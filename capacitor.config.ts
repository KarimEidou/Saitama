import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration.
 *
 * NOTE: the `android/` platform directory is intentionally NOT generated here.
 * Running `npx cap add android` is owned by the Android packaging workstream
 * (Task 15). This file only declares the configuration that task will consume.
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
