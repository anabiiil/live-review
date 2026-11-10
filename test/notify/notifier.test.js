import '../helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from '../../src/db.js';
import { createCommentStore } from '../../src/comments/store.js';
import { createNotificationStore } from '../../src/notify/notificationStore.js';
import { createNotifier, notificationKind } from '../../src/notify/notifier.js';

const DELAY = 40;
const OWNER = 'owner@example.test';
const RANA = 'rana@x.test';
const SAM = 'sam@x.test';
const ANCHOR = { lineText: 'return 2;', before: ['a', 'b'], after: ['c'] };
const SHA = 'a'.repeat(40);

/** @param {Record<string, unknown>} [overrides] */
function setup(overrides = {}) {
  const config = {
    ownerEmail: 'Owner@Example.test', ownerName: 'Olivia', resendApiKey: 're_x', fromEmail: 'lr@example.test',
    publicHost: 'review.example.test', ...overrides,
  };
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, slug, name, path, created_at) VALUES(7, 'demo', 'Demo', '/d', 0)").run();
  db.prepare("INSERT INTO projects(id, slug, name, path, created_at) VALUES(8, 'other', 'Other', '/o', 0)").run();
  for (const [p, e] of [[7, RANA], [7, SAM], [8, RANA]]) {
    db.prepare('INSERT INTO members(project_id, email, invited_at) VALUES(?, ?, 0)').run(p, e);
  }
  db.prepare('INSERT INTO users(email, name) VALUES(?, ?)').run(RANA, 'Rana');
  const comments = createCommentStore(db);
  const store = createNotificationStore(db);
  const isMember = db.prepare('SELECT 1 AS x FROM members WHERE project_id = ? AND email = ?');
  const projects = {
    get: (/** @type {number} */ id) => /** @type {any} */ (db.prepare('SELECT id, slug, name FROM projects WHERE id = ?').get(id)) ?? null,
    isMember: (/** @type {number} */ p, /** @type {string} */ e) => isMember.get(p, e) !== undefined,
  };
  /** @type {{to:string, subject:string, text:string}[]} */
  const sent = [];
  /** @type {{to:string, msg:any}[]} */
  const live = [];
  let clock = 1000;
  const notifier = createNotifier({
    db, config, comments, projects, store,
    sender: { send: async (m) => { sent.push(m); return { ok: true }; } },
    deliver: { toOwner: (msg) => live.push({ to: 'owner', msg }), toReviewer: (to, msg) => live.push({ to, msg }) },
    adminPort: () => 4318,
    now: () => ++clock,
    delayMs: DELAY,
  });
  /** @param {string} author @param {object} [over] */
  const top = (author, over = {}) =>
    comments.create({ projectId: 7, target: 'live', path: 'src/app.php', line: 3, side: 'new', anchor: ANCHOR, authorEmail: author, body: 'Why 2 here?', now: ++clock, ...over });
  /** @param {number} parent @param {string} author @param {string} [body] */
  const reply = (parent, author, body = 'Also this') => comments.reply(parent, { authorEmail: author, body, now: ++clock });
  /** @param {any} change */
  const handle = (change) => notifier.handle({ projectId: 7, target: 'live', byOwner: change.actorEmail === OWNER, ...change });
  const recipients = () => live.map((l) => l.to).sort();
  return { db, config, comments, store, notifier, sent, live, top, reply, handle, recipients };
}

test('notificationKind maps comment changes; edits and deletes notify nobody', () => {
  assert.equal(notificationKind({ kind: 'create' }), 'comment');
  assert.equal(notificationKind({ kind: 'reply' }), 'reply');
  assert.equal(notificationKind({ kind: 'resolve', resolved: true }), 'resolved');
  assert.equal(notificationKind({ kind: 'resolve', resolved: false }), 'reopened');
  assert.equal(notificationKind({ kind: 'resolve' }), null);
  assert.equal(notificationKind({ kind: 'edit' }), null);
  assert.equal(notificationKind({ kind: 'delete' }), null);
});

test('a new top-level comment by a reviewer notifies the owner only; by the owner, nobody', () => {
  const t = setup();
  const c = t.top(RANA);
  t.reply(c.id, SAM); // SAM is a participant, but a new top-level comment goes to the owner only
  const c2 = t.top(RANA);
  t.handle({ commentId: c2.id, kind: 'create', actorEmail: RANA });
  assert.deepEqual(t.recipients(), ['owner']);
  const o = t.top(OWNER);
  t.live.length = 0;
  t.handle({ commentId: o.id, kind: 'create', actorEmail: OWNER });
  assert.deepEqual(t.recipients(), []);
});

test('owner resolves a reviewer thread: the reviewer is notified, not the owner', () => {
  const t = setup();
  const c = t.top(RANA);
  t.handle({ commentId: c.id, kind: 'resolve', resolved: true, actorEmail: OWNER });
  assert.deepEqual(t.recipients(), [RANA]);
  const n = t.live[0].msg;
  assert.equal(n.type, 'notification');
  assert.deepEqual(n.notification, {
    id: n.notification.id, kind: 'resolved', projectSlug: 'demo', projectName: 'Demo', commentId: c.id, threadId: c.id,
    path: 'src/app.php', line: 3, target: 'live', actorName: 'Olivia', excerpt: 'Why 2 here?', url: `/demo/live#c-${c.id}`,
    createdAt: n.notification.createdAt, read: false,
  });
  t.live.length = 0;
  t.handle({ commentId: c.id, kind: 'resolve', resolved: false, actorEmail: OWNER });
  assert.equal(t.live[0].msg.notification.kind, 'reopened');
});

test('a reviewer resolves their thread: the owner is notified', () => {
  const t = setup();
  const c = t.top(RANA);
  t.handle({ commentId: c.id, kind: 'resolve', resolved: true, actorEmail: RANA });
  assert.deepEqual(t.recipients(), ['owner']);
  assert.equal(t.live[0].msg.notification.actorName, 'Rana');
});

test('a reply notifies the owner and the other participants, never the actor', () => {
  const t = setup();
  const c = t.top(RANA);
  t.reply(c.id, SAM);
  const r = t.reply(c.id, OWNER, 'Owner says hi');
  t.handle({ commentId: r.id, kind: 'reply', actorEmail: OWNER });
  assert.deepEqual(t.recipients(), [RANA, SAM]);
  const n = t.live[0].msg.notification;
  assert.equal(n.commentId, r.id);
  assert.equal(n.threadId, c.id);
  assert.equal(n.excerpt, 'Owner says hi');
  assert.equal(n.url, `/demo/live#c-${r.id}`);

  t.live.length = 0;
  const r2 = t.reply(c.id, SAM, 'Sam again');
  t.handle({ commentId: r2.id, kind: 'reply', actorEmail: SAM });
  assert.deepEqual(t.recipients(), ['owner', RANA]);
});

test('a participant removed from the project is not notified', () => {
  const t = setup();
  const c = t.top(RANA);
  t.reply(c.id, SAM);
  t.db.prepare('DELETE FROM members WHERE project_id = 7 AND email = ?').run(SAM);
  t.handle({ commentId: c.id, kind: 'resolve', resolved: true, actorEmail: OWNER });
  assert.deepEqual(t.recipients(), [RANA]);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE recipient_email = ?').get(SAM).n, 0);
});

test('edits and deletes notify nobody; an unknown comment is ignored', () => {
  const t = setup();
  const c = t.top(RANA);
  t.handle({ commentId: c.id, kind: 'edit', actorEmail: RANA });
  t.handle({ commentId: c.id, kind: 'delete', actorEmail: RANA });
  t.handle({ commentId: 999, kind: 'reply', actorEmail: RANA });
  assert.deepEqual(t.recipients(), []);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n, 0);
});

test('notifications are persisted; listing, unread count and read marking are per recipient', () => {
  const t = setup();
  const c = t.top(RANA);
  t.handle({ commentId: c.id, kind: 'create', actorEmail: RANA });
  const r = t.reply(c.id, OWNER, 'answer');
  t.handle({ commentId: r.id, kind: 'reply', actorEmail: OWNER });
  t.handle({ commentId: c.id, kind: 'resolve', resolved: true, actorEmail: OWNER });

  const owner = { kind: /** @type {const} */ ('owner'), email: OWNER };
  const rana = { kind: /** @type {const} */ ('reviewer'), email: RANA };
  assert.deepEqual(t.notifier.list(owner).items.map((n) => n.kind), ['comment']);
  const mine = t.notifier.list(rana);
  assert.deepEqual(mine.items.map((n) => n.kind), ['resolved', 'reply'], 'newest first');
  assert.equal(mine.unread, 2);
  // The stored reply notification still points at the reply itself.
  assert.equal(mine.items[1].commentId, r.id);
  assert.equal(mine.items[1].excerpt, 'answer');

  // Someone else's ids are ignored.
  const ownerId = t.notifier.list(owner).items[0].id;
  assert.equal(t.notifier.markRead(rana, { ids: [ownerId] }), 2);
  assert.equal(t.notifier.list(owner).unread, 1);
  assert.equal(t.notifier.markRead(rana, { ids: [mine.items[0].id] }), 1);
  assert.equal(t.notifier.list(rana).items[0].read, true);
  assert.equal(t.notifier.markRead(rana, { all: true }), 0);
  assert.equal(t.notifier.list(owner).unread, 1);

  // A reviewer who left the project no longer sees its notifications.
  t.db.prepare('DELETE FROM members WHERE project_id = 7 AND email = ?').run(RANA);
  assert.deepEqual(t.notifier.list(rana), { items: [], unread: 0 });
});

test('one notification → one email to that recipient after the delay, with text and link', async () => {
  const t = setup();
  const c = t.top(RANA);
  t.handle({ commentId: c.id, kind: 'create', actorEmail: RANA });
  assert.equal(t.sent.length, 0, 'waits for the batching delay');
  await sleep(DELAY * 3);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].to, OWNER);
  assert.equal(t.sent[0].subject, 'Rana commented on Demo');
  assert.match(t.sent[0].text, /src\/app\.php:3/);
  assert.match(t.sent[0].text, /Why 2 here\?/);
  assert.match(t.sent[0].text, new RegExp(`http://localhost:4318/demo/live#c-${c.id}`));
});

test('subjects for replies, resolves and reopens; reviewer links use the public host', async () => {
  const t = setup();
  const c = t.top(RANA);
  t.handle({ commentId: c.id, kind: 'resolve', resolved: true, actorEmail: OWNER });
  await t.notifier.flush();
  assert.equal(t.sent[0].to, RANA);
  assert.equal(t.sent[0].subject, 'Olivia marked your comment resolved in Demo');
  assert.match(t.sent[0].text, new RegExp(`https://review\\.example\\.test/demo/live#c-${c.id}`));
  t.handle({ commentId: c.id, kind: 'resolve', resolved: false, actorEmail: OWNER });
  await t.notifier.flush();
  assert.equal(t.sent[1].subject, 'Olivia reopened a comment in Demo');
  const r = t.reply(c.id, OWNER);
  t.handle({ commentId: r.id, kind: 'reply', actorEmail: OWNER });
  await t.notifier.flush();
  assert.equal(t.sent[2].subject, 'Olivia replied on Demo');
  t.handle({ commentId: c.id, kind: 'resolve', resolved: true, actorEmail: RANA });
  await t.notifier.flush();
  assert.equal(t.sent[3].to, OWNER);
  assert.equal(t.sent[3].subject, 'Rana marked a comment resolved in Demo', 'the owner did not write this thread');
});

test('emails are batched per recipient; several → a digest', async () => {
  const t = setup();
  const c = t.top(RANA);
  const r = t.reply(c.id, SAM);
  t.handle({ commentId: r.id, kind: 'reply', actorEmail: SAM }); // owner + Rana
  const c3 = t.top(RANA, { target: SHA, path: 'b.js', line: 9, body: 'x'.repeat(900) });
  t.handle({ commentId: c3.id, kind: 'create', actorEmail: RANA }); // owner
  const c4 = t.top(RANA, { projectId: 8 });
  t.handle({ commentId: c4.id, projectId: 8, kind: 'create', actorEmail: RANA }); // owner, other project
  await sleep(DELAY * 3);
  const to = (/** @type {string} */ e) => t.sent.filter((m) => m.to === e);
  assert.equal(t.sent.length, 2);
  assert.equal(to(RANA).length, 1);
  assert.equal(to(RANA)[0].subject, 'sam@x.test replied on Demo');
  assert.equal(to(OWNER).length, 1);
  assert.equal(to(OWNER)[0].subject, '3 updates on LiveReview');
  assert.match(to(OWNER)[0].text, new RegExp(`/demo/commit/a{40}#c-${c3.id}`));
  assert.ok(!to(OWNER)[0].text.includes('x'.repeat(600)), 'long bodies are shortened');
  assert.ok(to(OWNER)[0].text.includes('x'.repeat(500)));
});

test('a digest within one project names it', async () => {
  const t = setup();
  t.handle({ commentId: t.top(RANA).id, kind: 'create', actorEmail: RANA });
  t.handle({ commentId: t.top(SAM).id, kind: 'create', actorEmail: SAM });
  await t.notifier.flush();
  assert.equal(t.sent[0].subject, '2 updates on Demo');
});

test('no email when email is not configured or the recipient turned it off (live delivery still happens)', async () => {
  for (const over of [{ resendApiKey: '' }, { fromEmail: '' }, { ownerEmailNotifications: false }]) {
    const t = setup(over);
    t.handle({ commentId: t.top(RANA).id, kind: 'create', actorEmail: RANA });
    await sleep(DELAY * 3);
    assert.equal(t.sent.length, 0, JSON.stringify(over));
    assert.deepEqual(t.recipients(), ['owner']);
  }
  const t = setup();
  t.notifier.setReviewerEmailPreference(RANA, false);
  assert.equal(t.notifier.emailPreference(RANA), false);
  assert.equal(t.notifier.emailPreference(SAM), true, 'on by default');
  t.handle({ commentId: t.top(RANA).id, kind: 'resolve', resolved: true, actorEmail: OWNER });
  await t.notifier.flush();
  assert.equal(t.sent.length, 0);
  assert.deepEqual(t.recipients(), [RANA]);
});

test('turning email off while a batch waits cancels it', async () => {
  const t = setup();
  t.handle({ commentId: t.top(RANA).id, kind: 'create', actorEmail: RANA });
  t.config.ownerEmailNotifications = false;
  await sleep(DELAY * 3);
  assert.equal(t.sent.length, 0);
});

test('a comment deleted before the email goes out is skipped', async () => {
  const t = setup();
  const c = t.top(RANA);
  t.handle({ commentId: c.id, kind: 'create', actorEmail: RANA });
  t.comments.delete(c.id, { kind: 'owner', email: OWNER, name: null });
  await sleep(DELAY * 3);
  assert.equal(t.sent.length, 0);
});

test('close() sends what is pending right away', async () => {
  const t = setup();
  t.handle({ commentId: t.top(RANA).id, kind: 'create', actorEmail: RANA });
  await t.notifier.close();
  assert.equal(t.sent.length, 1);
});

test('a send failure is logged, never thrown', async () => {
  /** @type {string[]} */
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects(id, slug, name, path, created_at) VALUES(7, 'demo', 'Demo', '/d', 0)").run();
    const comments = createCommentStore(db);
    const notifier = createNotifier({
      db, comments, store: createNotificationStore(db),
      config: { ownerEmail: 'o@x.test', resendApiKey: 'k', fromEmail: 'f@x.test' },
      sender: { send: async () => ({ ok: false, error: 'Resend 403: nope' }) },
      projects: { get: () => ({ id: 7, slug: 'demo', name: 'Demo' }), isMember: () => true },
      deliver: { toOwner: () => {}, toReviewer: () => {} },
      adminPort: () => 4318,
      delayMs: DELAY,
    });
    const c = comments.create({ projectId: 7, target: 'live', path: 'a', line: 1, side: 'new', anchor: ANCHOR, authorEmail: 'r@x.test', body: 'b' });
    notifier.handle({ projectId: 7, target: 'live', commentId: c.id, kind: 'create', byOwner: false, actorEmail: 'r@x.test' });
    await notifier.close();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Resend 403/);
  } finally {
    console.error = orig;
  }
});
