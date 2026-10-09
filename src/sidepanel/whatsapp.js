/**
 * Side panel → WhatsApp tab messaging helpers.
 */
import { WHATSAPP_URL_PATTERN } from '../shared/config.js';

/** @returns {Promise<chrome.tabs.Tab|undefined>} */
export async function findWhatsAppTab() {
  const [tab] = await chrome.tabs.query({ url: WHATSAPP_URL_PATTERN });
  return tab;
}

/**
 * Sends a message to the content script in the WhatsApp tab and unwraps
 * its {ok, result | error} reply. Throws with a human-readable message.
 * @param {string} type one of MSG
 * @param {object} [payload]
 * @returns {Promise<any>} the result
 */
export async function sendToWhatsApp(type, payload) {
  const tab = await findWhatsAppTab();
  if (!tab) throw new Error('Open WhatsApp Web first.');
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type, payload });
  } catch {
    throw new Error('Reload the WhatsApp Web tab, then try again.');
  }
  if (!res?.ok) throw new Error(res?.error || 'WhatsApp did not respond.');
  return res.result;
}
