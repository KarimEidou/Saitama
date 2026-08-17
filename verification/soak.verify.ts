/**
 * SOAK VERIFICATION — THE COMPOSED GAME, DRIVEN LONG ENOUGH TO BREAK.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * `integration.verify.ts` proves that twenty-six systems compose into
 * something a player can drive. It samples errors at BEATS — after boot, after
 * a punch, after a collapse — and every one of those beats is inside the first
 * few seconds of a session.
 *
 * A whole-frame kill lived in this repository for most of its integration work
 * and survived every "0 console errors" result, because it did not arrive
 * until the background asset loads finished — several seconds after boot, long
 * after the last checkpoint anything looked at. It was a prop: two of the
 * pipeline's GLBs carry a blend shape, `THREE.InstancedMesh` cannot draw
 * geometry with morph targets in three r185, and `WebGLRenderer` threw out of
 * `renderBufferDirect` on every frame from the moment the first wheel rim
 * attached. `renderer.info` froze mid-frame and nothing was presented again.
 *
 * So this file asserts the thing that was actually missing: a LONG run, with
 * EVERY frame's errors counted, and proof at the end that the render loop is
 * still alive rather than silently dead.
 *
 * ── WHAT IT ASSERTS ────────────────────────────────────────────────────────
 *   1. Zero console errors and zero diagnostic errors across the WHOLE run.
 *   2. `renderer.info.render.calls` is non-zero at the end — a frame really
 *      completed, which is the one thing an error count cannot tell you: the
 *      composition root catches per-frame throws so the loop survives them,
 *      and a game whose every render dies still "runs".
 *   3. `frameCount` advanced monotonically — the counter is written AFTER the
 *      render, so it stalls the moment rendering throws.
 *   4. The player crossed chunk boundaries in both directions, so chunks were
 *      built AND evicted, which is the streaming lifetime this run is for.
 *
 * Frame RATE is not measured or reported anywhere: the only GL here is
 * SwiftShader, a CPU rasteriser, and a number derived from it says nothing
 * about a phone.
 *
 * Run: `npx tsx verification/soak.verify.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

/**
 * Frames to drive. 1800 is thirty seconds at 60 Hz on a device, and far more
 * than that in simulated time here — the clock charges up to `MAX_DELTA`
 * (1/15 s) a frame, so 1800 SwiftShader frames advance the world by minutes.
 * The point is duration in GAME time: background loads must finish, chunks
 * must stream and evict, the crowd must reach its cap.
 */
const FRAMES = Number(process.env.FRAMES ?? 1800);

/** Frames between samples. Each sample is one round trip, so not every frame. */
const SAMPLE = 60;

/**
 * Small on purpose. Every pixel is rasterised on the CPU and this run presents
 * more than a thousand frames; the assertions are about counters, not pixels.
 */
const VIEWPORT = { width: 480, height: 854 };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

function serveDist(): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let filePath = path.join(DIST, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '') filePath = path.join(DIST, 'index.html');
    if (!filePath.startsWith(DIST) || !existsSync(filePath)) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

/**
 * Step `count` frames inside the page.
 *
 * A template string, not a function: Playwright serialises the argument, and
 * the bundler's `__name` helper does not exist in the page's scope — a named
 * inner function therefore throws `__name is not defined`. Same constraint as
 * `integration.verify.ts`.
 */
async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(
    `new Promise((resolve) => {
       let left = ${count};
       const tick = () => { if (--left <= 0) { resolve(); return; } requestAnimationFrame(tick); };
       requestAnimationFrame(tick);
     })`
  );
}

interface ISample {
  readonly frameCount: number;
  readonly drawCalls: number;
  readonly diagErrors: number;
  readonly lastError: string;
  readonly residentChunks: number;
  readonly chunkIndex: number;
  readonly x: number;
  readonly z: number;
}

const sample = (page: Page): Promise<ISample> =>
  page.evaluate(() => {
    const diag = window.__GAME_DIAG__ as unknown as {
      frameCount: number;
      errors?: string[];
      world: Record<string, unknown>;
    };
    const game = window as unknown as {
      __GAME__: { renderer: { raw: { info: { render: { calls: number } } } } };
    };
    const errors = diag.errors ?? [];
    const position = diag.world.playerPosition as { x: number; z: number };
    return {
      frameCount: diag.frameCount,
      drawCalls: game.__GAME__.renderer.raw.info.render.calls,
      diagErrors: errors.length,
      lastError: errors[errors.length - 1] ?? '',
      residentChunks: diag.world.residentChunks as number,
      chunkIndex: diag.world.chunkIndex as number,
      x: position.x,
      z: position.z,
    };
  });

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const failures: string[] = [];

  if (!existsSync(DIST)) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }

  const served = await serveDist();
  const base = `http://127.0.0.1:${served.port}/`;
  say(`serving dist/ at ${base}`);

  let browser: Browser | undefined;
  const consoleErrors: string[] = [];

  try {
    browser = await chromium.launch({
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500));
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    say('\n[1] boot');
    await page.goto(`${base}?tier=high&nosave=1`, { waitUntil: 'load', timeout: 300_000 });
    await page.waitForFunction(() => window.__GAME_READY__ === true, undefined, {
      timeout: 300_000,
    });
    const booted = await sample(page);
    say(`  ready — ${booted.drawCalls} draws, ${booted.residentChunks} chunks`);

    // Force the whole resident ring up front. The background loads that follow
    // it are what the crash used to ride in on, and they only start once the
    // ring's materials and props have been asked for.
    await page.evaluate(() => {
      (
        window as unknown as { __GAME__: { cityStreamer: { buildImmediate(r: number): void } } }
      ).__GAME__.cityStreamer.buildImmediate(1);
    });

    say(`\n[2] soak — ${FRAMES} frames, sampled every ${SAMPLE}`);
    await page.evaluate(() => {
      window.__INPUT__!.enable();
    });

    let lastFrameCount = booted.frameCount;
    let stalled = 0;
    let minChunk = booted.chunkIndex;
    let maxChunk = booted.chunkIndex;
    let firstErrorAt = -1;

    for (let done = 0; done < FRAMES; done += SAMPLE) {
      // Walk out and back, so chunks are BUILT and then EVICTED, repeatedly.
      // A one-way sprint only ever loads; eviction needs the focus to leave a
      // chunk by more than the streamer's ring of hysteresis and stay away.
      const leg = Math.floor(done / 300) % 2 === 0 ? 1 : -1;
      await page.evaluate((forward) => {
        window.__INPUT__!.setMove(0, forward);
        window.__INPUT__!.press('sprint');
      }, leg);

      await frames(page, Math.min(SAMPLE, FRAMES - done));
      const now = await sample(page);

      if (now.diagErrors > 0 && firstErrorAt < 0) firstErrorAt = now.frameCount;
      if (now.frameCount <= lastFrameCount) stalled++;
      lastFrameCount = now.frameCount;
      minChunk = Math.min(minChunk, now.chunkIndex);
      maxChunk = Math.max(maxChunk, now.chunkIndex);

      say(
        `  frame ${String(now.frameCount).padStart(5)}  draws ${String(now.drawCalls).padStart(4)}` +
          `  chunks ${String(now.residentChunks).padStart(3)}` +
          `  at (${now.x.toFixed(0)}, ${now.z.toFixed(0)})` +
          `  errors ${now.diagErrors}${now.lastError === '' ? '' : `  <-- ${now.lastError}`}`
      );
    }

    await page.evaluate(() => {
      window.__INPUT__!.setMove(0, 0);
      window.__INPUT__!.release('sprint');
    });
    await frames(page, 10);

    const final = await sample(page);

    say('\n[3] verdict');
    say(`  frames driven          ${final.frameCount}`);
    say(`  diagnostic errors      ${final.diagErrors}`);
    say(`  console errors         ${consoleErrors.length}`);
    say(`  draw calls, last frame ${final.drawCalls}`);
    say(`  chunk index range      ${minChunk}..${maxChunk}`);

    if (final.diagErrors > 0) {
      failures.push(
        `${final.diagErrors} frame errors, first at frame ${firstErrorAt}: ${final.lastError}`
      );
    }
    if (consoleErrors.length > 0) {
      failures.push(`${consoleErrors.length} console errors, first: ${consoleErrors[0]}`);
    }
    // THE liveness assertion. `info.autoReset` is false in this project and the
    // renderer resets manually at the top of its own `render()`, so a non-zero
    // count here means the LAST frame actually completed a render — not that
    // some frame, once, long ago, did.
    if (final.drawCalls <= 0) {
      failures.push('renderer.info.render.calls is 0 — the render loop is dead');
    }
    if (final.frameCount < FRAMES * 0.9) {
      failures.push(`only ${final.frameCount} frames advanced, wanted about ${FRAMES}`);
    }
    if (stalled > 0) {
      failures.push(`frame counter stalled across ${stalled} samples`);
    }
    if (minChunk === maxChunk) {
      failures.push('the player never left its spawn chunk — no streaming was exercised');
    }
  } finally {
    await browser?.close();
    served.server.close();
  }

  if (failures.length > 0) {
    say('\nFAIL');
    for (const failure of failures) say(`  - ${failure}`);
    process.exit(1);
  }
  say('\nPASS — no errors across the whole run, and the loop is still drawing.');
}

main().catch((error) => {
  console.error('soak crashed:', error);
  process.exit(1);
});
