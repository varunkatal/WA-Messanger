/**
 * Message section: text with formatting buttons and {variable} chips, saved
 * templates, attachments (files kept in IndexedDB), a WhatsApp-style preview
 * and "Send test to myself".
 */
import { MSG } from '../shared/messages.js';
import { CAMPAIGN_DEFAULTS, MEDIA_LIMITS, MEDIA_MIME, log } from '../shared/config.js';
import { KEYS, getLocal, setLocal, putMedia, getMedia, deleteMedia } from '../shared/storage.js';
import { buildParts, findVariables, renderTemplate } from '../shared/template.js';
import { getRecipients } from './recipients.js';
import { sendToWhatsApp } from './whatsapp.js';

/**
 * @typedef {Object} Attachment
 * @property {string} id      IndexedDB key of the file
 * @property {string} name
 * @property {string} mime
 * @property {number} size
 * @property {'image'|'video'|'document'} type
 * @property {string} caption
 */

/** @type {{text: string, textAsCaption: boolean, attachments: Attachment[]}} */
const draft = { text: '', textAsCaption: CAMPAIGN_DEFAULTS.textAsCaption, attachments: [] };

/** @type {{name: string, text: string}[]} */
let templates = [];
/** Which recipient the preview uses. */
let previewIndex = 0;
/** mediaId → object URL for image thumbnails. */
const thumbUrls = new Map();
/** mediaId → data URL, so each file is converted once. */
const dataUrlCache = new Map();
/** The text field the variable chips insert into: the message or a caption, whichever was used last. */
let lastField = null;

const $ = (id) => document.getElementById(id);

/** @returns a copy of the current message (used by the Send tab). */
export function getMessage() {
  return structuredClone(draft);
}

/* ---------- Draft persistence ---------- */

let saveTimer = null;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    setLocal(KEYS.MESSAGE_DRAFT, draft).catch((err) => log('saving message failed', err));
  }, 300);
}

async function loadDraft() {
  const saved = await getLocal(KEYS.MESSAGE_DRAFT, null);
  if (saved) Object.assign(draft, saved);
  // Drop attachments whose file is gone from IndexedDB (e.g. browser data cleared).
  const present = await Promise.all(draft.attachments.map((a) => getMedia(a.id).catch(() => null)));
  draft.attachments = draft.attachments.filter((_, i) => present[i]);
  templates = await getLocal(KEYS.TEMPLATES, []);
}

/* ---------- Text, formatting, variables ---------- */

function onTextInput() {
  draft.text = $('msg-text').value;
  saveDraft();
  renderPreview();
}

/**
 * Inserts text at the cursor of the last used field (replacing any selection).
 * Fires `input` so that field's own handler saves and re-renders.
 */
function insertAtCursor(text) {
  const ta = lastField?.isConnected ? lastField : $('msg-text');
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

/**
 * Wraps the selection of a textarea in a WhatsApp marker (*bold*, _italic_…).
 * Spaces at the edges of the selection are kept outside, because "*word *"
 * isn't bold in WhatsApp. With no selection, inserts the pair and puts the
 * cursor between them. Fires `input` so the field's own handler saves.
 * @param {HTMLTextAreaElement} ta
 * @param {string} marker
 */
function wrapSelection(ta, marker) {
  let start = ta.selectionStart;
  let end = ta.selectionEnd;
  while (start < end && /\s/.test(ta.value[start])) start++;
  while (end > start && /\s/.test(ta.value[end - 1])) end--;
  const selected = ta.value.slice(start, end);
  ta.setRangeText(`${marker}${selected}${marker}`, start, end, 'end');
  if (!selected) ta.setSelectionRange(start + marker.length, start + marker.length);
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

const FORMATS = [
  ['*', 'B', 'b', 'Bold'],
  ['_', 'I', 'i', 'Italic'],
  ['~', 'S', 's', 'Strikethrough'],
  ['```', '{}', 'code', 'Monospace'],
];

/**
 * Small B / I / S / {} toolbar for a caption textarea.
 * @param {HTMLTextAreaElement} field
 */
function makeFormatBar(field) {
  const bar = document.createElement('span');
  bar.className = 'fmt-bar fmt-small';
  for (const [marker, text, tag, title] of FORMATS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fmt-btn';
    b.title = title;
    const inner = document.createElement(tag);
    inner.textContent = text;
    b.append(inner);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    b.addEventListener('click', () => wrapSelection(field, marker));
    bar.append(b);
  }
  return bar;
}

/** Grows a textarea to fit its text (captions start small). */
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

/** Variable names available from the recipient list: name + imported columns. */
function availableVariables() {
  const names = new Set(['name']);
  for (const r of getRecipients()) for (const k of Object.keys(r.vars || {})) names.add(k);
  return [...names];
}

function renderVariableChips() {
  const chips = availableVariables().map((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `{${v}}`;
    b.title = 'Insert at the cursor (message or caption)';
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the cursor in the textarea
    b.addEventListener('click', () => insertAtCursor(`{${v}}`));
    return b;
  });
  $('msg-vars').replaceChildren(...chips);
}

/* ---------- Templates ---------- */

function renderTemplates(selectedName = '') {
  const select = $('tpl-select');
  const first = document.createElement('option');
  first.value = '';
  first.textContent = templates.length ? 'Templates…' : 'No saved templates';
  const opts = templates.map((t, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = t.name;
    o.selected = t.name === selectedName;
    return o;
  });
  select.replaceChildren(first, ...opts);
  $('tpl-delete').disabled = !selectedName;
}

function onTemplatePicked() {
  const t = templates[Number($('tpl-select').value)];
  $('tpl-delete').disabled = !t;
  if (!t) return;
  if (draft.text.trim() && draft.text !== t.text && !confirm(`Replace the current message with "${t.name}"?`)) {
    renderTemplates();
    return;
  }
  $('msg-text').value = t.text;
  onTextInput();
}

function onTemplateSave() {
  if (!draft.text.trim()) {
    alert('Write a message first.');
    return;
  }
  const current = templates[Number($('tpl-select').value)];
  const name = prompt('Template name:', current?.name ?? '')?.trim();
  if (!name) return;
  const existing = templates.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
  if (existing >= 0 && templates[existing].text !== draft.text && !confirm(`Replace the template "${templates[existing].name}"?`)) return;
  const entry = { name, text: draft.text };
  if (existing >= 0) templates[existing] = entry;
  else templates.push(entry);
  templates.sort((a, b) => a.name.localeCompare(b.name));
  setLocal(KEYS.TEMPLATES, templates).catch((err) => log('saving templates failed', err));
  renderTemplates(name);
}

function onTemplateDelete() {
  const i = Number($('tpl-select').value);
  const t = templates[i];
  if (!t || !confirm(`Delete the template "${t.name}"?`)) return;
  templates.splice(i, 1);
  setLocal(KEYS.TEMPLATES, templates).catch((err) => log('saving templates failed', err));
  renderTemplates();
}

/* ---------- Attachments ---------- */

/**
 * How WhatsApp will show a file: photo, video, or document (everything else).
 * @param {string} mime
 * @returns {'image'|'video'|'document'}
 */
function mediaKind(mime) {
  if (MEDIA_MIME.image.includes(mime)) return 'image';
  if (MEDIA_MIME.video.includes(mime)) return 'video';
  return 'document';
}

const formatSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

async function onFilesChosen(event) {
  const files = [...(event.target.files || [])];
  event.target.value = '';
  const errors = [];
  for (const file of files) {
    const mime = file.type || 'application/octet-stream';
    const type = mediaKind(mime);
    if (file.size > MEDIA_LIMITS[type]) {
      errors.push(`"${file.name}" is ${formatSize(file.size)}; the limit for ${type}s is ${formatSize(MEDIA_LIMITS[type])}.`);
      continue;
    }
    const id = crypto.randomUUID();
    try {
      await putMedia({ id, blob: file });
    } catch (err) {
      errors.push(`Could not store "${file.name}": ${err.message}`);
      continue;
    }
    draft.attachments.push({ id, name: file.name, mime, size: file.size, type, caption: '' });
  }
  const errEl = $('att-error');
  errEl.textContent = errors.join(' ');
  errEl.hidden = errors.length === 0;
  saveDraft();
  renderAttachments();
  renderPreview();
}

async function removeAttachment(id) {
  draft.attachments = draft.attachments.filter((a) => a.id !== id);
  if (thumbUrls.has(id)) URL.revokeObjectURL(thumbUrls.get(id));
  thumbUrls.delete(id);
  dataUrlCache.delete(id);
  deleteMedia(id).catch((err) => log('deleting media failed', err));
  saveDraft();
  renderAttachments();
  renderPreview();
}

function moveAttachment(index, delta) {
  const list = draft.attachments;
  const to = index + delta;
  if (to < 0 || to >= list.length) return;
  [list[index], list[to]] = [list[to], list[index]];
  saveDraft();
  renderAttachments();
  renderPreview();
}

const ICONS = { image: '🖼', video: '🎬', document: '📄' };

/** Thumbnail for images, an icon for videos and documents. */
async function thumbFor(a) {
  if (a.type === 'image') {
    if (!thumbUrls.has(a.id)) {
      const rec = await getMedia(a.id).catch(() => null);
      if (rec) thumbUrls.set(a.id, URL.createObjectURL(rec.blob));
    }
    if (thumbUrls.has(a.id)) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = thumbUrls.get(a.id);
      img.alt = '';
      return img;
    }
  }
  const icon = document.createElement('span');
  icon.className = 'thumb thumb-icon';
  icon.textContent = ICONS[a.type];
  return icon;
}

async function renderAttachments() {
  const rows = await Promise.all(
    draft.attachments.map(async (a, i) => {
      const row = document.createElement('div');
      row.className = 'att-row';

      const info = document.createElement('div');
      info.className = 'att-info';
      const name = document.createElement('span');
      name.className = 'att-name';
      name.textContent = a.name;
      const meta = document.createElement('small');
      meta.className = 'muted';
      meta.textContent = `${a.type} · ${formatSize(a.size)}`;
      const caption = document.createElement('textarea');
      caption.rows = 2;
      caption.className = 'caption';
      caption.placeholder = 'Caption — Enter for a new line, {name} works';
      caption.value = a.caption;
      caption.addEventListener('focus', () => { lastField = caption; });
      caption.addEventListener('input', () => {
        a.caption = caption.value;
        autoGrow(caption);
        saveDraft();
        renderPreview();
      });
      requestAnimationFrame(() => autoGrow(caption)); // needs layout, so after it's in the page
      const head = document.createElement('div');
      head.className = 'row-between';
      head.append(meta, makeFormatBar(caption));
      info.append(name, head, caption);

      const actions = document.createElement('div');
      actions.className = 'att-actions';
      const mk = (text, title, fn, disabled = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-btn';
        b.textContent = text;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener('click', fn);
        return b;
      };
      actions.append(
        mk('▲', 'Move up', () => moveAttachment(i, -1), i === 0),
        mk('✕', 'Remove', () => removeAttachment(a.id)),
        mk('▼', 'Move down', () => moveAttachment(i, 1), i === draft.attachments.length - 1)
      );

      row.append(await thumbFor(a), info, actions);
      return row;
    })
  );
  $('att-list').replaceChildren(...rows);
  $('att-caption-opt').hidden = draft.attachments.length === 0;
}

/**
 * Reads an attachment as a data URL (cached per session).
 * @param {string} mediaId
 * @returns {Promise<string>}
 */
export async function getDataUrl(mediaId) {
  if (dataUrlCache.has(mediaId)) return dataUrlCache.get(mediaId);
  const rec = await getMedia(mediaId);
  if (!rec) throw new Error('An attachment file is missing. Remove it and add it again.');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(rec.blob);
  });
  dataUrlCache.set(mediaId, dataUrl);
  return dataUrl;
}

/* ---------- Preview ---------- */

/**
 * Builds DOM for WhatsApp formatting: *bold*, _italic_, ~strike~, ```mono```, `code`.
 * Built with text nodes only (never innerHTML) because the text includes imported names.
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function formatWhatsApp(text) {
  const frag = document.createDocumentFragment();
  const re = /```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`/g;
  const tags = { '*': 'strong', _: 'em', '~': 's', '`': 'code' };
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    const token = m[0];
    const marker = token.startsWith('```') ? '```' : token[0];
    const el = document.createElement(tags[marker[0]]);
    el.textContent = token.slice(marker.length, -marker.length);
    frag.append(el);
    last = m.index + token.length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** The recipient shown in the preview, or null when there are none. */
function previewRecipient() {
  const list = getRecipients();
  if (!list.length) return null;
  previewIndex = Math.min(Math.max(previewIndex, 0), list.length - 1);
  return list[previewIndex];
}

/** Warns when a used {variable} is empty for some recipients. */
function renderVariableWarnings() {
  const list = getRecipients();
  const used = findVariables([draft.text, ...draft.attachments.map((a) => a.caption)].join(' '));
  const lines = [];
  for (const v of used) {
    const missing = list.filter((r) => !String(r.vars?.[v] ?? '').trim()).length;
    if (list.length && missing) {
      lines.push(`{${v}} is empty for ${missing} of ${list.length} recipients — they will see nothing there.`);
    }
  }
  const el = $('pv-warn');
  el.textContent = lines.join(' ');
  el.hidden = lines.length === 0;
}

function renderPreview() {
  const r = previewRecipient();
  const list = getRecipients();
  $('pv-who').textContent = r ? `${r.name || (r.number ? `+${r.number}` : 'Recipient')} (${previewIndex + 1}/${list.length})` : 'No recipients yet';
  $('pv-prev').disabled = !r || previewIndex === 0;
  $('pv-next').disabled = !r || previewIndex >= list.length - 1;

  const parts = buildParts(draft, r?.vars ?? {}, { keepMissing: !r });
  const bubbles = parts.map((p) => {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (p.kind === 'file') {
      const media = document.createElement('div');
      media.className = 'bubble-media';
      if (p.type === 'image' && thumbUrls.has(p.mediaId)) {
        const img = document.createElement('img');
        img.src = thumbUrls.get(p.mediaId);
        img.alt = '';
        media.append(img);
      } else {
        media.textContent = `${ICONS[p.type]} ${p.filename}`;
      }
      bubble.append(media);
    }
    const body = p.kind === 'text' ? p.text : p.caption;
    if (body) {
      const textEl = document.createElement('div');
      textEl.className = 'bubble-text';
      textEl.append(formatWhatsApp(body));
      bubble.append(textEl);
    }
    return bubble;
  });
  if (!bubbles.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'Write a message or add an attachment.';
    bubbles.push(empty);
  }
  $('pv-chat').replaceChildren(...bubbles);
  renderVariableWarnings();
}

/* ---------- Send test ---------- */

async function onSendTest() {
  const btn = $('msg-test');
  const status = $('msg-test-status');
  const r = previewRecipient();
  const parts = buildParts(draft, r?.vars ?? {}, { keepMissing: !r });
  if (!parts.length) {
    status.textContent = 'Write a message or add an attachment first.';
    return;
  }
  btn.disabled = true;
  try {
    for (const [i, part] of parts.entries()) {
      status.textContent = `Sending ${i + 1} of ${parts.length}…`;
      const payload = part.kind === 'file' ? { ...part, dataUrl: await getDataUrl(part.mediaId) } : part;
      await sendToWhatsApp(MSG.SEND_TEST, payload);
    }
    status.textContent = 'Sent — check your own chat ("Message yourself") in WhatsApp.';
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Init ---------- */

/** Wires up the Message tab and restores the saved draft. */
export async function initComposer() {
  $('msg-text').addEventListener('input', onTextInput);
  $('msg-text').addEventListener('focus', (e) => { lastField = e.target; });
  document.querySelectorAll('#msg-fmt .fmt-btn').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
    b.addEventListener('click', () => wrapSelection($('msg-text'), b.dataset.marker));
  });
  $('tpl-select').addEventListener('change', onTemplatePicked);
  $('tpl-save').addEventListener('click', onTemplateSave);
  $('tpl-delete').addEventListener('click', onTemplateDelete);
  $('att-add').addEventListener('click', () => $('att-file').click());
  $('att-file').addEventListener('change', onFilesChosen);
  $('msg-as-caption').addEventListener('change', (e) => {
    draft.textAsCaption = e.target.checked;
    saveDraft();
    renderPreview();
  });
  $('pv-prev').addEventListener('click', () => { previewIndex--; renderPreview(); });
  $('pv-next').addEventListener('click', () => { previewIndex++; renderPreview(); });
  $('msg-test').addEventListener('click', onSendTest);

  // Recipients change on the other tab: refresh variable chips and preview.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEYS.RECIPIENTS_DRAFT]) {
      renderVariableChips();
      renderPreview();
    }
  });

  await loadDraft();
  $('msg-text').value = draft.text;
  $('msg-as-caption').checked = draft.textAsCaption;
  renderTemplates();
  renderVariableChips();
  await renderAttachments(); // creates image thumbnails used by the preview
  renderPreview();
}
