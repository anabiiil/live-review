import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markSummary, markLabel, commentCount, toggleThreads, threadForComment, flashOffset, FLASH_MS } from '../../public/js/pairing.js';
import { createUiState } from '../../public/js/comments.js';

const t = (id, resolved = false, replies = 0) => ({ id, resolved, replies: Array.from({ length: replies }, (_, i) => ({ id: id * 100 + i })) });

test('markSummary counts comments (with replies) and whether every thread is resolved', () => {
  assert.deepEqual(markSummary([t(1, false, 2), t(2, true)]), { ids: [1, 2], comments: 4, open: 1, resolved: false });
  assert.deepEqual(markSummary([t(3, true, 1)]), { ids: [3], comments: 2, open: 0, resolved: true });
  assert.deepEqual(markSummary([]), { ids: [], comments: 0, open: 0, resolved: false });
});

test('commentCount and markLabel read naturally', () => {
  assert.equal(commentCount(1), '1 comment');
  assert.equal(commentCount(3), '3 comments');
  assert.equal(markLabel(markSummary([t(1, false, 1)]), 12, false), 'Show 2 comments on line 12');
  assert.equal(markLabel(markSummary([t(1)]), 12, true), 'Hide 1 comment on line 12');
  assert.equal(markLabel(markSummary([t(1, true)]), 4, false), 'Show 1 resolved comment on line 4');
});

test('toggleThreads opens all when any is closed, closes all when all are open', () => {
  const open = new Set([1]);
  assert.equal(toggleThreads(open, [1, 2]), true);
  assert.deepEqual([...open].sort(), [1, 2]);
  assert.equal(toggleThreads(open, [1, 2]), false);
  assert.deepEqual([...open], []);
  assert.equal(toggleThreads(open, []), false);
});

test('threadForComment finds the thread of a top-level comment or a reply', () => {
  const list = [t(1, false, 2), t(2)];
  assert.equal(threadForComment(list, 2)?.id, 2);
  assert.equal(threadForComment(list, 101)?.id, 1);
  assert.equal(threadForComment(list, 9), null);
});

test('flashOffset: elapsed time while the flash runs, null afterwards', () => {
  assert.equal(flashOffset(null, 1000), null);
  assert.equal(flashOffset(1000, 1000), 0);
  assert.equal(flashOffset(1000, 1400), 400);
  assert.equal(flashOffset(1000, 1000 + FLASH_MS), null);
});

test('open threads are part of the ui state that survives re-rendering', () => {
  const ui = createUiState('unified');
  assert.ok(ui.openThreads instanceof Set);
  assert.equal(ui.openThreads.size, 0);
});

test('fileLineKeys lists the positions a file diff renders (old side for deletions, new for additions, both for context)', async () => {
  const { fileLineKeys } = await import('../../public/js/pairing.js');
  const file = {
    path: 'a.js',
    hunks: [{ header: '@@', lines: [
      { type: 'ctx', oldNo: 1, newNo: 1, text: '' },
      { type: 'del', oldNo: 2, newNo: null, text: '' },
      { type: 'add', oldNo: null, newNo: 2, text: '' },
    ] }],
  };
  assert.deepEqual([...fileLineKeys(file)].sort(), ['a.js:new:1', 'a.js:new:2', 'a.js:old:1', 'a.js:old:2']);
  assert.equal(fileLineKeys({ path: 'b', hunks: [] }).size, 0);
});

test('the ui state carries a control to refocus after the next render', () => {
  const ui = createUiState('unified');
  assert.equal(ui.focusKey, null);
});
