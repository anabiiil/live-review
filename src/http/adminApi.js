import { normalizeEmail } from '../db.js';
import { isConfigured, saveConfig } from '../config.js';
import { RepoError } from '../git/repo.js';
import { isHidden } from '../privacy/hidden.js';
import { previewProject } from '../projects/preview.js';
import { StoreError } from '../projects/store.js';
import { inviteEmail } from '../auth/email.js';
import { OWNER_COOKIE } from './guards.js';
import { unauthenticatedPage, adminShell } from './pages.js';
import { HttpError, redirect, sendHtml, sendJson } from './router.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('./router.js').RouteContext} RouteContext */

const HOST_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const TUNNEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const MAX_EMAIL = 254;
const MAX_OWNER_NAME = 60;
const MAX_FROM_NAME = 60;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const INBOX_LIMIT = 200;
const REPO_REASONS = new Set(['not-a-repo', 'not-root', 'forbidden']);
const CONFIG_KEYS = new Set(['publicHost', 'resendApiKey', 'fromEmail', 'ownerName', 'ownerEmail', 'tunnelName', 'publicPort', 'adminPort']);

const notFound = () => new HttpError(404, 'not-found');
const invalid = (/** @type {string} */ message) => new HttpError(400, 'invalid', message);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} v
 * @returns {number}
 */
function positiveId(v) {
  const n = Number(v);
  if (!/^[1-9]\d{0,15}$/.test(String(v)) || !Number.isSafeInteger(n)) throw notFound();
  return n;
}

/**
 * Same rule as the project store: an array of non-empty basename globs without "/".
 * @param {unknown} v
 * @returns {string[]}
 */
function checkExtraHidden(v) {
  if (!Array.isArray(v) || !v.every((g) => typeof g === 'string' && g.trim() !== '' && !g.includes('/'))) {
    throw new StoreError('invalid-extra-hidden', 'extraHidden must be an array of non-empty basename globs without "/"');
  }
  return v.map((g) => g.trim());
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {string}
 */
function checkEmail(v, field) {
  const e = typeof v === 'string' ? normalizeEmail(v) : '';
  if (e.length > MAX_EMAIL || !EMAIL_RE.test(e)) throw invalid(`${field} must be an email address`);
  return e;
}

/**
 * The sender address: a bare address, or `Display Name <addr@domain>` (name of 1-60 printable characters
 * without `<`, `>`, `"` or line breaks). Stored trimmed, as given.
 * @param {unknown} v
 * @returns {string}
 */
function checkFrom(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  const bad = () => invalid('fromEmail must be an email address, or "Display Name <address>"');
  if (s === '' || s.length > MAX_EMAIL + MAX_FROM_NAME + 4 || CONTROL_RE.test(s)) throw bad();
  const m = /^([^<>"]*)<([^<>\s]+)>$/.exec(s);
  if (!m) {
    if (s.length > MAX_EMAIL || !EMAIL_RE.test(s)) throw bad();
    return s;
  }
  const name = m[1].trim();
  if (name.length < 1 || name.length > MAX_FROM_NAME || m[2].length > MAX_EMAIL || !EMAIL_RE.test(m[2])) throw bad();
  return s;
}

/**
 * @param {unknown} v
 * @param {string} field
 * @returns {number}
 */
function checkPort(v, field) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1024 || v > 65535) throw invalid(`${field} must be an integer from 1024 to 65535`);
  return v;
}

/**
 * Validate a partial config update. Returns only the keys to change (resendApiKey is left out when it is to be kept).
 * @param {unknown} body
 * @param {Config} current
 * @returns {Partial<Config>}
 */
function validateConfigPatch(body, current) {
  if (!isObject(body)) throw invalid('expected a JSON object');
  for (const key of Object.keys(body)) if (!CONFIG_KEYS.has(key)) throw invalid(`unknown setting: ${key}`);
  /** @type {Partial<Config>} */
  const patch = {};
  if ('publicHost' in body) {
    const host = typeof body.publicHost === 'string' ? body.publicHost.trim().toLowerCase() : '';
    if (!HOST_RE.test(host)) throw invalid('publicHost must be a hostname such as review.example.com');
    patch.publicHost = host;
  }
  if ('fromEmail' in body) patch.fromEmail = checkFrom(body.fromEmail);
  if ('ownerEmail' in body) patch.ownerEmail = checkEmail(body.ownerEmail, 'ownerEmail');
  if ('ownerName' in body) {
    const name = typeof body.ownerName === 'string' ? body.ownerName.trim() : '';
    if (name.length < 1 || name.length > MAX_OWNER_NAME) throw invalid(`ownerName must be 1-${MAX_OWNER_NAME} characters`);
    patch.ownerName = name;
  }
  if ('tunnelName' in body) {
    const t = body.tunnelName;
    if (t !== '' && !(typeof t === 'string' && TUNNEL_RE.test(t))) throw invalid('tunnelName may only contain letters, digits, ".", "_" and "-" (max 64)');
    patch.tunnelName = t;
  }
  if ('publicPort' in body) patch.publicPort = checkPort(body.publicPort, 'publicPort');
  if ('adminPort' in body) patch.adminPort = checkPort(body.adminPort, 'adminPort');
  if (('publicPort' in patch || 'adminPort' in patch) && (patch.publicPort ?? current.publicPort) === (patch.adminPort ?? current.adminPort)) {
    throw invalid('publicPort and adminPort must be different');
  }
  if ('resendApiKey' in body) {
    const k = body.resendApiKey;
    if (k === null) patch.resendApiKey = '';
    else if (typeof k === 'string') {
      if (k.trim() !== '') patch.resendApiKey = k.trim();
    } else throw invalid('resendApiKey must be a string or null');
  }
  return patch;
}

/**
 * Config as sent to the browser: the API key never leaves the server.
 * @param {Config} cfg
 */
function redactConfig(cfg) {
  const { resendApiKey, ...rest } = cfg;
  return { ...rest, hasResendKey: resendApiKey !== '', configured: isConfigured(cfg) };
}

/**
 * Wrap an admin handler so store and repository problems become 400 responses with stable codes.
 * @param {(ctx:RouteContext)=>unknown|Promise<unknown>} fn
 * @returns {(ctx:RouteContext)=>Promise<void>}
 */
const guarded = (fn) => async (ctx) => {
  try {
    await fn(ctx);
  } catch (err) {
    if (err instanceof StoreError && err.code !== 'not-found') {
      sendJson(ctx.res, 400, { error: err.code, message: err.message });
    } else if (err instanceof RepoError && REPO_REASONS.has(err.reason)) {
      sendJson(ctx.res, 400, { error: 'invalid-repo', reason: err.reason });
    } else {
      throw err;
    }
  }
};

/**
 * Register the owner-only admin API and page. Only ever answers on the admin listener.
 * @param {ReturnType<typeof import('./router.js').createRouter>} router
 * @param {{config:Config, db:import('node:sqlite').DatabaseSync, now:()=>number,
 *   emailSender:{send:(m:{to:string, subject:string, text:string})=>Promise<unknown>},
 *   projects:ReturnType<typeof import('../projects/store.js').createProjectStore>,
 *   comments:ReturnType<typeof import('../comments/store.js').createCommentStore>,
 *   sessions:ReturnType<typeof import('../auth/sessions.js').createSessionService>,
 *   owner:ReturnType<typeof import('../auth/sessions.js').createOwnerAuth>,
 *   events:import('node:events').EventEmitter, onConfigChange:()=>void,
 *   boundPorts:()=>{publicPort:number, adminPort:number}}} deps
 */
export function registerAdminApi(router, { config, db, now, emailSender, projects, comments, sessions, owner, events, onConfigChange, boundPorts }) {
  const memberRows = db.prepare(
    `SELECT m.email AS email, u.name AS name, m.invited_at AS invitedAt
     FROM members m LEFT JOIN users u ON u.email = m.email WHERE m.project_id = ? ORDER BY m.email`,
  );
  const hasMembership = db.prepare('SELECT 1 AS x FROM members WHERE email = ? LIMIT 1');

  /** @type {{only:'admin'}} */
  const admin = { only: 'admin' };

  /** @param {string} rawId */
  const projectFor = (rawId) => {
    const p = projects.get(positiveId(rawId));
    if (!p) throw notFound();
    return p;
  };

  /** @param {import('../projects/store.js').Project} p */
  const projectView = (p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    path: p.path,
    extraHidden: p.extraHidden,
    createdAt: p.createdAt,
    open: comments.openCounts(p.id).total,
    members: memberRows.all(p.id).map((r) => ({ email: String(r.email), name: r.name === null ? null : String(r.name), invitedAt: Number(r.invitedAt) })),
  });

  /**
   * Revoke the reviewer's sessions if they belong to no project any more, and tell the live hub.
   * @param {number} projectId
   * @param {string} email already normalized
   */
  const afterMemberLeft = (projectId, email) => {
    if (hasMembership.get(email) === undefined) sessions.revokeAllFor(email);
    events.emit('member-removed', { projectId, email });
  };

  /**
   * Issue a fresh single-use invite and email it. A failed email never fails the request.
   * @param {import('../projects/store.js').Project} project
   * @param {unknown} rawEmail
   */
  async function inviteMember(project, rawEmail) {
    if (!config.publicHost) throw new HttpError(409, 'not-configured');
    const token = projects.createInvite(project.id, typeof rawEmail === 'string' ? rawEmail : '', now());
    const email = normalizeEmail(/** @type {string} */ (rawEmail));
    const inviteLink = `https://${config.publicHost}/invite/${token}`;
    try {
      const mail = inviteEmail({ projectName: project.name, link: inviteLink, ownerName: config.ownerName || 'The owner' });
      const r = /** @type {{ok?:boolean, error?:string}|undefined} */ (await emailSender.send({ to: email, ...mail }));
      if (r?.ok === false) return { inviteLink, emailSent: false, emailError: r.error ?? 'email failed' };
      return { inviteLink, emailSent: true };
    } catch (err) {
      return { inviteLink, emailSent: false, emailError: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- sign-in and page --------------------------------------------------------------------

  router.add(
    'GET',
    '/admin',
    (ctx) => {
      const token = ctx.query.get('t');
      if (token !== null) {
        const session = owner.exchange(token, now());
        if (!session) {
          unauthenticatedPage(ctx);
          return;
        }
        ctx.res.setHeader('Set-Cookie', `${OWNER_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`);
        redirect(ctx.res, '/admin');
        return;
      }
      if (!ctx.viewer) unauthenticatedPage(ctx);
      else sendHtml(ctx.res, 200, adminShell({ title: 'LiveReview Admin' }));
    },
    { auth: false, page: true, ...admin },
  );

  // ---- config ------------------------------------------------------------------------------

  router.add('GET', '/api/admin/config', ({ res }) => sendJson(res, 200, redactConfig(config)), admin);

  router.add(
    'PUT',
    '/api/admin/config',
    ({ res, body }) => {
      const patch = validateConfigPatch(body, config);
      // Compared with the ports actually bound, not the configured ones (a pending change may already be saved).
      const bound = boundPorts();
      const restartRequired =
        (patch.publicPort !== undefined && patch.publicPort !== bound.publicPort) ||
        (patch.adminPort !== undefined && patch.adminPort !== bound.adminPort);
      if (Object.keys(patch).length > 0) {
        saveConfig(patch);
        Object.assign(config, patch);
        onConfigChange();
      }
      sendJson(res, 200, { config: redactConfig(config), restartRequired });
    },
    admin,
  );

  // ---- projects ----------------------------------------------------------------------------

  router.add(
    'POST',
    '/api/admin/projects/preview',
    guarded(async ({ res, body }) => {
      const extraHidden = body?.extraHidden === undefined ? [] : checkExtraHidden(body.extraHidden);
      sendJson(res, 200, await previewProject(body?.path, extraHidden));
    }),
    admin,
  );

  router.add(
    'POST',
    '/api/admin/projects',
    guarded(async ({ res, body }) => {
      const p = await projects.add({ path: body?.path, name: body?.name, slug: body?.slug });
      sendJson(res, 201, projectView(p));
    }),
    admin,
  );

  router.add('GET', '/api/admin/projects', ({ res }) => sendJson(res, 200, projects.list().map(projectView)), admin);

  router.add(
    'PATCH',
    '/api/admin/projects/:id',
    guarded(({ res, params, body }) => {
      const before = projectFor(params.id);
      if (!isObject(body)) throw invalid('expected a JSON object');
      for (const key of Object.keys(body)) if (!['name', 'slug', 'extraHidden'].includes(key)) throw invalid(`unknown field: ${key}`);
      const { name, slug, extraHidden } = body;
      const updated = projects.update(before.id, { name, slug, extraHidden });
      // Idempotent, so it runs whenever the list is sent: a wipe cut short earlier is completed now.
      if (extraHidden !== undefined) {
        comments.wipeHidden(updated.id, (path) => isHidden(path, updated.extraHidden));
        events.emit('project-changed', { projectId: updated.id });
      }
      sendJson(res, 200, projectView(updated));
    }),
    admin,
  );

  router.add(
    'DELETE',
    '/api/admin/projects/:id',
    ({ res, params, query }) => {
      const p = projectFor(params.id);
      if (query.get('confirm') !== p.slug) throw new HttpError(400, 'confirm-required');
      const emails = projects.members(p.id);
      projects.remove(p.id);
      for (const email of emails) afterMemberLeft(p.id, email);
      events.emit('project-removed', { projectId: p.id });
      sendJson(res, 200, { ok: true });
    },
    admin,
  );

  // ---- members -----------------------------------------------------------------------------

  router.add(
    'POST',
    '/api/admin/projects/:id/members',
    guarded(async ({ res, params, body }) => {
      sendJson(res, 200, await inviteMember(projectFor(params.id), body?.email));
    }),
    admin,
  );

  router.add(
    'POST',
    '/api/admin/projects/:id/members/:email/invite',
    guarded(async ({ res, params }) => {
      const p = projectFor(params.id);
      if (!projects.isMember(p.id, params.email)) throw notFound();
      sendJson(res, 200, await inviteMember(p, params.email));
    }),
    admin,
  );

  router.add(
    'DELETE',
    '/api/admin/projects/:id/members/:email',
    ({ res, params }) => {
      const p = projectFor(params.id);
      const email = normalizeEmail(params.email);
      if (!projects.isMember(p.id, email)) throw notFound();
      projects.removeMember(p.id, email);
      afterMemberLeft(p.id, email);
      sendJson(res, 200, { ok: true });
    },
    admin,
  );

  // ---- inbox -------------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/admin/inbox',
    ({ res }) => {
      /** @type {Map<number, import('../projects/store.js').Project|null>} */
      const cache = new Map();
      const items = [];
      for (const t of comments.recentOpenThreads(INBOX_LIMIT)) {
        if (!cache.has(t.projectId)) cache.set(t.projectId, projects.get(t.projectId));
        const p = cache.get(t.projectId);
        if (!p) continue;
        // The stored anchor (copied file content) stays server-side.
        const { anchor, replies, ...rest } = t;
        items.push({
          slug: p.slug,
          projectName: p.name,
          target: t.target,
          thread: { ...rest, replies: replies.map(({ anchor: _a, ...r }) => r) },
        });
      }
      sendJson(res, 200, items);
    },
    admin,
  );
}
