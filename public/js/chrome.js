// Page chrome: the top bar (mark, project switcher, branch + live dot, tabs, notification slot, avatar menu),
// banners and the main area.
import { get, post } from './api.js';
import { h, messageBox, setChildren } from './dom.js';
import { headLabel } from './format.js';
import { icon } from './icons.js';
import { initials, openCount } from './shell-model.js';

/**
 * @typedef {object} Ctx
 * @property {{email:string, name:string|null, kind:'owner'|'reviewer'}|null} me
 * @property {ReturnType<typeof import('./ws.js').createSocket>} socket
 * @property {(path:string, opts?:{replace?:boolean})=>void} navigate
 */

/** @typedef {{slug:string, name:string, open:number}} ProjectSummary */
/** @typedef {'live'|'commits'|'comments'} Tab */

/**
 * A button that opens a menu below it. Closes on Escape, outside clicks and choosing an item; arrow keys move
 * between items.
 * @param {HTMLButtonElement} trigger
 * @param {()=>any[]} items builds the menu content each time it opens
 * @param {{align?:'start'|'end', label:string}} opts
 * @returns {{root:HTMLElement, destroy:()=>void}}
 */
function menuButton(trigger, items, { align = 'start', label }) {
  const menu = h('div', { class: `menu ${align}`, role: 'menu', 'aria-label': label, hidden: '' });
  const root = h('div', { class: 'menu-anchor' }, trigger, menu);
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  const entries = () => /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('[role="menuitem"]')]);
  /** @param {boolean} [focusTrigger] */
  const close = (focusTrigger) => {
    if (menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger.focus();
  };
  const open = () => {
    setChildren(menu, items());
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    entries()[0]?.focus();
  };
  trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
  menu.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('[role="menuitem"]')) close();
  });
  root.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = entries();
      const at = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === 'Tab') close();
  });
  /** @param {MouseEvent} e */
  const outside = (e) => {
    if (e.target instanceof Node && !root.contains(e.target)) close();
  };
  document.addEventListener('click', outside);
  return { root, destroy: () => document.removeEventListener('click', outside) };
}

/**
 * @param {Ctx} ctx
 * @param {{project?:ProjectSummary, projects?:ProjectSummary[], tab?:Tab}} [opts]
 */
export function createChrome(ctx, { project, projects = [], tab } = {}) {
  let stopped = false;
  /** @type {(()=>void)[]} */
  const cleanups = [];
  const slug = project ? encodeURIComponent(project.slug) : '';

  const brand = h('a', { class: 'brand', href: '/', 'data-link': '', 'aria-label': 'LiveReview, all projects' }, icon('mark'), h('span', { class: 'brand-name', text: 'LiveReview' }));

  // ---- project, branch, live state ----
  /** @type {HTMLElement|null} */
  let switcher = null;
  if (project) {
    const trigger = /** @type {HTMLButtonElement} */ (
      h('button', { class: 'switcher', type: 'button', title: 'Switch project' }, h('span', { class: 'switcher-name', dir: 'auto', text: project.name }), icon('chevron-down'))
    );
    const m = menuButton(
      trigger,
      () => [
        h('p', { class: 'menu-label', text: 'Projects' }),
        ...projects.map((p) =>
          h(
            'a',
            { class: 'menu-item', role: 'menuitem', href: `/${encodeURIComponent(p.slug)}/live`, 'data-link': '', 'aria-current': p.slug === project.slug ? 'page' : null },
            h('span', { class: 'menu-text', dir: 'auto', text: p.name }),
            p.open ? h('span', { class: 'mark-count', 'aria-label': `${p.open} open`, text: openCount(p.open) }) : null,
          ),
        ),
        h('div', { class: 'menu-sep', role: 'separator' }),
        h('a', { class: 'menu-item', role: 'menuitem', href: '/', 'data-link': '', text: 'All projects' }),
      ],
      { label: 'Projects' },
    );
    cleanups.push(m.destroy);
    switcher = m.root;
  }

  const branchText = h('span', { class: 'branch-name', dir: 'ltr' });
  const branch = h('span', { class: 'branch', hidden: '' }, icon('git-branch'), branchText);
  const liveText = h('span', { class: 'live-text' });
  const live = h('span', { class: 'live', role: 'status' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), liveText);
  /** @param {'connecting'|'live'|'offline'} state */
  const setLive = (state) => {
    live.dataset.state = state;
    liveText.textContent = state === 'live' ? 'live' : state === 'offline' ? 'offline' : 'connecting';
    live.title = state === 'live' ? 'Connected: changes appear as they happen' : state === 'offline' ? 'Offline, reconnecting…' : 'Connecting…';
  };
  setLive(ctx.socket.online ? 'live' : ctx.socket.offline ? 'offline' : 'connecting');

  // ---- tabs ----
  const count = h('span', { class: 'mark-count tab-count', hidden: '' });
  /** @param {number} n */
  const setOpen = (n) => {
    count.textContent = openCount(n);
    count.hidden = !n;
    count.setAttribute('aria-label', `${n} open`);
  };
  setOpen(project?.open ?? 0);
  /** @param {Tab} id @param {string} href @param {string} text @param {any} [extra] */
  const tabLink = (id, href, text, extra) =>
    h('a', { class: 'tab', href, 'data-link': '', 'aria-current': tab === id ? 'page' : null }, h('span', { text }), extra);
  const tabs = project
    ? h(
        'nav',
        { class: 'tabs', 'aria-label': 'Project views' },
        tabLink('live', `/${slug}/live`, 'Changes'),
        tabLink('commits', `/${slug}/commits`, 'Commits'),
        tabLink('comments', `/${slug}/comments`, 'Comments', count),
      )
    : null;

  // ---- notifications slot (filled by the notification center) and avatar menu ----
  const bellSlot = h('div', { class: 'bell-slot' });
  /** @type {HTMLElement|null} */
  let avatar = null;
  if (ctx.me) {
    const me = ctx.me;
    const trigger = /** @type {HTMLButtonElement} */ (
      h('button', { class: 'avatar-btn', type: 'button', 'aria-label': `Account: ${me.name || me.email}` }, h('span', { class: 'avatar', dir: 'auto', text: initials(me.name, me.email) }))
    );
    const signOut = async () => {
      try {
        await post('/api/logout');
      } finally {
        ctx.me = null;
        ctx.socket.stop();
        ctx.navigate('/login');
      }
    };
    const m = menuButton(
      trigger,
      () => [
        h('div', { class: 'menu-who' }, h('p', { class: 'menu-who-name', dir: 'auto', text: me.name || me.email }), me.name ? h('p', { class: 'menu-who-email', text: me.email }) : null),
        h('div', { class: 'menu-sep', role: 'separator' }),
        me.kind === 'reviewer'
          ? h('button', { class: 'menu-item', role: 'menuitem', type: 'button', onclick: signOut }, icon('log-out'), 'Sign out')
          : // The owner reaches the admin page from the admin listener; /admin is not served on the public one.
            h('a', { class: 'menu-item', role: 'menuitem', href: '/admin' }, icon('shield'), 'Admin'),
      ],
      { align: 'end', label: 'Account' },
    );
    cleanups.push(m.destroy);
    avatar = m.root;
  }

  const bar = h(
    'header',
    { class: 'topbar' },
    brand,
    switcher ? h('span', { class: 'topbar-sep', 'aria-hidden': 'true' }) : null,
    switcher,
    project ? h('span', { class: 'where' }, branch, live) : null,
    h('span', { class: 'spacer' }),
    tabs,
    bellSlot,
    avatar,
  );
  const banners = h('div', { class: 'banners' });
  const main = h('main', { id: 'main' });
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
    branchText.textContent = label;
    branch.title = label;
    branch.hidden = !label;
    opBanner = setBanner(opBanner, banner, 'warn');
  }

  // The open-comment count follows comment changes (one refetch per burst).
  /** @type {ReturnType<typeof setTimeout>|null} */
  let countTimer = null;
  const refreshCount = () => {
    if (countTimer) return;
    countTimer = setTimeout(async () => {
      countTimer = null;
      try {
        const list = /** @type {ProjectSummary[]} */ (await get('/api/projects'));
        const mine = list.find((p) => p.slug === project?.slug);
        if (mine && !stopped) setOpen(mine.open);
      } catch {
        /* the count just stays as it was */
      }
    }, 300);
  };
  cleanups.push(() => {
    if (countTimer) clearTimeout(countTimer);
  });

  if (project) {
    cleanups.push(
      ctx.socket.on((e) => {
        if (e.type === 'close') setLive('offline');
        else if (e.type === 'open') setLive('live');
        else if (e.slug !== project.slug) return;
        else if (e.type === 'moved' && typeof e.to === 'string') {
          // The owner renamed the project's address: show the same view under the new one.
          const rest = location.pathname.split('/').slice(2).join('/');
          ctx.navigate(`/${encodeURIComponent(e.to)}/${rest}${location.search}${location.hash}`, { replace: true });
        } else if (e.type === 'revoked') stop('Your access to this project was removed');
        else if (e.type === 'error' && e.error === 'project-unavailable') {
          errorBanner = setBanner(errorBanner, "This project isn't available right now", 'error');
        } else if (e.type === 'live') errorBanner = setBanner(errorBanner, null, 'error');
        else if (e.type === 'comments') refreshCount();
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
    /** Where the notification center mounts its bell. */
    bellSlot,
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
