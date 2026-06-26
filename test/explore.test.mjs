// Unit + integration tests for the explorer's pure transforms (lib/explore.js).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Explore from "../lib/explore.js"; // CommonJS default import -> the Explore namespace

const __dirname = dirname(fileURLToPath(import.meta.url));
const { filtered, qualifyingCabins, discoverRows, sweetRows, affordRows } = Explore;

// --- fixture helpers ---------------------------------------------------------
function cab(miles, { available = miles > 0, seats = 9, direct = false, airlines = "AC", taxes } = {}) {
  const c = { available, miles, directMiles: 0, seats, direct, airlines };
  if (taxes != null) c.taxes = taxes; // cents; omit to simulate a pre-tax cache
  return c;
}
function rec(origin, destination, date, cabins, opts = {}) {
  const { oRegion = "North America", dRegion = "Asia", distance = 5000, id, taxesCurrency } = opts;
  const full = { Y: cab(0, { available: false }), W: cab(0, { available: false }), J: cab(0, { available: false }), F: cab(0, { available: false }) };
  Object.assign(full, cabins);
  const r = { id: id ?? `${origin}-${destination}-${date}`, date, origin, originRegion: oRegion,
              destination, destinationRegion: dRegion, distance, source: "aeroplan", updatedAt: null, cabins: full };
  if (taxesCurrency != null) r.taxesCurrency = taxesCurrency;
  return r;
}
const S = (over = {}) => Object.assign(
  { home: [], cabins: ["Y", "W", "J", "F"], start: "", end: "", seats: 0, maxMiles: 0,
    balance: 0, direct: false, afford: false, roundTrip: false, pointValue: 0 }, over);

// --- filtered / qualifyingCabins --------------------------------------------
test("filtered honors home, date window, and cabin selection", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(60000) }),
    rec("YYZ", "LHR", "2026-07-10", { J: cab(55000) }),
    rec("YVR", "SYD", "2026-08-01", { J: cab(80000) }),
  ];
  assert.equal(filtered(recs, S({ home: ["YVR"] })).length, 2);
  assert.equal(filtered(recs, S({ start: "2026-07-05", end: "2026-07-31" })).length, 1);
  assert.equal(filtered(recs, S({ cabins: ["Y"] })).length, 0); // no economy priced
});

test("qualifyingCabins applies seats, maxMiles, direct and afford filters", () => {
  const r = rec("YVR", "NRT", "2026-07-01", { J: cab(60000, { seats: 2, direct: true }), Y: cab(35000, { seats: 9 }) });
  assert.deepEqual(qualifyingCabins(r, S()).map((c) => c.cabin).sort(), ["J", "Y"]);
  assert.deepEqual(qualifyingCabins(r, S({ seats: 5 })).map((c) => c.cabin), ["Y"]); // J has only 2 seats
  assert.deepEqual(qualifyingCabins(r, S({ direct: true })).map((c) => c.cabin), ["J"]);
  assert.deepEqual(qualifyingCabins(r, S({ maxMiles: 40000 })).map((c) => c.cabin), ["Y"]);
  assert.deepEqual(qualifyingCabins(r, S({ afford: true, balance: 50000 })).map((c) => c.cabin), ["Y"]);
});

// --- discoverRows ------------------------------------------------------------
test("discoverRows aggregates cheapest-per-cabin, date count, best origin, direct", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(60000, { direct: false }) }),
    rec("YYZ", "NRT", "2026-07-02", { J: cab(55000, { direct: true }), Y: cab(35000) }),
    rec("YYZ", "NRT", "2026-07-02", { J: cab(58000) }), // same date -> not a new date
  ];
  const [d] = discoverRows(recs, S());
  assert.equal(d.destination, "NRT");
  assert.equal(d.cab.J, 55000);
  assert.equal(d.cab.Y, 35000);
  assert.equal(d.cheapest, 35000);
  assert.equal(d.dateCount, 2);
  assert.equal(d.bestOrigin, "YYZ"); // origin of the cheapest cabin overall
  assert.equal(d.direct, true);
});

// --- sweetRows: value math + quantile ---------------------------------------
test("sweetRows computes mpm, cpp (auto + manual override), estValue, beatsValuation", () => {
  const recs = [rec("YVR", "NRT", "2026-07-01", { J: cab(60000) }, { distance: 4000 })];
  const auto = sweetRows(recs, S({ pointValue: 1.5 }), { autoFares: { "YVR-NRT-J": 900 }, manualFares: {}, today: "2026-06-01" })[0];
  assert.equal(auto.mpm, (60000 / 4000) * 1000);          // 15000
  assert.equal(auto.cpp, (900 * 100) / 60000);            // 1.5
  assert.equal(auto.fareAuto, true);
  assert.equal(auto.estValue, (60000 * 1.5) / 100);       // 900
  assert.equal(auto.beatsValuation, true);                // 1.5 >= 1.5

  const manual = sweetRows(recs, S(), { autoFares: { "YVR-NRT-J": 900 }, manualFares: { "YVR-NRT-J": 1200 }, today: "2026-06-01" })[0];
  assert.equal(manual.cpp, (1200 * 100) / 60000);         // 2.0 — manual overrides auto
  assert.equal(manual.fareAuto, false);
});

test("sweetRows today filter drops past departures", () => {
  const recs = [
    rec("YVR", "NRT", "2026-05-01", { J: cab(50000) }), // past
    rec("YVR", "NRT", "2026-09-01", { J: cab(70000) }), // future
  ];
  const [r] = sweetRows(recs, S(), { today: "2026-06-26" });
  assert.equal(r.miles, 70000); // cheaper past date excluded, so 70k future wins
});

test("sweetRows flags the cheapest ~25% within a region+cabin group of >=5", () => {
  // five J routes, same region pair, distance 1000 so mpm == miles: 10,20,30,40,50
  const recs = [10, 20, 30, 40, 50].map((m, i) =>
    rec("YVR", "D" + i, "2026-07-01", { J: cab(m) }, { distance: 1000 }));
  const rows = sweetRows(recs, S(), { today: "2026-06-01" });
  const sweetByMpm = Object.fromEntries(rows.map((r) => [r.mpm, r.sweet]));
  // cutoff = sorted[ceil(5*0.25)-1] = sorted[1] = 20 -> mpm<=20 flagged
  assert.equal(sweetByMpm[10], true);
  assert.equal(sweetByMpm[20], true);
  assert.equal(sweetByMpm[30], false);
  assert.equal(sweetByMpm[50], false);
});

test("sweetRows never flags a thin group (<5 routes)", () => {
  const recs = [10, 20, 30].map((m, i) => rec("YVR", "D" + i, "2026-07-01", { J: cab(m) }, { distance: 1000 }));
  const rows = sweetRows(recs, S(), { today: "2026-06-01" });
  assert.equal(rows.some((r) => r.sweet), false);
});

// --- affordRows --------------------------------------------------------------
test("affordRows respects balance and the round-trip multiplier", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(60000) }),
    rec("YVR", "LHR", "2026-07-01", { J: cab(70000) }, { dRegion: "Europe" }),
  ];
  const oneWay = affordRows(recs, S({ balance: 65000 }));
  assert.deepEqual([...oneWay.anyDest].sort(), ["NRT"]);          // only NRT within 65k one-way
  assert.equal(oneWay.reach.J.has("NRT"), true);

  const round = affordRows(recs, S({ balance: 65000, roundTrip: true }));
  assert.equal(round.list.length, 0);                            // 60k*2 = 120k > 65k -> nothing
});

test("affordRows dedupes to the cheapest option per origin-dest-cabin and unions dates", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(62000) }),
    rec("YVR", "NRT", "2026-07-05", { J: cab(58000) }),
  ];
  const { list } = affordRows(recs, S({ balance: 80000 }));
  assert.equal(list.length, 1);
  assert.equal(list[0].miles, 58000);
  assert.equal(list[0].dates.size, 2);
});

// --- taxes / tax-honest cpp --------------------------------------------------
test("sweetRows makes cpp tax-honest when fare and tax share a currency", () => {
  const recs = [rec("YVR", "NRT", "2026-07-01", { J: cab(60000, { taxes: 8650 }) }, { distance: 4000, taxesCurrency: "CAD" })];
  const r = sweetRows(recs, S(), { autoFares: { "YVR-NRT-J": 900 }, today: "2026-06-01", faresCurrency: "CAD" })[0];
  assert.equal(r.taxes, 86.5);
  assert.equal(r.taxesCurrency, "CAD");
  assert.equal(r.cppIsNet, true);
  assert.equal(r.cpp, ((900 - 86.5) * 100) / 60000); // net of the $86.50 award taxes
});

test("sweetRows falls back to gross cpp when currencies differ or taxes are unknown", () => {
  const usd = [rec("YVR", "NRT", "2026-07-01", { J: cab(60000, { taxes: 8650 }) }, { distance: 4000, taxesCurrency: "USD" })];
  const diff = sweetRows(usd, S(), { autoFares: { "YVR-NRT-J": 900 }, today: "2026-06-01", faresCurrency: "CAD" })[0];
  assert.equal(diff.cppIsNet, false);
  assert.equal(diff.cpp, (900 * 100) / 60000); // can't subtract a USD tax from a CAD fare

  const noTax = [rec("YVR", "NRT", "2026-07-01", { J: cab(60000) }, { distance: 4000 })]; // pre-tax cache
  const g = sweetRows(noTax, S(), { autoFares: { "YVR-NRT-J": 900 }, today: "2026-06-01", faresCurrency: "CAD" })[0];
  assert.equal(g.taxes, null);
  assert.equal(g.cppIsNet, false);
  assert.equal(g.cpp, (900 * 100) / 60000);
});

test("affordRows surfaces award taxes (dollars) for the cheapest option", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(62000, { taxes: 9000 }) }, { taxesCurrency: "CAD" }),
    rec("YVR", "NRT", "2026-07-05", { J: cab(58000, { taxes: 8650 }) }, { taxesCurrency: "CAD" }),
  ];
  const { list } = affordRows(recs, S({ balance: 80000 }));
  assert.equal(list.length, 1);
  assert.equal(list[0].miles, 58000);
  assert.equal(list[0].taxes, 86.5); // taxes of the cheapest (58k) option
  assert.equal(list[0].taxesCurrency, "CAD");
});

// --- integration over the committed sample ----------------------------------
test("integration: sample-cache.json yields self-consistent results", () => {
  const cache = JSON.parse(readFileSync(join(__dirname, "..", "sample-cache.json"), "utf8"));
  const recs = cache.records;
  assert.ok(recs.length > 100, "sample should have plenty of records");

  const rows = discoverRows(recs, S());
  assert.ok(rows.length > 0);
  for (const d of rows) {
    const finite = ["Y", "W", "J", "F"].map((X) => d.cab[X]).filter(Number.isFinite);
    if (finite.length) assert.equal(d.cheapest, Math.min(...finite), `${d.destination}: cheapest must equal min cabin`);
  }

  // sweet flags must only appear in region+cabin groups of >=5
  const sweet = sweetRows(recs, S(), { today: "2026-06-26" });
  const groupSize = {};
  for (const r of sweet) if (r.mpm != null) groupSize[r.regionKey] = (groupSize[r.regionKey] || 0) + 1;
  for (const r of sweet) if (r.sweet) assert.ok(groupSize[r.regionKey] >= 5, "sweet only in groups >=5");

  // affordability is monotonic in balance
  const lo = affordRows(recs, S({ balance: 40000 })).anyDest.size;
  const hi = affordRows(recs, S({ balance: 120000 })).anyDest.size;
  assert.ok(hi >= lo, "more balance reaches at least as many destinations");
});
