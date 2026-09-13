#!/usr/bin/env node
// Aeroplan Award Explorer — sample generator (DEV helper)
//
// Writes the committed sample-cache.json and sample-trips.json with SYNTHETIC data: real
// airport codes and Aeroplan-shaped pricing, but every price, seat count, tax, flight number,
// time and availability is invented. Nothing here comes from seats.aero, so the samples can
// ship in a public repository. They exist so a fresh clone can click through every view —
// the date grid's itineraries, exact layovers and Round trips included — before running the
// ingester. The explorer treats them exactly like real caches.
//
// Deterministic: the same --seed and --start give byte-identical files.
//
// Run:   node make-sample.mjs                           # 12-week window from today, seed 1
//        node make-sample.mjs --start 2026-10-01 --seed 7
//
// Zero dependencies — Node 18+.

import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import Explore from "./lib/explore.js"; // history helpers (CommonJS default import)

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = { cache: join(__dirname, "sample-cache.json"), trips: join(__dirname, "sample-trips.json") };
const CABINS = ["Y", "W", "J", "F"];

// --- the invented world ------------------------------------------------------------------
const HOMES = ["YVR", "YYZ"];
// Real airports and real great-circle miles (they drive the points-per-mile maths); everything
// priced against them below is made up.
const DESTS = [
  { code: "LHR", region: "Europe",        miles: { YVR: 4700, YYZ: 3550 } },
  { code: "CDG", region: "Europe",        miles: { YVR: 4900, YYZ: 3730 } },
  { code: "FRA", region: "Europe",        miles: { YVR: 5050, YYZ: 3940 } },
  { code: "AMS", region: "Europe",        miles: { YVR: 4820, YYZ: 3720 } },
  { code: "MUC", region: "Europe",        miles: { YVR: 5180, YYZ: 4060 } },
  { code: "NRT", region: "Asia",          miles: { YVR: 4680, YYZ: 6440 } },
  { code: "ICN", region: "Asia",          miles: { YVR: 5100, YYZ: 6620 } },
  { code: "CUN", region: "North America", miles: { YVR: 2950, YYZ: 1970 } },
];
// One-way points bands per destination region: [saver floor, dynamic ceiling]. null = no such cabin.
const BANDS = {
  Europe:          { Y: [35000, 70000], W: [55000, 85000], J: [70000, 130000], F: [110000, 160000] },
  Asia:            { Y: [40000, 75000], W: [60000, 95000], J: [85000, 160000], F: [130000, 200000] },
  "North America": { Y: [15000, 35000], W: [25000, 45000], J: [30000, 55000], F: null },
};
const P_AVAIL = { Y: 0.45, W: 0.22, J: 0.35, F: 0.06 };                  // how often a cabin has space (award space is sparse)
const P_DIRECT = { Europe: 0.35, Asia: 0.4, "North America": 0.55 };      // …and how often that includes a nonstop
const AIRLINES = { Europe: ["AC", "LH", "LX", "OS", "SN", "TP", "LO", "SK"], Asia: ["AC", "NH", "OZ", "TG", "BR"], "North America": ["AC", "UA"] };
const TAXES = { Y: [9000, 25000], W: [12000, 30000], J: [15000, 60000], F: [20000, 70000] }; // cents, CAD
// Itinerary detail (and return legs) ship for one route pair, so the grid panel, the Layovers
// column and the Round trips tab all have something to show offline.
const DETAIL = { out: ["YYZ", "LHR"], ret: ["LHR", "YYZ"], outDays: 12, retFromDay: 3, retToDay: 24, segmentsOnDay: 0 };
const VIA = { "YYZ-LHR": ["YUL", "YOW", "EWR", "FRA", "MUC", "ZRH"], "LHR-YYZ": ["EWR", "YUL", "FRA", "MUC", "DUB"] };
const WIDEBODY = ["Boeing 787-9", "Airbus A330-300", "Boeing 777-300ER"];
const NARROWBODY = ["Airbus A321neo", "Airbus A220-300", "Boeing 737 MAX 8", "Embraer E175"];
const TZ = { YYZ: -240, YUL: -240, YOW: -240, EWR: -240, LHR: 60, DUB: 0, FRA: 60, MUC: 60, ZRH: 60 }; // UTC offsets, minutes
const NONSTOP_MIN = { "YYZ-LHR": 430, "LHR-YYZ": 490 };

// --- deterministic randomness (mulberry32) --------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const roundTo = (n, step) => Math.round(n / step) * step;
const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
// Local wall-clock stamp for `minutes` past midnight of `date` (may spill into other days).
const stamp = (date, minutes) => {
  const day = Math.floor(minutes / 1440), m = minutes - day * 1440;
  return `${addDays(date, day)}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

// --- availability records ------------------------------------------------------------------
const EMPTY = { available: false, miles: 0, directMiles: 0, seats: 0, direct: false, airlines: "", taxes: 0, directSeats: 0, directTaxes: 0, directAirlines: "" };

// Saver space sits at the floor; dynamic pricing climbs toward the ceiling, dearer at weekends.
function priceFor(r, [lo, hi], dayIndex) {
  if (r() < 0.25) return lo;
  const weekend = dayIndex % 7 === 5 || dayIndex % 7 === 6 ? 0.15 : 0;
  return roundTo(lo + (hi - lo) * Math.min(1, r() * 0.9 + weekend), 100);
}

function cabinFor(r, region, X, dayIndex) {
  const band = BANDS[region][X];
  if (!band || r() >= P_AVAIL[X]) return { ...EMPTY };
  const miles = priceFor(r, band, dayIndex);
  const seats = X === "Y" ? between(r, 1, 9) : between(r, 1, 5);
  const taxes = roundTo(between(r, ...TAXES[X]), 100);
  const direct = r() < P_DIRECT[region];
  // The record describes the CHEAPEST itinerary; the direct* fields describe the nonstop, which is
  // often pricier with fewer seats — unless the nonstop is the cheapest itinerary itself.
  const nonstopIsCheapest = direct && r() < 0.5;
  const carriers = nonstopIsCheapest ? ["AC"] : [...new Set([pick(r, AIRLINES[region]), ...(r() < 0.5 ? [pick(r, AIRLINES[region])] : [])])];
  return {
    available: true, miles,
    directMiles: !direct ? 0 : nonstopIsCheapest ? miles : roundTo(miles + between(r, 5000, 40000), 100),
    seats, direct, airlines: carriers.join(", "), taxes,
    directSeats: !direct ? 0 : nonstopIsCheapest ? seats : Math.max(1, Math.min(seats, between(r, 1, 4))),
    directTaxes: !direct ? 0 : nonstopIsCheapest ? taxes : roundTo(between(r, ...TAXES[X]), 100),
    directAirlines: direct ? "AC" : "",
  };
}

// `priceRegion` picks the pricing band: the far end's region for both directions of a route.
function record(r, origin, originRegion, dest, destRegion, distance, date, dayIndex, generatedAt, priceRegion = destRegion) {
  const cabins = {};
  for (const X of CABINS) cabins[X] = cabinFor(r, priceRegion, X, dayIndex);
  if (!CABINS.some((X) => cabins[X].available)) return null; // the ingester drops these too
  return { id: `syn-${origin}-${dest}-${date}`, date, origin, originRegion, destination: dest, destinationRegion: destRegion,
           distance, taxesCurrency: "CAD", source: "aeroplan", updatedAt: generatedAt, cabins };
}

// --- itineraries ------------------------------------------------------------------------------
function itinerariesFor(r, o, d, date, rec, withSegments) {
  const key = `${o}-${d}`, out = [];
  let n = 0;
  for (const X of CABINS) {
    const c = rec.cabins[X];
    if (!c.available) continue;
    const count = between(r, 3, 8);
    for (let i = 0; i < count; i++) {
      const nonstop = c.direct && (i === 0 ? c.directMiles === c.miles || r() < 0.5 : r() < 0.2);
      const via = nonstop ? null : pick(r, VIA[key]);
      const depMin = between(r, 6, 22) * 60 + pick(r, [0, 15, 30, 45]);
      const block = NONSTOP_MIN[key] + between(r, -15, 25);
      let duration, arr, segments = null, flights, aircraft, carriers;
      const carrier = nonstop ? "AC" : pick(r, ["AC", "AC", "LH", "UA"]);
      if (nonstop) {
        duration = block;
        arr = stamp(date, depMin + duration + (TZ[d] - TZ[o]));
        flights = [`AC${o === "YYZ" ? 848 + 2 * (i % 3) : 849 + 2 * (i % 3)}`];
        aircraft = [pick(r, WIDEBODY)];
        carriers = "AC";
      } else {
        const dur1 = between(r, 60, 120) + (TZ[via] === TZ[o] ? 0 : block - 120);
        const layover = between(r, 55, 330);
        const dur2 = Math.max(60, block + 60 - dur1);
        const arr1 = depMin + dur1 + (TZ[via] - TZ[o]);           // local at via
        const dep2 = arr1 + layover;                                // local at via
        const arr2 = dep2 + dur2 + (TZ[d] - TZ[via]);               // local at d
        duration = dur1 + layover + dur2;
        arr = stamp(date, arr2);
        const second = carrier === "AC" ? "AC" : carrier;
        flights = [`${carrier === "UA" ? "UA" : "AC"}${between(r, 100, 999)}`, `${second}${between(r, 100, 999)}`];
        aircraft = TZ[via] === TZ[o] ? [pick(r, NARROWBODY), pick(r, WIDEBODY)] : [pick(r, WIDEBODY), pick(r, NARROWBODY)];
        carriers = [...new Set(flights.map((f) => f.slice(0, 2)))].join(", ");
        if (withSegments) segments = [
          { flight: flights[0], from: o, to: via, dep: stamp(date, depMin), arr: stamp(date, arr1), duration: dur1, aircraft: aircraft[0], aircraftCode: "", fareClass: X === "J" ? "I" : X === "W" ? "R" : "X" },
          { flight: flights[1], from: via, to: d, dep: stamp(date, dep2), arr: stamp(date, arr2), duration: dur2, aircraft: aircraft[1], aircraftCode: "", fareClass: X === "J" ? "I" : X === "W" ? "R" : "X" },
        ];
      }
      const miles = i === 0 ? (nonstop ? c.directMiles || c.miles : c.miles) : roundTo(c.miles + between(r, 0, 60000), 100);
      const t = {
        id: `syn-t-${key}-${date}-${++n}`, availabilityId: rec.id, origin: o, destination: d, cabin: X,
        flights, carriers, via: via ? [via] : [], aircraft, fareClasses: flights.map(() => (X === "J" ? "I" : X === "W" ? "R" : X === "F" ? "O" : "X")),
        dep: stamp(date, depMin), arr, duration, stops: via ? 1 : 0, miles,
        taxes: roundTo(c.taxes + between(r, -2000, 6000), 100), taxesCurrency: "CAD",
        seats: i === 0 ? (nonstop ? c.directSeats || c.seats : c.seats) : between(r, 1, 9),
      };
      if (segments) t.segments = segments;
      out.push(t);
    }
  }
  return out.sort((a, b) => a.miles - b.miles || a.duration - b.duration);
}

// --- price history: a few earlier "pulls" so the Trend column has something to say ----------------
function historyFor(r, records, generatedAt) {
  const today = Explore.observeHistory(records);
  // A few routes had no space in the last two pulls and appear now → the Trend column says NEW.
  // (Two zeros at most: mergeHistory prunes a series that was dead for three pulls in a row.)
  const isNew = new Set(Object.keys(today).filter(() => r() < 0.08));
  let prev = null;
  for (let i = 5; i >= 1; i--) {
    const t = new Date(Date.parse(generatedAt) - i * 86400000).toISOString();
    const obs = {};
    for (const [k, o] of Object.entries(today)) {
      if (isNew.has(k)) { if (i <= 2) obs[k] = { m: 0, d: 0 }; continue; }
      obs[k] = { m: roundTo(o.m * (1 + (r() - 0.45) * 0.2), 100), d: Math.max(1, o.d + between(r, -3, 3)) };
    }
    prev = Explore.mergeHistory(prev, obs, t);
  }
  return Explore.mergeHistory(prev, today, generatedAt);
}

// --- put it together ----------------------------------------------------------------------------
export function synthesize({ start, seed = 1, days = 84 } = {}) {
  const r = rng(seed);
  start = start || isoDate(new Date());
  const end = addDays(start, days - 1);
  const generatedAt = `${start}T12:00:00.000Z`;
  const records = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    for (const home of HOMES) for (const dest of DESTS) {
      const rec = record(r, home, "North America", dest.code, dest.region, dest.miles[home], date, i, generatedAt);
      if (rec) records.push(rec);
    }
  }
  // Return legs for the detailed pair, only on the days that carry itinerary detail.
  const [ro, rd] = DETAIL.ret;
  const retDest = DESTS.find((x) => x.code === ro);
  const retDays = []; for (let i = DETAIL.retFromDay; i <= DETAIL.retToDay; i++) retDays.push(i);
  for (const i of retDays) {
    const date = addDays(start, i);
    let rec = null; // a paired day should usually have space: a few draws before giving up on it
    for (let attempt = 0; attempt < 4 && !rec; attempt++) rec = record(r, ro, retDest.region, rd, "North America", retDest.miles[rd], date, i, generatedAt, retDest.region);
    if (rec) records.push(rec);
  }
  records.sort((a, b) => a.origin.localeCompare(b.origin) || a.destination.localeCompare(b.destination) || a.date.localeCompare(b.date));
  const byKey = new Map(records.map((x) => [`${x.origin}-${x.destination}-${x.date}`, x]));

  // Itineraries: the outbound route on its first days, the return route on the paired days.
  const routes = {};
  const routeEntry = (o, d, dayList) => {
    const dates = {};
    for (const i of dayList) {
      const date = addDays(start, i);
      const rec = byKey.get(`${o}-${d}-${date}`);
      if (!rec) continue;
      dates[date] = itinerariesFor(r, o, d, date, rec, i === DETAIL.segmentsOnDay);
    }
    routes[`${o}-${d}`] = { pulledAt: generatedAt, dateWindow: { start, end }, dates };
  };
  routeEntry(...DETAIL.out, Array.from({ length: DETAIL.outDays }, (_, i) => i));
  routeEntry(...DETAIL.ret, retDays);

  const note = "Synthetic preview: real airport codes and distances, invented prices, seats, taxes and flights. Nothing here comes from seats.aero — run the scripts for live data.";
  const cache = {
    meta: { source: "aeroplan", generatedAt, dateWindow: { start, end }, originRegions: ["North America"], destinationRegion: null,
            pullReturns: false, recordCount: records.length, apiCallsUsed: 0, quotaRemainingAtEnd: null, sample: true, synthetic: true, sampleNote: note },
    records,
    history: historyFor(r, records, generatedAt),
  };
  const trips = { meta: { source: "aeroplan", generatedAt, schema: 1, sample: true, synthetic: true, sampleNote: note }, routes };
  return { cache, trips };
}

function isMain(metaUrl) {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const start = opt("--start"), seed = opt("--seed");
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) { console.error("--start needs YYYY-MM-DD"); process.exit(1); }
  const { cache, trips } = synthesize({ start, seed: seed ? parseInt(seed, 10) : 1 });
  const cj = JSON.stringify(cache), tj = JSON.stringify(trips);
  writeFileSync(OUT.cache, cj);
  writeFileSync(OUT.trips, tj);
  const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0);
  console.log(`✅ Wrote ${cache.records.length} synthetic records (${HOMES.join(", ")} → ${DESTS.length} destinations, ${cache.meta.dateWindow.start} → ${cache.meta.dateWindow.end}) to ${OUT.cache} — ${kb(cj)} KB`);
  console.log(`✅ Wrote ${Object.keys(trips.routes).length} route(s) of synthetic itineraries to ${OUT.trips} — ${kb(tj)} KB`);
}
