#!/usr/bin/env node
// Aeroplan Award Explorer — sample generator (DEV helper)
//
// Produces a small, committed sample-cache.json from your full (gitignored)
// aeroplan-cache.json, so a fresh clone can click around the explorer offline
// before running the ingester. Re-run after `node ingest.mjs` to refresh the
// shipped sample — e.g. after a cache-schema change.
//
// If trips.cache.json exists (from `node detail.mjs`), it also writes a trimmed
// sample-trips.json for the routes the sample covers, so the date grid's
// itinerary panel has something to show offline too. Destinations with detail
// also keep their return legs (dest→home) — only on dates that have detail —
// so the Round trips tab and its per-leg itineraries work offline as well.
//
// Run (after an ingest):   node make-sample.mjs
//
// Zero dependencies — Node 18+.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  inFile: join(__dirname, "aeroplan-cache.json"),
  outFile: join(__dirname, "sample-cache.json"),
  origins: ["YVR", "YYZ"], // keep these home airports (west + east coast)
  maxDestinations: 18,      // cap distinct destinations (by coverage) to keep the file small
  maxBytes: 900 * 1024,     // hard size budget — the repo's pre-commit guard rejects files over 1 MB
  tripsIn: join(__dirname, "trips.cache.json"),
  tripsOut: join(__dirname, "sample-trips.json"),
  tripsDatesPerCabin: 8,    // per route: keep the first N dates on which each cabin is bookable …
  tripsPerCabin: 10,        // … and at most N itineraries per cabin per date (cheapest first)
};

if (!existsSync(CONFIG.inFile)) {
  console.error(`❌ ${CONFIG.inFile} not found — run "node ingest.mjs" first.`);
  process.exit(1);
}

const cache = JSON.parse(readFileSync(CONFIG.inFile, "utf8"));
const all = cache.records || [];
if (!all.length) { console.error("❌ Cache has no records."); process.exit(1); }

const keepOrigin = new Set(CONFIG.origins);
// The far end of a record: its destination on an outbound leg, its origin on a return leg.
const far = (r) => (keepOrigin.has(r.origin) ? r.destination : r.origin);
const CABINS = ["Y", "W", "J", "F"];

// --- itineraries sample (optional) ------------------------------------------
// Built FIRST, because it decides which return legs the cache sample keeps. Guarded: a bad
// trips file costs the itineraries sample and the return legs, never the cache sample.
let trips = null;
if (!existsSync(CONFIG.tripsIn)) {
  console.log(`   (no ${CONFIG.tripsIn} — run "node detail.mjs ORIG-DEST" to also ship a sample-trips.json)`);
} else {
  try { trips = JSON.parse(readFileSync(CONFIG.tripsIn, "utf8")); }
  catch (e) { console.warn(`⚠ ${CONFIG.tripsIn} is not valid JSON (${e.message}) — skipping the itineraries sample.`); }
}

// Return legs (dest→home) are kept only for destinations whose RETURN route has detail, and
// only on dates that have detail, so every round trip the sample can pair also has flights to
// show. Everything else is outbound-only, as before.
const returnDests = new Set();
for (const key of Object.keys(trips?.routes || {})) {
  const [a, b] = key.split("-");
  if (keepOrigin.has(b) && !keepOrigin.has(a)) returnDests.add(a);
}
const candidates = all.filter((r) => keepOrigin.has(r.origin) || (keepOrigin.has(r.destination) && returnDests.has(r.origin)));

const tripRoutes = {};    // trimmed itineraries per route, for sample-trips.json
const detailedDates = {}; // "ORIG-DEST" -> Set of the dates kept there
try {
  for (const [key, entry] of Object.entries(trips?.routes || {})) {
    const [o, dst] = key.split("-");
    if (!keepOrigin.has(o) && !keepOrigin.has(dst)) continue;
    if (!entry || typeof entry !== "object" || !entry.dates || typeof entry.dates !== "object") throw new Error(`route ${key} has no dates`);
    // Dates where the cache shows each cabin bookable, so every cabin has clickable detail.
    const keepDates = new Set();
    for (const X of CABINS) {
      candidates.filter((r) => r.origin === o && r.destination === dst && r.cabins?.[X]?.available && Array.isArray(entry.dates[r.date]))
        .map((r) => r.date).sort().slice(0, CONFIG.tripsDatesPerCabin).forEach((d) => keepDates.add(d));
    }
    if (!keepDates.size) continue;
    const dates = {};
    for (const d of [...keepDates].sort()) {
      const perCabin = {};
      dates[d] = [];
      for (const t of [...entry.dates[d]].sort((a, b) => a.miles - b.miles || a.duration - b.duration)) {
        if ((perCabin[t.cabin] = (perCabin[t.cabin] || 0) + 1) <= CONFIG.tripsPerCabin) dates[d].push(t);
      }
    }
    tripRoutes[key] = { ...entry, dates };
    detailedDates[key] = new Set(Object.keys(dates));
  }
} catch (e) {
  console.warn(`⚠ Could not build the itineraries sample from ${CONFIG.tripsIn}: ${e.message} — writing the cache sample without return legs.`);
  for (const k of Object.keys(tripRoutes)) delete tripRoutes[k];
  for (const k of Object.keys(detailedDates)) delete detailedDates[k];
}

// --- availability sample ------------------------------------------------------
// Outbound legs keep every date; return legs only the dates with detail (decided above), so
// the byte budget below measures exactly what gets written.
let recs = candidates.filter((r) => keepOrigin.has(r.origin) || detailedDates[`${r.origin}-${r.destination}`]?.has(r.date));

// Destinations with itinerary detail come first (so sample-trips.json lines up with the
// sample), then the best-covered ones; take as many as fit the byte budget.
const freq = {};
for (const r of recs) freq[far(r)] = (freq[far(r)] || 0) + 1;
const farOf = (key) => { const [a, b] = key.split("-"); return keepOrigin.has(a) ? b : a; };
const detailDests = new Set(Object.keys(tripRoutes).map(farOf).filter((d) => freq[d]));
const ordered = [
  ...detailDests,
  ...Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([d]) => d).filter((d) => !detailDests.has(d)),
];
const keepDest = new Set();
let bytes = 0;
for (const d of ordered) {
  if (keepDest.size >= CONFIG.maxDestinations) break;
  const chunk = JSON.stringify(recs.filter((r) => far(r) === d)).length;
  if (bytes + chunk > CONFIG.maxBytes) continue; // skip; a smaller destination may still fit
  keepDest.add(d); bytes += chunk;
}
recs = recs.filter((r) => keepDest.has(far(r)));
// Only routes the cache sample actually covers ship itineraries.
for (const key of Object.keys(tripRoutes)) if (!keepDest.has(farOf(key))) delete tripRoutes[key];
// Advertise return legs from what is really in the file.
const returnsKept = [...new Set(recs.filter((r) => !keepOrigin.has(r.origin)).map((r) => r.origin))].sort();

const out = {
  meta: {
    ...cache.meta,
    recordCount: recs.length,
    sample: true,
    sampleNote: `Trimmed preview (${CONFIG.origins.join(", ")} · ${keepDest.size} destinations` +
      `${returnsKept.length ? "; return legs for " + returnsKept.join(", ") : ""}). Run "node ingest.mjs" for live data.`,
  },
  records: recs,
};

const json = JSON.stringify(out);
writeFileSync(CONFIG.outFile, json);
console.log(
  `✅ Wrote ${recs.length} records (${keepDest.size} destinations, origins ${CONFIG.origins.join(", ")}` +
    `${returnsKept.length ? ", returns for " + returnsKept.join(", ") : ""}) to ${CONFIG.outFile} — ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB`
);

// --- itineraries sample, written last ------------------------------------------
const n = Object.keys(tripRoutes).length;
if (trips && !n) {
  console.log(`   (trips.cache.json has no route the sample covers — nothing written to ${CONFIG.tripsOut})`);
} else if (n) {
  const tout = { meta: { ...trips.meta, sample: true, sampleNote: `Trimmed preview (${Object.keys(tripRoutes).join(", ")}). Run "node detail.mjs" for live itineraries.` }, routes: tripRoutes };
  const tjson = JSON.stringify(tout);
  writeFileSync(CONFIG.tripsOut, tjson);
  console.log(`✅ Wrote ${n} route(s) of itineraries to ${CONFIG.tripsOut} — ${(Buffer.byteLength(tjson) / 1024).toFixed(0)} KB`);
}
