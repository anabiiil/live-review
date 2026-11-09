import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileAt, isReachable } from '../git/repo.js';
import { isHidden } from '../privacy/hidden.js';
import { findAnchor, makeAnchor } from './anchor.js';

/** @typedef {import('../types.js').FileDiff} FileDiff */
/** @typedef {import('./store.js').Comment} Comment */

/**
 * Whether `line` is shown in the diff on the given side.
 * @param {FileDiff} file
 * @param {'old'|'new'} side
 * @param {number} line
 */
export function visibleInDiff(file, side, line) {
  return file.hunks.some((h) =>
    h.lines.some((l) =>
      side === 'new' ? l.newNo === line && (l.type === 'add' || l.type === 'ctx') : l.oldNo === line && (l.type === 'del' || l.type === 'ctx'),
    ),
  );
}

/** @param {FileDiff} f */
const usable = (f) => !f.hidden && !f.binary;

/**
 * Working-tree file as text; null when missing, not a regular file (symlinks are not followed) or unreadable.
 * @param {string} root
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function workingTreeFile(root, path) {
  try {
    const full = join(root, ...path.split('/'));
    const st = await lstat(full);
    if (!st.isFile()) return null;
    return await readFile(full, 'utf8');
  } catch {
    return null;
  }
}

/** Comments that can be matched: anchored (not wiped) top-level comments with a line and side. */
const matchable = (/** @type {Comment} */ c) => c.anchor !== null && !c.hidden && c.line !== null && c.side !== null;

/**
 * Re-anchor live comments against the current live diff. Comments move with their line;
 * a comment whose line is gone from the diff is marked outdated.
 * @param {{root:string, projectId:number, files:FileDiff[], store:ReturnType<typeof import('./store.js').createCommentStore>, extraHidden?:string[]}} args
 * @returns {Promise<number[]>} ids of comments whose line or outdated flag changed
 */
export async function reanchorLive({ root, projectId, files, store, extraHidden = [] }) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  /** @type {Map<string, string[]|null>} */
  const cache = new Map();
  /** @type {number[]} */
  const changed = [];
  for (const c of store.liveActive(projectId).filter(matchable)) {
    const side = /** @type {'old'|'new'} */ (c.side);
    const file = byPath.get(c.path);
    /** @type {string[]|null} */
    let lines = null;
    if (file && usable(file) && !isHidden(c.path, extraHidden)) {
      const readPath = side === 'old' ? (file.oldPath ?? file.path) : file.path;
      const key = `${side}\0${readPath}`;
      if (!cache.has(key)) {
        const text = side === 'new' ? await workingTreeFile(root, readPath) : await fileAt(root, 'HEAD', readPath);
        cache.set(key, text === null ? null : text.split('\n'));
      }
      lines = cache.get(key) ?? null;
    }
    const found = file && lines ? findAnchor(lines, /** @type {any} */ (c.anchor), /** @type {number} */ (c.line)) : null;
    if (file && lines && found !== null && visibleInDiff(file, side, found)) {
      if (found !== c.line) {
        store.updatePosition(c.id, { line: found, anchor: makeAnchor(lines, found) });
        changed.push(c.id);
      }
    } else {
      store.updatePosition(c.id, { outdated: true });
      changed.push(c.id);
    }
  }
  return changed;
}

/**
 * After a new commit, move live comments that landed in it onto the commit.
 * Comments that do not match are left alone (the next reanchorLive marks them).
 * @param {{root:string, projectId:number, sha:string, commitFiles:FileDiff[], store:ReturnType<typeof import('./store.js').createCommentStore>}} args
 * @returns {Promise<number[]>} ids of comments now targeting `sha`
 */
export async function attachOnCommit({ root, projectId, sha, commitFiles, store }) {
  const byPath = new Map(commitFiles.map((f) => [f.path, f]));
  /** @type {number[]} */
  const moved = [];
  for (const c of store.liveActive(projectId).filter(matchable)) {
    const file = byPath.get(c.path);
    if (!file || !usable(file)) continue;
    const side = /** @type {'old'|'new'} */ (c.side);
    const text = side === 'new' ? await fileAt(root, sha, file.path) : await fileAt(root, `${sha}^`, file.oldPath ?? file.path);
    if (text === null) continue;
    const lines = text.split('\n');
    const found = findAnchor(lines, /** @type {any} */ (c.anchor), /** @type {number} */ (c.line));
    if (found === null || !visibleInDiff(file, side, found)) continue;
    store.updatePosition(c.id, { target: sha, line: found, anchor: makeAnchor(lines, found) });
    moved.push(c.id);
  }
  return moved;
}

/**
 * Flag comments on commits that are no longer reachable from any branch (amend, rebase, reset)
 * and clear the flag again if a commit becomes reachable.
 * @param {{root:string, projectId:number, store:ReturnType<typeof import('./store.js').createCommentStore>}} args
 * @returns {Promise<number[]>} ids of comments whose flag changed
 */
export async function markRewritten({ root, projectId, store }) {
  /** @type {number[]} */
  const changed = [];
  for (const sha of store.commitTargets(projectId)) {
    changed.push(...store.setRewritten(projectId, sha, !(await isReachable(root, sha))));
  }
  return changed;
}
