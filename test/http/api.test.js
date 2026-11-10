import '../helpers/quiet-sqlite.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { createApp, errorResponse } from '../../src/app.js';
import { RepoError } from '../../src/git/repo.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';
import { request, seenBodies } from '../helpers/http.js';

const HOST = 'review.example.test';
const ORIGIN = `https://${HOST}`;
const SECRET = 'SUPERSECRET-envvalue-8c1f';

/** @type {Awaited<ReturnType<typeof setup>>} */
let ctx;

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-data-'));
  const db = openDb(join(dataDir, 'livereview.db'));
  /** @type {{to:string, subject:string, text:string}[]} */
  const sent = [];
  const emailSender = {
    /** @param {{to:string, subject:string, text:string}} m */
    async send(m) {
      sent.push(m);
      return /** @type {const} */ ({ ok: true });
    },
  };
  const config = {
    publicHost: HOST, resendApiKey: 're_test', fromEmail: 'lr@example.test', ownerName: 'Olivia',
    ownerEmail: 'owner@example.test', tunnelName: '', publicPort: 0, adminPort: 0,
  };
  const app = createApp({ config, db, emailSender });
  const ports = await app.start();

  const repo = await makeTmpRepo();
  await repo.write('src/a.js', 'one\ntwo\nthree\n');
  await repo.write('.gitignore', 'node_modules\n');
  await repo.write('config/.env.production', `TOKEN=${SECRET}\n`);
  await repo.commit('initial');
  // Commits on no branch: one dangling, one reset away after it was commented on.
  const tree = (await repo.git('rev-parse', 'HEAD^{tree}')).trim();
  const dangling = (await repo.git('commit-tree', tree, '-p', 'HEAD', '-m', 'dangling')).trim();
  const rewrittenSha = (await repo.git('commit-tree', tree, '-p', 'HEAD', '-m', 'rewritten')).trim();
  await repo.write('src/a.js', 'one\nTWO\nthree\n');
  await repo.write('.env', `TOKEN=${SECRET}\n`);
  const other = await makeTmpRepo();
  await other.write('b.txt', 'b\n');
  await other.commit('init');
  const gone = await makeTmpRepo();
  await gone.write('c.txt', 'c\n');
  await gone.commit('init');

  const { projects } = app.services;
  const nwc = await projects.add({ path: repo.dir, name: 'NWC Legal' });
  const otherP = await projects.add({ path: other.dir, name: 'Other' });
  const goneP = await projects.add({ path: gone.dir, name: 'Gone' });
  projects.addMember(nwc.id, 'alice@example.com');
  projects.addMember(goneP.id, 'alice@example.com');
  projects.addMember(otherP.id, 'bob@example.com');
  app.services.comments.create({
    projectId: nwc.id, target: rewrittenSha, path: 'src/a.js', line: 1, side: 'new',
    anchor: { lineText: 'one', before: [], after: ['two'] }, authorEmail: 'alice@example.com', body: 'old note',
  });

  return { config, dataDir, db, app, ports, sent, repo, other, gone, nwc, otherP, goneP, dangling, rewrittenSha };
}

/**
 * @param {string} path
 * @param {{method?:string, body?:unknown, cookie?:string, origin?:string|null, headers?:Record<string,string>}} [o]
 */
function pub(path, { method = 'GET', body, cookie, origin = ORIGIN, headers = {} } = {}) {
  /** @type {Record<string,string>} */
  const h = { Host: HOST, ...headers };
  if (origin && method !== 'GET') h.Origin = origin;
  if (cookie) h.Cookie = cookie;
  return request(ctx.ports.publicPort, { method, path, headers: h, body });
}

/** Sign alice in through an invite link; returns the Cookie header value. */
async function aliceCookie() {
  const token = ctx.app.services.projects.createInvite(ctx.nwc.id, 'alice@example.com', Date.now());
  const res = await pub(`/invite/${token}`, { method: 'POST' });
  return `lr_session=${res.cookies.lr_session}`;
}

before(async () => {
  ctx = await setup();
});

after(async () => {
  await ctx.app.stop();
  ctx.db.close();
  await Promise.all([ctx.repo.cleanup(), ctx.other.cleanup(), ctx.gone.cleanup()]);
  await rm(ctx.dataDir, { recursive: true, force: true });
});

test('reviewer without a session gets 401 from the API and a redirect from pages', async () => {
  const res = await pub('/api/projects');
  assert.equal(res.status, 401);
  assert.deepEqual(res.json(), { error: 'unauthorized' });
  const page = await pub('/nwc-legal');
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login');
  const login = await pub('/login');
  assert.equal(login.status, 200);
  assert.match(login.body, /<script type="module" src="\/static\/app\.js"><\/script>/);
});

test('opening an invite link only shows a page; its form POST signs in once', async () => {
  const token = ctx.app.services.projects.createInvite(ctx.nwc.id, 'alice@example.com', Date.now());
  for (let i = 0; i < 2; i++) {
    const page = await pub(`/invite/${token}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers['set-cookie'], undefined);
    assert.match(page.body, new RegExp(`<form method="post" action="/invite/${token}">`));
    assert.doesNotMatch(page.body, /<script/);
  }
  const forged = await pub(`/invite/${token}`, { method: 'POST', origin: 'https://evil.example' });
  assert.equal(forged.status, 403);
  const noOrigin = await pub(`/invite/${token}`, { method: 'POST', origin: '' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await pub('/invite/not-a-token')).status, 410);

  const res = await pub(`/invite/${token}`, { method: 'POST' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/nwc-legal');
  const setCookie = res.headers['set-cookie']?.[0] ?? '';
  assert.match(setCookie, /^lr_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  const me = await pub('/api/me', { cookie: `lr_session=${res.cookies.lr_session}` });
  assert.deepEqual(me.json(), { email: 'alice@example.com', name: null, kind: 'reviewer', emailNotifications: true });

  const again = await pub(`/invite/${token}`, { method: 'POST' });
  assert.equal(again.status, 410);
  assert.match(again.body, /This invite link is no longer valid/);
  assert.equal((await pub(`/invite/${token}`)).status, 410, 'a used link shows the no-longer-valid page');
});

test('reviewer sees only member projects; no-access and unknown give identical 404s', async () => {
  const cookie = await aliceCookie();
  const list = await pub('/api/projects', { cookie });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json(), [
    { slug: 'gone', name: 'Gone', open: 0 },
    { slug: 'nwc-legal', name: 'NWC Legal', open: 1 },
  ]);
  const a = await pub('/api/p/other/live', { cookie });
  const b = await pub('/api/p/does-not-exist/live', { cookie });
  const c = await pub('/api/p/BAD..slug/live', { cookie });
  for (const r of [a, b, c]) {
    assert.equal(r.status, 404);
    assert.equal(r.body, a.body);
  }
  assert.deepEqual(a.json(), { error: 'no-access' });
});

test('live diff shows the modified file and never the .env content', async () => {
  const cookie = await aliceCookie();
  const res = await pub('/api/p/nwc-legal/live', { cookie });
  assert.equal(res.status, 200);
  const live = res.json();
  assert.equal(live.untrackedTruncated, false);
  assert.equal(live.head.branch, 'main');
  const a = live.files.find((/** @type {any} */ f) => f.path === 'src/a.js');
  assert.equal(a.status, 'modified');
  assert.match(a.patch, /\+TWO/);
  const env = live.files.find((/** @type {any} */ f) => f.path === '.env');
  assert.equal(env.hidden, true);
  assert.ok(!res.body.includes(SECRET));
});

test('tracked files that match .gitignore are hidden in the live view and cannot be commented on', async () => {
  const repo = await makeTmpRepo();
  const { projects } = ctx.app.services;
  try {
    await repo.write('src/b.js', 'b\n');
    await repo.write('config/local.yml', 'token: trackedignoredvalue\n');
    await repo.commit('init');
    await repo.write('.gitignore', 'local.yml\n');
    await repo.write('config/local.yml', 'token: trackedignoredvalue2\n');
    const p = await projects.add({ path: repo.dir, name: 'Ignored Tracked' });
    projects.addMember(p.id, 'alice@example.com');
    const cookie = await aliceCookie();
    const res = await pub(`/api/p/${p.slug}/live`, { cookie });
    assert.equal(res.status, 200);
    const f = res.json().files.find((/** @type {any} */ x) => x.path === 'config/local.yml');
    assert.equal(f.hidden, true);
    assert.doesNotMatch(res.body, /trackedignoredvalue/);
    const post = await pub(`/api/p/${p.slug}/comments`, {
      method: 'POST', cookie, body: { target: 'live', path: 'config/local.yml', line: 1, side: 'new', body: 'x' },
    });
    assert.equal(post.status, 400);
    projects.remove(p.id);
  } finally {
    await repo.cleanup();
  }
});

test('commits list, commit detail and unknown commit', async () => {
  const cookie = await aliceCookie();
  const list = await pub('/api/p/nwc-legal/commits?page=1', { cookie });
  assert.equal(list.status, 200);
  const { commits, hasMore, page } = list.json();
  assert.equal(page, 1);
  assert.equal(hasMore, false);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].subject, 'initial');
  const detail = await pub(`/api/p/nwc-legal/commit/${commits[0].sha}`, { cookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.json().commit.sha, commits[0].sha);
  assert.ok(detail.json().files.some((/** @type {any} */ f) => f.path === 'src/a.js'));
  const unknown = await pub(`/api/p/nwc-legal/commit/${'0'.repeat(40)}`, { cookie });
  assert.equal(unknown.status, 404);
  const bad = await pub('/api/p/nwc-legal/commit/zzz', { cookie });
  assert.equal(bad.status, 404);
});

test('a .env committed in history is redacted in the commit view', async () => {
  const cookie = await aliceCookie();
  const { commits } = (await pub('/api/p/nwc-legal/commits', { cookie })).json();
  const res = await pub(`/api/p/nwc-legal/commit/${commits[0].sha}`, { cookie });
  assert.equal(res.status, 200);
  const env = res.json().files.find((/** @type {any} */ f) => f.path === 'config/.env.production');
  assert.equal(env.hidden, true);
  assert.ok(!res.body.includes(SECRET));
});

test('commits on no branch are 404 unless they already have comments', async () => {
  const cookie = await aliceCookie();
  for (const sha of [ctx.dangling, ctx.dangling.slice(0, 10)]) {
    const get = await pub(`/api/p/nwc-legal/commit/${sha}`, { cookie });
    assert.equal(get.status, 404, sha);
    assert.deepEqual(get.json(), { error: 'not-found' });
    const post = await pub('/api/p/nwc-legal/comments', {
      method: 'POST', cookie, body: { target: sha, path: 'src/a.js', line: 1, side: 'new', body: 'x' },
    });
    assert.equal(post.status, 404, sha);
    assert.equal((await pub(`/api/p/nwc-legal/comments?target=${sha.slice(0, 10)}`, { cookie })).status, 404);
  }
  const kept = await pub(`/api/p/nwc-legal/commit/${ctx.rewrittenSha}`, { cookie });
  assert.equal(kept.status, 200);
  assert.equal(kept.json().commit.sha, ctx.rewrittenSha);
  const short = await pub(`/api/p/nwc-legal/comments?target=${ctx.rewrittenSha.slice(0, 8)}`, { cookie });
  assert.equal(short.status, 200);
  assert.equal(short.json().threads.length, 1);
  assert.equal(short.json().threads[0].body, 'old note');
});

test('comments: create with server anchor, list, reply, edit, resolve, delete', async () => {
  const cookie = await aliceCookie();
  const post = (/** @type {unknown} */ body) => pub('/api/p/nwc-legal/comments', { method: 'POST', cookie, body });
  const created = await post({ target: 'live', path: 'src/a.js', line: 2, side: 'new', body: 'why caps?', anchor: { lineText: 'x', before: [], after: [] } });
  assert.equal(created.status, 201);
  const c = created.json();
  assert.equal(c.body, 'why caps?');
  assert.equal(c.authorEmail, 'alice@example.com');
  assert.equal('anchor' in c, false);
  const stored = ctx.app.services.comments.get(c.id);
  assert.deepEqual(stored?.anchor, { lineText: 'TWO', before: ['one'], after: ['three'] });

  assert.equal((await post({ target: 'live', path: '.env', line: 1, side: 'new', body: 'x' })).status, 400);
  assert.equal((await post({ target: 'live', path: 'nope.js', line: 1, side: 'new', body: 'x' })).status, 400);
  assert.equal((await post({ target: 'live', path: 'src/a.js', line: 99, side: 'new', body: 'x' })).status, 400);

  const reply = await pub(`/api/comments/${c.id}/replies`, { method: 'POST', cookie, body: { body: 'because' } });
  assert.equal(reply.status, 201);
  const edited = await pub(`/api/comments/${c.id}`, { method: 'PATCH', cookie, body: { body: 'why?', resolved: true } });
  assert.equal(edited.status, 200);
  assert.equal(edited.json().body, 'why?');
  assert.equal(edited.json().resolved, true);

  const list = await pub('/api/p/nwc-legal/comments?target=live', { cookie });
  assert.equal(list.status, 200);
  const { threads, outdated, rewritten } = list.json();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].replies.length, 1);
  assert.deepEqual(outdated, []);
  assert.deepEqual(rewritten, []);

  const bobToken = ctx.app.services.projects.createInvite(ctx.otherP.id, 'bob@example.com', Date.now());
  const bob = `lr_session=${(await pub(`/invite/${bobToken}`, { method: 'POST' })).cookies.lr_session}`;
  const foreign = await pub(`/api/comments/${c.id}`, { method: 'DELETE', cookie: bob });
  assert.equal(foreign.status, 404);

  const del = await pub(`/api/comments/${c.id}`, { method: 'DELETE', cookie });
  assert.equal(del.status, 200);
  assert.equal(ctx.app.services.comments.get(c.id), null);
});

test('login request: 200 for everyone, padded to 800 ms, email only for members; verify signs in', async () => {
  ctx.sent.length = 0;
  const stranger = await pub('/api/login/request', { method: 'POST', body: { email: 'stranger@example.com' } });
  assert.equal(stranger.status, 200);
  assert.deepEqual(stranger.json(), { ok: true });
  assert.ok(stranger.ms >= 800, `took ${stranger.ms}`);
  assert.equal(ctx.sent.length, 0);

  const member = await pub('/api/login/request', { method: 'POST', body: { email: 'Alice@Example.com' } });
  assert.equal(member.status, 200);
  assert.equal(member.body, stranger.body);
  assert.ok(member.ms >= 800, `took ${member.ms}`);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].to, 'alice@example.com');
  const code = /\b(\d{6})\b/.exec(ctx.sent[0].text)?.[1];

  const wrong = await pub('/api/login/verify', { method: 'POST', body: { email: 'alice@example.com', code: '000000' === code ? '111111' : '000000' } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json(), { error: 'invalid-code' });
  const ok = await pub('/api/login/verify', { method: 'POST', body: { email: 'alice@example.com', code } });
  assert.equal(ok.status, 200);
  const cookie = `lr_session=${ok.cookies.lr_session}`;
  assert.equal((await pub('/api/me', { cookie })).status, 200);

  const named = await pub('/api/me/name', { method: 'POST', cookie, body: { name: 'Alice A.' } });
  assert.equal(named.status, 200);
  assert.equal((await pub('/api/me', { cookie })).json().name, 'Alice A.');
  assert.equal((await pub('/api/me/name', { method: 'POST', cookie, body: { name: 'x'.repeat(61) } })).status, 400);

  const out = await pub('/api/logout', { method: 'POST', cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers['set-cookie']?.[0] ?? '', /^lr_session=; .*Max-Age=0/);
  assert.equal((await pub('/api/me', { cookie })).status, 401);
});

test('login request does not wait for a slow email provider', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-data-'));
  const db = openDb(join(dataDir, 'livereview.db'));
  /** @type {string[]} */
  const delivered = [];
  /** @type {Promise<unknown>[]} */
  const pending = [];
  const emailSender = {
    /** @param {{to:string}} m */
    send(m) {
      const p = new Promise((r) => setTimeout(r, 1500)).then(() => {
        delivered.push(m.to);
        return { ok: true };
      });
      pending.push(p);
      return p;
    },
  };
  const app = createApp({ config: { ...ctx.config, publicPort: 0, adminPort: 0 }, db, emailSender });
  const { publicPort } = await app.start();
  const p = await app.services.projects.add({ path: ctx.other.dir, name: 'Slow' });
  app.services.projects.addMember(p.id, 'carol@example.com');
  /** @param {string} email */
  const ask = (email) => request(publicPort, {
    method: 'POST', path: '/api/login/request', headers: { Host: HOST, Origin: ORIGIN }, body: { email },
  });
  try {
    const member = await ask('carol@example.com');
    const stranger = await ask('nobody@example.com');
    for (const r of [member, stranger]) {
      assert.equal(r.status, 200);
      assert.ok(r.ms >= 800 && r.ms < 1300, `took ${r.ms}`);
    }
    assert.equal(pending.length, 1);
    await Promise.all(pending);
    assert.deepEqual(delivered, ['carol@example.com']);
  } finally {
    await app.stop();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('deleted project folder gives 503 while the project list still works', async () => {
  const cookie = await aliceCookie();
  await rm(ctx.gone.dir, { recursive: true, force: true });
  const live = await pub('/api/p/gone/live', { cookie });
  assert.equal(live.status, 503);
  assert.deepEqual(live.json(), { error: 'project-unavailable' });
  assert.equal((await pub('/api/p/gone/commits', { cookie })).status, 503);
  const list = await pub('/api/projects', { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json().length, 2);
});

test('public listener never serves admin paths', async () => {
  const cookie = await aliceCookie();
  for (const path of ['/admin', '/admin/settings', '/api/admin/projects']) {
    assert.equal((await pub(path, { cookie })).status, 404, path);
  }
});

test('static files and diff2html vendor bundle are served with traversal protection', async () => {
  const js = await pub('/static/app.js');
  assert.equal(js.status, 200);
  assert.match(String(js.headers['content-type']), /^text\/javascript/);
  const css = await pub('/vendor/diff2html/css/diff2html.min.css');
  assert.equal(css.status, 200);
  assert.match(String(css.headers['content-type']), /^text\/css/);
  for (const path of ['/static/../package.json', '/static/%2e%2e/package.json', '/static/..%2fpackage.json', '/vendor/diff2html/../../../package.json']) {
    assert.equal((await pub(path)).status, 404, path);
  }
});

test('responses carry security headers', async () => {
  const res = await pub('/login');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'same-origin');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(String(res.headers['content-security-policy']), /default-src 'self'/);
  assert.match(String(res.headers['content-security-policy']), new RegExp(`connect-src 'self' wss://${HOST.replaceAll('.', '\\.')};`));
  assert.equal(res.headers['cache-control'], 'no-store');
  const a = ctx.ports.adminPort;
  const admin = await request(a, { path: '/login', headers: { Host: `127.0.0.1:${a}` } });
  assert.match(
    String(admin.headers['content-security-policy']),
    new RegExp(`connect-src 'self' ws://localhost:${a} ws://127\\.0\\.0\\.1:${a};`),
  );
});

test('request body limits and JSON validation', async () => {
  const cookie = await aliceCookie();
  const big = await request(ctx.ports.publicPort, {
    method: 'POST', path: '/api/me/name', headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie },
    raw: JSON.stringify({ name: 'x'.repeat(70_000) }),
  });
  assert.equal(big.status, 413);
  const bad = await request(ctx.ports.publicPort, {
    method: 'POST', path: '/api/me/name', headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie }, raw: '{nope',
  });
  assert.equal(bad.status, 400);
});

test('every RepoError maps to 503 project-unavailable except unknown-commit (404)', (t) => {
  const logged = /** @type {unknown[][]} */ ([]);
  t.mock.method(console, 'error', (/** @type {unknown[]} */ ...args) => logged.push(args));
  for (const reason of ['missing', 'forbidden', 'not-a-repo', 'not-root']) {
    assert.deepEqual(errorResponse(new RepoError(reason)), [503, { error: 'project-unavailable' }], reason);
  }
  assert.deepEqual(errorResponse(new RepoError('unknown-commit')), [404, { error: 'not-found' }]);
  assert.equal(logged.length, 3);
  for (const args of logged) assert.equal(args.length, 1);
});

test('.env content never appears in any response body', () => {
  assert.ok(seenBodies.length > 10);
  for (const body of seenBodies) assert.ok(!body.includes(SECRET));
});
