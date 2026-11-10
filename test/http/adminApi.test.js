import '../helpers/quiet-sqlite.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';
import { request } from '../helpers/http.js';

const HOST = 'review.example.test';
const PUBLIC_ORIGIN = `https://${HOST}`;
const OWNER_EMAIL = 'owner@example.test';

/** @type {Awaited<ReturnType<typeof setup>>} */
let ctx;
/** @type {string|undefined} */
let previousDataDir;

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-admin-'));
  previousDataDir = process.env.LIVEREVIEW_DATA_DIR;
  process.env.LIVEREVIEW_DATA_DIR = dataDir;
  const db = openDb(join(dataDir, 'livereview.db'));
  /** @type {{to:string, subject:string, text:string}[]} */
  const sent = [];
  const mail = { mode: /** @type {'ok'|'fail'|'throw'} */ ('ok') };
  const emailSender = {
    /** @param {{to:string, subject:string, text:string}} m */
    async send(m) {
      if (mail.mode === 'throw') throw new Error('network down');
      if (mail.mode === 'fail') return /** @type {const} */ ({ ok: false, error: 'Resend 500: boom' });
      sent.push(m);
      return /** @type {const} */ ({ ok: true });
    },
  };
  const config = {
    publicHost: HOST, resendApiKey: 're_secret_key', fromEmail: 'lr@example.test', ownerName: 'Olivia',
    ownerEmail: OWNER_EMAIL, tunnelName: '', publicPort: 0, adminPort: 0,
  };
  const app = createApp({ config, db, emailSender });
  const ports = await app.start();
  /** @type {string[]} */
  const removedEvents = [];
  app.events.on('member-removed', (/** @type {{projectId:number, email:string}} */ e) => removedEvents.push(`${e.projectId}:${e.email}`));
  /** @type {Awaited<ReturnType<typeof makeTmpRepo>>[]} */
  const repos = [];
  return { dataDir, db, config, app, ports, sent, mail, removedEvents, repos, ownerCookie: '' };
}

/**
 * @param {string} path
 * @param {{method?:string, body?:unknown, cookie?:string|null, origin?:string|null, host?:string, raw?:string}} [o]
 */
function adm(path, { method = 'GET', body, cookie, origin, host, raw } = {}) {
  const base = `127.0.0.1:${ctx.ports.adminPort}`;
  /** @type {Record<string,string>} */
  const h = { Host: host ?? base };
  const o = origin === undefined ? `http://${base}` : origin;
  if (o && method !== 'GET') h.Origin = o;
  const c = cookie === undefined ? ctx.ownerCookie : cookie;
  if (c) h.Cookie = c;
  return request(ctx.ports.adminPort, { method, path, headers: h, body, raw });
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

/** A fresh repo registered through the admin API. */
async function newProject(name = 'Proj', files = { 'src/a.js': 'one\ntwo\n' }) {
  const repo = await makeTmpRepo();
  for (const [p, c] of Object.entries(files)) await repo.write(p, c);
  await repo.commit('init');
  ctx.repos.push(repo);
  const res = await adm('/api/admin/projects', { method: 'POST', body: { path: repo.dir, name } });
  assert.equal(res.status, 201, res.body);
  return { repo, project: res.json() };
}

/** @param {string} link */
const tokenOf = (link) => link.slice(link.lastIndexOf('/') + 1);

/**
 * Add a member through the API and sign them in via the invite link.
 * @param {number} projectId @param {string} email
 */
async function addAndSignIn(projectId, email) {
  const res = await adm(`/api/admin/projects/${projectId}/members`, { method: 'POST', body: { email } });
  assert.equal(res.status, 200, res.body);
  const redeem = await pub(`/invite/${tokenOf(res.json().inviteLink)}`, { method: 'POST' });
  assert.equal(redeem.status, 302);
  return `lr_session=${redeem.cookies.lr_session}`;
}

before(async () => {
  ctx = await setup();
  const token = ctx.app.services.owner.issueOneTime();
  const res = await adm(`/admin?t=${token}`, { cookie: null });
  ctx.ownerCookie = `lr_owner=${res.cookies.lr_owner}`;
});

after(async () => {
  await ctx.app.stop();
  ctx.db.close();
  await Promise.all(ctx.repos.map((r) => r.cleanup()));
  await rm(ctx.dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.LIVEREVIEW_DATA_DIR;
  else process.env.LIVEREVIEW_DATA_DIR = previousDataDir;
});

test('every admin API requires the owner session', async () => {
  for (const [method, path] of /** @type {const} */ ([
    ['GET', '/api/admin/config'],
    ['PUT', '/api/admin/config'],
    ['POST', '/api/admin/projects/preview'],
    ['POST', '/api/admin/projects'],
    ['GET', '/api/admin/projects'],
    ['PATCH', '/api/admin/projects/1'],
    ['DELETE', '/api/admin/projects/1'],
    ['POST', '/api/admin/projects/1/members'],
    ['POST', '/api/admin/projects/1/members/a@b.co/invite'],
    ['DELETE', '/api/admin/projects/1/members/a@b.co'],
    ['GET', '/api/admin/inbox'],
  ])) {
    const res = await adm(path, { method, cookie: null });
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.deepEqual(res.json(), { error: 'unauthorized' });
  }
  const forged = await adm('/api/admin/config', { cookie: 'lr_owner=forged' });
  assert.equal(forged.status, 401);
});

test('admin routes do not exist on the public listener', async () => {
  for (const path of ['/admin', '/api/admin/config', '/api/admin/projects', '/api/admin/inbox']) {
    const res = await pub(path, { cookie: ctx.ownerCookie });
    assert.equal(res.status, 404, path);
  }
});

test('GET /admin: one-time token is exchanged once, then the cookie opens the admin page', async () => {
  const message = 'Open LiveReview from the link printed in your terminal.';
  const bare = await adm('/admin', { cookie: null });
  assert.equal(bare.status, 401);
  assert.ok(bare.body.includes(message));

  const bad = await adm('/admin?t=nope', { cookie: null });
  assert.equal(bad.status, 401);
  assert.ok(bad.body.includes(message));

  const token = ctx.app.services.owner.issueOneTime();
  const ex = await adm(`/admin?t=${token}`, { cookie: null });
  assert.equal(ex.status, 302);
  assert.equal(ex.headers.location, '/admin');
  const setCookie = String(ex.headers['set-cookie']);
  assert.match(setCookie, /^lr_owner=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.ok(!/secure/i.test(setCookie));

  const again = await adm(`/admin?t=${token}`, { cookie: null });
  assert.equal(again.status, 401);
  assert.equal(again.cookies.lr_owner, undefined);

  const page = await adm('/admin', { cookie: `lr_owner=${ex.cookies.lr_owner}` });
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.ok(page.body.includes('/static/admin.js'));
  assert.match(page.body, /<title>LiveReview Admin<\/title>/);
  assert.ok(page.body.includes('/static/app.css'));

  const script = await adm('/static/admin.js', { cookie: null });
  assert.equal(script.status, 200);
});

test('cross-origin and origin-less state changes are rejected', async () => {
  const evil = await adm('/api/admin/config', { method: 'PUT', body: { ownerName: 'Evil' }, origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  const pubOrigin = await adm('/api/admin/config', { method: 'PUT', body: { ownerName: 'Evil' }, origin: PUBLIC_ORIGIN });
  assert.equal(pubOrigin.status, 403);
  const none = await adm('/api/admin/projects', { method: 'POST', body: {}, origin: null });
  assert.equal(none.status, 403);
  const badHost = await adm('/api/admin/config', { host: 'evil.example' });
  assert.equal(badHost.status, 421);
  assert.equal(ctx.config.ownerName, 'Olivia');
});

test('GET config hides the API key and reports hasResendKey and configured', async () => {
  const res = await adm('/api/admin/config');
  assert.equal(res.status, 200);
  const cfg = res.json();
  assert.equal('resendApiKey' in cfg, false);
  assert.ok(!res.body.includes('re_secret_key'));
  assert.equal(cfg.hasResendKey, true);
  assert.equal(cfg.configured, true);
  assert.equal(cfg.publicHost, HOST);
  assert.equal(cfg.ownerEmail, OWNER_EMAIL);
  assert.equal(cfg.publicPort, 0);
});

test('PUT config validates input', async () => {
  const bad = [
    { publicHost: 'localhost' },
    { publicHost: 'bad host.example.com' },
    { publicHost: 'https://x.example.com' },
    { publicHost: '' },
    { publicHost: 5 },
    { fromEmail: 'nope' },
    { ownerEmail: 'a b@c.d' },
    { ownerName: '   ' },
    { ownerName: 'x'.repeat(61) },
    { tunnelName: 'has space' },
    { tunnelName: 'x'.repeat(65) },
    { publicPort: 80 },
    { adminPort: 70000 },
    { publicPort: 4317.5 },
    { publicPort: '4317' },
    { publicPort: 5000, adminPort: 5000 },
    { resendApiKey: 12 },
    { resendApiKey: true },
    { unknownKey: 1 },
    { hasResendKey: true },
    { fromEmail: null },
    { fromEmail: '<a@b.test>' },
    { fromEmail: 'Name <nope>' },
    { fromEmail: 'Na<me <a@b.test>' },
    { fromEmail: 'Na"me <a@b.test>' },
    { fromEmail: `${'x'.repeat(61)} <a@b.test>` },
    { fromEmail: 'Name\r\nBcc: x@y.test <a@b.test>' },
    { fromEmail: 'Name <a@b.test> trailing' },
  ];
  for (const body of bad) {
    const res = await adm('/api/admin/config', { method: 'PUT', body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.json().error, 'invalid', JSON.stringify(body));
  }
  const notObject = await adm('/api/admin/config', { method: 'PUT', body: [1] });
  assert.equal(notObject.status, 400);
  // Nothing was applied.
  assert.equal(ctx.config.publicHost, HOST);
  assert.equal(ctx.config.ownerName, 'Olivia');
  assert.equal(ctx.config.publicPort, 0);
});

test('PUT config accepts a display name in fromEmail and stores it trimmed as given', async () => {
  for (const from of ['LiveReview <lr@example.test>', 'Olivia Reviews<lr@example.test>', 'lr@example.test']) {
    const res = await adm('/api/admin/config', { method: 'PUT', body: { fromEmail: `  ${from}  ` } });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json().config.fromEmail, from);
    assert.equal(ctx.config.fromEmail, from);
  }
});

test('PUT config applies, normalizes, persists and flags port changes', async () => {
  const res = await adm('/api/admin/config', {
    method: 'PUT',
    body: { fromEmail: ' Lr2@Example.TEST ', ownerName: '  Olivia B  ', tunnelName: 'my-tunnel.1', publicPort: 4400, adminPort: 4401 },
  });
  assert.equal(res.status, 200, res.body);
  const out = res.json();
  assert.equal(out.restartRequired, true);
  assert.equal(out.config.fromEmail, 'Lr2@Example.TEST');
  assert.equal(out.config.ownerName, 'Olivia B');
  assert.equal(out.config.tunnelName, 'my-tunnel.1');
  assert.equal(out.config.publicPort, 4400);
  assert.equal('resendApiKey' in out.config, false);
  assert.equal(out.config.hasResendKey, true);
  assert.equal(ctx.config.fromEmail, 'Lr2@Example.TEST');
  const onDisk = JSON.parse(await readFile(join(ctx.dataDir, 'config.json'), 'utf8'));
  assert.equal(onDisk.ownerName, 'Olivia B');
  assert.equal(onDisk.publicPort, 4400);

  const reset = await adm('/api/admin/config', { method: 'PUT', body: { ownerName: 'Olivia', tunnelName: '', publicPort: 0, adminPort: 0 } });
  // 0 is not a valid port, so this must be refused and leave the state alone.
  assert.equal(reset.status, 400);
  // Put the in-memory ports back so later tests keep their listeners' expectations.
  ctx.config.publicPort = 0;
  ctx.config.adminPort = 0;

  const same = await adm('/api/admin/config', { method: 'PUT', body: { ownerName: 'Olivia', tunnelName: '' } });
  assert.equal(same.status, 200);
  assert.equal(same.json().restartRequired, false);
  assert.equal(ctx.config.tunnelName, '');
  const host = await adm('/api/admin/config', { method: 'PUT', body: { publicHost: 'Review.Example.TEST' } });
  assert.equal(host.status, 200);
  assert.equal(host.json().config.publicHost, HOST);
});

test('PUT config: restartRequired compares with the ports the listeners actually bound', async () => {
  const bound = { publicPort: ctx.ports.publicPort, adminPort: ctx.ports.adminPort };
  try {
    const same = await adm('/api/admin/config', { method: 'PUT', body: bound });
    assert.equal(same.status, 200, same.body);
    assert.equal(same.json().restartRequired, false);
    const moved = await adm('/api/admin/config', { method: 'PUT', body: { publicPort: bound.publicPort === 4400 ? 4401 : 4400 } });
    assert.equal(moved.json().restartRequired, true);
    // Asking for the bound port again needs no restart, although the saved config said otherwise.
    const back = await adm('/api/admin/config', { method: 'PUT', body: { publicPort: bound.publicPort } });
    assert.equal(back.json().restartRequired, false);
  } finally {
    ctx.config.publicPort = 0;
    ctx.config.adminPort = 0;
  }
});

test('PUT config: resendApiKey omitted or empty keeps, null clears, string sets', async () => {
  const get = async () => (await adm('/api/admin/config')).json();
  const put = (/** @type {unknown} */ body) => adm('/api/admin/config', { method: 'PUT', body });

  assert.equal((await put({ ownerName: 'Olivia' })).status, 200);
  assert.equal(ctx.config.resendApiKey, 're_secret_key');
  assert.equal((await put({ resendApiKey: '' })).status, 200);
  assert.equal(ctx.config.resendApiKey, 're_secret_key');
  assert.equal((await put({ resendApiKey: '   ' })).status, 200);
  assert.equal(ctx.config.resendApiKey, 're_secret_key');

  const cleared = await put({ resendApiKey: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json().config.hasResendKey, false);
  assert.equal(cleared.json().config.configured, false);
  assert.equal(ctx.config.resendApiKey, '');
  assert.equal((await get()).hasResendKey, false);

  const set = await put({ resendApiKey: '  re_new_key  ' });
  assert.equal(set.status, 200);
  assert.ok(!set.body.includes('re_new_key'));
  assert.equal(ctx.config.resendApiKey, 're_new_key');
  const onDisk = JSON.parse(await readFile(join(ctx.dataDir, 'config.json'), 'utf8'));
  assert.equal(onDisk.resendApiKey, 're_new_key');
  assert.equal((await get()).configured, true);
  ctx.config.resendApiKey = 're_secret_key';
});

test('PUT config swaps the default email sender immediately', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-admin2-'));
  const db = openDb(join(dataDir, 'livereview.db'));
  /** @type {{url:string, auth:string, from:string}[]} */
  const calls = [];
  const fetch = /** @type {typeof globalThis.fetch} */ (
    /** @param {any} url @param {any} init */
    async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.Authorization, from: JSON.parse(init.body).from });
      return new Response('{}', { status: 200 });
    }
  );
  const config = {
    publicHost: HOST, resendApiKey: '', fromEmail: '', ownerName: 'Olivia', ownerEmail: OWNER_EMAIL,
    tunnelName: '', publicPort: 0, adminPort: 0,
  };
  const app = createApp({ config, db, fetch });
  const ports = await app.start();
  try {
    const base = `127.0.0.1:${ports.adminPort}`;
    const token = app.services.owner.issueOneTime();
    const ex = await request(ports.adminPort, { path: `/admin?t=${token}`, headers: { Host: base } });
    const headers = { Host: base, Origin: `http://${base}`, Cookie: `lr_owner=${ex.cookies.lr_owner}` };
    const proj = app.services.projects;
    const repo = await makeTmpRepo();
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    try {
      const p = await proj.add({ path: repo.dir, name: 'P' });
      const before = await request(ports.adminPort, { method: 'POST', path: `/api/admin/projects/${p.id}/members`, headers, body: { email: 'r@example.com' } });
      assert.equal(before.json().emailSent, false);
      assert.equal(calls.length, 0);

      const put = await request(ports.adminPort, {
        method: 'PUT', path: '/api/admin/config', headers, body: { resendApiKey: 're_live', fromEmail: 'from@example.test' },
      });
      assert.equal(put.status, 200);
      const after = await request(ports.adminPort, { method: 'POST', path: `/api/admin/projects/${p.id}/members`, headers, body: { email: 'r@example.com' } });
      assert.equal(after.json().emailSent, true);
      assert.deepEqual(calls, [{ url: 'https://api.resend.com/emails', auth: 'Bearer re_live', from: 'from@example.test' }]);
    } finally {
      await repo.cleanup();
    }
  } finally {
    await app.stop();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('preview: lists visible and hidden files; refuses home dir and non-repo paths', async () => {
  const { repo } = await newProject('Preview Src', { 'src/a.js': 'x\n', '.env': 'K=1\n', 'notes.txt': 'n\n' });
  const ok = await adm('/api/admin/projects/preview', { method: 'POST', body: { path: repo.dir, extraHidden: ['notes.*'] } });
  assert.equal(ok.status, 200, ok.body);
  const out = ok.json();
  assert.equal(out.root, repo.dir);
  assert.deepEqual(out.visible, ['src/a.js']);
  assert.deepEqual(out.hidden, ['.env', 'notes.txt']);

  const home = await adm('/api/admin/projects/preview', { method: 'POST', body: { path: homedir() } });
  assert.equal(home.status, 400);
  assert.deepEqual(home.json(), { error: 'invalid-repo', reason: 'forbidden' });

  const sub = await adm('/api/admin/projects/preview', { method: 'POST', body: { path: join(repo.dir, 'src') } });
  assert.deepEqual(sub.json(), { error: 'invalid-repo', reason: 'not-root' });
  const missing = await adm('/api/admin/projects/preview', { method: 'POST', body: { path: join(repo.dir, 'nope') } });
  assert.deepEqual(missing.json(), { error: 'invalid-repo', reason: 'not-a-repo' });
  const rel = await adm('/api/admin/projects/preview', { method: 'POST', body: { path: 'relative/dir' } });
  assert.equal(rel.status, 400);
  assert.equal(rel.json().reason, 'not-a-repo');
  const nonString = await adm('/api/admin/projects/preview', { method: 'POST', body: { path: 5 } });
  assert.equal(nonString.status, 400);
  assert.equal(nonString.json().error, 'invalid-repo');

  for (const extraHidden of ['x', [''], ['a/b'], [1]]) {
    const bad = await adm('/api/admin/projects/preview', { method: 'POST', body: { path: repo.dir, extraHidden } });
    assert.equal(bad.status, 400, JSON.stringify(extraHidden));
    assert.equal(bad.json().error, 'invalid-extra-hidden');
  }
});

test('add project: validation errors map to codes; list shows members and open counts', async () => {
  const { repo, project } = await newProject('Alpha Project');
  assert.equal(project.slug, 'alpha-project');
  assert.equal(project.name, 'Alpha Project');
  assert.equal(project.path, repo.dir);

  const dup = await adm('/api/admin/projects', { method: 'POST', body: { path: repo.dir, name: 'Again' } });
  assert.equal(dup.status, 400);
  assert.equal(dup.json().error, 'duplicate-path');
  const other = await makeTmpRepo();
  ctx.repos.push(other);
  await other.write('x.txt', 'x\n');
  await other.commit('init');
  const reserved = await adm('/api/admin/projects', { method: 'POST', body: { path: other.dir, name: 'N', slug: 'admin' } });
  assert.equal(reserved.json().error, 'invalid-slug');
  const taken = await adm('/api/admin/projects', { method: 'POST', body: { path: other.dir, name: 'N', slug: 'alpha-project' } });
  assert.equal(taken.json().error, 'slug-taken');
  const noName = await adm('/api/admin/projects', { method: 'POST', body: { path: other.dir, name: '  ' } });
  assert.equal(noName.json().error, 'invalid-name');
  const notRepo = await adm('/api/admin/projects', { method: 'POST', body: { path: join(other.dir, 'zzz'), name: 'N' } });
  assert.deepEqual(notRepo.json(), { error: 'invalid-repo', reason: 'not-a-repo' });
  const explicit = await adm('/api/admin/projects', { method: 'POST', body: { path: other.dir, name: 'Beta', slug: 'beta-1' } });
  assert.equal(explicit.status, 201);
  assert.equal(explicit.json().slug, 'beta-1');

  await adm(`/api/admin/projects/${project.id}/members`, { method: 'POST', body: { email: 'Zed@Example.com' } });
  ctx.app.services.comments.create({
    projectId: project.id, target: 'live', path: 'src/a.js', line: 1, side: 'new',
    anchor: { lineText: 'one', before: [], after: [] }, authorEmail: 'zed@example.com', body: 'hi',
  });
  ctx.db.prepare("INSERT INTO users(email, name) VALUES('zed@example.com', 'Zed') ON CONFLICT(email) DO UPDATE SET name = 'Zed'").run();

  const list = await adm('/api/admin/projects');
  assert.equal(list.status, 200);
  const alpha = list.json().find((/** @type {{id:number}} */ p) => p.id === project.id);
  assert.equal(alpha.slug, 'alpha-project');
  assert.equal(alpha.open, 1);
  assert.deepEqual(alpha.extraHidden, []);
  assert.equal(typeof alpha.createdAt, 'number');
  assert.equal(alpha.members.length, 1);
  assert.equal(alpha.members[0].email, 'zed@example.com');
  assert.equal(alpha.members[0].name, 'Zed');
  assert.equal(typeof alpha.members[0].invitedAt, 'number');
  const beta = list.json().find((/** @type {{slug:string}} */ p) => p.slug === 'beta-1');
  assert.deepEqual(beta.members, []);
  assert.equal(beta.open, 0);
});

test('add member returns an invite link that redeems on the public listener and emails it', async () => {
  const { project } = await newProject('Invite Me');
  ctx.sent.length = 0;
  const res = await adm(`/api/admin/projects/${project.id}/members`, { method: 'POST', body: { email: ' Rita@Example.com ' } });
  assert.equal(res.status, 200, res.body);
  const out = res.json();
  assert.equal(out.emailSent, true);
  assert.equal('emailError' in out, false);
  assert.match(out.inviteLink, new RegExp(`^https://${HOST}/invite/[A-Za-z0-9_-]{43}$`));
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].to, 'rita@example.com');
  assert.ok(ctx.sent[0].text.includes(out.inviteLink));
  assert.ok(ctx.sent[0].subject.includes('Invite Me'));
  assert.ok(ctx.sent[0].subject.includes('Olivia'));

  const redeem = await pub(`/invite/${tokenOf(out.inviteLink)}`, { method: 'POST' });
  assert.equal(redeem.status, 302);
  assert.equal(redeem.headers.location, '/invite-me');
  const projectsRes = await pub('/api/projects', { cookie: `lr_session=${redeem.cookies.lr_session}` });
  assert.equal(projectsRes.status, 200);
  assert.deepEqual(projectsRes.json().map((/** @type {{slug:string}} */ p) => p.slug), ['invite-me']);
  // Single use.
  assert.equal((await pub(`/invite/${tokenOf(out.inviteLink)}`, { method: 'POST' })).status, 410);

  // Adding the same member again is idempotent (one membership, a fresh link).
  const again = await adm(`/api/admin/projects/${project.id}/members`, { method: 'POST', body: { email: 'rita@example.com' } });
  assert.equal(again.status, 200);
  assert.equal(ctx.app.services.projects.members(project.id).length, 1);
});

test('email failure still returns 200 with a working link', async () => {
  const { project } = await newProject('Mail Fail');
  ctx.mail.mode = 'fail';
  try {
    const res = await adm(`/api/admin/projects/${project.id}/members`, { method: 'POST', body: { email: 'f@example.com' } });
    assert.equal(res.status, 200);
    const out = res.json();
    assert.equal(out.emailSent, false);
    assert.equal(out.emailError, 'Resend 500: boom');
    assert.equal((await pub(`/invite/${tokenOf(out.inviteLink)}`, { method: 'POST' })).status, 302);

    ctx.mail.mode = 'throw';
    const thrown = await adm(`/api/admin/projects/${project.id}/members`, { method: 'POST', body: { email: 'g@example.com' } });
    assert.equal(thrown.status, 200);
    assert.equal(thrown.json().emailSent, false);
    assert.equal(thrown.json().emailError, 'network down');
    assert.equal((await pub(`/invite/${tokenOf(thrown.json().inviteLink)}`, { method: 'POST' })).status, 302);
  } finally {
    ctx.mail.mode = 'ok';
  }
});

test('add member: validation and not-configured', async () => {
  const { project } = await newProject('Member Checks');
  for (const email of ['nope', '', undefined, 5]) {
    const res = await adm(`/api/admin/projects/${project.id}/members`, { method: 'POST', body: { email } });
    assert.equal(res.status, 400, String(email));
    assert.equal(res.json().error, 'invalid-email');
  }
  const saved = ctx.config.publicHost;
  ctx.config.publicHost = '';
  try {
    const res = await adm(`/api/admin/projects/${project.id}/members`, { method: 'POST', body: { email: 'ok@example.com' } });
    assert.equal(res.status, 409);
    assert.equal(res.json().error, 'not-configured');
    assert.deepEqual(ctx.app.services.projects.members(project.id), []);
  } finally {
    ctx.config.publicHost = saved;
  }
});

test('regenerate invalidates the old link, resends the email and needs an existing member', async () => {
  const { project } = await newProject('Regen');
  const first = (await adm(`/api/admin/projects/${project.id}/members`, { method: 'POST', body: { email: 'reg@example.com' } })).json();
  ctx.sent.length = 0;
  const regen = await adm(`/api/admin/projects/${project.id}/members/${encodeURIComponent('Reg@Example.com')}/invite`, { method: 'POST', body: {} });
  assert.equal(regen.status, 200, regen.body);
  const second = regen.json();
  assert.notEqual(second.inviteLink, first.inviteLink);
  assert.equal(second.emailSent, true);
  assert.equal(ctx.sent.length, 1);
  assert.ok(ctx.sent[0].text.includes(second.inviteLink));

  assert.equal((await pub(`/invite/${tokenOf(first.inviteLink)}`, { method: 'POST' })).status, 410);
  assert.equal((await pub(`/invite/${tokenOf(second.inviteLink)}`, { method: 'POST' })).status, 302);

  const stranger = await adm(`/api/admin/projects/${project.id}/members/stranger%40example.com/invite`, { method: 'POST', body: {} });
  assert.equal(stranger.status, 404);
  assert.deepEqual(stranger.json(), { error: 'not-found' });
  assert.deepEqual(ctx.app.services.projects.members(project.id), ['reg@example.com']);
});

test('removing the last membership revokes the reviewer session; other memberships keep it', async () => {
  const { project: p1 } = await newProject('Revoke One');
  const { project: p2 } = await newProject('Revoke Two');
  const email = 'rev@example.com';
  const cookie = await addAndSignIn(p1.id, email);
  await adm(`/api/admin/projects/${p2.id}/members`, { method: 'POST', body: { email } });
  const pending = (await adm(`/api/admin/projects/${p1.id}/members/${email}/invite`, { method: 'POST', body: {} })).json();
  assert.equal((await pub('/api/projects', { cookie })).status, 200);

  ctx.removedEvents.length = 0;
  const first = await adm(`/api/admin/projects/${p1.id}/members/${email}`, { method: 'DELETE' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json(), { ok: true });
  assert.deepEqual(ctx.removedEvents, [`${p1.id}:${email}`]);
  // Still a member of project two: the session survives, but only shows project two.
  const still = await pub('/api/projects', { cookie });
  assert.equal(still.status, 200);
  assert.deepEqual(still.json().map((/** @type {{slug:string}} */ p) => p.slug), ['revoke-two']);
  assert.equal((await pub('/api/p/revoke-one/live', { cookie })).status, 404);
  // The removed member's pending invite is dead.
  assert.equal((await pub(`/invite/${tokenOf(pending.inviteLink)}`, { method: 'POST' })).status, 410);

  const last = await adm(`/api/admin/projects/${p2.id}/members/${encodeURIComponent(email)}`, { method: 'DELETE' });
  assert.equal(last.status, 200);
  assert.deepEqual(ctx.removedEvents, [`${p1.id}:${email}`, `${p2.id}:${email}`]);
  const gone = await pub('/api/projects', { cookie });
  assert.equal(gone.status, 401);

  const again = await adm(`/api/admin/projects/${p2.id}/members/${email}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});

test('PATCH project: rename, reslug, errors; changing extraHidden wipes matching anchors', async () => {
  const { project } = await newProject('Patchable', { 'src/a.js': 'x\n', 'notes.txt': 'n\n' });
  const { comments } = ctx.app.services;
  const anchor = { lineText: 'n', before: [], after: [] };
  const onNotes = comments.create({
    projectId: project.id, target: 'live', path: 'notes.txt', line: 1, side: 'new', anchor, authorEmail: 'a@example.com', body: 'c1',
  });
  const onSrc = comments.create({
    projectId: project.id, target: 'live', path: 'src/a.js', line: 1, side: 'new', anchor, authorEmail: 'a@example.com', body: 'c2',
  });
  const reply = comments.reply(onNotes.id, { authorEmail: 'b@example.com', body: 'r' });

  const renamed = await adm(`/api/admin/projects/${project.id}`, { method: 'PATCH', body: { name: ' Patched ', slug: 'patched-slug' } });
  assert.equal(renamed.status, 200, renamed.body);
  assert.equal(renamed.json().name, 'Patched');
  assert.equal(renamed.json().slug, 'patched-slug');
  assert.equal(comments.get(onNotes.id)?.hidden, false);

  const taken = await adm(`/api/admin/projects/${project.id}`, { method: 'PATCH', body: { slug: 'admin' } });
  assert.equal(taken.status, 400);
  assert.equal(taken.json().error, 'invalid-slug');
  const badHidden = await adm(`/api/admin/projects/${project.id}`, { method: 'PATCH', body: { extraHidden: ['a/b'] } });
  assert.equal(badHidden.json().error, 'invalid-extra-hidden');
  const unknownKey = await adm(`/api/admin/projects/${project.id}`, { method: 'PATCH', body: { path: '/etc' } });
  assert.equal(unknownKey.status, 400);
  assert.equal(comments.get(onNotes.id)?.hidden, false);

  const hidden = await adm(`/api/admin/projects/${project.id}`, { method: 'PATCH', body: { extraHidden: ['notes.*'] } });
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.json().extraHidden, ['notes.*']);
  const wiped = comments.get(onNotes.id);
  assert.equal(wiped?.hidden, true);
  assert.equal(wiped?.anchor, null);
  assert.equal(comments.get(reply.id)?.anchor, null);
  const untouched = comments.get(onSrc.id);
  assert.equal(untouched?.hidden, false);
  assert.deepEqual(untouched?.anchor, anchor);
});

test('DELETE project needs ?confirm=<slug>, then cascades and revokes orphaned reviewers', async () => {
  const { project } = await newProject('Doomed');
  const cookie = await addAndSignIn(project.id, 'doomed@example.com');
  const base = `/api/admin/projects/${project.id}`;

  const none = await adm(base, { method: 'DELETE' });
  assert.equal(none.status, 400);
  assert.deepEqual(none.json(), { error: 'confirm-required' });
  const wrong = await adm(`${base}?confirm=nope`, { method: 'DELETE' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json().error, 'confirm-required');
  assert.ok(ctx.app.services.projects.get(project.id));

  ctx.removedEvents.length = 0;
  const ok = await adm(`${base}?confirm=${project.slug}`, { method: 'DELETE' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json(), { ok: true });
  assert.equal(ctx.app.services.projects.get(project.id), null);
  assert.deepEqual(ctx.removedEvents, [`${project.id}:doomed@example.com`]);
  assert.equal((await pub('/api/projects', { cookie })).status, 401);
  const again = await adm(`${base}?confirm=${project.slug}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});

test('ids must be positive integers; unknown projects are 404', async () => {
  for (const id of ['abc', '0', '-1', '1.5', '01', '99999999999999999999']) {
    for (const [method, suffix] of /** @type {const} */ ([['PATCH', ''], ['DELETE', ''], ['POST', '/members'], ['POST', '/members/a@b.co/invite'], ['DELETE', '/members/a@b.co']])) {
      const res = await adm(`/api/admin/projects/${id}${suffix}`, { method, body: { email: 'a@b.co' } });
      assert.equal(res.status, 404, `${method} ${id}${suffix}`);
    }
  }
  for (const [method, suffix] of /** @type {const} */ ([['PATCH', ''], ['DELETE', '?confirm=x'], ['POST', '/members'], ['POST', '/members/a@b.co/invite'], ['DELETE', '/members/a@b.co']])) {
    const res = await adm(`/api/admin/projects/987654${suffix}`, { method, body: { email: 'a@b.co' } });
    assert.equal(res.status, 404, `${method} ${suffix}`);
    assert.deepEqual(res.json(), { error: 'not-found' });
  }
});

test('inbox: newest first, open top-level threads across projects, no anchors, limited to 200', async () => {
  const { project: pa } = await newProject('Inbox A');
  const { project: pb } = await newProject('Inbox B');
  const { comments } = ctx.app.services;
  const anchor = { lineText: 'one', before: [], after: [] };
  const make = (/** @type {number} */ projectId, /** @type {string} */ path, /** @type {number} */ now, target = 'live') =>
    comments.create({ projectId, target, path, line: 1, side: 'new', anchor, authorEmail: 'a@example.com', body: `at ${now}`, now });
  const base = 4_000_000_000_000; // newer than anything created by earlier tests
  const oldest = make(pa.id, 'src/a.js', base + 1);
  const middle = make(pb.id, 'src/a.js', base + 2, 'abcdef1234567');
  const newest = make(pa.id, 'src/a.js', base + 3);
  const resolved = make(pa.id, 'src/a.js', base + 4);
  const outdated = make(pa.id, 'src/a.js', base + 5);
  const hidden = make(pb.id, 'notes.txt', base + 6);
  comments.setResolved(resolved.id, { kind: 'owner', email: OWNER_EMAIL, name: null }, true);
  comments.updatePosition(outdated.id, { outdated: true });
  comments.wipeHidden(pb.id, (p) => p === 'notes.txt');
  comments.reply(oldest.id, { authorEmail: 'b@example.com', body: 'a reply', now: base + 7 });

  const res = await adm('/api/admin/inbox');
  assert.equal(res.status, 200);
  const items = res.json();
  const mine = items.filter((/** @type {{thread:{id:number}}} */ i) => [oldest, middle, newest, resolved, outdated, hidden].some((c) => c.id === i.thread.id));
  assert.deepEqual(mine.map((/** @type {{thread:{id:number}}} */ i) => i.thread.id), [newest.id, middle.id, oldest.id]);
  assert.deepEqual(items.slice(0, 3).map((/** @type {{thread:{id:number}}} */ i) => i.thread.id), [newest.id, middle.id, oldest.id]);
  assert.equal(mine[0].slug, 'inbox-a');
  assert.equal(mine[0].projectName, 'Inbox A');
  assert.equal(mine[0].target, 'live');
  assert.equal(mine[1].slug, 'inbox-b');
  assert.equal(mine[1].target, 'abcdef1234567');
  assert.equal(mine[2].thread.replies.length, 1);
  assert.ok(!res.body.includes('"anchor"'));
  assert.ok(!res.body.includes('lineText'));
});

test('inbox is capped at 200 threads', async () => {
  const { project } = await newProject('Inbox Cap');
  const anchor = { lineText: 'one', before: [], after: [] };
  const base = 5_000_000_000_000;
  ctx.db.exec('BEGIN');
  for (let i = 0; i < 205; i++) {
    ctx.app.services.comments.create({
      projectId: project.id, target: 'live', path: 'src/a.js', line: 1, side: 'new', anchor, authorEmail: 'a@example.com', body: 'x', now: base + i,
    });
  }
  ctx.db.exec('COMMIT');
  const res = await adm('/api/admin/inbox');
  assert.equal(res.json().length, 200);
});

test('comments posted from the admin listener are authored as the owner email', async () => {
  const { repo, project } = await newProject('Owner Posts', { 'src/a.js': 'one\ntwo\n' });
  await repo.write('src/a.js', 'one\nTWO\n');
  const res = await adm(`/api/p/${project.slug}/comments`, {
    method: 'POST', body: { target: 'live', path: 'src/a.js', line: 2, side: 'new', body: 'from owner' },
  });
  assert.equal(res.status, 201, res.body);
  assert.equal(res.json().authorEmail, OWNER_EMAIL);
});
