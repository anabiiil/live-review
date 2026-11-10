/**
 * Hidden-file rules: files that look like secrets are never shown to reviewers.
 * Patterns are basename-only globs where `*` is the only wildcard.
 */

/** @typedef {import('../types.js').FileDiff} FileDiff */

export const DEFAULT_HIDDEN = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks',
  'id_rsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc', '.git-credentials',
  'credentials*.json', '*secret*', '*.kdbx', 'auth.json',
];

/** @type {Map<string, RegExp>} */
const cache = new Map();

/** @param {string} glob */
function globToRegExp(glob) {
  let re = cache.get(glob);
  if (!re) {
    const body = glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&'))
      .join('.*');
    re = new RegExp(`^${body}$`, 'is');
    cache.set(glob, re);
  }
  return re;
}

/** @param {string} path */
function basename(path) {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/**
 * Extra patterns are matched against the basename only, so a pattern containing "/" never matches.
 * @param {string} path
 * @param {string[]} [extra] additional basename globs
 * @returns {boolean}
 */
export function isHidden(path, extra = []) {
  const name = basename(path);
  return DEFAULT_HIDDEN.concat(extra).some((glob) => globToRegExp(glob).test(name));
}

/**
 * Returns copies of hidden files with content stripped; other files are passed through as-is.
 * Both `path` and `oldPath` are checked so a rename away from a secret file is also hidden.
 * @param {FileDiff[]} files
 * @param {string[]} [extra]
 * @param {Set<string>} [alsoHidden] exact repo-relative paths to hide as well (e.g. tracked but git-ignored)
 * @returns {FileDiff[]}
 */
export function redactFiles(files, extra = [], alsoHidden = new Set()) {
  /** @param {string|null} p */
  const hide = (p) => p !== null && (alsoHidden.has(p) || isHidden(p, extra));
  return files.map((f) => {
    if (!hide(f.path) && !hide(f.oldPath)) return f;
    return {
      ...f,
      hidden: true,
      hunks: [],
      patch: `diff --git a/${f.oldPath ?? f.path} b/${f.path}\n`,
    };
  });
}
