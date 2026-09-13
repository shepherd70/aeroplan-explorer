// Unit + integration tests for the explorer's pure transforms (lib/explore.js).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Explore from "../lib/explore.js"; // CommonJS default import -> the Explore namespace

const __dirname = dirname(fileURLToPath(import.meta.url));
const { filtered, qualifyingCabins, discoverRows, sweetRows, affordRows, roundTripRows } = Explore;

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
test("sweetRows computes mpm, cpp from a manual fare, estValue, beatsValuation", () => {
  const recs = [rec("YVR", "NRT", "2026-07-01", { J: cab(60000) }, { distance: 4000 })];
  const r = sweetRows(recs, S({ pointValue: 1.5 }), { manualFares: { "YVR-NRT-J": 900 }, today: "2026-06-01" })[0];
  assert.equal(r.mpm, (60000 / 4000) * 1000);          // 15000
  assert.equal(r.cpp, (900 * 100) / 60000);            // 1.5
  assert.equal(r.fareValue, 900);
  assert.equal(r.estValue, (60000 * 1.5) / 100);       // 900
  assert.equal(r.beatsValuation, true);                // 1.5 >= 1.5

  const none = sweetRows(recs, S(), { today: "2026-06-01" })[0];
  assert.equal(none.fareValue, null);
  assert.equal(none.cpp, null);
});

test("sweetRows today filter drops past departures", () => {
  const recs = [
    rec("YVR", "NRT", "2026-05-01", { J: cab(50000) }), // past
    rec("YVR", "NRT", "2026-09-01", { J: cab(70000) }), // future
  ];
  const [r] = sweetRows(recs, S(), { today: "2026-06-26" });
  assert.equal(r.miles, 70000); // cheaper past date excluded, so 70k future wins
  assert.equal(r.dateCount, 1); // the past date doesn't count as an available date either
});

test("sweetRows carries date context: count, span, and the cheapest price's date(s)", () => {
  const recs = [
    rec("YVR", "NRT", "2026-09-01", { J: cab(70000) }),
    rec("YVR", "NRT", "2026-07-05", { J: cab(58000) }),
    rec("YVR", "NRT", "2026-08-10", { J: cab(58000) }), // same cheapest price, later date
    rec("YVR", "NRT", "2026-07-01", { J: cab(62000) }),
  ];
  const [r] = sweetRows(recs, S(), { today: "2026-06-01" });
  assert.equal(r.dateCount, 4);
  assert.equal(r.dateFirst, "2026-07-01");
  assert.equal(r.dateLast, "2026-09-01");
  assert.deepEqual(r.bestDates, ["2026-07-05", "2026-08-10"]); // every date at the cheapest price
  assert.equal(r.bestDate, r.bestDates[0]);                    // earliest of them
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
  const r = sweetRows(recs, S(), { manualFares: { "YVR-NRT-J": 900 }, today: "2026-06-01", faresCurrency: "CAD" })[0];
  assert.equal(r.taxes, 86.5);
  assert.equal(r.taxesCurrency, "CAD");
  assert.equal(r.cppIsNet, true);
  assert.equal(r.cpp, ((900 - 86.5) * 100) / 60000); // net of the $86.50 award taxes
});

test("sweetRows falls back to gross cpp when currencies differ or taxes are unknown", () => {
  const usd = [rec("YVR", "NRT", "2026-07-01", { J: cab(60000, { taxes: 8650 }) }, { distance: 4000, taxesCurrency: "USD" })];
  const diff = sweetRows(usd, S(), { manualFares: { "YVR-NRT-J": 900 }, today: "2026-06-01", faresCurrency: "CAD" })[0];
  assert.equal(diff.cppIsNet, false);
  assert.equal(diff.cpp, (900 * 100) / 60000); // can't subtract a USD tax from a CAD fare

  const noTax = [rec("YVR", "NRT", "2026-07-01", { J: cab(60000) }, { distance: 4000 })]; // pre-tax cache
  const g = sweetRows(noTax, S(), { manualFares: { "YVR-NRT-J": 900 }, today: "2026-06-01", faresCurrency: "CAD" })[0];
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

// --- roundTripRows -----------------------------------------------------------
const RET = { oRegion: "Asia", dRegion: "North America" }; // a return leg's regions

test("roundTripRows pairs outbound with the cheapest in-window return, summing points + taxes", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(60000, { taxes: 13000 }) }, { taxesCurrency: "CAD", distance: 4685 }),
    rec("NRT", "YVR", "2026-07-08", { J: cab(62000, { taxes: 9000 }) }, { ...RET, taxesCurrency: "CAD" }),
    rec("NRT", "YVR", "2026-07-10", { J: cab(55000, { taxes: 9500 }) }, { ...RET, taxesCurrency: "CAD" }),
  ];
  const { rows, hasReturnData } = roundTripRows(recs, S(), { origin: "YVR", dest: "NRT", cabin: "J", minNights: 3, maxNights: 21, today: "2026-06-01" });
  assert.equal(hasReturnData, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dateRet, "2026-07-10"); // 55k beats 62k even though it's later
  assert.equal(rows[0].nights, 9);
  assert.equal(rows[0].totalMiles, 115000);
  assert.equal(rows[0].totalTaxes, 225);       // (13000 + 9500) / 100
});

test("roundTripRows respects the trip-length window", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(60000) }, { distance: 4685 }),
    rec("NRT", "YVR", "2026-07-02", { J: cab(55000) }, RET), // 1 night — too short
  ];
  const { rows } = roundTripRows(recs, S(), { origin: "YVR", dest: "NRT", cabin: "J", minNights: 3, maxNights: 21, today: "2026-06-01" });
  assert.equal(rows.length, 0);
});

test("roundTripRows computes round-trip cpp from both directional fares", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(60000, { taxes: 13000 }) }, { taxesCurrency: "CAD", distance: 4685 }),
    rec("NRT", "YVR", "2026-07-09", { J: cab(60000, { taxes: 9000 }) }, { ...RET, taxesCurrency: "CAD" }),
  ];
  const { rows } = roundTripRows(recs, S(), { origin: "YVR", dest: "NRT", cabin: "J", minNights: 3, maxNights: 21, today: "2026-06-01",
    manualFares: { "YVR-NRT-J": 3200, "NRT-YVR-J": 3000 }, faresCurrency: "CAD" });
  assert.equal(rows[0].rtFare, 6200);
  assert.equal(rows[0].totalTaxes, 220);                       // (13000 + 9000) / 100
  assert.equal(rows[0].cppIsNet, true);
  assert.equal(rows[0].cpp, ((6200 - 220) * 100) / 120000);    // net round-trip cpp
});

test("roundTripRows flags missing return data so the UI can prompt a returns pull", () => {
  const recs = [rec("YVR", "NRT", "2026-07-01", { J: cab(60000) }, { distance: 4685 })]; // outbound only
  const res = roundTripRows(recs, S(), { origin: "YVR", dest: "NRT", cabin: "J", minNights: 3, maxNights: 21, today: "2026-06-01" });
  assert.equal(res.hasOutboundData, true);
  assert.equal(res.hasReturnData, false);
  assert.equal(res.rows.length, 0);
});

// --- price / availability history --------------------------------------------
test("observeHistory records cheapest miles + date count per route+cabin", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(62000) }),
    rec("YVR", "NRT", "2026-07-05", { J: cab(58000), Y: cab(34000) }),
  ];
  const obs = Explore.observeHistory(recs);
  assert.deepEqual(obs["YVR-NRT-J"], { m: 58000, d: 2 });
  assert.deepEqual(obs["YVR-NRT-Y"], { m: 34000, d: 1 });
});

test("mergeHistory appends observations and caps the series length", () => {
  let h = {};
  h = Explore.mergeHistory(h, { "A-B-J": { m: 60000, d: 3 } }, "2026-06-01T00:00:00Z", { maxObs: 2 });
  h = Explore.mergeHistory(h, { "A-B-J": { m: 55000, d: 4 } }, "2026-06-02T00:00:00Z", { maxObs: 2 });
  h = Explore.mergeHistory(h, { "A-B-J": { m: 50000, d: 5 } }, "2026-06-03T00:00:00Z", { maxObs: 2 });
  assert.equal(h["A-B-J"].length, 2);
  assert.deepEqual(h["A-B-J"].map((s) => s.m), [55000, 50000]);
});

test("mergeHistory records unavailability, then prunes a long-dead route", () => {
  let h = { "A-B-J": [{ t: "t0", m: 60000, d: 2 }] };
  h = Explore.mergeHistory(h, {}, "t1", { pruneAfter: 3 });
  assert.ok(h["A-B-J"], "kept after one empty run");
  assert.equal(h["A-B-J"].at(-1).m, 0);
  h = Explore.mergeHistory(h, {}, "t2", { pruneAfter: 3 });
  h = Explore.mergeHistory(h, {}, "t3", { pruneAfter: 3 });
  assert.equal(h["A-B-J"], undefined); // three empty runs -> pruned
});

test("historyTrend flags newly available and price drops", () => {
  assert.equal(Explore.historyTrend([]), null);
  const fresh = Explore.historyTrend([{ t: "t0", m: 0, d: 0 }, { t: "t1", m: 60000, d: 3 }]);
  assert.equal(fresh.isNew, true);
  assert.equal(fresh.current, 60000);
  const drop = Explore.historyTrend([{ t: "t0", m: 60000, d: 3 }, { t: "t1", m: 50000, d: 4 }]);
  assert.equal(drop.dropped, true);
  assert.equal(drop.deltaMiles, -10000);
  assert.equal(drop.rose, false);
  assert.deepEqual(drop.spark, [60000, 50000]);
});

// --- watchlist ---------------------------------------------------------------
test("watchList reports current points, under-target, availability, and trend per watch", () => {
  const recs = [
    rec("YVR", "NRT", "2026-07-01", { J: cab(60000) }),
    rec("YVR", "NRT", "2026-07-05", { J: cab(58000) }),
    rec("YVR", "LHR", "2026-07-01", { J: cab(70000) }, { dRegion: "Europe" }),
  ];
  const history = { "YVR-NRT-J": [{ t: "t0", m: 65000, d: 3 }, { t: "t1", m: 58000, d: 5 }] };
  const watches = { "YVR-NRT-J": { target: 60000 }, "YVR-LHR-J": { target: 60000 }, "YYZ-CDG-J": { target: null } };
  const byKey = Object.fromEntries(Explore.watchList(recs, history, watches).map((w) => [w.key, w]));
  assert.equal(byKey["YVR-NRT-J"].current, 58000);   // cheapest available now
  assert.equal(byKey["YVR-NRT-J"].underTarget, true); // 58k <= 60k
  assert.equal(byKey["YVR-NRT-J"].trend.dropped, true);
  assert.equal(byKey["YVR-LHR-J"].underTarget, false); // 70k > 60k
  assert.equal(byKey["YYZ-CDG-J"].available, false);  // not in the records
  assert.equal(byKey["YYZ-CDG-J"].current, null);
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

  // every sweet row's date context is internally consistent
  for (const r of sweet) {
    assert.ok(r.dateCount >= 1, "a row exists only if some date qualified");
    assert.ok(r.dateFirst <= r.dateLast, "span is ordered");
    assert.ok(r.bestDates.length >= 1 && r.bestDates.length <= r.dateCount);
    assert.equal(r.bestDate, r.bestDates[0]);
    assert.ok(r.bestDate >= r.dateFirst && r.bestDates[r.bestDates.length - 1] <= r.dateLast,
      "cheapest dates lie inside the availability span");
  }

  // affordability is monotonic in balance
  const lo = affordRows(recs, S({ balance: 40000 })).anyDest.size;
  const hi = affordRows(recs, S({ balance: 120000 })).anyDest.size;
  assert.ok(hi >= lo, "more balance reaches at least as many destinations");
});

// --- itinerary detail (trips.cache.json) helpers -----------------------------
const trip = (over = {}) => Object.assign(
  { id: "t", cabin: "J", flights: ["AC836", "LH2476"], via: ["MUC"], aircraft: ["Airbus A330-300", "Airbus A320neo"],
    dep: "2026-10-11T17:40", arr: "2026-10-12T15:40", duration: 1020, stops: 1, miles: 186800, taxes: 15282, seats: 5 }, over);
const TRIPS = { meta: { schema: 1 }, routes: { "YYZ-LHR": { pulledAt: "2026-09-11T12:00:00Z", dates: {
  "2026-10-11": [
    trip({ id: "slow-cheap", miles: 100000, duration: 1200 }),
    trip({ id: "fast-cheap", miles: 100000, duration: 900 }),
    trip({ id: "nonstop", via: [], stops: 0, miles: 120000, duration: 420, seats: 2 }),
    trip({ id: "eco", cabin: "Y", miles: 40000 }),
  ],
  "2026-10-12": [trip({ id: "next-day" })],
} } } };

test("tripsFor returns a date+cabin's itineraries cheapest-then-shortest, honoring direct/seats filters", () => {
  const { tripsFor } = Explore;
  assert.deepEqual(tripsFor(TRIPS, "YYZ", "LHR", "2026-10-11", "J", S()).map((t) => t.id), ["fast-cheap", "slow-cheap", "nonstop"]);
  assert.deepEqual(tripsFor(TRIPS, "YYZ", "LHR", "2026-10-11", "J", S({ direct: true })).map((t) => t.id), ["nonstop"]);
  assert.deepEqual(tripsFor(TRIPS, "YYZ", "LHR", "2026-10-11", "J", S({ seats: 3 })).map((t) => t.id), ["fast-cheap", "slow-cheap"]);
  assert.deepEqual(tripsFor(TRIPS, "YYZ", "LHR", "2026-10-11", "Y", S()).map((t) => t.id), ["eco"]);
  // "not pulled" / "no such date" / "no file" all come back as an empty list, never null
  assert.deepEqual(tripsFor(TRIPS, "YYZ", "LHR", "2026-10-13", "J", S()), []);
  assert.deepEqual(tripsFor(TRIPS, "YVR", "NRT", "2026-10-11", "J", S()), []);
  assert.deepEqual(tripsFor(null, "YYZ", "LHR", "2026-10-11", "J", S()), []);
});

test("routeDetail reports pull age, coverage and window, or null when the route was never pulled", () => {
  const { routeDetail } = Explore;
  assert.deepEqual(routeDetail(TRIPS, "YYZ", "LHR"), { pulledAt: "2026-09-11T12:00:00Z", dateCount: 2, tripCount: 5, dateWindow: null });
  // The window the route was pulled for rides along, so the UI can tell "outside the window" from "no itineraries".
  const windowed = { routes: { "YYZ-LHR": { ...TRIPS.routes["YYZ-LHR"], dateWindow: { start: "2026-09-11", end: "2026-12-10" } } } };
  assert.deepEqual(routeDetail(windowed, "YYZ", "LHR").dateWindow, { start: "2026-09-11", end: "2026-12-10" });
  assert.equal(routeDetail(TRIPS, "YVR", "NRT"), null);
  assert.equal(routeDetail(null, "YYZ", "LHR"), null);
});

test("detailStatus says why a leg has nothing before the day is even looked at", () => {
  const { detailStatus } = Explore;
  assert.equal(detailStatus(null, "YYZ", "LHR", "2026-10-11").status, "no-file");
  assert.equal(detailStatus(TRIPS, "YVR", "NRT", "2026-10-11").status, "not-pulled");
  const windowed = { routes: { "YYZ-LHR": { ...TRIPS.routes["YYZ-LHR"], dateWindow: { start: "2026-09-11", end: "2026-12-10" } } } };
  assert.equal(detailStatus(windowed, "YYZ", "LHR", "2026-12-11").status, "outside-window");
  assert.equal(detailStatus(windowed, "YYZ", "LHR", "2026-09-10").status, "outside-window");
  assert.equal(detailStatus(windowed, "YYZ", "LHR", "2026-12-10").status, "ok");
  assert.equal(detailStatus(windowed, "YYZ", "LHR", "2026-10-11").detail.dateCount, 2);
  // No window recorded (older file): can't tell "outside" from "none", so look at the day.
  assert.equal(detailStatus(TRIPS, "YYZ", "LHR", "2026-12-11").status, "ok");
  // A --date pull can add a day beyond the window; the file's contents win over the window.
  const late = { routes: { "YYZ-LHR": { ...windowed.routes["YYZ-LHR"], dates: { ...windowed.routes["YYZ-LHR"].dates, "2026-12-20": [trip({ id: "late" })] } } } };
  assert.equal(detailStatus(late, "YYZ", "LHR", "2026-12-20").status, "ok");
  assert.equal(detailStatus(late, "YYZ", "LHR", "2026-12-21").status, "outside-window");
});

test("layoverMinutes derives connection waits from segments, null without them", () => {
  const { layoverMinutes } = Explore;
  const withSegs = trip({ segments: [
    { flight: "AC836", from: "YYZ", to: "MUC", dep: "2026-10-11T17:40", arr: "2026-10-12T07:45", duration: 485 },
    { flight: "LH2476", from: "MUC", to: "LHR", dep: "2026-10-12T14:35", arr: "2026-10-12T15:40", duration: 125 },
  ] });
  assert.deepEqual(layoverMinutes(withSegs), [{ at: "MUC", minutes: 410 }]);
  assert.deepEqual(layoverMinutes(trip({ segments: [{ flight: "AC1", from: "YYZ", to: "LHR", dep: "2026-10-11T17:40", arr: "2026-10-12T05:40" }] })), []);
  assert.equal(layoverMinutes(trip()), null);
});

test("cheapestRouting picks the cheapest itinerary for a route (optionally one cabin/date) and reports its routing", () => {
  const { cheapestRouting } = Explore;
  assert.deepEqual(cheapestRouting(TRIPS, "YYZ", "LHR", { cabin: "J" }),
    { id: "fast-cheap", date: "2026-10-11", cabin: "J", stops: 1, via: ["MUC"], miles: 100000, duration: 900, flights: ["AC836", "LH2476"] });
  assert.equal(cheapestRouting(TRIPS, "YYZ", "LHR", { cabin: "J", date: "2026-10-12" }).id, "next-day");
  assert.equal(cheapestRouting(TRIPS, "YYZ", "LHR", { cabin: ["Y", "J"] }).id, "eco", "cabin may be a list");
  assert.equal(cheapestRouting(TRIPS, "YYZ", "LHR", {}).id, "eco", "no cabin filter = any cabin");
  assert.equal(cheapestRouting(TRIPS, "YYZ", "LHR", { cabin: "F" }), null);
  assert.equal(cheapestRouting(TRIPS, "YYZ", "LHR", { cabin: "J", date: "2026-10-13" }), null);
  assert.equal(cheapestRouting(TRIPS, "YVR", "NRT", { cabin: "J" }), null, "route never pulled");
  assert.equal(cheapestRouting(null, "YYZ", "LHR", { cabin: "J" }), null);
});

// --- Direct only: describe a cabin by its nonstop, not its cheapest (possibly connecting) itinerary ---
// Cheapest J is a 70k connection with 5 seats / $152.82 on AC+LH; the nonstop is 186.8k, 2 seats, $46.80, AC.
const mixedJ = () => ({ ...cab(70000, { seats: 5, direct: true, airlines: "AC, LH", taxes: 15282 }),
  directMiles: 186800, directSeats: 2, directTaxes: 4680, directAirlines: "AC" });

test("directView swaps in the nonstop's price, seats, taxes and carriers; older caches keep the cheapest values", () => {
  const { directView } = Explore;
  assert.deepEqual(directView(mixedJ()), { ...mixedJ(), miles: 186800, seats: 2, taxes: 4680, airlines: "AC" });
  const conn = cab(70000, { direct: false });
  assert.equal(directView(conn), conn, "not a nonstop: untouched");
  const old = cab(70000, { seats: 5, direct: true, airlines: "AC", taxes: 15282 }); // pre-PR#3 cache: no direct* seats/taxes
  assert.deepEqual(directView(old), { ...old, miles: 70000, seats: 5, taxes: 15282, airlines: "AC" });
  const oldPrice = { ...old, directMiles: 80000 };
  assert.equal(directView(oldPrice).miles, 80000, "directMiles has always been captured — use it");
});

test("qualifyingCabins under Direct only filters and reports on the nonstop's numbers", () => {
  const r = rec("YYZ", "LHR", "2026-10-11", { J: mixedJ() });
  assert.equal(qualifyingCabins(r, S({ direct: false }))[0].miles, 70000, "no filter: cheapest itinerary");
  const q = qualifyingCabins(r, S({ direct: true }))[0];
  assert.equal(q.miles, 186800);
  assert.equal(q.seats, 2);
  assert.equal(q.taxes, 4680);
  assert.equal(q.airlines, "AC");
  assert.deepEqual(qualifyingCabins(r, S({ direct: true, seats: 3 })), [], "Min seats 3 rejects the 2-seat nonstop");
  assert.equal(qualifyingCabins(r, S({ direct: false, seats: 3 })).length, 1, "…but not the 5-seat connection");
  assert.deepEqual(qualifyingCabins(r, S({ direct: true, maxMiles: 100000 })), [], "Max points applies to the nonstop price");
  assert.deepEqual(qualifyingCabins(r, S({ direct: true, afford: true, balance: 100000 })), [], "affordability too");
});

test("sweetRows, affordRows and collectLeg show nonstop numbers under Direct only", () => {
  const recs = [rec("YYZ", "LHR", "2026-10-11", { J: mixedJ() }, { taxesCurrency: "CAD" }),
                rec("LHR", "YYZ", "2026-10-20", { J: mixedJ() }, { taxesCurrency: "CAD" })];
  const sweet = sweetRows(recs, S({ direct: true }), { today: "2026-10-01" }).find((r) => r.origin === "YYZ");
  assert.equal(sweet.miles, 186800);
  assert.equal(sweet.taxes, 46.8);
  assert.equal(sweet.airlines, "AC");
  assert.equal(sweetRows(recs, S(), { today: "2026-10-01" }).find((r) => r.origin === "YYZ").miles, 70000);
  const aff = affordRows(recs, S({ direct: true, balance: 200000 })).list.find((r) => r.origin === "YYZ");
  assert.equal(aff.miles, 186800);
  assert.equal(aff.taxes, 46.8);
  assert.equal(affordRows(recs, S({ direct: true, balance: 100000 })).list.length, 0, "nonstop is out of reach");
  const leg = Explore.collectLeg(recs, "YYZ", "LHR", "J", S({ direct: true }), "2026-10-01")[0];
  assert.equal(leg.miles, 186800);
  assert.equal(leg.seats, 2);
  assert.equal(leg.taxes, 46.8);
  const { rows } = roundTripRows(recs, S({ direct: true }), { origin: "YYZ", dest: "LHR", cabin: "J", minNights: 1, maxNights: 30, today: "2026-10-01" });
  assert.equal(rows[0].totalMiles, 373600, "both legs priced as nonstops");
  assert.equal(rows[0].totalTaxes, 93.6);
});
