// Projects tab: list, add (path -> preview -> confirm), edit, remove, members and invite links.
import { del, get, patch, post } from '../api.js';
import { h, messageBox, setChildren } from '../dom.js';
import { createDraftState, dropDrafts, errorMessage, getDraft, inviteStatus, normalizeEmail, parsePatterns, patternsText, rememberFocus, setDraft, takeFocus } from './helpers.js';
import { busy, confirmDialog, copyField, field } from './widgets.js';

/**
 * @typedef {{email:string, name:string|null, invitedAt:number}} Member
 * @typedef {{id:number, slug:string, name:string, path:string, extraHidden:string[], open:number, members:Member[]}} Project
 * @typedef {{inviteLink:string, emailSent:boolean, emailError?:string}} Invite
 */

/**
 * Keep a control's text in the draft state so a live refresh that rebuilds the card restores it.
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
 * The add-project form: path + name (+ slug) -> Preview -> Add project.
 * @param {{onAdded:()=>void}} o
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
    { class: 'card add-project', novalidate: '' },
    h('h2', { text: 'Add a project' }),
    path.row,
    h('div', { class: 'row2' }, name.row, slug.row),
    error,
    h('div', { class: 'composer-actions' }, previewBtn),
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
              await post('/api/admin/projects', { path: folder, name: val(name).trim(), ...(val(slug).trim() ? { slug: val(slug).trim() } : {}) });
              for (const x of [path, name, slug]) /** @type {HTMLInputElement} */ (x.control).value = '';
              clearPreview();
              onAdded();
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
          h('div', { class: 'composer-actions' }, add),
        );
      } catch (err) {
        error.textContent = errorMessage(/** @type {any} */ (err));
      }
    });
  });
  return form;
}

/**
 * Edit panel of one project: name, address name, extra hidden patterns.
 * @param {Project} p
 * @param {{drafts:import('./helpers.js').DraftState, onSaved:()=>void, onCancel:()=>void}} o
 */
function editForm(p, { drafts, onSaved, onCancel }) {
  const name = field(`ed-name-${p.id}`, 'Project name', h('input', { type: 'text', value: p.name, dir: 'auto' }));
  const slug = field(`ed-slug-${p.id}`, 'Address name', h('input', { type: 'text', value: p.slug, dir: 'ltr', autocapitalize: 'off', spellcheck: 'false' }), {
    hint: 'Changing it breaks links you already shared.',
  });
  const hidden = field(`ed-hidden-${p.id}`, 'Extra hidden files', h('textarea', { rows: 4, dir: 'ltr', spellcheck: 'false', placeholder: '*.log\nnotes.md' }), {
    hint: 'One file name or pattern per line, matched against the file name. Secret-looking files are always hidden.',
  });
  bindDraft(drafts, name.control, `edit:${p.id}:name`, p.name);
  bindDraft(drafts, slug.control, `edit:${p.id}:slug`, p.slug);
  bindDraft(drafts, hidden.control, `edit:${p.id}:hidden`, patternsText(p.extraHidden));
  const error = h('p', { class: 'form-error', role: 'alert' });
  const save = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn primary', type: 'submit', text: 'Save' }));
  const form = h(
    'form',
    { class: 'edit-panel', novalidate: '' },
    name.row, slug.row, hidden.row, error,
    h('div', { class: 'composer-actions' }, save, h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: onCancel })),
  );
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
        onSaved();
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
  const root = h('div', { class: 'container' });
  const listHost = h('div', { class: 'project-admin-list' });
  /** Invite results by `${projectId}:${email}`, kept across re-renders of the list. @type {Map<string, Invite>} */
  const invites = new Map();
  /** @type {Set<number>} */
  const editing = new Set();
  const drafts = createDraftState();
  /** @type {Project[]} */
  let projects = [];
  let alive = true;

  async function load() {
    try {
      projects = await get('/api/admin/projects');
    } catch (err) {
      if (alive) setChildren(listHost, messageBox('Could not load projects', 'Please reload the page.'));
      return;
    }
    if (alive) draw();
  }
  const reload = () => load().then(onChanged);

  /** @param {Project} p */
  function memberRow(p) {
    return (/** @param {Member} m */ (m) => {
      const key = `${p.id}:${normalizeEmail(m.email)}`;
      const invite = invites.get(key);
      const error = h('p', { class: 'form-error', role: 'alert' });
      const regen = /** @type {HTMLButtonElement} */ (h('button', { class: 'link', type: 'button', text: 'New invite link' }));
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
        h('div', { class: 'member-line' }, h('span', { class: 'member-email', dir: 'auto', text: m.email }), m.name ? h('span', { class: 'muted', dir: 'auto', text: m.name }) : null, h('span', { class: 'spacer' }), regen, remove),
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

  /** @param {Project} p */
  function card(p) {
    const removeError = h('p', { class: 'form-error', role: 'alert' });
    const removeBtn = h('button', {
      class: 'link danger', type: 'button', text: 'Remove',
      onclick: async () => {
        const ok = await confirmDialog({
          title: `Remove ${p.name}?`,
          message: 'Reviewers lose access and all comments on this project are deleted. Your files are not touched.',
          confirmLabel: 'Remove project', requireText: p.slug,
        });
        if (!ok) return;
        try {
          await del(`/api/admin/projects/${p.id}?confirm=${encodeURIComponent(p.slug)}`);
          await reload();
        } catch (err) {
          removeError.textContent = errorMessage(/** @type {any} */ (err));
        }
      },
    });
    const isEditing = editing.has(p.id);
    return h(
      'article',
      { class: 'card project-admin' },
      h(
        'div',
        { class: 'project-head' },
        h('h2', { dir: 'auto', text: p.name }),
        h('span', { class: 'chip', dir: 'ltr', text: p.slug }),
        p.open ? h('span', { class: 'chip open-chip', text: p.open === 1 ? '1 open comment' : `${p.open} open comments` }) : h('span', { class: 'muted', text: 'No open comments' }),
        h('span', { class: 'spacer' }),
        h('a', { href: `/${encodeURIComponent(p.slug)}/live`, text: 'Open' }),
        h('button', {
          class: 'link', type: 'button', text: 'Edit',
          onclick: () => {
            if (editing.has(p.id)) {
              editing.delete(p.id);
              dropDrafts(drafts, `edit:${p.id}`);
            } else editing.add(p.id);
            draw();
          },
        }),
        removeBtn,
      ),
      removeError,
      h('p', { class: 'path', dir: 'ltr', text: p.path }),
      isEditing
        ? editForm(p, {
            drafts,
            onSaved: () => {
              editing.delete(p.id);
              dropDrafts(drafts, `edit:${p.id}`);
              reload();
            },
            onCancel: () => {
              editing.delete(p.id);
              dropDrafts(drafts, `edit:${p.id}`);
              draw();
            },
          })
        : p.extraHidden.length
          ? h('p', { class: 'muted', dir: 'ltr', text: `Also hidden: ${p.extraHidden.join(', ')}` })
          : null,
      h('h3', { text: `Reviewers (${p.members.length})` }),
      p.members.length ? h('ul', { class: 'members' }, p.members.map(memberRow(p))) : h('p', { class: 'muted', text: 'Nobody has access yet.' }),
      addMemberForm(p),
    );
  }

  /** Rebuild the list. Typed text comes back from `drafts`; the focused field and its caret are restored. */
  function draw() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.dataset.draft && listHost.contains(active)) {
      const field = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (active);
      let start = null;
      let end = null;
      try {
        start = field.selectionStart;
        end = field.selectionEnd;
      } catch {
        /* type=email inputs have no selection API */
      }
      rememberFocus(drafts, { key: active.dataset.draft, start, end });
    }
    setChildren(listHost, projects.length ? projects.map(card) : messageBox('No projects yet', 'Add the top folder of a git repository above.'));
    const focus = takeFocus(drafts);
    if (!focus) return;
    const el = [...listHost.querySelectorAll('[data-draft]')].find((e) => e instanceof HTMLElement && e.dataset.draft === focus.key);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    el.focus();
    try {
      if (focus.start !== null && focus.end !== null) el.setSelectionRange(focus.start, focus.end);
    } catch {
      /* no selection API on this input type */
    }
  }

  setChildren(root, addProjectForm({ onAdded: reload }), listHost);
  setChildren(listHost, h('p', { class: 'muted pad', text: 'Loading…' }));
  load();

  return {
    root,
    refresh: load,
    destroy() {
      alive = false;
    },
  };
}
