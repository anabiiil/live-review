// The review surface shared by the live view and the commit view: toolbar, file list, diffs,
// threads and the comment sections. Re-rendering keeps scroll position, open composers and focus.
import { api, getComments } from './api.js';
import { createUiState, renderThread } from './comments.js';
import { renderFile } from './diff.js';
import { captureFocus, restoreFocus } from './focus.js';
import { h, setChildren, storage } from './dom.js';
import { flashOffset, threadForComment, threadsByKey } from './pairing.js';
import { commentIdFromHash } from './route.js';

/** @typedef {import('../../src/types.js').FileDiff} FileDiff */
/** @typedef {{threads:any[], outdated:any[], rewritten:any[]}} CommentSet */

const MODE_KEY = 'lr-diff-mode';
/** Side by side needs room: phones always get the unified layout. */
const NARROW = window.matchMedia('(max-width: 640px)');

/** @returns {'split'|'unified'} */
function initialMode() {
  const saved = storage.get(MODE_KEY);
  if (saved === 'split' || saved === 'unified') return saved;
  return window.matchMedia('(min-width: 1100px)').matches ? 'split' : 'unified';
}

/**
 * @param {{slug:string, target:string, root:HTMLElement, me:{email:string, name:string|null, kind:'owner'|'reviewer'}}} o
 *   target is 'live' or a full commit sha
 */
export function createReview({ slug, target, root, me }) {
  const ui = createUiState(initialMode());
  /** @type {FileDiff[]} */
  let files = [];
  let truncated = false;
  /** @type {CommentSet} */
  let comments = { threads: [], outdated: [], rewritten: [] };
  let haveDiff = false;
  let diffJson = '';
  let commentsJson = '';
  let destroyed = false;
  /** Scroll to the `#c-id` thread on the next render, and keep doing so until the reader scrolls. */
  let hashPinned = false;
  let lastHash = '';
  /** The hash whose thread was already opened (once: after that the reader may close it again). */
  let revealedHash = '';
  /** @type {{id:number, at:number}|null} the deep-link flash in progress */
  let flash = null;

  const api0 = `/api/p/${encodeURIComponent(slug)}`;

  const unpin = () => {
    hashPinned = false;
  };
  const onNarrow = () => render();
  NARROW.addEventListener('change', onNarrow);
  const onHash = () => {
    lastHash = '';
    revealedHash = '';
    render();
  };
  window.addEventListener('wheel', unpin, { passive: true });
  window.addEventListener('touchmove', unpin, { passive: true });
  window.addEventListener('keydown', unpin);
  window.addEventListener('hashchange', onHash);

  /** @type {import('./comments.js').CommentEnv} */
  const env = {
    me,
    ui,
    rerender: () => render(),
    // Always render: the caller just changed `ui` (closed a composer) and a live-update refetch may
    // already have delivered the same comments.
    refresh: async () => {
      setComments(await getComments(slug, target), true);
    },
    createComment: (path, side, line, body) => api('POST', `${api0}/comments`, { target, path, line, side, body }),
    reply: (id, body) => api('POST', `/api/comments/${id}/replies`, { body }),
    edit: (id, body) => api('PATCH', `/api/comments/${id}`, { body }),
    remove: (id) => api('DELETE', `/api/comments/${id}`),
    setResolved: (id, resolved) => api('PATCH', `/api/comments/${id}`, { resolved }),
  };

  /** Capture scroll and focus, rebuild, restore. */
  function render() {
    if (destroyed || !haveDiff) return;
    const x = window.scrollX;
    const y = window.scrollY;
    // Buttons that re-render the page (marks, file header controls, Resolve) carry a stable key.
    const snap = captureFocus(root, ui);

    build();

    window.scrollTo(x, y);
    restoreFocus(root, ui, snap);
    ui.opening.clear();
    applyHash();
  }

  /**
   * Scroll to the comment named by the URL hash on load and while the reader has not scrolled, and flash it
   * once. Re-renders during the flash resume it where it was.
   */
  function applyHash() {
    const id = commentIdFromHash(location.hash);
    if (id === null) return;
    const el = /** @type {HTMLElement|null} */ (root.querySelector(`#c-${id}`));
    if (!el) return;
    if (location.hash !== lastHash) {
      lastHash = location.hash;
      flash = { id, at: Date.now() };
      el.scrollIntoView({ block: 'center' });
      hashPinned = true;
    } else if (hashPinned) el.scrollIntoView({ block: 'center' });
    const offset = flash && flash.id === id ? flashOffset(flash.at, Date.now()) : null;
    if (offset === null) return;
    el.style.animationDelay = `-${offset}ms`;
    el.classList.add('flash');
  }

  /**
   * Make sure the hash target is visible, once per hash: open its thread (and its file, large diff, resolved
   * summary or section).
   */
  function revealHash() {
    const id = commentIdFromHash(location.hash);
    if (id === null || location.hash === revealedHash) return;
    const t = threadForComment([...comments.threads, ...comments.outdated, ...comments.rewritten], id);
    if (!t) return;
    revealedHash = location.hash;
    if (comments.outdated.includes(t)) ui.openSections.add('outdated');
    if (comments.rewritten.includes(t)) ui.openSections.add('rewritten');
    ui.expandedResolved.add(t.id);
    if (!ui.openThreads.has(t.id)) {
      ui.openThreads.add(t.id);
      ui.opening.add(t.id);
    }
    if (comments.threads.includes(t)) {
      ui.collapsedFiles.delete(t.path);
      ui.expandedFiles.add(t.path);
    }
  }

  function build() {
    revealHash();
    const visible = comments.threads.filter((t) => !t.hidden);
    const byKey = threadsByKey(visible);
    /** @type {Map<string, number>} */
    const openByPath = new Map();
    /** @type {Map<string, any[]>} */
    const byPath = new Map();
    for (const t of visible) {
      if (!t.resolved) openByPath.set(t.path, (openByPath.get(t.path) ?? 0) + 1);
      if (t.side && t.line !== null) byPath.set(t.path, [...(byPath.get(t.path) ?? []), t]);
    }
    const narrow = NARROW.matches;
    const diffEnv = { comments: env, mode: narrow ? 'unified' : ui.mode, byKey, byPath, placed: new Set(), openByPath };

    const fileEls = files.map((f) => renderFile(f, diffEnv));

    // Threads whose line is not part of a rendered diff still need a home.
    const folded = new Set(files.filter((f) => ui.collapsedFiles.has(f.path)).map((f) => f.path));
    const unplaced = visible.filter((t) => !diffEnv.placed.has(t.id) && !folded.has(t.path));

    const toolbar = h(
      'div',
      { class: 'review-toolbar' },
      h('span', { class: 'muted', text: files.length === 1 ? '1 file changed' : `${files.length} files changed` }),
      narrow ? null : h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': 'Diff layout' },
        ...(/** @type {const} */ (['unified', 'split'])).map((mode) =>
          h('button', {
            class: 'seg-btn', type: 'button', 'aria-pressed': String(ui.mode === mode), text: mode === 'split' ? 'Side by side' : 'Unified',
            onclick: () => {
              ui.mode = mode;
              storage.set(MODE_KEY, mode);
              render();
            },
          }),
        ),
      ),
    );

    const main = h('div', { class: 'review-main' });
    if (truncated) main.append(h('p', { class: 'notice', text: 'Showing the first 300 new files' }));
    if (!files.length) {
      main.append(h('p', { class: 'empty', text: target === 'live' ? 'No uncommitted changes right now. This page updates by itself when files change; to comment on earlier work, open Commits.' : 'This commit changes no files.' }));
    } else {
      main.append(
        h('p', { class: 'comment-hint', text: 'To comment, click the + next to any line. Lines with comments get a yellow mark on the right; click it to open the conversation.' }),
      );
    }
    main.append(...fileEls);
    if (unplaced.length) main.append(section('unplaced', 'Comments on lines not shown in this diff', unplaced, (t) => [location_(t), renderThread(t, env)], true));

    const others = comments.outdated.filter((t) => !t.hidden);
    if (others.length) main.append(section('outdated', 'Outdated comments', others, (t) => [location_(t), renderThread(t, env)]));
    const rewritten = comments.rewritten.filter((t) => !t.hidden && t.target !== target);
    if (rewritten.length) {
      main.append(
        section('rewritten', 'Comments on rewritten commits', rewritten, (t) => [
          h(
            'div',
            { class: 'thread-where' },
            h('a', { href: `/${encodeURIComponent(slug)}/commit/${t.target}`, 'data-link': '', text: t.target.slice(0, 7) }),
            ' ',
            h('span', { dir: 'ltr', text: location_text(t) }),
          ),
          renderThread(t, env),
        ]),
      );
    }

    setChildren(root, toolbar, h('div', { class: 'review-body' }, sidebar(files, openByPath), main));
  }

  /** @param {any} t */
  const location_text = (t) => (t.line ? `${t.path}:${t.line}` : t.path);
  /** @param {any} t */
  const location_ = (t) => h('div', { class: 'thread-where', dir: 'ltr', text: location_text(t) });

  /**
   * A collapsible group of threads.
   * @param {string} id
   * @param {string} title
   * @param {any[]} list
   * @param {(t:any)=>any[]} item
   * @param {boolean} [alwaysOpen]
   */
  function section(id, title, list, item, alwaysOpen = false) {
    const details = h(
      'details',
      { class: 'section', open: alwaysOpen || ui.openSections.has(id) },
      h('summary', { text: `${title} (${list.length})` }),
      h('div', { class: 'section-body' }, list.map((t) => h('div', { class: 'section-item' }, item(t)))),
    );
    details.addEventListener('toggle', () => {
      if (alwaysOpen) return;
      if (/** @type {HTMLDetailsElement} */ (details).open) ui.openSections.add(id);
      else ui.openSections.delete(id);
    });
    return details;
  }

  /**
   * @param {FileDiff[]} list
   * @param {Map<string, number>} openByPath
   */
  function sidebar(list, openByPath) {
    const open = ui.sidebarOpen ?? window.matchMedia('(min-width: 900px)').matches;
    const details = /** @type {HTMLDetailsElement} */ (
      h('details', { class: 'filelist', open }, h('summary', { text: `Files (${list.length})` }))
    );
    details.addEventListener('toggle', () => {
      ui.sidebarOpen = details.open;
    });
    const ul = h('ul');
    for (const f of list) {
      const slash = f.path.lastIndexOf('/');
      const open = openByPath.get(f.path) ?? 0;
      ul.append(
        h(
          'li',
          null,
          h(
            'a',
            {
              href: '#', class: 'filelink', title: f.path,
              onclick: (/** @type {Event} */ e) => {
                e.preventDefault();
                if (ui.collapsedFiles.delete(f.path)) render();
                const el = [...root.querySelectorAll('section.file')].find((n) => /** @type {HTMLElement} */ (n).dataset.path === f.path);
                el?.scrollIntoView({ block: 'start' });
              },
            },
            h('span', { class: `badge ${f.status}`, text: { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[f.status] }),
            h(
              'span',
              { class: 'fname', dir: 'ltr' },
              slash >= 0 ? h('span', { class: 'dir', text: f.path.slice(0, slash + 1) }) : null,
              h('span', { class: 'base', text: f.path.slice(slash + 1) }),
            ),
            open ? h('span', { class: 'mark-count', title: open === 1 ? '1 open comment' : `${open} open comments`, text: String(open) }) : null,
          ),
        ),
      );
    }
    details.append(list.length ? ul : h('p', { class: 'muted pad', text: 'No files' }));
    return h('aside', { class: 'sidebar' }, details);
  }

  async function refreshComments() {
    setComments(await getComments(slug, target));
  }

  /**
   * @param {CommentSet} c
   * @param {boolean} [force] render even when the comments did not change
   */
  function setComments(c, force = false) {
    const json = JSON.stringify(c);
    if (json === commentsJson && !force) return;
    commentsJson = json;
    comments = c;
    render();
  }

  return {
    ui,
    /**
     * @param {FileDiff[]} nextFiles
     * @param {boolean} nextTruncated
     */
    setDiff(nextFiles, nextTruncated) {
      const json = JSON.stringify([nextFiles, nextTruncated]);
      if (haveDiff && json === diffJson) return;
      diffJson = json;
      files = nextFiles;
      truncated = nextTruncated;
      haveDiff = true;
      render();
    },
    setComments,
    refreshComments,
    get ready() {
      return haveDiff;
    },
    destroy() {
      destroyed = true;
      window.removeEventListener('wheel', unpin);
      window.removeEventListener('touchmove', unpin);
      window.removeEventListener('keydown', unpin);
      window.removeEventListener('hashchange', onHash);
      NARROW.removeEventListener('change', onNarrow);
    },
  };
}
