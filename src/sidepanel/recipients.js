/**
 * Recipients section: a Numbers · Groups · Contacts · Lists switch (paste/typed
 * numbers and CSV/Excel import, inline group and contact pickers, saved lists),
 * and the selected recipients as removable chips (persisted as a draft).
 *
 * XLSX is the SheetJS global, loaded by a classic <script> in sidepanel.html.
 */
import { MSG } from '../shared/messages.js';
import { normalizePhone, parseNumberList } from '../shared/phone.js';
import { KEYS, getLocal, setLocal } from '../shared/storage.js';
import { log } from '../shared/config.js';
import { sendToWhatsApp } from './whatsapp.js';

/**
 * @typedef {Object} Recipient
 * @property {string} key      dedupe key: "n:<number>" or "id:<chatId>"
 * @property {'number'|'contact'|'group'} kind
 * @property {string} chatId   "<number>@c.us" for typed numbers; WPP's id for contacts/groups
 * @property {string|null} number
 * @property {string} name
 * @property {Object<string,string>} vars  template variables, always includes `name`
 */

/** @type {{list: Recipient[], invalid: {raw: string, name: string, reason: string}[]}} */
const state = { list: [], invalid: [] };

const $ = (id) => document.getElementById(id);

/* ---------- State ---------- */

async function load() {
  const saved = await getLocal(KEYS.RECIPIENTS_DRAFT, null);
  if (saved) {
    state.list = saved.list ?? [];
    state.invalid = saved.invalid ?? [];
  }
}

function save() {
  setLocal(KEYS.RECIPIENTS_DRAFT, { list: state.list, invalid: state.invalid }).catch((err) =>
    log('saving recipients failed', err)
  );
}

/** @returns {Recipient[]} the current list (used by later phases). */
export function getRecipients() {
  return state.list;
}

/**
 * Adds recipients, skipping ones already in the list.
 * @param {Recipient[]} items
 * @returns {{added: number, duplicates: number}}
 */
function addRecipients(items) {
  const seen = new Set(state.list.map((r) => r.key));
  let added = 0;
  let duplicates = 0;
  for (const item of items) {
    if (seen.has(item.key)) {
      duplicates++;
      continue;
    }
    seen.add(item.key);
    state.list.push(item);
    added++;
  }
  return { added, duplicates };
}

/**
 * Validates raw rows into number recipients; invalid ones go to state.invalid.
 * @param {{phone: string|number, name: string, vars?: Object<string,string>}[]} rows
 * @returns {{added: number, duplicates: number, invalid: number}}
 */
function addRawRows(rows) {
  const valid = [];
  let invalid = 0;
  for (const row of rows) {
    const res = normalizePhone(row.phone);
    const name = String(row.name ?? '').trim();
    if (!res.ok) {
      state.invalid.push({ raw: String(row.phone ?? ''), name, reason: res.reason });
      invalid++;
      continue;
    }
    valid.push({
      key: `n:${res.number}`,
      kind: 'number',
      chatId: `${res.number}@c.us`,
      number: res.number,
      name,
      vars: { ...(row.vars || {}), name },
    });
  }
  return { ...addRecipients(valid), invalid };
}

/**
 * Updates the list, saves, and shows a one-line summary of what happened.
 * @param {{added: number, duplicates: number, invalid?: number}} result
 */
function commit(result) {
  const parts = [`Added ${result.added}`];
  if (result.duplicates) parts.push(`${result.duplicates} duplicate${result.duplicates > 1 ? 's' : ''} skipped`);
  if (result.invalid) parts.push(`${result.invalid} invalid`);
  showSummary(parts.join(' · '), result.invalid ? 'warn' : 'ok');
  save();
  render();
}

function showSummary(text, tone = 'ok') {
  const el = $('rcp-summary');
  el.textContent = text;
  el.className = `summary summary-${tone}`;
  el.hidden = !text;
}

/* ---------- Paste ---------- */

/** Adds whatever is in the paste box, then empties it. */
function addFromPasteBox() {
  const box = $('rcp-paste');
  const rows = parseNumberList(box.value);
  if (!rows.length) return;
  commit(addRawRows(rows));
  box.value = '';
}

/* ---------- File import ---------- */

/** Workbook + parsed rows of the chosen sheet, while the mapping box is open. */
let importState = null;

/**
 * Turns a header into a variable name: "Class / Section" → "class_section".
 * @param {string} header
 * @param {number} index
 */
function toVarName(header, index) {
  const v = String(header).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return v || `col_${index + 1}`;
}

const isBlankRow = (row) => row.every((c) => String(c ?? '').trim() === '');

/**
 * Reads one sheet as rows and works out the header row.
 * If the first row already contains a valid phone number, there is no header row.
 */
function readSheet(sheetName) {
  const ws = importState.workbook.Sheets[sheetName];
  const rows = XLSX.utils
    .sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false })
    .filter((r) => !isBlankRow(r));
  const width = Math.max(0, ...rows.map((r) => r.length));
  const first = rows[0] ?? [];
  const hasHeader = !first.some((c) => normalizePhone(c).ok);
  const headers = Array.from({ length: width }, (_, i) =>
    hasHeader && String(first[i] ?? '').trim() ? String(first[i]).trim() : `Column ${XLSX.utils.encode_col(i)}`
  );
  importState.headers = headers;
  importState.rows = hasHeader ? rows.slice(1) : rows;
}

/** Index of the first header matching the pattern, or -1. */
const guessColumn = (headers, pattern) => headers.findIndex((h) => pattern.test(h));

function fillSelect(select, options, selected) {
  select.replaceChildren(
    ...options.map(({ value, label }) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      o.selected = value === selected;
      return o;
    })
  );
}

function renderMapping() {
  const { headers, rows } = importState;
  let phoneIdx = guessColumn(headers, /phone|mobile|number|contact|whats ?app|cell|^ph/i);
  if (phoneIdx < 0) {
    // No obvious header: pick the column with the most valid numbers in the first rows.
    const sample = rows.slice(0, 20);
    let best = 0;
    headers.forEach((_, i) => {
      const score = sample.filter((r) => normalizePhone(r[i]).ok).length;
      if (score > best) [best, phoneIdx] = [score, i];
    });
  }
  const nameIdx = guessColumn(headers, /name/i);
  const cols = headers.map((h, i) => ({ value: String(i), label: h }));
  fillSelect($('map-phone'), cols, String(Math.max(phoneIdx, 0)));
  fillSelect($('map-name'), [{ value: '-1', label: '— none —' }, ...cols], String(nameIdx));
  $('map-rows').textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} found`;
  updateVarHint();
}

/** Shows which extra columns become {variables}. */
function updateVarHint() {
  const phone = Number($('map-phone').value);
  const name = Number($('map-name').value);
  const vars = importState.headers
    .map((h, i) => (i === phone || i === name ? null : `{${toVarName(h, i)}}`))
    .filter(Boolean);
  $('map-vars').textContent = vars.length ? `Other columns become variables: ${vars.join(' ')}` : '';
}

async function onFileChosen(event) {
  const file = event.target.files?.[0];
  event.target.value = ''; // allow choosing the same file again
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const isText = /\.(csv|txt)$/i.test(file.name);
    // raw for CSV keeps cells as text, so "098..." and long numbers aren't mangled.
    const workbook = XLSX.read(buf, { type: 'array', raw: isText });
    importState = { workbook, fileName: file.name };
    const sheets = workbook.SheetNames;
    fillSelect($('map-sheet'), sheets.map((s) => ({ value: s, label: s })), sheets[0]);
    $('map-sheet-row').hidden = sheets.length < 2;
    $('map-file').textContent = file.name;
    readSheet(sheets[0]);
    if (!importState.rows.length) {
      importState = null;
      showSummary(`No rows found in "${file.name}".`, 'err');
      return;
    }
    renderMapping();
    $('import-box').hidden = false;
  } catch (err) {
    log('import failed', err);
    showSummary(`Could not read "${file.name}": ${err.message}`, 'err');
  }
}

function onImportConfirm() {
  const phone = Number($('map-phone').value);
  const name = Number($('map-name').value);
  const { headers, rows } = importState;
  const parsed = rows.map((r) => {
    const vars = {};
    headers.forEach((h, i) => {
      if (i !== phone && i !== name) vars[toVarName(h, i)] = String(r[i] ?? '').trim();
    });
    return { phone: r[phone], name: name >= 0 ? r[name] : '', vars };
  });
  closeImport();
  commit(addRawRows(parsed));
}

function closeImport() {
  importState = null;
  $('import-box').hidden = true;
}

/* ---------- Source switch: Numbers · Groups · Contacts · Lists ---------- */

/** @type {'numbers'|'groups'|'contacts'|'lists'} */
let mode = 'numbers';
/** Groups / contacts loaded from WhatsApp, once per panel session (↻ reloads). */
const sources = { groups: null, contacts: null };
/** Re-renders the visible picker list (e.g. after a recipient is removed), or null. */
let refreshPicker = null;

function setMode(next) {
  mode = next;
  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
  const pane = next === 'groups' || next === 'contacts' ? 'pick' : next;
  document.querySelectorAll('.pane').forEach((p) => { p.hidden = p.dataset.pane !== pane; });
  refreshPicker = null;
  if (pane === 'pick') showSource(next);
}

/** Shows a one-line message in place of the picker list. */
function setPickerMessage(text) {
  const p = document.createElement('p');
  p.className = 'muted small';
  p.textContent = text;
  $('picker-list').replaceChildren(p);
  $('picker-add').disabled = true;
}

/** WhatsApp groups → picker items carrying the recipient to add. */
const groupItems = (groups) =>
  groups
    .map((g) => ({
      label: g.name || 'Unnamed group',
      sub: g.participantsCount != null ? `${g.participantsCount} members` : 'Group',
      recipient: { key: `id:${g.id}`, kind: 'group', chatId: g.id, number: null, name: g.name, vars: { name: g.name } },
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

/** WhatsApp contacts → picker items. */
const contactItems = (contacts) =>
  contacts
    .map((c) => ({
      label: c.name || (c.number ? `+${c.number}` : c.id),
      sub: c.number ? `+${c.number}` : 'Number hidden',
      recipient: {
        key: c.number ? `n:${c.number}` : `id:${c.id}`,
        kind: 'contact',
        chatId: c.id,
        number: c.number,
        name: c.name,
        vars: { name: c.name },
      },
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

/**
 * Loads groups or contacts from WhatsApp (cached) and shows them in the picker.
 * @param {'groups'|'contacts'} kind
 * @param {boolean} [reload] ignore the cache
 */
async function showSource(kind, reload = false) {
  $('picker-search').placeholder = kind === 'groups' ? 'Search groups by name…' : 'Search contacts…';
  if (!sources[kind] || reload) {
    setPickerMessage('Loading from WhatsApp…');
    try {
      const raw = await sendToWhatsApp(kind === 'groups' ? MSG.LIST_GROUPS : MSG.LIST_CONTACTS);
      sources[kind] = kind === 'groups' ? groupItems(raw) : contactItems(raw);
    } catch (err) {
      if (mode === kind) setPickerMessage(err.message);
      return;
    }
  }
  if (mode === kind) showPicker(sources[kind]);
}

/**
 * Renders the inline picker: search, select all, checkbox list, "Add N selected".
 * Items already in the recipient list show as added.
 * @param {{label: string, sub: string, recipient: Recipient}[]} items
 */
function showPicker(items) {
  const selected = new Set(); // recipient keys
  const listEl = $('picker-list');
  const search = $('picker-search');
  const selectAll = $('picker-all');
  const addBtn = $('picker-add');
  search.value = '';

  const added = () => new Set(state.list.map((r) => r.key));
  const visible = () => {
    const q = search.value.trim().toLowerCase();
    return q ? items.filter((it) => `${it.label} ${it.sub}`.toLowerCase().includes(q)) : items;
  };
  const selectable = () => {
    const have = added();
    return visible().filter((it) => !have.has(it.recipient.key));
  };

  const updateFooter = () => {
    addBtn.textContent = `Add ${selected.size} selected`;
    addBtn.disabled = selected.size === 0;
    const sel = selectable();
    selectAll.checked = sel.length > 0 && sel.every((it) => selected.has(it.recipient.key));
  };

  const renderList = () => {
    const have = added();
    const frag = document.createDocumentFragment();
    for (const it of visible()) {
      const key = it.recipient.key;
      const isAdded = have.has(key);
      const row = document.createElement('label');
      row.className = `picker-row${isAdded ? ' picker-added' : ''}`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isAdded || selected.has(key);
      cb.disabled = isAdded;
      cb.addEventListener('change', () => {
        cb.checked ? selected.add(key) : selected.delete(key);
        updateFooter();
      });
      const text = document.createElement('span');
      text.className = 'picker-text';
      const label = document.createElement('span');
      label.textContent = it.label;
      const sub = document.createElement('small');
      sub.textContent = isAdded ? `${it.sub} · added` : it.sub;
      text.append(label, sub);
      row.append(cb, text);
      frag.append(row);
    }
    listEl.replaceChildren(frag);
    if (!listEl.children.length) setPickerMessage(items.length ? 'No matches.' : 'Nothing found.');
    updateFooter();
  };

  search.oninput = renderList;
  selectAll.onchange = () => {
    for (const it of selectable()) selectAll.checked ? selected.add(it.recipient.key) : selected.delete(it.recipient.key);
    renderList();
  };
  addBtn.onclick = () => {
    const picked = items.filter((it) => selected.has(it.recipient.key)).map((it) => structuredClone(it.recipient));
    selected.clear();
    commit(addRecipients(picked)); // re-renders the list, which calls refreshPicker
  };

  refreshPicker = renderList;
  renderList();
}

/* ---------- Saved lists ---------- */

/** @type {{name: string, savedAt: number, list: Recipient[]}[]} */
let savedLists = [];

async function loadSavedLists() {
  savedLists = await getLocal(KEYS.SAVED_LISTS, []);
}

function persistSavedLists() {
  setLocal(KEYS.SAVED_LISTS, savedLists).catch((err) => log('saving lists failed', err));
}

function renderSavedLists() {
  $('lists-box').hidden = savedLists.length === 0;
  $('lists-empty').hidden = savedLists.length > 0;
  fillSelect(
    $('lists-select'),
    savedLists.map((l, i) => ({ value: String(i), label: `${l.name} (${l.list.length})` })),
    '0'
  );
}

/** Saves the current recipients under a name; same name (any case) replaces the old list. */
function onSaveList() {
  const name = prompt('Name for this list (e.g. Grade 8 all sections):')?.trim();
  if (!name) return;
  const existing = savedLists.findIndex((l) => l.name.toLowerCase() === name.toLowerCase());
  if (existing >= 0 && !confirm(`Replace the saved list "${savedLists[existing].name}"?`)) return;
  const entry = { name, savedAt: Date.now(), list: structuredClone(state.list) };
  if (existing >= 0) savedLists[existing] = entry;
  else savedLists.push(entry);
  savedLists.sort((a, b) => a.name.localeCompare(b.name));
  persistSavedLists();
  renderSavedLists();
  showSummary(`Saved "${name}" (${entry.list.length} recipients)`);
}

/** Adds the chosen saved list to the current recipients (duplicates skipped). */
function onLoadList() {
  const entry = savedLists[Number($('lists-select').value)];
  if (!entry) return;
  commit(addRecipients(structuredClone(entry.list)));
}

function onDeleteList() {
  const i = Number($('lists-select').value);
  const entry = savedLists[i];
  if (!entry || !confirm(`Delete the saved list "${entry.name}"?`)) return;
  savedLists.splice(i, 1);
  persistSavedLists();
  renderSavedLists();
}

/* ---------- List rendering ---------- */

function render() {
  const { list, invalid } = state;
  const count = (kind) => list.filter((r) => r.kind === kind).length;
  const breakdown = [
    [count('number'), 'numbers'],
    [count('contact'), 'contacts'],
    [count('group'), 'groups'],
  ]
    .filter(([n]) => n)
    .map(([n, l]) => `${n} ${l}`)
    .join(' · ');
  $('rcp-count').textContent = `${list.length} recipient${list.length === 1 ? '' : 's'}${breakdown ? ` (${breakdown})` : ''}`;
  $('rcp-clear').hidden = list.length === 0;
  $('rcp-save-list').hidden = list.length === 0;

  const chips = list.map((r) => {
    const chip = document.createElement('span');
    chip.className = `rcp-chip rcp-${r.kind}`;
    const label = r.name || (r.number ? `+${r.number}` : 'Contact');
    chip.title = r.number ? `+${r.number}` : r.kind === 'group' ? 'WhatsApp group' : 'Contact';
    const text = document.createElement('span');
    text.textContent = r.kind === 'group' ? `👥 ${label}` : label;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'chip-x';
    rm.title = 'Remove';
    rm.textContent = '×';
    rm.addEventListener('click', () => removeRecipient(r.key));
    chip.append(text, rm);
    return chip;
  });
  $('rcp-chips').replaceChildren(...chips);
  $('rcp-chips').hidden = list.length === 0;
  $('rcp-empty').hidden = list.length > 0;
  refreshPicker?.();

  $('rcp-invalid').hidden = invalid.length === 0;
  $('rcp-invalid-count').textContent = `${invalid.length} invalid entr${invalid.length === 1 ? 'y' : 'ies'} (not added)`;
  const invFrag = document.createDocumentFragment();
  invalid.forEach((i) => {
    const li = document.createElement('li');
    li.textContent = `${i.name ? `${i.name}: ` : ''}${i.raw || '(empty)'} — ${i.reason}`;
    invFrag.append(li);
  });
  $('rcp-invalid-list').replaceChildren(invFrag);
}

function removeRecipient(key) {
  state.list = state.list.filter((r) => r.key !== key);
  save();
  render();
}

function onClearAll() {
  if (!confirm(`Remove all ${state.list.length} recipients?`)) return;
  state.list = [];
  state.invalid = [];
  showSummary('');
  save();
  render();
}

function onClearInvalid() {
  state.invalid = [];
  save();
  render();
}

/* ---------- Init ---------- */

/** Wires up the Recipients tab and restores the saved draft. */
export async function initRecipients() {
  // Pasted numbers are added immediately; typed ones when the box loses focus.
  $('rcp-paste').addEventListener('paste', () => setTimeout(addFromPasteBox, 0));
  $('rcp-paste').addEventListener('blur', addFromPasteBox);
  $('rcp-import').addEventListener('click', () => $('rcp-file').click());
  $('rcp-file').addEventListener('change', onFileChosen);
  $('map-sheet').addEventListener('change', (e) => {
    readSheet(e.target.value);
    renderMapping();
  });
  $('map-phone').addEventListener('change', updateVarHint);
  $('map-name').addEventListener('change', updateVarHint);
  $('map-import').addEventListener('click', onImportConfirm);
  $('map-cancel').addEventListener('click', closeImport);
  document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('picker-refresh').addEventListener('click', () => {
    if (mode === 'groups' || mode === 'contacts') showSource(mode, true);
  });
  $('rcp-clear').addEventListener('click', onClearAll);
  $('rcp-invalid-clear').addEventListener('click', onClearInvalid);
  $('rcp-save-list').addEventListener('click', onSaveList);
  $('lists-load').addEventListener('click', onLoadList);
  $('lists-delete').addEventListener('click', onDeleteList);

  await Promise.all([load(), loadSavedLists()]);
  render();
  renderSavedLists();
}
