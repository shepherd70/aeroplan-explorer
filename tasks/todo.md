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

## Follow-ups
- [x] Keyboard access to grid date cells (`tabindex="0"` + Enter/Space on `#gridMonths`) — 2026-09-12
- [x] `ingestTripsText`: confirm before loading a newer `meta.schema` — 2026-09-12
