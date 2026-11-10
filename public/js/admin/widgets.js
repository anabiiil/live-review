// Small admin widgets: copyable link, confirm dialog, busy buttons. Untrusted text only via h()/textContent.
import { h } from '../dom.js';

/**
 * Copy text to the clipboard. Falls back to select() + execCommand('copy') where the async API is missing
 * or refused (plain http on a non-secure origin, permissions).
 * @param {string} text
 * @param {HTMLInputElement} [input] a visible input holding the text, used for the fallback
 * @returns {Promise<boolean>}
 */
export async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the legacy path */
  }
  const field = input ?? /** @type {HTMLInputElement} */ (h('input', { value: text, readonly: '', 'aria-hidden': 'true', class: 'offscreen' }));
  if (!input) document.body.append(field);
  try {
    field.select();
    field.setSelectionRange(0, field.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (!input) field.remove();
  }
}

/**
 * A read-only input with the link and a Copy button.
 * @param {string} link
 * @param {{label?:string}} [opts]
 * @returns {HTMLElement}
 */
export function copyField(link, { label = 'Invite link' } = {}) {
  const input = /** @type {HTMLInputElement} */ (h('input', { class: 'link-input', type: 'text', readonly: '', value: link, dir: 'ltr', 'aria-label': label }));
  const status = h('span', { class: 'copy-status muted', role: 'status' });
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const button = h('button', {
    class: 'btn primary', type: 'button', text: 'Copy',
    onclick: async () => {
      const ok = await copyText(link, input);
      if (!ok) input.select();
      status.textContent = ok ? 'Copied' : 'Press Ctrl+C / ⌘C to copy';
      clearTimeout(timer);
      timer = setTimeout(() => (status.textContent = ''), 2500);
    },
  });
  input.addEventListener('focus', () => input.select());
  return h('div', { class: 'copy-field' }, input, button, status);
}

/**
 * A modal confirmation. Resolves true only when confirmed (and, if `requireText` is given, typed).
 * @param {{title:string, message:string, confirmLabel:string, requireText?:string, danger?:boolean}} o
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message, confirmLabel, requireText, danger = true }) {
  return new Promise((resolve) => {
    const typed = /** @type {HTMLInputElement|null} */ (
      requireText ? h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': `Type ${requireText} to confirm`, dir: 'ltr' }) : null
    );
    const ok = /** @type {HTMLButtonElement} */ (h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'submit', text: confirmLabel }));
    ok.disabled = Boolean(requireText);
    const cancel = h('button', { class: 'btn', type: 'button', text: 'Cancel' });
    const form = h(
      'form',
      { method: 'dialog' },
      h('h2', { text: title }),
      h('p', { text: message }),
      requireText ? h('p', null, 'Type ', h('code', { text: requireText }), ' to confirm.') : null,
      typed,
      h('div', { class: 'composer-actions' }, ok, cancel),
    );
    const dialog = /** @type {HTMLDialogElement} */ (h('dialog', { class: 'confirm' }, form));
    let result = false;
    typed?.addEventListener('input', () => {
      ok.disabled = typed.value !== requireText;
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (ok.disabled) return;
      result = true;
      dialog.close();
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    (typed ?? cancel).focus();
  });
}

/**
 * Disable a button (and relabel it) while `fn` runs.
 * @template T
 * @param {HTMLButtonElement} button
 * @param {string} busyLabel
 * @param {()=>Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function busy(button, busyLabel, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/**
 * A labelled form row: <label for> + control + error line.
 * @param {string} id
 * @param {string} label
 * @param {HTMLElement} control
 * @param {{hint?:string}} [opts]
 */
export function field(id, label, control, { hint } = {}) {
  control.id = id;
  const error = h('p', { class: 'form-error', role: 'alert', id: `${id}-error` });
  control.setAttribute('aria-describedby', `${id}-error`);
  const row = h('div', { class: 'field' }, h('label', { for: id, text: label }), control, hint ? h('p', { class: 'hint muted', text: hint }) : null, error);
  return {
    row,
    control,
    /** @param {string} message */
    setError(message) {
      error.textContent = message;
      control.toggleAttribute('aria-invalid', Boolean(message));
    },
  };
}
