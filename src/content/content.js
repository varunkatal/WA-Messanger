/**
 * ISOLATED-world content script on web.whatsapp.com.
 * Talks to the side panel (chrome messaging) and to the MAIN-world bridge
 * (window.postMessage). From Phase 4 it also runs the campaign queue, so a
 * campaign keeps going when the side panel is closed.
 *
 * Content scripts can't be ES modules, so shared modules are loaded with
 * dynamic import() (they are listed in web_accessible_resources).
 */
(() => {
  const modulesReady = Promise.all([
    import(chrome.runtime.getURL('src/shared/messages.js')),
    import(chrome.runtime.getURL('src/shared/config.js')),
  ]).then(([messages, config]) => ({ ...messages, ...config }));

  /** Pending bridge requests: id → {resolve, reject, timer}. */
  const pending = new Map();
  let nextId = 1;
  let sourceBridge = null; // set once modules load; no request is pending before that
  modulesReady.then((m) => { sourceBridge = m.SOURCE_BRIDGE; });

  /**
   * Sends a command to the MAIN-world bridge and waits for its reply.
   * @param {string} cmd  one of BRIDGE_CMD
   * @param {any[]} [args]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} the bridge result
   */
  async function callBridge(cmd, args = [], timeoutMs) {
    const { SOURCE_EXT, TIMEOUTS } = await modulesReady;
    const id = `${Date.now()}-${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`WhatsApp did not respond to "${cmd}" in time.`));
      }, timeoutMs ?? TIMEOUTS.bridgeDefault);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: SOURCE_EXT, id, cmd, args }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    // Cheap check first: WhatsApp posts lots of its own messages.
    if (!data || data.source !== sourceBridge) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || 'Unknown bridge error'));
  });

  /**
   * Asks the bridge for status and maps it to a CONN state for the side panel.
   * @returns {Promise<{state: string, me?: string, error?: string}>}
   */
  async function getStatus() {
    const { BRIDGE_CMD, CONN } = await modulesReady;
    try {
      const s = await callBridge(BRIDGE_CMD.STATUS, [], 5_000);
      if (s.engineTimedOut) {
        return { state: CONN.ENGINE_ERROR, error: 'WhatsApp engine not ready — update WA-JS.' };
      }
      if (!s.loaded) return { state: CONN.LOADING };
      if (!s.authenticated) return { state: CONN.LOGGED_OUT };
      if (!s.ready) return { state: CONN.LOADING };
      return { state: CONN.CONNECTED, me: s.me };
    } catch (err) {
      return { state: CONN.ENGINE_ERROR, error: err.message };
    }
  }

  // Registered synchronously so early messages from the side panel aren't lost.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    modulesReady.then(({ MSG }) => {
      switch (msg?.type) {
        case MSG.GET_STATUS:
          getStatus().then(sendResponse);
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
      }
    });
    return true;
  });

  modulesReady.then(({ log }) => log('content script loaded'));
})();
