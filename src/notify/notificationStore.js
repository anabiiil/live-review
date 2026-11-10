import { normalizeEmail } from '../db.js';

/** @typedef {'comment'|'reply'|'resolved'|'reopened'} NotificationKind */
/**
 * One stored notification. `commentId` is the thread's top-level comment.
 * @typedef {{id:number, recipientEmail:string, projectId:number, commentId:number|null, kind:NotificationKind,
 *   actorEmail:string, createdAt:number, readAt:number|null}} StoredNotification
 */

/** @param {Record<string, any>} r @returns {StoredNotification} */
const toNotification = (r) => ({
  id: r.id,
  recipientEmail: r.recipient_email,
  projectId: r.project_id,
  commentId: r.comment_id,
  kind: r.kind,
  actorEmail: r.actor_email,
  createdAt: r.created_at,
  readAt: r.read_at,
});

// A reviewer only sees notifications of projects they still belong to; the owner sees all of theirs.
const VISIBLE = `n.recipient_email = ? AND (? = 1 OR EXISTS
  (SELECT 1 FROM members m WHERE m.project_id = n.project_id AND m.email = n.recipient_email))`;

/**
 * Persisted notifications, one row per recipient.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createNotificationStore(db) {
  const q = {
    insert: db.prepare(
      'INSERT INTO notifications(recipient_email, project_id, comment_id, kind, actor_email, created_at) VALUES(?, ?, ?, ?, ?, ?)',
    ),
    get: db.prepare('SELECT * FROM notifications WHERE id = ?'),
    list: db.prepare(`SELECT n.* FROM notifications n WHERE ${VISIBLE} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`),
    unread: db.prepare(`SELECT COUNT(*) AS n FROM notifications n WHERE ${VISIBLE} AND n.read_at IS NULL`),
    readAll: db.prepare('UPDATE notifications SET read_at = ? WHERE recipient_email = ? AND read_at IS NULL'),
    readOne: db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_email = ? AND read_at IS NULL'),
  };

  return {
    /** @param {number} id @returns {StoredNotification|null} */
    get(id) {
      const r = q.get.get(id);
      return r ? toNotification(r) : null;
    },

    /**
     * @param {{recipientEmail:string, projectId:number, commentId:number, kind:NotificationKind, actorEmail:string,
     *   createdAt:number}} n
     * @returns {StoredNotification}
     */
    add({ recipientEmail, projectId, commentId, kind, actorEmail, createdAt }) {
      const r = q.insert.run(normalizeEmail(recipientEmail), projectId, commentId, kind, normalizeEmail(actorEmail), createdAt);
      return toNotification(/** @type {Record<string, any>} */ (q.get.get(Number(r.lastInsertRowid))));
    },

    /**
     * Newest first.
     * @param {string} recipientEmail
     * @param {{limit?:number, owner?:boolean}} [opts] `owner` lifts the membership filter
     * @returns {StoredNotification[]}
     */
    list(recipientEmail, { limit = 30, owner = false } = {}) {
      return q.list.all(normalizeEmail(recipientEmail), owner ? 1 : 0, limit).map(toNotification);
    },

    /**
     * @param {string} recipientEmail
     * @param {{owner?:boolean}} [opts]
     * @returns {number}
     */
    unreadCount(recipientEmail, { owner = false } = {}) {
      return /** @type {{n:number}} */ (q.unread.get(normalizeEmail(recipientEmail), owner ? 1 : 0)).n;
    },

    /**
     * Mark the recipient's notifications read: every one (`all`), or those of `ids` that are theirs.
     * @param {string} recipientEmail
     * @param {{ids?:number[], all?:boolean, now:number}} opts
     */
    markRead(recipientEmail, { ids = [], all = false, now }) {
      const e = normalizeEmail(recipientEmail);
      if (all) {
        q.readAll.run(now, e);
        return;
      }
      for (const id of ids) q.readOne.run(now, id, e);
    },
  };
}
