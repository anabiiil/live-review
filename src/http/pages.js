import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_SLUGS, SLUG_RE } from '../projects/store.js';
import { redirect, sendHtml, sendJson } from './router.js';
import { sessionCookie } from './guards.js';

/** @typedef {ReturnType<typeof import('./router.js').createRouter>} Router */
/** @typedef {import('./router.js').RouteContext} RouteContext */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STATIC_DIRS = {
  static: resolve(ROOT, 'public'),
  vendor: resolve(ROOT, 'node_modules', 'diff2html', 'bundles'),
};

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const SHA_RE = /^[0-9a-f]{7,40}$/;
const NOT_FOUND_HTML = 'Not found.';
const ADMIN_UNAUTHORIZED = 'Open LiveReview from the link printed in your terminal.';

/** @param {string} s */
export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/**
 * The single-page app shell. No inline scripts (CSP).
 * @param {{title:string}} p
 * @returns {string}
 */
export function shell({ title }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/vendor/diff2html/css/diff2html.min.css">
<link rel="stylesheet" href="/static/app.css">
<script src="/vendor/diff2html/js/diff2html.min.js"></script>
<script type="module" src="/static/app.js"></script>
</head>
<body>
<div id="app"></div>
</body>
</html>
`;
}

/**
 * A static message page (no scripts).
 * @param {string} message
 * @returns {string}
 */
export function messagePage(message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LiveReview</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<p>${escapeHtml(message)}</p>
</body>
</html>
`;
}

/**
 * Response for a page request without a viewer: public → /login, admin → 401 message.
 * @param {RouteContext} ctx
 */
export function unauthenticatedPage({ res, listener }) {
  if (listener.kind === 'admin') sendHtml(res, 401, messagePage(ADMIN_UNAUTHORIZED));
  else redirect(res, '/login');
}

/**
 * @param {string} dir absolute base directory
 * @param {string} rawRest percent-encoded remainder of the URL path
 * @returns {Promise<string|null>} absolute file path inside `dir`, or null
 */
async function resolveStatic(dir, rawRest) {
  let rest;
  try {
    rest = decodeURIComponent(rawRest);
  } catch {
    return null;
  }
  if (rest === '' || rest.includes('\0') || rest.includes('\\')) return null;
  if (rest.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  const full = resolve(dir, rest);
  if (!full.startsWith(dir + sep)) return null;
  try {
    // Symlinks may not lead outside the directory either.
    const real = await realpath(full);
    const realDir = await realpath(dir);
    if (!real.startsWith(realDir + sep)) return null;
    if (!(await stat(real)).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * @param {keyof typeof STATIC_DIRS} which
 * @returns {(ctx:RouteContext)=>Promise<void>}
 */
const serveStatic = (which) => async ({ res, params }) => {
  const file = await resolveStatic(STATIC_DIRS[which], params['*'] ?? '');
  const type = file ? TYPES[/** @type {keyof typeof TYPES} */ (extname(file).toLowerCase())] : undefined;
  if (!file || !type) {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }
  const data = await readFile(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  res.end(data);
};

/**
 * Register static files, the invite link and the HTML page routes.
 * @param {Router} router
 * @param {{projects:ReturnType<typeof import('../projects/store.js').createProjectStore>,
 *   sessions:ReturnType<typeof import('../auth/sessions.js').createSessionService>, now:()=>number}} deps
 */
export function registerPages(router, { projects, sessions, now }) {
  router.add('GET', '/static/*', serveStatic('static'), { auth: false });
  router.add('GET', '/vendor/diff2html/*', serveStatic('vendor'), { auth: false });

  router.add(
    'GET',
    '/invite/:token',
    ({ res, params }) => {
      const redeemed = projects.redeemInvite(params.token, now());
      const project = redeemed && projects.get(redeemed.projectId);
      if (!redeemed || !project) {
        sendHtml(res, 410, messagePage('This invite link is no longer valid.'));
        return;
      }
      res.setHeader('Set-Cookie', sessionCookie(sessions.create(redeemed.email, now())));
      redirect(res, `/${project.slug}`);
    },
    { auth: false, only: 'public' },
  );

  router.add(
    'GET',
    '/login',
    (ctx) => {
      if (ctx.viewer) redirect(ctx.res, '/');
      else if (ctx.listener.kind === 'admin') unauthenticatedPage(ctx);
      else sendHtml(ctx.res, 200, shell({ title: 'Sign in · LiveReview' }));
    },
    { auth: false, page: true },
  );

  const page = { page: true };
  /** @param {RouteContext} ctx */
  const projectPage = ({ res, params }) => {
    const { slug, sha } = params;
    const validSlug = SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
    if (!validSlug || (sha !== undefined && !SHA_RE.test(sha))) sendHtml(res, 404, messagePage(NOT_FOUND_HTML));
    else sendHtml(res, 200, shell({ title: 'LiveReview' }));
  };
  router.add('GET', '/', ({ res }) => sendHtml(res, 200, shell({ title: 'LiveReview' })), page);
  router.add('GET', '/:slug', projectPage, page);
  router.add('GET', '/:slug/live', projectPage, page);
  router.add('GET', '/:slug/commits', projectPage, page);
  router.add('GET', '/:slug/commit/:sha', projectPage, page);
}
