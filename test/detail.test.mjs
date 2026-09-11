// Tests for detail.mjs — the on-demand itinerary puller (normalizeTrip + pure helpers).
// Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTrip } from "../detail.mjs";

// --- fixtures: real seats.aero shapes captured 2026-09-11 (trimmed) ----------
// Search endpoint `AvailabilityTrips[]` element — no per-segment data.
const SEARCH_TRIP = {
  ID: "3IC5dGTYoYKLtmUWwrzB1XB2m2A", RouteID: "2ruhqamYeAlR1lZsUFRpkG1lqEx",
  AvailabilityID: "33OpOUQWoXWnD05TveDYpBGD6J9", TotalDuration: 703, Stops: 2,
  Carriers: "AC", RemainingSeats: 3, MileageCost: 42600, TotalTaxes: 5130,
  TaxesCurrency: "CAD", TaxesCurrencySymbol: "$", TotalSegmentDistance: 2641,
  OriginAirport: "RDU", DestinationAirport: "YVR", Connections: ["YYZ", "YYC"],
  Aircraft: ["Embraer E175", "Airbus A321", "Boeing 737 MAX 8"], FareClasses: ["X", "W", "W"],
  FlightNumbers: "AC8835, AC137, AC2025", DepartsAt: "2026-09-20T06:00:00Z",
  Cabin: "economy", ArrivesAt: "2026-09-20T14:43:00Z", Source: "aeroplan",
};
// /trips/{id} element — carries AvailabilitySegments (given out of order on purpose).
const TRIPS_TRIP = {
  ID: "3D6VDYSKr0gpBquMTQc6Jti5lcK", AvailabilityID: "34OzjwGWcayk42v90F6SRioxaFj", Cabin: "business",
  FlightNumbers: "AC836, LH2476", Carriers: "AC, LH", Connections: ["MUC"],
  Aircraft: ["Airbus A330-300", "Airbus A320neo"], FareClasses: ["P", "I"],
  Stops: 1, TotalDuration: 1020, RemainingSeats: 5, MileageCost: 186800,
  TotalTaxes: 15282, TaxesCurrency: "CAD", OriginAirport: "YYZ", DestinationAirport: "LHR",
  DepartsAt: "2026-10-11T17:40:00Z", ArrivesAt: "2026-10-12T15:40:00Z",
  AvailabilitySegments: [
    { FlightNumber: "LH2476", OriginAirport: "MUC", DestinationAirport: "LHR", Order: 1,
      DepartsAt: "2026-10-12T14:35:00Z", ArrivesAt: "2026-10-12T15:40:00Z", Duration: 125,
      AircraftName: "Airbus A320neo", AircraftCode: "32N", FareClass: "I", Cabin: "business" },
    { FlightNumber: "AC836", OriginAirport: "YYZ", DestinationAirport: "MUC", Order: 0,
      DepartsAt: "2026-10-11T17:40:00Z", ArrivesAt: "2026-10-12T07:45:00Z", Duration: 485,
      AircraftName: "Airbus A330-300", AircraftCode: "333", FareClass: "P", Cabin: "business" },
  ],
};

test("normalizeTrip maps a search-shape trip to the compact schema", () => {
  const t = normalizeTrip(SEARCH_TRIP);
  assert.deepEqual(t, {
    id: "3IC5dGTYoYKLtmUWwrzB1XB2m2A", availabilityId: "33OpOUQWoXWnD05TveDYpBGD6J9",
    origin: "RDU", destination: "YVR", cabin: "Y",
    flights: ["AC8835", "AC137", "AC2025"], carriers: "AC",
    via: ["YYZ", "YYC"], aircraft: ["Embraer E175", "Airbus A321", "Boeing 737 MAX 8"],
    fareClasses: ["X", "W", "W"],
    dep: "2026-09-20T06:00", arr: "2026-09-20T14:43",
    duration: 703, stops: 2, miles: 42600, taxes: 5130, taxesCurrency: "CAD", seats: 3,
  });
  assert.equal("segments" in t, false, "no segments key unless the API sent segments");
});

test("normalizeTrip keeps wall-clock times and drops the bogus Z / any offset", () => {
  // AC509 YYZ→ORD really departs 14:00 local and lands 14:55 local (115 min across one zone).
  const t = normalizeTrip({ ...SEARCH_TRIP, DepartsAt: "2026-10-11T14:00:00Z", ArrivesAt: "2026-10-11T14:55:00+02:00" });
  assert.equal(t.dep, "2026-10-11T14:00");
  assert.equal(t.arr, "2026-10-11T14:55");
});

test("normalizeTrip maps cabin words to Y/W/J/F and drops unknown cabins", () => {
  const cabinOf = (Cabin) => normalizeTrip({ ...SEARCH_TRIP, Cabin })?.cabin ?? null;
  assert.equal(cabinOf("economy"), "Y");
  assert.equal(cabinOf("premium"), "W");
  assert.equal(cabinOf("Premium Economy"), "W");
  assert.equal(cabinOf("business"), "J");
  assert.equal(cabinOf("first"), "F");
  assert.equal(normalizeTrip({ ...SEARCH_TRIP, Cabin: "suite" }), null);
  assert.equal(normalizeTrip({ ...SEARCH_TRIP, Cabin: undefined }), null);
});

test("normalizeTrip emits ordered segments from the /trips shape", () => {
  const t = normalizeTrip(TRIPS_TRIP);
  assert.equal(t.cabin, "J");
  assert.deepEqual(t.flights, ["AC836", "LH2476"]);
  assert.deepEqual(t.segments, [
    { flight: "AC836", from: "YYZ", to: "MUC", dep: "2026-10-11T17:40", arr: "2026-10-12T07:45",
      duration: 485, aircraft: "Airbus A330-300", aircraftCode: "333", fareClass: "P" },
    { flight: "LH2476", from: "MUC", to: "LHR", dep: "2026-10-12T14:35", arr: "2026-10-12T15:40",
      duration: 125, aircraft: "Airbus A320neo", aircraftCode: "32N", fareClass: "I" },
  ]);
});

test("normalizeTrip tolerates missing optional arrays and returns null on malformed input", () => {
  const bare = normalizeTrip({ ...SEARCH_TRIP, Connections: undefined, Aircraft: undefined, FareClasses: undefined, FlightNumbers: "" });
  assert.deepEqual(bare.via, []);
  assert.deepEqual(bare.aircraft, []);
  assert.deepEqual(bare.fareClasses, []);
  assert.deepEqual(bare.flights, []);
  assert.equal(normalizeTrip(null), null);
  assert.equal(normalizeTrip("nope"), null);
  assert.equal(normalizeTrip({ ...SEARCH_TRIP, OriginAirport: undefined }), null);
  assert.equal(normalizeTrip({ ...SEARCH_TRIP, DestinationAirport: "" }), null);
  assert.equal(normalizeTrip({ ...SEARCH_TRIP, DepartsAt: undefined }), null);
});

// --- CLI helpers: args, pull (fake fetch), merge -------------------------------
import { parseArgs, pullRoute, mergeRoutes } from "../detail.mjs";

test("parseArgs accepts ORIG-DEST routes (any case) and optional --start/--end", () => {
  const a = parseArgs(["yyz-lhr", "YVR-NRT", "--start", "2026-10-01", "--end", "2026-10-31"]);
  assert.deepEqual(a.routes, [{ origin: "YYZ", dest: "LHR" }, { origin: "YVR", dest: "NRT" }]);
  assert.equal(a.start, "2026-10-01");
  assert.equal(a.end, "2026-10-31");
  assert.equal(parseArgs(["YYZ-LHR"]).start, undefined);
  assert.deepEqual(parseArgs(["YYZ-LHR", "YYZ-LHR"]).routes, [{ origin: "YYZ", dest: "LHR" }], "duplicates collapse");
});

test("parseArgs rejects malformed routes, dates, and unknown flags", () => {
  assert.throws(() => parseArgs(["YYZLHR"]), /YYZLHR/);
  assert.throws(() => parseArgs(["YYZ-LHR", "--start", "10/01/2026"]), /--start/);
  assert.throws(() => parseArgs(["YYZ-LHR", "--start", "2026-13-01"]), /--start/, "impossible month");
  assert.throws(() => parseArgs(["YYZ-LHR", "--end", "2026-02-30"]), /--end/, "impossible day");
  assert.throws(() => parseArgs(["YYZ-LHR", "--bogus"]), /--bogus/);
  assert.throws(() => parseArgs([]), /usage/i);
});

// A fake fetch that serves two pages for one route and records the URLs it was asked for.
function fakeSearch(pages, { remaining = 900 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    const skip = parseInt(new URL(url).searchParams.get("skip") || "0", 10);
    const page = pages.find((p) => p.skip === skip) || { data: [], hasMore: false };
    return {
      ok: true, status: 200,
      headers: new Headers({ "x-ratelimit-remaining": String(remaining--) }),
      json: async () => ({ data: page.data, hasMore: page.hasMore, cursor: 123, count: 999 }),
      text: async () => "",
    };
  };
  return { fetchImpl, calls };
}
const searchRec = (Date, trips, Source = "aeroplan") => ({ ID: `rec-${Date}`, Date, Source, AvailabilityTrips: trips });

test("pullRoute paginates by skip, groups normalized trips by record date, skips other programs", async () => {
  const cheapLater = { ...SEARCH_TRIP, ID: "b", MileageCost: 30000, TotalDuration: 900, DepartsAt: "2026-09-21T09:00:00Z" };
  const { fetchImpl, calls } = fakeSearch([
    { skip: 0, hasMore: true, data: [searchRec("2026-09-20", [SEARCH_TRIP]), searchRec("2026-09-20", [SEARCH_TRIP], "united")] },
    { skip: 2, hasMore: false, data: [searchRec("2026-09-21", [cheapLater, SEARCH_TRIP, { ...SEARCH_TRIP, Cabin: "suite" }])] },
  ]);
  const r = await pullRoute({ origin: "RDU", dest: "YVR", start: "2026-09-20", end: "2026-09-21", apiKey: "k", fetchImpl, pauseMs: 0 });
  assert.equal(calls.length, 2);
  const q = calls[0].searchParams;
  assert.equal(calls[0].pathname, "/partnerapi/search");
  assert.equal(q.get("origin_airport"), "RDU");
  assert.equal(q.get("destination_airport"), "YVR");
  assert.equal(q.get("include_trips"), "true");
  assert.equal(q.get("sources"), "aeroplan");
  assert.equal(q.get("start_date"), "2026-09-20");
  assert.equal(calls[1].searchParams.get("skip"), "2", "second page advances by items received");
  assert.equal(calls[1].searchParams.get("cursor"), "123", "snapshot token is passed back");
  assert.deepEqual(Object.keys(r.dates), ["2026-09-20", "2026-09-21"]);
  assert.equal(r.dates["2026-09-20"].length, 1, "the united record is ignored");
  assert.deepEqual(r.dates["2026-09-21"].map((t) => t.id), ["b", SEARCH_TRIP.ID], "cheapest first; unknown cabin dropped");
  assert.equal(r.apiCalls, 2);
  assert.equal(r.quotaRemaining, 899);
  assert.equal(r.tripCount, 3);
});

test("pullRoute retries a 429 then succeeds, and throws on a persistent 500", async () => {
  let n = 0;
  const flaky = async () => (++n === 1
    ? { ok: false, status: 429, headers: new Headers({ "retry-after": "0" }), json: async () => ({}), text: async () => "slow down" }
    : { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: [], hasMore: false }), text: async () => "" });
  const r = await pullRoute({ origin: "A", dest: "B", start: "2026-01-01", end: "2026-01-02", apiKey: "k", fetchImpl: flaky, pauseMs: 0 });
  assert.equal(r.apiCalls, 2);
  const dead = async () => ({ ok: false, status: 500, statusText: "boom", headers: new Headers(), json: async () => ({}), text: async () => "" });
  await assert.rejects(
    () => pullRoute({ origin: "A", dest: "B", start: "2026-01-01", end: "2026-01-02", apiKey: "k", fetchImpl: dead, pauseMs: 0, maxRetries: 1 }),
    /HTTP 500/);
});

test("mergeRoutes replaces only the pulled routes and stamps meta", () => {
  const old = { meta: { source: "aeroplan", generatedAt: "2026-09-01T00:00:00Z", schema: 1 },
    routes: { "YVR-NRT": { pulledAt: "2026-09-01T00:00:00Z", dates: { "2026-09-05": [] } },
              "YYZ-LHR": { pulledAt: "2026-09-01T00:00:00Z", dates: { "2026-09-05": [] } } } };
  const pulled = { "YYZ-LHR": { pulledAt: "2026-09-11T00:00:00Z", dateWindow: { start: "2026-09-11", end: "2026-12-07" }, dates: { "2026-10-11": [{ id: "x" }] } } };
  const out = mergeRoutes(old, pulled, "2026-09-11T00:00:00Z");
  assert.deepEqual(out.routes["YVR-NRT"], old.routes["YVR-NRT"], "untouched route survives byte-for-byte");
  assert.deepEqual(out.routes["YYZ-LHR"], pulled["YYZ-LHR"]);
  assert.deepEqual(out.meta, { source: "aeroplan", generatedAt: "2026-09-11T00:00:00Z", schema: 1 });
  assert.deepEqual(Object.keys(mergeRoutes(null, pulled, "t").routes), ["YYZ-LHR"], "no existing file");
});
