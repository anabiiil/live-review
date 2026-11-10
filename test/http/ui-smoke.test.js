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

const APP_CSS = ['/static/css/tokens.css', '/static/css/base.css', '/static/css/shell.css', '/static/css/diff.css'];
/** @param {string} html @returns {string[]} stylesheet hrefs in order */
const stylesheets = (html) => [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);

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
  const res = await request(ports.publicPort, { method: 'POST', path: `/invite/${token}`, headers: { Host: HOST, Origin: `https://${HOST}` } });
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
    assert.deepEqual(stylesheets(res.body), APP_CSS, path);
    assert.ok(!res.body.includes('diff2html'), path);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(res.body), `${path}: no inline scripts`);
  }
  const login = await pub('/login');
  assert.equal(login.status, 200);
  assert.ok(login.body.includes('<div id="app">'));
});

test('/admin with the owner cookie returns the admin shell; without it, the terminal hint', async () => {
  const base = `127.0.0.1:${ctx.ports.adminPort}`;
  const exchange = await request(ctx.ports.adminPort, { path: `/admin?t=${ctx.app.services.owner.issueOneTime()}`, headers: { Host: base } });
  const cookie = `lr_owner=${exchange.cookies.lr_owner}`;
  const page = await request(ctx.ports.adminPort, { path: '/admin', headers: { Host: base, Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type']), /^text\/html/);
  assert.ok(page.body.includes('<div id="app">'));
  assert.ok(page.body.includes('src="/static/admin.js"'));
  assert.deepEqual(stylesheets(page.body), [...APP_CSS, '/static/admin.css']);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(page.body), 'no inline scripts');
  const anon = await request(ctx.ports.adminPort, { path: '/admin', headers: { Host: base } });
  assert.equal(anon.status, 401);
  assert.ok(!anon.body.includes('admin.js'));
});

test('admin modules and stylesheet are served from the admin listener and parse', async () => {
  const base = `127.0.0.1:${ctx.ports.adminPort}`;
  const files = (await listJs(PUBLIC_DIR)).filter((f) => f === 'admin.js' || f.startsWith('js/admin/'));
  assert.ok(files.length >= 7, files.join(','));
  for (const file of files) {
    const res = await request(ctx.ports.adminPort, { path: `/static/${file}`, headers: { Host: base } });
    assert.equal(res.status, 200, file);
    assert.match(String(res.headers['content-type']), /^text\/javascript/, file);
    await run(process.execPath, ['--check', join(PUBLIC_DIR, file)]);
  }
  const css = await request(ctx.ports.adminPort, { path: '/static/admin.css', headers: { Host: base } });
  assert.equal(css.status, 200);
  assert.match(String(css.headers['content-type']), /^text\/css/);
  assert.match(css.body, /\.copy-field/);
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

test('stylesheets are served as css; tokens carry the spec palette in light and dark', async () => {
  for (const href of APP_CSS) {
    const res = await pub(href);
    assert.equal(res.status, 200, href);
    assert.match(String(res.headers['content-type']), /^text\/css/, href);
  }
  const tokens = (await pub('/static/css/tokens.css')).body;
  assert.match(tokens, /prefers-color-scheme:\s*dark/);
  for (const hex of ['#F6F7FB', '#2F45D8', '#FFD84D', '#14161D', '#8C9BFF', '#F2C94C']) assert.ok(tokens.includes(hex), hex);
  assert.match(tokens, /"IBM Plex Sans", "IBM Plex Sans Arabic"/);
});

test('every font the tokens name is served as woff2 with a long cache', async () => {
  const tokens = (await pub('/static/css/tokens.css')).body;
  const urls = [...new Set([...tokens.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]))];
  // 3 weights: Plex Sans latin + latin-ext, Plex Sans Arabic arabic, Plex Mono latin + latin-ext.
  assert.equal(urls.length, 15, urls.join(','));
  for (const url of urls) {
    assert.match(url, /^\/vendor\/fonts\/ibm-plex-(sans|sans-arabic|mono)\/[a-z0-9-]+\.woff2$/, url);
    const res = await pub(url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers['content-type'], 'font/woff2', url);
    assert.match(String(res.headers['cache-control']), /max-age=31536000/, url);
  }
});

test('the font route serves only woff2 files of the three font packages', async () => {
  for (const path of [
    '/vendor/fonts/ibm-plex-sans/../../../package.json',
    '/vendor/fonts/ibm-plex-sans/%2e%2e%2fpackage.json',
    '/vendor/fonts/ibm-plex-sans/..%2f..%2fpackage.json',
    '/vendor/fonts/ibm-plex-sans/package.json',
    '/vendor/fonts/ibm-plex-sans/ibm-plex-sans-latin-400-normal.woff',
    '/vendor/fonts/ibm-plex-sans/400.css',
    '/vendor/fonts/ws/index.js',
    '/vendor/fonts/ibm-plex-sans/missing-400-normal.woff2',
  ]) {
    assert.equal((await pub(path)).status, 404, path);
  }
});

test('the invite page is styled with the shared stylesheets and has no scripts', async () => {
  const token = ctx.app.services.projects.createInvite(1, 'bob@example.com', Date.now());
  const res = await pub(`/invite/${token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(stylesheets(res.body), ['/static/css/tokens.css', '/static/css/base.css', '/static/css/shell.css']);
  assert.ok(!/<script/.test(res.body));
  assert.match(res.body, /<button class="btn primary[^"]*" type="submit">Continue<\/button>/);
});

test('modules never assign untrusted strings through innerHTML or similar sinks', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of await listJs(PUBLIC_DIR)) {
    const text = await readFile(join(PUBLIC_DIR, file), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(text), `${file} uses an HTML sink`);
  }
});
