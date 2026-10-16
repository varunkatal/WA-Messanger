/**
 * Reports tab: campaign history with per-recipient status, CSV export,
 * retry failed / unsent, and delete.
 *
 * XLSX is the SheetJS global, loaded by a classic <script> in sidepanel.html.
 */
import { CAMPAIGN_DEFAULTS, log } from '../shared/config.js';
import { KEYS, getLocal, setLocal, campaignKey, removeMediaData } from '../shared/storage.js';
import { STATE_VIEW, countStatuses, startCampaign } from './campaign.js';

const $ = (id) => document.getElementById(id);

/** Campaign ids whose details are expanded (kept across re-renders). */
const expanded = new Set();

const STATUS_TEXT = { sent: '✓ Sent', failed: '✕ Failed', skipped: '⤼ Not on WhatsApp', pending: '… Not sent' };

const fmtDateTime = (t) =>
  t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

/** @returns {Promise<object[]>} all campaigns, newest first */
async function loadCampaigns() {
  const index = await getLocal(KEYS.CAMPAIGN_INDEX, []);
  if (!index.length) return [];
  const data = await chrome.storage.local.get(index.map(campaignKey));
  return index.map((id) => data[campaignKey(id)]).filter(Boolean).reverse();
}

/* ---------- Actions ---------- */

/** Downloads one campaign's per-recipient results as CSV. */
function exportCsv(c) {
  const rows = c.recipients.map((r) => ({
    Name: r.name || '',
    Number: r.number ? `+${r.number}` : '',
    Type: r.kind,
    Status: r.status,
    Error: r.error || '',
    'Sent at': r.sentAt ? new Date(r.sentAt).toLocaleString('en-IN') : '',
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Report');
  const safeName = c.name.replace(/[^\w\- ]+/g, '').trim() || 'campaign';
  XLSX.writeFile(wb, `${safeName} report.csv`, { bookType: 'csv' });
}

/** Starts a new campaign with the same message for recipients that failed or were never sent. */
async function retry(c) {
  const again = c.recipients
    .filter((r) => r.status === 'failed' || r.status === 'pending')
    .map(({ key, kind, chatId, number, name, vars }) => ({ key, kind, chatId, number, name, vars }));
  const settings = { ...CAMPAIGN_DEFAULTS, ...(await getLocal(KEYS.SETTINGS, {})) };
  try {
    const started = await startCampaign({ name: `${c.name} (retry)`, recipients: again, message: c.message, settings });
    if (started) document.querySelector('.tab[data-tab="send"]').click();
  } catch (err) {
    alert(err.message);
  }
}

/** Deletes a campaign, plus attachment files no other campaign uses. */
async function remove(c) {
  if (c.state === 'running' || c.state === 'paused') {
    alert('Stop this campaign first (Send tab).');
    return;
  }
  if (!confirm(`Delete "${c.name}" from history?`)) return;
  const index = (await getLocal(KEYS.CAMPAIGN_INDEX, [])).filter((id) => id !== c.id);
  const others = index.length ? Object.values(await chrome.storage.local.get(index.map(campaignKey))) : [];
  const stillUsed = new Set(others.flatMap((o) => o.message.attachments.map((a) => a.id)));
  const orphanMedia = c.message.attachments.filter((a) => !stillUsed.has(a.id)).map((a) => a.id);
  await chrome.storage.local.remove(campaignKey(c.id));
  await removeMediaData(orphanMedia);
  await setLocal(KEYS.CAMPAIGN_INDEX, index);
  if ((await getLocal(KEYS.ACTIVE_CAMPAIGN, null)) === c.id) await chrome.storage.local.remove(KEYS.ACTIVE_CAMPAIGN);
  expanded.delete(c.id);
}

/* ---------- Rendering ---------- */

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function button(text, onClick, className = 'btn btn-small btn-secondary') {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function detailsTable(c) {
  const table = el('table', 'table report-table');
  const body = el('tbody');
  for (const r of c.recipients) {
    const tr = el('tr', `st-${r.status}`);
    tr.append(
      el('td', null, r.name || (r.number ? `+${r.number}` : '—')),
      el('td', 'muted', r.kind === 'group' ? 'Group' : r.number ? `+${r.number}` : 'Contact'),
      el('td', null, STATUS_TEXT[r.status] ?? r.status)
    );
    if (r.error && r.status !== 'skipped') tr.title = r.error;
    body.append(tr);
  }
  table.append(body);
  return table;
}

function campaignCard(c) {
  const n = countStatuses(c);
  const view = STATE_VIEW[c.state] ?? STATE_VIEW.stopped;
  const card = el('div', 'card');

  const head = el('div', 'row-between');
  const pill = el('span', `pill ${view.style}`, view.text);
  head.append(el('strong', null, c.name), pill);

  const meta = el('div', 'muted small', `${fmtDateTime(c.startedAt || c.createdAt)} · ${n.total} recipients`);
  const counts = el('div', 'small', `✓ ${n.sent} sent · ✕ ${n.failed} failed · ⤼ ${n.skipped} skipped · ${n.pending} not sent`);

  const actions = el('div', 'row wrap');
  const isOpen = expanded.has(c.id);
  actions.append(
    button(isOpen ? 'Hide details' : 'Details', () => {
      isOpen ? expanded.delete(c.id) : expanded.add(c.id);
      render();
    }),
    button('Export CSV', () => exportCsv(c))
  );
  const retryable = n.failed + (c.state === 'running' || c.state === 'paused' ? 0 : n.pending);
  if (retryable) actions.append(button(`Retry ${retryable} failed / unsent`, () => retry(c), 'btn btn-small'));
  actions.append(button('Delete', () => remove(c), 'link-btn small'));

  card.append(head, meta, counts, actions);
  if (isOpen) card.append(detailsTable(c));
  return card;
}

async function render() {
  try {
    const campaigns = await loadCampaigns();
    $('rp-empty').hidden = campaigns.length > 0;
    $('rp-list').replaceChildren(...campaigns.map(campaignCard));
  } catch (err) {
    log('rendering reports failed', err);
  }
}

/* ---------- Init ---------- */

let renderQueued = false;
/** Batches the many per-recipient storage writes into one re-render per second. */
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 1_000);
}

/** Wires up the Reports tab. */
export async function initReports() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k === KEYS.CAMPAIGN_INDEX || k.startsWith(campaignKey('')))) queueRender();
  });
  await render();
}
