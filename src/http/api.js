import { lstat, readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeEmail } from '../db.js';
import { saveConfig } from '../config.js';
import { RepoError, SHA_RE, commitInfo, fileAt, isReachable, listCommits } from '../git/repo.js';
import { commitDiff, liveDiff } from '../git/diff.js';
import { SLUG_RE } from '../projects/store.js';
import { ValidationError } from '../comments/store.js';
import { makeAnchor } from '../comments/anchor.js';
import { visibleInDiff } from '../comments/reanchor.js';
import { codeEmail } from '../auth/email.js';
import { HttpError, sendJson } from './router.js';
import { SESSION_COOKIE, clearSessionCookie, parseCookies, sessionCookie } from './guards.js';

/** @typedef {import('../types.js').Viewer} Viewer */
/** @typedef {import('../types.js').FileDiff} FileDiff */
/** @typedef {import('../projects/store.js').Project} Project */
/** @typedef {import('../comments/store.js').Comment} Comment */
/** @typedef {import('./router.js').RouteContext} RouteContext */

const LOGIN_PAD_MS = 800;
const COMMITS_PER_PAGE = 20;
const MAX_PAGE = 10000;
const MAX_NAME = 60;
const NOTIFICATIONS_DEFAULT = 30;
const NOTIFICATIONS_MAX = 100;
const MAX_READ_IDS = 500;
const STATUSES = new Set(['open', 'resolved', 'all']);

const noAccess = () => new HttpError(404, 'no-access');
const notFound = () => new HttpError(404, 'not-found');

/**
 * Comments as sent to clients: the stored anchor (copied file content) stays server-side.
 * @template {Comment & {replies?: Comment[]}} T
 * @param {T} c
 */
function publicComment(c) {
  const { anchor, ...rest } = c;
  if (rest.replies) rest.replies = rest.replies.map(publicComment);
  return rest;
}

/**
 * The stored anchor as numbered lines around the comment's line (the line itself is `focus`). Null when the
 * file is hidden or there is no anchor.
 * @param {{anchor:import('../types.js').Anchor|null, line:number|null, hidden:boolean}} c
 * @returns {{no:number, text:string, focus:boolean}[]|null}
 */
export function threadSnippet({ anchor, line, hidden }) {
  if (hidden || !anchor || line === null) return null;
  const first = line - anchor.before.length;
  return [
    ...anchor.before.map((text, i) => ({ no: first + i, text, focus: false })),
    { no: line, text: anchor.lineText, focus: true },
    ...anchor.after.map((text, i) => ({ no: line + 1 + i, text, focus: false })),
  ];
}

/**
 * A thread as the threads listing sends it: no stored anchor, plus its location and code snippet.
 * @param {import('../comments/store.js').Thread} t
 */
export function listedThread(t) {
  return {
    ...publicComment(t),
    location: { target: t.target, path: t.path, line: t.line, side: t.side },
    snippet: threadSnippet(t),
  };
}

/**
 * The `status` query of the threads listings; open by default.
 * @param {URLSearchParams} query
 * @returns {'open'|'resolved'|'all'}
 */
export function threadStatus(query) {
  const s = query.get('status') ?? 'open';
  if (!STATUSES.has(s)) throw new ValidationError('status must be open, resolved or all');
  return /** @type {'open'|'resolved'|'all'} */ (s);
}

/**
 * RepoError('missing') unless the project folder still exists as a directory with a .git entry.
 * The diff functions check this themselves; this covers the plain repository queries.
 * @param {string} root
 */
async function ensureRepo(root) {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
    await lstat(join(root, '.git'));
  } catch {
    throw new RepoError('missing', 'the project folder no longer exists or is no longer a git repository');
  }
}

/**
 * Working-tree file as text; null when missing, not a regular file (symlinks not followed) or outside root.
 * @param {string} root
 * @param {string} path repo-relative, forward slashes
 * @returns {Promise<string|null>}
 */
async function workingTreeFile(root, path) {
  const full = resolve(root, ...path.split('/'));
  if (!full.startsWith(resolve(root) + sep)) return null;
  try {
    if (!(await lstat(full)).isFile()) return null;
    return await readFile(full, 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function positiveId(v) {
  const n = Number(v);
  if (!/^[1-9]\d{0,15}$/.test(String(v)) || !Number.isSafeInteger(n)) throw notFound();
  return n;
}

/**
 * Register the viewer JSON API.
 * @param {ReturnType<typeof import('./router.js').createRouter>} router
 * @param {{config:import('../config.js').Config, db:import('node:sqlite').DatabaseSync, now:()=>number,
 *   emailSender:{send:(m:{to:string, subject:string, text:string})=>Promise<unknown>},
 *   projects:ReturnType<typeof import('../projects/store.js').createProjectStore>,
 *   comments:ReturnType<typeof import('../comments/store.js').createCommentStore>,
 *   codes:ReturnType<typeof import('../auth/codes.js').createCodeService>,
 *   sessions:ReturnType<typeof import('../auth/sessions.js').createSessionService>,
 *   events:import('node:events').EventEmitter,
 *   notifier:ReturnType<typeof import('../notify/notifier.js').createNotifier>}} deps
 */
export function registerApi(router, { config, db, now, emailSender, projects, comments, codes, sessions, events, notifier }) {
  const upsertName = db.prepare(
    'INSERT INTO users(email, name) VALUES(?, ?) ON CONFLICT(email) DO UPDATE SET name = excluded.name',
  );

  /** @param {Viewer} viewer */
  const authorEmail = (viewer) => {
    if (viewer.kind !== 'owner') return viewer.email;
    // Keep the owner's display name on comments in step with the configured name.
    const email = normalizeEmail(config.ownerEmail);
    if (config.ownerName) upsertName.run(email, config.ownerName);
    return email;
  };

  /**
   * Tell the live hub (refetch hints) and the notifier about a successful comment change.
   * @param {Viewer} viewer
   * @param {{projectId:number, target:string, id:number, resolved:boolean}} c the comment after the change
   * @param {'create'|'reply'|'edit'|'resolve'|'delete'} kind
   */
  const commentChanged = (viewer, c, kind) =>
    events.emit('comment-changed', {
      projectId: c.projectId, target: c.target, commentId: c.id, kind, byOwner: viewer.kind === 'owner',
      actorEmail: viewer.kind === 'owner' ? normalizeEmail(config.ownerEmail ?? '') : normalizeEmail(viewer.email),
      ...(kind === 'resolve' ? { resolved: c.resolved } : {}),
    });

  /**
   * The project behind a slug if the viewer may see it; unknown and forbidden are indistinguishable.
   * @param {Viewer} viewer
   * @param {string} slug
   * @returns {Project}
   */
  const projectFor = (viewer, slug) => {
    if (!SLUG_RE.test(slug)) throw noAccess();
    const p = projects.bySlug(slug);
    if (!p || !projects.canView(viewer, p.id)) throw noAccess();
    return p;
  };

  /**
   * A comment the viewer may act on; unknown and forbidden are indistinguishable.
   * @param {Viewer} viewer
   * @param {string} rawId
   */
  const commentFor = (viewer, rawId) => {
    const c = comments.get(positiveId(rawId));
    if (!c || !projects.canView(viewer, c.projectId)) throw notFound();
    return c;
  };

  /**
   * Resolve a commit id to its full sha, but only for commits the project may show: reachable from a
   * branch, or already commented on (rewritten history stays viewable). Dangling and stash commits are 404.
   * @param {Project} p
   * @param {string} sha
   * @returns {Promise<string>}
   */
  const viewableCommit = async (p, sha) => {
    if (!SHA_RE.test(sha)) throw notFound();
    await ensureRepo(p.path);
    const full = (await commitInfo(p.path, sha)).sha;
    if (!comments.hasTarget(p.id, full) && !(await isReachable(p.path, full))) throw notFound();
    return full;
  };

  // ---- sign-in -----------------------------------------------------------------------------

  router.add(
    'POST',
    '/api/login/request',
    async ({ req, res, body, started }) => {
      try {
        const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : '';
        if (email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email)) {
          const ip = String(req.headers['cf-connecting-ip'] ?? '') || 'unknown';
          const { code } = codes.requestCode(email, ip, now());
          // Not awaited: the provider's latency must not reveal who is a member. The sender never puts the
          // API key in its result or errors, so logging them is safe.
          if (code) {
            Promise.resolve()
              .then(() => emailSender.send({ to: email, ...codeEmail(code) }))
              .then(
                (r) => {
                  const result = /** @type {{ok?:boolean, error?:string}|undefined} */ (r);
                  if (result?.ok === false) console.error('login email failed:', result.error);
                },
                (err) => console.error('login email failed:', err instanceof Error ? err.message : String(err)),
              );
          }
        }
      } catch (err) {
        console.error('login request failed:', err instanceof Error ? err.message : err);
      }
      const wait = LOGIN_PAD_MS - (performance.now() - started);
      if (wait > 0) await sleep(Math.ceil(wait));
      sendJson(res, 200, { ok: true });
    },
    { auth: false, only: 'public' },
  );

  router.add(
    'POST',
    '/api/login/verify',
    ({ res, body }) => {
      const email = typeof body?.email === 'string' ? body.email : '';
      const code = typeof body?.code === 'string' ? body.code : '';
      if (email === '' || !codes.verifyCode(email, code, now())) {
        sendJson(res, 401, { error: 'invalid-code' });
        return;
      }
      res.setHeader('Set-Cookie', sessionCookie(sessions.create(email, now())));
      sendJson(res, 200, { ok: true });
    },
    { auth: false, only: 'public' },
  );

  router.add(
    'POST',
    '/api/logout',
    ({ req, res }) => {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) sessions.revoke(token);
      res.setHeader('Set-Cookie', clearSessionCookie());
      sendJson(res, 200, { ok: true });
    },
    { auth: false, only: 'public' },
  );

  // ---- viewer ------------------------------------------------------------------------------

  router.add('GET', '/api/me', ({ res, viewer }) => {
    const v = /** @type {Viewer} */ (viewer);
    sendJson(res, 200, { email: v.email, name: v.name, kind: v.kind, emailNotifications: notifier.emailPreference(v.email) });
  });

  router.add('PUT', '/api/me/prefs', ({ res, viewer, body }) => {
    const v = /** @type {Viewer} */ (viewer);
    const on = body?.emailNotifications;
    if (typeof on !== 'boolean') throw new ValidationError('emailNotifications must be true or false');
    if (v.kind === 'owner') {
      saveConfig({ ownerEmailNotifications: on });
      config.ownerEmailNotifications = on;
    } else {
      notifier.setReviewerEmailPreference(v.email, on);
    }
    sendJson(res, 200, { emailNotifications: notifier.emailPreference(v.email) });
  });

  // ---- notifications -----------------------------------------------------------------------

  router.add('GET', '/api/notifications', ({ res, viewer, query }) => {
    const asked = Number.parseInt(query.get('limit') ?? '', 10);
    const limit = Number.isFinite(asked) ? Math.min(NOTIFICATIONS_MAX, Math.max(1, asked)) : NOTIFICATIONS_DEFAULT;
    sendJson(res, 200, notifier.list(/** @type {Viewer} */ (viewer), limit));
  });

  router.add('POST', '/api/notifications/read', ({ res, viewer, body }) => {
    const { ids, all } = body ?? {};
    if (all !== undefined && all !== true) throw new ValidationError('all must be true');
    if (all === undefined) {
      const ok =
        Array.isArray(ids) &&
        ids.length <= MAX_READ_IDS &&
        ids.every((/** @type {unknown} */ id) => Number.isSafeInteger(id) && /** @type {number} */ (id) > 0);
      if (!ok) throw new ValidationError(`ids must be a list of up to ${MAX_READ_IDS} notification ids, or all must be true`);
    }
    const unread = notifier.markRead(/** @type {Viewer} */ (viewer), all ? { all: true } : { ids });
    sendJson(res, 200, { unread });
  });

  router.add('POST', '/api/me/name', ({ res, viewer, body }) => {
    const v = /** @type {Viewer} */ (viewer);
    if (v.kind === 'owner') throw new HttpError(403, 'forbidden');
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > MAX_NAME) throw new ValidationError(`name must be 1-${MAX_NAME} characters`);
    upsertName.run(v.email, name);
    sendJson(res, 200, { email: v.email, name, kind: v.kind });
  });

  router.add('GET', '/api/projects', ({ res, viewer }) => {
    const list = projects
      .projectsFor(/** @type {Viewer} */ (viewer))
      .map((p) => ({ slug: p.slug, name: p.name, open: comments.openCounts(p.id).total }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
    sendJson(res, 200, list);
  });

  // ---- project views -----------------------------------------------------------------------

  router.add('GET', '/api/p/:slug/live', async ({ res, viewer, params }) => {
    const p = projectFor(/** @type {Viewer} */ (viewer), params.slug);
    sendJson(res, 200, await liveDiff(p.path, { extraHidden: p.extraHidden }));
  });

  router.add('GET', '/api/p/:slug/commits', async ({ res, viewer, params, query }) => {
    const p = projectFor(/** @type {Viewer} */ (viewer), params.slug);
    const asked = Number.parseInt(query.get('page') ?? '1', 10);
    const page = Math.min(MAX_PAGE, Math.max(1, Number.isFinite(asked) ? asked : 1));
    await ensureRepo(p.path);
    const { commits, hasMore } = await listCommits(p.path, { skip: (page - 1) * COMMITS_PER_PAGE, limit: COMMITS_PER_PAGE });
    sendJson(res, 200, { commits, hasMore, page });
  });

  router.add('GET', '/api/p/:slug/commit/:sha', async ({ res, viewer, params }) => {
    const p = projectFor(/** @type {Viewer} */ (viewer), params.slug);
    const sha = await viewableCommit(p, params.sha);
    const files = await commitDiff(p.path, sha, { extraHidden: p.extraHidden });
    const commit = await commitInfo(p.path, sha);
    sendJson(res, 200, { commit, files });
  });

  // ---- comments ----------------------------------------------------------------------------

  router.add('GET', '/api/p/:slug/threads', ({ res, viewer, params, query }) => {
    const p = projectFor(/** @type {Viewer} */ (viewer), params.slug);
    const status = threadStatus(query);
    sendJson(res, 200, { threads: comments.threads({ projectId: p.id, status }).map(listedThread) });
  });

  router.add('GET', '/api/p/:slug/comments', async ({ res, viewer, params, query }) => {
    const p = projectFor(/** @type {Viewer} */ (viewer), params.slug);
    let target = query.get('target') ?? '';
    if (target !== 'live' && !SHA_RE.test(target)) throw new ValidationError('target must be "live" or a commit sha');
    // A full sha is answered from the database alone, so rewritten threads stay readable even when the
    // repository is unavailable; an abbreviated one is resolved (and gated) through git.
    if (target !== 'live' && target.length < 40) target = await viewableCommit(p, target);
    const all = comments.forTarget(p.id, target);
    sendJson(res, 200, {
      threads: all.filter((t) => !t.outdated).map(publicComment),
      outdated: target === 'live' ? all.filter((t) => t.outdated).map(publicComment) : [],
      rewritten: comments.rewrittenThreads(p.id).map(publicComment),
    });
  });

  router.add('POST', '/api/p/:slug/comments', async ({ res, viewer, params, body }) => {
    const v = /** @type {Viewer} */ (viewer);
    const p = projectFor(v, params.slug);
    const { target, path, line, side } = body ?? {};
    if (target !== 'live' && !(typeof target === 'string' && SHA_RE.test(target))) {
      throw new ValidationError('target must be "live" or a commit sha');
    }
    if (typeof path !== 'string' || path === '') throw new ValidationError('path is required');
    if (side !== 'old' && side !== 'new') throw new ValidationError('side must be old or new');
    if (!Number.isInteger(line) || line < 1) throw new ValidationError('line must be a positive integer');

    await ensureRepo(p.path);
    /** @type {FileDiff[]} */
    let files;
    /** @type {string} */
    let storedTarget;
    if (target === 'live') {
      files = (await liveDiff(p.path, { extraHidden: p.extraHidden })).files;
      storedTarget = 'live';
    } else {
      storedTarget = await viewableCommit(p, target);
      files = await commitDiff(p.path, storedTarget, { extraHidden: p.extraHidden });
    }
    const file = files.find((f) => f.path === path);
    if (!file) throw new ValidationError('file is not part of this diff');
    if (file.hidden || file.binary) throw new ValidationError('comments are not allowed on hidden or binary files');
    if (!visibleInDiff(file, side, line)) throw new ValidationError('line is not shown in this diff');

    const oldPath = file.oldPath ?? file.path;
    /** @type {string|null} */
    let content;
    if (storedTarget === 'live') {
      content = side === 'new' ? await workingTreeFile(p.path, file.path) : await fileAt(p.path, 'HEAD', oldPath);
    } else {
      content = side === 'new' ? await fileAt(p.path, storedTarget, file.path) : await fileAt(p.path, `${storedTarget}^`, oldPath);
    }
    if (content === null) throw new ValidationError('file content is not available');
    let anchor;
    try {
      anchor = makeAnchor(content.split('\n'), line);
    } catch {
      throw new ValidationError('line is out of range');
    }
    const created = comments.create({
      projectId: p.id, target: storedTarget, path: file.path, line, side, anchor,
      authorEmail: authorEmail(v), body: body.body, now: now(), file, extraHidden: p.extraHidden,
    });
    commentChanged(v, created, 'create');
    sendJson(res, 201, publicComment(created));
  });

  router.add('POST', '/api/comments/:id/replies', ({ res, viewer, params, body }) => {
    const v = /** @type {Viewer} */ (viewer);
    const parent = commentFor(v, params.id);
    const reply = comments.reply(parent.id, { authorEmail: authorEmail(v), body: body?.body, now: now() });
    commentChanged(v, reply, 'reply');
    sendJson(res, 201, publicComment(reply));
  });

  router.add('PATCH', '/api/comments/:id', ({ res, viewer, params, body }) => {
    const v = /** @type {Viewer} */ (viewer);
    let c = commentFor(v, params.id);
    const { body: text, resolved } = body ?? {};
    if (text === undefined && resolved === undefined) throw new ValidationError('nothing to change');
    if (resolved !== undefined && typeof resolved !== 'boolean') throw new ValidationError('resolved must be true or false');
    if (resolved !== undefined && c.parentId !== null) throw new ValidationError('only top-level comments can be resolved');
    // edit is the stricter permission (author only), so a combined change cannot half-apply.
    const wasResolved = c.resolved;
    if (text !== undefined) c = comments.edit(c.id, v, text, now());
    if (resolved !== undefined) c = comments.setResolved(c.id, v, resolved);
    if (text !== undefined) commentChanged(v, c, 'edit');
    // Only a real change of state notifies anyone.
    if (resolved !== undefined && resolved !== wasResolved) commentChanged(v, c, 'resolve');
    sendJson(res, 200, publicComment(c));
  });

  router.add('DELETE', '/api/comments/:id', ({ res, viewer, params }) => {
    const v = /** @type {Viewer} */ (viewer);
    const c = commentFor(v, params.id);
    comments.delete(c.id, v);
    commentChanged(v, c, 'delete');
    sendJson(res, 200, { ok: true });
  });
}
