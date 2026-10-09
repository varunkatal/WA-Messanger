/**
 * ISOLATED-world content script on web.whatsapp.com.
 * Talks to the side panel (chrome messaging) and to the MAIN-world bridge
 * (window.postMessage), and runs the campaign queue, so a campaign keeps
 * going when the side panel is closed.
 *
 * Content scripts can't be ES modules, so shared modules are loaded with
 * dynamic import() (they are listed in web_accessible_resources).
 */
(() => {
  const modulesReady = Promise.all([
    import(chrome.runtime.getURL('src/shared/messages.js')),
    import(chrome.runtime.getURL('src/shared/config.js')),
    import(chrome.runtime.getURL('src/shared/storage.js')),
    import(chrome.runtime.getURL('src/shared/template.js')),
  ]).then((mods) => Object.assign({}, ...mods));

  /** Pending bridge requests: id → {resolve, reject, timer}. */
  const pending = new Map();
  let nextId = 1;
  let sourceBridge = null; // set once modules load; no request is pending before that
  modulesReady.then((m) => { sourceBridge = m.SOURCE_BRIDGE; });

  /**
   * Sends a command to the MAIN-world bridge and waits for its reply.
   * @param {string} cmd  one of BRIDGE_CMD
   * @param {any[]} [args]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} the bridge result
   */
  async function callBridge(cmd, args = [], timeoutMs) {
    const { SOURCE_EXT, TIMEOUTS } = await modulesReady;
    const id = `${Date.now()}-${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`WhatsApp did not respond to "${cmd}" in time.`));
      }, timeoutMs ?? TIMEOUTS.bridgeDefault);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: SOURCE_EXT, id, cmd, args }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    // Cheap check first: WhatsApp posts lots of its own messages.
    if (!data || data.source !== sourceBridge) return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || 'Unknown bridge error'));
  });

  /**
   * Asks the bridge for status and maps it to a CONN state for the side panel.
   * @returns {Promise<{state: string, me?: string, error?: string}>}
   */
  async function getStatus() {
    const { BRIDGE_CMD, CONN } = await modulesReady;
    try {
      const s = await callBridge(BRIDGE_CMD.STATUS, [], 5_000);
      if (s.engineTimedOut) {
        return { state: CONN.ENGINE_ERROR, error: 'WhatsApp engine not ready — update WA-JS.' };
      }
      if (!s.loaded) return { state: CONN.LOADING };
      if (!s.authenticated) return { state: CONN.LOGGED_OUT };
      if (!s.ready) return { state: CONN.LOADING };
      return { state: CONN.CONNECTED, me: s.me };
    } catch (err) {
      return { state: CONN.ENGINE_ERROR, error: err.message };
    }
  }

  /**
   * Wraps a promise's outcome as {ok, result | error} for sendResponse.
   * @param {Promise<any>} promise
   */
  async function wrap(promise) {
    try {
      return { ok: true, result: await promise };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /* ---------- Sending ---------- */

  /**
   * Sends one message part (see template.js buildParts) to a chat.
   * File parts must carry `dataUrl`.
   * @param {string} chatId
   * @param {{kind: 'text', text: string} | {kind: 'file', dataUrl: string, type: string, filename: string, mimetype: string, caption: string}} part
   */
  async function sendPart(chatId, part) {
    const { BRIDGE_CMD, TIMEOUTS } = await modulesReady;
    if (part.kind === 'text') {
      return callBridge(BRIDGE_CMD.SEND_TEXT, [chatId, part.text], TIMEOUTS.bridgeMedia);
    }
    const opts = { type: part.type, filename: part.filename, mimetype: part.mimetype };
    if (part.caption) opts.caption = part.caption;
    return callBridge(BRIDGE_CMD.SEND_FILE, [chatId, part.dataUrl, opts], TIMEOUTS.bridgeMedia);
  }

  /** "Send test to myself": sends one part to the logged-in user's own chat. */
  async function sendTestPart(part) {
    const { BRIDGE_CMD } = await modulesReady;
    const s = await callBridge(BRIDGE_CMD.STATUS, [], 5_000);
    if (!s.me) throw new Error('Log in to WhatsApp Web first.');
    return sendPart(s.me, part);
  }

  /* ---------- Campaign runner ---------- */

  /** The campaign object being run (source of truth while running), or null. */
  let campaign = null;
  /** True while the send loop is executing. */
  let looping = false;
  /** Cancels the current delay early (pause/stop). */
  let wakeUp = null;
  /** mediaId → data URL, read from chrome.storage once per page load. */
  const mediaCache = new Map();

  const randomBetween = (min, max) => min + Math.random() * (max - min);

  /** Waits ms, unless pause/stop wakes it early. */
  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wakeUp = null;
        resolve();
      }
      wakeUp = done;
    });
  }

  async function loadCampaign(id) {
    const { campaignKey, getLocal } = await modulesReady;
    return getLocal(campaignKey(id), null);
  }

  async function saveCampaign() {
    const { campaignKey, setLocal, log } = await modulesReady;
    try {
      await setLocal(campaignKey(campaign.id), campaign);
    } catch (err) {
      log('saving campaign failed', err);
    }
  }

  /** Adds a line to the campaign's live log (kept short). */
  async function addLog(text, tone = 'info') {
    const { CAMPAIGN_LOG_MAX } = await modulesReady;
    campaign.log.push({ t: Date.now(), text, tone });
    if (campaign.log.length > CAMPAIGN_LOG_MAX) campaign.log.splice(0, campaign.log.length - CAMPAIGN_LOG_MAX);
  }

  async function getMediaDataUrl(mediaId) {
    if (mediaCache.has(mediaId)) return mediaCache.get(mediaId);
    const { mediaKey, getLocal } = await modulesReady;
    const dataUrl = await getLocal(mediaKey(mediaId), null);
    if (!dataUrl) throw new Error('Attachment file is missing — start a new campaign.');
    mediaCache.set(mediaId, dataUrl);
    return dataUrl;
  }

  /** Recipients sent today (IST) across all campaigns. */
  async function getDailyCount() {
    const { KEYS, getLocal, istDate } = await modulesReady;
    const d = await getLocal(KEYS.DAILY_COUNT, null);
    return d?.date === istDate() ? d.count : 0;
  }

  async function bumpDailyCount() {
    const { KEYS, setLocal, istDate } = await modulesReady;
    await setLocal(KEYS.DAILY_COUNT, { date: istDate(), count: (await getDailyCount()) + 1 });
  }

  const label = (r) => r.name || (r.number ? `+${r.number}` : 'recipient');

  /**
   * Sends the campaign message to one recipient.
   * @returns {Promise<'sent'|'skipped'>}
   */
  async function sendToRecipient(r) {
    const { BRIDGE_CMD, buildParts } = await modulesReady;
    let chatId = r.chatId;
    if (r.kind === 'number' && campaign.settings.checkBeforeSend) {
      const wid = await callBridge(BRIDGE_CMD.CHECK_NUMBER, [r.number]);
      if (!wid) return 'skipped';
      chatId = wid;
    }
    const parts = buildParts(campaign.message, r.vars || {});
    if (!parts.length) throw new Error('Message is empty for this recipient.');
    for (const part of parts) {
      const full = part.kind === 'file' ? { ...part, dataUrl: await getMediaDataUrl(part.mediaId) } : part;
      await sendPart(chatId, full);
    }
    return 'sent';
  }

  /** Pauses the running campaign with a reason shown in the side panel. */
  async function pauseWith(reason, tone = 'warn') {
    campaign.state = 'paused';
    campaign.pauseReason = reason;
    campaign.nextAt = null;
    await addLog(reason, tone);
  }

  /**
   * The send loop. Takes the next pending recipient, sends, persists after every
   * recipient, then waits a random delay (or a longer pause after each batch).
   */
  async function runLoop() {
    if (looping || !campaign) return;
    looping = true;
    const s = campaign.settings;
    try {
      while (campaign.state === 'running') {
        const r = campaign.recipients.find((x) => x.status === 'pending');
        if (!r) {
          campaign.state = 'done';
          campaign.finishedAt = Date.now();
          campaign.nextAt = null;
          await addLog('Campaign finished.', 'ok');
          break;
        }
        if ((await getDailyCount()) >= s.dailyCap) {
          await pauseWith(`Daily limit of ${s.dailyCap} reached. Resume tomorrow (resets at midnight IST).`);
          break;
        }

        campaign.nextAt = null;
        campaign.current = r.key;
        await saveCampaign();

        let outcome;
        try {
          outcome = await sendToRecipient(r);
        } catch (err) {
          outcome = 'failed';
          r.error = err.message;
        }
        campaign.current = null;

        if (outcome === 'sent') {
          r.status = 'sent';
          r.sentAt = Date.now();
          r.error = null;
          campaign.consecutiveFailures = 0;
          campaign.batchCount = (campaign.batchCount || 0) + 1;
          await bumpDailyCount();
          await addLog(`Sent to ${label(r)}`, 'ok');
        } else if (outcome === 'skipped') {
          r.status = 'skipped';
          r.error = 'Not on WhatsApp';
          await addLog(`Skipped +${r.number}: not on WhatsApp`, 'warn');
        } else {
          r.status = 'failed';
          campaign.consecutiveFailures = (campaign.consecutiveFailures || 0) + 1;
          await addLog(`Failed: ${label(r)} — ${r.error}`, 'err');
          if (campaign.consecutiveFailures >= s.maxConsecutiveFailures) {
            await pauseWith(`Paused after ${campaign.consecutiveFailures} failures in a row. Check WhatsApp, then Resume.`, 'err');
          }
        }
        await saveCampaign();

        if (campaign.state !== 'running' || !campaign.recipients.some((x) => x.status === 'pending')) continue;

        // Wait before the next recipient.
        let waitSec;
        if (outcome === 'skipped') {
          waitSec = randomBetween(2, 4); // nothing was sent; a short gap is enough
        } else if (campaign.batchCount >= s.batchSize) {
          campaign.batchCount = 0;
          waitSec = randomBetween(s.batchPauseMinSec, s.batchPauseMaxSec);
          const pauseText = waitSec >= 90 ? `${Math.round(waitSec / 60)} min` : `${Math.round(waitSec)} s`;
          await addLog(`Batch of ${s.batchSize} done — pausing ${pauseText}.`);
        } else {
          waitSec = randomBetween(s.delayMinSec, s.delayMaxSec);
        }
        campaign.nextAt = Date.now() + waitSec * 1000;
        await saveCampaign();
        await sleep(waitSec * 1000);
      }
    } finally {
      looping = false;
      campaign.nextAt = null;
      await saveCampaign();
    }
  }

  /** Loads a campaign from storage (written by the side panel) and starts it. */
  async function startCampaign(id) {
    if (campaign && (campaign.state === 'running' || looping)) {
      throw new Error('Another campaign is running. Stop it first.');
    }
    const c = await loadCampaign(id);
    if (!c) throw new Error('Campaign not found.');
    campaign = c;
    campaign.state = 'running';
    campaign.startedAt ??= Date.now();
    await addLog(`Started: ${campaign.recipients.length} recipients.`);
    runLoop();
  }

  /**
   * Pause / resume / stop. Pause and stop take effect between messages and
   * cancel the current delay.
   */
  async function controlCampaign(id, action) {
    if (!campaign || campaign.id !== id) {
      campaign = await loadCampaign(id);
      if (!campaign) throw new Error('Campaign not found.');
    }
    if (action === 'resume') {
      if (campaign.state !== 'paused') throw new Error('Only a paused campaign can be resumed.');
      campaign.state = 'running';
      campaign.pauseReason = null;
      campaign.consecutiveFailures = 0;
      await addLog('Resumed.');
      await saveCampaign();
      runLoop();
      return;
    }
    if (campaign.state !== 'running' && campaign.state !== 'paused') return;
    if (action === 'pause') {
      if (campaign.state !== 'running') return;
      await pauseWith('Paused.', 'info');
    } else {
      campaign.state = 'stopped';
      campaign.finishedAt = Date.now();
      campaign.nextAt = null;
      await addLog('Stopped. Unsent recipients stay "pending" (retry them from Reports).', 'warn');
    }
    wakeUp?.();
    await saveCampaign();
  }

  /** On page load a "running" campaign can't still be running: show it as paused. */
  async function recoverAfterReload() {
    const { KEYS, getLocal } = await modulesReady;
    const id = await getLocal(KEYS.ACTIVE_CAMPAIGN, null);
    if (!id) return;
    const c = await loadCampaign(id);
    if (c?.state !== 'running') return;
    campaign = c;
    campaign.current = null;
    await pauseWith('WhatsApp Web was reloaded — press Resume to continue.');
    await saveCampaign();
  }

  /* ---------- Messages from the side panel ---------- */

  // Registered synchronously so early messages from the side panel aren't lost.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    modulesReady.then(({ MSG, BRIDGE_CMD }) => {
      const id = msg?.payload?.id;
      switch (msg?.type) {
        case MSG.GET_STATUS:
          getStatus().then(sendResponse);
          break;
        case MSG.LIST_CONTACTS:
          wrap(callBridge(BRIDGE_CMD.LIST_CONTACTS)).then(sendResponse);
          break;
        case MSG.LIST_GROUPS:
          wrap(callBridge(BRIDGE_CMD.LIST_GROUPS)).then(sendResponse);
          break;
        case MSG.SEND_TEST:
          wrap(sendTestPart(msg.payload)).then(sendResponse);
          break;
        case MSG.CAMPAIGN_START:
          wrap(startCampaign(id)).then(sendResponse);
          break;
        case MSG.CAMPAIGN_PAUSE:
          wrap(controlCampaign(id, 'pause')).then(sendResponse);
          break;
        case MSG.CAMPAIGN_RESUME:
          wrap(controlCampaign(id, 'resume')).then(sendResponse);
          break;
        case MSG.CAMPAIGN_STOP:
          wrap(controlCampaign(id, 'stop')).then(sendResponse);
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
      }
    });
    return true;
  });

  modulesReady.then(({ log }) => {
    log('content script loaded');
    recoverAfterReload().catch((err) => log('recover failed', err));
  });
})();
