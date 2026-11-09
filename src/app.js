import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createProjectStore, StoreError } from './projects/store.js';
import { createCommentStore, ForbiddenError, NotFoundError, ValidationError } from './comments/store.js';
import { createCodeService } from './auth/codes.js';
import { createOwnerAuth, createSessionService } from './auth/sessions.js';
import { createEmailSender } from './auth/email.js';
import { RepoError } from './git/repo.js';
import { HttpError, createRouter, readJsonBody, sendJson } from './http/router.js';
import { hostAllowed, isStateChanging, originAllowed, resolveViewer } from './http/guards.js';
import { registerApi } from './http/api.js';
import { registerAdminApi } from './http/adminApi.js';
import { registerPages, unauthenticatedPage } from './http/pages.js';

/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./http/guards.js').Listener} Listener */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
};

/** @param {string} pathname */
const isAdminPath = (pathname) =>
  pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/api/admin' || pathname.startsWith('/api/admin/');

/**
 * Map an error to a status and JSON body. Unknown errors are logged and never described to the client.
 * @param {unknown} err
 * @returns {[number, Record<string,string>]}
 */
export function errorResponse(err) {
  if (err instanceof HttpError) {
    return [err.status, err.detail === undefined ? { error: err.error } : { error: err.error, message: err.detail }];
  }
  if (err instanceof ValidationError) return [400, { error: 'invalid', message: err.message }];
  if (err instanceof StoreError) {
    return err.code === 'not-found' ? [404, { error: 'not-found' }] : [400, { error: 'invalid', message: err.message }];
  }
  if (err instanceof ForbiddenError) return [403, { error: 'forbidden' }];
  if (err instanceof NotFoundError) return [404, { error: 'not-found' }];
  if (err instanceof RepoError) {
    if (err.reason === 'unknown-commit') return [404, { error: 'not-found' }];
    if (err.reason !== 'missing') console.error(`LiveReview project unavailable: ${err.reason}`);
    return [503, { error: 'project-unavailable' }];
  }
  console.error('LiveReview request failed:', err);
  return [500, { error: 'internal' }];
}

/**
 * Build the HTTP application: a public listener (reviewers, reached through Cloudflare) and an admin
 * listener (the owner), both on 127.0.0.1.
 * @param {{config:Config, db:import('node:sqlite').DatabaseSync, now?:()=>number,
 *   emailSender?:{send:(m:{to:string, subject:string, text:string})=>Promise<unknown>},
 *   fetch?:typeof globalThis.fetch}} opts
 */
export function createApp({ config, db, now = Date.now, emailSender, fetch }) {
  const projects = createProjectStore(db);
  const comments = createCommentStore(db);
  const hasMembership = db.prepare('SELECT 1 AS x FROM members WHERE email = ? LIMIT 1');
  const codes = createCodeService(db, { isAllowedEmail: (email) => hasMembership.get(email) !== undefined });
  const sessions = createSessionService(db);
  const owner = createOwnerAuth();
  const buildSender = () => createEmailSender({ apiKey: config.resendApiKey, from: config.fromEmail, fetch });
  let currentSender = emailSender ?? buildSender();
  // Callers hold this wrapper, so a config change can swap the real sender underneath them.
  const sender = { send: (/** @type {{to:string, subject:string, text:string}} */ m) => currentSender.send(m) };
  const events = new EventEmitter();
  const userNameQ = db.prepare('SELECT name FROM users WHERE email = ?');
  /** @param {string} email */
  const userName = (email) => {
    const row = /** @type {{name:string|null}|undefined} */ (userNameQ.get(email));
    return row?.name ?? null;
  };

  /** @type {{projects:typeof projects, comments:typeof comments, codes:typeof codes, sessions:typeof sessions,
   *   owner:typeof owner, pipeline?:unknown, hub?:unknown}} */
  const services = { projects, comments, codes, sessions, owner };

  const router = createRouter();
  registerApi(router, { config, db, now, emailSender: sender, projects, comments, codes, sessions });
  registerAdminApi(router, {
    config, db, now, emailSender: sender, projects, comments, sessions, owner, events,
    onConfigChange: () => {
      if (!emailSender) currentSender = buildSender();
    },
  });
  registerPages(router, { projects, sessions, now });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {Listener} listener
   */
  async function handle(req, res, listener) {
    const started = performance.now();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      const raw = req.url ?? '/';
      if (!raw.startsWith('/')) throw new HttpError(400, 'invalid');
      const q = raw.indexOf('?');
      const pathname = q < 0 ? raw : raw.slice(0, q);
      const query = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));

      if (!hostAllowed(req, listener)) throw new HttpError(421, 'forbidden');
      if (listener.kind === 'public' && isAdminPath(pathname)) throw new HttpError(404, 'not-found');
      const method = String(req.method);
      if (isStateChanging(method) && !originAllowed(req, listener)) throw new HttpError(403, 'forbidden');

      const found = router.match(method, pathname);
      if (!found) throw new HttpError(404, 'not-found');
      if ('methodNotAllowed' in found) throw new HttpError(405, 'method-not-allowed');
      const { route, params } = found;
      if (route.only && route.only !== listener.kind) throw new HttpError(404, 'not-found');

      const viewer = resolveViewer(req, listener);
      const ctx = { req, res, params, query, viewer, listener, started, body: undefined };
      if (route.auth && !viewer) {
        if (route.page) unauthenticatedPage(ctx);
        else sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (isStateChanging(method)) ctx.body = await readJsonBody(req);
      await route.handler(ctx);
    } catch (err) {
      if (res.headersSent) {
        console.error('LiveReview response failed:', err);
        res.destroy();
        return;
      }
      const [status, body] = errorResponse(err);
      if (status === 413) res.setHeader('Connection', 'close');
      sendJson(res, status, body);
    }
  }

  /** @type {Listener} */
  const publicListener = { kind: 'public', port: 0, config, sessions, owner, userName, now };
  /** @type {Listener} */
  const adminListener = { kind: 'admin', port: 0, config, sessions, owner, userName, now };
  const servers = [publicListener, adminListener].map((listener) => ({
    listener,
    server: createServer((req, res) => void handle(req, res, listener)),
  }));

  /**
   * @param {import('node:http').Server} server
   * @param {number} port
   * @returns {Promise<number>}
   */
  const listen = (server, port) =>
    new Promise((resolvePort, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolvePort(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
      });
    });

  return {
    services,
    /** Emits `member-removed` ({projectId, email}) when the owner removes a member (or deletes a project). */
    events,

    /** @returns {Promise<{publicPort:number, adminPort:number}>} */
    async start() {
      const [pub, adm] = servers;
      pub.listener.port = await listen(pub.server, config.publicPort);
      try {
        adm.listener.port = await listen(adm.server, config.adminPort);
      } catch (err) {
        pub.server.close();
        throw err;
      }
      return { publicPort: pub.listener.port, adminPort: adm.listener.port };
    },

    /** @returns {Promise<void>} */
    async stop() {
      await Promise.all(
        servers.map(
          ({ server }) =>
            new Promise((done) => {
              if (!server.listening) return done(undefined);
              server.close(() => done(undefined));
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}
