import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, parse, resolve } from 'node:path';
import { runGit } from './run.js';

/** @typedef {import('../types.js').HeadState} HeadState */
/** @typedef {import('../types.js').CommitSummary} CommitSummary */

/** Object id of git's empty tree; the "before" side when diffing a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A full or abbreviated (7-40 hex) commit id. */
export const SHA_RE = /^[0-9a-f]{7,40}$/;

/** Error for repository-level problems; `reason` is a stable machine-readable code. */
export class RepoError extends Error {
  /**
   * @param {'not-a-repo'|'not-root'|'forbidden'|'unknown-commit'|string} reason
   * @param {string} [message]
   */
  constructor(reason, message) {
    super(message ?? reason);
    this.name = 'RepoError';
    /** @type {string} */
    this.reason = reason;
  }
}

/**
 * Normalize a path for comparison (case-insensitive on Windows).
 * @param {string} p
 */
function comparable(p) {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * @param {string} p
 * @returns {Promise<string>}
 */
async function realpathOr(p) {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Validate that `path` is exactly the top level of a git work tree and is not
 * the home directory or a filesystem root.
 * @param {string} path
 * @returns {Promise<string>} the normalized top level reported by git
 */
export async function validateRepoRoot(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
    throw new RepoError('not-a-repo', 'path must be an absolute folder path');
  }
  /** @type {string} */
  let real;
  try {
    real = await realpath(path);
  } catch {
    throw new RepoError('not-a-repo', 'folder does not exist');
  }
  if (comparable(real) === comparable(parse(real).root) || comparable(real) === comparable(await realpathOr(homedir()))) {
    throw new RepoError('forbidden', 'this folder cannot be added');
  }
  const { stdout, code } = await runGit(real, ['rev-parse', '--show-toplevel'], { allowFail: true });
  const top = stdout.replace(/\r?\n$/, '');
  if (code !== 0 || top === '') {
    throw new RepoError('not-a-repo', 'folder is not a git work tree');
  }
  const topReal = await realpathOr(top);
  if (comparable(topReal) !== comparable(real)) {
    throw new RepoError('not-root', 'folder is not the repository root');
  }
  return resolve(top);
}

/**
 * @param {string} root
 * @returns {Promise<HeadState>}
 */
export async function headState(root) {
  const [branchRes, shaRes, paths] = await Promise.all([
    runGit(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true }),
    runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }),
    runGit(root, ['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'MERGE_HEAD']),
  ]);
  const branch = branchRes.code === 0 ? branchRes.stdout.replace(/\n$/, '') : null;
  const sha = shaRes.code === 0 ? shaRes.stdout.trim() : null;
  const [rebaseMerge, rebaseApply, mergeHead] = paths.stdout.replace(/\n$/, '').split('\n');
  /** @param {string} rel */
  const exists = (rel) =>
    access(resolve(root, rel)).then(
      () => true,
      () => false,
    );
  /** @type {HeadState['operation']} */
  let operation = null;
  if ((await exists(rebaseMerge)) || (await exists(rebaseApply))) operation = 'rebase';
  else if (await exists(mergeHead)) operation = 'merge';
  return { branch, detached: branch === null && sha !== null, sha, empty: sha === null, operation };
}

/**
 * @param {string} root
 * @param {{skip?: number, limit?: number}} [opts]
 * @returns {Promise<{commits: CommitSummary[], hasMore: boolean}>}
 */
export async function listCommits(root, { skip = 0, limit = 50 } = {}) {
  if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('skip must be >= 0 and limit must be >= 1');
  }
  const head = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  if (head.code !== 0) return { commits: [], hasMore: false };
  const { stdout } = await runGit(root, [
    'log',
    '--no-color',
    '--no-ext-diff',
    '-z',
    `--skip=${skip}`,
    `--max-count=${limit + 1}`,
    '--format=%H%x00%h%x00%s%x00%an%x00%aI',
    'HEAD',
    '--',
  ]);
  const fields = stdout.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  /** @type {CommitSummary[]} */
  const all = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    all.push({
      sha: fields[i],
      short: fields[i + 1],
      subject: fields[i + 2],
      author: fields[i + 3],
      date: fields[i + 4],
    });
  }
  return { commits: all.slice(0, limit), hasMore: all.length > limit };
}

/**
 * @param {string} root
 * @param {string} sha full or abbreviated (7-40 hex) commit id
 * @returns {Promise<{sha:string, author:string, email:string, date:string, message:string, parents:string[]}>}
 */
export async function commitInfo(root, sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new RepoError('unknown-commit');
  const verify = await runGit(root, ['rev-parse', '--verify', '-q', `${sha}^{commit}`], { allowFail: true });
  if (verify.code !== 0) throw new RepoError('unknown-commit');
  const full = verify.stdout.trim();
  const { stdout } = await runGit(root, [
    'log',
    '--no-color',
    '--no-ext-diff',
    '--no-walk',
    '-z',
    '--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%B',
    full,
    '--',
  ]);
  const [h, author, email, date, parents, body] = stdout.split('\0');
  return {
    sha: h,
    author,
    email,
    date,
    message: body.trimEnd(),
    parents: parents === '' ? [] : parents.split(' '),
  };
}

/**
 * Committer time of a commit in epoch ms; null when it cannot be read.
 * @param {string} root
 * @param {string} sha full commit id
 * @returns {Promise<number|null>}
 */
export async function commitTime(root, sha) {
  if (!SHA_RE.test(sha)) return null;
  const { stdout, code } = await runGit(root, ['log', '-1', '--no-walk', '--no-color', '--format=%ct', sha, '--'], { allowFail: true });
  const secs = Number.parseInt(stdout.trim(), 10);
  return code === 0 && Number.isFinite(secs) ? secs * 1000 : null;
}

/**
 * Contents of a blob at a revision as UTF-8 text, or null when the revision
 * or path does not exist or is not a blob (directory, submodule).
 * @param {string} root
 * @param {string} rev
 * @param {string} path repo-relative, forward slashes
 * @returns {Promise<string|null>}
 */
export async function fileAt(root, rev, path) {
  if (typeof rev !== 'string' || rev === '' || rev.startsWith('-')) throw new RepoError('unknown-commit');
  const { stdout, code } = await runGit(root, ['cat-file', 'blob', `${rev}:${path}`], { allowFail: true });
  return code === 0 ? stdout : null;
}

/**
 * Whether a commit is contained in at least one local branch.
 * @param {string} root
 * @param {string} sha
 * @returns {Promise<boolean>}
 */
export async function isReachable(root, sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) return false;
  const { stdout, code } = await runGit(
    root,
    ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', sha, 'refs/heads'],
    { allowFail: true },
  );
  return code === 0 && stdout.trim() !== '';
}

/**
 * Absolute path of the repository's git directory.
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function gitDir(root) {
  const { stdout } = await runGit(root, ['rev-parse', '--absolute-git-dir']);
  return resolve(stdout.replace(/\r?\n$/, ''));
}
