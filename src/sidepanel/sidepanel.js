/**
 * Side panel entry: tab switching and the connection status header.
 */
import { MSG, CONN } from '../shared/messages.js';
import { STATUS_POLL_MS, WHATSAPP_URL_PATTERN, log } from '../shared/config.js';

/* ---------- Tabs ---------- */

function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
    });
  });
}

/* ---------- Connection status ---------- */

/** How each connection state is shown: pill text, pill style, button label. */
const STATUS_VIEW = {
  [CONN.NO_TAB]: { text: 'Open WhatsApp Web', style: 'pill-warn', button: 'Open WhatsApp' },
  [CONN.NEEDS_RELOAD]: { text: 'Reload WhatsApp tab', style: 'pill-warn', button: 'Reload tab' },
  [CONN.LOADING]: { text: 'Loading…', style: 'pill-muted', button: 'Go to WhatsApp' },
  [CONN.LOGGED_OUT]: { text: 'Not logged in', style: 'pill-warn', button: 'Go to WhatsApp' },
  [CONN.ENGINE_ERROR]: { text: 'Engine not ready', style: 'pill-err', button: 'Go to WhatsApp' },
  [CONN.CONNECTED]: { text: 'Connected', style: 'pill-ok', button: 'Go to WhatsApp' },
};

const DETAIL_TEXT = {
  [CONN.NO_TAB]: 'No WhatsApp Web tab is open.',
  [CONN.NEEDS_RELOAD]: 'Reload WhatsApp Web once so the extension can attach.',
  [CONN.LOADING]: 'WhatsApp Web is starting…',
  [CONN.LOGGED_OUT]: 'Scan the QR code in WhatsApp Web to log in.',
};

/** Last known state, used by the header button. */
let current = { state: null, tabId: null };

/**
 * Finds the WhatsApp tab and asks its content script for status.
 * @returns {Promise<{state: string, tabId: number|null, me?: string, error?: string}>}
 */
async function fetchStatus() {
  const [tab] = await chrome.tabs.query({ url: WHATSAPP_URL_PATTERN });
  if (!tab) return { state: CONN.NO_TAB, tabId: null };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATUS });
    return { ...res, tabId: tab.id };
  } catch {
    // "Receiving end does not exist": the tab was open before the extension was (re)loaded.
    return { state: CONN.NEEDS_RELOAD, tabId: tab.id };
  }
}

/**
 * Renders the header for a status result.
 * @param {{state: string, me?: string, error?: string}} status
 */
function renderStatus(status) {
  const view = STATUS_VIEW[status.state] ?? STATUS_VIEW[CONN.ENGINE_ERROR];
  const pill = document.getElementById('status-pill');
  pill.textContent = view.text;
  pill.className = `pill ${view.style}`;

  document.getElementById('wa-button').textContent = view.button;

  let detail = DETAIL_TEXT[status.state] ?? '';
  if (status.state === CONN.CONNECTED && status.me) detail = `Logged in as +${status.me.split('@')[0]}`;
  if (status.state === CONN.ENGINE_ERROR) detail = status.error || 'WhatsApp engine not ready — update WA-JS.';
  document.getElementById('status-detail').textContent = detail;
}

async function refreshStatus() {
  try {
    current = await fetchStatus();
  } catch (err) {
    log('status check failed', err);
    current = { state: CONN.ENGINE_ERROR, tabId: null, error: err.message };
  }
  renderStatus(current);
}

async function onWhatsAppButton() {
  if (current.state === CONN.NEEDS_RELOAD && current.tabId != null) {
    await chrome.tabs.reload(current.tabId);
  }
  await chrome.runtime.sendMessage({ type: MSG.OPEN_WHATSAPP });
  setTimeout(refreshStatus, 1_000);
}

/* ---------- Init ---------- */

initTabs();
document.getElementById('wa-button').addEventListener('click', onWhatsAppButton);
refreshStatus();
setInterval(refreshStatus, STATUS_POLL_MS);
