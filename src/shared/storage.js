/**
 * chrome.storage helpers, plus IndexedDB for attachment files (Blobs are too
 * big for chrome.storage and can't be stored there as-is).
 */

/** All chrome.storage.local keys in one place. */
export const KEYS = {
  RECIPIENTS_DRAFT: 'recipientsDraft',
  /** [{name, savedAt, list: Recipient[]}], named recipient lists the user saved. */
  SAVED_LISTS: 'savedLists',
  /** {text, textAsCaption, attachments: [{id, name, mime, size, type, caption}]}; files live in IndexedDB. */
  MESSAGE_DRAFT: 'messageDraft',
  /** [{name, text}], saved message templates. */
  TEMPLATES: 'templates',
  /** Send-tab settings, same shape as CAMPAIGN_DEFAULTS. */
  SETTINGS: 'settings',
  /** [campaignId], newest last. Each campaign is stored under campaignKey(id). */
  CAMPAIGN_INDEX: 'campaignIndex',
  /** Id of the campaign shown on the Send tab (running, paused or the last one). */
  ACTIVE_CAMPAIGN: 'activeCampaign',
  /** {date: 'YYYY-MM-DD' (IST), count} recipients sent today, across campaigns. */
  DAILY_COUNT: 'dailyCount',
};

/** Storage key of one campaign. */
export const campaignKey = (id) => `campaign:${id}`;

/**
 * Storage key of an attachment's data URL, written when a campaign starts so
 * the content script (which can't read the side panel's IndexedDB) can send it.
 */
export const mediaKey = (id) => `media:${id}`;

/** Today's date in India (IST, UTC+5:30) as YYYY-MM-DD; the daily cap resets at IST midnight. */
export function istDate(now = Date.now()) {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

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

/* ---------- IndexedDB: attachment files ---------- */

const DB_NAME = 'wbs';
const DB_VERSION = 1;
const MEDIA_STORE = 'media';

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Runs one request on the media store and resolves with its result once the transaction completes. */
async function mediaTx(mode, makeRequest) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE, mode);
    const req = makeRequest(tx.objectStore(MEDIA_STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * @param {{id: string, blob: Blob}} record
 * @returns {Promise<void>}
 */
export const putMedia = (record) => mediaTx('readwrite', (store) => store.put(record)).then(() => {});

/**
 * @param {string} id
 * @returns {Promise<{id: string, blob: Blob}|undefined>}
 */
export const getMedia = (id) => mediaTx('readonly', (store) => store.get(id));

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export const deleteMedia = (id) => mediaTx('readwrite', (store) => store.delete(id)).then(() => {});
