import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmailSender, inviteEmail, codeEmail } from '../../src/auth/email.js';

function stub(response) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch, calls };
}
const json = (status, body, statusText = '') =>
  new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } });

const MSG = { to: 'alice@example.com', subject: 'Hi', text: 'Body\n' };

test('send POSTs the Resend payload and returns ok', async () => {
  const { fetch, calls } = stub(json(200, { id: 'x' }));
  const sender = createEmailSender({ apiKey: 'KEY', from: 'LiveReview <a@b.c>', fetch });
  assert.deepEqual(await sender.send(MSG), { ok: true });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer KEY');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), {
    from: 'LiveReview <a@b.c>', to: ['alice@example.com'], subject: 'Hi', text: 'Body\n',
  });
  assert.ok(init.signal instanceof AbortSignal);
});

test('422 yields ok:false with status and message', async () => {
  const { fetch } = stub(json(422, { message: 'Invalid from address' }, 'Unprocessable Entity'));
  const res = await createEmailSender({ apiKey: 'KEY', from: 'x', fetch }).send(MSG);
  assert.deepEqual(res, { ok: false, error: 'Resend 422: Invalid from address' });
});

test('non-JSON error body falls back to statusText', async () => {
  const { fetch } = stub(new Response('<html>', { status: 502, statusText: 'Bad Gateway' }));
  const res = await createEmailSender({ apiKey: 'KEY', from: 'x', fetch }).send(MSG);
  assert.deepEqual(res, { ok: false, error: 'Resend 502: Bad Gateway' });
});

test('network failure yields ok:false and never throws', async () => {
  const { fetch } = stub(new TypeError('fetch failed'));
  const res = await createEmailSender({ apiKey: 'KEY', from: 'x', fetch }).send(MSG);
  assert.deepEqual(res, { ok: false, error: 'fetch failed' });
});

test('error text never contains the API key', async () => {
  const { fetch } = stub(json(401, { message: 'bad key' }));
  const res = await createEmailSender({ apiKey: 'SECRET-KEY', from: 'x', fetch }).send(MSG);
  assert.ok(!JSON.stringify(res).includes('SECRET-KEY'));
});

test('missing apiKey or from does not call fetch', async () => {
  for (const cfg of [{ apiKey: '', from: 'x' }, { apiKey: 'k', from: '' }, { from: 'x' }, { apiKey: 'k' }]) {
    const { fetch, calls } = stub(json(200, {}));
    const res = await createEmailSender({ ...cfg, fetch }).send(MSG);
    assert.deepEqual(res, { ok: false, error: 'Email is not configured' });
    assert.equal(calls.length, 0);
  }
});

test('inviteEmail uses the exact copy', () => {
  assert.deepEqual(inviteEmail({ projectName: 'Acme', link: 'https://x.test/invite/abc', ownerName: 'Olivia' }), {
    subject: 'Olivia invited you to review "Acme"',
    text:
      'Olivia invited you to review their work on "Acme" with LiveReview.\n\n' +
      'Open this link to get started:\nhttps://x.test/invite/abc\n\n' +
      'The link works once and expires in 7 days.\n',
  });
});

test('codeEmail uses the exact copy', () => {
  assert.deepEqual(codeEmail('012345'), {
    subject: 'Your LiveReview sign-in code: 012345',
    text:
      'Your LiveReview sign-in code is 012345\n\n' +
      "It expires in 10 minutes. If you didn't ask for it, you can ignore this email.\n",
  });
});
