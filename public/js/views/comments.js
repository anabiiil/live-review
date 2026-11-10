// Comments page: every thread of a project (or, on the admin page, of every project) with filters, grouped
// by file. Each card shows a code snippet, the conversation (the same thread component as the diff), an
// inline reply box, Resolve / Reopen, "Show in code" and a per-viewer Hide.
import { api, get } from '../api.js';
import { createUiState, renderThread } from '../comments.js';
import { h, messageBox, setChildren, storage } from '../dom.js';
import { captureFocus, restoreFocus } from '../focus.js';
import { icon } from '../icons.js';
import {
  filterThreads, groupThreads, hiddenKey, parseHidden, serializeHidden, showInCodeHref, threadPlace, toggleHidden, whereText,
} from '../comments-model.js';

/** @typedef {import('../comments-model.js').ListedThread & {body:string, authorName:string|null}} Thread */
/** @typedef {import('../comments-model.js').Status} Status */

const STATUSES = /** @type {const} */ ([['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']]);
const REFRESH_DELAY = 150;

/**
 * @param {{
 *   me:{email:string, name:string|null, kind:'owner'|'reviewer'},
 *   load:()=>Promise<Thread[]>,
 *   slug?:string,
 *   crossProject?:boolean,
 *   inApp?:boolean,
 *   onCount?:(open:number)=>void,
 * }} o slug: the project (absent across projects, where each thread carries its own); inApp: links navigate
 *   inside the single-page app (data-link)
 */
export function createCommentsPage({ me, load, slug, crossProject = false, inApp = true, onCount = () => {} }) {
  const root = h('div', { class: 'container comments-page' });
  const ui = createUiState('unified');
  /** @type {Thread[]} */
  let threads = [];
  let json = '';
  let loaded = false;
  let failed = false;
  let alive = true;
  /** @type {Status} */
  let status = 'open';
  let onlyMine = false;
  let showHidden = false;
  const key = hiddenKey(me.email);
  let hidden = parseHidden(storage.get(key));

  async function refresh() {
    try {
      const next = await load();
      if (!alive) return;
      failed = false;
      loaded = true;
      onCount(next.filter((t) => !t.resolved).length);
      const nextJson = JSON.stringify(next);
      if (nextJson === json) return;
      json = nextJson;
      threads = next;
    } catch {
      if (!alive) return;
      failed = true;
      loaded = true;
    }
    draw();
  }

  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** Coalesce a burst of live hints into one refetch. */
  function soon() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (alive) refresh();
    }, REFRESH_DELAY);
  }

  /** @type {import('../comments.js').CommentEnv} */
  const env = {
    me,
    ui,
    rerender: () => draw(),
    // Always redraw: the caller just changed `ui` (closed a composer).
    refresh: async () => {
      json = '';
      await refresh();
    },
    createComment: async () => ({ id: 0 }),
    reply: (id, body) => api('POST', `/api/comments/${id}/replies`, { body }),
    edit: (id, body) => api('PATCH', `/api/comments/${id}`, { body }),
    remove: (id) => api('DELETE', `/api/comments/${id}`),
    setResolved: (id, resolved) => api('PATCH', `/api/comments/${id}`, { resolved }),
  };

  /** @param {number} id */
  function flipHidden(id) {
    toggleHidden(hidden, id);
    storage.set(key, serializeHidden(hidden));
    draw();
  }

  /** @param {Thread} t */
  function snippet(t) {
    if (t.hidden) return h('p', { class: 'snippet-note', text: 'This file is hidden, so its code is not shown.' });
    if (!t.snippet?.length) return null;
    return h(
      'div',
      { class: 'snippet', dir: 'ltr', role: 'group', 'aria-label': `Code around line ${t.line}` },
      t.snippet.map((l) =>
        h('div', { class: `sn-line${l.focus ? ' focus' : ''}` }, h('span', { class: 'sn-no', 'aria-hidden': 'true', text: String(l.no) }), h('span', { class: 'sn-text', text: l.text || ' ' })),
      ),
    );
  }

  /**
   * @param {Thread} t
   * @param {boolean} isHidden
   */
  function card(t, isHidden) {
    const s = t.slug ?? slug ?? '';
    const href = showInCodeHref(t, s);
    const link = /** @param {Record<string, any>} props @param {...any} kids */ (props, ...kids) =>
      h('a', { ...props, href, 'data-link': inApp ? '' : null }, ...kids);
    const where = whereText(t);
    const head = h(
      'div',
      { class: 'ccard-head' },
      crossProject && t.projectName ? h('span', { class: 'chip ccard-project', dir: 'auto', text: t.projectName }) : null,
      href ? link({ class: 'ccard-where', dir: 'ltr', title: `Show ${where} in code` }, where) : h('span', { class: 'ccard-where', dir: 'ltr', text: where }),
      h('span', { class: `ccard-place${t.outdated || t.rewritten || t.hidden ? ' stale' : ''}`, text: threadPlace(t) }),
      h('span', { class: 'spacer' }),
      href ? link({ class: 'ccard-action' }, icon('arrow-up-right'), 'Show in code') : null,
      h(
        'button',
        { class: 'ccard-action', type: 'button', 'aria-pressed': String(isHidden), 'data-focus-key': `hide:${t.id}`, onclick: () => flipHidden(t.id) },
        icon('eye-off'),
        isHidden ? 'Unhide' : 'Hide',
      ),
    );
    const cls = ['ccard'];
    if (t.resolved) cls.push('resolved');
    if (isHidden) cls.push('is-hidden');
    if (isHidden) {
      const first = String(t.body).split('\n', 1)[0];
      return h(
        'article',
        { class: cls.join(' '), 'data-thread': t.id },
        head,
        h('p', { class: 'ccard-folded' }, h('strong', { dir: 'auto', text: t.authorName || t.authorEmail }), ' ', h('span', { dir: 'auto', text: first })),
      );
    }
    return h('article', { class: cls.join(' '), 'data-thread': t.id }, head, snippet(t), renderThread(t, env, { inline: true }));
  }

  /** @param {Status} s @param {number} n */
  const statusButton = (s, n) => {
    const label = STATUSES.find(([id]) => id === s)?.[1] ?? s;
    return h(
      'button',
      {
        class: 'seg-btn', type: 'button', 'aria-pressed': String(status === s), 'data-focus-key': `status:${s}`,
        onclick: () => {
          status = s;
          draw();
        },
      },
      label,
      h('span', { class: 'seg-count', text: String(n) }),
    );
  };

  function filters(/** @type {{open:number, resolved:number, all:number}} */ counts, /** @type {number} */ hiddenCount) {
    const mine = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', 'data-focus-key': 'onlymine' }));
    mine.checked = onlyMine;
    mine.addEventListener('change', () => {
      onlyMine = mine.checked;
      draw();
    });
    return h(
      'div',
      { class: 'comments-filters' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, STATUSES.map(([s]) => statusButton(s, counts[s]))),
      h('label', { class: 'check' }, mine, 'Only mine'),
      h('span', { class: 'spacer' }),
      hiddenCount || showHidden
        ? h('button', {
            class: 'link', type: 'button', 'aria-pressed': String(showHidden), 'data-focus-key': 'showhidden',
            text: showHidden ? 'Leave hidden out' : `Show hidden (${hiddenCount})`,
            onclick: () => {
              showHidden = !showHidden;
              draw();
            },
          })
        : null,
    );
  }

  /** @param {number} total threads before filtering */
  function empty(total) {
    if (!total) return messageBox('No comments yet', 'Comments on any line of Changes or a commit show up here.');
    const text = status === 'open' ? 'No open comments' : status === 'resolved' ? 'No resolved comments' : 'No comments';
    return messageBox(onlyMine ? `${text} of yours` : text, onlyMine ? 'Clear "Only mine" to see everyone\'s.' : undefined);
  }

  function draw() {
    if (!alive) return;
    if (!loaded) {
      setChildren(root, h('h1', { text: 'Comments' }), h('p', { class: 'muted', text: 'Loading…' }));
      return;
    }
    if (failed && !threads.length) {
      setChildren(root, h('h1', { text: 'Comments' }), messageBox("Comments aren't available right now", 'Please try again in a moment.'));
      return;
    }
    // Keep the reader's place and the draft they are typing across a live redraw.
    const y = window.scrollY;
    const snap = captureFocus(root, ui);

    const { visible, counts, hiddenCount } = filterThreads(threads, { status, onlyMine, email: me.email, hidden, showHidden });
    const groups = groupThreads(visible);
    setChildren(
      root,
      h('div', { class: 'page-head' }, h('h1', { text: 'Comments' })),
      filters(counts, hiddenCount),
      groups.length
        ? groups.map((g) =>
            h(
              'section',
              { class: 'cgroup' },
              h(
                'h2',
                { class: 'cgroup-head' },
                crossProject && g.projectName ? h('span', { class: 'cgroup-project', dir: 'auto', text: g.projectName }) : null,
                h('span', { class: 'cgroup-path', dir: 'ltr', text: g.path }),
                h('span', { class: 'cgroup-count', text: g.threads.length === 1 ? '1 thread' : `${g.threads.length} threads` }),
              ),
              g.threads.map((t) => card(t, hidden.has(t.id))),
            ),
          )
        : empty(threads.length),
    );

    window.scrollTo(window.scrollX, y);
    // A control whose card was filtered out hands focus to the next card, else the heading.
    restoreFocus(root, ui, snap, { fallback: true });
  }

  /** Another tab or window changed what this viewer hides. */
  /** @param {StorageEvent} e */
  const onStorage = (e) => {
    if (e.key !== key) return;
    hidden = parseHidden(e.newValue);
    draw();
  };
  window.addEventListener('storage', onStorage);

  draw();
  refresh();
  return {
    root,
    refresh,
    /** A live hint that comments may have changed: refetch soon (bursts are coalesced). */
    changed: soon,
    destroy() {
      alive = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
    },
  };
}

/**
 * The project's Comments tab.
 * @param {import('./project.js').ProjectCtx} p
 */
export function commentsBody({ ctx, chrome, project }) {
  const me = /** @type {NonNullable<typeof ctx.me>} */ (ctx.me);
  const s = encodeURIComponent(project.slug);
  const page = createCommentsPage({
    me,
    slug: project.slug,
    load: async () => (await get(`/api/p/${s}/threads?status=all`)).threads,
  });
  setChildren(chrome.main, page.root);

  // Subscribing brings the project's `comments` hints (and its head state for the top bar).
  chrome.listen((e) => {
    // Any comment change in the project, or a reconnect that may have missed some.
    if (e.type === 'comments' || e.type === 'open') page.changed();
    else if (e.type === 'live') chrome.setHead(e.head);
  });
  const off = ctx.socket.on((e) => {
    if (e.type === 'notification' && e.notification?.projectSlug === project.slug) page.changed();
  });
  ctx.socket.subscribe(project.slug);

  return {
    destroy() {
      off();
      page.destroy();
    },
  };
}
