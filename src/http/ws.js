import { WebSocket, WebSocketServer } from 'ws';
import { normalizeEmail } from '../db.js';
import { SLUG_RE } from '../projects/store.js';
import { hostAllowed, originAllowed, resolveViewer, sessionCheck } from './guards.js';

/** @typedef {import('../types.js').Viewer} Viewer */
/** @typedef {import('./guards.js').Listener} Listener */
/** @typedef {import('../live/pipeline.js').LiveMessage} LiveMessage */
/**
 * One subscription of one socket. `ready` once the first live state was sent (broadcasts start then);
 * `acquired` while it holds a watcher reference.
 * @typedef {{projectId:number, slug:string, ready:boolean, acquired:boolean}} Subscription
 */
/**
 * `signedIn` re-checks the session the socket was opened with.
 * @typedef {{ws:WebSocket, viewer:Viewer, kind:'public'|'admin', alive:boolean, subs:Map<number, Subscription>,
 *   signedIn:()=>boolean}} Client
 */
/**
 * `actorEmail` is who made the change; `resolved` (resolve only) is the new state.
 * @typedef {{projectId:number, target:string, commentId:number,
 *   kind:'create'|'reply'|'edit'|'resolve'|'delete', byOwner:boolean, actorEmail?:string, resolved?:boolean}} CommentChange
 */

const MAX_PAYLOAD = 4096;
const EXCERPT = 140;
const STATUS_TEXT = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 421: 'Misdirected Request' };

/**
 * The WebSocket hub: viewers subscribe to projects they may see and receive live diffs, comment refetch
 * hints and (owner only) notifications of new comments.
 * @param {{projects:ReturnType<typeof import('../projects/store.js').createProjectStore>,
 *   comments:ReturnType<typeof import('../comments/store.js').createCommentStore>,
 *   watcherPool:{acquire:(projectId:number, root:string)=>Promise<void>, release:(projectId:number)=>void, active:()=>number[]},
 *   snapshot:(projectId:number, opts:{refresh:boolean})=>Promise<LiveMessage|null>,
 *   heartbeatMs?:number}} deps
 */
export function createHub({ projects, comments, watcherPool, snapshot, heartbeatMs = 30000 }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  /** @type {Set<Client>} */
  const clients = new Set();

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.signedIn()) {
        // Signed out or expired: the socket must not outlive the session.
        dropClient(c);
        c.ws.close(1008, 'signed-out');
        continue;
      }
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  /**
   * @param {Client} c
   * @param {object} msg
   */
  const send = (c, msg) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };

  /** @param {number} projectId @param {string} fallback */
  const slugOf = (projectId, fallback) => projects.get(projectId)?.slug ?? fallback;

  /**
   * Drop a subscription and give back its watcher reference.
   * @param {Client} c
   * @param {number} projectId
   */
  function removeSub(c, projectId) {
    const sub = c.subs.get(projectId);
    if (!sub) return;
    c.subs.delete(projectId);
    if (sub.acquired) {
      sub.acquired = false;
      watcherPool.release(projectId);
    }
  }

  /**
   * Forget a client and give back its watcher references.
   * @param {Client} c
   */
  function dropClient(c) {
    clients.delete(c);
    for (const id of [...c.subs.keys()]) removeSub(c, id);
  }

  /**
   * Subscribe to a project. Unknown and forbidden slugs are ignored without a reply.
   * @param {Client} c
   * @param {unknown} slug
   */
  async function subscribe(c, slug) {
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return;
    const p = projects.bySlug(slug);
    if (!p || !projects.canView(c.viewer, p.id)) return;
    const existing = c.subs.get(p.id);
    if (existing) {
      // Already subscribed (e.g. the page was reopened under the project's new slug): send the state again.
      if (!existing.ready) return;
      const msg = await snapshot(p.id, { refresh: false });
      if (msg && c.subs.get(p.id) === existing && clients.has(c)) send(c, msg);
      return;
    }
    /** @type {Subscription} */
    const sub = { projectId: p.id, slug: p.slug, ready: false, acquired: false };
    c.subs.set(p.id, sub);
    const current = () => c.subs.get(p.id) === sub && clients.has(c);
    const wasWatched = watcherPool.active().includes(p.id);
    try {
      await watcherPool.acquire(p.id, p.path);
    } catch {
      if (!current()) return;
      c.subs.delete(p.id);
      send(c, { type: 'error', slug: sub.slug, error: 'project-unavailable' });
      return;
    }
    if (!current()) {
      watcherPool.release(p.id);
      return;
    }
    sub.acquired = true;
    const msg = await snapshot(p.id, { refresh: !wasWatched });
    if (!current()) return;
    if (!msg) {
      removeSub(c, p.id);
      return;
    }
    sub.ready = true;
    send(c, msg);
  }

  /**
   * @param {Client} c
   * @param {unknown} slug
   */
  function unsubscribe(c, slug) {
    if (typeof slug !== 'string') return;
    for (const sub of c.subs.values()) {
      if (sub.slug === slug) return removeSub(c, sub.projectId);
    }
    const p = SLUG_RE.test(slug) ? projects.bySlug(slug) : null;
    if (p) removeSub(c, p.id);
  }

  /**
   * @param {Client} c
   * @param {import('ws').RawData} data
   */
  function onMessage(c, data) {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg === null || typeof msg !== 'object') return;
    if (msg.type === 'subscribe') {
      subscribe(c, msg.slug).catch((err) => console.error('LiveReview subscribe failed:', err));
    } else if (msg.type === 'unsubscribe') {
      unsubscribe(c, msg.slug);
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {Viewer} viewer
   * @param {'public'|'admin'} kind
   * @param {()=>boolean} signedIn
   */
  function onConnection(ws, viewer, kind, signedIn) {
    /** @type {Client} */
    const c = { ws, viewer, kind, alive: true, subs: new Map(), signedIn };
    clients.add(c);
    ws.on('pong', () => {
      c.alive = true;
    });
    ws.on('message', (data) => onMessage(c, data));
    ws.on('error', () => ws.terminate());
    ws.on('close', () => dropClient(c));
  }

  /**
   * Send `msg` to every socket subscribed to the project (once its first live state was sent).
   * @param {number} projectId
   * @param {object} msg
   */
  function broadcast(projectId, msg) {
    for (const c of clients) {
      if (c.subs.get(projectId)?.ready) send(c, msg);
    }
  }

  return {
    /**
     * Handle an HTTP upgrade on one of the listeners: only `/ws`, with the listener's Host, Origin and
     * viewer rules. The viewer is resolved once, here.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:stream').Duplex} socket
     * @param {Buffer} head
     * @param {Listener} listener
     */
    handleUpgrade(req, socket, head, listener) {
      /** @param {401|403|404|421} status */
      const reject = (status) => {
        socket.on('error', () => {});
        socket.once('finish', () => socket.destroy());
        socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      const raw = req.url ?? '';
      const q = raw.indexOf('?');
      if ((q < 0 ? raw : raw.slice(0, q)) !== '/ws') return reject(404);
      if (!hostAllowed(req, listener)) return reject(421);
      if (!originAllowed(req, listener)) return reject(403);
      const viewer = resolveViewer(req, listener);
      if (!viewer) return reject(401);
      const signedIn = sessionCheck(req, listener);
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, viewer, listener.kind, signedIn));
    },

    broadcast,

    /**
     * Send `msg` to every owner socket (admin listener).
     * @param {object} msg
     */
    sendToOwner(msg) {
      for (const c of clients) if (c.kind === 'admin') send(c, msg);
    },

    /**
     * Send `msg` to every reviewer socket (public listener) signed in as `email`.
     * @param {string} email
     * @param {object} msg
     */
    sendToEmail(email, msg) {
      const e = normalizeEmail(email);
      for (const c of clients) if (c.kind === 'public' && normalizeEmail(c.viewer.email) === e) send(c, msg);
    },

    /**
     * A comment was created, replied to, edited, resolved or deleted: tell the project's subscribers to
     * refetch, and tell the owner about new comments and replies by others.
     * @param {CommentChange} change
     */
    commentChanged({ projectId, target, commentId, kind, byOwner }) {
      const p = projects.get(projectId);
      if (!p) return;
      broadcast(projectId, { type: 'comments', slug: p.slug, target });
      if ((kind !== 'create' && kind !== 'reply') || byOwner) return;
      const c = comments.get(commentId);
      if (!c) return;
      const anchor = `#c-${c.id}`;
      const msg = {
        type: 'notify',
        slug: p.slug,
        commentId: c.id,
        path: c.path,
        line: c.line,
        author: c.authorName ?? c.authorEmail,
        excerpt: c.body.slice(0, EXCERPT),
        url: c.target === 'live' ? `/${p.slug}/live${anchor}` : `/${p.slug}/commit/${c.target}${anchor}`,
      };
      for (const client of clients) if (client.kind === 'admin') send(client, msg);
    },

    /**
     * A reviewer lost access to a project (the project may already be deleted): their subscriptions to it
     * end with `revoked`, and if they belong to no project any more all their sockets are closed.
     * @param {number} projectId
     * @param {string} email
     */
    revoke(projectId, email) {
      const e = normalizeEmail(email);
      const mine = [...clients].filter((c) => c.kind === 'public' && normalizeEmail(c.viewer.email) === e);
      for (const c of mine) {
        const sub = c.subs.get(projectId);
        if (!sub) continue;
        send(c, { type: 'revoked', slug: slugOf(projectId, sub.slug) });
        removeSub(c, projectId);
      }
      if (projects.projectsFor({ kind: 'reviewer', email: e, name: null }).length === 0) {
        for (const c of mine) c.ws.close(1008, 'revoked');
      }
    },

    /**
     * The project's slug changed: its subscribers are told where it moved, and their subscriptions follow it.
     * @param {number} projectId
     * @param {string} from the old slug
     * @param {string} to the new slug
     */
    moveProject(projectId, from, to) {
      for (const c of clients) {
        const sub = c.subs.get(projectId);
        if (!sub) continue;
        sub.slug = to;
        send(c, { type: 'moved', slug: from, to });
      }
    },

    /**
     * The project was deleted: every subscription to it ends with `revoked`.
     * @param {number} projectId
     */
    dropProject(projectId) {
      for (const c of clients) {
        const sub = c.subs.get(projectId);
        if (!sub) continue;
        send(c, { type: 'revoked', slug: sub.slug });
        removeSub(c, projectId);
      }
    },

    /** Terminate every socket and stop the heartbeat. */
    close() {
      clearInterval(heartbeat);
      for (const c of [...clients]) {
        dropClient(c);
        c.ws.terminate();
      }
      wss.close();
    },
  };
}
