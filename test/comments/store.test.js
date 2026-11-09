import '../helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db.js';
import {
  createCommentStore,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../src/comments/store.js';

const OWNER = { kind: 'owner', email: 'owner@example.com', name: 'Olivia' };
const ALICE = { kind: 'reviewer', email: 'alice@example.com', name: 'Alice' };
const BOB = { kind: 'reviewer', email: 'bob@example.com', name: null };
const ANCHOR = { lineText: 'const a = 1;', before: ['x'], after: ['y'] };

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, slug, name, path, created_at) VALUES(1, 'p', 'P', '/p', 0)").run();
  db.prepare("INSERT INTO projects(id, slug, name, path, created_at) VALUES(2, 'q', 'Q', '/q', 0)").run();
  db.prepare("INSERT INTO users(email, name) VALUES('alice@example.com', 'Alice')").run();
  return { db, store: createCommentStore(db) };
}

/** @param {ReturnType<typeof createCommentStore>} store @param {object} [over] */
function add(store, over = {}) {
  return store.create({
    projectId: 1, target: 'live', path: 'src/a.js', line: 3, side: 'new', anchor: ANCHOR,
    authorEmail: 'Alice@Example.com ', body: ' hello ', now: 1000, ...over,
  });
}

test('create returns a normalized comment with author name', () => {
  const { db, store } = setup();
  const c = add(store);
  assert.deepEqual(c, {
    id: c.id, projectId: 1, parentId: null, target: 'live', path: 'src/a.js', line: 3, side: 'new',
    anchor: ANCHOR, authorEmail: 'alice@example.com', authorName: 'Alice', body: 'hello',
    createdAt: 1000, updatedAt: 1000, resolved: false, outdated: false, rewritten: false, hidden: false,
  });
  assert.equal(add(store, { authorEmail: 'bob@example.com' }).authorName, null);
  assert.deepEqual(store.get(c.id), c);
  assert.equal(store.get(999), null);
  db.close();
});

test('create validates input', () => {
  const { db, store } = setup();
  assert.throws(() => add(store, { body: '   ' }), ValidationError);
  assert.throws(() => add(store, { body: 'x'.repeat(5001) }), ValidationError);
  assert.doesNotThrow(() => add(store, { body: 'x'.repeat(5000) }));
  assert.throws(() => add(store, { side: 'both' }), ValidationError);
  assert.throws(() => add(store, { line: 0 }), ValidationError);
  assert.throws(() => add(store, { line: 1.5 }), ValidationError);
  assert.throws(() => add(store, { anchor: { lineText: 1 } }), ValidationError);
  assert.throws(() => add(store, { projectId: 99 }), NotFoundError);
  db.close();
});

test('comment on a hidden or binary file is rejected', () => {
  const { db, store } = setup();
  assert.throws(() => add(store, { path: '.env' }), ValidationError);
  assert.throws(() => add(store, { path: 'config/prod.env.key' }), ValidationError);
  assert.throws(() => add(store, { path: 'ci.yml', extraHidden: ['*.yml'] }), ValidationError);
  assert.doesNotThrow(() => add(store, { path: 'ci.yml' }));
  const file = { path: 'logo.png', oldPath: null, status: 'added', binary: true, hidden: false, large: false, hunks: [], patch: '' };
  assert.throws(() => add(store, { path: 'logo.png', file }), ValidationError);
  assert.throws(() => add(store, { path: 'x.js', file: { ...file, path: 'x.js', binary: false, hidden: true } }), ValidationError);
  db.close();
});

test('reply inherits project, target and path; replying to a reply goes to the top-level parent', () => {
  const { db, store } = setup();
  const c = add(store, { projectId: 2, target: 'abc1234' });
  const r1 = store.reply(c.id, { authorEmail: 'bob@example.com', body: 'r1', now: 2000 });
  const r2 = store.reply(r1.id, { authorEmail: 'alice@example.com', body: 'r2', now: 2000 });
  for (const r of [r1, r2]) {
    assert.equal(r.projectId, 2);
    assert.equal(r.target, 'abc1234');
    assert.equal(r.path, 'src/a.js');
    assert.equal(r.parentId, c.id);
  }
  assert.throws(() => store.reply(999, { authorEmail: 'a@b.c', body: 'x' }), NotFoundError);
  assert.throws(() => store.reply(c.id, { authorEmail: 'a@b.c', body: '' }), ValidationError);
  const [thread] = store.forTarget(2, 'abc1234');
  assert.deepEqual(thread.replies.map((r) => r.id), [r1.id, r2.id]);
  assert.equal(thread.replies[1].authorName, 'Alice');
  db.close();
});

test('only the author can edit', () => {
  const { db, store } = setup();
  const c = add(store);
  assert.throws(() => store.edit(c.id, BOB, 'nope'), ForbiddenError);
  assert.throws(() => store.edit(c.id, OWNER, 'nope'), ForbiddenError);
  const e = store.edit(c.id, { ...ALICE, email: 'ALICE@example.com' }, '  edited  ', 5000);
  assert.equal(e.body, 'edited');
  assert.equal(e.updatedAt, 5000);
  assert.equal(e.createdAt, 1000);
  assert.throws(() => store.edit(c.id, ALICE, ''), ValidationError);
  assert.throws(() => store.edit(999, ALICE, 'x'), NotFoundError);
  db.close();
});

test('owner can resolve a reviewer comment; strangers cannot; replies cannot be resolved', () => {
  const { db, store } = setup();
  const c = add(store);
  assert.throws(() => store.setResolved(c.id, BOB, true), ForbiddenError);
  assert.equal(store.setResolved(c.id, OWNER, true).resolved, true);
  assert.equal(store.setResolved(c.id, ALICE, false).resolved, false);
  const r = store.reply(c.id, { authorEmail: 'bob@example.com', body: 'x' });
  assert.throws(() => store.setResolved(r.id, OWNER, true), ValidationError);
  db.close();
});

test('delete: author or owner; deleting a thread removes its replies', () => {
  const { db, store } = setup();
  const c = add(store);
  const r = store.reply(c.id, { authorEmail: 'bob@example.com', body: 'x' });
  assert.throws(() => store.delete(c.id, BOB), ForbiddenError);
  store.delete(r.id, BOB);
  assert.equal(store.get(r.id), null);
  const r2 = store.reply(c.id, { authorEmail: 'bob@example.com', body: 'y' });
  store.delete(c.id, OWNER);
  assert.equal(store.get(c.id), null);
  assert.equal(store.get(r2.id), null);
  assert.throws(() => store.delete(c.id, OWNER), NotFoundError);
  const own = add(store);
  store.delete(own.id, ALICE);
  assert.equal(store.get(own.id), null);
  db.close();
});

test('forTarget returns top-level threads for one project and target, ordered', () => {
  const { db, store } = setup();
  const b = add(store, { now: 2000, body: 'b' });
  const a = add(store, { now: 1000, body: 'a' });
  add(store, { target: 'abc1234' });
  add(store, { projectId: 2 });
  const threads = store.forTarget(1, 'live');
  assert.deepEqual(threads.map((t) => t.id), [a.id, b.id]);
  assert.deepEqual(threads[0].replies, []);
  store.updatePosition(a.id, { outdated: true });
  assert.equal(store.forTarget(1, 'live').length, 2); // outdated still returned
  db.close();
});

test('openCounts counts unresolved, non-outdated, non-hidden top-level comments', () => {
  const { db, store } = setup();
  add(store, { path: 'a.js' });
  add(store, { path: 'a.js' });
  const resolved = add(store, { path: 'b.js' });
  const outdated = add(store, { path: 'b.js' });
  add(store, { path: 'c.js' });
  add(store, { path: 'c.js', target: 'abc1234' });
  add(store, { path: 'z.js', projectId: 2 });
  store.reply(resolved.id, { authorEmail: 'bob@example.com', body: 'reply is not counted' });
  store.setResolved(resolved.id, OWNER, true);
  store.updatePosition(outdated.id, { outdated: true });
  store.wipeHidden(1, (p) => p === 'c.js');
  assert.deepEqual(store.openCounts(1), { total: 2, byPath: { 'a.js': 2 } });
  db.close();
});

test('openCounts with a target limits byPath but not total', () => {
  const { db, store } = setup();
  add(store, { path: 'a.js' });
  add(store, { path: 'b.js', target: 'abc1234' });
  add(store, { path: 'b.js', target: 'abc1234' });
  assert.deepEqual(store.openCounts(1, 'abc1234'), { total: 3, byPath: { 'b.js': 2 } });
  assert.deepEqual(store.openCounts(1, 'live'), { total: 3, byPath: { 'a.js': 1 } });
  assert.deepEqual(store.openCounts(2), { total: 0, byPath: {} });
  db.close();
});

test('liveActive and commitTargets', () => {
  const { db, store } = setup();
  const live = add(store);
  const out = add(store);
  store.reply(live.id, { authorEmail: 'bob@example.com', body: 'x' });
  add(store, { target: 'bbb2222' });
  add(store, { target: 'aaa1111' });
  add(store, { target: 'aaa1111', line: 9 });
  add(store, { projectId: 2, target: 'ccc3333' });
  store.updatePosition(out.id, { outdated: true });
  assert.deepEqual(store.liveActive(1).map((c) => c.id), [live.id]);
  assert.deepEqual(store.commitTargets(1), ['aaa1111', 'bbb2222']);
  db.close();
});

test('wipeHidden clears anchors and flags only matching top-level comments', () => {
  const { db, store } = setup();
  const yml = add(store, { path: 'ci.yml' });
  const js = add(store, { path: 'a.js' });
  const reply = store.reply(yml.id, { authorEmail: 'bob@example.com', body: 'x' });
  const ids = store.wipeHidden(1, (p) => p.endsWith('.yml'));
  assert.deepEqual(ids, [yml.id]);
  assert.equal(store.get(yml.id).anchor, null);
  assert.equal(store.get(yml.id).hidden, true);
  assert.equal(store.get(reply.id).hidden, true);
  assert.deepEqual(store.get(js.id).anchor, ANCHOR);
  assert.equal(store.get(js.id).hidden, false);
  assert.deepEqual(store.wipeHidden(1, (p) => p.endsWith('.yml')), []); // idempotent
  db.close();
});

test('setRewritten flags a commit target, and rewrittenThreads returns them', () => {
  const { db, store } = setup();
  const c = add(store, { target: 'abc1234' });
  add(store, { target: 'def5678' });
  const r = store.reply(c.id, { authorEmail: 'bob@example.com', body: 'x' });
  assert.deepEqual(store.setRewritten(1, 'abc1234', true), [c.id]);
  assert.deepEqual(store.setRewritten(1, 'abc1234', true), []);
  const threads = store.rewrittenThreads(1);
  assert.deepEqual(threads.map((t) => t.id), [c.id]);
  assert.equal(threads[0].rewritten, true);
  assert.equal(threads[0].replies[0].id, r.id);
  assert.equal(threads[0].replies[0].rewritten, true);
  assert.deepEqual(store.setRewritten(1, 'abc1234', false), [c.id]);
  assert.deepEqual(store.rewrittenThreads(1), []);
  db.close();
});

test('updatePosition moves replies with their thread', () => {
  const { db, store } = setup();
  const c = add(store);
  const r = store.reply(c.id, { authorEmail: 'bob@example.com', body: 'x' });
  store.updatePosition(c.id, { target: 'abc1234', line: 8, anchor: { ...ANCHOR, lineText: 'moved' } });
  assert.equal(store.get(c.id).target, 'abc1234');
  assert.equal(store.get(c.id).line, 8);
  assert.equal(store.get(c.id).anchor.lineText, 'moved');
  assert.equal(store.get(r.id).target, 'abc1234');
  assert.equal(store.forTarget(1, 'abc1234')[0].replies.length, 1);
  db.close();
});
