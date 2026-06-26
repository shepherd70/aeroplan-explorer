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
  function qualifyingCabins(rec, settings) {
    const out = [];
    const mult = tripMult(settings);
    for (const X of activeCabins(settings)) {
      const c = rec.cabins?.[X];
      if (!c || !c.available || !(c.miles > 0)) continue;
      if (settings.direct && !c.direct) continue;
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
  // opts: { autoFares, manualFares, today } — autoFares from enrich-fares.mjs, manualFares
  // are the user's per-row overrides, today (YYYY-MM-DD) drops past dates so cpp lines up
  // with the future fares enrich-fares prices.
  function sweetRows(records, settings, opts) {
    const { autoFares = {}, manualFares = {}, today = "", faresCurrency = "" } = opts || {};
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
                  taxes: null, taxesCurrency: "" };
          byTriple.set(k, row);
        }
        if (c.miles < row.miles) {
          row.miles = c.miles; row.seats = c.seats; row.direct = c.direct; row.airlines = c.airlines;
          // taxes of the cheapest option, in dollars (null when the cache predates tax capture)
          row.taxes = c.taxes != null ? c.taxes / 100 : null;
          row.taxesCurrency = (rec.taxesCurrency || "").toUpperCase();
        }
        if (rec.distance && !row.distance) row.distance = rec.distance;
      }
    }
    const rows = [...byTriple.values()];
    const fc = (faresCurrency || "").toUpperCase();
    for (const r of rows) {
      r.mpm = r.distance > 0 ? (r.miles / r.distance) * 1000 : null;
      r.fareKey = `${r.origin}-${r.destination}-${r.cabin}`;
      const auto = autoFares[r.fareKey];           // auto fare from enrich-fares.mjs
      const fare = manualFares[r.fareKey] ?? auto;  // manual entry overrides auto
      r.fareValue = fare ?? null;
      r.fareAuto = manualFares[r.fareKey] == null && auto != null;
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

  return { CABINS, activeCabins, tripMult, qualifyingCabins, filtered, discoverRows, sweetRows, affordRows };
});
