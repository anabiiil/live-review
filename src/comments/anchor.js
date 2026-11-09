/** @typedef {import('../types.js').Anchor} Anchor */

const CONTEXT = 3;

/** @param {string} s */
const strip = (s) => (s.endsWith('\r') ? s.slice(0, -1) : s);

/**
 * Build a content anchor for a line so a comment can be re-located after the
 * file changes. Lines are 1-based; trailing "\r" is stripped everywhere.
 * @param {string[]} lines
 * @param {number} lineNo
 * @returns {Anchor}
 */
export function makeAnchor(lines, lineNo) {
  if (!Number.isInteger(lineNo) || lineNo < 1 || lineNo > lines.length) {
    throw new RangeError(`line ${lineNo} out of range 1..${lines.length}`);
  }
  const i = lineNo - 1;
  return {
    lineText: strip(lines[i]),
    before: lines.slice(Math.max(0, i - CONTEXT), i).map(strip),
    after: lines.slice(i + 1, i + 1 + CONTEXT).map(strip),
  };
}

/**
 * Find where an anchored line now lives. A candidate must match the line text
 * and every stored context line at the same relative offset (missing lines
 * fail). Returns the 1-based candidate nearest `oldLine` (ties go to the lower
 * line), or null when the anchor is orphaned.
 * @param {string[]} lines
 * @param {Anchor} anchor
 * @param {number} oldLine
 * @returns {number|null}
 */
export function findAnchor(lines, anchor, oldLine) {
  const { lineText, before, after } = anchor;
  /** @type {number|null} */
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < lines.length; i++) {
    if (strip(lines[i]) !== lineText) continue;
    if (!matchesAt(lines, i - before.length, before)) continue;
    if (!matchesAt(lines, i + 1, after)) continue;
    const dist = Math.abs(i + 1 - oldLine);
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
 * @param {number} start index of the first expected line
 * @param {string[]} expected
 */
function matchesAt(lines, start, expected) {
  if (start < 0 || start + expected.length > lines.length) return false;
  return expected.every((e, k) => strip(lines[start + k]) === e);
}
