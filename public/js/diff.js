// Diff renderer: our own unified and side-by-side tables from FileDiff.hunks. A right margin column carries a
// highlighter mark on every line with comments; the mark opens and closes the threads under the line.
import { h } from './dom.js';
import { renderComposer, renderThread } from './comments.js';
import { icon } from './icons.js';
import {
  LARGE_DIFF_LINES, commentCount, diffLineCount, diffStats, fileLineKeys, lineKey, markLabel, markSummary, maxLineLength, pairLines,
  rowPositions, toggleThreads,
} from './pairing.js';

/** @typedef {import('../../src/types.js').FileDiff} FileDiff */
/** @typedef {import('../../src/types.js').DiffLine} DiffLine */
/** @typedef {import('./comments.js').CommentEnv} CommentEnv */
/** @typedef {{side:'old'|'new', line:number, key:string}} Position */

/**
 * @typedef {object} DiffEnv
 * @property {CommentEnv} comments
 * @property {'split'|'unified'} mode layout actually used (phones are always unified)
 * @property {Map<string, any[]>} byKey top-level threads by `${path}:${side}:${line}`
 * @property {Map<string, any[]>} byPath top-level threads with a line, by path
 * @property {Set<number>} placed thread ids rendered in a row (filled while rendering)
 * @property {Map<string, number>} openByPath unresolved thread counts
 */

const STATUS = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const STATUS_TITLE = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' };
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');
/** Matches --t-fast in tokens.css. */
const CLOSE_MS = 150;
/** Review states with a close animation running: toggles wait for it, so a double click does not flicker. */
const closing = new WeakSet();

/** @param {string} text */
const note = (text) => h('p', { class: 'file-note', text });

/**
 * Open or close a group of threads. Closing lets the open threads fade out first (unless motion is reduced).
 * @param {DiffEnv} env
 * @param {number[]} ids
 */
function toggle(env, ids) {
  const { ui } = env.comments;
  if (closing.has(ui)) return;
  const leaving = ids.filter((id) => ui.openThreads.has(id));
  const opened = toggleThreads(ui.openThreads, ids);
  if (opened) {
    for (const id of ids) ui.opening.add(id);
    env.comments.rerender();
    return;
  }
  const els = REDUCED_MOTION.matches ? [] : leaving.map((id) => document.getElementById(`c-${id}`)).filter(Boolean);
  if (!els.length) {
    env.comments.rerender();
    return;
  }
  for (const el of els) /** @type {HTMLElement} */ (el).classList.add('closing');
  closing.add(ui);
  setTimeout(() => {
    closing.delete(ui);
    env.comments.rerender();
  }, CLOSE_MS);
}

/**
 * Threads (open ones only) and composer for the given positions, or null when there is nothing to show.
 * @param {DiffEnv} env
 * @param {string} path
 * @param {Position[]} positions
 */
function slotContent(env, path, positions) {
  const { ui } = env.comments;
  /** @type {HTMLElement[]} */
  const out = [];
  for (const p of positions) {
    for (const t of env.byKey.get(p.key) ?? []) {
      env.placed.add(t.id);
      if (ui.openThreads.has(t.id)) out.push(renderThread(t, env.comments, { inline: true }));
    }
    const open = ui.composers.get(p.key);
    if (open) {
      out.push(
        renderComposer(env.comments, {
          key: p.key, label: 'Comment', placeholder: `Comment on line ${p.line}`,
          onSubmit: async (text) => {
            const created = await env.comments.createComment(path, p.side, p.line, text);
            ui.composers.delete(p.key);
            // The new thread stays open where it was written.
            if (created && typeof created.id === 'number') ui.openThreads.add(created.id);
            await env.comments.refresh();
          },
          onCancel: () => {
            ui.composers.delete(p.key);
            env.comments.rerender();
          },
        }),
      );
    }
  }
  return out.length ? out : null;
}

/**
 * The right-margin cell of a row: a highlighter mark when the row's lines have threads.
 * @param {DiffEnv} env
 * @param {Position[]} positions
 */
function marginCell(env, positions) {
  /** @type {any[]} */
  const threads = positions.flatMap((p) => env.byKey.get(p.key) ?? []);
  if (!threads.length) return h('td', { class: 'margin' });
  const { ui } = env.comments;
  const s = markSummary(threads);
  const expanded = s.ids.every((id) => ui.openThreads.has(id));
  const cls = ['mark'];
  if (s.resolved) cls.push('resolved');
  if (expanded) cls.push('is-open');
  return h(
    'td',
    { class: 'margin has-mark' },
    h(
      'button',
      {
        class: cls.join(' '), type: 'button', 'aria-expanded': String(expanded), 'aria-label': markLabel(s, positions[0].line, expanded),
        'data-focus-key': `mark:${positions[0].key}`,
        title: s.resolved ? `Resolved: ${commentCount(s.comments)}` : commentCount(s.comments),
        onclick: () => toggle(env, s.ids),
      },
      s.resolved ? icon('check', { size: 12 }) : null,
      h('span', { class: 'mark-n', text: String(s.comments) }),
    ),
  );
}

/**
 * A line-number cell. Cells with a number are clickable and open a composer on that side.
 * @param {'old'|'new'} side
 * @param {number|null} no
 * @param {boolean} primary shows the "+" affordance
 * @param {'add'|'del'|'ctx'} [type] line type, for shading
 */
function numCell(side, no, primary, type = 'ctx') {
  if (no === null) return h('td', { class: `num ${side} empty` });
  return h(
    'td',
    { class: `num ${side} ${type}`, 'data-side': side, 'data-line': no },
    primary ? h('button', { class: 'addc', type: 'button', 'aria-label': `Add a comment on line ${no}`, text: '+' }) : null,
    h('span', { class: 'n', text: String(no) }),
  );
}

const MARK = { add: '+', del: '-', ctx: ' ' };

/**
 * @param {DiffLine|null} l
 * @param {string} extra
 */
function codeCell(l, extra = '') {
  if (!l) return h('td', { class: `code empty ${extra}` });
  return h('td', { class: `code ${l.type} ${extra}`, dir: 'ltr', 'data-m': MARK[l.type], text: l.text });
}

/**
 * The row under a line that holds its open threads and composer.
 * @param {number} span
 * @param {HTMLElement} inner
 * @param {boolean} resolved every thread in it is resolved
 */
const slotRow = (span, inner, resolved) => h('tr', { class: `slot${resolved ? ' resolved' : ''}` }, h('td', { colspan: span }, inner));

/** @param {(HTMLElement[]|null)[]} parts */
const allResolved = (...parts) => {
  const threads = parts.flat().filter((el) => el && el.classList.contains('thread'));
  return threads.length > 0 && threads.every((el) => el?.classList.contains('resolved'));
};

/**
 * @param {FileDiff} file
 * @param {DiffEnv} env
 */
function unifiedTable(file, env) {
  const tbody = h('tbody');
  for (const hunk of file.hunks) {
    tbody.append(h('tr', { class: 'hunk' }, h('td', { colspan: 4, dir: 'ltr', text: hunk.header })));
    for (const l of hunk.lines) {
      const positions = rowPositions(file.path, l);
      tbody.append(
        h(
          'tr',
          { class: `line ${l.type}` },
          numCell('old', l.type === 'add' ? null : l.oldNo, l.type === 'del', l.type),
          numCell('new', l.type === 'del' ? null : l.newNo, l.type !== 'del', l.type),
          codeCell(l),
          marginCell(env, positions),
        ),
      );
      const content = slotContent(env, file.path, positions);
      if (content) tbody.append(slotRow(4, h('div', { class: 'slot-inner' }, content), allResolved(content)));
    }
  }
  return h(
    'table',
    { class: 'diff unified' },
    h('colgroup', null, h('col', { class: 'c-num' }), h('col', { class: 'c-num' }), h('col'), h('col', { class: 'c-mark' })),
    tbody,
  );
}

/**
 * @param {FileDiff} file
 * @param {DiffEnv} env
 */
function splitTable(file, env) {
  const tbody = h('tbody');
  for (const hunk of file.hunks) {
    tbody.append(h('tr', { class: 'hunk' }, h('td', { colspan: 5, dir: 'ltr', text: hunk.header })));
    for (const { left, right } of pairLines(hunk.lines)) {
      /** @type {Position[]} */
      const lp = left && left.oldNo !== null ? [{ side: 'old', line: left.oldNo, key: lineKey(file.path, 'old', left.oldNo) }] : [];
      /** @type {Position[]} */
      const rp = right && right.newNo !== null ? [{ side: 'new', line: right.newNo, key: lineKey(file.path, 'new', right.newNo) }] : [];
      // A context line is the same line on both sides: its comments are keyed on whichever side they were made.
      tbody.append(
        h(
          'tr',
          { class: 'line' },
          numCell('old', left ? left.oldNo : null, true, left?.type),
          codeCell(left, 'old'),
          numCell('new', right ? right.newNo : null, true, right?.type),
          codeCell(right, 'new'),
          marginCell(env, [...rp, ...lp]),
        ),
      );
      const lc = slotContent(env, file.path, lp);
      const rc = slotContent(env, file.path, rp);
      if (lc || rc) {
        tbody.append(
          slotRow(5, h('div', { class: 'slot-inner slot-split' }, h('div', { class: 'slot-left' }, lc), h('div', { class: 'slot-right' }, rc)), allResolved(lc, rc)),
        );
      }
    }
  }
  return h(
    'table',
    { class: 'diff split' },
    h('colgroup', null, h('col', { class: 'c-num' }), h('col'), h('col', { class: 'c-num' }), h('col'), h('col', { class: 'c-mark' })),
    tbody,
  );
}

/**
 * The file header's comment count: toggles every thread of the file.
 * @param {FileDiff} file
 * @param {DiffEnv} env
 */
function fileComments(file, env) {
  // Only threads on lines this diff shows: the others are listed below the diff.
  const keys = fileLineKeys(file);
  const threads = (env.byPath.get(file.path) ?? []).filter((t) => keys.has(lineKey(t.path, t.side, t.line)));
  if (!threads.length) return null;
  const { ui } = env.comments;
  const s = markSummary(threads);
  const expanded = s.ids.every((id) => ui.openThreads.has(id));
  const text = commentCount(s.comments);
  return h(
    'button',
    {
      class: `file-comments${s.resolved ? ' resolved' : ''}`, type: 'button', 'aria-expanded': String(expanded),
      'data-focus-key': `filecomments:${file.path}`,
      'aria-label': `${expanded ? 'Hide' : 'Show'} ${s.resolved ? `${text}, all resolved` : text} in ${file.path}`,
      onclick: () => {
        // Make sure the lines are on screen before opening their threads.
        ui.collapsedFiles.delete(file.path);
        if (!expanded) ui.expandedFiles.add(file.path);
        toggle(env, s.ids);
      },
    },
    s.resolved ? icon('check', { size: 14 }) : icon('message', { size: 14 }),
    h('span', { text }),
  );
}

/**
 * One file section: sticky header, then its diff (or the reason there is none).
 * @param {FileDiff} file
 * @param {DiffEnv} env
 * @returns {HTMLElement}
 */
export function renderFile(file, env) {
  const ui = env.comments.ui;
  const collapsed = ui.collapsedFiles.has(file.path);
  const lines = diffLineCount(file);
  const { add, del } = diffStats(file);

  const toggleBtn = h(
    'button',
    {
      class: 'file-toggle', type: 'button', 'aria-expanded': String(!collapsed), 'aria-label': `${collapsed ? 'Expand' : 'Collapse'} ${file.path}`,
      'data-focus-key': `filetoggle:${file.path}`,
      onclick: () => {
        if (collapsed) ui.collapsedFiles.delete(file.path);
        else ui.collapsedFiles.add(file.path);
        env.comments.rerender();
      },
    },
    icon('chevron-down', { size: 16 }),
  );
  const pathText = file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const header = h(
    'div',
    { class: 'file-header' },
    toggleBtn,
    h('span', { class: `badge ${file.status}`, title: STATUS_TITLE[file.status], text: STATUS[file.status] }),
    h('span', { class: 'file-path', dir: 'ltr', text: pathText }),
    add || del
      ? h('span', { class: 'stats', 'aria-label': `${add} added, ${del} removed` }, h('span', { class: 'plus', text: `+${add}` }), h('span', { class: 'minus', text: `−${del}` }))
      : null,
    fileComments(file, env),
  );
  const section = h('section', { class: `file${collapsed ? ' collapsed' : ''}`, 'data-path': file.path }, header);
  if (collapsed) return section;

  const body = h('div', { class: 'file-body' });
  if (file.hidden) body.append(note('Hidden file changed'));
  else if (file.binary) body.append(note('Binary file changed'));
  else if (file.large) body.append(note('Large file added'));
  else if (!file.hunks.length) body.append(note(file.status === 'renamed' ? 'Renamed without changes' : 'No content changes'));
  else if (lines > LARGE_DIFF_LINES && !ui.expandedFiles.has(file.path)) {
    body.append(
      h('button', {
        class: 'btn show-diff', type: 'button', text: `Show diff (${lines} lines)`,
        onclick: () => {
          ui.expandedFiles.add(file.path);
          env.comments.rerender();
        },
      }),
    );
  } else {
    const table = env.mode === 'split' ? splitTable(file, env) : unifiedTable(file, env);
    table.style.setProperty('--maxch', String(Math.min(maxLineLength(file), 400)));
    table.addEventListener('click', (e) => {
      const td = /** @type {HTMLElement} */ (e.target).closest('td.num[data-line]');
      if (!(td instanceof HTMLElement) || !table.contains(td)) return;
      const side = td.dataset.side === 'old' ? 'old' : 'new';
      const line = Number(td.dataset.line);
      const key = lineKey(file.path, side, line);
      if (!ui.composers.has(key)) ui.composers.set(key, { path: file.path, side, line });
      ui.pendingFocus = key;
      env.comments.rerender();
    });
    body.append(table);
  }
  section.append(body);
  return section;
}
