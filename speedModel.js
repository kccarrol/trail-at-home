/* Trail at Home: speed model.
   Each step, the rider's watts push against gravity on the current grade, rolling resistance and
   air drag. Any surplus or shortfall speeds the rider up or slows them down, so climbs feel slow,
   descents carry momentum, and speed eases between the two instead of jumping.

   m·dv/dt = η·P / max(v, 0.5) − m·g·sinθ − Crr·m·g·cosθ − ½·ρ·CdA·v²,   θ = atan(grade × difficulty)

   step(state, powerW, gradePct, settings, dtS) -> new state   (pure: no DOM, no Bluetooth)
   makeSettings({ riderKg, difficultyPct }) -> settings with the defaults below */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TAH = Object.assign(root.TAH || {}, factory());
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const G = 9.80665;
const MIN_DRIVE_SPEED = 0.5;      // m/s floor in η·P/v, so a standing start doesn't divide by zero
const WHEEL_INERTIA = 1.04;       // spinning wheels add about 4% to the mass being accelerated
const DEFAULTS = {
  bikeKg: 13,                     // added to the rider's weight
  crr: 0.010,                     // rolling resistance: hardpacked dirt or gravel
  cdaM2: 0.45,                    // drag area: upright on a mountain bike
  rhoKgM3: 1.225,                 // air density at sea level
  eta: 0.97,                      // drivetrain efficiency
  vMaxMps: 25                     // 90 km/h (56 mph) ceiling
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function makeSettings(o = {}) {
  const riderKg = Number.isFinite(+o.riderKg) ? +o.riderKg : 72;
  const pct = Number.isFinite(+o.difficultyPct) ? clamp(+o.difficultyPct, 0, 100) : 100;
  return Object.assign({}, DEFAULTS, o.overrides || {}, { massKg: clamp(riderKg + DEFAULTS.bikeKg, 40, 300), difficulty: pct / 100 });
}

// Resisting force in newtons at speed v on this grade.
function resistance(v, gradePct, s) {
  const th = Math.atan(gradePct / 100 * s.difficulty);
  return s.massKg * G * (Math.sin(th) + s.crr * Math.cos(th)) + 0.5 * s.rhoKgM3 * s.cdaM2 * v * v;
}

function step(state, powerW, gradePct, s, dtS) {
  const v = state.speedMps, p = Math.max(0, powerW || 0);
  const drive = s.eta * p / Math.max(v, MIN_DRIVE_SPEED), resist = resistance(v, gradePct, s);
  if (v <= 0.01 && drive <= resist) return { speedMps: 0, accelMps2: 0 };   // stopped and not pushing hard enough: never roll backwards
  const a = (drive - resist) / (s.massKg * WHEEL_INERTIA);
  return { speedMps: clamp(v + a * dtS, 0, s.vMaxMps), accelMps2: a };
}

// Speed where watts exactly balance the resistance (what step() settles to at steady power).
function steadySpeed(powerW, gradePct, s) {
  let lo = 0, hi = s.vMaxMps;
  const surplus = v => s.eta * powerW - v * resistance(v, gradePct, s);
  if (surplus(hi) > 0) return hi;
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (surplus(mid) > 0) lo = mid; else hi = mid; }
  return lo;
}

// Watts needed to hold a speed; used to turn a bike that only reports speed into power.
function powerForSpeed(vMps, gradePct, s) {
  return Math.max(0, vMps * resistance(vMps, gradePct, s) / s.eta);
}

return { DEFAULTS, makeSettings, step, steadySpeed, powerForSpeed };
});
