// LiveReview reviewer app: client-side routing over the server-rendered shell.
import { ApiError, get, onUnauthorized } from './js/api.js';
import { h, messageBox, setChildren } from './js/dom.js';
import { parseRoute } from './js/route.js';
import { createSocket } from './js/ws.js';
import { loginView } from './js/views/login.js';
import { projectsView } from './js/views/projects.js';
import { projectPage } from './js/views/project.js';
import { liveBody } from './js/views/live.js';
import { commitsBody } from './js/views/commits.js';
import { commitBody } from './js/views/commit.js';
import { commentsBody } from './js/views/comments.js';
import { createNotificationCenter } from './js/notifications.js';

const host = /** @type {HTMLElement} */ (document.getElementById('app'));
const ADMIN_UNAUTHORIZED = 'Open LiveReview from the link printed in your terminal.';

/** @type {import('./js/chrome.js').Ctx} */
const ctx = {
  me: null,
  notices: null,
  socket: createSocket(),
  navigate(path, { replace = false } = {}) {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
    render();
  },
};

/** @type {{destroy:()=>void}|null} */
let current = null;
let token = 0;
let shownPath = '';

// A 401 means no session: the public listener sends the reader to /login; the admin listener (which
// answers /login with 401 too) can only ask for the link from the terminal.
let handling401 = false;
onUnauthorized(async () => {
  if (handling401) return;
  handling401 = true;
  try {
    const probe = await fetch('/login', { credentials: 'same-origin', redirect: 'manual' });
    current?.destroy();
    current = null;
    dropNotices();
    ctx.socket.stop();
    if (probe.status === 401) setChildren(host, h('div', { class: 'page' }, messageBox('Not signed in', ADMIN_UNAUTHORIZED)));
    else location.assign('/login');
  } catch {
    location.assign('/login');
  }
});

async function ensureMe() {
  if (!ctx.me) ctx.me = await get('/api/me');
  // One notification center per signed-in page load; its bell is mounted into each top bar.
  if (ctx.me && !ctx.notices) {
    ctx.notices = createNotificationCenter({ socket: ctx.socket, me: /** @type {any} */ (ctx.me), navigate: (url) => ctx.navigate(url) });
  }
  return ctx.me;
}

function dropNotices() {
  ctx.notices?.destroy();
  ctx.notices = null;
}

async function render() {
  const mine = ++token;
  shownPath = location.pathname;
  current?.destroy();
  current = null;
  const route = parseRoute(location.pathname);
  window.scrollTo(0, 0);

  /** @param {{destroy:()=>void}} view */
  const adopt = (view) => {
    if (mine !== token) view.destroy();
    else current = view;
  };

  try {
    if (route.name === 'login') {
      dropNotices();
      adopt(loginView(ctx, host));
      return;
    }
    if (route.name === 'notfound') {
      document.title = 'Not found · LiveReview';
      setChildren(host, h('div', { class: 'page' }, messageBox('Page not found', 'Check the address and try again.')));
      return;
    }
    if (route.name === 'project') {
      ctx.navigate(`/${route.slug}/live${location.hash}`, { replace: true });
      return;
    }
    await ensureMe();
    if (mine !== token) return;
    if (route.name === 'projects') adopt(projectsView(ctx, host));
    else if (route.name === 'live') adopt(projectPage(ctx, host, route.slug, 'live', liveBody));
    else if (route.name === 'commits') adopt(projectPage(ctx, host, route.slug, 'commits', commitsBody));
    else if (route.name === 'comments') adopt(projectPage(ctx, host, route.slug, 'comments', commentsBody));
    else if (route.name === 'commit') {
      const { sha } = route;
      adopt(projectPage(ctx, host, route.slug, 'commits', (p) => commitBody(p, sha)));
    }
  } catch (err) {
    if (mine !== token || (err instanceof ApiError && err.status === 401)) return;
    setChildren(host, h('div', { class: 'page' }, messageBox('Something went wrong', 'Please reload the page.')));
  }
}

// In-app navigation for links marked data-link (plain left clicks only).
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target instanceof Element ? e.target.closest('a[data-link]') : null;
  if (!(a instanceof HTMLAnchorElement) || a.origin !== location.origin) return;
  e.preventDefault();
  ctx.navigate(a.pathname + a.search + a.hash);
});
window.addEventListener('popstate', () => {
  // Fragment-only navigation (#c-12) also fires popstate; the views handle it themselves.
  if (location.pathname !== shownPath) render();
});

render();
