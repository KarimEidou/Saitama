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
    // Hardware acceleration + WebGL2 are required by the renderer.
    webContentsDebuggingEnabled: true,
    allowMixedContent: false,
    captureInput: false,
    // Keep the WebView background opaque black so there is no white flash
    // before the first rendered frame.
    backgroundColor: '#000000',
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
      backgroundColor: '#000000',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
  },
};

export default config;
