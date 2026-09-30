/* Trail at Home: TCX export.
   Turns a saved ride (its 1 Hz sample log) into a Garmin TCX file, the plain-XML format Strava
   and most fitness apps accept, and works out the ride's summary numbers.

   buildTcx(ride, { includePosition }) -> string
     ride: { startedAt (epoch ms), samples: [{ elapsedS, distM, speedMps, eleM, lat, lon, powerW, cadenceRpm, hrBpm }] }
     Trackpoint times are start + elapsedS, so they rise strictly; the ride log only records while
     the clock runs, so paused time is never in the file.
   summarize(samples) -> { elapsedS, movingS, distM, ascentM, avgPowerW, maxPowerW, maxSpeedMps, avgHrBpm, kJ } */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TAH = Object.assign(root.TAH || {}, factory());
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

const MOVING_MPS = 0.3;          // same threshold as the ride clock's moving time
const MAX_STEP_MPS = 30;         // a larger jump between samples was a tap on the profile, not riding

// Distance ridden between two samples. Jumps along the route (tapping the profile) count as the
// distance the speed would have covered, so they don't show up as a teleport.
function stepDist(a, b) {
  const dt = Math.max(0, b.elapsedS - a.elapsedS), dd = b.distM - a.distM;
  return dd >= 0 && dd <= MAX_STEP_MPS * dt + 1 ? dd : Math.max(0, b.speedMps || 0) * dt;
}

function summarize(samples) {
  const s = { elapsedS: 0, movingS: 0, distM: 0, ascentM: 0, avgPowerW: null, maxPowerW: null, maxSpeedMps: 0, avgHrBpm: null, kJ: 0 };
  if (!samples || !samples.length) return s;
  let pSum = 0, pN = 0, hSum = 0, hN = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    if (i) {
      const prev = samples[i - 1], dt = Math.max(0, x.elapsedS - prev.elapsedS);
      s.distM += stepDist(prev, x);
      if (x.speedMps > MOVING_MPS) s.movingS += dt;
      if (x.ascentM != null && prev.ascentM != null && x.ascentM > prev.ascentM && stepDist(prev, x) === x.distM - prev.distM) s.ascentM += x.ascentM - prev.ascentM;
      if (x.powerW != null) s.kJ += x.powerW * dt / 1000;
    }
    if (x.powerW != null) { if (x.speedMps > MOVING_MPS) { pSum += x.powerW; pN++; } s.maxPowerW = Math.max(s.maxPowerW || 0, x.powerW); }
    if (x.hrBpm != null) { hSum += x.hrBpm; hN++; }
    s.maxSpeedMps = Math.max(s.maxSpeedMps, x.speedMps || 0);
  }
  s.elapsedS = samples[samples.length - 1].elapsedS - samples[0].elapsedS;
  if (pN) s.avgPowerW = pSum / pN;
  if (hN) s.avgHrBpm = hSum / hN;
  return s;
}

const esc = t => String(t).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const iso = ms => new Date(Math.round(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const num = (v, d) => Number(v.toFixed(d)).toString();

function buildTcx(ride, opts = {}) {
  const samples = ride.samples || [], includePosition = opts.includePosition !== false;
  if (!samples.length) throw new Error("This ride has no recorded data.");
  const t0 = samples[0].elapsedS, start = ride.startedAt, sum = summarize(samples);
  const timeOf = x => iso(start + (x.elapsedS - t0) * 1000);
  const out = [];
  let dist = 0, lastSec = -1;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    if (i) dist += stepDist(samples[i - 1], x);
    const sec = Math.round(x.elapsedS - t0);
    if (sec <= lastSec) continue;                       // keep times strictly increasing at 1 s resolution
    lastSec = sec;
    let tp = `<Trackpoint><Time>${timeOf(x)}</Time>`;
    if (includePosition && x.lat != null && x.lon != null) tp += `<Position><LatitudeDegrees>${num(x.lat, 7)}</LatitudeDegrees><LongitudeDegrees>${num(x.lon, 7)}</LongitudeDegrees></Position>`;
    if (x.eleM != null && Number.isFinite(x.eleM)) tp += `<AltitudeMeters>${num(x.eleM, 1)}</AltitudeMeters>`;
    tp += `<DistanceMeters>${num(dist, 1)}</DistanceMeters>`;
    if (x.hrBpm != null) tp += `<HeartRateBpm><Value>${Math.round(x.hrBpm)}</Value></HeartRateBpm>`;
    if (x.cadenceRpm != null) tp += `<Cadence>${Math.min(254, Math.round(x.cadenceRpm))}</Cadence>`;
    const ext = (x.speedMps != null ? `<ns3:Speed>${num(x.speedMps, 2)}</ns3:Speed>` : "") + (x.powerW != null ? `<ns3:Watts>${Math.round(x.powerW)}</ns3:Watts>` : "");
    if (ext) tp += `<Extensions><ns3:TPX>${ext}</ns3:TPX></Extensions>`;
    out.push(tp + "</Trackpoint>");
  }
  const startIso = iso(start);
  const lapExt = sum.avgPowerW != null ? `<Extensions><ns3:LX><ns3:AvgWatts>${Math.round(sum.avgPowerW)}</ns3:AvgWatts></ns3:LX></Extensions>` : "";
  const hr = sum.avgHrBpm != null ? `<AverageHeartRateBpm><Value>${Math.round(sum.avgHrBpm)}</Value></AverageHeartRateBpm>` : "";
  // Strava rejects TCX files with anything before the XML declaration, so it comes first.
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
<Activities><Activity Sport="Biking"><Id>${startIso}</Id>
<Lap StartTime="${startIso}"><TotalTimeSeconds>${num(sum.elapsedS, 1)}</TotalTimeSeconds><DistanceMeters>${num(sum.distM, 1)}</DistanceMeters><MaximumSpeed>${num(sum.maxSpeedMps, 2)}</MaximumSpeed><Calories>${Math.round(sum.kJ)}</Calories>${hr}<Intensity>Active</Intensity><TriggerMethod>Manual</TriggerMethod>
<Track>
${out.join("\n")}
</Track>${lapExt}</Lap>
<Notes>${esc(ride.routeName ? "Virtual ride of " + ride.routeName + " on Trail at Home" : "Virtual ride on Trail at Home")}</Notes>
<Creator xsi:type="Device_t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Name>Trail at Home</Name><UnitId>0</UnitId><ProductID>0</ProductID><Version><VersionMajor>1</VersionMajor><VersionMinor>0</VersionMinor></Version></Creator>
</Activity></Activities>
</TrainingCenterDatabase>
`;
}

function tcxFileName(ride) {
  const d = new Date(ride.startedAt), pad = n => String(n).padStart(2, "0");
  const safe = String(ride.routeName || "ride").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "ride";
  return `Trail at Home - ${safe} - ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.tcx`;
}

return { buildTcx, summarize, tcxFileName };
});
