# TODO — On-demand flight itinerary detail

Plan: `tasks/plan.md`. Read-only planning done 2026-09-11; no code changed yet.

## Phase 1: Foundation
- [x] **Task 1** `normalizeTrip()` + schema in `detail.mjs` (isMain-guarded), fixtures + tests in `test/detail.test.mjs` — S
- [x] **Task 2** `node detail.mjs ORIG-DEST …` CLI: per-route search with `include_trips=true&sources=aeroplan`, skip-pagination, merge-by-route into `trips.cache.json`, quota floor, retries; export `loadApiKey/readRemainingQuota/sleep` from `ingest.mjs` — M
- [x] **Task 3** `lib/explore.js`: `tripsFor`, `layoverMinutes`, `routeDetail` + tests — S
- [x] **Task 4** `index.html`: Open itineraries… button, `tripsHandle` in IndexedDB, `ingestTripsText`, Reload/restore both files, pill suffix — S

### Checkpoint A
- [x] `node --test` green
- [x] `node detail.mjs YYZ-LHR` → file loads in page, pill shows "1 route detailed"
- [x] No UI change without a trips file
- [ ] Schema reviewed by human (pending — built autonomously)

## Phase 2: Core feature
- [x] **Task 5** Grid cell click → itinerary panel (`#gridItins`), 3 empty states, Direct-only / Min-seats honoured, top 15 + show all, selected-cell outline, stop count in tooltips — M

### Checkpoint B
- [x] YYZ→LHR J 2026-10-11 shows AC836, LH2476 via MUC · 17h 00m · 186,800 pts
- [x] Re-pull + Reload refreshes `pulledAt`
- [ ] Panel layout reviewed by human (pending — built autonomously)

## Phase 3: Polish
- [x] **Task 6** Watchlist: `node detail.mjs …` command for starred routes + Copy button + ✓ age per detailed row — S
- [x] **Task 7** `make-sample.mjs` → `sample-trips.json`; README (setup step, Itinerary detail section, grid bullet, notes, dev commands) — M
- [x] **Task 8** `--date` exact layovers via `/trips/{id}`, Layovers column — M
- [x] **Task 9** "via MUC" routing badges in Sweet-spot / Discover for detailed routes — S

### Checkpoint: Complete
- [x] All acceptance criteria met; `node --test` green (49 tests); UI verified in headless Chrome (dump-dom harness — the verify skill's Chrome MCP isn't available here)
- [x] README accurate; `git status` clean of cache files
- [ ] Ready for PR (branch `itinerary-detail`, awaiting your review)

## Follow-up (separate PR)
- [ ] `ingest.mjs normalize()`: capture `XDirectRemainingSeats / XDirectTotalTaxes / XDirectAirlines` (no extra requests)
