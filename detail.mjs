#!/usr/bin/env node
// Aeroplan Award Explorer — itinerary detail puller
// Pulls flight-level detail (flight numbers, connections, aircraft, times, duration) for
// chosen routes from the seats.aero Partner API and writes a second, gitignored cache
// (trips.cache.json) that the explorer reads alongside aeroplan-cache.json.
//
// Run:   node detail.mjs YYZ-LHR YVR-NRT            (one API request per route)
// Needs: a seats.aero Pro API key in env var SEATS_AERO_KEY (or a local .env file).
//
// Zero dependencies — uses Node 18+ native fetch.

import { fileURLToPath, pathToFileURL } from "node:url";
import { toInt } from "./ingest.mjs"; // importing ingest.mjs never runs the ingester

// Run only when executed directly — never when a test imports normalizeTrip().
if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error("\n❌ Detail pull failed:", err?.message || err);
    process.exit(1);
  });
}

function isMain(metaUrl) {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}

async function main() {
  console.error("detail.mjs: CLI not implemented yet (see tasks/plan.md, Task 2).");
  process.exit(1);
}

// --- normalization -----------------------------------------------------------

// seats.aero names cabins with words; the explorer uses the one-letter codes everywhere.
const CABIN_CODE = { economy: "Y", premium: "W", "premium economy": "W", business: "J", first: "F" };

// Keep the wall-clock part of an API timestamp. seats.aero sends LOCAL times with a bogus
// "Z" suffix (YYZ→ORD "14:00Z"→"14:55Z" is a 115-minute flight), so converting through
// Date would shift every time by the viewer's zone. "2026-10-11T14:00:00Z" -> "2026-10-11T14:00".
function localStamp(v) {
  const m = String(v ?? "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  return m ? m[1] : null;
}

const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const splitFlights = (v) => String(v ?? "").split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);

// One raw trip (either the search endpoint's AvailabilityTrips[] element or a /trips/{id}
// element) -> the compact record stored in trips.cache.json. Returns null when malformed
// or when the cabin is not one the explorer knows.
function normalizeTrip(raw) {
  if (!raw || typeof raw !== "object") return null;
  const origin = raw.OriginAirport, destination = raw.DestinationAirport;
  const dep = localStamp(raw.DepartsAt);
  if (!origin || !destination || !dep) return null;
  const cabin = CABIN_CODE[String(raw.Cabin ?? "").trim().toLowerCase()];
  if (!cabin) return null;

  const t = {
    id: raw.ID || null,
    availabilityId: raw.AvailabilityID || null,
    origin: String(origin).toUpperCase(),
    destination: String(destination).toUpperCase(),
    cabin,
    flights: splitFlights(raw.FlightNumbers),
    carriers: String(raw.Carriers ?? "").trim(),
    via: strList(raw.Connections),
    aircraft: strList(raw.Aircraft),
    fareClasses: strList(raw.FareClasses),
    dep,
    arr: localStamp(raw.ArrivesAt),
    duration: toInt(raw.TotalDuration) || 0,   // minutes, whole itinerary
    stops: toInt(raw.Stops) || 0,
    miles: toInt(raw.MileageCost) || 0,
    taxes: toInt(raw.TotalTaxes) || 0,          // cents, like the main cache
    taxesCurrency: String(raw.TaxesCurrency ?? "").toUpperCase(),
    seats: toInt(raw.RemainingSeats) || 0,
  };

  // Per-segment detail only comes from /trips/{id}; it is what makes layovers computable.
  if (Array.isArray(raw.AvailabilitySegments) && raw.AvailabilitySegments.length) {
    t.segments = [...raw.AvailabilitySegments]
      .sort((a, b) => (toInt(a.Order) || 0) - (toInt(b.Order) || 0))
      .map((s) => ({
        flight: String(s.FlightNumber ?? ""),
        from: String(s.OriginAirport ?? "").toUpperCase(),
        to: String(s.DestinationAirport ?? "").toUpperCase(),
        dep: localStamp(s.DepartsAt),
        arr: localStamp(s.ArrivesAt),
        duration: toInt(s.Duration) || 0,
        aircraft: String(s.AircraftName ?? ""),
        aircraftCode: String(s.AircraftCode ?? ""),
        fareClass: String(s.FareClass ?? ""),
      }));
  }
  return t;
}

// Exported for unit tests. Importing this file does NOT run the puller (see isMain).
export { normalizeTrip, localStamp };
