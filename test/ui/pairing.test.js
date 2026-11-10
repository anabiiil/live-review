import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairLines, lineKey, rowPositions, threadsByKey, diffStats, diffLineCount, maxLineLength } from '../../public/js/pairing.js';
import { parseRoute, commentIdFromHash } from '../../public/js/route.js';

/** @param {'add'|'del'|'ctx'} type @param {number|null} o @param {number|null} n @param {string} text */
const L = (type, o, n, text = `${type}${o ?? ''}${n ?? ''}`) => ({ type, oldNo: o, newNo: n, text });

test('pairLines: context on both sides', () => {
  const c = L('ctx', 1, 1);
  assert.deepEqual(pairLines([c]), [{ left: c, right: c }]);
});

test('pairLines: replacement block pairs the n-th deletion with the n-th addition', () => {
  const d1 = L('del', 2, null), d2 = L('del', 3, null), a1 = L('add', null, 2), a2 = L('add', null, 3);
  assert.deepEqual(pairLines([d1, d2, a1, a2]), [
    { left: d1, right: a1 },
    { left: d2, right: a2 },
  ]);
});

test('pairLines: uneven blocks leave blanks; pure add and pure del', () => {
  const d1 = L('del', 2, null), a1 = L('add', null, 2), a2 = L('add', null, 3);
  assert.deepEqual(pairLines([d1, a1, a2]), [
    { left: d1, right: a1 },
    { left: null, right: a2 },
  ]);
  assert.deepEqual(pairLines([d1]), [{ left: d1, right: null }]);
  assert.deepEqual(pairLines([a1]), [{ left: null, right: a1 }]);
});

test('pairLines: blocks separated by context are paired independently; adds before dels still pair', () => {
  const [d1, a1, c, a2, d2] = [L('del', 1, null), L('add', null, 1), L('ctx', 2, 2), L('add', null, 3), L('del', 3, null)];
  assert.deepEqual(pairLines([d1, a1, c, a2, d2]), [
    { left: d1, right: a1 },
    { left: c, right: c },
    { left: d2, right: a2 },
  ]);
  assert.deepEqual(pairLines([]), []);
});

test('rowPositions: del old, add new, ctx both (new first)', () => {
  assert.deepEqual(rowPositions('a.js', L('del', 4, null)), [{ side: 'old', line: 4, key: 'a.js:old:4' }]);
  assert.deepEqual(rowPositions('a.js', L('add', null, 5)), [{ side: 'new', line: 5, key: 'a.js:new:5' }]);
  assert.deepEqual(rowPositions('a.js', L('ctx', 6, 7)).map((p) => p.key), ['a.js:new:7', 'a.js:old:6']);
});

test('threadsByKey groups by path, side and line', () => {
  const t1 = { id: 1, path: 'a', side: /** @type {const} */ ('new'), line: 3 };
  const t2 = { id: 2, path: 'a', side: /** @type {const} */ ('new'), line: 3 };
  const t3 = { id: 3, path: 'a', side: /** @type {const} */ ('old'), line: 3 };
  const t4 = { id: 4, path: 'a', side: null, line: null };
  const m = threadsByKey([t1, t2, t3, t4]);
  assert.deepEqual(m.get(lineKey('a', 'new', 3)), [t1, t2]);
  assert.deepEqual(m.get(lineKey('a', 'old', 3)), [t3]);
  assert.equal(m.size, 2);
});

test('diff stats helpers', () => {
  const f = /** @type {any} */ ({ hunks: [{ header: '', lines: [L('add', null, 1, 'abc'), L('del', 1, null, 'abcdef'), L('ctx', 2, 2, 'x')] }] });
  assert.deepEqual(diffStats(f), { add: 1, del: 1 });
  assert.equal(diffLineCount(f), 3);
  assert.equal(maxLineLength(f), 6);
});

test('parseRoute', () => {
  assert.deepEqual(parseRoute('/'), { name: 'projects' });
  assert.deepEqual(parseRoute('/login'), { name: 'login' });
  assert.deepEqual(parseRoute('/nwc-legal'), { name: 'project', slug: 'nwc-legal' });
  assert.deepEqual(parseRoute('/nwc-legal/live'), { name: 'live', slug: 'nwc-legal' });
  assert.deepEqual(parseRoute('/nwc-legal/commits'), { name: 'commits', slug: 'nwc-legal' });
  assert.deepEqual(parseRoute('/nwc-legal/commit/abcdef1'), { name: 'commit', slug: 'nwc-legal', sha: 'abcdef1' });
  for (const bad of ['/nwc-legal/commit/xyz', '/nwc-legal/other', '/A/live', '/a/b/c/d', '/%E0%A4%A', '/nwc-legal/']) {
    assert.deepEqual(parseRoute(bad), { name: 'notfound' }, bad);
  }
});

test('commentIdFromHash', () => {
  assert.equal(commentIdFromHash('#c-42'), 42);
  assert.equal(commentIdFromHash('#c-'), null);
  assert.equal(commentIdFromHash('#c-4x'), null);
  assert.equal(commentIdFromHash(''), null);
});
