#!/usr/bin/env node
// LiveReview entry point. Nothing that loads node:sqlite is imported until the Node version has been checked.

const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`LiveReview needs Node.js 24 or newer (you have v${process.versions.node}).`);
  process.exit(1);
}

await import('../src/quietSqlite.js');
const { loadConfig } = await import('../src/config.js');
const { openDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { startTunnel, stopTunnel } = await import('../src/tunnel.js');
const { openBrowser } = await import('../src/openBrowser.js');

/** @param {unknown} err */
function fail(err) {
  const e = /** @type {NodeJS.ErrnoException} */ (err);
  if (e && e.code === 'EADDRINUSE') {
    console.error(`Port ${e.port} is already in use. Is LiveReview already running?`);
  } else {
    console.error(`LiveReview could not start: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(1);
}

/** @type {ReturnType<typeof openDb>|undefined} */
let db;
/** @type {ReturnType<typeof createApp>} */
let app;
/** @type {{publicPort:number, adminPort:number}} */
let ports;
/** @type {ReturnType<typeof loadConfig>} */
let config;
try {
  config = loadConfig();
  db = openDb();
  app = createApp({ config, db });
  ports = await app.start();
} catch (err) {
  db?.close();
  fail(err);
}

const token = app.services.owner.issueOneTime();
const adminUrl = `http://localhost:${ports.adminPort}/admin?t=${token}`;
console.log('LiveReview is running.');
console.log(`  Admin (this computer only): ${adminUrl}`);
console.log(config.publicHost ? `  Public: https://${config.publicHost}` : '  Public: not configured yet — open the admin page to set it up');

if (process.env.LIVEREVIEW_NO_BROWSER !== '1') openBrowser(adminUrl);

/** @type {import('node:child_process').ChildProcess|null} */
let tunnel = null;
let shuttingDown = false;
void startTunnel({ tunnelName: config.tunnelName, publicPort: ports.publicPort }).then((child) => {
  tunnel = child;
  if (shuttingDown) stopTunnel(child);
});
// Whatever way we leave, cloudflared does not outlive LiveReview.
process.on('exit', () => stopTunnel(tunnel));

async function shutdown() {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  stopTunnel(tunnel);
  try {
    await app.stop();
    db?.close();
  } catch (err) {
    console.error('LiveReview did not shut down cleanly:', err);
    process.exit(1);
  }
  process.exit(0);
}

for (const signal of process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void shutdown());
}
