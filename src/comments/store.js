import { normalizeEmail } from '../db.js';
import { isHidden } from '../privacy/hidden.js';

/** @typedef {import('../types.js').Viewer} Viewer */
/** @typedef {import('../types.js').Anchor} Anchor */
/** @typedef {import('../types.js').FileDiff} FileDiff */
/**
 * @typedef {{id:number, projectId:number, parentId:number|null, target:string, path:string, line:number|null,
 *   side:'old'|'new'|null, anchor:Anchor|null, authorEmail:string, authorName:string|null, body:string,
 *   createdAt:number, updatedAt:number, resolved:boolean, outdated:boolean, rewritten:boolean,
 *   hidden:boolean}} Comment
 */
/** @typedef {Comment & {replies: Comment[]}} Thread */

/** Input rejected (bad body, line, side, hidden or binary file...). */
export class ValidationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** The actor may not perform this action on this comment. */
export class ForbiddenError extends Error {
  /** @param {string} [message] */
  constructor(message = 'forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** The comment (or project) does not exist. */
export class NotFoundError extends Error {
  /** @param {string} [message] */
  constructor(message = 'not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export const MAX_BODY = 5000;

const SELECT = `SELECT c.*, u.name AS author_name FROM comments c LEFT JOIN users u ON u.email = c.author_email`;

/**
 * @param {unknown} body
 * @returns {string} the trimmed body
 */
function checkBody(body) {
  if (typeof body !== 'string') throw new ValidationError('comment body must be text');
  const t = body.trim();
  if (t.length < 1 || t.length > MAX_BODY) throw new ValidationError(`comment body must be 1-${MAX_BODY} characters`);
  return t;
}

/**
 * @param {unknown} a
 * @returns {a is Anchor}
 */
function isAnchor(a) {
  const o = /** @type {any} */ (a);
  return (
    o !== null &&
    typeof o === 'object' &&
    typeof o.lineText === 'string' &&
    Array.isArray(o.before) &&
    Array.isArray(o.after) &&
    o.before.every((/** @type {unknown} */ s) => typeof s === 'string') &&
    o.after.every((/** @type {unknown} */ s) => typeof s === 'string')
  );
}

/** @param {Record<string, any>} r @returns {Comment} */
function toComment(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    parentId: r.parent_id,
    target: r.target,
    path: r.path,
    line: r.line,
    side: r.side,
    anchor: r.anchor ? JSON.parse(r.anchor) : null,
    authorEmail: r.author_email,
    authorName: r.author_name ?? null,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolved: r.resolved === 1,
    outdated: r.outdated === 1,
    rewritten: r.rewritten === 1,
    hidden: r.hidden === 1,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createCommentStore(db) {
  /**
   * @template T
   * @param {()=>T} fn
   * @returns {T}
   */
  function tx(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** @param {number} id @returns {Comment|null} */
  function get(id) {
    const row = db.prepare(`${SELECT} WHERE c.id = ?`).get(id);
    return row ? toComment(row) : null;
  }

  /** @param {number} id @returns {Comment} */
  function need(id) {
    const c = get(id);
    if (!c) throw new NotFoundError('comment not found');
    return c;
  }

  /** @param {Comment[]} tops @returns {Thread[]} */
  function withReplies(tops) {
    if (tops.length === 0) return [];
    const ids = tops.map((t) => t.id);
    const rows = db
      .prepare(`${SELECT} WHERE c.parent_id IN (${ids.map(() => '?').join(',')}) ORDER BY c.created_at, c.id`)
      .all(...ids);
    /** @type {Map<number, Comment[]>} */
    const byParent = new Map();
    for (const r of rows) {
      const c = toComment(r);
      const list = byParent.get(/** @type {number} */ (c.parentId));
      if (list) list.push(c);
      else byParent.set(/** @type {number} */ (c.parentId), [c]);
    }
    return tops.map((t) => ({ ...t, replies: byParent.get(t.id) ?? [] }));
  }

  /** @param {Viewer} actor @param {Comment} c */
  const isAuthor = (actor, c) => normalizeEmail(actor.email) === c.authorEmail;

  return {
    /**
     * Create a top-level comment. Pass the FileDiff for `path` as `file` so hidden and binary files are rejected.
     * @param {{projectId:number, target:string, path:string, line:number, side:'old'|'new', anchor:Anchor,
     *   authorEmail:string, body:string, now?:number, file?:FileDiff|null, extraHidden?:string[]}} input
     * @returns {Comment}
     */
    create({ projectId, target, path, line, side, anchor, authorEmail, body, now = Date.now(), file = null, extraHidden = [] }) {
      const text = checkBody(body);
      if (side !== 'old' && side !== 'new') throw new ValidationError('side must be old or new');
      if (!Number.isInteger(line) || line < 1) throw new ValidationError('line must be a positive integer');
      if (typeof target !== 'string' || target === '') throw new ValidationError('target is required');
      if (typeof path !== 'string' || path === '') throw new ValidationError('path is required');
      if (!isAnchor(anchor)) throw new ValidationError('invalid anchor');
      if (isHidden(path, extraHidden) || file?.hidden || file?.binary) {
        throw new ValidationError('comments are not allowed on hidden or binary files');
      }
      if (!db.prepare('SELECT 1 AS x FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('project not found');
      const r = db
        .prepare(
          `INSERT INTO comments(project_id, parent_id, target, path, line, side, anchor, author_email, body, created_at, updated_at)
           VALUES(?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, target, path, line, side, JSON.stringify(anchor), normalizeEmail(authorEmail), text, now, now);
      return need(Number(r.lastInsertRowid));
    },

    /**
     * Reply to a comment; replying to a reply replies to its top-level parent.
     * @param {number} parentId
     * @param {{authorEmail:string, body:string, now?:number}} input
     * @returns {Comment}
     */
    reply(parentId, { authorEmail, body, now = Date.now() }) {
      const text = checkBody(body);
      const given = need(parentId);
      const top = given.parentId === null ? given : need(given.parentId);
      const r = db
        .prepare(
          `INSERT INTO comments(project_id, parent_id, target, path, line, side, anchor, author_email, body, created_at, updated_at, outdated, rewritten, hidden)
           VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(top.projectId, top.id, top.target, top.path, top.line, top.side, normalizeEmail(authorEmail), text, now, now, +top.outdated, +top.rewritten, +top.hidden);
      return need(Number(r.lastInsertRowid));
    },

    /**
     * Author only.
     * @param {number} id
     * @param {Viewer} actor
     * @param {string} body
     * @param {number} [now]
     * @returns {Comment}
     */
    edit(id, actor, body, now = Date.now()) {
      const text = checkBody(body);
      const c = need(id);
      if (!isAuthor(actor, c)) throw new ForbiddenError('only the author can edit a comment');
      db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(text, now, id);
      return need(id);
    },

    /**
     * Author or owner; top-level comments only.
     * @param {number} id
     * @param {Viewer} actor
     * @param {boolean} resolved
     * @returns {Comment}
     */
    setResolved(id, actor, resolved) {
      const c = need(id);
      if (c.parentId !== null) throw new ValidationError('only top-level comments can be resolved');
      if (actor.kind !== 'owner' && !isAuthor(actor, c)) throw new ForbiddenError('only the author or the owner can resolve a comment');
      db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id);
      return need(id);
    },

    /**
     * Author or owner. Deleting a top-level comment deletes its replies.
     * @param {number} id
     * @param {Viewer} actor
     */
    delete(id, actor) {
      const c = need(id);
      if (actor.kind !== 'owner' && !isAuthor(actor, c)) throw new ForbiddenError('only the author or the owner can delete a comment');
      tx(() => db.prepare('DELETE FROM comments WHERE id = ? OR parent_id = ?').run(id, id));
    },

    get,

    /**
     * All top-level threads for a target (live or a commit sha), including outdated and hidden ones.
     * @param {number} projectId
     * @param {string} target
     * @returns {Thread[]}
     */
    forTarget(projectId, target) {
      const rows = db
        .prepare(`${SELECT} WHERE c.project_id = ? AND c.target = ? AND c.parent_id IS NULL ORDER BY c.created_at, c.id`)
        .all(projectId, target);
      return withReplies(rows.map(toComment));
    },

    /**
     * Threads whose commit is no longer reachable from any branch.
     * @param {number} projectId
     * @returns {Thread[]}
     */
    rewrittenThreads(projectId) {
      const rows = db
        .prepare(`${SELECT} WHERE c.project_id = ? AND c.rewritten = 1 AND c.parent_id IS NULL ORDER BY c.created_at, c.id`)
        .all(projectId);
      return withReplies(rows.map(toComment));
    },

    /**
     * Unresolved, non-outdated, non-hidden top-level comments. `total` spans all targets; `byPath` is limited to `target` when given.
     * @param {number} projectId
     * @param {string} [target]
     * @returns {{total:number, byPath:Record<string, number>}}
     */
    openCounts(projectId, target) {
      const open = 'project_id = ? AND parent_id IS NULL AND resolved = 0 AND outdated = 0 AND hidden = 0';
      const total = /** @type {{n:number}} */ (db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE ${open}`).get(projectId)).n;
      const rows =
        target === undefined
          ? db.prepare(`SELECT path, COUNT(*) AS n FROM comments WHERE ${open} GROUP BY path`).all(projectId)
          : db.prepare(`SELECT path, COUNT(*) AS n FROM comments WHERE ${open} AND target = ? GROUP BY path`).all(projectId, target);
      /** @type {Record<string, number>} */
      const byPath = {};
      for (const r of rows) byPath[r.path] = r.n;
      return { total, byPath };
    },

    /**
     * Top-level live comments that are not outdated.
     * @param {number} projectId
     * @returns {Comment[]}
     */
    liveActive(projectId) {
      return db
        .prepare(`${SELECT} WHERE c.project_id = ? AND c.target = 'live' AND c.parent_id IS NULL AND c.outdated = 0 ORDER BY c.created_at, c.id`)
        .all(projectId)
        .map(toComment);
    },

    /**
     * Distinct commit shas that have comments.
     * @param {number} projectId
     * @returns {string[]}
     */
    commitTargets(projectId) {
      return db
        .prepare(`SELECT DISTINCT target FROM comments WHERE project_id = ? AND target != 'live' AND parent_id IS NULL ORDER BY target`)
        .all(projectId)
        .map((r) => r.target);
    },

    /**
     * Clear anchors and flag as hidden every top-level comment whose path matches.
     * @param {number} projectId
     * @param {(path:string)=>boolean} predicate
     * @returns {number[]} ids of top-level comments that changed
     */
    wipeHidden(projectId, predicate) {
      return tx(() => {
        const rows = db.prepare('SELECT id, path FROM comments WHERE project_id = ? AND parent_id IS NULL AND hidden = 0').all(projectId);
        const ids = rows.filter((r) => predicate(r.path)).map((r) => /** @type {number} */ (r.id));
        const wipe = db.prepare('UPDATE comments SET anchor = NULL, hidden = 1 WHERE id = ? OR parent_id = ?');
        for (const id of ids) wipe.run(id, id);
        return ids;
      });
    },

    /**
     * Move a top-level comment (used by re-anchoring); replies follow it.
     * @param {number} id
     * @param {{target?:string, line?:number, anchor?:Anchor|null, outdated?:boolean}} change
     */
    updatePosition(id, { target, line, anchor, outdated }) {
      /** @type {string[]} */
      const sets = [];
      /** @type {(string|number|null)[]} */
      const args = [];
      /** @type {string[]} */
      const followSets = [];
      /** @type {(string|number|null)[]} */
      const followArgs = [];
      if (target !== undefined) {
        sets.push('target = ?'), args.push(target);
        followSets.push('target = ?'), followArgs.push(target);
      }
      if (line !== undefined) {
        sets.push('line = ?'), args.push(line);
        followSets.push('line = ?'), followArgs.push(line);
      }
      if (anchor !== undefined) sets.push('anchor = ?'), args.push(anchor ? JSON.stringify(anchor) : null);
      if (outdated !== undefined) {
        sets.push('outdated = ?'), args.push(outdated ? 1 : 0);
        followSets.push('outdated = ?'), followArgs.push(outdated ? 1 : 0);
      }
      if (sets.length === 0) return;
      tx(() => {
        db.prepare(`UPDATE comments SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
        if (followSets.length) db.prepare(`UPDATE comments SET ${followSets.join(', ')} WHERE parent_id = ?`).run(...followArgs, id);
      });
    },

    /**
     * Set the rewritten flag on every comment of a commit target.
     * @param {number} projectId
     * @param {string} target
     * @param {boolean} rewritten
     * @returns {number[]} ids of top-level comments whose flag changed
     */
    setRewritten(projectId, target, rewritten) {
      const v = rewritten ? 1 : 0;
      return tx(() => {
        const ids = db
          .prepare('SELECT id FROM comments WHERE project_id = ? AND target = ? AND parent_id IS NULL AND rewritten != ?')
          .all(projectId, target, v)
          .map((r) => /** @type {number} */ (r.id));
        db.prepare('UPDATE comments SET rewritten = ? WHERE project_id = ? AND target = ?').run(v, projectId, target);
        return ids;
      });
    },
  };
}
