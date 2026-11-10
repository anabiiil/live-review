import { spawn as nodeSpawn } from 'node:child_process';

/**
 * Open a URL in the default browser. The URL is passed as a single argument (no shell). Failures are ignored:
 * the URL is also printed in the terminal.
 * @param {string} url
 * @param {{spawn?:typeof nodeSpawn, platform?:NodeJS.Platform}} [deps]
 */
export function openBrowser(url, { spawn = nodeSpawn, platform = process.platform } = {}) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    const child = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignored on purpose
  }
}
