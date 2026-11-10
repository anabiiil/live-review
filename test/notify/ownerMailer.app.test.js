import '../helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';
import { request } from '../helpers/http.js';

const HOST = 'review.example.test';

test('a reviewer comment through the API emails the owner (batched), owner comments do not', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-mail-'));
  const repo = await makeTmpRepo();
  /** @type {{to:string, subject:string, text:string}[]} */
  const sent = [];
  const config = {
    publicHost: HOST, ownerName: 'Owner', ownerEmail: 'owner@example.test', fromEmail: 'lr@example.test',
    resendApiKey: 're_test', tunnelName: '', publicPort: 0, adminPort: 0,
  };
  const app = createApp({
    config, db: openDb(join(dataDir, 'lr.db')), ownerMailDelayMs: 50,
    emailSender: { send: async (m) => { sent.push(m); return { ok: true }; } },
  });
  try {
    const { publicPort, adminPort } = await app.start();
    await repo.write('a.txt', 'one\ntwo\n');
    await repo.commit('init');
    await repo.write('a.txt', 'one\nTWO\n');
    const project = app.services.projects.add({ path: repo.dir, name: 'Demo' });
    const p = await project;
    const token = app.services.projects.createInvite(p.id, 'rev@example.test', Date.now());
    const pub = { Host: HOST, Origin: `https://${HOST}` };
    const inv = await request(publicPort, { method: 'POST', path: `/invite/${token}`, headers: pub, raw: '', });
    const rev = `lr_session=${inv.cookies.lr_session}`;
    assert.ok(inv.cookies.lr_session, `invite redeemed (${inv.status})`);

    const c = await request(publicPort, {
      method: 'POST', path: '/api/p/demo/comments', headers: { ...pub, Cookie: rev },
      body: { target: 'live', path: 'a.txt', line: 2, side: 'new', body: 'Why uppercase?' },
    });
    assert.equal(c.status, 201, c.body);

    // Owner comment (admin listener) must not email.
    const aHost = `localhost:${adminPort}`;
    const ex = await request(adminPort, { path: `/admin?t=${app.services.owner.issueOneTime()}`, headers: { Host: aHost } });
    const own = await request(adminPort, {
      method: 'POST', path: '/api/p/demo/comments', headers: { Host: aHost, Origin: `http://${aHost}`, Cookie: `lr_owner=${ex.cookies.lr_owner}` },
      body: { target: 'live', path: 'a.txt', line: 1, side: 'new', body: 'owner note' },
    });
    assert.equal(own.status, 201, own.body);

    await sleep(300);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'owner@example.test');
    assert.match(sent[0].subject, /commented on Demo/);
    assert.match(sent[0].text, /a\.txt:2/);
    assert.match(sent[0].text, /Why uppercase\?/);
    assert.ok(!sent[0].text.includes('owner note'));
  } finally {
    await app.stop();
    await repo.cleanup();
    await rm(dataDir, { recursive: true, force: true });
  }
});
