// The whole v2 notification loop over HTTP and WebSocket, end to end: who is told live, who is emailed (and
// with which link), preferences, member removal, and snippets under hide rules that change later.
// Adapted from the final review's e2e-notify harness. Isolated: temp data dir, temp repositories, random ports.
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

const HOST = 'review.loop.test';
const PUBLIC_ORIGIN = `https://${HOST}`;
const OWNER_EMAIL = 'owner@loop.test';
const R1_EMAIL = 'rev1@loop.test';
const R2_EMAIL = 'rev2@loop.test';
const DELAY = 50;
/** Long enough for a live push and one email batch. */
const SETTLE = DELAY * 4;

/** @type {any} */
let ctx;
/** @type {string|undefined} */
let previousDataDir;

before(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-loop-'));
  previousDataDir = process.env.LIVEREVIEW_DATA_DIR;
  process.env.LIVEREVIEW_DATA_DIR = dataDir;
  const db = openDb(join(dataDir, 'livereview.db'));
  /** @type {{to:string, subject:string, text:string}[]} */
  const sent = [];
  const config = {
    publicHost: HOST, ownerName: 'Owner', ownerEmail: OWNER_EMAIL, fromEmail: 'lr@loop.test', resendApiKey: 're_test',
    tunnelName: '', publicPort: 0, adminPort: 0, ownerEmailNotifications: true,
  };
  const app = createApp({
    config, db, notifyDelayMs: DELAY, watcherOptions: { debounceMs: 50, graceMs: 100 },
    emailSender: { send: async (m) => { sent.push(m); return { ok: true }; } },
  });
  const ports = await app.start();
  const aHost = `localhost:${ports.adminPort}`;
  const ex = await request(ports.adminPort, { path: `/admin?t=${app.services.owner.issueOneTime()}`, headers: { Host: aHost } });
  ctx = { dataDir, db, app, ports, sent, aHost, ownerCookie: `lr_owner=${ex.cookies.lr_owner}`, repos: [], sockets: [] };
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

/** @param {string} method @param {string} path @param {unknown} [body] */
const A = (method, path, body) =>
  request(ctx.ports.adminPort, { method, path, body, headers: { Host: ctx.aHost, Origin: `http://${ctx.aHost}`, Cookie: ctx.ownerCookie } });

/** @param {string} cookie */
const P = (cookie) => (/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body) =>
  request(ctx.ports.publicPort, { method, path, body, headers: { Host: HOST, Origin: PUBLIC_ORIGIN, Cookie: cookie } });

/** @param {number} projectId @param {string} email */
async function invite(projectId, email) {
  const m = await A('POST', `/api/admin/projects/${projectId}/members`, { email });
  assert.equal(m.status, 200, m.body);
  const path = new URL(m.json().inviteLink).pathname;
  assert.equal((await request(ctx.ports.publicPort, { path, headers: { Host: HOST } })).status, 200, 'opening the link only shows a page');
  const redeem = await request(ctx.ports.publicPort, { method: 'POST', path, headers: { Host: HOST, Origin: PUBLIC_ORIGIN } });
  assert.equal(redeem.status, 302);
  return `lr_session=${redeem.cookies.lr_session}`;
}

/** @param {'public'|'admin'} kind @param {string} cookie */
function sock(kind, cookie) {
  const port = kind === 'public' ? ctx.ports.publicPort : ctx.ports.adminPort;
  const host = kind === 'public' ? HOST : ctx.aHost;
  const origin = kind === 'public' ? PUBLIC_ORIGIN : `http://${host}`;
  /** @type {any[]} */
  const got = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Host: host, Origin: origin, Cookie: cookie } });
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'notification') got.push(m.notification);
  });
  ctx.sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', () => resolve({ ws, got }));
  });
}

test('notification loop: live pushes, batched emails with the right links, preferences, removal, snippets', async () => {
  const repo = await makeTmpRepo();
  ctx.repos.push(repo);
  await repo.write('app.php', '<?php\nfunction a() {\n  return 1;\n}\n');
  await repo.write('conf.php', '<?php\n$x = 1;\n');
  await repo.commit('init');
  await repo.write('app.php', '<?php\nfunction a() {\n  return 2; // changed\n}\n');
  await repo.write('conf.php', '<?php\n$x = "SECRET-VALUE";\n');

  const created = await A('POST', '/api/admin/projects', { path: repo.dir, name: 'Demo' });
  assert.equal(created.status, 201, created.body);
  const proj = created.json();
  const r1 = await invite(proj.id, R1_EMAIL);
  const r2 = await invite(proj.id, R2_EMAIL);
  const R1 = P(r1);
  const R2 = P(r2);
  assert.equal((await R1('POST', '/api/me/name', { name: 'Rana' })).status, 200);

  const ows = await sock('admin', ctx.ownerCookie);
  const w1 = await sock('public', r1);
  const w2 = await sock('public', r2);
  const { sent } = ctx;
  const reset = () => {
    ows.got.length = 0;
    w1.got.length = 0;
    w2.got.length = 0;
    sent.length = 0;
  };
  const kinds = (/** @type {{got:any[]}} */ s) => s.got.map((n) => n.kind);

  // A new comment: the owner only, live and by email with the admin (localhost) link.
  const res = await R1('POST', `/api/p/${proj.slug}/comments`, { target: 'live', path: 'app.php', line: 3, side: 'new', body: 'Why 2 here?' });
  assert.equal(res.status, 201, res.body);
  const c = res.json();
  await sleep(SETTLE);
  assert.deepEqual([kinds(ows), kinds(w1), kinds(w2)], [['comment'], [], []]);
  const ownerMail = sent.filter((m) => m.to === OWNER_EMAIL);
  assert.equal(ownerMail.length, 1);
  assert.ok(ownerMail[0].text.includes(`http://localhost:${ctx.ports.adminPort}/${proj.slug}/live#c-${c.id}`), ownerMail[0].text);

  // The owner resolves: Rana is told (it is hers), with the public link.
  reset();
  await A('PATCH', `/api/comments/${c.id}`, { resolved: true });
  await sleep(SETTLE);
  assert.deepEqual([kinds(ows), kinds(w1), kinds(w2)], [[], ['resolved'], []]);
  assert.equal(w1.got[0].yours, true);
  assert.deepEqual(sent.map((m) => m.to), [R1_EMAIL]);
  assert.ok(sent[0].text.includes(`https://${HOST}/${proj.slug}/live#c-${c.id}`), sent[0].text);
  const bell = (await R1('GET', '/api/notifications')).json();
  assert.equal(bell.unread, 1);
  assert.equal(bell.items[0].kind, 'resolved');

  // Resolving again is not a change: nobody is told.
  reset();
  await A('PATCH', `/api/comments/${c.id}`, { resolved: true });
  await sleep(SETTLE);
  assert.deepEqual(kinds(w1), []);

  // Rana reopens: the owner is told.
  reset();
  await R1('PATCH', `/api/comments/${c.id}`, { resolved: false });
  await sleep(SETTLE);
  assert.deepEqual([kinds(ows), kinds(w1)], [['reopened'], []]);

  // Sam (r2) replies: the owner and Rana, never the actor.
  reset();
  assert.equal((await R2('POST', `/api/comments/${c.id}/replies`, { body: 'Agree, odd.' })).status, 201);
  await sleep(SETTLE);
  assert.deepEqual([kinds(ows), kinds(w1), kinds(w2)], [['reply'], ['reply'], []]);

  // Rana turns email off: an owner reply reaches both reviewers live, only Sam by email.
  reset();
  await R1('PUT', '/api/me/prefs', { emailNotifications: false });
  await A('POST', `/api/comments/${c.id}/replies`, { body: 'Owner says hi' });
  await sleep(SETTLE);
  assert.deepEqual([kinds(ows), kinds(w1), kinds(w2)], [[], ['reply'], ['reply']]);
  assert.deepEqual(sent.map((m) => m.to), [R2_EMAIL]);

  // The owner turns email off: live only.
  reset();
  await A('PUT', '/api/me/prefs', { emailNotifications: false });
  await R2('POST', `/api/comments/${c.id}/replies`, { body: 'again' });
  await sleep(SETTLE);
  assert.deepEqual(kinds(ows), ['reply']);
  assert.ok(!sent.some((m) => m.to === OWNER_EMAIL));
  await A('PUT', '/api/me/prefs', { emailNotifications: true });

  // Rana is removed from Demo (still a member elsewhere): she is no longer told, cannot see its threads,
  // and her bell no longer lists the project.
  reset();
  const other = await makeTmpRepo();
  ctx.repos.push(other);
  await other.write('x.txt', 'x\n');
  await other.commit('init');
  const proj2 = (await A('POST', '/api/admin/projects', { path: other.dir, name: 'Other' })).json();
  await A('POST', `/api/admin/projects/${proj2.id}/members`, { email: R1_EMAIL });
  assert.equal((await A('DELETE', `/api/admin/projects/${proj.id}/members/${encodeURIComponent(R1_EMAIL)}`)).status, 200);
  assert.equal((await R2('POST', `/api/comments/${c.id}/replies`, { body: 'after removal' })).status, 201);
  await sleep(SETTLE);
  assert.deepEqual([kinds(ows), kinds(w1)], [['reply'], []]);
  const gone = await R1('GET', `/api/p/${proj.slug}/threads`);
  const unknown = await R1('GET', '/api/p/nope/threads');
  assert.equal(gone.status, 404);
  assert.equal(gone.body, unknown.body, 'no access and unknown look the same');
  assert.deepEqual((await R1('GET', '/api/notifications')).json(), { items: [], unread: 0 });

  // Snippets follow the hide rules as they are now.
  const snippetOf = async (/** @type {number} */ id) =>
    (await R2('GET', `/api/p/${proj.slug}/threads?status=all`)).json().threads.find((/** @type {any} */ t) => t.id === id).snippet;
  const c2 = await R2('POST', `/api/p/${proj.slug}/comments`, { target: 'live', path: 'conf.php', line: 2, side: 'new', body: 'look' });
  assert.equal(c2.status, 201, c2.body);
  const before = await snippetOf(c2.json().id);
  assert.ok(Array.isArray(before) && before.some((/** @type {any} */ l) => l.text.includes('SECRET')), 'snippet present before hiding');
  await A('PATCH', `/api/admin/projects/${proj.id}`, { extraHidden: ['conf.php'] });
  assert.equal(await snippetOf(c2.json().id), null, 'null once the file matches an extra hidden pattern');

  const c3 = await R2('POST', `/api/p/${proj.slug}/comments`, { target: 'live', path: 'app.php', line: 2, side: 'new', body: 'gi' });
  assert.equal(c3.status, 201, c3.body);
  assert.ok(Array.isArray(await snippetOf(c3.json().id)));
  await repo.write('.gitignore', 'app.php\n');
  assert.equal(await snippetOf(c3.json().id), null, 'null once the file is git-ignored');
  const live = (await R2('GET', `/api/p/${proj.slug}/live`)).json();
  assert.equal(live.files.find((/** @type {any} */ f) => f.path === 'app.php')?.hidden, true, 'the live diff hides it too');
  const listing = await R2('GET', `/api/p/${proj.slug}/threads?status=all`);
  assert.ok(!listing.body.includes('SECRET-VALUE') && !listing.body.includes('return 2'), 'no stale anchor text anywhere');
});
