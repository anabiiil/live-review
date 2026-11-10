// Comment threads and composers. All text reaches the DOM through text nodes / textContent.
import { h } from './dom.js';
import { parseBody, relativeTime } from './format.js';
import { icon } from './icons.js';
import { initials } from './shell-model.js';

export const MAX_BODY = 5000;

/**
 * State of the review UI that must survive re-rendering (live updates replace the DOM).
 * @typedef {object} UiState
 * @property {'split'|'unified'} mode
 * @property {Map<string,{path:string, side:'old'|'new', line:number}>} composers open new-comment composers by `${path}:${side}:${line}`
 * @property {Set<number>} replying thread ids with an open reply box
 * @property {Set<number>} editing comment ids being edited
 * @property {Map<string,string>} drafts composer text by key (new line key, `reply:{id}`, `edit:{id}`)
 * @property {Set<string>} busy composer keys with a request in flight
 * @property {Map<string,string>} errors last submit error by composer key
 * @property {Set<string>} expandedFiles large diffs the reader chose to show
 * @property {Set<string>} collapsedFiles files the reader folded
 * @property {Set<number>} expandedResolved resolved threads shown in full (in the sections below the diff)
 * @property {Set<number>} openThreads diff threads the reader opened from their margin mark
 * @property {Set<number>} opening threads opened since the last render (they animate in once)
 * @property {Set<string>} openSections open collapsible sections
 * @property {string|null} pendingFocus draft key to focus after the next render (a composer was just opened)
 * @property {boolean|null} sidebarOpen
 */

/** @param {'split'|'unified'} mode @returns {UiState} */
export function createUiState(mode) {
  return {
    mode, composers: new Map(), replying: new Set(), editing: new Set(), drafts: new Map(), busy: new Set(), errors: new Map(),
    expandedFiles: new Set(), collapsedFiles: new Set(), expandedResolved: new Set(), openThreads: new Set(), opening: new Set(),
    openSections: new Set(),
    pendingFocus: null, sidebarOpen: null,
  };
}

/**
 * Everything threads need from the surrounding view.
 * @typedef {object} CommentEnv
 * @property {{email:string, name:string|null, kind:'owner'|'reviewer'}} me
 * @property {UiState} ui
 * @property {() => void} rerender re-render from local state
 * @property {() => Promise<void>} refresh refetch comments, then re-render
 * @property {(path:string, side:'old'|'new', line:number, body:string) => Promise<{id:number}>} createComment
 * @property {(id:number, body:string) => Promise<void>} reply
 * @property {(id:number, body:string) => Promise<void>} edit
 * @property {(id:number) => Promise<void>} remove
 * @property {(id:number, resolved:boolean) => Promise<void>} setResolved
 */

/**
 * What a composer shows, derived from the UI state so a re-render in the middle of a request keeps it.
 * @param {UiState} ui
 * @param {string} key
 * @param {string} [initial]
 * @returns {{busy:boolean, error:string, text:string}}
 */
export function composerState(ui, key, initial = '') {
  return { busy: ui.busy.has(key), error: ui.errors.get(key) ?? '', text: ui.drafts.get(key) ?? initial };
}

/** A submit starts: keep the text, mark busy, forget the previous error. */
export function beginSubmit(/** @type {UiState} */ ui, /** @type {string} */ key, /** @type {string} */ text) {
  ui.drafts.set(key, text);
  ui.busy.add(key);
  ui.errors.delete(key);
}

/** The request succeeded: the draft is spent. */
export function finishSubmit(/** @type {UiState} */ ui, /** @type {string} */ key) {
  ui.busy.delete(key);
  ui.errors.delete(key);
  ui.drafts.delete(key);
}

/** The request failed: keep the text, show the error. */
export function failSubmit(/** @type {UiState} */ ui, /** @type {string} */ key, /** @type {string} */ message) {
  ui.busy.delete(key);
  ui.errors.set(key, message);
}

/** The composer was cancelled. */
export function discardDraft(/** @type {UiState} */ ui, /** @type {string} */ key) {
  ui.drafts.delete(key);
  ui.errors.delete(key);
  ui.busy.delete(key);
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
export function renderBody(text) {
  const root = h('div', { class: 'body', dir: 'auto' });
  for (const n of parseBody(text)) {
    if (n.kind === 'text') root.append(document.createTextNode(n.text));
    else if (n.kind === 'code') root.append(h('code', { text: n.text }));
    else root.append(h('pre', { class: 'codeblock', dir: 'ltr' }, h('code', { text: n.text })));
  }
  return root;
}

/** @param {Error & {data?:any}} err */
function errorText(err) {
  const msg = err?.data?.message;
  return typeof msg === 'string' && msg ? msg : 'That did not work. Please try again.';
}

/**
 * @param {CommentEnv} env
 * @param {{key:string, initial?:string, label:string, placeholder:string,
 *   onSubmit:(text:string)=>Promise<void>, onCancel:()=>void}} o
 * @returns {HTMLElement}
 */
export function renderComposer(env, { key, initial = '', label, placeholder, onSubmit, onCancel }) {
  const { ui } = env;
  const { busy, error: errorMessage, text } = composerState(ui, key, initial);
  const ta = /** @type {HTMLTextAreaElement} */ (
    h('textarea', { rows: 3, dir: 'auto', 'data-draft': key, placeholder, 'aria-label': placeholder, maxlength: MAX_BODY })
  );
  ta.value = text;
  ta.disabled = busy;
  const error = h('p', { class: 'form-error', role: 'alert', text: errorMessage });
  const submit = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn primary', type: 'button', text: busy ? 'Saving…' : label }));
  const cancel = /** @type {HTMLButtonElement} */ (h('button', { class: 'link', type: 'button', text: 'Cancel' }));
  cancel.disabled = busy;
  const sync = () => {
    submit.disabled = busy || ta.value.trim() === '';
  };
  sync();

  // Busy and error live in `ui`, so a live re-render in the middle of the request rebuilds the same state.
  async function send() {
    const value = ta.value.trim();
    if (!value || ui.busy.has(key)) return;
    beginSubmit(ui, key, ta.value);
    env.rerender();
    try {
      await onSubmit(value);
      finishSubmit(ui, key);
    } catch (err) {
      failSubmit(ui, key, errorText(/** @type {any} */ (err)));
      ui.pendingFocus = key;
    }
    env.rerender();
  }

  ta.addEventListener('input', () => {
    ui.drafts.set(key, ta.value);
    sync();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });
  submit.addEventListener('click', send);
  cancel.addEventListener('click', () => {
    discardDraft(ui, key);
    onCancel();
  });
  return h(
    'div',
    { class: `composer${ui.pendingFocus === key ? ' opening' : ''}` },
    ta,
    error,
    h('div', { class: 'composer-actions' }, submit, cancel, h('span', { class: 'composer-hint', text: 'Ctrl+Enter to send' })),
  );
}

/**
 * Whether the viewer wrote the comment.
 * @param {CommentEnv} env
 * @param {{authorEmail:string}} c
 */
const isMine = (env, c) => c.authorEmail.toLowerCase() === env.me.email.toLowerCase();

/**
 * A quiet text button.
 * @param {string} text
 * @param {(e:Event)=>void} onclick
 * @param {string} [extra]
 */
const action = (text, onclick, extra = '') => h('button', { class: `link${extra ? ` ${extra}` : ''}`, type: 'button', text, onclick });

/**
 * One comment: avatar initials, name, relative time, body, then quiet actions.
 * @param {any} c
 * @param {CommentEnv} env
 * @param {{top:boolean, thread:any}} o
 */
function renderComment(c, env, { top, thread }) {
  const { ui } = env;
  const mine = isMine(env, c);
  const owner = env.me.kind === 'owner';
  const edited = c.updatedAt > c.createdAt;
  const head = h(
    'div',
    { class: 'comment-head' },
    h('strong', { class: 'author', dir: 'auto', text: c.authorName || c.authorEmail }),
    h('time', { datetime: new Date(c.createdAt).toISOString(), title: new Date(c.createdAt).toLocaleString(), text: relativeTime(c.createdAt) }),
    edited ? h('span', { class: 'edited', text: 'edited' }) : null,
  );
  const main = h('div', { class: 'comment-main' }, head);
  const root = h(
    'div',
    { class: 'comment', id: top ? null : `c-${c.id}` },
    h('span', { class: 'avatar', 'aria-hidden': 'true', dir: 'auto', text: initials(c.authorName, c.authorEmail) }),
    main,
  );

  if (ui.editing.has(c.id)) {
    const stop = () => {
      ui.editing.delete(c.id);
      env.rerender();
    };
    main.append(
      renderComposer(env, {
        key: `edit:${c.id}`, initial: c.body, label: 'Save', placeholder: 'Edit your comment',
        onSubmit: async (text) => {
          await env.edit(c.id, text);
          ui.editing.delete(c.id);
          await env.refresh();
        },
        onCancel: stop,
      }),
    );
    return root;
  }

  main.append(renderBody(c.body));
  const actions = h('div', { class: 'comment-actions' });
  if (top) {
    actions.append(
      action('Reply', () => {
        ui.replying.add(thread.id);
        ui.pendingFocus = `reply:${thread.id}`;
        env.rerender();
      }),
    );
  }
  if (top && (mine || owner)) {
    actions.append(
      action(thread.resolved ? 'Reopen' : 'Resolve', async (e) => {
        const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
        btn.disabled = true;
        try {
          await env.setResolved(thread.id, !thread.resolved);
          ui.expandedResolved.delete(thread.id);
          await env.refresh();
        } catch (err) {
          btn.disabled = false;
          alert(errorText(/** @type {any} */ (err)));
        }
      }),
    );
  }
  if (mine) {
    actions.append(
      action('Edit', () => {
        ui.editing.add(c.id);
        ui.pendingFocus = `edit:${c.id}`;
        env.rerender();
      }),
    );
  }
  if (mine || owner) {
    actions.append(
      action(
        'Delete',
        async () => {
          if (!confirm(top && thread.replies.length ? 'Delete this comment and its replies?' : 'Delete this comment?')) return;
          try {
            await env.remove(c.id);
            await env.refresh();
          } catch (err) {
            alert(errorText(/** @type {any} */ (err)));
          }
        },
        'danger',
      ),
    );
  }
  if (actions.childNodes.length) main.append(actions);
  return root;
}

/**
 * A thread: its comment, replies, reply box.
 * Inline threads (in the diff) are opened and closed by their margin mark, so they always render in full;
 * threads listed in the sections below the diff keep a resolved thread folded to one line until asked.
 * @param {any} t top-level comment with `replies`
 * @param {CommentEnv} env
 * @param {{inline?:boolean}} [o]
 * @returns {HTMLElement}
 */
export function renderThread(t, env, { inline = false } = {}) {
  const { ui } = env;
  const cls = ['thread'];
  if (t.resolved) cls.push('resolved');
  if (inline && ui.opening.has(t.id)) cls.push('opening');
  const root = h('div', { class: cls.join(' '), id: `c-${t.id}` });

  if (!inline && t.resolved && !ui.expandedResolved.has(t.id)) {
    const first = String(t.body).split('\n', 1)[0].slice(0, 90);
    root.append(
      h(
        'button',
        {
          class: 'thread-summary', type: 'button', 'aria-expanded': 'false',
          onclick: () => {
            ui.expandedResolved.add(t.id);
            env.rerender();
          },
        },
        h('span', { class: 'resolved-label' }, icon('check', { size: 14 }), 'Resolved'),
        h('span', { class: 'author', dir: 'auto', text: t.authorName || t.authorEmail }),
        h('span', { class: 'excerpt', dir: 'auto', text: first }),
        h('span', { class: 'muted', text: 'Show' }),
      ),
    );
    return root;
  }

  if (t.resolved) {
    root.append(
      h(
        'div',
        { class: 'thread-bar' },
        h('span', { class: 'resolved-label' }, icon('check', { size: 14 }), 'Resolved'),
        inline
          ? null
          : action('Hide', () => {
              ui.expandedResolved.delete(t.id);
              env.rerender();
            }),
      ),
    );
  }
  root.append(renderComment(t, env, { top: true, thread: t }));
  if (t.replies.length) {
    root.append(h('div', { class: 'replies' }, t.replies.map((/** @type {any} */ r) => renderComment(r, env, { top: false, thread: t }))));
  }
  if (ui.replying.has(t.id)) {
    root.append(
      renderComposer(env, {
        key: `reply:${t.id}`, label: 'Reply', placeholder: 'Write a reply',
        onSubmit: async (text) => {
          await env.reply(t.id, text);
          ui.replying.delete(t.id);
          await env.refresh();
        },
        onCancel: () => {
          ui.replying.delete(t.id);
          env.rerender();
        },
      }),
    );
  }
  return root;
}
