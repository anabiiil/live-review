import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir, loadConfig, saveConfig, isConfigured } from '../src/config.js';

/** @param {(dir: string) => Promise<void>} fn */
async function withDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lr-config-'));
  const prev = process.env.LIVEREVIEW_DATA_DIR;
  process.env.LIVEREVIEW_DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.LIVEREVIEW_DATA_DIR;
    else process.env.LIVEREVIEW_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/** @param {string} platform @param {() => void} fn */
function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  const prev = process.env.LIVEREVIEW_DATA_DIR;
  const prevAppData = process.env.APPDATA;
  delete process.env.LIVEREVIEW_DATA_DIR;
  process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming';
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', /** @type {PropertyDescriptor} */ (desc));
    if (prev !== undefined) process.env.LIVEREVIEW_DATA_DIR = prev;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
  }
}

test('dataDir honours LIVEREVIEW_DATA_DIR', async () => {
  await withDataDir(async (dir) => {
    assert.equal(dataDir(), dir);
  });
});

test('dataDir per platform', () => {
  withPlatform('darwin', () => {
    assert.equal(dataDir(), join(homedir(), 'Library', 'Application Support', 'LiveReview'));
  });
  withPlatform('win32', () => {
    assert.equal(dataDir(), join('C:\\Users\\x\\AppData\\Roaming', 'LiveReview'));
  });
  withPlatform('linux', () => {
    assert.equal(dataDir(), join(homedir(), '.config', 'livereview'));
  });
});

test('loadConfig on an empty dir returns defaults', async () => {
  await withDataDir(async () => {
    assert.deepEqual(loadConfig(), {
      publicHost: '',
      resendApiKey: '',
      fromEmail: '',
      ownerName: '',
      ownerEmail: '',
      tunnelName: '',
      publicPort: 4317,
      adminPort: 4318,
      ownerEmailNotifications: true,
    });
  });
});

test('saveConfig persists and merges', async () => {
  await withDataDir(async (dir) => {
    const a = saveConfig({ publicHost: 'review.example.com', ownerName: 'Ann' });
    assert.equal(a.publicHost, 'review.example.com');
    assert.equal(a.publicPort, 4317);
    const b = saveConfig({ ownerEmail: 'ann@example.com', ownerName: 'Ann B' });
    assert.equal(b.publicHost, 'review.example.com');
    assert.equal(b.ownerName, 'Ann B');
    assert.deepEqual(loadConfig(), b);
    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.ownerEmail, 'ann@example.com');
  });
});

test('saveConfig creates the data dir if missing', async () => {
  await withDataDir(async (dir) => {
    process.env.LIVEREVIEW_DATA_DIR = join(dir, 'nested', 'deeper');
    saveConfig({ tunnelName: 't' });
    assert.equal(loadConfig().tunnelName, 't');
  });
});

test('saveConfig writes config.json with mode 0600 and leaves no temp files', async () => {
  await withDataDir(async (dir) => {
    saveConfig({ resendApiKey: 're_secret' });
    if (process.platform !== 'win32') {
      const st = await stat(join(dir, 'config.json'));
      assert.equal(st.mode & 0o777, 0o600);
    }
    assert.deepEqual(await readdir(dir), ['config.json']);
  });
});

test('loadConfig throws a clear error naming the file on malformed JSON', async () => {
  await withDataDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), '{ not json');
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /config\.json/);
      return true;
    });
    // must not have been silently reset
    assert.equal(await readFile(join(dir, 'config.json'), 'utf8'), '{ not json');
  });
});

test('loadConfig rejects a non-object config file', async () => {
  await withDataDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), '[1,2]');
    assert.throws(() => loadConfig(), /config\.json/);
  });
});

test('isConfigured needs host and owner; email settings are optional', () => {
  const base = { publicHost: 'h.example.com', ownerName: 'n', ownerEmail: 'o@example.com', resendApiKey: '', fromEmail: '', tunnelName: '', publicPort: 4317, adminPort: 4318 };
  assert.equal(isConfigured(base), true);
  for (const k of ['publicHost', 'ownerName', 'ownerEmail']) {
    assert.equal(isConfigured({ ...base, [k]: '' }), false, k);
  }
});

test('isConfigured with email settings filled', () => {
  const full = {
    publicHost: 'h.example.com',
    resendApiKey: 'k',
    fromEmail: 'f@example.com',
    ownerName: 'n',
    ownerEmail: 'o@example.com',
    tunnelName: '',
    publicPort: 4317,
    adminPort: 4318,
  };
  assert.equal(isConfigured(full), true);
  for (const k of ['publicHost', 'ownerName', 'ownerEmail']) {
    assert.equal(isConfigured({ ...full, [k]: '' }), false, k);
  }
});
