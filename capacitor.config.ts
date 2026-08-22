import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration.
 *
 * The `android/` platform directory is GENERATED, not committed — it stays in
 * `.gitignore` because `npm run guard` rejects any tracked `.png` outside
 * `docs/screenshots/`, and a Capacitor project ships 26 launcher/splash PNGs
 * under `android/app/src/main/res/`. Everything in it derives from this file
 * plus `package.json`, so regenerate rather than commit:
 *
 *   npx tsx scripts/android-sdk.ts     # install the SDK (idempotent)
 *   npm run build && npx cap add android
 *   npx tsx scripts/build-apk.ts       # -> android/app/build/outputs/apk/debug/
 */
const config: CapacitorConfig = {
  appId: 'com.saitama.onepunch',
  appName: 'One Punch Man',
  webDir: 'dist',

  // Bundle the web build into the APK rather than loading from a dev server.
  server: {
    androidScheme: 'https',
  },

  android: {
    // `webContentsDebuggingEnabled` is deliberately ABSENT, and setting it is a
    // security bug rather than a rendering setting. It calls
    // `WebView.setWebContentsDebuggingEnabled(true)` in RELEASE builds too, so
    // anything that can reach the devtools socket on the device can read the
    // save data in Preferences and execute JavaScript in the game context —
    // including the `window.__GAME__` handle `src/main.ts` exposes. Capacitor
    // already turns debugging on automatically for debug builds, which is the
    // only place it is wanted. Nothing here affects hardware acceleration or
    // WebGL2: both are Android WebView defaults, not Capacitor configuration.
    //
    // The two below restate WebView defaults so the intent is on the record.
    // `allowMixedContent: false` refuses http subresources under the https
    // scheme configured above. `captureInput: false` keeps the standard
    // keyboard rather than Capacitor's simplified InputConnection.
    allowMixedContent: false,
    captureInput: false,
    // Keep the WebView background opaque black so there is no white flash
    // before the first rendered frame. This — plus the generated launch theme —
    // is the whole boot-flash story. There is deliberately no
    // `plugins.SplashScreen` block: `@capacitor/splash-screen` is not a
    // dependency of this project, so `cap sync` would copy those keys into
    // `android/app/src/main/assets/capacitor.config.json` where nothing reads
    // them, and anyone tuning the flash would edit dead settings.
    backgroundColor: '#000000',
  },
};

export default config;
