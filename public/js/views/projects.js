import { get } from '../api.js';
import { createChrome } from '../chrome.js';
import { h, messageBox, setChildren } from '../dom.js';

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
          h('h1', { text: 'Projects' }),
          h(
            'ul',
            { class: 'project-list' },
            list.map((/** @type {{slug:string, name:string, open:number}} */ p) =>
              h(
                'li',
                null,
                h(
                  'a',
                  { class: 'project-card', href: `/${encodeURIComponent(p.slug)}/live`, 'data-link': '' },
                  h('span', { class: 'project-title', dir: 'auto', text: p.name }),
                  p.open ? h('span', { class: 'chip open-chip', text: p.open === 1 ? '1 open comment' : `${p.open} open comments` }) : h('span', { class: 'muted', text: 'No open comments' }),
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
