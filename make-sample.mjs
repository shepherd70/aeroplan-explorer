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
const trips = existsSync(CONFIG.tripsIn) ? JSON.parse(readFileSync(CONFIG.tripsIn, "utf8")) : null;
// The far end of a record: its destination on an outbound leg, its origin on a return leg.
const far = (r) => (keepOrigin.has(r.origin) ? r.destination : r.origin);
// Return legs are kept only for destinations that have itinerary detail in either direction
// (see the header comment); everything else is outbound-only, as before.
const returnDests = new Set();
for (const key of Object.keys(trips?.routes || {})) {
  const [a, b] = key.split("-");
  if (keepOrigin.has(a)) returnDests.add(b);
  if (keepOrigin.has(b)) returnDests.add(a);
}
let recs = all.filter((r) => keepOrigin.has(r.origin) || (keepOrigin.has(r.destination) && returnDests.has(r.origin)));

// Destinations with itinerary detail come first (so sample-trips.json lines up with the
// sample), then the best-covered ones; take as many as fit the byte budget.
const freq = {};
for (const r of recs) freq[far(r)] = (freq[far(r)] || 0) + 1;
const detailDests = new Set([...returnDests].filter((d) => freq[d]));
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

// --- itineraries sample (optional) ------------------------------------------
// Built before the cache sample is written: return legs are then trimmed to the dates that
// have detail, so every round trip the sample can pair also has flights to show.
const detailedDates = {}; // "ORIG-DEST" -> Set of dates kept in sample-trips.json
if (!existsSync(CONFIG.tripsIn)) {
  console.log(`   (no ${CONFIG.tripsIn} — run "node detail.mjs ORIG-DEST" to also ship a sample-trips.json)`);
} else {
  const sampleRoutes = new Set(recs.map((r) => `${r.origin}-${r.destination}`));
  const routes = {};
  for (const [key, entry] of Object.entries(trips.routes || {})) {
    if (!sampleRoutes.has(key)) continue;
    // Dates where the sample cache shows each cabin bookable, so every cabin has clickable detail.
    const [o, dst] = key.split("-");
    const keepDates = new Set();
    for (const X of ["Y", "W", "J", "F"]) {
      recs.filter((r) => r.origin === o && r.destination === dst && r.cabins?.[X]?.available && entry.dates?.[r.date])
        .map((r) => r.date).sort().slice(0, CONFIG.tripsDatesPerCabin).forEach((d) => keepDates.add(d));
    }
    const dates = {};
    for (const d of [...keepDates].sort()) {
      const perCabin = {};
      dates[d] = [];
      for (const t of [...entry.dates[d]].sort((a, b) => a.miles - b.miles || a.duration - b.duration)) {
        if ((perCabin[t.cabin] = (perCabin[t.cabin] || 0) + 1) <= CONFIG.tripsPerCabin) dates[d].push(t);
      }
    }
    routes[key] = { ...entry, dates };
    detailedDates[key] = new Set(Object.keys(dates));
  }
  const n = Object.keys(routes).length;
  if (!n) {
    console.log(`   (trips.cache.json has no route the sample covers — nothing written to ${CONFIG.tripsOut})`);
  } else {
    const out = { meta: { ...trips.meta, sample: true, sampleNote: `Trimmed preview (${Object.keys(routes).join(", ")}). Run "node detail.mjs" for live itineraries.` }, routes };
    const tjson = JSON.stringify(out);
    writeFileSync(CONFIG.tripsOut, tjson);
    console.log(`✅ Wrote ${n} route(s) of itineraries to ${CONFIG.tripsOut} — ${(Buffer.byteLength(tjson) / 1024).toFixed(0)} KB`);
  }
}

// Return legs only on dates with detail (outbound legs keep every date, as before).
recs = recs.filter((r) => keepOrigin.has(r.origin) || detailedDates[`${r.origin}-${r.destination}`]?.has(r.date));
const returnsKept = [...returnDests].filter((d) => keepDest.has(d));

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
