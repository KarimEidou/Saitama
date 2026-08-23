/**
 * ENTRY POINT
 *
 * Everything this file does is: find the canvas, hand it to the composition
 * root, drive the pre-HUD boot screen while that happens, and start the loop.
 * The game itself lives in `src/game/`.
 *
 * ── THE TWO GLOBALS THAT SURVIVED THE REWRITE ──────────────────────────────
 * `window.__GAME_READY__` and `window.__GAME_DIAG__` are a contract with the
 * verification harness and their SEMANTICS are unchanged from the bootstrap
 * this file replaced:
 *
 *   __GAME_READY__  flips true only after a real frame has presented — never on
 *                   "the bundle parsed" and never on "the loop started", so a
 *                   harness that screenshots on it cannot catch an empty canvas.
 *   __GAME_DIAG__   is published from here as a zeroed stub BEFORE anything can
 *                   fail, so a boot that dies still leaves a readable `errors`
 *                   array rather than an undefined global. `createDiagnostics`
 *                   swaps in the real, live object once boot reaches it.
 *
 * `src/game/diagnostics.ts` adds `boot`, `timings`, `systems` and `world` to it.
 * All four are additive: a harness written against the original shape passes
 * against this one untouched.
 *
 * ── WHY THE BOOT SCREEN IS STILL HERE ──────────────────────────────────────
 * `index.html` paints its own loading screen before a single byte of JavaScript
 * has parsed. The HUD's `LoadingScreen` cannot: it needs the HUD, which needs
 * the bundle. So this one covers the gap and hands over the moment the real one
 * exists — driven, from the first frame it is on screen, by actual bytes
 * fetched through the asset provider and never by a timer.
 */

// Bundles Bebas Neue and Inter. A side-effect import, and the app bootstrap is
// the place `src/ui/hud/fonts.ts` documents for it: the HUD's own modules must
// not pull a stylesheet through the bundler, or every headless consumer of the
// HUD drags one too. Without this line the shipping bundle contains neither
// face and the whole HUD renders in `system-ui` — about 25% wider than the
// condensed face every panel width in `styles.ts` is measured against, which is
// why labels that fit in the harness overflow on a device.
import '@/ui/hud/fonts';
import { clamp, createLogger } from '@/util';
import { Game } from '@/game';

const log = createLogger('main');

/* -------------------------------------------------------------------------- */
/* Diagnostics global                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cap on `__GAME_DIAG__.errors` written from this file.
 *
 * The window-level handlers below can fire once per frame for a throw inside
 * the RAF loop; an uncapped array would then grow until the tab dies, taking
 * the diagnostic it exists to preserve with it.
 */
const MAX_RECORDED_ERRORS = 64;

/**
 * Publish the diagnostics global BEFORE anything can fail.
 *
 * `src/game/diagnostics.ts` builds the real object, but that happens several
 * steps into `Game.boot` — after `detectPlatform()` and the GPU probe, which
 * are exactly the things that die on the devices where the diagnostic matters
 * most. Without this stub, `recordDiagError` below no-ops and a harness polling
 * the global cannot tell "the bundle never parsed" from "the probe threw".
 *
 * Zeroed, and replaced by `createDiagnostics` once boot reaches it — which
 * carries this object's `errors` across, so a fault recorded here is still
 * readable after the swap.
 */
function publishDiagnosticsStub(): void {
  if (window.__GAME_DIAG__) return;
  window.__GAME_DIAG__ = {
    renderer: 'unknown',
    vendor: 'unknown',
    isWebGL2: false,
    maxTextureSize: 0,
    maxAnisotropy: 0,
    compressedFormats: [],
    drawCalls: 0,
    triangles: 0,
    fps: 0,
    frameCount: 0,
    quality: 'low',
    bootTimeMs: 0,
    errors: [],
  };
}

publishDiagnosticsStub();

/** Append to `__GAME_DIAG__.errors`, whichever object is currently published. */
function recordDiagError(text: string): void {
  const diag = window.__GAME_DIAG__;
  if (!diag) return;
  const errors = (diag.errors ??= []);
  if (errors.length >= MAX_RECORDED_ERRORS) return;
  errors.push(text);
}

// `boot().catch()` is otherwise the only error sink in the whole app, so a
// throw inside the RAF loop — the most likely place for a long-session failure
// — would never reach `errors` at all.
window.addEventListener('error', (event) => {
  recordDiagError(`uncaught: ${event.message} (${event.filename}:${event.lineno})`);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  recordDiagError(
    `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`
  );
});

/* -------------------------------------------------------------------------- */
/* The pre-HUD boot screen                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Progress at which the inline screen hands over to the HUD's.
 *
 * The renderer, the bus and the HUD are all up by 0.1, which is the first
 * moment there is a better screen to show.
 */
const HANDOVER_FRACTION = 0.1;

const bootScreen = document.getElementById('boot-screen');
const bootStatus = document.getElementById('boot-status');
const bootBarFill = document.getElementById('boot-bar-fill');
const bootError = document.getElementById('boot-error');

function setStatus(text: string, progress: number): void {
  if (bootStatus) bootStatus.textContent = text;
  if (bootBarFill) bootBarFill.style.width = `${clamp(progress, 0, 1) * 100}%`;
}

function fail(message: string, error: unknown): void {
  log.error(message, error);
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  // Un-hide FIRST. Past `HANDOVER_FRACTION` the screen carries `.hidden`,
  // which is `opacity: 0` — everything written below would be rendered
  // invisibly, leaving the player staring at a loading bar that will never
  // advance and the harness screenshotting a stall with no explanation.
  bootScreen?.classList.remove('hidden');
  if (bootStatus) bootStatus.textContent = 'Failed to start';
  if (bootError) {
    bootError.style.display = 'block';
    bootError.textContent = `${message}\n\n${detail}`;
  }
  recordDiagError(`${message}: ${detail}`);
}

/* -------------------------------------------------------------------------- */
/* Launch options                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Query-string overrides.
 *
 * Three, all of them for verification rather than for players:
 *   `?tier=low|medium|high`  force the render tier
 *   `?native=1`              claim to be a Capacitor shell, which pins the
 *                            asset tier to `mobile` — the only way to reproduce
 *                            the APK's asset situation in a desktop browser
 *   `?nosave=1`              ignore any stored save and start clean
 */
function readLaunchOptions(): {
  tier: 'low' | 'medium' | 'high' | undefined;
  native: boolean;
  loadSave: boolean;
} {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('tier');
  const tier = raw === 'low' || raw === 'medium' || raw === 'high' ? raw : undefined;
  return {
    tier,
    native: params.get('native') === '1',
    loadSave: params.get('nosave') !== '1',
  };
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function boot(): Promise<void> {
  setStatus('Initialising', 0.02);

  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('#game-canvas not found in index.html');
  const uiRoot = document.getElementById('ui-root');
  if (!uiRoot) throw new Error('#ui-root not found in index.html');

  const options = readLaunchOptions();

  const game = await Game.boot({
    canvas,
    uiRoot,
    forceRenderTier: options.tier,
    forceNative: options.native,
    onProgress: (fraction, label) => {
      setStatus(label, fraction);
      // Hand over the moment the HUD's own loading screen is up. Past this
      // point the inline screen is covering a better one that shows the same
      // numbers, plus the rules-of-the-world copy that makes a five-second
      // wait tolerable.
      if (fraction >= HANDOVER_FRACTION) bootScreen?.classList.add('hidden');
    },
  });

  setStatus('Ready', 1);
  bootScreen?.classList.add('hidden');

  if (options.loadSave) {
    const restored = await game.load();
    if (restored) log.info('restored save');
  }

  game.start();

  // Kept reachable for the console and for the verification harness, which
  // drives input through `window.__INPUT__` but reads world state from here.
  (window as unknown as { __GAME__?: Game }).__GAME__ = game;

  installBackgroundSave(game);
}

/**
 * Persist on backgrounding.
 *
 * `pagehide` alone is not enough: Android (and the Capacitor WebView this ships
 * in) does not guarantee it for an app that is backgrounded and later reclaimed
 * — the last reliably delivered callback is `visibilitychange` -> `hidden`. On
 * that path the player loses up to `AUTOSAVE_INTERVAL` seconds of progress with
 * no indication anything went wrong.
 *
 * Both triggers are kept, coalesced through one in-flight flag: `pagehide`
 * fires on every navigation-away including bfcache entry, so back-forward
 * navigation could otherwise start a second `save()` while the first is still
 * writing — two writers to one storage key, with `Game.save`'s own try/catch
 * swallowing whichever one loses.
 */
function installBackgroundSave(game: Game): void {
  let inFlight = false;
  const requestSave = (): void => {
    if (inFlight) return;
    inFlight = true;
    void game
      .save()
      .catch((error: unknown) => {
        log.warn('background save failed', error);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') requestSave();
  });
  window.addEventListener('pagehide', requestSave);
}

boot().catch((error) => {
  fail('Bootstrap failed', error);
});
