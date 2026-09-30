# Trail at Home

A small offline app for riding Strava GPX routes on an indoor bike. It stores up to 100 routes on your phone.

## Put it online for free (GitHub Pages)

1. Create a free account at github.com.
2. Create a new public repository, for example `trail-at-home`.
3. Choose "uploading an existing file" and upload everything in this folder, keeping the `icons` folder. The app needs all nine scripts: `app.js`, `climbs.js`, `profileCanvas.js`, `routePrep.js`, `speedModel.js`, `rideSession.js`, `tcx.js`, `rideStore.js` and `strava.js`. (`strava-helper-worker.js` and `run-tests.js` aren't part of the app; uploading them does no harm.)
4. In the repository, open Settings, then Pages. Under "Build and deployment", set the source to "Deploy from a branch", pick `main` and `/ (root)`, and save.
5. After a minute or two, your app is at `https://YOUR-USERNAME.github.io/trail-at-home/`.

## Install it on your Android phone

1. Open that link in Chrome.
2. Tap "Install app" at the top of the page, or open Chrome's ⋮ menu and choose "Install app" or "Add to Home screen".
3. Open it from your home screen. After the first load it works without internet.

## Updating the app

If you change any files, open `sw.js` and bump the version (for example `trail-at-home-v6` to `trail-at-home-v7`) before uploading. Phones pick up the new version the next time the app is opened twice.

## Notes

- Routes and settings are stored only on the phone. Uninstalling the app or clearing Chrome's site data deletes them.
- "Connect bike" reads the standard Bluetooth fitness signals: power, cadence, speed and heart rate. When the bike shares power (like the VeloCore), speed is calculated from your watts, your weight and the trail's grade. If the bike only shares speed, the app works out your watts from it and still applies the grade. Otherwise use the + and − buttons.
- Hill difficulty (in Settings) scales how steep hills feel, from 100% (true to the route) down to 0% (everything flat). It changes both your speed and the suggested resistance.
- The ride screen shows the next stretch of the route (1, 2 or 5 km, set in Settings) above a strip of the whole route, both coloured by grade: blue downhill, green 0–3%, yellow 3–6%, orange 6–10%, red 10% and up. Tap the strip to jump to a spot.
- A note appears 1 km before each climb ("Climb in 350 m · 1.2 km · avg 6%") and counts down the rest while you're on it. Tap it to hide it for that climb.
- Every ride is kept under "Ride history" on the route list (the last 50, plus any still waiting to upload). From there or from the finish screen you can download a ride as a TCX file, or upload it to Strava in one tap once Strava is connected.
- If you stop pedaling for 5 seconds, the ride clock pauses until you start again.
- Routes added before version 4 only have elevation, not map positions. Add their GPX files again to update them in place; your progress is kept. A GPX with no elevation is added as a flat route.
- On a VeloCore, start the third-party app workout from Programs on the bike's screen before tapping Connect bike. Close other apps that might already be connected to it.
- "Connect heart rate" pairs a separate chest strap or armband.
- If the bike's Bluetooth drops mid-ride, the ride carries on as if you've stopped pedaling and the app keeps trying to reconnect. A banner lets you switch to the + and − buttons instead.
- When a new version is uploaded, the app shows a "new version is ready" banner with a Reload button.

## Sending rides to Strava

**Without any setup:** tap "Download TCX" on the finish screen or in Ride history. The file goes to your phone's Downloads. To add it to Strava, open strava.com/upload/select in a browser (Strava's phone app can't import files), choose "File", and pick it.

**One-tap upload (one-time setup, about 15 minutes, free).** Strava only hands out upload access to apps that keep a "client secret" private, and a web app can't hide one. So the secret lives in a tiny helper you run for free on Cloudflare, and the app talks to Strava through it.

1. **Create a Strava API app.** On a computer, go to strava.com/settings/api. Name it "Trail at Home", category "Training", website your app's address, and set **Authorization Callback Domain** to just your GitHub Pages host, for example `yourname.github.io` (no `https://`, no path). Note the **Client ID** and **Client Secret**. A new Strava app can only be used by its owner, which is all you need.
2. **Create the helper.** Sign up at dash.cloudflare.com (free plan). Under Workers, create a new Worker from the "Hello World" starter, name it something like `trail-at-home-strava`, and deploy it. Choose "Edit code", replace everything with the contents of `strava-helper-worker.js`, and deploy again.
3. **Give the helper its settings.** In the Worker's Settings, under Variables and Secrets, add three:
   - `STRAVA_CLIENT_ID`: your Client ID
   - `STRAVA_CLIENT_SECRET`: your Client Secret (choose the "Secret" type so it's encrypted)
   - `ALLOWED_ORIGIN`: your app's origin, for example `https://yourname.github.io` (no path, no trailing slash)
   Deploy, and copy the Worker's address (it ends in `.workers.dev`).
4. **Connect the app.** On the route list, open "Strava", then "One-time setup". Enter the Client ID and the helper address, tap "Connect Strava", sign in, and leave "Upload your activities" ticked.

After that, "Upload to Strava" sends the ride, marks it as a trainer ride, and changes its type to Virtual Ride. Rides that can't upload (no signal, Strava busy) wait and go the next time the app opens online. The same ride is never added twice. To remove the app's access later, go to strava.com, Settings, My Apps.

**Privacy:** by default the file includes the route's real GPS positions, so the ride shows on that route's map on Strava. It's labelled a virtual ride, but people may still take it for an outdoor ride. Untick "Include map positions" in the Strava section to leave them out.

## How it's built

- `routePrep.js` turns GPX points into a 10 m grid with smoothed elevation, grade and positions.
- `climbs.js` finds the climbs in a route (3% or steeper for 200 m or more, gaining at least 15 m).
- `profileCanvas.js` draws the elevation profiles.
- `speedModel.js` works out speed from watts, grade, weight, rolling resistance and air drag, with momentum.
- `rideSession.js` runs the ride clock: position, auto-pause, and a once-a-second ride log saved every 30 seconds.
- `rideStore.js` keeps ride history; `tcx.js` turns a ride into a TCX file; `strava.js` connects to and uploads to Strava through the helper in `strava-helper-worker.js`.
- `app.js` is the screens, storage and Bluetooth.
- `run-tests.js` checks the maths. With Node 18 or later installed, run `node run-tests.js` in this folder. It isn't needed on the phone.

In code, ride history is `TAH.rides` (`list()`, `get(id)`) and the ride in progress is `TAH.currentRide`.
