import '../helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { openDb } from '../../src/db.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';
import { liveDiff, commitDiff } from '../../src/git/diff.js';
import { makeAnchor } from '../../src/comments/anchor.js';
import { createCommentStore } from '../../src/comments/store.js';
import { reanchorLive, attachOnCommit, markRewritten } from '../../src/comments/reanchor.js';

const NINE = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`);
const text = (lines) => lines.join('\n') + '\n';

/** Repo with a.txt committed (9 lines), plus a DB with one project. */
async function withRepo(fn) {
  const repo = await makeTmpRepo();
  await repo.write('a.txt', text(NINE));
  await repo.commit('init');
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects(id, slug, name, path, created_at) VALUES(1, 'p', 'P', ?, 0)").run(repo.dir);
  const store = createCommentStore(db);
  const live = async (extraHidden = []) => (await liveDiff(repo.dir, { extraHidden })).files;
  /** Comment on a line of the current working-tree content of a.txt. */
  const commentNew = (line, path = 'a.txt', lines = null) => {
    const content = lines ?? NINE;
    return store.create({
      projectId: 1, target: 'live', path, line, side: 'new', anchor: makeAnchor(content, line),
      authorEmail: 'r@example.com', body: 'hi', now: 1,
    });
  };
  try {
    await fn({ repo, db, store, live, commentNew });
  } finally {
    db.close();
    await repo.cleanup();
  }
}

/** Working-tree edit: replace line 5 with a changed line. Returns the new content lines. */
async function changeLine5(repo) {
  const lines = [...NINE.slice(0, 4), 'CHANGED', ...NINE.slice(5)];
  await repo.write('a.txt', text(lines));
  return lines;
}

test('live comment survives inserting lines above and moves with its line', async () => {
  await withRepo(async ({ repo, store, live, commentNew }) => {
    const lines = await changeLine5(repo);
    const c = commentNew(5, 'a.txt', lines);
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files: await live(), store }), []);

    const moved = ['new a', 'new b', ...lines];
    await repo.write('a.txt', text(moved));
    const changed = await reanchorLive({ root: repo.dir, projectId: 1, files: await live(), store });
    assert.deepEqual(changed, [c.id]);
    const after = store.get(c.id);
    assert.equal(after.line, 7);
    assert.equal(after.outdated, false);
    assert.equal(after.anchor.lineText, 'CHANGED');
    assert.deepEqual(after.anchor.before, ['line 2', 'line 3', 'line 4']);
  });
});

test('editing the commented line marks the comment outdated', async () => {
  await withRepo(async ({ repo, store, live, commentNew }) => {
    const lines = await changeLine5(repo);
    const c = commentNew(5, 'a.txt', lines);
    await repo.write('a.txt', text([...lines.slice(0, 4), 'CHANGED AGAIN', ...lines.slice(5)]));
    const changed = await reanchorLive({ root: repo.dir, projectId: 1, files: await live(), store });
    assert.deepEqual(changed, [c.id]);
    assert.equal(store.get(c.id).outdated, true);
    // Already-outdated comments are not examined again.
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files: await live(), store }), []);
  });
});

test('reverting the change so the line leaves the diff marks the comment outdated', async () => {
  await withRepo(async ({ repo, store, live, commentNew }) => {
    const lines = await changeLine5(repo);
    const c = commentNew(5, 'a.txt', lines);
    await repo.write('a.txt', text(NINE));
    const files = await live();
    assert.equal(files.length, 0);
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files, store }), [c.id]);
    assert.equal(store.get(c.id).outdated, true);
  });
});

test('a context line that drifts out of the visible hunk becomes outdated', async () => {
  await withRepo(async ({ repo, store, live, commentNew }) => {
    const lines = [...NINE];
    lines[8] = 'tail changed';
    await repo.write('a.txt', text(lines));
    // line 7 is context (within 3 lines of the change at line 9); line 5 is not shown.
    const shown = commentNew(7, 'a.txt', lines);
    const hiddenCtx = commentNew(4, 'a.txt', lines);
    const changed = await reanchorLive({ root: repo.dir, projectId: 1, files: await live(), store });
    assert.deepEqual(changed, [hiddenCtx.id]);
    assert.equal(store.get(shown.id).outdated, false);
    assert.equal(store.get(hiddenCtx.id).outdated, true);
  });
});

test('old-side comments are matched against HEAD', async () => {
  await withRepo(async ({ repo, store, live }) => {
    await changeLine5(repo);
    const c = store.create({
      projectId: 1, target: 'live', path: 'a.txt', line: 5, side: 'old', anchor: makeAnchor(NINE, 5),
      authorEmail: 'r@example.com', body: 'why remove', now: 1,
    });
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files: await live(), store }), []);
    assert.equal(store.get(c.id).outdated, false);
    // Removing the change entirely leaves the file out of the diff.
    await repo.write('a.txt', text(NINE));
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files: await live(), store }), [c.id]);
    assert.equal(store.get(c.id).outdated, true);
  });
});

test('a file that disappeared or became hidden outdates its comments', async () => {
  await withRepo(async ({ repo, store, live, commentNew }) => {
    const lines = await changeLine5(repo);
    const c = commentNew(5, 'a.txt', lines);
    const files = await live();
    const hiddenFiles = files.map((f) => ({ ...f, hidden: true, hunks: [] }));
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files: hiddenFiles, store }), [c.id]);
    assert.equal(store.get(c.id).outdated, true);
  });
});

test('missing working-tree file outdates a new-side comment', async () => {
  await withRepo(async ({ repo, store, live, commentNew }) => {
    const lines = await changeLine5(repo);
    const c = commentNew(5, 'a.txt', lines);
    const files = await live();
    await rm(`${repo.dir}/a.txt`);
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files, store }), [c.id]);
    assert.equal(store.get(c.id).outdated, true);
  });
});

test('extraHidden outdates comments on newly hidden paths', async () => {
  await withRepo(async ({ repo, store, live, commentNew }) => {
    const lines = await changeLine5(repo);
    const c = commentNew(5, 'a.txt', lines);
    const files = await live(); // not yet redacted
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files, store, extraHidden: ['*.txt'] }), [c.id]);
  });
});

test('commit containing the commented change moves the comment to the commit', async () => {
  await withRepo(async ({ repo, store, live, commentNew }) => {
    const lines = await changeLine5(repo);
    const c = commentNew(5, 'a.txt', lines);
    const other = store.create({
      projectId: 1, target: 'live', path: 'a.txt', line: 1, side: 'new', anchor: makeAnchor(lines, 1),
      authorEmail: 'r@example.com', body: 'line 1 is outside the commit hunks', now: 1,
    });
    const sha = await repo.commit('change line 5');
    const commitFiles = await commitDiff(repo.dir, sha);
    const moved = await attachOnCommit({ root: repo.dir, projectId: 1, sha, commitFiles, store });
    assert.deepEqual(moved, [c.id]);
    assert.equal(store.get(c.id).target, sha);
    assert.equal(store.get(c.id).line, 5);
    assert.equal(store.get(other.id).target, 'live');
    assert.deepEqual(store.forTarget(1, sha).map((t) => t.id), [c.id]);
    // The leftover live comment is no longer in the (now empty) live diff.
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files: await live(), store }), [other.id]);
    assert.equal(store.get(other.id).outdated, true);
  });
});

test('old-side comments attach to the commit via its parent', async () => {
  await withRepo(async ({ repo, store }) => {
    await changeLine5(repo);
    const c = store.create({
      projectId: 1, target: 'live', path: 'a.txt', line: 5, side: 'old', anchor: makeAnchor(NINE, 5),
      authorEmail: 'r@example.com', body: 'removed?', now: 1,
    });
    const sha = await repo.commit('change line 5');
    const commitFiles = await commitDiff(repo.dir, sha);
    assert.deepEqual(await attachOnCommit({ root: repo.dir, projectId: 1, sha, commitFiles, store }), [c.id]);
    assert.equal(store.get(c.id).target, sha);
  });
});

test('comments on files untouched by the commit stay live', async () => {
  await withRepo(async ({ repo, store, commentNew }) => {
    const lines = await changeLine5(repo);
    const c = commentNew(5, 'a.txt', lines);
    await repo.write('b.txt', 'b\n');
    const sha = await repo.commit('x'); // includes a.txt too
    const commitFiles = (await commitDiff(repo.dir, sha)).filter((f) => f.path === 'b.txt');
    assert.deepEqual(await attachOnCommit({ root: repo.dir, projectId: 1, sha, commitFiles, store }), []);
    assert.equal(store.get(c.id).target, 'live');
  });
});

test('amending a commit flags its comments as rewritten, and restoring it clears the flag', async () => {
  await withRepo(async ({ repo, store, commentNew }) => {
    const lines = await changeLine5(repo);
    const c = commentNew(5, 'a.txt', lines);
    const sha = await repo.commit('change line 5');
    await attachOnCommit({ root: repo.dir, projectId: 1, sha, commitFiles: await commitDiff(repo.dir, sha), store });
    assert.deepEqual(await markRewritten({ root: repo.dir, projectId: 1, store }), []);
    assert.equal(store.get(c.id).rewritten, false);

    await repo.git('commit', '-q', '--amend', '-m', 'reworded');
    assert.deepEqual(await markRewritten({ root: repo.dir, projectId: 1, store }), [c.id]);
    assert.equal(store.get(c.id).rewritten, true);
    assert.deepEqual(store.rewrittenThreads(1).map((t) => t.id), [c.id]);
    assert.deepEqual(await markRewritten({ root: repo.dir, projectId: 1, store }), []); // stable

    await repo.git('branch', 'restore', sha);
    assert.deepEqual(await markRewritten({ root: repo.dir, projectId: 1, store }), [c.id]);
    assert.equal(store.get(c.id).rewritten, false);
  });
});

test('adding *.yml to extra hidden and wiping clears anchors', async () => {
  await withRepo(async ({ repo, store, live, commentNew }) => {
    await repo.write('ci.yml', 'a: 1\nb: 2\n');
    const c = commentNew(1, 'ci.yml', ['a: 1', 'b: 2', '']);
    const keep = commentNew(1, 'ci.txt', ['a: 1', 'b: 2', '']);
    const ids = store.wipeHidden(1, (p) => p.endsWith('.yml'));
    assert.deepEqual(ids, [c.id]);
    assert.equal(store.get(c.id).anchor, null);
    assert.equal(store.get(c.id).hidden, true);
    assert.notEqual(store.get(keep.id).anchor, null);
    // Wiped comments are ignored by re-anchoring.
    assert.deepEqual(await reanchorLive({ root: repo.dir, projectId: 1, files: await live(['*.yml']), store }), [keep.id]);
    assert.equal(store.get(c.id).outdated, false);
  });
});

test('a comment on .env is rejected', async () => {
  await withRepo(async ({ store }) => {
    await assert.rejects(async () => store.create({
      projectId: 1, target: 'live', path: '.env', line: 1, side: 'new', anchor: makeAnchor(['SECRET=1'], 1),
      authorEmail: 'r@example.com', body: 'hi',
    }), { name: 'ValidationError' });
  });
});
