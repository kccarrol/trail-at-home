/* Trail at Home: the suggested resistance level.
   Riders turn a knob by hand, so the suggestion follows the average grade of the road just ahead,
   moves in whole steps (5 by default) and holds still between changes. No DOM, so it runs in Node.

   avgGrade(route, distM)            -> average grade (%) from 75 m behind to 125 m ahead
   roundToStep(level, stepSize, max) -> level rounded to the nearest step, kept within 1..max
   createResistanceCoach({ stepSize, max }) -> { next(rawLevel, nowS), reset() }
     next() returns { level, changed, up } and only moves the level when the raw suggestion has
     drifted well past the halfway point (4 of 5 levels) to the next step, and not more often than every 20 s
     unless the road has changed a lot (two steps or more).
   createKnobReader() -> { feed(raw, max), level() } makes sense of the level a bike reports: trusted
     only once it has changed while connected (a bike sending a fixed placeholder never nags), 0 or
     less ignored, and read in tenths from the first reading above the top level on
   bikeOffBy(bikeLevel, level, stepSize) -> how far the bike's knob is from the suggestion, 0 when
     close enough (within less than half a step, and never stricter than ±2 levels) */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TAH = Object.assign(root.TAH || {}, factory());
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const BEHIND_M = 75, AHEAD_M = 125;      // the stretch of road the suggestion averages over
const HOLD_S = 20;                        // fewest seconds between ordinary changes
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function avgGrade(r, distM) {
  const step = r.gridStepM, last = r.n - 1;
  const a = clamp(Math.round((distM - BEHIND_M) / step), 0, last), b = clamp(Math.round((distM + AHEAD_M) / step), 0, last);
  let sum = 0;
  for (let i = a; i <= b; i++) sum += r.grade[i];
  return sum / (b - a + 1);
}

function roundToStep(level, stepSize, max) {
  return clamp(Math.round(level / stepSize) * stepSize, 1, max);
}

function createResistanceCoach({ stepSize = 5, max = 100 } = {}) {
  let level = null, lastChangeS = -Infinity;
  return {
    next(raw, nowS) {
      const target = roundToStep(raw, stepSize, max);
      if (level === null) { level = target; lastChangeS = nowS; return { level, changed: false, up: false }; }
      const drift = Math.abs(raw - level);
      // Past the halfway point plus a margin, so a road hovering between two levels doesn't flip-flop.
      const due = target !== level && drift >= stepSize * 0.8 && (nowS - lastChangeS >= HOLD_S || drift >= stepSize * 2);
      // The ends of the range always land exactly, so a level of 1 or the bike's top level can show.
      const atEnd = (target === 1 || target === max) && target !== level && nowS - lastChangeS >= HOLD_S;
      if (!due && !atEnd) return { level, changed: false, up: false };
      const up = target > level;
      level = target; lastChangeS = nowS;
      return { level, changed: true, up };
    },
    reset() { level = null; lastChangeS = -Infinity; }
  };
}

function createKnobReader() {
  let first = null, last = null, moved = false, tenths = false;
  return {
    feed(raw, max) {
      if (!(raw > 0) || raw > max * 10) return false;     // not a knob position
      if (raw > max) tenths = true;
      if (first === null) first = raw; else if (raw !== first) moved = true;
      last = raw; return true;
    },
    level() { return moved ? Math.round(tenths ? last / 10 : last) : null; }
  };
}

function bikeOffBy(bikeLevel, level, stepSize) {
  const ok = Math.max(2, Math.ceil(stepSize / 2) - 1);
  const d = bikeLevel - level;
  return Math.abs(d) <= ok ? 0 : d;
}

return { avgGrade, roundToStep, createResistanceCoach, createKnobReader, bikeOffBy };
});
