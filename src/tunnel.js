import { spawn as nodeSpawn } from 'node:child_process';

export const CLOUDFLARED_HINT =
  `cloudflared isn't installed. Install it: macOS "brew install cloudflared", Windows "winget install --id Cloudflare.cloudflared". ` +
  'LiveReview will keep running without the public link.';

/**
 * Start the owner's own `cloudflared` as a visible child process (its output goes to this terminal).
 * Nothing is downloaded or installed here; if the program is missing we say how to install it and carry on.
 * `--no-autoupdate` stops cloudflared from replacing its own binary. `--url` is a `tunnel run` flag.
 * Resolves with the running child, or null when there is no tunnel configured or the program could not start.
 * @param {{tunnelName?:string, publicPort:number}} config
 * @param {{spawn?:typeof nodeSpawn, log?:(line:string)=>void}} [deps]
 * @returns {Promise<import('node:child_process').ChildProcess|null>}
 */
export async function startTunnel({ tunnelName, publicPort }, { spawn = nodeSpawn, log = console.log } = {}) {
  if (!tunnelName) return null;
  const child = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${publicPort}`, tunnelName],
    { stdio: 'inherit', windowsHide: false },
  );
  return new Promise((resolve) => {
    let started = false;
    child.once('spawn', () => {
      started = true;
      resolve(child);
    });
    child.on('error', (err) => {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') log(CLOUDFLARED_HINT);
      else log(`cloudflared could not be run: ${err.message}`);
      if (!started) resolve(null);
    });
    child.on('exit', (code) => {
      if (code) log(`cloudflared stopped (code ${code}).`);
    });
  });
}

/**
 * @param {import('node:child_process').ChildProcess|null|undefined} child
 */
export function stopTunnel(child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
}
