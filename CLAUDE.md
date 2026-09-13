# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Aeroplan Award Explorer: a zero-dependency, no-build tool for browsing Air Canada Aeroplan
award availability pulled from the seats.aero Partner API. Three decoupled pieces that talk
only through two JSON cache files:

- `ingest.mjs` → `aeroplan-cache.json` — bulk availability (~200 API calls, 150–200 MB, gitignored).
- `detail.mjs` → `trips.cache.json` — flight-level itineraries per route (one call per route, gitignored).
- `index.html` + `lib/explore.js` — the offline explorer. It reads both files via the File
  System Access API; nothing is served and nothing calls the API from the browser.

The scripts normalize API responses into stable schemas and the page only reads those schemas.
A seats.aero field rename is fixed in `normalize()` (ingest) or `normalizeTrip()` (detail), never in the page.

## Commands

No package.json, no dependencies, no build or lint step. Node 18+ (developed on v24).

```
node --test                                   # all tests (test/*.test.mjs)
node --test test/explore.test.mjs             # one file
node --test --test-name-pattern="tripsFor"    # one test by name
node ingest.mjs [--returns]                   # pull availability; needs SEATS_AERO_KEY in .env; --returns adds dest→home legs
node detail.mjs YYZ-LHR [--date 2026-10-11]   # itineraries for routes; --date adds per-segment layovers for one date
node make-sample.mjs [--start YYYY-MM-DD]     # regenerate the SYNTHETIC sample-cache.json + sample-trips.json (deterministic)
```

Tests use `node:test` + `node:assert/strict`. The two-record fixtures in `test/` are real API
shapes captured 2026-09-11 (also in `docs/design/itinerary-detail.md`'s appendix); keep new
fixtures true to the real shape. CI (`.github/workflows/test.yml`) runs the suite on Node 18–24.

## Architecture rules that are easy to break

- **`lib/explore.js` is pure and dual-target.** A UMD-style IIFE: a classic `<script>` in the
  browser (so `file://` keeps working) and `module.exports` in Node. No DOM, no module-level
  state, no browser globals; records, `settings`, fares, "today" and the trips cache are all
  passed in. New data logic goes here with a test; `index.html` calls `Explore.*` and only renders.
- **`index.html` owns all DOM, state and persistence.** Script-scope globals: `RECORDS`/`DATA`
  (main cache), `TRIPS` (itineraries; may be `null`, so every view must work without it),
  `settings` (filters; localStorage key `aeroplan-explorer-settings-v1`), `cashFares`, `watches`.
  File handles persist in IndexedDB. `renderAll()` re-renders every view; the date grid's
  itinerary panel is driven by `gridSel` and `renderItineraries()`.
- **Scripts export helpers without running.** `ingest.mjs` and `detail.mjs` guard `main()` with
  `isMain()`; tests import `normalize`, `normalizeTrip`, `parseArgs`, `pullRoute`/`pullTrips`
  (which take an injectable `fetchImpl`) and the merge helpers.
- **Cabin codes are Y/W/J/F everywhere internally.** seats.aero uses words
  (economy/premium/business/first) in trips and per-cabin prefixed fields
  (`JMileageCost`, `JDirectRemainingSeats`, …) in availability records.
- **"Direct only" means "describe the nonstop".** A cabin's `miles/seats/taxes/airlines` belong to
  its *cheapest* itinerary, which may connect; the `direct*` fields hold the nonstop's own numbers.
  `Explore.directView()` swaps them in when `settings.direct` is set and every view must go
  through it (it falls back to the cheapest values on caches from before those fields existed).
- **Money is integer cents** (`taxes`, `directTaxes`, trip `taxes`) plus a `taxesCurrency` (CAD for
  Aeroplan). ¢/pt is tax-honest: `(cash fare − award taxes) / points`.
- **Price history lives in the cache.** `cache.history` is a per-route+cabin series that
  `ingest.mjs` carries forward across runs via `Explore.observeHistory`/`mergeHistory`; the
  Trend column and Watchlist read it. Don't drop it when changing the cache writer.

## seats.aero quirks (verified live; keep them)

- Daily quota is 1000 requests, reported in a `…remaining` response header. Both scripts stop at
  `quotaFloor` and always write whatever they collected in a `finally`.
- Pagination is by `skip`; the API's `cursor` is a constant snapshot token, not an advancing
  pointer. Pass it back unchanged on every page.
- Trip timestamps are local wall-clock with a bogus `Z` suffix. `localStamp()` strips it; never
  route them through `Date` conversion. Layovers are naive differences of those stamps.
- `/search?include_trips=true` gives itineraries without per-segment times; `/trips/{availabilityId}`
  adds `segments` (one call per route+date). `minify_trips=true` strips the fields we need.
- The API sends no CORS headers, so the page cannot call it; all pulls stay in Node.

## Repo hygiene

- Live caches are gitignored (`aeroplan-cache.json`, `*.cache.json`). The committed samples
  (`sample-cache.json`, `sample-trips.json`) are **synthetic**, generated by `make-sample.mjs`
  (real airport codes, invented everything else) so no seats.aero data ships in the repo — never
  commit real API data, even trimmed. A global pre-commit hook rejects any staged file over 1 MB;
  `test/sample.test.mjs` keeps the cache sample under 900 KB. Never bypass the hook.
- UI changes are verified in a real browser, not by tests: `.claude/skills/verify` has the recipe
  (serve the repo on an uncommon port such as 8791 so localStorage is a fresh origin; load data with
  `ingestText()` / `ingestTripsText()` instead of the file picker; assert on state and rendered
  text rather than screenshots).
- `CHANGELOG.md` gets one entry per merged PR; design notes live in `docs/design/`; the plan for
  going public is `docs/public-release-plan.md`.
