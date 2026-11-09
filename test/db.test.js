import './helpers/quiet-sqlite.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, normalizeEmail } from '../src/db.js';

/** @param {(dir: string) => Promise<void>} fn */
async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'lr-db-'));
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

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  Foo@Example.COM \n'), 'foo@example.com');
});

test('openDb twice on the same file does not error and keeps data', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'x.db');
    const a = openDb(file);
    a.prepare("INSERT INTO projects(slug,name,path,created_at) VALUES('s','n','/p',1)").run();
    a.close();
    const b = openDb(file);
    assert.equal(b.prepare('SELECT COUNT(*) AS c FROM projects').get().c, 1);
    assert.equal(b.prepare('PRAGMA user_version').get().user_version, 1);
    b.close();
  });
});

test('openDb default file lives in the data dir, created if missing', async () => {
  await withDir(async (dir) => {
    process.env.LIVEREVIEW_DATA_DIR = join(dir, 'new', 'sub');
    const db = openDb();
    db.prepare("INSERT INTO users(email) VALUES('a@b.c')").run();
    db.close();
    const again = openDb(join(dir, 'new', 'sub', 'livereview.db'));
    assert.equal(again.prepare('SELECT COUNT(*) AS c FROM users').get().c, 1);
    again.close();
  });
});

test('foreign keys on and WAL enabled', async () => {
  await withDir(async (dir) => {
    const db = openDb(join(dir, 'x.db'));
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    db.close();
  });
});

test('deleting a project cascades members, invites and comments', async () => {
  await withDir(async (dir) => {
    const db = openDb(join(dir, 'x.db'));
    db.prepare("INSERT INTO projects(id,slug,name,path,created_at) VALUES(1,'s','n','/p',1)").run();
    db.prepare("INSERT INTO members(project_id,email,invited_at) VALUES(1,'a@b.c',1)").run();
    db.prepare("INSERT INTO invites(token_hash,project_id,email,expires_at) VALUES('h',1,'a@b.c',9)").run();
    db.prepare(
      "INSERT INTO comments(id,project_id,author_email,body,created_at,updated_at) VALUES(1,1,'a@b.c','hi',1,1)",
    ).run();
    db.prepare(
      "INSERT INTO comments(id,project_id,parent_id,author_email,body,created_at,updated_at) VALUES(2,1,1,'a@b.c','re',1,1)",
    ).run();
    db.prepare('DELETE FROM projects WHERE id=1').run();
    for (const t of ['members', 'invites', 'comments']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c, 0, t);
    }
    db.close();
  });
});

test('foreign key violations are rejected', async () => {
  await withDir(async (dir) => {
    const db = openDb(join(dir, 'x.db'));
    assert.throws(() =>
      db.prepare("INSERT INTO members(project_id,email,invited_at) VALUES(99,'a@b.c',1)").run(),
    );
    db.close();
  });
});

test('comment side is constrained and defaults are applied', async () => {
  await withDir(async (dir) => {
    const db = openDb(join(dir, 'x.db'));
    db.prepare("INSERT INTO projects(id,slug,name,path,created_at) VALUES(1,'s','n','/p',1)").run();
    assert.throws(() =>
      db
        .prepare(
          "INSERT INTO comments(project_id,side,author_email,body,created_at,updated_at) VALUES(1,'left','a@b.c','x',1,1)",
        )
        .run(),
    );
    db.prepare(
      "INSERT INTO comments(project_id,side,author_email,body,created_at,updated_at) VALUES(1,'new','a@b.c','x',1,1)",
    ).run();
    const row = db.prepare('SELECT resolved,outdated,rewritten,hidden FROM comments').get();
    assert.deepEqual({ ...row }, { resolved: 0, outdated: 0, rewritten: 0, hidden: 0 });
    assert.equal(db.prepare('SELECT extra_hidden FROM projects').get().extra_hidden, '[]');
    db.close();
  });
});

test('expected indexes exist', async () => {
  await withDir(async (dir) => {
    const db = openDb(join(dir, 'x.db'));
    const idx = (table) =>
      db
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .map((r) => db.prepare(`PRAGMA index_info(${r.name})`).all().map((c) => c.name).join(','));
    assert.ok(idx('comments').includes('project_id,target'));
    assert.ok(idx('sessions').includes('email'));
    assert.ok(idx('code_requests').includes('email,at'));
    assert.ok(idx('code_requests').includes('ip,at'));
    assert.ok(idx('invites').includes('project_id,email'));
    db.close();
  });
});
