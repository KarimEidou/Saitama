/**
 * BASIS TRANSCODER STAGING
 *
 * `KTX2Loader` fetches `basis_transcoder.js` + `.wasm` at RUNTIME, out of
 * `<asset root>/basis/` (`BASIS_TRANSCODER_DIR`, src/assets/constants.ts:56;
 * the URL is assembled in src/assets/registry.ts:165). Nothing in the module
 * graph imports them, so without this plugin `vite build` exits 0 and ships a
 * bundle with no transcoder at that path.
 *
 * That failure is SILENT, which is why it survived: every `.ktx2` still
 * downloads with a 200 and only fails at parse time, so the loader books it as
 * an asset failure rather than an exception. `__GAME_DIAG__.errors` stays
 * empty, no error-count gate fires, and the whole city renders as the
 * violet/black missing-asset checker.
 *
 * The files cannot be imported through the bundler either: `basis_transcoder.js`
 * is a UMD bundle and Vite would rewrite it into an ES module the worker cannot
 * evaluate (src/assets/ktx2.ts:151). So they are COPIED verbatim out of
 * `node_modules/three/examples/jsm/libs/basis/` into:
 *
 *   - `public/assets/basis/` on `buildStart` — this is what `vite dev` serves,
 *     and Vite's public-dir copy carries it into `dist/assets/basis/`, which
 *     `npx cap sync` in turn copies into the APK.
 *   - `<outDir>/assets/basis/` on `closeBundle` — belt and braces for a build
 *     whose `publicDir` is disabled or pointed somewhere else.
 *
 * Note that a build ALSO emits hashed copies at `dist/assets/basis_transcoder-*.js`
 * / `.wasm`, dragged in through three's own `new URL(..., import.meta.url)`
 * graph. Those sit at the wrong path and the loader never asks for them — their
 * presence is not evidence that staging happened.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Repo root — this file lives in `scripts/`. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where three ships the transcoder; same resolution the harness scripts use. */
const BASIS_SRC = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');

/** Directory name the loader appends to the asset root — see `BASIS_TRANSCODER_DIR`. */
const BASIS_DIR = 'basis';

/**
 * The two files `KTX2Loader` actually fetches. three ships a README beside
 * them; copying it would only pad the APK.
 */
export const BASIS_TRANSCODER_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'] as const;

/**
 * Copy the transcoder into `<assetRoot>/basis/`, returning the paths written.
 *
 * Safe to call repeatedly: the copy is unconditional, so a stale transcoder
 * left over from an older `three` is always overwritten.
 */
export function stageBasisTranscoder(assetRoot: string): string[] {
  const destination = path.join(assetRoot, BASIS_DIR);
  mkdirSync(destination, { recursive: true });

  const written: string[] = [];
  for (const file of BASIS_TRANSCODER_FILES) {
    const from = path.join(BASIS_SRC, file);
    if (!existsSync(from)) {
      // Fail the build LOUDLY. A half-installed `npm ci` that quietly drops the
      // transcoder is otherwise indistinguishable from a good build until the
      // game boots into a checkerboard city with zero reported errors.
      throw new Error(
        `Basis transcoder missing: ${from} — reinstall dependencies (\`npm ci\`). ` +
          'Without it KTX2Loader cannot decode a single texture.'
      );
    }
    const to = path.join(destination, file);
    copyFileSync(from, to);
    written.push(to);
  }
  return written;
}

/**
 * Vite plugin that stages the transcoder for both `vite dev` and `vite build`.
 *
 * Both hooks no-op under Vitest. There is no `vitest.config.ts`, so `vitest run`
 * loads THIS config file and spins up a Vite server that fires `buildStart` —
 * and the test suite has no business writing into the working tree.
 */
export function basisTranscoderPlugin(): Plugin {
  // Defaults cover a hook invoked before `configResolved` (only tests do that).
  let publicAssets: string | undefined = path.join(ROOT, 'public', 'assets');
  let outputAssets = path.join(ROOT, 'dist', 'assets');

  return {
    name: 'stage-basis-transcoder',

    configResolved(config) {
      // `publicDir: false` resolves to '', and joining that would stage into a
      // stray `./assets/basis` next to the cwd. Skip it; `closeBundle` still
      // puts a copy in the build output.
      publicAssets = config.publicDir === '' ? undefined : path.join(config.publicDir, 'assets');
      outputAssets = path.resolve(config.root, config.build.outDir, config.build.assetsDir);
    },

    buildStart() {
      if (process.env.VITEST !== undefined) return;
      if (publicAssets !== undefined) stageBasisTranscoder(publicAssets);
    },

    closeBundle() {
      if (process.env.VITEST !== undefined) return;
      stageBasisTranscoder(outputAssets);
    },
  };
}
