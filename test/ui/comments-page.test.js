import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMineThread, filterThreads, groupThreads, showInCodeHref, threadPlace, whereText, parseHidden, serializeHidden,
  hiddenKey, toggleHidden,
} from '../../public/js/comments-model.js';
import { parseRoute } from '../../public/js/route.js';

/** @param {Partial<any>} o */
const T = (o) => ({
  id: 1, path: 'src/app.php', line: 3, side: 'new', target: 'live', resolved: false, outdated: false, rewritten: false,
  hidden: false, authorEmail: 'rana@x.test', replies: [], ...o,
});

test('parseRoute: /:slug/comments', () => {
  assert.deepEqual(parseRoute('/demo/comments'), { name: 'comments', slug: 'demo' });
  assert.deepEqual(parseRoute('/demo/comments/x'), { name: 'notfound' });
});

test('isMineThread: started or replied to, case-insensitive', () => {
  assert.equal(isMineThread(T({}), 'RANA@x.test'), true);
  assert.equal(isMineThread(T({ replies: [{ authorEmail: 'sam@x.test' }] }), 'sam@x.test'), true);
  assert.equal(isMineThread(T({}), 'sam@x.test'), false);
});

test('filterThreads: status, only mine, hidden and counts', () => {
  const threads = [
    T({ id: 1 }),
    T({ id: 2, resolved: true }),
    T({ id: 3, authorEmail: 'sam@x.test' }),
    T({ id: 4, authorEmail: 'sam@x.test', resolved: true }),
  ];
  const all = filterThreads(threads, { status: 'open', onlyMine: false, email: 'rana@x.test', hidden: new Set(), showHidden: false });
  assert.deepEqual(all.visible.map((t) => t.id), [1, 3]);
  assert.deepEqual(all.counts, { open: 2, resolved: 2, all: 4 });
  assert.equal(all.hiddenCount, 0);

  const mine = filterThreads(threads, { status: 'all', onlyMine: true, email: 'rana@x.test', hidden: new Set(), showHidden: false });
  assert.deepEqual(mine.visible.map((t) => t.id), [1, 2]);
  assert.deepEqual(mine.counts, { open: 1, resolved: 1, all: 2 });

  const hid = filterThreads(threads, { status: 'open', onlyMine: false, email: 'rana@x.test', hidden: new Set([3, 4]), showHidden: false });
  assert.deepEqual(hid.visible.map((t) => t.id), [1]);
  assert.deepEqual(hid.counts, { open: 1, resolved: 1, all: 2 }, 'hidden threads leave the counts');
  assert.equal(hid.hiddenCount, 1, 'hidden threads matching the status');

  const shown = filterThreads(threads, { status: 'open', onlyMine: false, email: 'rana@x.test', hidden: new Set([3]), showHidden: true });
  assert.deepEqual(shown.visible.map((t) => t.id), [1, 3]);
  assert.equal(shown.hiddenCount, 1);
});

test('groupThreads: by file (and project), first-seen order, lines ascending', () => {
  const threads = [
    T({ id: 1, path: 'b.js', line: 9 }),
    T({ id: 2, path: 'a.js', line: 4 }),
    T({ id: 3, path: 'b.js', line: 2 }),
    T({ id: 4, path: 'b.js', line: null }),
  ];
  const g = groupThreads(threads);
  assert.deepEqual(g.map((x) => [x.path, x.threads.map((t) => t.id)]), [['b.js', [4, 3, 1]], ['a.js', [2]]]);

  const cross = groupThreads([T({ id: 1, slug: 'p1', projectName: 'One', path: 'a.js' }), T({ id: 2, slug: 'p2', projectName: 'Two', path: 'a.js' })]);
  assert.deepEqual(cross.map((x) => [x.slug, x.projectName, x.path]), [['p1', 'One', 'a.js'], ['p2', 'Two', 'a.js']]);
});

test('showInCodeHref: live, commit, rewritten (shown on live), hidden (nowhere)', () => {
  assert.equal(showInCodeHref(T({ id: 5 }), 'demo'), '/demo/live#c-5');
  assert.equal(showInCodeHref(T({ id: 5, outdated: true }), 'demo'), '/demo/live#c-5');
  const sha = 'a'.repeat(40);
  assert.equal(showInCodeHref(T({ id: 6, target: sha }), 'demo'), `/demo/commit/${sha}#c-6`);
  assert.equal(showInCodeHref(T({ id: 7, target: sha, rewritten: true }), 'demo'), '/demo/live#c-7');
  assert.equal(showInCodeHref(T({ id: 8, hidden: true }), 'demo'), null);
});

test('threadPlace and whereText', () => {
  const sha = 'abcdef1234'.padEnd(40, '0');
  assert.equal(threadPlace(T({})), 'Changes');
  assert.equal(threadPlace(T({ outdated: true })), 'Outdated');
  assert.equal(threadPlace(T({ target: sha })), 'Commit abcdef1');
  assert.equal(threadPlace(T({ target: sha, rewritten: true })), 'Rewritten commit abcdef1');
  assert.equal(threadPlace(T({ hidden: true })), 'Hidden file');
  assert.equal(whereText(T({})), 'src/app.php:3');
  assert.equal(whereText(T({ line: null })), 'src/app.php');
});

test('hidden threads: stored per viewer, tolerant parsing, toggling', () => {
  assert.equal(hiddenKey('Rana@X.test'), 'lr-hidden-threads:rana@x.test');
  assert.deepEqual([...parseHidden('[3, 5, "x", -1, 2.5]')], [3, 5]);
  assert.deepEqual([...parseHidden('nope')], []);
  assert.deepEqual([...parseHidden(null)], []);
  assert.deepEqual([...parseHidden('{"a":1}')], []);
  const s = new Set([1]);
  toggleHidden(s, 2);
  toggleHidden(s, 1);
  assert.deepEqual([...s], [2]);
  assert.equal(serializeHidden(new Set([4, 2])), '[4,2]');
  const many = new Set(Array.from({ length: 2100 }, (_, i) => i + 1));
  assert.equal(JSON.parse(serializeHidden(many)).length, 2000, 'keeps the most recent 2000');
  assert.equal(JSON.parse(serializeHidden(many))[1999], 2100);
});
