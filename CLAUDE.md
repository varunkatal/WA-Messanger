# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This file is the design spec; the phase plan is in `ROADMAP.md`. Phases 1–5 (connection, recipients, composer, campaign engine, reports) are built; Phase 6 (polish) is next. Vendored: WA-JS 4.8.2, SheetJS 0.20.3.

Implementation notes not obvious from the spec:
- `content.js` loads `src/shared/*.js` via dynamic `import(chrome.runtime.getURL(...))`, which is why those files are in `web_accessible_resources`. Its `onMessage` listener is registered synchronously and awaits the modules inside.
- Bridge readiness has two levels: `WPP.isReady` (modules hooked, also true on the QR login screen) and `WPP.isFullReady` (logged in, safe to send). Status uses the first to tell "not logged in" apart from "engine broken"; send commands wait for the second.
- Recipient draft is a list of `{key, kind, chatId, number, name, vars}` in `chrome.storage.local` (`KEYS.RECIPIENTS_DRAFT`). Dedupe key is `n:<number>` when a number is known, else `id:<chatId>`, so a picked contact and the same typed number collapse.
- Attachments: Blobs live in the side panel's IndexedDB (`wbs` / `media`). The content script can't read that origin, so on campaign start each file is copied once to `chrome.storage.local` as a data URL, chunked: `media:<id>` = `{chunks}`, parts at `media:<id>:<i>` (`putMediaData`/`getMediaData` in storage.js; old whole-string values still read). Send test stages files the same way and removes them after. Reports → Delete removes those no other campaign uses.
- Campaigns: each stored at `campaign:<id>`, ids listed in `KEYS.CAMPAIGN_INDEX`, the Send tab shows `KEYS.ACTIVE_CAMPAIGN`. The side panel only creates a campaign; after `CAMPAIGN_START` the content script owns it and writes it after every recipient. The panel re-renders from `storage.onChanged`.
- Voice notes: 🎙 records WebM/Opus with `MediaRecorder`; `src/shared/webm-to-ogg.js` re-boxes it as OGG/Opus (no re-encode), checked with `decodeAudioData`, then attached with `ptt: true` → sent with `isPtt` (WA-JS builds the waveform). The side panel can't show the mic prompt, so on `NotAllowedError` it opens `src/permission/mic.html` in a tab once. Converter can be tested by recording in headless Chrome with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
- Group export (Groups picker → ⬇ Export members): one .xlsx, columns `Group | Number | Name | WhatsApp name | Admin | Note`. Number must stay before "WhatsApp name" — the import's `guessColumn` takes the first header matching the phone pattern (which includes "whatsapp"). Groups already added as recipients stay tickable in Groups mode; "Add" counts only new ones. For records only — CLAUDE.md's out-of-scope rule on messaging scraped numbers still applies.
- Staying connected: the service worker sets `autoDiscardable: false` on WhatsApp tabs (Memory Saver would otherwise discard them and kill the runner). The bridge's 60 s engine timeout restarts when the tab becomes visible, since Chrome throttles background tabs. The header button reloads the tab in Engine-error / asleep / needs-reload states; it calls `chrome.tabs` directly from the panel (`showWhatsApp` in `whatsapp.js`), not via the service worker.
- Bridge sends use `markIsRead: false` so sending to a class group doesn't mark it read. WA-JS waits for the server ack by default.
- The runner can be exercised in Node with a fake `window`/`chrome` (load `content.js` via `new Function`), since its shared modules are plain ESM.
- Phone rules are covered by quick Node checks: `src/shared/phone.js` has no chrome APIs, so `node -e "import('./src/shared/phone.js').then(m => console.log(m.normalizePhone('09876543210')))"` works.

## Commands

There is no build step, package manager, linter or test runner (by design; see Tech stack).
- **Run/reload:** `chrome://extensions` → Developer mode → Load unpacked (select repo root) / click Reload after changes, then **reload the WhatsApp Web tab**.
- **Debug:** service worker console (from `chrome://extensions`) and the WhatsApp tab DevTools console (filter `[WBS]`).
- **Syntax check a file:** `node --check path/to/file.js`

## Project summary

A Manifest V3 Chrome extension that sends bulk WhatsApp messages through the user's own logged-in **WhatsApp Web** tab. Recipients can be phone numbers (typed, pasted, CSV/Excel), WhatsApp contacts, and WhatsApp groups. Messages can be text and/or images, videos, audio, recorded voice notes and documents, each with an optional caption (not audio). Text supports personalisation variables like `{name}`.

Owner: Varun (teacher, India). Main use: messaging students/parents and class groups. Default country code: **91**.

## How to work with me (important)

1. **Build phase by phase** following `ROADMAP.md`. Do not jump ahead. Finish a phase, then stop.
2. At the end of each phase, tell me: what was built, which files changed, and **exact steps to test it in Chrome** (`chrome://extensions` → Developer mode → Load unpacked / Reload).
3. **Explain briefly why** for any important decision — I want to understand the code, not just receive it.
4. Prefer **simple and working** over feature-rich and complex. If a feature adds a lot of complexity, ask first.
5. Keep configuration separate from logic (`src/shared/config.js`).
6. I test with real data early — make import tolerant of messy Excel files (extra spaces, `+91`, `0` prefix, empty rows, numbers stored as numbers/scientific notation).
7. I'm on a Mac with Chrome.

## Tech stack & constraints

- Manifest V3, plain JavaScript ES modules, HTML, CSS. **No build step, no frameworks, no npm runtime dependencies.**
- Vendor files (downloaded once, committed in `/vendor`):
  - `wppconnect-wa.js` — from `@wppconnect/wa-js` (`dist/wppconnect-wa.js`). Exposes global `WPP`.
  - `xlsx.full.min.js` — SheetJS, for CSV/XLSX import and CSV export.
- MV3 forbids remotely hosted code: **never load scripts from a CDN at runtime.**
- Chrome ≥ 114 (side panel API, `world: "MAIN"` content scripts).

## Folder structure

```
/manifest.json
/vendor/wppconnect-wa.js
/vendor/xlsx.full.min.js
/icons/16.png 48.png 128.png
/src/background/service-worker.js     # opens side panel, finds/opens WhatsApp tab, relays messages
/src/content/bridge-main.js           # MAIN world: waits for WPP, executes WPP calls, replies via postMessage
/src/content/content.js               # ISOLATED world: queue runner, talks to side panel + bridge
/src/sidepanel/sidepanel.html
/src/sidepanel/sidepanel.css
/src/sidepanel/sidepanel.js           # tab switching, state
/src/sidepanel/recipients.js          # manual entry, import, contacts/groups pickers
/src/sidepanel/composer.js            # text, variables, attachments, preview
/src/sidepanel/campaign.js            # settings, start/pause/resume/stop, progress
/src/sidepanel/reports.js             # history, export CSV, retry failed
/src/shared/config.js                 # defaults: country code, delays, limits, file sizes
/src/shared/phone.js                  # normalisation + validation
/src/shared/storage.js                # chrome.storage + IndexedDB helpers
/src/shared/messages.js               # message type constants for all messaging
/src/shared/template.js               # {variable} rendering, spintax (later)
```

## Architecture

### Three execution contexts
1. **Side panel** (extension page) — all UI. Holds media in IndexedDB (extension origin).
2. **Content script, ISOLATED world** (`content.js`, on `https://web.whatsapp.com/*`) — runs the campaign queue (so it keeps running even if the side panel is closed), persists progress, relays commands to the bridge.
3. **Content script, MAIN world** (`bridge-main.js` + `vendor/wppconnect-wa.js`) — only place that can access `WPP`. Pure executor: receives a command, calls WPP, returns result.

The service worker is thin: MV3 service workers get killed when idle, so **never keep campaign state only in the service worker.**

### manifest.json essentials
- `permissions`: `storage`, `sidePanel`, `tabs`, `unlimitedStorage`
- `host_permissions`: `https://web.whatsapp.com/*`
- `side_panel.default_path`: `src/sidepanel/sidepanel.html`
- `content_scripts`:
  - `{ matches: [web.whatsapp.com], js: [vendor/wppconnect-wa.js, src/content/bridge-main.js], world: "MAIN", run_at: "document_start" }`
  - `{ matches: [web.whatsapp.com], js: [src/content/content.js], run_at: "document_idle" }` (content scripts can't be ES modules; keep content.js self-contained or load shared helpers as plain scripts listed before it)
- Action click → open side panel (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`).

### Messaging protocol
- Side panel ⇄ content script: `chrome.tabs.sendMessage(whatsAppTabId, {type, payload})` and `chrome.runtime.sendMessage` back. Progress also written to `chrome.storage.local` so the panel can rebuild state via `storage.onChanged` after being reopened.
- Content script ⇄ bridge: `window.postMessage({source: "WBS_EXT", id, cmd, args}, "*")` → bridge replies `{source: "WBS_BRIDGE", id, ok, result | error}`. Use a request `id` and a promise map with a timeout (5 min for sends: big videos upload slowly). **Always check `event.source === window` and the `source` tag**; ignore everything else (WhatsApp posts its own messages).
- Define all `type`/`cmd` strings in `src/shared/messages.js` (and mirror them in the bridge, which can't import modules).

### Bridge commands (WA-JS)
Wait for readiness with `WPP.webpack.onReady(...)` / `WPP.isReady`, and check login with `WPP.conn.isAuthenticated()`. Commands:

| cmd | WA-JS call (verify signatures against the WA-JS docs for the vendored version) |
|---|---|
| `status` | `WPP.isReady`, `WPP.conn.isAuthenticated()`, `WPP.conn.getMyUserId()` |
| `listGroups` | `WPP.chat.list({ onlyGroups: true })` → `[{id, name, participantsCount}]` |
| `listContacts` | `WPP.contact.list({ onlyMyContacts: true })` → `[{id, name, number}]` |
| `groupMembers` | `WPP.group.getParticipants(groupId)`; `@lid` members → `WPP.contact.getPnLidEntry` (number only if WhatsApp has it locally, else `null`), names via `WPP.contact.get` → `[{id, number, name, pushname, isAdmin}]`, without me |
| `checkNumber` | `WPP.contact.queryExists(number + "@c.us")` → wid or null |
| `sendText` | `WPP.chat.sendTextMessage(chatId, text, { createChat: true })` |
| `sendFile` | `WPP.chat.sendFileMessage(chatId, dataUrl, { type, caption, filename, mimetype, createChat: true })` with `type` = `image` / `video` / `document` |

Return only plain serialisable data (ids as strings, `_serialized`), never WA model objects.

Chat IDs: individual = `<countrycode+number>@c.us`, group = `...@g.us`. **Do not hard-code the `@lid` / newer id formats** — always use the id returned by WPP for contacts/groups.

### Media handling
- User picks files in side panel → store `Blob` in IndexedDB with `{id, name, mime, size, caption}`.
- When sending, the side panel (or content script on request) converts to a data URL and passes it through messaging. Cache the data URL per campaign so each file is converted once.
- Limits in `config.js`: image 5 MB, video 50 MB, audio 16 MB, document 40 MB. Data URLs are ~33% bigger and one Chrome message tops out near 64 MB, so media goes through `chrome.storage` in 8 MB chunks, never as one message. Reject larger files with a clear message.
- Order per recipient: text message first (if any, and if no attachments carry the text), then each attachment with its caption. Option: "put text as caption of first attachment" (default ON — fewer messages).

### Phone normalisation (`phone.js`)
Strip spaces, dashes, brackets, `+`. Handle Excel numbers (`9.87654321E9`, `9876543210.0`). Leading `0` → drop. 10 digits → prefix `91`. `91` + 10 digits → keep. Otherwise mark invalid with a reason. Dedupe by final number (and groups by id).

### Campaign engine (`content.js`)
- Campaign object: `{id, name, createdAt, recipients:[{chatId, name, vars, kind:'number'|'contact'|'group', status:'pending'|'sent'|'failed'|'skipped', error, sentAt}], message:{text, attachments:[mediaId...], textAsCaption}, settings, cursor, state:'running'|'paused'|'stopped'|'done'}`.
- Loop: take next pending → (if number and `checkBeforeSend`) `checkNumber` → skip if not on WhatsApp → render template → send → update status → **persist to `chrome.storage.local` after every recipient** → wait random delay → batch pause every N.
- Defaults (`config.js`): delay 8–20 s random, batch 25 then pause 3–6 min, daily cap 200, stop after 5 consecutive failures.
- Daily count stored with date key (IST date) to enforce cap across campaigns.
- On page load, if a campaign is `running`, show it as **paused** and let the user resume (do not auto-resume silently).
- Pause/Stop take effect between messages, and also cancel the current delay timer.

### UI (side panel)
Tabs: **Send · Reports**. The Send tab is one screen in Premium Sender Pro's order: 1 · Recipients (Numbers / Groups / Contacts / Lists switch, selected recipients as chips) → 2 · Message (captions are multi-line with their own format bar) → More options (settings, collapsed) → Send button, replaced by the progress card while a campaign runs. Clean, compact, works at ~360 px width.
- Header: connection status pill (Connected / Open WhatsApp Web / Not logged in) + button to open/focus WhatsApp tab.
- Recipients: textarea for paste, file import with column mapping dropdowns, "Pick contacts", "Pick groups" (searchable checkbox lists with select-all), final table with counts (valid / invalid / duplicates removed) and remove buttons. Saved lists: save the current recipients under a name, load (merge + dedupe) or delete later (`KEYS.SAVED_LISTS`).
- Message: textarea, formatting buttons (bold / italic / strike / mono — wrap the selection in WhatsApp markers), saved templates dropdown (`KEYS.TEMPLATES`), clickable variable chips, attachment list with caption fields and thumbnails, preview card styled like a WhatsApp bubble, "Send test to myself".
- Send: settings fields, estimated time, Start / Pause / Resume / Stop, progress bar, live log.
- Reports: campaign history, export CSV, retry failed.
- Before starting any campaign: confirmation dialog showing recipient count and estimated duration.

## Coding conventions
- Small, readable functions; JSDoc comments on public functions.
- `async/await` everywhere; every bridge call wrapped in try/catch with a human-readable error.
- No `innerHTML` with user/imported data — use `textContent` (names come from Excel/WhatsApp).
- Logs prefixed `[WBS]`; a `DEBUG` flag in `config.js`.
- No analytics, no external network calls. All data stays local.

## Testing checklist (per phase)
- Reload extension at `chrome://extensions`, then **reload the WhatsApp Web tab** (content scripts only attach on page load).
- Test on own numbers and a private test group before any real list.
- Check the service worker console and the WhatsApp tab console (`[WBS]` logs).

## Known pitfalls
- WhatsApp Web updates can break WA-JS → keep it a single replaceable vendor file and show a clear "WhatsApp engine not ready — update WA-JS" error if `WPP` never becomes ready (timeout 60 s).
- Content scripts don't attach to an already-open tab after install — prompt user to reload WhatsApp Web.
- Side panel closing must not stop the campaign (runner lives in content script).
- Chrome messaging has a size limit (~64 MB); data URLs are ~33% bigger than the file — respect the media limits.
- Ban risk: never remove delays/limits for "speed". Warn in UI when the user sets delay < 5 s or daily cap > 300.

## Out of scope
- WhatsApp Business API / paid gateways
- Public Chrome Web Store listing (published as **Unlisted**, name "Bulk Sender"; privacy policy in `PRIVACY.md`). Each Store update needs a higher `version` and a new review, so urgent fixes go through Load unpacked first.
- Scraping numbers from groups for messaging strangers
