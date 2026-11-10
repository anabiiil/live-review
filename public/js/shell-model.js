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
