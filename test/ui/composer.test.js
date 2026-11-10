import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUiState, composerState, beginSubmit, finishSubmit, failSubmit, discardDraft } from '../../public/js/comments.js';

test('composerState derives text, busy and error from the ui state', () => {
  const ui = createUiState('unified');
  assert.deepEqual(composerState(ui, 'k', 'initial'), { busy: false, error: '', text: 'initial' });
  ui.drafts.set('k', 'typed');
  assert.deepEqual(composerState(ui, 'k', 'initial'), { busy: false, error: '', text: 'typed' });
});

test('a re-render in the middle of a request still sees busy and the text', () => {
  const ui = createUiState('unified');
  beginSubmit(ui, 'k', 'my comment');
  assert.deepEqual(composerState(ui, 'k'), { busy: true, error: '', text: 'my comment' });
});

test('a failure leaves the text, clears busy and shows the error in the rebuilt composer', () => {
  const ui = createUiState('unified');
  beginSubmit(ui, 'k', 'my comment');
  failSubmit(ui, 'k', 'line is not shown in this diff');
  assert.deepEqual(composerState(ui, 'k'), { busy: false, error: 'line is not shown in this diff', text: 'my comment' });
  // Retrying clears the old error.
  beginSubmit(ui, 'k', 'my comment');
  assert.equal(composerState(ui, 'k').error, '');
});

test('success spends the draft; cancel discards everything', () => {
  const ui = createUiState('unified');
  beginSubmit(ui, 'k', 'x');
  finishSubmit(ui, 'k');
  assert.deepEqual(composerState(ui, 'k'), { busy: false, error: '', text: '' });
  beginSubmit(ui, 'j', 'y');
  failSubmit(ui, 'j', 'nope');
  discardDraft(ui, 'j');
  assert.deepEqual(composerState(ui, 'j'), { busy: false, error: '', text: '' });
});

test('keys are independent', () => {
  const ui = createUiState('unified');
  beginSubmit(ui, 'a', 'one');
  failSubmit(ui, 'b', 'err');
  assert.equal(composerState(ui, 'a').busy, true);
  assert.equal(composerState(ui, 'b').busy, false);
  assert.equal(composerState(ui, 'a').error, '');
});
