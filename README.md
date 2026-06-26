# Aeroplan Award Explorer

Browse what your Aeroplan points can actually get you — by **destination**, by
**value**, by **date flexibility**, and by **what your balance can book right now** —
instead of Air Canada's search-one-route-and-one-date-at-a-time website.

Two pieces:

- **`ingest.mjs`** — a small Node script that pulls Aeroplan award availability from the
  [seats.aero](https://seats.aero) Partner API and writes a local `aeroplan-cache.json`.
- **`index.html`** — a self-contained page that reads that cache and gives you four
  exploration views, fully offline. No server, no build step.

The two are decoupled: the ingester normalizes the API response into a stable cache
schema, and the explorer only ever reads that schema. If seats.aero changes a field name,
you only fix the ingester.

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
   availability for the **next 90 days**.

4. **Explore.** Open `index.html` in Chrome or Edge, click **“Open cache file…”**, and
   pick `aeroplan-cache.json`. The app remembers which file you picked — after re-running
   the ingester, hit **↻ Reload**. Chrome/Edge may re-prompt for read permission once per
   session, then it re-reads the cache.

> A small sample `aeroplan-cache.json` ships with the repo so you can click around before
> you run the ingester. Your first `node ingest.mjs` overwrites it with real data.

---

## Optional: cash fares → true cents-per-point

The Sweet-spot finder lets you type a cash fare on any row to get exact ¢/pt. To populate
those automatically, run the optional enrichment step against the **Amadeus Self-Service
API**:

1. **Get free credentials** at [developers.amadeus.com](https://developers.amadeus.com) →
   create a Self-Service app → copy its API key and secret into `.env`:
   ```
   AMADEUS_CLIENT_ID=your_amadeus_key
   AMADEUS_CLIENT_SECRET=your_amadeus_secret
   ```
2. **Enrich** (run *after* `node ingest.mjs`):
   ```
   node enrich-fares.mjs
   ```
   It prices the **cheapest-award date per route + cabin** (one Amadeus call each, capped
   at `maxFares`), merges the fares into `aeroplan-cache.json`, then you **↻ Reload**.

In the explorer, auto fares show as italic blue in the **Cash $** column and drive the
**¢/pt** value automatically (green when they beat your **Point value ¢**). Type to
override any cell; clear it to revert to the auto fare. Re-running `node ingest.mjs` keeps
your fares; re-run `enrich-fares.mjs` to refresh them.

Notes: the free **test** host (`test.api.amadeus.com`) has limited/cached data, so some
routes return no fare — set `AMADEUS_HOSTNAME=api.amadeus.com` in `.env` for full coverage
(paid past a monthly free quota). Default currency is CAD (edit `CONFIG.currency` in
`enrich-fares.mjs`); ¢/pt is then "cents of that currency per point."

A fare stays in the cache until a later run re-prices it; if a route is re-priced and now
returns *no* fare it's dropped, but a transient API error leaves the prior fare untouched.
The Sweet-spot tab shows the last enrich date and how many routes were re-priced, so you can
tell how fresh the auto fares are.

---

## Configuring the pull

Edit the `CONFIG` block at the top of `ingest.mjs`:

| Setting | Default | Notes |
|---|---|---|
| `startDate` / `endDate` | today → +90 days | Departure date window (`YYYY-MM-DD`). |
| `originRegions` | `["North America"]` | `[]` = pull every region (uses more quota). |
| `destinationRegion` | `null` | Restrict destinations to one region, or all. |
| `take` | `1000` | Page size (10–1000). Bigger = fewer API calls. |
| `quotaFloor` | `25` | Stop early if remaining daily calls drops this low. |
| `onlyKeepAvailable` | `true` | Drop records with no bookable cabin. |

seats.aero uses a **daily usage quota** (not per-second). The ingester reads the
remaining-calls header, prints it as it goes, and stops before draining it.

**Valid regions:** `North America`, `South America`, `Africa`, `Asia`, `Europe`, `Oceania`.

---

## The four views

1. **Destination discovery** — from your home airport(s), every place you can go, cheapest
   points per cabin, # of available dates, nonstop flag. Table or an offline map. Click any
   destination to jump to its date grid.
2. **Sweet-spot value finder** — ranks routes by points-per-1000-miles and flags the
   cheapest ~25% within each region-pair + cabin as "sweet spots" (thin groups of <5
   routes aren't flagged). Paste a cash fare on any row to get true ¢-per-point. Set a
   **Point value ¢** in the filters to see each award's estimated $ value and flag fares
   that beat your valuation (the ¢/pt cell turns green).
3. **Flexible date grid** — pick a route, see a month-by-month calendar heatmap of points
   cost and seats. The fix for "I don't have fixed dates."
4. **What can I book now?** — enter your balance; see destinations reachable **one-way**
   per cabin and a list of everything you can afford today. (Points are one-way and exclude
   cash taxes/surcharges — a round trip needs roughly double the points plus taxes.)

Filters at the top (home airports, cabins, dates, seats, max points, balance, point value,
direct-only, **round trip**, within-balance) apply to all four views and are remembered
between visits. Tick **Round trip (≈2×)** to make every affordability check and the "what
can I book" view compare against roughly double the one-way points (Aeroplan prices each
direction separately, so it's an estimate — confirm both legs).

---

## Notes & limits

- **Read-only.** This never books anything. When you find something, go book it on
  aircanada.com.
- **One-way availability.** Every view shows directional origin→destination award space for
  a single departure date. To check a round trip, run the destination as a separate origin
  (or swap Origin/Destination in the date grid, if both directions were pulled) and verify
  the return leg yourself — the tool does not pair outbound and return.
- **Seat counts are a snapshot.** A cabin shows as available when seats.aero reported it
  bookable at last ingest; remaining-seat numbers are point-in-time and can be stale. Use
  the **Min seats** filter to require a minimum.
- **Cabin codes:** Y = economy, W = premium economy, J = business, F = first.
- **Map coverage:** ~100 major airports have built-in coordinates; others still appear in
  every table, just not as map dots. Add more in the `AIRPORTS` object in `index.html`.
- **Data is a snapshot.** Availability is only as fresh as your last `node ingest.mjs`. The
  header shows the cache age and warns when it's over ~3 days old.
- **Browser support:** "Open cache file…" uses the File System Access API (Chrome/Edge).
  Other browsers fall back to a normal file picker (no auto-reload).
