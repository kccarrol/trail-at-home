/* Trail at Home: Strava connection and upload.
   Strava's token exchange needs the app's client secret, which can't be kept safe inside a web
   app, so a tiny helper you deploy (strava-helper-worker.js) holds it. The helper also relays the
   three Strava API calls the app makes, so they work whatever Strava's browser (CORS) rules are.

   createStrava({ getConfig: () => ({ clientId, helperUrl }), kv: { get, set, del }, fetch?, now?, sleep? })
     .status()                 -> { configured, connected, name }
     .connectUrl(redirectUri)  -> Strava's sign-in page (remembers a random state to check on return)
     .handleRedirect(params)   -> { handled, ok, message } for the page Strava sends the rider back to
     .upload(ride, tcxText, { onProgress, onUploadId }) -> { status: "uploaded"|"processing", activityId?, uploadId?, virtual? }
         throws StravaError with kind "auth" (reconnect), "retry" (try later) or "fatal" (Strava refused the file)
     .disconnect() */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TAH = Object.assign(root.TAH || {}, factory());
})(typeof self !== "undefined" ? self : this, function () {
"use strict";

// Upload needs activity:write. Changing the type to Virtual Ride also needs activity:read_all when
// the rider's activities default to "Only Me", so both are requested.
const SCOPE = "activity:write,activity:read_all";
const POLL_MS = 2000, POLL_FOR_MS = 60000, REFRESH_EARLY_MS = 5 * 60000;

class StravaError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}

function createStrava(o) {
  const f = o.fetch || ((...a) => fetch(...a)), now = o.now || Date.now;
  const sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const cfg = () => {
    const c = o.getConfig() || {};
    return { clientId: String(c.clientId || "").trim(), helper: String(c.helperUrl || "").trim().replace(/\/+$/, "") };
  };
  const configured = () => { const c = cfg(); return /^\d+$/.test(c.clientId) && /^https:\/\/[^/]+/.test(c.helper); };
  const tokens = async () => (await o.kv.get("strava-tokens")) || null;

  async function status() {
    const t = await tokens();
    return { configured: configured(), connected: !!t, name: t && t.athlete ? t.athlete.firstname || "" : "" };
  }

  async function connectUrl(redirectUri) {
    if (!configured()) throw new StravaError("fatal", "Add your Strava client ID and helper address first.");
    const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
    await o.kv.set("strava-state", { state, redirectUri, at: now() });
    const q = new URLSearchParams({ client_id: cfg().clientId, redirect_uri: redirectUri, response_type: "code", approval_prompt: "auto", scope: SCOPE, state });
    return "https://www.strava.com/oauth/authorize?" + q.toString();
  }

  // Low-level call to the helper; turns HTTP and network failures into StravaErrors.
  async function call(path, init) {
    let r;
    try { r = await f(cfg().helper + path, init); }
    catch (e) { throw new StravaError("retry", "Couldn't reach Strava. Check your connection."); }
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    if (r.ok) return body || {};
    const msg = (body && (body.error || body.message)) || `Strava returned an error (${r.status}).`;
    if (r.status === 401) throw new StravaError("auth", "Strava needs you to connect again.", 401);
    if (r.status === 429 || r.status >= 500) throw new StravaError("retry", r.status === 429 ? "Strava is busy. The upload will try again later." : msg, r.status);
    const err = new StravaError("fatal", typeof msg === "string" ? msg : JSON.stringify(msg), r.status);
    err.body = body;
    throw err;
  }
  const postJson = (path, data) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

  async function saveTokens(j, prev) {
    if (!j || !j.access_token) throw new StravaError("auth", "Strava didn't return a sign-in token.");
    const t = {
      accessToken: j.access_token, refreshToken: j.refresh_token || (prev && prev.refreshToken),
      expiresAt: (j.expires_at ? j.expires_at * 1000 : now() + (j.expires_in || 21600) * 1000),
      athlete: j.athlete ? { firstname: j.athlete.firstname || "", lastname: j.athlete.lastname || "" } : (prev && prev.athlete) || null
    };
    await o.kv.set("strava-tokens", t);
    return t;
  }

  async function handleRedirect(params) {
    if (!params.has("state") || !(params.has("code") || params.has("error"))) return { handled: false };
    const saved = await o.kv.get("strava-state");
    await o.kv.del("strava-state");
    if (!saved || saved.state !== params.get("state")) return { handled: true, ok: false, message: "That Strava sign-in didn't match. Please tap Connect Strava again." };
    if (params.has("error")) return { handled: true, ok: false, message: "Strava connection was cancelled." };
    const granted = (params.get("scope") || "").split(",");
    if (!granted.includes("activity:write")) return { handled: true, ok: false, message: "Strava didn't give permission to upload. Tap Connect Strava again and leave “Upload your activities” ticked." };
    try {
      const t = await saveTokens(await postJson("/exchange", { code: params.get("code") }), null);
      const partial = !granted.includes("activity:read_all") ? " Rides set to “Only Me” may stay as normal rides rather than virtual rides." : "";
      return { handled: true, ok: true, message: `Connected to Strava${t.athlete && t.athlete.firstname ? " as " + t.athlete.firstname : ""}.${partial}` };
    } catch (e) {
      return { handled: true, ok: false, message: "Couldn't finish connecting to Strava: " + e.message };
    }
  }

  // A valid access token, refreshed through the helper when it's within 5 minutes of expiring.
  async function accessToken(force) {
    const t = await tokens();
    if (!t) throw new StravaError("auth", "Connect Strava first.");
    if (!force && t.expiresAt - now() > REFRESH_EARLY_MS) return t.accessToken;
    try { return (await saveTokens(await postJson("/refresh", { refresh_token: t.refreshToken }), t)).accessToken; }
    catch (e) {
      if (e.kind === "retry") throw e;
      throw new StravaError("auth", "Strava needs you to connect again.", e.status);
    }
  }
  // Strava API call through the helper, retrying once with a fresh token if Strava says 401.
  async function api(method, path, body) {
    const go = async force => {
      const headers = { Authorization: "Bearer " + await accessToken(force) };
      let payload = body;
      if (body && !(typeof FormData !== "undefined" && body instanceof FormData)) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
      return call("/api" + path, { method, headers, body: payload });
    };
    try { return await go(false); }
    catch (e) { if (e.kind === "auth" && e.status === 401) return go(true); throw e; }
  }

  // "... duplicate of activity 1234" (or a link to it): the ride is already on Strava.
  function duplicateOf(msg) {
    if (!/duplicate/i.test(msg || "")) return null;
    const m = String(msg).match(/activities\/(\d+)/) || String(msg).match(/activity\D{0,20}(\d{5,})/i);
    return { id: m ? m[1] : null };
  }
  const uploaded = (activityId, virtual, duplicate) => ({ status: "uploaded", activityId: activityId ? String(activityId) : null, virtual, duplicate: !!duplicate });

  async function upload(ride, tcxText, cb = {}) {
    const progress = cb.onProgress || (() => {});
    let uploadId = ride.upload && ride.upload.status === "processing" ? ride.upload.uploadId : null, activityId = null;
    if (!uploadId) {
      progress("Sending to Strava…");
      const form = new FormData();
      form.append("file", new Blob([tcxText], { type: "application/vnd.garmin.tcx+xml" }), "ride.tcx");
      form.append("data_type", "tcx");
      form.append("trainer", "1");
      form.append("name", "Trail at Home: " + (ride.routeName || "ride"));
      form.append("description", "Virtual ride on a Bowflex VeloCore, recorded with Trail at Home.");
      form.append("external_id", "trailathome-" + ride.id);
      let u;
      try { u = await api("POST", "/uploads", form); }
      catch (e) {
        const dup = e.kind === "fatal" && duplicateOf(e.body && (e.body.error || JSON.stringify(e.body)) || e.message);
        if (dup) return uploaded(dup.id, false, true);
        throw e;
      }
      const dup = duplicateOf(u.error);
      if (dup) return uploaded(dup.id, false, true);
      if (u.error) throw new StravaError("fatal", u.error);
      uploadId = u.id_str || String(u.id);
      activityId = u.activity_id || null;
      if (cb.onUploadId) await cb.onUploadId(uploadId);
    }
    // Strava processes the file in the background: poll until it has an activity id.
    const until = now() + POLL_FOR_MS;
    while (!activityId) {
      if (now() >= until) return { status: "processing", uploadId };
      progress("Strava is processing the ride…");
      await sleep(POLL_MS);
      const s = await api("GET", "/uploads/" + encodeURIComponent(uploadId));
      if (s.activity_id) { activityId = s.activity_id; break; }
      if (s.error) {
        const dup = duplicateOf(s.error);
        if (dup) return uploaded(dup.id, false, true);
        throw new StravaError("fatal", s.error);
      }
    }
    // Uploads can't say "virtual ride", so set the type afterwards.
    progress("Marking it as a virtual ride…");
    let virtual = true;
    try { await api("PUT", "/activities/" + encodeURIComponent(activityId), { sport_type: "VirtualRide", trainer: true }); }
    catch (e) { virtual = false; }                       // the ride is on Strava either way; only its type didn't change
    return uploaded(activityId, virtual, false);
  }

  async function disconnect() { await o.kv.del("strava-tokens"); await o.kv.del("strava-state"); }

  return { status, connectUrl, handleRedirect, upload, disconnect, SCOPE };
}

return { createStrava, StravaError, STRAVA_SCOPE: SCOPE };
});
