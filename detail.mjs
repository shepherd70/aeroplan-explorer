#!/usr/bin/env node
// Aeroplan Award Explorer — itinerary detail puller
// Pulls flight-level detail (flight numbers, connections, aircraft, times, duration) for
// chosen routes from the seats.aero Partner API and writes a second, gitignored cache
// (trips.cache.json) that the explorer reads alongside aeroplan-cache.json.
//
// Run:   node detail.mjs YYZ-LHR YVR-NRT [--start YYYY-MM-DD] [--end YYYY-MM-DD]
//        One API request per route (a second only if the window exceeds one page).
//        The date window defaults to the one in aeroplan-cache.json, else today → +90 days.
//        node detail.mjs YYZ-LHR --date 2026-10-11
//        Exact layovers for ONE date: one request per route+date to /trips/{id}, which adds
//        per-segment times to that date's itineraries (the explorer then shows a Layovers column).
// Needs: a seats.aero Pro API key in env var SEATS_AERO_KEY (or a local .env file).
//
// Zero dependencies — uses Node 18+ native fetch.

import { writeFileSync, readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
// Importing ingest.mjs never runs the ingester (it is guarded the same way this file is).
import { toInt, loadApiKey, readRemainingQuota, sleep } from "./ingest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CONFIG — edit these to change how detail is pulled.
// ---------------------------------------------------------------------------
const CONFIG = {
  base: "https://seats.aero/partnerapi",
  source: "aeroplan",
  take: 500,                     // records (dates) per page; a 90-day window fits in one
  maxPages: 20,                  // backstop against a runaway loop
  maxRetries: 4,                 // retries on 429/5xx (exponential backoff, honors Retry-After)
  pauseMs: 300,                  // polite delay between requests
  quotaFloor: 25,                // stop early if remaining daily calls drops below this
  mainCache: join(__dirname, "aeroplan-cache.json"), // only read for its date window
  outFile: join(__dirname, "trips.cache.json"),
};
const SCHEMA = 1;
const USAGE = "usage: node detail.mjs ORIG-DEST [ORIG-DEST …] [--start YYYY-MM-DD] [--end YYYY-MM-DD]\n" +
              "       node detail.mjs ORIG-DEST [ORIG-DEST …] --date YYYY-MM-DD   (exact layovers for one date)";

// Run only when executed directly — never when a test imports the helpers below.
if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error("\n❌ Detail pull failed:", err?.message || err);
    process.exit(1);
  });
}

function isMain(metaUrl) {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }

  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error(
      "❌ No API key. Set SEATS_AERO_KEY in your environment or in a .env file " +
        "next to this script (see .env.example)."
    );
    process.exit(1);
  }

  const existing = readExisting(CONFIG.outFile);
  if (args.date) return await mainDate(args, apiKey, existing);

  const win = { ...defaultWindow(CONFIG.mainCache), ...(args.start && { start: args.start }), ...(args.end && { end: args.end }) };
  console.log(`Aeroplan Award Explorer — itinerary detail`);
  console.log(`  routes : ${args.routes.map((r) => `${r.origin}-${r.dest}`).join(", ")}`);
  console.log(`  dates  : ${win.start} → ${win.end}`);
  console.log("");

  const pulled = {};
  let apiCalls = 0, quotaRemaining = null;
  try {
    for (const { origin, dest } of args.routes) {
      if (quotaRemaining != null && quotaRemaining <= CONFIG.quotaFloor) {
        console.log(`  ⚠ Skipping ${origin}-${dest} — only ~${quotaRemaining} API calls left today.`);
        continue;
      }
      const r = await pullRoute({ origin, dest, start: win.start, end: win.end, apiKey });
      apiCalls += r.apiCalls;
      if (r.quotaRemaining != null) quotaRemaining = r.quotaRemaining;
      pulled[`${origin}-${dest}`] = { pulledAt: new Date().toISOString(), dateWindow: { ...win }, dates: r.dates };
      const byCabin = {};
      for (const ts of Object.values(r.dates)) for (const t of ts) byCabin[t.cabin] = (byCabin[t.cabin] || 0) + 1;
      const cab = ["F", "J", "W", "Y"].filter((X) => byCabin[X]).map((X) => `${X} ${byCabin[X].toLocaleString()}`).join(" · ");
      console.log(`  ✅ ${origin}-${dest}: ${Object.keys(r.dates).length} dates, ${r.tripCount.toLocaleString()} itineraries` +
        (cab ? ` (${cab})` : "") + (quotaRemaining != null ? ` · ~${quotaRemaining} calls left` : ""));
    }
  } finally {
    writeOut(existing, pulled, apiCalls, quotaRemaining);
  }
}

// --date mode: per-segment detail (exact layovers) for one date of each route. The
// availability id comes from the main cache, so that must hold the route+date.
async function mainDate(args, apiKey, existing) {
  const { date } = args;
  console.log(`Aeroplan Award Explorer — itinerary detail (exact layovers)`);
  console.log(`  routes : ${args.routes.map((r) => `${r.origin}-${r.dest}`).join(", ")}`);
  console.log(`  date   : ${date}`);
  console.log("");
  if (!existsSync(CONFIG.mainCache)) {
    console.error(`❌ ${CONFIG.mainCache} not found — run "node ingest.mjs" first (it supplies the availability ids).`);
    process.exit(1);
  }
  const records = JSON.parse(readFileSync(CONFIG.mainCache, "utf8")).records || [];
  const pulled = {};
  let apiCalls = 0, quotaRemaining = null, failed = 0;
  try {
    for (const { origin, dest } of args.routes) {
      const key = `${origin}-${dest}`;
      const id = availabilityIdFor(records, origin, dest, date);
      if (!id) {
        console.error(`  ❌ ${key} ${date}: no availability record in aeroplan-cache.json — check the date, or re-run node ingest.mjs.`);
        failed++;
        continue;
      }
      if (quotaRemaining != null && quotaRemaining <= CONFIG.quotaFloor) {
        console.log(`  ⚠ Skipping ${key} — only ~${quotaRemaining} API calls left today.`);
        failed++;
        continue;
      }
      const r = await pullTrips({ availabilityId: id, apiKey });
      apiCalls += r.apiCalls;
      if (r.quotaRemaining != null) quotaRemaining = r.quotaRemaining;
      const prev = pulled[key] || existing?.routes?.[key] || { dateWindow: { start: date, end: date }, dates: {} };
      const entry = { ...prev, pulledAt: new Date().toISOString(), dates: { ...prev.dates } };
      entry.dates[date] = mergeDateTrips(entry.dates[date], r.trips);
      pulled[key] = entry;
      const withSegs = entry.dates[date].filter((t) => t.segments).length;
      console.log(`  ✅ ${key} ${date}: ${r.trips.length} itineraries with segments (${withSegs} of ${entry.dates[date].length} on this date now have exact layovers)` +
        (quotaRemaining != null ? ` · ~${quotaRemaining} calls left` : ""));
    }
  } finally {
    writeOut(existing, pulled, apiCalls, quotaRemaining);
  }
  if (failed) process.exit(1);
}

// Persist whatever was collected — a mid-run failure shouldn't waste the quota spent.
function writeOut(existing, pulled, apiCalls, quotaRemaining) {
  if (!Object.keys(pulled).length) return;
  const cache = mergeRoutes(existing, pulled, new Date().toISOString());
  writeFileSync(CONFIG.outFile, JSON.stringify(cache));
  console.log(`\n✅ Wrote ${Object.keys(cache.routes).length} route(s) to ${CONFIG.outFile}`);
  console.log(`   API calls used: ${apiCalls}` + (quotaRemaining != null ? `, ~${quotaRemaining} left today` : ""));
}

// --- CLI args -----------------------------------------------------------------

// ["yyz-lhr", "--start", "2026-10-01"] -> { routes: [{origin, dest}], start?, end? }.
// Throws a one-line message on anything malformed.
function parseArgs(argv) {
  const out = { routes: [] };
  const seen = new Set();
  // Format AND a real calendar date — "2026-13-01" would otherwise burn a request on a 400.
  const isDate = (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || "")) return false;
    const d = new Date(v + "T00:00:00Z");
    return !isNaN(d) && d.toISOString().slice(0, 10) === v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--start" || a === "--end" || a === "--date") {
      const v = argv[++i];
      if (!isDate(v)) throw new Error(`${a} needs a YYYY-MM-DD date (got "${v ?? ""}")\n${USAGE}`);
      out[a.slice(2)] = v;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown option ${a}\n${USAGE}`);
    } else {
      const m = a.toUpperCase().match(/^([A-Z0-9]{3})-([A-Z0-9]{3})$/);
      if (!m) throw new Error(`Route "${a}" must look like ORIG-DEST (e.g. YYZ-LHR)\n${USAGE}`);
      const key = `${m[1]}-${m[2]}`;
      if (!seen.has(key)) { seen.add(key); out.routes.push({ origin: m[1], dest: m[2] }); }
    }
  }
  if (!out.routes.length) throw new Error(USAGE);
  return out;
}

// --- pulling one route ----------------------------------------------------------

// One route's itineraries for a date window, via the cached-search endpoint with trips
// inlined. Paginates by `skip` (seats.aero's `cursor` is a constant snapshot token, not an
// advancing pointer). `fetchImpl` is injectable for tests.
async function pullRoute({ origin, dest, start, end, apiKey, fetchImpl = fetch, pauseMs = CONFIG.pauseMs, maxRetries = CONFIG.maxRetries }) {
  const dates = {};
  let apiCalls = 0, quotaRemaining = null, tripCount = 0;
  let skip = 0, snapshot = null;
  for (let page = 0; page < CONFIG.maxPages; page++) {
    const params = new URLSearchParams({
      origin_airport: origin, destination_airport: dest,
      start_date: start, end_date: end,
      take: String(CONFIG.take), include_trips: "true", sources: CONFIG.source,
    });
    if (skip > 0) params.set("skip", String(skip));
    if (snapshot != null) params.set("cursor", String(snapshot));
    const url = `${CONFIG.base}/search?${params.toString()}`;
    const got = await fetchWithRetry(url, { apiKey, fetchImpl, maxRetries, label: `${origin}-${dest} page ${page + 1}` });
    apiCalls += got.calls;
    if (got.quotaRemaining != null) quotaRemaining = got.quotaRemaining;
    const json = got.json;
    const items = Array.isArray(json) ? json : json.data || [];
    for (const rec of items) {
      if (rec?.Source && rec.Source !== CONFIG.source) continue; // defensive: `sources=` should already filter
      const date = String(rec?.Date || "").slice(0, 10);
      if (!date) continue;
      for (const raw of rec.AvailabilityTrips || []) {
        const t = normalizeTrip(raw);
        if (!t) continue;
        (dates[date] ||= []).push(t);
        tripCount++;
      }
    }
    if (snapshot == null && !Array.isArray(json) && json.cursor != null) snapshot = json.cursor;
    const more = Array.isArray(json) ? items.length >= CONFIG.take : (json.hasMore != null ? !!json.hasMore : items.length >= CONFIG.take);
    skip += items.length;
    if (!more || items.length === 0) break;
    if (pauseMs) await sleep(pauseMs);
  }
  // Deterministic order: cheapest first, then shortest. Dates in calendar order.
  const sorted = {};
  for (const d of Object.keys(dates).sort()) {
    sorted[d] = dates[d].sort((a, b) => a.miles - b.miles || a.duration - b.duration);
  }
  return { dates: sorted, apiCalls, quotaRemaining, tripCount };
}

// GET one URL with bounded retry/backoff on transient 429/5xx (honors Retry-After).
async function fetchWithRetry(url, { apiKey, fetchImpl = fetch, maxRetries = CONFIG.maxRetries, label = url }) {
  let calls = 0, quotaRemaining = null;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { "Partner-Authorization": apiKey, Accept: "application/json" } });
    calls++;
    const remaining = readRemainingQuota(res.headers);
    if (remaining != null) quotaRemaining = remaining;
    if (res.ok) return { json: await res.json(), calls, quotaRemaining };
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      const waitMs = Number.isFinite(ra) ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt);
      console.warn(`  ⚠ HTTP ${res.status} on ${label} — retrying in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText || ""} on ${label}` + (body ? `\n   ${body.slice(0, 400)}` : ""));
  }
}

// --- exact layovers for one date (/trips/{id}) ------------------------------------

// The main cache's record id for a route+date — that is the availability id /trips wants.
function availabilityIdFor(records, origin, dest, date) {
  const r = (records || []).find((x) => x.origin === origin && x.destination === dest && x.date === date);
  return r?.id || null;
}

// Every itinerary of one availability record, with per-segment detail. One request.
async function pullTrips({ availabilityId, apiKey, fetchImpl = fetch, maxRetries = CONFIG.maxRetries }) {
  const url = `${CONFIG.base}/trips/${encodeURIComponent(availabilityId)}`;
  const got = await fetchWithRetry(url, { apiKey, fetchImpl, maxRetries, label: `trips ${availabilityId}` });
  const items = Array.isArray(got.json) ? got.json : got.json?.data || [];
  const trips = items.map(normalizeTrip).filter(Boolean);
  return { trips, apiCalls: got.calls, quotaRemaining: got.quotaRemaining };
}

// Fold a /trips pull into a date's existing itineraries: same trip id -> replaced (now with
// segments), new ids -> added, everything else kept. Cheapest first, then shortest.
function mergeDateTrips(existing, pulled) {
  const byId = new Map();
  for (const t of existing || []) byId.set(t.id ?? `${t.cabin}|${t.flights?.join(",")}|${t.dep}`, t);
  for (const t of pulled || []) byId.set(t.id ?? `${t.cabin}|${t.flights?.join(",")}|${t.dep}`, t);
  return [...byId.values()].sort((a, b) => a.miles - b.miles || a.duration - b.duration);
}

// --- cache file -----------------------------------------------------------------

// Existing trips cache (or null). A corrupt file aborts rather than being silently replaced.
function readExisting(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${path} is not valid JSON — fix or delete it, then re-run.`); }
}

// New cache object: pulled routes replace their old entries, every other route is kept as-is.
function mergeRoutes(existing, pulled, generatedAt) {
  return {
    meta: { source: CONFIG.source, generatedAt, schema: SCHEMA },
    routes: { ...(existing?.routes || {}), ...pulled },
  };
}

// Date window: the main cache's window when present (so detail lines up with the grid),
// else today → +90 days. Reads only the head of the (large) cache file — meta comes first.
function defaultWindow(mainCachePath) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const plus90 = new Date(today); plus90.setDate(plus90.getDate() + 90);
  const fallback = { start: iso(today), end: iso(plus90) };
  if (!existsSync(mainCachePath)) return fallback;
  try {
    const fd = openSync(mainCachePath, "r");
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const m = buf.toString("utf8", 0, n).match(/"dateWindow":\{"start":"(\d{4}-\d{2}-\d{2})","end":"(\d{4}-\d{2}-\d{2})"\}/);
    if (m) return { start: m[1], end: m[2] };
  } catch { /* fall through */ }
  return fallback;
}

// --- normalization -----------------------------------------------------------

// seats.aero names cabins with words; the explorer uses the one-letter codes everywhere.
const CABIN_CODE = { economy: "Y", premium: "W", "premium economy": "W", business: "J", first: "F" };

// Keep the wall-clock part of an API timestamp. seats.aero sends LOCAL times with a bogus
// "Z" suffix (YYZ→ORD "14:00Z"→"14:55Z" is a 115-minute flight), so converting through
// Date would shift every time by the viewer's zone. "2026-10-11T14:00:00Z" -> "2026-10-11T14:00".
function localStamp(v) {
  const m = String(v ?? "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  return m ? m[1] : null;
}

const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const splitFlights = (v) => String(v ?? "").split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);

// One raw trip (either the search endpoint's AvailabilityTrips[] element or a /trips/{id}
// element) -> the compact record stored in trips.cache.json. Returns null when malformed
// or when the cabin is not one the explorer knows.
function normalizeTrip(raw) {
  if (!raw || typeof raw !== "object") return null;
  const origin = raw.OriginAirport, destination = raw.DestinationAirport;
  const dep = localStamp(raw.DepartsAt);
  if (!origin || !destination || !dep) return null;
  const cabin = CABIN_CODE[String(raw.Cabin ?? "").trim().toLowerCase()];
  if (!cabin) return null;

  const t = {
    id: raw.ID || null,
    availabilityId: raw.AvailabilityID || null,
    origin: String(origin).toUpperCase(),
    destination: String(destination).toUpperCase(),
    cabin,
    flights: splitFlights(raw.FlightNumbers),
    carriers: String(raw.Carriers ?? "").trim(),
    via: strList(raw.Connections),
    aircraft: strList(raw.Aircraft),
    fareClasses: strList(raw.FareClasses),
    dep,
    arr: localStamp(raw.ArrivesAt),
    duration: toInt(raw.TotalDuration) || 0,   // minutes, whole itinerary
    stops: toInt(raw.Stops) || 0,
    miles: toInt(raw.MileageCost) || 0,
    taxes: toInt(raw.TotalTaxes) || 0,          // cents, like the main cache
    taxesCurrency: String(raw.TaxesCurrency ?? "").toUpperCase(),
    seats: toInt(raw.RemainingSeats) || 0,
  };

  // Per-segment detail only comes from /trips/{id}; it is what makes layovers computable.
  if (Array.isArray(raw.AvailabilitySegments) && raw.AvailabilitySegments.length) {
    t.segments = [...raw.AvailabilitySegments]
      .sort((a, b) => (toInt(a.Order) || 0) - (toInt(b.Order) || 0))
      .map((s) => ({
        flight: String(s.FlightNumber ?? ""),
        from: String(s.OriginAirport ?? "").toUpperCase(),
        to: String(s.DestinationAirport ?? "").toUpperCase(),
        dep: localStamp(s.DepartsAt),
        arr: localStamp(s.ArrivesAt),
        duration: toInt(s.Duration) || 0,
        aircraft: String(s.AircraftName ?? ""),
        aircraftCode: String(s.AircraftCode ?? ""),
        fareClass: String(s.FareClass ?? ""),
      }));
  }
  return t;
}

// Exported for unit tests. Importing this file does NOT run the puller (see isMain).
export { normalizeTrip, localStamp, parseArgs, pullRoute, mergeRoutes, defaultWindow, availabilityIdFor, pullTrips, mergeDateTrips };
