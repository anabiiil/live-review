import '../helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../../src/db.js';
import { createSessionService, createOwnerAuth } from '../../src/auth/sessions.js';

const DAY = 86_400_000;
const setup = () => {
  const db = openDb(':memory:');
  return { db, sessions: createSessionService(db) };
};

test('session create/lookup returns the normalized email', () => {
  const { sessions } = setup();
  const token = sessions.create(' Alice@Example.com ', 0);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(sessions.lookup(token, 1000), { email: 'alice@example.com' });
});

test('token is stored only as a SHA-256 hash', () => {
  const { db, sessions } = setup();
  const token = sessions.create('a@example.com', 0);
  const row = db.prepare('SELECT * FROM sessions').get();
  assert.equal(row.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.notEqual(row.token_hash, token);
});

test('session is valid until 30 days, then null', () => {
  const { sessions } = setup();
  const token = sessions.create('a@example.com', 0);
  assert.deepEqual(sessions.lookup(token, 30 * DAY - 1), { email: 'a@example.com' });
  assert.equal(sessions.lookup(token, 30 * DAY), null);
});

test('garbage tokens return null without throwing', () => {
  const { sessions } = setup();
  for (const bad of ['', 'nope', null, undefined, 42, {}, 'x'.repeat(10_000)]) {
    assert.equal(sessions.lookup(/** @type {any} */ (bad), 0), null);
  }
});

test('revoke removes one session; revokeAllFor removes every session for the email', () => {
  const { sessions } = setup();
  const a1 = sessions.create('a@example.com', 0);
  const a2 = sessions.create('A@example.com', 0);
  const b = sessions.create('b@example.com', 0);
  sessions.revoke(a1);
  assert.equal(sessions.lookup(a1, 1), null);
  assert.ok(sessions.lookup(a2, 1));
  sessions.revokeAllFor(' A@EXAMPLE.com');
  assert.equal(sessions.lookup(a2, 1), null);
  assert.ok(sessions.lookup(b, 1));
  assert.doesNotThrow(() => sessions.revoke(/** @type {any} */ (undefined)));
});

test('expired sessions are pruned opportunistically', () => {
  const { db, sessions } = setup();
  sessions.create('a@example.com', 0);
  sessions.create('b@example.com', 31 * DAY);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});

test('tokens are unique', () => {
  const { sessions } = setup();
  assert.notEqual(sessions.create('a@example.com', 0), sessions.create('a@example.com', 0));
});

test('owner one-time token exchanges exactly once', () => {
  const owner = createOwnerAuth();
  const one = owner.issueOneTime(0);
  assert.match(one, /^[A-Za-z0-9_-]{43}$/);
  const session = owner.exchange(one, 1000);
  assert.match(session, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(owner.exchange(one, 2000), null);
  assert.equal(owner.isOwnerSession(session), true);
});

test('owner one-time token expires after 10 minutes', () => {
  const owner = createOwnerAuth();
  const one = owner.issueOneTime(0);
  assert.equal(owner.exchange(one, 10 * 60_000), null);
  assert.equal(owner.exchange(one, 1), null); // expired attempt still consumed it
});

test('owner exchange and isOwnerSession reject garbage and the one-time token itself', () => {
  const owner = createOwnerAuth();
  const one = owner.issueOneTime();
  assert.equal(owner.exchange('nope'), null);
  assert.equal(owner.exchange(/** @type {any} */ (null)), null);
  assert.equal(owner.isOwnerSession(one), false);
  assert.equal(owner.isOwnerSession('nope'), false);
  assert.equal(owner.isOwnerSession(/** @type {any} */ (undefined)), false);
  assert.ok(owner.exchange(one));
});

test('separate owner auth instances do not share tokens', () => {
  const a = createOwnerAuth();
  const b = createOwnerAuth();
  const s = a.exchange(a.issueOneTime());
  assert.equal(b.isOwnerSession(s), false);
});
