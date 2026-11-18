/**
 * Thin service worker. MV3 kills it when idle, so it holds no campaign state —
 * it opens the side panel and keeps the WhatsApp tab from being put to sleep.
 */
import { WHATSAPP_URL, WHATSAPP_URL_PATTERN } from '../shared/config.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[WBS] setPanelBehavior failed', err));

/**
 * Stops Chrome's Memory Saver from discarding the WhatsApp tab. A discarded tab
 * loses our content scripts (and any running campaign) until it is reloaded.
 * @param {number} tabId
 */
function keepAwake(tabId) {
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url?.startsWith(WHATSAPP_URL)) keepAwake(tabId);
});

// Tabs that were already open when the service worker (re)started.
chrome.tabs.query({ url: WHATSAPP_URL_PATTERN }).then((tabs) => tabs.forEach((t) => keepAwake(t.id)));
