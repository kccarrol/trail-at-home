/* Trail at Home: ride GPX routes on an indoor bike.
   Sections: helpers, settings, storage, GPX reading, library, ride, bluetooth, app shell.
   Route maths, the speed model and the ride clock live in routePrep.js, speedModel.js and
   rideSession.js, which load first and add themselves to window.TAH. */
(function () {
"use strict";

/* ========== Helpers ========== */
const $ = id => document.getElementById(id);
const TAH = window.TAH;

// Must match <meta name="app-version"> in index.html (and is bumped with sw.js's cache version).
const APP_VERSION = "15";
{
  const page = document.querySelector('meta[name="app-version"]');
  if (!page || page.content !== APP_VERSION) throw new Error(`index.html and app.js are from different versions (${page ? page.content : "older"} and ${APP_VERSION}). Upload both from the same zip.`);
  // Each helper file must have loaded; name the first one that didn't.
  const need = { "climbs.js": "detectClimbs", "profileCanvas.js": "drawProfile", "routePrep.js": "prepareRoute", "speedModel.js": "makeSettings",
    "rideSession.js": "createRideSession", "tcx.js": "buildTcx", "rideStore.js": "createRideStore", "strava.js": "createStrava" };
  for (const f in need) if (!TAH || typeof TAH[need[f]] !== "function") throw new Error(`The file ${f} is missing or out of date. Upload it with the other app files.`);
}
const STEP = TAH.GRID_STEP_M;            // routes are resampled every 10 m
const MI = 1609.344, FT = 0.3048, KG_PER_LB = 0.45359237;
const MAX_ROUTES = 100, MAX_FILE_BYTES = 30e6, KEEP_RIDE_LOGS = 50;
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
  o.weight = n(o.weight, 72, 30, 250);     // kg, rider only (the model adds 13 kg of bike)
  o.difficulty = n(o.difficulty, 100, 0, 100);   // % of each hill's steepness felt in speed and resistance
  o.ahead = [1, 2, 5].includes(+o.ahead) ? +o.ahead : 2;   // km shown in the look-ahead profile
  o.stravaClientId = typeof o.stravaClientId === "string" ? o.stravaClientId.trim().slice(0, 20) : "";
  o.stravaHelper = typeof o.stravaHelper === "string" ? o.stravaHelper.trim().slice(0, 300) : "";
  o.tcxPositions = o.tcxPositions !== false;              // include map positions in exported rides
  return o;
}
const S = sanitize(Object.assign({}, lsGet("tah-settings") || {}));
const saveSettings = () => lsSet("tah-settings", S);
const modelSettings = () => TAH.makeSettings({ riderKg: S.weight, difficultyPct: S.difficulty });

/* ========== Formatting ========== */
const isMi = () => S.units === "mi";
const dUnit = () => isMi() ? MI : 1000;
const fmtD = m => (m / dUnit()).toFixed(2);
const fmtDShort = m => { const v = m / dUnit(); return (v < 10 ? v.toFixed(1) : Math.round(v)) + (isMi() ? " mi" : " km"); };
const fmtE = m => Math.round(isMi() ? m / FT : m).toLocaleString();
const eUnit = () => isMi() ? "ft" : "m";
const spdOut = kmh => (isMi() ? kmh / 1.609344 : kmh).toFixed(1);
const sUnit = () => isMi() ? "mph" : "km/h";
// Short distances for the climb callout: "350 m" / "1.2 km", or "1,150 ft" / "0.4 mi".
const fmtNear = m => isMi()
  ? (m < 0.19 * MI ? `${(Math.max(50, Math.round(m / FT / 50) * 50)).toLocaleString()} ft` : `${(m / MI).toFixed(1)} mi`)
  : (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);
const fmtT = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };

/* ========== Storage (IndexedDB) ==========
   "meta" holds small route summaries for the list; "profiles" holds each route's 10 m grid
   (positions and elevation) plus the prepared grade data; "rides" and "rideSamples" hold the
   once-a-second ride logs, saved in 30-second chunks (see rideStore.js); "kv" holds small values
   such as the Strava connection. */
let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = new Promise((res, rej) => {
    if (!("indexedDB" in self)) return rej(new Error("no-idb"));
    const r = indexedDB.open("trail-at-home", 3);
    r.onupgradeneeded = () => {
      const d = r.result, has = n => d.objectStoreNames.contains(n);
      if (!has("meta")) d.createObjectStore("meta", { keyPath: "id" });
      if (!has("profiles")) d.createObjectStore("profiles", { keyPath: "id" });
      if (!has("rides")) d.createObjectStore("rides", { keyPath: "id" });
      if (!has("rideSamples")) d.createObjectStore("rideSamples", { keyPath: ["rideId", "seq"] });
      if (!has("kv")) d.createObjectStore("kv");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("blocked"));
  });
  return dbPromise;
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
async function allMeta() { const d = await db(); return reqP(d.transaction("meta").objectStore("meta").getAll()); }
async function getProfile(id) { const d = await db(); return reqP(d.transaction("profiles").objectStore("profiles").get(id)); }
async function putMeta(m) { const d = await db(); const t = d.transaction("meta", "readwrite"); t.objectStore("meta").put(m); return txDone(t); }
async function putProfile(p) { const d = await db(); const t = d.transaction("profiles", "readwrite"); t.objectStore("profiles").put(p); return txDone(t); }
async function saveRoute(m, prof) {
  const d = await db(), t = d.transaction(["meta", "profiles"], "readwrite");
  t.objectStore("meta").put(m); t.objectStore("profiles").put(prof); return txDone(t);
}
async function deleteRoute(id) {
  const d = await db(), t = d.transaction(["meta", "profiles"], "readwrite");
  t.objectStore("meta").delete(id); t.objectStore("profiles").delete(id); return txDone(t);
}

// A stored profile record. Routes saved by earlier versions hold only { id, e }.
function profileRecord(id, prep) {
  return { id, e: prep.rawEleM, lat: prep.lat, lon: prep.lon, hasEle: prep.hasElevation, prep };
}
// The prepared route for a stored profile, re-prepared (and re-saved) if the maths has changed since.
function preparedFrom(p) {
  if (p.prep && p.prep.prepVersion === TAH.PREP_VERSION) return p.prep;
  const prep = TAH.prepareFromGrid({ e: p.e, lat: p.lat, lon: p.lon, hasElevation: p.hasEle !== false });
  putProfile(Object.assign(p, { prep })).catch(() => {});
  return prep;
}

/* --- Ride history (rideStore.js) and small key-value settings --- */
const rides = TAH.createRideStore(db);
TAH.rides = rides;                                     // { list, get, samples, remove, ... }
const kv = {
  async get(k) { const d = await db(); return reqP(d.transaction("kv").objectStore("kv").get(k)); },
  async set(k, v) { const d = await db(), t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); return txDone(t); },
  async del(k) { const d = await db(), t = d.transaction("kv", "readwrite"); t.objectStore("kv").delete(k); return txDone(t); }
};
const newId = () => (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
const storageMsg = e => e && e.name === "QuotaExceededError"
  ? "Your phone is out of space for routes. Delete some routes or free up storage."
  : "Something went wrong saving to your phone. Please try again.";

/* ========== GPX reading ========== */
const RouteError = TAH.RouteError;
function cls(g) { if (g <= -2) return "descent"; if (g < 3) return "easy"; if (g < 6) return "moderate"; if (g < 10) return "hard"; return "extreme"; }
// Suggested knob setting. Difficulty scales the hill part, so an easier day suggests less resistance too.
function resFor(g) { const d = g * S.difficulty / 100, r = d >= 0 ? S.flat + d * S.step : S.flat + d * S.step * 0.5; return clamp(Math.round(r), 1, S.max); }

// Reads a GPX file into its name and raw points; routePrep.js does the rest.
function parseGPX(text, fallbackName) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new RouteError("couldn't be read as a GPX file.");
  let pts = doc.getElementsByTagName("trkpt");
  if (!pts.length) pts = doc.getElementsByTagName("rtept");
  if (pts.length < 2) throw new RouteError("has no route points.");
  const lat = [], lon = [], ele = [];
  for (const p of pts) {
    const el = p.getElementsByTagName("ele")[0];
    lat.push(parseFloat(p.getAttribute("lat"))); lon.push(parseFloat(p.getAttribute("lon")));
    ele.push(el ? parseFloat(el.textContent) : NaN);
  }
  const nameEl = doc.querySelector("metadata > name, trk > name, rte > name");
  return { name: ((nameEl && nameEl.textContent.trim()) || fallbackName).slice(0, 120), points: { lat, lon, ele } };
}

function sampleGrid() {
  const n = 12000 / STEP + 1, e = new Float32Array(n);
  for (let i = 0; i < n; i++) { const d = i * STEP; e[i] = 300 + 60 * Math.sin(d / 1800) + 45 * Math.sin(d / 700 + 1) + 25 * Math.exp(-(((d - 8000) / 250) ** 2)); }
  return e;
}

/* ========== Routes: the library, and the Browse routes page ========== */
let metas = [], previewFixRunning = false;
const setStatus = t => { $("status").textContent = t; };
const setError = t => { $("err").textContent = t; };

function routeSummary(prep) {
  return { total: prep.totalDistM, gain: prep.totalAscentM, preview: TAH.makePreview(prep), hasTrack: prep.hasTrack, hasEle: prep.hasElevation };
}
async function saveNewRoute(name, prep) {
  const m = Object.assign({ id: newId(), name, added: Date.now(), lastRidden: 0, pos: 0, stats: null }, routeSummary(prep));
  await saveRoute(m, profileRecord(m.id, prep));
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  return m;
}
// Re-adding a GPX for a route saved before positions were stored: update it, keep its progress.
async function upgradeRoute(m, prep) {
  Object.assign(m, routeSummary(prep));
  m.pos = clamp(m.pos || 0, 0, m.total);
  await saveRoute(m, profileRecord(m.id, prep));
}

async function loadLibrary() {
  try { metas = await allMeta(); }
  catch (e) { metas = []; setError(e.message === "no-idb" ? "This browser can't save routes. Open the app in Chrome." : "Your saved routes couldn't be opened. Try closing and reopening the app."); }
  fixMissingPreviews();
  refreshPage();
}

// The route list's elevation outline, coloured by grade like the ride screen. It's SVG rather than
// canvas so 100 of them stay cheap and follow the light/dark theme through CSS on their own.
function previewSvg(pv) {
  if (!pv || pv.e.length < 2) return "";
  const r = TAH.previewRoute(pv), W = 200, H = 36, p = TAH.columns(r, 0, r.totalDistM, pv.e.length);
  const lo = Math.min(...pv.e), yr = { min: lo - 2, max: Math.max(Math.max(...pv.e), lo + 40) };   // flat routes sit low
  const X = x => (x / pv.e.length * W).toFixed(1), Y = e => (3 + (1 - (e - yr.min) / (yr.max - yr.min)) * (H - 5)).toFixed(1);
  let h = "", k = 0;
  while (k < p.g.length) {
    const band = TAH.gradeBand(p.g[k]), start = k;
    while (k < p.g.length && TAH.gradeBand(p.g[k]) === band) k++;
    let pts = `${X(p.x[start])},${H}`;
    for (let i = start; i <= k; i++) pts += ` ${X(p.x[i])},${Y(p.e[i])}`;
    h += `<polygon class="g-${band}" points="${pts} ${X(p.x[k])},${H}"/>`;
  }
  h += `<polyline class="pv-line" points="${p.x.map((x, i) => `${X(x)},${Y(p.e[i])}`).join(" ")}"/>`;
  return `<svg class="pv" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${h}</svg>`;
}

// One route card. "manage" (Browse routes) has action buttons; "pick" (Start a ride) is tap-to-choose.
// A route is finished when ridden to the end, or when the rider tapped Finish route part-way (m.done).
// Only a route that is part-way and not finished counts as in progress (Home's Continue card).
const reachedEnd = m => m.pos >= m.total - 5;
const isDone = m => !!m.done || reachedEnd(m);
const isGoing = m => !isDone(m) && m.pos > 50;
function routeCard(m, mode) {
  // The bar shows how far along an unfinished route is; a finished one says so instead.
  const pct = isGoing(m) ? Math.min(100, m.pos / m.total * 100) : 0;
  const where = reachedEnd(m) ? "Finished." : m.done ? `Finished at ${fmtDShort(m.pos)}.` : m.pos > 50 ? `Stopped at ${fmtDShort(m.pos)}.` : "";
  const [dn, du] = fmtDShort(m.total).split(" ");
  const climb = m.hasEle === false ? `<span>flat (no elevation in the GPX)</span>` : `<span><em>${fmtE(m.gain)}</em>${eUnit()} climbing</span>`;
  const id = esc(m.id);
  const acts = mode !== "manage" ? "" : `<div class="acts">
        <button data-act="ride" data-id="${id}">Ride</button><button data-act="rename" data-id="${id}">Rename</button>
        ${isGoing(m) ? `<button data-act="finish" data-id="${id}">Mark finished</button>` : ""}${m.pos > 50 ? `<button data-act="reset" data-id="${id}">Start over</button>` : ""}<button data-act="delete" data-id="${id}">Delete</button></div>`;
  return `<li class="route">
      <button class="open" data-id="${id}" ${mode === "static" ? "disabled" : ""}>
        <b>${esc(m.name)}</b>${previewSvg(m.preview)}
        <span class="stats2"><span><em>${esc(dn)}</em>${esc(du || "")}</span>${climb}</span>
        ${where ? `<span class="sub${isDone(m) ? " done" : ""}">${where}</span>` : ""}
        ${pct > 0 ? `<span class="prog"><i style="width:${pct.toFixed(1)}%"></i></span>` : ""}
      </button>${acts}
    </li>`;
}
const recency = m => Math.max(m.lastRidden || 0, m.added || 0);
const routeState = m => isDone(m) ? "done" : m.pos > 50 ? "going" : "new";
// Length bands in the rider's units: under 6 mi / 6–20 mi / over 20 mi, or 10 / 30 km.
const lengthBands = () => isMi() ? [6 * MI, 20 * MI, "under 6 mi", "6–20 mi", "over 20 mi"] : [10000, 30000, "under 10 km", "10–30 km", "over 30 km"];
function fillLengthFilter() {
  const [, , a, b, c] = lengthBands(), sel = $("rLength"), v = sel.value;
  sel.innerHTML = `<option value="">Any length</option><option value="s">Short (${a})</option><option value="m">Medium (${b})</option><option value="l">Long (${c})</option>`;
  sel.value = v;
}
function filteredRoutes() {
  const q = $("rSearch").value.trim().toLowerCase(), prog = $("rProgress").value, len = $("rLength").value, [lo, hi] = lengthBands();
  const list = metas.filter(m => (!q || m.name.toLowerCase().includes(q)) && (!prog || routeState(m) === prog) &&
    (!len || (len === "s" ? m.total < lo : len === "m" ? m.total >= lo && m.total <= hi : m.total > hi)));
  const by = { recent: (a, b) => recency(b) - recency(a), name: (a, b) => a.name.localeCompare(b.name),
    short: (a, b) => a.total - b.total, long: (a, b) => b.total - a.total, climb: (a, b) => (b.gain || 0) - (a.gain || 0) }[$("rSort").value];
  return list.sort(by);
}
function drawLibrary() {
  const empty = !metas.length;
  $("sample").hidden = !empty; $("routeFilters").hidden = empty;
  fillLengthFilter();
  // Routes added before this version have elevation but no map positions (hasTrack undefined).
  const old = metas.filter(m => m.hasTrack === undefined).length;
  $("legacy").hidden = !old;
  $("legacyText").textContent = old === 1
    ? "1 route was added before the app saved map positions. Add its GPX file again to update it; your progress is kept."
    : `${old} routes were added before the app saved map positions. Add their GPX files again to update them; your progress is kept.`;
  const list = filteredRoutes();
  $("count").textContent = empty ? "No routes yet. Add GPX files of your Strava routes to get started."
    : list.length === metas.length ? `${metas.length} of ${MAX_ROUTES} routes saved` : `Showing ${list.length} of ${metas.length} routes`;
  $("routes").innerHTML = list.map(m => routeCard(m, "manage")).join("");
  if (page === "start") drawPick();
}
["rSearch", "rProgress", "rLength", "rSort"].forEach(id => $(id).addEventListener(id === "rSearch" ? "input" : "change", drawLibrary));

// Routes saved by an earlier version have no coloured outline yet; add one in the background.
async function fixMissingPreviews() {
  const missing = metas.filter(m => !m.preview);
  if (!missing.length || previewFixRunning) return;
  previewFixRunning = true;
  for (const m of missing) {
    try { const p = await getProfile(m.id); if (p) { m.preview = TAH.makePreview(preparedFrom(p)); delete m.spark; await putMeta(m); } } catch (e) {}
  }
  previewFixRunning = false;
  if (page === "routes" || page === "start") drawLibrary();
}

async function importFiles(files) {
  if (!files.length) return;
  setError(""); setStatus(files.length === 1 ? "Adding route…" : `Adding ${files.length} routes…`);
  const problems = [], flat = []; let added = 0, dupes = 0, updated = 0;
  for (const f of files) {
    if (metas.length >= MAX_ROUTES) { problems.push(`You've reached ${MAX_ROUTES} routes. Delete some to add more.`); break; }
    if (f.size > MAX_FILE_BYTES) { problems.push(`${f.name} is too large to be a route file.`); continue; }
    try {
      const r = parseGPX(await f.text(), f.name.replace(/\.gpx$/i, ""));
      const prep = TAH.prepareRoute(r.points);
      const same = metas.find(m => m.name === r.name && Math.abs(m.total - prep.totalDistM) < 25);
      if (same) {
        if (!same.hasTrack && prep.hasTrack && same.hasEle !== false) { await upgradeRoute(same, prep); updated++; }
        else dupes++;
        continue;
      }
      metas.push(await saveNewRoute(r.name, prep)); added++;
      if (!prep.hasElevation) flat.push(r.name);
    } catch (err) {
      problems.push(err instanceof RouteError ? `${f.name} ${err.message}` : `${f.name} couldn't be saved. ${storageMsg(err)}`);
    }
  }
  const bits = [];
  if (added) bits.push(added === 1 ? "Added 1 route." : `Added ${added} routes.`);
  if (updated) bits.push(updated === 1 ? "Updated 1 route with map positions." : `Updated ${updated} routes with map positions.`);
  if (dupes) bits.push(dupes === 1 ? "1 route was already saved." : `${dupes} routes were already saved.`);
  if (flat.length) bits.push(`${joinList(flat.map(n => `"${n}"`))} ${flat.length === 1 ? "has" : "have"} no elevation data, so ${flat.length === 1 ? "it rides" : "they ride"} flat.`);
  setStatus(bits.join(" ")); setError(problems.join(" "));
  if (added || updated) { $("rSearch").value = ""; $("rProgress").value = ""; $("rLength").value = ""; $("rSort").value = "recent"; }
  drawLibrary();
}

$("file").addEventListener("change", ev => { const files = [...ev.target.files]; ev.target.value = ""; importFiles(files); });
$("sample").addEventListener("click", async () => {
  try { metas.push(await saveNewRoute("Sample: Ridge loop", TAH.prepareFromGrid({ e: sampleGrid() }))); drawLibrary(); } catch (e) { setError(storageMsg(e)); }
});
$("routes").addEventListener("click", async ev => {
  const b = ev.target.closest("button"); if (!b) return;
  const m = metas.find(x => x.id === b.dataset.id); if (!m) return;
  try {
    if (b.dataset.act === "rename") {
      const name = prompt("Route name", m.name);
      if (name && name.trim()) { m.name = name.trim().slice(0, 120); await putMeta(m); drawLibrary(); }
    } else if (b.dataset.act === "reset") {
      if (confirm(`Start "${m.name}" over from the beginning? Past rides stay in your history.`)) { m.pos = 0; m.stats = null; m.done = false; await putMeta(m); drawLibrary(); }
    } else if (b.dataset.act === "finish") {
      m.done = true; await putMeta(m); drawLibrary();
      setStatus(`"${m.name}" is marked finished, so Home won't offer to continue it. Ride it again any time.`);
    } else if (b.dataset.act === "delete") {
      if (confirm(`Delete "${m.name}"? This can't be undone.`)) { await deleteRoute(m.id); metas = metas.filter(x => x !== m); setStatus(""); drawLibrary(); }
    } else pickForRide(m);                               // "Ride" or a tap on the card: straight to connecting the bike
  } catch (e) { setError(storageMsg(e)); }
});

/* ========== Ride screen ==========
   The session (rideSession.js) owns position, speed, the clock and the ride log; this part
   shows its state and handles the buttons. */
const R = {
  meta: null, route: null, session: null, log: null, wake: null, lastSave: 0,
  resShown: null, clsShown: null, resumeAfterSheet: false
};

// Loads a route into the ride page. The caller shows the page (see beginRide).
async function openRide(m) {
  if (R.session) closeRide();                          // never two ride clocks at once
  const p = await getProfile(m.id);
  if (!p) { setError("That route's data is missing. Try adding it again."); return false; }
  R.meta = m; R.route = preparedFrom(p); R.log = null; R.resShown = null; R.clsShown = null;
  P.dismissed.clear(); P.yr = null; U.lastRideId = null;
  R.session = TAH.createRideSession({
    route: R.route, startDistM: m.pos || 0, stats: m.stats,
    getInputs: rideInputs, getModelSettings: modelSettings,
    onState: update, onFinish: finished, onAutoPause: showAutoPause, onFlush: saveSamples
  });
  TAH.currentRide = R.session;
  shown.clear();
  $("title").textContent = m.name;
  $("summary").hidden = true; closeEndSheet();
  $("noEle").hidden = R.route.hasElevation;
  return true;
}

// Leaving the ride page: pause, save the ride to history and the spot on the route.
function closeRide() {
  if (R.session && R.session.state.running) stop();
  endLog(); saveProgress();
  R.meta = null; R.route = null; R.session = null; TAH.currentRide = null;
  releaseScreen(); setStatus("");
  logSave.then(() => { if (page === "history") drawHistory(); if (page === "home") drawHome(); });
}
$("back").addEventListener("click", () => {
  if (R.session && R.session.state.running && !confirm("Leave the ride? It will be paused and saved to your history, and you can continue the route later.")) return;
  goHome();
});
$("rideSettings").addEventListener("click", () => go("settings"));

function saveProgress() {
  if (!R.meta || !R.session) return;
  R.meta.pos = R.session.state.distM; R.meta.stats = Object.assign({}, R.session.stats); R.meta.lastRidden = Date.now();
  putMeta(R.meta).catch(() => {});
}

/* --- Ride log: begins at Start, continues through pauses, ends at the finish or on leaving --- */
function beginLog() {
  if (R.log) return;
  const st = R.session.state;
  R.log = { id: newId(), routeId: R.meta.id, routeName: R.meta.name, startedAt: Date.now(), endedAt: null,
    startDistM: st.distM, endDistM: st.distM, finished: false, hasTrack: R.route.hasTrack, sampleCount: 0, chunks: 0 };
  rides.prune(KEEP_RIDE_LOGS).catch(() => {});
}
let logSave = Promise.resolve();
function saveSamples(samples) {
  if (!R.log || !samples.length) return;
  const log = R.log;
  log.endDistM = samples[samples.length - 1].distM;
  logSave = logSave.then(() => rides.saveChunk(log, samples)).catch(() => {
    btMsg("Couldn't save the ride log. Your phone may be low on storage.");
  });
}
function endLog() {
  if (!R.log || !R.session) return;
  R.session.newLog();                                  // flushes the last samples
  const log = R.log; R.log = null;
  log.endedAt = Date.now(); log.finished = R.session.state.finished;
  logSave = logSave.then(() => log.sampleCount ? rides.finish(log) : undefined).catch(() => {});
  return log;
}

/* --- Elevation profile: a look-ahead window over a whole-route strip (profileCanvas.js draws) --- */
const P = {
  ahead: { c: $("ahead"), w: 0, h: 0 }, strip: { c: $("strip"), w: 0, h: 0 }, off: document.createElement("canvas"),
  theme: null, yr: null, easing: false, lastT: 0, raf: 0, dismissed: new Set()
};
const THEME_VARS = { descent: "--g-descent", easy: "--g-easy", moderate: "--g-moderate", hard: "--g-hard", steep: "--g-steep",
  line: "--ink", text: "--muted", marker: "--marker", bg: "--paper", done: "--done" };
function readTheme() {
  const cs = getComputedStyle(document.documentElement), t = {};
  for (const k in THEME_VARS) t[k] = cs.getPropertyValue(THEME_VARS[k]).trim();
  return t;
}
// Match the canvas's backing store to its size on screen, times the pixel ratio, so lines stay sharp.
function fitCanvas(v) {
  const r = v.c.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
  v.w = r.width; v.h = r.height;
  v.c.width = Math.max(1, Math.round(r.width * dpr)); v.c.height = Math.max(1, Math.round(r.height * dpr));
  v.ctx = v.c.getContext("2d"); v.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return dpr;
}
// Size both canvases and pre-draw the static whole-route strip. Runs on open, resize, rotation and theme change.
function layoutProfiles() {
  if (!R.route || page !== "ride") return;
  P.theme = readTheme();
  fitCanvas(P.ahead);
  const dpr = fitCanvas(P.strip);
  P.off.width = P.strip.c.width; P.off.height = P.strip.c.height;
  const octx = P.off.getContext("2d"); octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  TAH.drawProfile(octx, R.route, { fromM: 0, toM: R.route.totalDistM, width: P.strip.w, height: P.strip.h, theme: P.theme, lineWidth: 1.5 });
  P.yr = null; kickProfile();
}
function aheadWindow(d) {
  const total = R.route.totalDistM, L = Math.min(S.ahead * 1000, total);
  const from = clamp(d - 0.15 * L, 0, total - L);                // rider sits 15% in; clamps at the start and the end
  return { from, to: from + L };
}
function drawProfiles(t) {
  const r = R.route, d = R.session.state.distM, th = P.theme;
  if (!P.strip.w || !P.ahead.w) return;
  // Whole route: copy the static drawing, then shade what's done and place the marker.
  const s = P.strip;
  s.ctx.clearRect(0, 0, s.w, s.h); s.ctx.drawImage(P.off, 0, 0, s.w, s.h);
  TAH.drawProgress(s.ctx, r, { fromM: 0, toM: r.totalDistM, currentM: d, done: true, width: s.w, height: s.h, theme: th });
  // Look-ahead: the height range eases toward what's in view over about a second, so it doesn't jump.
  const win = aheadWindow(d), target = TAH.spanAtLeast(TAH.rangeOf(r, win.from, win.to), 30);
  const dt = P.lastT ? Math.min(0.5, (t - P.lastT) / 1000) : 0; P.lastT = t;
  if (!P.yr) P.yr = target;
  else { const k = 1 - Math.exp(-dt / 0.33); P.yr = { min: P.yr.min + (target.min - P.yr.min) * k, max: P.yr.max + (target.max - P.yr.max) * k }; }
  P.easing = Math.abs(P.yr.min - target.min) + Math.abs(P.yr.max - target.max) > 0.05;
  const a = P.ahead;
  TAH.drawProfile(a.ctx, r, { fromM: win.from, toM: win.to, currentM: d, done: true, dot: true, width: a.w, height: a.h,
    theme: th, yRange: P.yr, padTop: 34, axis: m => `${fmtE(m)} ${eUnit()}` });
}
// One animation loop: while riding it advances the ride every frame (so the marker moves smoothly)
// and redraws; when paused it draws once, or until the height range settles.
function profileFrame(t) {
  P.raf = 0;
  if (!R.session || page !== "ride") return;
  if (R.session.state.running) { P.raf = requestAnimationFrame(profileFrame); R.session.tick(); }
  drawProfiles(t);
  if (!P.raf && P.easing) P.raf = requestAnimationFrame(profileFrame);
}
function kickProfile() { if (!P.raf) { P.lastT = 0; P.raf = requestAnimationFrame(profileFrame); } }

let resizePending = 0;
if ("ResizeObserver" in window) new ResizeObserver(() => { cancelAnimationFrame(resizePending); resizePending = requestAnimationFrame(layoutProfiles); }).observe($("profiles"));
window.addEventListener("orientationchange", () => setTimeout(layoutProfiles, 250));
if (window.matchMedia) {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(() => layoutProfiles());
}

// "Climb in 350 m · 1.2 km · avg 6%" within 1 km of a climb, "On climb · 400 m left · avg 7%" on it.
function updateCallout(d) {
  const ca = TAH.climbAt(R.route.climbs || [], d), el = $("callout");
  const show = ca && !P.dismissed.has(ca.climb.startM) && (ca.on || ca.toStartM <= 1000);
  el.hidden = !show;
  if (!show) return;
  // Each part keeps its words together (no-break spaces), so a narrow screen wraps only between parts.
  const nb = t => t.replace(/ /g, "\u00a0"), avg = nb(`avg ${Math.round(ca.climb.avgGrade)}%`);
  setText("callout", ca.on ? `${nb("On climb")} · ${nb(fmtNear(ca.leftM) + " left")} · ${avg}`
    : `${nb("Climb in " + fmtNear(ca.toStartM))} · ${nb(fmtNear(ca.climb.lengthM))} · ${avg}`);
  el.dataset.climb = ca.climb.startM;
}
$("callout").addEventListener("click", e => { P.dismissed.add(+e.currentTarget.dataset.climb); e.currentTarget.hidden = true; });

/* --- Inputs for the session --- */
function speedMode() { if (BT.bike && live.hasPower) return "power"; if (BT.bike && live.hasSpeed) return "bike"; return "manual"; }
function rideInputs() {
  const md = speedMode();
  return {
    mode: md,
    powerW: md === "power" && fresh(live.powT) ? Math.max(0, live.power) : 0,    // stale or reconnecting: 0 W
    speedMps: md === "bike" ? (fresh(live.spdT) ? live.spd / 3.6 : 0) : md === "manual" ? S.speed / 3.6 : 0,
    cadenceRpm: live.hasCad && BT.bike ? (fresh(live.cadT) ? live.cad : 0) : null,
    hrBpm: fresh(live.hrT) ? live.hr : null
  };
}

/* --- What the screen shows --- */
function update() {
  const r = R.route, ses = R.session; if (!r || !ses) return;
  const st = ses.state, g = st.grade, c = cls(g), md = speedMode();

  // Where the ride stands: Ready, Riding, Auto-paused, Paused (a ride in progress), Finished.
  const inRide = !!R.log, done = st.finished || R.meta.done;
  const state = done && !st.running ? "finished" : st.running ? (st.autoPaused ? "auto" : "riding") : inRide ? "paused" : "ready";
  const words = { ready: st.distM > 50 ? `Ready to continue from ${fmtDShort(st.distM)}` : "Ready",
    riding: "Riding", auto: "Auto-paused: start pedaling to carry on", paused: "Paused",
    finished: st.finished ? "Route finished" : `Route finished at ${fmtDShort(st.distM)}` }[state];
  if (shown.get("rstate") !== words) {
    shown.set("rstate", words); $("rideState").dataset.state = state; $("rideState").textContent = words;
    $("scr-ride").classList.toggle("ride-paused", state === "paused" || state === "auto");
    $("scr-ride").classList.toggle("in-ride", inRide);
    $("pauseTag").textContent = state === "auto" ? "Auto-paused: pedal to carry on" : "Paused";
  }
  setText("go", st.running ? "Pause" : inRide ? "Resume" : done ? "Ride again" : st.distM > 50 ? "Continue route" : "Start");
  $("endRide").hidden = !inRide;
  if (!inRide && !$("endSheet").hidden) closeEndSheet();

  if (c !== R.clsShown) { R.clsShown = c; $("sign").dataset.cls = c; $("sym").innerHTML = SYM[c]; setText("diff", NAMES[c]); }
  const gv = Math.abs(g) < 0.05 ? 0 : g;
  setText("grade", (gv < 0 ? "−" : "") + Math.abs(gv).toFixed(1));

  // Resistance only changes when the target moves by a noticeable amount, so the number
  // doesn't flicker; each change flashes with an arrow while riding.
  const target = resFor(g), band = Math.max(1, Math.round(S.max / 50));
  if (R.resShown === null || Math.abs(target - R.resShown) >= band || target === 1 || target === S.max) {
    if (R.resShown !== null && target !== R.resShown && st.running) flashRes(target > R.resShown);
    R.resShown = target;
  }
  setText("res", R.resShown);

  setText("spd", spdOut(md === "manual" ? S.speed : st.speedMps * 3.6));
  setText("spdL", sUnit() + ({ manual: ", match your console", power: ", from your power", bike: ", from your bike" })[md]);
  $("sUp").disabled = $("sDown").disabled = md !== "manual";
  $("syncRow").hidden = md !== "manual";

  setText("mTime", fmtT(ses.stats.secs));
  setText("mPow", live.hasPower && BT.bike ? (fresh(live.powT) ? Math.max(0, Math.round(live.power)) : 0) : "–");
  setText("mCad", live.hasCad && BT.bike ? (fresh(live.cadT) ? Math.round(live.cad) : 0) : "–");
  setText("mHr", fresh(live.hrT) ? live.hr : "–");

  setText("sDist", fmtD(st.distM)); setText("sDistL", (isMi() ? "mi" : "km") + " ridden");
  setText("sLeft", fmtD(r.totalDistM - st.distM)); setText("sLeftL", (isMi() ? "mi" : "km") + " to go");
  setText("sGain", fmtE(st.ascentM)); setText("sGainL", eUnit() + " climbed");
  setText("aGrade", (gv < 0 ? "−" : "") + Math.abs(gv).toFixed(1) + "%"); setText("aEle", `${fmtE(st.eleM)} ${eUnit()}`);
  updateCallout(st.distM);
  kickProfile();

  const now = performance.now();
  if (st.running && now - R.lastSave > 5000) { saveProgress(); R.lastSave = now; }
}

function flashRes(up) {
  const box = $("resBox");
  $("resDir").textContent = up ? "▲" : "▼";
  box.classList.remove("bump"); void box.offsetWidth; box.classList.add("bump");
}

function showAutoPause() { update(); }

// Summary of the ride just ended (from its own log, so it matches history and the Strava upload).
// how: "end" (rode to the end of the route), "finish" (tapped Finish route part-way), "save" (spot kept).
function showSummary(sum, how) {
  const avg = sum.movingS > 0 ? sum.distM / sum.movingS * 3.6 : 0;
  let t = `${fmtT(sum.movingS)} of riding over ${fmtDShort(sum.distM)}, averaging ${spdOut(avg)} ${sUnit()}`;
  if (sum.avgPowerW != null) t += ` and ${Math.round(sum.avgPowerW)} watts`;
  t += sum.ascentM > 1 ? `. You climbed ${fmtE(sum.ascentM)} ${eUnit()}.` : ".";
  if (how === "save") t += " Your spot on the route is saved, so you can continue it any time.";
  if (how === "finish") t += ` The route is marked finished at ${fmtDShort(R.session.state.distM)} of ${fmtDShort(R.route.totalDistM)}.`;
  $("sumTitle").textContent = how === "end" ? "Route finished" : how === "finish" ? "Ride finished" : "Ride saved";
  $("sumText").textContent = t;
  $("summary").hidden = false;
  drawSummaryUpload();
  if (page === "ride") window.scrollTo({ top: 0, behavior: "smooth" });
}

/* --- Riding --- */
async function lockScreen() { try { if ("wakeLock" in navigator) R.wake = await navigator.wakeLock.request("screen"); } catch (e) { R.wake = null; } }
function releaseScreen() { try { R.wake && R.wake.release(); } catch (e) {} R.wake = null; }
function start() {
  const ses = R.session;
  if (ses.state.finished || R.meta.done) { ses.jumpTo(0); ses.resetStats(); R.meta.done = false; }
  $("summary").hidden = true;
  beginLog(); ses.start();
  lockScreen(); update();
}
function stop() {
  R.session.pause();
  saveProgress(); update(); releaseScreen();
}
// Ends the ride: it goes to history with a summary. how: "end" (reached the end of the route),
// "finish" (the rider is done with the route part-way, so it no longer shows as in progress),
// or "save" (the spot is kept and the route can be continued later).
function endRide(how) {
  closeEndSheet();
  if (R.session.state.running) R.session.pause();
  if (how === "finish") R.meta.done = true;
  const sum = TAH.summarize(R.session.samples);
  const log = endLog(); U.lastRideId = log ? log.id : null;
  saveProgress(); releaseScreen();
  if (log && sum.elapsedS >= 1) showSummary(sum, how);
  update();
}
function finished() { endRide("end"); }

// Finish asks what kind of finish: done with the route, or stop for now and keep the spot.
// The ride pauses while the choice is open; Keep riding carries on if it was moving.
function openEndSheet() {
  R.resumeAfterSheet = R.session.state.running;
  if (R.resumeAfterSheet) stop();
  $("saveSpotSub").textContent = `Continue from ${fmtDShort(R.session.state.distM)} another time.`;
  setText("keepRiding", R.resumeAfterSheet ? "Keep riding" : "Cancel");
  $("rideControls").hidden = true; $("endSheet").hidden = false;
  $("finishRoute").focus();
}
function closeEndSheet() { $("endSheet").hidden = true; $("rideControls").hidden = false; }
$("endRide").addEventListener("click", openEndSheet);
$("finishRoute").addEventListener("click", () => endRide("finish"));
$("saveSpot").addEventListener("click", () => endRide("save"));
$("keepRiding").addEventListener("click", () => { closeEndSheet(); if (R.resumeAfterSheet) start(); else update(); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { if (R.session && R.session.state.running) lockScreen(); }
  else { saveProgress(); if (R.session) R.session.flush(); }
});
setInterval(() => { if (R.session && !R.session.state.running && (BT.bike || BT.hr)) update(); }, 1000);  // keep live numbers fresh while paused

$("go").addEventListener("click", () => R.session.state.running ? stop() : start());

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
  R.meta.done = false; R.session.jumpTo(v * dUnit()); $("syncIn").value = ""; saveProgress();
});
$("strip").addEventListener("click", e => {
  const b = e.currentTarget.getBoundingClientRect();
  R.meta.done = false; R.session.jumpTo(clamp((e.clientX - b.left) / b.width, 0, 1) * R.route.totalDistM); $("summary").hidden = true; saveProgress();
});


/* --- Settings panel --- */
function showSettings() {
  $("setFlat").value = S.flat; $("setStep").value = S.step; $("setMax").value = S.max; $("setUnits").value = S.units;
  $("setWeight").value = $("setWeight").dataset.shown = Math.round(isMi() ? S.weight / KG_PER_LB : S.weight);
  $("weightL").textContent = isMi() ? "Your weight (lb)" : "Your weight (kg)";
  $("setDiff").value = S.difficulty; $("diffVal").textContent = Math.round(S.difficulty) + "%";
  $("setAhead").innerHTML = [1, 2, 5].map(k => `<option value="${k}">${isMi() ? (k / 1.609344).toFixed(1) + " mi" : k + " km"}</option>`).join("");
  $("setAhead").value = S.ahead;
  $("capNote").textContent = isMi() ? "56 mph" : "90 km/h";
}
function readSettings() {
  const v = id => parseFloat($(id).value);
  S.max = v("setMax"); S.flat = v("setFlat"); S.step = v("setStep"); S.difficulty = v("setDiff"); S.ahead = v("setAhead");
  // Only take the weight if its box was edited; it shows a rounded number, so re-reading it would drift.
  const w = v("setWeight"); if (Number.isFinite(w) && $("setWeight").value !== $("setWeight").dataset.shown) S.weight = isMi() ? w * KG_PER_LB : w;
  applySettings();
}
function applySettings() {
  sanitize(S); saveSettings(); showSettings(); R.resShown = null; shown.clear(); R.clsShown = null; P.yr = null; update(); layoutProfiles();
}
showSettings();
["setFlat", "setStep", "setMax", "setWeight", "setDiff", "setAhead"].forEach(id => $(id).addEventListener("change", readSettings));
$("setDiff").addEventListener("input", () => { $("diffVal").textContent = Math.round($("setDiff").value) + "%"; });
$("setUnits").addEventListener("change", () => { S.units = $("setUnits").value; applySettings(); });

/* ========== Bluetooth ==========
   Reads whichever standard services a device offers: Fitness Machine (speed, cadence, power,
   heart rate), Cycling Power (watts, cadence), Cycling Speed and Cadence, and Heart Rate. */
const SVC = { ftms: 0x1826, cp: 0x1818, csc: 0x1816, hr: 0x180D };
const CHR = { ftms: 0x2AD2, cp: 0x2A63, csc: 0x2A5B, hr: 0x2A37 };
const live = { power: 0, powT: 0, cad: 0, cadT: 0, hr: 0, hrT: 0, spd: 0, spdT: 0, hasPower: false, hasSpeed: false, hasCad: false };
const BT = { bike: null, hr: null, bikeUserOff: false, hrUserOff: false, bikeLost: false };
let lastCrank = null;
const fresh = t => t > 0 && performance.now() - t < STALE_MS;
// The start flow and the ride page each have Connect buttons and a message line; keep them in step.
const btMsg = t => document.querySelectorAll("[data-btmsg]").forEach(e => { e.textContent = t; });
const setBtBtn = (kind, props) => document.querySelectorAll(`[data-bt="${kind}"]`).forEach(b => Object.assign(b, props));
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

// Gives up on a Bluetooth step that hangs, so a reconnect attempt can't stall forever.
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error("timeout"); })]);

// Connects to the bike and subscribes to every useful service it has.
async function attachBike(dev) {
  const server = await withTimeout(dev.gatt.connect(), 10000), got = [];
  if (await subscribe(server, SVC.ftms, CHR.ftms, parseFTMS)) got.push("ftms");
  else {
    if (await subscribe(server, SVC.cp, CHR.cp, parseCP)) { got.push("cp"); live.hasPower = true; }
    if (await subscribe(server, SVC.csc, CHR.csc, parseCSC)) got.push("csc");
  }
  if (!BT.hr && await subscribe(server, SVC.hr, CHR.hr, parseHR)) got.push("hr");
  return got;
}
async function attachHr(dev) {
  const server = await withTimeout(dev.gatt.connect(), 10000);
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
  btMsg("Connecting…"); setBtBtn("bike", { disabled: true });
  try {
    const got = await attachBike(dev);
    if (!got.length) { try { dev.gatt.disconnect(); } catch (e) {} btMsg("That device isn't sharing fitness data. Make sure you picked the bike, then try again."); return; }
    BT.bike = dev; BT.bikeUserOff = false; lostBanner(false);
    if (!dev._tahWatch) { dev.addEventListener("gattserverdisconnected", () => bikeLost(dev)); dev._tahWatch = true; }
    setBtBtn("bike", { textContent: "Disconnect bike" });
    btMsg(`Connected to ${dev.name || "your bike"}. Start pedaling…`);
    setTimeout(describeBike, 3000);
    update();
  } catch (e) {
    try { dev.gatt.disconnect(); } catch (x) {}
    btMsg("Couldn't connect. Make sure the bike is on and not connected to another app, then try again.");
  } finally { setBtBtn("bike", { disabled: false }); }
}

// Unexpected drop: the ride keeps going as if you'd stopped pedaling (0 W), with a banner, and the
// app keeps trying to reconnect until it works or you switch to the + and − buttons.
async function bikeLost(dev) {
  if (BT.bike !== dev || BT.bikeUserOff || BT.bikeLost) return;
  BT.bikeLost = true; lostBanner(true);
  for (let attempt = 1; BT.bike === dev && !BT.bikeUserOff; attempt++) {
    setText("lostText", `Bike disconnected. Reconnecting${attempt > 1 ? ` (try ${attempt})` : ""}… Your ride carries on as if you've stopped pedaling.`);
    await sleep(Math.min(1500 * attempt, 5000));
    if (BT.bike !== dev || BT.bikeUserOff) break;
    try {
      if ((await attachBike(dev)).length) {
        BT.bikeLost = false; lostBanner(false);
        btMsg(`Reconnected to ${dev.name || "your bike"}.`); update(); return;
      }
    } catch (e) {}
  }
  BT.bikeLost = false; lostBanner(false);
}
function lostBanner(on) { $("lostBanner").hidden = !on; }
function bikeGone(msg) {
  BT.bike = null; BT.bikeLost = false; resetBikeData(); lostBanner(false);
  setBtBtn("bike", { textContent: "Connect bike" }); btMsg(msg); update();
}
$("lostManual").addEventListener("click", () => {
  const dev = BT.bike; BT.bikeUserOff = true;
  try { dev && dev.gatt.disconnect(); } catch (e) {}
  bikeGone("Speed is on the + and − buttons. Tap Connect bike to try the bike again.");
});

async function connectHr() {
  if (BT.hr) { BT.hrUserOff = true; try { BT.hr.gatt.disconnect(); } catch (e) {} hrGone("Heart rate monitor disconnected."); return; }
  const dev = await pickDevice({ filters: [{ services: [SVC.hr] }] });
  if (!dev) return;
  btMsg("Connecting heart rate…"); setBtBtn("hr", { disabled: true });
  try {
    if (!(await attachHr(dev)).length) throw new Error("no-hr");
    BT.hr = dev; BT.hrUserOff = false;
    if (!dev._tahWatch) { dev.addEventListener("gattserverdisconnected", () => hrLost(dev)); dev._tahWatch = true; }
    setBtBtn("hr", { textContent: "Disconnect heart rate" });
    btMsg(`Heart rate from ${dev.name || "your monitor"}.`);
  } catch (e) {
    try { dev.gatt.disconnect(); } catch (x) {}
    btMsg("Couldn't connect to the heart rate monitor. Make sure it's on and not connected to another app.");
  } finally { setBtBtn("hr", { disabled: false }); }
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
function hrGone(msg) { BT.hr = null; live.hrT = 0; setBtBtn("hr", { textContent: "Connect heart rate" }); btMsg(msg); update(); }

if (navigator.bluetooth) {
  $("btRow").hidden = false; $("startBt").hidden = false;
  document.querySelectorAll('[data-bt="bike"]').forEach(b => b.addEventListener("click", connectBike));
  document.querySelectorAll('[data-bt="hr"]').forEach(b => b.addEventListener("click", connectHr));
} else {
  btMsg("Bluetooth isn't available in this browser. Use Chrome on Android to connect the bike.");
}

/* ========== Ride history, TCX export and Strava ==========
   Every ride is kept in history (rideStore.js). From the finish summary or the history list the
   rider can download a TCX file (tcx.js) or, once Strava is connected, upload in one tap
   (strava.js). Uploads that can't finish (offline, Strava busy) wait in a queue and retry when
   the app next opens online. */
const strava = TAH.createStrava({ getConfig: () => ({ clientId: S.stravaClientId, helperUrl: S.stravaHelper }), kv });
const U = { running: false, again: false, needsAuth: false, live: new Map(), lastRideId: null, connected: false };
const MIN_HISTORY_SAMPLES = 10;                          // rides under 10 seconds aren't worth listing

function when(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + ", " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function rideFacts(r) {
  const s = r.summary || {}, bits = [fmtDShort(s.distM || 0), fmtT(s.movingS || 0)];
  if (s.avgPowerW != null) bits.push(`${Math.round(s.avgPowerW)} W`);
  if (s.ascentM > 1) bits.push(`${fmtE(s.ascentM)} ${eUnit()} climbed`);
  return bits.join(" · ") + (r.finished ? "" : " · part of the route");
}
const stravaLink = id => `<a href="https://www.strava.com/activities/${encodeURIComponent(id)}" target="_blank" rel="noopener">View on Strava</a>`;
// One line describing where a ride's upload stands (HTML).
function uploadLine(r) {
  const live = U.live.get(r.id), u = r.upload || { status: "none" };
  if (live) return esc(live);
  switch (u.status) {
    case "uploaded":
      if (!u.activityId) return "On Strava.";
      return (u.duplicate ? "Already on Strava. " : u.virtual === false ? "On Strava as a regular ride. " : "On Strava as a virtual ride. ") + stravaLink(u.activityId);
    case "pending": return U.needsAuth ? "Waiting: connect Strava again to upload." : navigator.onLine ? "Waiting to upload…" : "Will upload when you're back online.";
    case "processing": return "Strava is still processing it. It'll check again shortly.";
    case "failed": return esc(u.retryable ? `Upload will try again later. ${u.error || ""}` : `Strava couldn't take this ride: ${u.error || "unknown error"}`);
    default: return "";
  }
}

/* --- Exporting a TCX file --- */
async function exportTcx(id) {
  await logSave;
  const ride = await rides.get(id);
  if (!ride || !ride.samples.length) throw new Error("This ride has no recorded data.");
  const name = TAH.tcxFileName(ride);
  const file = new File([TAH.buildTcx(ride, { includePosition: S.tcxPositions })], name, { type: "application/vnd.garmin.tcx+xml" });
  // Android's share sheet, where Chrome allows this file type; otherwise a normal download.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  const url = URL.createObjectURL(file), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return "downloaded";
}
const exportedMsg = how => how === "shared" ? "Shared." : how === "cancelled" ? ""
  : "Saved to your Downloads. To add it to Strava by hand, open strava.com/upload/select in a browser and choose the file.";

/* --- Uploading --- */
async function requestUpload(id) {
  await logSave;
  const r = await rides.get(id, false);
  if (!r || (r.upload && r.upload.status === "uploaded")) return;
  const keep = r.upload && r.upload.status === "processing" ? r.upload : { status: "pending" };
  await rides.setUpload(id, keep);
  U.needsAuth = false;
  refreshUploads();
  runQueue();
}
async function uploadOne(id) {
  const ride = await rides.get(id);
  if (!ride) return "next";
  const say = t => { U.live.set(id, t); refreshUploads(); };
  say("Sending to Strava…");
  try {
    const res = await strava.upload(ride, TAH.buildTcx(ride, { includePosition: S.tcxPositions }), {
      onProgress: say,
      onUploadId: uploadId => rides.setUpload(id, { status: "processing", uploadId })
    });
    await rides.setUpload(id, res);
    return "next";
  } catch (e) {
    const cur = (await rides.get(id, false)).upload;
    if (e.kind === "auth") { U.needsAuth = true; await rides.setUpload(id, cur.status === "processing" ? cur : { status: "pending" }); return "stop"; }
    if (e.kind === "retry") {
      await rides.setUpload(id, cur.status === "processing" ? cur : { status: "failed", retryable: true, error: e.message });
      return "stop";                                     // probably offline: leave the rest for later
    }
    await rides.setUpload(id, { status: "failed", retryable: false, error: e.message });
    return "next";
  } finally { U.live.delete(id); }
}
// Uploads everything waiting, oldest first. Runs at start-up, when the phone comes back online,
// after connecting Strava and whenever the rider taps Upload.
async function runQueue() {
  if (U.running) { U.again = true; return; }
  U.running = true;
  try {
    do {
      U.again = false;
      const st = await strava.status();
      U.connected = st.connected;
      if (!st.connected || U.needsAuth || !navigator.onLine) break;
      const waiting = (await rides.list()).filter(r => rides.isQueued(r.upload) && !(R.log && R.log.id === r.id)).reverse();
      for (const r of waiting) if ((await uploadOne(r.id)) === "stop") break;
    } while (U.again);
  } catch (e) { /* storage trouble: try again next time */ }
  finally { U.running = false; refreshUploads(); drawStrava(); }
}
window.addEventListener("online", () => { refreshUploads(); runQueue(); });
window.addEventListener("offline", () => refreshUploads());

/* --- Finish summary buttons --- */
async function drawSummaryUpload() {
  const box = $("sumActs");
  if (!U.lastRideId) { box.hidden = true; $("sumMsg").innerHTML = ""; return; }
  const r = await rides.get(U.lastRideId, false).catch(() => null);
  if (!r) { box.hidden = true; return; }
  box.hidden = false;
  const done = r.upload && r.upload.status === "uploaded", busy = U.live.has(r.id) || (r.upload && ["pending", "processing"].includes(r.upload.status));
  $("sumUp").hidden = !U.connected || done;
  $("sumUp").disabled = busy;
  $("sumUp").textContent = r.upload && r.upload.status === "failed" ? "Try Strava again" : "Upload to Strava";
  $("sumMsg").innerHTML = uploadLine(r) || (U.connected ? "" : "To upload in one tap, connect Strava in Settings.");
}
$("sumUp").addEventListener("click", () => { if (U.lastRideId) requestUpload(U.lastRideId); });
$("sumTcx").addEventListener("click", async () => {
  try { $("sumMsg").textContent = exportedMsg(await exportTcx(U.lastRideId)); }
  catch (e) { $("sumMsg").textContent = e.message; }
});

/* --- Ride history page: search, filters, sort and totals --- */
function filterRides(list) {
  const q = $("hSearch").value.trim().toLowerCase(), per = $("hPeriod").value, st = $("hStatus").value, now = Date.now();
  const since = per === "year" ? new Date(new Date().getFullYear(), 0, 1).getTime() : per ? now - per * 86400000 : 0;
  const onStrava = r => r.upload && r.upload.status === "uploaded";
  list = list.filter(r => (!q || (r.routeName || "").toLowerCase().includes(q)) && r.startedAt >= since &&
    (!st || (st === "finished" ? r.finished : st === "partial" ? !r.finished : st === "strava" ? onStrava(r) : !onStrava(r))));
  const d = r => (r.summary && r.summary.distM) || 0, c = r => (r.summary && r.summary.ascentM) || 0;
  const by = { new: (a, b) => b.startedAt - a.startedAt, old: (a, b) => a.startedAt - b.startedAt, far: (a, b) => d(b) - d(a), climb: (a, b) => c(b) - c(a) }[$("hSort").value];
  return list.sort(by);
}
function rideTotals(list, all) {
  let dist = 0, secs = 0, climb = 0;
  for (const r of list) { const s = r.summary || {}; dist += s.distM || 0; secs += s.movingS || 0; climb += s.ascentM || 0; }
  const n = list.length === all ? `${all} ride${all === 1 ? "" : "s"}` : `${list.length} of ${all} rides`;
  return `${n} · ${fmtDShort(dist)} · ${fmtT(secs)} · ${fmtE(climb)} ${eUnit()} climbed`;
}
["hSearch", "hPeriod", "hStatus", "hSort"].forEach(id => $(id).addEventListener(id === "hSearch" ? "input" : "change", drawHistory));

/* --- Ride history list --- */
async function drawHistory() {
  let list;
  try { list = (await rides.list()).filter(r => r.sampleCount >= MIN_HISTORY_SAMPLES && !(R.log && R.log.id === r.id)); }
  catch (e) { return; }
  const all = list.length;
  list = filterRides(list);
  $("histEmpty").hidden = all > 0;
  $("histFilters").hidden = all === 0;
  $("histEmpty").textContent = "Rides you finish or end part-way show up here.";
  if (all && !list.length) { $("histEmpty").hidden = false; $("histEmpty").textContent = "No rides match those filters."; }
  $("histTotals").textContent = list.length ? rideTotals(list, all) : "";
  $("hist").innerHTML = list.map(r => {
    const u = r.upload || {}, busy = U.live.has(r.id) || u.status === "pending" || u.status === "processing";
    const up = !U.connected || u.status === "uploaded" ? "" :
      `<button data-act="up" data-id="${esc(r.id)}"${busy ? " disabled" : ""}>${u.status === "failed" ? "Try Strava again" : "Upload to Strava"}</button>`;
    // Date block on the left, like a fixtures list: month, day, weekday.
    const d = new Date(r.startedAt);
    const dateBlock = `<div class="date" aria-hidden="true"><span>${esc(d.toLocaleDateString(undefined, { month: "short" }))}</span><b>${d.getDate()}</b><span>${esc(d.toLocaleDateString(undefined, { weekday: "short" }))}</span></div>`;
    return `<li class="ride">
      ${dateBlock}
      <div class="rbody">
        <div class="rtop"><b>${esc(r.routeName || "Ride")}</b><span>${esc(d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}</span></div>
        <span class="sub">${esc(rideFacts(r))}</span>
        <span class="upst" data-st="${esc(r.id)}">${uploadLine(r)}</span>
        <span class="sr-only">${esc(when(r.startedAt))}</span>
      </div>
      <div class="acts"><button data-act="tcx" data-id="${esc(r.id)}">Download TCX</button>${up}<button data-act="del" data-id="${esc(r.id)}">Delete</button></div>
    </li>`;
  }).join("");
}
function refreshUploads() {
  if (page === "history") drawHistory();
  if (!$("summary").hidden) drawSummaryUpload();
}
$("hist").addEventListener("click", async ev => {
  const b = ev.target.closest("button"); if (!b) return;
  const id = b.dataset.id;
  try {
    if (b.dataset.act === "tcx") { const how = await exportTcx(id); $("histMsg").textContent = exportedMsg(how); }
    else if (b.dataset.act === "up") requestUpload(id);
    else if (b.dataset.act === "del") {
      const r = await rides.get(id, false);
      if (r && confirm(`Delete the ride on ${when(r.startedAt)}? ${r.upload && r.upload.status === "uploaded" ? "It stays on Strava." : "This can't be undone."}`)) { await rides.remove(id); drawHistory(); }
    }
  } catch (e) { $("histMsg").textContent = e.message; }
});

/* --- Strava connection panel --- */
async function drawStrava() {
  const st = await strava.status().catch(() => ({ configured: false, connected: false }));
  U.connected = st.connected;
  $("stravaState").textContent = U.needsAuth ? "Strava needs you to connect again. Rides waiting to upload will go once you do."
    : st.connected ? `Connected${st.name ? " as " + st.name : ""}. Rides can go to Strava in one tap.`
    : st.configured ? "Not connected yet." : "Not set up. Rides can still be downloaded as TCX files and added at strava.com.";
  $("stravaConnect").hidden = !st.configured || (st.connected && !U.needsAuth);
  $("stravaConnect").textContent = U.needsAuth ? "Connect Strava again" : "Connect Strava";
  $("stravaOff").hidden = !st.connected;
  $("setupBox").open = !st.configured && $("setupBox").open;
}
// Filled once at start-up, so a refresh of the panel never overwrites what's being typed.
$("setClientId").value = S.stravaClientId; $("setHelper").value = S.stravaHelper; $("setPos").checked = S.tcxPositions;
$("stravaConnect").addEventListener("click", async () => {
  try { location.href = await strava.connectUrl(location.origin + location.pathname); }
  catch (e) { $("stravaMsg").textContent = e.message; }
});
$("stravaOff").addEventListener("click", async () => {
  if (!confirm("Disconnect Strava? Rides already uploaded stay on Strava.")) return;
  await strava.disconnect(); U.needsAuth = false;
  $("stravaMsg").textContent = "Disconnected. To remove the app's access completely, go to strava.com, Settings, My Apps.";
  drawStrava(); drawHistory();
});
["setClientId", "setHelper"].forEach(id => $(id).addEventListener("change", () => {
  S.stravaClientId = $("setClientId").value; S.stravaHelper = $("setHelper").value; sanitize(S); saveSettings(); drawStrava();
}));
$("setPos").addEventListener("change", () => { S.tcxPositions = $("setPos").checked; saveSettings(); });

// Coming back from Strava's sign-in page: the address carries ?code=…&state=… (or ?error=…).
async function handleStravaReturn() {
  const q = new URLSearchParams(location.search);
  if (!q.has("state")) return;
  history.replaceState(null, "", location.pathname);
  const r = await strava.handleRedirect(q).catch(e => ({ handled: true, ok: false, message: e.message }));
  if (!r.handled) return;
  U.needsAuth = false;
  go("settings", true); $("stravaMsg").textContent = r.message;
  if (r.ok) runQueue();
  drawStrava();
}

/* ========== Pages ==========
   Home, Start a ride, Browse routes, Ride history, Info, Settings and the ride itself. Each page
   has its own address (#routes, #history…), so the phone's back gesture moves between them. */
const PAGES = ["home", "start", "routes", "history", "info", "settings", "ride"];
const TITLES = { home: "Trail at Home", start: "Start a ride", routes: "Browse routes", history: "Ride history", info: "Info", settings: "Settings", ride: "Ride" };
let page = "home";
const pageFromHash = () => { const h = location.hash.slice(1); return PAGES.includes(h) ? h : "home"; };
const depth = () => (history.state && history.state.depth) || 0;   // pages stacked above Home

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
function showPage(name, scrollY = 0, focus = true) {
  if (name === "ride" && !R.meta) name = "home";
  // Settings can be opened mid-ride without ending it; any other page ends (pauses and saves) the ride.
  if (R.meta && name !== "ride" && name !== "settings") closeRide();
  page = name;
  for (const p of PAGES) $("scr-" + p).hidden = p !== name;
  const tabs = !["start", "ride"].includes(name) && !(name === "settings" && R.meta);   // mid-ride, Settings only goes back to the ride
  $("tabbar").hidden = !tabs; document.body.classList.toggle("has-tabbar", tabs);
  document.querySelectorAll("[data-tab]").forEach(t => { if (t.dataset.tab === name) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current"); });
  document.title = name === "home" ? "Trail at Home" : `${name === "ride" && R.meta ? R.meta.name : TITLES[name]} · Trail at Home`;
  window.scrollTo(0, scrollY);
  // Some pages fill in after reading storage, so restore the scroll again once they're drawn.
  Promise.resolve(ENTER[name]()).then(() => { if (scrollY) window.scrollTo(0, scrollY); });
  const h1 = $("scr-" + name).querySelector("h1");
  if (focus && h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); }
}
function go(name, opt = {}) {
  if (!opt.replace && history.state) history.replaceState(Object.assign({}, history.state, { scroll: window.scrollY }), "");
  const st = Object.assign({ page: name, depth: name === "home" ? 0 : opt.replace ? depth() : depth() + 1 }, opt.state || {});
  history[opt.replace ? "replaceState" : "pushState"](st, "", name === "home" ? location.pathname : "#" + name);
  showPage(name);
}
// Back to Home by unwinding the pages above it, so the phone's back gesture doesn't revisit them.
// If the app was opened on another page (a reload on #history, say), that first page becomes Home.
let wantHome = false;
function goHome() { const d = depth(); if (d > 0) { wantHome = true; history.go(-d); } else go("home", { replace: true }); }
window.addEventListener("popstate", () => {
  if (wantHome) { wantHome = false; if (pageFromHash() !== "home") { go("home", { replace: true }); return; } }
  showPage(pageFromHash(), (history.state && history.state.scroll) || 0);
});
document.addEventListener("click", e => {
  const g = e.target.closest("[data-go]");
  if (g) {
    if (g.dataset.go === "start") START.route = null;
    go(g.dataset.go);
    if (g.dataset.anchor) $(g.dataset.anchor).scrollIntoView({ block: "start" });   // e.g. Settings → the Strava steps in Info
    return;
  }
  if (e.target.closest("[data-back]")) { if (page === "settings" && R.meta) history.back(); else goHome(); }
});

const ENTER = {
  home: drawHome,
  start: startEnter,
  routes: drawLibrary,
  history: drawHistory,
  info: () => {},
  settings() {
    showSettings(); drawStrava();
    $("scr-settings").querySelector("[data-back]").hidden = !R.meta;   // "Back to ride" only mid-ride
    rides.list().then(l => {
      const n = l.filter(r => r.sampleCount >= MIN_HISTORY_SAMPLES).length;
      $("storageInfo").textContent = `${metas.length} of ${MAX_ROUTES} routes and ${n} ride${n === 1 ? "" : "s"} are stored on this phone only.`;
    }).catch(() => {});
  },
  ride() { update(); layoutProfiles(); if (!$("summary").hidden) drawSummaryUpload(); }
};
const refreshPage = () => ENTER[page]();
// Tabs swap pages rather than stacking them, so the phone's back gesture from any tab goes Home.
const TAB_PAGES = ["home", "routes", "history", "settings", "info"];
$("tabbar").addEventListener("click", e => {
  const t = e.target.closest("[data-tab]"); if (!t) return;
  const name = t.dataset.tab;
  if (name === "start") START.route = null;
  if (name === "home") { goHome(); return; }
  if (name === page && name !== "start") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  go(name, { replace: page !== "home" && TAB_PAGES.includes(page) && name !== "start" });
});

/* --- Home --- */
// The hero's art: the route's own elevation profile, coloured by grade, with the app icon's
// orange trail climbing it to a dot where you stopped (no trail if you haven't started it).
function heroSvg(pv, frac) {
  if (!pv || pv.e.length < 2) return "";
  const r = TAH.previewRoute(pv), W = 120, H = 64, TOP = 8, p = TAH.columns(r, 0, r.totalDistM, pv.e.length);
  const lo = Math.min(...pv.e), hi = Math.max(Math.max(...pv.e), lo + 40);
  const X = x => x / pv.e.length * W, Y = e => TOP + (1 - (e - lo) / (hi - lo)) * (H - TOP - 6);
  let h = `<defs><linearGradient id="hfade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#0F1612" stop-opacity=".55"/></linearGradient></defs>`;
  let k = 0;
  while (k < p.g.length) {
    const band = TAH.gradeBand(p.g[k]), start = k;
    while (k < p.g.length && TAH.gradeBand(p.g[k]) === band) k++;
    let pts = `${X(p.x[start]).toFixed(1)},${H}`;
    for (let i = start; i <= k; i++) pts += ` ${X(p.x[i]).toFixed(1)},${Y(p.e[i]).toFixed(1)}`;
    h += `<polygon class="g-${band}" opacity=".9" points="${pts} ${X(p.x[k]).toFixed(1)},${H}"/>`;
  }
  h += `<rect width="${W}" height="${H}" fill="url(#hfade)"/>`;
  const ridge = p.x.map((x, i) => `${X(x).toFixed(1)},${Y(p.e[i]).toFixed(1)}`);
  h += `<polyline points="${ridge.join(" ")}" fill="none" stroke="#EEF2E8" stroke-width="1" stroke-linejoin="round" opacity=".8"/>`;
  if (frac != null) {
    const end = frac * W, done = [];
    for (let i = 0; i < p.x.length && X(p.x[i]) <= end; i++) done.push(ridge[i]);
    const ex = Math.max(0, Math.min(W, end)), ey = Y(TAH.valueAt(r, r.eleM, frac * r.totalDistM));
    done.push(`${ex.toFixed(1)},${ey.toFixed(1)}`);
    h += `<polyline points="${done.join(" ")}" fill="none" stroke="#0F1612" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
    h += `<polyline points="${done.join(" ")}" fill="none" stroke="#EC7A22" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
    h += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4.5" fill="#EC7A22" stroke="#0F1612" stroke-width="2"/>`;
  }
  return `<svg class="thumb" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${h}</svg>`;
}
// Mountains and a trail, like the app icon, for the welcome hero before any routes exist.
const WELCOME_ART = `<svg class="thumb" viewBox="0 0 340 118" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><polygon points="0,118 70,46 104,74 168,16 250,96 300,70 340,92 340,118" fill="#3D7BD6"/><polygon points="0,118 60,90 120,104 190,72 250,96 300,84 340,96 340,118" fill="#3F9A52"/><polyline points="10,112 70,46 104,74 136,45" fill="none" stroke="#0F1612" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/><polyline points="10,112 70,46 104,74 136,45" fill="none" stroke="#EC7A22" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="136" cy="45" r="8" fill="#EC7A22" stroke="#0F1612" stroke-width="3"/></svg>`;
const BIKE_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17" r="3.5"/><circle cx="18.5" cy="17" r="3.5"/><path d="M5.5 17 10 9h6l2.5 8M10 9l3 8h-2M15 6h3"/></svg>`;
const fact = (value, label) => { const [n, u] = String(value).split(" "); return `<div><b>${esc(n)}${u ? `<small style="font-size:.55em;margin-left:2px">${esc(u)}</small>` : ""}</b><span>${esc(label)}</span></div>`; };

async function drawHome() {
  // The hero features one route: one you're part-way through, else the one used most recently.
  const going = metas.filter(isGoing).sort((a, b) => (b.lastRidden || 0) - (a.lastRidden || 0))[0];
  const next = going || metas.slice().sort((a, b) => recency(b) - recency(a))[0];
  const hero = $("hero");
  if (!next) {
    hero.innerHTML = `<div class="hero-top"><div><p class="kicker">Welcome</p><h2>Ride real hills at home</h2></div>${WELCOME_ART}</div>
      <p class="small" style="margin:10px 0 12px">Add a GPX file of a Strava route and ride it on your Bowflex, with the grade, resistance and climbs as you go.</p>
      <button class="primary" data-hero="add">Add your first route</button>`;
  } else {
    const pct = Math.round(next.pos / next.total * 100);
    const facts = going ? fact(fmtDShort(going.pos), "ridden") + fact(fmtDShort(going.total - going.pos), "to go") + fact(`${pct}%`, "complete")
      : fact(fmtDShort(next.total), "distance") + (next.hasEle === false ? "" : fact(`${fmtE(next.gain)} ${eUnit()}`, "climbing"));
    hero.innerHTML = `<div class="hero-top"><div><p class="kicker">${going ? "Continue your ride" : isDone(next) ? "You finished this route" : "Ready when you are"}</p>
      <h2>${esc(next.name)}</h2></div>${heroSvg(next.preview, going ? going.pos / going.total : null)}</div>
      <div class="facts">${facts}</div>
      <button class="primary" data-hero="ride" data-id="${esc(next.id)}">${BIKE_ICON}${going ? "Continue ride" : isDone(next) ? "Ride it again" : "Ride this route"}</button>
      <button class="alt" data-hero="pick">Choose a different route</button>`;
  }
  $("tRoutes").textContent = metas.length ? `${metas.length} route${metas.length === 1 ? "" : "s"} saved` : "Add your first routes";
  try {
    const list = await rides.list(), n = list.filter(r => r.sampleCount >= MIN_HISTORY_SAMPLES).length;
    const waiting = list.filter(r => rides.isQueued(r.upload)).length;
    $("tHistory").textContent = n ? `${n} ride${n === 1 ? "" : "s"}${waiting ? `, ${waiting} waiting to upload` : ""}` : "No rides yet";
    $("tSettings").textContent = (await strava.status()).connected ? "Resistance, units, Strava (connected)" : "Resistance, units, Strava";
  } catch (e) {}
}
$("hero").addEventListener("click", e => {
  const b = e.target.closest("[data-hero]"); if (!b) return;
  if (b.dataset.hero === "ride") { const m = metas.find(x => x.id === b.dataset.id); if (m) pickForRide(m); }
  else if (b.dataset.hero === "pick") { START.route = null; go("start"); }
  else go("routes");
});

/* --- Start a ride: 1. choose a route, 2. connect the bike, 3. ride --- */
const START = { route: null };
function showStep(n) {
  const changed = $("step" + n).hidden;
  $("step1").hidden = n !== 1; $("step2").hidden = n !== 2;
  $("stepL1").classList.toggle("on", n === 1); $("stepL2").classList.toggle("on", n === 2);
  if (n === 1) drawPick(); else drawPicked();
  if (changed) window.scrollTo(0, 0);
}
function startEnter() {
  const step2 = history.state && history.state.step === 2 && START.route && metas.includes(START.route);
  showStep(step2 ? 2 : 1);
}
// From Browse routes or the Continue card: skip straight to connecting the bike.
function pickForRide(m) { START.route = m; go("start", { state: { step: 2 } }); }
function drawPick() {
  const q = $("pickSearch").value.trim().toLowerCase();
  const list = metas.filter(m => !q || m.name.toLowerCase().includes(q)).sort((a, b) => recency(b) - recency(a));
  $("pickEmpty").hidden = metas.length > 0; $("pickSearch").hidden = !metas.length;
  $("pickList").innerHTML = list.map(m => routeCard(m, "pick")).join("") || (metas.length ? '<li class="empty">No routes match.</li>' : "");
}
$("pickSearch").addEventListener("input", drawPick);
$("pickList").addEventListener("click", ev => {
  const b = ev.target.closest("button.open"); if (!b) return;
  const m = metas.find(x => x.id === b.dataset.id); if (!m) return;
  START.route = m;
  history.replaceState(Object.assign({}, history.state, { scroll: window.scrollY }), "");
  history.pushState({ page: "start", step: 2, fromList: true, depth: depth() + 1 }, "", "#start");
  showStep(2);
});
function drawPicked() {
  // A route finished part-way can still be picked up where it was left, but starts over by default.
  const m = START.route, part = m.pos > 50 && !reachedEnd(m);
  $("picked").innerHTML = `<ul class="routes">${routeCard(m, "static")}</ul><button class="change" id="changeRoute">Choose a different route</button>`;
  $("fromBox").hidden = !part;
  if (part) {
    $("fromWhere").textContent = `${fmtDShort(m.pos)} of ${fmtDShort(m.total)}`;
    $("fromResumeL").textContent = m.done ? "Where you finished" : "Where you left off";
    document.querySelector(`input[name="from"][value="${m.done ? "begin" : "resume"}"]`).checked = true;
  }
  $("beginRide").textContent = isDone(m) ? "Ride it again" : "Start ride";
  $("changeRoute").addEventListener("click", () => {
    if (history.state && history.state.fromList) history.back();
    else { history.replaceState({ page: "start", depth: depth() }, "", "#start"); showStep(1); }
  });
}
let beginning = false;                                 // a double tap must not load the route twice
$("beginRide").addEventListener("click", async () => {
  const m = START.route; if (!m || beginning) return;
  beginning = true; $("beginRide").disabled = true;
  try {
    const fromStart = $("fromBox").hidden ? isDone(m) : document.querySelector('input[name="from"]:checked').value === "begin";
    if (fromStart) { m.pos = 0; m.stats = null; }
    if (fromStart || m.done) { m.done = false; await putMeta(m); }   // riding it again: in progress until finished
    if (!(await openRide(m))) return;
    go("ride", { replace: true });                     // back from the ride returns to where you came from
    start();
  } catch (e) { btMsg(storageMsg(e)); }
  finally { beginning = false; $("beginRide").disabled = false; }
});

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
$("updBtn").addEventListener("click", () => { if (R.session && R.session.state.running) stop(); endLog(); saveProgress(); location.reload(); });

// Open on the page in the address (a reload keeps you on, say, Ride history), but never mid-ride.
{
  const first = pageFromHash() === "ride" ? "home" : pageFromHash();
  // Any ?code=… from Strava's sign-in stays in the address for handleStravaReturn to read.
  history.replaceState({ page: first, depth: 0 }, "", location.pathname + location.search + (first === "home" ? "" : "#" + first));
  showPage(first, 0, false);
}
loadLibrary();
handleStravaReturn().finally(runQueue);
})();

// Started cleanly: tell the start-up guard in index.html, and allow an automatic repair again next time.
window.__tah.ok = true;
try { sessionStorage.removeItem("tah-autorepair"); } catch (e) {}
