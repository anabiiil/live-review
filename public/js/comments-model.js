// Pure helpers for the comments page. No DOM access: importable from node for tests.

/**
 * A thread as the threads listings send it (`/api/p/:slug/threads`, `/api/admin/threads`).
 * @typedef {{id:number, path:string, line:number|null, side:'old'|'new'|null, target:string, resolved:boolean,
 *   outdated:boolean, rewritten:boolean, hidden:boolean, authorEmail:string, replies:{authorEmail:string}[],
 *   snippet?:{no:number, text:string, focus:boolean}[]|null, slug?:string, projectName?:string}} ListedThread
 */
/** @typedef {'open'|'resolved'|'all'} Status */

/** Hidden threads remembered per viewer; the oldest are forgotten past this. */
const MAX_HIDDEN = 2000;

/**
 * Whether the viewer started the thread or replied in it.
 * @param {ListedThread} t
 * @param {string} email
 */
export function isMineThread(t, email) {
  const e = email.toLowerCase();
  return t.authorEmail.toLowerCase() === e || t.replies.some((r) => r.authorEmail.toLowerCase() === e);
}

/**
 * The threads to show for the filters, the per-status counts (for the filter labels) and how many threads of
 * the chosen status the viewer hid.
 * @template {ListedThread} T
 * @param {T[]} threads
 * @param {{status:Status, onlyMine:boolean, email:string, hidden:Set<number>, showHidden:boolean}} o
 * @returns {{visible:T[], counts:{open:number, resolved:number, all:number}, hiddenCount:number}}
 */
export function filterThreads(threads, { status, onlyMine, email, hidden, showHidden }) {
  const base = onlyMine ? threads.filter((t) => isMineThread(t, email)) : threads;
  /** @param {T} t */
  const matches = (t) => status === 'all' || (status === 'resolved' ? t.resolved : !t.resolved);
  const shown = showHidden ? base : base.filter((t) => !hidden.has(t.id));
  const counts = { open: 0, resolved: 0, all: shown.length };
  for (const t of shown) counts[t.resolved ? 'resolved' : 'open'] += 1;
  return {
    visible: shown.filter(matches),
    counts,
    hiddenCount: base.filter((t) => hidden.has(t.id) && matches(t)).length,
  };
}

/**
 * Threads grouped by file (and by project when the list spans projects), groups in the order they first
 * appear (the listing is newest first), threads within a file by line.
 * @template {ListedThread} T
 * @param {T[]} threads
 * @returns {{key:string, slug:string|undefined, projectName:string|undefined, path:string, threads:T[]}[]}
 */
export function groupThreads(threads) {
  /** @type {Map<string, {key:string, slug:string|undefined, projectName:string|undefined, path:string, threads:T[]}>} */
  const groups = new Map();
  for (const t of threads) {
    const key = `${t.slug ?? ''}\n${t.path}`;
    const g = groups.get(key);
    if (g) g.threads.push(t);
    else groups.set(key, { key, slug: t.slug, projectName: t.projectName, path: t.path, threads: [t] });
  }
  const list = [...groups.values()];
  for (const g of list) g.threads.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.id - b.id);
  return list;
}

/**
 * Where "Show in code" goes: the line in Changes (live, outdated and rewritten threads are listed there) or
 * in the commit. Null for a thread on a file that is hidden now: it is shown nowhere.
 * @param {ListedThread} t
 * @param {string} slug
 * @returns {string|null}
 */
export function showInCodeHref(t, slug) {
  if (t.hidden) return null;
  const s = encodeURIComponent(slug);
  if (t.target === 'live' || t.rewritten) return `/${s}/live#c-${t.id}`;
  return `/${s}/commit/${encodeURIComponent(t.target)}#c-${t.id}`;
}

/**
 * Where the thread lives, in a few words.
 * @param {ListedThread} t
 */
export function threadPlace(t) {
  if (t.hidden) return 'Hidden file';
  if (t.target === 'live') return t.outdated ? 'Outdated' : 'Changes';
  return `${t.rewritten ? 'Rewritten commit' : 'Commit'} ${t.target.slice(0, 7)}`;
}

/** @param {{path:string, line:number|null}} t */
export const whereText = (t) => (t.line === null ? t.path : `${t.path}:${t.line}`);

/** @param {string} email */
export const hiddenKey = (email) => `lr-hidden-threads:${email.toLowerCase()}`;

/**
 * @param {string|null} raw the stored value
 * @returns {Set<number>}
 */
export function parseHidden(raw) {
  try {
    const v = JSON.parse(raw ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => Number.isSafeInteger(x) && x > 0) : []);
  } catch {
    return new Set();
  }
}

/** @param {Set<number>} set */
export const serializeHidden = (set) => JSON.stringify([...set].slice(-MAX_HIDDEN));

/**
 * @param {Set<number>} set
 * @param {number} id
 */
export function toggleHidden(set, id) {
  if (!set.delete(id)) set.add(id);
}
