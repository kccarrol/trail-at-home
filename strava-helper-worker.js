/* Trail at Home: Strava token helper (a Cloudflare Worker).
   Holds your Strava client secret so the app never has to. It does two things:
     POST /exchange {code}           -> swaps the sign-in code for tokens
     POST /refresh  {refresh_token}  -> gets a fresh access token
   and relays the three Strava API calls the app makes (upload, check upload, set virtual ride).
   Only requests from your app's address (ALLOWED_ORIGIN) are accepted.

   Setup: see "Sending rides to Strava" in README.md. This file is not part of the app itself and is
   not needed on GitHub; it's pasted into Cloudflare. It contains no secrets: those are set as
   encrypted variables in Cloudflare (STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, ALLOWED_ORIGIN). */
const API = "https://www.strava.com/api/v3";
const RELAY = [
  { method: "POST", re: /^\/api\/uploads$/ },
  { method: "GET", re: /^\/api\/uploads\/\d+$/ },
  { method: "PUT", re: /^\/api\/activities\/\d+$/ }
];

export default {
  async fetch(req, env) {
    const allowed = (env.ALLOWED_ORIGIN || "").replace(/\/+$/, "");
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    const reply = (body, status, type = "application/json") => new Response(body, { status, headers: { ...cors, "Content-Type": type } });
    if (!allowed || origin !== allowed) return new Response("Forbidden", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const path = new URL(req.url).pathname.replace(/\/+$/, "");

    // Token exchange and refresh: add the secret and pass through to Strava.
    if (req.method === "POST" && (path === "/exchange" || path === "/refresh")) {
      let body;
      try { body = await req.json(); } catch (e) { return reply('{"error":"Expected JSON"}', 400); }
      const params = { client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET };
      if (path === "/exchange" && typeof body.code === "string") Object.assign(params, { code: body.code, grant_type: "authorization_code" });
      else if (path === "/refresh" && typeof body.refresh_token === "string") Object.assign(params, { refresh_token: body.refresh_token, grant_type: "refresh_token" });
      else return reply('{"error":"Missing code or refresh_token"}', 400);
      const r = await fetch("https://www.strava.com/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params)
      });
      return reply(await r.text(), r.status);
    }

    // Relay the app's Strava API calls, passing the rider's own access token through.
    const route = RELAY.find(x => x.method === req.method && x.re.test(path));
    if (route) {
      const auth = req.headers.get("Authorization");
      if (!auth || !/^Bearer [\w.-]+$/.test(auth)) return reply('{"error":"Missing token"}', 401);
      const headers = { Authorization: auth };
      const type = req.headers.get("Content-Type");
      if (type) headers["Content-Type"] = type;
      const r = await fetch(API + path.slice(4), {
        method: req.method, headers, body: req.method === "GET" ? undefined : await req.arrayBuffer()
      });
      return reply(await r.text(), r.status, r.headers.get("Content-Type") || "application/json");
    }
    return reply('{"error":"Not found"}', 404);
  }
};
