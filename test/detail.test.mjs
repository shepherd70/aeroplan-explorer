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
