// Desktop notifications for new reviewer comments, and the unread count in the window title.
import { h } from '../dom.js';
import { internalUrl, notificationTitle, unreadTitle } from './helpers.js';

const supported = () => typeof Notification !== 'undefined';

/**
 * @param {{socket:ReturnType<typeof import('../ws.js').createSocket>, onNotify?:()=>void}} o
 */
export function createNotifier({ socket, onNotify }) {
  let unread = 0;
  const showTitle = () => {
    document.title = unreadTitle(unread);
  };
  const attending = () => document.visibilityState === 'visible' && document.hasFocus();
  const reset = () => {
    if (attending() && unread !== 0) {
      unread = 0;
      showTitle();
    }
  };
  document.addEventListener('visibilitychange', reset);
  window.addEventListener('focus', reset);

  /** @param {any} msg a `notify` message */
  function show(msg) {
    if (!attending()) {
      unread += 1;
      showTitle();
    }
    if (!supported() || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(notificationTitle(msg), { body: String(msg.excerpt ?? ''), tag: `c-${msg.commentId}` });
      n.onclick = () => {
        window.focus();
        const url = internalUrl(msg.url);
        if (url) location.assign(url);
        n.close();
      };
    } catch (err) {
      console.error('Could not show the notification:', err);
    }
  }

  const off = socket.on((e) => {
    if (e.type !== 'notify') return;
    show(e);
    onNotify?.();
  });

  /** The "Enable desktop notifications" control; hides itself once permission is granted. */
  function button() {
    const note = h('span', { class: 'muted', role: 'status' });
    const btn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn', type: 'button', text: 'Enable desktop notifications' }));
    const root = h('span', { class: 'notify-control' }, btn, note);
    const sync = () => {
      const perm = supported() ? Notification.permission : 'denied';
      root.hidden = perm === 'granted';
      btn.hidden = perm !== 'default';
      note.textContent = perm === 'denied' ? (supported() ? 'Notifications are blocked in your browser settings' : 'Notifications are not available in this browser') : '';
    };
    btn.addEventListener('click', async () => {
      try {
        await Notification.requestPermission();
      } catch {
        /* older browsers use a callback; the state is read back below anyway */
      }
      sync();
    });
    sync();
    return root;
  }

  return {
    button,
    get unread() {
      return unread;
    },
    destroy() {
      off();
      document.removeEventListener('visibilitychange', reset);
      window.removeEventListener('focus', reset);
    },
  };
}
