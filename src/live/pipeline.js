import { RepoError, commitInfo } from '../git/repo.js';
import { commitDiff, liveDiff } from '../git/diff.js';
import { attachOnCommit, markRewritten, reanchorLive } from '../comments/reanchor.js';

/** @typedef {import('../types.js').HeadState} HeadState */
/** @typedef {import('../types.js').FileDiff} FileDiff */
/**
 * What a subscriber receives for a project: its live diff, or the reason it has none.
 * @typedef {{type:'live', slug:string, head:HeadState, files:FileDiff[], untrackedTruncated:boolean}
 *   | {type:'error', slug:string, error:'project-unavailable'}} LiveMessage
 */
/**
 * @typedef {object} ProjectState
 * @property {Promise<void>|null} running the current run loop
 * @property {boolean} pending a change arrived during the run: run once more
 * @property {boolean} initialized a head has been seen (the first run never attaches)
 * @property {string|null} headSha head of the last successful run
 * @property {LiveMessage|null} last
 * @property {string|null} sent serialised last message broadcast to subscribers
 * @property {boolean} logged an unexpected error was already logged
 */

/**
 * The live pipeline: on every change of a watched project, recompute the live diff, move comments
 * that landed in a new commit onto it, flag comments on rewritten history, re-anchor live comments and
 * tell subscribers. Runs are serialized per project; changes during a run coalesce into one more run.
 * All git used here is read-only.
 * @param {{projects:ReturnType<typeof import('../projects/store.js').createProjectStore>,
 *   comments:ReturnType<typeof import('../comments/store.js').createCommentStore>,
 *   hub:{broadcast:(projectId:number, msg:object)=>void}}} deps
 */
export function createPipeline({ projects, comments, hub }) {
  /** @type {Map<number, ProjectState>} */
  const states = new Map();
  let closed = false;

  /** @param {number} projectId @returns {ProjectState} */
  function stateOf(projectId) {
    let st = states.get(projectId);
    if (!st) {
      st = { running: null, pending: false, initialized: false, headSha: null, last: null, sent: null, logged: false };
      states.set(projectId, st);
    }
    return st;
  }

  /**
   * @param {number} projectId
   * @param {ProjectState} st
   */
  async function runOnce(projectId, st) {
    const p = projects.get(projectId);
    if (!p) {
      states.delete(projectId);
      return;
    }
    try {
      const { head, files, untrackedTruncated } = await liveDiff(p.path, { extraHidden: p.extraHidden });
      /** @type {Set<string>} */
      const targets = new Set(['live']);
      /** @param {number[]} ids */
      const touched = (ids) => {
        for (const id of ids) {
          const c = comments.get(id);
          if (c) targets.add(c.target);
        }
      };
      if (st.initialized && head.sha !== st.headSha) {
        let attached = false;
        if (head.sha !== null) {
          const info = await commitInfo(p.path, head.sha);
          // A commit made on top of the previous head (or the first commit of an empty repository).
          if ((info.parents[0] ?? null) === st.headSha) {
            const commitFiles = await commitDiff(p.path, info.sha, { extraHidden: p.extraHidden });
            if ((await attachOnCommit({ root: p.path, projectId, sha: info.sha, commitFiles, store: comments })).length) {
              targets.add(info.sha);
            }
            attached = true;
          }
        }
        if (!attached) touched(await markRewritten({ root: p.path, projectId, store: comments }));
      }
      await reanchorLive({ root: p.path, projectId, files, store: comments, extraHidden: p.extraHidden });
      st.initialized = true;
      st.headSha = head.sha;
      st.logged = false;
      // The project may have been removed while git was running.
      const now = projects.get(projectId);
      if (!now || states.get(projectId) !== st) return;
      st.last = { type: 'live', slug: now.slug, head, files, untrackedTruncated };
      // Subscribers already have an identical state: tell them only about other comment targets.
      const sent = JSON.stringify(st.last);
      if (sent === st.sent) targets.delete('live');
      else hub.broadcast(projectId, st.last);
      st.sent = sent;
      for (const target of targets) hub.broadcast(projectId, { type: 'comments', slug: now.slug, target });
    } catch (err) {
      if (!(err instanceof RepoError) && !st.logged) {
        st.logged = true;
        console.error(`LiveReview live update failed (project ${projectId}):`, err instanceof Error ? err.message : err);
      }
      const now = projects.get(projectId);
      if (!now || states.get(projectId) !== st) return;
      st.last = { type: 'error', slug: now.slug, error: 'project-unavailable' };
      st.sent = null;
      hub.broadcast(projectId, st.last);
    }
  }

  /**
   * @param {number} projectId
   * @param {ProjectState} st
   */
  async function loop(projectId, st) {
    try {
      do {
        st.pending = false;
        if (closed) break;
        await runOnce(projectId, st);
      } while (st.pending);
    } finally {
      st.running = null;
    }
  }

  /**
   * Recompute a project's live state and notify subscribers. Never rejects. A call made while a run is in
   * progress resolves after the single follow-up run that covers it.
   * @param {number} projectId
   * @returns {Promise<void>}
   */
  function recompute(projectId) {
    if (closed) return Promise.resolve();
    const st = stateOf(projectId);
    if (st.running) {
      st.pending = true;
      return st.running;
    }
    st.running = loop(projectId, st);
    return st.running;
  }

  return {
    recompute,

    /**
     * The current live message for a new subscriber. `refresh` forces a new run (the project was not being
     * watched, so the last result may be stale); otherwise the last result is reused once any run in progress ends.
     * @param {number} projectId
     * @param {{refresh?:boolean}} [opts]
     * @returns {Promise<LiveMessage|null>} null when the project no longer exists
     */
    async snapshot(projectId, { refresh = false } = {}) {
      const st = stateOf(projectId);
      if (refresh || !st.last) await recompute(projectId);
      else if (st.running) await st.running;
      return states.get(projectId)?.last ?? null;
    },

    /**
     * Forget a removed project.
     * @param {number} projectId
     */
    drop(projectId) {
      states.delete(projectId);
    },

    /** Stop starting runs and wait for those in progress. */
    async close() {
      closed = true;
      await Promise.all([...states.values()].map((st) => st.running));
    },
  };
}
