/** @typedef {import('node:http').IncomingMessage} Req */
/** @typedef {import('node:http').ServerResponse} Res */

export const MAX_BODY_BYTES = 64 * 1024;

/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} error stable machine-readable value sent as `{error}`
   * @param {string} [message] optional human-readable detail sent as `{message}`
   */
  constructor(status, error, message) {
    super(message ?? error);
    this.name = 'HttpError';
    this.status = status;
    this.error = error;
    /** @type {string|undefined} */
    this.detail = message;
  }
}

/**
 * @typedef {{req:Req, res:Res, params:Record<string,string>, query:URLSearchParams, body:any,
 *   viewer:import('../types.js').Viewer|null, listener:import('./guards.js').Listener, started:number}} RouteContext
 */
/**
 * @typedef {{method:string, parts:string[], handler:(ctx:RouteContext)=>unknown|Promise<unknown>,
 *   auth:boolean, page:boolean, only?:'public'|'admin'}} Route
 */

/**
 * Minimal path router. Patterns are `/literal/:param/...`, and a final `*` segment matches the rest
 * (raw, still percent-encoded) as `params['*']`. Routes match in registration order.
 */
export function createRouter() {
  /** @type {Route[]} */
  const routes = [];

  return {
    /**
     * @param {string} method GET routes also answer HEAD
     * @param {string} pattern
     * @param {Route['handler']} handler
     * @param {{auth?:boolean, page?:boolean, only?:'public'|'admin'}} [opts] auth defaults to true
     */
    add(method, pattern, handler, { auth = true, page = false, only } = {}) {
      routes.push({ method, parts: pattern.split('/').slice(1), handler, auth, page, only });
    },

    /**
     * @param {string} method
     * @param {string} pathname raw (percent-encoded) path
     * @returns {{route:Route, params:Record<string,string>}|{methodNotAllowed:true}|null}
     */
    match(method, pathname) {
      const segs = pathname.split('/').slice(1);
      let pathMatched = false;
      for (const route of routes) {
        const params = matchParts(route.parts, segs);
        if (!params) continue;
        if (route.method === method || (method === 'HEAD' && route.method === 'GET')) return { route, params };
        pathMatched = true;
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

/**
 * @param {string[]} parts
 * @param {string[]} segs
 * @returns {Record<string,string>|null}
 */
function matchParts(parts, segs) {
  /** @type {Record<string,string>} */
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '*' && i === parts.length - 1) {
      params['*'] = segs.slice(i).join('/');
      return params;
    }
    if (i >= segs.length) return null;
    if (p.startsWith(':')) {
      let value;
      try {
        value = decodeURIComponent(segs[i]);
      } catch {
        return null;
      }
      if (value === '') return null;
      params[p.slice(1)] = value;
    } else if (p !== segs[i]) {
      return null;
    }
  }
  return parts.length === segs.length ? params : null;
}

/**
 * @param {Res} res
 * @param {number} status
 * @param {unknown} data
 */
export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {Res} res
 * @param {number} status
 * @param {string} html
 */
export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/**
 * @param {Res} res
 * @param {string} location a same-site path
 */
export function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0 });
  res.end();
}

/**
 * Read a JSON request body (max 64 KB). An empty body yields `{}`.
 * @param {Req} req
 * @returns {Promise<any>}
 */
export async function readJsonBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'too-large');
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  // Oversized bodies are drained (not stored) so the client still receives the 413; the server's
  // request timeout bounds how long that can take.
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too-large');
  if (size === 0) return {};
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(type)) throw new HttpError(400, 'invalid', 'expected a JSON body');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid', 'invalid JSON');
  }
}
