// LiveReview admin app: setup / settings, projects, comments across projects and the notification center.
import { ApiError, get, onUnauthorized } from './js/api.js';
import { h, messageBox, setChildren } from './js/dom.js';
import { createSocket } from './js/ws.js';
import { tabFromHash, unreadTitle } from './js/admin/helpers.js';
import { commentsView } from './js/admin/comments.js';
import { createNotificationCenter } from './js/notifications.js';
import { projectsView } from './js/admin/projects.js';
import { settingsView } from './js/admin/settings.js';

const host = /** @type {HTMLElement} */ (document.getElementById('app'));
const ADMIN_UNAUTHORIZED = 'Open LiveReview from the link printed in your terminal.';
const TABS = /** @type {const} */ ([['projects', 'Projects'], ['comments', 'Comments'], ['settings', 'Settings']]);

const socket = createSocket();
/** @type {ReturnType<typeof createNotificationCenter>|null} */
let notices = null;

/** @type {import('./js/admin/settings.js').AdminConfig|null} */
let config = null;
let me = /** @type {{email:string, name:string|null, kind:'owner'|'reviewer', emailNotifications?:boolean}|null} */ (null);
let openCount = 0;
/** Whether the page was drawn as the setup screen (the config object is shared with the form, so compare against this). */
let shownSetup = false;
/** @type {{destroy:()=>void, refresh?:()=>Promise<void>}|null} */
let view = null;
/** @type {HTMLElement|null} */
let countBadge = null;

onUnauthorized(() => {
  view?.destroy();
  view = null;
  notices?.destroy();
  notices = null;
  socket.stop();
  setChildren(host, h('div', { class: 'page' }, messageBox('Not signed in', ADMIN_UNAUTHORIZED)));
});

/** @param {number} n open threads across projects */
function setOpenCount(n) {
  openCount = n;
  if (countBadge) {
    countBadge.textContent = n ? String(n) : '';
    countBadge.hidden = n === 0;
  }
}

function header() {
  const tabs = config?.configured
    ? h(
        'nav',
        { class: 'tabs', 'aria-label': 'Admin sections' },
        TABS.map(([id, label]) =>
          h(
            'a',
            { href: `#${id}`, 'aria-current': tabFromHash(location.hash) === id ? 'page' : null },
            label,
            id === 'comments' ? (countBadge = h('span', { class: 'mark-count tab-count', 'aria-label': 'open comments', hidden: openCount === 0 ? '' : null, text: openCount ? String(openCount) : '' })) : null,
          ),
        ),
      )
    : null;
  if (!tabs) countBadge = null;
  return h(
    'header',
    { class: 'topbar' },
    h('span', { class: 'brand', text: 'LiveReview — Admin' }),
    tabs,
    h('span', { class: 'spacer' }),
    notices?.bell ?? null,
    config?.configured && config.publicHost
      ? h('a', { class: 'public-link', id: 'public-link', href: `https://${config.publicHost}`, target: '_blank', rel: 'noopener noreferrer', text: 'Open public site' })
      : null,
  );
}

/** Draw the whole page for the current config and tab. */
function render() {
  view?.destroy();
  view = null;
  if (!config) return;
  const main = h('main', { id: 'main' });
  setChildren(host, h('div', { class: 'page' }, header(), main));
  const setup = !config.configured;
  shownSetup = setup;
  const tab = setup ? 'settings' : tabFromHash(location.hash);
  if (tab === 'settings') {
    const el = settingsView({
      config, setup,
      onSaved: (next) => {
        config = /** @type {any} */ (next);
        const link = document.getElementById('public-link');
        if (link instanceof HTMLAnchorElement && next.publicHost) link.href = `https://${next.publicHost}`;
        // Finishing setup swaps the page for the tabs. Removing the key later does not: Settings stays up
        // with its notice. Changing the hash redraws through hashchange; if it is already there, draw directly.
        if (shownSetup && next.configured) {
          if (location.hash === '#projects') render();
          else location.hash = '#projects';
        }
      },
    });
    setChildren(main, el);
    view = { destroy() {} };
  } else if (tab === 'comments') {
    const v = commentsView({ me: /** @type {any} */ (me), onCount: setOpenCount });
    setChildren(main, v.root);
    view = v;
  } else {
    const v = projectsView({ onChanged: () => void refreshOpenCount() });
    setChildren(main, v.root);
    view = v;
  }
}

/** After a notification or a reconnect: bring the current tab up to date, fetching the threads once. */
function refreshCurrent() {
  if (view?.refresh && tabFromHash(location.hash) === 'comments') {
    view.refresh();
    return;
  }
  refreshOpenCount();
  view?.refresh?.();
}

async function refreshOpenCount() {
  try {
    setOpenCount((await get('/api/admin/threads?status=open')).threads.length);
  } catch {
    /* the badge just stays as it was */
  }
}

async function start() {
  document.title = unreadTitle(0);
  try {
    [config, me] = await Promise.all([get('/api/admin/config'), get('/api/me')]);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) setChildren(host, h('div', { class: 'page' }, messageBox('Something went wrong', 'Please reload the page.')));
    return;
  }
  notices = createNotificationCenter({
    socket,
    me: /** @type {any} */ (me),
    // The project pages are served on this listener too.
    navigate: (url) => location.assign(url),
    onUnread: (n) => {
      document.title = unreadTitle(n);
    },
    // The admin page has no avatar menu: the email preference sits in the dropdown.
    settingsInPanel: true,
  });
  render();
  if (config?.configured) refreshOpenCount();
  let opened = false;
  socket.on((e) => {
    if (!config?.configured) return;
    if (e.type === 'notification') refreshCurrent();
    else if (e.type === 'open') {
      // The first open follows the initial load; a later one is a reconnect that may have missed events.
      if (opened) refreshCurrent();
      opened = true;
    }
  });
  socket.start();
}

window.addEventListener('hashchange', render);
start();
