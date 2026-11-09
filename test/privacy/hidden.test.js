import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HIDDEN, isHidden, redactFiles } from '../../src/privacy/hidden.js';

/** @returns {import('../../src/types.js').FileDiff} */
function file(path, over = {}) {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    hidden: false,
    large: false,
    hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'add', oldNo: null, newNo: 1, text: 'SECRET=1' }] }],
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+SECRET=1\n`,
    ...over,
  };
}

test('DEFAULT_HIDDEN is the exact specified list', () => {
  assert.deepEqual(DEFAULT_HIDDEN, [
    '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks',
    'id_rsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
    'credentials*.json', '*secret*', '*.kdbx', 'auth.json',
  ]);
});

test('isHidden is true for secret-looking paths', () => {
  for (const p of [
    '.env', 'config/.env.production', 'certs/server.PEM', 'id_ed25519.pub',
    'app/credentials-prod.json', 'src/client_secret.ts', 'composer/auth.json',
    'deploy/.NPMRC', 'keys/my.key', 'vault.kdbx',
  ]) {
    assert.equal(isHidden(p), true, p);
  }
});

test('isHidden is false for ordinary paths', () => {
  for (const p of ['environment.ts', 'src/keyboard.js', 'README.md', 'src/env/index.js', 'monkey.txt']) {
    assert.equal(isHidden(p), false, p);
  }
});

test('only the basename is matched, not directory names', () => {
  assert.equal(isHidden('secrets/readme.md'), false);
  assert.equal(isHidden('.env/readme.md'), false);
});

test('extra basename globs are honoured', () => {
  assert.equal(isHidden('a/b.yml'), false);
  assert.equal(isHidden('a/b.yml', ['*.yml']), true);
  assert.equal(isHidden('a/B.YML', ['*.yml']), true);
  assert.equal(isHidden('a/b.yaml', ['*.yml']), false);
});

test('glob metacharacters other than * are literal', () => {
  assert.equal(isHidden('a/x.yml', ['x.y?l']), false);
  assert.equal(isHidden('a/x.y?l', ['x.y?l']), true);
  assert.equal(isHidden('a/xzyml', ['x.yml']), false);
});

test('redactFiles hides matches and leaves the rest untouched', () => {
  const env = file('.env');
  const ok = file('src/a.js');
  const out = redactFiles([env, ok]);
  assert.equal(out.length, 2);
  assert.equal(out[0].hidden, true);
  assert.deepEqual(out[0].hunks, []);
  assert.equal(out[0].patch, 'diff --git a/.env b/.env\n');
  assert.equal(out[0].path, '.env');
  assert.equal(out[1], ok);
  assert.equal(out[1].hidden, false);
  assert.equal(out[1].hunks.length, 1);
});

test('redactFiles does not mutate its input', () => {
  const env = file('.env');
  redactFiles([env]);
  assert.equal(env.hidden, false);
  assert.equal(env.hunks.length, 1);
  assert.match(env.patch, /SECRET=1/);
});

test('redactFiles hides a renamed file whose oldPath is hidden', () => {
  const renamed = file('config/settings.txt', { oldPath: '.env', status: 'renamed' });
  const [out] = redactFiles([renamed]);
  assert.equal(out.hidden, true);
  assert.deepEqual(out.hunks, []);
  assert.equal(out.status, 'renamed');
  assert.equal(out.oldPath, '.env');
  assert.equal(out.patch, 'diff --git a/.env b/config/settings.txt\n');
  assert.doesNotMatch(out.patch, /SECRET/);
});

test('redactFiles keeps binary and large flags and honours extra globs', () => {
  const k = file('x/server.key', { binary: true, large: true });
  const y = file('conf/app.yml');
  const out = redactFiles([k, y], ['*.yml']);
  assert.equal(out[0].binary, true);
  assert.equal(out[0].large, true);
  assert.equal(out[0].hidden, true);
  assert.equal(out[1].hidden, true);
});

test('names containing line terminators cannot escape a glob', () => {
  assert.equal(isHidden('a/x\ny.pem'), true);
  assert.equal(isHidden('a\nsecret'), true);
  assert.equal(isHidden('a/x\r\ny z.key'), true);
  assert.equal(isHidden('a/b\nc.yml', ['*.yml']), true);
});
