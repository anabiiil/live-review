// WebSocket client: one socket, subscriptions remembered across reconnects, backoff 1 s doubling to 30 s.

const MIN_DELAY = 1000;
const MAX_DELAY = 30000;

/**
 * @typedef {{type:string, slug?:string, [k:string]:any}} SocketEvent  server messages plus synthetic 'open' / 'close'
 */

export function createSocket() {
  /** @type {WebSocket|null} */
  let ws = null;
  let delay = MIN_DELAY;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  let stopped = false;
  /** @type {Set<string>} */
  const slugs = new Set();
  /** @type {Set<(e:SocketEvent)=>void>} */
  const handlers = new Set();

  /** @param {SocketEvent} e */
  const emit = (e) => {
    for (const fn of [...handlers]) {
      try {
        fn(e);
      } catch (err) {
        console.error(err);
      }
    }
  };

  /** @param {object} msg */
  const send = (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  function connect() {
    if (stopped) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const sock = new WebSocket(url);
    ws = sock;
    sock.addEventListener('open', () => {
      delay = MIN_DELAY;
      for (const slug of slugs) send({ type: 'subscribe', slug });
      emit({ type: 'open' });
    });
    sock.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && typeof msg === 'object' && typeof msg.type === 'string') emit(msg);
      } catch {
        /* ignore malformed frames */
      }
    });
    sock.addEventListener('close', () => {
      if (ws !== sock) return;
      ws = null;
      emit({ type: 'close' });
      if (stopped) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(MAX_DELAY, delay * 2);
    });
    sock.addEventListener('error', () => sock.close());
  }

  return {
    /** Open the connection (idempotent). */
    start() {
      stopped = false;
      if (!ws && !timer) connect();
    },
    /** @param {string} slug */
    subscribe(slug) {
      slugs.add(slug);
      send({ type: 'subscribe', slug });
    },
    /** @param {string} slug */
    unsubscribe(slug) {
      slugs.delete(slug);
      send({ type: 'unsubscribe', slug });
    },
    /**
     * @param {(e:SocketEvent)=>void} fn
     * @returns {() => void} remove the handler
     */
    on(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    get online() {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      ws?.close();
    },
  };
}
