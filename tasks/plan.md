# Implementation Plan: On-demand flight itinerary detail

## Overview

Add flight-level detail (flight numbers, connection airports, aircraft, departure/arrival
times, total duration, stops, and optionally exact layovers) to the Aeroplan Award Explorer.
Detail is pulled **per route, on demand** by a new Node script (`detail.mjs`) into a second,
gitignored cache (`trips.cache.json`), and surfaced in the explorer's **Flexible date grid**:
clicking a date cell opens an itinerary panel for that date + cabin. The main 90-day pull,
the main cache schema, and the five other views are untouched.

Planning was read-only: no code was changed. Findings below were verified live against the
seats.aero Partner API on 2026-09-11 (7 calls, key from `.env`).

## Verified API facts (ground truth for the tasks)

| Fact | Value |
|---|---|
| Daily quota | 1000 requests/day, counted per request (`x-ratelimit-limit/-remaining`) |
| Full `node ingest.mjs` pull | 200 requests |
| Per-route detail call | `GET /partnerapi/search?origin_airport=YYZ&destination_airport=LHR&start_date=…&end_date=…&take=500&include_trips=true&sources=aeroplan` → **1 request**, all 88 dates, 5,330 trips, 3.8 MB, ~2.3 s, `hasMore:false` |
| Trip fields from `include_trips` | `FlightNumbers`, `Carriers`, `Connections[]`, `Aircraft[]`, `FareClasses[]`, `DepartsAt`, `ArrivesAt`, `TotalDuration` (min), `Stops`, `Cabin` (economy/premium/business/first), `RemainingSeats`, `MileageCost`, `TotalTaxes` (cents), `TaxesCurrency`, `AvailabilityID` |
| Not in `include_trips` | per-segment times (so exact layover lengths are not derivable) |
| `GET /partnerapi/trips/{availabilityId}` | adds `AvailabilitySegments[]` (`FlightNumber`, `OriginAirport`, `DestinationAirport`, `DepartsAt`, `ArrivesAt`, `Duration`, `AircraftName`, `AircraftCode`, `FareClass`, `Order`) + `booking_links`; 1 request per route+date; a 3-day-old cache id still resolved |
| `minify_trips=true` | strips exactly the fields we want — do not use |
| Inlining trips in the full pull | ~29 trips/record → +1.1 GB compacted; the page `JSON.parse`s the whole file, so this is ruled out |
| Browser → API | no `Access-Control-Allow-*` headers on OPTIONS or GET; a `file://` page cannot call the API. All pulls stay in Node |
| Timestamps | local wall-clock with a bogus `Z` suffix (YYZ→ORD 14:00→14:55, duration 115 min). Treat as local; never convert |

## Architecture decisions

- **Separate file, not a merge into `aeroplan-cache.json`.** The main cache is 141 MB and
  rewritten only by `ingest.mjs`; itineraries are pulled at a different cadence for a
  handful of routes. `trips.cache.json` already matches the `*.cache.json` gitignore rule.
- **Keyed by route and date, not by availability id.** `routes["YYZ-LHR"].dates["2026-10-11"]`
  mirrors how the grid looks things up (`origin`, `dest`, `date`, `cabin`), is readable, and
  survives id churn. Availability ids are kept on each trip for the optional segment pull.
- **Per-route granularity in the file.** Re-pulling a route replaces only that route's entry,
  and each route carries its own `pulledAt` so the UI can show staleness per route.
- **Pure logic in `lib/explore.js`, DOM in `index.html`** — same split the repo already uses,
  so the new transforms are unit-tested with `node --test`.
- **Existing global filters apply to the panel.** *Direct only* hides multi-stop itineraries,
  *Min seats* hides thin ones. No new global filters in this feature (see optional tasks).
- **Keep all trips per date.** Economy dates can have 60+ itineraries; the panel shows the
  top 15 by points then duration with a "show all" toggle rather than the script dropping data.
- **Times are displayed as local wall-clock** with the `Z` stripped at normalization time.

## Target schema — `trips.cache.json`

```json
{
  "meta": { "source": "aeroplan", "generatedAt": "2026-09-11T…Z", "schema": 1 },
  "routes": {
    "YYZ-LHR": {
      "pulledAt": "2026-09-11T…Z",
      "dateWindow": { "start": "2026-09-11", "end": "2026-12-07" },
      "dates": {
        "2026-10-11": [
          { "id": "3D6VDYSKr0gpBquMTQc6Jti5lcK", "availabilityId": "34OzjwGWcayk42v90F6SRioxaFj",
            "cabin": "J", "flights": ["AC836","LH2476"], "carriers": "AC, LH",
            "via": ["MUC"], "aircraft": ["Airbus A330-300","Airbus A320neo"],
            "fareClasses": ["P","I"], "dep": "2026-10-11T17:40", "arr": "2026-10-12T15:40",
            "duration": 1020, "stops": 1, "miles": 186800, "taxes": 15282,
            "taxesCurrency": "CAD", "seats": 5,
            "segments": [ { "flight": "AC836", "from": "YYZ", "to": "MUC", "dep": "2026-10-11T17:40",
                            "arr": "2026-10-12T07:45", "duration": 485, "aircraft": "Airbus A330-300",
                            "fareClass": "P" } ]
          }
        ]
      }
    }
  }
}
```
`segments` is present only after the optional per-date pull (Task 8). `taxes` is in cents,
matching the main cache. Cabin words map economy→Y, premium→W, business→J, first→F.

## Dependency graph

```
ingest.mjs: export loadApiKey / readRemainingQuota / sleep   (XS)
    └── detail.mjs CLI: pull route(s) → trips.cache.json        (Task 2)
            ▲ uses
detail.mjs: normalizeTrip() + schema  ── tests                  (Task 1)
            │  schema contract
            ├── lib/explore.js: tripsFor / layoverMinutes / routeDetail ── tests   (Task 3)
            │         │
            └── index.html: open + reload + restore trips file, TRIPS global      (Task 4)
                      │
                      └── index.html: grid cell click → itinerary panel          (Task 5)
                                ├── Watchlist: detail command + copy             (Task 6)
                                ├── make-sample.mjs + sample-trips.json + README (Task 7)
                                ├── optional: exact layovers via /trips/{id}      (Task 8)
                                └── optional: "via" badges in tables             (Task 9)
```
Tasks 1–2 (script) and Task 3 (pure helpers) are independent once the schema is fixed by
Task 1; Task 4 depends only on the schema. Tasks 6, 7, 9 are independent of each other.

---

## Phase 1: Foundation — the data path

### Task 1: `normalizeTrip()` and the trips schema (pure, tested)

**Description:** Create `detail.mjs` with the same `isMain()` guard as `ingest.mjs` so it can
be imported by tests without running. Implement and export `normalizeTrip(raw)` that maps a
raw seats.aero trip (either the `AvailabilityTrips` shape from search or the `/trips/{id}`
shape with `AvailabilitySegments`) to the compact schema above. Add `test/detail.test.mjs`
with fixtures copied from the real shapes in the appendix.

**Acceptance criteria:**
- [ ] Search-shape trip → `{ id, availabilityId, cabin, flights[], carriers, via[], aircraft[], fareClasses[], dep, arr, duration, stops, miles, taxes, taxesCurrency, seats }`; `FlightNumbers` "AC509, UA929" splits into `["AC509","UA929"]`; `dep`/`arr` keep the wall-clock and drop the `Z`.
- [ ] Cabin words map to Y/W/J/F; an unknown cabin or missing origin/destination/date returns `null`.
- [ ] Trips-endpoint shape additionally yields `segments[]` ordered by `Order`, with `from`/`to`/`dep`/`arr`/`duration`/`aircraft`/`fareClass`.

**Verification:**
- [ ] `node --test test/detail.test.mjs` passes.
- [ ] `node --test` (whole suite) still passes.

**Dependencies:** None.
**Files:** `detail.mjs` (new), `test/detail.test.mjs` (new).
**Scope:** S.

### Task 2: `node detail.mjs YYZ-LHR …` pulls routes into `trips.cache.json`

**Description:** Turn `detail.mjs` into a CLI. Export `loadApiKey`, `readRemainingQuota`, and
`sleep` from `ingest.mjs` (they are already guarded from running the ingester) and reuse
them. For each `ORIG-DEST` argument call the per-route search with `include_trips=true` and
`sources=aeroplan`, paginating by `skip` while `hasMore` (same pattern as `ingest.mjs`),
normalize every trip, group by date, and merge into the existing file, replacing only the
pulled routes. Date window defaults to `aeroplan-cache.json`'s `meta.dateWindow` when that
file exists, else today → +90 days; `--start YYYY-MM-DD` / `--end YYYY-MM-DD` override.

**Acceptance criteria:**
- [ ] `node detail.mjs YYZ-LHR YVR-NRT` uses one request per route (plus pages only if `hasMore`), prints per-route date/trip counts and remaining quota, and writes `trips.cache.json` in the schema above with `pulledAt` per route.
- [ ] Re-running for one route leaves other routes' entries byte-for-byte intact; a mid-run failure still writes what was collected (same `finally` pattern as the ingester).
- [ ] Stops before the quota floor (25), retries 429/5xx with backoff, exits 1 with a usage line on a malformed route (`YYZLHR`, `yyz-lhr` is accepted and upper-cased), exits 1 with the same "No API key" message as the ingester when the key is missing.

**Verification:**
- [ ] `node --test` passes (merge and arg-parsing logic covered by unit tests using a fake fetch or by testing the pure merge/parse helpers).
- [ ] Manual: `node detail.mjs YYZ-LHR` → `routes["YYZ-LHR"].dates` has ~88 keys, business trips include `AC836, LH2476 via MUC` on 2026-10-11, `x-ratelimit-remaining` drops by 1.
- [ ] `git status` does not show `trips.cache.json` (gitignore rule `*.cache.json` covers it; add a comment line next to it).

**Dependencies:** Task 1.
**Files:** `detail.mjs`, `ingest.mjs` (exports only), `test/detail.test.mjs`, `.gitignore` (comment).
**Scope:** M.

### Task 3: Pure trip helpers in `lib/explore.js`

**Description:** Add and export three pure functions, following the existing style (no DOM,
state passed in): `tripsFor(trips, origin, dest, date, cabin, settings)` returns that
date+cabin's itineraries filtered by `settings.direct` (stops === 0) and `settings.seats`,
sorted by miles ascending then duration ascending; `layoverMinutes(trip)` returns an array
of `{ at, minutes }` from `segments` or `null` when segments are absent;
`routeDetail(trips, origin, dest)` returns `{ pulledAt, dateCount, tripCount }` or `null`.

**Acceptance criteria:**
- [ ] `tripsFor` returns `[]` (not `null`) when the trips cache is null, the route is missing, or the date is missing, so callers can distinguish "not pulled" via `routeDetail`.
- [ ] Sorting and both filters are covered by tests, including a tie on miles broken by duration.
- [ ] `layoverMinutes` computes `MUC 410` for the appendix fixture and `null` without segments.

**Verification:**
- [ ] `node --test` passes with new cases in `test/explore.test.mjs`.

**Dependencies:** Task 1 (schema only).
**Files:** `lib/explore.js`, `test/explore.test.mjs`.
**Scope:** S.

### Task 4: Explorer opens, reloads, and restores the itineraries file

**Description:** In `index.html` add an **Open itineraries…** button beside *Open cache file…*
(`index.html:133-140`), a second handle (`tripsHandle`, persisted under the IndexedDB key
`tripsHandle` via the existing `idbSet/idbGet`), `ingestTripsText(text)` that validates the
`{ meta, routes }` shape and sets a `TRIPS` global, and a non-Chromium fallback `<input type=file>`.
**↻ Reload** re-reads both handles; `restoreHandle()` restores both. The freshness pill gains
a short suffix such as `· 3 routes detailed` (or a second small pill) with the oldest
`pulledAt` age; a stale (>3 days) detail file uses the existing `warn` style.

**Acceptance criteria:**
- [ ] With no itineraries file opened, every existing view behaves exactly as before (`TRIPS` is `null`; nothing else reads it yet).
- [ ] Opening `trips.cache.json` sets `TRIPS`, updates the pill, and survives a page reload via the persisted handle; Reload re-reads both files with at most one permission prompt each.
- [ ] Opening a non-trips JSON (e.g. the main cache) shows a clear alert and leaves `TRIPS` unchanged.

**Verification:**
- [ ] `node --test` passes (no pure-logic change expected).
- [ ] Manual, via the project `verify` skill recipe: serve on :8791, `ingestText(...)` the main cache, then `ingestTripsText(await fetch('trips.cache.json').then(r=>r.text()))`; assert `Object.keys(TRIPS.routes)` and the pill text.

**Dependencies:** Task 1 (schema). Can be built in parallel with Tasks 2–3.
**Files:** `index.html`.
**Scope:** S.

### Checkpoint A: data path works end to end
- [ ] `node --test` green.
- [ ] `node detail.mjs YYZ-LHR` writes a file the page accepts; pill shows `1 route detailed`.
- [ ] No behaviour change anywhere in the UI without a trips file.
- [ ] Human review of the schema before building UI on it.

---

## Phase 2: Core feature — the itinerary panel

### Task 5: Click a date cell to see that date's itineraries

**Description:** In `renderGrid()` (`index.html:727`) add `data-date` to each `.cell.has`,
delegate a click handler on `#gridMonths`, and render a new `<div id="gridItins">` placed
between `#gridLegend` and `#gridMonths` (`index.html:222-224`). `renderItineraries(o, d, date, X)`
calls `Explore.tripsFor` and draws a table: **Flights · Routing (YYZ → MUC → LHR or Nonstop) ·
Aircraft · Departs · Arrives · Duration (17h 00m, +1 day marker when `arr` date > `dep` date)
· Seats · Points · Taxes**, plus a **Layovers** column only when any row has `segments`.
Show the first 15 rows with a *show all (60)* toggle. Highlight the selected cell
(`.cell.selected` outline). Three empty states, each one sentence: no trips file opened
(mention the button), route not pulled (show the exact command `node detail.mjs YYZ-LHR`
in a `<code>` block with the route filled in), and pulled but nothing for this date+cabin
(mention `pulledAt`). Cabin-select changes re-render the panel for the selected date; changing
origin/destination clears it. Cell tooltips gain `· nonstop`/`· 1 stop` from the cheapest
itinerary when detail exists.

**Acceptance criteria:**
- [ ] Clicking the 2026-10-11 cell for YYZ→LHR Business shows a row `AC836, LH2476 · YYZ → MUC → LHR · Airbus A330-300 + Airbus A320neo · 17h 00m · 186,800 pts · $152.82`.
- [ ] *Direct only* checked hides that row; *Min seats* 6 hides it (it has 5 seats); unchecking restores it without re-clicking the cell.
- [ ] Each of the three empty states renders the described sentence; the "not pulled" state's command names the selected route.

**Verification:**
- [ ] `node --test` passes.
- [ ] Manual via the `verify` skill: load both files, `openGridFor("YYZ","LHR","J")`, click the cell located by `[data-date="2026-10-11"]`, read the rendered table text; toggle `#fDirect` and confirm the panel updates.
- [ ] Manual: sample cache + no trips file → panel shows the "open itineraries" sentence, no console errors.

**Dependencies:** Tasks 3, 4.
**Files:** `index.html` (markup, CSS for `.cell.selected` and the panel, `renderGrid`, new `renderItineraries`).
**Scope:** M.

### Checkpoint B: end-to-end flow
- [ ] Fresh pull → open both files → click a cell → correct itineraries, filters honoured.
- [ ] Round trip: re-run `node detail.mjs YYZ-LHR`, hit Reload, panel reflects the new `pulledAt`.
- [ ] Human review of the panel layout before polish.

---

## Phase 3: Polish and optional depth

### Task 6: Watchlist shows the detail command for starred routes

**Description:** `renderWatch()` (`index.html:901`) gains a line above the table:
"Pull itineraries for these routes:" followed by `<code>node detail.mjs YYZ-LHR YVR-NRT</code>`
(unique routes from the watch keys) and a **Copy** button using `navigator.clipboard`. Each
row gets a small ✓ with the `pulledAt` age when `Explore.routeDetail` finds the route.

**Acceptance criteria:**
- [ ] Command lists each starred route once, regardless of how many cabins are starred.
- [ ] Copy puts exactly the command text on the clipboard; button reads "Copied" for ~1.5 s.
- [ ] Rows for detailed routes show the age; others show nothing.

**Verification:** manual via the `verify` skill (star two routes, read the code text); `node --test` unchanged.
**Dependencies:** Tasks 3, 4. **Files:** `index.html`. **Scope:** S.

### Task 7: Sample itineraries and documentation

**Description:** Extend `make-sample.mjs` to also trim `trips.cache.json` into a committed
`sample-trips.json` (routes present in the sample, first 30 dates, at most 10 trips per cabin
per date) so a fresh clone can try the panel offline. Update `README.md`: a Setup step 5
("Pull itineraries for the routes you care about"), a new **Itinerary detail** section
(what it shows, one request per route, exact layovers optional, stale-per-route), the
Flexible date grid bullet, the Notes (times are local; detail is a snapshot per route), and
the Development command list.

**Acceptance criteria:**
- [ ] `node make-sample.mjs` writes both sample files; `sample-trips.json` is under ~300 KB and loads in the page against `sample-cache.json` with at least one clickable detailed date.
- [ ] README documents the two-file flow and the copy-command shortcut in the Watchlist.

**Verification:** run `node make-sample.mjs`; manual load of both samples; `node --test`.
**Dependencies:** Tasks 2, 5. **Files:** `make-sample.mjs`, `sample-trips.json`, `README.md`. **Scope:** M.

### Task 8 (optional): Exact layovers for one date via `/trips/{id}`

**Description:** `node detail.mjs YYZ-LHR --date 2026-10-11` looks up that date's availability
id in `aeroplan-cache.json`, calls `GET /partnerapi/trips/{id}`, and writes `segments` onto the
matching trips (matched by trip `id`; unmatched trips are added). One request per date. The
panel's **Layovers** column then shows e.g. `MUC 6h 50m`.

**Acceptance criteria:**
- [ ] After the call, `layoverMinutes` returns values for that date; other dates are untouched.
- [ ] Missing id (date not in the main cache) prints a one-line explanation and exits 1.

**Verification:** `node --test` (normalizeTrip segment path from Task 1); manual pull + panel check.
**Dependencies:** Tasks 2, 5. **Files:** `detail.mjs`, `index.html`, tests. **Scope:** M.

### Task 9 (optional): "via" badges in the Sweet-spot and Discover tables

**Description:** For routes with detail, replace the bare `nonstop` badge with the cheapest
itinerary's routing badge (`nonstop` or `via MUC`) on the cheapest date. Pure helper
`cheapestRouting(trips, origin, dest, cabin)` in `lib/explore.js`.

**Acceptance criteria:**
- [ ] Rows for undetailed routes are unchanged; detailed rows show the routing badge with a tooltip naming the date it applies to.

**Verification:** unit test for the helper; manual check on the Sweet-spot table.
**Dependencies:** Tasks 3, 5. **Files:** `lib/explore.js`, `index.html`, `test/explore.test.mjs`. **Scope:** S.

### Checkpoint: Complete
- [ ] All acceptance criteria in Tasks 1–7 met (8–9 only if chosen).
- [ ] `node --test` green; UI verified with the `verify` skill on both the real and sample caches.
- [ ] README accurate; `git status` shows no cache files.
- [ ] Ready for review / PR.

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Timestamps carry a false `Z`; naive `new Date()` would shift times by the viewer's timezone | High | Strip the suffix in `normalizeTrip`; render the string directly; unit test pins `14:00` |
| Trips file and main cache drift (pulled at different times); a cell exists but the date has no trips, or vice versa | Med | Per-route `pulledAt` in the pill and the panel's empty state; cells remain driven by the main cache |
| Two file handles double the permission prompts in Chrome | Low | Request both inside the same Reload click; restore both on load |
| Large economy lists (60+/date) make the panel unwieldy | Low | Top 15 + "show all"; sorted by points then duration |
| Quota exhaustion when detailing many routes | Low | 1 request/route; same quota floor and remaining-count print as the ingester |
| `hasMore` on very long windows | Low | Paginate by `skip` exactly as `ingest.mjs` does |
| seats.aero renames a trip field | Med | Same isolation as today: only `normalizeTrip` knows raw names; tests use real fixtures |

## Parallelization

- Safe in parallel after Task 1 fixes the schema: Task 2 (script), Task 3 (helpers), Task 4 (file loading).
- Sequential: Task 5 after 3 and 4; Task 7 after 2 and 5.
- Independent polish: Tasks 6, 8, 9.

## Open questions for the reviewer

1. Separate `trips.cache.json` (planned) vs. merging into `aeroplan-cache.json` — separate keeps
   the ingester untouched and avoids rewriting 141 MB per detail pull. Confirm.
2. Are exact layover lengths worth one request per date (Task 8), or is total journey time
   plus the connection list enough? Plan treats Task 8 as optional.
3. Should the panel live in the grid only (planned), or should the Round-trips tab also get
   itinerary detail for each leg? Not planned; would be a follow-up.

## Out of scope / follow-ups

- Free accuracy win, no extra requests: `ingest.mjs` `normalize()` currently drops the
  direct-only fields the bulk record already carries (`XDirectRemainingSeats`,
  `XDirectTotalTaxes`, `XDirectAirlines`). Capturing them makes nonstop rows exact. Separate PR.
- A local proxy so the page could call the API live — rejected; it ends the no-server design.

---

## Appendix: real API shapes (captured 2026-09-11) for test fixtures

Search `AvailabilityTrips[]` element (no segments):
```json
{ "ID": "3IC5dGTYoYKLtmUWwrzB1XB2m2A", "RouteID": "2ruhqamYeAlR1lZsUFRpkG1lqEx",
  "AvailabilityID": "33OpOUQWoXWnD05TveDYpBGD6J9", "TotalDuration": 703, "Stops": 2,
  "Carriers": "AC", "RemainingSeats": 3, "MileageCost": 42600, "TotalTaxes": 5130,
  "TaxesCurrency": "CAD", "TaxesCurrencySymbol": "$", "TotalSegmentDistance": 2641,
  "OriginAirport": "RDU", "DestinationAirport": "YVR", "Connections": ["YYZ", "YYC"],
  "Aircraft": ["Embraer E175", "Airbus A321", "Boeing 737 MAX 8"], "FareClasses": ["X", "W", "W"],
  "FlightNumbers": "AC8835, AC137, AC2025", "DepartsAt": "2026-09-20T06:00:00Z",
  "Cabin": "economy", "ArrivesAt": "2026-09-20T14:43:00Z", "Source": "aeroplan" }
```

`/trips/{id}` element (with segments; YYZ→LHR 2026-10-11, business):
```json
{
  "ID": "3GiPDfrTbKqu1LKqqHGAPYmUjWa",
  "AvailabilityID": "34OzjwGWcayk42v90F6SRioxaFj",
  "Cabin": "business",
  "FlightNumbers": "AC836, LH2476",
  "Carriers": "AC, LH",
  "Connections": [
    "MUC"
  ],
  "Aircraft": [
    "Airbus A330-300",
    "Airbus A320neo"
  ],
  "FareClasses": [
    "P",
    "I"
  ],
  "Stops": 1,
  "TotalDuration": 1020,
  "RemainingSeats": 5,
  "MileageCost": 186800,
  "TotalTaxes": 15282,
  "TaxesCurrency": "CAD",
  "DepartsAt": "2026-10-11T17:40:00Z",
  "ArrivesAt": "2026-10-12T15:40:00Z",
  "AvailabilitySegments": [
    {
      "FlightNumber": "AC836",
      "OriginAirport": "YYZ",
      "DestinationAirport": "MUC",
      "Order": 0,
      "DepartsAt": "2026-10-11T17:40:00Z",
      "ArrivesAt": "2026-10-12T07:45:00Z",
      "Duration": 485,
      "AircraftName": "Airbus A330-300",
      "AircraftCode": "333",
      "FareClass": "P",
      "Cabin": "business"
    },
    {
      "FlightNumber": "LH2476",
      "OriginAirport": "MUC",
      "DestinationAirport": "LHR",
      "Order": 1,
      "DepartsAt": "2026-10-12T14:35:00Z",
      "ArrivesAt": "2026-10-12T15:40:00Z",
      "Duration": 125,
      "AircraftName": "Airbus A320neo",
      "AircraftCode": "32N",
      "FareClass": "I",
      "Cabin": "business"
    }
  ]
}
```
Layover check from the segments above: MUC arrival 07:45 → departure 14:35 = 410 min. The
sanity check that proves times are local: AC509 YYZ→ORD `DepartsAt 14:00`, `ArrivesAt 14:55`,
`Duration 115` (55 wall-clock minutes across one time zone).
