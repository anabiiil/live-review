import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { normalizeEmail } from '../db.js';

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 60_000;
const MAX_PER_EMAIL = 5;
const MAX_PER_IP = 20;

/** @param {string} s */
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Constant-time equality for two hex digests (always equal length).
 * @param {string} a
 * @param {string} b
 */
function hashesEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Email sign-in codes: 6 digits, 10 minutes, single use, burned after 5 wrong tries, rate limited.
 * `now` arguments are epoch milliseconds.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{isAllowedEmail: (email: string) => boolean}} deps
 */
export function createCodeService(db, { isAllowedEmail }) {
  const countByEmail = db.prepare('SELECT COUNT(*) AS n FROM code_requests WHERE email = ? AND at > ?');
  const countByIp = db.prepare('SELECT COUNT(*) AS n FROM code_requests WHERE ip = ? AND at > ?');
  const pruneRequests = db.prepare('DELETE FROM code_requests WHERE at <= ?');
  const recordRequest = db.prepare('INSERT INTO code_requests(email, ip, at) VALUES(?, ?, ?)');
  const pruneCodes = db.prepare('DELETE FROM login_codes WHERE used = 1 OR attempts >= ? OR expires_at <= ?');
  const retireOld = db.prepare('UPDATE login_codes SET used = 1 WHERE email = ? AND used = 0');
  const insertCode = db.prepare('INSERT INTO login_codes(email, code_hash, expires_at) VALUES(?, ?, ?)');
  const findLive = db.prepare(
    'SELECT id, code_hash FROM login_codes WHERE email = ? AND used = 0 AND attempts < ? AND expires_at > ? ' +
      'ORDER BY id DESC LIMIT 1',
  );
  const markUsed = db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?');
  const addAttempt = db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?');

  return {
    /**
     * Issue a code for a member. `{code: null}` means "not a member" or "rate limited"; callers must treat
     * both identically. Every request is recorded, including refused ones, so limits cannot be probed.
     * @param {string} email
     * @param {string} ip
     * @param {number} [now]
     * @returns {{code: string|null}}
     */
    requestCode(email, ip, now = Date.now()) {
      const e = normalizeEmail(email);
      const addr = String(ip);
      const since = now - WINDOW_MS;
      pruneRequests.run(since);
      pruneCodes.run(MAX_ATTEMPTS, now - WINDOW_MS);

      const limited =
        /** @type {{n:number}} */ (countByEmail.get(e, since)).n >= MAX_PER_EMAIL ||
        /** @type {{n:number}} */ (countByIp.get(addr, since)).n >= MAX_PER_IP;
      recordRequest.run(e, addr, now);
      if (limited || !isAllowedEmail(e)) return { code: null };

      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      db.exec('BEGIN');
      try {
        retireOld.run(e);
        insertCode.run(e, sha256(code), now + CODE_TTL_MS);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return { code };
    },

    /**
     * Check a code. Never throws; any failure is `false`. A wrong or malformed code counts as one attempt
     * against the live code; the fifth wrong attempt burns it.
     * @param {string} email
     * @param {string} code
     * @param {number} [now]
     * @returns {boolean}
     */
    verifyCode(email, code, now = Date.now()) {
      try {
        const e = normalizeEmail(email);
        const live = /** @type {{id:number, code_hash:string}|undefined} */ (findLive.get(e, MAX_ATTEMPTS, now));
        if (!live) return false;
        const candidate = typeof code === 'string' ? code.trim() : '';
        if (/^\d{6}$/.test(candidate) && hashesEqual(sha256(candidate), live.code_hash)) {
          markUsed.run(live.id);
          return true;
        }
        addAttempt.run(live.id);
        return false;
      } catch {
        return false;
      }
    },
  };
}
