import { get } from '../api.js';
import { createChrome } from '../chrome.js';
import { h, messageBox, setChildren } from '../dom.js';
import { openCount, projectRowMeta } from '../shell-model.js';

/**
 * @param {import('../chrome.js').Ctx} ctx
 * @param {HTMLElement} host
 */
export function projectsView(ctx, host) {
  document.title = 'Projects · LiveReview';
  const chrome = createChrome(ctx);
  setChildren(host, chrome.root);
  setChildren(chrome.main, h('p', { class: 'muted pad', text: 'Loading…' }));
  let alive = true;
  get('/api/projects').then(
    (list) => {
      if (!alive) return;
      if (!list.length) {
        setChildren(chrome.main, messageBox('No projects yet', 'Projects shared with you will show up here.'));
        return;
      }
      setChildren(
        chrome.main,
        h(
          'div',
          { class: 'container' },
          h('div', { class: 'page-head' }, h('h1', { text: 'Projects' })),
          h(
            'ul',
            { class: 'rows project-rows' },
            list.map((/** @type {{slug:string, name:string, open:number}} */ p) =>
              h(
                'li',
                null,
                h(
                  'a',
                  { class: 'row project-row', href: `/${encodeURIComponent(p.slug)}/live`, 'data-link': '' },
                  h('span', { class: 'row-main' }, h('span', { class: 'row-title', dir: 'auto', text: p.name }), h('span', { class: 'row-sub', dir: 'ltr', text: `/${p.slug}` })),
                  p.open
                    ? h('span', { class: 'row-open' }, h('span', { class: 'mark-count', text: openCount(p.open) }), h('span', { class: 'row-open-text', text: p.open === 1 ? 'open comment' : 'open comments' }))
                    : h('span', { class: 'row-open quiet', text: projectRowMeta(p) }),
                ),
              ),
            ),
          ),
        ),
      );
    },
    () => alive && setChildren(chrome.main, messageBox('Could not load projects', 'Please reload the page.')),
  );
  return {
    destroy() {
      alive = false;
      chrome.destroy();
    },
  };
}
