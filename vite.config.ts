import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
// Explicit `.ts` extension (allowed by `allowImportingTsExtensions`): Vite's
// forthcoming `configLoader: 'native'` cannot resolve an extensionless config
// import and warns on every build without it.
import { basisTranscoderPlugin } from './scripts/stage-basis-transcoder.ts';

/**
 * Vite configuration for the One Punch Man open-world mobile build.
 *
 * IMPORTANT INVARIANTS (do not change without coordinating across workstreams):
 *  - `base: './'` is REQUIRED. Capacitor loads the bundle over `file://` on
 *    Android; absolute `/assets/...` URLs 404 there.
 *  - Binary game assets (.glb/.ktx2/.hdr/.bin/...) are registered via
 *    `assetsInclude` so Vite emits them as files rather than trying to parse them.
 *  - `three` is split into its own chunk so the engine payload can be cached
 *    independently of game code.
 *  - `basisTranscoderPlugin()` must stay registered. It is the ONLY thing that
 *    puts the Basis transcoder where the runtime looks for it; drop it and the
 *    build still succeeds and still boots, just with every texture unparseable.
 */
export default defineConfig({
  // Relative base: mandatory for Capacitor file:// loading.
  base: './',

  // Copies `basis_transcoder.js` + `.wasm` into `assets/basis/`, the directory
  // `KTX2Loader` fetches them from at runtime (`BASIS_TRANSCODER_DIR`,
  // src/assets/constants.ts:56). They must be served verbatim and therefore
  // cannot be imported through the bundler (src/assets/ktx2.ts:151), so nothing
  // in the module graph pulls them in and nothing else would copy them.
  plugins: [basisTranscoderPlugin()],

  resolve: {
    alias: {
      // Keep in sync with `paths` in tsconfig.json.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // Treat game binaries as static assets (hashed + copied, never parsed).
  assetsInclude: [
    '**/*.glb',
    '**/*.gltf',
    '**/*.ktx2',
    '**/*.hdr',
    '**/*.exr',
    '**/*.bin',
    '**/*.basis',
    '**/*.dds',
    '**/*.fbx',
    '**/*.vrm',
  ],

  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
    // Mobile GPUs choke on huge single bundles; warn early.
    chunkSizeWarningLimit: 1500,
    // Inline nothing: Capacitor serves from disk, and inlined base64 bloats
    // the JS parse budget on low-end Android devices.
    assetsInlineLimit: 0,
    cssCodeSplit: true,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules')) return 'vendor';
          return undefined;
        },
        // Stable, predictable asset layout for the Capacitor packager.
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },

  server: {
    host: true,
    port: 5173,
    strictPort: false,
  },

  preview: {
    host: true,
    port: 4173,
    strictPort: false,
  },

  // Pre-bundle three so dev-server cold start stays fast.
  optimizeDeps: {
    include: ['three'],
  },
});
