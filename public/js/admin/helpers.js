// Pure helpers for the admin UI. No DOM access: importable from node for tests.

export const DEFAULT_HOST = 'review.example.com';
export const BASE_TITLE = 'LiveReview Admin';

/**
 * @typedef {{text:string, code?:{label?:string, text:string}[]}} SetupStep
 * Step text may contain `inline code` (single backticks); nothing else is interpreted.
 */

/**
 * The "How to connect your domain" steps, with the owner's values filled in when known.
 * @param {{publicHost?:string, publicPort?:number}} [values]
 * @returns {SetupStep[]}
 */
export function setupSteps({ publicHost = '', publicPort = 4317 } = {}) {
  const host = publicHost.trim() || DEFAULT_HOST;
  return [
    {
      text: 'Install cloudflared.',
      code: [
        { label: 'macOS', text: 'brew install cloudflared' },
        { label: 'Windows', text: 'winget install --id Cloudflare.cloudflared' },
      ],
    },
    { text: 'Log in to Cloudflare.', code: [{ text: 'cloudflared tunnel login' }] },
    { text: 'Create the tunnel.', code: [{ text: 'cloudflared tunnel create livereview' }] },
    { text: 'Point your hostname at it.', code: [{ text: `cloudflared tunnel route dns livereview ${host}` }] },
    {
      text: `Put \`livereview\` in "Cloudflare tunnel name" above and restart LiveReview — it starts the tunnel for you, pointed at http://127.0.0.1:${publicPort}.`,
    },
    {
      text: 'In Resend, add and verify your domain (it gives you DNS records to add in Cloudflare), then use an address on that domain as the sender.',
    },
  ];
}

const REPO_REASONS = {
  'not-a-repo': "That folder isn't a git repository",
  'not-root': 'Choose the top folder of the repository',
  forbidden: "That folder can't be shared",
};

const CODE_MESSAGES = {
  'duplicate-path': 'This folder has already been added',
  'slug-taken': 'That address name is already used by another project',
  'invalid-slug': 'The address name may only use lowercase letters, digits and "-", and must not be a reserved word',
  'invalid-name': 'Give the project a name',
  'invalid-email': 'That is not a valid email address',
  'invalid-extra-hidden': 'Hidden patterns must be file names or globs such as *.log, without "/"',
  'not-configured': 'Finish setup first: the invite link needs your public hostname',
  'not-found': 'That no longer exists. Reload the page.',
};

/**
 * Human text for a failed admin API call.
 * @param {{status?:number, data?:any, message?:string}|null|undefined} err an ApiError (or anything shaped like one)
 * @returns {string}
 */
export function errorMessage(err) {
  const data = err?.data;
  if (data?.error === 'invalid-repo') {
    return REPO_REASONS[/** @type {keyof typeof REPO_REASONS} */ (data.reason)] ?? "That folder can't be used";
  }
  const known = CODE_MESSAGES[/** @type {keyof typeof CODE_MESSAGES} */ (data?.error)];
  if (known) return known;
  if (typeof data?.message === 'string' && data.message) return data.message;
  if (err?.status === 401) return 'Not signed in. Open LiveReview from the link printed in your terminal.';
  return 'That did not work. Please try again.';
}

const CONFIG_FIELDS = ['publicHost', 'ownerName', 'ownerEmail', 'fromEmail', 'resendApiKey', 'tunnelName', 'publicPort', 'adminPort'];

/**
 * Attribute a 400 from PUT /api/admin/config to a form field (the server names the field first).
 * @param {{data?:any}|null|undefined} err
 * @returns {{field:string|null, message:string}}
 */
export function configError(err) {
  const message = errorMessage(/** @type {any} */ (err));
  const first = message.split(/[\s:]/, 1)[0];
  return { field: CONFIG_FIELDS.includes(first) ? first : null, message };
}

/**
 * Required fields that are still empty. The API key counts as present when one is already saved.
 * @param {Record<string,string>} values form values by field name
 * @param {{hasResendKey:boolean}} state
 * @returns {Record<string,string>} message by field
 */
export function missingFields(values, { hasResendKey }) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const f of ['publicHost', 'ownerName', 'ownerEmail']) {
    if (!String(values[f] ?? '').trim()) out[f] = 'Required';
  }
  // Email is optional, but the key and the sender only work together.
  const hasKey = hasResendKey || String(values.resendApiKey ?? '').trim() !== '';
  const hasFrom = String(values.fromEmail ?? '').trim() !== '';
  if (hasKey && !hasFrom) out.fromEmail = 'Required when a Resend key is set';
  if (hasFrom && !hasKey) out.resendApiKey = 'Required when a sender address is set';
  return out;
}

/**
 * Status line for a freshly issued invite.
 * @param {{emailSent?:boolean, emailError?:string}} result
 * @returns {{ok:boolean, text:string}}
 */
export function inviteStatus(result) {
  if (result?.emailSent) return { ok: true, text: 'Invite email sent' };
  return { ok: false, text: `Email not sent: ${result?.emailError ?? 'unknown error'} — send the link yourself` };
}

/**
 * Window title with the unread count.
 * @param {number} unread
 * @returns {string}
 */
export const unreadTitle = (unread) => (unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE);

/**
 * Patterns typed one per line → list (trimmed, blanks dropped, duplicates removed).
 * @param {string} text
 * @returns {string[]}
 */
export function parsePatterns(text) {
  return [...new Set(String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
}

/** @param {string[]} list */
export const patternsText = (list) => list.join('\n');

/**
 * Same normalisation as the server's normalizeEmail (src/db.js): trim and lowercase.
 * @param {string} s
 */
export const normalizeEmail = (s) => String(s).trim().toLowerCase();

/**
 * Text typed into fields that live-refreshes rebuild. Pure state; the view wires it to the DOM.
 * `values` by draft key (data-draft), plus the field that had focus with its selection.
 * @typedef {{values:Map<string,string>, focus:{key:string, start:number|null, end:number|null}|null}} DraftState
 */

/** @returns {DraftState} */
export const createDraftState = () => ({ values: new Map(), focus: null });

/** @param {DraftState} d @param {string} key @param {string} value */
export const setDraft = (d, key, value) => void d.values.set(key, value);

/**
 * The draft for `key`, or `initial` when nothing was typed.
 * @param {DraftState} d @param {string} key @param {string} [initial]
 */
export const getDraft = (d, key, initial = '') => d.values.get(key) ?? initial;

/**
 * Forget the drafts whose key equals `prefix` or starts with `prefix:` (a form was saved or cancelled).
 * @param {DraftState} d @param {string} prefix
 */
export function dropDrafts(d, prefix) {
  for (const k of [...d.values.keys()]) if (k === prefix || k.startsWith(`${prefix}:`)) d.values.delete(k);
  if (d.focus && (d.focus.key === prefix || d.focus.key.startsWith(`${prefix}:`))) d.focus = null;
}

/** @param {DraftState} d @param {{key:string, start:number|null, end:number|null}|null} focus */
export const rememberFocus = (d, focus) => void (d.focus = focus);

/** The remembered focus, once. @param {DraftState} d */
export function takeFocus(d) {
  const f = d.focus;
  d.focus = null;
  return f;
}

/**
 * Tab id from a location hash (`#inbox`, the v1 address, opens Comments).
 * @param {string} hash
 * @returns {'projects'|'comments'|'settings'}
 */
export function tabFromHash(hash) {
  const t = hash.replace(/^#/, '');
  if (t === 'inbox') return 'comments';
  return t === 'comments' || t === 'settings' ? t : 'projects';
}

/**
 * The hint under the owner's "Email me about comments" switch: emails need both a Resend key and a sender.
 * @param {{hasResendKey?:boolean, fromEmail?:string}} config
 * @returns {string}
 */
export const emailHintText = (config) =>
  config.hasResendKey && (config.fromEmail ?? '').trim() !== ''
    ? 'At most one email a minute, with new comments and replies.'
    : 'Needs email set up first: add a Resend key and sender under Email.';
