// Page chrome: top bar (product, project, branch, tabs, offline indicator, user), banners, main area.
import { post } from './api.js';
import { h, messageBox, setChildren } from './dom.js';
import { headLabel } from './format.js';

/**
 * @typedef {object} Ctx
 * @property {{email:string, name:string|null, kind:'owner'|'reviewer'}|null} me
 * @property {ReturnType<typeof import('./ws.js').createSocket>} socket
 * @property {(path:string, opts?:{replace?:boolean})=>void} navigate
 */

/**
 * @param {Ctx} ctx
 * @param {{project?:{slug:string, name:string}, tab?:'live'|'commits'}} [opts]
 */
export function createChrome(ctx, { project, tab } = {}) {
  let stopped = false;
  /** @type {(()=>void)[]} */
  const cleanups = [];

  const branch = h('span', { class: 'branch', hidden: '' });
  const offline = h('span', { class: 'offline', role: 'status', text: 'Offline, reconnecting…' });
  offline.hidden = !ctx.socket.offline;
  const banners = h('div', { class: 'banners' });
  const main = h('main', { id: 'main' });

  const who = ctx.me
    ? [
        h('span', { class: 'who', dir: 'auto', text: ctx.me.name || ctx.me.email }),
        ctx.me.kind === 'reviewer'
          ? h('button', {
              class: 'link', type: 'button', text: 'Sign out',
              onclick: async () => {
                try {
                  await post('/api/logout');
                } finally {
                  ctx.me = null;
                  ctx.socket.stop();
                  ctx.navigate('/login');
                }
              },
            })
          : // The owner reaches the admin page from the admin listener; /admin is not served on the public one.
            h('a', { class: 'admin-link', href: '/admin', text: 'Admin' }),
      ]
    : [];

  const slug = project ? encodeURIComponent(project.slug) : '';
  const bar = h(
    'header',
    { class: 'topbar' },
    h('a', { class: 'brand', href: '/', 'data-link': '', text: 'LiveReview' }),
    project ? h('a', { class: 'project-name', href: `/${slug}/live`, 'data-link': '', dir: 'auto', text: project.name }) : null,
    project ? branch : null,
    project
      ? h(
          'nav',
          { class: 'tabs', 'aria-label': 'Project views' },
          h('a', { href: `/${slug}/live`, 'data-link': '', 'aria-current': tab === 'live' ? 'page' : null, text: 'Live' }),
          h('a', { href: `/${slug}/commits`, 'data-link': '', 'aria-current': tab === 'commits' ? 'page' : null, text: 'Commits' }),
        )
      : null,
    h('span', { class: 'spacer' }),
    offline,
    ...who,
  );
  const root = h('div', { class: 'page' }, bar, banners, main);

  /** @type {HTMLElement|null} */
  let errorBanner = null;
  /** @type {HTMLElement|null} */
  let opBanner = null;

  /** @param {HTMLElement|null} el @param {string|null} text @param {string} cls */
  function setBanner(el, text, cls) {
    if (!text) {
      el?.remove();
      return null;
    }
    if (el) {
      el.textContent = text;
      return el;
    }
    const b = h('div', { class: `banner ${cls}`, role: 'status', text });
    banners.append(b);
    return b;
  }

  /** Header state from a head snapshot. @param {import('../../src/types.js').HeadState|null} head */
  function setHead(head) {
    const { label, banner } = headLabel(head);
    branch.textContent = label;
    branch.hidden = !label;
    opBanner = setBanner(opBanner, banner, 'warn');
  }

  if (project) {
    cleanups.push(
      ctx.socket.on((e) => {
        if (e.type === 'close') offline.hidden = false;
        else if (e.type === 'open') offline.hidden = true;
        else if (e.slug !== project.slug) return;
        else if (e.type === 'moved' && typeof e.to === 'string') {
          // The owner renamed the project's address: show the same view under the new one.
          const rest = location.pathname.split('/').slice(2).join('/');
          ctx.navigate(`/${encodeURIComponent(e.to)}/${rest}${location.search}${location.hash}`, { replace: true });
        } else if (e.type === 'revoked') stop('Your access to this project was removed');
        else if (e.type === 'error' && e.error === 'project-unavailable') {
          errorBanner = setBanner(errorBanner, "This project isn't available right now", 'error');
        } else if (e.type === 'live') errorBanner = setBanner(errorBanner, null, 'error');
      }),
    );
  }

  /** @param {string} message */
  function stop(message) {
    if (stopped) return;
    stopped = true;
    if (project) ctx.socket.unsubscribe(project.slug);
    setChildren(main, messageBox(message));
    for (const fn of stopListeners) fn();
  }
  /** @type {(()=>void)[]} */
  const stopListeners = [];

  return {
    root,
    main,
    setHead,
    get stopped() {
      return stopped;
    },
    /**
     * Listen to this project's socket events until the page is torn down or access is revoked.
     * @param {(e:import('./ws.js').SocketEvent)=>void} fn
     */
    listen(fn) {
      cleanups.push(
        ctx.socket.on((e) => {
          if (stopped) return;
          if (e.type === 'open' || e.type === 'close' || e.slug === project?.slug) fn(e);
        }),
      );
    },
    /** @param {()=>void} fn called when access is revoked */
    onStop(fn) {
      stopListeners.push(fn);
    },
    destroy() {
      for (const fn of cleanups) fn();
      if (project && !stopped) ctx.socket.unsubscribe(project.slug);
    },
  };
}
