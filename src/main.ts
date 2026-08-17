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
 *   __GAME_DIAG__   is published BEFORE anything can fail and mutated in place
 *                   afterwards, so a boot that dies still leaves a readable
 *                   `errors` array rather than an undefined global.
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

import { clamp, createLogger } from '@/util';
import { Game } from '@/game';

const log = createLogger('main');

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
  if (bootStatus) bootStatus.textContent = 'Failed to start';
  if (bootError) {
    bootError.style.display = 'block';
    bootError.textContent = `${message}\n\n${detail}`;
  }
  const diag = window.__GAME_DIAG__;
  if (diag) (diag.errors ??= []).push(`${message}: ${detail}`);
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

  window.addEventListener('pagehide', () => {
    void game.save();
  });
}

boot().catch((error) => {
  fail('Bootstrap failed', error);
});
