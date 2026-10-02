#!/usr/bin/env python3
"""Trail at Home browser tests.

Drives the real app in headless Chromium with a fake VeloCore (fake-bluetooth.js), a fake clock
(so a 10-minute ride takes seconds) and, for Strava, a fake Strava and token helper. Every check
passes or fails on its own; the run exits non-zero if anything failed.

Setup, once:   pip install playwright && python3 -m playwright install chromium
Run all:       python3 tests/browser/run_browser_tests.py
Run some:      python3 tests/browser/run_browser_tests.py ride strava
List suites:   python3 tests/browser/run_browser_tests.py --list

A full run takes several minutes, mostly the suites that ride a whole route (ride, strava).
"""
import functools, http.server, json, os, re, shutil, socketserver, sys, tempfile, threading, time, traceback
import urllib.parse, xml.etree.ElementTree as ET

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright isn't installed. Run: pip install playwright && python3 -m playwright install chromium")

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FAKE_BT = os.path.join(os.path.dirname(__file__), "fake-bluetooth.js")
PHONES = [(360, 740), (390, 844), (412, 915)]          # small, typical and large Android screens


# ---------- results ----------
class Results:
    def __init__(self): self.passed = 0; self.failed = []; self.suite = ""
    def check(self, name, ok, detail=""):
        if ok: self.passed += 1; print(f"    ok    {name}")
        else: self.failed.append(f"{self.suite}: {name} ({detail})"); print(f"    FAIL  {name}  [{detail}]")
R = Results()
check = R.check


# ---------- a local web server for a folder ----------
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")    # tests shouldn't depend on the browser's HTTP cache
        super().end_headers()

def serve(folder):
    handler = functools.partial(Quiet, directory=folder)
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://localhost:{httpd.server_address[1]}"


# ---------- test routes (GPX files) ----------
def gpx(name, segs, ele=True, spacing=5):
    """A straight route heading north. segs: [(length m, grade %)]."""
    pts, d, h = [], 0, 100.0
    for length, g in segs:
        x = 0
        while x < length:
            pts.append(f'<trkpt lat="{37 + d / 111195:.7f}" lon="-120.6000000">' + (f"<ele>{h:.2f}</ele>" if ele else "") + "</trkpt>")
            d += spacing; x += spacing; h += g / 100 * spacing
    return f'<?xml version="1.0"?><gpx version="1.1" creator="tests"><trk><name>{name}</name><trkseg>{"".join(pts)}</trkseg></trk></gpx>'

FIX = tempfile.mkdtemp(prefix="tah-fixtures-")
def fixture(fname, *a, **k):
    path = os.path.join(FIX, fname)
    if not os.path.exists(path): open(path, "w").write(gpx(*a, **k))
    return path
HILL = lambda: fixture("hill.gpx", "Test hill", [(1000, 0), (1000, 8), (1500, -6)])   # flat, 8% climb, descent
FLAT = lambda: fixture("flat.gpx", "No elevation", [(2000, 0)], ele=False)
OLD = lambda: fixture("legacy.gpx", "Old route", [(3000, 2)])
LONG = lambda: fixture("long.gpx", "Long valley", [(12000, 1), (12000, -1)], spacing=20)
SHORT = lambda: fixture("short.gpx", "Short sprint", [(1500, 0)])


# ---------- helpers ----------
def new_page(browser, viewport=(400, 860), clock=True, bt=True, **ctx_opts):
    ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, **ctx_opts)
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    if bt: page.add_init_script(path=FAKE_BT)
    if clock: page.clock.install()
    return ctx, page

def add_routes(page, base, files):
    page.goto(base + "/index.html#routes")
    page.set_input_files("#file", files)
    page.wait_for_function("document.getElementById('status').textContent.includes('Added')")

def ride_route(page, name, watts, connect=True):
    """From Browse routes: pick a route, connect the fake bike, start riding."""
    page.locator("#routes .route", has_text=name).locator("button.open").click()
    page.wait_for_selector("#step2:not([hidden])")
    if connect:
        page.click('#startBt [data-bt="bike"]'); page.clock.run_for(3500)
        page.evaluate(f"__bt.power={watts}")
    page.click("#beginRide"); page.wait_for_function("window.TAH.currentRide")

def kmh(page): return float(page.text_content("#spd")) * 1.609344   # the app shows mph by default
def visible_page(page):
    return next(n for n in ["home", "start", "routes", "history", "info", "settings", "ride"] if page.is_visible(f"#scr-{n}"))
def no_errors(page): check("no script errors", not page.errors, "; ".join(page.errors[:2]))

MARKER_JS = """([id, fromM, toM]) => {
  const c = document.getElementById(id), ctx = c.getContext('2d'), st = TAH.currentRide.state;
  const w = c.width, css = c.getBoundingClientRect().width, dpr = w / css, y = Math.round(c.height * 0.05);
  const row = ctx.getImageData(0, y, w, 1).data, hits = [];
  for (let x = 0; x < w; x++) if (row[x*4] > 225 && row[x*4+1] > 230 && row[x*4+2] > 215) hits.push(x);   // the white marker
  const from = fromM ?? 0, to = toM ?? TAH.currentRide.route.totalDistM;
  const want = (st.distM - from) / (to - from) * css;
  return hits.length ? Math.abs((hits[0] + hits[hits.length - 1]) / 2 / dpr - want) : null;
}"""


# ================= suites =================
def suite_ride(browser, base):
    """Speed from power and grade, Bluetooth drop and reconnect, auto-pause, ride log, finish."""
    ctx, page = new_page(browser)
    add_routes(page, base, [HILL(), FLAT()])
    check("a GPX without elevation imports as a flat route", "rides flat" in page.text_content("#status"), page.text_content("#status"))
    ride_route(page, "Test hill", 200)
    page.clock.run_for(120_000)
    v = kmh(page)
    check("200 W on the flat settles near 28 km/h", abs(v - 28) <= 1, f"{v:.1f} km/h")
    check("speed label says it comes from power", "from your power" in page.text_content("#spdL"))
    page.clock.run_for(240_000)
    v = kmh(page)
    check("200 W on the 8% climb settles near 9 km/h", abs(v - 9) <= 1.2, f"{v:.1f} km/h at {page.text_content('#grade')}%")
    page.evaluate("__bt.drop()"); page.clock.run_for(2000)
    check("a Bluetooth drop shows the reconnect banner", page.is_visible("#lostBanner"))
    page.clock.run_for(20_000)
    check("while disconnected the ride coasts at 0 W to a stop", float(page.text_content("#spd")) == 0 and page.text_content("#mPow") == "0")
    check("stopping auto-pauses the ride", "Auto-paused" in page.text_content("#rideState"))
    t = page.text_content("#mTime"); page.clock.run_for(15_000)
    check("the clock is frozen while auto-paused", page.text_content("#mTime") == t)
    page.evaluate("__bt.restore()"); page.clock.run_for(8000)
    check("the bike reconnects and the banner goes", not page.is_visible("#lostBanner") and "Reconnected" in page.text_content("#btMsg"))
    check("pedaling again resumes the ride", float(page.text_content("#spd")) > 0 and page.text_content("#rideState") == "Riding")
    st = page.evaluate("({n: TAH.currentRide.samples.length, e: TAH.currentRide.state.elapsedS})")
    check("the ride log has one sample per second of riding", abs(st["n"] - st["e"]) <= 2, f"{st['n']} samples, {st['e']:.0f} s")
    page.clock.run_for(600_000)
    check("reaching the end shows the finish summary", page.is_visible("#summary") and page.text_content("#sumTitle") == "Route finished")
    check("nothing left to go at the finish", page.text_content("#sLeft") == "0.00")
    page.clock.run_for(3000)
    logs = page.evaluate("TAH.rides.list().then(async l => ({count: l.length, first: l[0], n: (await TAH.rides.samples(l[0].id)).length}))")
    check("the finished ride is saved with all its samples", logs["count"] == 1 and logs["first"]["finished"] and logs["n"] == logs["first"]["sampleCount"] > 500, json.dumps({k: logs["first"].get(k) for k in ("finished", "sampleCount")}))
    page.click("#rideSettings")
    page.fill("#setDiff", "50"); page.dispatch_event("#setDiff", "change")
    check("hill difficulty is saved", json.loads(page.evaluate("localStorage.getItem('tah-settings')"))["difficulty"] == 50)
    no_errors(page); ctx.close()


def suite_upgrade(browser, base):
    """Routes saved by the very first version (elevation only, database v1) still work and upgrade."""
    ctx, page = new_page(browser, clock=False, bt=False)
    page.goto(base + "/README.md")
    page.evaluate("""() => new Promise((res, rej) => {
      const r = indexedDB.open("trail-at-home", 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("meta", {keyPath: "id"}); r.result.createObjectStore("profiles", {keyPath: "id"}); };
      r.onsuccess = () => { const d = r.result, t = d.transaction(["meta", "profiles"], "readwrite");
        const e = new Float32Array(301); for (let i = 0; i < 301; i++) e[i] = 100 + i * 10 * 0.02;
        t.objectStore("meta").put({id: "old1", name: "Old route", total: 3000, gain: 60, spark: null, added: 1, lastRidden: 2, pos: 1200, stats: {secs: 300, dist: 1200, joules: 0, powSecs: 0}});
        t.objectStore("profiles").put({id: "old1", e});
        t.oncomplete = () => { d.close(); res(); }; t.onerror = () => rej(t.error); };
    })""")
    page.goto(base + "/index.html#routes"); page.wait_for_selector("#routes .route")
    check("old routes get the re-add notice", page.is_visible("#legacy"))
    page.click("#routes .route .open"); page.click("#beginRide"); page.wait_for_selector("#scr-ride:not([hidden])")
    check("an old route opens at its saved spot", page.text_content("#sDist") == "0.75", page.text_content("#sDist"))
    check("an old route has its grade", page.text_content("#grade") == "2.0", page.text_content("#grade"))
    page.click("#go"); page.click("#back"); page.click('[data-tab="routes"]')
    page.set_input_files("#file", [OLD()])
    page.wait_for_function("document.getElementById('status').textContent.includes('Updated')")
    check("re-adding its GPX updates it in place", page.locator("#routes .route").count() == 1 and not page.is_visible("#legacy"))
    db = page.evaluate("""() => new Promise(res => { const r = indexedDB.open("trail-at-home"); r.onsuccess = () =>
      r.result.transaction("profiles").objectStore("profiles").get("old1").onsuccess = e => { const p = e.target.result;
        res({v: r.result.version, hasLat: !!p.lat, prep: p.prep && p.prep.prepVersion}); }; })""")
    check("the database upgraded and the route now has map positions", db["v"] >= 3 and db["hasLat"] and db["prep"] >= 2, json.dumps(db))
    no_errors(page); ctx.close()


def suite_profile(browser, base):
    """Elevation profile: climbs, climb note, marker accuracy, rotation."""
    ctx, page = new_page(browser, device_scale_factor=3)
    add_routes(page, base, [HILL(), FLAT()])
    check("route cards show grade-coloured outlines", page.locator("#routes svg.pv").count() == 2)
    ride_route(page, "Test hill", 200)
    climbs = page.evaluate("TAH.currentRide.route.climbs")
    check("the 8% climb is found", len(climbs) == 1 and abs(climbs[0]["startM"] - 1000) <= 60 and 7 < climbs[0]["avgGrade"] < 9, json.dumps(climbs))
    note = lambda: page.text_content("#callout").replace("\u00a0", " ")     # the note keeps its parts together with no-break spaces
    page.clock.run_for(1000)
    check("the climb note shows within 1 km of the climb", page.is_visible("#callout") and note().startswith("Climb in"), note())
    for _ in range(60):
        page.clock.run_for(4000)
        if page.evaluate("TAH.currentRide.state.distM") > 1300: break
    check("on the climb the note counts down", note().startswith("On climb"), note())
    total = page.evaluate("TAH.currentRide.route.totalDistM"); L = 2000
    def ahead_window():
        d = page.evaluate("TAH.currentRide.state.distM"); f = max(0, min(d - 0.15 * L, total - L)); return [f, f + L]
    s = page.evaluate(MARKER_JS, ["strip", None, None]); a = page.evaluate(MARKER_JS, ["ahead", *ahead_window()])
    check("the whole-route marker is within 1 px of the rider", s is not None and s <= 1, s)
    check("the look-ahead marker is within 1 px of the rider", a is not None and a <= 1, a)
    page.set_viewport_size({"width": 860, "height": 400}); page.clock.run_for(600)
    check("rotating the phone keeps the ride going", page.evaluate("TAH.currentRide.state.running"))
    s = page.evaluate(MARKER_JS, ["strip", None, None])
    check("after rotating, the marker is still within 1 px", s is not None and s <= 1, s)
    page.set_viewport_size({"width": 400, "height": 860}); page.clock.run_for(600)
    page.evaluate("TAH.currentRide.jumpTo(700)"); page.clock.run_for(500)
    page.click("#callout"); page.clock.run_for(2000)
    check("tapping the climb note hides it", not page.is_visible("#callout"))
    cost = page.evaluate("""() => { const r = TAH.currentRide.route, c = document.createElement('canvas'); c.width = 1200; c.height = 360;
      const x = c.getContext('2d'); x.setTransform(3, 0, 0, 3, 0, 0); const th = {descent:'#00f',easy:'#0f0',moderate:'#ff0',hard:'#f80',steep:'#f00',line:'#000',text:'#555',marker:'#fff',bg:'#000',done:'rgba(0,0,0,.6)'};
      const n = 200, t0 = performance.now(); for (let i = 0; i < n; i++) TAH.drawProfile(x, r, {fromM: i, toM: i + 2000, currentM: i + 300, done: true, dot: true, width: 400, height: 120, theme: th, axis: m => m.toFixed(0)});
      return (performance.now() - t0) / n; }""")
    check("drawing a look-ahead frame takes under 2 ms", cost < 2, f"{cost:.3f} ms")
    no_errors(page); ctx.close()


def suite_strava(browser, base):
    """Connecting Strava, TCX download, upload, offline queue, duplicates, retry on reopen (all against a fake Strava)."""
    HELPER = "https://helper.test"
    state = {"posts": [], "polls": 0, "puts": [], "ext": set()}
    cors = {"Access-Control-Allow-Origin": base, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"}
    def helper(route, req):
        if req.method == "OPTIONS": return route.fulfill(status=204, headers=cors)
        path = urllib.parse.urlparse(req.url).path
        j = lambda code, body: route.fulfill(status=code, headers={**cors, "Content-Type": "application/json"}, body=json.dumps(body))
        if path == "/exchange": return j(200, {"access_token": "AT", "refresh_token": "RT", "expires_at": 4102444800, "athlete": {"firstname": "Kane"}})
        if path == "/api/uploads" and req.method == "POST":
            body = req.post_data_buffer or b""
            ext = re.search(rb'name="external_id"\r\n\r\n([^\r]+)', body).group(1).decode()
            state["posts"].append({"ext": ext, "trainer": b'name="trainer"\r\n\r\n1' in body, "tcx": b"<?xml" in body})
            if ext in state["ext"]: return j(201, {"id": 2, "id_str": "2", "error": "ride.tcx duplicate of <a href='/activities/777'>x</a>"})
            state["ext"].add(ext); return j(201, {"id": 1, "id_str": "1", "error": None, "activity_id": None})
        if path == "/api/uploads/1": state["polls"] += 1; return j(200, {"id_str": "1", "error": None, "activity_id": 777 if state["polls"] >= 2 else None})
        if path == "/api/activities/777" and req.method == "PUT": state["puts"].append(json.loads(req.post_data)); return j(200, {"id": 777})
        return j(404, {"message": "not found"})
    def authorize(route, req):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(req.url).query)
        state["scope"] = q["scope"][0]
        back = q["redirect_uri"][0] + "?" + urllib.parse.urlencode({"state": q["state"][0], "code": "abc", "scope": "read,activity:write,activity:read_all"})
        route.fulfill(status=302, headers={"Location": back})
    ctx, page = new_page(browser, viewport=(400, 900), clock=False, accept_downloads=True)
    ctx.route(HELPER + "/**", helper); ctx.route("https://www.strava.com/oauth/authorize*", authorize)
    add_routes(page, base, [HILL()])
    page.goto(base + "/index.html#settings"); page.wait_for_timeout(300)
    page.click("#setupBox > summary")
    page.fill("#setClientId", "123456"); page.dispatch_event("#setClientId", "change")
    page.fill("#setHelper", HELPER); page.dispatch_event("#setHelper", "change")
    page.click("#stravaConnect")
    page.wait_for_function("document.getElementById('stravaMsg').textContent.includes('Connected')", timeout=10000)
    check("connecting asks for upload and private-activity access", state["scope"] == "activity:write,activity:read_all", state.get("scope"))
    check("after signing in, Settings says connected", "Connected as Kane" in page.text_content("#stravaState"))
    page.reload(); page.wait_for_timeout(500)
    check("the connection survives a restart", "Connected" in page.text_content("#stravaState"))
    page.clock.install()
    page.goto(base + "/index.html#routes"); page.wait_for_selector("#routes .route")
    ride_route(page, "Test hill", 320)
    for _ in range(40):
        page.clock.run_for(30_000)
        if page.is_visible("#summary"): break
    page.clock.run_for(2000)
    check("the finish summary offers Upload and Download", page.is_visible("#sumUp") and page.is_visible("#sumTcx"))
    with page.expect_download() as dl: page.click("#sumTcx")
    raw = open(dl.value.path(), "rb").read()
    ns = {"t": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2", "x": "http://www.garmin.com/xmlschemas/ActivityExtension/v2"}
    root = ET.fromstring(raw)
    tps = root.findall(".//t:Trackpoint", ns)
    check("the TCX file is valid XML starting with the declaration", raw.startswith(b"<?xml"))
    check("the TCX has a point per second with power and position", len(tps) > 400 and len(root.findall(".//x:Watts", ns)) == len(tps) == len(root.findall(".//t:Position", ns)), f"{len(tps)} points")
    times = [t.text for t in root.findall(".//t:Trackpoint/t:Time", ns)]
    check("TCX times always increase", all(a < b for a, b in zip(times, times[1:])))
    ctx.set_offline(True); page.click("#sumUp"); page.clock.run_for(500)
    page.wait_for_function("document.getElementById('sumMsg').textContent.includes('online')", timeout=5000)
    check("uploading offline waits instead of failing", len(state["posts"]) == 0)
    ctx.set_offline(False); page.clock.run_for(1000)
    for _ in range(20):
        page.clock.run_for(2500); page.wait_for_timeout(100)
        if "virtual ride" in page.text_content("#sumMsg"): break
    check("back online, the ride uploads as a virtual ride", "On Strava as a virtual ride" in page.text_content("#sumMsg"), page.text_content("#sumMsg"))
    check("the upload is a trainer ride with TCX data", state["posts"] and state["posts"][0]["trainer"] and state["posts"][0]["tcx"])
    check("the activity type was set to Virtual Ride", state["puts"] == [{"sport_type": "VirtualRide", "trainer": True}], state["puts"])
    check("the summary links to the Strava activity", page.get_attribute("#sumMsg a", "href") == "https://www.strava.com/activities/777")
    page.click("#back"); page.clock.run_for(500); page.click('[data-tab="history"]'); page.clock.run_for(500); page.wait_for_timeout(300)
    rid = page.evaluate("TAH.rides.list().then(l => l[0].id)")
    page.evaluate(f"TAH.rides.setUpload('{rid}', {{status: 'none'}})"); page.evaluate("dispatchEvent(new Event('online'))"); page.clock.run_for(500)
    page.wait_for_selector(".ride [data-act=up]", timeout=5000); page.locator(".ride [data-act=up]").click()
    for _ in range(10):
        page.clock.run_for(2000); page.wait_for_timeout(100)
        if "Already" in page.text_content(".ride .upst"): break
    check("uploading the same ride again is recognised as a duplicate", "Already on Strava" in page.text_content(".ride .upst"))
    page.evaluate(f"TAH.rides.setUpload('{rid}', {{status: 'pending'}})"); state["ext"].clear(); n = len(state["posts"])
    page.reload(); page.wait_for_selector("#scr-history:not([hidden])")
    status = None
    for _ in range(15):
        page.clock.run_for(2000); page.wait_for_timeout(100)
        status = page.evaluate(f"TAH.rides.get('{rid}', false).then(r => r.upload.status)")
        if status == "uploaded": break
    check("a ride left waiting uploads when the app reopens", status == "uploaded" and len(state["posts"]) - n == 1, status)
    no_errors(page); ctx.close()


def suite_pages(browser, base):
    """Home, Browse routes filters, the two-step start, ride states, Settings mid-ride, End ride."""
    ctx, page = new_page(browser, viewport=(390, 860), clock=False)
    add_routes(page, base, [HILL(), LONG(), SHORT()])
    names = lambda: page.locator("#routes .route b").all_text_contents()
    check("routes list newest first", names()[0] == "Short sprint", names())
    page.select_option("#rSort", "long"); check("sort longest first", names()[0] == "Long valley", names())
    page.select_option("#rSort", "recent"); page.fill("#rSearch", "hill"); check("search by name", names() == ["Test hill"], names())
    page.fill("#rSearch", "")
    page.locator("#routes .route", has_text="Short sprint").locator('[data-act="ride"]').click()
    check("Ride on a route card goes straight to the bike step", page.is_visible("#step2") and page.text_content("#picked b") == "Short sprint")
    page.go_back(); check("back returns to Browse routes", visible_page(page) == "routes")
    page.goto(base + "/index.html"); page.wait_for_timeout(300)
    page.click('[data-tab="start"]'); check("the Ride tab opens step 1", page.is_visible("#step1"))
    page.fill("#pickSearch", "hill"); page.locator("#pickList button.open").first.click()
    check("picking a route opens step 2", page.is_visible("#step2"))
    page.go_back(); check("back returns to step 1", page.is_visible("#step1"))
    page.locator("#pickList button.open").first.click()
    page.clock.install()
    page.click('#startBt [data-bt="bike"]'); page.clock.run_for(3500)
    check("the bike connects from the start step", page.locator('#startBt [data-bt="bike"]').text_content() == "Disconnect bike")
    page.evaluate("__bt.power=220"); page.click("#beginRide"); page.wait_for_function("window.TAH.currentRide"); page.clock.run_for(8000)
    check("Start ride begins riding", page.text_content("#rideState") == "Riding" and page.text_content("#go") == "Pause" and page.is_visible("#endRide"))
    page.click("#go"); page.clock.run_for(500)
    check("Pause shows the paused state", page.text_content("#rideState") == "Paused" and page.text_content("#go") == "Resume")
    page.click("#go"); page.clock.run_for(60_000)
    d0 = page.evaluate("TAH.currentRide.state.distM"); page.click("#rideSettings"); page.clock.run_for(10_000)
    check("Settings mid-ride keeps the ride going", page.evaluate("TAH.currentRide.state.running") and page.is_visible("#scr-settings [data-back]"))
    check("the tab bar is hidden mid-ride", page.is_hidden("#tabbar"))
    page.click("#scr-settings [data-back]"); page.clock.run_for(1000)
    check("Back to ride returns to the ride, still moving", visible_page(page) == "ride" and page.evaluate("TAH.currentRide.state.distM") - d0 > 50)
    page.click("#endRide"); page.clock.run_for(1500); page.wait_for_timeout(300)
    check("End ride saves it and shows a summary", page.text_content("#sumTitle") == "Ride saved" and page.text_content("#go") == "Continue route")
    page.click("#back"); page.clock.run_for(500); page.wait_for_timeout(300)
    check("Home features the route in progress", page.text_content("#hero .kicker") == "Continue your ride" and page.text_content("#hero h2") == "Test hill")
    page.click('#hero [data-hero="ride"]')
    check("Continue ride opens the bike step with Where you left off", page.is_visible("#step2") and page.is_visible("#fromBox"))
    page.check('input[name="from"][value="begin"]'); page.click("#beginRide"); page.wait_for_function("window.TAH.currentRide"); page.clock.run_for(500)
    check("The beginning restarts the route from 0", page.evaluate("TAH.currentRide.state.distM") < 20)
    no_errors(page); ctx.close()


def suite_tabs(browser, base):
    """Tab bar: tabs don't pile up history, back from any tab goes Home, hidden in the start flow."""
    ctx, page = new_page(browser, viewport=(390, 844), clock=False, bt=False)
    page.goto(base + "/index.html#routes"); page.click("#sample"); page.wait_for_selector("#routes .route")
    page.goto(base + "/index.html"); page.wait_for_timeout(300)
    for t in ["routes", "history", "settings"]: page.click(f'[data-tab="{t}"]'); page.wait_for_timeout(100)
    check("the current tab is highlighted", page.get_attribute('[aria-current="page"]', "data-tab") == "settings")
    page.go_back(); page.wait_for_timeout(200)
    check("back from a tab goes Home", visible_page(page) == "home")
    for t in ["routes", "history", "settings"]:
        page.click(f'[data-tab="{t}"]'); page.wait_for_timeout(100)
        check(f"the {t.title()} tab opens its page", visible_page(page) == t)
        page.click('[data-tab="home"]'); page.wait_for_timeout(200)
        check(f"the Home tab returns from {t.title()}", visible_page(page) == "home")
    page.click('[data-tab="start"]'); check("the tab bar hides in the start flow", page.is_hidden("#tabbar"))
    page.goto(base + "/index.html#routes"); page.wait_for_timeout(300)
    page.evaluate("window.scrollTo(0, 0)")
    page.locator("#routes .route button.open").first.click(); page.wait_for_timeout(100)
    page.go_back(); page.wait_for_timeout(200)
    check("back from a deep link still lands on a page", visible_page(page) in ("routes", "home"))
    no_errors(page); ctx.close()


def suite_layout(browser, base):
    """On common phone sizes: Home's buttons fit above the tab bar, and the ride buttons are on screen."""
    for w, h in PHONES:
        ctx, page = new_page(browser, viewport=(w, h), clock=False)
        add_routes(page, base, [HILL()])
        page.locator("#routes .route button.open").click(); page.click("#beginRide"); page.wait_for_function("window.TAH.currentRide")
        page.evaluate("TAH.currentRide.jumpTo(500)"); page.wait_for_timeout(300)
        go = page.evaluate("document.getElementById('go').getBoundingClientRect().bottom")
        check(f"{w}x{h}: Pause and End ride are on screen", go <= h, f"bottom at {go:.0f}")
        page.click("#endRide"); page.click("#back"); page.wait_for_timeout(400)
        tiles = page.evaluate("Math.max(...[...document.querySelectorAll('.tile')].map(t => t.getBoundingClientRect().bottom))")
        bar = page.evaluate("document.getElementById('tabbar').getBoundingClientRect().top")
        check(f"{w}x{h}: all Home buttons fit above the tab bar", tiles <= bar, f"{tiles - bar:.0f}px over")
        no_errors(page); ctx.close()


def suite_startup(browser, base):
    """Start-up guard: mismatched or missing files show a Repair message instead of dead buttons."""
    tmp = tempfile.mkdtemp(prefix="tah-startup-")
    try:
        for case in ("ok", "oldapp", "missing"):
            shutil.copytree(ROOT, os.path.join(tmp, case), ignore=shutil.ignore_patterns(".git", "tests", "node_modules"))
        app = os.path.join(tmp, "oldapp", "app.js")
        s = open(app).read(); open(app, "w").write(re.sub(r'const APP_VERSION = "\d+";', 'const APP_VERSION = "0";', s, count=1))
        os.remove(os.path.join(tmp, "missing", "strava.js"))
        httpd, url = serve(tmp)
        for case, label in [("ok", "all files current"), ("oldapp", "app.js from another version"), ("missing", "a file missing")]:
            ctx, page = new_page(browser, viewport=(390, 844), clock=False, bt=False)
            page.goto(f"{url}/{case}/index.html"); page.wait_for_timeout(1500)
            shown = page.is_visible(".bootfail")
            if case == "ok":
                page.click('[data-tab="routes"]'); page.wait_for_timeout(200)
                check(f"{label}: no error, buttons work", not shown and page.is_visible("#scr-routes"))
            else:
                why = page.text_content(".bootfail .why") if shown else ""
                check(f"{label}: shows the Repair message", shown, why)
                if case == "missing": check("the message names the missing file", "strava.js" in why, why)
            ctx.close()
        httpd.shutdown()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def suite_offline(browser, base):
    """Offline cache: the app starts offline, and an update arrives as one consistent version."""
    tmp = tempfile.mkdtemp(prefix="tah-offline-")
    try:
        site = os.path.join(tmp, "site")
        shutil.copytree(ROOT, site, ignore=shutil.ignore_patterns(".git", "tests", "node_modules"))
        httpd, url = serve(site)
        ctx, page = new_page(browser, viewport=(390, 844), clock=False, bt=False)
        page.goto(url + "/index.html"); page.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller", timeout=15000)
        page.click('[data-tab="routes"]'); page.click("#sample"); page.wait_for_selector("#routes .route")
        ctx.set_offline(True); page.goto(url + "/index.html"); page.wait_for_timeout(1500)
        page.click('[data-tab="routes"]'); page.wait_for_timeout(300)
        check("the app starts and works offline", not page.is_visible(".bootfail") and page.locator("#routes .route").count() == 1)
        ctx.set_offline(False)
        # Publish a new version, the way an update would arrive.
        cur = int(re.search(r'const APP_VERSION = "(\d+)";', open(os.path.join(site, "app.js")).read()).group(1)); new = cur + 1
        for f, pat, rep in [("app.js", r'const APP_VERSION = "\d+";', f'const APP_VERSION = "{new}";'),
                            ("index.html", r'<meta name="app-version" content="\d+">', f'<meta name="app-version" content="{new}">'),
                            ("sw.js", r'trail-at-home-v\d+', f'trail-at-home-v{new}')]:
            p = os.path.join(site, f); s = open(p).read(); open(p, "w").write(re.sub(pat, rep, s, count=1))
        page.goto(url + "/index.html"); page.wait_for_timeout(2500); page.goto(url + "/index.html"); page.wait_for_timeout(1500)
        v = page.evaluate("document.querySelector('meta[name=app-version]').content")
        caches = page.evaluate("caches.keys()")
        check("an update arrives as one version with the old cache removed", v == str(new) and caches == [f"trail-at-home-v{new}"] and not page.is_visible(".bootfail"), f"page {v}, caches {caches}")
        page.click('[data-tab="routes"]'); page.wait_for_timeout(300)
        check("routes are kept through the update", page.locator("#routes .route").count() == 1)
        ctx.close(); httpd.shutdown()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


SUITES = {"ride": suite_ride, "upgrade": suite_upgrade, "profile": suite_profile, "strava": suite_strava, "pages": suite_pages,
          "tabs": suite_tabs, "layout": suite_layout, "startup": suite_startup, "offline": suite_offline}


def main():
    args = sys.argv[1:]
    if "--list" in args:
        for n, f in SUITES.items(): print(f"{n:9} {f.__doc__.strip().splitlines()[0]}")
        return
    unknown = [a for a in args if a not in SUITES]
    if unknown: sys.exit(f"Unknown suite(s): {', '.join(unknown)}. Use --list to see them.")
    chosen = args or list(SUITES)
    httpd, base = serve(ROOT)
    start = time.time()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name in chosen:
            R.suite = name
            print(f"\n{name}: {SUITES[name].__doc__.strip().splitlines()[0]}")
            t0 = time.time()
            try: SUITES[name](browser, base)
            except Exception as e:
                R.failed.append(f"{name}: crashed ({type(e).__name__}: {str(e).splitlines()[0][:160]})")
                print(f"    CRASH {type(e).__name__}: {e}"); traceback.print_exc(limit=1)
            print(f"    ({time.time() - t0:.0f} s)")
        browser.close()
    httpd.shutdown(); shutil.rmtree(FIX, ignore_errors=True)
    print(f"\n{R.passed} checks passed, {len(R.failed)} failed, in {time.time() - start:.0f} s.")
    for f in R.failed: print("  FAIL", f)
    sys.exit(1 if R.failed else 0)


if __name__ == "__main__":
    main()
