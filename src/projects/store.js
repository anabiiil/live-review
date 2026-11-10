import { createHash, randomBytes } from 'node:crypto';
import { normalizeEmail } from '../db.js';
import { validateRepoRoot } from '../git/repo.js';

/** @typedef {import('../types.js').Viewer} Viewer */
/** @typedef {{id:number, slug:string, name:string, path:string, extraHidden:string[], createdAt:number}} Project */

/** Error for project-store problems; `code` is a stable machine-readable value. */
export class StoreError extends Error {
  /**
   * @param {'duplicate-path'|'invalid-slug'|'slug-taken'|'invalid-name'|'invalid-extra-hidden'|'invalid-email'|'not-found'} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code);
    this.name = 'StoreError';
    /** @type {string} */
    this.code = code;
  }
}

export const RESERVED_SLUGS = new Set(['admin', 'api', 'login', 'logout', 'invite', 'vendor', 'static', 'ws']);
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 48;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * @param {string} slug
 * @returns {boolean}
 */
function validSlug(slug) {
  return typeof slug === 'string' && slug.length <= MAX_SLUG && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

/**
 * Derive a unique lowercase ASCII slug from a display name. Names with no ASCII
 * letters or digits become `project-{n}`; collisions and reserved words get `-2`, `-3`...
 * @param {string} name
 * @param {(slug:string)=>boolean} [isTaken]
 * @returns {string}
 */
export function slugify(name, isTaken = () => false) {
  const base = String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
  /** @param {string} s */
  const free = (s) => validSlug(s) && !isTaken(s);
  if (base === '') {
    for (let n = 1; ; n++) if (free(`project-${n}`)) return `project-${n}`;
  }
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/, '') + suffix;
    if (free(candidate)) return candidate;
  }
}

/** @param {string} token */
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/**
 * @param {string} email
 * @returns {string}
 */
function cleanEmail(email) {
  const e = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw new StoreError('invalid-email', 'invalid email address');
  return e;
}

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function cleanExtraHidden(v) {
  if (!Array.isArray(v) || !v.every((g) => typeof g === 'string' && g.trim() !== '' && !g.includes('/'))) {
    throw new StoreError('invalid-extra-hidden', 'extraHidden must be an array of non-empty basename globs without "/"');
  }
  return v.map((g) => g.trim());
}

/**
 * @param {string} name
 * @returns {string}
 */
function cleanName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new StoreError('invalid-name', 'name is required');
  return name.trim();
}

/** @param {any} r @returns {Project} */
function toProject(r) {
  return {
    id: Number(r.id),
    slug: r.slug,
    name: r.name,
    path: r.path,
    extraHidden: JSON.parse(r.extra_hidden),
    createdAt: Number(r.created_at),
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createProjectStore(db) {
  const COLS = 'id, slug, name, path, extra_hidden, created_at';
  const q = {
    list: db.prepare(`SELECT ${COLS} FROM projects ORDER BY id`),
    get: db.prepare(`SELECT ${COLS} FROM projects WHERE id = ?`),
    bySlug: db.prepare(`SELECT ${COLS} FROM projects WHERE slug = ?`),
    byPath: db.prepare('SELECT id FROM projects WHERE path = ?'),
    insert: db.prepare('INSERT INTO projects(slug,name,path,extra_hidden,created_at) VALUES(?,?,?,?,?)'),
    del: db.prepare('DELETE FROM projects WHERE id = ?'),
    members: db.prepare('SELECT email FROM members WHERE project_id = ? ORDER BY email'),
    addMember: db.prepare('INSERT OR IGNORE INTO members(project_id,email,invited_at) VALUES(?,?,?)'),
    delMember: db.prepare('DELETE FROM members WHERE project_id = ? AND email = ?'),
    isMember: db.prepare('SELECT 1 AS x FROM members WHERE project_id = ? AND email = ?'),
    forEmail: db.prepare(
      `SELECT ${COLS.split(', ').map((c) => 'p.' + c).join(', ')} FROM projects p
       JOIN members m ON m.project_id = p.id WHERE m.email = ? ORDER BY p.id`,
    ),
    delInvitesFor: db.prepare('DELETE FROM invites WHERE project_id = ? AND email = ?'),
    delUnusedInvitesFor: db.prepare('DELETE FROM invites WHERE project_id = ? AND email = ? AND used_at IS NULL'),
    insertInvite: db.prepare('INSERT INTO invites(token_hash,project_id,email,expires_at) VALUES(?,?,?,?)'),
    findInvite: db.prepare(
      'SELECT project_id, email FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    ),
    useInvite: db.prepare('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),
  };

  /** @param {number} id */
  const get = (id) => {
    const r = q.get.get(id);
    return r ? toProject(r) : null;
  };
  /** @param {string} slug */
  const slugTaken = (slug) => q.bySlug.get(slug) !== undefined;
  /** @param {number} id */
  const requireProject = (id) => {
    const p = get(id);
    if (!p) throw new StoreError('not-found', 'project not found');
    return p;
  };

  /** @param {number} projectId @param {string} email */
  const isMember = (projectId, email) => q.isMember.get(projectId, normalizeEmail(email)) !== undefined;

  return {
    /** @returns {Project[]} */
    list: () => q.list.all().map(toProject),
    get,
    /** @param {string} slug @returns {Project|null} */
    bySlug(slug) {
      const r = q.bySlug.get(slug);
      return r ? toProject(r) : null;
    },

    /**
     * @param {{path:string, name:string, slug?:string}} input
     * @returns {Promise<Project>}
     */
    async add({ path, name, slug }) {
      const cleanN = cleanName(name);
      const explicit = slug !== undefined && slug !== null && slug !== '';
      if (explicit && !validSlug(slug)) throw new StoreError('invalid-slug', 'invalid or reserved slug');
      const root = await validateRepoRoot(path);
      if (q.byPath.get(root)) throw new StoreError('duplicate-path', 'this folder has already been added');
      if (explicit && slugTaken(slug)) throw new StoreError('slug-taken', 'slug already in use');
      const finalSlug = explicit ? slug : slugify(cleanN, slugTaken);
      const res = q.insert.run(finalSlug, cleanN, root, '[]', Date.now());
      return /** @type {Project} */ (get(Number(res.lastInsertRowid)));
    },

    /**
     * @param {number} id
     * @param {{name?:string, slug?:string, extraHidden?:string[]}} patch
     * @returns {Project}
     */
    update(id, { name, slug, extraHidden } = {}) {
      const current = requireProject(id);
      const nextName = name === undefined ? current.name : cleanName(name);
      let nextSlug = current.slug;
      if (slug !== undefined && slug !== current.slug) {
        if (!validSlug(slug)) throw new StoreError('invalid-slug', 'invalid or reserved slug');
        if (slugTaken(slug)) throw new StoreError('slug-taken', 'slug already in use');
        nextSlug = slug;
      }
      const nextHidden = extraHidden === undefined ? current.extraHidden : cleanExtraHidden(extraHidden);
      db.prepare('UPDATE projects SET name = ?, slug = ?, extra_hidden = ? WHERE id = ?').run(
        nextName,
        nextSlug,
        JSON.stringify(nextHidden),
        id,
      );
      return /** @type {Project} */ (get(id));
    },

    /** Deletes the project with its members, invites and comments. @param {number} id @returns {boolean} */
    remove: (id) => Number(q.del.run(id).changes) > 0,

    /** @param {number} projectId @returns {string[]} */
    members: (projectId) => q.members.all(projectId).map((r) => String(r.email)),
    /** Idempotent. @param {number} projectId @param {string} email */
    addMember(projectId, email) {
      requireProject(projectId);
      q.addMember.run(projectId, cleanEmail(email), Date.now());
    },
    /** Also deletes the member's invites. @param {number} projectId @param {string} email */
    removeMember(projectId, email) {
      const e = normalizeEmail(email);
      db.exec('BEGIN');
      try {
        q.delMember.run(projectId, e);
        q.delInvitesFor.run(projectId, e);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    isMember,

    /** @param {Viewer} viewer @returns {Project[]} */
    projectsFor(viewer) {
      if (viewer.kind === 'owner') return q.list.all().map(toProject);
      return q.forEmail.all(normalizeEmail(viewer.email)).map(toProject);
    },
    /** @param {Viewer} viewer @param {number} projectId @returns {boolean} */
    canView(viewer, projectId) {
      if (!get(projectId)) return false;
      return viewer.kind === 'owner' || isMember(projectId, viewer.email);
    },

    /**
     * Create a personal single-use invite link token (the member is added if not already one).
     * Earlier unused invites for the same project and email are invalidated.
     * @param {number} projectId
     * @param {string} email
     * @param {number} now epoch ms
     * @returns {string} the plaintext token (only its SHA-256 is stored)
     */
    createInvite(projectId, email, now) {
      requireProject(projectId);
      const e = cleanEmail(email);
      const token = randomBytes(32).toString('base64url');
      db.exec('BEGIN');
      try {
        q.addMember.run(projectId, e, now);
        q.delUnusedInvitesFor.run(projectId, e);
        q.insertInvite.run(hashToken(token), projectId, e, now + INVITE_TTL_MS);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return token;
    },

    /**
     * Look an invite up without using it (no side effects).
     * @param {string} token
     * @param {number} now epoch ms
     * @returns {{email:string, projectId:number}|null} null unless it is unused, unexpired and its membership exists
     */
    peekInvite(token, now) {
      if (typeof token !== 'string' || token === '') return null;
      const row = q.findInvite.get(hashToken(token), now);
      if (!row) return null;
      const email = String(row.email);
      const projectId = Number(row.project_id);
      return isMember(projectId, email) ? { email, projectId } : null;
    },

    /**
     * @param {string} token
     * @param {number} now epoch ms
     * @returns {{email:string, projectId:number}|null}
     */
    redeemInvite(token, now) {
      if (typeof token !== 'string' || token === '') return null;
      const hash = hashToken(token);
      const row = q.findInvite.get(hash, now);
      if (!row) return null;
      const email = String(row.email);
      const projectId = Number(row.project_id);
      if (!isMember(projectId, email)) return null;
      if (Number(q.useInvite.run(now, hash).changes) !== 1) return null;
      return { email, projectId };
    },
  };
}
