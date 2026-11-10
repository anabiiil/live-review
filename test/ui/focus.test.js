import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusTarget } from '../../public/js/focus.js';

const after = (/** @type {string[]} */ keys, /** @type {string[]} */ cards) => ({ keys: new Set(keys), cards: new Set(cards) });

test('focusTarget: nothing focused stays unfocused', () => {
  assert.equal(focusTarget({ control: null, card: null, cards: ['1'] }, after([], ['1']), { fallback: true }), null);
});

test('focusTarget: the same key comes back when it is still on the page', () => {
  const before = { control: 'resolve:2', card: '2', cards: ['1', '2', '3'] };
  assert.deepEqual(focusTarget(before, after(['resolve:2', 'hide:2'], ['1', '2', '3'])), { kind: 'key', key: 'resolve:2' });
  assert.deepEqual(focusTarget({ control: 'status:open', card: null, cards: [] }, after(['status:open'], [])), { kind: 'key', key: 'status:open' });
});

test('focusTarget: a vanished key without fallback leaves focus alone (the diff view)', () => {
  assert.equal(focusTarget({ control: 'mark:x', card: null, cards: [] }, after([], [])), null);
});

test('focusTarget: a filtered-out card hands focus to the next card still shown', () => {
  const before = { control: 'hide:2', card: '2', cards: ['1', '2', '3', '4'] };
  assert.deepEqual(focusTarget(before, after(['hide:1', 'hide:4'], ['1', '4']), { fallback: true }), { kind: 'card', card: '4' });
});

test('focusTarget: no next card, or a control outside any card, falls back to the heading', () => {
  assert.deepEqual(
    focusTarget({ control: 'resolve:3', card: '3', cards: ['1', '2', '3'] }, after(['hide:1'], ['1', '2']), { fallback: true }),
    { kind: 'heading' },
  );
  assert.deepEqual(focusTarget({ control: 'showhidden', card: null, cards: ['1'] }, after([], ['1']), { fallback: true }), { kind: 'heading' });
});
