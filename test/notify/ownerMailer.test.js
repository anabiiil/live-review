import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createOwnerMailer } from '../../src/notify/ownerMailer.js';

const DELAY = 40;

function setup(overrides = {}) {
  const config = {
    ownerEmail: 'owner@example.test', ownerName: 'Owner', resendApiKey: 're_x', fromEmail: 'lr@example.test',
    publicHost: 'review.example.test', ...overrides,
  };
  /** @type {{to:string, subject:string, text:string}[]} */
  const sent = [];
  const comments = new Map([
    [1, { id: 1, projectId: 7, parentId: null, target: 'live', path: 'src/app.php', line: 3, body: 'Why 2 here?', authorEmail: 'rev@x.test', authorName: 'Rana' }],
    [2, { id: 2, projectId: 7, parentId: 1, target: 'live', path: 'src/app.php', line: 3, body: 'Also this', authorEmail: 'rev@x.test', authorName: null }],
    [3, { id: 3, projectId: 7, parentId: null, target: 'a'.repeat(40), path: 'b.js', line: 9, body: 'x'.repeat(900), authorEmail: 'rev@x.test', authorName: 'Rana' }],
  ]);
  const mailer = createOwnerMailer({
    config,
    sender: { send: async (m) => { sent.push(m); return { ok: true }; } },
    getComment: (id) => comments.get(id) ?? null,
    getProject: (id) => (id === 7 ? { id: 7, slug: 'demo', name: 'Demo' } : null),
    adminPort: () => 4318,
    delayMs: DELAY,
  });
  return { mailer, sent, config };
}

test('one reviewer comment → one email to the owner after the delay, with text and link', async () => {
  const { mailer, sent } = setup();
  mailer.notify({ projectId: 7, target: 'live', commentId: 1, kind: 'create', byOwner: false });
  assert.equal(sent.length, 0, 'waits for the batching delay');
  await sleep(DELAY * 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.test');
  assert.equal(sent[0].subject, 'Rana commented on Demo');
  assert.match(sent[0].text, /src\/app\.php:3/);
  assert.match(sent[0].text, /Why 2 here\?/);
  assert.match(sent[0].text, /http:\/\/localhost:4318\/demo\/live#c-1/);
});

test('several comments within the delay → one digest email', async () => {
  const { mailer, sent } = setup();
  mailer.notify({ projectId: 7, target: 'live', commentId: 1, kind: 'create', byOwner: false });
  mailer.notify({ projectId: 7, target: 'live', commentId: 2, kind: 'reply', byOwner: false });
  mailer.notify({ projectId: 7, target: 'a'.repeat(40), commentId: 3, kind: 'create', byOwner: false });
  await sleep(DELAY * 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, '3 new comments on LiveReview');
  assert.match(sent[0].text, /rev@x\.test replied/);
  assert.match(sent[0].text, /\/demo\/commit\/a{40}#c-3/);
  assert.ok(!sent[0].text.includes('x'.repeat(600)), 'long bodies are shortened');
});

test('ignores owner comments, edits, resolves and deletes', async () => {
  const { mailer, sent } = setup();
  mailer.notify({ projectId: 7, target: 'live', commentId: 1, kind: 'create', byOwner: true });
  for (const kind of ['edit', 'resolve', 'delete']) mailer.notify({ projectId: 7, target: 'live', commentId: 1, kind, byOwner: false });
  await sleep(DELAY * 3);
  assert.equal(sent.length, 0);
});

test('does nothing when email or owner email is not configured', async () => {
  for (const over of [{ resendApiKey: '' }, { fromEmail: '' }, { ownerEmail: '' }]) {
    const { mailer, sent } = setup(over);
    mailer.notify({ projectId: 7, target: 'live', commentId: 1, kind: 'create', byOwner: false });
    await sleep(DELAY * 3);
    assert.equal(sent.length, 0, JSON.stringify(over));
  }
});

test('a comment deleted before the email goes out is skipped', async () => {
  const { mailer, sent } = setup();
  mailer.notify({ projectId: 7, target: 'live', commentId: 99, kind: 'create', byOwner: false });
  await sleep(DELAY * 3);
  assert.equal(sent.length, 0);
});

test('close() sends what is pending right away', async () => {
  const { mailer, sent } = setup();
  mailer.notify({ projectId: 7, target: 'live', commentId: 1, kind: 'create', byOwner: false });
  await mailer.close();
  assert.equal(sent.length, 1);
});

test('a send failure is logged, never thrown', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const mailer = createOwnerMailer({
      config: { ownerEmail: 'o@x.test', resendApiKey: 'k', fromEmail: 'f@x.test' },
      sender: { send: async () => ({ ok: false, error: 'Resend 403: nope' }) },
      getComment: () => ({ id: 1, projectId: 7, parentId: null, target: 'live', path: 'a', line: 1, body: 'b', authorEmail: 'r@x.test', authorName: null }),
      getProject: () => ({ id: 7, slug: 'demo', name: 'Demo' }),
      adminPort: () => 4318,
      delayMs: DELAY,
    });
    mailer.notify({ projectId: 7, target: 'live', commentId: 1, kind: 'create', byOwner: false });
    await mailer.close();
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Resend 403/);
  } finally {
    console.error = orig;
  }
});
