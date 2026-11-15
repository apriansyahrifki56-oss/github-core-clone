// MCP (/mcp): JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28 via server/discover
// (no session state; every request is answered as plain application/json).
// Tools act on the same store as REST: create_repo, get_repo, create_issue,
// list_issues, create_pull_request, merge_pull_request.

import { VIEWER_LOGIN } from './scenario.ts';
import { issueJson, pullJson, repoJson, store, type Repo } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'The repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolJson(tool: ToolDef): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  };
}

function toolResult(content: unknown): Record<string, unknown> {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { content: [{ type: 'text', text }], structuredContent: content };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { __rpcError: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` } };
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument ${JSON.stringify(required)}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return toolError('Invalid repository name');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError('Repository already exists');
      const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(String(args.owner), String(args.repo));
      if (repo === null) return toolError('Repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(String(args.owner), String(args.repo));
      if (repo === null) return toolError('Repository not found');
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(String(args.owner), String(args.repo));
      if (repo === null) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(String(args.owner), String(args.repo));
      if (repo === null) return toolError('Repository not found');
      const head = String(args.head);
      const base = String(args.base);
      if (store.refTip(repo, head) === null || store.refTip(repo, base) === null) return toolError('Unknown head or base branch');
      const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate !== undefined) return toolError('A pull request already exists for this head and base');
      const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      if (pull === null) return toolError('Unknown head or base branch');
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(String(args.owner), String(args.repo));
      if (repo === null) return toolError('Repository not found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.merged) return toolError('Pull request already merged');
      if (!store.pullMergeable(repo, pull)) return toolError('Pull request is conflicted');
      const sha = store.mergePull(repo, pull);
      if (sha === null) return toolError('Pull request is conflicted');
      return toolResult({ merged: true, sha, ...pullJson(repo, pull) });
    }
    default:
      return { __rpcError: { code: -32602, message: `unknown tool ${JSON.stringify(name)}` } };
  }
}

/** Handle one POST /mcp body. Returns the HTTP status and the JSON-RPC body to send. */
export function handleMcp(rawBody: Buffer): { status: number; body: unknown } {
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
    }
    request = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is answered with 202 and no body.
  if (id === null && request.id === undefined) {
    return { status: 202, body: null };
  }

  const result = (value: unknown): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    return result({
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    return result({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return result({});
  }
  if (method === 'tools/list') {
    return result({ tools: TOOLS.map((tool) => toolJson(tool)) });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(toolName, args);
    if ('__rpcError' in outcome) {
      const rpcError = outcome.__rpcError as { code: number; message: string };
      return error(rpcError.code, rpcError.message);
    }
    return result(outcome);
  }
  return error(-32601, `Method not found: ${method}`);
}
