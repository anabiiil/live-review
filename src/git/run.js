import { spawn } from 'node:child_process';

/** Error thrown when a git command exits non-zero (or cannot be started). */
export class GitError extends Error {
  /**
   * @param {{code:number, stderr:string, args:string[]}} info
   */
  constructor({ code, stderr, args }) {
    const detail = stderr.trim().split('\n')[0] || `exit code ${code}`;
    super(`git ${args.join(' ')} failed: ${detail}`);
    this.name = 'GitError';
    /** @type {number} */
    this.code = code;
    /** @type {string} */
    this.stderr = stderr;
    /** @type {string[]} */
    this.args = args;
  }
}

/** Variables that would redirect git to a different repository than `cwd`. */
const REDIRECTING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR'];

/** @returns {NodeJS.ProcessEnv} */
function gitEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const key of REDIRECTING_ENV) delete env[key];
  return env;
}

/**
 * Run git without a shell. Output is collected as UTF-8.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{input?: string, allowFail?: boolean}} [opts]
 * @returns {Promise<{stdout: string, code: number}>}
 */
export function runGit(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      windowsHide: true,
      env: gitEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    let settled = false;
    /** @param {number} code */
    const finish = (code) => {
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0 && !opts.allowFail) {
        reject(new GitError({ code, stderr, args }));
      } else {
        resolve({ stdout, code });
      }
    };
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new GitError({ code: -1, stderr: String(e.message), args }));
    });
    child.on('close', (code) => finish(code ?? -1));
    // Ignore EPIPE when git exits before consuming stdin.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}
