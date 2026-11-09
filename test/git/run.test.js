import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGit, GitError } from '../../src/git/run.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';

test('runGit returns stdout and code 0', async () => {
  const repo = await makeTmpRepo();
  try {
    const res = await runGit(repo.dir, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(res.stdout, 'true\n');
    assert.equal(res.code, 0);
  } finally {
    await repo.cleanup();
  }
});

test('runGit rejects with GitError on non-zero exit', async () => {
  const repo = await makeTmpRepo();
  try {
    await assert.rejects(
      () => runGit(repo.dir, ['not-a-real-command']),
      (err) => {
        assert.ok(err instanceof GitError);
        assert.notEqual(err.code, 0);
        assert.equal(typeof err.stderr, 'string');
        assert.deepEqual(err.args, ['not-a-real-command']);
        return true;
      },
    );
  } finally {
    await repo.cleanup();
  }
});

test('runGit allowFail resolves with non-zero code', async () => {
  const repo = await makeTmpRepo();
  try {
    const res = await runGit(repo.dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
    assert.notEqual(res.code, 0);
  } finally {
    await repo.cleanup();
  }
});

test('runGit passes input on stdin', async () => {
  const repo = await makeTmpRepo();
  try {
    const res = await runGit(repo.dir, ['hash-object', '--stdin'], { input: 'hello\n' });
    assert.equal(res.stdout.trim(), 'ce013625030ba8dba906f756967f9e9ca394464a');
  } finally {
    await repo.cleanup();
  }
});

test('runGit does not quote non-ASCII paths', async () => {
  const repo = await makeTmpRepo();
  try {
    await repo.write('src/مجلد/my file.php', '<?php\n');
    const res = await runGit(repo.dir, ['ls-files', '--others', '--exclude-standard']);
    assert.equal(res.stdout, 'src/مجلد/my file.php\n');
  } finally {
    await repo.cleanup();
  }
});
