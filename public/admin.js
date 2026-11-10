// LiveReview admin app: setup / settings, projects, inbox and desktop notifications.
import { ApiError, get, onUnauthorized } from './js/api.js';
import { h, messageBox, setChildren } from './js/dom.js';
import { createSocket } from './js/ws.js';
import { tabFromHash, unreadTitle } from './js/admin/helpers.js';
import { inboxView } from './js/admin/inbox.js';
import { createNotifier } from './js/admin/notifications.js';
import { projectsView } from './js/admin/projects.js';
import { settingsView } from './js/admin/settings.js';

const host = /** @type {HTMLElement} */ (document.getElementById('app'));
const ADMIN_UNAUTHORIZED = 'Open LiveReview from the link printed in your terminal.';
const TABS = /** @type {const} */ ([['projects', 'Projects'], ['inbox', 'Inbox'], ['settings', 'Settings']]);

const socket = createSocket();
const notifier = createNotifier({ socket, onNotify: () => view?.refresh?.() });

/** @type {import('./js/admin/settings.js').AdminConfig|null} */
let config = null;
let me = /** @type {{email:string, name:string|null, kind:'owner'|'reviewer'}|null} */ (null);
let inboxCount = 0;
/** @type {{destroy:()=>void, refresh?:()=>Promise<void>}|null} */
let view = null;
/** @type {HTMLElement|null} */
let inboxBadge = null;

onUnauthorized(() => {
  view?.destroy();
  view = null;
  socket.stop();
  setChildren(host, h('div', { class: 'page' }, messageBox('Not signed in', ADMIN_UNAUTHORIZED)));
});

/** @param {number} n */
function setInboxCount(n) {
  inboxCount = n;
  if (inboxBadge) {
    inboxBadge.textContent = n ? String(n) : '';
    inboxBadge.hidden = n === 0;
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
            id === 'inbox' ? (inboxBadge = h('span', { class: 'count-badge', 'aria-label': 'open comments', hidden: inboxCount === 0 ? '' : null, text: inboxCount ? String(inboxCount) : '' })) : null,
          ),
        ),
      )
    : null;
  if (!tabs) inboxBadge = null;
  return h(
    'header',
    { class: 'topbar' },
    h('span', { class: 'brand', text: 'LiveReview — Admin' }),
    tabs,
    h('span', { class: 'spacer' }),
    notifier.button(),
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
  const tab = setup ? 'settings' : tabFromHash(location.hash);
  if (tab === 'settings') {
    const wasConfigured = config.configured;
    const el = settingsView({
      config, setup,
      onSaved: (next) => {
        config = /** @type {any} */ (next);
        const link = document.getElementById('public-link');
        if (link instanceof HTMLAnchorElement && next.publicHost) link.href = `https://${next.publicHost}`;
        // Leaving setup (or dropping back into it) changes the whole page; a plain save does not.
        if (/** @type {any} */ (next).configured !== wasConfigured) {
          if (next.configured) location.hash = '#projects';
          render();
        }
      },
    });
    setChildren(main, el);
    view = { destroy() {} };
  } else if (tab === 'inbox') {
    const v = inboxView({ me: /** @type {any} */ (me), onCount: setInboxCount });
    setChildren(main, v.root);
    view = v;
  } else {
    const v = projectsView({ onChanged: () => void refreshInboxCount() });
    setChildren(main, v.root);
    view = v;
  }
}

async function refreshInboxCount() {
  try {
    setInboxCount((await get('/api/admin/inbox')).length);
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
  render();
  if (config?.configured) refreshInboxCount();
  socket.on((e) => {
    if (e.type === 'open' || e.type === 'notify') refreshInboxCount();
  });
  socket.start();
}

window.addEventListener('hashchange', render);
start();
