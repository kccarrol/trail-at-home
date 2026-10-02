/* Trail at Home: ride session.
   Owns the ride clock: each tick it reads the latest inputs, runs the speed model on the grade at
   the rider's spot, moves them along the route, auto-pauses when they stop, and keeps a
   once-a-second log. No DOM or Bluetooth here; the app passes those in as functions.

   createRideSession({
     route,                  prepared route from routePrep
     startDistM, stats,      where to start, and saved totals when resuming
     getInputs(),            -> { mode: "power"|"bike"|"manual", powerW, speedMps, cadenceRpm, hrBpm }
     getModelSettings(),     -> speedModel settings (read every tick, so changes apply mid-ride)
     onState(state), onFinish(state), onAutoPause(isPaused), onFlush(samples)
     now(), wallNow()        clocks in ms (defaults: performance.now, Date.now; tests pass fakes)
   })

   rideState: { elapsedS, distM, speedMps, grade, eleM, lat, lon, powerW, cadenceRpm, hrBpm, ascentM,
                running, autoPaused, finished }   grade is in percent; lat/lon are null for routes
   saved before positions were stored. Log samples are rideState snapshots plus t (epoch ms). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./routePrep.js"), require("./speedModel.js"));
  else root.TAH = Object.assign(root.TAH || {}, factory(root.TAH, root.TAH));
})(typeof self !== "undefined" ? self : this, function (routePrep, speedModel) {
"use strict";

const TICK_MS = 250;             // 4 updates a second
const SUBSTEP_S = 0.1;           // physics steps never exceed 0.1 s, however late a tick arrives
const MAX_CATCHUP_S = 60;        // a throttled background tab catches up at most a minute at once
const AUTO_PAUSE_S = 5;          // this long at 0 W and standing still pauses the clock
const SAMPLE_EVERY_S = 1;
const FLUSH_EVERY_S = 30;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const newStats = () => ({ secs: 0, dist: 0, joules: 0, powSecs: 0 });   // moving time, moving distance, energy

function createRideSession(o) {
  const route = o.route;
  const now = o.now || (() => performance.now());
  const wallNow = o.wallNow || (() => Date.now());
  const noop = () => {};
  const onState = o.onState || noop, onFinish = o.onFinish || noop, onAutoPause = o.onAutoPause || noop, onFlush = o.onFlush || noop;

  let distM = clamp(o.startDistM || 0, 0, route.totalDistM);
  let speedMps = 0, powerW = 0, cadenceRpm = null, hrBpm = null;
  let running = false, autoPaused = false, stillS = 0, timer = null, lastT = 0;
  let elapsedS = 0, nextSampleS = 0, lastFlushS = 0, flushed = 0;
  let samples = [];
  const stats = Object.assign(newStats(), o.stats || {});
  const state = {};

  function refresh() {
    const at = routePrep.sampleAt(route, distM);
    Object.assign(state, {
      elapsedS, distM, speedMps, grade: at.grade, eleM: at.eleM, lat: at.lat, lon: at.lon,
      powerW, cadenceRpm, hrBpm, ascentM: at.ascentM, running, autoPaused, finished: distM >= route.totalDistM
    });
    return state;
  }

  // nominalS is the whole second of ride time this sample stands for, so log times are exactly 1 s apart.
  function takeSample(tMs, nominalS) {
    const s = Object.assign({ t: Math.round(tMs) }, refresh());
    if (nominalS != null) s.elapsedS = nominalS;
    delete s.running; delete s.autoPaused; delete s.finished;
    samples.push(s);
  }

  // Advance the ride by dtS seconds of real time, in small physics steps.
  function advance(dtS, tickWallMs) {
    const steps = Math.max(1, Math.ceil(dtS / SUBSTEP_S)), h = dtS / steps;
    for (let k = 0; k < steps && distM < route.totalDistM; k++) {
      const inp = o.getInputs(), set = o.getModelSettings();
      const grade = routePrep.sampleAt(route, distM).grade;
      cadenceRpm = inp.cadenceRpm == null ? null : inp.cadenceRpm;
      hrBpm = inp.hrBpm == null ? null : inp.hrBpm;

      // Watts driving the model: measured, or worked out from the bike's own speed on the flat.
      let watts = 0;
      if (inp.mode === "power") watts = Math.max(0, inp.powerW || 0);
      else if (inp.mode === "bike") watts = speedModel.powerForSpeed(Math.max(0, inp.speedMps || 0), 0, set);
      powerW = inp.mode === "manual" ? null : watts;

      const wantsToMove = watts > 0 || (inp.mode === "manual" && inp.speedMps > 0);
      if (autoPaused) {
        if (!wantsToMove) continue;                     // clock and physics stay frozen
        autoPaused = false; stillS = 0; onAutoPause(false);
      }

      if (inp.mode === "manual") speedMps = clamp(inp.speedMps || 0, 0, set.vMaxMps);
      else speedMps = speedModel.step({ speedMps }, watts, grade, set, h).speedMps;

      const moved = Math.min(speedMps * h, route.totalDistM - distM);
      distM += moved;
      if (route.totalDistM - distM < 0.05) distM = route.totalDistM;   // don't stop a hair short of the end
      elapsedS += h;
      if (speedMps > 0.3) { stats.secs += h; stats.dist += moved; if (inp.mode !== "manual") { stats.joules += watts * h; stats.powSecs += h; } }

      while (elapsedS >= nextSampleS - 1e-6) { takeSample(tickWallMs - (dtS - (k + 1) * h) * 1000, nextSampleS); nextSampleS += SAMPLE_EVERY_S; }

      stillS = !wantsToMove && speedMps < 0.05 ? stillS + h : 0;
      if (stillS >= AUTO_PAUSE_S) { autoPaused = true; speedMps = 0; onAutoPause(true); }
    }
    if (elapsedS - lastFlushS >= FLUSH_EVERY_S) flush();
    if (distM >= route.totalDistM && running) {
      speedMps = 0;
      if (!samples.length || samples[samples.length - 1].distM < route.totalDistM) takeSample(tickWallMs, Math.max(nextSampleS, Math.ceil(elapsedS)));   // log the finish point
      nextSampleS = Math.max(nextSampleS, Math.ceil(elapsedS)) + SAMPLE_EVERY_S;
      stop(); flush(); onFinish(refresh());
    }
  }

  function tick(nowMs) {
    const t = nowMs == null ? now() : nowMs;
    const dt = clamp((t - lastT) / 1000, 0, MAX_CATCHUP_S);
    lastT = t;
    if (dt > 0) advance(dt, wallNow());
    onState(refresh());
  }

  function stop() { running = false; if (timer) clearInterval(timer); timer = null; }

  const api = {
    get state() { return refresh(); },
    get samples() { return samples; },   // this ride's 1 Hz log, oldest first
    get stats() { return stats; },
    get route() { return route; },
    start() {
      if (running) return;
      if (distM >= route.totalDistM) { distM = 0; Object.assign(stats, newStats()); }
      running = true; autoPaused = false; stillS = 0; lastT = now();
      if (!o.manualClock) timer = setInterval(() => tick(), TICK_MS);
      onState(refresh());
    },
    pause() {
      if (!running) return;
      tick(); stop(); speedMps = 0;
      if (autoPaused) { autoPaused = false; onAutoPause(false); }
      flush(); onState(refresh());
    },
    // Tapping Resume while auto-paused: the clock runs again; it auto-pauses again if the
    // rider still doesn't pedal.
    resume() {
      if (!running || !autoPaused) return;
      autoPaused = false; stillS = 0; lastT = now(); onAutoPause(false); onState(refresh());
    },
    tick,
    // Move to a spot on the route (tapping the profile, matching the console, restarting).
    jumpTo(d) { distM = clamp(d, 0, route.totalDistM); speedMps = 0; onState(refresh()); },
    resetStats() { Object.assign(stats, newStats()); },
    // Start a fresh log (a new ride), after the previous one has been flushed.
    newLog() { flush(); samples = []; flushed = 0; elapsedS = 0; nextSampleS = 0; lastFlushS = 0; },
    flush
  };

  function flush() {
    lastFlushS = elapsedS;
    if (flushed >= samples.length) return;
    const chunk = samples.slice(flushed);
    flushed = samples.length;
    try { onFlush(chunk); } catch (e) { /* saving is best effort; the app reports storage errors */ }
  }

  refresh();
  return api;
}

return { createRideSession, RIDE_TICK_MS: TICK_MS };
});
