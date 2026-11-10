// Inbox tab: open comment threads across all projects, newest first. Reply and resolve in place.
import { get, patch, post } from '../api.js';
import { createUiState, renderComposer, renderBody } from '../comments.js';
import { h, messageBox, setChildren } from '../dom.js';
import { relativeTime } from '../format.js';
import { countByProject, threadHref } from './helpers.js';
import { busy } from './widgets.js';

/**
 * @typedef {{slug:string, projectName:string, target:string, thread:any}} InboxItem
 */

/**
 * @param {{me:{email:string, name:string|null, kind:'owner'|'reviewer'}, onCount:(n:number)=>void}} o
 */
export function inboxView({ me, onCount }) {
  const root = h('div', { class: 'container' });
  const ui = createUiState('unified');
  /** @type {InboxItem[]} */
  let items = [];
  let loaded = false;
  let failed = false;
  let alive = true;

  async function refresh() {
    try {
      items = await get('/api/admin/inbox');
      failed = false;
    } catch {
      failed = true;
    }
    loaded = true;
    if (!alive) return;
    onCount(items.length);
    draw();
  }

  /** @type {import('../comments.js').CommentEnv} */
  const env = {
    me, ui, rerender: () => draw(), refresh,
    createComment: async () => {},
    reply: async (id, body) => void (await post(`/api/comments/${id}/replies`, { body })),
    edit: async () => {},
    remove: async () => {},
    setResolved: async (id, resolved) => void (await patch(`/api/comments/${id}`, { resolved })),
  };

  /** @param {InboxItem} item */
  function card(item) {
    const t = item.thread;
    const where = t.path ? `${t.path}:${t.line}` : 'general';
    const resolve = /** @type {HTMLButtonElement} */ (h('button', { class: 'link', type: 'button', text: 'Resolve' }));
    const error = h('p', { class: 'form-error', role: 'alert' });
    resolve.addEventListener('click', () =>
      busy(resolve, 'Resolving…', async () => {
        error.textContent = '';
        try {
          await env.setResolved(t.id, true);
          await refresh();
        } catch {
          error.textContent = 'Could not resolve. Please try again.';
        }
      }),
    );
    return h(
      'article',
      { class: 'card inbox-item', id: `c-${t.id}` },
      h(
        'div',
        { class: 'inbox-head' },
        h('span', { class: 'chip', dir: 'auto', text: item.projectName }),
        h('a', { class: 'where', dir: 'ltr', href: threadHref(item), text: where }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted', title: new Date(t.createdAt).toLocaleString(), text: relativeTime(t.createdAt) }),
      ),
      h('p', { class: 'muted' }, h('strong', { dir: 'auto', text: t.authorName || t.authorEmail })),
      h('div', { class: 'inbox-body' }, renderBody(t.body)),
      t.replies.length
        ? h(
            'div',
            { class: 'inbox-replies' },
            t.replies.map((/** @type {any} */ r) =>
              h('div', { class: 'comment' }, h('strong', { dir: 'auto', text: r.authorName || r.authorEmail }), ' ', h('span', { class: 'muted', text: relativeTime(r.createdAt) }), renderBody(r.body)),
            ),
          )
        : null,
      ui.replying.has(t.id)
        ? renderComposer(env, {
            key: `reply:${t.id}`, label: 'Reply', placeholder: 'Write a reply',
            onSubmit: async (text) => {
              await env.reply(t.id, text);
              ui.replying.delete(t.id);
              await refresh();
            },
            onCancel: () => {
              ui.replying.delete(t.id);
              draw();
            },
          })
        : h(
            'div',
            { class: 'comment-actions' },
            h('button', {
              class: 'link', type: 'button', text: 'Reply',
              onclick: () => {
                ui.replying.add(t.id);
                ui.pendingFocus = `reply:${t.id}`;
                draw();
              },
            }),
            resolve,
            h('a', { class: 'open-link', href: threadHref(item), text: 'Open in project' }),
          ),
      error,
    );
  }

  function draw() {
    if (!loaded) return setChildren(root, h('p', { class: 'muted pad', text: 'Loading…' }));
    if (failed) return setChildren(root, messageBox('Could not load the inbox', 'Please reload the page.'));
    const counts = countByProject(items);
    setChildren(
      root,
      h('h1', { text: 'Inbox' }),
      counts.length
        ? h(
            'p',
            { class: 'inbox-counts' },
            counts.map((c) => h('span', { class: 'chip open-chip', dir: 'auto', text: `${c.name}: ${c.count} unresolved` })),
          )
        : null,
      items.length ? items.map(card) : messageBox('All caught up', 'Open comments from reviewers will show up here.'),
    );
    if (ui.pendingFocus) {
      const ta = root.querySelector(`textarea[data-draft="${CSS.escape(ui.pendingFocus)}"]`);
      ui.pendingFocus = null;
      if (ta instanceof HTMLTextAreaElement) ta.focus();
    }
  }

  draw();
  refresh();
  return {
    root,
    refresh,
    destroy() {
      alive = false;
    },
  };
}
