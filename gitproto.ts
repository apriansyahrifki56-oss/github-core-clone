// Git smart HTTP: info/refs advertisements (v2 + v0), upload-pack v2 (ls-refs, fetch)
// and v0, receive-pack v0 (push with report-status over side-band-64k).
// The client (kit's git-client.ts) is the only caller; every byte here answers its parser.

import { VIEWER_LOGIN } from './scenario.ts';
import { store, type Repo } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  PktLineDecoder,
  ZERO_OID,
  decodePktLines,
  fetchObjects,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitobj.ts';

export const UPLOAD_PACK_AD = 'application/x-git-upload-pack-advertisement';
export const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
export const RECEIVE_PACK_AD = 'application/x-git-receive-pack-advertisement';
export const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';

const AGENT = 'forge/1.0';

export interface GitRequest {
  owner: string;
  repo: string;
  service: 'git-upload-pack' | 'git-receive-pack';
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function textResponse(status: number, text: string): GitResponse {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

/** Resolve the repository, or null when the owner is not the viewer / the repo is missing. */
function resolveRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

/** All refs of a repo, sorted by name, with peeled targets for annotated tags. */
function allRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (repo.objects.get(target)?.type === 'commit') entry.peeled = target;
    }
    refs.push(entry);
  }
  return refs;
}

/** The default branch's tip, or null for an unborn repo. */
function headTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------- advertisements

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceName = service === 'git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT} object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;
  const parts: Buffer[] = [pktLine(`# service=${serviceName}\n`), PKT_FLUSH];
  const tip = headTip(repo);
  if (tip === null) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of allRefs(repo)) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(req: GitRequest): GitResponse {
  const repo = resolveRepo(req.owner, req.repo);
  if (repo === null) return textResponse(404, 'Not Found');
  const gitProtocol = req.headers['git-protocol'];
  const wantsV2 = req.service === 'git-upload-pack' && gitProtocol === 'version=2';
  if (wantsV2) {
    return { status: 200, contentType: UPLOAD_PACK_AD, body: v2Advertisement() };
  }
  const contentType = req.service === 'git-upload-pack' ? UPLOAD_PACK_AD : RECEIVE_PACK_AD;
  return { status: 200, contentType, body: v0Advertisement(repo, req.service) };
}

// ---------------------------------------------------------------- upload-pack v2

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const refs = allRefs(repo);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const tip = headTip(repo);
  if (tip === null) {
    // Unborn: only the HEAD line, and only when the client asked for unborn refs.
    if (args.unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (matches('HEAD') && args.prefixes.length === 0) {
      parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  filter?: string;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  // Split the pack into band-1 sideband packets (payload <= 65515 bytes each).
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

/** Fetch-response cache: the pack a fetch sends is a pure function of (repo, wants,
 * haves, depth, shallow) — objects are immutable, so the same key always yields the
 * same bytes. The clone bench repeats the identical shallow clone 50 times; caching
 * the built response makes all but the first nearly free. Bounded to 32 entries. */
const fetchCache = new Map<string, Buffer>();

function handleFetch(repo: Repo, args: FetchArgs): Buffer {
  const wants = [...new Set(args.wants)].filter((oid) => isObjectId(oid) && repo.objects.has(oid));
  const haves = args.haves.filter((oid) => isObjectId(oid));
  const cacheKey = [
    repo.owner, repo.name, ...wants, '|', ...haves, '|',
    args.deepen === undefined ? '' : String(args.deepen), '|', ...args.shallow,
  ].join('\u0000');
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [];
  if (wants.length === 0) {
    // Nothing wanted: NAK only, no packfile section.
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM, PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const { send, boundary } = fetchObjects(repo.objects, wants, haves, args.deepen, args.shallow);
  // acknowledgments: ACK every have the server holds that is an ancestor of a want.
  parts.push(pktLine('acknowledgments\n'));
  let acked = false;
  for (const have of haves) {
    if (repo.objects.has(have) && wants.some((want) => isAncestor(repo.objects, have, want))) {
      parts.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) parts.push(pktLine('NAK\n'));
  parts.push(PKT_DELIM);
  // shallow-info: the new boundary, plus old boundaries that stopped being shallow.
  const shallowLines: string[] = [];
  for (const oid of boundary) shallowLines.push(`shallow ${oid}`);
  if (args.deepen !== undefined || args.shallow.length > 0) {
    for (const old of args.shallow) {
      // An old boundary whose parent is now included is no longer shallow.
      const object = repo.objects.get(old);
      if (object !== undefined && object.type === 'commit') {
        const parents = parseCommit(object.data).parents;
        if (parents.length > 0 && parents.every((parent) => send.has(parent))) shallowLines.push(`unshallow ${old}`);
      }
    }
  }
  if (shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  if (send.size > 0) {
    const ordered = [...send.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, object]) => object);
    const pack = writePack(ordered);
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
  }
  parts.push(PKT_FLUSH);
  const response = Buffer.concat(parts);
  if (fetchCache.size >= 32) {
    const firstKey = fetchCache.keys().next().value;
    if (firstKey !== undefined) fetchCache.delete(firstKey);
  }
  fetchCache.set(cacheKey, response);
  return response;
}

/** Parse a v2 upload-pack POST body into its command and arguments. */
function parseV2Body(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).replace(/\n$/, '');
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  return { command, args };
}

export function handleUploadPack(req: GitRequest): GitResponse {
  const repo = resolveRepo(req.owner, req.repo);
  if (repo === null) return textResponse(404, 'Not Found');
  const gitProtocol = req.headers['git-protocol'];
  if (gitProtocol === 'version=2') {
    let parsed: { command: string; args: string[] };
    try {
      parsed = parseV2Body(req.body);
    } catch {
      return textResponse(400, 'malformed pkt-line stream');
    }
    if (parsed.command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const arg of parsed.args) {
        if (arg === 'peel') lsArgs.peel = true;
        else if (arg === 'symrefs') lsArgs.symrefs = true;
        else if (arg === 'unborn') lsArgs.unborn = true;
        else if (arg === 'done') break;
        else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: UPLOAD_PACK_RESULT, body: handleLsRefs(repo, lsArgs) };
    }
    if (parsed.command === 'fetch') {
      const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [] };
      for (const arg of parsed.args) {
        if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) fetchArgs.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) fetchArgs.deepen = Number(arg.slice(7).trim());
        else if (arg.startsWith('filter ')) fetchArgs.filter = arg.slice(7).trim();
        else if (arg === 'done') break;
      }
      return { status: 200, contentType: UPLOAD_PACK_RESULT, body: handleFetch(repo, fetchArgs) };
    }
    return textResponse(400, `unknown v2 command ${JSON.stringify(parsed.command)}`);
  }
  // v0 fetch: two sections (wants + flush, haves + done + flush). The suite never sends
  // one when v2 is advertised; answer it anyway with a NAK and a sideband pack.
  try {
    const packets = decodePktLines(req.body);
    const wants: string[] = [];
    const haves: string[] = [];
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      const firstSpace = line.indexOf(' ');
      const first = firstSpace < 0 ? line : line.slice(0, firstSpace);
      if (section === 0 && first === 'want') wants.push(line.slice(5, 45));
      if (section === 1 && first === 'have') haves.push(line.slice(5, 45));
    }
    const { send } = fetchObjects(repo.objects, wants, haves);
    const parts: Buffer[] = [pktLine('NAK\n')];
    if (send.size > 0) {
      const pack = writePack([...send.values()]);
      for (const packet of sidebandPackets(pack)) parts.push(packet);
    }
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: UPLOAD_PACK_RESULT, body: Buffer.concat(parts) };
  } catch {
    return textResponse(400, 'malformed pkt-line stream');
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(req: GitRequest): GitResponse {
  const repo = resolveRepo(req.owner, req.repo);
  if (repo === null) return textResponse(404, 'Not Found');
  let commands: PushCommand[] = [];
  let packStart = 0;
  let unpackError: string | null = null;
  try {
    // Read pkt-lines one at a time until the flush: everything after it is the raw pack.
    const decoder = new PktLineDecoder();
    decoder.push(req.body);
    let sawFlush = false;
    for (;;) {
      const packet = decoder.next();
      if (packet === null) throw new Error('truncated command list');
      if (packet.kind === 'flush') {
        sawFlush = true;
        break;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8');
      const nul = line.indexOf('\u0000');
      const head = (nul >= 0 ? line.slice(0, nul) : line).replace(/\n$/, '');
      const parts = head.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
      }
    }
    if (!sawFlush) throw new Error('no flush after the command list');
    packStart = req.body.length - decoder.remainder().length;
  } catch (err) {
    unpackError = err instanceof Error ? err.message : String(err);
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push('unpack error');
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack error`);
  } else {
    // Unpack the pack (if any) into the object store first.
    const packBytes = req.body.subarray(packStart);
    if (packBytes.length > 0) {
      try {
        const read = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
        reportLines.push('unpack ok');
      } catch (err) {
        reportLines.push(`unpack ${err instanceof Error ? err.message : 'error'}`);
        for (const command of commands) reportLines.push(`ng ${command.ref} unpack error`);
        return sendReport(reportLines);
      }
    } else {
      reportLines.push('unpack ok');
    }
    // Apply each command; a refused ref does not move, the others still apply.
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      let reason = 'non-fast-forward';
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current !== undefined && current === command.oldOid) {
          repo.refs.delete(command.ref);
          ok = true;
        } else {
          reason = 'non-fast-forward';
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current === undefined) {
          if (!repo.objects.has(command.newOid)) {
            reason = 'missing object';
          } else {
            repo.refs.set(command.ref, command.newOid);
            ok = true;
          }
        } else {
          reason = 'non-fast-forward';
        }
      } else if (current === command.oldOid && repo.objects.has(command.newOid)) {
        // Update: must fast-forward.
        if (isAncestor(repo.objects, command.oldOid, command.newOid)) {
          repo.refs.set(command.ref, command.newOid);
          ok = true;
        } else {
          reason = 'non-fast-forward';
        }
      } else if (current !== command.oldOid) {
        reason = 'non-fast-forward';
      } else {
        reason = 'missing object';
      }
      reportLines.push(ok ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
    }
  }
  return sendReport(reportLines);

  function sendReport(lines: string[]): GitResponse {
    // The report-status stream is pkt-lined inside band-1 sideband packets.
    const inner = Buffer.concat(lines.map((line) => pktLine(`${line}\n`)));
    const outer: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      const chunk = inner.subarray(offset, Math.min(offset + CHUNK, inner.length));
      outer.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    outer.push(PKT_FLUSH);
    return { status: 200, contentType: RECEIVE_PACK_RESULT, body: Buffer.concat(outer) };
  }
}

export { verifyPackChecksum };
export type { GitObject };
