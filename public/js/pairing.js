// Pure diff helpers (row pairing, comment placement keys). No DOM access: importable from node for tests.

/** @typedef {import('../../src/types.js').DiffLine} DiffLine */
/** @typedef {import('../../src/types.js').FileDiff} FileDiff */
/** @typedef {{left:DiffLine|null, right:DiffLine|null}} SplitRow */

/** Hunks longer than this many lines start collapsed. */
export const LARGE_DIFF_LINES = 400;

/**
 * Pair a hunk's lines for the side-by-side view: context lines sit on both sides; within a block of
 * changes the n-th deletion faces the n-th addition.
 * @param {DiffLine[]} lines
 * @returns {SplitRow[]}
 */
export function pairLines(lines) {
  /** @type {SplitRow[]} */
  const rows = [];
  /** @type {DiffLine[]} */
  let dels = [];
  /** @type {DiffLine[]} */
  let adds = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.type === 'ctx') {
      flush();
      rows.push({ left: l, right: l });
    } else if (l.type === 'del') dels.push(l);
    else adds.push(l);
  }
  flush();
  return rows;
}

/**
 * Key for a comment position, shared by threads, composers and drafts.
 * @param {string} path
 * @param {'old'|'new'} side
 * @param {number} line
 */
export const lineKey = (path, side, line) => `${path}:${side}:${line}`;

/**
 * The positions a unified-view row can hold comments for: deletions the old side, additions the new
 * side, context lines both.
 * @param {string} path
 * @param {DiffLine} l
 * @returns {{side:'old'|'new', line:number, key:string}[]}
 */
export function rowPositions(path, l) {
  /** @type {{side:'old'|'new', line:number, key:string}[]} */
  const out = [];
  if ((l.type === 'del' || l.type === 'ctx') && l.oldNo !== null) out.push({ side: 'old', line: l.oldNo, key: lineKey(path, 'old', l.oldNo) });
  if ((l.type === 'add' || l.type === 'ctx') && l.newNo !== null) out.push({ side: 'new', line: l.newNo, key: lineKey(path, 'new', l.newNo) });
  // Context lines show their new-side comments first.
  return out.reverse();
}

/**
 * Group top-level threads by position.
 * @template {{path:string, side:'old'|'new'|null, line:number|null}} T
 * @param {T[]} threads
 * @returns {Map<string, T[]>}
 */
export function threadsByKey(threads) {
  /** @type {Map<string, T[]>} */
  const map = new Map();
  for (const t of threads) {
    if (!t.side || t.line === null) continue;
    const k = lineKey(t.path, t.side, t.line);
    const list = map.get(k);
    if (list) list.push(t);
    else map.set(k, [t]);
  }
  return map;
}

/**
 * Number of lines a file's diff shows (hunk lines).
 * @param {FileDiff} f
 */
export const diffLineCount = (f) => f.hunks.reduce((n, h) => n + h.lines.length, 0);

/**
 * Added / deleted line counts.
 * @param {FileDiff} f
 */
export function diffStats(f) {
  let add = 0;
  let del = 0;
  for (const h of f.hunks) for (const l of h.lines) (l.type === 'add' ? add++ : l.type === 'del' && del++);
  return { add, del };
}

/**
 * Longest line (in characters) of a file's diff, for sizing the scrollable table.
 * @param {FileDiff} f
 */
export function maxLineLength(f) {
  let max = 0;
  for (const h of f.hunks) for (const l of h.lines) if (l.text.length > max) max = l.text.length;
  return max;
}
