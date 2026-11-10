// Setup / Settings screen: one form, plus the "connect your domain" steps.
import { api } from '../api.js';
import { h, setChildren } from '../dom.js';
import { parseBody } from '../format.js';
import { configError, missingFields, setupSteps } from './helpers.js';
import { busy, confirmDialog, field } from './widgets.js';

/** `inline code` in a step becomes <code>; everything else is text. @param {string} text */
function inline(text) {
  return parseBody(text).map((n) => (n.kind === 'code' ? h('code', { text: n.text }) : n.text));
}

/**
 * @param {import('./helpers.js').SetupStep[]} steps
 * @returns {HTMLElement}
 */
function renderSteps(steps) {
  return h(
    'ol',
    { class: 'steps' },
    steps.map((s) =>
      h(
        'li',
        null,
        h('p', null, inline(s.text)),
        s.code?.map((c) =>
          h('div', { class: 'cmd' }, c.label ? h('span', { class: 'cmd-label muted', text: c.label }) : null, h('pre', { class: 'codeblock', dir: 'ltr' }, h('code', { text: c.text }))),
        ),
      ),
    ),
  );
}

/**
 * @typedef {{publicHost:string, ownerName:string, ownerEmail:string, fromEmail:string, tunnelName:string,
 *   publicPort:number, adminPort:number, hasResendKey:boolean, configured:boolean}} AdminConfig
 */

/**
 * @param {{config:AdminConfig, setup:boolean, onSaved:(config:AdminConfig)=>void}} o
 * @returns {HTMLElement}
 */
export function settingsView({ config, setup, onSaved }) {
  const text = (/** @type {string} */ name, /** @type {Record<string,any>} */ props = {}) =>
    h('input', { type: 'text', name, autocomplete: 'off', value: String(/** @type {any} */ (config)[name] ?? ''), ...props });

  const f = {
    publicHost: field('f-host', 'Public hostname', text('publicHost', { placeholder: 'review.example.com', autocapitalize: 'off', spellcheck: 'false' }), {
      hint: 'The address reviewers will open, served through your Cloudflare tunnel.',
    }),
    ownerName: field('f-name', 'Your name', text('ownerName', { placeholder: 'Your name', autocomplete: 'name' })),
    ownerEmail: field('f-email', 'Your email', text('ownerEmail', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' })),
    fromEmail: field('f-from', 'Sender address', text('fromEmail', { placeholder: 'review@example.com', spellcheck: 'false' }), {
      hint: 'Optional. Sign-in codes and invites are sent from this address. It must be on a domain you verified in Resend.',
    }),
    resendApiKey: field(
      'f-key', 'Resend API key',
      h('input', { type: 'password', name: 'resendApiKey', autocomplete: 'off', placeholder: config.hasResendKey ? 'Saved — leave blank to keep' : 're_…' }),
      { hint: 'Optional. Without email you can still copy each invite link and send it yourself.' },
    ),
    tunnelName: field('f-tunnel', 'Cloudflare tunnel name', text('tunnelName', { placeholder: 'livereview', spellcheck: 'false' }), {
      hint: 'Leave blank if you run the tunnel yourself.',
    }),
    publicPort: field('f-pport', 'Public port', text('publicPort', { type: 'number', min: 1024, max: 65535 })),
    adminPort: field('f-aport', 'Admin port', text('adminPort', { type: 'number', min: 1024, max: 65535 })),
  };
  /** @type {Record<string, ReturnType<typeof field>>} */
  const fields = f;
  const input = (/** @type {keyof typeof f} */ k) => /** @type {HTMLInputElement} */ (f[k].control);

  const formError = h('p', { class: 'form-error', role: 'alert' });
  const notice = h('p', { class: 'notice', role: 'status', hidden: '' });
  const saved = h('span', { class: 'muted', role: 'status' });
  const save = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn primary', type: 'submit', text: setup ? 'Save and continue' : 'Save' }));

  const stepsHost = h('div');
  const redrawSteps = () =>
    setChildren(stepsHost, renderSteps(setupSteps({ publicHost: input('publicHost').value, publicPort: Number(input('publicPort').value) || config.publicPort })));
  redrawSteps();
  input('publicHost').addEventListener('input', redrawSteps);
  input('publicPort').addEventListener('input', redrawSteps);

  /** Take the server's view of the config; the key itself is never sent back. @param {AdminConfig} next */
  const adopt = (next) => {
    Object.assign(config, next);
    input('resendApiKey').placeholder = config.hasResendKey ? 'Saved — leave blank to keep' : 're_…';
    removeKey.hidden = !config.hasResendKey;
    onSaved(config);
  };

  const removeKey = /** @type {HTMLButtonElement} */ (h('button', { class: 'link danger', type: 'button', text: 'Remove key' }));
  removeKey.hidden = !config.hasResendKey;
  removeKey.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Remove the Resend API key?', message: 'LiveReview cannot email sign-in codes until you save a new key.', confirmLabel: 'Remove key',
    });
    if (!ok) return;
    await busy(removeKey, 'Removing…', async () => {
      try {
        const r = await api('PUT', '/api/admin/config', { resendApiKey: null });
        notice.textContent = 'Email is off until you add a key';
        notice.hidden = false;
        saved.textContent = '';
        adopt(r.config);
      } catch (err) {
        formError.textContent = configError(/** @type {any} */ (err)).message;
      }
    });
  });

  const form = h(
    'form',
    { class: 'card settings-form', novalidate: '' },
    h('h2', { text: setup ? 'Set up LiveReview' : 'Settings' }),
    setup ? h('p', { class: 'muted', text: 'Add your domain and email details, then connect your Cloudflare tunnel with the steps below.' }) : null,
    f.publicHost.row,
    h('div', { class: 'row2' }, f.ownerName.row, f.ownerEmail.row),
    f.fromEmail.row,
    f.resendApiKey.row,
    h('div', { class: 'field-extra' }, removeKey),
    f.tunnelName.row,
    h('details', { class: 'advanced' }, h('summary', { text: 'Advanced' }), h('div', { class: 'row2' }, f.publicPort.row, f.adminPort.row)),
    formError,
    notice,
    h('div', { class: 'composer-actions' }, save, saved),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const x of Object.values(fields)) x.setError('');
    formError.textContent = '';
    notice.hidden = true;
    saved.textContent = '';
    const values = {
      publicHost: input('publicHost').value, ownerName: input('ownerName').value, ownerEmail: input('ownerEmail').value,
      fromEmail: input('fromEmail').value, resendApiKey: input('resendApiKey').value, tunnelName: input('tunnelName').value.trim(),
    };
    const missing = missingFields(values, config);
    for (const [k, msg] of Object.entries(missing)) fields[k].setError(msg);
    if (Object.keys(missing).length) {
      /** @type {HTMLElement|undefined} */ (Object.values(fields).find((x) => x.control.hasAttribute('aria-invalid'))?.control)?.focus();
      return;
    }
    /** @type {Record<string, unknown>} */
    const body = {
      publicHost: values.publicHost, ownerName: values.ownerName, ownerEmail: values.ownerEmail, fromEmail: values.fromEmail, tunnelName: values.tunnelName,
    };
    if (values.resendApiKey.trim()) body.resendApiKey = values.resendApiKey;
    const pp = Number(input('publicPort').value);
    const ap = Number(input('adminPort').value);
    if (pp !== config.publicPort) body.publicPort = pp;
    if (ap !== config.adminPort) body.adminPort = ap;
    await busy(save, 'Saving…', async () => {
      try {
        const r = await api('PUT', '/api/admin/config', body);
        if (r.restartRequired) {
          notice.textContent = 'Restart LiveReview to apply the new ports';
          notice.hidden = false;
        }
        input('resendApiKey').value = '';
        saved.textContent = 'Saved';
        adopt(r.config);
      } catch (err) {
        const { field: name, message } = configError(/** @type {any} */ (err));
        if (name && fields[name]) fields[name].setError(message);
        else formError.textContent = message;
      }
    });
  });

  const help = h(
    'details',
    { class: 'section', open: setup ? '' : null },
    h('summary', { text: 'How to connect your domain' }),
    h('div', { class: 'section-body' }, stepsHost),
  );
  return h('div', { class: 'container' }, form, help);
}
