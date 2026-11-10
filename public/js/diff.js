// Diff renderer: our own unified and side-by-side tables from FileDiff.hunks, with comment slots.
import { h } from './dom.js';
import { renderComposer, renderThread } from './comments.js';
import { LARGE_DIFF_LINES, diffLineCount, diffStats, lineKey, maxLineLength, pairLines, rowPositions } from './pairing.js';

/** @typedef {import('../../src/types.js').FileDiff} FileDiff */
/** @typedef {import('../../src/types.js').DiffLine} DiffLine */
/** @typedef {import('./comments.js').CommentEnv} CommentEnv */

/**
 * @typedef {object} DiffEnv
 * @property {CommentEnv} comments
 * @property {'split'|'unified'} mode layout actually used (phones are always unified)
 * @property {Map<string, any[]>} byKey top-level threads by `${path}:${side}:${line}`
 * @property {Set<number>} placed thread ids rendered in a row (filled while rendering)
 * @property {Map<string, number>} openByPath unresolved thread counts
 */

const STATUS = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const STATUS_TITLE = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' };

/** @param {string} text */
const note = (text) => h('p', { class: 'file-note', text });

/**
 * Threads and composer for the given positions, or null when there is nothing to show.
 * @param {DiffEnv} env
 * @param {string} path
 * @param {{side:'old'|'new', line:number, key:string}[]} positions
 */
function slotContent(env, path, positions) {
  const { ui } = env.comments;
  /** @type {HTMLElement[]} */
  const out = [];
  for (const p of positions) {
    for (const t of env.byKey.get(p.key) ?? []) {
      env.placed.add(t.id);
      out.push(renderThread(t, env.comments));
    }
    const open = ui.composers.get(p.key);
    if (open) {
      out.push(
        renderComposer(env.comments, {
          key: p.key, label: 'Comment', placeholder: `Comment on line ${p.line}`,
          onSubmit: async (text) => {
            await env.comments.createComment(path, p.side, p.line, text);
            ui.composers.delete(p.key);
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
 * @param {FileDiff} file
 * @param {DiffEnv} env
 */
function unifiedTable(file, env) {
  const tbody = h('tbody');
  for (const hunk of file.hunks) {
    tbody.append(h('tr', { class: 'hunk' }, h('td', { colspan: 3, dir: 'ltr', text: hunk.header })));
    for (const l of hunk.lines) {
      tbody.append(
        h(
          'tr',
          { class: `line ${l.type}` },
          numCell('old', l.type === 'add' ? null : l.oldNo, l.type === 'del', l.type),
          numCell('new', l.type === 'del' ? null : l.newNo, l.type !== 'del', l.type),
          codeCell(l),
        ),
      );
      const content = slotContent(env, file.path, rowPositions(file.path, l));
      if (content) tbody.append(h('tr', { class: 'slot' }, h('td', { colspan: 3 }, h('div', { class: 'slot-inner' }, content))));
    }
  }
  return h('table', { class: 'diff unified' }, h('colgroup', null, h('col', { class: 'c-num' }), h('col', { class: 'c-num' }), h('col')), tbody);
}

/**
 * @param {FileDiff} file
 * @param {DiffEnv} env
 */
function splitTable(file, env) {
  const tbody = h('tbody');
  for (const hunk of file.hunks) {
    tbody.append(h('tr', { class: 'hunk' }, h('td', { colspan: 4, dir: 'ltr', text: hunk.header })));
    for (const { left, right } of pairLines(hunk.lines)) {
      tbody.append(
        h(
          'tr',
          { class: 'line' },
          numCell('old', left ? left.oldNo : null, true, left?.type),
          codeCell(left, 'old'),
          numCell('new', right ? right.newNo : null, true, right?.type),
          codeCell(right, 'new'),
        ),
      );
      const lp = left && left.oldNo !== null ? [{ side: /** @type {const} */ ('old'), line: left.oldNo, key: lineKey(file.path, 'old', left.oldNo) }] : [];
      const rp = right && right.newNo !== null ? [{ side: /** @type {const} */ ('new'), line: right.newNo, key: lineKey(file.path, 'new', right.newNo) }] : [];
      const lc = slotContent(env, file.path, lp);
      const rc = slotContent(env, file.path, rp);
      if (lc || rc) {
        tbody.append(
          h(
            'tr',
            { class: 'slot' },
            h('td', { colspan: 4 }, h('div', { class: 'slot-inner slot-split' }, h('div', { class: 'slot-left' }, lc), h('div', { class: 'slot-right' }, rc))),
          ),
        );
      }
    }
  }
  return h(
    'table',
    { class: 'diff split' },
    h('colgroup', null, h('col', { class: 'c-num' }), h('col'), h('col', { class: 'c-num' }), h('col')),
    tbody,
  );
}

/**
 * One file section: header, then its diff (or the reason there is none).
 * @param {FileDiff} file
 * @param {DiffEnv} env
 * @returns {HTMLElement}
 */
export function renderFile(file, env) {
  const ui = env.comments.ui;
  const collapsed = ui.collapsedFiles.has(file.path);
  const lines = diffLineCount(file);
  const { add, del } = diffStats(file);
  const open = env.openByPath.get(file.path) ?? 0;

  const toggle = h(
    'button',
    {
      class: 'file-toggle', type: 'button', 'aria-expanded': String(!collapsed), 'aria-label': `${collapsed ? 'Expand' : 'Collapse'} ${file.path}`,
      onclick: () => {
        if (collapsed) ui.collapsedFiles.delete(file.path);
        else ui.collapsedFiles.add(file.path);
        env.comments.rerender();
      },
    },
    h('span', { class: 'chev', 'aria-hidden': 'true', text: collapsed ? '▸' : '▾' }),
  );
  const pathText = file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const header = h(
    'div',
    { class: 'file-header' },
    toggle,
    h('span', { class: `badge ${file.status}`, title: STATUS_TITLE[file.status], text: STATUS[file.status] }),
    h('span', { class: 'file-path', dir: 'ltr', text: pathText }),
    add || del ? h('span', { class: 'stats' }, h('span', { class: 'plus', text: `+${add}` }), ' ', h('span', { class: 'minus', text: `−${del}` })) : null,
    open ? h('span', { class: 'chip open-chip', title: 'Open comments', text: `${open} open` }) : null,
  );
  const section = h('section', { class: 'file', 'data-path': file.path }, header);
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
