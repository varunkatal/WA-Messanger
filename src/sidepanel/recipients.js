/**
 * Recipients tab: paste/typed numbers, CSV/Excel import with column mapping,
 * contact and group pickers, and the final recipient list (persisted as a draft).
 *
 * XLSX is the SheetJS global, loaded by a classic <script> in sidepanel.html.
 */
import { MSG } from '../shared/messages.js';
import { normalizePhone, splitNameAndPhone } from '../shared/phone.js';
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

function onPasteAdd() {
  const text = $('rcp-paste').value;
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(splitNameAndPhone);
  if (!rows.length) return;
  commit(addRawRows(rows));
  $('rcp-paste').value = '';
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

/* ---------- Contact / group pickers ---------- */

/**
 * Opens the picker overlay.
 * @param {string} title
 * @param {{id: string, label: string, sub: string}[]} items
 * @param {(ids: Set<string>) => void} onAdd
 */
function openPicker(title, items, onAdd) {
  const selected = new Set();
  const listEl = $('picker-list');
  const search = $('picker-search');
  const selectAll = $('picker-all');
  const addBtn = $('picker-add');

  $('picker-title').textContent = title;
  search.value = '';

  const visible = () => {
    const q = search.value.trim().toLowerCase();
    return q ? items.filter((it) => `${it.label} ${it.sub}`.toLowerCase().includes(q)) : items;
  };

  const updateFooter = () => {
    addBtn.textContent = `Add ${selected.size} selected`;
    addBtn.disabled = selected.size === 0;
    const vis = visible();
    selectAll.checked = vis.length > 0 && vis.every((it) => selected.has(it.id));
  };

  const renderList = () => {
    const frag = document.createDocumentFragment();
    for (const it of visible()) {
      const row = document.createElement('label');
      row.className = 'picker-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(it.id);
      cb.addEventListener('change', () => {
        cb.checked ? selected.add(it.id) : selected.delete(it.id);
        updateFooter();
      });
      const text = document.createElement('span');
      text.className = 'picker-text';
      const label = document.createElement('span');
      label.textContent = it.label;
      const sub = document.createElement('small');
      sub.textContent = it.sub;
      text.append(label, sub);
      row.append(cb, text);
      frag.append(row);
    }
    listEl.replaceChildren(frag);
    if (!listEl.children.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = items.length ? 'No matches.' : 'Nothing found.';
      listEl.append(empty);
    }
    updateFooter();
  };

  search.oninput = renderList;
  selectAll.onchange = () => {
    for (const it of visible()) selectAll.checked ? selected.add(it.id) : selected.delete(it.id);
    renderList();
  };
  addBtn.onclick = () => {
    onAdd(selected);
    closePicker();
  };

  renderList();
  $('picker').hidden = false;
  search.focus();
}

function closePicker() {
  $('picker').hidden = true;
  $('picker-list').replaceChildren();
}

/**
 * Loads a list from WhatsApp with a busy state on the button.
 * @param {HTMLButtonElement} btn
 * @param {string} type MSG type
 */
async function fetchList(btn, type) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    return await sendToWhatsApp(type);
  } catch (err) {
    showSummary(err.message, 'err');
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function onPickContacts(event) {
  const contacts = await fetchList(event.currentTarget, MSG.LIST_CONTACTS);
  if (!contacts) return;
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const items = contacts
    .map((c) => ({ id: c.id, label: c.name || (c.number ? `+${c.number}` : c.id), sub: c.number ? `+${c.number}` : 'Number hidden' }))
    .sort((a, b) => a.label.localeCompare(b.label));
  openPicker('Pick contacts', items, (ids) => {
    const picked = [...ids].map((id) => {
      const c = byId.get(id);
      return {
        key: c.number ? `n:${c.number}` : `id:${c.id}`,
        kind: 'contact',
        chatId: c.id,
        number: c.number,
        name: c.name,
        vars: { name: c.name },
      };
    });
    commit(addRecipients(picked));
  });
}

async function onPickGroups(event) {
  const groups = await fetchList(event.currentTarget, MSG.LIST_GROUPS);
  if (!groups) return;
  const byId = new Map(groups.map((g) => [g.id, g]));
  const items = groups
    .map((g) => ({
      id: g.id,
      label: g.name || 'Unnamed group',
      sub: g.participantsCount != null ? `${g.participantsCount} members` : 'Group',
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  openPicker('Pick groups', items, (ids) => {
    const picked = [...ids].map((id) => {
      const g = byId.get(id);
      return { key: `id:${g.id}`, kind: 'group', chatId: g.id, number: null, name: g.name, vars: { name: g.name } };
    });
    commit(addRecipients(picked));
  });
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

  const body = $('rcp-rows');
  const frag = document.createDocumentFragment();
  list.forEach((r) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = r.name || '—';
    const detail = document.createElement('td');
    detail.className = 'muted';
    detail.textContent = r.kind === 'group' ? 'Group' : r.number ? `+${r.number}` : 'Contact';
    const action = document.createElement('td');
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'icon-btn';
    rm.title = 'Remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => removeRecipient(r.key));
    action.append(rm);
    tr.append(name, detail, action);
    frag.append(tr);
  });
  body.replaceChildren(frag);
  $('rcp-table').hidden = list.length === 0;
  $('rcp-empty').hidden = list.length > 0;

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
  $('rcp-paste-add').addEventListener('click', onPasteAdd);
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
  $('rcp-contacts').addEventListener('click', onPickContacts);
  $('rcp-groups').addEventListener('click', onPickGroups);
  $('picker-cancel').addEventListener('click', closePicker);
  $('rcp-clear').addEventListener('click', onClearAll);
  $('rcp-invalid-clear').addEventListener('click', onClearInvalid);

  await load();
  render();
}
