/**
 * Thin service worker. MV3 kills it when idle, so it holds no campaign state —
 * it only opens the side panel and opens/focuses the WhatsApp tab.
 */
import { MSG } from '../shared/messages.js';
import { WHATSAPP_URL, WHATSAPP_URL_PATTERN, log } from '../shared/config.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[WBS] setPanelBehavior failed', err));

/**
 * Focuses the existing WhatsApp Web tab, or opens a new one.
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function openOrFocusWhatsApp() {
  const [tab] = await chrome.tabs.query({ url: WHATSAPP_URL_PATTERN });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab;
  }
  return chrome.tabs.create({ url: WHATSAPP_URL });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === MSG.OPEN_WHATSAPP) {
    openOrFocusWhatsApp()
      .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
      .catch((err) => {
        log('openOrFocusWhatsApp failed', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // keep the channel open for the async response
  }
  return false;
});
