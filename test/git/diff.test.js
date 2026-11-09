import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseWithDiff2Html } from 'diff2html';
import { liveDiff, commitDiff } from '../../src/git/diff.js';
import { RepoError } from '../../src/git/repo.js';
import { runGit } from '../../src/git/run.js';
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

/** @param {{files: {path:string}[]}} res @param {string} path */
const byPath = (files, path) => files.find((f) => f.path === path);

test('liveDiff: modified tracked file', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'one\ntwo\n');
    const sha = await repo.commit('init');
    await repo.write('a.txt', 'one\nTWO\n');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(res.head.sha, sha);
    assert.equal(res.untrackedTruncated, false);
    assert.equal(res.files.length, 1);
    const f = res.files[0];
    assert.equal(f.path, 'a.txt');
    assert.equal(f.status, 'modified');
    assert.equal(f.hunks.length, 1);
    assert.deepEqual(
      f.hunks[0].lines.filter((l) => l.type !== 'ctx').map((l) => [l.type, l.text]),
      [['del', 'two'], ['add', 'TWO']],
    );
  });
});

test('liveDiff: staged and unstaged changes both appear', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.write('b.txt', 'b\n');
    await repo.commit('init');
    await repo.write('a.txt', 'a2\n');
    await repo.git('add', 'a.txt');
    await repo.write('b.txt', 'b2\n');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.deepEqual(res.files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
  });
});

test('liveDiff: user git config cannot change the diff format', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'one\n');
    await repo.commit('init');
    await repo.git('config', 'diff.noprefix', 'true');
    await repo.git('config', 'diff.mnemonicPrefix', 'true');
    await repo.git('config', 'color.ui', 'always');
    await repo.git('config', 'color.diff', 'always');
    await repo.git('config', 'diff.external', 'false');
    await repo.git('config', 'diff.submodule', 'log');
    await repo.write('a.txt', 'two\n');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].path, 'a.txt');
    assert.ok(res.files[0].patch.includes('diff --git a/a.txt b/a.txt'));
    assert.ok(!res.files[0].patch.includes('\u001b'));
    assert.equal(res.files[0].hunks[0].lines.length, 2);
  });
});

test('liveDiff: detects renames', async () => {
  await withRepo(async (repo) => {
    await repo.write('old.txt', 'line1\nline2\nline3\nline4\nline5\n');
    await repo.commit('init');
    await repo.git('mv', 'old.txt', 'new.txt');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].status, 'renamed');
    assert.equal(res.files[0].oldPath, 'old.txt');
    assert.equal(res.files[0].path, 'new.txt');
  });
});

test('liveDiff: untracked file is synthesized as an added file', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await repo.write('notes.md', '# Notes\nsecond line\n');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    const f = byPath(res.files, 'notes.md');
    assert.ok(f);
    assert.equal(f.status, 'added');
    assert.equal(f.oldPath, null);
    assert.equal(f.binary, false);
    assert.equal(f.large, false);
    assert.equal(f.hunks.length, 1);
    assert.deepEqual(
      f.hunks[0].lines.map((l) => [l.type, l.oldNo, l.newNo, l.text]),
      [['add', null, 1, '# Notes'], ['add', null, 2, 'second line']],
    );
    assert.equal(
      f.patch,
      'diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+# Notes\n+second line\n',
    );
  });
});

test('liveDiff: synthesized patch is accepted by git apply and diff2html', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    const content = 'x = 1\n+++ not a header\n@@ -1 +1 @@\ndiff --git a/z b/z\nlast';
    await repo.write('sub dir/we ird.txt', content);
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    const f = byPath(res.files, 'sub dir/we ird.txt');
    assert.ok(f);
    assert.ok(f.patch.endsWith('+last\n\\ No newline at end of file\n'));
    assert.equal(f.hunks[0].lines.length, 5);

    const parsed = parseWithDiff2Html(f.patch);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].addedLines, 5);
    assert.equal(parsed[0].isNew, true);

    // git itself must accept the patch against an empty tree.
    const other = await makeTmpRepo();
    try {
      await runGit(other.dir, ['apply', '--check', '-'], { input: f.patch });
      await runGit(other.dir, ['apply', '-'], { input: f.patch });
      const { readFile } = await import('node:fs/promises');
      assert.equal(await readFile(join(other.dir, 'sub dir', 'we ird.txt'), 'utf8'), content);
    } finally {
      await other.cleanup();
    }
  });
});

test('liveDiff: empty untracked file has a header-only patch', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await repo.write('empty.txt', '');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    const f = byPath(res.files, 'empty.txt');
    assert.ok(f);
    assert.equal(f.status, 'added');
    assert.deepEqual(f.hunks, []);
    assert.equal(f.patch, 'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n');
  });
});

test('liveDiff: executable untracked file keeps its mode', async (t) => {
  if (process.platform === 'win32') return t.skip('no exec bit on Windows');
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await repo.write('run.sh', '#!/bin/sh\n');
    await chmod(join(repo.dir, 'run.sh'), 0o755);
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.ok(byPath(res.files, 'run.sh').patch.includes('new file mode 100755\n'));
  });
});

test('liveDiff: ignored untracked file is absent', async () => {
  await withRepo(async (repo) => {
    await repo.write('.gitignore', 'ignored.txt\n');
    await repo.commit('init');
    await repo.write('ignored.txt', 'nope\n');
    await repo.write('kept.txt', 'yes\n');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(byPath(res.files, 'ignored.txt'), undefined);
    assert.ok(byPath(res.files, 'kept.txt'));
  });
});

test('liveDiff: tracked .env change is hidden and leaks nothing', async () => {
  await withRepo(async (repo) => {
    await repo.write('.env', 'API_KEY=old-super-secret\n');
    await repo.commit('init');
    await repo.write('.env', 'API_KEY=new-super-secret\n');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    const f = byPath(res.files, '.env');
    assert.equal(f.hidden, true);
    assert.deepEqual(f.hunks, []);
    assert.ok(!f.patch.includes('secret'));
    assert.ok(!JSON.stringify(res).includes('secret'));
  });
});

test('liveDiff: untracked hidden files and extraHidden patterns leak nothing', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await repo.write('prod.env', 'x');
    await repo.write('.env.local', 'TOKEN=topsecretvalue\n');
    await repo.write('config/id_rsa', 'PRIVATE topsecretvalue\n');
    await repo.write('custom.conf', 'topsecretvalue=1\n');
    const res = await liveDiff(repo.dir, { extraHidden: ['*.conf'] });
    for (const p of ['.env.local', 'config/id_rsa', 'custom.conf']) {
      const f = byPath(res.files, p);
      assert.ok(f, p);
      assert.equal(f.hidden, true, p);
      assert.deepEqual(f.hunks, [], p);
    }
    assert.ok(!JSON.stringify(res).includes('topsecretvalue'));
  });
});

test('liveDiff: hidden rename away from a secret is hidden', async () => {
  await withRepo(async (repo) => {
    await repo.write('.env', 'API_KEY=abcdefghij-secret-value\nmore\nlines\nhere\nfor\nsimilarity\n');
    await repo.commit('init');
    await repo.git('mv', '.env', 'config.txt');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].hidden, true);
    assert.ok(!JSON.stringify(res).includes('abcdefghij'));
  });
});

test('liveDiff: untracked file over 1 MB is large without content', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await repo.write('big.log', 'x'.repeat(1.5 * 1024 * 1024));
    await repo.write('limit.log', 'y'.repeat(1024 * 1024));
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    const big = byPath(res.files, 'big.log');
    assert.equal(big.large, true);
    assert.equal(big.status, 'added');
    assert.deepEqual(big.hunks, []);
    assert.ok(!big.patch.includes('xxxx'));
    assert.equal(big.patch, 'diff --git a/big.log b/big.log\nnew file mode 100644\n');
    // exactly 1 MB is still shown
    const limit = byPath(res.files, 'limit.log');
    assert.equal(limit.large, false);
    assert.equal(limit.hunks.length, 1);
  });
});

test('liveDiff: untracked binary file is flagged without content', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await repo.write('img.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    const f = byPath(res.files, 'img.bin');
    assert.equal(f.binary, true);
    assert.equal(f.status, 'added');
    assert.deepEqual(f.hunks, []);
    assert.ok(f.patch.startsWith('diff --git a/img.bin b/img.bin\nnew file mode 100644\n'));
    assert.ok(f.patch.includes('Binary files /dev/null and b/img.bin differ'));
  });
});

test('liveDiff: NUL after the first 8 KB does not make a file binary', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await repo.write('late.txt', Buffer.concat([Buffer.from('a'.repeat(9000) + '\n'), Buffer.from([0]), Buffer.from('\n')]));
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(byPath(res.files, 'late.txt').binary, false);
  });
});

test('liveDiff: more than 300 untracked files are truncated', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    for (let i = 0; i < 305; i++) await writeFile(join(repo.dir, `f${String(i).padStart(3, '0')}.txt`), `${i}\n`);
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(res.files.length, 300);
    assert.equal(res.untrackedTruncated, true);
  });
});

test('liveDiff: exactly 300 untracked files are not truncated', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    for (let i = 0; i < 300; i++) await writeFile(join(repo.dir, `f${String(i).padStart(3, '0')}.txt`), `${i}\n`);
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(res.files.length, 300);
    assert.equal(res.untrackedTruncated, false);
  });
});

test('liveDiff: empty repo with one untracked file', async () => {
  await withRepo(async (repo) => {
    await repo.write('first.txt', 'hello\n');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(res.head.empty, true);
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].path, 'first.txt');
    assert.equal(res.files[0].status, 'added');
  });
});

test('liveDiff: empty repo with staged file shows it as added', async () => {
  await withRepo(async (repo) => {
    await repo.write('first.txt', 'hello\n');
    await repo.git('add', 'first.txt');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].status, 'added');
    assert.equal(res.files[0].hunks.length, 1);
  });
});

test('liveDiff: non-ASCII path with spaces is exact', async () => {
  await withRepo(async (repo) => {
    await repo.write('src/مجلد/my file.php', '<?php\necho 1;\n');
    await repo.commit('init');
    await repo.write('src/مجلد/my file.php', '<?php\necho 2;\n');
    await repo.write('src/مجلد/new file.php', '<?php\n');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.deepEqual(res.files.map((f) => f.path).sort(), ['src/مجلد/my file.php', 'src/مجلد/new file.php']);
  });
});

test('liveDiff: untracked symlinks never read outside the repo', async (t) => {
  if (process.platform === 'win32') return t.skip('symlinks need privileges on Windows');
  const outside = await mkdtemp(join(tmpdir(), 'livereview-outside-'));
  try {
    await withRepo(async (repo) => {
      await repo.write('a.txt', 'a\n');
      await repo.commit('init');
      await writeFile(join(outside, 'private.txt'), 'outside-private-content\n');
      await mkdir(join(outside, 'dir'));
      await writeFile(join(outside, 'dir', 'inner.txt'), 'outside-dir-content\n');
      await symlink(join(outside, 'private.txt'), join(repo.dir, 'link-out.txt'));
      await symlink(join(outside, 'dir'), join(repo.dir, 'linkdir'));
      await symlink('a.txt', join(repo.dir, 'link-in.txt'));
      await symlink('does-not-exist', join(repo.dir, 'dangling'));
      const res = await liveDiff(repo.dir, { extraHidden: [] });
      assert.equal(byPath(res.files, 'link-out.txt'), undefined);
      assert.equal(byPath(res.files, 'linkdir'), undefined);
      assert.equal(byPath(res.files, 'dangling'), undefined);
      assert.ok(!JSON.stringify(res).includes('outside-'));
      // an in-repo symlink is shown like git does: mode 120000, content is the link target
      const inner = byPath(res.files, 'link-in.txt');
      assert.ok(inner);
      assert.ok(inner.patch.includes('new file mode 120000\n'));
      assert.deepEqual(inner.hunks[0].lines.map((l) => l.text), ['a.txt']);
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test('liveDiff: untracked nested repositories and directories are skipped', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await mkdir(join(repo.dir, 'nested'));
    await runGit(join(repo.dir, 'nested'), ['init', '-q']);
    await writeFile(join(repo.dir, 'nested', 'inside.txt'), 'inside\n');
    const res = await liveDiff(repo.dir, { extraHidden: [] });
    assert.deepEqual(res.files, []);
  });
});

test('liveDiff: tracked submodule change shows only pointer lines', async () => {
  await withRepo(async (repo) => {
    const sub = await makeTmpRepo();
    try {
      await sub.write('s.txt', 'sub-secret-content\n');
      await sub.commit('sub init');
      await repo.write('a.txt', 'a\n');
      await repo.commit('init');
      await repo.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'vendor/sub');
      await repo.commit('add submodule');
      await sub.write('s.txt', 'changed\n');
      const newSha = await sub.commit('sub change');
      await runGit(join(repo.dir, 'vendor', 'sub'), ['-c', 'protocol.file.allow=always', 'pull', '-q']);
      const res = await liveDiff(repo.dir, { extraHidden: [] });
      const f = byPath(res.files, 'vendor/sub');
      assert.ok(f);
      assert.deepEqual(
        f.hunks[0].lines.map((l) => l.text),
        [f.hunks[0].lines[0].text, `Subproject commit ${newSha}`],
      );
      assert.ok(!JSON.stringify(res).includes('sub-secret-content'));
    } finally {
      await sub.cleanup();
    }
  });
});

test('liveDiff: rejects with RepoError missing when the folder is gone', async () => {
  const repo = await makeTmpRepo();
  await repo.write('a.txt', 'a\n');
  await repo.commit('init');
  await repo.cleanup();
  await assert.rejects(
    () => liveDiff(repo.dir, { extraHidden: [] }),
    (err) => err instanceof RepoError && err.reason === 'missing',
  );
});

test('liveDiff and commitDiff: rejects with missing when .git is gone', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    const sha = await repo.commit('init');
    await rm(join(repo.dir, '.git'), { recursive: true, force: true });
    for (const call of [() => liveDiff(repo.dir, { extraHidden: [] }), () => commitDiff(repo.dir, sha, { extraHidden: [] })]) {
      await assert.rejects(call, (err) => err instanceof RepoError && err.reason === 'missing');
    }
  });
});

test('commitDiff: root commit lists all files as added', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.write('src/b.txt', 'b\n');
    const sha = await repo.commit('init');
    const files = await commitDiff(repo.dir, sha, { extraHidden: [] });
    assert.deepEqual(files.map((f) => [f.path, f.status]), [['a.txt', 'added'], ['src/b.txt', 'added']]);
  });
});

test('commitDiff: diffs against the parent and honors user diff config', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'one\n');
    await repo.commit('init');
    await repo.git('config', 'diff.noprefix', 'true');
    await repo.git('config', 'color.ui', 'always');
    await repo.write('a.txt', 'two\n');
    const sha = await repo.commit('change');
    const files = await commitDiff(repo.dir, sha, { extraHidden: [] });
    assert.equal(files.length, 1);
    assert.equal(files[0].status, 'modified');
    assert.ok(files[0].patch.includes('diff --git a/a.txt b/a.txt'));
    // abbreviated shas work too
    assert.equal((await commitDiff(repo.dir, sha.slice(0, 8), { extraHidden: [] })).length, 1);
  });
});

test('commitDiff: merge commit diffs against the first parent', async () => {
  await withRepo(async (repo) => {
    await repo.write('base.txt', 'base\n');
    await repo.commit('init');
    await repo.git('checkout', '-q', '-b', 'feature');
    await repo.write('feature.txt', 'feature\n');
    await repo.commit('feature work');
    await repo.git('checkout', '-q', 'main');
    await repo.write('main.txt', 'main\n');
    await repo.commit('main work');
    await repo.git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
    const sha = (await repo.git('rev-parse', 'HEAD')).trim();
    const files = await commitDiff(repo.dir, sha, { extraHidden: [] });
    assert.deepEqual(files.map((f) => [f.path, f.status]), [['feature.txt', 'added']]);
  });
});

test('commitDiff: old commit containing .env is hidden', async () => {
  await withRepo(async (repo) => {
    await repo.write('.env', 'API_KEY=leaked-secret-123\n');
    await repo.write('app.js', 'ok\n');
    const sha = await repo.commit('oops');
    await repo.git('rm', '-q', '.env');
    await repo.commit('remove env');
    const files = await commitDiff(repo.dir, sha, { extraHidden: [] });
    const env = byPath(files, '.env');
    assert.equal(env.hidden, true);
    assert.deepEqual(env.hunks, []);
    assert.ok(!JSON.stringify(files).includes('leaked-secret'));
    assert.equal(byPath(files, 'app.js').hidden, false);
  });
});

test('commitDiff: respects extraHidden', async () => {
  await withRepo(async (repo) => {
    await repo.write('internal.conf', 'x=topsecretvalue\n');
    const sha = await repo.commit('init');
    const files = await commitDiff(repo.dir, sha, { extraHidden: ['*.conf'] });
    assert.equal(files[0].hidden, true);
    assert.ok(!JSON.stringify(files).includes('topsecretvalue'));
  });
});

test('commitDiff: unknown commit rejects with RepoError unknown-commit', async () => {
  await withRepo(async (repo) => {
    await repo.write('a.txt', 'a\n');
    await repo.commit('init');
    await assert.rejects(
      () => commitDiff(repo.dir, 'deadbeefdeadbeef', { extraHidden: [] }),
      (err) => err instanceof RepoError && err.reason === 'unknown-commit',
    );
    await assert.rejects(
      () => commitDiff(repo.dir, '--output=/tmp/x', { extraHidden: [] }),
      (err) => err instanceof RepoError && err.reason === 'unknown-commit',
    );
  });
});
