// The HTTP server: routing, auth, request ids, body limits. One process, in-memory
// store, no disk, no outside service.
//
// Auth: the suite presents Authorization: Bearer <MAKEFUN_SHOP_TOKEN>. When the
// environment names a token, only that token is accepted; without one (local runs)
// any non-empty Bearer token is accepted. GET /healthz needs no token. Everything
// else without a valid token is 401 JSON. The git surfaces answer the same 401.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitRequest } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}, no token needed.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Unauthorized' }, { 'x-github-request-id': requestId });
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repo = decodeURIComponent(gitMatch[2] as string);
          const rest = gitMatch[3] as string;
          const gitReq: GitRequest = {
            owner,
            repo,
            service: 'git-upload-pack',
            query: queryOf(req),
            headers: req.headers,
            body,
          };
          if (rest === 'info/refs') {
            const service = gitReq.query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found', 'utf8'));
              return;
            }
            gitReq.service = service;
            const answer = handleInfoRefs(gitReq);
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (rest === 'git-upload-pack' && method === 'POST') {
            const answer = handleUploadPack(gitReq);
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (rest === 'git-receive-pack' && method === 'POST') {
            gitReq.service = 'git-receive-pack';
            const answer = handleReceivePack(gitReq);
            sendBuffer(res, answer.status, answer.contentType, answer.body);
            return;
          }
          sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not Found', 'utf8'));
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] }, { 'x-github-request-id': requestId });
            return;
          }
          const answer = handleGraphQL(parsed);
          sendJson(res, answer.status, answer.body, { 'x-github-request-id': requestId });
          return;
        }

        // MCP.
        if (path === '/mcp' && method === 'POST') {
          const answer = handleMcp(body);
          if (answer.body === null) {
            res.writeHead(answer.status);
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.body, { 'x-github-request-id': requestId });
          return;
        }

        // REST v3.
        if (path.startsWith('/api/v3')) {
          const host = req.headers.host ?? '127.0.0.1';
          const restReq: RestRequest = { method, path, query: queryOf(req), headers: req.headers, body, host };
          const answer = handleRest(restReq);
          if (answer === null) {
            sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
            return;
          }
          if (answer.noBody === true) {
            res.writeHead(answer.status, { 'x-github-request-id': requestId, ...answer.headers });
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.body, { 'x-github-request-id': requestId, ...answer.headers });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestId });
      } catch (err) {
        // A request must never take the server down: answer 500 and stay up.
        try {
          if (!res.headersSent) {
            sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' }, { 'x-github-request-id': requestId });
          } else {
            res.end();
          }
        } catch {
          try {
            res.end();
          } catch {
            // Nothing left to do.
          }
        }
        process.stderr.write(`[entry] request ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });
}
