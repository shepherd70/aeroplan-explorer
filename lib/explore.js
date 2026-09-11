// lib/explore.js — pure data transforms for the Aeroplan Award Explorer.
//
// Dual-target by design, so there is still NO build step:
//   • Browser: index.html loads this as a classic <script> (works over file://,
//     unlike ES modules) and it attaches a single global `Explore` namespace.
//   • Node:    unit tests `import`/`require` it; it exports the same namespace.
//
// Every function here is PURE: no DOM, no module-level mutable state, no reliance
// on browser globals. State (the loaded records, the user's filter `settings`,
// cash fares, "today") is passed in. That is exactly what makes it testable.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // Node
  else root.Explore = api;                                                    // browser
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CABINS = ["Y", "W", "J", "F"]; // economy, premium economy, business, first

  const activeCabins = (settings) => CABINS.filter((X) => settings.cabins.includes(X));
  const tripMult = (settings) => (settings.roundTrip ? 2 : 1); // round trip ≈ 2× one-way points

  // A record's cabins that pass ALL active filters; returns [{cabin, ...cabinData}].
  // A cabin's miles/seats/taxes/airlines describe its CHEAPEST itinerary, which may connect.
  // Under "Direct only" the user is asking about the nonstop, so describe that instead using
  // the direct* fields the ingester captures. Caches from before those fields existed fall
  // back to the cheapest values (directMiles has always been there). Not a nonstop: unchanged.
  function directView(c) {
    if (!c || !c.direct) return c;
    return {
      ...c,
      miles: c.directMiles > 0 ? c.directMiles : c.miles,
      seats: c.directSeats != null ? c.directSeats : c.seats,
      taxes: c.directTaxes != null ? c.directTaxes : c.taxes,
      airlines: c.directAirlines || c.airlines,
    };
  }

  function qualifyingCabins(rec, settings) {
    const out = [];
    const mult = tripMult(settings);
    for (const X of activeCabins(settings)) {
      let c = rec.cabins?.[X];
      if (!c || !c.available || !(c.miles > 0)) continue;
      if (settings.direct) { if (!c.direct) continue; c = directView(c); }
      if (settings.seats > 0 && c.seats < settings.seats) continue;
      if (settings.maxMiles > 0 && c.miles > settings.maxMiles) continue;
      if (settings.afford && !(settings.balance > 0 && c.miles * mult <= settings.balance)) continue;
      out.push({ cabin: X, ...c });
    }
    return out;
  }

  // Records passing home/date filters, each with its qualifying cabins: [{rec, q}].
  function filtered(records, settings) {
    const home = settings.home || [];
    const s = settings.start, e = settings.end;
    const out = [];
    for (const r of records) {
      if (home.length && !home.includes(r.origin)) continue;
      if (s && r.date < s) continue;
      if (e && r.date > e) continue;
      const q = qualifyingCabins(r, settings);
      if (!q.length) continue;
      out.push({ rec: r, q });
    }
    return out;
  }

  // View 1: one row per destination, cheapest points per cabin + date count.
  function discoverRows(records, settings) {
    const byDest = new Map();
    for (const { rec, q } of filtered(records, settings)) {
      let d = byDest.get(rec.destination);
      if (!d) {
        d = { destination: rec.destination, region: rec.destinationRegion, distance: rec.distance,
              dates: new Set(), direct: false, cab: { Y: Infinity, W: Infinity, J: Infinity, F: Infinity },
              bestOrigin: null, bestMiles: Infinity };
        byDest.set(rec.destination, d);
      }
      d.dates.add(rec.date);
      if (rec.distance && !d.distance) d.distance = rec.distance;
      for (const c of q) {
        if (c.miles < d.cab[c.cabin]) d.cab[c.cabin] = c.miles;
        if (c.miles < d.bestMiles) { d.bestMiles = c.miles; d.bestOrigin = rec.origin; }
        if (c.direct) d.direct = true;
      }
    }
    return [...byDest.values()].map((d) => {
      const cheapest = Math.min(...CABINS.map((X) => d.cab[X]));
      return { ...d, dateCount: d.dates.size, cheapest: isFinite(cheapest) ? cheapest : null };
    });
  }

  // View 2: one row per origin-destination-cabin, with value metrics + sweet-spot flag.
  // opts: { manualFares, faresCurrency, today } — manualFares are the user's typed cash
  // fares keyed "ORIG-DEST-CABIN", faresCurrency the currency those fares are in, and
  // today (YYYY-MM-DD) drops past dates so cpp only reflects bookable departures.
  // Each row carries its date context: dateCount / dateFirst / dateLast (qualifying
  // departure dates in the window) and bestDate / bestDates (when the cheapest price flies).
  function sweetRows(records, settings, opts) {
    const { manualFares = {}, today = "", faresCurrency = "" } = opts || {};
    const byTriple = new Map();
    for (const { rec, q } of filtered(records, settings)) {
      if (today && rec.date < today) continue;
      for (const c of q) {
        const k = `${rec.origin}-${rec.destination}-${c.cabin}`;
        let row = byTriple.get(k);
        if (!row) {
          row = { origin: rec.origin, destination: rec.destination, cabin: c.cabin,
                  region: `${rec.originRegion}→${rec.destinationRegion}`,
                  regionKey: `${rec.originRegion}|${rec.destinationRegion}|${c.cabin}`,
                  distance: rec.distance, miles: Infinity, seats: 0, direct: false, airlines: "",
                  taxes: null, taxesCurrency: "", dates: new Set(), bestDates: new Set() };
          byTriple.set(k, row);
        }
        row.dates.add(rec.date);
        if (c.miles < row.miles) {
          row.miles = c.miles; row.seats = c.seats; row.direct = c.direct; row.airlines = c.airlines;
          // taxes of the cheapest option, in dollars (null when the cache predates tax capture)
          row.taxes = c.taxes != null ? c.taxes / 100 : null;
          row.taxesCurrency = (rec.taxesCurrency || "").toUpperCase();
          row.bestDates = new Set([rec.date]);
        } else if (c.miles === row.miles) {
          row.bestDates.add(rec.date);
        }
        if (rec.distance && !row.distance) row.distance = rec.distance;
      }
    }
    const rows = [...byTriple.values()];
    const fc = (faresCurrency || "").toUpperCase();
    for (const r of rows) {
      const dates = [...r.dates].sort();
      r.dateCount = dates.length;
      r.dateFirst = dates[0] ?? null;
      r.dateLast = dates[dates.length - 1] ?? null;
      r.bestDates = [...r.bestDates].sort();
      r.bestDate = r.bestDates[0] ?? null;
      delete r.dates;
      r.mpm = r.distance > 0 ? (r.miles / r.distance) * 1000 : null;
      r.fareKey = `${r.origin}-${r.destination}-${r.cabin}`;
      const fare = manualFares[r.fareKey];
      r.fareValue = fare ?? null;
      // Cents per point, tax-honest: redeeming still costs the award's cash taxes out of
      // pocket, so the points only "buy" (fare − taxes). Net only when fare and tax share a
      // currency; otherwise fall back to gross and flag it (cppIsNet) for the UI.
      if (fare > 0 && r.miles > 0) {
        const canNet = r.taxes != null && fc && r.taxesCurrency && fc === r.taxesCurrency;
        const basis = canNet ? Math.max(0, fare - r.taxes) : fare;
        r.cpp = (basis * 100) / r.miles;
        r.cppIsNet = canNet;
      } else {
        r.cpp = null;
        r.cppIsNet = false;
      }
      r.estValue = settings.pointValue > 0 ? (r.miles * settings.pointValue) / 100 : null;
      r.beatsValuation = r.cpp != null && settings.pointValue > 0 ? r.cpp >= settings.pointValue : null;
    }
    // Sweet spot = in the cheapest ~25% of points-per-mile for its region pair + cabin.
    // Thin groups (< MIN_GROUP routes) are never flagged — a quantile would be meaningless.
    const MIN_GROUP = 5, QUANTILE = 0.25;
    const groups = {};
    for (const r of rows) if (r.mpm != null) (groups[r.regionKey] ||= []).push(r.mpm);
    const cutoff = {};
    for (const k in groups) {
      const a = groups[k].sort((x, y) => x - y);
      cutoff[k] = a.length < MIN_GROUP ? -Infinity : a[Math.max(0, Math.ceil(a.length * QUANTILE) - 1)];
    }
    for (const r of rows) r.sweet = r.mpm != null && r.mpm <= cutoff[r.regionKey];
    return rows;
  }

  // View 4: destinations reachable within `settings.balance` (× trip multiplier).
  // Returns { reach:{Y,W,J,F:Set}, anyDest:Set, list:[{origin,destination,cabin,miles,dates:Set,direct,distance}] }.
  function affordRows(records, settings) {
    const bal = settings.balance;
    const mult = tripMult(settings);
    const reach = { Y: new Set(), W: new Set(), J: new Set(), F: new Set() };
    const anyDest = new Set();
    const list = [];
    const seen = new Map();
    for (const { rec, q } of filtered(records, settings)) {
      for (const c of q) {
        if (c.miles * mult > bal) continue;
        reach[c.cabin].add(rec.destination); anyDest.add(rec.destination);
        const k = `${rec.origin}-${rec.destination}-${c.cabin}`;
        const prev = seen.get(k);
        if (!prev) {
          const row = { origin: rec.origin, destination: rec.destination, cabin: c.cabin,
                        miles: c.miles, dates: new Set([rec.date]), direct: c.direct, distance: rec.distance,
                        taxes: c.taxes != null ? c.taxes / 100 : null, taxesCurrency: (rec.taxesCurrency || "").toUpperCase() };
          seen.set(k, row); list.push(row);
        } else {
          prev.dates.add(rec.date);
          if (c.miles < prev.miles) {
            prev.miles = c.miles; prev.direct = c.direct;
            prev.taxes = c.taxes != null ? c.taxes / 100 : null;
            prev.taxesCurrency = (rec.taxesCurrency || "").toUpperCase();
          }
        }
      }
    }
    return { reach, anyDest, list };
  }

  // Whole days from date a to date b (both "YYYY-MM-DD"). UTC math avoids DST drift.
  function daysBetween(a, b) {
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  }

  // Cheapest-points availability per date for one directional leg (o -> d, cabin X),
  // honoring the shared date / seats / direct filters. Used by the round-trip pairing.
  function collectLeg(records, o, d, X, settings, today) {
    const byDate = new Map();
    for (const r of records) {
      if (r.origin !== o || r.destination !== d) continue;
      if (today && r.date < today) continue;
      if (settings.start && r.date < settings.start) continue;
      if (settings.end && r.date > settings.end) continue;
      let c = r.cabins?.[X];
      if (!c || !c.available || !(c.miles > 0)) continue;
      if (settings.direct) { if (!c.direct) continue; c = directView(c); }
      if (settings.seats > 0 && c.seats < settings.seats) continue;
      const prev = byDate.get(r.date);
      if (!prev || c.miles < prev.miles) {
        byDate.set(r.date, { date: r.date, miles: c.miles,
          taxes: c.taxes != null ? c.taxes / 100 : null,
          taxesCurrency: (r.taxesCurrency || "").toUpperCase(),
          direct: c.direct, seats: c.seats });
      }
    }
    return [...byDate.values()];
  }

  // View 5: real round trips. Pairs each outbound (origin->dest) date with the cheapest-points
  // return (dest->origin) landing within [minNights, maxNights] nights, summing points and
  // (same-currency) taxes. cpp uses the two directional cash fares when both are present.
  // Returns { rows, hasOutboundData, hasReturnData } so the UI can prompt a returns pull.
  function roundTripRows(records, settings, opts) {
    const { origin, dest, cabin, minNights = 0, maxNights = 60,
            manualFares = {}, faresCurrency = "", today = "" } = opts || {};
    if (!origin || !dest || !cabin) return { rows: [], hasOutboundData: false, hasReturnData: false };
    const out = collectLeg(records, origin, dest, cabin, settings, today);
    const ret = collectLeg(records, dest, origin, cabin, settings, today);
    ret.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const fc = (faresCurrency || "").toUpperCase();
    const fareOut = manualFares[`${origin}-${dest}-${cabin}`];
    const fareRet = manualFares[`${dest}-${origin}-${cabin}`];
    const rows = [];
    for (const o of out) {
      let best = null;
      for (const r of ret) {
        const nights = daysBetween(o.date, r.date);
        if (nights < minNights || nights > maxNights) continue;
        if (!best || r.miles < best.miles || (r.miles === best.miles && r.date < best.date)) best = r;
      }
      if (!best) continue;
      const totalMiles = o.miles + best.miles;
      const taxKnown = o.taxes != null && best.taxes != null && o.taxesCurrency && o.taxesCurrency === best.taxesCurrency;
      const totalTaxes = taxKnown ? o.taxes + best.taxes : null;
      const taxesCurrency = taxKnown ? o.taxesCurrency : "";
      let rtFare = null, cpp = null, cppIsNet = false;
      if (fareOut > 0 && fareRet > 0) {
        rtFare = fareOut + fareRet;
        const canNet = totalTaxes != null && fc && taxesCurrency && fc === taxesCurrency;
        cpp = ((canNet ? Math.max(0, rtFare - totalTaxes) : rtFare) * 100) / totalMiles;
        cppIsNet = canNet;
      }
      rows.push({ origin, dest, cabin, dateOut: o.date, dateRet: best.date, nights: daysBetween(o.date, best.date),
        milesOut: o.miles, milesRet: best.miles, totalMiles,
        taxesOut: o.taxes, taxesRet: best.taxes, totalTaxes, taxesCurrency,
        directOut: o.direct, directRet: best.direct, seatsOut: o.seats, seatsRet: best.seats,
        rtFare, cpp, cppIsNet });
    }
    return { rows, hasOutboundData: out.length > 0, hasReturnData: ret.length > 0 };
  }

  // --- price / availability history ------------------------------------------
  // One observation per route+cabin for the current ingest: cheapest available miles
  // (across all departure dates in the window) and how many dates were available.
  // Keyed "ORIG-DEST-CABIN". The ingester feeds this into mergeHistory().
  function observeHistory(records) {
    const obs = {};
    for (const r of records) {
      for (const X of CABINS) {
        const c = r.cabins?.[X];
        if (!c || !c.available || !(c.miles > 0)) continue;
        const k = `${r.origin}-${r.destination}-${X}`;
        const o = obs[k] || (obs[k] = { m: Infinity, dates: new Set() });
        if (c.miles < o.m) o.m = c.miles;
        o.dates.add(r.date);
      }
    }
    for (const k in obs) { obs[k] = { m: obs[k].m, d: obs[k].dates.size }; }
    return obs;
  }

  // Append this ingest's observations to the carried-forward history, capping each series
  // and pruning routes that have gone unavailable for a while. Pure — the ingester persists
  // the result as cache.history. A series entry is { t: ingestISO, m: cheapestMiles|0, d: #dates };
  // m===0 records that the route had no availability at that ingest.
  function mergeHistory(prev, observations, t, opts) {
    const { maxObs = 24, pruneAfter = 3 } = opts || {};
    const out = {};
    const keys = new Set([...Object.keys(prev || {}), ...Object.keys(observations || {})]);
    for (const k of keys) {
      const series = prev && prev[k] ? prev[k].slice() : [];
      const o = observations ? observations[k] : null;
      series.push({ t, m: o ? o.m : 0, d: o ? o.d : 0 });
      while (series.length > maxObs) series.shift();
      const tail = series.slice(-pruneAfter);
      if (tail.length >= pruneAfter && tail.every((s) => !(s.m > 0))) continue; // dead route — drop
      out[k] = series;
    }
    return out;
  }

  // Summarize a history series for display. null when there's nothing useful yet.
  function historyTrend(series) {
    if (!series || !series.length) return null;
    const last = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const available = last.m > 0;
    const wasAvailable = prev ? prev.m > 0 : false;
    const deltaMiles = available && wasAvailable ? last.m - prev.m : null;
    return {
      available,
      isNew: available && prev != null && !wasAvailable, // appeared since the previous ingest
      current: available ? last.m : null,
      previous: wasAvailable ? prev.m : null,
      deltaMiles,                                         // negative = cheaper now
      dropped: deltaMiles != null && deltaMiles < 0,
      rose: deltaMiles != null && deltaMiles > 0,
      observations: series.length,
      spark: series.map((s) => s.m),                      // 0 marks unavailable at that ingest
    };
  }

  // Status of each watched route+cabin: current cheapest points (null when unavailable now),
  // the optional points target, whether it's met, and the price trend. `watches` is keyed
  // "ORIG-DEST-CABIN" -> { target }. Pure.
  function watchList(records, history, watches) {
    const obs = observeHistory(records);
    const out = [];
    for (const key of Object.keys(watches || {})) {
      const parts = key.split("-");
      const cabin = parts.pop(), dest = parts.pop(), origin = parts.join("-");
      const o = obs[key];
      const current = o ? o.m : null;
      const w = watches[key] || {};
      const target = w.target != null && w.target > 0 ? w.target : null;
      out.push({
        key, origin, dest, cabin,
        current, dates: o ? o.d : 0,
        available: current != null,
        target,
        underTarget: current != null && target != null ? current <= target : null,
        trend: history ? historyTrend(history[key]) : null,
      });
    }
    return out;
  }

  // --- Itinerary detail (trips.cache.json from `node detail.mjs`) ------------------
  // `trips` is the parsed trips cache ({ meta, routes: { "ORIG-DEST": { pulledAt, dates: { date: [trip] } } } })
  // or null when none is loaded. All three helpers are safe to call with null.

  const routeEntry = (trips, origin, dest) => trips?.routes?.[`${origin}-${dest}`] || null;

  // Itineraries for one route + date + cabin, cheapest first then shortest, honoring the
  // global "Direct only" and "Min seats" filters. Always an array: an empty list means
  // "nothing to show" — use routeDetail() to tell "never pulled" from "no itineraries".
  function tripsFor(trips, origin, dest, date, cabin, settings) {
    const list = routeEntry(trips, origin, dest)?.dates?.[date] || [];
    const minSeats = settings?.seats > 0 ? settings.seats : 0;
    return list
      .filter((t) => t.cabin === cabin && (!settings?.direct || t.stops === 0) && t.seats >= minSeats)
      .sort((a, b) => a.miles - b.miles || a.duration - b.duration);
  }

  // Pull status of a route: when it was last pulled and how much it covers. null = never pulled.
  function routeDetail(trips, origin, dest) {
    const r = routeEntry(trips, origin, dest);
    if (!r) return null;
    const dates = Object.values(r.dates || {});
    return { pulledAt: r.pulledAt || null, dateCount: dates.length, tripCount: dates.reduce((n, d) => n + d.length, 0) };
  }

  // Connection waits from per-segment times (only present after a /trips/{id} pull).
  // Stamps are local wall-clock strings; arrival and next departure share the connection's
  // zone, so a naive difference is exact. null without segments; [] for a nonstop.
  function layoverMinutes(trip) {
    const segs = trip?.segments;
    if (!Array.isArray(segs)) return null;
    const mins = (s) => { const [d, t] = String(s || "").split("T"); const [y, m, dd] = d.split("-").map(Number); const [h, mi] = (t || "0:0").split(":").map(Number); return Date.UTC(y, m - 1, dd, h, mi) / 60000; };
    const out = [];
    for (let i = 1; i < segs.length; i++) {
      out.push({ at: segs[i].from, minutes: Math.round(mins(segs[i].dep) - mins(segs[i - 1].arr)) });
    }
    return out;
  }

  // The cheapest itinerary on a route, optionally limited to a cabin (string or list) and/or
  // one date, with how it routes — for "via MUC" badges in the tables. null when the route
  // has no detail or nothing matches.
  function cheapestRouting(trips, origin, dest, { cabin, date } = {}) {
    const entry = routeEntry(trips, origin, dest);
    if (!entry) return null;
    const cabins = cabin == null ? null : Array.isArray(cabin) ? cabin : [cabin];
    const dates = date != null ? [date] : Object.keys(entry.dates || {});
    let best = null;
    for (const d of dates) {
      for (const t of entry.dates?.[d] || []) {
        if (cabins && !cabins.includes(t.cabin)) continue;
        if (!best || t.miles < best.miles || (t.miles === best.miles && t.duration < best.duration)) best = { ...t, date: d };
      }
    }
    return best ? { id: best.id, date: best.date, cabin: best.cabin, stops: best.stops, via: best.via || [], miles: best.miles, duration: best.duration, flights: best.flights || [] } : null;
  }

  return { CABINS, activeCabins, tripMult, directView, qualifyingCabins, filtered, discoverRows, sweetRows, affordRows,
           roundTripRows, collectLeg, daysBetween, observeHistory, mergeHistory, historyTrend, watchList,
           tripsFor, routeDetail, layoverMinutes, cheapestRouting };
});
