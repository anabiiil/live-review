// Shared frame for the per-project pages: resolves the project (no access and unknown look the same),
// builds the chrome and hands over to the page body.
import { get } from '../api.js';
import { createChrome } from '../chrome.js';
import { h, messageBox, setChildren } from '../dom.js';

/**
 * @typedef {{ctx:import('../chrome.js').Ctx, chrome:ReturnType<typeof createChrome>, project:import('../chrome.js').ProjectSummary}} ProjectCtx
 */

/**
 * @param {import('../chrome.js').Ctx} ctx
 * @param {HTMLElement} host
 * @param {string} slug
 * @param {import('../chrome.js').Tab} tab
 * @param {(p:ProjectCtx)=>{destroy:()=>void}} build
 */
export function projectPage(ctx, host, slug, tab, build) {
  let alive = true;
  /** @type {{destroy:()=>void}|null} */
  let inner = null;
  /** @type {ReturnType<typeof createChrome>|null} */
  let chrome = null;
  document.title = 'LiveReview';
  const plain = createChrome(ctx);
  setChildren(host, plain.root);
  setChildren(plain.main, h('p', { class: 'muted pad', text: 'Loading…' }));

  (async () => {
    const list = await get('/api/projects');
    if (!alive) return;
    const project = list.find((/** @type {{slug:string}} */ p) => p.slug === slug);
    if (!project) {
      setChildren(plain.main, messageBox('Project not found', "You don't have access to this project, or it doesn't exist."));
      return;
    }
    plain.destroy();
    chrome = createChrome(ctx, { project, projects: list, tab });
    setChildren(host, chrome.root);
    document.title = `${project.name} - LiveReview`;
    ctx.socket.start();
    inner = build({ ctx, chrome, project });
  })().catch(() => {
    if (alive) setChildren(plain.main, messageBox('Something went wrong', 'Please reload the page.'));
  });

  return {
    destroy() {
      alive = false;
      inner?.destroy();
      chrome?.destroy();
      plain.destroy();
    },
  };
}
