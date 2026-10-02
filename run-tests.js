/* Trail at Home tests. Run with Node 18+ from this folder:  node run-tests.js  */
"use strict";
const assert = require("node:assert/strict");
const { prepareRoute, sampleAt } = require("./routePrep.js");
const { makeSettings, step, steadySpeed } = require("./speedModel.js");
const { createRideSession } = require("./rideSession.js");
const { detectClimbs, climbAt } = require("./climbs.js");
const pc = require("./profileCanvas.js");
const { buildTcx, summarize } = require("./tcx.js");
const { avgGrade, roundToStep, createResistanceCoach, createKnobReader, bikeOffBy } = require("./resistance.js");
const { createStrava } = require("./strava.js");

let failed = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + e.message); }
}
const kmh = mps => mps * 3.6;
const S85 = makeSettings({ riderKg: 72 });                 // 72 kg rider + 13 kg bike = 85 kg
function settle(powerW, gradePct, s = S85, v0 = 0, secs = 300) {
  let st = { speedMps: v0 };
  for (let t = 0; t < secs; t += 0.1) st = step(st, powerW, gradePct, s, 0.1);
  return st.speedMps;
}
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

// A straight synthetic route heading north, one GPX point every `spacing` meters.
const SEGS = [[1000, 0], [1000, 6], [800, -4], [600, 10], [1000, 2], [800, -8]];   // [length m, grade %]
function syntheticGpx(spacing, noiseM, seed) {
  const r = rng(seed), lat = [], lon = [], ele = [];
  let d = 0, h = 300;
  for (const [len, g] of SEGS) for (let x = 0; x < len; x += spacing) {
    lat.push(37 + d / 111195); lon.push(-120.6); ele.push(h + (r() * 2 - 1) * noiseM);
    d += spacing; h += g / 100 * spacing;
  }
  return { lat, lon, ele };
}
function trueGrade(d) { let a = 0; for (const [len, g] of SEGS) { if (d < a + len) return { g, edge: Math.min(d - a, a + len - d) }; a += len; } return null; }
function flatRoute(meters) { return prepareRoute({ lat: [37, 37 + meters / 111195], lon: [-120, -120], ele: [100, 100] }); }

console.log("Speed model");
test("200 W on flat settles within ±1 km/h of 28 km/h", () => {
  const v = kmh(settle(200, 0)); assert.ok(Math.abs(v - 28) <= 1, `got ${v.toFixed(2)} km/h`);
});
test("200 W at 8% settles near 9 km/h", () => {
  const v = kmh(settle(200, 8)); assert.ok(Math.abs(v - 9) <= 1, `got ${v.toFixed(2)} km/h`);
});
test("step() converges to the steady-state speed", () => {
  assert.ok(Math.abs(settle(250, 3) - steadySpeed(250, 3, S85)) < 0.02);
});
test("0 W at −6% accelerates (coasting)", () => {
  const v = settle(0, -6, S85, 2, 20); assert.ok(v > 5, `got ${kmh(v).toFixed(1)} km/h after 20 s`);
});
test("0 W at +5% decays to 0 and never goes negative", () => {
  let st = { speedMps: 8 }, min = Infinity;
  for (let t = 0; t < 60; t += 0.1) { st = step(st, 0, 5, S85, 0.1); min = Math.min(min, st.speedMps); }
  assert.equal(st.speedMps, 0); assert.ok(min >= 0);
});
test("difficulty 0% makes an 8% climb ride like the flat", () => {
  const easy = makeSettings({ riderKg: 72, difficultyPct: 0 });
  assert.ok(Math.abs(settle(200, 8, easy) - settle(200, 0, easy)) < 0.01);
});
test("speed never exceeds 90 km/h", () => {
  assert.ok(kmh(settle(1500, -25)) <= 90.0001);
});

console.log("Route prep");
test("±3 m elevation noise: grades average within 0.5% and 95% of points within ±1% of true", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const r = prepareRoute(syntheticGpx(5, 3, seed)), errs = [];
    for (let i = 0; i < r.n; i++) {
      const tg = trueGrade(i * 10);
      if (tg && tg.edge >= 150) errs.push(Math.abs(r.grade[i] - tg.g));   // skip the blend around grade changes
    }
    errs.sort((a, b) => a - b);
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length, p95 = errs[Math.floor(errs.length * 0.95)];
    assert.ok(mean <= 0.5 && p95 <= 1, `seed ${seed}: mean ${mean.toFixed(2)}%, 95th percentile ${p95.toFixed(2)}%`);
  }
});
test("distance, positions and ascent are worked out", () => {
  const r = prepareRoute(syntheticGpx(5, 0, 1));
  assert.ok(Math.abs(r.totalDistM - 5200) <= 10, `total ${r.totalDistM}`);
  assert.ok(r.hasTrack && r.hasElevation);
  const trueAscent = 60 + 60 + 20;                                            // the 6%, 10% and 2% climbs
  assert.ok(Math.abs(r.totalAscentM - trueAscent) < 8, `ascent ${r.totalAscentM.toFixed(1)}`);
  const mid = sampleAt(r, 1500);
  assert.ok(Math.abs(mid.lat - (37 + 1500 / 111195)) < 1e-5 && Math.abs(mid.grade - 6) < 0.5);
});
test("a GPX with no elevation rides flat", () => {
  const g = syntheticGpx(5, 0, 1); g.ele = g.ele.map(() => NaN);
  const r = prepareRoute(g);
  assert.equal(r.hasElevation, false); assert.ok(r.grade.every(x => x === 0));
});
test("points under 1 m apart are dropped and gaps in elevation are filled", () => {
  const g = syntheticGpx(5, 0, 1);
  g.lat.splice(10, 0, g.lat[10] + 1e-6); g.lon.splice(10, 0, g.lon[10]); g.ele.splice(10, 0, 9999);  // 0.1 m apart, bogus height
  g.ele[400] = NaN;
  const r = prepareRoute(g);
  assert.ok(r.eleM.every(Number.isFinite) && Math.abs(r.totalDistM - 5200) <= 10);
});

console.log("Ride session");
function fakeRide(route, inputs, opts = {}) {
  let t = 0, wall = 1.7e12;
  const events = { finished: false, pauses: [], flushed: [] };
  const s = createRideSession(Object.assign({
    route, manualClock: true, now: () => t, wallNow: () => wall,
    getInputs: () => typeof inputs === "function" ? inputs(s.state) : inputs,
    getModelSettings: () => S85,
    onFinish: () => { events.finished = true; },
    onAutoPause: p => events.pauses.push(p),
    onFlush: c => events.flushed.push(...c)
  }, opts));
  const run = secs => { for (let k = 0; k < secs * 4 && !events.finished; k++) { t += 250; wall += 250; s.tick(t); } };
  return { s, run, events };
}

test("speed changes smoothly (under 3 km/h per second) through a 0% to 8% climb at 200 W", () => {
  const lat = [], lon = [], ele = [];
  for (let d = 0, h = 0; d <= 4000; d += 5) { lat.push(37 + d / 111195); lon.push(-120); ele.push(h); if (d >= 2000) h += 0.4; }
  const { s, run } = fakeRide(prepareRoute({ lat, lon, ele }), { mode: "power", powerW: 200 });
  s.start(); run(20 * 60);
  const sp = s.samples.map(x => kmh(x.speedMps));
  let worst = 0; for (let i = 60; i < sp.length - 1; i++)   // skip the start and the stop at the finish line
   worst = Math.max(worst, Math.abs(sp[i] - sp[i - 1]));
  assert.ok(worst < 3, `largest change ${worst.toFixed(2)} km/h in one second`);
});
test("virtual distance at the finish matches the route's total distance", () => {
  const r = flatRoute(3000), { s, run, events } = fakeRide(r, { mode: "power", powerW: 250 });
  s.start(); run(30 * 60);
  assert.ok(events.finished); assert.equal(s.state.distM, r.totalDistM);
  assert.equal(s.samples[s.samples.length - 1].distM, r.totalDistM);
});
test("a one-hour ride logs about 3,600 samples, flushed in 30 s chunks", () => {
  const r = flatRoute(100000), { s, run, events } = fakeRide(r, { mode: "power", powerW: 150 });
  s.start(); run(3600); s.pause();
  assert.ok(Math.abs(s.samples.length - 3600) <= 2, `got ${s.samples.length}`);
  assert.equal(events.flushed.length, s.samples.length);
  assert.ok(Math.abs(s.samples[100].t - s.samples[99].t - 1000) <= 100);
});
test("auto-pause after 5 s at 0 W and standing still, resume on pedaling", () => {
  const r = flatRoute(10000); let w = 200;
  const { s, run, events } = fakeRide(r, () => ({ mode: "power", powerW: w }));
  s.start(); run(30); w = 0; run(60);
  assert.deepEqual(events.pauses, [true]); assert.ok(s.state.autoPaused);
  const frozen = s.state.elapsedS; run(20);
  assert.equal(s.state.elapsedS, frozen, "clock keeps running while auto-paused");
  w = 150; run(5);
  assert.deepEqual(events.pauses, [true, false]); assert.ok(s.state.elapsedS > frozen && s.state.speedMps > 0);
});
test("resume() ends an auto-pause; it auto-pauses again if still not pedaling", () => {
  const r = flatRoute(10000); let w = 200;
  const { s, run, events } = fakeRide(r, () => ({ mode: "power", powerW: w }));
  s.start(); run(30); w = 0; run(60);
  assert.ok(s.state.autoPaused);
  const frozen = s.state.elapsedS;
  s.resume();
  assert.ok(!s.state.autoPaused && s.state.running); assert.deepEqual(events.pauses, [true, false]);
  run(2); assert.ok(s.state.elapsedS > frozen, "clock runs again");
  run(10); assert.ok(s.state.autoPaused, "auto-pauses again without pedaling");
});
test("bike drop: 0 W coasts to a stop without resetting the ride", () => {
  const r = flatRoute(10000); let w = 200;
  const { s, run } = fakeRide(r, () => ({ mode: "power", powerW: w }));
  s.start(); run(60); const d = s.state.distM;
  w = 0; run(120);                                                   // the app sends 0 W while reconnecting
  assert.ok(s.state.distM > d && s.state.speedMps === 0 && s.state.running);
  w = 200; run(10);
  assert.ok(s.state.speedMps > 0 && s.state.distM > d);
});
test("a bike that only reports speed still slows on climbs", () => {
  const lat = [], lon = [], ele = [];
  for (let d = 0, h = 0; d <= 3000; d += 5) { lat.push(37 + d / 111195); lon.push(-120); ele.push(h); if (d >= 1000) h += 0.4; }
  const { s, run } = fakeRide(prepareRoute({ lat, lon, ele }), { mode: "bike", speedMps: 25 / 3.6 });
  s.start(); run(120);
  const flat = kmh(s.state.speedMps);
  run(240);
  assert.ok(Math.abs(flat - 25) < 1 && kmh(s.state.speedMps) < 12, `flat ${flat.toFixed(1)}, climb ${kmh(s.state.speedMps).toFixed(1)}`);
});

console.log("Climbs and profile");
function routeFrom(segs, spacing = 5) {           // segs: [length m, grade %]
  const lat = [], lon = [], ele = [];
  let d = 0, h = 100;
  for (const [len, g] of segs) for (let x = 0; x < len; x += spacing) { lat.push(37 + d / 111195); lon.push(-120); ele.push(h); d += spacing; h += g / 100 * spacing; }
  lat.push(37 + d / 111195); lon.push(-120); ele.push(h);
  return prepareRoute({ lat, lon, ele });
}
test("flat 1 km, 800 m at 6%, 50 m flat, 400 m at 5% is one merged climb of about 1.25 km", () => {
  const r = routeFrom([[1000, 0], [800, 6], [50, 0], [400, 5], [500, 0]]), c = detectClimbs(r);
  assert.equal(c.length, 1, JSON.stringify(c));
  assert.ok(Math.abs(c[0].lengthM - 1250) <= 100, `length ${c[0].lengthM}`);
  assert.ok(Math.abs(c[0].startM - 1000) <= 100 && c[0].avgGrade > 5 && c[0].avgGrade < 6.5, JSON.stringify(c[0]));
  assert.deepEqual(r.climbs, c, "climbs are cached with the prepared route");
});
test("climbs apart by 300 m stay separate; short or small climbs are dropped", () => {
  const r = routeFrom([[500, 0], [600, 6], [300, 0], [500, 7], [500, 0], [150, 8], [400, 0], [300, 3.5], [500, 0]]);
  const c = detectClimbs(r);
  assert.equal(c.length, 2, JSON.stringify(c.map(x => [x.startM, x.lengthM, x.gainM.toFixed(0)])));
});
test("climbAt finds the climb ahead, then the one you're on", () => {
  const cs = [{ startM: 1000, endM: 2250 }];
  assert.deepEqual(climbAt(cs, 650), { climb: cs[0], on: false, toStartM: 350 });
  assert.deepEqual(climbAt(cs, 1850), { climb: cs[0], on: true, leftM: 400 });
  assert.equal(climbAt(cs, 2300), null);
});
test("the profile never draws more points than pixel columns, and keeps peaks", () => {
  const r = routeFrom([[3000, 0], [20, 30], [20, -30], [3000, 0]]);    // a sharp 20 m-wide bump
  const p = pc.columns(r, 0, r.totalDistM, 300);
  assert.ok(p.x.length <= 300 && p.g.length === p.x.length - 1);
  assert.ok(Math.max(...p.e) >= r.maxEleM - 0.01, "peak kept");
  const near = pc.columns(r, 1000, 2000, 400);                          // 100 samples in 400 px: one point each
  assert.ok(near.x.length >= 100 && near.x.length <= 103 && near.x[0] === 0 && near.x[near.x.length - 1] === 400);
});
test("the marker sits within one pixel of the rider's distance", () => {
  const r = routeFrom([[2000, 3]]);
  const calls = [];
  const ctx = { fillRect: (x, y, w, h) => calls.push([x, w]), beginPath() {}, arc() {}, fill() {}, stroke() {} };
  for (const d of [0, 123.4, 999.9, 1500, 2000]) {
    calls.length = 0;
    pc.drawProgress(ctx, r, { fromM: 0, toM: 2000, currentM: d, width: 347, height: 40, theme: {} });
    const centre = calls[0][0] + calls[0][1] / 2, want = d / 2000 * 347;
    assert.ok(Math.abs(centre - want) <= 1 || (want < 1.5 || want > 345.5), `at ${d} m: marker ${centre.toFixed(2)} px, want ${want.toFixed(2)}`);
  }
});
test("grade bands match the colour table", () => {
  assert.deepEqual([-0.1, 0, 2.9, 3, 5.9, 6, 9.9, 10, 25].map(pc.gradeBand),
    ["descent", "easy", "easy", "moderate", "moderate", "hard", "hard", "steep", "steep"]);
});
test("route-list preview keeps shape, peak and total", () => {
  const r = routeFrom([[1000, 0], [800, 6], [1000, -4]]), pv = pc.makePreview(r, 96);
  assert.equal(pv.e.length, 96); assert.equal(pv.total, r.totalDistM);
  assert.ok(Math.abs(Math.max(...pv.e) - r.maxEleM) < 0.2);
  const short = pc.makePreview(routeFrom([[300, 4]]), 96);
  assert.equal(short.e.length, 96); assert.ok(short.e.every(Number.isFinite));
});

console.log("Suggested resistance");
test("the suggestion averages the grade from 75 m behind to 125 m ahead", () => {
  const r = { gridStepM: 10, n: 101, grade: Array.from({ length: 101 }, (_, i) => i < 50 ? 0 : 6) };
  assert.equal(avgGrade(r, 0), 0);                                  // 0..125 m is all flat
  assert.ok(Math.abs(avgGrade(r, 450) - 6 * 9 / 21) < 1e-9);        // samples 38..58: 9 of 21 climb
  assert.equal(avgGrade(r, 1000), 6);                               // the end of the route is clamped
});
test("levels round to steps of 5 and stay within 1 and the bike's top level", () => {
  assert.equal(roundToStep(49, 5, 100), 50); assert.equal(roundToStep(22.4, 5, 100), 20);
  assert.equal(roundToStep(1.5, 5, 100), 1); assert.equal(roundToStep(99, 5, 100), 100);
  assert.equal(roundToStep(23, 1, 100), 23); assert.equal(roundToStep(36, 10, 32), 32);
});
test("the level holds between steps, waits 20 s between changes, but jumps for a big change", () => {
  const c = createResistanceCoach({ stepSize: 5, max: 100 });
  assert.deepEqual(c.next(25, 0), { level: 25, changed: false, up: false });
  assert.equal(c.next(28.5, 30).changed, false);                   // past halfway but not by enough: holds
  assert.deepEqual(c.next(29.5, 31), { level: 30, changed: true, up: true });
  assert.equal(c.next(25.5, 40).changed, false);                   // only 9 s since the last change
  assert.deepEqual(c.next(25.5, 52), { level: 25, changed: true, up: false });
  assert.deepEqual(c.next(36, 53), { level: 35, changed: true, up: true });   // two steps at once: no wait
  c.reset(); assert.equal(c.next(61, 54).level, 60);
});
test("a road wobbling around a step boundary doesn't make the level flip-flop", () => {
  const c = createResistanceCoach({ stepSize: 5, max: 100 });
  let changes = 0; c.next(27.5, 0);
  for (let t = 1; t < 600; t++) if (c.next(27.5 + 1.4 * Math.sin(t / 7), t).changed) changes++;
  assert.equal(changes, 0);
});
test("a bike's level is trusted only once it moves; zero and nonsense readings are ignored", () => {
  const k = createKnobReader();
  assert.equal(k.feed(0, 100), false); assert.equal(k.feed(5000, 100), false);
  k.feed(30, 100); k.feed(30, 100); assert.equal(k.level(), null);        // a fixed value could be a placeholder
  k.feed(35, 100); assert.equal(k.level(), 35);
});
test("a bike that reports tenths of a level is read in tenths from then on", () => {
  const k = createKnobReader();
  k.feed(250, 100); k.feed(305, 100); assert.equal(k.level(), 31);
  k.feed(90, 100); assert.equal(k.level(), 9);                            // still tenths below the top level
});
test("the bike's knob counts as matching within 2 levels for steps of 5", () => {
  assert.equal(bikeOffBy(47, 45, 5), 0); assert.equal(bikeOffBy(43, 45, 5), 0);
  assert.equal(bikeOffBy(48, 45, 5), 3); assert.equal(bikeOffBy(40, 45, 5), -5);
  assert.equal(bikeOffBy(41, 45, 10), 0); assert.equal(bikeOffBy(48, 45, 1), 3);
});

console.log("Strava export and upload");
// A small XML well-formedness check (Node has no XML parser built in).
function parseXml(x) {
  assert.ok(x.startsWith("<?xml"), "the XML declaration must come first");
  const body = x.replace(/^<\?xml[^>]*\?>/, ""), stack = [], counts = {};
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m, pos = 0;
  while ((m = re.exec(body))) {
    assert.equal(m.index, pos, `unexpected text near ${JSON.stringify(body.slice(pos, pos + 40))}`); pos = re.lastIndex;
    if (m[5] !== undefined) { assert.ok(!/&(?!(lt|gt|amp|quot|apos);)/.test(m[5]), "bad entity"); continue; }
    if (m[1]) assert.equal(stack.pop(), m[2], `mismatched </${m[2]}>`);
    else { counts[m[2]] = (counts[m[2]] || 0) + 1; if (!m[4]) stack.push(m[2]); }
  }
  assert.equal(pos, body.length, "trailing junk"); assert.equal(stack.length, 0, "unclosed " + stack.join(","));
  return counts;
}
function recordRide(route, watts, secs, pauseAt) {
  let w = watts;
  const { s, run } = fakeRide(route, () => ({ mode: "power", powerW: w, cadenceRpm: 85, hrBpm: 140 }));
  s.start();
  if (pauseAt) { run(pauseAt); w = 0; run(40); w = watts; }     // stop pedaling long enough to auto-pause
  run(secs); s.pause();
  return { s, ride: { id: "r1", routeName: "Test & <Hill>", startedAt: Date.UTC(2026, 8, 30, 18, 0, 0), samples: s.samples } };
}
test("buildTcx parses as XML, one trackpoint per sample, strictly increasing times", () => {
  const { ride } = recordRide(routeFrom([[1500, 0], [1500, 6], [1500, -4]]), 220, 900, 120);
  const x = buildTcx(ride), counts = parseXml(x);
  assert.equal(counts.Trackpoint, ride.samples.length);
  const times = [...x.matchAll(/<Time>([^<]+)<\/Time>/g)].map(m => Date.parse(m[1]));
  assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]), "times rise");
  assert.equal(times[0], ride.startedAt);
  assert.equal(counts["ns3:Watts"], ride.samples.length); assert.equal(counts.Cadence, ride.samples.length);
  assert.equal(counts.LatitudeDegrees, ride.samples.length);
  assert.ok(x.includes("Test &amp; &lt;Hill&gt;"));
});
test("positions can be left out of the file", () => {
  const { ride } = recordRide(routeFrom([[2000, 2]]), 200, 120);
  const x = buildTcx(ride, { includePosition: false });
  parseXml(x); assert.ok(!x.includes("<Position>") && x.includes("<AltitudeMeters>"));
});
test("file distance and moving time match the finish summary within 1%", () => {
  const { s, ride } = recordRide(routeFrom([[3000, 0], [2000, 5], [3000, -3]]), 200, 1200, 200);
  const sum = summarize(ride.samples), x = buildTcx(ride);
  const lapDist = +x.match(/<Lap[^>]*><TotalTimeSeconds>[^<]+<\/TotalTimeSeconds><DistanceMeters>([^<]+)/)[1];
  const lastTp = +[...x.matchAll(/<DistanceMeters>([^<]+)<\/DistanceMeters><HeartRateBpm>/g)].pop()[1];
  const within = (a, b) => Math.abs(a - b) <= 0.01 * b;
  assert.ok(within(lapDist, s.stats.dist) && within(lastTp, s.stats.dist), `file ${lapDist} / ${lastTp} m, summary ${s.stats.dist.toFixed(1)} m`);
  assert.ok(within(sum.movingS, s.stats.secs), `moving ${sum.movingS} s, summary ${s.stats.secs.toFixed(1)} s`);
  assert.ok(sum.avgPowerW > 190 && sum.avgPowerW <= 200.5, `avg power ${sum.avgPowerW}`);
});
test("tapping the profile mid-ride doesn't add a teleport to the file's distance", () => {
  const samples = [0, 1, 2, 3, 4].map(i => ({ elapsedS: i, distM: i < 3 ? i * 8 : 2000 + i * 8, speedMps: 8 }));
  assert.ok(Math.abs(summarize(samples).distM - 32) < 0.01);
});

// A fake Strava and helper for the upload flow.
function fakeStrava(script = {}) {
  const kv = new Map(), calls = [];
  let t = 1.8e12, uploads = 0, polls = 0;
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetchFn = async (url, init = {}) => {
    const path = url.replace("https://helper.example", ""), method = init.method || "GET";
    calls.push(method + " " + path);
    if (script.offline) throw new TypeError("Failed to fetch");
    if (path === "/exchange") return json(200, { access_token: "A1", refresh_token: "R1", expires_at: t / 1000 + 21600, athlete: { firstname: "Kane" } });
    if (path === "/refresh") return script.refreshFails ? json(400, { message: "Bad Request" }) : json(200, { access_token: "A2", refresh_token: "R2", expires_at: t / 1000 + 21600 });
    if (script.expireToken && init.headers.Authorization === "Bearer A1") return json(401, { message: "Authorization Error" });
    if (path === "/api/uploads" && method === "POST") {
      uploads++;
      assert.equal(init.body.get("data_type"), "tcx"); assert.equal(init.body.get("trainer"), "1");
      assert.equal(init.body.get("external_id"), "trailathome-r1");
      if (script.busy) return json(429, { message: "Rate Limit Exceeded" });
      return json(201, { id: 99, id_str: "99", status: "Your activity is still being processed.", error: null, activity_id: null });
    }
    if (path === "/api/uploads/99") {
      polls++;
      if (script.duplicate) return json(200, { id_str: "99", error: "ride.tcx duplicate of <a href='/activities/5550001'>Trail at Home: Test</a>", activity_id: null });
      if (script.neverDone || polls < 2) return json(200, { id_str: "99", status: "Your activity is still being processed.", error: null, activity_id: null });
      return json(200, { id_str: "99", status: "Your activity is ready.", error: null, activity_id: 5550001 });
    }
    if (path === "/api/activities/5550001" && method === "PUT") { assert.deepEqual(JSON.parse(init.body), { sport_type: "VirtualRide", trainer: true }); return json(200, { id: 5550001 }); }
    return json(404, { message: "not found" });
  };
  const st = createStrava({
    getConfig: () => ({ clientId: "12345", helperUrl: "https://helper.example/" }),
    kv: { get: async k => kv.get(k), set: async (k, v) => kv.set(k, v), del: async k => kv.delete(k) },
    fetch: fetchFn, now: () => t, sleep: async ms => { t += ms; }
  });
  return { st, kv, calls, script, advance: ms => { t += ms; }, counts: () => ({ uploads, polls }) };
}
async function connected(script) {
  const fs = fakeStrava(script);
  const url = new URL(await fs.st.connectUrl("https://kane.github.io/trail-at-home/"));
  assert.equal(url.searchParams.get("scope"), "activity:write,activity:read_all");
  const r = await fs.st.handleRedirect(new URLSearchParams({ state: url.searchParams.get("state"), code: "C", scope: "read,activity:write,activity:read_all" }));
  assert.ok(r.ok, r.message);
  return fs;
}
const RIDE = { id: "r1", routeName: "Test", upload: { status: "pending" } };
const pending = [];
const atest = (name, fn) => pending.push([name, fn]);

atest("connect: state is checked and tokens are stored", async () => {
  const fs = fakeStrava();
  await fs.st.connectUrl("https://x/");
  const bad = await fs.st.handleRedirect(new URLSearchParams({ state: "nope", code: "C", scope: "activity:write" }));
  assert.equal(bad.ok, false);
  const fs2 = await connected();
  assert.deepEqual(await fs2.st.status(), { configured: true, connected: true, name: "Kane" });
});
atest("connect: refused upload permission is reported", async () => {
  const fs = fakeStrava(), url = new URL(await fs.st.connectUrl("https://x/"));
  const r = await fs.st.handleRedirect(new URLSearchParams({ state: url.searchParams.get("state"), code: "C", scope: "read" }));
  assert.equal(r.ok, false); assert.equal((await fs.st.status()).connected, false);
});
atest("upload: posts, polls, marks it a virtual ride, links the activity", async () => {
  const fs = await connected(), ids = [];
  const r = await fs.st.upload(RIDE, "<?xml?>", { onUploadId: id => ids.push(id) });
  assert.deepEqual(r, { status: "uploaded", activityId: "5550001", virtual: true, duplicate: false });
  assert.deepEqual(ids, ["99"]); assert.ok(fs.calls.includes("PUT /api/activities/5550001"));
});
atest("upload: tokens refresh without prompting when near expiry", async () => {
  const fs = await connected();
  fs.advance(21600 * 1000 - 60 * 1000);                              // one minute left
  await fs.st.upload(RIDE, "<?xml?>");
  assert.ok(fs.calls.includes("POST /refresh"));
  assert.equal((await fs.kv.get("strava-tokens")).accessToken, "A2");
});
atest("upload: a 401 refreshes once and carries on", async () => {
  const fs = await connected({ expireToken: true });
  const r = await fs.st.upload(RIDE, "<?xml?>");
  assert.equal(r.status, "uploaded"); assert.ok(fs.calls.includes("POST /refresh"));
});
atest("upload: a duplicate counts as uploaded", async () => {
  const fs = await connected({ duplicate: true });
  const r = await fs.st.upload(RIDE, "<?xml?>");
  assert.equal(r.status, "uploaded"); assert.equal(r.activityId, "5550001"); assert.equal(r.duplicate, true);
});
atest("upload: offline or busy is retryable; a dead refresh token asks to reconnect", async () => {
  const off = await connected(); off.script.offline = true;
  await assert.rejects(off.st.upload(RIDE, "x"), e => e.kind === "retry");
  const busy = await connected({ busy: true });
  await assert.rejects(busy.st.upload(RIDE, "x"), e => e.kind === "retry");
  const dead = await connected({ refreshFails: true }); dead.advance(22000 * 1000);
  await assert.rejects(dead.st.upload(RIDE, "x"), e => e.kind === "auth");
});
atest("upload: still processing after 60 s resumes polling later without re-uploading", async () => {
  const fs = await connected({ neverDone: true });
  const r1 = await fs.st.upload(RIDE, "x");
  assert.deepEqual(r1, { status: "processing", uploadId: "99" });
  fs.script.neverDone = false;
  const r2 = await fs.st.upload(Object.assign({}, RIDE, { upload: r1 }), "x");
  assert.equal(r2.status, "uploaded"); assert.equal(fs.counts().uploads, 1);
});

(async () => {
  for (const [name, fn] of pending) {
    try { await fn(); console.log("  ok   " + name); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + e.message); }
  }
  console.log(failed ? `\n${failed} test(s) failed.` : "\nAll tests passed.");
  process.exitCode = failed ? 1 : 0;
})();
