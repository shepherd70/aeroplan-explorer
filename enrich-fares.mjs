#!/usr/bin/env node
// Aeroplan Award Explorer — cash-fare enrichment (OPTIONAL)
//
// Fetches representative cash fares from the Amadeus Self-Service API and merges them
// into aeroplan-cache.json, so the explorer shows TRUE cents-per-point automatically
// (no manual fare entry needed).
//
// Run AFTER ingest:   node enrich-fares.mjs
// Needs Amadeus credentials in .env:  AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET
// Get free credentials at https://developers.amadeus.com (Self-Service, free test tier).
//
// Notes:
//  - Prices ONE representative date per route+cabin (the cheapest-award date) so cpp is a
//    fair comparison. This keeps Amadeus call volume to ~one call per route+cabin.
//  - The free TEST environment has limited/cached data — some routes return no fare. Switch
//    to production (AMADEUS_HOSTNAME=api.amadeus.com) for full coverage (paid past a quota).
//  - Zero dependencies — Node 18+ native fetch.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
const CONFIG = {
  hostname: process.env.AMADEUS_HOSTNAME || "test.api.amadeus.com", // or "api.amadeus.com" (production)
  currency: "CAD",
  adults: 1,
  cabins: ["Y", "W", "J", "F"], // which cabins to price
  maxFares: 400,                 // hard cap on Amadeus calls — protects your quota
  nonStop: false,
  pauseMs: 200,                  // polite delay between calls
  maxRetries: 4,
  cacheFile: join(__dirname, "aeroplan-cache.json"),
};

const CABIN_TO_AMADEUS = { Y: "ECONOMY", W: "PREMIUM_ECONOMY", J: "BUSINESS", F: "FIRST" };

main().catch((e) => {
  console.error("\n❌ Enrich failed:", e?.message || e);
  process.exit(1);
});

async function main() {
  const id = env("AMADEUS_CLIENT_ID"), secret = env("AMADEUS_CLIENT_SECRET");
  if (!id || !secret) {
    console.error("❌ Missing Amadeus credentials — add AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to .env (see .env.example).");
    process.exit(1);
  }
  if (!existsSync(CONFIG.cacheFile)) {
    console.error(`❌ ${CONFIG.cacheFile} not found — run "node ingest.mjs" first.`);
    process.exit(1);
  }

  const cache = JSON.parse(readFileSync(CONFIG.cacheFile, "utf8"));
  const records = cache.records || [];
  if (!records.length) { console.error("❌ Cache has no records."); process.exit(1); }

  // For each origin-dest-cabin, find the cheapest award and its date — price cash on that
  // exact date so cents-per-point compares like with like. Use the LOCAL date (not UTC) so
  // an evening run in a UTC-negative timezone doesn't skip valid same-day awards.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const targets = new Map();
  for (const r of records) {
    if (r.date < today) continue; // Amadeus rejects past dates
    for (const X of CONFIG.cabins) {
      const c = r.cabins?.[X];
      if (!c || !c.available || !(c.miles > 0)) continue;
      const key = `${r.origin}-${r.destination}-${X}`;
      const prev = targets.get(key);
      if (!prev || c.miles < prev.miles)
        targets.set(key, { key, origin: r.origin, dest: r.destination, cabin: X, date: r.date, miles: c.miles });
    }
  }

  // Price the biggest awards first — that's where cents-per-point matters most — so a
  // maxFares cap still covers the interesting redemptions.
  let list = [...targets.values()].sort((a, b) => b.miles - a.miles);
  const capped = list.length > CONFIG.maxFares;
  if (capped) list = list.slice(0, CONFIG.maxFares);

  console.log("Amadeus cash-fare enrichment");
  console.log(`  host    : ${CONFIG.hostname}`);
  console.log(`  pricing : ${list.length} route+cabin pairs` + (capped ? ` (capped from ${targets.size}; raise maxFares for more)` : ""));
  console.log(`  currency: ${CONFIG.currency}\n`);

  let token = await getToken(id, secret);
  const fares = { ...(cache.cashFares || {}) }; // preserve any prior fares
  let priced = 0, done = 0, calls = 0;

  for (const t of list) {
    if (token.expiresAt - Date.now() < 60000) token = await getToken(id, secret); // refresh near expiry
    const params = new URLSearchParams({
      originLocationCode: t.origin,
      destinationLocationCode: t.dest,
      departureDate: t.date,
      adults: String(CONFIG.adults),
      currencyCode: CONFIG.currency,
      travelClass: CABIN_TO_AMADEUS[t.cabin],
      max: "1",
    });
    if (CONFIG.nonStop) params.set("nonStop", "true");
    const url = `https://${CONFIG.hostname}/v2/shopping/flight-offers?${params}`;

    const { json, transient } = await fetchWithRetry(url, () => `Bearer ${token.value}`, async () => {
      token = await getToken(id, secret);
    });
    calls++; done++;
    const n = parseFloat(json?.data?.[0]?.price?.grandTotal);
    if (Number.isFinite(n) && n > 0) {
      fares[t.key] = Math.round(n * 100) / 100; // keep cents — matches manually-typed fares
      priced++;
    } else if (!transient) {
      delete fares[t.key]; // re-priced and Amadeus has no fare now → drop the stale value
    } // transient failure (429/5xx/network) → keep any prior fare
    process.stdout.write(`\r  priced ${priced}/${done} (${calls} calls)`);
    await sleep(CONFIG.pauseMs);
  }
  process.stdout.write("\n");

  cache.cashFares = fares;
  cache.meta = cache.meta || {};
  cache.meta.fares = {
    currency: CONFIG.currency,
    updatedAt: new Date().toISOString(),
    count: Object.keys(fares).length, // total fares in the cache (incl. ones not re-priced this run)
    pricedThisRun: priced,            // how many were actually (re)priced this run
    source: "amadeus",
    host: CONFIG.hostname,
  };
  writeFileSync(CONFIG.cacheFile, JSON.stringify(cache));
  console.log(`\n✅ Merged ${Object.keys(fares).length} cash fares (${CONFIG.currency}) into ${CONFIG.cacheFile}`);
  console.log("   Reload the explorer — the Sweet-spot finder now shows ¢/pt automatically.");
}

// --- HTTP helpers ------------------------------------------------------------

// Fetch JSON with retry on network errors / 429 / 5xx, and one re-auth on 401.
// Returns { json, transient }: json is the parsed body (or null); transient=true means the
// failure was temporary (rate-limit/server/network) so the caller should KEEP any prior
// fare; transient=false means a definitive "no fare" (e.g. 400/404) so a stale fare can be
// dropped. `auth()` returns the current Authorization header; `reauth()` refreshes the token.
async function fetchWithRetry(url, auth, reauth) {
  let reauthed = false;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: auth(), Accept: "application/json" } });
    } catch (e) {
      if (attempt < CONFIG.maxRetries) { await sleep(backoff(attempt)); continue; }
      return { json: null, transient: true }; // network error exhausted — don't abort the run
    }
    if (res.ok) return { json: await res.json().catch(() => null), transient: false };
    if (res.status === 401 && !reauthed && reauth) { reauthed = true; await reauth(); continue; }
    if ((res.status === 429 || res.status >= 500) && attempt < CONFIG.maxRetries) {
      const ra = parseInt(res.headers.get("retry-after") || "", 10);
      await sleep(Number.isFinite(ra) ? ra * 1000 : backoff(attempt));
      continue;
    }
    // Non-retryable client error, or retries exhausted on 429/5xx.
    return { json: null, transient: res.status === 429 || res.status >= 500 };
  }
}

async function getToken(id, secret) {
  const res = await fetch(`https://${CONFIG.hostname}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Amadeus auth failed: HTTP ${res.status} ${body.slice(0, 250)}`);
  }
  const j = await res.json();
  if (!j.access_token) throw new Error("Amadeus auth returned no access_token");
  return { value: j.access_token, expiresAt: Date.now() + (j.expires_in || 1799) * 1000 };
}

// --- misc --------------------------------------------------------------------

function env(name) {
  if (process.env[name]) return process.env[name].trim();
  const p = join(__dirname, ".env");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`));
      if (m) {
        let v = m[1].trim();
        if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "").trim();
        return v.replace(/^["']|["']$/g, "").trim();
      }
    }
  }
  return null;
}
const backoff = (a) => Math.min(30000, 1000 * 2 ** a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
