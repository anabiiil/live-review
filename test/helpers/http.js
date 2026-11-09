import { request as httpRequest } from 'node:http';

/**
 * @typedef {{status:number, headers:import('node:http').IncomingHttpHeaders, body:string, ms:number,
 *   json:()=>any, cookies:Record<string, string>}} TestResponse
 */

/** Every response body received through this helper, for leak checks. */
export const seenBodies = /** @type {string[]} */ ([]);

/**
 * Send an HTTP request to 127.0.0.1 with full control over Host, Origin and Cookie headers
 * (fetch forbids setting Host).
 * @param {number} port
 * @param {{method?:string, path?:string, headers?:Record<string,string>, body?:unknown, raw?:string}} [opts]
 * @returns {Promise<TestResponse>}
 */
export function request(port, { method = 'GET', path = '/', headers = {}, body, raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const allHeaders = { ...headers };
  if (payload !== undefined) {
    if (!Object.keys(allHeaders).some((h) => h.toLowerCase() === 'content-type')) {
      allHeaders['Content-Type'] = 'application/json';
    }
    allHeaders['Content-Length'] = String(Buffer.byteLength(payload));
  }
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: allHeaders, agent: false }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        seenBodies.push(text);
        /** @type {Record<string,string>} */
        const cookies = {};
        for (const line of res.headers['set-cookie'] ?? []) {
          const [pair] = line.split(';');
          const eq = pair.indexOf('=');
          cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
        }
        resolve({
          status: /** @type {number} */ (res.statusCode),
          headers: res.headers,
          body: text,
          ms: performance.now() - started,
          json: () => JSON.parse(text),
          cookies,
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
