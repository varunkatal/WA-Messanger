/**
 * Send section (bottom of the Send tab): "More options" settings, the Send
 * button, then pause / resume / stop, progress and live log while it runs.
 * The queue itself runs in the content script (so it survives closing the
 * side panel); this file creates the campaign in storage, sends commands,
 * and re-renders from storage changes.
 */
import { MSG } from '../shared/messages.js';
import { CAMPAIGN_DEFAULTS, SAFETY_WARN, log } from '../shared/config.js';
import { KEYS, getLocal, setLocal, campaignKey, mediaKey, istDate } from '../shared/storage.js';
import { buildParts } from '../shared/template.js';
import { getRecipients } from './recipients.js';
import { getMessage, getDataUrl } from './composer.js';
import { sendToWhatsApp } from './whatsapp.js';

const $ = (id) => document.getElementById(id);

/** @type {typeof CAMPAIGN_DEFAULTS} */
let settings = { ...CAMPAIGN_DEFAULTS };
/** The campaign shown at the top of the Send tab. */
let active = null;

/* ---------- Shared helpers (also used by Reports) ---------- */

/**
 * @param {{recipients: {status: string}[]}} c
 * @returns {{total: number, sent: number, failed: number, skipped: number, pending: number}}
 */
export function countStatuses(c) {
  const n = { total: c.recipients.length, sent: 0, failed: 0, skipped: 0, pending: 0 };
  for (const r of c.recipients) n[r.status]++;
  return n;
}

export const STATE_VIEW = {
  running: { text: 'Running', style: 'pill-ok' },
  paused: { text: 'Paused', style: 'pill-warn' },
  stopped: { text: 'Stopped', style: 'pill-muted' },
  done: { text: 'Done', style: 'pill-ok' },
  pending: { text: 'Starting…', style: 'pill-muted' },
};

/**
 * "about 1 h 20 min"
 * @param {number} sec
 */
export function formatDuration(sec) {
  const min = Math.round(sec / 60);
  if (min < 1) return 'under a minute';
  if (min < 60) return `about ${min} min`;
  const h = Math.floor(min / 60);
  return `about ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

/**
 * Rough campaign duration: random delays between recipients, batch pauses,
 * plus a few seconds per send.
 * @param {number} n recipients
 * @param {typeof CAMPAIGN_DEFAULTS} s
 */
function estimateSeconds(n, s) {
  if (n <= 0) return 0;
  const gaps = n - 1;
  const batchPauses = Math.floor(gaps / s.batchSize);
  const avgDelay = (s.delayMinSec + s.delayMaxSec) / 2;
  const avgPause = (s.batchPauseMinSec + s.batchPauseMaxSec) / 2;
  return n * 3 + (gaps - batchPauses) * avgDelay + batchPauses * avgPause;
}

async function sentToday() {
  const d = await getLocal(KEYS.DAILY_COUNT, null);
  return d?.date === istDate() ? d.count : 0;
}

/* ---------- Settings ---------- */

/** Settings fields: input id → [settings key, multiplier from the field's unit to seconds]. */
const FIELDS = {
  'set-delay-min': ['delayMinSec', 1],
  'set-delay-max': ['delayMaxSec', 1],
  'set-batch': ['batchSize', 1],
  'set-pause-min': ['batchPauseMinSec', 60],
  'set-pause-max': ['batchPauseMaxSec', 60],
  'set-cap': ['dailyCap', 1],
};

function fillSettings() {
  for (const [id, [key, mult]] of Object.entries(FIELDS)) $(id).value = settings[key] / mult;
  $('set-check').checked = settings.checkBeforeSend;
}

/** Reads the fields, fixing impossible values (min > max, zero batch) quietly. */
function readSettings() {
  const s = { ...settings };
  for (const [id, [key, mult]] of Object.entries(FIELDS)) {
    const v = Number($(id).value);
    if (Number.isFinite(v) && v >= 0) s[key] = v * mult;
  }
  s.delayMinSec = Math.max(1, s.delayMinSec);
  s.delayMaxSec = Math.max(s.delayMinSec, s.delayMaxSec);
  s.batchSize = Math.max(1, Math.round(s.batchSize));
  s.batchPauseMaxSec = Math.max(s.batchPauseMinSec, s.batchPauseMaxSec);
  s.dailyCap = Math.max(1, Math.round(s.dailyCap));
  s.checkBeforeSend = $('set-check').checked;
  return s;
}

function onSettingsChange() {
  settings = readSettings();
  setLocal(KEYS.SETTINGS, settings).catch((err) => log('saving settings failed', err));
  renderSettingsSummary();
  renderSettingsWarnings();
  renderStartSummary();
}

/** One-line summary shown on the collapsed "More options" row. */
function renderSettingsSummary() {
  const s = settings;
  const pause = (sec) => (sec % 60 ? (sec / 60).toFixed(1) : sec / 60);
  $('set-summary').textContent =
    `Gap ${s.delayMinSec}–${s.delayMaxSec} s · batches of ${s.batchSize}, pause ${pause(s.batchPauseMinSec)}–${pause(s.batchPauseMaxSec)} min · max ${s.dailyCap}/day`;
}

function renderSettingsWarnings() {
  const lines = [];
  if (settings.delayMinSec < SAFETY_WARN.minDelaySec) {
    lines.push(`Delays under ${SAFETY_WARN.minDelaySec} s look like a bot and raise the risk of WhatsApp banning your number.`);
  }
  if (settings.dailyCap > SAFETY_WARN.maxDailyCap) {
    lines.push(`More than ${SAFETY_WARN.maxDailyCap} messages a day raises the ban risk.`);
  }
  $('set-warn').textContent = lines.join(' ');
  $('set-warn').hidden = lines.length === 0;
}

function onResetSettings() {
  settings = { ...CAMPAIGN_DEFAULTS };
  fillSettings();
  onSettingsChange();
}

/* ---------- Starting ---------- */

const isLive = (c) => c && (c.state === 'running' || c.state === 'paused' || c.state === 'pending');

async function renderStartSummary() {
  const n = getRecipients().length;
  const today = await sentToday();
  const left = Math.max(0, settings.dailyCap - today);
  const lines = [`${n} recipient${n === 1 ? '' : 's'} · ${n ? formatDuration(estimateSeconds(n, settings)) : '—'}`];
  lines.push(`Sent today: ${today} of ${settings.dailyCap}${n > left ? ` — only ${left} more today, then it pauses` : ''}`);
  $('cp-summary').textContent = lines.join('\n');
  const btn = $('cp-start');
  btn.disabled = isLive(active);
  btn.title = isLive(active) ? 'Stop or finish the current campaign first.' : '';
}

function showStartError(text) {
  $('cp-error').textContent = text;
  $('cp-error').hidden = !text;
}

/**
 * Creates a campaign in storage and tells the content script to run it.
 * Also used by Reports → "Retry".
 * @param {{name: string, recipients: object[], message: object, settings: object}} spec
 */
export async function startCampaign({ name, recipients, message, settings: s }) {
  if (isLive(active)) throw new Error('A campaign is already running or paused. Stop it first.');
  if (!recipients.length) throw new Error('Add recipients first.');
  if (!buildParts(message, {}, { keepMissing: true }).length) throw new Error('Write a message or add an attachment first.');

  const est = formatDuration(estimateSeconds(recipients.length, s));
  const left = Math.max(0, s.dailyCap - (await sentToday()));
  if (left === 0) throw new Error(`Today's limit of ${s.dailyCap} messages is used up. Try tomorrow or raise the daily limit.`);
  const files = message.attachments.length ? ` + ${message.attachments.length} attachment(s)` : '';
  const capNote = recipients.length > left ? `\n\nOnly ${left} can be sent today (daily limit); the rest will wait.` : '';
  if (!confirm(`Send to ${recipients.length} recipients${files}?\n\nEstimated time: ${est}.${capNote}\n\nKeep the WhatsApp Web tab open while it runs.`)) {
    return false;
  }

  // The content script can't read this page's IndexedDB, so attachments go to
  // chrome.storage as data URLs (once per file; retries reuse them).
  for (const a of message.attachments) {
    const key = mediaKey(a.id);
    if (!(await getLocal(key, null))) await setLocal(key, await getDataUrl(a.id));
  }

  const now = Date.now();
  const id = `c${now}`;
  const campaign = {
    id,
    name: name || new Date(now).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    recipients: recipients.map((r) => ({ ...r, status: 'pending', error: null, sentAt: null })),
    message,
    settings: { ...s },
    state: 'pending',
    pauseReason: null,
    batchCount: 0,
    consecutiveFailures: 0,
    current: null,
    nextAt: null,
    log: [],
  };
  const index = await getLocal(KEYS.CAMPAIGN_INDEX, []);
  await setLocal(campaignKey(id), campaign);
  await setLocal(KEYS.CAMPAIGN_INDEX, [...index, id]);
  await setLocal(KEYS.ACTIVE_CAMPAIGN, id);

  try {
    await sendToWhatsApp(MSG.CAMPAIGN_START, { id });
  } catch (err) {
    // Never started: remove it again so history only shows real campaigns.
    await chrome.storage.local.remove(campaignKey(id));
    await setLocal(KEYS.CAMPAIGN_INDEX, index);
    throw err;
  }
  return true;
}

async function onStart() {
  showStartError('');
  const btn = $('cp-start');
  btn.disabled = true;
  try {
    await startCampaign({
      name: $('cp-new-name').value.trim(),
      recipients: getRecipients(),
      message: getMessage(),
      settings: readSettings(),
    });
    $('cp-new-name').value = '';
  } catch (err) {
    showStartError(err.message);
  } finally {
    renderStartSummary();
  }
}

/* ---------- Controls ---------- */

/**
 * Pause / resume / stop through the content script. If the WhatsApp tab is
 * gone, pause and stop are applied to storage directly so the UI isn't stuck.
 */
async function control(type) {
  if (!active) return;
  showStartError('');
  try {
    await sendToWhatsApp(type, { id: active.id });
  } catch (err) {
    if (type === MSG.CAMPAIGN_RESUME) {
      showStartError(err.message);
      return;
    }
    const c = await getLocal(campaignKey(active.id), null);
    if (!c) return;
    c.state = type === MSG.CAMPAIGN_STOP ? 'stopped' : 'paused';
    c.pauseReason = c.state === 'paused' ? 'Paused (WhatsApp tab not reachable).' : null;
    c.nextAt = null;
    c.log.push({ t: Date.now(), text: c.state === 'stopped' ? 'Stopped.' : 'Paused.', tone: 'warn' });
    await setLocal(campaignKey(active.id), c);
  }
}

/* ---------- Progress view ---------- */

function statusLine(c) {
  if (c.state === 'paused') return c.pauseReason || 'Paused.';
  if (c.state === 'done') return `Finished ${new Date(c.finishedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.`;
  if (c.state === 'stopped') return 'Stopped.';
  if (c.state === 'pending') return 'Starting…';
  if (c.current) {
    const r = c.recipients.find((x) => x.key === c.current);
    return `Sending to ${r?.name || (r?.number ? `+${r.number}` : 'recipient')}…`;
  }
  if (c.nextAt) {
    const sec = Math.max(0, Math.round((c.nextAt - Date.now()) / 1000));
    return sec >= 90 ? `Batch pause — next message in ${Math.ceil(sec / 60)} min` : `Next message in ${sec} s`;
  }
  return 'Running…';
}

function renderCampaign() {
  const box = $('cp-box');
  box.hidden = !active;
  // While a campaign is live its progress card takes the Send button's place.
  $('send-box').hidden = isLive(active);
  if (!active) return;
  const c = active;
  const n = countStatuses(c);
  const done = n.total - n.pending;
  const view = STATE_VIEW[c.state] ?? STATE_VIEW.stopped;

  $('cp-name').textContent = c.name;
  $('cp-state').textContent = view.text;
  $('cp-state').className = `pill ${view.style}`;
  $('cp-bar').style.width = `${n.total ? (done / n.total) * 100 : 0}%`;
  $('cp-counts').textContent = `${done} / ${n.total} · ✓ ${n.sent} sent · ✕ ${n.failed} failed · ⤼ ${n.skipped} skipped`;
  $('cp-status').textContent = statusLine(c);
  $('cp-pause').hidden = c.state !== 'running';
  $('cp-resume').hidden = c.state !== 'paused';
  $('cp-stop').hidden = !(c.state === 'running' || c.state === 'paused');

  const items = c.log.slice(-50).reverse().map((l) => {
    const li = document.createElement('li');
    li.className = `log-${l.tone}`;
    const time = new Date(l.t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.textContent = `${time}  ${l.text}`;
    return li;
  });
  $('cp-log').replaceChildren(...items);
}

async function loadActive() {
  const id = await getLocal(KEYS.ACTIVE_CAMPAIGN, null);
  active = id ? await getLocal(campaignKey(id), null) : null;
  renderCampaign();
  renderStartSummary();
}

/* ---------- Init ---------- */

/** Wires up the Send tab. */
export async function initCampaign() {
  settings = { ...CAMPAIGN_DEFAULTS, ...(await getLocal(KEYS.SETTINGS, {})) };
  fillSettings();
  renderSettingsSummary();
  renderSettingsWarnings();
  for (const id of [...Object.keys(FIELDS), 'set-check']) $(id).addEventListener('change', onSettingsChange);
  $('set-reset').addEventListener('click', onResetSettings);
  $('cp-start').addEventListener('click', onStart);
  $('cp-pause').addEventListener('click', () => control(MSG.CAMPAIGN_PAUSE));
  $('cp-resume').addEventListener('click', () => control(MSG.CAMPAIGN_RESUME));
  $('cp-stop').addEventListener('click', () => {
    if (confirm('Stop this campaign? Unsent recipients can be retried later from Reports.')) control(MSG.CAMPAIGN_STOP);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[KEYS.ACTIVE_CAMPAIGN]) {
      loadActive();
      return;
    }
    if (active && changes[campaignKey(active.id)]) {
      active = changes[campaignKey(active.id)].newValue ?? null;
      renderCampaign();
      renderStartSummary();
    }
    if (changes[KEYS.RECIPIENTS_DRAFT] || changes[KEYS.DAILY_COUNT]) renderStartSummary();
  });

  // Countdown ("Next message in 12 s") ticks between storage updates.
  setInterval(() => {
    if (active?.state === 'running') $('cp-status').textContent = statusLine(active);
  }, 1_000);

  await loadActive();
}
