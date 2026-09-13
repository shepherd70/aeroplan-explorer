# TODO — Aeroplan Award Explorer

Feature tracker. The plan for the itinerary-detail work (tasks, acceptance criteria, real API
shapes) is in `tasks/plan.md`.

## Shipped
- [x] On-demand itinerary detail, plan Tasks 1–9 (detail.mjs, trips.cache.json, grid panel,
      Watchlist command, samples, `--date` layovers, "via" badges) — PR #2 `itinerary-detail`, merged 2026-09-11
- [x] Follow-up: `ingest.mjs normalize()` captures `XDirectRemainingSeats / XDirectTotalTaxes /
      XDirectAirlines` (no extra requests) — PR #3 `direct-fields`, merged 2026-09-11
- [x] Every view describes the nonstop under Direct only (`Explore.directView`) — PR #4
      `direct-only-views`, merged 2026-09-11

## Review checkpoints left open by the plan
Both were built autonomously; a Claude review pass ran on 2026-09-12 (headless Chrome against
the committed samples). Human sign-off is still the open box.
- [ ] **Schema reviewed by human.** Review notes: schema is sound (cents + currency match the
      main cache, local stamps without `Z`, per-route `pulledAt`, optional `segments`). The
      per-route `dateWindow` was recorded but never read; it is now returned by
      `Explore.routeDetail()` so the panel can tell "date outside the pulled window" from "no
      itineraries that day". Not done: warn in `ingestTripsText` when `meta.schema` is newer than the page knows.
- [ ] **Panel layout reviewed by human.** Review notes: acceptance row (AC836, LH2476 via MUC ·
      17h 00m · 186,800 · $152.82 CAD), Direct-only / Min-seats re-filtering without a re-click,
      Layovers column after a `--date` pull, selected-cell outline, tooltips, Watchlist command and
      ✓ ages all verified. Added the outside-window empty state. Not done: keyboard access to date
      cells (they are click-only `div`s; `tabindex` + Enter/Space would fix it).

## 2026-09-12 — loose ends (working tree, not yet committed)
- [x] `node ingest.mjs --returns` pulls return legs for one run without editing CONFIG
      (README setup step + config table + notes, Round-trips empty state name the flag)
- [x] Panel: outside-window empty state (`lib/explore.js`, `index.html`, test)
- [x] `CLAUDE.md` for future sessions
- [x] Live cache re-pulled with `--returns` (391 calls, 255,621 records, 2026-09-12) — Round trips tab verified pairing YYZ⇄LHR

## 2026-09-12 — itinerary detail on the Round trips tab (branch `rt-itineraries`)
Plan (the last open question in `tasks/plan.md`): each round-trip leg is its own directional
route, so both must be pulled; the panel reuses the grid's per-leg renderer.
- [x] `Explore.detailStatus()` — one place that says no-file / not-pulled / outside-window / ok (tests)
- [x] `legItinerariesHtml()` — the grid panel's table + empty states, shared; grid panel now a thin wrapper
- [x] Round trips: rows clickable (mouse + Enter/Space) → `#rtItins` shows Outbound and Return legs; "via" badges per leg (exact date, no fallback); hint names whichever direction lacks detail
- [x] `make-sample.mjs`: return legs for detailed destinations, on detailed dates only, so the sample's Round trips tab pairs and shows flights offline
- [x] README (Itinerary detail "where it shows", Round trips view, samples note)
- [x] Verified in headless Chrome on live YYZ⇄LHR detail (both directions) and on the regenerated samples (7 Business round trips, every return leg has flights)

## 2026-09-12 — scheduled refresh (branch `scheduled-refresh`)
Trend, Watchlist status and the freshness pill compare pulls, so they need a daily run.
- [x] `node ingest.mjs --quiet`: header (with run time) + one line per pass + summary; no progress or shape dump
- [x] `refresh.sh`: scheduler entry point — cd to the repo, nvm-aware, appends to gitignored `ingest.log`, passes flags through
- [x] README "Keeping it fresh": Task Scheduler (WSL) and cron examples; detail pulls stay manual on purpose
- [x] Verified: quiet vs normal output against a fake API; wrapper invoked through wsl.exe as a task would (Node found, log written, exit code propagated)

## 2026-09-13 — keyboard access for table rows and stars (branch `table-row-keyboard`)
- [x] Sweet-spot and Discover rows: focusable buttons; Enter/Space opens the grid, which then focuses its first available date
- [x] Watch stars (Sweet-spot, Watchlist): focusable; Enter/Space toggles and focus survives the re-render
- [x] Keys typed into a row's fare input never trigger the row; README notes the keyboard model
- [x] Verified in headless Chrome on the sample (rows, stars, fare-input guard, focus after re-render and after unwatch)

## 2026-09-13 — review pass over PRs #5–#9 (branch `review-fixes`)
Independent `/code-review high` over `877ff98..main`: ten confirmed findings, all fixed here.
- [x] `detailStatus` no longer hides a `--date` day beyond the route window (what is in the file wins); `detail.mjs --date` also widens the window (`widenWindow`, tested)
- [x] Round trips: a selection the re-paired table no longer contains is cleared (nights / filters / Reload)
- [x] Each leg box suggests only its own route's `node detail.mjs` command (re-pulling the good direction would drop its exact layovers)
- [x] `make-sample.mjs`: return legs trimmed before the byte budget is measured; the note advertises only return legs actually written; a bad trips file warns and never blocks the cache sample; samples regenerated (budget now fully used)
- [x] Keyboard jump into the grid focuses the preserved selection before the first cell
- [x] Newer-schema prompt asks once per schema (remembered in settings), not on every Reload and page load
- [x] Row / cell picks toggle the selection class and redraw only the panel — focus and scroll survive; both keydown handlers use `rowKey`
- [x] Unwatching the last Watchlist row moves focus to the Watchlist tab button
- [x] Verified in headless Chrome (live YYZ⇄LHR detail) and by running the generator against outbound-only, null-route and invalid-JSON trips files
- Not done (cut from the review as cleanup-tier): unit tests for `applyCliFlags`; renderRT's footer re-derives the no-file / not-pulled split

## Follow-ups
- [ ] Sortable column headers (Discover, What can I book) are still click-only
- [x] Keyboard access to grid date cells (`tabindex="0"` + Enter/Space on `#gridMonths`) — 2026-09-12
- [x] `ingestTripsText`: confirm before loading a newer `meta.schema` — 2026-09-12
