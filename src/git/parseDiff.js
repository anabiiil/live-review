/** @typedef {import('../types.js').FileDiff} FileDiff */
/** @typedef {import('../types.js').Hunk} Hunk */
/** @typedef {import('../types.js').DiffLine} DiffLine */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Decode a C-style quoted git path ("a\tb", octal escapes) or strip a trailing tab.
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
  let s = raw.replace(/\t+$/, '');
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
    /** @type {number[]} */
    const bytes = [];
    const enc = new TextEncoder();
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        const n = s[i + 1];
        if (/[0-7]/.test(n)) {
          const m = /^[0-7]{1,3}/.exec(s.slice(i + 1));
          bytes.push(parseInt(m[0], 8));
          i += m[0].length;
          continue;
        }
        const map = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
        if (n in map) {
          bytes.push(map[n]);
          i += 1;
          continue;
        }
      }
      bytes.push(...enc.encode(ch));
    }
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }
  return s;
}

/**
 * @param {string} p path as printed after ---/+++ (may be /dev/null)
 * @returns {string|null} path without a/ b/ prefix, or null for /dev/null
 */
function cleanSidePath(p) {
  const u = unquote(p);
  if (u === '/dev/null') return null;
  return u.replace(/^[ab]\//, '');
}

/**
 * Split "Binary files X and Y differ". File names may themselves contain " and ", so a side is
 * only trusted when it is /dev/null or when both sides agree on one path (a/P and b/P).
 * @param {string} line
 * @returns {{old: string|null, new: string|null}|null} null when the line is ambiguous
 */
function parseBinaryLine(line) {
  const m = /^Binary files (.+) differ$/.exec(line);
  if (!m) return null;
  const body = m[1];
  if (body.startsWith('/dev/null and ')) return { old: null, new: cleanSidePath(body.slice('/dev/null and '.length)) };
  if (body.endsWith(' and /dev/null')) return { old: cleanSidePath(body.slice(0, -' and /dev/null'.length)), new: null };
  const half = (body.length - ' and '.length) / 2;
  if (Number.isInteger(half) && body.slice(half, half + 5) === ' and ') {
    const a = body.slice(0, half);
    const b = body.slice(half + 5);
    if (a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) {
      return { old: cleanSidePath(a), new: cleanSidePath(b) };
    }
  }
  return null;
}

/**
 * Best effort extraction of the path from the "diff --git a/X b/X" line.
 * @param {string} line
 * @returns {string|null}
 */
function pathFromGitHeader(line) {
  const rest = line.slice('diff --git '.length);
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === ' ') {
    const a = rest.slice(0, mid);
    const b = rest.slice(mid + 1);
    if (a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) {
      return b.slice(2);
    }
  }
  const m = /^(?:"?a\/.*?"?) ("?b\/.*"?)$/.exec(rest);
  return m ? cleanSidePath(m[1]) : null;
}

/**
 * @param {string[]} lines raw lines of a single file section
 * @returns {FileDiff}
 */
function parseSection(lines) {
  let oldFile; // undefined = not seen, null = /dev/null
  let newFile;
  let renameFrom = null;
  let renameTo = null;
  let isNew = false;
  let isDeleted = false;
  let binary = false;
  let binaryOld = null;
  let binaryNew = null;
  /** @type {Hunk[]} */
  const hunks = [];
  /** @type {Hunk|null} */
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (hunk === null) {
      if (line.startsWith('@@')) {
        // fall through to hunk handling below
      } else if (line.startsWith('--- ')) {
        oldFile = cleanSidePath(line.slice(4));
        continue;
      } else if (line.startsWith('+++ ')) {
        newFile = cleanSidePath(line.slice(4));
        continue;
      } else if (line.startsWith('rename from ')) {
        renameFrom = unquote(line.slice('rename from '.length));
        continue;
      } else if (line.startsWith('rename to ')) {
        renameTo = unquote(line.slice('rename to '.length));
        continue;
      } else if (line.startsWith('new file mode')) {
        isNew = true;
        continue;
      } else if (line.startsWith('deleted file mode')) {
        isDeleted = true;
        continue;
      } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        binary = true;
        const sides = parseBinaryLine(line);
        if (sides) {
          binaryOld = sides.old;
          binaryNew = sides.new;
        }
        continue;
      } else {
        continue;
      }
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      hunk = { header: line.replace(/\r$/, ''), lines: [] };
      hunks.push(hunk);
      oldNo = Number(hm[1]);
      newNo = Number(hm[3]);
      oldLeft = hm[2] === undefined ? 1 : Number(hm[2]);
      newLeft = hm[4] === undefined ? 1 : Number(hm[4]);
      continue;
    }
    if (hunk === null) continue;
    const c = line[0];
    const text = line.slice(1).replace(/\r$/, '');
    if (c === '\\') continue; // "\ No newline at end of file"
    if (c === '+') {
      hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, text });
      newLeft--;
    } else if (c === '-') {
      hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text });
      oldLeft--;
    } else if (c === ' ' || (line === '' && oldLeft > 0 && newLeft > 0)) {
      hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text });
      oldLeft--;
      newLeft--;
    }
  }

  const renamed = renameFrom !== null || renameTo !== null;
  const added = isNew || oldFile === null || (binary && binaryOld === null && binaryNew !== null);
  const deleted = isDeleted || newFile === null || (binary && binaryNew === null && binaryOld !== null);

  /** @type {FileDiff['status']} */
  let status = 'modified';
  if (renamed) status = 'renamed';
  else if (added) status = 'added';
  else if (deleted) status = 'deleted';

  // Binary sections have no ---/+++ lines, so the diff --git header is the most reliable source.
  const headerPath = binary ? pathFromGitHeader(lines[0]) : null;
  let path;
  if (status === 'deleted') {
    path = oldFile ?? renameFrom ?? headerPath ?? binaryOld;
  } else {
    path = newFile ?? renameTo ?? headerPath ?? binaryNew;
  }
  path = path ?? pathFromGitHeader(lines[0]) ?? '';

  let oldPath = null;
  if (status === 'renamed') {
    oldPath = renameFrom ?? oldFile ?? null;
  }

  const patch = lines.join('\n') + '\n';
  return {
    path,
    oldPath,
    status,
    binary,
    hidden: false,
    large: false,
    hunks: binary ? [] : hunks,
    patch,
  };
}

/**
 * Parse `git diff` unified output into per-file structures.
 * @param {string} text
 * @returns {FileDiff[]}
 */
export function parseDiff(text) {
  if (!text) return [];
  const all = text.split('\n');
  if (all[all.length - 1] === '') all.pop();
  /** @type {string[][]} */
  const sections = [];
  /** @type {string[]|null} */
  let cur = null;
  for (const line of all) {
    if (line.startsWith('diff --git ')) {
      cur = [line];
      sections.push(cur);
    } else if (cur) {
      cur.push(line);
    }
  }
  return sections.map(parseSection);
}
