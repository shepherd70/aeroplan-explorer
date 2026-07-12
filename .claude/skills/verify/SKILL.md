---
name: verify
description: Build/launch/drive recipe for verifying Aeroplan Award Explorer UI changes end-to-end in Chrome. Use when a change to index.html or lib/explore.js needs runtime verification.
---

# Verifying the Aeroplan Award Explorer

Zero-dep static app — there is no build step. The only setup is serving the folder
over http (the Chrome extension refuses `file://` URLs).

## Launch

1. Serve the repo root on localhost. Any static server works; a zero-dep one:
   write a ~20-line `node:http` server to the scratchpad serving `C:\dev\aeroplan-explorer`
   and run it in the background (`node serve.mjs`, port 8791).
   Port choice matters: an uncommon port (8791) gives a fresh localStorage origin,
   so filters/watches/fares you touch during testing never pollute the user's real state.
2. Chrome: `tabs_create_mcp` → `navigate` to `http://localhost:8791/index.html`.
3. Load data without the file picker (it can't be automated):
   `javascript_tool` → `const t = await fetch('aeroplan-cache.json').then(r => r.text()); ingestText(t); RECORDS.length`
   Use `sample-cache.json` if the real (gitignored) cache is missing.
   The real cache is ~163k records and loads in a couple of seconds.

## Drive

- Filters: type into the fields then press Tab (change event triggers `renderAll()`).
- Tabs: click the nav buttons; check `document.querySelector("nav.tabs button.active").textContent`.
- Sort selects: use `form_input` with a ref from `find` — clicking through native
  dropdown options with `computer` is flaky.
- To click a specific table row, locate it via JS (`tr.dataset.o/.d/.c` on
  `#sweetTable tr.clickable`), `scrollIntoView`, read `getBoundingClientRect`, then
  `computer` click at those coordinates.
- App state beats pixels for assertions: read `localStorage` keys
  (`aeroplan-explorer-settings-v1`, `-fares-v1`, `-watches-v1`), `RECORDS.length`,
  and rendered cell text via `javascript_tool`.

## Gotchas

- **Screenshots intermittently time out** (CDP `Page.captureScreenshot` 30s) on this
  tab, especially right after clicks. Workaround that reliably works: a standalone
  batch of `wait 5-8s` + `screenshot`. Don't chase it as an app bug — `renderSweet()`
  on the real cache is ~40ms; the app isn't frozen.
- The window/zoom can differ between captures — never reuse click coordinates from a
  screenshot taken before a layout change; re-locate via JS or `find`.
- `node --test` covers lib/explore.js + ingest transforms, but that's CI's job —
  verification is driving the UI.
