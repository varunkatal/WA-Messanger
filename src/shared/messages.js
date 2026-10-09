/**
 * Message type constants for every messaging hop.
 * BRIDGE_CMD and the source tags are mirrored in src/content/bridge-main.js,
 * which runs in the page (MAIN world) and cannot import modules — keep them in sync.
 */

/** Side panel / service worker ⇄ content script (chrome.runtime / chrome.tabs messaging). */
export const MSG = {
  GET_STATUS: 'GET_STATUS',
  OPEN_WHATSAPP: 'OPEN_WHATSAPP',
};

/** Content script ⇄ bridge (window.postMessage). */
export const BRIDGE_CMD = {
  STATUS: 'status',
};

export const SOURCE_EXT = 'WBS_EXT';
export const SOURCE_BRIDGE = 'WBS_BRIDGE';

/** Connection states shown in the side panel header. */
export const CONN = {
  NO_TAB: 'no_tab',             // no WhatsApp Web tab open
  NEEDS_RELOAD: 'needs_reload', // tab open but our content script isn't in it
  LOADING: 'loading',           // WPP still starting up
  ENGINE_ERROR: 'engine_error', // WPP never became ready
  LOGGED_OUT: 'logged_out',
  CONNECTED: 'connected',
};
