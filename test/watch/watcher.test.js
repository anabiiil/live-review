import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWatcherPool } from '../../src/watch/watcher.js';
import { liveDiff } from '../../src/git/diff.js';
import { runGit } from '../../src/git/run.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';

const DEBOUNCE = 50;
const GRACE = 100;
const SETTLE = 100;
const QUIET = DEBOUNCE * 6;

/**
 * Run `fn` with a fresh repo and a pool that records onChange calls.
 * @param {(ctx: {repo: Awaited<ReturnType<typeof makeTmpRepo>>, pool: ReturnType<typeof createWatcherPool>, calls: number[]}) => Promise<void>} fn
 */
async function withPool(fn) {
  const repo = await makeTmpRepo();
  /** @type {number[]} */
  const calls = [];
  const pool = createWatcherPool({ onChange: (id) => calls.push(id), debounceMs: DEBOUNCE, graceMs: GRACE });
  try {
    await fn({ repo, pool, calls });
  } finally {
    await pool.closeAll();
    await repo.cleanup();
  }
}

/** Wait until `pred()` is true or fail after `ms`. */
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(20);
  }
  assert.fail('timed out waiting for condition');
}

test('writing a file fires one onChange', () =>
  withPool(async ({ repo, pool, calls }) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await pool.acquire(1, repo.dir);
    await sleep(SETTLE);
    await repo.write('b.txt', 'b\n');
    await waitFor(() => calls.length >= 1);
    await sleep(QUIET);
    assert.deepEqual(calls, [1]);
  }));

test('a burst of 200 file writes yields exactly one onChange', () =>
  withPool(async ({ repo, pool, calls }) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await pool.acquire(1, repo.dir);
    await sleep(SETTLE);
    mkdirSync(join(repo.dir, 'burst'));
    for (let i = 0; i < 200; i++) writeFileSync(join(repo.dir, 'burst', `f${i}.txt`), `${i}\n`);
    await waitFor(() => calls.length >= 1);
    await sleep(QUIET);
    assert.deepEqual(calls, [1]);
  }));

test('writes inside ignored and node_modules directories are ignored', () =>
  withPool(async ({ repo, pool, calls }) => {
    await repo.write('.gitignore', 'dist/\n');
    await repo.write('src/a.txt', 'a\n');
    await repo.commit('init');
    await repo.write('dist/out.js', 'x\n');
    await repo.write('node_modules/pkg/index.js', 'x\n');
    await pool.acquire(1, repo.dir);
    await sleep(SETTLE);
    await repo.write('dist/out.js', 'y\n');
    await repo.write('dist/nested/deep.js', 'y\n');
    await repo.write('node_modules/pkg/index.js', 'y\n');
    await sleep(QUIET);
    assert.deepEqual(calls, []);
    await repo.write('src/b.txt', 'b\n');
    await waitFor(() => calls.length >= 1);
    assert.deepEqual(calls, [1]);
  }));

test('a commit fires onChange', () =>
  withPool(async ({ repo, pool, calls }) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await pool.acquire(1, repo.dir);
    await sleep(SETTLE);
    await repo.git('commit', '-q', '--allow-empty', '-m', 'empty');
    await waitFor(() => calls.length >= 1);
    assert.deepEqual(calls.slice(0, 1), [1]);
  }));

test('staging a file fires onChange', () =>
  withPool(async ({ repo, pool, calls }) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await pool.acquire(1, repo.dir);
    await sleep(SETTLE);
    // Content already on disk before staging would be a working tree event too,
    // so stage an existing tracked file's mode change instead of writing.
    await repo.git('update-index', '--chmod=+x', 'a.txt');
    await waitFor(() => calls.length >= 1);
  }));

test('refcounting: two acquires and one release keep the watcher; last release closes after grace', () =>
  withPool(async ({ repo, pool }) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await Promise.all([pool.acquire(7, repo.dir), pool.acquire(7, repo.dir)]);
    assert.deepEqual(pool.active(), [7]);
    pool.release(7);
    await sleep(GRACE * 3);
    assert.deepEqual(pool.active(), [7]);
    pool.release(7);
    assert.deepEqual(pool.active(), [7], 'still open during the grace period');
    await waitFor(() => pool.active().length === 0);
  }));

test('acquire during the grace period cancels the pending close', () =>
  withPool(async ({ repo, pool }) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await pool.acquire(3, repo.dir);
    pool.release(3);
    await sleep(GRACE / 2);
    await pool.acquire(3, repo.dir);
    await sleep(GRACE * 3);
    assert.deepEqual(pool.active(), [3]);
    pool.release(3);
    await waitFor(() => pool.active().length === 0);
  }));

test('onChange exceptions are swallowed and the watcher keeps running', async () => {
  const repo = await makeTmpRepo();
  let n = 0;
  const pool = createWatcherPool({
    onChange: () => {
      n++;
      throw new Error('boom');
    },
    debounceMs: DEBOUNCE,
    graceMs: GRACE,
  });
  const origError = console.error;
  /** @type {unknown[][]} */
  const logged = [];
  console.error = (...args) => void logged.push(args);
  try {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await pool.acquire(1, repo.dir);
    await sleep(SETTLE);
    await repo.write('b.txt', 'b\n');
    await waitFor(() => n >= 1);
    await sleep(QUIET);
    await repo.write('c.txt', 'c\n');
    await waitFor(() => n >= 2);
    assert.equal(logged.length, 1, 'logged once');
  } finally {
    console.error = origError;
    await pool.closeAll();
    await repo.cleanup();
  }
});

test('closeAll closes every watcher, cancels pending debounces and empties active()', () =>
  withPool(async ({ repo, pool, calls }) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await pool.acquire(1, repo.dir);
    await sleep(SETTLE);
    await repo.write('b.txt', 'b\n');
    await sleep(10);
    await pool.closeAll();
    assert.deepEqual(pool.active(), []);
    const before = calls.length;
    await sleep(QUIET);
    assert.equal(calls.length, before);
    await pool.closeAll();
  }));

test('release of an unknown project is a no-op', () =>
  withPool(async ({ pool }) => {
    pool.release(99);
    assert.deepEqual(pool.active(), []);
  }));

test('a failed acquire (not a repo) rejects and leaves no entry', async () => {
  const pool = createWatcherPool({ onChange: () => {}, debounceMs: DEBOUNCE, graceMs: GRACE });
  try {
    await assert.rejects(pool.acquire(5, '/nonexistent-livereview-dir'));
    assert.deepEqual(pool.active(), []);
  } finally {
    await pool.closeAll();
  }
});

test('a commit made in a linked worktree fires onChange', () =>
  withPool(async ({ repo, pool, calls }) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    const wt = `${repo.dir}-wt`;
    await repo.git('worktree', 'add', '-q', '-b', 'side', wt);
    try {
      await pool.acquire(1, wt);
      await sleep(SETTLE);
      await repo.git('-C', wt, 'commit', '-q', '--allow-empty', '-m', 'in worktree');
      await waitFor(() => calls.length >= 1);
    } finally {
      await pool.closeAll();
      await repo.git('worktree', 'remove', '--force', wt);
    }
  }));

test('closeAll still works after the watched root disappears', async () => {
  const repo = await makeTmpRepo();
  const pool = createWatcherPool({ onChange: () => {}, debounceMs: DEBOUNCE, graceMs: GRACE });
  try {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await pool.acquire(1, repo.dir);
    await repo.cleanup();
    await sleep(QUIET);
    pool.release(1);
    await pool.closeAll();
    assert.deepEqual(pool.active(), []);
  } finally {
    await pool.closeAll();
    await repo.cleanup();
  }
});

test('acquire rejects and leaves no entry when the watcher is not ready in time', async () => {
  const repo = await makeTmpRepo();
  const pool = createWatcherPool({ onChange: () => {}, debounceMs: DEBOUNCE, graceMs: GRACE, readyTimeoutMs: 1 });
  try {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await assert.rejects(pool.acquire(1, repo.dir), /not ready/);
    assert.deepEqual(pool.active(), []);
  } finally {
    await pool.closeAll();
    await repo.cleanup();
  }
});

test('writes inside a nested repository or submodule .git directory are ignored', () =>
  withPool(async ({ repo, pool, calls }) => {
    await repo.write('a.txt', 'a\n');
    await repo.write('vendor/lib/.git/HEAD', 'ref: refs/heads/main\n');
    await repo.commit('init');
    await pool.acquire(1, repo.dir);
    await sleep(SETTLE);
    writeFileSync(join(repo.dir, 'vendor', 'lib', '.git', 'HEAD'), 'ref: refs/heads/other\n');
    mkdirSync(join(repo.dir, 'vendor', 'lib', '.git', 'refs'), { recursive: true });
    writeFileSync(join(repo.dir, 'vendor', 'lib', '.git', 'refs', 'x'), 'x\n');
    await sleep(QUIET);
    assert.deepEqual(calls, []);
  }));

test('our own git reads do not fire onChange (no recompute loop)', () =>
  withPool(async ({ repo, pool, calls }) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await repo.write('a.txt', 'changed\n');
    await pool.acquire(1, repo.dir);
    // FSEvents may still report the write made just before acquire; only what follows the reads counts.
    await sleep(QUIET);
    calls.length = 0;
    await liveDiff(repo.dir);
    await liveDiff(repo.dir);
    await runGit(repo.dir, ['status']);
    await sleep(1500);
    assert.deepEqual(calls, []);
  }));

/** Open file descriptors of this process, or null where they cannot be listed. */
function openFds() {
  for (const dir of ['/proc/self/fd', '/dev/fd']) {
    try {
      return readdirSync(dir).length;
    } catch {
      // try the next one
    }
  }
  return null;
}

test('watching a 2,000-file repository opens only a handful of file descriptors', { skip: process.platform === 'win32' }, () =>
  withPool(async ({ repo, pool }) => {
    for (let d = 0; d < 20; d++) {
      mkdirSync(join(repo.dir, `d${d}`));
      for (let f = 0; f < 100; f++) writeFileSync(join(repo.dir, `d${d}`, `f${f}.txt`), `${d}/${f}\n`);
    }
    await repo.commit('init');
    const before = openFds();
    assert.notEqual(before, null);
    await pool.acquire(1, repo.dir);
    const after = /** @type {number} */ (openFds());
    assert.ok(after - /** @type {number} */ (before) < 50, `fd growth ${after - /** @type {number} */ (before)}`);
  }));
