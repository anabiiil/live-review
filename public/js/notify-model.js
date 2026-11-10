// Pure helpers for the notification center. No DOM access: importable from node for tests.

/**
 * A notification as the server sends it (live `notification` message and `/api/notifications`).
 * @typedef {{id:number, kind:'comment'|'reply'|'resolved'|'reopened', projectSlug:string, projectName:string,
 *   commentId:number, threadId:number, path:string, line:number|null, target:string, actorName:string,
 *   excerpt:string, url:string, createdAt:number, read:boolean, yours?:boolean}} Note
 */

export const LIST_LIMIT = 30;

/**
 * One line saying what happened, e.g. "Rana replied on app.php:3".
 * @param {Note} n
 */
export function notificationText(n) {
  const file = n.path.slice(n.path.lastIndexOf('/') + 1);
  const where = n.line === null ? file : `${file}:${n.line}`;
  const whose = n.yours ? 'your' : 'a';
  if (n.kind === 'comment') return `${n.actorName} commented on ${where}`;
  if (n.kind === 'reply') return `${n.actorName} replied on ${where}`;
  if (n.kind === 'resolved') return `${n.actorName} marked ${whose} comment on ${where} resolved`;
  return `${n.actorName} reopened ${whose} comment on ${where}`;
}

/**
 * Put a notification at the top of the list (replacing an older copy), keeping at most `limit`.
 * @param {Note[]} list
 * @param {Note} n
 * @param {number} [limit]
 */
export const mergeNotifications = (list, n, limit = LIST_LIMIT) => [n, ...list.filter((x) => x.id !== n.id)].slice(0, limit);

/** @param {number} n */
export const unreadBadge = (n) => (n <= 0 ? '' : n > 99 ? '99+' : String(n));

/** @param {number} n */
export const unreadLabel = (n) => (n > 0 ? `Notifications, ${n} unread` : 'Notifications');

/**
 * A same-site path from the server, or null. Anything else (other origin, protocol-relative, control
 * characters the URL parser would drop) is refused; the path must resolve to `origin`.
 * @param {unknown} url
 * @param {string} [origin] the page's origin (location.origin in the browser)
 * @returns {string|null}
 */
export function internalUrl(url, origin = typeof location === 'undefined' ? 'https://livereview.invalid' : location.origin) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    if (new URL(url, origin).origin !== origin) return null;
  } catch {
    return null;
  }
  return url;
}
