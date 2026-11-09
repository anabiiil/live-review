import { runGit } from '../git/run.js';
import { validateRepoRoot } from '../git/repo.js';
import { isHidden } from '../privacy/hidden.js';

/**
 * Split NUL-separated git output into paths, dropping empty entries and
 * directory entries (untracked nested repositories are listed as "dir/").
 * @param {string} out
 * @returns {string[]}
 */
function splitPaths(out) {
  return out.split('\0').filter((p) => p !== '' && !p.endsWith('/'));
}

/**
 * Show which files of a repository reviewers would and would not see.
 * Considers tracked files plus untracked files that are not git-ignored.
 * @param {string} path absolute folder path; must be a repository root
 * @param {string[]} [extraHidden] additional basename globs
 * @returns {Promise<{root:string, visible:string[], hidden:string[]}>}
 * @throws {import('../git/repo.js').RepoError} when the path is not an acceptable repository root
 */
export async function previewProject(path, extraHidden = []) {
  const root = await validateRepoRoot(path);
  const [tracked, untracked] = await Promise.all([
    runGit(root, ['ls-files', '-z']),
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const all = new Set([...splitPaths(tracked.stdout), ...splitPaths(untracked.stdout)]);
  /** @type {string[]} */
  const visible = [];
  /** @type {string[]} */
  const hidden = [];
  for (const p of all) (isHidden(p, extraHidden) ? hidden : visible).push(p);
  const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);
  return { root, visible: visible.sort(cmp), hidden: hidden.sort(cmp) };
}
