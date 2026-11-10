// Keeping keyboard focus across a full re-render. Controls that re-render the page carry a stable
// `data-focus-key`; composers are `textarea[data-draft]` and keep their selection. When the focused control's
// key is gone after the render (its card was filtered out), focus moves to the next card that is still there,
// else to the page heading, so a keyboard user is never dropped on <body>.

/**
 * @typedef {{draft:{key:string, start:number, end:number}|null, control:string|null, card:string|null,
 *   cards:string[]}} FocusSnapshot
 *   card: `data-thread` of the card around the focused control; cards: every card, in page order
 */

/**
 * Where focus goes after a render (pure; no DOM).
 * @param {{control:string|null, card:string|null, cards:string[]}} before what was focused, and the cards then
 * @param {{keys:Set<string>, cards:Set<string>}} after the focus keys and cards on the page now
 * @param {{fallback?:boolean}} [opts] fallback: move to the next card / the heading when the control is gone
 * @returns {{kind:'key', key:string}|{kind:'card', card:string}|{kind:'heading'}|null}
 */
export function focusTarget(before, after, { fallback = false } = {}) {
  if (before.control === null) return null;
  if (after.keys.has(before.control)) return { kind: 'key', key: before.control };
  if (!fallback) return null;
  const at = before.card === null ? -1 : before.cards.indexOf(before.card);
  if (at >= 0) {
    const next = before.cards.slice(at + 1).find((c) => after.cards.has(c));
    if (next !== undefined) return { kind: 'card', card: next };
  }
  return { kind: 'heading' };
}

/**
 * Read the focus before a render. `ui.focusKey` (set by a control a request disabled) wins and is cleared.
 * @param {HTMLElement} root
 * @param {{focusKey:string|null}} ui
 * @returns {FocusSnapshot}
 */
export function captureFocus(root, ui) {
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && root.contains(active);
  const draft =
    inside && active instanceof HTMLTextAreaElement && active.dataset.draft
      ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd }
      : null;
  const control = ui.focusKey ?? (inside ? /** @type {HTMLElement} */ (active).dataset.focusKey ?? null : null);
  ui.focusKey = null;
  const el = control === null ? null : byKey(root, control);
  const card = /** @type {HTMLElement|null} */ (el?.closest('[data-thread]') ?? null);
  const cards = [...root.querySelectorAll('[data-thread]')].map((n) => /** @type {HTMLElement} */ (n).dataset.thread ?? '');
  return { draft, control, card: card?.dataset.thread ?? null, cards };
}

/**
 * Put focus back after a render: a composer that asked for it (`ui.pendingFocus`), else the composer that had
 * it (with its selection), else the control with the same key (or the fallback).
 * @param {HTMLElement} root
 * @param {{pendingFocus:string|null}} ui
 * @param {FocusSnapshot} snap
 * @param {{fallback?:boolean}} [opts]
 */
export function restoreFocus(root, ui, snap, opts = {}) {
  const wanted = ui.pendingFocus ?? snap.draft?.key ?? null;
  if (wanted) {
    const ta = [...root.querySelectorAll('textarea[data-draft]')].find((el) => /** @type {HTMLElement} */ (el).dataset.draft === wanted);
    if (ta instanceof HTMLTextAreaElement && !ta.disabled) {
      ta.focus({ preventScroll: true });
      if (ui.pendingFocus) {
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.scrollIntoView({ block: 'nearest' });
      } else if (snap.draft) ta.setSelectionRange(snap.draft.start, snap.draft.end);
    }
    ui.pendingFocus = null;
    return;
  }
  const keys = new Set([...root.querySelectorAll('[data-focus-key]')].map((n) => /** @type {HTMLElement} */ (n).dataset.focusKey ?? ''));
  const cards = new Set([...root.querySelectorAll('[data-thread]')].map((n) => /** @type {HTMLElement} */ (n).dataset.thread ?? ''));
  const target = focusTarget(snap, { keys, cards }, opts);
  if (!target) return;
  /** @type {Element|null|undefined} */
  let el = null;
  if (target.kind === 'key') el = byKey(root, target.key);
  else if (target.kind === 'card') {
    const card = [...root.querySelectorAll('[data-thread]')].find((n) => /** @type {HTMLElement} */ (n).dataset.thread === target.card);
    el = card?.querySelector('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled])');
  } else {
    el = root.querySelector('h1');
    if (el instanceof HTMLElement && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  }
  if (el instanceof HTMLElement) el.focus({ preventScroll: target.kind === 'key' });
}

/** @param {HTMLElement} root @param {string} key */
function byKey(root, key) {
  return [...root.querySelectorAll('[data-focus-key]')].find((n) => /** @type {HTMLElement} */ (n).dataset.focusKey === key) ?? null;
}
