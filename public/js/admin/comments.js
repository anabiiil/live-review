// Comments tab: every thread across all projects, with the project's name on each card. The same page and
// cards as a project's Comments tab.
import { get } from '../api.js';
import { createCommentsPage } from '../views/comments.js';

/**
 * @param {{me:{email:string, name:string|null, kind:'owner'|'reviewer'}, onCount:(open:number)=>void}} o
 */
export function commentsView({ me, onCount }) {
  return createCommentsPage({
    me,
    crossProject: true,
    // The admin page is not the single-page app: "Show in code" opens the project page.
    inApp: false,
    onCount,
    load: async () => (await get('/api/admin/threads?status=all')).threads,
  });
}
