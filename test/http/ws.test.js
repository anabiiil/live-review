import '../helpers/quiet-sqlite.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
const QUIET = 400;
const HEARTBEAT = 100;

/** @type {Awaited<ReturnType<typeof setup>>} */
let ctx;
/** @type {string|undefined} */
let previousDataDir;

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-ws-'));
  previousDataDir = process.env.LIVEREVIEW_DATA_DIR;
  process.env.LIVEREVIEW_DATA_DIR = dataDir;
  const db = openDb(join(dataDir, 'livereview.db'));
  const emailSender = { send: async () => ({ ok: true }) };
  const config = {
    publicHost: HOST, resendApiKey: 're_key', fromEmail: 'lr@example.test', ownerName: 'Olivia',
    ownerEmail: OWNER_EMAIL, tunnelName: '', publicPort: 0, adminPort: 0,
  };
  const app = createApp({
    config, db, emailSender, watcherOptions: { debounceMs: 50, graceMs: 100 }, hubOptions: { heartbeatMs: HEARTBEAT },
  });
  const ports = await app.start();
  /** @type {Awaited<ReturnType<typeof makeTmpRepo>>[]} */
  const repos = [];
  /** @type {Client[]} */
  const sockets = [];
  return { dataDir, db, app, ports, repos, sockets, ownerCookie: '' };
}

/**
 * @param {string} path
 * @param {{method?:string, body?:unknown}} [o]
 */
function adm(path, { method = 'GET', body } = {}) {
  const base = `127.0.0.1:${ctx.ports.adminPort}`;
  /** @type {Record<string,string>} */
  const h = { Host: base, Cookie: ctx.ownerCookie };
  if (method !== 'GET') h.Origin = `http://${base}`;
  return request(ctx.ports.adminPort, { method, path, headers: h, body });
}

/**
 * @param {string} path
 * @param {{method?:string, body?:unknown, cookie?:string}} [o]
 */
function pub(path, { method = 'GET', body, cookie } = {}) {
  /** @type {Record<string,string>} */
  const h = { Host: HOST };
  if (method !== 'GET') h.Origin = PUBLIC_ORIGIN;
  if (cookie) h.Cookie = cookie;
  return request(ctx.ports.publicPort, { method, path, headers: h, body });
}

/** A fresh repo with an uncommitted change on line 2 of a.js, registered through the admin API. */
async function newProject(name) {
  const repo = await makeTmpRepo();
  await repo.write('a.js', 'one\ntwo\nthree\n');
  await repo.commit('init');
  await repo.write('a.js', 'one\nTWO\nthree\n');
  ctx.repos.push(repo);
  const res = await adm('/api/admin/projects', { method: 'POST', body: { path: repo.dir, name } });
  assert.equal(res.status, 201, res.body);
  return { repo, project: /** @type {{id:number, slug:string}} */ (res.json()) };
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

/** @typedef {{ws:WebSocket, messages:any[], closed:Promise<number>, send:(m:object)=>void,
 *   waitFor:(pred:(m:any)=>boolean, ms?:number)=>Promise<any>}} Client */

/**
 * Open a WebSocket with full control over Host, Origin and Cookie.
 * @param {'public'|'admin'} kind
 * @param {{cookie?:string, host?:string, origin?:string|null, path?:string}} [o]
 * @returns {Promise<Client>} rejects with the HTTP status when the upgrade is refused
 */
function connect(kind, { cookie, host, origin, path = '/ws' } = {}) {
  const port = kind === 'public' ? ctx.ports.publicPort : ctx.ports.adminPort;
  const defaultHost = kind === 'public' ? HOST : `127.0.0.1:${port}`;
  const h = host ?? defaultHost;
  const o = origin === undefined ? (kind === 'public' ? PUBLIC_ORIGIN : `http://${h}`) : origin;
  /** @type {Record<string,string>} */
  const headers = { Host: h };
  if (o) headers.Origin = o;
  const c = cookie ?? (kind === 'admin' ? ctx.ownerCookie : undefined);
  if (c) headers.Cookie = c;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  /** @type {any[]} */
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  const closed = new Promise((done) => ws.on('close', (code) => done(code)));
  return new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => {
      reject(res.statusCode);
      ws.terminate();
    });
    ws.once('error', () => {});
    ws.once('open', () => {
      /** @type {Client} */
      const client = {
        ws,
        messages,
        closed,
        send: (m) => ws.send(JSON.stringify(m)),
        async waitFor(pred, ms = 3000) {
          const end = Date.now() + ms;
          while (Date.now() < end) {
            const found = messages.find(pred);
            if (found) return found;
            await sleep(20);
          }
          assert.fail(`timed out; got ${JSON.stringify(messages.map((m) => m.type))}`);
        },
      };
      ctx.sockets.push(client);
      resolve(client);
    });
  });
}

/**
 * Subscribe and wait for the first live state.
 * @param {Client} client @param {string} slug
 */
async function subscribe(client, slug) {
  client.send({ type: 'subscribe', slug });
  return client.waitFor((m) => m.type === 'live' && m.slug === slug);
}

before(async () => {
  ctx = await setup();
  const token = ctx.app.services.owner.issueOneTime();
  const base = `127.0.0.1:${ctx.ports.adminPort}`;
  const res = await request(ctx.ports.adminPort, { path: `/admin?t=${token}`, headers: { Host: base } });
  ctx.ownerCookie = `lr_owner=${res.cookies.lr_owner}`;
});

after(async () => {
  for (const s of ctx.sockets) s.ws.terminate();
  await ctx.app.stop();
  ctx.db.close();
  await Promise.all(ctx.repos.map((r) => r.cleanup()));
  await rm(ctx.dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.LIVEREVIEW_DATA_DIR;
  else process.env.LIVEREVIEW_DATA_DIR = previousDataDir;
});

test('upgrade applies the Host, Origin, viewer and path rules of each listener', async () => {
  const { project } = await newProject('Upgrade');
  const cookie = await addAndSignIn(project.id, 'rev-up@example.test');
  const status = (/** @type {Promise<Client>} */ p) => p.then(() => 'open', (code) => code);

  assert.equal(await status(connect('public', { cookie })), 'open');
  assert.equal(await status(connect('admin')), 'open');
  assert.equal(await status(connect('public', { cookie, host: 'evil.example.test' })), 421);
  assert.equal(await status(connect('public', { cookie, origin: 'https://evil.example.test' })), 403);
  assert.equal(await status(connect('public', { cookie, origin: null })), 403);
  assert.equal(await status(connect('public')), 401);
  assert.equal(await status(connect('public', { cookie: 'lr_session=forged' })), 401);
  assert.equal(await status(connect('public', { cookie, path: '/other' })), 404);
  // Each listener only honours its own cookie.
  assert.equal(await status(connect('admin', { cookie })), 401);
  assert.equal(await status(connect('public', { cookie: ctx.ownerCookie })), 401);
  assert.equal(await status(connect('admin', { origin: `http://localhost:${ctx.ports.adminPort}` })), 403);
});

test('subscribe sends the current live state at once; malformed messages are ignored', async () => {
  const { project } = await newProject('Snapshot');
  const owner = await connect('admin');
  owner.ws.send('not json');
  owner.send({ type: 'nope' });
  owner.ws.send('null');
  const live = await subscribe(owner, project.slug);
  assert.equal(live.head.branch, 'main');
  assert.deepEqual(live.files.map((/** @type {any} */ f) => f.path), ['a.js']);
  assert.equal(live.untrackedTruncated, false);
  assert.ok(ctx.app.services.watcherPool.active().includes(project.id));
});

test('subscribing to a project the viewer cannot see is silently ignored and acquires no watcher', async () => {
  const { project: mine } = await newProject('Mine');
  const { project: theirs } = await newProject('Theirs');
  const cookie = await addAndSignIn(mine.id, 'rev-silent@example.test');
  const rev = await connect('public', { cookie });
  rev.send({ type: 'subscribe', slug: theirs.slug });
  rev.send({ type: 'subscribe', slug: 'no-such-project' });
  rev.send({ type: 'subscribe', slug: '../x' });
  rev.send({ type: 'subscribe', slug: 42 });
  await sleep(QUIET);
  assert.deepEqual(rev.messages, []);
  assert.ok(!ctx.app.services.watcherPool.active().includes(theirs.id));
  // The socket still works for a project the reviewer can see.
  await subscribe(rev, mine.slug);
});

test('the owner socket gets notify for comments and replies by reviewers; reviewers never do', async () => {
  const { project } = await newProject('Notify');
  const cookie = await addAndSignIn(project.id, 'rev-n@example.test');
  assert.equal((await pub('/api/me/name', { method: 'POST', body: { name: 'Rita' }, cookie })).status, 200);
  const owner = await connect('admin');
  const rev = await connect('public', { cookie });
  await subscribe(owner, project.slug);
  await subscribe(rev, project.slug);

  const created = await pub(`/api/p/${project.slug}/comments`, {
    method: 'POST', cookie, body: { target: 'live', path: 'a.js', line: 2, side: 'new', body: `Why ${'x'.repeat(200)}` },
  });
  assert.equal(created.status, 201, created.body);
  const id = created.json().id;
  const notify = await owner.waitFor((m) => m.type === 'notify' && m.commentId === id);
  assert.deepEqual(notify, {
    type: 'notify', slug: project.slug, commentId: id, path: 'a.js', line: 2, author: 'Rita',
    excerpt: `Why ${'x'.repeat(136)}`, url: `/${project.slug}/live#c-${id}`,
  });
  await rev.waitFor((m) => m.type === 'comments' && m.target === 'live');

  const reply = await pub(`/api/comments/${id}/replies`, { method: 'POST', cookie, body: { body: 'more' } });
  assert.equal(reply.status, 201);
  await owner.waitFor((m) => m.type === 'notify' && m.commentId === reply.json().id && m.excerpt === 'more');

  // The owner's own comments are not notified.
  const own = await adm(`/api/comments/${id}/replies`, { method: 'POST', body: { body: 'answer' } });
  assert.equal(own.status, 201);
  const edit = await pub(`/api/comments/${id}`, { method: 'PATCH', cookie, body: { body: 'edited' } });
  assert.equal(edit.status, 200);
  await sleep(QUIET);
  assert.equal(owner.messages.filter((m) => m.type === 'notify').length, 2);
  assert.equal(rev.messages.filter((m) => m.type === 'notify').length, 0);
  // Every change is announced as a refetch hint.
  assert.ok(rev.messages.filter((m) => m.type === 'comments' && m.slug === project.slug).length >= 4);
});

test('removing a connected reviewer sends revoked and closes their access', async () => {
  const { project } = await newProject('Revoke');
  const { project: other } = await newProject('Keep');
  const email = 'rev-r@example.test';
  const cookie = await addAndSignIn(project.id, email);
  await addAndSignIn(other.id, email);
  const rev = await connect('public', { cookie });
  await subscribe(rev, project.slug);
  await subscribe(rev, other.slug);

  const del = await adm(`/api/admin/projects/${project.id}/members/${encodeURIComponent(email)}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  await rev.waitFor((m) => m.type === 'revoked' && m.slug === project.slug);
  assert.equal((await pub(`/api/p/${project.slug}/live`, { cookie })).status, 404);
  assert.equal((await pub(`/api/p/${other.slug}/live`, { cookie })).status, 200);

  // Changes to the revoked project no longer reach the socket; the other one still does.
  const before = rev.messages.length;
  await ctx.repos.at(-2)?.write('a.js', 'changed\n');
  await ctx.repos.at(-1)?.write('a.js', 'changed too\n');
  await rev.waitFor((m) => m.type === 'live' && m.slug === other.slug && m.files[0]?.patch.includes('changed too'));
  assert.ok(rev.messages.slice(before).every((m) => m.slug !== project.slug));
  assert.equal(rev.ws.readyState, WebSocket.OPEN);
});

test('a reviewer left with no project has every socket closed', async () => {
  const { project } = await newProject('Last');
  const email = 'rev-last@example.test';
  const cookie = await addAndSignIn(project.id, email);
  const a = await connect('public', { cookie });
  const b = await connect('public', { cookie });
  await subscribe(a, project.slug);
  const del = await adm(`/api/admin/projects/${project.id}/members/${encodeURIComponent(email)}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  await a.waitFor((m) => m.type === 'revoked' && m.slug === project.slug);
  assert.equal(await a.closed, 1008);
  assert.equal(await b.closed, 1008);
  assert.equal((await pub(`/api/p/${project.slug}/live`, { cookie })).status, 401);
});

test('deleting a project revokes every subscription to it, including the owner', async () => {
  const { project } = await newProject('Gone');
  const owner = await connect('admin');
  await subscribe(owner, project.slug);
  const del = await adm(`/api/admin/projects/${project.id}?confirm=${project.slug}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  await owner.waitFor((m) => m.type === 'revoked' && m.slug === project.slug);
});

test('a socket whose session ended (logout; expiry uses the same lookup) is closed with 1008 at the next heartbeat', async () => {
  const { project } = await newProject('Logout');
  const cookie = await addAndSignIn(project.id, 'logout@example.com');
  const ws = await connect('public', { cookie });
  ws.send({ type: 'subscribe', slug: project.slug });
  await ws.waitFor((m) => m.type === 'live');
  const other = await connect('public', { cookie: await addAndSignIn(project.id, 'stays@example.com') });
  assert.equal((await pub('/api/logout', { method: 'POST', cookie })).status, 200);
  assert.equal(await Promise.race([ws.closed, sleep(HEARTBEAT * 10).then(() => 'open')]), 1008);
  await sleep(HEARTBEAT * 3);
  assert.equal(other.ws.readyState, WebSocket.OPEN, 'other sessions are untouched');

  // An owner socket whose owner session is gone is closed too.
  const owner = await connect('admin');
  const isOwnerSession = ctx.app.services.owner.isOwnerSession;
  ctx.app.services.owner.isOwnerSession = () => false;
  try {
    assert.equal(await Promise.race([owner.closed, sleep(HEARTBEAT * 10).then(() => 'open')]), 1008);
  } finally {
    ctx.app.services.owner.isOwnerSession = isOwnerSession;
  }
});

test('unsubscribe and close release the watcher reference', async () => {
  const { project } = await newProject('Release');
  const pool = ctx.app.services.watcherPool;
  const a = await connect('admin');
  await subscribe(a, project.slug);
  a.send({ type: 'unsubscribe', slug: project.slug });
  // graceMs is 100: the watcher closes shortly after its last reference goes.
  const gone = async () => {
    for (let i = 0; i < 100 && pool.active().includes(project.id); i++) await sleep(20);
    return !pool.active().includes(project.id);
  };
  assert.ok(await gone());
  const b = await connect('admin');
  await subscribe(b, project.slug);
  b.ws.close();
  await b.closed;
  assert.ok(await gone());
});
