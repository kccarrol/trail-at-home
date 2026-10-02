# Trail at Home

A phone web app (installable PWA) for riding Strava GPX routes on a Bowflex VeloCore indoor bike.
It reads the bike's power over Web Bluetooth, turns power and the route's grade into a virtual
speed, shows the trail ahead, suggests a resistance level, logs each ride, and can upload rides to
Strava. The owner rides with it on an Android phone in Chrome, with the app installed to the home
screen, and is not a developer: explain changes in plain language.

## Rules that matter most

1. **No build step, no runtime dependencies.** GitHub Pages serves these files exactly as they
   are. Plain JavaScript, no bundler, no npm packages in the app, no frameworks.
2. **Bump the version on every change to the app's files, in all three places, to the same number**
   (changes only to tests or docs don't need it):
   - `sw.js`: `const CACHE = "trail-at-home-vN"`
   - `index.html`: `<meta name="app-version" content="N">`
   - `app.js`: `const APP_VERSION = "N"`

   If they don't match, the app refuses to start and shows its Repair message. If `sw.js` isn't
   bumped, phones never fetch the update.
3. **Never lose the rider's data.** Routes, rides and settings live in IndexedDB and localStorage
   on the phone. Schema changes go through `onupgradeneeded` in `db()` (database is at version 3)
   and must keep old records working. Changing route maths means bumping `PREP_VERSION` in
   `routePrep.js`, so saved routes are re-prepared from their stored 10 m grid.
4. **Never put the Strava client secret in the app.** It lives only in Cloudflare's encrypted
   settings, used by `strava-helper-worker.js`.
5. **Run the tests before every commit** (below). Add tests for new behaviour.
6. **New script files** must be added to the `<script>` list in `index.html`, to `SHELL` in
   `sw.js`, and to the module check near the top of `app.js`.

## Tests

- Unit tests (Node 18+, no installs): `node run-tests.js`. 36 tests covering the speed model,
  route prep, climbs, the profile drawing, the ride session, TCX export and the Strava client.
- Browser tests (Playwright, headless Chromium):
  - Setup, once: `pip install playwright && python3 -m playwright install chromium`
  - All suites: `python3 tests/browser/run_browser_tests.py` (about 7 minutes)
  - Some suites: `python3 tests/browser/run_browser_tests.py tabs pages`
  - List: `python3 tests/browser/run_browser_tests.py --list`

  Suites: ride, upgrade, profile, strava, pages, tabs, layout, startup, offline. They use a fake
  VeloCore (`tests/browser/fake-bluetooth.js`), a fake clock, and a fake Strava. Exit code is
  non-zero on any failure.
- Real-world checks the tests can't make: an actual VeloCore over Bluetooth, and a real Strava
  upload. Ask the owner to try these after changes to Bluetooth or Strava code.

## Files

| File | What it does |
|---|---|
| `index.html` | All markup and CSS (one `<style>` block), the start-up guard script, and the script list |
| `app.js` | Screens, storage, Bluetooth, page router, ride history UI, Strava UI, app shell |
| `routePrep.js` | GPX points → 10 m grid with smoothed elevation, grade, positions, climbs; `sampleAt()` |
| `speedModel.js` | Physics: watts, grade, weight, rolling resistance, drag → speed with momentum |
| `rideSession.js` | The ride clock: position, auto-pause, 1 Hz ride log, flushes every 30 s |
| `climbs.js` | Finds climbs (≥3% for ≥200 m, merged across <100 m gaps, ≥15 m gain) |
| `profileCanvas.js` | Draws the look-ahead and whole-route elevation profiles on canvas |
| `tcx.js` | Builds TCX files and ride summaries |
| `rideStore.js` | Ride history in IndexedDB (records plus sample chunks), upload status |
| `strava.js` | Strava sign-in, token refresh, upload, polling, set Virtual Ride, duplicates |
| `strava-helper-worker.js` | Cloudflare Worker holding the client secret; relays the 3 API calls. Not part of the app |
| `sw.js` | Offline cache: network first (`cache: "no-cache"`), saved copy offline; install fetches fresh |
| `run-tests.js`, `tests/browser/` | Tests (not loaded by the app) |

## How the code fits together

- Each helper file is a small UMD module: in the browser it adds functions to `window.TAH`, in
  Node it's `require()`-able for the unit tests. Keep them free of DOM access where they are now.
- `app.js` is one wrapped script with sections marked `/* ========== Name ========== */`.
- **Pages:** home, start, routes, history, info, settings, ride. Each is `<section id="scr-NAME">`.
  Navigation is hash-based (`#routes`) through `go(name, {replace, state})`, `goHome()` and
  `showPage()`. `history.state.depth` counts pages above Home, so "Home" unwinds instead of
  stacking. Tabs replace each other rather than stacking. Each page's refresh is in `ENTER`.
- **Ride lifecycle:** Start a ride (pick route, connect bike) → `openRide()` → `start()`. The
  ride page runs `R.session` (rideSession) driven by `requestAnimationFrame` while visible and a
  250 ms interval otherwise. Settings can be opened mid-ride without ending it; any other page
  ends the ride (pauses, saves the log and the spot on the route). The pinned Finish button pauses
  and opens a choice: Finish route (`endRide("finish")`, sets the route's `done` flag) or Stop for
  now (`endRide("save")`); reaching the end calls `endRide("end")`.
- **Finished routes:** a route is finished when ridden to the end or when `m.done` is set (Finish
  route, or Mark finished on Routes). Use `isDone()` / `isGoing()` in `app.js`; only an in-progress
  route gets Home's Continue card. Riding it again (from the start or where it was finished) clears
  `done`. Old records without `done` behave as before.
- **Start-up guard** (top of `index.html`): if a script fails to load or `app.js` throws before
  finishing, it repairs once automatically (clears the app's caches and service worker, never
  user data), then shows a message with a Repair button. It only repairs when online.
- **Units:** the model works in meters and m/s; the UI shows miles or km via the `fmt*` helpers.
  Grades are percent everywhere.

## Design

Dark only, based on the app icon's colours and bold sports UI references. Tokens are CSS custom
properties at the top of the `<style>` block; use them rather than new hex values.

- Background `--bg #0F1612`, panels `--paper #1A241D`, inputs `--raised #223027`, lines `--line`.
- Text `--ink #EEF2E8`, secondary `--muted #93A398`.
- One accent: trail orange. `--accent #E4641A` for large buttons (white text, large and bold
  only), `--accent-deep #C94F12` behind small white text (4.6:1), `--accent-text #FF9147` for
  orange text on dark.
- Icon-chip colours: gear yellow, ridge blue, hill green (`--gear`, `--ridge`, `--hill`).
- Grade colours on profiles (`--g-*`): blue downhill, green 0–3%, yellow 3–6%, orange 6–10%,
  red 10%+. Trail-sign colours on the ride page are separate (`--green`, `--blue`, `--black`,
  `--descent`). The profile reads its colours from CSS via `readTheme()`; the marker is white.
- Type: Barlow Condensed, bold and uppercase, only for page titles, the Home hero, route names
  and big numbers. Everything else is Barlow, sentence case. No all-caps labels.
- Home must show all four tiles above the tab bar on 360×740, 390×844 and 412×915 (the
  `layout` suite checks this). The ride page keeps Pause, Finish and Settings pinned on screen. During a
  ride (`.in-ride`) the title bar and status label are hidden; paused or auto-paused
  (`.ride-paused`) draws a yellow frame with a tag. No green frame while riding, on purpose: the
  frame only appears when something needs attention.
- Keep text contrast at 4.5:1 or better (3:1 only for large bold text).

UI copy: plain words, sentence case, active voice, says what will happen ("Upload to Strava").
Errors say what went wrong and how to fix it.

## Deploying

The `main` branch is published by GitHub Pages. After a change is merged, the owner opens the
app, waits a few seconds, closes it fully and opens it again. Always ship every file together
(the version check enforces this).

## Known limits and ideas

- Speed tops out at 90 km/h (56 mph); descents can feel fast. One constant in `speedModel.js`.
- Ride history keeps the last 50 rides, plus any still waiting to upload to Strava.
- The light theme was dropped with the redesign; it could return via a second set of tokens.
