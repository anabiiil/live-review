import { watch } from 'chokidar';
import { resolve, sep } from 'node:path';
import { runGit } from '../git/run.js';
import { gitDir } from '../git/repo.js';

/**
 * Entries of the git directory that signal commits, checkouts and staging.
 * Git replaces HEAD and index by renaming a `.lock` file over them, which
 * file-level watchers can miss, so the creation and removal of the lock files
 * is treated as the signal too.
 */
const GIT_WATCHED = new Set(['HEAD', 'HEAD.lock', 'index', 'index.lock', 'refs', 'packed-refs', 'packed-refs.lock']);

/**
 * Normalize a path for comparison (case-insensitive on Windows).
 * @param {string} p
 */
function norm(p) {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * Directories and files git reports as ignored (and untracked) at this moment.
 * @param {string} root
 * @returns {Promise<{dirs: Set<string>, files: Set<string>}>}
 */
async function listIgnored(root) {
  const { stdout } = await runGit(root, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
  ]);
  const dirs = new Set();
  const files = new Set();
  for (const entry of stdout.split('\0')) {
    if (entry === '') continue;
    if (entry.endsWith('/')) dirs.add(norm(resolve(root, entry.slice(0, -1))));
    else files.add(norm(resolve(root, entry)));
  }
  return { dirs, files };
}

/**
 * Build the `ignored` predicate for the working tree watcher.
 * @param {string} root
 * @param {{dirs: Set<string>, files: Set<string>}} ignored
 * @returns {(path: string) => boolean}
 */
function workTreeIgnored(root, { dirs, files }) {
  const rootN = norm(root);
  return (path) => {
    const p = norm(path);
    if (p !== rootN && !p.startsWith(rootN + sep)) return false;
    const segments = p.slice(rootN.length).split(sep);
    // `.git` anywhere below the root: the repository's own and those of nested repositories and submodules.
    if (segments.includes('.git') || segments.includes('node_modules')) return true;
    if (files.has(p)) return true;
    for (let cur = p; cur.length > rootN.length; cur = cur.slice(0, cur.lastIndexOf(sep))) {
      if (dirs.has(cur)) return true;
    }
    return false;
  };
}

/**
 * `ignored` predicate for a git directory: only HEAD, index, refs and packed-refs matter.
 * @param {string} dir
 * @returns {(path: string) => boolean}
 */
function gitDirIgnored(dir) {
  const dirN = norm(dir);
  return (path) => {
    const p = norm(path);
    if (p === dirN) return false;
    if (!p.startsWith(dirN + sep)) return true;
    return !GIT_WATCHED.has(p.slice(dirN.length + 1).split(sep)[0]);
  };
}

/**
 * Reject when `promise` has not settled within `ms`.
 * @param {Promise<void>} promise
 * @param {number} ms
 * @returns {Promise<void>}
 */
function withTimeout(promise, ms) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`watcher not ready after ${ms} ms`)), ms);
  });
  promise.catch(() => {}); // a late failure after the timeout is not unhandled
  return /** @type {Promise<void>} */ (Promise.race([promise, timeout])).finally(() => clearTimeout(timer));
}

/**
 * @typedef {object} Entry
 * @property {number} refs
 * @property {import('chokidar').FSWatcher[]} watchers
 * @property {Promise<void>} ready
 * @property {ReturnType<typeof setTimeout>|null} debounce
 * @property {ReturnType<typeof setTimeout>|null} grace
 * @property {boolean} closed
 */

/**
 * Pool of per-project file watchers, shared by reference count and closed
 * `graceMs` after their last user releases them. Acquire fails if the watcher is not ready within `readyTimeoutMs`.
 * @param {{onChange: (projectId: number) => void, debounceMs?: number, graceMs?: number, readyTimeoutMs?: number}} opts
 */
export function createWatcherPool({ onChange, debounceMs = 300, graceMs = 60000, readyTimeoutMs = 15000 }) {
  /** @type {Map<number, Entry>} */
  const entries = new Map();
  let loggedChangeError = false;

  /**
   * @param {number} projectId
   * @param {Entry} entry
   */
  function schedule(projectId, entry) {
    if (entry.closed) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = null;
      if (entry.closed) return;
      try {
        onChange(projectId);
      } catch (err) {
        if (!loggedChangeError) {
          loggedChangeError = true;
          console.error('watcher onChange failed:', err);
        }
      }
    }, debounceMs);
  }

  /**
   * @param {number} projectId
   * @param {Entry} entry
   * @param {string} root
   */
  async function setup(projectId, entry, root) {
    const [ignored, dir, common] = await Promise.all([
      listIgnored(root),
      gitDir(root),
      runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((r) =>
        resolve(r.stdout.replace(/\r?\n$/, '')),
      ),
    ]);
    if (entry.closed) return;
    /** @type {Array<[string, (p: string) => boolean, boolean]>} */
    const targets = [
      [root, workTreeIgnored(root, ignored), false],
      [dir, gitDirIgnored(dir), true],
    ];
    // In a linked worktree, branch refs live in the common git directory.
    if (norm(common) !== norm(dir)) targets.push([common, gitDirIgnored(common), true]);

    await Promise.all(
      targets.map(([path, isIgnored, isGitDir]) => {
        const w = watch(path, {
          ignored: isIgnored,
          ignoreInitial: true,
          followSymlinks: false,
          awaitWriteFinish: false,
          atomic: true,
        });
        entry.watchers.push(w);
        w.on('all', () => schedule(projectId, entry));
        if (isGitDir) {
          // chokidar can drop the lock-and-rename dance git uses to replace
          // index and HEAD; the raw fs events are reliable, so use them too.
          w.on('raw', (_event, name, details) => {
            const watched = typeof details?.watchedPath === 'string' ? norm(details.watchedPath) : null;
            if (watched === norm(path) && !GIT_WATCHED.has(String(name))) return;
            schedule(projectId, entry);
          });
        }
        w.on('error', (err) => console.error(`watcher error (project ${projectId}):`, err));
        return new Promise((done) => w.once('ready', done));
      }),
    );
  }

  /** @param {Entry} entry */
  async function closeEntry(entry) {
    entry.closed = true;
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.grace) clearTimeout(entry.grace);
    entry.debounce = entry.grace = null;
    await entry.ready.catch(() => {});
    await Promise.all(entry.watchers.map((w) => w.close().catch(() => {})));
  }

  /**
   * @param {number} projectId
   * @param {Entry} entry
   */
  function remove(projectId, entry) {
    if (entries.get(projectId) === entry) entries.delete(projectId);
  }

  return {
    /**
     * Start (or join) watching a project; resolves once the watcher is ready.
     * @param {number} projectId
     * @param {string} root
     * @returns {Promise<void>}
     */
    async acquire(projectId, root) {
      const existing = entries.get(projectId);
      if (existing) {
        existing.refs++;
        if (existing.grace) {
          clearTimeout(existing.grace);
          existing.grace = null;
        }
        return existing.ready;
      }
      /** @type {Entry} */
      const entry = {
        refs: 1,
        watchers: [],
        ready: Promise.resolve(),
        debounce: null,
        grace: null,
        closed: false,
      };
      entry.ready = withTimeout(setup(projectId, entry, root), readyTimeoutMs);
      entries.set(projectId, entry);
      try {
        await entry.ready;
      } catch (err) {
        remove(projectId, entry);
        await closeEntry(entry);
        throw err;
      }
    },

    /**
     * Drop one reference; the watcher closes `graceMs` after the last one.
     * @param {number} projectId
     */
    release(projectId) {
      const entry = entries.get(projectId);
      if (!entry || entry.refs === 0) return;
      entry.refs--;
      if (entry.refs > 0 || entry.grace) return;
      entry.grace = setTimeout(() => {
        entry.grace = null;
        remove(projectId, entry);
        void closeEntry(entry);
      }, graceMs);
    },

    /** @returns {number[]} ids of projects currently watched (including those in grace) */
    active() {
      return [...entries.keys()];
    },

    /** Close every watcher and cancel all timers. */
    async closeAll() {
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(all.map(closeEntry));
    },
  };
}
