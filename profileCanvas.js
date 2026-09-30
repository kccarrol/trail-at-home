/* Trail at Home: elevation profile drawing.
   Draws a stretch of a route on a <canvas>: the area under the elevation line coloured by grade,
   the line on top, then optional done-shading and a "you are here" marker. No chart library.

   drawProfile(ctx, route, { fromM, toM, currentM, done, theme, width, height, yRange?, axis?, padTop? })
     padTop (px) keeps a clear band at the top for text laid over the canvas.
     ctx is already scaled for devicePixelRatio; width and height are in CSS pixels.
     route needs { gridStepM, n, eleM[], grade[] } (a prepared route, or a preview from makePreview).
   drawProgress(ctx, ...) adds just the shading and marker, over a copy of a static drawing.
   Pure helpers (xForDist, columns, rangeOf, makePreview) have no DOM and are unit-tested. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TAH = Object.assign(root.TAH || {}, factory());
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const Y_PAD = 0.1;               // 10% of the height left clear above and below the line
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Grade bands, in percent: descent, 0–3, 3–6, 6–10, 10 and up.
function gradeBand(g) { return g < 0 ? "descent" : g < 3 ? "easy" : g < 6 ? "moderate" : g < 10 ? "hard" : "steep"; }

const xForDist = (d, fromM, toM, width) => (d - fromM) / (toM - fromM) * width;

// Linear interpolation of a per-sample array at a distance.
function valueAt(route, arr, d) {
  const x = clamp(d / route.gridStepM, 0, route.n - 1), i = Math.min(Math.floor(x), route.n - 2), f = x - i;
  return i < 0 ? arr[0] : arr[i] + (arr[i + 1] - arr[i]) * f;
}

// Points to draw for a window: one per grid sample when they fit, otherwise one per pixel column
// (highest elevation in the column, so peaks don't vanish, and its average grade).
// Returns { x[], e[], g[] }: point positions in px and elevations, and the grade of each gap.
function columns(route, fromM, toM, width) {
  const step = route.gridStepM, x = [], e = [], g = [];
  const i0 = Math.max(0, Math.ceil(fromM / step)), i1 = Math.min(route.n - 1, Math.floor(toM / step));
  const cols = Math.max(1, Math.floor(width));
  if (i1 - i0 + 1 <= cols) {
    const push = d => { x.push(xForDist(d, fromM, toM, width)); e.push(valueAt(route, route.eleM, d)); };
    push(fromM);
    for (let i = i0; i <= i1; i++) if (i * step > fromM && i * step < toM) push(i * step);
    push(toM);
    for (let k = 0; k < x.length - 1; k++) {
      const mid = fromM + ((x[k] + x[k + 1]) / 2) / width * (toM - fromM);
      g.push(valueAt(route, route.grade, mid));
    }
  } else {
    const colM = (toM - fromM) / cols;
    for (let c = 0; c < cols; c++) {
      const a = fromM + c * colM, b = a + colM;
      let lo = Math.max(i0, Math.ceil(a / step)), hi = Math.min(i1, Math.floor(b / step));
      if (hi < lo) { lo = hi = clamp(Math.round((a + b) / 2 / step), 0, route.n - 1); }
      let top = -Infinity, sum = 0;
      for (let i = lo; i <= hi; i++) { if (route.eleM[i] > top) top = route.eleM[i]; sum += route.grade[i]; }
      x.push(c + 0.5); e.push(top); g.push(sum / (hi - lo + 1));
    }
    // Stretch the ends to the edges so the fill reaches both sides.
    x[0] = 0; x[x.length - 1] = width;
    g.length = x.length - 1;
  }
  return { x, e, g };
}

// Lowest and highest elevation in a window.
function rangeOf(route, fromM, toM) {
  const step = route.gridStepM;
  const a = valueAt(route, route.eleM, fromM), b = valueAt(route, route.eleM, toM);
  let min = Math.min(a, b), max = Math.max(a, b);
  const i0 = Math.max(0, Math.ceil(fromM / step)), i1 = Math.min(route.n - 1, Math.floor(toM / step));
  for (let i = i0; i <= i1; i++) { const v = route.eleM[i]; if (v < min) min = v; if (v > max) max = v; }
  return { min, max };
}
// Widen a range to at least minSpan meters, keeping it centred.
function spanAtLeast(r, minSpan) {
  const span = r.max - r.min;
  if (span >= minSpan) return { min: r.min, max: r.max };
  const mid = (r.min + r.max) / 2;
  return { min: mid - minSpan / 2, max: mid + minSpan / 2 };
}

function yMapper(yr, height, padTop) {
  const top = padTop != null ? padTop : height * Y_PAD, h = height - top - height * Y_PAD, span = Math.max(1e-6, yr.max - yr.min);
  return e => top + (1 - (e - yr.min) / span) * h;
}

function drawProfile(ctx, route, o) {
  const W = o.width, H = o.height, t = o.theme;
  const yr = o.yRange || spanAtLeast(rangeOf(route, o.fromM, o.toM), 30);
  const Y = yMapper(yr, H, o.padTop), p = columns(route, o.fromM, o.toM, W);
  ctx.clearRect(0, 0, W, H);

  // Area under the line, one filled shape per run of the same grade colour.
  let k = 0;
  while (k < p.g.length) {
    const band = gradeBand(p.g[k]), start = k;
    while (k < p.g.length && gradeBand(p.g[k]) === band) k++;
    ctx.beginPath();
    ctx.moveTo(p.x[start], H);
    for (let i = start; i <= k; i++) ctx.lineTo(p.x[i], Y(p.e[i]));
    ctx.lineTo(p.x[k], H);
    ctx.closePath();
    ctx.fillStyle = t[band];
    ctx.fill();
  }
  // The elevation line.
  ctx.beginPath();
  for (let i = 0; i < p.x.length; i++) i ? ctx.lineTo(p.x[i], Y(p.e[i])) : ctx.moveTo(p.x[i], Y(p.e[i]));
  ctx.lineWidth = o.lineWidth || 2; ctx.lineJoin = "round"; ctx.strokeStyle = t.line; ctx.stroke();

  if (o.axis) {
    ctx.font = "600 12px system-ui, sans-serif"; ctx.textAlign = "right"; ctx.fillStyle = t.text;
    ctx.textBaseline = "top"; ctx.fillText(o.axis(yr.max), W - 4, (o.padTop != null ? o.padTop : 0) + 3);
    ctx.textBaseline = "bottom"; ctx.fillText(o.axis(yr.min), W - 4, H - 3);
  }
  if (o.currentM != null) drawProgress(ctx, route, Object.assign({}, o, { yRange: yr }));
  return yr;
}

// Done-shading and the marker. Pass dot: true to mark the rider's spot on the line.
function drawProgress(ctx, route, o) {
  const W = o.width, H = o.height, t = o.theme;
  const x = clamp(Math.round(xForDist(o.currentM, o.fromM, o.toM, W)), 0, W);
  if (o.done && x > 0) { ctx.fillStyle = t.done; ctx.fillRect(0, 0, x, H); }
  ctx.fillStyle = t.marker;
  ctx.fillRect(clamp(x - 1.5, 0, W - 3), 0, 3, H);
  if (o.dot && o.yRange) {
    const y = yMapper(o.yRange, H, o.padTop)(valueAt(route, route.eleM, o.currentM));
    ctx.beginPath(); ctx.arc(clamp(x, 6, W - 6), y, 6, 0, Math.PI * 2);
    ctx.fillStyle = t.marker; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = t.bg; ctx.stroke();
  }
  return x;
}

// A small stand-in for a route, for the route list: `cols` points of peak elevation and average grade.
function makePreview(route, cols = 96) {
  const e = [], g = [], total = route.totalDistM, step = route.gridStepM, r1 = v => Math.round(v * 10) / 10;
  for (let c = 0; c < cols; c++) {
    const a = c * total / cols, b = (c + 1) * total / cols;
    const lo = Math.ceil(a / step), hi = Math.min(route.n - 1, Math.floor(b / step));
    if (hi < lo) { e.push(r1(valueAt(route, route.eleM, (a + b) / 2))); g.push(r1(valueAt(route, route.grade, (a + b) / 2))); continue; }
    let top = -Infinity, sum = 0;
    for (let i = lo; i <= hi; i++) { top = Math.max(top, route.eleM[i]); sum += route.grade[i]; }
    e.push(r1(top)); g.push(r1(sum / (hi - lo + 1)));
  }
  return { e, g, total };
}
function previewRoute(pv) {
  return { gridStepM: pv.total / (pv.e.length - 1), n: pv.e.length, totalDistM: pv.total, eleM: pv.e, grade: pv.g };
}

return { gradeBand, xForDist, valueAt, columns, rangeOf, spanAtLeast, drawProfile, drawProgress, makePreview, previewRoute };
});
