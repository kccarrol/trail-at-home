# Trail at Home

A small offline app for riding Strava GPX routes on an indoor bike. It stores up to 100 routes on your phone.

## Put it online for free (GitHub Pages)

1. Create a free account at github.com.
2. Create a new public repository, for example `trail-at-home`.
3. Choose "uploading an existing file" and upload everything in this folder, keeping the `icons` folder.
4. In the repository, open Settings, then Pages. Under "Build and deployment", set the source to "Deploy from a branch", pick `main` and `/ (root)`, and save.
5. After a minute or two, your app is at `https://YOUR-USERNAME.github.io/trail-at-home/`.

## Install it on your Android phone

1. Open that link in Chrome.
2. Tap "Install app" at the top of the page, or open Chrome's ⋮ menu and choose "Install app" or "Add to Home screen".
3. Open it from your home screen. After the first load it works without internet.

## Updating the app

If you change any files, open `sw.js` and bump the version (for example `trail-at-home-v2` to `trail-at-home-v3`) before uploading. Phones pick up the new version the next time the app is opened twice.

## Notes

- Routes and settings are stored only on the phone. Uninstalling the app or clearing Chrome's site data deletes them.
- "Connect bike" reads the standard Bluetooth fitness signals: power, cadence, speed and heart rate. When the bike shares power (like the VeloCore), speed is calculated from your watts, your weight and the trail's grade. If the bike only shares speed, that's used directly. Otherwise use the + and − buttons.
- On a VeloCore, start the third-party app workout from Programs on the bike's screen before tapping Connect bike. Close other apps that might already be connected to it.
- "Connect heart rate" pairs a separate chest strap or armband.
- If the bike's Bluetooth drops mid-ride, the app tries to reconnect three times before switching back to the + and − buttons.
- When a new version is uploaded, the app shows a "new version is ready" banner with a Reload button.
