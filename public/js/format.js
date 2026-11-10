// Pure text helpers. No DOM access: importable from node for tests.

/**
 * @typedef {{kind:'text'|'code'|'pre', text:string}} BodyNode
 */

const FENCE_OPEN = /^\s{0,3}```([^`]*)$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;
const INLINE_CODE = /`([^`\n]+)`/g;

/**
 * @param {BodyNode[]} out
 * @param {string} str
 */
function pushInline(out, str) {
  let last = 0;
  INLINE_CODE.lastIndex = 0;
  for (let m = INLINE_CODE.exec(str); m; m = INLINE_CODE.exec(str)) {
    if (m.index > last) out.push({ kind: 'text', text: str.slice(last, m.index) });
    out.push({ kind: 'code', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < str.length) out.push({ kind: 'text', text: str.slice(last) });
}

/**
 * Split a comment body into text, inline `code` and fenced ``` blocks. Nothing else is interpreted.
 * An unclosed fence runs to the end of the body.
 * @param {string} body
 * @returns {BodyNode[]}
 */
export function parseBody(body) {
  /** @type {BodyNode[]} */
  const out = [];
  const lines = String(body).split('\n');
  /** @type {string[]} */
  let buf = [];
  const flush = () => {
    if (buf.length) pushInline(out, buf.join('\n'));
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (FENCE_OPEN.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !FENCE_CLOSE.test(lines[j])) j++;
      flush();
      out.push({ kind: 'pre', text: lines.slice(i + 1, j).join('\n') });
      i = j + 1;
    } else {
      buf.push(lines[i]);
      i++;
    }
  }
  flush();
  return out;
}

/**
 * "just now", "5 min ago", "3 h ago", "2 d ago", else the date (YYYY-MM-DD).
 * @param {number|string|Date} when epoch ms, ISO string or Date
 * @param {number} [now] epoch ms
 * @returns {string}
 */
export function relativeTime(when, now = Date.now()) {
  const t = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(s / 3600);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(s / 86400);
  if (d < 30) return `${d} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Header text for the repository head.
 * @param {{branch:string|null, detached:boolean, sha:string|null, empty:boolean, operation:null|'rebase'|'merge'}|null|undefined} head
 * @returns {{label:string, banner:string|null}}
 */
export function headLabel(head) {
  if (!head) return { label: '', banner: null };
  /** @type {string|null} */
  let banner = null;
  if (head.operation === 'rebase') banner = 'A rebase is in progress. The diff may look unusual until it finishes.';
  else if (head.operation === 'merge') banner = 'A merge is in progress. The diff may look unusual until it is finished.';
  let label;
  if (head.detached) label = `detached at ${(head.sha ?? '').slice(0, 7)}`;
  else if (head.empty) label = `${head.branch ?? 'unborn branch'} (no commits yet)`;
  else label = head.branch ?? '';
  return { label, banner };
}

/**
 * First line and the rest of a commit message.
 * @param {string} message
 * @returns {{subject:string, rest:string}}
 */
export function splitMessage(message) {
  const text = String(message ?? '');
  const nl = text.indexOf('\n');
  if (nl < 0) return { subject: text, rest: '' };
  return { subject: text.slice(0, nl), rest: text.slice(nl + 1).replace(/^\n+/, '') };
}
