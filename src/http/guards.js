import { normalizeEmail } from '../db.js';

/** @typedef {import('../types.js').Viewer} Viewer */
/** @typedef {import('node:http').IncomingMessage} Req */
/**
 * One of the two listeners. `port` is the actual bound port (filled in after listen).
 * @typedef {{kind:'public'|'admin', port:number, config:import('../config.js').Config,
 *   sessions:ReturnType<typeof import('../auth/sessions.js').createSessionService>,
 *   owner:ReturnType<typeof import('../auth/sessions.js').createOwnerAuth>,
 *   userName:(email:string)=>string|null, now:()=>number}} Listener
 */

export const SESSION_COOKIE = 'lr_session';
export const OWNER_COOKIE = 'lr_owner';
export const SESSION_MAX_AGE = 2592000;

/**
 * Parse a Cookie header. The first occurrence of a name wins; malformed pairs are skipped.
 * @param {string|undefined} header
 * @returns {Record<string,string>}
 */
export function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name === '' || Object.hasOwn(out, name)) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** @param {Req} req */
const hostOf = (req) => String(req.headers.host ?? '').toLowerCase();

/**
 * Public: Host must equal config.publicHost. Admin: `localhost:{port}` or `127.0.0.1:{port}`.
 * @param {Req} req
 * @param {Listener} listener
 */
export function hostAllowed(req, listener) {
  const host = hostOf(req);
  if (host === '') return false;
  if (listener.kind === 'public') return host === String(listener.config.publicHost ?? '').toLowerCase();
  return host === `localhost:${listener.port}` || host === `127.0.0.1:${listener.port}`;
}

/** @param {string|undefined} method */
export const isStateChanging = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(String(method));

/**
 * Origin check for state-changing requests and WebSocket upgrades. Call after hostAllowed.
 * Public: `https://{publicHost}`. Admin: `http://` + the request's (already validated) Host.
 * @param {Req} req
 * @param {Listener} listener
 */
export function originAllowed(req, listener) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  const expected =
    listener.kind === 'public' ? `https://${String(listener.config.publicHost ?? '').toLowerCase()}` : `http://${hostOf(req)}`;
  return origin.toLowerCase() === expected && hostAllowed(req, listener);
}

/**
 * Public listener: the reviewer behind a valid `lr_session`. Admin listener: the owner iff `lr_owner` is a
 * live owner session. Each listener ignores the other's cookie.
 * @param {Req} req
 * @param {Listener} listener
 * @returns {Viewer|null}
 */
export function resolveViewer(req, listener) {
  const cookies = parseCookies(req.headers.cookie);
  if (listener.kind === 'admin') {
    const token = cookies[OWNER_COOKIE];
    if (!token || !listener.owner.isOwnerSession(token)) return null;
    return { kind: 'owner', email: normalizeEmail(listener.config.ownerEmail ?? ''), name: listener.config.ownerName || null };
  }
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = listener.sessions.lookup(token, listener.now());
  if (!session) return null;
  return { kind: 'reviewer', email: session.email, name: listener.userName(session.email) };
}

/** @param {string} token */
export const sessionCookie = (token) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;

export const clearSessionCookie = () => `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
