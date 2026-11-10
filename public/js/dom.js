// DOM helpers. Untrusted strings only ever reach the page through textContent / text nodes.

/**
 * Create an element. `props`: class, text, on<Event> handlers, data-* / aria-* / other attributes
 * (null/undefined/false skip). Children: nodes, strings (as text), arrays, null.
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') /** @type {any} */ (el).value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

/**
 * @param {Node} el
 * @param {any[]} children
 */
export function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/**
 * Replace the content of `el`.
 * @param {Node} el
 * @param {...any} children
 */
export function setChildren(el, ...children) {
  el.textContent = '';
  append(el, children);
}

/**
 * A text-only message block.
 * @param {string} title
 * @param {string} [text]
 */
export function messageBox(title, text) {
  return h('div', { class: 'message', role: 'status' }, h('h2', { text: title }), text ? h('p', { text }) : null);
}

/** localStorage that never throws. */
export const storage = {
  /** @param {string} k @returns {string|null} */
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  /** @param {string} k @param {string} v */
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode or blocked: the preference just does not stick */
    }
  },
};
