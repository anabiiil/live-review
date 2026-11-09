import { createHash, randomBytes } from 'node:crypto';
import { normalizeEmail } from '../db.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const ONE_TIME_TTL_MS = 10 * 60_000;

/** @param {string} s */
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

/**
 * Reviewer sessions. Tokens are random, only their SHA-256 is stored. `now` is epoch milliseconds.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createSessionService(db) {
  const insert = db.prepare('INSERT INTO sessions(token_hash, email, expires_at) VALUES(?, ?, ?)');
  const prune = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const find = db.prepare('SELECT email FROM sessions WHERE token_hash = ? AND expires_at > ?');
  const removeOne = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const removeAll = db.prepare('DELETE FROM sessions WHERE email = ?');

  return {
    /**
     * @param {string} email
     * @param {number} [now]
     * @returns {string} the session token (shown once, set as the cookie)
     */
    create(email, now = Date.now()) {
      prune.run(now);
      const token = newToken();
      insert.run(sha256(token), normalizeEmail(email), now + SESSION_TTL_MS);
      return token;
    },

    /**
     * @param {string} token
     * @param {number} [now]
     * @returns {{email: string}|null}
     */
    lookup(token, now = Date.now()) {
      if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
      try {
        const row = /** @type {{email:string}|undefined} */ (find.get(sha256(token), now));
        return row ? { email: row.email } : null;
      } catch {
        return null;
      }
    },

    /** @param {string} token */
    revoke(token) {
      if (typeof token !== 'string') return;
      removeOne.run(sha256(token));
    },

    /** @param {string} email */
    revokeAllFor(email) {
      removeAll.run(normalizeEmail(email));
    },
  };
}

/**
 * Owner authentication for the admin listener. In memory only: a restart signs the owner out.
 * The one-time token is meant to be placed in the URL the CLI opens; it is exchanged once for a session token.
 */
export function createOwnerAuth() {
  /** @type {Map<string, number>} token hash -> expiry */
  const oneTime = new Map();
  /** @type {Set<string>} */
  const sessions = new Set();

  return {
    /** @param {number} [now] @returns {string} */
    issueOneTime(now = Date.now()) {
      for (const [hash, expires] of oneTime) if (expires <= now) oneTime.delete(hash);
      const token = newToken();
      oneTime.set(sha256(token), now + ONE_TIME_TTL_MS);
      return token;
    },

    /**
     * Single use: the token is consumed even if it had expired.
     * @param {string} token
     * @param {number} [now]
     * @returns {string|null} owner session token
     */
    exchange(token, now = Date.now()) {
      if (typeof token !== 'string' || token.length > 256) return null;
      const hash = sha256(token);
      const expires = oneTime.get(hash);
      if (expires === undefined) return null;
      oneTime.delete(hash);
      if (expires <= now) return null;
      const session = newToken();
      sessions.add(sha256(session));
      return session;
    },

    /** @param {string} token */
    isOwnerSession(token) {
      return typeof token === 'string' && token.length <= 256 && sessions.has(sha256(token));
    },
  };
}
