/* Trail at Home: climb detection.
   Finds the climbs in a prepared route, for the "next climb" callout on the ride screen.
   A climb is a stretch of smoothed grade of at least 3% that runs 200 m or more. Climbs separated
   by less than 100 m of flatter ground merge into one, and anything gaining under 15 m is dropped.

   detectClimbs({ grade[], eleM[], gridStepM, n }) -> [{ startM, endM, lengthM, avgGrade, gainM }]
   avgGrade is in percent. Runs once when a route is prepared; the result is cached with it. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TAH = Object.assign(root.TAH || {}, factory());
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const CLIMB_MIN_GRADE = 3;       // %
const CLIMB_MIN_LENGTH_M = 200;
const CLIMB_MERGE_GAP_M = 100;
const CLIMB_MIN_GAIN_M = 15;

function detectClimbs(r) {
  const step = r.gridStepM, n = r.n, runs = [];
  // 1) Runs of grid samples at or above 3%, kept if they're 200 m or longer.
  for (let i = 0; i < n; i++) {
    if (r.grade[i] < CLIMB_MIN_GRADE) continue;
    let j = i;
    while (j + 1 < n && r.grade[j + 1] >= CLIMB_MIN_GRADE) j++;
    if ((j - i) * step >= CLIMB_MIN_LENGTH_M) runs.push([i, j]);
    i = j;
  }
  // 2) Merge runs separated by less than 100 m.
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && (run[0] - last[1]) * step < CLIMB_MERGE_GAP_M) last[1] = run[1];
    else merged.push(run.slice());
  }
  // 3) Measure each, dropping ones with too little climbing.
  const out = [];
  for (const [i, j] of merged) {
    const lengthM = (j - i) * step, gainM = r.eleM[j] - r.eleM[i];
    if (gainM < CLIMB_MIN_GAIN_M) continue;
    out.push({ startM: i * step, endM: j * step, lengthM, avgGrade: gainM / lengthM * 100, gainM });
  }
  return out;
}

// The climb the rider is on, or else the next one ahead (climbs are sorted by startM).
function climbAt(climbs, distM) {
  for (const c of climbs) {
    if (distM < c.startM) return { climb: c, on: false, toStartM: c.startM - distM };
    if (distM <= c.endM) return { climb: c, on: true, leftM: c.endM - distM };
  }
  return null;
}

return { detectClimbs, climbAt };
});
