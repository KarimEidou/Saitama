/**
 * AUTOMATED BUILD VERIFICATION
 *
 * Serves the production build, launches headless Chromium with SwiftShader,
 * waits for the game to signal readiness, and proves a real frame rendered.
 *
 * The last point is the one that matters: a WebGL page that throws still
 * "loads" successfully and still screenshots. So this harness does not trust
 * `__GAME_READY__` alone — it reads the pixels back and rejects a frame that
 * is blank, uniform, or a flat black fill. That is the difference between
 * verifying the toolchain and merely verifying that a server responded.
 *
 * Run: `npm run verify`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { IGameDiagnostics } from '../src/types/engine.ts';
// Type-only, and it is here for the `declare global` in
// `src/ui/input/test-bridge.ts` rather than for the name: that is what puts
// `window.__INPUT__` on `Window` for this file. `IInputTuning` is read below.
import type { IInputTuning } from '../src/ui/input/index.ts';
import type { IIntegrationDiagnostics } from '../src/game/diagnostics.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'verification');
const SCREENSHOT = path.join(OUT_DIR, 'task01-bootstrap.png');
/** Committed evidence copy — the only directory the binary guard allows. */
const DOCS_SHOT = path.join(ROOT, 'docs', 'screenshots', 'task01-bootstrap.png');

const VIEWPORT = { width: 900, height: 1600 }; // portrait, phone-like
/** Capture density. One constant, because the assertion below and the page
 *  must not be able to disagree about what a captured pixel is. */
const DPR = 2;

/**
 * Width of the committed evidence copy.
 *
 * The capture itself is DPR 2 — 1800x3200, 5.76 megapixels — and the binary
 * guard's 5 MB SIZE rule still applies inside `docs/screenshots/` (the
 * allow-list exempts it from the FORMAT rule only). The densest committed shot
 * in that directory measures 1.31 bytes/pixel, which at 5.76 MP projects to
 * 7.2 MB: a busy first frame would pass verification and then fail the very
 * next `npm run guard`, on a file the guard's own remedy does not fit. So the
 * evidence copy is downscaled and the full-resolution capture stays in
 * `verification/`, which `.gitignore` excludes.
 */
const DOCS_SHOT_WIDTH = 900;

/** The binary guard's per-file ceiling, mirrored so this fails at the source. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Artifacts `index.html` links that a plain `vite build` does not produce.
 *
 * `scripts/make-icons.ts` writes both into `public/` (gitignored), and its only
 * callers are `scripts/build-web.ts` and `scripts/build-apk.ts` — neither of
 * which is reachable from `npm run build`. Following this harness's own
 * instructions therefore serves a `dist/` with a dangling `rel="manifest"`,
 * Chromium logs the 404 at error level, and the run fails naming a console
 * error rather than the missing build step.
 */
const BUILD_EXTRAS = ['manifest.webmanifest', path.join('icons', 'apple-touch-icon.png')];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  // Emscripten's default instantiation path is `compileStreaming`, which
  // REJECTS on any type but `application/wasm`; the three sibling harnesses all
  // declare it. Today three's loaders pre-fetch the binary as an ArrayBuffer,
  // so the omission was invisible — until a loader changes.
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

/** Minimal static file server over `dist/`. No dependency on a CLI tool. */
function serveDist(): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let filePath = path.join(DIST, decodeURIComponent(url.pathname));
      if (url.pathname === '/' || url.pathname === '') filePath = path.join(DIST, 'index.html');
      // Contain path traversal. `DIST + path.sep`, not `DIST`: a bare prefix
      // test lets `/../dist-notes/secrets.txt` through, because `<ROOT>/dist-notes`
      // starts with `<ROOT>/dist`.
      if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind server'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

interface PixelReport {
  readonly width: number;
  readonly height: number;
  /** Mean per-channel standard deviation across the image. */
  readonly stdDev: number;
  /** Mean channel brightness 0..255. */
  readonly mean: number;
  /** Distinct colours sampled on a coarse grid. */
  readonly distinctColors: number;
  readonly isBlank: boolean;
}

/**
 * Analyse the screenshot. A correctly rendered 3D scene has meaningful
 * variance; a black or single-colour frame does not.
 */
async function analyseScreenshot(file: string): Promise<PixelReport> {
  const image = sharp(file);
  const meta = await image.metadata();
  const stats = await image.stats();

  // Consider only colour channels (drop alpha, which is uniformly opaque).
  const colorChannels = stats.channels.slice(0, 3);
  const stdDev = colorChannels.reduce((sum, c) => sum + c.stdev, 0) / colorChannels.length;
  const mean = colorChannels.reduce((sum, c) => sum + c.mean, 0) / colorChannels.length;

  // Count distinct colours on a downsampled grid — catches a uniform fill that
  // still has slight compression noise.
  const raw = await sharp(file).resize(64, 64, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }

  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    stdDev,
    mean,
    distinctColors: seen.size,
    // Blank means: essentially no variance AND almost no distinct colours.
    isBlank: stdDev < 1.5 || seen.size < 8,
  };
}

async function main(): Promise<void> {
  const failures: string[] = [];

  if (!existsSync(DIST)) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(path.dirname(DOCS_SHOT), { recursive: true });

  // Say what is missing BEFORE the browser gets a chance to 404 on it, so the
  // run names its own cause instead of reporting a Blink console error.
  const missingExtras = BUILD_EXTRAS.filter((rel) => !existsSync(path.join(DIST, rel)));
  if (missingExtras.length > 0) {
    console.warn(
      `WARNING: dist/ is missing ${missingExtras.join(', ')}, which index.html links.\n` +
        `         Chromium will request them and the server will answer 404 — any console\n` +
        `         error below may be that, not the game. They are produced by\n` +
        `         \`npx tsx scripts/make-icons.ts\` (run by scripts/build-web.ts and\n` +
        `         scripts/build-apk.ts); plain \`npm run build\` does not run it.`
    );
  }

  const { server, port } = await serveDist();
  const url = `http://127.0.0.1:${port}/`;
  console.log(`serving dist/ at ${url}`);

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      args: [
        // Software GL: there is no physical GPU in this environment.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });

    const page: Page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: DPR,
      isMobile: true,
      hasTouch: true,
    });

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });

    // Wait for a frame to have actually presented.
    await page.waitForFunction(() => window.__GAME_READY__ === true, undefined, {
      timeout: 60_000,
    });
    console.log('__GAME_READY__ = true');

    // Let the animation advance so the frame is unambiguously live.
    await page.waitForTimeout(1200);

    const diag = (await page.evaluate(
      () => window.__GAME_DIAG__ ?? null
    )) as IGameDiagnostics | null;

    if (!diag) {
      failures.push('window.__GAME_DIAG__ was not populated');
    }

    await page.screenshot({ path: SCREENSHOT, type: 'png' });
    const pixels = await analyseScreenshot(SCREENSHOT);
    // Downscaled — see DOCS_SHOT_WIDTH. The analysis above is of the full
    // capture; only the committed copy shrinks.
    await sharp(SCREENSHOT)
      .resize({ width: DOCS_SHOT_WIDTH })
      .png({ compressionLevel: 9 })
      .toFile(DOCS_SHOT);
    const docsBytes = (await stat(DOCS_SHOT)).size;

    /* ---------------------------- assertions ---------------------------- */
    if (pixels.isBlank) {
      failures.push(
        `screenshot looks blank (stdDev=${pixels.stdDev.toFixed(2)}, ` +
          `distinctColors=${pixels.distinctColors})`
      );
    }
    if (diag && !diag.isWebGL2) failures.push('WebGL2 context was not obtained');
    if (diag && diag.drawCalls < 1) failures.push(`no draw calls issued (${diag.drawCalls})`);
    if (diag && diag.triangles < 100)
      failures.push(`suspiciously few triangles (${diag.triangles})`);
    if (diag && diag.frameCount < 2) failures.push(`too few frames rendered (${diag.frameCount})`);
    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
    }
    // Fail HERE rather than in the next `npm run guard`: the guard is right,
    // but the file it rejects was written by this step and `git rm --cached`
    // is the wrong remedy for it.
    if (docsBytes > MAX_FILE_BYTES) {
      failures.push(
        `evidence copy ${DOCS_SHOT} is ${(docsBytes / 1048576).toFixed(2)} MB, over the binary ` +
          `guard's ${MAX_FILE_BYTES / 1048576} MB limit — lower DOCS_SHOT_WIDTH`
      );
    }
    // `analyseScreenshot` has always measured the capture's dimensions and
    // nothing ever read them. If the viewport or the DPR silently stops
    // applying, every statistic above is of a differently-sized frame, the run
    // still passes, and the committed evidence copy is overwritten with it.
    // Read from `pixels`, i.e. from SCREENSHOT: downscaling only the DOCS_SHOT
    // copy leaves this correct, and so does changing DPR, because the page and
    // the assertion read the same constant.
    const wantWidth = VIEWPORT.width * DPR;
    const wantHeight = VIEWPORT.height * DPR;
    if (pixels.width !== wantWidth || pixels.height !== wantHeight) {
      failures.push(
        `capture is ${pixels.width}x${pixels.height}, expected ${wantWidth}x${wantHeight} ` +
          `(viewport ${VIEWPORT.width}x${VIEWPORT.height} at DPR ${DPR}) — the frame analysed ` +
          `and copied to docs/screenshots is not the frame this harness thinks it configured`
      );
    }

    /* --------------------- a real touch walks him --------------------- */
    /* THE ONE THING NOTHING IN THIS REPOSITORY PROVED.
       `harness/input.verify.ts` proves the touch stack produces the right
       InputState, and `player-controller`'s unit tests prove the controller
       moves when handed one. Nothing joined them: no test anywhere took a
       finger, put it on the glass of the real build, and checked that the
       character went anywhere. That is precisely the bug this branch exists to
       fix — the stick read `active:true, magnitude:0` and every layer reported
       itself healthy — so it gets an assertion in the harness that runs against
       the SHIPPING BUNDLE, with the real assets, after the real boot.

       `__INPUT__.reset()` first, and it is not a formality: while the synthetic
       source is armed it REPLACES every real backend, so a stale arm makes this
       whole section prove nothing at all while passing.

       Touches go over CDP because Playwright's touchscreen can tap and cannot
       drag, and a tap is the one gesture this control is now specifically
       required NOT to move for.

       All four (layout x hand) combinations, because the setting exists and a
       control that works on one of its four settings is a control that does not
       work. */
    const walkFailures: string[] = [];
    if (diag) {
      const cdp = await page.context().newCDPSession(page);
      const tuning = (await page.evaluate(() =>
        window.__INPUT__ ? window.__INPUT__.config() : null
      )) as IInputTuning | null;

      if (!tuning) {
        walkFailures.push('window.__INPUT__ is not installed in the production bundle');
      } else {
        /* Past full deflection, so the reading is 1.0 whichever origin the
           layout picked — the anchor for a centred grab, the touch point for a
           floating one. This section is about DISPLACEMENT, not about which of
           the two answered. */
        const reach = tuning.stickFullDeflectionPx + 28;

        /* THE HOLD IS COUNTED IN FRAMES, NOT MILLISECONDS, and that is not
           fussiness. The input manager polls once per rendered frame, and this
           harness renders through SwiftShader on a machine with no GPU:
           measured here, the game presents a frame roughly every 400ms. A
           `waitForTimeout(120)` after lifting the finger therefore read a
           snapshot from BEFORE the lift and reported a stick pinned at
           magnitude 1.000 with nothing touching the glass — a harness artefact
           that looks exactly like the bug this file exists to catch. Wall-clock
           waits cannot tell the two apart; frames can. */
        const frameCount = () =>
          page.evaluate(
            () => (window.__GAME_DIAG__ as IIntegrationDiagnostics | undefined)?.frameCount ?? 0
          ) as Promise<number>;
        const waitFrames = async (count: number): Promise<void> => {
          const target = (await frameCount()) + count;
          await page.waitForFunction(
            (want) =>
              ((window.__GAME_DIAG__ as IIntegrationDiagnostics | undefined)?.frameCount ?? 0) >=
              want,
            target,
            { timeout: 60_000 }
          );
        };

        for (const stickHand of ['left', 'right'] as const) {
          for (const floatingStick of [false, true]) {
            const label = `${floatingStick ? 'floating' : 'anchored'}/${stickHand}`;
            await page.evaluate(
              (patch) => {
                window.__INPUT__?.reset();
                window.__INPUT__?.setConfig(patch);
              },
              { stickHand, floatingStick }
            );
            await waitFrames(2);

            /* The anchored stick's home corner, which is inside the stick zone
               on both hands and on this viewport. Headless Chromium reports no
               insets, so the safe-area terms are zero. */
            const from = {
              x:
                stickHand === 'right'
                  ? VIEWPORT.width - tuning.stickFixedInsetPx
                  : tuning.stickFixedInsetPx,
              y: VIEWPORT.height - tuning.stickFixedInsetPx,
            };

            /* WHO OWNS THE PIXEL. A HUD panel left mounted over the stick half
               swallows the touch before the input layer ever sees it, and the
               failure then looks exactly like a broken stick. Reported rather
               than asserted on, so the message below names the cause. */
            const owner = (await page.evaluate(
              (point) => document.elementFromPoint(point.x, point.y)?.className ?? '(nothing)',
              from
            )) as string;

            /* `src/types/engine.ts` declares the global as the BASE
               `IGameDiagnostics` on purpose — `src/types/` may not import from
               `src/game/`, so the richer shape the game actually publishes
               cannot be named there. The cast is that architectural rule
               arriving here, not a shortcut. */
            const before = (await page.evaluate(
              () =>
                (window.__GAME_DIAG__ as IIntegrationDiagnostics | undefined)?.world
                  .playerPosition ?? null
            )) as { x: number; y: number; z: number } | null;

            /* `radiusX`/`radiusY`/`force` are not decoration: a touch point
               without them is not the shape a real finger sends, and the
               `touchEnd` below carries the LIFTED POINT rather than an empty
               list. Measured: an empty list released the first gesture of the
               run and none of the three after it, so the stick stayed pinned at
               magnitude 1.000 with no finger on the glass. */
            const finger = (x: number, y: number) => [
              { x, y, radiusX: 3, radiusY: 3, force: 1, id: 1 },
            ];
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: finger(from.x, from.y),
            });
            for (let step = 1; step <= 8; step += 1) {
              await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: finger(from.x, from.y - (reach * step) / 8),
              });
              await page.waitForTimeout(16);
            }
            // Held for 12 frames: long enough that acceleration cannot be the
            // reason the number is small.
            await waitFrames(12);

            const held = (await page.evaluate(() => ({
              move: window.__INPUT__?.snapshot().move ?? null,
              device: window.__INPUT__?.device() ?? null,
              position:
                (window.__GAME_DIAG__ as IIntegrationDiagnostics | undefined)?.world
                  .playerPosition ?? null,
            }))) as {
              move: { magnitude: number; active: boolean } | null;
              device: string | null;
              position: { x: number; y: number; z: number } | null;
            };

            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchEnd',
              touchPoints: finger(from.x, from.y - reach),
            });
            await waitFrames(3);

            const rest = (await page.evaluate(
              () => window.__INPUT__?.snapshot().move.magnitude ?? -1
            )) as number;

            const moved =
              before && held.position
                ? Math.hypot(held.position.x - before.x, held.position.z - before.z)
                : Number.NaN;
            const detail =
              `${label}: moved ${Number.isFinite(moved) ? moved.toFixed(3) : '?'} m, ` +
              `magnitude ${held.move?.magnitude.toFixed(3) ?? '?'}, device ${held.device ?? '?'}, ` +
              `pixel owned by "${owner}"`;
            console.log(`  ${detail}`);

            if (!(moved > 1)) walkFailures.push(`a touch drag did not walk him — ${detail}`);
            if (held.device !== 'touch') {
              walkFailures.push(`the drag was not attributed to touch — ${detail}`);
            }
            if (rest > 0.001) {
              walkFailures.push(
                `${label}: the stick did not centre when the thumb lifted (${rest})`
              );
            }
          }
        }

        // Back to the shipping defaults, so nothing after this reads a tuning
        // this section left behind.
        await page.evaluate(() => {
          window.__INPUT__?.reset();
          window.__INPUT__?.setConfig({ stickHand: 'left', floatingStick: false });
        });
      }

      // Nothing has ever read this. A boot that collected three non-fatal
      // errors and rendered anyway passed every assertion above.
      const bootErrors = diag.errors ?? [];
      if (bootErrors.length > 0) {
        walkFailures.push(
          `__GAME_DIAG__.errors is not empty: ${bootErrors.slice(0, 5).join(' | ')}`
        );
      }
    }
    console.log('\n──────── a real touch walks him ────────');
    if (walkFailures.length === 0) console.log('  all four layout x hand combinations walked');
    failures.push(...walkFailures);

    /* ------------------------------ report ------------------------------ */
    console.log('\n──────── __GAME_DIAG__ ────────');
    console.log(JSON.stringify(diag, null, 2));
    console.log('\n──────── screenshot ────────');
    console.log(JSON.stringify(pixels, null, 2));
    console.log(`saved: ${SCREENSHOT}`);
    console.log(`evidence copy: ${DOCS_SHOT}`);
  } finally {
    await browser?.close();
    server.close();
  }

  console.log('\n──────── result ────────');
  if (failures.length > 0) {
    console.error('VERIFICATION FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('VERIFICATION PASSED');
}

main().catch((error) => {
  console.error('verification crashed:', error);
  process.exit(1);
});
