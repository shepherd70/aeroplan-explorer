# Aeroplan Award Explorer

Browse what your Aeroplan points can actually get you — by **destination**, by
**value**, by **date flexibility**, and by **what your balance can book right now** —
instead of Air Canada's search-one-route-and-one-date-at-a-time website.

Three pieces:

- **`ingest.mjs`** — a small Node script that pulls Aeroplan award availability from the
  [seats.aero](https://seats.aero) Partner API and writes a local `aeroplan-cache.json`.
- **`detail.mjs`** — an on-demand puller for **flight-level itineraries** (flight numbers,
  connections, aircraft, times, duration, optionally exact layovers) for the routes you
  care about; writes a second, smaller `trips.cache.json`.
- **`index.html`** — a self-contained page that reads those caches and gives you six
  exploration views, fully offline. No server, no build step.

They are decoupled: the scripts normalize the API responses into stable cache schemas, and
the explorer only ever reads those schemas. If seats.aero changes a field name, you only
fix the script.

---

## Setup

1. **Get an API key.** You need a seats.aero **Pro** account (~$9.99/mo). Generate the
   key in your account settings. (The Pro plan covers the cached + bulk availability
   endpoints this tool uses; Live Search is gated to approved commercial partners and is
   not used here.)

2. **Add your key.** Copy `.env.example` to `.env` and paste your key:
   ```
   SEATS_AERO_KEY=your_real_key_here
   ```
   `.env` is gitignored — never commit it.

3. **Pull data.** Requires Node 18+ (uses native `fetch`; tested on Node v24):
   ```
   node ingest.mjs
   ```
   This writes `aeroplan-cache.json`. The first run prints the real API record shape so
   you can confirm field names. By default it pulls **North America–origin** Aeroplan
   availability for the **next 90 days**. Add `--returns` to also pull the return legs
   (destination→home) so the **Round trips** tab can pair them — roughly twice the API calls.
   To run it every morning, see **Keeping it fresh** below.

4. **Explore.** Open `index.html` in Chrome or Edge, click **“Open cache file…”**, and
   pick `aeroplan-cache.json` (or the bundled `sample-cache.json` to look around before you
   ingest). The app remembers which file you picked — after re-running the ingester, hit
   **↻ Reload**. Chrome/Edge may re-prompt for read permission once per session, then it
   re-reads the cache.

5. **Pull itineraries for the routes you care about** (optional, one API request per route):
   ```
   node detail.mjs YYZ-LHR YVR-NRT
   ```
   This writes `trips.cache.json`. Click **Open itineraries…** in the header and pick it;
   then, in the **Flexible date grid**, click any date to see that day's flights. See
   [Itinerary detail](#itinerary-detail-flights-connections-aircraft-layovers) below.

> Small samples ship with the repo — `sample-cache.json` and `sample-trips.json` — so you
> can click around before you run anything (they include return legs and itineraries for
> YYZ⇄LHR, so the **Round trips** tab works offline too). `node ingest.mjs` / `node detail.mjs` write the
> **live** `aeroplan-cache.json` / `trips.cache.json` (both gitignored); open those once you
> have them. (Regenerate the samples with `node make-sample.mjs`.)

---

## Cash fares → true cents-per-point

The Sweet-spot finder lets you type a cash fare on any row to get exact ¢/pt (green when it
beats your **Point value ¢**). Fares are saved in the browser, keyed by route + cabin, so
they survive a **↻ Reload**. Clear a cell to remove its fare.

**¢/pt is tax-honest.** Redeeming still costs the award's cash taxes & carrier surcharges
out of pocket, so the points only "buy" *(cash fare − award taxes)*. The Sweet-spot finder
shows those taxes in their own **Taxes** column — pulled straight from seats.aero per cabin,
no extra API calls — and nets them out of ¢/pt. Enter fares in the same currency as the
**Taxes** column (CAD for Aeroplan; the input shows it as a placeholder) so the netting
applies; hover a ¢/pt cell to see the basis. Taxes appear only after an ingest that captured
them, so re-run `node ingest.mjs` if your **Taxes** column is empty.

> Auto-priced fares used to come from the Amadeus Self-Service API, which Amadeus shut down
> in July 2026. That enrichment step has been removed; fares are manual now.

---

## Itinerary detail (flights, connections, aircraft, layovers)

The main pull tells you *that* a cabin is bookable on a date and roughly how (nonstop or
not, which carriers). `node detail.mjs` adds *how exactly*: every itinerary seats.aero knows
for a route and date — flight numbers, connection airports, aircraft, local departure and
arrival times, total duration, seats, points and taxes per itinerary.

- **Per route, on demand.** `node detail.mjs YYZ-LHR YVR-NRT` costs one API request per
  route for the whole date window (the main cache's window by default; `--start` / `--end`
  override). Re-running a route replaces only that route's entry; others are kept.
- **Where it shows.** In the **Flexible date grid**, click a date cell: a panel lists that
  day's itineraries for the selected cabin, cheapest first then shortest. The **Direct only**
  and **Min seats** filters apply there too. Cell tooltips say how the cheapest one routes
  ("via MUC"). Routes you haven't pulled show the exact command to run. In **Round trips**,
  click a row to see both legs' flights — the return is its own route, so pull both directions
  (`node detail.mjs YYZ-LHR LHR-YYZ`; the tab tells you which one is missing).
- **Exact layovers.** The per-route pull gives total journey time and the connection
  airports, but not per-segment times. For one date, `node detail.mjs YYZ-LHR --date
  2026-10-11` fetches segment-level detail (one request per route + date) and the panel gains
  a **Layovers** column ("MUC 6h 50m"). Needs that route + date in `aeroplan-cache.json`.
- **Watchlist shortcut.** The Watchlist tab shows a ready-made `node detail.mjs …` command
  for all starred routes, with a **Copy** button, and marks which routes have detail and how
  old it is.
- **Freshness.** The header pill shows how many routes have detail and the age of the
  oldest pull (amber past 3 days). Detail is a snapshot per route — re-run to refresh.
- **Times are local** to each airport (as the airline publishes them); "+1" marks an arrival
  the next day.

---

## Configuring the pull

Edit the `CONFIG` block at the top of `ingest.mjs`:

| Setting | Default | Notes |
|---|---|---|
| `startDate` / `endDate` | today → +90 days | Departure date window (`YYYY-MM-DD`). |
| `originRegions` | `["North America"]` | `[]` = pull every region (uses more quota). |
| `destinationRegion` | `null` | Restrict destinations to one region, or all. |
| `pullReturns` | `false` | Also pull return legs (dest→home) so the **Round trips** tab can pair them. Adds a reverse pass per origin region — roughly 2× quota. `node ingest.mjs --returns` turns it on for one run. |
| `take` | `1000` | Page size (10–1000). Bigger = fewer API calls. |
| `quotaFloor` | `25` | Stop early if remaining daily calls drops this low. |
| `onlyKeepAvailable` | `true` | Drop records with no bookable cabin. |
| `trackHistory` | `true` | Carry forward a compact per-route price/availability history (`cache.history`) so the explorer can flag drops & newly-available space across pulls. |

seats.aero uses a **daily usage quota** (not per-second). The ingester reads the
remaining-calls header, prints it as it goes, and stops before draining it.

**Valid regions:** `North America`, `South America`, `Africa`, `Asia`, `Europe`, `Oceania`.

---

## Keeping it fresh (scheduled pulls)

The **Trend** column, the Watchlist's *since your last pull* status and the header's freshness
pill all compare pulls, so they only earn their keep once `node ingest.mjs` runs regularly —
ideally once a day with the same `CONFIG`, which keeps each route's history series comparable
(one point per run; drops and rises need at least two). A pull is ~200 API calls, ~400 with
`--returns`, out of the daily 1000.

`--quiet` makes the ingester log-friendly: no per-page progress or record-shape dump, just the
config header, one line per pass and the summary. `refresh.sh` wraps that for a scheduler: it
`cd`s into the repo, picks up an nvm-installed Node if that's how you installed it, and appends
everything to `ingest.log` (gitignored). Extra arguments go straight through to `ingest.mjs`:

```
bash /path/to/aeroplan-explorer/refresh.sh --returns
```

**Windows with the repo under WSL** (how this project is developed). In PowerShell, create a
daily task — the wrapper handles the shell side, so nothing needs quoting (`wsl -l` lists your
distro name):

```
schtasks /Create /TN "Aeroplan ingest" /SC DAILY /ST 06:30 /TR "wsl.exe -d Ubuntu -- bash /home/YOU/dev/aeroplan-explorer/refresh.sh --returns"
```

Run it once by hand with `schtasks /Run /TN "Aeroplan ingest"`, then check `ingest.log` in the
repo; remove it with `schtasks /Delete /TN "Aeroplan ingest"`. A daily task only fires while the
PC is on — in Task Scheduler's properties, *Run task as soon as possible after a scheduled start
is missed* covers mornings it was asleep.

**Linux / macOS** — `crontab -e`:

```
30 6 * * * bash /path/to/aeroplan-explorer/refresh.sh --returns
```

After a scheduled pull, hit **↻ Reload** in the explorer. Itinerary detail (`node detail.mjs`)
is deliberately not scheduled: it costs one request per route, and only you know which routes
matter — the Watchlist hands you the command whenever you want it.

---

## The six views

1. **Destination discovery** — from your home airport(s), every place you can go, cheapest
   points per cabin, # of available dates, nonstop flag. Table or an offline map. Click any
   destination to jump to its date grid.
2. **Sweet-spot value finder** — ranks routes by points-per-1000-miles and flags the
   cheapest ~25% within each region-pair + cabin as "sweet spots" (thin groups of <5
   routes aren't flagged). Every row carries its date context: **Cheapest on** is the
   departure date the lowest price flies (+n when more dates share it) and **Dates** counts
   the departure dates with any availability in your window — click a row to jump to its
   full date-grid calendar. A **Taxes** column shows the award's cash taxes & surcharges, and
   pasting a cash fare on any row gives true, tax-honest ¢-per-point. Set a **Point value ¢**
   in the filters to see each award's estimated $ value and flag fares that beat your
   valuation (the ¢/pt cell turns green). A **Trend** column sparklines each route's
   cheapest-points history and flags drops (▼), rises (▲), and newly-available space (NEW)
   since your last pull.
3. **Flexible date grid** — pick a route, see a month-by-month calendar heatmap of points
   cost and seats. The fix for "I don't have fixed dates." With itinerary detail loaded,
   click a date (or Tab to it and press Enter) to see every flight option that day (see
   **Itinerary detail** above).
4. **What can I book now?** — enter your balance; see destinations reachable **one-way**
   per cabin and a list of everything you can afford today, each with its **Taxes** (the cash
   you still pay on top — points can't cover it). Points are one-way; a round trip needs
   roughly double the points plus taxes.
5. **Round trips** — pair a real outbound (home→dest) award with the cheapest-points return
   (dest→home) within a trip-length window you set (min/max nights), showing combined points,
   combined taxes, and tax-honest round-trip ¢/pt — not the ≈2× estimate. Needs return-leg data
   in the cache (`pullReturns` above); if it's missing, the tab tells you how to pull it. With
   itinerary detail for both directions, each leg shows how its cheapest itinerary routes and
   clicking a row lists both legs' flights (see **Itinerary detail** above).
6. **Watchlist** — star any route in the Sweet-spot finder and it lands here with its current
   cheapest points, how many dates are available, an optional points **target**, a status
   (available / under target / over), and its trend since your last pull. Stars and targets are saved in your browser; the list is
   independent of the filters above. It also hands you the `node detail.mjs …` command for
   every starred route (with a **Copy** button) and shows which routes have itinerary detail.

Filters at the top (home airports, cabins, dates, seats, max points, balance, point value,
direct-only, **round trip**, within-balance) apply to all views except the Watchlist and are remembered
between visits. Tick **Round trip (≈2×)** to make every affordability check and the "what
can I book" view compare against roughly double the one-way points (Aeroplan prices each
direction separately, so it's an estimate — confirm both legs).

---

## Notes & limits

- **Read-only.** This never books anything. When you find something, go book it on
  aircanada.com.
- **Round trips need both directions.** Views 1–4 show directional origin→destination award
  space for a single date. The **Round trips** tab pairs outbound + return for you, but only
  when the cache holds the return legs — ingest with `node ingest.mjs --returns` (or set
  `pullReturns: true` / `originRegions: []` in CONFIG). Aeroplan prices each direction
  separately at booking, so confirm both legs.
- **Direct only describes the nonstop.** A cabin's points, seats, taxes and carriers normally
  belong to its *cheapest* itinerary, which may connect. With **Direct only** ticked, every view
  reports the nonstop's own numbers instead (a nonstop is often pricier with fewer seats), so the
  Min seats, Max points and balance filters apply to what you'd actually book. Caches ingested
  before this was captured fall back to the cheapest values until you re-run `node ingest.mjs`.
- **Seat counts are a snapshot.** A cabin shows as available when seats.aero reported it
  bookable at last ingest; remaining-seat numbers are point-in-time and can be stale. Use
  the **Min seats** filter to require a minimum.
- **Cabin codes:** Y = economy, W = premium economy, J = business, F = first.
- **Map coverage:** ~100 major airports have built-in coordinates; others still appear in
  every table, just not as map dots. Add more in the `AIRPORTS` object in `index.html`.
- **Data is a snapshot.** Availability is only as fresh as your last `node ingest.mjs`. The
  header shows the cache age and warns when it's over ~3 days old.
- **History is per pull.** `cache.history` keeps a short series (cheapest points + # dates) per
  route+cabin — one point per `node ingest.mjs` run, capped and pruned. The Trend column needs
  ≥2 pulls and a stable pull config to be meaningful; switch it off with `trackHistory: false`.
- **Itinerary detail is per route.** `trips.cache.json` only holds the routes you pulled with
  `node detail.mjs`, each with its own pull time. Itinerary times are local wall-clock as
  published; seats and prices per itinerary are as of that pull.
- **Keyboard.** Every clickable row (Destination discovery, Sweet-spot, Round trips), watch star
  and date cell is reachable with Tab; Enter or Space does what a click does, and a jump to the
  date grid lands on its first available date.
- **Browser support:** "Open cache file…" and "Open itineraries…" use the File System Access
  API (Chrome/Edge). Other browsers fall back to a normal file picker (no auto-reload).

---

## Development

Still zero-dependency, still no build step. The explorer's pure data transforms live in
`lib/explore.js` — a dual-target file that loads as a classic `<script>` in the browser
(so opening `index.html` over `file://` keeps working) and also exports for Node, so the
same logic is unit-tested.

```
node --test           # runs test/*.test.mjs (normalize + explorer transforms + detail puller)
node make-sample.mjs  # regenerate the committed sample-cache.json (+ sample-trips.json) from full pulls
```

- `lib/explore.js` — pure: filtering, destination/sweet-spot/affordability aggregation, and
  the itinerary helpers (`tripsFor`, `routeDetail`, `layoverMinutes`). No DOM.
- `ingest.mjs` exports `normalize()` plus the API helpers (guarded so importing it doesn't run an ingest).
- `detail.mjs` exports `normalizeTrip()`, `parseArgs()`, `pullRoute()`, `pullTrips()` and the
  merge helpers, guarded the same way; `pullRoute`/`pullTrips` take an injectable `fetchImpl` for tests.
- `index.html` keeps all rendering/DOM/event code and calls `Explore.*` for the data work.

`trips.cache.json` schema (one entry per pulled route; `segments` only after a `--date` pull):
```
{ meta: { source, generatedAt, schema: 1 },
  routes: { "YYZ-LHR": { pulledAt, dateWindow: { start, end },
    dates: { "2026-10-11": [ { id, availabilityId, cabin: "J", flights: ["AC836","LH2476"], carriers,
      via: ["MUC"], aircraft: [...], fareClasses: [...], dep: "2026-10-11T17:40", arr: "2026-10-12T15:40",
      duration: 1020, stops: 1, miles: 186800, taxes: 15282, taxesCurrency: "CAD", seats: 5,
      segments?: [ { flight, from, to, dep, arr, duration, aircraft, aircraftCode, fareClass } ] } ] } } } }
```
