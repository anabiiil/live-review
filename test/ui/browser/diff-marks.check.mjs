// Browser check for the diff's margin comment marks (not part of `npm test`): `npm run check:ui`.
// Boots an isolated app (temp data dir, temp demo repo, random ports; never the owner's data or ports) and drives
// it with Playwright on the system Chrome. Playwright is not a dependency: install it where Node can find it
// (`npm i --no-save playwright-core`) or point LR_PLAYWRIGHT at a playwright-core/index.mjs.
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..', '..');

async function loadPlaywright() {
  const candidates = [process.env.LR_PLAYWRIGHT && pathToFileURL(process.env.LR_PLAYWRIGHT).href, 'playwright-core', 'playwright'].filter(Boolean);
  for (const c of candidates) {
    try {
      const m = await import(/** @type {string} */ (c));
      return m.chromium ?? m.default?.chromium;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const chromium = await loadPlaywright();
if (!chromium) {
  console.log('Skipped: Playwright not found. Run `npm i --no-save playwright-core` (uses your installed Chrome),');
  console.log('or set LR_PLAYWRIGHT=/path/to/playwright-core/index.mjs, then `npm run check:ui` again.');
  process.exit(0);
}

process.env.LIVEREVIEW_DATA_DIR = await mkdtemp(join(tmpdir(), 'lr-check-data-'));
await import(join(ROOT, 'src/quietSqlite.js'));
const { createApp } = await import(join(ROOT, 'src/app.js'));
const { openDb } = await import(join(ROOT, 'src/db.js'));

const repo = await realpath(await mkdtemp(join(tmpdir(), 'lr-check-repo-')));
const git = (/** @type {string[]} */ ...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'rana@example.test');
git('config', 'user.name', 'Rana Haddad');
await writeFile(join(repo, 'app.php'), '<?php\nfunction a() {\n  return 1;\n}\n');
await writeFile(join(repo, 'util.js'), 'export const add = (a, b) => a + b;\n');
git('add', '.');
git('commit', '-qm', 'Initial');
await writeFile(join(repo, 'app.php'), '<?php\nfunction a() {\n  return 2; // changed\n}\n');
await writeFile(join(repo, 'util.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');

const config = { publicHost: 'localhost:1', ownerName: 'Owner', ownerEmail: 'owner@check.test', fromEmail: '', resendApiKey: '', tunnelName: '', publicPort: 0, adminPort: 0 };
const app = createApp({ config, db: openDb(join(process.env.LIVEREVIEW_DATA_DIR, 'lr.db')) });
const ports = await app.start();
await app.services.projects.add({ path: repo, name: 'Demo' });
const base = `http://localhost:${ports.adminPort}`;
const ex = await fetch(`${base}/admin?t=${app.services.owner.issueOneTime()}`, { redirect: 'manual' });
const cookie = String(ex.headers.get('set-cookie')).split(';')[0];
for (const [line, body] of /** @type {[number, string][]} */ ([[3, 'Why 2 here?'], [2, 'لماذا تغيّر هذا السطر؟']])) {
  const r = await fetch(`${base}/api/p/demo/comments`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'live', path: 'app.php', line, side: 'new', body }),
  });
  if (!r.ok) throw new Error(`seeding a comment failed: ${r.status}`);
}

let failed = 0;
const ok = (/** @type {unknown} */ cond, /** @type {string} */ msg) => {
  console.log(cond ? 'PASS' : 'FAIL', msg);
  if (!cond) failed++;
};

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  /** @type {string[]} */
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/admin?t=${app.services.owner.issueOneTime()}`);
  await page.evaluate(() => localStorage.setItem('lr-diff-mode', 'unified'));
  await page.goto(`${base}/demo/live`);
  await page.waitForSelector('.mark');
  const threads = async () => (await page.$$('.thread')).length;
  const focusKey = () => page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.dataset?.focusKey ?? null);

  ok((await threads()) === 0, 'threads are collapsed by default');
  ok((await page.$$('.mark')).length === 2, 'each commented line has a mark');
  const mark = page.locator('.mark').nth(1);
  ok((await mark.getAttribute('aria-expanded')) === 'false', 'a closed mark says aria-expanded=false');

  // Keyboard: Enter on the mark opens the thread and focus stays on the (rebuilt) mark.
  await mark.focus();
  const key = await focusKey();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.thread');
  ok((await threads()) === 1, 'Enter on a mark opens its thread');
  ok((await focusKey()) === key && key !== null, 'focus stays on the mark after it opens');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  ok((await threads()) === 0, 'Enter again closes it');
  ok((await focusKey()) === key, 'focus stays on the mark after it closes');

  // Double click does not flicker: the second toggle waits for the close animation.
  await page.locator('.mark').nth(1).click();
  await page.waitForSelector('.thread');
  await page.locator('.mark').nth(1).dblclick();
  await page.waitForTimeout(300);
  ok((await threads()) === 0, 'a double click while closing leaves the thread closed');

  // File header controls keep focus too.
  await page.focus('.file-comments');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  ok((await threads()) === 2, 'the file header opens every thread of the file');
  ok((await focusKey()) === 'filecomments:app.php', 'focus stays on the file header count');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.focus('section.file[data-path="app.php"] .file-toggle');
  await page.keyboard.press('Enter');
  ok((await focusKey()) === 'filetoggle:app.php', 'focus stays on the file chevron');
  await page.keyboard.press('Enter');

  // Resolve keeps focus on the (now Reopen) button.
  await page.locator('.mark').nth(1).click();
  await page.waitForSelector('.thread');
  await page.focus('.thread button[data-focus-key^="resolve:"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.thread.resolved');
  ok(String(await focusKey()).startsWith('resolve:'), 'focus stays on Resolve, now Reopen');
  ok((await page.evaluate(() => document.activeElement?.textContent)) === 'Reopen', 'the focused button now reads Reopen');

  // Open state and a reply draft survive a live re-render.
  await page.click('.thread button.link:has-text("Reply")');
  await page.keyboard.type('draft reply');
  await writeFile(join(repo, 'util.js'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  await page.waitForFunction(() => document.body.textContent?.includes('mul'), null, { timeout: 8000 });
  ok((await threads()) === 1, 'open threads stay open across a live re-render');
  ok((await page.$eval('textarea[data-draft^="reply:"]', (t) => /** @type {HTMLTextAreaElement} */ (t).value)) === 'draft reply', 'the reply draft survives');

  // Deep link opens and flashes.
  const id = await page.evaluate(() => Number(document.querySelector('.thread')?.id.slice(2)));
  await page.goto(`${base}/demo/commits`);
  await page.goto(`${base}/demo/live#c-${id}`);
  await page.waitForSelector(`#c-${id}`);
  ok(await page.$eval(`#c-${id}`, (e) => e.classList.contains('flash')), 'a #c-id link opens the thread and flashes it');

  // Comments page: filters, Hide / Unhide, Show hidden and Resolve keep keyboard focus; a card that is
  // filtered out hands focus to the next card (else the heading).
  await page.goto(`${base}/demo/comments`);
  await page.waitForSelector('.ccard');
  const cardOf = () => page.evaluate(() => /** @type {HTMLElement|null} */ (document.activeElement?.closest('[data-thread]'))?.dataset.thread ?? null);
  await page.focus('button[data-focus-key="status:all"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  ok((await focusKey()) === 'status:all', 'focus stays on a status filter');
  const ids = await page.$$eval('.ccard', (cs) => cs.map((c) => /** @type {HTMLElement} */ (c).dataset.thread));
  ok(ids.length === 2, 'All shows both threads');
  await page.focus(`button[data-focus-key="hide:${ids[0]}"]`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  ok((await cardOf()) === ids[1], 'hiding a card moves focus into the next card');
  await page.focus('button[data-focus-key="showhidden"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  ok((await focusKey()) === 'showhidden', 'focus stays on Show hidden');
  await page.focus(`button[data-focus-key="hide:${ids[0]}"]`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  ok((await focusKey()) === `hide:${ids[0]}`, 'focus stays on Unhide');
  const resolveKey = await page.$eval('.ccard button[data-focus-key^="resolve:"]', (b) => /** @type {HTMLElement} */ (b).dataset.focusKey);
  await page.focus(`button[data-focus-key="${resolveKey}"]`);
  const before = await page.$eval(`button[data-focus-key="${resolveKey}"]`, (b) => b.textContent);
  await page.keyboard.press('Enter');
  await page.waitForFunction(([k, t]) => document.querySelector(`button[data-focus-key="${k}"]`)?.textContent !== t, [resolveKey, before]);
  ok((await focusKey()) === resolveKey, 'focus stays on Resolve / Reopen');
  // Reopening in the Resolved view filters the card out.
  await page.focus('button[data-focus-key="status:resolved"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const openKey = await page.$eval('.ccard button[data-focus-key^="resolve:"]', (b) => /** @type {HTMLElement} */ (b).dataset.focusKey);
  await page.focus(`button[data-focus-key="${openKey}"]`);
  await page.keyboard.press('Enter');
  await page.waitForFunction((k) => !document.querySelector(`button[data-focus-key="${k}"]`), openKey);
  ok(await page.evaluate(() => document.activeElement?.tagName === 'H1' || !!document.activeElement?.closest('[data-thread]')),
    'reopening a card in the Resolved view moves focus to the next card or the heading, not the body');

  // Phone: the mark stays in reach when the code is scrolled sideways.
  await page.goto(`${base}/demo/live`);
  await page.waitForSelector('.mark');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(300);
  await page.$eval('.file-body', (b) => (b.scrollLeft = 500));
  const box = await page.locator('.mark').first().boundingBox();
  ok(box && box.x + box.width <= 375 && box.x > 250, 'the mark stays in view on a phone');

  ok(errs.length === 0, `no page errors${errs.length ? `: ${errs.join('; ')}` : ''}`);
} finally {
  await browser.close();
  await app.stop();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
