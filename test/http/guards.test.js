import '../helpers/quiet-sqlite.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { createSessionService, createOwnerAuth } from '../../src/auth/sessions.js';
import { hostAllowed, originAllowed, parseCookies, resolveViewer } from '../../src/http/guards.js';
import { request } from '../helpers/http.js';

const HOST = 'review.example.test';
const config = {
  publicHost: HOST, resendApiKey: '', fromEmail: '', ownerName: 'Olivia', ownerEmail: 'Owner@Example.test',
  tunnelName: '', publicPort: 0, adminPort: 0,
};

/** @param {Record<string,string>} headers @param {string} [method] */
const fakeReq = (headers, method = 'GET') => /** @type {any} */ ({ headers, method });

/** @param {'public'|'admin'} kind @param {number} [port] */
function listenerFor(kind, port = 4318) {
  const db = openDb(':memory:');
  return {
    db,
    listener: {
      kind, port, config,
      sessions: createSessionService(db), owner: createOwnerAuth(),
      userName: () => null, now: Date.now,
    },
  };
}

test('hostAllowed: public needs the exact public host, admin needs localhost/127.0.0.1 with the port', () => {
  const pub = listenerFor('public').listener;
  assert.equal(hostAllowed(fakeReq({ host: HOST }), pub), true);
  assert.equal(hostAllowed(fakeReq({ host: 'REVIEW.example.test' }), pub), true);
  for (const h of ['evil.test', `${HOST}.evil.test`, `${HOST}:4317`, 'localhost:4317', '']) {
    assert.equal(hostAllowed(fakeReq({ host: h }), pub), false, h);
  }
  assert.equal(hostAllowed(fakeReq({}), pub), false);
  const unconfigured = { ...pub, config: { ...config, publicHost: '' } };
  assert.equal(hostAllowed(fakeReq({ host: '' }), unconfigured), false);

  const adm = listenerFor('admin', 4318).listener;
  assert.equal(hostAllowed(fakeReq({ host: 'localhost:4318' }), adm), true);
  assert.equal(hostAllowed(fakeReq({ host: '127.0.0.1:4318' }), adm), true);
  for (const h of ['localhost', 'localhost:4317', HOST, 'evil.test:4318', '[::1]:4318']) {
    assert.equal(hostAllowed(fakeReq({ host: h }), adm), false, h);
  }
});

test('originAllowed: public wants https://publicHost, admin wants http:// matching its host', () => {
  const pub = listenerFor('public').listener;
  assert.equal(originAllowed(fakeReq({ host: HOST, origin: `https://${HOST}` }, 'POST'), pub), true);
  for (const o of [`http://${HOST}`, 'https://evil.test', 'null', `https://${HOST}:443`]) {
    assert.equal(originAllowed(fakeReq({ host: HOST, origin: o }, 'POST'), pub), false, o);
  }
  assert.equal(originAllowed(fakeReq({ host: HOST }, 'POST'), pub), false);

  const adm = listenerFor('admin', 4318).listener;
  assert.equal(originAllowed(fakeReq({ host: 'localhost:4318', origin: 'http://localhost:4318' }, 'POST'), adm), true);
  assert.equal(originAllowed(fakeReq({ host: '127.0.0.1:4318', origin: 'http://127.0.0.1:4318' }, 'POST'), adm), true);
  assert.equal(originAllowed(fakeReq({ host: 'localhost:4318', origin: 'https://localhost:4318' }, 'POST'), adm), false);
  assert.equal(originAllowed(fakeReq({ host: 'localhost:4318', origin: `https://${HOST}` }, 'POST'), adm), false);
});

test('parseCookies keeps the first value and ignores junk', () => {
  assert.deepEqual(parseCookies('a=1; b=2; a=3; junk; c='), { a: '1', b: '2', c: '' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('resolveViewer: reviewer from lr_session on public, owner from lr_owner on admin only', () => {
  const { listener: pub } = listenerFor('public');
  const token = pub.sessions.create('alice@example.com');
  assert.deepEqual(resolveViewer(fakeReq({ cookie: `lr_session=${token}` }), pub), {
    kind: 'reviewer', email: 'alice@example.com', name: null,
  });
  assert.equal(resolveViewer(fakeReq({ cookie: 'lr_session=nope' }), pub), null);
  assert.equal(resolveViewer(fakeReq({}), pub), null);

  const { listener: adm } = listenerFor('admin');
  const ownerSession = /** @type {string} */ (adm.owner.exchange(adm.owner.issueOneTime()));
  assert.deepEqual(resolveViewer(fakeReq({ cookie: `lr_owner=${ownerSession}` }), adm), {
    kind: 'owner', email: 'owner@example.test', name: 'Olivia',
  });
  assert.equal(resolveViewer(fakeReq({ cookie: 'lr_owner=forged' }), adm), null);
  // An owner cookie means nothing on the public listener, a reviewer cookie nothing on the admin one.
  const pubWithOwner = { ...pub, owner: adm.owner };
  assert.equal(resolveViewer(fakeReq({ cookie: `lr_owner=${ownerSession}` }), pubWithOwner), null);
  const admWithSessions = { ...adm, sessions: pub.sessions };
  assert.equal(resolveViewer(fakeReq({ cookie: `lr_session=${token}` }), admWithSessions), null);
});

/** @type {{app:ReturnType<typeof createApp>, db:import('node:sqlite').DatabaseSync, ports:{publicPort:number, adminPort:number}}} */
let live;

before(async () => {
  const db = openDb(':memory:');
  const app = createApp({ config, db, emailSender: { send: async () => ({ ok: true }) } });
  live = { app, db, ports: await app.start() };
});

after(async () => {
  await live.app.stop();
  live.db.close();
});

test('servers: wrong Host on public gives 421, state change without Origin gives 403', async () => {
  const p = live.ports.publicPort;
  const wrongHost = await request(p, { path: '/api/projects', headers: { Host: 'evil.test' } });
  assert.equal(wrongHost.status, 421);
  assert.deepEqual(wrongHost.json(), { error: 'forbidden' });

  const noOrigin = await request(p, { method: 'POST', path: '/api/login/request', headers: { Host: HOST }, body: { email: 'a@b.c' } });
  assert.equal(noOrigin.status, 403);
  assert.deepEqual(noOrigin.json(), { error: 'forbidden' });
  const badOrigin = await request(p, {
    method: 'POST', path: '/api/logout', headers: { Host: HOST, Origin: 'https://evil.test' }, body: {},
  });
  assert.equal(badOrigin.status, 403);
});

test('servers: admin listener checks Host/Origin and requires the owner cookie', async () => {
  const a = live.ports.adminPort;
  const host = `127.0.0.1:${a}`;
  assert.equal((await request(a, { path: '/api/me', headers: { Host: HOST } })).status, 421);
  assert.equal((await request(a, { path: '/api/me', headers: { Host: `localhost:${a + 1}` } })).status, 421);

  const anon = await request(a, { path: '/api/me', headers: { Host: host } });
  assert.equal(anon.status, 401);
  assert.deepEqual(anon.json(), { error: 'unauthorized' });
  const page = await request(a, { path: '/', headers: { Host: host } });
  assert.equal(page.status, 401);
  assert.match(page.body, /Open LiveReview from the link printed in your terminal\./);

  const owner = live.app.services.owner;
  const cookie = `lr_owner=${owner.exchange(owner.issueOneTime())}`;
  const me = await request(a, { path: '/api/me', headers: { Host: `localhost:${a}`, Cookie: cookie } });
  assert.deepEqual(me.json(), { email: 'owner@example.test', name: 'Olivia', kind: 'owner', emailNotifications: true });
  const shell = await request(a, { path: '/', headers: { Host: host, Cookie: cookie } });
  assert.equal(shell.status, 200);
  assert.match(shell.body, /<div id="app"><\/div>/);

  const noOrigin = await request(a, { method: 'PATCH', path: '/api/comments/1', headers: { Host: host, Cookie: cookie }, body: {} });
  assert.equal(noOrigin.status, 403);
  const crossOrigin = await request(a, {
    method: 'PATCH', path: '/api/comments/1', headers: { Host: host, Cookie: cookie, Origin: `http://localhost:${a}` }, body: {},
  });
  assert.equal(crossOrigin.status, 403);
  const sameOrigin = await request(a, {
    method: 'PATCH', path: '/api/comments/1', headers: { Host: host, Cookie: cookie, Origin: `http://${host}` }, body: { body: 'x' },
  });
  assert.equal(sameOrigin.status, 404);

  // Reviewer-only routes do not exist on the admin listener.
  assert.equal((await request(a, { path: '/invite/abc', headers: { Host: host, Cookie: cookie } })).status, 404);
  const loginReq = await request(a, {
    method: 'POST', path: '/api/login/request', headers: { Host: host, Origin: `http://${host}` }, body: { email: 'a@b.c' },
  });
  assert.equal(loginReq.status, 404);
});
