/**
 * All tunable defaults live here. Logic files import from this module
 * instead of hard-coding numbers.
 */

export const DEBUG = true;

export const WHATSAPP_URL = 'https://web.whatsapp.com/';
export const WHATSAPP_URL_PATTERN = 'https://web.whatsapp.com/*';

export const DEFAULT_COUNTRY_CODE = '91';

/** Timeouts (ms) for content script → bridge calls. */
export const TIMEOUTS = {
  bridgeDefault: 15_000,
  bridgeMedia: 60_000,
  /** If WPP is not ready this long after page load, report an engine error. */
  engineReady: 60_000,
};

/** How often the side panel re-checks connection status (ms). */
export const STATUS_POLL_MS = 5_000;

/** Campaign defaults (used from Phase 4). */
export const CAMPAIGN_DEFAULTS = {
  delayMinSec: 8,
  delayMaxSec: 20,
  batchSize: 25,
  batchPauseMinSec: 180,
  batchPauseMaxSec: 360,
  dailyCap: 200,
  maxConsecutiveFailures: 5,
  checkBeforeSend: true,
  textAsCaption: true,
};

/** Lines kept in a campaign's live log. */
export const CAMPAIGN_LOG_MAX = 200;

/** Warn in the UI when the user goes past these (Phase 6). */
export const SAFETY_WARN = {
  minDelaySec: 5,
  maxDailyCap: 300,
};

/**
 * Attachment size limits in bytes. Documents are capped at 40 MB even though
 * WhatsApp allows more: files travel to the WhatsApp tab as data URLs (~33%
 * bigger than the file) through Chrome messaging, which tops out near 64 MB.
 */
export const MEDIA_LIMITS = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  document: 40 * 1024 * 1024,
};

/**
 * File types WhatsApp shows inline as photo / video. Anything else (PDF, Word,
 * GIF, MOV…) is sent as a document, which always works.
 */
export const MEDIA_MIME = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/3gpp'],
};

/** Longer text than this is sent as its own message instead of as a caption. */
export const CAPTION_MAX_CHARS = 1024;

/**
 * Logs with the [WBS] prefix when DEBUG is on.
 * @param {...any} args
 */
export function log(...args) {
  if (DEBUG) console.log('[WBS]', ...args);
}
