import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupSteps, errorMessage, configError, missingFields, inviteStatus, unreadTitle,
  parsePatterns, tabFromHash, normalizeEmail,
  createDraftState, setDraft, getDraft, dropDrafts, rememberFocus, takeFocus,
} from '../../public/js/admin/helpers.js';

test('setupSteps: six steps, exact commands, values substituted', () => {
  const steps = setupSteps({ publicHost: 'review.acme.dev', publicPort: 4400 });
  assert.equal(steps.length, 6);
  assert.deepEqual(steps[0].code, [
    { label: 'macOS', text: 'brew install cloudflared' },
    { label: 'Windows', text: 'winget install --id Cloudflare.cloudflared' },
  ]);
  assert.equal(steps[1].code?.[0].text, 'cloudflared tunnel login');
  assert.equal(steps[2].code?.[0].text, 'cloudflared tunnel create livereview');
  assert.equal(steps[3].code?.[0].text, 'cloudflared tunnel route dns livereview review.acme.dev');
  assert.match(steps[4].text, /`livereview`.*"Cloudflare tunnel name".*http:\/\/127\.0\.0\.1:4400\./);
  assert.match(steps[5].text, /Resend.*verify your domain/);
});

test('setupSteps: placeholder host and default port when unknown', () => {
  const steps = setupSteps({ publicHost: '  ' });
  assert.equal(steps[3].code?.[0].text, 'cloudflared tunnel route dns livereview review.example.com');
  assert.match(steps[4].text, /127\.0\.0\.1:4317\./);
});

test('errorMessage: repo reasons, store codes, server messages, fallbacks', () => {
  const e = (/** @type {any} */ data, status = 400) => errorMessage({ status, data });
  assert.equal(e({ error: 'invalid-repo', reason: 'not-a-repo' }), "That folder isn't a git repository");
  assert.equal(e({ error: 'invalid-repo', reason: 'not-root' }), 'Choose the top folder of the repository');
  assert.equal(e({ error: 'invalid-repo', reason: 'forbidden' }), "That folder can't be shared");
  assert.equal(e({ error: 'invalid-repo', reason: 'weird' }), "That folder can't be used");
  assert.equal(e({ error: 'duplicate-path', message: 'x' }), 'This folder has already been added');
  assert.match(e({ error: 'slug-taken' }), /already used/);
  assert.match(e({ error: 'invalid-slug' }), /lowercase/);
  assert.match(e({ error: 'not-configured' }, 409), /Finish setup/);
  assert.equal(e({ error: 'invalid', message: 'publicHost must be a hostname' }), 'publicHost must be a hostname');
  assert.match(e(null, 401), /Not signed in/);
  assert.match(e(null, 500), /did not work/);
  assert.match(errorMessage(undefined), /did not work/);
});

test('configError: names the field the server complained about', () => {
  assert.deepEqual(configError({ data: { error: 'invalid', message: 'publicHost must be a hostname such as review.example.com' } }), {
    field: 'publicHost', message: 'publicHost must be a hostname such as review.example.com',
  });
  assert.equal(configError({ data: { error: 'invalid', message: 'tunnelName may only contain letters' } }).field, 'tunnelName');
  assert.equal(configError({ data: { error: 'invalid', message: 'expected a JSON object' } }).field, null);
});

test('missingFields: email settings optional, but key and sender go together', () => {
  const base = { publicHost: 'a.b.co', ownerName: 'O', ownerEmail: 'o@x.co', fromEmail: '', resendApiKey: '' };
  assert.deepEqual(missingFields(base, { hasResendKey: false }), {});
  assert.deepEqual(missingFields({ ...base, fromEmail: 'f@x.co' }, { hasResendKey: true }), {});
  assert.deepEqual(missingFields({ ...base, fromEmail: 'f@x.co' }, { hasResendKey: false }), { resendApiKey: 'Required when a sender address is set' });
  assert.deepEqual(missingFields({ ...base, resendApiKey: 're_x' }, { hasResendKey: false }), { fromEmail: 'Required when a Resend key is set' });
  assert.deepEqual(missingFields(base, { hasResendKey: true }), { fromEmail: 'Required when a Resend key is set' });
  assert.deepEqual(Object.keys(missingFields({ ...base, publicHost: ' ', ownerName: '' }, { hasResendKey: false })).sort(), ['ownerName', 'publicHost']);
});

test('inviteStatus: sent vs failed wording', () => {
  assert.deepEqual(inviteStatus({ emailSent: true }), { ok: true, text: 'Invite email sent' });
  assert.deepEqual(inviteStatus({ emailSent: false, emailError: 'Resend 401: bad key' }), {
    ok: false, text: 'Email not sent: Resend 401: bad key — send the link yourself',
  });
});

test('unreadTitle', () => {
  assert.equal(unreadTitle(0), 'LiveReview Admin');
  assert.equal(unreadTitle(3), '(3) LiveReview Admin');
});

test('parsePatterns trims, drops blanks and duplicates', () => {
  assert.deepEqual(parsePatterns(' *.log \r\n\n*.log\nsecrets*\n'), ['*.log', 'secrets*']);
  assert.deepEqual(parsePatterns(''), []);
});

test('normalizeEmail matches the server: trim and lowercase', () => {
  assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
});

test('drafts: values survive until dropped; initial is the fallback', () => {
  const d = createDraftState();
  assert.equal(getDraft(d, 'edit-name:1', 'Sample'), 'Sample');
  setDraft(d, 'edit-name:1', 'Renamed');
  setDraft(d, 'edit-slug:1', 'x');
  setDraft(d, 'member:1', 'bob@');
  setDraft(d, 'member:12', 'keep');
  assert.equal(getDraft(d, 'edit-name:1', 'Sample'), 'Renamed');
  setDraft(d, 'edit-name:1', '');
  assert.equal(getDraft(d, 'edit-name:1', 'Sample'), '', 'an emptied field stays empty');
});

test('drafts: dropDrafts removes exactly one form by key prefix', () => {
  const d = createDraftState();
  setDraft(d, 'edit:1:name', 'a');
  setDraft(d, 'edit:1:slug', 'b');
  setDraft(d, 'edit:12:name', 'c');
  setDraft(d, 'member:1', 'd');
  rememberFocus(d, { key: 'edit:1:slug', start: 1, end: 1 });
  dropDrafts(d, 'edit:1');
  assert.deepEqual([...d.values.keys()].sort(), ['edit:12:name', 'member:1']);
  assert.equal(d.focus, null);
});

test('drafts: focus is remembered and handed out once; unrelated focus survives a drop', () => {
  const d = createDraftState();
  rememberFocus(d, { key: 'member:1', start: 3, end: 5 });
  dropDrafts(d, 'edit:1');
  assert.deepEqual(takeFocus(d), { key: 'member:1', start: 3, end: 5 });
  assert.equal(takeFocus(d), null);
});

test('tabFromHash defaults to projects; the v1 inbox address opens comments', () => {
  assert.equal(tabFromHash('#comments'), 'comments');
  assert.equal(tabFromHash('#inbox'), 'comments');
  assert.equal(tabFromHash('#settings'), 'settings');
  assert.equal(tabFromHash(''), 'projects');
  assert.equal(tabFromHash('#nope'), 'projects');
});
