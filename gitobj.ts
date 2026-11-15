// Git object primitives: SHA-1 hashing, pkt-lines, packfile read/write (plain objects
// out, OFS/REF deltas resolved on read), tree/commit/tag parsing, and graph walks.
// No git binary, no outside service: everything here is node:crypto + node:zlib.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const GIT_OBJECT_FORMAT = 'sha1';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id of an object: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

/** One pkt-line: 4 hex length digits (the length counts itself) + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload is ${body.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  const length = body.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim';

export interface PktPacket {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed length. */
export function decodePktLines(buf: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (hex === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const length = parseInt(hex, 16);
    if (!Number.isFinite(length) || length < 4 || length > PKT_LINE_MAX) throw new Error(`pkt-line length ${hex} is not valid`);
    if (offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return packets;
}

/** Incremental pkt-line decoder for a streaming body. */
export class PktLineDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
  }

  next(): PktPacket | null {
    if (this.#buffer.length < 4) return null;
    const hex = this.#buffer.subarray(0, 4).toString('ascii');
    if (hex === '0000') {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (hex === '0001') {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    const length = parseInt(hex, 16);
    if (!Number.isFinite(length) || length < 4 || length > PKT_LINE_MAX) throw new Error(`pkt-line length ${hex} is not valid`);
    if (this.#buffer.length < length) return null;
    const payload = Buffer.from(this.#buffer.subarray(4, length));
    this.#buffer = this.#buffer.subarray(length);
    return { kind: 'data', payload };
  }

  finish(): void {
    if (this.#buffer.length > 0) throw new Error('trailing bytes after the last pkt-line');
  }

  /** The bytes not yet consumed as pkt-lines (the raw pack after a command list). */
  remainder(): Buffer {
    return this.#buffer;
  }
}

// ---------------------------------------------------------------- objects

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree entry (no mode)');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry (no name/oid)');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git tree sort: entries by name, directories as if the name had a trailing '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPE_COMMIT = 1;
const PACK_TYPE_TREE = 2;
const PACK_TYPE_BLOB = 3;
const PACK_TYPE_TAG = 4;
const PACK_TYPE_OFS_DELTA = 6;
const PACK_TYPE_REF_DELTA = 7;

function packTypeName(code: number): ObjectType | null {
  if (code === PACK_TYPE_COMMIT) return 'commit';
  if (code === PACK_TYPE_TREE) return 'tree';
  if (code === PACK_TYPE_BLOB) return 'blob';
  if (code === PACK_TYPE_TAG) return 'tag';
  return null;
}

function packTypeCode(type: ObjectType): number {
  if (type === 'commit') return PACK_TYPE_COMMIT;
  if (type === 'tree') return PACK_TYPE_TREE;
  if (type === 'blob') return PACK_TYPE_BLOB;
  return PACK_TYPE_TAG;
}

/** Apply a git delta (source-size varint, target-size varint, copy/insert ops) to `base`. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('truncated delta varint');
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} does not match base ${base.length}`);
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy offset');
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy size');
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('truncated delta insert');
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
}

/**
 * Read a packfile (version 2/3), inflate every object, resolve OFS/REF deltas.
 * `resolveBase` supplies objects the pack's thin deltas may name (a fetch's haves);
 * when it returns undefined the delta is resolved from the pack itself.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  // Trailer check: the last 20 bytes are sha1 of everything before them.
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer !== actual) throw new Error(`pack trailer ${trailer} does not match its bytes ${actual}`);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  const end = pack.length - 20;
  interface PendingDelta { baseOffset: number | null; baseOid: string | null; delta: Buffer; offset: number }
  const pending: PendingDelta[] = [];
  let parsed = 0;
  while (offset < end && parsed < declaredCount) {
    const startOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === PACK_TYPE_OFS_DELTA) {
      // Negative offset: 7 bits per byte, big-endian with the +1 chain.
      let byte2 = pack[offset] as number;
      offset += 1;
      let baseOffset = byte2 & 0x7f;
      while ((byte2 & 0x80) !== 0) {
        byte2 = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte2 & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      offset += inflated.consumed;
      pending.push({ baseOffset: startOffset - baseOffset, baseOid: null, delta: inflated.data, offset: startOffset });
      deltaCount += 1;
    } else if (typeCode === PACK_TYPE_REF_DELTA) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset += inflated.consumed;
      pending.push({ baseOffset: null, baseOid, delta: inflated.data, offset: startOffset });
      deltaCount += 1;
    } else {
      const type = packTypeName(typeCode);
      if (type === null) throw new Error(`pack object type ${typeCode} is unknown`);
      const inflated = inflateAt(pack, offset);
      offset += inflated.consumed;
      if (inflated.data.length !== size) throw new Error(`pack object size ${inflated.data.length} does not match header ${size}`);
      const oid = hashObject(type, inflated.data);
      const object: GitObject = { type, data: inflated.data };
      objects.set(oid, object);
      byOffset.set(startOffset, object);
    }
    parsed += 1;
  }
  if (parsed !== declaredCount) throw new Error(`pack declares ${declaredCount} objects, ${parsed} parsed`);
  // Resolve deltas (they may chain: resolve in offset order, retrying until settled).
  let remaining = pending;
  for (let round = 0; round <= pending.length + 1 && remaining.length > 0; round += 1) {
    const next: PendingDelta[] = [];
    for (const item of remaining) {
      let base: GitObject | undefined;
      if (item.baseOffset !== null) base = byOffset.get(item.baseOffset);
      else if (item.baseOid !== null) base = objects.get(item.baseOid) ?? resolveBase?.(item.baseOid);
      if (base === undefined) {
        next.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      const oid = hashObject(base.type, data);
      const object: GitObject = { type: base.type, data };
      objects.set(oid, object);
      byOffset.set(item.offset, object);
    }
    if (next.length === remaining.length) throw new Error('a pack delta names a base that is not in the pack');
    remaining = next;
  }
  return { objects, deltaCount, declaredCount };
}

/** Inflate one zlib stream starting at `offset`; returns the data and the exact bytes consumed. */
function inflateAt(pack: Buffer, offset: number): { data: Buffer; consumed: number } {
  const result = zlibInflate(pack.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

/** Build a packfile from plain objects (no deltas), version 2, with a SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeCode = packTypeCode(object.type);
    const size = object.data.length;
    const headerBytes: number[] = [];
    let first = (size & 0x0f) | (typeCode << 4);
    let rest = size >>> 4;
    if (rest !== 0) first |= 0x80;
    headerBytes.push(first);
    while (rest !== 0) {
      let byte = rest & 0x7f;
      rest >>>= 7;
      if (rest !== 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(zlibDeflate(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Verify a pack's trailer SHA-1. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 32) return { ok: false, actual: '', expected: '' };
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1Hex(pack.subarray(0, pack.length - 20));
  return { ok: actual === expected, actual, expected };
}

// ---------------------------------------------------------------- graph walks

/** Walk a commit's ancestry (parents first), calling `visit` on each commit oid. */
export function walkAncestry(
  objects: Map<string, GitObject>,
  tips: readonly string[],
  visit: (oid: string, commit: ParsedCommit) => void,
): void {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    visit(oid, commit);
    for (const parent of commit.parents) stack.push(parent);
  }
}

/** Whether `ancestor` is reachable from `oid` (or equals it). */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  let found = false;
  walkAncestry(objects, [oid], (current) => {
    if (current === ancestor) found = true;
  });
  return found;
}

/** The first commit reachable from both `a` and `b` (a merge base), or null. */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const fromA = new Set<string>();
  walkAncestry(objects, [a], (oid) => fromA.add(oid));
  let base: string | null = null;
  walkAncestry(objects, [b], (oid) => {
    if (base === null && fromA.has(oid)) base = oid;
  });
  return base;
}

/**
 * The objects a fetch must send: everything reachable from `wants` (commits, their trees
 * and blobs, tag targets) minus everything reachable from `haves`, limited to `depth`
 * generations from the wants when `depth` is given. Returns the object map plus the
 * shallow boundary commits (the deepest included commits whose parents were cut).
 */
export function fetchObjects(
  objects: Map<string, GitObject>,
  wants: readonly string[],
  haves: readonly string[],
  depth?: number,
  shallow: readonly string[] = [],
): { send: Map<string, GitObject>; boundary: string[] } {
  const shallowSet = new Set(shallow);
  /** The closure of one oid (commit + tree + blobs, tag target), into `into`. */
  const collect = (oid: string, into: Set<string>): void => {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (into.has(current)) continue;
      const object = objects.get(current);
      if (object === undefined) continue;
      into.add(current);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  };
  const excluded = new Set<string>();
  // The objects the client already holds: the closure of each have, but the walk
  // stops at a shallow boundary — a shallow commit's parents are NOT held.
  const collectExclude = (oid: string): void => {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (excluded.has(current)) continue;
      const object = objects.get(current);
      if (object === undefined) continue;
      excluded.add(current);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        // A shallow boundary's parents are not held by the client: do not exclude them.
        if (!shallowSet.has(current)) for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  };
  for (const have of haves) collectExclude(have);

  const included = new Set<string>();
  const boundary: string[] = [];
  // BFS by generation from the wants. An excluded commit is not sent, but the walk
  // still passes through it (a deepen must reach the parent of a held shallow tip).
  const queue: Array<{ oid: string; generation: number }> = wants.map((oid) => ({ oid, generation: 0 }));
  const seenCommit = new Set<string>();
  while (queue.length > 0) {
    const { oid, generation } = queue.shift() as { oid: string; generation: number };
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const object = objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      if (!excluded.has(oid)) included.add(oid);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, generation });
      continue;
    }
    if (object.type !== 'commit') continue;
    if (excluded.has(oid)) {
      // Held by the client: not sent, but its parents are still one generation on.
      const commit = parseCommit(object.data);
      if (depth === undefined || generation + 1 < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, generation: generation + 1 });
      }
      continue;
    }
    const commit = parseCommit(object.data);
    included.add(oid);
    // The commit's tree and blobs always travel with it.
    collect(commit.tree, included);
    if (depth !== undefined && generation + 1 >= depth) {
      // The parents are cut: this commit is a shallow boundary.
      if (commit.parents.length > 0) boundary.push(oid);
      continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, generation: generation + 1 });
  }
  // Remove anything the haves already cover (trees/blobs of excluded commits).
  for (const oid of [...included]) if (excluded.has(oid)) included.delete(oid);
  const send = new Map<string, GitObject>();
  for (const oid of included) {
    const object = objects.get(oid);
    if (object !== undefined) send.set(oid, object);
  }
  return { send, boundary };
}
