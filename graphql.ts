// GraphQL v4 (/api/graphql): a small executor for exactly the documents the suite
// sends (kit's checks-graphql.ts GRAPHQL_DOCUMENTS): viewer, repository (+ issues,
// issue, pullRequests, pullRequest), __type introspection, node(id:), and the five
// mutations. Unknown fields answer HTTP 200 with an errors array naming the field;
// an unknown repository answers data.repository = null with no errors.
// Batching: an array of operation documents answers an array of results, in order.

import { VIEWER_LOGIN } from './scenario.ts';
import { issueJson, pullJson, store, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------- parsing

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'object'; fields: Record<string, ValueNode> }
  | { kind: 'list'; items: ValueNode[] };

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, string>;
  selections: Selection[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      i += 1;
      continue;
    }
    if (char === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (text.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      i += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          const next = text[i + 1] as string;
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          i += 2;
        } else {
          value += text[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let value = '';
      while (i < text.length && /[0-9.]/.test(text[i] as string)) {
        value += text[i];
        i += 1;
      }
      tokens.push({ kind: value.includes('.') ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i] as string)) {
        value += text[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`GraphQL parse: unexpected character ${JSON.stringify(char)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(text: string) {
    this.#tokens = tokenize(text);
  }

  peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }

  next(): Token {
    const token = this.#tokens[this.#pos] as Token;
    this.#pos += 1;
    return token;
  }

  expect(value: string): Token {
    const token = this.next();
    if (token.value !== value) throw new Error(`GraphQL parse: expected ${JSON.stringify(value)}, saw ${JSON.stringify(token.value)}`);
    return token;
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`GraphQL parse: expected a name, saw ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: Record<string, string> = {};
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')') {
        this.expect('$');
        const varName = this.expectName();
        this.expect(':');
        // The type: a name, possibly wrapped in [ ] and suffixed with !.
        let typeText = '';
        while (this.peek().value !== ')' && this.peek().value !== ',' && this.peek().kind !== 'eof') {
          typeText += this.next().value;
        }
        variables[varName] = typeText;
        if (this.peek().value === ',') this.next();
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek().value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')') {
        const argName = this.expectName();
        this.expect(':');
        args[argName] = this.parseValue();
        if (this.peek().value === ',') this.next();
      }
      this.expect(')');
    }
    let selections: Selection[] = [];
    if (this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek().value !== '}') {
        const key = this.expectName();
        this.expect(':');
        fields[key] = this.parseValue();
        if (this.peek().value === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.value === '[') {
      const items: ValueNode[] = [];
      while (this.peek().value !== ']') {
        items.push(this.parseValue());
        if (this.peek().value === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`GraphQL parse: unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- global ids

function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.owner}/${repo.name}`, 'utf8').toString('base64');
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.owner}/${repo.name}#${issue.number}`, 'utf8').toString('base64');
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.owner}/${repo.name}#${pull.number}`, 'utf8').toString('base64');
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return Buffer.from(`Comment:${repo.owner}/${repo.name}#${issue.number}:${commentId}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number; extra: string } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(Repository|Issue|PullRequest|Comment):([^/]+)\/([^#]+)(?:#(\d+)(?::(\d+))?)?$/.exec(text);
  if (match === null) return null;
  return {
    kind: match[1] as string,
    owner: match[2] as string,
    name: match[3] as string,
    number: match[4] === undefined ? 0 : Number(match[4]),
    extra: match[5] ?? '',
  };
}

// ---------------------------------------------------------------- schema

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION', 'MILESTONE', 'PACKAGE', 'WIKI'];

// ---------------------------------------------------------------- execution

interface ExecContext {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Source =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestFileConnection'; repo: Repo; pull: Pull; files: Array<{ path: string }> }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'Owner'; login: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Type'; name: string }
  | { __typename: 'Comment'; repo: Repo; issue: Issue; id: number; body: string }
  | { __typename: 'CommentEdge'; repo: Repo; issue: Issue; id: number; body: string }
  | { __typename: 'IssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'CommentPayload'; repo: Repo; issue: Issue; id: number; body: string };

function fieldError(ctx: ExecContext, typeName: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return null;
}

function executeSelections(source: Source, selections: Selection[], ctx: ExecContext): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== source.__typename) continue;
      const nested = executeSelections(source, selection.selections, ctx);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = resolveField(source, selection, ctx);
    if (ctx.errors.length > 0 && source.__typename === 'Query') {
      // A field error on the root aborts the operation's data.
      return null;
    }
  }
  return out;
}

function resolveField(source: Source, selection: FieldSelection, ctx: ExecContext): unknown {
  const args: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(selection.args)) args[name] = resolveValue(node, ctx.variables);

  switch (source.__typename) {
    case 'Query': {
      if (selection.name === 'viewer') {
        return executeSelections({ __typename: 'User', login: VIEWER_LOGIN }, selection.selections, ctx);
      }
      if (selection.name === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner, name);
        if (repo === undefined) return null;
        return executeSelections({ __typename: 'Repository', repo }, selection.selections, ctx);
      }
      if (selection.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null || decoded.kind !== 'Repository') return null;
        if (decoded.owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        return executeSelections({ __typename: 'Repository', repo }, selection.selections, ctx);
      }
      if (selection.name === '__type') {
        return executeSelections({ __typename: 'Type', name: String(args.name ?? '') }, selection.selections, ctx);
      }
      return fieldError(ctx, 'Query', selection.name);
    }
    case 'Mutation': {
      if (selection.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null || decoded.kind !== 'Repository') {
          ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
          return null;
        }
        const repo = store.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) {
          ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
          return null;
        }
        const issue = store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        return executeSelections({ __typename: 'IssuePayload', repo, issue }, selection.selections, ctx);
      }
      if (selection.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (decoded === null || decoded.kind !== 'Issue') {
          ctx.errors.push({ message: 'closeIssue: unknown issueId' });
          return null;
        }
        const repo = store.getRepo(decoded.owner, decoded.name);
        const issue = repo?.issues.find((candidate) => candidate.number === decoded.number);
        if (repo === undefined || issue === undefined) {
          ctx.errors.push({ message: 'closeIssue: unknown issueId' });
          return null;
        }
        issue.state = 'closed';
        issue.updatedAt = store.nowIso();
        return executeSelections({ __typename: 'IssuePayload', repo, issue }, selection.selections, ctx);
      }
      if (selection.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null || decoded.kind !== 'Repository') {
          ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
          return null;
        }
        const repo = store.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) {
          ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
          return null;
        }
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        if (store.refTip(repo, headRef) === null || store.refTip(repo, baseRef) === null) {
          ctx.errors.push({ message: 'createPullRequest: unknown head or base branch' });
          return null;
        }
        const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
        if (duplicate !== undefined) {
          ctx.errors.push({ message: 'createPullRequest: a pull request already exists for this head and base' });
          return null;
        }
        const pull = store.createPull(repo, String(input.title ?? ''), '', headRef, baseRef);
        if (pull === null) {
          ctx.errors.push({ message: 'createPullRequest: unknown head or base branch' });
          return null;
        }
        return executeSelections({ __typename: 'PullRequestPayload', repo, pull }, selection.selections, ctx);
      }
      if (selection.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (decoded === null || decoded.kind !== 'PullRequest') {
          ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
          return null;
        }
        const repo = store.getRepo(decoded.owner, decoded.name);
        const pull = repo?.pulls.find((candidate) => candidate.number === decoded.number);
        if (repo === undefined || pull === undefined) {
          ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
          return null;
        }
        if (!store.pullMergeable(repo, pull)) {
          ctx.errors.push({ message: 'mergePullRequest: pull request is conflicted' });
          return null;
        }
        const sha = store.mergePull(repo, pull);
        if (sha === null) {
          ctx.errors.push({ message: 'mergePullRequest: pull request is conflicted' });
          return null;
        }
        return executeSelections({ __typename: 'PullRequestPayload', repo, pull }, selection.selections, ctx);
      }
      if (selection.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (decoded === null || decoded.kind !== 'Issue') {
          ctx.errors.push({ message: 'addComment: unknown subjectId' });
          return null;
        }
        const repo = store.getRepo(decoded.owner, decoded.name);
        const issue = repo?.issues.find((candidate) => candidate.number === decoded.number);
        if (repo === undefined || issue === undefined) {
          ctx.errors.push({ message: 'addComment: unknown subjectId' });
          return null;
        }
        const comment = { id: store.nextCommentId, body: String(input.body ?? ''), createdAt: store.nowIso() };
        store.nextCommentId += 1;
        issue.comments.push(comment);
        return executeSelections({ __typename: 'CommentPayload', repo, issue, id: comment.id, body: comment.body }, selection.selections, ctx);
      }
      return fieldError(ctx, 'Mutation', selection.name);
    }
    case 'User': {
      if (selection.name === 'login') return source.login;
      return fieldError(ctx, 'User', selection.name);
    }
    case 'Owner': {
      if (selection.name === 'login') return source.login;
      return fieldError(ctx, 'User', selection.name);
    }
    case 'Repository': {
      const repo = source.repo;
      switch (selection.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return executeSelections({ __typename: 'Owner', login: repo.owner }, selection.selections, ctx);
        case 'defaultBranchRef': {
          const branches = store.listBranches(repo);
          const main = branches.find((branch) => branch.name === repo.defaultBranch);
          if (main === undefined) return null;
          return executeSelections({ __typename: 'Ref', name: main.name }, selection.selections, ctx);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = Number(args.number ?? 0);
          const issue = repo.issues.find((candidate) => candidate.number === number);
          if (issue === undefined) return null;
          return executeSelections({ __typename: 'Issue', repo, issue }, selection.selections, ctx);
        }
        case 'issues': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const after = typeof args.after === 'string' ? args.after : null;
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          let issues = [...repo.issues];
          if (states !== null) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          if (orderBy.field === 'CREATED_AT') {
            issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
          } else {
            issues.sort((a, b) => a.number - b.number);
          }
          let start = 0;
          if (after !== null) {
            const decoded = Buffer.from(after, 'base64').toString('utf8');
            const match = /^cursor:(\d+)$/.exec(decoded);
            if (match !== null) {
              const index = issues.findIndex((issue) => issue.number === Number(match[1]));
              if (index >= 0) start = index + 1;
            }
          }
          const total = issues.length;
          const page = first === undefined ? issues.slice(start) : issues.slice(start, start + first);
          const hasNextPage = start + page.length < total;
          const endCursor = page.length === 0 ? null : Buffer.from(`cursor:${page[page.length - 1]?.number}`, 'utf8').toString('base64');
          return executeSelections(
            { __typename: 'IssueConnection', repo, issues: page, hasNextPage, endCursor },
            selection.selections,
            ctx,
          );
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const pulls = first === undefined ? [...repo.pulls] : repo.pulls.slice(0, first);
          return executeSelections({ __typename: 'PullRequestConnection', repo, pulls }, selection.selections, ctx);
        }
        case 'pullRequest': {
          const number = Number(args.number ?? 0);
          const pull = repo.pulls.find((candidate) => candidate.number === number);
          if (pull === undefined) return null;
          return executeSelections({ __typename: 'PullRequest', repo, pull }, selection.selections, ctx);
        }
        default:
          return fieldError(ctx, 'Repository', selection.name);
      }
    }
    case 'Issue': {
      const issue = source.issue;
      switch (selection.name) {
        case 'id':
          return issueGlobalId(source.repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        default:
          return fieldError(ctx, 'Issue', selection.name);
      }
    }
    case 'PullRequest': {
      const pull = source.pull;
      switch (selection.name) {
        case 'id':
          return pullGlobalId(source.repo, pull);
        case 'number':
          return pull.number;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return pull.state === 'open' ? (store.pullMergeable(source.repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : undefined;
          const changes = store.pullFiles(source.repo, pull);
          const limited = first === undefined ? changes : changes.slice(0, first);
          return executeSelections(
            { __typename: 'PullRequestFileConnection', repo: source.repo, pull, files: limited.map((change) => ({ path: change.path })) },
            selection.selections,
            ctx,
          );
        }
        default:
          return fieldError(ctx, 'PullRequest', selection.name);
      }
    }
    case 'IssueConnection': {
      if (selection.name === 'nodes') {
        return source.issues.map((issue) => executeSelections({ __typename: 'Issue', repo: source.repo, issue }, selection.selections, ctx));
      }
      if (selection.name === 'pageInfo') {
        return executeSelections({ __typename: 'PageInfo', hasNextPage: source.hasNextPage, endCursor: source.endCursor }, selection.selections, ctx);
      }
      return fieldError(ctx, 'IssueConnection', selection.name);
    }
    case 'PullRequestConnection': {
      if (selection.name === 'nodes') {
        return source.pulls.map((pull) => executeSelections({ __typename: 'PullRequest', repo: source.repo, pull }, selection.selections, ctx));
      }
      return fieldError(ctx, 'PullRequestConnection', selection.name);
    }
    case 'PullRequestFileConnection': {
      if (selection.name === 'nodes') {
        return source.files.map((file) => ({ path: file.path }));
      }
      return fieldError(ctx, 'PullRequestFileConnection', selection.name);
    }
    case 'PageInfo': {
      if (selection.name === 'hasNextPage') return source.hasNextPage;
      if (selection.name === 'endCursor') return source.endCursor;
      return fieldError(ctx, 'PageInfo', selection.name);
    }
    case 'Ref': {
      if (selection.name === 'name') return source.name;
      return fieldError(ctx, 'Ref', selection.name);
    }
    case 'Type': {
      if (selection.name === 'fields') {
        const names = TYPE_FIELDS[source.name] ?? null;
        if (names === null) return null;
        return names.map((name) => ({ name }));
      }
      if (selection.name === 'enumValues') {
        if (source.name !== 'SearchType') return null;
        return SEARCH_TYPE_VALUES.map((name) => ({ name }));
      }
      if (selection.name === 'name') return source.name;
      return fieldError(ctx, '__Type', selection.name);
    }
    case 'Comment': {
      if (selection.name === 'id') return commentGlobalId(source.repo, source.issue, source.id);
      if (selection.name === 'body') return source.body;
      return fieldError(ctx, 'Comment', selection.name);
    }
    case 'CommentEdge': {
      if (selection.name === 'node') {
        return executeSelections({ __typename: 'Comment', repo: source.repo, issue: source.issue, id: source.id, body: source.body }, selection.selections, ctx);
      }
      return fieldError(ctx, 'CommentEdge', selection.name);
    }
    case 'IssuePayload': {
      if (selection.name === 'issue') {
        return executeSelections({ __typename: 'Issue', repo: source.repo, issue: source.issue }, selection.selections, ctx);
      }
      return fieldError(ctx, 'IssuePayload', selection.name);
    }
    case 'PullRequestPayload': {
      if (selection.name === 'pullRequest') {
        return executeSelections({ __typename: 'PullRequest', repo: source.repo, pull: source.pull }, selection.selections, ctx);
      }
      return fieldError(ctx, 'PullRequestPayload', selection.name);
    }
    case 'CommentPayload': {
      if (selection.name === 'commentEdge') {
        return executeSelections({ __typename: 'CommentEdge', repo: source.repo, issue: source.issue, id: source.id, body: source.body }, selection.selections, ctx);
      }
      return fieldError(ctx, 'CommentPayload', selection.name);
    }
    default:
      return fieldError(ctx, source.__typename, selection.name);
  }
}

function executeOperation(operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: ExecContext = { variables, errors: [] };
  const root: Source = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(root, operation.selections, ctx);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data, errors: [] };
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(body: unknown): { status: number; body: unknown } {
  const runOne = (entry: unknown): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'GraphQL request must be an object with a query string' }] };
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.query !== 'string') {
      return { data: null, errors: [{ message: 'GraphQL request needs a query string' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = new Parser(record.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    if (operations.length === 0) return { data: null, errors: [{ message: 'GraphQL request holds no operation' }] };
    const operation = operations[0] as Operation;
    // A named operation is selected by operationName; otherwise the first one runs.
    let selected = operation;
    if (typeof record.operationName === 'string') {
      const named = operations.find((candidate) => candidate.name === record.operationName);
      if (named !== undefined) selected = named;
    }
    return executeOperation(selected, variables);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(body) };
}

export { issueJson, pullJson };
