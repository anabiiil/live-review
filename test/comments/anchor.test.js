import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAnchor, findAnchor } from '../../src/comments/anchor.js';

const base = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

test('makeAnchor captures up to 3 context lines either side, 1-based', () => {
  const a = makeAnchor(base, 5);
  assert.deepEqual(a, { lineText: 'five', before: ['two', 'three', 'four'], after: ['six', 'seven', 'eight'] });
});

test('makeAnchor near the edges has fewer context lines', () => {
  assert.deepEqual(makeAnchor(base, 1), { lineText: 'one', before: [], after: ['two', 'three', 'four'] });
  assert.deepEqual(makeAnchor(base, 8), { lineText: 'eight', before: ['five', 'six', 'seven'], after: [] });
});

test('makeAnchor strips trailing CR and rejects out-of-range lines', () => {
  const a = makeAnchor(['a\r', 'b\r', 'c\r'], 2);
  assert.deepEqual(a, { lineText: 'b', before: ['a'], after: ['c'] });
  assert.throws(() => makeAnchor(base, 0), RangeError);
  assert.throws(() => makeAnchor(base, 9), RangeError);
  assert.throws(() => makeAnchor(base, 1.5), RangeError);
});

test('unchanged file resolves to the same line', () => {
  for (let n = 1; n <= base.length; n++) {
    assert.equal(findAnchor(base, makeAnchor(base, n), n), n);
  }
});

test('two lines inserted above shift the line by 2', () => {
  const anchor = makeAnchor(base, 5);
  const edited = ['new1', 'new2', ...base];
  assert.equal(findAnchor(edited, anchor, 5), 7);
});

test('editing the commented line orphans the anchor', () => {
  const anchor = makeAnchor(base, 5);
  const edited = base.map((l) => (l === 'five' ? 'FIVE' : l));
  assert.equal(findAnchor(edited, anchor, 5), null);
});

test('editing a context line orphans the anchor', () => {
  const anchor = makeAnchor(base, 5);
  const edited = base.map((l) => (l === 'six' ? 'SIX' : l));
  assert.equal(findAnchor(edited, anchor, 5), null);
});

test('duplicate identical blocks resolve to the one nearest oldLine', () => {
  const block = ['x', 'a', 'b', 'target', 'c', 'd', 'y'];
  const lines = [...block, 'sep', ...block, 'sep', ...block];
  const anchor = makeAnchor(lines, 4); // first block
  const starts = [4, 12, 20];
  assert.equal(findAnchor(lines, anchor, 4), 4);
  assert.equal(findAnchor(lines, anchor, 11), starts[1]);
  assert.equal(findAnchor(lines, anchor, 13), starts[1]);
  assert.equal(findAnchor(lines, anchor, 100), starts[2]);
});

test('equidistant candidates tie to the lower line', () => {
  const block = ['x', 'a', 'b', 'target', 'c', 'd', 'y'];
  const lines = [...block, 'sep', ...block]; // targets at 4 and 12
  const anchor = makeAnchor(lines, 4);
  assert.equal(findAnchor(lines, anchor, 8), 4);
});

test('anchor from an LF file matches the CRLF version', () => {
  const anchor = makeAnchor(base, 5);
  const crlf = base.map((l) => `${l}\r`);
  assert.equal(findAnchor(crlf, anchor, 5), 5);
});

test('anchor at line 1 (no before context) works', () => {
  const anchor = makeAnchor(base, 1);
  assert.deepEqual(anchor.before, []);
  assert.equal(findAnchor(base, anchor, 1), 1);
  assert.equal(findAnchor(['zero', ...base], anchor, 1), 2);
});

test('last line works', () => {
  const anchor = makeAnchor(base, 8);
  assert.equal(findAnchor(base, anchor, 8), 8);
});

test('trailing empty element is end-of-file: sentinel line is out of range', () => {
  const withNl = [...base, ''];
  assert.throws(() => makeAnchor(withNl, 9), RangeError);
  assert.deepEqual(makeAnchor(withNl, 8), makeAnchor(base, 8));
});

test('last-line anchor survives an appended line', () => {
  const withNl = [...base, ''];
  const anchor = makeAnchor(withNl, 8);
  assert.equal(findAnchor([...base, 'nine', ''], anchor, 8), 8);
  assert.equal(findAnchor([...base, 'nine'], anchor, 8), 8);
});

test('last-line anchor from a file with final newline matches one without', () => {
  const anchor = makeAnchor([...base, ''], 8);
  assert.equal(findAnchor(base, anchor, 8), 8);
  assert.equal(findAnchor(['top', ...base], anchor, 8), 9);
});

test('last-line anchor from a file without final newline survives appends', () => {
  const anchor = makeAnchor(base, 8);
  assert.equal(findAnchor([...base, 'nine'], anchor, 8), 8);
  assert.equal(findAnchor([...base, ''], anchor, 8), 8);
});

test('non-finite oldLine is treated as 1', () => {
  const lines = ['x', 'a', 'x', 'a'];
  const anchor = { lineText: 'a', before: [], after: [] };
  assert.equal(findAnchor(lines, anchor, NaN), 2);
  assert.equal(findAnchor(lines, anchor, undefined), 2);
});

test('candidate lacking stored surrounding lines fails', () => {
  const anchor = makeAnchor(base, 5);
  assert.equal(findAnchor(['three', 'four', 'five'], anchor, 5), null);
  assert.equal(findAnchor([], anchor, 1), null);
});
