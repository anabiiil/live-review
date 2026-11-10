import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { runGit } from './run.js';
import { parseDiff } from './parseDiff.js';
import { EMPTY_TREE, RepoError, commitInfo, headState } from './repo.js';
import { isHidden, redactFiles } from '../privacy/hidden.js';

/** @typedef {import('../types.js').FileDiff} FileDiff */
/** @typedef {import('../types.js').HeadState} HeadState */

/** Untracked files above this size are listed without content. */
const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** At most this many untracked files are listed. */
const MAX_UNTRACKED_FILES = 300;
/** Untracked files read at the same time. */
const READ_CONCURRENCY = 16;
/** A NUL byte within this many leading bytes marks a file as binary. */
const SNIFF_BYTES = 8192;

/** Flags that make `git diff` output independent of the user's git config. */
const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--submodule=short',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '-M',
];

/**
 * Throw RepoError('missing') unless `root` still exists and is a git work tree.
 * @param {string} root
 * @returns {Promise<string>} the real path of the root
 */
async function assertRepoPresent(root) {
  try {
    const real = await realpath(root);
    const st = await lstat(real);
    if (!st.isDirectory()) throw new Error('not a directory');
    const { stdout, code } = await runGit(real, ['rev-parse', '--show-toplevel'], { allowFail: true });
    const top = stdout.replace(/\r?\n$/, '');
    if (code !== 0 || top === '') throw new Error('not a repo');
    if (resolve(await realpath(top)) !== resolve(real)) throw new Error('not the repo root');
    return real;
  } catch {
    throw new RepoError('missing', 'the project folder no longer exists or is no longer a git repository');
  }
}

/**
 * Quote a path the way git does in diff headers (only when it holds control chars, `"` or `\`).
 * @param {string} p
 */
function quotePath(p) {
  if (!/[\u0000-\u001f\u007f"\\]/.test(p)) return p;
  const named = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\u0007': '\\a', '\b': '\\b', '\f': '\\f', '\v': '\\v', '"': '\\"', '\\': '\\\\' };
  let out = '';
  for (const ch of p) {
    if (ch in named) out += named[ch];
    else if (/[\u0000-\u001f\u007f]/.test(ch)) out += '\\' + ch.charCodeAt(0).toString(8).padStart(3, '0');
    else out += ch;
  }
  return `"${out}"`;
}

/**
 * Header lines up to (not including) the hunk, as git prints them for a new file.
 * @param {string} path
 * @param {string} mode
 */
function newFileHeader(path, mode) {
  return `diff --git ${quotePath('a/' + path)} ${quotePath('b/' + path)}\nnew file mode ${mode}\n`;
}

/**
 * Build an added-file FileDiff from raw content, as `git diff --no-index /dev/null file` would.
 * @param {string} path repo-relative path
 * @param {string} mode git file mode
 * @param {string} content
 * @returns {FileDiff}
 */
function addedFile(path, mode, content) {
  let patch = newFileHeader(path, mode);
  /** @type {FileDiff['hunks']} */
  let hunks = [];
  if (content !== '') {
    const noNewline = !content.endsWith('\n');
    const lines = content.split('\n');
    if (!noNewline) lines.pop();
    const tab = path.includes(' ') ? '\t' : '';
    patch += `--- /dev/null\n+++ ${quotePath('b/' + path)}${tab}\n@@ -0,0 +1,${lines.length} @@\n`;
    patch += lines.map((l) => '+' + l + '\n').join('');
    if (noNewline) patch += '\\ No newline at end of file\n';
    hunks = parseDiff(patch)[0]?.hunks ?? [];
  }
  return { path, oldPath: null, status: 'added', binary: false, hidden: false, large: false, hunks, patch };
}

/**
 * An added-file entry that carries no content.
 * @param {string} path
 * @param {{binary?: boolean, large?: boolean}} flags
 * @returns {FileDiff}
 */
function stubFile(path, { binary = false, large = false } = {}) {
  let patch = newFileHeader(path, '100644');
  if (binary) patch += `Binary files /dev/null and ${quotePath('b/' + path)} differ\n`;
  return { path, oldPath: null, status: 'added', binary, hidden: false, large, hunks: [], patch };
}

/**
 * @param {string} realRoot
 * @param {string} real
 */
function isInside(realRoot, real) {
  const rel = relative(realRoot, real);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/**
 * Read up to `length` bytes at `position`, looping over short reads; fewer only at end of file.
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {number} position
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
async function readUpTo(fh, position, length) {
  const buf = Buffer.alloc(Math.max(length, 0));
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await fh.read(buf, got, buf.length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/**
 * Synthesize an added FileDiff for an untracked path, or null when it must not be shown.
 * Never reads content of hidden, large or non-regular files.
 * @param {string} realRoot
 * @param {string} path repo-relative, forward slashes
 * @param {string[]} extraHidden
 * @returns {Promise<FileDiff|null>}
 */
async function untrackedFile(realRoot, path, extraHidden) {
  if (path.endsWith('/')) return null; // nested repository or directory
  if (isHidden(path, extraHidden)) return stubFile(path); // redacted later; content is never read
  const abs = resolve(realRoot, ...path.split('/'));
  try {
    const st = await lstat(abs);
    const real = await realpath(abs);
    if (!isInside(realRoot, real)) return null;
    if (st.isSymbolicLink()) {
      // Like git: a symlink's content is its target text; the target itself is never read.
      return addedFile(path, '120000', await readlink(abs));
    }
    if (!st.isFile()) return null;
    const mode = st.mode & 0o111 ? '100755' : '100644';
    if (st.size > MAX_UNTRACKED_BYTES) return stubFile(path, { large: true });

    // O_NOFOLLOW guards against the path being swapped for a symlink after the checks above.
    const fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const fst = await fh.stat();
      if (!fst.isFile()) return null;
      if (fst.size > MAX_UNTRACKED_BYTES) return stubFile(path, { large: true });
      // Sniff the first 8 KB before reading anything else, so binaries are rejected cheaply.
      const head = await readUpTo(fh, 0, Math.min(fst.size, SNIFF_BYTES));
      if (head.includes(0)) return stubFile(path, { binary: true });
      // One byte past the stat size notices a file that grew after the checks above.
      const rest = await readUpTo(fh, head.length, Math.min(fst.size + 1, MAX_UNTRACKED_BYTES + 1) - head.length);
      if (head.length + rest.length > MAX_UNTRACKED_BYTES) return stubFile(path, { large: true });
      const data = Buffer.concat([head, rest]);
      return addedFile(path, mode, data.toString('utf8'));
    } finally {
      await fh.close();
    }
  } catch {
    return null; // vanished, unreadable or dangling: skip
  }
}

/**
 * Working tree vs HEAD (staged and unstaged) plus untracked files, with hidden files redacted.
 * @param {string} root
 * @param {{extraHidden?: string[]}} [opts]
 * @returns {Promise<{head: HeadState, files: FileDiff[], untrackedTruncated: boolean}>}
 */
export async function liveDiff(root, { extraHidden = [] } = {}) {
  const realRoot = await assertRepoPresent(root);
  const head = await headState(root);
  const [diff, others] = await Promise.all([
    runGit(root, ['diff', ...DIFF_FLAGS, head.sha ?? EMPTY_TREE, '--']),
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const tracked = parseDiff(diff.stdout);

  const paths = others.stdout.split('\0').filter((p) => p !== '' && !p.endsWith('/'));
  const untrackedTruncated = paths.length > MAX_UNTRACKED_FILES;
  /** @type {FileDiff[]} */
  const untracked = [];
  // Bounded concurrency keeps open file handles well below the process limit.
  const wanted = paths.slice(0, MAX_UNTRACKED_FILES);
  for (let i = 0; i < wanted.length; i += READ_CONCURRENCY) {
    const batch = await Promise.all(wanted.slice(i, i + READ_CONCURRENCY).map((p) => untrackedFile(realRoot, p, extraHidden)));
    for (const f of batch) if (f) untracked.push(f);
  }

  const ignored = await ignoredPaths(root, tracked);
  return { head, files: redactFiles([...tracked, ...untracked], extraHidden, ignored), untrackedTruncated };
}

/**
 * Paths of changed tracked files (new or old side) that match .gitignore: tracked anyway, but the owner
 * meant them to stay private, so they are hidden like the hidden list.
 * @param {string} root
 * @param {FileDiff[]} files
 * @returns {Promise<Set<string>>}
 */
async function ignoredPaths(root, files) {
  const paths = new Set();
  for (const f of files) {
    paths.add(f.path);
    if (f.oldPath) paths.add(f.oldPath);
  }
  if (paths.size === 0) return new Set();
  // --no-index: check the ignore rules even for paths that are in the index.
  const { stdout, code } = await runGit(root, ['check-ignore', '--no-index', '--stdin', '-z'], {
    input: [...paths].join('\0') + '\0',
    allowFail: true,
  });
  // Exit code 1 means nothing matched; anything else is a failure, and failing closed shows nothing.
  if (code !== 0 && code !== 1) throw new Error(`git check-ignore failed with exit code ${code}`);
  return new Set(stdout.split('\0').filter((p) => p !== ''));
}

/**
 * Changes introduced by a commit (against its first parent), with hidden files redacted.
 * @param {string} root
 * @param {string} sha
 * @param {{extraHidden?: string[]}} [opts]
 * @returns {Promise<FileDiff[]>}
 */
export async function commitDiff(root, sha, { extraHidden = [] } = {}) {
  await assertRepoPresent(root);
  const info = await commitInfo(root, sha);
  const { stdout } = await runGit(root, ['diff', ...DIFF_FLAGS, info.parents[0] ?? EMPTY_TREE, info.sha, '--']);
  return redactFiles(parseDiff(stdout), extraHidden);
}
