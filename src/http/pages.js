import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_SLUGS, SLUG_RE } from '../projects/store.js';
import { SHA_RE } from '../git/repo.js';
import { redirect, sendHtml, sendJson } from './router.js';
import { sessionCookie } from './guards.js';

/** @typedef {ReturnType<typeof import('./router.js').createRouter>} Router */
/** @typedef {import('./router.js').RouteContext} RouteContext */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STATIC_DIRS = {
  static: resolve(ROOT, 'public'),
  vendor: resolve(ROOT, 'node_modules', 'diff2html', 'bundles'),
};
/** Self-hosted fonts: `/vendor/fonts/{package}/{file}.woff2` → `node_modules/@fontsource/{package}/files/`. */
const FONT_DIRS = new Map(
  ['ibm-plex-sans', 'ibm-plex-sans-arabic', 'ibm-plex-mono'].map((pkg) => [pkg, resolve(ROOT, 'node_modules', '@fontsource', pkg, 'files')]),
);
const FONT_FILE = /^[a-z0-9-]+\.woff2$/;

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const NOT_FOUND_HTML = 'Not found.';
const ADMIN_UNAUTHORIZED = 'Open LiveReview from the link printed in your terminal.';

const BASE_CSS = ['/static/css/tokens.css', '/static/css/base.css', '/static/css/shell.css'];
const APP_CSS = [...BASE_CSS, '/static/css/diff.css', '/static/css/comments-page.css', '/static/css/notifications.css'];
/** @param {string[]} hrefs */
const links = (hrefs) => hrefs.map((href) => `<link rel="stylesheet" href="${href}">`).join('\n');

/** The product mark as static markup (pages without scripts). */
const MARK_SVG =
  '<svg class="icon icon-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M15 3v18"/><rect x="15" y="8" width="6" height="5" class="mark-tab"/></svg>';
const BRAND_HTML = `<p class="brand big">${MARK_SVG}<span>LiveReview</span></p>`;

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
${links(APP_CSS)}
<script type="module" src="/static/app.js"></script>
</head>
<body>
<div id="app"></div>
</body>
</html>
`;
}

/**
 * The owner's admin page shell (admin listener only). No inline scripts (CSP).
 * @param {{title:string}} p
 * @returns {string}
 */
export function adminShell({ title }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${links(APP_CSS)}
<link rel="stylesheet" href="/static/css/admin.css">
<script type="module" src="/static/admin.js"></script>
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
${links(BASE_CSS)}
</head>
<body class="static-page">
<main class="static-main">
${BRAND_HTML}
<div class="card static-card">
<p>${escapeHtml(message)}</p>
</div>
</main>
</body>
</html>
`;
}

/**
 * The page an invite link opens: a button that redeems it (no scripts).
 * @param {string} projectName
 * @param {string} token
 * @returns {string}
 */
export function invitePage(projectName, token) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join ${escapeHtml(projectName)} · LiveReview</title>
${links(BASE_CSS)}
</head>
<body class="static-page">
<main class="static-main">
${BRAND_HTML}
<div class="card static-card">
<p class="muted">You've been invited to review</p>
<h1 dir="auto">${escapeHtml(projectName)}</h1>
<p class="muted">Read its live changes and commits, and comment on any line. Continue to open the project.</p>
<form method="post" action="/invite/${encodeURIComponent(token)}">
<button class="btn primary big" type="submit">Continue</button>
</form>
</div>
</main>
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
 * A woff2 file of one of the font packages. Fonts change only with the package version, so browsers may keep them.
 * @param {RouteContext} ctx
 */
async function serveFont({ res, params }) {
  const dir = FONT_DIRS.get(params.pkg);
  const name = params.file;
  const file = dir && FONT_FILE.test(name) ? await resolveStatic(dir, name) : null;
  if (!file) {
    sendJson(res, 404, { error: 'not-found' });
    return;
  }
  const data = await readFile(file);
  res.writeHead(200, { 'Content-Type': 'font/woff2', 'Content-Length': data.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
  res.end(data);
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
  router.add('GET', '/vendor/fonts/:pkg/:file', serveFont, { auth: false });

  const INVITE_GONE = 'This invite link is no longer valid.';
  // Opening the link only shows a page: link previewers and mail scanners fetch it too, and must not use up
  // the single-use token. The invite is redeemed by the page's form, a POST that passes the Origin check.
  router.add(
    'GET',
    '/invite/:token',
    ({ res, params }) => {
      const invite = projects.peekInvite(params.token, now());
      const project = invite && projects.get(invite.projectId);
      if (!invite || !project) sendHtml(res, 410, messagePage(INVITE_GONE));
      else sendHtml(res, 200, invitePage(project.name, params.token));
    },
    { auth: false, only: 'public' },
  );

  router.add(
    'POST',
    '/invite/:token',
    ({ res, params }) => {
      const redeemed = projects.redeemInvite(params.token, now());
      const project = redeemed && projects.get(redeemed.projectId);
      if (!redeemed || !project) {
        sendHtml(res, 410, messagePage(INVITE_GONE));
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
  router.add('GET', '/:slug/comments', projectPage, page);
  router.add('GET', '/:slug/commit/:sha', projectPage, page);
}
