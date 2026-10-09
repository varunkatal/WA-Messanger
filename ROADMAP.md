# ROADMAP — WhatsApp Bulk Sender

Build one phase at a time. Each phase ends with a working, testable extension.

## Phase 1 — Skeleton & connection
- `manifest.json`, icons, vendored WA-JS + SheetJS.
- Service worker: action click opens side panel; "open/focus WhatsApp tab" handler.
- Content scripts: `bridge-main.js` (MAIN world, waits for `WPP`) and `content.js` (ISOLATED world) talking via `postMessage` with request ids + timeouts.
- Bridge command: `status`.
- Side panel shell: header with connection pill (Connected / Open WhatsApp Web / Not logged in / Reload WhatsApp tab / Engine not ready), four tabs with placeholders.
- `config.js`, `messages.js`.

**Test:** load unpacked → open WhatsApp Web → pill turns "Connected" and shows your number.

## Phase 2 — Recipients
- `phone.js` normalisation + validation (messy Excel input).
- Paste/typed numbers, CSV/XLSX import with column mapping (name, number, extra vars).
- Bridge `listContacts`, `listGroups`; searchable pickers with select-all.
- Final recipients table: valid / invalid / duplicates counts, remove buttons. Persist draft list.
- Saved lists: save the current recipients under a name (e.g. "Grade 8 all sections"), load one back (merged, deduped), delete.

## Phase 3 — Message composer
- Text area, variable chips (`{name}` + imported columns), `template.js` rendering.
- Attachments (image/video/document) stored in IndexedDB, size limits, captions, thumbnails.
- "Text as caption of first attachment" option.
- Formatting buttons: wrap selected text in `*bold*`, `_italic_`, `~strike~`, `` `mono` ``.
- Saved message templates: save current text under a name, pick from a dropdown, delete.
- WhatsApp-style preview; bridge `sendText`, `sendFile`; "Send test to myself".

## Phase 4 — Campaign engine
- Queue runner in `content.js`, persisted after every recipient.
- `checkNumber` before send, random delays, batch pauses, daily cap (IST), stop after N consecutive failures.
- Send tab: settings, estimated time, confirm dialog, Start / Pause / Resume / Stop, progress bar, live log.
- Running campaign on page reload → shown as paused, user resumes.

## Phase 5 — Reports
- Campaign history, per-recipient status, export CSV, retry failed.

## Phase 6 — Polish
- Spintax, safety warnings (delay < 5 s, cap > 300), error message pass, edge cases from real use.
