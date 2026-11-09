import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../../src/git/parseDiff.js';
import { runGit } from '../../src/git/run.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';

test('empty input yields no files', () => {
  assert.deepEqual(parseDiff(''), []);
});

test('modified file with two hunks has correct line numbers', () => {
  const text = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@ first',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '@@ -10,2 +10,3 @@ second',
    ' ten',
    '+ten and a half',
    ' eleven',
    '',
  ].join('\n');
  const files = parseDiff(text);
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.path, 'a.txt');
  assert.equal(f.oldPath, null);
  assert.equal(f.status, 'modified');
  assert.equal(f.binary, false);
  assert.equal(f.hidden, false);
  assert.equal(f.large, false);
  assert.equal(f.hunks.length, 2);
  assert.equal(f.hunks[0].header, '@@ -1,3 +1,3 @@ first');
  assert.deepEqual(f.hunks[0].lines, [
    { type: 'ctx', oldNo: 1, newNo: 1, text: 'one' },
    { type: 'del', oldNo: 2, newNo: null, text: 'two' },
    { type: 'add', oldNo: null, newNo: 2, text: 'TWO' },
    { type: 'ctx', oldNo: 3, newNo: 3, text: 'three' },
  ]);
  assert.deepEqual(f.hunks[1].lines, [
    { type: 'ctx', oldNo: 10, newNo: 10, text: 'ten' },
    { type: 'add', oldNo: null, newNo: 11, text: 'ten and a half' },
    { type: 'ctx', oldNo: 11, newNo: 12, text: 'eleven' },
  ]);
  assert.ok(f.patch.startsWith('diff --git a/a.txt b/a.txt'));
  assert.ok(f.patch.includes('@@ -10,2 +10,3 @@ second'));
});

test('added file (--- /dev/null)', () => {
  const text = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+hello',
    '+world',
    '',
  ].join('\n');
  const [f] = parseDiff(text);
  assert.equal(f.status, 'added');
  assert.equal(f.path, 'new.txt');
  assert.equal(f.oldPath, null);
  assert.deepEqual(f.hunks[0].lines, [
    { type: 'add', oldNo: null, newNo: 1, text: 'hello' },
    { type: 'add', oldNo: null, newNo: 2, text: 'world' },
  ]);
});

test('deleted file (+++ /dev/null) keeps old path as path', () => {
  const text = [
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    'index 4444444..0000000',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-bye',
    '-now',
    '',
  ].join('\n');
  const [f] = parseDiff(text);
  assert.equal(f.status, 'deleted');
  assert.equal(f.path, 'gone.txt');
  assert.equal(f.oldPath, null);
  assert.deepEqual(f.hunks[0].lines, [
    { type: 'del', oldNo: 1, newNo: null, text: 'bye' },
    { type: 'del', oldNo: 2, newNo: null, text: 'now' },
  ]);
});

test('pure rename with similarity index has no hunks', () => {
  const text = [
    'diff --git a/old name.txt b/new name.txt',
    'similarity index 100%',
    'rename from old name.txt',
    'rename to new name.txt',
    '',
  ].join('\n');
  const [f] = parseDiff(text);
  assert.equal(f.status, 'renamed');
  assert.equal(f.path, 'new name.txt');
  assert.equal(f.oldPath, 'old name.txt');
  assert.deepEqual(f.hunks, []);
  assert.equal(f.binary, false);
});

test('rename with edits parses hunks and paths from ---/+++', () => {
  const text = [
    'diff --git a/x.js b/y.js',
    'similarity index 80%',
    'rename from x.js',
    'rename to y.js',
    'index 5555555..6666666 100644',
    '--- a/x.js',
    '+++ b/y.js',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');
  const [f] = parseDiff(text);
  assert.equal(f.status, 'renamed');
  assert.equal(f.path, 'y.js');
  assert.equal(f.oldPath, 'x.js');
  assert.equal(f.hunks[0].lines.length, 2);
});

test('binary file detected from "Binary files differ"', () => {
  const text = [
    'diff --git a/img.png b/img.png',
    'index 7777777..8888888 100644',
    'Binary files a/img.png and b/img.png differ',
    '',
  ].join('\n');
  const [f] = parseDiff(text);
  assert.equal(f.binary, true);
  assert.deepEqual(f.hunks, []);
  assert.equal(f.path, 'img.png');
  assert.equal(f.status, 'modified');
});

test('new binary file is added with binary true', () => {
  const text = [
    'diff --git a/img.png b/img.png',
    'new file mode 100644',
    'index 0000000..8888888',
    'Binary files /dev/null and b/img.png differ',
    '',
  ].join('\n');
  const [f] = parseDiff(text);
  assert.equal(f.binary, true);
  assert.equal(f.status, 'added');
  assert.equal(f.path, 'img.png');
});

test('"\\ No newline at end of file" is not emitted as a line', () => {
  const text = [
    'diff --git a/n.txt b/n.txt',
    'index 1111111..2222222 100644',
    '--- a/n.txt',
    '+++ b/n.txt',
    '@@ -1 +1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n');
  const [f] = parseDiff(text);
  assert.deepEqual(f.hunks[0].lines, [
    { type: 'del', oldNo: 1, newNo: null, text: 'old' },
    { type: 'add', oldNo: null, newNo: 1, text: 'new' },
  ]);
});

test('multiple files are split correctly with per-file patch', () => {
  const text = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-a',
    '+A',
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '-b',
    '+B',
    '',
  ].join('\n');
  const files = parseDiff(text);
  assert.deepEqual(files.map((f) => f.path), ['a.txt', 'b.txt']);
  assert.ok(!files[0].patch.includes('b.txt'));
  assert.ok(files[1].patch.startsWith('diff --git a/b.txt'));
});

test('content lines starting with "diff --git " inside a hunk do not split files', () => {
  const text = [
    'diff --git a/p.patch b/p.patch',
    '--- a/p.patch',
    '+++ b/p.patch',
    '@@ -1 +1,2 @@',
    ' keep',
    '+diff --git a/x b/x',
    '',
  ].join('\n');
  const files = parseDiff(text);
  assert.equal(files.length, 1);
  assert.equal(files[0].hunks[0].lines.length, 2);
  assert.equal(files[0].hunks[0].lines[1].text, 'diff --git a/x b/x');
});

test('non-ASCII path with spaces round-trips exactly through real git', async () => {
  const repo = await makeTmpRepo();
  try {
    const rel = 'src/مجلد/my file.php';
    await repo.write(rel, '<?php\necho 1;\n');
    await repo.commit('init');
    await repo.write(rel, '<?php\necho 2;\n');
    const { stdout } = await runGit(repo.dir, ['diff', '--no-color', '--no-ext-diff', 'HEAD']);
    const files = parseDiff(stdout);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, rel);
    assert.equal(files[0].status, 'modified');
  } finally {
    await repo.cleanup();
  }
});

test('real git rename and delete are classified', async () => {
  const repo = await makeTmpRepo();
  try {
    await repo.write('keep.txt', 'k1\nk2\nk3\nk4\nk5\n');
    await repo.write('old.txt', 'o1\no2\no3\no4\no5\n');
    await repo.commit('init');
    await repo.git('mv', 'old.txt', 'new.txt');
    await repo.git('rm', '-q', 'keep.txt');
    const { stdout } = await runGit(repo.dir, ['diff', '--no-color', '--no-ext-diff', '-M', '--cached']);
    const files = parseDiff(stdout);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.equal(byPath['new.txt'].status, 'renamed');
    assert.equal(byPath['new.txt'].oldPath, 'old.txt');
    assert.equal(byPath['keep.txt'].status, 'deleted');
  } finally {
    await repo.cleanup();
  }
});

test('CRLF content has \\r stripped from text', () => {
  const text = [
    'diff --git a/w.txt b/w.txt',
    '--- a/w.txt',
    '+++ b/w.txt',
    '@@ -1,2 +1,2 @@',
    ' same\r',
    '-old\r',
    '+new\r',
    '',
  ].join('\n');
  const [f] = parseDiff(text);
  assert.deepEqual(f.hunks[0].lines.map((l) => l.text), ['same', 'old', 'new']);
});
