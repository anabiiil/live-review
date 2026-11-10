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
import { createPipeline } from '../../src/live/pipeline.js';
import { createProjectStore } from '../../src/projects/store.js';
import { createCommentStore } from '../../src/comments/store.js';
import { makeAnchor } from '../../src/comments/anchor.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';
import { request } from '../helpers/http.js';

const HOST = 'review.example.test';
const PUBLIC_ORIGIN = `https://${HOST}`;
const LIVE_MS = 2000;

/** @type {Awaited<ReturnType<typeof setup>>} */
let ctx;
/** @type {string|undefined} */
let previousDataDir;

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-live-'));
  previousDataDir = process.env.LIVEREVIEW_DATA_DIR;
  process.env.LIVEREVIEW_DATA_DIR = dataDir;
  const db = openDb(join(dataDir, 'livereview.db'));
  const config = {
    publicHost: HOST, resendApiKey: 're_key', fromEmail: 'lr@example.test', ownerName: 'Olivia',
    ownerEmail: 'owner@example.test', tunnelName: '', publicPort: 0, adminPort: 0,
  };
  const app = createApp({ config, db, emailSender: { send: async () => ({ ok: true }) }, watcherOptions: { debounceMs: 50, graceMs: 100 } });
  const ports = await app.start();
  /** @type {Awaited<ReturnType<typeof makeTmpRepo>>[]} */
  const repos = [];
  /** @type {WebSocket[]} */
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
 * @param {{method?:string, body?:unknown, cookie:string}} o
 */
function pub(path, { method = 'GET', body, cookie }) {
  /** @type {Record<string,string>} */
  const h = { Host: HOST, Cookie: cookie };
  if (method !== 'GET') h.Origin = PUBLIC_ORIGIN;
  return request(ctx.ports.publicPort, { method, path, headers: h, body });
}

/** A repo with a.js committed and line 2 changed in the working tree, registered through the admin API. */
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
  const redeem = await request(ctx.ports.publicPort, { method: 'POST', path: `/invite/${link.slice(link.lastIndexOf('/') + 1)}`, headers: { Host: HOST, Origin: PUBLIC_ORIGIN } });
  assert.equal(redeem.status, 302);
  return `lr_session=${redeem.cookies.lr_session}`;
}

/**
 * A reviewer socket on the public listener that records every message.
 * @param {string} cookie
 */
async function connect(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${ctx.ports.publicPort}/ws`, { headers: { Host: HOST, Origin: PUBLIC_ORIGIN, Cookie: cookie } });
  ctx.sockets.push(ws);
  /** @type {any[]} */
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    messages,
    /** @param {object} m */
    send: (m) => ws.send(JSON.stringify(m)),
    /**
     * @param {(m:any)=>boolean} pred
     * @param {number} [ms]
     */
    async waitFor(pred, ms = 3000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const found = messages.find(pred);
        if (found) return found;
        await sleep(10);
      }
      assert.fail(`timed out; got ${JSON.stringify(messages.map((m) => `${m.type}:${m.slug}`))}`);
    },
    /** Forget what was received so far. */
    clear: () => messages.splice(0),
  };
}

before(async () => {
  ctx = await setup();
  const token = ctx.app.services.owner.issueOneTime();
  const base = `127.0.0.1:${ctx.ports.adminPort}`;
  const res = await request(ctx.ports.adminPort, { path: `/admin?t=${token}`, headers: { Host: base } });
  ctx.ownerCookie = `lr_owner=${res.cookies.lr_owner}`;
});

after(async () => {
  for (const ws of ctx.sockets) ws.terminate();
  await ctx.app.stop();
  ctx.db.close();
  await Promise.all(ctx.repos.map((r) => r.cleanup()));
  await rm(ctx.dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.LIVEREVIEW_DATA_DIR;
  else process.env.LIVEREVIEW_DATA_DIR = previousDataDir;
});

test('a subscribed reviewer gets the new live state within 2 s of a file write', async () => {
  const { repo, project } = await newProject('Live');
  const cookie = await addAndSignIn(project.id, 'rev-live@example.test');
  const rev = await connect(cookie);
  rev.send({ type: 'subscribe', slug: project.slug });
  await rev.waitFor((m) => m.type === 'live');
  rev.clear();
  const started = Date.now();
  await repo.write('b.js', 'brand new\n');
  const live = await rev.waitFor((m) => m.type === 'live' && m.files.some((/** @type {any} */ f) => f.path === 'b.js'), LIVE_MS);
  assert.ok(Date.now() - started <= LIVE_MS);
  assert.deepEqual(Object.keys(live).sort(), ['files', 'head', 'slug', 'type', 'untrackedTruncated']);
  assert.equal(live.slug, project.slug);
  await rev.waitFor((m) => m.type === 'comments' && m.target === 'live');
});

test('a commit moves a live comment onto the commit and clients are told to refetch', async () => {
  const { repo, project } = await newProject('Commit');
  const cookie = await addAndSignIn(project.id, 'rev-commit@example.test');
  const rev = await connect(cookie);
  rev.send({ type: 'subscribe', slug: project.slug });
  await rev.waitFor((m) => m.type === 'live');
  const created = await pub(`/api/p/${project.slug}/comments`, {
    method: 'POST', cookie, body: { target: 'live', path: 'a.js', line: 2, side: 'new', body: 'Shouting?' },
  });
  assert.equal(created.status, 201, created.body);

  const sha = await repo.commit('second');
  await rev.waitFor((m) => m.type === 'comments' && m.target === sha);
  await rev.waitFor((m) => m.type === 'live' && m.head.sha === sha);
  const onCommit = (await pub(`/api/p/${project.slug}/comments?target=${sha}`, { cookie })).json();
  assert.deepEqual(onCommit.threads.map((/** @type {any} */ t) => [t.id, t.line, t.outdated]), [[created.json().id, 2, false]]);
  const live = (await pub(`/api/p/${project.slug}/comments?target=live`, { cookie })).json();
  assert.deepEqual([live.threads, live.outdated], [[], []]);

  // Rewriting that commit flags its comments and announces the change.
  rev.clear();
  await repo.git('commit', '-q', '--amend', '-m', 'second, amended');
  await rev.waitFor((m) => m.type === 'comments' && m.target === sha);
  const after = (await pub(`/api/p/${project.slug}/comments?target=live`, { cookie })).json();
  assert.deepEqual(after.rewritten.map((/** @type {any} */ t) => t.id), [created.json().id]);
});

test('changing extraHidden recomputes the live state at once', async () => {
  const { project } = await newProject('Hide');
  const cookie = await addAndSignIn(project.id, 'rev-hide@example.test');
  const rev = await connect(cookie);
  rev.send({ type: 'subscribe', slug: project.slug });
  await rev.waitFor((m) => m.type === 'live');
  rev.clear();
  const res = await adm(`/api/admin/projects/${project.id}`, { method: 'PATCH', body: { extraHidden: ['a.js'] } });
  assert.equal(res.status, 200, res.body);
  const live = await rev.waitFor((m) => m.type === 'live');
  assert.equal(live.files[0].hidden, true);
});

test('a deleted project folder broadcasts an error; other projects keep updating', async () => {
  const { repo: doomed, project: broken } = await newProject('Doomed');
  const { repo: fine, project: ok } = await newProject('Fine');
  const email = 'rev-del@example.test';
  const cookie = await addAndSignIn(broken.id, email);
  await addAndSignIn(ok.id, email);
  const rev = await connect(cookie);
  rev.send({ type: 'subscribe', slug: broken.slug });
  rev.send({ type: 'subscribe', slug: ok.slug });
  await rev.waitFor((m) => m.type === 'live' && m.slug === broken.slug);
  await rev.waitFor((m) => m.type === 'live' && m.slug === ok.slug);

  await doomed.cleanup();
  const error = await rev.waitFor((m) => m.type === 'error');
  assert.deepEqual(error, { type: 'error', slug: broken.slug, error: 'project-unavailable' });

  await fine.write('later.js', 'still here\n');
  await rev.waitFor((m) => m.type === 'live' && m.slug === ok.slug && m.files.some((/** @type {any} */ f) => f.path === 'later.js'), LIVE_MS);
});

test('pipeline: concurrent recomputes coalesce into one follow-up run; the first run never attaches', async () => {
  const db = openDb(':memory:');
  const repo = await makeTmpRepo();
  try {
    await repo.write('a.js', 'one\ntwo\nthree\n');
    const first = await repo.commit('init');
    await repo.write('a.js', 'one\nTWO\nthree\n');
    const projects = createProjectStore(db);
    const comments = createCommentStore(db);
    const p = await projects.add({ path: repo.dir, name: 'Unit' });
    /** @type {{projectId:number, msg:any}[]} */
    const sent = [];
    const pipeline = createPipeline({ projects, comments, hub: { broadcast: (projectId, msg) => sent.push({ projectId, msg }) } });

    const live = () => sent.filter((s) => s.msg.type === 'live').length;
    await Promise.all([1, 2, 3, 4, 5].map(() => pipeline.recompute(p.id)));
    assert.equal(live(), 1, 'the follow-up run found the same state and did not rebroadcast it');
    assert.equal((await pipeline.snapshot(p.id))?.type, 'live');
    assert.equal(live(), 1, 'snapshot reuses the last result');
    assert.equal((await pipeline.snapshot(p.id, { refresh: true }))?.type, 'live');
    assert.equal(live(), 1, 'an unchanged state is not broadcast again');
    await repo.write('b.js', 'new\n');
    await pipeline.recompute(p.id);
    assert.equal(live(), 2, 'a changed state is broadcast');
    assert.equal(sent.filter((s) => s.msg.type === 'comments' && s.msg.target === 'live').length, 2);

    // A commit made before the pipeline ever saw this project is not attached: the comment is outdated instead.
    const lines = ['one', 'TWO', 'three', ''];
    const c = comments.create({ projectId: p.id, target: 'live', path: 'a.js', line: 2, side: 'new', anchor: makeAnchor(lines, 2), authorEmail: 'r@example.test', body: 'x' });
    const fresh = createPipeline({ projects, comments, hub: { broadcast: () => {} } });
    const second = await repo.commit('second');
    assert.notEqual(second, first);
    await fresh.recompute(p.id);
    assert.deepEqual([comments.get(c.id)?.target, comments.get(c.id)?.outdated], ['live', true]);

    // Errors never escape and unknown projects are ignored.
    await pipeline.recompute(9999);
    assert.equal(await pipeline.snapshot(9999), null);
    await pipeline.close();
  } finally {
    db.close();
    await repo.cleanup();
  }
});
