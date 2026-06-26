#!/usr/bin/env node
// Aeroplan Award Explorer — sample generator (DEV helper)
//
// Produces a small, committed sample-cache.json from your full (gitignored)
// aeroplan-cache.json, so a fresh clone can click around the explorer offline
// before running the ingester. Re-run after `node ingest.mjs` to refresh the
// shipped sample — e.g. after a cache-schema change.
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
};

if (!existsSync(CONFIG.inFile)) {
  console.error(`❌ ${CONFIG.inFile} not found — run "node ingest.mjs" first.`);
  process.exit(1);
}

const cache = JSON.parse(readFileSync(CONFIG.inFile, "utf8"));
const all = cache.records || [];
if (!all.length) { console.error("❌ Cache has no records."); process.exit(1); }

const keepOrigin = new Set(CONFIG.origins);
let recs = all.filter((r) => keepOrigin.has(r.origin));

// Keep the best-covered destinations so the date grid and discovery look rich.
const freq = {};
for (const r of recs) freq[r.destination] = (freq[r.destination] || 0) + 1;
const keepDest = new Set(
  Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, CONFIG.maxDestinations)
    .map(([d]) => d)
);
recs = recs.filter((r) => keepDest.has(r.destination));

// Trim any cash fares to the kept routes.
let cashFares = null;
if (cache.cashFares) {
  cashFares = {};
  for (const [k, v] of Object.entries(cache.cashFares)) {
    const [o, d] = k.split("-");
    if (keepOrigin.has(o) && keepDest.has(d)) cashFares[k] = v;
  }
}

const out = {
  meta: {
    ...cache.meta,
    recordCount: recs.length,
    sample: true,
    sampleNote: `Trimmed preview (${CONFIG.origins.join(", ")} · ${keepDest.size} destinations). Run "node ingest.mjs" for live data.`,
  },
  records: recs,
  ...(cashFares && Object.keys(cashFares).length ? { cashFares } : {}),
};

const json = JSON.stringify(out);
writeFileSync(CONFIG.outFile, json);
console.log(
  `✅ Wrote ${recs.length} records (${keepDest.size} destinations, origins ${CONFIG.origins.join(", ")}) ` +
    `to ${CONFIG.outFile} — ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB`
);
