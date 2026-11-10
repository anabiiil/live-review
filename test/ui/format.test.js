import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBody, relativeTime, headLabel, splitMessage } from '../../public/js/format.js';

test('parseBody: plain text stays one node', () => {
  assert.deepEqual(parseBody('hello\nworld'), [{ kind: 'text', text: 'hello\nworld' }]);
  assert.deepEqual(parseBody(''), []);
});

test('parseBody: inline code splits text around it', () => {
  assert.deepEqual(parseBody('use `foo()` here, not `bar`.'), [
    { kind: 'text', text: 'use ' },
    { kind: 'code', text: 'foo()' },
    { kind: 'text', text: ' here, not ' },
    { kind: 'code', text: 'bar' },
    { kind: 'text', text: '.' },
  ]);
});

test('parseBody: unmatched or empty backticks stay text; inline code never spans lines', () => {
  assert.deepEqual(parseBody('a ` b'), [{ kind: 'text', text: 'a ` b' }]);
  assert.deepEqual(parseBody('a `` b'), [{ kind: 'text', text: 'a `` b' }]);
  assert.deepEqual(parseBody('a `x\ny` b'), [{ kind: 'text', text: 'a `x\ny` b' }]);
});

test('parseBody: fenced block becomes pre, surrounding text kept', () => {
  assert.deepEqual(parseBody('before\n```js\nconst a = 1;\n  b();\n```\nafter `x`'), [
    { kind: 'text', text: 'before' },
    { kind: 'pre', text: 'const a = 1;\n  b();' },
    { kind: 'text', text: 'after ' },
    { kind: 'code', text: 'x' },
  ]);
});

test('parseBody: backticks inside a fence are not inline code; unclosed fence runs to the end', () => {
  assert.deepEqual(parseBody('```\nuse `x`\n'), [{ kind: 'pre', text: 'use `x`\n' }]);
  assert.deepEqual(parseBody('```\na\n```'), [{ kind: 'pre', text: 'a' }]);
});

test('parseBody: markup is never interpreted, it is returned as text', () => {
  const nodes = parseBody('<img src=x onerror=alert(1)> **b** [l](javascript:x)');
  assert.deepEqual(nodes, [{ kind: 'text', text: '<img src=x onerror=alert(1)> **b** [l](javascript:x)' }]);
});

test('relativeTime', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  assert.equal(relativeTime(now - 10_000, now), 'just now');
  assert.equal(relativeTime(now + 10_000, now), 'just now');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 min ago');
  assert.equal(relativeTime('2026-11-09T09:00:00Z', now), '3 h ago');
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2 d ago');
  assert.equal(relativeTime('2026-08-01T10:00:00Z', now), '2026-08-01');
  assert.equal(relativeTime('garbage', now), '');
});

test('headLabel', () => {
  const base = { branch: 'main', detached: false, sha: 'abcdef0123', empty: false, operation: null };
  assert.deepEqual(headLabel(base), { label: 'main', banner: null });
  assert.equal(headLabel({ ...base, branch: null, detached: true }).label, 'detached at abcdef0');
  assert.equal(headLabel({ ...base, empty: true, sha: null }).label, 'main (no commits yet)');
  assert.match(headLabel({ ...base, operation: 'rebase' }).banner ?? '', /rebase/i);
  assert.match(headLabel({ ...base, operation: 'merge' }).banner ?? '', /merge/i);
  assert.deepEqual(headLabel(null), { label: '', banner: null });
});

test('splitMessage', () => {
  assert.deepEqual(splitMessage('subject'), { subject: 'subject', rest: '' });
  assert.deepEqual(splitMessage('subject\n\nbody line\nmore'), { subject: 'subject', rest: 'body line\nmore' });
});
