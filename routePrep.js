/* Trail at Home: route preparation.
   Turns raw GPX points into an even 10 m grid with smoothed elevation, grade and running ascent,
   and looks up conditions at any distance along the route. No DOM, so it runs in Node tests too.

   prepareRoute({ lat[], lon[], ele[] })  -> prepared route (ele may hold NaN where missing)
   prepareFromGrid({ e, lat?, lon?, hasElevation? }) -> prepared route from a stored 10 m grid
     (the prepared route includes climbs: [{ startM, endM, lengthM, avgGrade, gainM }], from climbs.js)
   sampleAt(route, distM) -> { grade, eleM, lat, lon, ascentM } at that distance
   Grades are in percent throughout (8 means an 8% climb). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./climbs.js"));
  else root.TAH = Object.assign(root.TAH || {}, factory(root.TAH));
})(typeof self !== "undefined" ? self : this, function (climbs) {
"use strict";

// Bump when the smoothing or grade maths change; saved routes are re-prepared on next open.
const PREP_VERSION = 2;          // 2: climbs added
const GRID_STEP_M = 10;
const MIN_POINT_GAP_M = 1;        // consecutive GPX points closer than this are dropped
const SMOOTH_HALF = 3;            // then a moving average over 7 grid samples (70 m)
const GRADE_HALF = 6;             // grade measured across 13 samples (120 m)
const RAW_WINDOW_M = 50;          // dense GPX: average raw points within ±50 m of each grid point
const MAX_GRADE_PCT = 25;
const ASCENT_DEADBAND_M = 2;      // GPS wobble smaller than this doesn't count as climbing
const MIN_ROUTE_M = 200;

class RouteError extends Error {}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const validEle = h => Number.isFinite(h) && h > -500 && h < 9000;

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000, t = Math.PI / 180, dLat = (bLat - aLat) * t, dLon = (bLon - aLon) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Raw GPX points -> prepared route.
function prepareRoute(points) {
  const lat = [], lon = [], ele = [], dist = [];
  let cum = 0;
  for (let i = 0; i < points.lat.length; i++) {
    const la = +points.lat[i], lo = +points.lon[i];
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
    if (lat.length) {
      const s = haversine(lat[lat.length - 1], lon[lon.length - 1], la, lo);
      if (s < MIN_POINT_GAP_M) continue;
      cum += s;
    }
    lat.push(la); lon.push(lo); dist.push(cum);
    const h = points.ele ? +points.ele[i] : NaN;
    ele.push(validEle(h) ? h : NaN);
  }
  if (dist.length < 2) throw new RouteError("has too few usable points.");
  if (cum < MIN_ROUTE_M) throw new RouteError("is shorter than 200 meters.");

  // Fill gaps in elevation by interpolating along distance; no elevation at all rides flat.
  const known = [];
  for (let i = 0; i < ele.length; i++) if (!Number.isNaN(ele[i])) known.push(i);
  const hasElevation = known.length >= 2;
  if (hasElevation) {
    for (let k = 0, i = 0; i < ele.length; i++) {
      if (!Number.isNaN(ele[i])) continue;
      while (k < known.length - 1 && known[k + 1] < i) k++;
      const a = known[k], b = known[Math.min(k + 1, known.length - 1)];
      if (i < a) ele[i] = ele[a];
      else if (b <= a || i > b) ele[i] = ele[b];
      else ele[i] = ele[a] + (ele[b] - ele[a]) * (dist[i] - dist[a]) / (dist[b] - dist[a]);
    }
  } else ele.fill(0);

  // Resample onto an even 10 m grid (linear interpolation of lat, lon and elevation). Where the
  // GPX is dense (recorded rides log a point every few meters), elevation is instead the mean of
  // every raw point within ±50 m, which cancels far more GPS noise than picking one point.
  const n = Math.floor(cum / GRID_STEP_M) + 1;
  const gLat = new Float64Array(n), gLon = new Float64Array(n), gEle = new Float32Array(n);
  let wa = 0, wb = 0, wsum = 0;
  for (let i = 0, j = 0; i < n; i++) {
    const x = i * GRID_STEP_M;
    while (j < dist.length - 2 && dist[j + 1] < x) j++;
    const span = dist[j + 1] - dist[j], t = span > 0 ? clamp((x - dist[j]) / span, 0, 1) : 0;
    gLat[i] = lat[j] + (lat[j + 1] - lat[j]) * t;
    gLon[i] = lon[j] + (lon[j + 1] - lon[j]) * t;
    while (wb < dist.length && dist[wb] <= x + RAW_WINDOW_M) wsum += ele[wb++];
    while (wa < wb && dist[wa] < x - RAW_WINDOW_M) wsum -= ele[wa++];
    gEle[i] = wb - wa >= 3 ? wsum / (wb - wa) : ele[j] + (ele[j + 1] - ele[j]) * t;
  }
  return prepareFromGrid({ e: gEle, lat: gLat, lon: gLon, hasElevation });
}

// A 10 m elevation grid (plus optional positions) -> smoothed elevation, grade and ascent.
function prepareFromGrid(grid) {
  const src = grid.e, n = src.length;
  if (n < 2) throw new RouteError("has too few usable points.");
  const hasElevation = grid.hasElevation !== false;
  const hasTrack = !!(grid.lat && grid.lon && grid.lat.length === n && grid.lon.length === n);

  // 1) Centred moving average of elevation (prefix sums keep it O(n)).
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (hasElevation ? src[i] : 0);
  const eleM = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - SMOOTH_HALF), b = Math.min(n - 1, i + SMOOTH_HALF);
    eleM[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  // 2) Grade = rise over run across a 100 m window of the smoothed profile, clamped.
  const grade = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - GRADE_HALF), b = Math.min(n - 1, i + GRADE_HALF);
    grade[i] = b > a ? clamp((eleM[b] - eleM[a]) / ((b - a) * GRID_STEP_M) * 100, -MAX_GRADE_PCT, MAX_GRADE_PCT) : 0;
  }
  // 3) Running ascent with a dead band, plus min/max for drawing.
  const cumAscentM = new Float32Array(n), distM = new Float32Array(n);
  let gain = 0, ref = eleM[0], min = eleM[0], max = eleM[0];
  for (let i = 0; i < n; i++) {
    distM[i] = i * GRID_STEP_M;
    if (i) {
      if (eleM[i] > ref + ASCENT_DEADBAND_M) { gain += eleM[i] - ref; ref = eleM[i]; }
      else if (eleM[i] < ref - ASCENT_DEADBAND_M) ref = eleM[i];
    }
    cumAscentM[i] = gain;
    if (eleM[i] < min) min = eleM[i];
    if (eleM[i] > max) max = eleM[i];
  }
  const route = {
    prepVersion: PREP_VERSION, gridStepM: GRID_STEP_M, n, totalDistM: (n - 1) * GRID_STEP_M,
    distM, lat: hasTrack ? grid.lat : null, lon: hasTrack ? grid.lon : null,
    rawEleM: src, eleM, grade, cumAscentM, totalAscentM: gain, minEleM: min, maxEleM: max,
    hasElevation, hasTrack
  };
  route.climbs = hasElevation ? climbs.detectClimbs(route) : [];
  return route;
}

// Conditions at any distance, interpolated between grid samples so readings change smoothly.
function sampleAt(r, distM) {
  const x = clamp(distM / r.gridStepM, 0, r.n - 1), i = Math.min(Math.floor(x), r.n - 2), f = x - i;
  const lerp = a => a[i] + (a[i + 1] - a[i]) * f;
  return {
    grade: lerp(r.grade), eleM: lerp(r.eleM), ascentM: lerp(r.cumAscentM),
    lat: r.hasTrack ? lerp(r.lat) : null, lon: r.hasTrack ? lerp(r.lon) : null
  };
}

return { PREP_VERSION, GRID_STEP_M, RouteError, haversine, prepareRoute, prepareFromGrid, sampleAt };
});
