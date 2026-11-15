// The forge's in-memory store: repositories, git objects, refs, issues, pull requests.
// Everything is deterministic: server-made commits and timestamps come from a fixed
// epoch plus a monotonic counter, so the same request sequence leaves the same state
// on a live run and on a replay. No wall clock, no Math.random, no disk.

import { SCENARIO_EPOCH_SEC, VIEWER_EMAIL, VIEWER_IDENT, VIEWER_LOGIN } from './scenario.ts';
import {
  ZERO_OID,
  buildTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjectType,
  type TreeEntry,
} from './gitobj.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** A flat path -> blob map for one tree. */
export type FileMap = Map<string, { oid: string; mode: string }>;

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  nextLabelId = 1;
  #counter = 0;

  /** A deterministic timestamp: the scenario epoch plus one second per event, ISO. */
  nowIso(): string {
    this.#counter += 1;
    return new Date((SCENARIO_EPOCH_SEC + this.#counter) * 1000).toISOString();
  }

  /** A deterministic git timestamp (seconds since epoch) for server-made commits. */
  nowEpochSec(): number {
    this.#counter += 1;
    return SCENARIO_EPOCH_SEC + this.#counter;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER_LOGIN,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.#counter,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The flat file map of a tree, recursively. */
  treeFileMap(repo: Repo, treeOid: string): FileMap {
    const map: FileMap = new Map();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else map.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return map;
  }

  /** Build (and store) the tree objects for a flat file map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, files: FileMap): string {
    // Group files by directory, bottom-up.
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    const dirOf = (path: string): string => {
      const slash = path.lastIndexOf('/');
      return slash < 0 ? '' : path.slice(0, slash);
    };
    for (const [path, file] of files) {
      const dir = dirOf(path);
      let entries = dirs.get(dir);
      if (entries === undefined) {
        entries = new Map();
        dirs.set(dir, entries);
      }
      entries.set(path.slice(dir === '' ? 0 : dir.length + 1), file);
    }
    // Ensure every ancestor directory exists in the map.
    const allDirs = new Set<string>(['']);
    for (const dir of [...dirs.keys()]) {
      let current = dir;
      while (current !== '') {
        allDirs.add(current);
        current = dirOf(current);
      }
    }
    for (const dir of allDirs) if (!dirs.has(dir)) dirs.set(dir, new Map());
    // Build deepest first ('' is depth 0; ''.split('/') would wrongly say 1).
    const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const sorted = [...allDirs].sort((a, b) => depthOf(b) - depthOf(a));
    const treeOids = new Map<string, string>();
    for (const dir of sorted) {
      const entries: TreeEntry[] = [];
      for (const [name, file] of dirs.get(dir) as Map<string, { oid: string; mode: string }>) {
        entries.push({ mode: file.mode, name, oid: file.oid });
      }
      // Subdirectories of this dir.
      for (const sub of allDirs) {
        if (dirOf(sub) === dir && sub !== '') {
          const name = sub.slice(dir === '' ? 0 : dir.length + 1);
          const oid = treeOids.get(sub);
          if (oid !== undefined) entries.push({ mode: '40000', name, oid });
        }
      }
      const treeData = buildTree(entries);
      treeOids.set(dir, this.putObject(repo, 'tree', treeData));
    }
    return treeOids.get('') as string;
  }

  /** Create a commit object (deterministic timestamp + viewer identity) and store it. */
  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const stamp = `${this.nowEpochSec()} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${VIEWER_IDENT} ${stamp}`);
    lines.push(`committer ${VIEWER_IDENT} ${stamp}`);
    const text = `${lines.join('\n')}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
    return this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  }

  /** The tip oid of a branch, or null when the ref does not exist. */
  refTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All branches as {name, sha}, sorted by name. */
  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Commits reachable from `tip`, newest first (parents after children, DFS by first parent order). */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; parents: string[] }> {
    const out: Array<{ sha: string; message: string; parents: string[] }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message.replace(/\n$/, ''), parents: commit.parents });
      // Push parents reversed so the first parent is visited first.
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  // ------------------------------------------------------------ contents API

  /** Read a file or directory at `path` on `branch`. Returns null when missing. */
  readPath(
    repo: Repo,
    branch: string,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
    const tip = this.refTip(repo, branch);
    if (tip === null) return null;
    const tipObject = repo.objects.get(tip);
    if (tipObject === undefined || tipObject.type !== 'commit') return null;
    const files = this.treeFileMap(repo, parseCommit(tipObject.data).tree);
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (clean === '') {
      const entries: Array<{ name: string; path: string; oid: string; mode: string }> = [];
      const seen = new Set<string>();
      for (const [filePath, file] of files) {
        const top = filePath.split('/')[0] as string;
        if (seen.has(top)) continue;
        seen.add(top);
        const isDir = filePath.includes('/');
        entries.push({ name: top, path: top, oid: isDir ? this.dirOid(repo, tip, top) : file.oid, mode: isDir ? '40000' : file.mode });
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      return { kind: 'dir', entries };
    }
    const file = files.get(clean);
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid);
      if (blob === undefined) return null;
      return { kind: 'file', oid: file.oid, data: blob.data };
    }
    // A directory: any file under clean/.
    const prefix = `${clean}/`;
    const entries: Array<{ name: string; path: string; oid: string; mode: string }> = [];
    const seen = new Map<string, { oid: string; mode: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const top = rest.split('/')[0] as string;
      if (seen.has(top)) continue;
      const isDir = rest.includes('/');
      seen.set(top, { oid: isDir ? this.dirOid(repo, tip, `${clean}/${top}`) : entry.oid, mode: isDir ? '40000' : entry.mode });
    }
    if (seen.size === 0) return null;
    for (const [name, entry] of seen) entries.push({ name, path: `${clean}/${name}`, oid: entry.oid, mode: entry.mode });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { kind: 'dir', entries };
  }

  /** The tree oid of a directory path at a commit tip ('' for the root). */
  dirOid(repo: Repo, tip: string, dirPath: string): string {
    const tipObject = repo.objects.get(tip);
    if (tipObject === undefined || tipObject.type !== 'commit') return ZERO_OID;
    let treeOid = parseCommit(tipObject.data).tree;
    if (dirPath === '' || dirPath === '/') return treeOid;
    for (const segment of dirPath.split('/')) {
      const treeObject = repo.objects.get(treeOid);
      if (treeObject === undefined || treeObject.type !== 'tree') return ZERO_OID;
      const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return ZERO_OID;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  /**
   * Write (create/update) or delete one file on `branch`, creating a commit.
   * Returns the new commit sha and the blob sha (null on delete).
   */
  writePath(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null; created: boolean } {
    const tip = this.refTip(repo, branch);
    const files: FileMap = new Map();
    const parents: string[] = [];
    if (tip !== null) {
      const tipObject = repo.objects.get(tip);
      if (tipObject !== undefined && tipObject.type === 'commit') {
        for (const [filePath, file] of this.treeFileMap(repo, parseCommit(tipObject.data).tree)) files.set(filePath, file);
        parents.push(tip);
      }
    }
    const clean = path.replace(/^\/+/, '');
    const existed = files.has(clean);
    let blobSha: string | null = null;
    if (content === null) {
      files.delete(clean);
    } else {
      blobSha = this.putObject(repo, 'blob', content);
      files.set(clean, { oid: blobSha, mode: '100644' });
    }
    const treeOid = this.buildTreeFromMap(repo, files);
    const commitSha = this.makeCommit(repo, treeOid, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha, created: !existed };
  }

  // ------------------------------------------------------------ issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const stamp = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: stamp,
      updatedAt: stamp,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.refTip(repo, headRef);
    const baseSha = this.refTip(repo, baseRef);
    if (headSha === null || baseSha === null) return null;
    const base = mergeBase(repo.objects, headSha, baseSha) ?? baseSha;
    const stamp = this.nowIso();
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeBaseSha: base,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.nextPullId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** The file diff between two trees (flat maps), as changes. */
  diffFileMaps(oldFiles: FileMap, newFiles: FileMap): FileChange[] {
    const changes: FileChange[] = [];
    const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = oldFiles.get(path);
      const newEntry = newFiles.get(path);
      if (oldEntry === undefined && newEntry !== undefined) {
        changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
      } else if (oldEntry !== undefined && newEntry === undefined) {
        changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
      } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
        changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
    return changes;
  }

  /** The files of a pull request: the merge-base..head diff. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const baseObject = repo.objects.get(pull.mergeBaseSha);
    const headObject = repo.objects.get(pull.headSha);
    if (baseObject === undefined || headObject === undefined) return [];
    if (baseObject.type !== 'commit' || headObject.type !== 'commit') return [];
    const oldFiles = this.treeFileMap(repo, parseCommit(baseObject.data).tree);
    const newFiles = this.treeFileMap(repo, parseCommit(headObject.data).tree);
    return this.diffFileMaps(oldFiles, newFiles);
  }

  /** Whether a pull request merges cleanly (no file changed differently on both sides). */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const baseTipSha = this.refTip(repo, pull.baseRef);
    if (baseTipSha === null) return false;
    const baseObject = repo.objects.get(pull.mergeBaseSha);
    const headObject = repo.objects.get(pull.headSha);
    const tipObject = repo.objects.get(baseTipSha);
    if (baseObject === undefined || headObject === undefined || tipObject === undefined) return false;
    if (baseObject.type !== 'commit' || headObject.type !== 'commit' || tipObject.type !== 'commit') return false;
    const baseFiles = this.treeFileMap(repo, parseCommit(baseObject.data).tree);
    const headFiles = this.treeFileMap(repo, parseCommit(headObject.data).tree);
    const tipFiles = this.treeFileMap(repo, parseCommit(tipObject.data).tree);
    const changes = this.diffFileMaps(baseFiles, headFiles);
    for (const change of changes) {
      const baseVersion = baseFiles.get(change.path)?.oid ?? null;
      const tipVersion = tipFiles.get(change.path)?.oid ?? null;
      const headVersion = headFiles.get(change.path)?.oid ?? null;
      if (tipVersion !== baseVersion && headVersion !== baseVersion && tipVersion !== headVersion) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit whose tree is the base
   * tree plus the head diff, parented on the base tip. Returns the merge commit sha,
   * or null when the pull is conflicted.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.merged || pull.state !== 'open') return null;
    if (!this.pullMergeable(repo, pull)) return null;
    const baseTipSha = this.refTip(repo, pull.baseRef);
    if (baseTipSha === null) return null;
    const baseObject = repo.objects.get(pull.mergeBaseSha);
    const headObject = repo.objects.get(pull.headSha);
    const tipObject = repo.objects.get(baseTipSha);
    if (baseObject === undefined || headObject === undefined || tipObject === undefined) return null;
    if (baseObject.type !== 'commit' || headObject.type !== 'commit' || tipObject.type !== 'commit') return null;
    const baseFiles = this.treeFileMap(repo, parseCommit(baseObject.data).tree);
    const headFiles = this.treeFileMap(repo, parseCommit(headObject.data).tree);
    const tipFiles = this.treeFileMap(repo, parseCommit(tipObject.data).tree);
    const merged = new Map(tipFiles);
    for (const change of this.diffFileMaps(baseFiles, headFiles)) {
      if (change.status === 'removed') merged.delete(change.path);
      else if (change.newOid !== null) merged.set(change.path, { oid: change.newOid, mode: '100644' });
    }
    const treeOid = this.buildTreeFromMap(repo, merged);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commitSha = this.makeCommit(repo, treeOid, [baseTipSha], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = commitSha;
    pull.updatedAt = pull.mergedAt;
    return commitSha;
  }

  /** Line counts for a file change (added/deleted lines, multiset diff). */
  fileLineCounts(repo: Repo, change: FileChange): { additions: number; deletions: number } {
    const linesOf = (oid: string | null): string[] => {
      if (oid === null) return [];
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'blob') return [];
      const text = object.data.toString('utf8');
      if (text === '') return [];
      return text.split('\n');
    };
    const oldLines = linesOf(change.oldOid);
    const newLines = linesOf(change.newOid);
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of newLines) {
      const left = oldCounts.get(line) ?? 0;
      if (left > 0) oldCounts.set(line, left - 1);
      else additions += 1;
    }
    let deletions = 0;
    for (const left of oldCounts.values()) deletions += left;
    return { additions, deletions };
  }
}

/** The one store for the process. */
export const store = new Store();

/** The repo object as the REST/GraphQL surfaces render it. */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.owner}/${repo.name}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: new Date(SCENARIO_EPOCH_SEC * 1000).toISOString(),
    updated_at: new Date(SCENARIO_EPOCH_SEC * 1000).toISOString(),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.owner}/${repo.name}#${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.owner}/${repo.name}#${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export { VIEWER_EMAIL };
