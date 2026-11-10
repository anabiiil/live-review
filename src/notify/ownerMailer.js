// Emails the owner when reviewers comment, so comments reach them even when the admin page is closed.
// Comments arriving close together are batched into one email.

const BODY_MAX = 500;

/**
 * @typedef {{projectId:number, target:string, commentId:number, kind:string, byOwner:boolean}} CommentChange
 * @typedef {{id:number, projectId:number, parentId:number|null, target:string, path:string, line:number,
 *   body:string, authorEmail:string, authorName:string|null}} CommentLike
 */

/**
 * @param {{
 *   config: {ownerEmail?:string, resendApiKey?:string, fromEmail?:string},
 *   sender: {send:(m:{to:string, subject:string, text:string})=>Promise<{ok:boolean, error?:string}|unknown>},
 *   getComment: (id:number) => CommentLike|null,
 *   getProject: (id:number) => {slug:string, name:string}|null,
 *   adminPort: () => number,
 *   delayMs?: number,
 * }} deps
 */
export function createOwnerMailer({ config, sender, getComment, getProject, adminPort, delayMs = 60_000 }) {
  /** @type {number[]} */
  let pending = [];
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  const enabled = () => Boolean(config.ownerEmail && config.resendApiKey && config.fromEmail);

  /** @param {CommentChange} change */
  function notify(change) {
    if (change.byOwner || (change.kind !== 'create' && change.kind !== 'reply')) return;
    if (!enabled()) return;
    pending.push(change.commentId);
    if (!timer) {
      timer = setTimeout(() => void flush(), delayMs);
      timer.unref?.();
    }
  }

  async function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    const ids = pending;
    pending = [];
    if (!ids.length || !enabled()) return;
    const items = [];
    for (const id of ids) {
      const c = getComment(id);
      const p = c && getProject(c.projectId);
      if (c && p) items.push({ c, p });
    }
    if (!items.length) return;
    const message = compose(items, adminPort());
    try {
      const res = /** @type {{ok?:boolean, error?:string}|undefined} */ (await sender.send({ to: String(config.ownerEmail), ...message }));
      if (res && res.ok === false) console.error(`LiveReview: comment email not sent: ${res.error}`);
    } catch (err) {
      console.error(`LiveReview: comment email not sent: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { notify, flush, close: flush };
}

/**
 * @param {{c:CommentLike, p:{slug:string, name:string}}[]} items
 * @param {number} port
 */
function compose(items, port) {
  const who = (/** @type {CommentLike} */ c) => c.authorName || c.authorEmail;
  const subject =
    items.length === 1
      ? `${who(items[0].c)} ${items[0].c.parentId ? 'replied' : 'commented'} on ${items[0].p.name}`
      : `${items.length} new comments on LiveReview`;
  const blocks = items.map(({ c, p }) => {
    const view = c.target === 'live' ? 'live' : `commit/${c.target}`;
    const body = c.body.length > BODY_MAX ? `${c.body.slice(0, BODY_MAX)}…` : c.body;
    return [
      `${who(c)} ${c.parentId ? 'replied' : 'commented'} on ${p.name} — ${c.path}:${c.line}`,
      '',
      body.split('\n').map((l) => `  ${l}`).join('\n'),
      '',
      `Open it (on this computer): http://localhost:${port}/${p.slug}/${view}#c-${c.id}`,
    ].join('\n');
  });
  const text = `${blocks.join('\n\n———\n\n')}\n\nYou get this because you own this LiveReview. Reply from the admin page.\n`;
  return { subject, text };
}
