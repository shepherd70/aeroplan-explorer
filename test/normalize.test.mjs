// Unit tests for the ingester's normalization (ingest.mjs exports these).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, toInt, hasAnyCabin } from "../ingest.mjs";

test("normalize maps Route fields, uppercases codes, trims the date", () => {
  const rec = normalize({
    ID: "x1", Date: "2026-07-01T00:00:00Z",
    Route: { OriginAirport: "yvr", DestinationAirport: "nrt", OriginRegion: "North America", DestinationRegion: "Asia", Distance: 4685 },
    JAvailable: true, JMileageCost: "60000", JRemainingSeats: 4, JDirect: true, JAirlines: "NH",
  });
  assert.equal(rec.id, "x1");
  assert.equal(rec.date, "2026-07-01");
  assert.equal(rec.origin, "YVR");
  assert.equal(rec.destination, "NRT");
  assert.equal(rec.originRegion, "North America");
  assert.equal(rec.destinationRegion, "Asia");
  assert.equal(rec.distance, 4685);
  assert.deepEqual(rec.cabins.J, { available: true, miles: 60000, directMiles: 0, seats: 4, direct: true, airlines: "NH" });
});

test("normalize parses comma-formatted mileage strings", () => {
  const rec = normalize({ Date: "2026-07-01", OriginAirport: "YYZ", DestinationAirport: "LHR", JMileageCost: "70,000", JAvailable: true });
  assert.equal(rec.cabins.J.miles, 70000);
});

test("availability falls back to miles>0 when the *Available flag is absent", () => {
  const rec = normalize({ Date: "2026-07-01", OriginAirport: "YYZ", DestinationAirport: "LHR", YMileageCost: "25000" });
  assert.equal(rec.cabins.Y.available, true);
  const none = normalize({ Date: "2026-07-01", OriginAirport: "YYZ", DestinationAirport: "LHR", YMileageCost: "0" });
  assert.equal(none.cabins.Y.available, false);
});

test("an explicit *Available:false wins even when miles are present", () => {
  const rec = normalize({ Date: "2026-07-01", OriginAirport: "YYZ", DestinationAirport: "LHR", JMileageCost: "60000", JAvailable: false });
  assert.equal(rec.cabins.J.available, false);
});

test("normalize returns null when origin / destination / date is missing", () => {
  assert.equal(normalize({ OriginAirport: "YYZ", DestinationAirport: "LHR" }), null); // no date
  assert.equal(normalize({ Date: "2026-07-01", DestinationAirport: "LHR" }), null);   // no origin
  assert.equal(normalize(null), null);
});

test("toInt handles numbers, formatted strings, and garbage", () => {
  assert.equal(toInt(1234), 1234);
  assert.equal(toInt("85,000"), 85000);
  assert.equal(toInt("  12 "), 12);
  assert.equal(toInt(null), 0);
  assert.equal(toInt("n/a"), 0);
  assert.equal(toInt(12.7), 13); // rounds
});

test("hasAnyCabin is true only with an available, priced cabin", () => {
  const yes = normalize({ Date: "2026-07-01", OriginAirport: "A", DestinationAirport: "B", WMileageCost: "30000", WAvailable: true });
  const no = normalize({ Date: "2026-07-01", OriginAirport: "A", DestinationAirport: "B", WMileageCost: "30000", WAvailable: false });
  assert.equal(hasAnyCabin(yes), true);
  assert.equal(hasAnyCabin(no), false);
});
