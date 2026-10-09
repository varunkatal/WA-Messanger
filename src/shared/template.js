/**
 * Message templates: {variable} rendering and splitting a message into the
 * parts that get sent (text and attachments). No chrome APIs, so it can be
 * checked in Node.
 */
import { CAPTION_MAX_CHARS } from './config.js';

const VAR_RE = /\{\s*(\w+)\s*\}/g;

/**
 * Replaces {variable} with values from `vars` (names are matched lowercase).
 * Missing or empty variables become '' — unless keepMissing, which leaves them
 * as written (used for the preview when there are no recipients yet).
 * @param {string} text
 * @param {Object<string,string>} vars
 * @param {boolean} [keepMissing]
 * @returns {string}
 */
export function renderTemplate(text, vars, keepMissing = false) {
  return text.replace(VAR_RE, (match, key) => {
    const value = vars[key.toLowerCase()];
    if (value != null && value !== '') return String(value);
    return keepMissing ? match : '';
  });
}

/**
 * @param {string} text
 * @returns {string[]} unique variable names used in the text, lowercase
 */
export function findVariables(text) {
  return [...new Set([...text.matchAll(VAR_RE)].map((m) => m[1].toLowerCase()))];
}

/**
 * @typedef {{kind: 'text', text: string}} TextPart
 * @typedef {{kind: 'file', mediaId: string, type: 'image'|'video'|'document', filename: string, mimetype: string, caption: string}} FilePart
 */

/**
 * Turns a message into what gets sent to one recipient, in order: text first
 * (unless it rides along as the first attachment's caption), then each attachment.
 * @param {{text: string, textAsCaption: boolean, attachments: {id: string, name: string, mime: string, type: string, caption: string}[]}} message
 * @param {Object<string,string>} vars
 * @param {{keepMissing?: boolean, captionMax?: number}} [opts]
 * @returns {(TextPart|FilePart)[]}
 */
export function buildParts(message, vars, { keepMissing = false, captionMax = CAPTION_MAX_CHARS } = {}) {
  const render = (t) => renderTemplate(t ?? '', vars, keepMissing).trim();
  const files = message.attachments.map((a) => ({
    kind: 'file',
    mediaId: a.id,
    type: a.type,
    filename: a.name,
    mimetype: a.mime,
    caption: render(a.caption),
  }));
  const text = render(message.text);
  if (!text) return files;

  const first = files[0];
  if (message.textAsCaption && first) {
    const combined = first.caption ? `${text}\n\n${first.caption}` : text;
    if (combined.length <= captionMax) {
      first.caption = combined;
      return files;
    }
  }
  return [{ kind: 'text', text }, ...files];
}
