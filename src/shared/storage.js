/**
 * chrome.storage helpers. (IndexedDB helpers for media arrive in Phase 3.)
 */

/** All chrome.storage.local keys in one place. */
export const KEYS = {
  RECIPIENTS_DRAFT: 'recipientsDraft',
};

/**
 * @param {string} key
 * @param {any} fallback returned when the key is missing
 * @returns {Promise<any>}
 */
export async function getLocal(key, fallback = null) {
  const data = await chrome.storage.local.get(key);
  return data[key] ?? fallback;
}

/**
 * @param {string} key
 * @param {any} value must be JSON-serialisable
 * @returns {Promise<void>}
 */
export async function setLocal(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
