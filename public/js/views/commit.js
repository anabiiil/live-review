import { ApiError, get } from '../api.js';
import { h, messageBox, setChildren } from '../dom.js';
import { relativeTime, splitMessage } from '../format.js';
import { icon } from '../icons.js';
import { initials } from '../shell-model.js';
import { createReview } from '../review.js';

/**
 * One commit: message, diff, comments.
 * @param {import('./project.js').ProjectCtx} p
 * @param {string} sha
 */
export function commitBody({ ctx, chrome, project }, sha) {
  const slug = encodeURIComponent(project.slug);
  const loading = h('p', { class: 'muted pad', text: 'Loading…' });
  setChildren(chrome.main, loading);
  let alive = true;
  /** @type {ReturnType<typeof createReview>|null} */
  let review = null;
  /** @type {string|null} */
  let fullSha = null;
  const me = /** @type {NonNullable<typeof ctx.me>} */ (ctx.me);

  const loadComments = () => review?.refreshComments().catch(() => {});
  chrome.listen((e) => {
    if (e.type === 'live') chrome.setHead(e.head);
    else if (e.type === 'comments' && fullSha && e.target === fullSha) loadComments();
    else if (e.type === 'open') loadComments();
  });
  ctx.socket.subscribe(project.slug);

  get(`/api/p/${slug}/commit/${encodeURIComponent(sha)}`).then(
    ({ commit, files }) => {
      if (!alive || chrome.stopped) return;
      fullSha = commit.sha;
      document.title = `${splitMessage(commit.message).subject} · ${project.name} · LiveReview`;
      const { subject, rest } = splitMessage(commit.message);
      const root = h('div', { class: 'review' });
      const parents = /** @type {string[]} */ (commit.parents);
      setChildren(
        chrome.main,
        h(
          'div',
          { class: 'container wide' },
          h(
            'header',
            { class: 'commit-head' },
            h('h1', { class: 'commit-subject', dir: 'auto', text: subject || '(no message)' }),
            rest ? h('pre', { class: 'commit-body', dir: 'auto', text: rest }) : null,
            h(
              'div',
              { class: 'commit-meta' },
              h(
                'span',
                { class: 'commit-by' },
                h('span', { class: 'avatar small', 'aria-hidden': 'true', text: initials(commit.author, '') }),
                h('span', null, h('bdi', { class: 'commit-author', text: commit.author }), ' committed ', h('time', { datetime: commit.date, title: new Date(commit.date).toLocaleString(), text: relativeTime(commit.date) })),
              ),
              h('span', { class: 'commit-sha', title: commit.sha }, icon('git-commit'), h('span', { class: 'sha-full', dir: 'ltr', text: commit.sha })),
              parents.length
                ? h(
                    'span',
                    { class: 'commit-parents' },
                    parents.length === 1 ? 'Parent ' : 'Parents ',
                    ...parents.map((/** @type {string} */ ps) => h('a', { class: 'sha', href: `/${slug}/commit/${ps}`, 'data-link': '', text: ps.slice(0, 7) })),
                  )
                : null,
            ),
          ),
          root,
        ),
      );
      review = createReview({ slug: project.slug, target: commit.sha, root, me });
      review.setDiff(files, false);
      loadComments();
    },
    (err) => {
      if (!alive || chrome.stopped) return;
      setChildren(
        chrome.main,
        err instanceof ApiError && err.status === 404
          ? messageBox('Commit not found', "This commit isn't available to view.")
          : messageBox("This project isn't available right now", 'Please try again in a moment.'),
      );
    },
  );

  return {
    destroy() {
      alive = false;
      review?.destroy();
    },
  };
}
