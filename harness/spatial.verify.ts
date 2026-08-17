/**
 * SPATIAL HARNESS VERIFICATION
 *
 * Builds `harness/spatial.html` with Vite, serves it, drives it in headless
 * Chromium and screenshots the top-down view into `docs/screenshots/`.
 *
 * The screenshot is evidence, not the test — the real assertions live in
 * `src/spatial/__tests__/`, which run headlessly and check culling against
 * brute force. What this adds is the thing a unit test cannot: proof that the
 * structures survive a real bundle, run in a browser, and produce a picture in
 * which the culling decisions are legible.
 *
 * The SwiftShader flags are passed even though the page draws on a 2D canvas,
 * so the harness behaves identically if it is ever given a WebGL view.
 *
 * Run: `npx tsx harness/spatial.verify.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';
import { build, type InlineConfig } from 'vite';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-spatial-harness');
const SHOT = path.join(OUT_DIR, 'spatial-harness.png');

/** Wide enough for the 900 px map plus the stats column. */
const VIEWPORT = { width: 1260, height: 940 };

const SWIFTSHADER_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

interface ICullRateSummary {
  readonly chunksAfterFrustum: number;
  readonly chunksAfterPvs: number;
  readonly pvsEliminationRate: number;
  readonly instancesAfterFrustum: number;
  readonly instancesAfterPvs: number;
  readonly pvsInstanceEliminationRate: number;
  readonly occupiedChunks: number;
}

interface ISnapshot {
  readonly instances: number;
  readonly nodes: number;
  readonly pvsBytes: number;
  readonly pvsAverageVisible: number;
  readonly viewChunk: number;
  readonly chunksFrustum: number;
  readonly chunksWithPvs: number;
  readonly instancesFrustum: number;
  readonly instancesWithPvs: number;
  readonly sweep: ICullRateSummary | undefined;
}

async function buildHarness(): Promise<void> {
  await rm(BUILD_DIR, { recursive: true, force: true });
  const config: InlineConfig = {
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: {
      outDir: BUILD_DIR,
      emptyOutDir: true,
      sourcemap: false,
      // Bundle rather than dev-serve: a dev server discovers dependencies
      // lazily and can reload mid-run when the optimiser re-triggers.
      rollupOptions: { input: { spatialHarness: path.join(ROOT, 'harness', 'spatial.html') } },
    },
  };
  await build(config);
}

function serve(directory: string): Promise<{ server: Server; port: number }> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const filePath = path.join(directory, decodeURIComponent(url.pathname));
      if (!filePath.startsWith(directory)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      if (!existsSync(filePath)) {
        response.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500).end(String(error));
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

/** A page that threw still screenshots — as a flat rectangle. Check pixels. */
async function analyse(file: string): Promise<{ stdDev: number; colours: number }> {
  const stats = await sharp(file).stats();
  const channels = stats.channels.slice(0, 3);
  const stdDev = channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length;
  const raw = await sharp(file).resize(72, 72, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }
  return { stdDev, colours: seen.size };
}

async function main(): Promise<void> {
  const failures: string[] = [];
  await mkdir(OUT_DIR, { recursive: true });

  console.log('building harness bundle...');
  await buildHarness();

  const { server, port } = await serve(BUILD_DIR);
  const url = `http://127.0.0.1:${port}/harness/spatial.html`;
  console.log(`serving ${BUILD_DIR} at ${url}`);

  let browser: Browser | undefined;
  let snapshot: ISnapshot | undefined;

  try {
    browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
    const page: Page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

    const consoleErrors: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForFunction(() => window.__SPATIAL_READY__ === true, undefined, {
      timeout: 90_000,
    });

    // Show the quadtree at 48 m cells and overlay the camera chunk's PVS mask:
    // the two things the picture exists to make legible.
    await page.evaluate(() => {
      const harness = window.__SPATIAL_HARNESS__!;
      harness.setOverlayDepth(5);
      harness.setShowPvsMask(true);
    });

    snapshot = (await page.evaluate(() =>
      window.__SPATIAL_HARNESS__!.snapshot()
    )) as unknown as ISnapshot;

    await page.screenshot({ path: SHOT, type: 'png' });
    const pixels = await analyse(SHOT);

    /* ---------------------------- assertions ---------------------------- */
    if (pixels.stdDev < 3) failures.push(`screenshot looks flat (stdDev ${pixels.stdDev})`);
    if (pixels.colours < 24) failures.push(`too few colours (${pixels.colours})`);
    if (snapshot.nodes !== 5461) failures.push(`quadtree has ${snapshot.nodes} nodes, expected 5461`);
    if (snapshot.pvsBytes !== 8192) failures.push(`PVS is ${snapshot.pvsBytes} B, expected 8192`);
    if (snapshot.instances < 1000) failures.push(`only ${snapshot.instances} instances indexed`);
    if (snapshot.chunksWithPvs > snapshot.chunksFrustum) {
      failures.push(
        `PVS kept MORE chunks than the frustum alone ` +
          `(${snapshot.chunksWithPvs} > ${snapshot.chunksFrustum})`
      );
    }
    if (snapshot.instancesWithPvs > snapshot.instancesFrustum) {
      failures.push(
        `PVS kept MORE instances than the frustum alone ` +
          `(${snapshot.instancesWithPvs} > ${snapshot.instancesFrustum})`
      );
    }
    if (snapshot.sweep === undefined) failures.push('the camera sweep did not run');
    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 4).join(' | ')}`);
    }

    console.log('\n──────── snapshot ────────');
    console.log(JSON.stringify(snapshot, null, 2));
    console.log('\n──────── pixels ────────');
    console.log(JSON.stringify(pixels, null, 2));
    console.log(`saved: ${SHOT}`);
  } finally {
    await browser?.close();
    server.close();
    await rm(BUILD_DIR, { recursive: true, force: true });
  }

  console.log('\n──────── result ────────');
  if (failures.length > 0) {
    console.error('SPATIAL HARNESS FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('SPATIAL HARNESS PASSED');
}

main().catch((error) => {
  console.error('spatial harness crashed:', error);
  process.exit(1);
});
