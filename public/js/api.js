// Same-origin JSON fetch helpers.

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {any} data parsed JSON body, or null
   */
  constructor(status, data) {
    super(data?.message ?? data?.error ?? `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** @type {((err:ApiError)=>void)|null} */
let unauthorizedHandler = null;

/** @param {(err:ApiError)=>void} fn called when an API request (other than sign-in) answers 401 */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {{auth?:boolean}} [opts] auth:false → a 401 is returned as an error without redirecting (sign-in calls)
 * @returns {Promise<any>}
 */
export async function api(method, path, body, { auth = true } = {}) {
  /** @type {RequestInit} */
  const init = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    /** @type {Record<string,string>} */ (init.headers)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  /** @type {any} */
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && auth && unauthorizedHandler) unauthorizedHandler(err);
    throw err;
  }
  return data;
}

export const get = (/** @type {string} */ path) => api('GET', path);
export const post = (/** @type {string} */ path, /** @type {unknown} */ body, /** @type {{auth?:boolean}} */ opts) =>
  api('POST', path, body ?? {}, opts);
export const patch = (/** @type {string} */ path, /** @type {unknown} */ body) => api('PATCH', path, body);
export const del = (/** @type {string} */ path) => api('DELETE', path);

/** @param {string} slug @param {string} target */
export const getComments = (slug, target) => get(`/api/p/${encodeURIComponent(slug)}/comments?target=${encodeURIComponent(target)}`);
