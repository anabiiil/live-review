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

/** How long the deep-link flash runs (ms); kept in step with the `flash` animation in diff.css. */
export const FLASH_MS = 1600;

/**
 * What a margin mark (or a file header count) shows for a set of threads.
 * @param {{id:number, resolved:boolean, replies:any[]}[]} threads
 * @returns {{ids:number[], comments:number, open:number, resolved:boolean}} resolved: every thread is resolved
 */
export function markSummary(threads) {
  let comments = 0;
  let open = 0;
  for (const t of threads) {
    comments += 1 + t.replies.length;
    if (!t.resolved) open++;
  }
  return { ids: threads.map((t) => t.id), comments, open, resolved: threads.length > 0 && open === 0 };
}

/** @param {number} n */
export const commentCount = (n) => (n === 1 ? '1 comment' : `${n} comments`);

/**
 * Accessible name of a margin mark.
 * @param {{comments:number, resolved:boolean}} s
 * @param {number} line
 * @param {boolean} expanded
 */
export function markLabel(s, line, expanded) {
  const what = s.resolved ? (s.comments === 1 ? '1 resolved comment' : `${s.comments} resolved comments`) : commentCount(s.comments);
  return `${expanded ? 'Hide' : 'Show'} ${what} on line ${line}`;
}

/**
 * Toggle a group of threads: open them all when any is closed, else close them all.
 * @param {Set<number>} open
 * @param {number[]} ids
 * @returns {boolean} whether the group is now open
 */
export function toggleThreads(open, ids) {
  if (!ids.length) return false;
  const allOpen = ids.every((id) => open.has(id));
  for (const id of ids) {
    if (allOpen) open.delete(id);
    else open.add(id);
  }
  return !allOpen;
}

/**
 * The thread holding comment `id` (the top-level comment or one of its replies).
 * @template {{id:number, replies:{id:number}[]}} T
 * @param {T[]} threads
 * @param {number} id
 * @returns {T|null}
 */
export function threadForComment(threads, id) {
  return threads.find((t) => t.id === id || t.replies.some((r) => r.id === id)) ?? null;
}

/**
 * How far into the deep-link flash we are, so a re-render can resume it instead of restarting or dropping it.
 * @param {number|null} startedAt
 * @param {number} now
 * @returns {number|null} elapsed ms, or null when there is no flash running
 */
export function flashOffset(startedAt, now) {
  if (startedAt === null) return null;
  const elapsed = now - startedAt;
  return elapsed >= 0 && elapsed < FLASH_MS ? elapsed : null;
}
