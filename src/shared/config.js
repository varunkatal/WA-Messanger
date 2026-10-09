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

/** Warn in the UI when the user goes past these (Phase 6). */
export const SAFETY_WARN = {
  minDelaySec: 5,
  maxDailyCap: 300,
};

/** Attachment size limits in bytes (Phase 3). */
export const MEDIA_LIMITS = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};

/**
 * Logs with the [WBS] prefix when DEBUG is on.
 * @param {...any} args
 */
export function log(...args) {
  if (DEBUG) console.log('[WBS]', ...args);
}
