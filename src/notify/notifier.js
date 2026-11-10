// Turns comment changes into notifications: stored per recipient, pushed live to their open sockets, and
// emailed (batched per recipient) when email is configured and they have not turned it off.
import { normalizeEmail } from '../db.js';

/** @typedef {import('./notificationStore.js').NotificationKind} NotificationKind */
/** @typedef {import('./notificationStore.js').StoredNotification} StoredNotification */
/** @typedef {import('../comments/store.js').Comment} Comment */
/** @typedef {import('../http/ws.js').CommentChange} CommentChange */
/**
 * A notification as clients see it (live message and listing).
 * @typedef {{id:number, kind:NotificationKind, projectSlug:string, projectName:string, commentId:number,
 *   threadId:number, path:string, line:number|null, target:string, actorName:string, excerpt:string, url:string,
 *   createdAt:number, read:boolean, yours:boolean}} Notification
 * `yours`: the recipient started the thread.
 */
/** @typedef {{notificationId:number, commentId:number}} Queued */
/** @typedef {{n:Notification, rootAuthor:string, body:string}} EmailItem */

const EXCERPT = 140;
const EMAIL_EXCERPT = 500;

/**
 * The notification kind for a comment change; null when it notifies nobody (edits, deletes).
 * @param {{kind:string, resolved?:boolean}} change
 * @returns {NotificationKind|null}
 */
export function notificationKind({ kind, resolved }) {
  if (kind === 'create') return 'comment';
  if (kind === 'reply') return 'reply';
  if (kind === 'resolve') return resolved === false ? 'reopened' : resolved === true ? 'resolved' : null;
  return null;
}

/**
 * @param {string} s
 * @param {number} max
 */
const shorten = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   config: {ownerEmail?:string, ownerName?:string, resendApiKey?:string, fromEmail?:string, publicHost?:string,
 *     ownerEmailNotifications?:boolean},
 *   sender: {send:(m:{to:string, subject:string, text:string})=>Promise<unknown>},
 *   comments: ReturnType<typeof import('../comments/store.js').createCommentStore>,
 *   projects: {get:(id:number)=>{id:number, slug:string, name:string}|null, isMember:(projectId:number, email:string)=>boolean},
 *   store: ReturnType<typeof import('./notificationStore.js').createNotificationStore>,
 *   deliver: {toOwner:(msg:object)=>void, toReviewer:(email:string, msg:object)=>void},
 *   adminPort: () => number,
 *   now?: () => number,
 *   delayMs?: number,
 * }} deps
 */
export function createNotifier({ db, config, sender, comments, projects, store, deliver, adminPort, now = Date.now, delayMs = 60_000 }) {
  const userQ = db.prepare('SELECT name, email_notifications AS on_ FROM users WHERE email = ?');
  const setPrefQ = db.prepare(
    'INSERT INTO users(email, email_notifications) VALUES(?, ?) ON CONFLICT(email) DO UPDATE SET email_notifications = excluded.email_notifications',
  );
  // The reply a stored `reply` notification is about: the actor's latest reply in the thread up to that moment.
  const replyQ = db.prepare(
    'SELECT id FROM comments WHERE parent_id = ? AND author_email = ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1',
  );

  /** @type {Map<string, {owner:boolean, items:Queued[], timer:NodeJS.Timeout}>} */
  const pending = new Map();

  const ownerEmail = () => (config.ownerEmail ? normalizeEmail(config.ownerEmail) : '');
  const emailConfigured = () => Boolean(config.resendApiKey && config.fromEmail);

  /** @param {string} email */
  const userRow = (email) => /** @type {{name:string|null, on_:number}|undefined} */ (userQ.get(email));

  /**
   * Whether this person wants notification emails (owner: config; reviewer: their user row, on by default).
   * @param {string} email
   */
  function wantsEmail(email) {
    if (email === ownerEmail()) return config.ownerEmailNotifications !== false;
    return (userRow(email)?.on_ ?? 1) === 1;
  }

  /** @param {string} email */
  function displayName(email) {
    const name = userRow(email)?.name;
    if (name) return name;
    if (email === ownerEmail() && config.ownerName) return config.ownerName;
    return email;
  }

  /**
   * Shape a stored notification for clients; null when its project or thread is gone.
   * @param {StoredNotification} n
   * @param {number} [commentId] the exact comment (a reply) when known
   * @returns {Notification|null}
   */
  function present(n, commentId) {
    const p = projects.get(n.projectId);
    const root = n.commentId === null ? null : comments.get(n.commentId);
    if (!p || !root) return null;
    let id = commentId;
    if (id === undefined && n.kind === 'reply') {
      const row = /** @type {{id:number}|undefined} */ (replyQ.get(root.id, n.actorEmail, n.createdAt));
      id = row?.id;
    }
    const about = (id !== undefined && id !== root.id && comments.get(id)) || root;
    // Same places as the comments page's "Show in code": rewritten history is read in Changes, and a
    // hidden file has no code to show, so its thread opens on the comments page.
    const url = root.hidden
      ? `/${p.slug}/comments`
      : root.target === 'live' || root.rewritten
        ? `/${p.slug}/live#c-${about.id}`
        : `/${p.slug}/commit/${root.target}#c-${about.id}`;
    return {
      id: n.id,
      kind: n.kind,
      projectSlug: p.slug,
      projectName: p.name,
      commentId: about.id,
      threadId: root.id,
      path: root.path,
      line: root.line,
      target: root.target,
      actorName: displayName(n.actorEmail),
      excerpt: shorten(about.body, EXCERPT),
      url,
      createdAt: n.createdAt,
      read: n.readAt !== null,
      yours: root.authorEmail === n.recipientEmail,
    };
  }

  /**
   * @param {string} to
   * @param {Queued} item
   */
  function queueEmail(to, item) {
    if (!emailConfigured() || !wantsEmail(to)) return;
    const entry = pending.get(to);
    if (entry) {
      entry.items.push(item);
      return;
    }
    const timer = setTimeout(() => void flushOne(to), delayMs);
    timer.unref?.();
    pending.set(to, { owner: to === ownerEmail(), items: [item], timer });
  }

  /** @param {string} to */
  async function flushOne(to) {
    const entry = pending.get(to);
    if (!entry) return;
    pending.delete(to);
    clearTimeout(entry.timer);
    // Settings may have changed while the batch waited.
    if (!emailConfigured() || !wantsEmail(to)) return;
    /** @type {EmailItem[]} */
    const items = [];
    for (const q of entry.items) {
      // The comment it is about (a reply, or the thread itself) was deleted while the batch waited.
      if (!comments.get(q.commentId)) continue;
      const stored = store.get(q.notificationId);
      const n = stored && present(stored, q.commentId);
      const root = n && comments.get(n.threadId);
      const about = n && comments.get(n.commentId);
      if (n && root && about) items.push({ n, rootAuthor: root.authorEmail, body: about.body });
    }
    if (!items.length) return;
    const base = entry.owner ? `http://localhost:${adminPort()}` : `https://${config.publicHost}`;
    const message = compose(items, { to, base, owner: entry.owner });
    try {
      const res = /** @type {{ok?:boolean, error?:string}|undefined} */ (await sender.send({ to, ...message }));
      if (res && res.ok === false) console.error(`LiveReview: notification email not sent: ${res.error}`);
    } catch (err) {
      console.error(`LiveReview: notification email not sent: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function flush() {
    await Promise.all([...pending.keys()].map((to) => flushOne(to)));
  }

  return {
    /**
     * React to a comment change (the `comment-changed` event).
     * @param {CommentChange} change
     */
    handle(change) {
      const kind = notificationKind(change);
      if (!kind) return;
      const c = comments.get(change.commentId);
      if (!c) return;
      const root = c.parentId === null ? c : comments.get(c.parentId);
      if (!root) return;
      const owner = ownerEmail();
      const actor = change.actorEmail ? normalizeEmail(change.actorEmail) : change.byOwner ? owner : c.authorEmail;
      /** @type {Set<string>} */
      const recipients = new Set();
      if (owner) recipients.add(owner);
      // A new top-level comment goes to the owner only; everything else also to the thread's participants
      // who still belong to the project.
      if (kind !== 'comment') {
        for (const e of comments.participants(root.id)) {
          if (e === owner || projects.isMember(root.projectId, e)) recipients.add(e);
        }
      }
      recipients.delete(actor);
      const createdAt = now();
      for (const to of recipients) {
        const stored = store.add({ recipientEmail: to, projectId: root.projectId, commentId: root.id, kind, actorEmail: actor, createdAt });
        const n = present(stored, c.id);
        if (!n) continue;
        const msg = { type: 'notification', notification: n };
        if (to === owner) deliver.toOwner(msg);
        else deliver.toReviewer(to, msg);
        queueEmail(to, { notificationId: stored.id, commentId: c.id });
      }
    },

    /**
     * The viewer's latest notifications and unread count.
     * @param {{kind:'owner'|'reviewer', email:string}} viewer
     * @param {number} [limit]
     * @returns {{items:Notification[], unread:number}}
     */
    list(viewer, limit = 30) {
      const owner = viewer.kind === 'owner';
      const items = /** @type {Notification[]} */ (
        store.list(viewer.email, { limit, owner }).map((n) => present(n)).filter(Boolean)
      );
      return { items, unread: store.unreadCount(viewer.email, { owner }) };
    },

    /**
     * @param {{kind:'owner'|'reviewer', email:string}} viewer
     * @param {{ids?:number[], all?:boolean}} which
     * @returns {number} the unread count afterwards
     */
    markRead(viewer, { ids, all }) {
      store.markRead(viewer.email, { ids, all, now: now() });
      return store.unreadCount(viewer.email, { owner: viewer.kind === 'owner' });
    },

    /** @param {string} email */
    emailPreference: (email) => wantsEmail(normalizeEmail(email)),

    /**
     * A reviewer's email preference (the owner's lives in config).
     * @param {string} email
     * @param {boolean} on
     */
    setReviewerEmailPreference(email, on) {
      setPrefQ.run(normalizeEmail(email), on ? 1 : 0);
    },

    flush,
    close: flush,
  };
}

/**
 * @param {Notification} n
 * @param {string} actor
 * @param {boolean} yours the recipient wrote the thread
 */
function happened(n, actor, yours) {
  if (n.kind === 'comment') return `${actor} commented on ${n.projectName}`;
  if (n.kind === 'reply') return `${actor} replied on ${n.projectName}`;
  if (n.kind === 'resolved') return `${actor} marked ${yours ? 'your' : 'a'} comment resolved in ${n.projectName}`;
  return `${actor} reopened a comment in ${n.projectName}`;
}

/**
 * @param {EmailItem[]} items
 * @param {{to:string, base:string, owner:boolean}} o
 */
function compose(items, { to, base, owner }) {
  const line = (/** @type {EmailItem} */ { n, rootAuthor }) => happened(n, n.actorName, rootAuthor === to);
  const projectNames = new Set(items.map(({ n }) => n.projectName));
  const subject =
    items.length === 1 ? line(items[0]) : `${items.length} updates on ${projectNames.size === 1 ? items[0].n.projectName : 'LiveReview'}`;
  const blocks = items.map((item) => {
    const { n } = item;
    const where = n.line === null ? n.path : `${n.path}:${n.line}`;
    // The email carries a longer excerpt than the live message.
    return [
      `${line(item)} — ${where}`,
      '',
      shorten(item.body, EMAIL_EXCERPT).split('\n').map((l) => `  ${l}`).join('\n'),
      '',
      `Open it${owner ? ' (on this computer)' : ''}: ${base}${n.url}`,
    ].join('\n');
  });
  const why = owner ? 'you own this LiveReview' : 'you take part in this conversation on LiveReview';
  const text = `${blocks.join('\n\n———\n\n')}\n\nYou get this because ${why}. You can turn these emails off from your menu in LiveReview.\n`;
  return { subject, text };
}
