/**
 * MAIN-world bridge. The only file that touches the WA-JS global `WPP`.
 * Pure executor: receives {source: WBS_EXT, id, cmd, args} via postMessage,
 * runs the WPP call, replies {source: WBS_BRIDGE, id, ok, result | error}.
 *
 * Runs in the page, so it cannot import modules or use chrome.* APIs.
 * The constants below mirror src/shared/messages.js and config.js.
 */
(() => {
  const SOURCE_EXT = 'WBS_EXT';
  const SOURCE_BRIDGE = 'WBS_BRIDGE';
  const CMD = { STATUS: 'status' };
  const ENGINE_READY_TIMEOUT_MS = 60_000;

  const loadedAt = Date.now();

  const getWPP = () => window.WPP;
  // isReady: WhatsApp's modules are hooked (true even on the QR login screen).
  // isFullReady: logged in and the main UI has loaded — required for sending.
  const isLoaded = () => Boolean(getWPP()?.isReady);
  const isReady = () => Boolean(getWPP()?.isFullReady);

  /**
   * Resolves when WPP is fully ready, rejects if that takes longer than the engine timeout.
   * @returns {Promise<void>}
   */
  function waitForReady() {
    if (isReady()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('WhatsApp is not ready. Make sure you are logged in, or update WA-JS (vendor/wppconnect-wa.js).'));
      }, ENGINE_READY_TIMEOUT_MS);
      const poll = setInterval(() => {
        if (isReady()) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 500);
    });
  }

  /** Command handlers. Each returns plain serialisable data only. */
  const handlers = {
    [CMD.STATUS]() {
      const WPP = getWPP();
      const loaded = isLoaded();
      let authenticated = false;
      let me = null;
      if (loaded) {
        try {
          authenticated = Boolean(WPP.conn.isAuthenticated());
          me = authenticated ? WPP.conn.getMyUserId()?._serialized ?? null : null;
        } catch (err) {
          console.warn('[WBS] status check failed', err);
        }
      }
      return {
        wppLoaded: Boolean(WPP),
        loaded,
        ready: isReady(),
        authenticated,
        me,
        engineTimedOut: !loaded && Date.now() - loadedAt > ENGINE_READY_TIMEOUT_MS,
      };
    },
  };

  /** Commands that may run before WPP is ready (everything else waits). */
  const NO_WAIT = new Set([CMD.STATUS]);

  function reply(id, ok, payload) {
    window.postMessage(
      { source: SOURCE_BRIDGE, id, ok, ...(ok ? { result: payload } : { error: payload }) },
      '*'
    );
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE_EXT) return;

    const { id, cmd, args } = data;
    const handler = handlers[cmd];
    if (!handler) {
      reply(id, false, `Unknown command: ${cmd}`);
      return;
    }
    try {
      if (!NO_WAIT.has(cmd)) await waitForReady();
      const result = await handler(...(args || []));
      reply(id, true, result);
    } catch (err) {
      console.error('[WBS] bridge command failed', cmd, err);
      reply(id, false, err?.message || String(err));
    }
  });

  console.log('[WBS] bridge loaded, WPP present:', Boolean(getWPP()));
})();
