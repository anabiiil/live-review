import { ApiError, get, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { icon } from '../icons.js';

/** Sign-in calls answer 401 themselves; that must not bounce the page back to /login. */
const NO_REDIRECT = { auth: false };

/**
 * Sign-in: email, then the 6-digit code, then (first time) a display name.
 * @param {import('../chrome.js').Ctx} ctx
 * @param {HTMLElement} host
 */
export function loginView(ctx, host) {
  document.title = 'Sign in · LiveReview';
  let email = '';
  const card = h('div', { class: 'card login' });
  setChildren(
    host,
    h('main', { class: 'static-main' }, h('p', { class: 'brand big' }, icon('mark'), h('span', { text: 'LiveReview' })), card),
  );

  /**
   * One text field + submit, with an error line.
   * @param {{title:string, intro?:string, label:string, input:Record<string,any>, submit:string, run:(value:string)=>Promise<string|void>, back?:()=>void, backLabel?:string}} o
   */
  function form({ title, intro, label, input, submit, run, back, backLabel }) {
    const field = /** @type {HTMLInputElement} */ (h('input', { id: 'f', required: true, ...input }));
    const error = h('p', { class: 'form-error', role: 'alert' });
    const button = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn primary big', type: 'submit', text: submit }));
    const f = h(
      'form',
      {
        novalidate: true,
        onsubmit: async (/** @type {Event} */ e) => {
          e.preventDefault();
          const value = field.value.trim();
          if (!value) return;
          button.disabled = field.disabled = true;
          error.textContent = '';
          try {
            const problem = await run(value);
            if (problem) error.textContent = problem;
          } catch (err) {
            error.textContent = err instanceof ApiError && err.status === 429 ? 'Too many attempts. Please try again later.' : 'Something went wrong. Please try again.';
          }
          button.disabled = field.disabled = false;
          field.focus();
        },
      },
      h('label', { for: 'f', text: label }),
      field,
      error,
      h('div', { class: 'form-actions' }, button, back ? h('button', { class: 'link', type: 'button', text: backLabel, onclick: back }) : null),
    );
    setChildren(card, h('h1', { text: title }), intro ? h('p', { class: 'muted intro', text: intro }) : null, f);
    field.focus();
  }

  function emailStep() {
    form({
      title: 'Sign in', intro: 'Enter the email address you were invited with.', label: 'Email',
      input: { type: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false', maxlength: 254, value: email },
      submit: 'Send code',
      run: async (value) => {
        email = value;
        await post('/api/login/request', { email }, NO_REDIRECT);
        codeStep();
      },
    });
  }

  function codeStep() {
    form({
      title: 'Enter your code',
      intro: `We sent a 6-digit code to ${email}. It expires in 10 minutes.`,
      label: '6-digit code',
      input: { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}', spellcheck: 'false' },
      submit: 'Verify',
      back: emailStep, backLabel: 'Use a different email',
      run: async (code) => {
        try {
          await post('/api/login/verify', { email, code }, NO_REDIRECT);
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) return "That code didn't work. Check it and try again.";
          throw err;
        }
        const me = await get('/api/me');
        ctx.me = me;
        if (me.name === null && me.kind === 'reviewer') nameStep();
        else ctx.navigate('/');
      },
    });
  }

  function nameStep() {
    form({
      title: 'What should we call you?', intro: 'Your name appears next to your comments.', label: 'Your name',
      input: { type: 'text', autocomplete: 'name', maxlength: 60 },
      submit: 'Continue',
      run: async (name) => {
        const me = await post('/api/me/name', { name });
        ctx.me = me;
        ctx.navigate('/');
      },
    });
  }

  emailStep();
  return { destroy() {} };
}
