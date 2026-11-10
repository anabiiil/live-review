import '../helpers/quiet-sqlite.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { openDb } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';
import { request } from '../helpers/http.js';

const HOST = 'review.example.test';
const PUBLIC_ORIGIN = `https://${HOST}`;
const OWNER_EMAIL = 'owner@example.test';
const DELAY = 60;

/** @type {any} */
let ctx;
/** @type {string|undefined} */
let previousDataDir;

before(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-notify-'));
  previousDataDir = process.env.LIVEREVIEW_DATA_DIR;
  process.env.LIVEREVIEW_DATA_DIR = dataDir;
  const db = openDb(join(dataDir, 'livereview.db'));
  /** @type {{to:string, subject:string, text:string}[]} */
  const sent = [];
  const config = {
    publicHost: HOST, resendApiKey: 're_key', fromEmail: 'lr@example.test', ownerName: 'Olivia',
    ownerEmail: OWNER_EMAIL, tunnelName: '', publicPort: 0, adminPort: 0, ownerEmailNotifications: true,
  };
  const app = createApp({
    config, db, notifyDelayMs: DELAY, watcherOptions: { debounceMs: 50, graceMs: 100 },
    emailSender: { send: async (m) => { sent.push(m); return { ok: true }; } },
  });
  const ports = await app.start();
  ctx = { dataDir, db, app, ports, sent, config, repos: [], sockets: [], ownerCookie: '' };
  const base = `127.0.0.1:${ports.adminPort}`;
  const res = await request(ports.adminPort, { path: `/admin?t=${app.services.owner.issueOneTime()}`, headers: { Host: base } });
  ctx.ownerCookie = `lr_owner=${res.cookies.lr_owner}`;
});

after(async () => {
  for (const s of ctx.sockets) s.terminate();
  await ctx.app.stop();
  ctx.db.close();
  await Promise.all(ctx.repos.map((/** @type {any} */ r) => r.cleanup()));
  await rm(ctx.dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.LIVEREVIEW_DATA_DIR;
  else process.env.LIVEREVIEW_DATA_DIR = previousDataDir;
});

/** @param {string} path @param {{method?:string, body?:unknown}} [o] */
function adm(path, { method = 'GET', body } = {}) {
  const base = `127.0.0.1:${ctx.ports.adminPort}`;
  /** @type {Record<string,string>} */
  const h = { Host: base, Cookie: ctx.ownerCookie };
  if (method !== 'GET') h.Origin = `http://${base}`;
  return request(ctx.ports.adminPort, { method, path, headers: h, body });
}

/** @param {string} path @param {{method?:string, body?:unknown, cookie?:string}} [o] */
function pub(path, { method = 'GET', body, cookie } = {}) {
  /** @type {Record<string,string>} */
  const h = { Host: HOST };
  if (method !== 'GET') h.Origin = PUBLIC_ORIGIN;
  if (cookie) h.Cookie = cookie;
  return request(ctx.ports.publicPort, { method, path, headers: h, body });
}

/** @param {string} name */
async function newProject(name) {
  const repo = await makeTmpRepo();
  await repo.write('a.js', 'one\ntwo\nthree\n');
  await repo.commit('init');
  await repo.write('a.js', 'one\nTWO\nthree\n');
  ctx.repos.push(repo);
  const res = await adm('/api/admin/projects', { method: 'POST', body: { path: repo.dir, name } });
  assert.equal(res.status, 201, res.body);
  return /** @type {{id:number, slug:string, name:string}} */ (res.json());
}

/** @param {number} projectId @param {string} email */
async function addAndSignIn(projectId, email) {
  const res = await adm(`/api/admin/projects/${projectId}/members`, { method: 'POST', body: { email } });
  assert.equal(res.status, 200, res.body);
  const link = res.json().inviteLink;
  const redeem = await pub(`/invite/${link.slice(link.lastIndexOf('/') + 1)}`, { method: 'POST' });
  assert.equal(redeem.status, 302);
  return `lr_session=${redeem.cookies.lr_session}`;
}

/**
 * @param {'public'|'admin'} kind
 * @param {string} cookie
 */
function connect(kind, cookie) {
  const port = kind === 'public' ? ctx.ports.publicPort : ctx.ports.adminPort;
  const host = kind === 'public' ? HOST : `127.0.0.1:${port}`;
  const origin = kind === 'public' ? PUBLIC_ORIGIN : `http://${host}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Host: host, Origin: origin, Cookie: cookie } });
  /** @type {any[]} */
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  ctx.sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, messages, notes: () => messages.filter((m) => m.type === 'notification').map((m) => m.notification) }));
  });
}

/** @param {string} slug @param {(o:{method?:string, body?:unknown})=>Promise<any>} as @param {number} [line] */
async function comment(slug, as, line = 2) {
  const res = await as({ method: 'POST', body: { target: 'live', path: 'a.js', line, side: 'new', body: `note on ${line}` } });
  assert.equal(res.status, 201, res.body);
  return res.json();
}

test('resolve notifications both ways reach the right sockets only; v1 notify still goes to the owner', async () => {
  const p = await newProject('Both Ways');
  const rana = await addAndSignIn(p.id, 'rana@example.test');
  const sam = await addAndSignIn(p.id, 'sam@example.test');
  const ownerWs = await connect('admin', ctx.ownerCookie);
  const ranaWs = await connect('public', rana);
  const samWs = await connect('public', sam);

  const c = await comment(p.slug, (o) => pub(`/api/p/${p.slug}/comments`, { ...o, cookie: rana }));
  await sleep(150);
  assert.deepEqual(ownerWs.notes().map((/** @type {any} */ n) => n.kind), ['comment']);
  assert.ok(ownerWs.messages.some((/** @type {any} */ m) => m.type === 'notify' && m.commentId === c.id), 'v1 notify kept for now');
  assert.equal(ranaWs.notes().length, 0);
  assert.equal(samWs.notes().length, 0);

  // Owner resolves Rana's thread: Rana is told, the owner is not.
  const res = await adm(`/api/comments/${c.id}`, { method: 'PATCH', body: { resolved: true } });
  assert.equal(res.status, 200, res.body);
  await sleep(150);
  const got = ranaWs.notes();
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'resolved');
  assert.equal(got[0].actorName, 'Olivia');
  assert.equal(got[0].projectSlug, p.slug);
  assert.equal(got[0].url, `/${p.slug}/live#c-${c.id}`);
  assert.equal(ownerWs.notes().length, 1);
  assert.equal(samWs.notes().length, 0, 'not a participant');

  // Resolving again changes nothing and notifies nobody.
  await adm(`/api/comments/${c.id}`, { method: 'PATCH', body: { resolved: true } });
  // Rana reopens: the owner is told.
  await pub(`/api/comments/${c.id}`, { method: 'PATCH', body: { resolved: false }, cookie: rana });
  await sleep(150);
  assert.deepEqual(ranaWs.notes().map((/** @type {any} */ n) => n.kind), ['resolved']);
  assert.deepEqual(ownerWs.notes().map((/** @type {any} */ n) => n.kind), ['comment', 'reopened']);

  // Sam replies: owner and Rana are told, Sam is not.
  const r = await pub(`/api/comments/${c.id}/replies`, { method: 'POST', body: { body: 'me too' }, cookie: sam });
  assert.equal(r.status, 201, r.body);
  await sleep(150);
  assert.equal(ranaWs.notes().at(-1).kind, 'reply');
  assert.equal(ranaWs.notes().at(-1).commentId, r.json().id);
  assert.equal(ownerWs.notes().at(-1).kind, 'reply');
  assert.equal(samWs.notes().length, 0);
});

test('notification APIs: list, unread, read marking, on both listeners', async () => {
  const p = await newProject('Inbox');
  const rana = await addAndSignIn(p.id, 'rana2@example.test');
  const c = await comment(p.slug, (o) => pub(`/api/p/${p.slug}/comments`, { ...o, cookie: rana }));
  await adm(`/api/comments/${c.id}/replies`, { method: 'POST', body: { body: 'owner answer' } });
  await adm(`/api/comments/${c.id}`, { method: 'PATCH', body: { resolved: true } });

  const mine = (await pub('/api/notifications', { cookie: rana })).json();
  assert.deepEqual(mine.items.map((/** @type {any} */ n) => n.kind), ['resolved', 'reply']);
  assert.equal(mine.unread, 2);
  assert.equal((await pub('/api/notifications?limit=1', { cookie: rana })).json().items.length, 1);
  assert.equal((await pub('/api/notifications')).status, 401);

  const owner = (await adm('/api/notifications?limit=100')).json();
  assert.ok(owner.items.some((/** @type {any} */ n) => n.kind === 'comment' && n.threadId === c.id));
  assert.ok(owner.unread >= 1);

  let r = await pub('/api/notifications/read', { method: 'POST', body: { ids: [mine.items[0].id, owner.items[0].id] }, cookie: rana });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(r.json(), { unread: 1 });
  assert.equal((await adm('/api/notifications?limit=100')).json().unread, owner.unread, "another person's ids are ignored");
  r = await pub('/api/notifications/read', { method: 'POST', body: { all: true }, cookie: rana });
  assert.deepEqual(r.json(), { unread: 0 });
  for (const body of [{}, { ids: 'x' }, { ids: [0] }, { all: 'yes' }, { ids: [1.5] }]) {
    assert.equal((await pub('/api/notifications/read', { method: 'POST', body, cookie: rana })).status, 400, JSON.stringify(body));
  }
  r = await adm('/api/notifications/read', { method: 'POST', body: { all: true } });
  assert.deepEqual(r.json(), { unread: 0 });
});

test('email preferences: /api/me shows them, PUT /api/me/prefs stores them (reviewer: user row; owner: config)', async () => {
  const p = await newProject('Prefs');
  const rana = await addAndSignIn(p.id, 'rana3@example.test');
  assert.deepEqual((await pub('/api/me', { cookie: rana })).json(), {
    email: 'rana3@example.test', name: null, kind: 'reviewer', emailNotifications: true,
  });
  let r = await pub('/api/me/prefs', { method: 'PUT', body: { emailNotifications: false }, cookie: rana });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json().emailNotifications, false);
  assert.equal((await pub('/api/me', { cookie: rana })).json().emailNotifications, false);
  assert.equal((await pub('/api/me/prefs', { method: 'PUT', body: { emailNotifications: 'no' }, cookie: rana })).status, 400);

  // Rana opted out: the owner's reply reaches her live but not by email.
  ctx.sent.length = 0;
  const c = await comment(p.slug, (o) => pub(`/api/p/${p.slug}/comments`, { ...o, cookie: rana }));
  await adm(`/api/comments/${c.id}/replies`, { method: 'POST', body: { body: 'hello' } });
  await sleep(DELAY * 4);
  assert.deepEqual(ctx.sent.map((/** @type {any} */ m) => m.to), [OWNER_EMAIL]);

  assert.equal((await adm('/api/me')).json().emailNotifications, true);
  r = await adm('/api/me/prefs', { method: 'PUT', body: { emailNotifications: false } });
  assert.equal(r.status, 200, r.body);
  assert.equal((await adm('/api/me')).json().emailNotifications, false);
  const saved = JSON.parse(await readFile(join(ctx.dataDir, 'config.json'), 'utf8'));
  assert.equal(saved.ownerEmailNotifications, false);
  ctx.sent.length = 0;
  await comment(p.slug, (o) => pub(`/api/p/${p.slug}/comments`, { ...o, cookie: rana }), 1);
  await sleep(DELAY * 4);
  assert.equal(ctx.sent.length, 0);
  await adm('/api/me/prefs', { method: 'PUT', body: { emailNotifications: true } });
});

test('a reviewer comment emails the owner through the app (batched); owner comments do not', async () => {
  const p = await newProject('Mail');
  const rana = await addAndSignIn(p.id, 'rana4@example.test');
  ctx.sent.length = 0;
  await pub('/api/me/name', { method: 'POST', body: { name: 'Rana' }, cookie: rana });
  await comment(p.slug, (o) => pub(`/api/p/${p.slug}/comments`, { ...o, cookie: rana }));
  await comment(p.slug, (o) => adm(`/api/p/${p.slug}/comments`, o), 1);
  await sleep(DELAY * 4);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].to, OWNER_EMAIL);
  assert.equal(ctx.sent[0].subject, 'Rana commented on Mail');
  assert.match(ctx.sent[0].text, /a\.js:2/);
  assert.match(ctx.sent[0].text, new RegExp(`http://localhost:${ctx.ports.adminPort}/${p.slug}/live#c-`));
  assert.ok(!ctx.sent[0].text.includes('note on 1'));
});

test('threads listing: status filters, location, snippet, hidden → null, access control', async () => {
  const p = await newProject('Threads');
  const other = await newProject('Threads Other');
  const rana = await addAndSignIn(p.id, 'rana5@example.test');
  const outsider = await addAndSignIn(other.id, 'out@example.test');
  const a = await comment(p.slug, (o) => pub(`/api/p/${p.slug}/comments`, { ...o, cookie: rana }));
  const b = await comment(p.slug, (o) => adm(`/api/p/${p.slug}/comments`, o), 3);
  await pub(`/api/comments/${a.id}/replies`, { method: 'POST', body: { body: 'reply' }, cookie: rana });
  await adm(`/api/comments/${b.id}`, { method: 'PATCH', body: { resolved: true } });
  // c is on a file that becomes hidden afterwards.
  const c = await comment(p.slug, (o) => adm(`/api/p/${p.slug}/comments`, o), 1);
  ctx.db.prepare('UPDATE comments SET anchor = NULL, hidden = 1 WHERE id = ? OR parent_id = ?').run(c.id, c.id);

  const all = (await pub(`/api/p/${p.slug}/threads?status=all`, { cookie: rana })).json();
  assert.deepEqual(all.threads.map((/** @type {any} */ t) => t.id).sort(), [a.id, b.id, c.id].sort());
  const ta = all.threads.find((/** @type {any} */ t) => t.id === a.id);
  assert.deepEqual(ta.location, { target: 'live', path: 'a.js', line: 2, side: 'new' });
  assert.deepEqual(ta.snippet, [
    { no: 1, text: 'one', focus: false },
    { no: 2, text: 'TWO', focus: true },
    { no: 3, text: 'three', focus: false },
  ]);
  assert.equal(ta.replies.length, 1);
  assert.equal(ta.replies[0].body, 'reply');
  assert.ok(!('anchor' in ta) && !('anchor' in ta.replies[0]), 'the stored anchor stays server-side');
  for (const f of ['resolved', 'outdated', 'rewritten', 'hidden']) assert.equal(typeof ta[f], 'boolean');
  assert.equal(all.threads.find((/** @type {any} */ t) => t.id === c.id).snippet, null);

  const open = (await pub(`/api/p/${p.slug}/threads?status=open`, { cookie: rana })).json();
  assert.deepEqual(open.threads.map((/** @type {any} */ t) => t.id).sort(), [a.id, c.id].sort());
  const def = (await pub(`/api/p/${p.slug}/threads`, { cookie: rana })).json();
  assert.deepEqual(def.threads.map((/** @type {any} */ t) => t.id).sort(), [a.id, c.id].sort(), 'open by default');
  const resolved = (await adm(`/api/p/${p.slug}/threads?status=resolved`)).json();
  assert.deepEqual(resolved.threads.map((/** @type {any} */ t) => t.id), [b.id]);
  assert.equal((await adm(`/api/p/${p.slug}/threads?status=bogus`)).status, 400);

  // No access and unknown are indistinguishable.
  const forbidden = await pub(`/api/p/${p.slug}/threads`, { cookie: outsider });
  const unknown = await pub('/api/p/no-such-project/threads', { cookie: outsider });
  assert.equal(forbidden.status, 404);
  assert.equal(forbidden.body, unknown.body);
  assert.equal((await pub(`/api/p/${p.slug}/threads`)).status, 401);

  // Admin listing spans projects and names them; it is not served on the public listener.
  const admin = (await adm('/api/admin/threads?status=all')).json();
  const mineA = admin.threads.find((/** @type {any} */ t) => t.id === a.id);
  assert.equal(mineA.slug, p.slug);
  assert.equal(mineA.projectName, 'Threads');
  assert.deepEqual(mineA.snippet, ta.snippet);
  assert.ok(admin.threads.every((/** @type {any} */ t) => !('anchor' in t)));
  assert.ok((await adm('/api/admin/threads?status=resolved')).json().threads.every((/** @type {any} */ t) => t.resolved));
  assert.equal((await adm('/api/admin/threads?status=nope')).status, 400);
  assert.equal((await pub('/api/admin/threads', { cookie: rana })).status, 404);
});
