import { ApiError, get } from '../api.js';
import { h, messageBox, setChildren } from '../dom.js';
import { createReview } from '../review.js';

/**
 * Live working-tree diff, updated over the socket.
 * @param {import('./project.js').ProjectCtx} p
 */
export function liveBody({ ctx, chrome, project }) {
  const loading = h('p', { class: 'muted pad', text: 'Loading…' });
  const root = h('div', { class: 'review' });
  setChildren(chrome.main, loading, root);
  const me = /** @type {NonNullable<typeof ctx.me>} */ (ctx.me);
  const review = createReview({ slug: project.slug, target: 'live', root, me });
  let gotLive = false;

  /** @param {{head:any, files:any[], untrackedTruncated:boolean}} msg */
  function apply(msg) {
    gotLive = true;
    loading.remove();
    chrome.setHead(msg.head);
    review.setDiff(msg.files, !!msg.untrackedTruncated);
  }
  const loadComments = () => review.refreshComments().catch(() => {});

  chrome.listen((e) => {
    if (e.type === 'live') apply(/** @type {any} */ (e));
    else if (e.type === 'comments' && e.target === 'live') loadComments();
    else if (e.type === 'open') loadComments();
  });
  ctx.socket.subscribe(project.slug);
  loadComments();

  // The socket delivers the first state; this covers a socket that cannot connect.
  get(`/api/p/${encodeURIComponent(project.slug)}/live`).then(
    (d) => {
      if (!gotLive && !chrome.stopped) apply(d);
    },
    (err) => {
      if (!gotLive && !chrome.stopped) {
        loading.remove();
        setChildren(chrome.main, messageBox("This project isn't available right now", err instanceof ApiError && err.status === 404 ? undefined : 'Please try again in a moment.'));
      }
    },
  );

  return {
    destroy() {
      review.destroy();
    },
  };
}
