// Notification center: the bell with its unread count and dropdown, toasts for new notifications, desktop
// notifications when permitted, and the email-notifications preference. One per page load; the bell element
// is re-mounted into each top bar.
import { get, post, api } from './api.js';
import { h, setChildren } from './dom.js';
import { relativeTime } from './format.js';
import { icon } from './icons.js';
import { LIST_LIMIT, internalUrl, mergeNotifications, notificationText, unreadBadge, unreadLabel } from './notify-model.js';

/** @typedef {import('./notify-model.js').Note} Note */

const TOAST_MS = 6000;
const MAX_TOASTS = 3;

const desktopSupported = () => typeof Notification !== 'undefined';
/** The reader is looking at this page (a toast is enough then). */
const attending = () => document.visibilityState === 'visible' && document.hasFocus();
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {{
 *   socket: ReturnType<typeof import('./ws.js').createSocket>,
 *   me: {email:string, kind:'owner'|'reviewer', emailNotifications?:boolean},
 *   navigate: (url:string)=>void,
 *   onUnread?: (n:number)=>void,
 *   settingsInPanel?: boolean,
 * }} o settingsInPanel: show the email preference in the dropdown (pages without an avatar menu)
 */
export function createNotificationCenter({ socket, me, navigate, onUnread = () => {}, settingsInPanel = false }) {
  /** @type {Note[]} */
  let items = [];
  let unread = 0;
  let loaded = false;
  let failed = false;
  let emailOn = me.emailNotifications !== false;
  let alive = true;

  // ---- bell and dropdown ----
  const count = h('span', { class: 'bell-count', 'aria-hidden': 'true', hidden: '' });
  const trigger = /** @type {HTMLButtonElement} */ (
    h('button', { class: 'icon-btn bell-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': unreadLabel(0) }, icon('bell'), count)
  );
  const panel = h('div', { class: 'note-panel', role: 'dialog', 'aria-label': 'Notifications', hidden: '' });
  const bell = h('div', { class: 'bell' }, trigger, panel);

  // ---- toasts ----
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  document.body.append(toasts);

  function setUnread(/** @type {number} */ n) {
    unread = Math.max(0, n);
    count.textContent = unreadBadge(unread);
    count.hidden = unread === 0;
    trigger.setAttribute('aria-label', unreadLabel(unread));
    onUnread(unread);
  }

  /** @param {Note} n */
  function open(n) {
    close(false);
    markRead(n);
    const url = internalUrl(n.url);
    if (url) navigate(url);
  }

  /** @param {Note} n */
  function markRead(n) {
    if (n.read) return;
    items = items.map((x) => (x.id === n.id ? { ...x, read: true } : x));
    setUnread(unread - 1);
    post('/api/notifications/read', { ids: [n.id] }).then(
      (r) => alive && setUnread(r.unread),
      () => {},
    );
    if (!panel.hidden) drawPanel();
  }

  async function markAllRead() {
    try {
      const r = await post('/api/notifications/read', { all: true });
      items = items.map((x) => ({ ...x, read: true }));
      setUnread(r.unread);
    } catch {
      /* the list just stays as it was */
    }
    drawPanel();
    /** @type {HTMLElement|null} */ (panel.querySelector('.note-item'))?.focus();
  }

  /** @param {Note} n */
  function itemEl(n) {
    const a = h(
      'a',
      { class: `note-item${n.read ? '' : ' unread'}`, href: internalUrl(n.url) ?? '#' },
      h('span', { class: 'note-dot', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'note-main' },
        h('span', { class: 'note-text', dir: 'auto', text: notificationText(n) }),
        n.excerpt ? h('span', { class: 'note-excerpt', dir: 'auto', text: n.excerpt }) : null,
        h(
          'span',
          { class: 'note-meta' },
          h('span', { dir: 'auto', text: n.projectName }),
          ' ',
          h('time', { datetime: new Date(n.createdAt).toISOString(), title: new Date(n.createdAt).toLocaleString(), text: relativeTime(n.createdAt) }),
          n.read ? null : h('span', { class: 'visually-hidden', text: ', unread' }),
        ),
      ),
    );
    a.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        markRead(n);
        return;
      }
      e.preventDefault();
      open(n);
    });
    return h('li', null, a);
  }

  function desktopControl() {
    if (!desktopSupported()) return null;
    const perm = Notification.permission;
    if (perm === 'granted') return null;
    if (perm === 'denied') return h('p', { class: 'note-foot-text', text: 'Desktop notifications are blocked in your browser settings.' });
    return h('button', {
      class: 'link', type: 'button', text: 'Turn on desktop notifications',
      onclick: async () => {
        try {
          await Notification.requestPermission();
        } catch {
          /* older browsers use a callback; the state is read back below anyway */
        }
        drawPanel();
      },
    });
  }

  function emailCheckbox() {
    const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', class: 'note-email' }));
    box.checked = emailOn;
    box.addEventListener('change', () => void setEmail(box.checked, () => (box.checked = emailOn)));
    return h('label', { class: 'check note-email-label' }, box, 'Email me about comments');
  }

  /** Focusable things in the dropdown, in order (to keep the focus in place across a redraw). */
  const focusables = () => /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('a, button, input')]);

  function drawPanel() {
    const at = focusables().indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const head = h(
      'div',
      { class: 'note-head' },
      h('h2', { text: 'Notifications' }),
      h('button', { class: 'link', type: 'button', text: 'Mark all read', disabled: unread === 0, onclick: markAllRead }),
    );
    let body;
    if (!loaded) body = h('p', { class: 'note-empty', text: 'Loading…' });
    else if (failed && !items.length) body = h('p', { class: 'note-empty', text: 'Notifications could not be loaded.' });
    else if (!items.length) body = h('p', { class: 'note-empty', text: "You're all caught up. Replies and resolved comments show up here." });
    else body = h('ul', { class: 'note-list' }, items.map(itemEl));
    const desktop = desktopControl();
    const foot = desktop || settingsInPanel ? h('div', { class: 'note-foot' }, settingsInPanel ? emailCheckbox() : null, desktop) : null;
    setChildren(panel, head, body, foot);
    if (at >= 0) {
      const list = focusables().filter((el) => !(/** @type {any} */ (el).disabled));
      (list[Math.min(at, list.length - 1)] ?? trigger).focus();
    }
  }

  /** @param {boolean} [focusTrigger] */
  function close(focusTrigger) {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger.focus();
  }
  function openPanel() {
    drawPanel();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    /** @type {HTMLElement|null} */ (panel.querySelector('.note-item') ?? panel.querySelector('button'))?.focus();
    load();
  }
  trigger.addEventListener('click', () => (panel.hidden ? openPanel() : close()));
  // Escape closes from anywhere (the focus may sit outside the dropdown, e.g. after a click on its padding).
  /** @param {KeyboardEvent} e */
  const onEscape = (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    e.preventDefault();
    close(bell.contains(document.activeElement) || document.activeElement === document.body);
  };
  document.addEventListener('keydown', onEscape);
  bell.addEventListener('keydown', (e) => {
    if (panel.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('.note-item')]);
      if (!list.length) return;
      e.preventDefault();
      const at = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
      list[next].focus();
    }
  });
  bell.addEventListener('focusout', (e) => {
    if (e.relatedTarget instanceof Node && !bell.contains(e.relatedTarget)) close();
  });
  /** @param {MouseEvent} e */
  const outside = (e) => {
    if (e.target instanceof Node && !bell.contains(e.target)) close();
  };
  document.addEventListener('click', outside);

  // ---- data ----
  async function load() {
    try {
      const r = await get(`/api/notifications?limit=${LIST_LIMIT}`);
      if (!alive) return;
      items = r.items;
      failed = false;
      setUnread(r.unread);
    } catch {
      failed = true;
    }
    loaded = true;
    if (!panel.hidden) drawPanel();
  }

  /**
   * @param {boolean} on
   * @param {()=>void} [revert] called when saving failed
   */
  async function setEmail(on, revert) {
    const was = emailOn;
    emailOn = on;
    try {
      const r = await api('PUT', '/api/me/prefs', { emailNotifications: on });
      emailOn = r.emailNotifications;
    } catch {
      emailOn = was;
      revert?.();
    }
    return emailOn;
  }

  // ---- toasts and desktop notifications ----
  /** @param {HTMLElement} el */
  function dismiss(el) {
    if (!el.isConnected || el.classList.contains('leaving')) return;
    if (reducedMotion()) {
      el.remove();
      return;
    }
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  }

  /** @param {Note} n */
  function toast(n) {
    const main = h(
      'button',
      { class: 'toast-main', type: 'button' },
      h('span', { class: 'toast-text', dir: 'auto', text: notificationText(n) }),
      n.excerpt ? h('span', { class: 'toast-excerpt', dir: 'auto', text: n.excerpt }) : null,
    );
    const x = h('button', { class: 'icon-btn toast-close', type: 'button', 'aria-label': 'Dismiss' }, icon('x'));
    const el = h('div', { class: 'toast', 'data-kind': n.kind }, h('span', { class: 'toast-mark', 'aria-hidden': 'true' }), main, x);
    main.addEventListener('click', () => {
      dismiss(el);
      open(n);
    });
    x.addEventListener('click', () => dismiss(el));
    let timer = setTimeout(() => dismiss(el), TOAST_MS);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('focusin', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => {
      clearTimeout(timer);
      timer = setTimeout(() => dismiss(el), TOAST_MS / 2);
    });
    toasts.append(el);
    const live = [...toasts.children].filter((c) => !c.classList.contains('leaving'));
    for (const old of live.slice(0, Math.max(0, live.length - MAX_TOASTS))) dismiss(/** @type {HTMLElement} */ (old));
  }

  /** @param {Note} n */
  function desktop(n) {
    if (!desktopSupported() || Notification.permission !== 'granted' || attending()) return;
    try {
      const d = new Notification(notificationText(n), { body: n.excerpt, tag: `lr-n-${n.id}` });
      d.onclick = () => {
        window.focus();
        open(n);
        d.close();
      };
    } catch (err) {
      console.error('Could not show the notification:', err);
    }
  }

  const off = socket.on((e) => {
    if (e.type === 'notification' && e.notification && typeof e.notification === 'object') {
      const n = /** @type {Note} */ (e.notification);
      const known = items.some((x) => x.id === n.id);
      items = mergeNotifications(items, n);
      if (!known && !n.read) setUnread(unread + 1);
      if (!panel.hidden) drawPanel();
      if (!known) {
        toast(n);
        desktop(n);
      }
    } else if (e.type === 'open' && loaded) {
      // A reconnect may have missed notifications.
      load();
    }
  });
  socket.start();
  load();

  return {
    /** The bell (button + dropdown), to mount in a top bar. */
    bell,
    /** The email preference as a menu item for the avatar menu. */
    emailItem() {
      const item = h(
        'button',
        { class: 'menu-item', role: 'menuitemcheckbox', type: 'button', 'aria-checked': String(emailOn) },
        icon('mail'),
        h('span', { class: 'menu-text', text: 'Email notifications' }),
        h('span', { class: 'switch', 'aria-hidden': 'true' }),
      );
      item.addEventListener('click', async () => {
        item.setAttribute('aria-checked', String(!emailOn));
        item.setAttribute('aria-checked', String(await setEmail(!emailOn)));
      });
      return item;
    },
    get unread() {
      return unread;
    },
    /** Refetch the list (e.g. after a reconnect). */
    refresh: load,
    destroy() {
      alive = false;
      off();
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', onEscape);
      bell.remove();
      toasts.remove();
    },
  };
}
