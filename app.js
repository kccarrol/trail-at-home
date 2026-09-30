/* Trail at Home: ride GPX routes on an indoor bike.
   Sections: helpers, settings, storage, route math, physics, library, ride, bluetooth, app shell. */
(function () {
"use strict";

/* ========== Helpers ========== */
const $ = id => document.getElementById(id);
const STEP = 10;                         // routes are resampled every 10 m
const MI = 1609.344, FT = 0.3048, KG_PER_LB = 0.45359237;
const MAX_ROUTES = 100, MAX_FILE_BYTES = 30e6;
const STALE_MS = 3000;                   // live bike data older than this is treated as missing
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Only write to the page when a value actually changes (keeps the 4x-per-second update cheap).
const shown = new Map();
function setText(id, t) { t = String(t); if (shown.get(id) !== t) { shown.set(id, t); $(id).textContent = t; } }

const NAMES = { descent: "Descent", easy: "Easy", moderate: "Moderate climb", hard: "Hard climb", extreme: "Very steep climb" };
const SYM = {
  easy: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>',
  moderate: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" fill="currentColor"/></svg>',
  hard: '<svg viewBox="0 0 24 24"><path d="M12 2 22 12 12 22 2 12Z" fill="currentColor"/></svg>',
  extreme: '<svg viewBox="0 0 28 24"><path d="M8 3 15 12 8 21 1 12Z M20 3 27 12 20 21 13 12Z" fill="currentColor"/></svg>',
  descent: '<svg viewBox="0 0 24 24"><path d="M4 7 12 16 20 7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};
const LEGEND = [["easy", "Under 3%: flat or gentle", "var(--green)"], ["moderate", "3–6%: moderate climb", "var(--blue)"],
  ["hard", "6–10%: hard climb", "var(--ink)"], ["extreme", "Over 10%: very steep", "var(--ink)"], ["descent", "Downhill steeper than 2%", "var(--descent)"]];
$("legend").innerHTML = LEGEND.map(l => `<div><span style="color:${l[2]}">${SYM[l[0]]}</span>${l[1]}</div>`).join("");

/* ========== Settings (small, kept in localStorage) ========== */
function lsGet(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function sanitize(o) {
  const n = (v, d, lo, hi) => Number.isFinite(+v) ? clamp(+v, lo, hi) : d;
  o.units = o.units === "km" ? "km" : "mi";
  o.max = n(o.max, 100, 1, 200);
  o.flat = n(o.flat, 25, 1, o.max);
  o.step = n(o.step, 4, 0, 20);
  o.speed = n(o.speed, 16.09, 0, 80);      // km/h, used when speed is set by hand
  o.weight = n(o.weight, 77, 30, 250);     // kg
  return o;
}
const S = sanitize(Object.assign({}, lsGet("tah-settings") || {}));
const saveSettings = () => lsSet("tah-settings", S);

/* ========== Formatting ========== */
const isMi = () => S.units === "mi";
const dUnit = () => isMi() ? MI : 1000;
const fmtD = m => (m / dUnit()).toFixed(2);
const fmtDShort = m => { const v = m / dUnit(); return (v < 10 ? v.toFixed(1) : Math.round(v)) + (isMi() ? " mi" : " km"); };
const fmtE = m => Math.round(isMi() ? m / FT : m).toLocaleString();
const eUnit = () => isMi() ? "ft" : "m";
const spdOut = kmh => (isMi() ? kmh / 1.609344 : kmh).toFixed(1);
const sUnit = () => isMi() ? "mph" : "km/h";
const fmtT = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };

/* ========== Storage (IndexedDB) ==========
   "meta" holds small route summaries for the list; "profiles" holds the elevation data. */
let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    if (!("indexedDB" in self)) return rej(new Error("no-idb"));
    const r = indexedDB.open("trail-at-home", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("meta", { keyPath: "id" }); d.createObjectStore("profiles", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbPromise;
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
async function allMeta() { const d = await db(); return reqP(d.transaction("meta").objectStore("meta").getAll()); }
async function getProfile(id) { const d = await db(); return reqP(d.transaction("profiles").objectStore("profiles").get(id)); }
async function putMeta(m) { const d = await db(); const t = d.transaction("meta", "readwrite"); t.objectStore("meta").put(m); return txDone(t); }
async function addRoute(m, e) {
  const d = await db(), t = d.transaction(["meta", "profiles"], "readwrite");
  t.objectStore("meta").put(m); t.objectStore("profiles").put({ id: m.id, e }); return txDone(t);
}
async function deleteRoute(id) {
  const d = await db(), t = d.transaction(["meta", "profiles"], "readwrite");
  t.objectStore("meta").delete(id); t.objectStore("profiles").delete(id); return txDone(t);
}
const newId = () => (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
const storageMsg = e => e && e.name === "QuotaExceededError"
  ? "Your phone is out of space for routes. Delete some routes or free up storage."
  : "Something went wrong saving to your phone. Please try again.";

/* ========== Route math ========== */
class GpxError extends Error {}
function cls(g) { if (g <= -2) return "descent"; if (g < 3) return "easy"; if (g < 6) return "moderate"; if (g < 10) return "hard"; return "extreme"; }
function resFor(g) { const r = g >= 0 ? S.flat + g * S.step : S.flat + g * S.step * 0.5; return clamp(Math.round(r), 1, S.max); }
function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000, t = Math.PI / 180, dLat = (bLat - aLat) * t, dLon = (bLon - aLon) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * t) * Math.cos(bLat * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Reads a GPX file and returns its name and elevations sampled every 10 m along the route.
function parseGPX(text, fallbackName) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new GpxError("couldn't be read as a GPX file.");
  let pts = doc.getElementsByTagName("trkpt");
  if (!pts.length) pts = doc.getElementsByTagName("rtept");
  if (pts.length < 2) throw new GpxError("has no route points.");
  const dist = [], ele = [];
  let cum = 0, pLat = null, pLon = null, noEle = 0;
  for (const p of pts) {
    const lat = parseFloat(p.getAttribute("lat")), lon = parseFloat(p.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const el = p.getElementsByTagName("ele")[0], h = el ? parseFloat(el.textContent) : NaN;
    if (!Number.isFinite(h) || h < -500 || h > 9000) { noEle++; continue; }   // missing or bogus elevation
    if (pLat !== null) { const s = haversine(pLat, pLon, lat, lon); if (s < 0.5) continue; cum += s; }
    pLat = lat; pLon = lon; dist.push(cum); ele.push(h);
  }
  if (dist.length < 2) throw new GpxError(noEle ? "has no elevation data. Try exporting a recorded ride instead of a route." : "has too few usable points.");
  if (cum < 200) throw new GpxError("is shorter than 200 meters.");
  // Linear interpolation onto an even 10 m grid.
  const n = Math.floor(cum / STEP) + 1, out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    const x = i * STEP;
    while (j < dist.length - 2 && dist[j + 1] < x) j++;
    const span = dist[j + 1] - dist[j], t = span > 0 ? clamp((x - dist[j]) / span, 0, 1) : 0;
    out[i] = ele[j] + (ele[j + 1] - ele[j]) * t;
  }
  const nameEl = doc.querySelector("metadata > name, trk > name, rte > name");
  return { name: ((nameEl && nameEl.textContent.trim()) || fallbackName).slice(0, 120), e: out };
}

// Smooths elevation, works out the grade at every point and running elevation gain.
function build(src) {
  const n = src.length;
  // 1) 70 m moving average of elevation (prefix sums keep this O(n)).
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i];
  const s = new Float32Array(n), W = 3;
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - W), b = Math.min(n - 1, i + W); s[i] = (pre[b + 1] - pre[a]) / (b - a + 1); }
  // 2) Grade over a 100 m window, clamped to a plausible range.
  const g = new Float32Array(n), H = 5;
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - H), b = Math.min(n - 1, i + H); g[i] = b > a ? clamp((s[b] - s[a]) / ((b - a) * STEP) * 100, -25, 25) : 0; }
  // 3) Elevation gain with a 2 m dead band so GPS jitter doesn't count as climbing.
  const cg = new Float32Array(n); let gain = 0, ref = s[0], min = s[0], max = s[0];
  for (let i = 1; i < n; i++) {
    if (s[i] > ref + 2) { gain += s[i] - ref; ref = s[i]; } else if (s[i] < ref - 2) ref = s[i];
    cg[i] = gain; if (s[i] < min) min = s[i]; if (s[i] > max) max = s[i];
  }
  return { n, total: (n - 1) * STEP, e: s, g, cg, gain, min, max };
}
// Grade at any position, interpolated between the 10 m samples so readings change smoothly.
function gradeAt(r, pos) { const x = clamp(pos / STEP, 0, r.n - 1), i = Math.floor(x), f = x - i; return i >= r.n - 1 ? r.g[i] : r.g[i] + (r.g[i + 1] - r.g[i]) * f; }
// A tiny 48-point outline of the route for the route list.
function makeSpark(e, k = 48) {
  const n = e.length, out = []; let lo = Infinity, hi = -Infinity;
  for (let b = 0; b < k; b++) { const a = Math.floor(b * n / k), z = Math.max(a + 1, Math.floor((b + 1) * n / k)); let t = 0; for (let i = a; i < z; i++) t += e[i]; out.push(t / (z - a)); }
  out.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
  const range = Math.max(20, hi - lo);
  return out.map(v => Math.round((v - lo) / range * 100) / 100);
}
function sampleProfile() {
  const n = 12000 / STEP + 1, e = new Float32Array(n);
  for (let i = 0; i < n; i++) { const d = i * STEP; e[i] = 300 + 60 * Math.sin(d / 1800) + 45 * Math.sin(d / 700 + 1) + 25 * Math.exp(-(((d - 8000) / 250) ** 2)); }
  return e;
}

/* ========== Physics: speed from power ==========
   Each moment the rider's watts push against gravity on the current grade, rolling resistance
   of knobby tires on dirt, and air drag. Any surplus or shortfall speeds the rider up or slows
   them down, so climbs feel slow and descents carry momentum. */
const PHYS = { g: 9.80665, rho: 1.2, cda: 0.5, crr: 0.015, eta: 0.97, bikeKg: 13, vmax: 11.18 }; // vmax ≈ 25 mph
function physStep(v, watts, gradePct, dt) {
  const th = Math.atan(gradePct / 100), m = S.weight + PHYS.bikeKg;
  const drive = watts * PHYS.eta / Math.max(v, 1);                     // force from pedaling (capped at very low speed)
  const resist = m * PHYS.g * (Math.sin(th) + PHYS.crr * Math.cos(th)) + 0.5 * PHYS.rho * PHYS.cda * v * v;
  if (v <= 0.01 && drive <= resist) return 0;                           // standing still and not pushing hard enough
  const a = (drive - resist) / (m * 1.04);                              // 1.04 accounts for spinning wheels
  return clamp(v + a * dt, 0, PHYS.vmax);
}

/* ========== Library screen ========== */
let metas = [], sparkFixRunning = false;
const setStatus = t => { $("status").textContent = t; };
const setError = t => { $("err").textContent = t; };

async function saveNewRoute(name, e) {
  const r = build(e);
  const m = { id: newId(), name, total: r.total, gain: r.gain, spark: makeSpark(r.e), added: Date.now(), lastRidden: 0, pos: 0, stats: null };
  await addRoute(m, e);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return m;
}

async function loadLibrary() {
  try { metas = await allMeta(); }
  catch (e) { metas = []; setError(e.message === "no-idb" ? "This browser can't save routes. Open the app in Chrome." : "Your saved routes couldn't be opened. Try closing and reopening the app."); }
  drawLibrary();
  fixMissingSparks();
}

function sparkSvg(sp) {
  if (!sp || sp.length < 2) return "";
  const pts = sp.map((v, i) => `${(i / (sp.length - 1) * 100).toFixed(1)},${(30 - v * 26).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,32 ${pts} 100,32"/></svg>`;
}

function drawLibrary() {
  metas.sort((a, b) => Math.max(b.lastRidden, b.added) - Math.max(a.lastRidden, a.added));
  const empty = !metas.length;
  $("intro").hidden = !empty; $("sample").hidden = !empty;
  $("count").textContent = empty ? "" : `${metas.length} of ${MAX_ROUTES} routes saved`;
  $("routes").innerHTML = metas.map(m => {
    const finished = m.pos >= m.total - 5;
    const pct = m.pos > 50 ? Math.min(100, m.pos / m.total * 100) : 0;
    const where = finished ? " Finished." : m.pos > 50 ? ` Stopped at ${fmtDShort(m.pos)}.` : "";
    return `<li class="route">
      <button class="open" data-id="${esc(m.id)}">
        <b>${esc(m.name)}</b>${sparkSvg(m.spark)}
        <span class="sub">${fmtDShort(m.total)}, ${fmtE(m.gain)} ${eUnit()} of climbing.${where}</span>
        ${pct > 0 ? `<span class="prog"><i style="width:${pct.toFixed(1)}%"></i></span>` : ""}
      </button>
      <div class="acts"><button data-act="rename" data-id="${esc(m.id)}">Rename</button><button data-act="delete" data-id="${esc(m.id)}">Delete</button></div>
    </li>`;
  }).join("");
}

// Routes saved by an earlier version have no outline yet; add one in the background.
async function fixMissingSparks() {
  const missing = metas.filter(m => !m.spark);
  if (!missing.length || sparkFixRunning) return;
  sparkFixRunning = true;
  for (const m of missing) {
    try { const p = await getProfile(m.id); if (p) { m.spark = makeSpark(build(p.e).e); await putMeta(m); } } catch (e) {}
  }
  sparkFixRunning = false;
  if (!$("lib").hidden) drawLibrary();
}

async function importFiles(files) {
  if (!files.length) return;
  setError(""); setStatus(files.length === 1 ? "Adding route…" : `Adding ${files.length} routes…`);
  const problems = []; let added = 0, dupes = 0;
  for (const f of files) {
    if (metas.length >= MAX_ROUTES) { problems.push(`You've reached ${MAX_ROUTES} routes. Delete some to add more.`); break; }
    if (f.size > MAX_FILE_BYTES) { problems.push(`${f.name} is too large to be a route file.`); continue; }
    try {
      const r = parseGPX(await f.text(), f.name.replace(/\.gpx$/i, ""));
      const total = (r.e.length - 1) * STEP;
      if (metas.some(m => m.name === r.name && Math.abs(m.total - total) < 25)) { dupes++; continue; }
      metas.push(await saveNewRoute(r.name, r.e)); added++;
    } catch (err) {
      problems.push(err instanceof GpxError ? `${f.name} ${err.message}` : `${f.name} couldn't be saved. ${storageMsg(err)}`);
    }
  }
  const bits = [];
  if (added) bits.push(added === 1 ? "Added 1 route." : `Added ${added} routes.`);
  if (dupes) bits.push(dupes === 1 ? "1 route was already saved." : `${dupes} routes were already saved.`);
  setStatus(bits.join(" ")); setError(problems.join(" "));
  drawLibrary();
}

$("file").addEventListener("change", ev => { const files = [...ev.target.files]; ev.target.value = ""; importFiles(files); });
$("sample").addEventListener("click", async () => {
  try { metas.push(await saveNewRoute("Sample: Ridge loop", sampleProfile())); drawLibrary(); } catch (e) { setError(storageMsg(e)); }
});
$("routes").addEventListener("click", async ev => {
  const b = ev.target.closest("button"); if (!b) return;
  const m = metas.find(x => x.id === b.dataset.id); if (!m) return;
  try {
    if (b.dataset.act === "rename") {
      const name = prompt("Route name", m.name);
      if (name && name.trim()) { m.name = name.trim().slice(0, 120); await putMeta(m); drawLibrary(); }
    } else if (b.dataset.act === "delete") {
      if (confirm(`Delete "${m.name}"? This can't be undone.`)) { await deleteRoute(m.id); metas = metas.filter(x => x !== m); setStatus(""); drawLibrary(); }
    } else await openRide(m);
  } catch (e) { setError(storageMsg(e)); }
});

/* ========== Ride screen ========== */
const R = {
  meta: null, route: null, pos: 0, v: 0,              // v = current speed in m/s
  running: false, timer: null, lastT: 0, lastSave: 0, wake: null,
  stats: null,                                         // moving time, distance and energy for this ride
  resShown: null, clsShown: null
};
const newStats = () => ({ secs: 0, dist: 0, joules: 0, powSecs: 0 });

async function openRide(m) {
  const p = await getProfile(m.id);
  if (!p) { setError("That route's data is missing. Try adding it again."); return; }
  R.meta = m; R.route = build(p.e); R.pos = clamp(m.pos || 0, 0, R.route.total); R.v = 0;
  R.stats = Object.assign(newStats(), m.stats || {}); R.resShown = null; R.clsShown = null;
  shown.clear();
  $("title").textContent = m.name;
  $("summary").hidden = true;
  $("go").textContent = R.pos >= R.route.total ? "Ride again" : R.pos > 0 ? "Resume" : "Start riding";
  $("lib").hidden = true; $("ride").hidden = false; window.scrollTo(0, 0);
  if (location.hash !== "#ride") history.pushState({ ride: true }, "", "#ride");
  drawProfile(); update();
  if (R.pos >= R.route.total) showSummary();
}

function closeRide() {
  if (R.running) stop();
  saveProgress();
  R.meta = null; R.route = null;
  $("ride").hidden = true; $("lib").hidden = false;
  setStatus(""); drawLibrary();
}
$("back").addEventListener("click", () => { if (location.hash === "#ride") history.back(); else closeRide(); });
window.addEventListener("popstate", () => { if (R.meta) closeRide(); });

function saveProgress() {
  if (!R.meta) return;
  R.meta.pos = R.pos; R.meta.stats = R.stats; R.meta.lastRidden = Date.now();
  putMeta(R.meta).catch(() => {});
}

function drawProfile() {
  const r = R.route, k = Math.max(1, Math.ceil(r.n / 600)), idx = [];
  for (let i = 0; i < r.n; i += k) idx.push(i);
  if (idx[idx.length - 1] !== r.n - 1) idx.push(r.n - 1);
  const range = Math.max(30, r.max - r.min);
  const X = i => (i * STEP / r.total * 1000).toFixed(1), Y = i => (192 - (r.e[i] - r.min) / range * 165).toFixed(1);
  const segCls = p => cls(r.g[Math.round((idx[p - 1] + idx[p]) / 2)]);
  // Neighbouring stretches of the same difficulty become one filled shape.
  let h = "", p = 1;
  while (p < idx.length) {
    const c = segCls(p), first = idx[p - 1];
    let top = `${X(first)},${Y(first)}`;
    while (p < idx.length && segCls(p) === c) { top += ` ${X(idx[p])},${Y(idx[p])}`; p++; }
    h += `<polygon class="p-${c}" points="${X(first)},200 ${top} ${X(idx[p - 1])},200"/>`;
  }
  h += `<rect class="done" id="profDone" x="0" y="0" width="0" height="200"/><line class="mark" id="mark" x1="0" x2="0" y1="0" y2="200" vector-effect="non-scaling-stroke"/>`;
  $("prof").innerHTML = h;
}

/* --- What the screen shows --- */
function speedMode() { if (BT.bike && live.hasPower) return "power"; if (BT.bike && live.hasSpeed) return "bike"; return "manual"; }

function update() {
  const r = R.route; if (!r) return;
  const g = gradeAt(r, R.pos), c = cls(g), md = speedMode();

  if (c !== R.clsShown) { R.clsShown = c; $("sign").dataset.cls = c; $("sym").innerHTML = SYM[c]; setText("diff", NAMES[c]); }
  const gv = Math.abs(g) < 0.05 ? 0 : g;
  setText("grade", (gv < 0 ? "−" : "") + Math.abs(gv).toFixed(1));

  // Resistance only changes when the target moves by a noticeable amount, so the number
  // doesn't flicker; each change flashes with an arrow while riding.
  const target = resFor(g), band = Math.max(1, Math.round(S.max / 50));
  if (R.resShown === null || Math.abs(target - R.resShown) >= band || target === 1 || target === S.max) {
    if (R.resShown !== null && target !== R.resShown && R.running) flashRes(target > R.resShown);
    R.resShown = target;
  }
  setText("res", R.resShown);

  setText("spd", spdOut(md === "manual" ? S.speed : R.v * 3.6));
  setText("spdL", sUnit() + ({ manual: ", match your console", power: ", from your power", bike: ", from your bike" })[md]);
  $("sUp").disabled = $("sDown").disabled = md !== "manual";
  $("syncRow").hidden = md === "power";

  setText("mTime", fmtT(R.stats.secs));
  setText("mPow", live.hasPower && BT.bike ? (fresh(live.powT) ? Math.max(0, Math.round(live.power)) : 0) : "–");
  setText("mCad", live.hasCad && BT.bike ? (fresh(live.cadT) ? Math.round(live.cad) : 0) : "–");
  setText("mHr", fresh(live.hrT) ? live.hr : "–");

  const i = clamp(Math.round(R.pos / STEP), 0, r.n - 1);
  setText("sDist", fmtD(R.pos)); setText("sDistL", (isMi() ? "mi" : "km") + " ridden");
  setText("sLeft", fmtD(r.total - R.pos)); setText("sLeftL", (isMi() ? "mi" : "km") + " to go");
  setText("sGain", fmtE(r.cg[i])); setText("sGainL", eUnit() + " climbed");
  const x = (R.pos / r.total * 1000).toFixed(1);
  if (shown.get("markX") !== x) { shown.set("markX", x); $("mark").setAttribute("x1", x); $("mark").setAttribute("x2", x); $("profDone").setAttribute("width", x); }
}

function flashRes(up) {
  const box = $("resBox");
  $("resDir").textContent = up ? "▲" : "▼";
  box.classList.remove("bump"); void box.offsetWidth; box.classList.add("bump");
}

function showSummary() {
  const st = R.stats, avg = st.secs > 0 ? st.dist / st.secs * 3.6 : 0;
  let t = `${fmtT(st.secs)} of riding over ${fmtDShort(st.dist)}, averaging ${spdOut(avg)} ${sUnit()}`;
  if (st.powSecs > 30) t += ` and ${Math.round(st.joules / st.powSecs)} watts`;
  t += `. The route climbs ${fmtE(R.route.gain)} ${eUnit()}.`;
  $("sumText").textContent = t;
  $("summary").hidden = false;
}

/* --- Riding --- */
function tick() {
  const now = performance.now(), dt = clamp((now - R.lastT) / 1000, 0, 60);   // background tabs can tick slowly
  R.lastT = now;
  const md = speedMode(), steps = Math.max(1, Math.ceil(dt / 0.1)), h = dt / steps, st = R.stats;
  for (let k = 0; k < steps && R.pos < R.route.total; k++) {
    let watts = 0;
    if (md === "power") { watts = fresh(live.powT) ? Math.max(0, live.power) : 0; R.v = physStep(R.v, watts, gradeAt(R.route, R.pos), h); }
    else if (md === "bike") R.v = fresh(live.spdT) ? live.spd / 3.6 : 0;
    else R.v = S.speed / 3.6;
    const moved = Math.min(R.v * h, R.route.total - R.pos);
    R.pos += moved;
    if (R.route.total - R.pos < 0.05) R.pos = R.route.total;          // guard against rounding just short of the end
    if (R.v > 0.3) { st.secs += h; st.dist += moved; if (md === "power") { st.joules += watts * h; st.powSecs += h; } }
  }
  if (now - R.lastSave > 5000) { saveProgress(); R.lastSave = now; }
  if (R.pos >= R.route.total) { stop(); showSummary(); }
  update();
}
async function lockScreen() { try { if ("wakeLock" in navigator) R.wake = await navigator.wakeLock.request("screen"); } catch (e) { R.wake = null; } }
function start() {
  if (R.pos >= R.route.total) { R.pos = 0; R.stats = newStats(); }
  $("summary").hidden = true;
  R.running = true; R.lastT = performance.now(); R.timer = setInterval(tick, 250);
  $("go").textContent = "Pause"; lockScreen();
}
function stop() {
  R.running = false; clearInterval(R.timer); R.v = 0;
  $("go").textContent = R.pos >= R.route.total ? "Ride again" : "Resume";
  saveProgress(); update();
  try { R.wake && R.wake.release(); } catch (e) {}
  R.wake = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { if (R.running) lockScreen(); }
  else saveProgress();
});
setInterval(() => { if (R.route && !R.running && (BT.bike || BT.hr)) update(); }, 1000);  // keep live numbers fresh while paused

$("go").addEventListener("click", () => R.running ? stop() : start());

// Hold + or − to keep changing speed.
function changeSpeed(dir) {
  if (speedMode() !== "manual") return;
  S.speed = clamp(S.speed + dir * (isMi() ? 0.5 * 1.609344 : 1), 0, 80); saveSettings(); update();
}
function holdRepeat(btn, fn) {
  let delay = null, rep = null;
  const end = () => { clearTimeout(delay); clearInterval(rep); };
  btn.addEventListener("pointerdown", e => { if (btn.disabled) return; e.preventDefault(); fn(); delay = setTimeout(() => { rep = setInterval(fn, 110); }, 450); });
  ["pointerup", "pointerleave", "pointercancel"].forEach(t => btn.addEventListener(t, end));
  btn.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
  btn.addEventListener("contextmenu", e => e.preventDefault());
}
holdRepeat($("sUp"), () => changeSpeed(1));
holdRepeat($("sDown"), () => changeSpeed(-1));

$("syncBtn").addEventListener("click", () => {
  const v = parseFloat($("syncIn").value.replace(",", "."));
  if (!Number.isFinite(v) || v < 0) { $("syncIn").focus(); return; }
  R.pos = clamp(v * dUnit(), 0, R.route.total); $("syncIn").value = ""; saveProgress(); update();
});
$("prof").addEventListener("click", e => {
  const b = e.currentTarget.getBoundingClientRect();
  R.pos = clamp((e.clientX - b.left) / b.width, 0, 1) * R.route.total; R.v = 0; saveProgress(); update();
});
$("restart").addEventListener("click", () => {
  if (R.running) stop();
  R.pos = 0; R.stats = newStats(); $("summary").hidden = true; $("go").textContent = "Start riding"; saveProgress(); update();
});

/* --- Settings panel --- */
function showSettings() {
  $("setFlat").value = S.flat; $("setStep").value = S.step; $("setMax").value = S.max; $("setUnits").value = S.units;
  $("setWeight").value = Math.round(isMi() ? S.weight / KG_PER_LB : S.weight);
  $("weightL").textContent = isMi() ? "Your weight (lb)" : "Your weight (kg)";
  $("capNote").textContent = isMi() ? "25 mph" : "40 km/h";
}
function readSettings() {
  const v = id => parseFloat($(id).value);
  S.max = v("setMax"); S.flat = v("setFlat"); S.step = v("setStep");
  const w = v("setWeight"); if (Number.isFinite(w)) S.weight = isMi() ? w * KG_PER_LB : w;
  applySettings();
}
function applySettings() {
  sanitize(S); saveSettings(); showSettings(); R.resShown = null; shown.clear(); R.clsShown = null; update();
}
showSettings();
["setFlat", "setStep", "setMax", "setWeight"].forEach(id => $(id).addEventListener("change", readSettings));
$("setUnits").addEventListener("change", () => { S.units = $("setUnits").value; applySettings(); });

/* ========== Bluetooth ==========
   Reads whichever standard services a device offers: Fitness Machine (speed, cadence, power,
   heart rate), Cycling Power (watts, cadence), Cycling Speed and Cadence, and Heart Rate. */
const SVC = { ftms: 0x1826, cp: 0x1818, csc: 0x1816, hr: 0x180D };
const CHR = { ftms: 0x2AD2, cp: 0x2A63, csc: 0x2A5B, hr: 0x2A37 };
const live = { power: 0, powT: 0, cad: 0, cadT: 0, hr: 0, hrT: 0, spd: 0, spdT: 0, hasPower: false, hasSpeed: false, hasCad: false };
const BT = { bike: null, hr: null, bikeUserOff: false, hrUserOff: false };
let lastCrank = null;
const fresh = t => t > 0 && performance.now() - t < STALE_MS;
const btMsg = t => { $("btMsg").textContent = t; };
const joinList = a => a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];

function setPower(w) { live.power = w; live.powT = performance.now(); live.hasPower = true; }
function setCad(r) { live.cad = r; live.cadT = performance.now(); live.hasCad = true; }
function setHr(b) { if (b > 20 && b < 250) { live.hr = b; live.hrT = performance.now(); } }
function setSpeed(k) { live.spd = k; live.spdT = performance.now(); live.hasSpeed = true; }
function resetBikeData() { Object.assign(live, { powT: 0, cadT: 0, spdT: 0, hasPower: false, hasSpeed: false, hasCad: false }); lastCrank = null; }

// Cadence from crank revolution counts. Event time is in 1/1024 s; both counters wrap at 65536.
function crank(revs, t) {
  const now = performance.now();
  if (!lastCrank) { lastCrank = { revs, t, now }; return; }
  const dr = (revs - lastCrank.revs + 65536) % 65536, ds = ((t - lastCrank.t + 65536) % 65536) / 1024;
  if (dr > 0 && ds > 0) { const rpm = dr / ds * 60; if (rpm < 250) setCad(rpm); lastCrank = { revs, t, now }; }
  else if (now - lastCrank.now > STALE_MS) setCad(0);    // no new pedal strokes: cadence is zero
}
function parseFTMS(v) {                                  // Indoor Bike Data: fields follow the flags in a fixed order
  const f = v.getUint16(0, true); let o = 2;
  if (!(f & 1)) { setSpeed(v.getUint16(o, true) / 100); o += 2; }
  if (f & 2) o += 2;
  if (f & 4) { setCad(v.getUint16(o, true) / 2); o += 2; }
  if (f & 8) o += 2;
  if (f & 16) o += 3;
  if (f & 32) o += 2;
  if (f & 64) { setPower(v.getInt16(o, true)); o += 2; }
  if (f & 128) o += 2;
  if (f & 256) o += 5;
  if (f & 512) setHr(v.getUint8(o));
}
function parseCP(v) {                                    // Cycling Power Measurement
  const f = v.getUint16(0, true); setPower(v.getInt16(2, true)); let o = 4;
  if (f & 1) o += 1; if (f & 4) o += 2; if (f & 16) o += 6;
  if (f & 32) crank(v.getUint16(o, true), v.getUint16(o + 2, true));
}
function parseCSC(v) { const f = v.getUint8(0); let o = 1; if (f & 1) o += 6; if (f & 2) crank(v.getUint16(o, true), v.getUint16(o + 2, true)); }
function parseHR(v) { const f = v.getUint8(0); setHr(f & 1 ? v.getUint16(1, true) : v.getUint8(1)); }

async function subscribe(server, svc, chr, parse) {
  try {
    const c = await (await server.getPrimaryService(svc)).getCharacteristic(chr);
    if (!c._tahListening) {                              // avoid double listeners after a reconnect
      c.addEventListener("characteristicvaluechanged", e => { try { parse(e.target.value); } catch (x) { /* malformed packet: skip */ } });
      c._tahListening = true;
    }
    await c.startNotifications();
    return true;
  } catch (e) { return false; }
}

// Connects to the bike and subscribes to every useful service it has.
async function attachBike(dev) {
  const server = await dev.gatt.connect(), got = [];
  if (await subscribe(server, SVC.ftms, CHR.ftms, parseFTMS)) got.push("ftms");
  else {
    if (await subscribe(server, SVC.cp, CHR.cp, parseCP)) { got.push("cp"); live.hasPower = true; }
    if (await subscribe(server, SVC.csc, CHR.csc, parseCSC)) got.push("csc");
  }
  if (!BT.hr && await subscribe(server, SVC.hr, CHR.hr, parseHR)) got.push("hr");
  return got;
}
async function attachHr(dev) {
  const server = await dev.gatt.connect();
  return (await subscribe(server, SVC.hr, CHR.hr, parseHR)) ? ["hr"] : [];
}

async function pickDevice(options) {
  try { return await navigator.bluetooth.requestDevice(options); }
  catch (e) {
    if (e.name !== "NotFoundError") btMsg("Bluetooth couldn't start. Check that Bluetooth is on and Chrome is allowed to use it.");
    return null;                                          // NotFoundError means the picker was closed
  }
}

function describeBike() {
  if (!BT.bike) return;
  const name = BT.bike.name || "your bike";
  const got = [live.hasPower && "power", live.hasCad && "cadence", fresh(live.hrT) && "heart rate", !live.hasPower && live.hasSpeed && "speed"].filter(Boolean);
  if (live.hasPower) btMsg(`Connected to ${name}. Receiving ${joinList(got)}. Speed now comes from your watts.`);
  else if (live.hasSpeed) btMsg(`Connected to ${name}. Receiving ${joinList(got)}.`);
  else btMsg(got.length ? `Connected, receiving ${joinList(got)}, but no power or speed. Keep using + and −.` : "Connected, but no data yet. Start pedaling. If nothing appears, use + and −.");
  update();
}

async function connectBike() {
  if (BT.bike) { BT.bikeUserOff = true; try { BT.bike.gatt.disconnect(); } catch (e) {} bikeGone("Bike disconnected."); return; }
  const dev = await pickDevice({ acceptAllDevices: true, optionalServices: [SVC.ftms, SVC.cp, SVC.csc, SVC.hr] });
  if (!dev) return;
  btMsg("Connecting…"); $("btBike").disabled = true;
  try {
    const got = await attachBike(dev);
    if (!got.length) { try { dev.gatt.disconnect(); } catch (e) {} btMsg("That device isn't sharing fitness data. Make sure you picked the bike, then try again."); return; }
    BT.bike = dev; BT.bikeUserOff = false; R.v = 0;
    if (!dev._tahWatch) { dev.addEventListener("gattserverdisconnected", () => bikeLost(dev)); dev._tahWatch = true; }
    $("btBike").textContent = "Disconnect bike";
    btMsg(`Connected to ${dev.name || "your bike"}. Start pedaling…`);
    setTimeout(describeBike, 3000);
    update();
  } catch (e) {
    try { dev.gatt.disconnect(); } catch (x) {}
    btMsg("Couldn't connect. Make sure the bike is on and not connected to another app, then try again.");
  } finally { $("btBike").disabled = false; }
}

// Unexpected drop: try to reconnect a few times before falling back to manual speed.
async function bikeLost(dev) {
  if (BT.bike !== dev || BT.bikeUserOff) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    btMsg(`Lost the bike connection. Reconnecting (try ${attempt} of 3)…`);
    await sleep(1500 * attempt);
    if (BT.bike !== dev || BT.bikeUserOff) return;
    try { if ((await attachBike(dev)).length) { btMsg(`Reconnected to ${dev.name || "your bike"}.`); return; } } catch (e) {}
  }
  bikeGone("Couldn't reconnect to the bike. Speed is back on the + and − buttons. Tap Connect bike to try again.");
}
function bikeGone(msg) {
  BT.bike = null; resetBikeData(); R.v = 0;
  $("btBike").textContent = "Connect bike"; btMsg(msg); update();
}

async function connectHr() {
  if (BT.hr) { BT.hrUserOff = true; try { BT.hr.gatt.disconnect(); } catch (e) {} hrGone("Heart rate monitor disconnected."); return; }
  const dev = await pickDevice({ filters: [{ services: [SVC.hr] }] });
  if (!dev) return;
  btMsg("Connecting heart rate…"); $("btHr").disabled = true;
  try {
    if (!(await attachHr(dev)).length) throw new Error("no-hr");
    BT.hr = dev; BT.hrUserOff = false;
    if (!dev._tahWatch) { dev.addEventListener("gattserverdisconnected", () => hrLost(dev)); dev._tahWatch = true; }
    $("btHr").textContent = "Disconnect heart rate";
    btMsg(`Heart rate from ${dev.name || "your monitor"}.`);
  } catch (e) {
    try { dev.gatt.disconnect(); } catch (x) {}
    btMsg("Couldn't connect to the heart rate monitor. Make sure it's on and not connected to another app.");
  } finally { $("btHr").disabled = false; }
}
async function hrLost(dev) {
  if (BT.hr !== dev || BT.hrUserOff) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(1500 * attempt);
    if (BT.hr !== dev || BT.hrUserOff) return;
    try { if ((await attachHr(dev)).length) return; } catch (e) {}
  }
  hrGone("Lost the heart rate monitor. Tap Connect heart rate to try again.");
}
function hrGone(msg) { BT.hr = null; live.hrT = 0; $("btHr").textContent = "Connect heart rate"; btMsg(msg); update(); }

if (navigator.bluetooth) {
  $("btRow").hidden = false;
  $("btBike").addEventListener("click", connectBike);
  $("btHr").addEventListener("click", connectHr);
} else {
  btMsg("Bluetooth isn't available in this browser. Use Chrome on Android to connect the bike.");
}

/* ========== App shell: install, offline, updates ========== */
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("install").hidden = false; });
$("install").addEventListener("click", async () => {
  if (!installEvt) return;
  installEvt.prompt(); await installEvt.userChoice.catch(() => {});
  installEvt = null; $("install").hidden = true;
});
window.addEventListener("appinstalled", () => { $("install").hidden = true; });

if ("serviceWorker" in navigator) {
  const hadWorker = !!navigator.serviceWorker.controller;   // first visit: nothing to update from
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then(reg => {
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (nw) nw.addEventListener("statechange", () => { if (nw.state === "activated" && hadWorker) $("updBanner").hidden = false; });
      });
    }).catch(() => {});
  });
}
$("updBtn").addEventListener("click", () => { if (R.running) stop(); saveProgress(); location.reload(); });

if (location.hash === "#ride") history.replaceState(null, "", location.pathname);
loadLibrary();
})();
