// Pure helpers for the app shell (top bar, project rows). No DOM access: importable from node for tests.

/**
 * Avatar letters: first letters of the first and last word of the name, else the email's first letter.
 * @param {string|null|undefined} name
 * @param {string|null|undefined} email
 * @returns {string}
 */
export function initials(name, email) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = (/** @type {string} */ w) => Array.from(w)[0] ?? '';
  let out = '';
  if (words.length) out = first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '');
  else out = first(String(email ?? '').trim());
  return out ? out.toLocaleUpperCase() : '?';
}

/**
 * Text for a count shown beside a tab (empty when there is nothing open).
 * @param {number} n
 * @returns {string}
 */
export function openCount(n) {
  if (!n || n < 0) return '';
  return n > 999 ? '999+' : String(n);
}

/**
 * Open-comment wording for a project row.
 * @param {{open:number}} p
 * @returns {string}
 */
export function projectRowMeta({ open }) {
  if (!open) return 'No open comments';
  return open === 1 ? '1 open comment' : `${open} open comments`;
}

/**
 * The secondary line of a project row: branch and last change, e.g. "On main, updated 5 minutes ago".
 * Null when neither is known.
 * @param {{branch?:string|null, lastChangeAt?:number|null}} p
 * @param {number} [now] epoch ms
 * @returns {string|null}
 */
export function projectActivity({ branch = null, lastChangeAt = null }, now = Date.now()) {
  /** @type {string[]} */
  const parts = [];
  if (branch) parts.push(`on ${branch}`);
  if (typeof lastChangeAt === 'number' && Number.isFinite(lastChangeAt)) parts.push(`updated ${ago(lastChangeAt, now)}`);
  if (!parts.length) return null;
  const text = parts.join(', ');
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * "just now", "1 minute ago", "3 hours ago", "2 days ago", else "on YYYY-MM-DD".
 * @param {number} t epoch ms
 * @param {number} now epoch ms
 */
function ago(t, now) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  /** @param {number} n @param {string} unit */
  const n = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 45) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return n(min, 'minute');
  const h = Math.round(s / 3600);
  if (h < 24) return n(h, 'hour');
  const d = Math.round(s / 86400);
  if (d < 30) return n(d, 'day');
  return `on ${new Date(t).toISOString().slice(0, 10)}`;
}
