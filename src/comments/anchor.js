/** @typedef {import('../types.js').Anchor} Anchor */

const CONTEXT = 3;

/** @param {string} s */
const strip = (s) => (s.endsWith('\r') ? s.slice(0, -1) : s);

/**
 * Number of real lines: a trailing "" element (from a final newline) marks
 * end-of-file and is not a line.
 * @param {string[]} lines
 */
const realCount = (lines) =>
  lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

/**
 * Build a content anchor for a line so a comment can be re-located after the
 * file changes. Lines are 1-based; trailing "\r" is stripped everywhere and a
 * trailing "" element (final newline) is end-of-file, not a line.
 * @param {string[]} lines
 * @param {number} lineNo
 * @returns {Anchor}
 */
export function makeAnchor(lines, lineNo) {
  const n = realCount(lines);
  if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > n) {
    throw new RangeError(`line ${lineNo} out of range 1..${n}`);
  }
  const i = lineNo - 1;
  return {
    lineText: strip(lines[i]),
    before: lines.slice(Math.max(0, i - CONTEXT), i).map(strip),
    after: lines.slice(i + 1, Math.min(n, i + 1 + CONTEXT)).map(strip),
  };
}

/**
 * Find where an anchored line now lives. A candidate must match the line text
 * and every stored context line at the same relative offset (missing lines
 * fail). Returns the 1-based candidate nearest `oldLine` (ties go to the lower
 * line), or null when the anchor is orphaned. A trailing "" element is
 * end-of-file, not a line. A non-finite `oldLine` is treated as 1.
 * @param {string[]} lines
 * @param {Anchor} anchor
 * @param {number} oldLine
 * @returns {number|null}
 */
export function findAnchor(lines, anchor, oldLine) {
  const { lineText, before, after } = anchor;
  const n = realCount(lines);
  const target = Number.isFinite(oldLine) ? oldLine : 1;
  /** @type {number|null} */
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    if (strip(lines[i]) !== lineText) continue;
    if (!matchesAt(lines, n, i - before.length, before)) continue;
    if (!matchesAt(lines, n, i + 1, after)) continue;
    const dist = Math.abs(i + 1 - target);
    // Iteration is ascending, so strict "<" keeps the lower line on ties.
    if (dist < bestDist) {
      best = i + 1;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * @param {string[]} lines
 * @param {number} n count of real lines
 * @param {number} start index of the first expected line
 * @param {string[]} expected
 */
function matchesAt(lines, n, start, expected) {
  if (start < 0 || start + expected.length > n) return false;
  return expected.every((e, k) => strip(lines[start + k]) === e);
}
