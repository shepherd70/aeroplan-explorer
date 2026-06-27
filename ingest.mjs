#!/usr/bin/env node
// Aeroplan Award Explorer — ingester
// Pulls Aeroplan award availability from the seats.aero Partner API and writes a
// normalized local cache file (aeroplan-cache.json) that the explorer reads offline.
//
// Run:   node ingest.mjs
// Needs: a seats.aero Pro API key in env var SEATS_AERO_KEY (or a local .env file).
//
// Zero dependencies — uses Node 18+ native fetch. (Tested on Node v24.)

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import Explore from "./lib/explore.js"; // shared pure helpers (CommonJS default import)

const { observeHistory, mergeHistory } = Explore;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CONFIG — edit these to change what gets pulled.
// ---------------------------------------------------------------------------
const CONFIG = {
  base: "https://seats.aero/partnerapi",
  source: "aeroplan",            // Air Canada Aeroplan

  // Date window for departures (YYYY-MM-DD). Defaults: today .. today+90d.
  startDate: isoDate(new Date()),
  endDate: isoDate(addDays(new Date(), 90)),

  // Which ORIGIN regions to pull. Empty array [] = pull everything (more quota).
  // Valid: "North America","South America","Africa","Asia","Europe","Oceania"
  originRegions: ["North America"],

  // Optional DESTINATION region filter (single value or null = all destinations).
  destinationRegion: null,

  // Pull RETURN legs too (dest→home), so the Round-trips view can pair outbound+return.
  // Adds a reverse pass per origin region — roughly doubles quota. Off by default.
  pullReturns: false,

  take: 1000,                    // page size (10–1000). Bigger = fewer calls.
  maxPagesPerRegion: 60,         // safety cap so a bad loop can't drain your quota
  maxRetries: 4,                 // retries on 429/5xx (exponential backoff, honors Retry-After)
  pauseMs: 300,                  // polite delay between page requests
  quotaFloor: 25,               // stop early if remaining daily calls drops below this
  onlyKeepAvailable: true,       // drop records with no available cabin
  trackHistory: true,            // carry forward a compact per-route price/availability history
  outFile: join(__dirname, "aeroplan-cache.json"),
};

// ---------------------------------------------------------------------------
const CABINS = ["Y", "W", "J", "F"]; // economy, premium economy, business, first

// Run the ingester only when this file is executed directly — not when a test
// (or another module) imports normalize() / helpers below.
if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error("\n❌ Ingest failed:", err?.message || err);
    process.exit(1);
  });
}

function isMain(metaUrl) {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}

async function main() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error(
      "❌ No API key. Set SEATS_AERO_KEY in your environment or in a .env file " +
        "next to this script (see .env.example)."
    );
    process.exit(1);
  }

  console.log(`Aeroplan Award Explorer — ingest`);
  console.log(`  source : ${CONFIG.source}`);
  console.log(`  dates  : ${CONFIG.startDate} → ${CONFIG.endDate}`);
  console.log(
    `  origins: ${CONFIG.originRegions.length ? CONFIG.originRegions.join(", ") : "ALL regions"}`
  );
  console.log("");

  // Each pass is an {o: originRegion, d: destinationRegion} filter (null = unfiltered).
  const baseRegions = CONFIG.originRegions.length ? CONFIG.originRegions : [null];
  const passes = baseRegions.map((r) => ({ o: r, d: CONFIG.destinationRegion }));
  if (CONFIG.pullReturns) {
    // The return of an (origin=R → dest=D) outbound is (origin=D → dest=R); pull those too.
    for (const r of baseRegions) passes.push({ o: CONFIG.destinationRegion, d: r });
  }
  const byId = new Map(); // dedupe across passes by record id
  let apiCalls = 0;
  let quotaRemaining = null;
  let shapeLogged = false;

  // Carry forward any cash fares added by enrich-fares.mjs so refreshing availability
  // doesn't wipe them (re-run enrich-fares.mjs to update the fares themselves).
  let preservedFares = null, preservedFaresMeta = null, preservedHistory = null;
  if (existsSync(CONFIG.outFile)) {
    try {
      const old = JSON.parse(readFileSync(CONFIG.outFile, "utf8"));
      preservedFares = old.cashFares || null;
      preservedFaresMeta = old.meta?.fares || null;
      preservedHistory = old.history || null;
    } catch { /* ignore unreadable/old cache */ }
  }

  try {
    for (const pass of passes) {
      // Don't start another pass once the daily quota is nearly drained.
      if (quotaRemaining != null && quotaRemaining <= CONFIG.quotaFloor) {
        console.log(`\n  ⚠ Skipping remaining passes — only ~${quotaRemaining} API calls left today.`);
        break;
      }
      const label = `${pass.o || "ALL"}→${pass.d || "ALL"}`;
      let skip = 0;
      let snapshot = null; // seats.aero "cursor": a constant snapshot token, not an advancing pointer
      for (let page = 0; page < CONFIG.maxPagesPerRegion; page++) {
        const params = new URLSearchParams({
          source: CONFIG.source,
          start_date: CONFIG.startDate,
          end_date: CONFIG.endDate,
          take: String(CONFIG.take),
        });
        if (pass.o) params.set("origin_region", pass.o);
        if (pass.d) params.set("destination_region", pass.d);
        // seats.aero paginates by `skip` (offset); its `cursor` is a constant snapshot token
        // (NOT an advancing pointer), so pass it back to read every page from one snapshot.
        if (skip > 0) params.set("skip", String(skip));
        if (snapshot != null) params.set("cursor", String(snapshot));

        const url = `${CONFIG.base}/availability?${params.toString()}`;

        // Fetch with bounded retry/backoff on transient 429/5xx.
        let res;
        for (let attempt = 0; ; attempt++) {
          res = await fetch(url, {
            headers: { "Partner-Authorization": apiKey, Accept: "application/json" },
          });
          apiCalls++;
          const remaining = readRemainingQuota(res.headers);
          if (remaining != null) quotaRemaining = remaining;
          if (res.ok) break;
          if ((res.status === 429 || res.status >= 500) && attempt < CONFIG.maxRetries) {
            const ra = parseInt(res.headers.get("retry-after") || "", 10);
            const waitMs = Number.isFinite(ra) ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt);
            console.warn(`\n  ⚠ HTTP ${res.status} on ${label} page ${page + 1} — retrying in ${Math.round(waitMs / 1000)}s`);
            await sleep(waitMs);
            continue;
          }
          const body = await res.text().catch(() => "");
          throw new Error(
            `HTTP ${res.status} ${res.statusText} on ${label} page ${page + 1}` +
              (body ? `\n   ${body.slice(0, 400)}` : "")
          );
        }

        const json = await res.json();
        const items = Array.isArray(json) ? json : json.data || json.results || [];

        // One-time diagnostic: print the real shape so you can confirm field names.
        if (!shapeLogged && items.length) {
          shapeLogged = true;
          console.log("First record keys:", Object.keys(items[0]).join(", "));
          if (items[0].Route) console.log("Route keys:", Object.keys(items[0].Route).join(", "));
          console.log("");
        }

        for (const raw of items) {
          const rec = normalize(raw);
          if (!rec) continue;
          if (CONFIG.onlyKeepAvailable && !hasAnyCabin(rec)) continue;
          byId.set(rec.id || `${rec.origin}-${rec.destination}-${rec.date}`, rec);
        }

        process.stdout.write(
          `\r  ${label}: page ${page + 1}, ${byId.size} unique records` +
            (quotaRemaining != null ? `, ~${quotaRemaining} calls left` : "")
        );

        // Capture the snapshot token from the first page; advance by skip while hasMore.
        if (snapshot == null && !Array.isArray(json) && json.cursor != null) snapshot = json.cursor;
        const pageFull = items.length >= CONFIG.take;
        const more = Array.isArray(json)
          ? pageFull
          : (json.hasMore != null ? !!json.hasMore : pageFull);
        skip += items.length;

        if (!more || items.length === 0) break;

        if (quotaRemaining != null && quotaRemaining <= CONFIG.quotaFloor) {
          console.log(`\n  ⚠ Stopping early — only ~${quotaRemaining} API calls left today.`);
          break;
        }
        await sleep(CONFIG.pauseMs);
      }
      process.stdout.write("\n");
    }
  } finally {
    // Always persist whatever we collected — a mid-run failure shouldn't waste the
    // quota already spent or discard pages already fetched.
    writeCache(byId, apiCalls, quotaRemaining, preservedFares, preservedFaresMeta, preservedHistory);
  }
}

function writeCache(byId, apiCalls, quotaRemaining, preservedFares, preservedFaresMeta, preservedHistory) {
  const records = [...byId.values()].sort(
    (a, b) =>
      (a.origin || "").localeCompare(b.origin || "") ||
      (a.destination || "").localeCompare(b.destination || "") ||
      (a.date || "").localeCompare(b.date || "")
  );

  const generatedAt = new Date().toISOString();
  // Carry forward a compact per-route price/availability history (one observation per run),
  // so the explorer can flag drops and newly-available space. Disabling tracking keeps any
  // existing history untouched rather than wiping it.
  const history = CONFIG.trackHistory
    ? mergeHistory(preservedHistory, observeHistory(records), generatedAt)
    : preservedHistory;

  const cache = {
    meta: {
      source: CONFIG.source,
      generatedAt,
      dateWindow: { start: CONFIG.startDate, end: CONFIG.endDate },
      originRegions: CONFIG.originRegions,
      destinationRegion: CONFIG.destinationRegion,
      pullReturns: CONFIG.pullReturns,
      recordCount: records.length,
      apiCallsUsed: apiCalls,
      quotaRemainingAtEnd: quotaRemaining,
      ...(preservedFaresMeta ? { fares: preservedFaresMeta } : {}),
    },
    records,
  };
  if (preservedFares) cache.cashFares = preservedFares;
  if (history && Object.keys(history).length) cache.history = history;

  writeFileSync(CONFIG.outFile, JSON.stringify(cache, null, 0));
  console.log(`\n✅ Wrote ${records.length} records to ${CONFIG.outFile}`);
  console.log(`   API calls used: ${apiCalls}` + (quotaRemaining != null ? `, ~${quotaRemaining} left today` : ""));
  if (cache.history) console.log(`   History: ${Object.keys(cache.history).length} route+cabin series tracked.`);
  if (preservedFares) console.log(`   Kept ${Object.keys(preservedFares).length} cash fares (re-run enrich-fares.mjs to refresh).`);
  if (!records.length) {
    console.log("   (No records — widen the date window or origin regions in CONFIG.)");
  } else {
    const origins = new Set(records.map((r) => r.origin));
    const dests = new Set(records.map((r) => r.destination));
    console.log(`   ${origins.size} origins → ${dests.size} destinations`);
  }
}

// --- normalization -----------------------------------------------------------

function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const route = raw.Route || raw.route || {};
  const get = (a, b) => raw[a] ?? route[a] ?? raw[b] ?? route[b];

  const origin = get("OriginAirport", "originAirport");
  const destination = get("DestinationAirport", "destinationAirport");
  const date = raw.Date || raw.date;
  if (!origin || !destination || !date) return null;

  const cabins = {};
  for (const X of CABINS) {
    const miles = toInt(raw[`${X}MileageCost`]);
    const available = !!(raw[`${X}Available`] ?? (miles > 0));
    cabins[X] = {
      available,
      miles: miles || 0,
      directMiles: toInt(raw[`${X}DirectMileageCost`]) || 0,
      seats: toInt(raw[`${X}RemainingSeats`]) || 0,
      direct: !!raw[`${X}Direct`],
      airlines: (raw[`${X}Airlines`] || "").toString().trim(),
      // Total cash payable on this award (taxes + carrier surcharges), in the smallest
      // unit of taxesCurrency — i.e. cents. seats.aero reports this as an int; 0 = none.
      taxes: toInt(raw[`${X}TotalTaxes`]) || 0,
    };
  }

  return {
    id: raw.ID || raw.id || null,
    date: String(date).slice(0, 10),
    origin: String(origin).toUpperCase(),
    originRegion: get("OriginRegion", "originRegion") || "",
    destination: String(destination).toUpperCase(),
    destinationRegion: get("DestinationRegion", "destinationRegion") || "",
    distance: toInt(get("Distance", "distance")) || 0,
    taxesCurrency: (get("TaxesCurrency", "taxesCurrency") || "").toString().toUpperCase(),
    source: raw.Source || route.Source || CONFIG.source,
    updatedAt: raw.UpdatedAt || raw.updatedAt || null,
    cabins,
  };
}

function hasAnyCabin(rec) {
  return CABINS.some((X) => rec.cabins[X]?.available && rec.cabins[X].miles > 0);
}

// --- helpers -----------------------------------------------------------------

function loadApiKey() {
  if (process.env.SEATS_AERO_KEY) return process.env.SEATS_AERO_KEY.trim();
  const envPath = join(__dirname, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*SEATS_AERO_KEY\s*=\s*(.+?)\s*$/);
      if (m) {
        let v = m[1].trim();
        if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "").trim(); // strip inline comment on unquoted values
        return v.replace(/^["']|["']$/g, "").trim();
      }
    }
  }
  return null;
}

function readRemainingQuota(headers) {
  // The API reports remaining daily calls via a response header; exact name can
  // vary, so match anything that looks like a "remaining" counter.
  for (const [name, value] of headers.entries()) {
    if (/remain/i.test(name)) {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function toInt(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Math.round(v);
  const n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Exported for unit tests. Importing this file does NOT run the ingester (see isMain).
export { normalize, toInt, hasAnyCabin };
