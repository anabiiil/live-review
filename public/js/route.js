// Pure route parsing. No DOM access: importable from node for tests.

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * @typedef {{name:'login'}|{name:'projects'}|{name:'project', slug:string}|{name:'live', slug:string}
 *   |{name:'commits', slug:string}|{name:'comments', slug:string}|{name:'commit', slug:string, sha:string}|{name:'notfound'}} Route
 */

/**
 * @param {string} pathname
 * @returns {Route}
 */
export function parseRoute(pathname) {
  if (pathname === '/') return { name: 'projects' };
  let segs;
  try {
    segs = pathname.split('/').slice(1).map(decodeURIComponent);
  } catch {
    return { name: 'notfound' };
  }
  const [first, second, third] = segs;
  if (segs.length === 1 && first === 'login') return { name: 'login' };
  if (!SLUG.test(first)) return { name: 'notfound' };
  if (segs.length === 1) return { name: 'project', slug: first };
  if (segs.length === 2 && second === 'live') return { name: 'live', slug: first };
  if (segs.length === 2 && second === 'commits') return { name: 'commits', slug: first };
  if (segs.length === 2 && second === 'comments') return { name: 'comments', slug: first };
  if (segs.length === 3 && second === 'commit' && SHA.test(third)) return { name: 'commit', slug: first, sha: third };
  return { name: 'notfound' };
}

/**
 * Comment id from a `#c-{id}` hash, or null.
 * @param {string} hash
 * @returns {number|null}
 */
export function commentIdFromHash(hash) {
  const m = /^#c-(\d{1,15})$/.exec(hash);
  return m ? Number(m[1]) : null;
}
