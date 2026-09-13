// The committed samples are synthetic (make-sample.mjs). These tests pin what the explorer and
// the repo rely on: the cache schema, determinism, the size budget, and that every offline
// demo path (itineraries, layovers, round trips, trends) has data behind it.
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesize } from "../make-sample.mjs";
import Explore from "../lib/explore.js";

const CABINS = ["Y", "W", "J", "F"];
const S = (over = {}) => ({ home: [], cabins: CABINS, start: "", end: "", seats: 0, maxMiles: 0, balance: 0, direct: false, afford: false, roundTrip: false, pointValue: 0, ...over });
const { cache, trips } = synthesize({ start: "2026-09-13", seed: 1 });

test("synthesize is deterministic for a given start and seed", () => {
  const again = synthesize({ start: "2026-09-13", seed: 1 });
  assert.equal(JSON.stringify(again.cache), JSON.stringify(cache));
  assert.equal(JSON.stringify(again.trips), JSON.stringify(trips));
  assert.notEqual(JSON.stringify(synthesize({ start: "2026-09-13", seed: 2 }).cache), JSON.stringify(cache));
});

test("the cache sample has the ingester's record shape and stays under the commit guard", () => {
  assert.ok(cache.meta.synthetic && cache.meta.sample, "flagged as synthetic");
  assert.ok(cache.records.length > 500, "enough records to browse");
  assert.ok(Buffer.byteLength(JSON.stringify(cache)) < 900 * 1024, "under the 900 KB budget (pre-commit guard is 1 MB)");
  const win = cache.meta.dateWindow;
  for (const r of cache.records) {
    assert.match(r.id, /^syn-/);
    assert.ok(r.date >= win.start && r.date <= win.end, "date inside the window");
    assert.equal(r.taxesCurrency, "CAD");
    assert.ok(r.distance > 0);
    for (const X of CABINS) {
      const c = r.cabins[X];
      assert.deepEqual(Object.keys(c).sort(), ["airlines", "available", "direct", "directAirlines", "directMiles", "directSeats", "directTaxes", "miles", "seats", "taxes"]);
      if (!c.available) { assert.equal(c.miles, 0); continue; }
      assert.ok(c.miles > 0 && c.seats > 0 && c.taxes > 0);
      if (c.direct) assert.ok(c.directMiles >= c.miles && c.directSeats > 0 && c.directAirlines, "nonstop numbers filled in");
      else assert.ok(!c.directMiles && !c.directSeats && !c.directAirlines);
    }
    assert.ok(CABINS.some((X) => r.cabins[X].available), "records without any bookable cabin are dropped, like the ingester does");
  }
});

test("every offline demo path has data: itineraries, layovers, round trips, trends, sweet spots", () => {
  const out = trips.routes["YYZ-LHR"], ret = trips.routes["LHR-YYZ"];
  assert.ok(out && ret, "both directions of the detailed pair");
  const byKey = new Set(cache.records.map((r) => `${r.origin}-${r.destination}-${r.date}`));
  for (const [key, entry] of Object.entries(trips.routes)) {
    for (const [date, list] of Object.entries(entry.dates)) {
      assert.ok(byKey.has(`${key}-${date}`), `${key} ${date}: detail only on days the cache has`);
      assert.ok(list.length > 0);
      for (const t of list) {
        assert.match(t.dep, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/); assert.match(t.arr, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
        assert.ok(CABINS.includes(t.cabin) && t.miles > 0 && t.duration > 0 && t.flights.length === t.stops + 1);
        assert.equal(t.via.length, t.stops);
      }
    }
  }
  // Return legs exist only on detailed days, so every pairable round trip has flights to show.
  const retDates = new Set(Object.keys(ret.dates));
  for (const r of cache.records.filter((x) => x.origin === "LHR")) assert.ok(retDates.has(r.date), `return leg ${r.date} has detail`);
  const rt = Explore.roundTripRows(cache.records, S(), { origin: "YYZ", dest: "LHR", cabin: "J", minNights: 3, maxNights: 21, today: "2026-09-13" });
  assert.ok(rt.hasReturnData && rt.rows.length >= 3, "Round trips pairs several J trips");
  // Exact layovers on the first detailed day.
  const withSegs = Object.values(out.dates).flat().filter((t) => t.segments);
  assert.ok(withSegs.length > 0);
  for (const t of withSegs) { const lay = Explore.layoverMinutes(t); assert.ok(lay.length === 1 && lay[0].minutes > 0, "layover computable and positive"); }
  // Trend column: drops, rises and a NEW.
  const trends = Object.values(cache.history).map(Explore.historyTrend);
  assert.ok(trends.some((t) => t.dropped) && trends.some((t) => t.rose) && trends.some((t) => t.isNew));
  // Sweet-spot finder flags something (needs groups of >= 5 routes per region pair + cabin).
  const sweet = Explore.sweetRows(cache.records, S(), { today: "2026-09-13" });
  assert.ok(sweet.filter((r) => r.sweet).length >= 3);
});
