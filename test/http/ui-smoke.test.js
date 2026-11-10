import '../helpers/quiet-sqlite.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openDb } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { makeTmpRepo } from '../helpers/tmpRepo.js';
import { request } from '../helpers/http.js';

const run = promisify(execFile);
const HOST = 'review.example.test';
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

/** @type {Awaited<ReturnType<typeof setup>>} */
let ctx;

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'livereview-ui-'));
  const db = openDb(join(dataDir, 'livereview.db'));
  const config = {
    publicHost: HOST, resendApiKey: 're_test', fromEmail: 'lr@example.test', ownerName: 'Olivia',
    ownerEmail: 'owner@example.test', tunnelName: '', publicPort: 0, adminPort: 0,
  };
  const app = createApp({ config, db, emailSender: { async send() { return { ok: true }; } } });
  const ports = await app.start();
  const repo = await makeTmpRepo();
  await repo.write('a.txt', 'one\n');
  await repo.commit('initial');
  const sha = (await repo.git('rev-parse', 'HEAD')).trim();
  const project = await app.services.projects.add({ path: repo.dir, name: 'Sample' });
  app.services.projects.addMember(project.id, 'alice@example.com');
  const token = app.services.projects.createInvite(project.id, 'alice@example.com', Date.now());
  const res = await request(ports.publicPort, { path: `/invite/${token}`, headers: { Host: HOST } });
  return { dataDir, db, app, ports, repo, sha, cookie: `lr_session=${res.cookies.lr_session}` };
}

/** @param {string} dir @returns {Promise<string[]>} paths relative to `dir` */
async function listJs(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name.endsWith('.js')) out.push(relative(dir, join(e.parentPath, e.name)).split('\\').join('/'));
  }
  return out.sort();
}

/** @param {string} path @param {string} [cookie] */
const pub = (path, cookie) => request(ctx.ports.publicPort, { path, headers: { Host: HOST, ...(cookie ? { Cookie: cookie } : {}) } });

before(async () => {
  ctx = await setup();
});

after(async () => {
  await ctx.app.stop();
  ctx.db.close();
  await ctx.repo.cleanup();
  await rm(ctx.dataDir, { recursive: true, force: true });
});

test('every page route returns the app shell', async () => {
  const paths = ['/', '/sample', '/sample/live', '/sample/commits', `/sample/commit/${ctx.sha}`];
  for (const path of paths) {
    const res = await pub(path, ctx.cookie);
    assert.equal(res.status, 200, path);
    assert.match(String(res.headers['content-type']), /^text\/html/, path);
    assert.ok(res.body.includes('<div id="app">'), path);
    assert.ok(res.body.includes('src="/static/app.js"'), path);
    assert.ok(res.body.includes('href="/static/app.css"'), path);
    assert.ok(!res.body.includes('diff2html'), path);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(res.body), `${path}: no inline scripts`);
  }
  const login = await pub('/login');
  assert.equal(login.status, 200);
  assert.ok(login.body.includes('<div id="app">'));
});

test('every module under public/ is served as javascript and parses', async () => {
  const files = await listJs(PUBLIC_DIR);
  assert.ok(files.includes('app.js') && files.length >= 12, files.join(','));
  for (const file of files) {
    const res = await pub(`/static/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(String(res.headers['content-type']), /^text\/javascript/, file);
    await run(process.execPath, ['--check', join(PUBLIC_DIR, file)]);
  }
});

test('app.css is served as css with the dark scheme', async () => {
  const res = await pub('/static/app.css');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /^text\/css/);
  assert.match(res.body, /prefers-color-scheme:\s*dark/);
});

test('modules never assign untrusted strings through innerHTML or similar sinks', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of await listJs(PUBLIC_DIR)) {
    const text = await readFile(join(PUBLIC_DIR, file), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(text), `${file} uses an HTML sink`);
  }
});
