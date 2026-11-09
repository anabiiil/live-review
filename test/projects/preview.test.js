import '../helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTmpRepo } from '../helpers/tmpRepo.js';
import { previewProject } from '../../src/projects/preview.js';
import { RepoError } from '../../src/git/repo.js';

test('preview splits hidden and visible files, sorted, including untracked but not ignored', async () => {
  const repo = await makeTmpRepo();
  try {
    await repo.write('.gitignore', 'dist/\n');
    await repo.write('src/a.js', 'x');
    await repo.write('.env', 'SECRET=1');
    await repo.write('keys/server.pem', 'k');
    await repo.commit('init');
    await repo.write('src/new.js', 'y');
    await repo.write('dist/out.js', 'ignored');
    await repo.write('notes/todo.txt', 'z');
    const r = await previewProject(repo.dir, []);
    assert.equal(r.root, repo.dir);
    assert.deepEqual(r.visible, ['.gitignore', 'notes/todo.txt', 'src/a.js', 'src/new.js']);
    assert.deepEqual(r.hidden, ['.env', 'keys/server.pem']);
  } finally {
    await repo.cleanup();
  }
});

test('preview applies extraHidden basename globs', async () => {
  const repo = await makeTmpRepo();
  try {
    await repo.write('src/a.js', 'x');
    await repo.write('notes/private.md', 'p');
    await repo.commit('init');
    const r = await previewProject(repo.dir, ['private.*']);
    assert.deepEqual(r.hidden, ['notes/private.md']);
    assert.deepEqual(r.visible, ['src/a.js']);
  } finally {
    await repo.cleanup();
  }
});

test('preview skips untracked nested repositories (directory entries)', async () => {
  const repo = await makeTmpRepo();
  try {
    await repo.write('a.txt', 'a');
    await repo.commit('init');
    const nested = join(repo.dir, 'nested');
    await mkdir(nested);
    const { runGit } = await import('../../src/git/run.js');
    await runGit(nested, ['init', '-q']);
    await repo.write('nested/f.txt', 'f');
    const r = await previewProject(repo.dir);
    assert.deepEqual(r.visible, ['a.txt']);
  } finally {
    await repo.cleanup();
  }
});

test('preview rejects a subfolder with a RepoError', async () => {
  const repo = await makeTmpRepo();
  try {
    await repo.write('src/a.js', 'x');
    await repo.commit('init');
    await assert.rejects(previewProject(join(repo.dir, 'src'), []), (e) => e instanceof RepoError && e.reason === 'not-root');
  } finally {
    await repo.cleanup();
  }
});
