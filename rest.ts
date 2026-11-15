// REST v3 (/api/v3): repositories, branches, commits, contents, labels, issues,
// pull requests. Every reply is application/json with a non-empty X-GitHub-Request-Id.
// A repository belongs to the login the token names (the scenario viewer); the same
// name under another owner is 404, never 403. A request without a token is 401
// (answered by app.ts before this router runs).

import { VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME } from './scenario.ts';
import { issueJson, pullJson, repoJson, store, type Issue, type Pull, type Repo } from './store.ts';
import { isObjectId, parseCommit } from './gitobj.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  host: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  noBody?: boolean;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): RestResponse {
  return { status, body, headers: { 'x-oauth-scopes': 'repo, read:org', ...headers } };
}

function errorResponse(status: number, message: string): RestResponse {
  return jsonResponse(status, { message });
}

function parseBody(req: RestRequest): { ok: true; json: Record<string, unknown> } | { ok: false; response: RestResponse } {
  const text = req.body.toString('utf8').trim();
  if (text === '') return { ok: true, json: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: errorResponse(400, 'Invalid JSON body') };
    }
    return { ok: true, json: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: errorResponse(400, 'Invalid JSON body') };
  }
}

function base64Decode(text: string): Buffer | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text.replace(/\s+/g, ''))) return null;
  try {
    return Buffer.from(text, 'base64');
  } catch {
    return null;
  }
}

/** Paginate a list; returns the page and the Link header value ('' when one page). */
function paginate<T>(items: readonly T[], req: RestRequest, path: string): { page: T[]; link: string } {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.trunc(perPageRaw), 100) : 30;
  const pageRaw = Number(req.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  if (totalPages > 1) {
    const urlFor = (pageNumber: number): string => {
      const query = new URLSearchParams(req.query);
      query.set('per_page', String(perPage));
      query.set('page', String(pageNumber));
      return `http://${req.host}${path}?${query.toString()}`;
    };
    const parts: string[] = [];
    if (page < totalPages) {
      parts.push(`<${urlFor(page + 1)}>; rel="next"`);
      parts.push(`<${urlFor(totalPages)}>; rel="last"`);
    }
    if (page > 1) {
      parts.push(`<${urlFor(1)}>; rel="first"`);
      parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
    }
    link = parts.join(', ');
  }
  return { page: slice, link };
}

function withLink(link: string): Record<string, string> {
  return link === '' ? {} : { link };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The repository for a /repos/{owner}/{name} path, or an error response when it is not the viewer's. */
function repoFor(owner: string, name: string): { repo: Repo } | { response: RestResponse } {
  if (owner !== VIEWER_LOGIN) return { response: errorResponse(404, 'Not Found') };
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { response: errorResponse(404, 'Not Found') };
  return { repo };
}

function issueShape(issue: Issue): Record<string, unknown> {
  return issue as unknown as Record<string, unknown>;
}

export function handleRest(req: RestRequest): RestResponse | null {
  const path = req.path;
  if (!path.startsWith('/api/v3')) return null;
  const rest = path.slice('/api/v3'.length);
  const segments = rest.split('/').filter((segment) => segment !== '').map(decodeSegment);
  const method = req.method;

  // GET /api/v3/ — the API root.
  if ((rest === '' || rest === '/') && method === 'GET') {
    return jsonResponse(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return jsonResponse(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    return jsonResponse(200, { login: VIEWER_LOGIN, id: 1000, node_id: Buffer.from(`User:${VIEWER_LOGIN}`, 'utf8').toString('base64'), name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(store.listRepos(), req, req.path);
      return jsonResponse(200, page.map((repo) => repoJson(repo)), withLink(link));
    }
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const name = parsed.json.name;
      if (typeof name !== 'string' || name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return errorResponse(422, 'Invalid repository name');
      }
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return errorResponse(422, 'Repository already exists');
      const repo = store.createRepo(
        name,
        parsed.json.private === true,
        typeof parsed.json.description === 'string' ? parsed.json.description : '',
      );
      return jsonResponse(201, repoJson(repo));
    }
    return errorResponse(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const found = repoFor(owner, name);
    if ('response' in found) return found.response;
    const repo = found.repo;
    const tail = segments.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') return jsonResponse(200, repoJson(repo));
      if (method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        if (typeof parsed.json.description === 'string') repo.description = parsed.json.description;
        if (typeof parsed.json.private === 'boolean') repo.private = parsed.json.private;
        return jsonResponse(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null, headers: {}, noBody: true };
      }
      return errorResponse(404, 'Not Found');
    }

    // GET /branches, GET /branches/{branch...}
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        return jsonResponse(200, store.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })));
      }
      if (method === 'GET' && tail.length >= 2) {
        const branch = tail.slice(1).join('/');
        const sha = store.refTip(repo, branch);
        if (sha === null) return errorResponse(404, 'Not Found');
        return jsonResponse(200, { name: branch, commit: { sha } });
      }
      return errorResponse(404, 'Not Found');
    }

    // GET /commits?sha=<ref>
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      let tip = store.refTip(repo, ref);
      if (tip === null && isObjectId(ref) && repo.objects.has(ref)) tip = ref;
      if (tip === null) return errorResponse(404, 'Not Found');
      const commits = store.listCommits(repo, tip).map((commit) => {
        const object = repo.objects.get(commit.sha);
        const parsed = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
        const authorLine = parsed?.author ?? '';
        const committerLine = parsed?.committer ?? '';
        const ident = (line: string): { name: string; email: string; date: string } => {
          const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
          if (match === null) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date(0).toISOString() };
          return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
        };
        return {
          sha: commit.sha,
          commit: { message: commit.message, author: ident(authorLine), committer: ident(committerLine) },
          parents: commit.parents.map((sha) => ({ sha })),
        };
      });
      return jsonResponse(200, commits);
    }

    // /git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        const ref = parsed.json.ref;
        const sha = parsed.json.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/heads/') || typeof sha !== 'string' || !isObjectId(sha)) {
          return errorResponse(422, 'Invalid ref');
        }
        if (repo.refs.has(ref)) return errorResponse(422, 'Reference already exists');
        const object = repo.objects.get(sha);
        if (object === undefined || object.type !== 'commit') return errorResponse(422, 'Invalid sha');
        repo.refs.set(ref, sha);
        return jsonResponse(201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
        const branch = tail.slice(3).join('/');
        const sha = store.refTip(repo, branch);
        if (sha === null) return errorResponse(404, 'Not Found');
        return jsonResponse(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      }
      return errorResponse(404, 'Not Found');
    }

    // /contents/{path...}
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      if (method === 'GET') {
        const ref = req.query.get('ref') ?? repo.defaultBranch;
        const read = store.readPath(repo, ref, contentPath);
        if (read === null) return errorResponse(404, 'Not Found');
        if (read.kind === 'file') {
          return jsonResponse(200, {
            type: 'file',
            encoding: 'base64',
            content: read.data.toString('base64'),
            sha: read.oid,
            size: read.data.length,
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
          });
        }
        return jsonResponse(200, read.entries.map((entry) => ({ type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path: entry.path, sha: entry.oid })));
      }
      if (method === 'PUT') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        const message = typeof parsed.json.message === 'string' ? parsed.json.message : 'Update';
        const branch = typeof parsed.json.branch === 'string' ? parsed.json.branch : repo.defaultBranch;
        const content = typeof parsed.json.content === 'string' ? base64Decode(parsed.json.content) : null;
        if (content === null) return errorResponse(422, 'Invalid content');
        const existing = store.readPath(repo, branch, contentPath);
        const sha = parsed.json.sha;
        if (existing !== null && existing.kind === 'file') {
          if (sha === undefined) return errorResponse(422, 'sha is required for an update');
          if (typeof sha !== 'string' || sha.toLowerCase() !== existing.oid.toLowerCase()) {
            return errorResponse(409, 'sha does not match the current blob');
          }
        } else if (sha !== undefined) {
          return errorResponse(409, 'sha does not match the current blob');
        }
        const result = store.writePath(repo, branch, contentPath, content, message);
        const status = result.created ? 201 : 200;
        return jsonResponse(status, {
          content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: result.blobSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        const branch = typeof parsed.json.branch === 'string' ? parsed.json.branch : repo.defaultBranch;
        const existing = store.readPath(repo, branch, contentPath);
        if (existing === null || existing.kind !== 'file') return errorResponse(404, 'Not Found');
        const sha = parsed.json.sha;
        if (typeof sha === 'string' && sha.toLowerCase() !== existing.oid.toLowerCase()) {
          return errorResponse(409, 'sha does not match the current blob');
        }
        const message = typeof parsed.json.message === 'string' ? parsed.json.message : 'Delete';
        const result = store.writePath(repo, branch, contentPath, null, message);
        return jsonResponse(200, { commit: { sha: result.commitSha, message } });
      }
      return errorResponse(404, 'Not Found');
    }

    // /labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        return jsonResponse(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      }
      if (method === 'POST' && tail.length === 1) {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        const name = parsed.json.name;
        if (typeof name !== 'string' || name === '') return errorResponse(422, 'Invalid label name');
        if (repo.labels.has(name)) return errorResponse(422, 'Label already exists');
        const label = { name, color: typeof parsed.json.color === 'string' ? parsed.json.color : 'ededed' };
        repo.labels.set(name, label);
        return jsonResponse(201, { name: label.name, color: label.color });
      }
      return errorResponse(404, 'Not Found');
    }

    // /issues[/...]
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const direction = req.query.get('direction') ?? 'desc';
          let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { page, link } = paginate(issues, req, req.path);
          return jsonResponse(200, page.map((issue) => issueJson(repo, issue)), withLink(link));
        }
        if (method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.response;
          const title = parsed.json.title;
          if (typeof title !== 'string' || title === '') return errorResponse(422, 'Invalid title');
          const body = typeof parsed.json.body === 'string' ? parsed.json.body : '';
          const labels = Array.isArray(parsed.json.labels) ? (parsed.json.labels as unknown[]) : [];
          for (const label of labels) {
            if (typeof label !== 'string' || !repo.labels.has(label)) return errorResponse(422, `Label ${String(label)} does not exist`);
          }
          const issue = store.createIssue(repo, title, body, labels as string[]);
          return jsonResponse(201, issueJson(repo, issue));
        }
        return errorResponse(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isSafeInteger(number) || number < 1) return errorResponse(404, 'Not Found');
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (tail.length === 2) {
        if (issue === undefined) return errorResponse(404, 'Not Found');
        if (method === 'GET') return jsonResponse(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.response;
          const state = parsed.json.state;
          if (state !== 'open' && state !== 'closed') return errorResponse(422, 'Invalid state');
          issue.state = state;
          issue.updatedAt = store.nowIso();
          return jsonResponse(200, issueJson(repo, issue));
        }
        return errorResponse(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) return errorResponse(404, 'Not Found');
        if (method === 'GET') {
          return jsonResponse(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: VIEWER_LOGIN, id: 1000 } })));
        }
        if (method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.response;
          const body = parsed.json.body;
          if (typeof body !== 'string' || body === '') return errorResponse(422, 'Invalid body');
          const comment = { id: store.nextCommentId, body, createdAt: store.nowIso() };
          store.nextCommentId += 1;
          issue.comments.push(comment);
          return jsonResponse(201, { id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: VIEWER_LOGIN, id: 1000 } });
        }
        return errorResponse(404, 'Not Found');
      }
      return errorResponse(404, 'Not Found');
    }

    // /pulls[/...]
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
          const { page, link } = paginate(pulls, req, req.path);
          return jsonResponse(200, page.map((pull) => pullJson(repo, pull)), withLink(link));
        }
        if (method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.response;
          const head = parsed.json.head;
          const base = parsed.json.base;
          const title = parsed.json.title;
          if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string' || title === '') {
            return errorResponse(422, 'Invalid pull request');
          }
          if (store.refTip(repo, head) === null || store.refTip(repo, base) === null) {
            return errorResponse(422, 'Unknown head or base branch');
          }
          const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
          if (duplicate !== undefined) return errorResponse(422, 'A pull request already exists for this head and base');
          const body = typeof parsed.json.body === 'string' ? parsed.json.body : '';
          const pull = store.createPull(repo, title, body, head, base);
          if (pull === null) return errorResponse(422, 'Unknown head or base branch');
          return jsonResponse(201, pullJson(repo, pull));
        }
        return errorResponse(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isSafeInteger(number) || number < 1) return errorResponse(404, 'Not Found');
      const pull: Pull | undefined = repo.pulls.find((candidate) => candidate.number === number);
      if (tail.length === 2) {
        if (pull === undefined) return errorResponse(404, 'Not Found');
        if (method === 'GET') return jsonResponse(200, pullJson(repo, pull));
        return errorResponse(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) return errorResponse(404, 'Not Found');
        const files = store.pullFiles(repo, pull).map((change) => {
          const counts = store.fileLineCounts(repo, change);
          const status = change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified';
          return {
            filename: change.path,
            status,
            additions: counts.additions,
            deletions: counts.deletions,
            changes: counts.additions + counts.deletions,
          };
        });
        return jsonResponse(200, files);
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return errorResponse(404, 'Not Found');
        if (pull.merged) return errorResponse(405, 'Pull request already merged');
        if (!store.pullMergeable(repo, pull)) return errorResponse(405, 'Pull request is conflicted');
        const sha = store.mergePull(repo, pull);
        if (sha === null) return errorResponse(405, 'Pull request is conflicted');
        return jsonResponse(200, { merged: true, sha, message: 'Pull request successfully merged' });
      }
      return errorResponse(404, 'Not Found');
    }

    return errorResponse(404, 'Not Found');
  }

  return errorResponse(404, 'Not Found');
}

export { issueShape };
