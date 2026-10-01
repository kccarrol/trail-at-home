// Bump this version whenever you change the app files, so phones pick up the update.
const CACHE = "trail-at-home-v11";
const SHELL = ["./", "./index.html", "./app.js", "./climbs.js", "./profileCanvas.js", "./routePrep.js", "./speedModel.js", "./rideSession.js", "./tcx.js", "./rideStore.js", "./strava.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png"];

// Install: fetch every file fresh from the server ({cache: "reload"} skips the browser's own
// short-term cache), so a new version is never stored alongside leftovers from the old one.
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The app's own files: network first (checking with the server every time, which is quick when
// nothing changed), so all files come from the same version; the saved copy is used offline or
// when the connection is too slow. Google Fonts: saved copy first.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !isFont) return;
  const save = res => {
    if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  };
  const cached = () => caches.match(e.request, { ignoreSearch: sameOrigin })
    .then(r => r || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined));
  if (isFont) { e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(save))); return; }
  e.respondWith(new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    // On a weak signal, don't keep the rider waiting: after 4 s use the saved copy if there is one.
    const timer = setTimeout(() => cached().then(finish), 4000);
    fetch(e.request, { cache: "no-cache" }).then(save)
      .then(r => { clearTimeout(timer); r.ok ? finish(r) : cached().then(c => finish(c || r)); })
      .catch(() => { clearTimeout(timer); cached().then(c => { if (c) finish(c); else if (!done) { done = true; resolve(Response.error()); } }); });
  }));
});
