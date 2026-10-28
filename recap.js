/* Trail at Home: the ride recap.
   Works out how closely a ride followed the suggested resistance, and draws the recap's route map
   and charts on <canvas>. No DOM access beyond the canvas context it's given.

   effortScore(samples, { stepSize }) -> null when no second of the ride can be rated, else
     { pct, ratedS, onS, overS, underS, movingS }
     A second counts when the rider was moving and both the suggested level (resSug) and the
     bike's knob (resBike) were logged. At or above the suggestion (within the ride page's own
     tolerance) earns full credit; below it earns knob / suggestion. The few seconds after the
     suggestion changes aren't rated, since that's when the rider is turning the knob.
     pct is 100 only when every rated second earned full credit.
   rateRide(samples, stepSize) -> per sample: null (not rated) or { kind: "on" | "over" | "under", credit 0..1 }
   rideExtras(samples) -> { avgSpeedMps, avgCadenceRpm, maxHrBpm }
   buckets(samples, n, fn) -> n averages of fn(sample) over equal slices of ride time (null: no data)
   fitTrack(lat[], lon[], width, height, pad) -> { x(lat, lon), y(lat, lon) } scaled to fit, north up
   drawMap(ctx, { routeLat, routeLon, ride: [{ lat, lon, kind }], colors, width, height })
   drawChart(ctx, { lines: [{ values, color, width?, dash?, fill? }], min?, max?, colors, width, height })
     fill: true shades under the line in a faint version of its colour. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./resistance.js"));
  else root.TAH = Object.assign(root.TAH || {}, factory(root.TAH));
})(typeof self !== "undefined" ? self : this, function (resistance) {
"use strict";

const MOVING_MPS = 0.3;          // same threshold as the ride clock's moving time
const GRACE_S = 6;               // after the suggestion changes, this long to turn the knob
const MAX_GAP_S = 5;             // a longer gap between samples is a pause, not riding

function effortOf(x, stepSize) {
  if (x.resSug == null || x.resBike == null) return null;
  const off = resistance.bikeOffBy(x.resBike, x.resSug, stepSize);
  if (off === 0) return { kind: "on", credit: 1 };
  if (off > 0) return { kind: "over", credit: 1 };
  return { kind: "under", credit: Math.max(0, Math.min(1, x.resBike / x.resSug)) };
}

// Each sample's rating, or null where it isn't rated (stopped, no knob reading, or turning the knob).
function rateRide(samples, stepSize = 5) {
  const out = [];
  let lastSug = null, changedAt = -Infinity;
  for (let i = 0; i < (samples || []).length; i++) {
    const x = samples[i];
    if (x.resSug != null && x.resSug !== lastSug) { if (lastSug !== null) changedAt = x.elapsedS; lastSug = x.resSug; }
    out.push(x.speedMps > MOVING_MPS && x.elapsedS - changedAt >= GRACE_S ? effortOf(x, stepSize) : null);
  }
  return out;
}

function effortScore(samples, { stepSize = 5 } = {}) {
  const s = { pct: 0, ratedS: 0, onS: 0, overS: 0, underS: 0, movingS: 0 }, rated = rateRide(samples, stepSize);
  let credit = 0;
  for (let i = 1; i < rated.length; i++) {
    const dt = samples[i].elapsedS - samples[i - 1].elapsedS;
    if (!(dt > 0 && dt <= MAX_GAP_S) || !(samples[i].speedMps > MOVING_MPS)) continue;
    s.movingS += dt;
    const e = rated[i];
    if (!e) continue;
    s.ratedS += dt; s[e.kind + "S"] += dt; credit += e.credit * dt;
  }
  if (!s.ratedS) return null;
  s.pct = s.underS ? Math.min(99, Math.round(credit / s.ratedS * 100)) : 100;
  return s;
}

function rideExtras(samples) {
  let dist = 0, secs = 0, cSum = 0, cN = 0, maxHr = null;
  for (let i = 0; i < (samples || []).length; i++) {
    const x = samples[i];
    if (x.hrBpm != null) maxHr = Math.max(maxHr || 0, x.hrBpm);
    if (!(x.speedMps > MOVING_MPS)) continue;
    if (x.cadenceRpm > 0) { cSum += x.cadenceRpm; cN++; }
    if (i) { const dt = x.elapsedS - samples[i - 1].elapsedS; if (dt > 0 && dt <= MAX_GAP_S) { secs += dt; dist += x.speedMps * dt; } }
  }
  return { avgSpeedMps: secs ? dist / secs : 0, avgCadenceRpm: cN ? cSum / cN : null, maxHrBpm: maxHr };
}

function buckets(samples, n, fn) {
  const out = new Array(n).fill(null);
  if (!samples || !samples.length) return out;
  const t0 = samples[0].elapsedS, span = Math.max(1e-9, samples[samples.length - 1].elapsedS - t0);
  const sum = new Array(n).fill(0), cnt = new Array(n).fill(0);
  for (const x of samples) {
    const v = fn(x);
    if (v == null || !Number.isFinite(v)) continue;
    const k = Math.min(n - 1, Math.floor((x.elapsedS - t0) / span * n));
    sum[k] += v; cnt[k]++;
  }
  for (let k = 0; k < n; k++) if (cnt[k]) out[k] = sum[k] / cnt[k];
  return out;
}

// A flat (equirectangular) projection is plenty for a route a few tens of km across.
function fitTrack(lat, lon, width, height, pad = 12) {
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    if (lat[i] == null || lon[i] == null) continue;
    la0 = Math.min(la0, lat[i]); la1 = Math.max(la1, lat[i]); lo0 = Math.min(lo0, lon[i]); lo1 = Math.max(lo1, lon[i]);
  }
  if (!Number.isFinite(la0)) return null;
  const k = Math.cos((la0 + la1) / 2 * Math.PI / 180);
  const w = Math.max(1e-9, (lo1 - lo0) * k), h = Math.max(1e-9, la1 - la0);
  const scale = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
  const ox = (width - w * scale) / 2, oy = (height - h * scale) / 2;
  return { x: (la, lo) => ox + (lo - lo0) * k * scale, y: (la, lo) => height - oy - (la - la0) * scale };
}

function drawMap(ctx, o) {
  const { width, height, colors: c } = o;
  ctx.clearRect(0, 0, width, height);
  const lats = o.routeLat && o.routeLat.length ? o.routeLat : o.ride.map(p => p.lat);
  const lons = o.routeLon && o.routeLon.length ? o.routeLon : o.ride.map(p => p.lon);
  const f = fitTrack(lats, lons, width, height, 14);
  if (!f) return false;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (o.routeLat && o.routeLat.length) {           // the whole route, faint, under the part ridden
    ctx.strokeStyle = c.route; ctx.lineWidth = 3; ctx.beginPath();
    for (let i = 0; i < o.routeLat.length; i++) { const x = f.x(o.routeLat[i], o.routeLon[i]), y = f.y(o.routeLat[i], o.routeLon[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
  }
  ctx.lineWidth = 5;
  for (let i = 1; i < o.ride.length; i++) {        // the ride, coloured by how it followed the suggestion
    const a = o.ride[i - 1], b = o.ride[i];
    if (a.lat == null || b.lat == null) continue;
    ctx.strokeStyle = c[b.kind] || c.ride; ctx.beginPath();
    ctx.moveTo(f.x(a.lat, a.lon), f.y(a.lat, a.lon)); ctx.lineTo(f.x(b.lat, b.lon), f.y(b.lat, b.lon)); ctx.stroke();
  }
  const dot = (p, fill) => {
    if (!p || p.lat == null) return;
    ctx.beginPath(); ctx.arc(f.x(p.lat, p.lon), f.y(p.lat, p.lon), 6, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = c.bg; ctx.stroke();
  };
  dot(o.ride.find(p => p.lat != null), c.start);
  for (let i = o.ride.length - 1; i >= 0; i--) if (o.ride[i].lat != null) { dot(o.ride[i], c.end); break; }
  return true;
}

function drawChart(ctx, o) {
  const { width, height, colors: c } = o, PAD = 6;
  ctx.clearRect(0, 0, width, height);
  let lo = o.min, hi = o.max;
  if (lo == null || hi == null) {
    let a = Infinity, b = -Infinity;
    for (const l of o.lines) for (const v of l.values) if (v != null) { a = Math.min(a, v); b = Math.max(b, v); }
    if (!Number.isFinite(a)) return false;
    if (lo == null) lo = a; if (hi == null) hi = b;
  }
  if (hi - lo < 1e-9) { hi = lo + 1; lo -= 1; }
  const y = v => PAD + (1 - (v - lo) / (hi - lo)) * (height - 2 * PAD);
  ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.beginPath();
  for (const g of [0.25, 0.5, 0.75]) { const yy = Math.round(PAD + g * (height - 2 * PAD)) + 0.5; ctx.moveTo(0, yy); ctx.lineTo(width, yy); }
  ctx.stroke();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const l of o.lines) {
    const n = l.values.length, x = k => n > 1 ? k / (n - 1) * width : width / 2;
    // Runs of data, so a gap (no reading) breaks the line rather than drawing across it.
    const runs = []; let run = null;
    l.values.forEach((v, k) => { if (v == null) run = null; else { if (!run) runs.push(run = []); run.push([x(k), y(v)]); } });
    for (const r of runs) {
      if (l.fill) {
        ctx.fillStyle = l.color; ctx.globalAlpha = 0.18; ctx.beginPath(); ctx.moveTo(r[0][0], height);
        for (const p of r) ctx.lineTo(p[0], p[1]);
        ctx.lineTo(r[r.length - 1][0], height); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = l.color; ctx.lineWidth = l.width || 2; ctx.setLineDash(l.dash || []); ctx.beginPath();
      r.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      ctx.stroke(); ctx.setLineDash([]);
    }
  }
  return true;
}

return { effortScore, rateRide, rideExtras, buckets, fitTrack, drawMap, drawChart };
});
