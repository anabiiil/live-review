import '../helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';
import { createProjectStore, slugify, StoreError } from '../../src/projects/store.js';
import { RepoError } from '../../src/git/repo.js';

const DAY = 24 * 3600 * 1000;

/**
 * @param {number} nRepos
 * @param {(ctx:{db:any, store:ReturnType<typeof createProjectStore>, repos:Awaited<ReturnType<typeof makeTmpRepo>>[]})=>Promise<void>} fn
 */
async function withStore(nRepos, fn) {
  const repos = [];
  for (let i = 0; i < nRepos; i++) {
    const r = await makeTmpRepo();
    await r.write('a.txt', 'a');
    await r.commit('init');
    repos.push(r);
  }
  const db = openDb(':memory:');
  try {
    await fn({ db, store: createProjectStore(db), repos });
  } finally {
    db.close();
    await Promise.all(repos.map((r) => r.cleanup()));
  }
}

/** @param {Promise<unknown>|(()=>unknown)} p @param {string} code */
async function rejectsWithCode(p, code) {
  await assert.rejects(typeof p === 'function' ? async () => p() : p, (e) => e instanceof StoreError && e.code === code);
}

test('add rejects a subfolder and non-repos with RepoError', async () => {
  await withStore(1, async ({ store, repos }) => {
    await repos[0].write('sub/x.txt', 'x');
    await assert.rejects(store.add({ path: join(repos[0].dir, 'sub'), name: 'Sub' }), RepoError);
    await assert.rejects(store.add({ path: '/definitely/not/here', name: 'X' }), RepoError);
    assert.deepEqual(store.list(), []);
  });
});

test('add stores the repo root and returns the project shape', async () => {
  await withStore(1, async ({ store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'Nwc Legal' });
    assert.equal(p.slug, 'nwc-legal');
    assert.equal(p.name, 'Nwc Legal');
    assert.equal(p.path, repos[0].dir);
    assert.deepEqual(p.extraHidden, []);
    assert.equal(typeof p.createdAt, 'number');
    assert.deepEqual(store.get(p.id), p);
    assert.deepEqual(store.bySlug('nwc-legal'), p);
    assert.equal(store.get(999), null);
    assert.equal(store.bySlug('nope'), null);
    assert.deepEqual(store.list(), [p]);
  });
});

test('duplicate path is rejected with code duplicate-path', async () => {
  await withStore(1, async ({ store, repos }) => {
    await store.add({ path: repos[0].dir, name: 'One' });
    await rejectsWithCode(store.add({ path: repos[0].dir, name: 'Two' }), 'duplicate-path');
  });
});

test('slug collisions get -2, -3; explicit reserved/invalid slugs are rejected', async () => {
  await withStore(3, async ({ store, repos }) => {
    const a = await store.add({ path: repos[0].dir, name: 'Nwc Legal' });
    const b = await store.add({ path: repos[1].dir, name: 'Nwc Legal' });
    const c = await store.add({ path: repos[2].dir, name: 'nwc legal' });
    assert.deepEqual([a.slug, b.slug, c.slug], ['nwc-legal', 'nwc-legal-2', 'nwc-legal-3']);
    await rejectsWithCode(store.add({ path: repos[0].dir, name: 'Z', slug: 'admin' }), 'invalid-slug');
    for (const bad of ['Has Caps', 'a--b', '-a', 'a-', 'a/b', 'x'.repeat(49)]) {
      await rejectsWithCode(store.add({ path: repos[0].dir, name: 'Z', slug: bad }), 'invalid-slug');
    }
    await assert.rejects(async () => store.update(a.id, { slug: 'ws' }), (e) => e.code === 'invalid-slug');
    await assert.rejects(async () => store.update(a.id, { slug: 'nwc-legal-2' }), (e) => e.code === 'slug-taken');
  });
});

test('add with an explicit valid slug uses it', async () => {
  await withStore(1, async ({ store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'Whatever', slug: 'my-slug' });
    assert.equal(p.slug, 'my-slug');
  });
});

test('slugify: ASCII folding, non-Latin fallback, reserved, length cap', () => {
  assert.equal(slugify('Nwc Legal'), 'nwc-legal');
  assert.equal(slugify('  Café -- Crème!! '), 'cafe-creme');
  assert.equal(slugify('مشروع'), 'project-1');
  assert.equal(slugify('日本語', (s) => s === 'project-1' || s === 'project-2'), 'project-3');
  assert.equal(slugify('Admin'), 'admin-2');
  const long = slugify('a'.repeat(100));
  assert.ok(long.length <= 48 && /^a+$/.test(long));
  const taken = slugify('a'.repeat(100), (s) => s === 'a'.repeat(48));
  assert.equal(taken.length, 48);
  assert.ok(taken.endsWith('-2'));
});

test('non-Latin project names fall back to project-{n}', async () => {
  await withStore(2, async ({ store, repos }) => {
    const a = await store.add({ path: repos[0].dir, name: 'مراجعة' });
    const b = await store.add({ path: repos[1].dir, name: '日本語' });
    assert.deepEqual([a.slug, b.slug], ['project-1', 'project-2']);
  });
});

test('update changes name and validates/stores extraHidden as parsed array', async () => {
  await withStore(1, async ({ store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'One' });
    const u = store.update(p.id, { name: 'Renamed', extraHidden: ['*.log', 'private.*'] });
    assert.equal(u.name, 'Renamed');
    assert.equal(u.slug, p.slug);
    assert.deepEqual(u.extraHidden, ['*.log', 'private.*']);
    assert.deepEqual(store.get(p.id).extraHidden, ['*.log', 'private.*']);
    assert.deepEqual(store.list()[0].extraHidden, ['*.log', 'private.*']);
    for (const bad of ['x', [''], ['a/b'], [1], null]) {
      assert.throws(() => store.update(p.id, { extraHidden: /** @type {any} */ (bad) }), (e) => e.code === 'invalid-extra-hidden');
    }
    assert.deepEqual(store.get(p.id).extraHidden, ['*.log', 'private.*']);
    assert.throws(() => store.update(999, { name: 'x' }), (e) => e.code === 'not-found');
  });
});

test('remove deletes project with members and invites', async () => {
  await withStore(1, async ({ db, store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'One' });
    store.createInvite(p.id, 'a@x.com', 0);
    assert.equal(store.remove(p.id), true);
    assert.equal(store.remove(p.id), false);
    assert.equal(store.get(p.id), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM members').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invites').get().c, 0);
  });
});

test('members are case-insensitive and idempotent', async () => {
  await withStore(1, async ({ store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'One' });
    store.addMember(p.id, 'A@X.com');
    store.addMember(p.id, ' a@x.COM ');
    assert.deepEqual(store.members(p.id), ['a@x.com']);
    assert.equal(store.isMember(p.id, 'a@x.com'), true);
    assert.equal(store.isMember(p.id, 'A@X.COM'), true);
    assert.equal(store.isMember(p.id, 'b@x.com'), false);
    assert.throws(() => store.addMember(p.id, 'not-an-email'), (e) => e.code === 'invalid-email');
    assert.throws(() => store.addMember(999, 'a@x.com'), (e) => e.code === 'not-found');
    store.removeMember(p.id, 'A@x.com');
    assert.deepEqual(store.members(p.id), []);
  });
});

test('owner sees all projects; reviewer only memberships; canView follows', async () => {
  await withStore(2, async ({ store, repos }) => {
    const p1 = await store.add({ path: repos[0].dir, name: 'One' });
    const p2 = await store.add({ path: repos[1].dir, name: 'Two' });
    store.addMember(p1.id, 'rev@x.com');
    const owner = { kind: /** @type {const} */ ('owner'), email: 'me@x.com', name: null };
    const rev = { kind: /** @type {const} */ ('reviewer'), email: 'REV@x.com', name: 'Rev' };
    const stranger = { kind: /** @type {const} */ ('reviewer'), email: 'nobody@x.com', name: null };
    assert.deepEqual(store.projectsFor(owner).map((p) => p.id), [p1.id, p2.id]);
    assert.deepEqual(store.projectsFor(rev).map((p) => p.id), [p1.id]);
    assert.deepEqual(store.projectsFor(stranger), []);
    assert.equal(store.canView(owner, p2.id), true);
    assert.equal(store.canView(rev, p1.id), true);
    assert.equal(store.canView(rev, p2.id), false);
    assert.equal(store.canView(stranger, p1.id), false);
    // nonexistent behaves like not-a-member
    assert.equal(store.canView(owner, 999), false);
    assert.equal(store.canView(rev, 999), false);
  });
});

test('invite: redeem works once, second redeem is null', async () => {
  await withStore(1, async ({ store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'One' });
    store.addMember(p.id, 'a@x.com');
    const token = store.createInvite(p.id, 'A@X.com', 1000);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(store.redeemInvite(token, 2000), { email: 'a@x.com', projectId: p.id });
    assert.equal(store.redeemInvite(token, 3000), null);
  });
});

test('invite: only the SHA-256 hash is stored', async () => {
  await withStore(1, async ({ db, store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'One' });
    const token = store.createInvite(p.id, 'a@x.com', 1000);
    const rows = db.prepare('SELECT * FROM invites').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(rows).includes(token));
    assert.equal(rows[0].expires_at, 1000 + 7 * DAY);
  });
});

test('invite: expires after 7 days', async () => {
  await withStore(1, async ({ store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'One' });
    store.addMember(p.id, 'a@x.com');
    const t1 = store.createInvite(p.id, 'a@x.com', 0);
    assert.equal(store.redeemInvite(t1, 8 * DAY), null);
    const t2 = store.createInvite(p.id, 'a@x.com', 0);
    assert.notEqual(store.redeemInvite(t2, 7 * DAY - 1), null);
  });
});

test('invite: regenerating invalidates the old token', async () => {
  await withStore(1, async ({ store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'One' });
    store.addMember(p.id, 'a@x.com');
    const old = store.createInvite(p.id, 'a@x.com', 0);
    const fresh = store.createInvite(p.id, 'a@x.com', 10);
    assert.notEqual(old, fresh);
    assert.equal(store.redeemInvite(old, 20), null);
    assert.deepEqual(store.redeemInvite(fresh, 20), { email: 'a@x.com', projectId: p.id });
  });
});

test('invite: removed member token is null', async () => {
  await withStore(1, async ({ db, store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'One' });
    store.addMember(p.id, 'a@x.com');
    const token = store.createInvite(p.id, 'a@x.com', 0);
    store.removeMember(p.id, 'a@x.com');
    assert.equal(store.redeemInvite(token, 10), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invites').get().c, 0);
  });
});

test('invite: garbage tokens return null without throwing', async () => {
  await withStore(1, async ({ store }) => {
    for (const t of ['', 'garbage', '%%%', 'a'.repeat(5000), /** @type {any} */ (null), /** @type {any} */ (undefined), /** @type {any} */ (42)]) {
      assert.equal(store.redeemInvite(t, 0), null);
    }
  });
});

test('invite: redeem requires the membership to still exist', async () => {
  await withStore(1, async ({ db, store, repos }) => {
    const p = await store.add({ path: repos[0].dir, name: 'One' });
    const token = store.createInvite(p.id, 'a@x.com', 0);
    db.prepare('DELETE FROM members WHERE project_id = ?').run(p.id); // bypass removeMember
    assert.equal(store.redeemInvite(token, 10), null);
  });
});
