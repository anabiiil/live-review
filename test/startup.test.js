import '../test/helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTunnel, stopTunnel, CLOUDFLARED_HINT } from '../src/tunnel.js';
import { openBrowser } from '../src/openBrowser.js';
import { request } from './helpers/http.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'livereview.js');
const quiet = join(root, 'src', 'quietSqlite.js');

/** A fake child process that records how it was spawned. */
function fakeSpawn(calls, behavior = 'spawn') {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.unref = () => {};
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ command, args, options, child });
    setImmediate(() => {
      if (behavior === 'enoent') child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }));
      else child.emit('spawn');
    });
    return child;
  };
}

test('startTunnel without a tunnel name does nothing', async () => {
  const calls = [];
  const lines = [];
  assert.equal(await startTunnel({ tunnelName: '', publicPort: 4317 }, { spawn: fakeSpawn(calls), log: (l) => lines.push(l) }), null);
  assert.equal(await startTunnel({ publicPort: 4317 }, { spawn: fakeSpawn(calls), log: (l) => lines.push(l) }), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(lines, []);
});

test('startTunnel runs cloudflared visibly with the exact argument list and no shell', async () => {
  const calls = [];
  const child = await startTunnel({ tunnelName: 'my-tunnel', publicPort: 4317 }, { spawn: fakeSpawn(calls), log: () => {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'cloudflared');
  assert.deepEqual(calls[0].args, ['tunnel', '--no-autoupdate', 'run', '--url', 'http://127.0.0.1:4317', 'my-tunnel']);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(calls[0].options.windowsHide, false);
  assert.ok(!calls[0].options.shell);
  assert.equal(child, calls[0].child);
  stopTunnel(child);
  assert.equal(child.killed, true);
});

test('startTunnel reports a non-zero exit and does not restart', async () => {
  const calls = [];
  const lines = [];
  const child = await startTunnel({ tunnelName: 't', publicPort: 1 }, { spawn: fakeSpawn(calls), log: (l) => lines.push(l) });
  child.emit('exit', 0);
  assert.deepEqual(lines, []);
  child.emit('exit', 3);
  assert.deepEqual(lines, ['cloudflared stopped (code 3).']);
  assert.equal(calls.length, 1);
});

test('startTunnel with cloudflared missing (injected spawn) prints the install hint and returns null', async () => {
  const lines = [];
  const child = await startTunnel({ tunnelName: 't', publicPort: 1 }, { spawn: fakeSpawn([], 'enoent'), log: (l) => lines.push(l) });
  assert.equal(child, null);
  assert.deepEqual(lines, [CLOUDFLARED_HINT]);
  assert.match(CLOUDFLARED_HINT, /brew install cloudflared/);
  assert.match(CLOUDFLARED_HINT, /winget install --id Cloudflare\.cloudflared/);
});

test('startTunnel with a real missing binary (empty PATH) prints the hint and returns null', async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), 'lr-path-'));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyDir;
  try {
    const lines = [];
    const child = await startTunnel({ tunnelName: 't', publicPort: 1 }, { log: (l) => lines.push(l) });
    assert.equal(child, null);
    assert.deepEqual(lines, [CLOUDFLARED_HINT]);
  } finally {
    process.env.PATH = savedPath;
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test('openBrowser picks the right command per platform and never uses a shell', () => {
  const expected = { darwin: 'open', win32: 'explorer.exe', linux: 'xdg-open', freebsd: 'xdg-open' };
  for (const [platform, command] of Object.entries(expected)) {
    const calls = [];
    let unref = false;
    const spawnFn = (c, a, o) => {
      const child = fakeSpawn(calls)(c, a, o);
      child.unref = () => {
        unref = true;
      };
      return child;
    };
    openBrowser('http://localhost:4318/admin?t=a&b=c d', { spawn: spawnFn, platform });
    assert.equal(calls[0].command, command, platform);
    assert.deepEqual(calls[0].args, ['http://localhost:4318/admin?t=a&b=c d'], platform);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.ok(!calls[0].options.shell);
    assert.equal(unref, true);
    // A launch error is swallowed.
    assert.doesNotThrow(() => calls[0].child.emit('error', new Error('boom')));
  }
});

test('openBrowser ignores a synchronous spawn failure', () => {
  assert.doesNotThrow(() =>
    openBrowser('http://localhost:1/', {
      spawn: () => {
        throw new Error('nope');
      },
    }),
  );
});

/** Run a snippet in a child node process with the production warning filter preloaded. */
async function runWithFilter(code) {
  const child = spawn(process.execPath, ['--import', quiet, '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const [exit] = await once(child, 'exit');
  return { exit, stderr };
}

test('warning filter drops only the node:sqlite ExperimentalWarning', async () => {
  const { exit, stderr } = await runWithFilter(`
    await import('node:sqlite');
    process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
    process.emitWarning('other thing', 'ExperimentalWarning');
    process.emitWarning('x', 'DeprecationWarning');
    process.emitWarning('plain');
  `);
  assert.equal(exit, 0);
  assert.ok(!/SQLite/i.test(stderr), stderr);
  assert.match(stderr, /ExperimentalWarning: other thing/);
  assert.match(stderr, /DeprecationWarning: x/);
  assert.match(stderr, /Warning: plain/);
});

/** A free TCP port on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Start bin/livereview.js with a temporary data dir; resolves once `ready(output)` is true. */
async function startBin(dataDir, ready) {
  const child = spawn(process.execPath, [bin], {
    env: { ...process.env, LIVEREVIEW_DATA_DIR: dataDir, LIVEREVIEW_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { stdout: '', stderr: '' };
  const exited = once(child, 'exit');
  child.stdout.on('data', (d) => (out.stdout += d));
  child.stderr.on('data', (d) => (out.stderr += d));
  const deadline = Date.now() + 15_000;
  while (!ready(out) && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return { child, out, exited };
}

test('bin/livereview.js prints the banner, serves the admin page and exits 0 on SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lr-start-'));
  const publicPort = await freePort();
  const adminPort = await freePort();
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ publicHost: 'review.example.test', publicPort, adminPort }));
  const { child, out, exited } = await startBin(dataDir, (o) => o.stdout.includes('  Public:'));
  try {
    const lines = out.stdout.trim().split('\n');
    assert.equal(lines[0], 'LiveReview is running.');
    const m = /^ {2}Admin \(this computer only\): (http:\/\/localhost:(\d+)\/admin\?t=([A-Za-z0-9_-]+))$/.exec(lines[1]);
    assert.ok(m, lines[1]);
    assert.equal(Number(m[2]), adminPort);
    assert.equal(lines[2], '  Public: https://review.example.test');
    assert.equal(out.stderr, '', 'no warnings on stderr');

    const host = `localhost:${adminPort}`;
    const res = await request(adminPort, { path: `/admin?t=${m[3]}`, headers: { Host: host } });
    assert.equal(res.status, 302);
    assert.ok(res.cookies.lr_owner);
    const page = await request(adminPort, { path: '/admin', headers: { Host: host, Cookie: `lr_owner=${res.cookies.lr_owner}` } });
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>LiveReview Admin<\/title>/);
  } finally {
    child.kill('SIGTERM');
  }
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(out.stderr, '');
  await rm(dataDir, { recursive: true, force: true });
});

test('bin/livereview.js says when nothing is configured yet', { skip: process.platform === 'win32' }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lr-start-'));
  const publicPort = await freePort();
  const adminPort = await freePort();
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ publicPort, adminPort }));
  const { child, out, exited } = await startBin(dataDir, (o) => o.stdout.includes('  Public:'));
  child.kill('SIGINT');
  const [code] = await exited;
  assert.equal(code, 0);
  assert.match(out.stdout, /^ {2}Public: not configured yet — open the admin page to set it up$/m);
  await rm(dataDir, { recursive: true, force: true });
});

test('bin/livereview.js explains a port that is already in use and exits 1', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lr-start-'));
  const publicPort = await freePort();
  const adminPort = await freePort();
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ publicPort, adminPort }));
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(adminPort, '127.0.0.1', resolve));
  try {
    const { out, exited } = await startBin(dataDir, (o) => o.stderr.length > 0);
    const [code] = await exited;
    assert.equal(code, 1);
    assert.equal(out.stderr.trim(), `Port ${adminPort} is already in use. Is LiveReview already running?`);
    assert.equal(out.stdout, '');
  } finally {
    blocker.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
