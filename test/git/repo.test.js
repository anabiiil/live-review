import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { join, isAbsolute, parse } from 'node:path';
import {
  RepoError,
  EMPTY_TREE,
  validateRepoRoot,
  headState,
  listCommits,
  commitInfo,
  fileAt,
  isReachable,
  gitDir,
} from '../../src/git/repo.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';

/**
 * @param {(repo: Awaited<ReturnType<typeof makeTmpRepo>>) => Promise<void>} fn
 */
async function withRepo(fn) {
  const repo = await makeTmpRepo();
  try {
    await fn(repo);
  } finally {
    await repo.cleanup();
  }
}

/** @param {Promise<unknown>} p @param {string} reason */
async function rejectsWith(p, reason) {
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof RepoError, `expected RepoError, got ${err}`);
    assert.equal(err.reason, reason);
    return true;
  });
}

test('EMPTY_TREE is the well-known empty tree id', () => {
  assert.equal(EMPTY_TREE, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
});

test('validateRepoRoot returns the toplevel for a repo root', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', 'a');
    await repo.commit('one');
    assert.equal(await validateRepoRoot(repo.dir), repo.dir);
  }));

test('validateRepoRoot accepts a symlinked path to the root and returns the real toplevel', () =>
  withRepo(async (repo) => {
    const holder = await mkdtemp(join(tmpdir(), 'livereview-link-'));
    try {
      const link = join(holder, 'link');
      await symlink(repo.dir, link);
      assert.equal(await validateRepoRoot(link), repo.dir);
    } finally {
      await rm(holder, { recursive: true, force: true });
    }
  }));

test('validateRepoRoot rejects a subfolder with not-root', () =>
  withRepo(async (repo) => {
    await mkdir(join(repo.dir, 'sub'));
    await rejectsWith(validateRepoRoot(join(repo.dir, 'sub')), 'not-root');
  }));

test('validateRepoRoot rejects a plain folder with not-a-repo', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'livereview-plain-')));
  try {
    await rejectsWith(validateRepoRoot(dir), 'not-a-repo');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('validateRepoRoot rejects a missing path with not-a-repo', async () => {
  await rejectsWith(validateRepoRoot(join(tmpdir(), 'livereview-does-not-exist-xyz')), 'not-a-repo');
});

test('validateRepoRoot rejects the home directory and filesystem roots as forbidden', async () => {
  await rejectsWith(validateRepoRoot(homedir()), 'forbidden');
  await rejectsWith(validateRepoRoot(parse(process.cwd()).root), 'forbidden');
});

test('headState of a fresh repo is empty on main', () =>
  withRepo(async (repo) => {
    assert.deepEqual(await headState(repo.dir), {
      branch: 'main',
      detached: false,
      sha: null,
      empty: true,
      operation: null,
    });
  }));

test('headState after a commit has the sha', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', 'a');
    const sha = await repo.commit('one');
    assert.deepEqual(await headState(repo.dir), {
      branch: 'main',
      detached: false,
      sha,
      empty: false,
      operation: null,
    });
  }));

test('headState reports a detached HEAD', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', 'a');
    const sha = await repo.commit('one');
    await repo.git('checkout', '-q', '--detach');
    assert.deepEqual(await headState(repo.dir), {
      branch: null,
      detached: true,
      sha,
      empty: false,
      operation: null,
    });
  }));

test('headState reports a merge in progress', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', 'base\n');
    await repo.commit('base');
    await repo.git('checkout', '-q', '-b', 'topic');
    await repo.write('a.txt', 'topic\n');
    await repo.commit('topic');
    await repo.git('checkout', '-q', 'main');
    await repo.write('a.txt', 'main\n');
    await repo.commit('main');
    await assert.rejects(repo.git('merge', 'topic'));
    const state = await headState(repo.dir);
    assert.equal(state.operation, 'merge');
    assert.equal(state.branch, 'main');
  }));

test('headState reports a rebase in progress', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', 'base\n');
    await repo.commit('base');
    await repo.git('checkout', '-q', '-b', 'topic');
    await repo.write('a.txt', 'topic\n');
    await repo.commit('topic');
    await repo.git('checkout', '-q', 'main');
    await repo.write('a.txt', 'main\n');
    await repo.commit('main');
    await repo.git('checkout', '-q', 'topic');
    await assert.rejects(repo.git('rebase', 'main'));
    const state = await headState(repo.dir);
    assert.equal(state.operation, 'rebase');
    assert.equal(state.detached, true);
  }));

test('listCommits pages with hasMore', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', '1');
    const c1 = await repo.commit('first');
    await repo.write('a.txt', '2');
    const c2 = await repo.commit('second | with "pipe"');
    await repo.write('a.txt', '3');
    const c3 = await repo.commit('ثالث');

    const page1 = await listCommits(repo.dir, { skip: 0, limit: 2 });
    assert.equal(page1.hasMore, true);
    assert.equal(page1.commits.length, 2);
    assert.deepEqual(page1.commits.map((c) => c.sha), [c3, c2]);
    assert.equal(page1.commits[0].subject, 'ثالث');
    assert.equal(page1.commits[1].subject, 'second | with "pipe"');
    assert.equal(page1.commits[0].short, c3.slice(0, page1.commits[0].short.length));
    assert.ok(page1.commits[0].short.length >= 7);
    assert.equal(page1.commits[0].author, 'Test User');
    assert.match(page1.commits[0].date, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);

    const page2 = await listCommits(repo.dir, { skip: 2, limit: 2 });
    assert.equal(page2.hasMore, false);
    assert.deepEqual(page2.commits.map((c) => c.sha), [c1]);
  }));

test('listCommits on a repo with no commits is empty', () =>
  withRepo(async (repo) => {
    assert.deepEqual(await listCommits(repo.dir, { skip: 0, limit: 10 }), {
      commits: [],
      hasMore: false,
    });
  }));

test('commitInfo of a root commit has no parents', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', 'a');
    const sha = await repo.commit('root subject\n\nbody line');
    const info = await commitInfo(repo.dir, sha);
    assert.equal(info.sha, sha);
    assert.equal(info.author, 'Test User');
    assert.equal(info.email, 'test@example.com');
    assert.deepEqual(info.parents, []);
    assert.match(info.date, /^\d{4}-\d\d-\d\dT/);
    assert.equal(info.message, 'root subject\n\nbody line');
  }));

test('commitInfo lists parents and accepts an abbreviated sha', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', '1');
    const c1 = await repo.commit('first');
    await repo.write('a.txt', '2');
    const c2 = await repo.commit('second');
    const info = await commitInfo(repo.dir, c2.slice(0, 8));
    assert.equal(info.sha, c2);
    assert.deepEqual(info.parents, [c1]);
  }));

test('commitInfo rejects malformed and unknown shas with unknown-commit', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', 'a');
    await repo.commit('one');
    await rejectsWith(commitInfo(repo.dir, 'zzz'), 'unknown-commit');
    await rejectsWith(commitInfo(repo.dir, '--all'), 'unknown-commit');
    await rejectsWith(commitInfo(repo.dir, 'abcdef0'), 'unknown-commit');
    await rejectsWith(commitInfo(repo.dir, 'HEAD'), 'unknown-commit');
  }));

test('commitInfo rejects a non-commit object with unknown-commit', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', 'a');
    await repo.commit('one');
    const blob = (await repo.git('rev-parse', 'HEAD:a.txt')).trim();
    await rejectsWith(commitInfo(repo.dir, blob), 'unknown-commit');
  }));

test('fileAt returns content at a revision and null when absent', () =>
  withRepo(async (repo) => {
    await repo.write('src/مجلد/a.txt', 'one\n');
    const c1 = await repo.commit('first');
    await repo.write('src/مجلد/a.txt', 'two\n');
    await repo.write('b.txt', 'b');
    await repo.commit('second');
    assert.equal(await fileAt(repo.dir, c1, 'src/مجلد/a.txt'), 'one\n');
    assert.equal(await fileAt(repo.dir, 'HEAD', 'src/مجلد/a.txt'), 'two\n');
    assert.equal(await fileAt(repo.dir, c1, 'b.txt'), null);
    assert.equal(await fileAt(repo.dir, 'HEAD', 'nope.txt'), null);
  }));

test('fileAt returns null when the revision does not exist', () =>
  withRepo(async (repo) => {
    assert.equal(await fileAt(repo.dir, 'HEAD', 'a.txt'), null);
  }));

test('isReachable is false for an amended-away commit', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', '1');
    await repo.commit('first');
    await repo.write('a.txt', '2');
    const old = await repo.commit('second');
    assert.equal(await isReachable(repo.dir, old), true);
    await repo.git('commit', '-q', '--amend', '-m', 'second amended');
    assert.equal(await isReachable(repo.dir, old), false);
    const head = (await repo.git('rev-parse', 'HEAD')).trim();
    assert.equal(await isReachable(repo.dir, head), true);
  }));

test('isReachable is false for malformed or unknown shas', () =>
  withRepo(async (repo) => {
    await repo.write('a.txt', '1');
    await repo.commit('first');
    assert.equal(await isReachable(repo.dir, 'zzz'), false);
    assert.equal(await isReachable(repo.dir, 'abcdef0'), false);
  }));

test('gitDir returns an absolute path to .git', () =>
  withRepo(async (repo) => {
    const dir = await gitDir(repo.dir);
    assert.ok(isAbsolute(dir));
    assert.equal(dir, join(repo.dir, '.git'));
  }));
