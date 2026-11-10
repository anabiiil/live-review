import { get } from '../api.js';
import { h, messageBox, setChildren } from '../dom.js';
import { relativeTime } from '../format.js';

/**
 * Paged commit list; reloads when the head moves.
 * @param {import('./project.js').ProjectCtx} p
 */
export function commitsBody({ ctx, chrome, project }) {
  const slug = encodeURIComponent(project.slug);
  const list = h('ol', { class: 'commit-list' });
  const status = h('p', { class: 'muted pad', text: 'Loading…' });
  const more = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn', type: 'button', text: 'Load more', hidden: '' }));
  setChildren(chrome.main, h('div', { class: 'container' }, h('h1', { text: 'Commits' }), status, list, more));
  let alive = true;
  let loaded = 0;
  let hasMore = false;
  let headSha = /** @type {string|null|undefined} */ (undefined);
  let busy = false;

  /** @param {{sha:string, short:string, subject:string, author:string, date:string}} c */
  const row = (c) =>
    h(
      'li',
      null,
      h(
        'a',
        { class: 'commit-row', href: `/${slug}/commit/${c.sha}`, 'data-link': '' },
        h('span', { class: 'sha', text: c.short }),
        h('span', { class: 'subject', dir: 'auto', text: c.subject || '(no message)' }),
        h('span', { class: 'meta' }, h('span', { dir: 'auto', text: c.author }), ' · ', h('time', { datetime: c.date, title: new Date(c.date).toLocaleString(), text: relativeTime(c.date) })),
      ),
    );

  /**
   * @param {number} from first page to fetch
   * @param {number} to last page to fetch
   * @param {boolean} replace
   */
  async function load(from, to, replace) {
    if (busy) return;
    busy = true;
    more.disabled = true;
    try {
      /** @type {HTMLElement[]} */
      const rows = [];
      for (let page = from; page <= to; page++) {
        const d = await get(`/api/p/${slug}/commits?page=${page}`);
        if (!alive) return;
        rows.push(...d.commits.map(row));
        hasMore = d.hasMore;
        loaded = page;
        if (!d.hasMore) break;
      }
      if (replace) list.textContent = '';
      list.append(...rows);
      status.hidden = true;
      if (!list.childNodes.length) {
        status.hidden = false;
        status.textContent = 'No commits yet.';
      }
    } catch {
      if (alive && !list.childNodes.length) setChildren(chrome.main, messageBox("Commits aren't available right now", 'Please try again in a moment.'));
    } finally {
      busy = false;
      more.disabled = false;
      more.hidden = !hasMore;
    }
  }

  more.addEventListener('click', () => load(loaded + 1, loaded + 1, false));
  chrome.listen((e) => {
    if (e.type !== 'live') return;
    chrome.setHead(e.head);
    const sha = e.head?.sha ?? null;
    if (headSha !== undefined && sha !== headSha && loaded > 0) load(1, loaded, true);
    headSha = sha;
  });
  ctx.socket.subscribe(project.slug);
  load(1, 1, true);

  return {
    destroy() {
      alive = false;
    },
  };
}
