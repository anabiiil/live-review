// Projects tab: a list of projects beside the selected one (reviewers and invite links, hidden files,
// name and address, removal), and the add-project flow (path -> preview -> confirm).
import { del, get, patch, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { icon } from '../icons.js';
import { initials } from '../shell-model.js';
import { createDraftState, dropDrafts, errorMessage, getDraft, inviteStatus, normalizeEmail, parsePatterns, patternsText, rememberFocus, setDraft, takeFocus } from './helpers.js';
import { busy, confirmDialog, copyField, field } from './widgets.js';

/**
 * @typedef {{email:string, name:string|null, invitedAt:number}} Member
 * @typedef {{id:number, slug:string, name:string, path:string, extraHidden:string[], open:number, members:Member[]}} Project
 * @typedef {{inviteLink:string, emailSent:boolean, emailError?:string}} Invite
 */

/** The project that was open when the tab was last left (the tab is rebuilt on every visit). @type {number|'new'|null} */
let remembered = null;

/**
 * Keep a control's text in the draft state so a live refresh that rebuilds the panel restores it.
 * @param {import('./helpers.js').DraftState} drafts
 * @param {HTMLElement} control
 * @param {string} key
 * @param {string} [initial]
 */
function bindDraft(drafts, control, key, initial = '') {
  const el = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (control);
  el.dataset.draft = key;
  el.value = getDraft(drafts, key, initial);
  el.addEventListener('input', () => setDraft(drafts, key, el.value));
}

/**
 * A scrollable file list with a heading.
 * @param {string} title
 * @param {string[]} files
 * @param {string} emptyText
 */
function fileList(title, files, emptyText) {
  return h(
    'section',
    { class: 'file-preview' },
    h('h3', { text: `${title} (${files.length} ${files.length === 1 ? 'file' : 'files'})` }),
    files.length
      ? h('ul', { class: 'files', tabindex: '0', 'aria-label': title }, files.map((f) => h('li', { dir: 'ltr', text: f })))
      : h('p', { class: 'muted', text: emptyText }),
  );
}

/**
 * The add-project form: path + name (+ slug) -> Preview -> Add project. Built once and re-mounted, so what
 * was typed (and the preview) survives redraws of the page.
 * @param {{onAdded:(project:Project)=>void}} o
 */
function addProjectForm({ onAdded }) {
  const path = field('ap-path', 'Folder path', h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '/Users/you/code/my-app', dir: 'ltr' }), {
    hint: 'The top folder of a git repository on this computer.',
  });
  const name = field('ap-name', 'Project name', h('input', { type: 'text', autocomplete: 'off', placeholder: 'My app', dir: 'auto' }));
  const slug = field('ap-slug', 'Address name (optional)', h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'my-app', dir: 'ltr' }), {
    hint: 'Used in the link: /my-app. Leave blank to derive it from the name.',
  });
  const val = (/** @type {{control:HTMLElement}} */ x) => /** @type {HTMLInputElement} */ (x.control).value;
  const error = h('p', { class: 'form-error', role: 'alert' });
  const previewHost = h('div', { class: 'preview', 'aria-live': 'polite' });
  const previewBtn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn', type: 'submit', text: 'Preview' }));
  const clearPreview = () => setChildren(previewHost);
  path.control.addEventListener('input', clearPreview);

  const form = h(
    'form',
    { class: 'add-project', novalidate: '' },
    path.row,
    h('div', { class: 'row2' }, name.row, slug.row),
    error,
    h('div', { class: 'actions' }, previewBtn),
    previewHost,
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    path.setError('');
    name.setError('');
    clearPreview();
    const folder = val(path).trim();
    if (!folder) return path.setError('Required');
    if (!val(name).trim()) return name.setError('Required');
    await busy(previewBtn, 'Checking…', async () => {
      try {
        const r = await post('/api/admin/projects/preview', { path: folder });
        const add = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn primary', type: 'button', text: 'Add project' }));
        const addError = h('p', { class: 'form-error', role: 'alert' });
        add.addEventListener('click', () =>
          busy(add, 'Adding…', async () => {
            addError.textContent = '';
            try {
              const created = await post('/api/admin/projects', { path: folder, name: val(name).trim(), ...(val(slug).trim() ? { slug: val(slug).trim() } : {}) });
              for (const x of [path, name, slug]) /** @type {HTMLInputElement} */ (x.control).value = '';
              clearPreview();
              onAdded(created);
            } catch (err) {
              addError.textContent = errorMessage(/** @type {any} */ (err));
            }
          }),
        );
        setChildren(
          previewHost,
          h('p', null, 'Reviewers will see this repository at ', h('code', { dir: 'ltr', text: r.root }), '.'),
          h('div', { class: 'preview-lists' }, fileList('Visible to reviewers', r.visible, 'No files yet.'), fileList('Hidden', r.hidden, 'Nothing is hidden.')),
          addError,
          h('div', { class: 'actions' }, add),
        );
      } catch (err) {
        error.textContent = errorMessage(/** @type {any} */ (err));
      }
    });
  });
  return form;
}

/** @param {Invite} invite */
function invitePanel(invite) {
  const status = inviteStatus(invite);
  return h(
    'div',
    { class: 'invite-panel' },
    h('p', { class: 'muted', text: 'Invite link (single use, valid for 7 days)' }),
    copyField(invite.inviteLink),
    h('p', { class: status.ok ? 'invite-ok' : 'invite-warn', role: 'status', text: status.text }),
  );
}

/**
 * @param {{onChanged:()=>void}} o  onChanged: something changed that other tabs may show (open counts etc.)
 */
export function projectsView({ onChanged }) {
  const root = h('div', { class: 'container admin-wide' });
  const listHost = h('div', { class: 'pv-list' });
  const detailHost = h('section', { class: 'pv-detail', 'aria-label': 'Project' });
  const layout = h('div', { class: 'pv' }, listHost, detailHost);
  /** Invite results by `${projectId}:${email}`, kept across re-renders. @type {Map<string, Invite>} */
  const invites = new Map();
  /** Projects whose settings were just saved (shows "Saved" until the next change). @type {Set<number>} */
  const justSaved = new Set();
  const drafts = createDraftState();
  /** @type {Project[]} */
  let projects = [];
  /** @type {string|null} */
  let lastJson = null;
  /** The explicit choice: a project id, 'new', or none (the first project shows beside the list on wide screens). @type {number|'new'|null} */
  let selected = remembered;
  let alive = true;
  const addForm = addProjectForm({
    onAdded: (created) => {
      selected = created.id;
      remembered = created.id;
      reload();
    },
  });

  /** @param {number|'new'|null} what */
  function select(what) {
    selected = what;
    remembered = what;
    draw();
    // On a narrow screen the list is replaced by the detail: start at its top.
    if (what !== null && getComputedStyle(listHost).display === 'none') window.scrollTo(0, 0);
  }

  async function load() {
    try {
      const next = await get('/api/admin/projects');
      const json = JSON.stringify(next);
      projects = next;
      // Nothing changed: leave the page (typed text, focus, scroll) alone.
      if (json === lastJson) return;
      lastJson = json;
    } catch {
      if (alive) setChildren(listHost, h('p', { class: 'pv-empty', text: 'Could not load projects. Please reload the page.' }));
      return;
    }
    if (alive) draw();
  }
  const reload = () => {
    lastJson = null;
    return load().then(onChanged);
  };

  /** The project to show in the detail panel, or 'new'. @returns {Project|'new'|null} */
  function shown() {
    if (!projects.length || selected === 'new') return 'new';
    return projects.find((p) => p.id === selected) ?? projects[0];
  }

  // ---- list ----
  function drawList() {
    const current = shown();
    const rows = projects.map((p) =>
      h(
        'li',
        null,
        h(
          'button',
          { class: 'row project-row', type: 'button', 'aria-current': current !== 'new' && current?.id === p.id ? 'true' : null, onclick: () => select(p.id) },
          h('span', { class: 'row-main' }, h('span', { class: 'row-title', dir: 'auto', text: p.name }), h('span', { class: 'row-sub', dir: 'ltr', text: `/${p.slug}` })),
          h(
            'span',
            { class: 'row-aside' },
            p.open ? h('span', { class: 'chip open-chip', text: `${p.open} open` }) : null,
            h('span', { class: 'muted', text: p.members.length === 1 ? '1 reviewer' : `${p.members.length} reviewers` }),
          ),
        ),
      ),
    );
    setChildren(
      listHost,
      h('div', { class: 'pv-list-head' }, h('h1', { text: 'Projects' }), h('button', { class: 'btn primary', type: 'button', text: 'Add project', onclick: () => select('new') })),
      rows.length ? h('ul', { class: 'rows' }, rows) : h('p', { class: 'pv-empty', text: 'No projects yet. Add the top folder of a git repository.' }),
    );
  }

  // ---- reviewers ----
  /** @param {Project} p */
  function memberRow(p) {
    return (/** @param {Member} m */ (m) => {
      const key = `${p.id}:${normalizeEmail(m.email)}`;
      const invite = invites.get(key);
      const error = h('p', { class: 'form-error', role: 'alert' });
      const regen = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn small', type: 'button', text: 'New invite link' }));
      regen.addEventListener('click', () =>
        busy(regen, 'Working…', async () => {
          error.textContent = '';
          try {
            invites.set(key, await post(`/api/admin/projects/${p.id}/members/${encodeURIComponent(m.email)}/invite`));
            draw();
          } catch (err) {
            error.textContent = errorMessage(/** @type {any} */ (err));
          }
        }),
      );
      const remove = /** @type {HTMLButtonElement} */ (h('button', { class: 'link danger', type: 'button', text: 'Remove' }));
      remove.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `Remove ${m.email}?`, message: `They lose access to ${p.name} right away and their invite link stops working.`, confirmLabel: 'Remove',
        });
        if (!ok) return;
        await busy(remove, 'Removing…', async () => {
          try {
            await del(`/api/admin/projects/${p.id}/members/${encodeURIComponent(m.email)}`);
            invites.delete(key);
            await reload();
          } catch (err) {
            error.textContent = errorMessage(/** @type {any} */ (err));
          }
        });
      });
      return h(
        'li',
        { class: 'member' },
        h(
          'div',
          { class: 'member-line' },
          h('span', { class: 'avatar small', 'aria-hidden': 'true', dir: 'auto', text: initials(m.name, m.email) }),
          h('span', { class: 'member-who' }, h('span', { class: 'member-email', dir: 'auto', text: m.email }), m.name ? h('span', { class: 'member-name', dir: 'auto', text: m.name }) : null),
          h('span', { class: 'member-actions' }, regen, remove),
        ),
        invite ? invitePanel(invite) : null,
        error,
      );
    });
  }

  /** @param {Project} p */
  function addMemberForm(p) {
    const email = h('input', { type: 'email', autocomplete: 'off', placeholder: 'reviewer@example.com', 'aria-label': `Add a reviewer to ${p.name}`, dir: 'ltr' });
    bindDraft(drafts, email, `member:${p.id}`);
    const error = h('p', { class: 'form-error', role: 'alert' });
    const add = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn', type: 'submit', text: 'Add and get link' }));
    const form = h('form', { class: 'add-member', novalidate: '' }, h('div', { class: 'inline-form' }, email, add), error);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const value = /** @type {HTMLInputElement} */ (email).value.trim();
      if (!value) return;
      await busy(add, 'Adding…', async () => {
        try {
          const r = await post(`/api/admin/projects/${p.id}/members`, { email: value });
          invites.set(`${p.id}:${normalizeEmail(value)}`, r);
          dropDrafts(drafts, `member:${p.id}`);
          await reload();
        } catch (err) {
          error.textContent = errorMessage(/** @type {any} */ (err));
        }
      });
    });
    return form;
  }

  // ---- name, address and hidden files ----
  /** @param {Project} p */
  function settingsForm(p) {
    const name = field(`ed-name-${p.id}`, 'Project name', h('input', { type: 'text', dir: 'auto' }));
    const slug = field(`ed-slug-${p.id}`, 'Address name', h('input', { type: 'text', dir: 'ltr', autocapitalize: 'off', spellcheck: 'false' }), {
      hint: 'Changing it breaks links you already shared.',
    });
    const hidden = field(`ed-hidden-${p.id}`, 'Hidden files', h('textarea', { rows: 4, dir: 'ltr', spellcheck: 'false', placeholder: '*.log\nnotes.md' }), {
      hint: 'One file name or pattern per line, matched against the file name. Secret-looking files are always hidden.',
    });
    bindDraft(drafts, name.control, `edit:${p.id}:name`, p.name);
    bindDraft(drafts, slug.control, `edit:${p.id}:slug`, p.slug);
    bindDraft(drafts, hidden.control, `edit:${p.id}:hidden`, patternsText(p.extraHidden));
    const error = h('p', { class: 'form-error', role: 'alert' });
    const savedNote = h('span', { class: 'pv-saved', role: 'status', text: justSaved.has(p.id) ? 'Saved' : '' });
    const save = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn primary', type: 'submit', text: 'Save changes' }));
    const form = h('form', { novalidate: '' }, name.row, slug.row, hidden.row, error, h('div', { class: 'actions pv-actions' }, save, savedNote));
    form.addEventListener('input', () => {
      justSaved.delete(p.id);
      savedNote.textContent = '';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const body = {
        name: /** @type {HTMLInputElement} */ (name.control).value.trim(),
        slug: /** @type {HTMLInputElement} */ (slug.control).value.trim(),
        extraHidden: parsePatterns(/** @type {HTMLTextAreaElement} */ (hidden.control).value),
      };
      await busy(save, 'Saving…', async () => {
        try {
          await patch(`/api/admin/projects/${p.id}`, body);
          dropDrafts(drafts, `edit:${p.id}`);
          justSaved.add(p.id);
          await reload();
        } catch (err) {
          error.textContent = errorMessage(/** @type {any} */ (err));
        }
      });
    });
    return form;
  }

  /** @param {Project} p */
  function removeSection(p) {
    const error = h('p', { class: 'form-error', role: 'alert' });
    const btn = h('button', {
      class: 'btn danger-quiet', type: 'button', text: 'Remove project',
      onclick: async () => {
        const ok = await confirmDialog({
          title: `Remove ${p.name}?`,
          message: 'Reviewers lose access and all comments on this project are deleted. Your files are not touched.',
          confirmLabel: 'Remove project', requireText: p.slug,
        });
        if (!ok) return;
        try {
          await del(`/api/admin/projects/${p.id}?confirm=${encodeURIComponent(p.slug)}`);
          selected = null;
          remembered = null;
          await reload();
        } catch (err) {
          error.textContent = errorMessage(/** @type {any} */ (err));
        }
      },
    });
    return h('section', { class: 'pv-section' }, h('div', { class: 'pv-danger' }, h('p', { text: 'Reviewers lose access and the comments on this project are deleted. Your files are not touched.' }), btn), error);
  }

  // ---- detail ----
  const back = () => h('button', { class: 'link pv-back', type: 'button', onclick: () => select(null) }, icon('chevron-down'), 'All projects');

  /** @param {Project} p */
  function projectDetail(p) {
    return [
      h(
        'header',
        { class: 'pv-head' },
        h(
          'div',
          { class: 'pv-head-main' },
          h('h2', { class: 'pv-title', dir: 'auto', text: p.name }),
          h(
            'div',
            { class: 'pv-meta' },
            h('span', { class: 'chip', dir: 'ltr', text: `/${p.slug}` }),
            p.open ? h('span', { class: 'chip open-chip', text: p.open === 1 ? '1 open comment' : `${p.open} open comments` }) : h('span', { class: 'muted', text: 'No open comments' }),
          ),
          h('p', { class: 'path', dir: 'ltr', text: p.path }),
        ),
        h('a', { class: 'btn', href: `/${encodeURIComponent(p.slug)}/live` }, 'Open project', icon('arrow-up-right')),
      ),
      h(
        'section',
        { class: 'pv-section' },
        h('h3', { text: p.members.length ? `Reviewers (${p.members.length})` : 'Reviewers' }),
        p.members.length ? null : h('p', { class: 'section-sub', text: 'Nobody has access yet. Add an email address to get an invite link.' }),
        h('ul', { class: 'members' }, p.members.map(memberRow(p))),
        addMemberForm(p),
      ),
      h('section', { class: 'pv-section' }, h('h3', { text: 'Project settings' }), settingsForm(p)),
      removeSection(p),
    ];
  }

  /** Rebuild the page. Typed text comes back from `drafts`; the focused field and its caret are restored. */
  function draw() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.dataset.draft && layout.contains(active)) {
      const control = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (active);
      let start = null;
      let end = null;
      try {
        start = control.selectionStart;
        end = control.selectionEnd;
      } catch {
        /* type=email inputs have no selection API */
      }
      rememberFocus(drafts, { key: active.dataset.draft, start, end });
    }
    const current = shown();
    layout.classList.toggle('has-detail', selected !== null && (selected === 'new' || projects.some((p) => p.id === selected)));
    drawList();
    setChildren(
      detailHost,
      back(),
      current === 'new'
        ? h('div', { class: 'pv-new' }, h('h2', { text: 'Add a project' }), h('p', { class: 'section-sub', text: 'Pick a git repository on this computer. You see what reviewers will and will not see before it is added.' }), addForm)
        : projectDetail(/** @type {Project} */ (current)),
    );
    const focus = takeFocus(drafts);
    if (!focus) return;
    const el = [...layout.querySelectorAll('[data-draft]')].find((e) => e instanceof HTMLElement && e.dataset.draft === focus.key);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    el.focus();
    try {
      if (focus.start !== null && focus.end !== null) el.setSelectionRange(focus.start, focus.end);
    } catch {
      /* no selection API on this input type */
    }
  }

  setChildren(root, layout);
  setChildren(listHost, h('p', { class: 'pv-empty', text: 'Loading…' }));
  load();

  return {
    root,
    refresh: load,
    destroy() {
      alive = false;
    },
  };
}
