import '../helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb } from '../../src/db.js';
import { createCodeService } from '../../src/auth/codes.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const MEMBERS = new Set(['alice@example.com', 'bob@example.com']);

function setup() {
  const db = openDb(':memory:');
  const svc = createCodeService(db, { isAllowedEmail: (e) => MEMBERS.has(e) });
  return { db, svc };
}

test('requestCode returns a 6-digit code that verifies exactly once', () => {
  const { svc } = setup();
  const { code } = svc.requestCode('alice@example.com', '1.1.1.1', 1000);
  assert.match(code, /^\d{6}$/);
  assert.equal(svc.verifyCode('alice@example.com', code, 2000), true);
  assert.equal(svc.verifyCode('alice@example.com', code, 3000), false);
});

test('emails are normalized for request and verify', () => {
  const { svc } = setup();
  const { code } = svc.requestCode('  Alice@Example.COM ', '1.1.1.1', 0);
  assert.match(code, /^\d{6}$/);
  assert.equal(svc.verifyCode('ALICE@example.com', ` ${code} `, 1), true);
});

test('code is stored as a SHA-256 hash, never plaintext', () => {
  const { db, svc } = setup();
  const { code } = svc.requestCode('alice@example.com', '1.1.1.1', 0);
  const row = db.prepare('SELECT * FROM login_codes').get();
  assert.equal(row.code_hash, createHash('sha256').update(code).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(`"${code}"`));
});

test('code expires after 10 minutes', () => {
  const { svc } = setup();
  const { code } = svc.requestCode('alice@example.com', '1.1.1.1', 0);
  assert.equal(svc.verifyCode('alice@example.com', code, 10 * MIN), false);
  const second = svc.requestCode('alice@example.com', '1.1.1.1', 20 * MIN).code;
  assert.equal(svc.verifyCode('alice@example.com', second, 20 * MIN + 10 * MIN - 1), true);
});

test('5 wrong attempts burn the code, even for the correct one afterwards', () => {
  const { svc } = setup();
  const { code } = svc.requestCode('alice@example.com', '1.1.1.1', 0);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal(svc.verifyCode('alice@example.com', wrong, 1000 + i), false);
  assert.equal(svc.verifyCode('alice@example.com', code, 2000), false);
});

test('4 wrong attempts then the correct code still verifies', () => {
  const { svc } = setup();
  const { code } = svc.requestCode('alice@example.com', '1.1.1.1', 0);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) svc.verifyCode('alice@example.com', wrong, 1000 + i);
  assert.equal(svc.verifyCode('alice@example.com', code, 2000), true);
});

test('malformed codes count as wrong attempts and never throw', () => {
  const { svc } = setup();
  const { code } = svc.requestCode('alice@example.com', '1.1.1.1', 0);
  for (const bad of ['', 'abc', '12345', '1234567', null, undefined, 123456, {}]) {
    assert.equal(svc.verifyCode('alice@example.com', /** @type {any} */ (bad), 10), false);
  }
  // 8 malformed attempts burned the code
  assert.equal(svc.verifyCode('alice@example.com', code, 20), false);
});

test('verify with no code outstanding is false and does not throw', () => {
  const { svc } = setup();
  assert.equal(svc.verifyCode('alice@example.com', '123456', 0), false);
  assert.equal(svc.verifyCode(/** @type {any} */ (null), '123456', 0), false);
});

test('a new code invalidates the older unused code for that email', () => {
  const { svc } = setup();
  const first = svc.requestCode('alice@example.com', '1.1.1.1', 0).code;
  let second = svc.requestCode('alice@example.com', '1.1.1.1', 1000).code;
  while (second === first) second = svc.requestCode('alice@example.com', '1.1.1.1', 1000).code;
  assert.equal(svc.verifyCode('alice@example.com', first, 2000), false);
  assert.equal(svc.verifyCode('alice@example.com', second, 2000), true);
});

test('a code only verifies for the email it was issued to', () => {
  const { db, svc } = setup();
  svc.requestCode('alice@example.com', '1.1.1.1', 0);
  svc.requestCode('bob@example.com', '1.1.1.1', 0);
  const set = db.prepare('UPDATE login_codes SET code_hash = ? WHERE email = ?');
  set.run(createHash('sha256').update('111111').digest('hex'), 'alice@example.com');
  set.run(createHash('sha256').update('222222').digest('hex'), 'bob@example.com');
  assert.equal(svc.verifyCode('bob@example.com', '111111', 1), false);
  assert.equal(svc.verifyCode('bob@example.com', '222222', 2), true);
  assert.equal(svc.verifyCode('alice@example.com', '111111', 3), true);
});

test('non-member gets code:null but the request is still recorded', () => {
  const { db, svc } = setup();
  assert.deepEqual(svc.requestCode('mallory@example.com', '2.2.2.2', 0), { code: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM login_codes').get().n, 0);
  const rows = db.prepare('SELECT email, ip, at FROM code_requests').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'mallory@example.com');
  assert.equal(rows[0].ip, '2.2.2.2');
});

test('6th request for the same email within an hour is null; window rolls', () => {
  const { db, svc } = setup();
  for (let i = 0; i < 5; i++) {
    assert.match(svc.requestCode('alice@example.com', `10.0.0.${i}`, i * 1000).code, /^\d{6}$/);
  }
  assert.equal(svc.requestCode('alice@example.com', '10.0.0.9', 6000).code, null);
  // the refused request was recorded too
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_requests').get().n, 6);
  // just inside the hour for the first five: still limited
  assert.equal(svc.requestCode('alice@example.com', '10.0.0.9', HOUR - 1).code, null);
  // an hour after all of them: free again
  assert.match(svc.requestCode('alice@example.com', '10.0.0.9', 2 * HOUR).code, /^\d{6}$/);
});

test('a rate-limited request does not issue or invalidate a code', () => {
  const { svc } = setup();
  let last = '';
  for (let i = 0; i < 5; i++) last = svc.requestCode('alice@example.com', `10.0.0.${i}`, i).code;
  assert.equal(svc.requestCode('alice@example.com', '10.0.0.9', 10).code, null);
  assert.equal(svc.verifyCode('alice@example.com', last, 11), true);
});

test('21st request from the same IP within an hour is null, across emails', () => {
  const { svc } = setup();
  for (let i = 0; i < 20; i++) svc.requestCode(`user${i}@example.com`, '3.3.3.3', i);
  assert.equal(svc.requestCode('alice@example.com', '3.3.3.3', 100).code, null);
  assert.match(svc.requestCode('alice@example.com', '4.4.4.4', 100).code, /^\d{6}$/);
});

test('non-member requests count toward limits so they cannot be probed', () => {
  const { svc } = setup();
  for (let i = 0; i < 5; i++) svc.requestCode('mallory@example.com', `10.0.1.${i}`, i);
  assert.equal(svc.requestCode('mallory@example.com', '10.0.1.9', 10).code, null);
});

test('old request rows are pruned opportunistically', () => {
  const { db, svc } = setup();
  svc.requestCode('alice@example.com', '1.1.1.1', 0);
  svc.requestCode('alice@example.com', '1.1.1.1', 2 * HOUR);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM code_requests').get().n, 1);
});
