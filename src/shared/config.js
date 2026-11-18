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
  /** Sends (text and files): a 50 MB video can take minutes to upload on a slow connection. */
  bridgeMedia: 300_000,
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
 * Attachment size limits in bytes. Files travel to the WhatsApp tab as data
 * URLs (~33% bigger than the file) through chrome.storage in chunks (see
 * storage.js putMediaData), so these aren't bound by Chrome's 64 MB message
 * limit. The whole file is still held in memory while sending, so keep them
 * moderate. WhatsApp checks its own limits too (WA-JS reports "file too large").
 */
export const MEDIA_LIMITS = {
  image: 5 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 40 * 1024 * 1024,
};

/**
 * File types WhatsApp shows inline as photo / video / audio (MP3, M4A, AAC,
 * OGG, AMR). Anything else (PDF, Word, GIF, MOV, WAV…) is sent as a document,
 * which always works.
 */
export const MEDIA_MIME = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/3gpp'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/amr'],
};

/**
 * Voice notes recorded in the side panel. Chrome records WebM/Opus; it's
 * re-boxed as OGG/Opus (webm-to-ogg.js), which is what WhatsApp voice notes are.
 * 15 min of speech is about 4 MB, well under the audio limit.
 */
export const VOICE_NOTE = {
  maxSec: 15 * 60,
  recorderMime: 'audio/webm;codecs=opus',
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
