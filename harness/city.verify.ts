/**
 * CITY HARNESS VERIFICATION
 *
 * Bundles `harness/city.html` with Vite, serves it, drives it in headless
 * Chromium on SwiftShader, and screenshots four views into `docs/screenshots/`.
 *
 * The screenshots are EVIDENCE, not the test. The assertions that matter live
 * in `src/world/city/__tests__/` and run headlessly. What this adds is what a
 * unit test cannot give:
 *
 *   • proof the generator survives a real bundle and a real GL context;
 *   • a measured `renderer.info.render.calls` per frame, so the draw-call
 *     budget is observed rather than modelled;
 *   • a street-level image a person can look at and judge.
 *
 * Frame timings are deliberately not collected. This is a CPU software
 * rasteriser; a millisecond here means nothing about a phone.
 *
 * Run: `npx tsx harness/city.verify.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';
import { build, type InlineConfig } from 'vite';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-city-harness');

const VIEWPORT = { width: 1600, height: 900 };

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
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

interface IReport {
  readonly chunks: number;
  readonly blocks: number;
  readonly blockCalls: number;
  readonly mergedBlockCalls: number;
  readonly groundCalls: number;
  readonly propCalls: number;
  readonly perBlockTotal: number;
  readonly total: number;
  readonly triangles: number;
  readonly worstBlockCalls: number;
}

interface IHarnessStats {
  readonly view: string;
  readonly chunks: number;
  readonly blocks: number;
  readonly buildings: number;
  readonly triangles: number;
  readonly drawCallsRendered: number;
  readonly drawCallsPerBlockWorst: number;
  readonly residentReport: IReport;
  readonly regionReport: IReport;
  readonly generationMs: number;
  readonly buildMs: number;
  readonly materialsSynthesised: number;
  readonly realMaterials: number;
  readonly realModels: number;
  readonly assetProblems: readonly string[];
  readonly propsResolved: number;
  readonly propsMissing: readonly string[];
  readonly usingRealTextures: boolean;
}

interface IViewSpec {
  readonly name: 'street' | 'map' | 'skyline' | 'fracture';
  readonly file: string;
  /** Crop the stats panel away so the image is pure render. */
  readonly cropPanel: boolean;
}

const VIEWS: readonly IViewSpec[] = [
  { name: 'street', file: 'city-street-level.png', cropPanel: true },
  { name: 'map', file: 'city-district-map.png', cropPanel: true },
  { name: 'skyline', file: 'city-downtown-skyline.png', cropPanel: true },
  { name: 'fracture', file: 'city-fracture-chunks.png', cropPanel: true },
];

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
      rollupOptions: { input: { cityHarness: path.join(ROOT, 'harness', 'city.html') } },
    },
    // `public/assets/` is 200 MB of processed KTX2 and GLB. Copying it into the
    // build output would dominate the run; it is mounted straight off disk by
    // the server below instead.
    publicDir: false,
  };
  await build(config);
}

/**
 * Extra mounts served alongside the bundle.
 *
 * `/assets` is the processed asset set, served from `public/` rather than
 * copied. `/basis` and `/draco` are the KTX2 transcoder and Draco decoder the
 * loaders fetch at runtime; they ship inside three's examples and simply need
 * to be reachable over HTTP.
 */
const MOUNTS: readonly (readonly [string, string])[] = [
  ['/assets', path.join(ROOT, 'public', 'assets')],
  ['/basis', path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis')],
  ['/draco', path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf')],
];

function resolveMount(pathname: string, fallbackDir: string): string {
  for (const [prefix, dir] of MOUNTS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return path.join(dir, pathname.slice(prefix.length));
    }
  }
  return path.join(fallbackDir, pathname);
}

function serve(directory: string): Promise<{ server: Server; port: number }> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const filePath = resolveMount(decodeURIComponent(url.pathname), directory);
      const roots = [directory, ...MOUNTS.map(([, dir]) => dir)];
      if (!roots.some((root) => filePath.startsWith(root))) {
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

/**
 * A page that threw still screenshots — as a flat rectangle. Measure the pixels
 * so "the harness rendered something" is checked rather than assumed.
 *
 * `edgeDensity` is the discriminator that matters here: a gradient sky has high
 * standard deviation and many colours but almost no edges, while a street full
 * of buildings, window reveals and kerbs is dense with them.
 */
async function analyse(file: string): Promise<{
  stdDev: number;
  colours: number;
  edgeDensity: number;
  meanLuma: number;
}> {
  const stats = await sharp(file).stats();
  const channels = stats.channels.slice(0, 3);
  const stdDev = channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length;
  const meanLuma = channels.reduce((sum, c) => sum + c.mean, 0) / channels.length;

  const raw = await sharp(file).resize(96, 96, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }

  const gray = await sharp(file).greyscale().resize(240, 135, { fit: 'fill' }).raw().toBuffer();
  let edges = 0;
  for (let y = 1; y < 134; y++) {
    for (let x = 1; x < 239; x++) {
      const i = y * 240 + x;
      const gx = Math.abs(gray[i + 1]! - gray[i - 1]!);
      const gy = Math.abs(gray[i + 240]! - gray[i - 240]!);
      if (gx + gy > 24) edges++;
    }
  }
  return { stdDev, colours: seen.size, edgeDensity: edges / (238 * 133), meanLuma };
}

async function main(): Promise<void> {
  const failures: string[] = [];
  await mkdir(OUT_DIR, { recursive: true });

  console.log('building city harness bundle...');
  await buildHarness();

  const { server, port } = await serve(BUILD_DIR);
  const url = `http://127.0.0.1:${port}/harness/city.html`;
  console.log(`serving ${BUILD_DIR} at ${url}`);

  let browser: Browser | undefined;
  const report: Record<string, unknown> = {};

  try {
    browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
    const page: Page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

    const consoleErrors: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 180_000 });
    await page.waitForFunction(() => window.__CITY_HARNESS__?.ready === true, undefined, {
      timeout: 300_000,
    });

    const planSummary = await page.evaluate(() => window.__CITY_HARNESS__.planSummary());
    report.plan = planSummary;
    console.log('\nplan:', JSON.stringify(planSummary));

    const stage = page.locator('#stage');

    for (const view of VIEWS) {
      console.log(`\nrendering "${view.name}"...`);
      const stats = (await page.evaluate(
        (name) => window.__CITY_HARNESS__.setView(name as never),
        view.name
      )) as unknown as IHarnessStats;

      const file = path.join(OUT_DIR, view.file);
      await (view.cropPanel ? stage : page).screenshot({ path: file, type: 'png' });
      const pixels = await analyse(file);
      report[view.name] = { stats, pixels };

      console.log(
        `  chunks=${stats.chunks} blocks=${stats.blocks} buildings=${stats.buildings} ` +
          `tris=${stats.triangles.toLocaleString()} drawCalls=${stats.drawCallsRendered} ` +
          `worstBlock=${stats.drawCallsPerBlockWorst} gen=${stats.generationMs.toFixed(0)}ms`
      );
      console.log(
        `  resident 5x5 (${stats.residentReport.chunks} chunks, ${stats.residentReport.blocks} blocks): ` +
          `perBlock=${stats.residentReport.perBlockTotal} batched=${stats.residentReport.total} ` +
          `(blocks ${stats.residentReport.mergedBlockCalls} + ground ${stats.residentReport.groundCalls} + props ${stats.residentReport.propCalls})`
      );
      console.log(
        `  whole built region (${stats.regionReport.chunks} chunks): batched=${stats.regionReport.total}`
      );
      console.log(
        `  pixels: stdDev=${pixels.stdDev.toFixed(1)} colours=${pixels.colours} ` +
          `edges=${(pixels.edgeDensity * 100).toFixed(1)}% luma=${pixels.meanLuma.toFixed(0)}`
      );
      console.log(
        `  assets: ${stats.realMaterials} real materials, ${stats.realModels} real models, ` +
          `${stats.propsResolved} stand-in props` +
          (stats.assetProblems.length ? ` | problems: ${stats.assetProblems.join('; ')}` : '')
      );

      /* -------------------------- assertions -------------------------- */
      if (stats.drawCallsPerBlockWorst > 3) {
        failures.push(`${view.name}: a block cost ${stats.drawCallsPerBlockWorst} draw calls (max 3)`);
      }
      if (stats.residentReport.worstBlockCalls > 3) {
        failures.push(`${view.name}: resident report worst block ${stats.residentReport.worstBlockCalls}`);
      }
      if (stats.triangles < 20_000) {
        failures.push(`${view.name}: only ${stats.triangles} triangles drawn`);
      }
      if (pixels.stdDev < 8) failures.push(`${view.name}: image looks flat (stdDev ${pixels.stdDev.toFixed(1)})`);
      if (pixels.colours < 200) failures.push(`${view.name}: only ${pixels.colours} distinct colours`);
      if (pixels.edgeDensity < 0.05) {
        failures.push(
          `${view.name}: almost no edges (${(pixels.edgeDensity * 100).toFixed(1)}%) — the ` +
            `image is probably empty sky or flat ground`
        );
      }
      if (view.name === 'street') {
        if (stats.buildings < 60) failures.push(`street: only ${stats.buildings} buildings in view`);
        if (stats.propsResolved < 8) {
          failures.push(`street: only ${stats.propsResolved} prop models resolved`);
        }
      }
      if (view.name === 'map') {
        if (stats.chunks !== 256) failures.push(`map: built ${stats.chunks} chunks, expected 256`);
        // The entire static city, all 256 chunks, batched by material.
        if (stats.regionReport.total > 400) {
          failures.push(`map: whole-city batched total ${stats.regionReport.total}`);
        }
      }
    }

    // The resident set — 5 x 5 chunks around the focus, matching
    // `IWorldConfig.streamingRadiusChunks` — is the case the 90-call budget is
    // written for. Everything past it is backdrop the streaming system would
    // hold at impostor detail.
    for (const name of ['street', 'skyline', 'fracture'] as const) {
      const entry = report[name] as { stats: IHarnessStats };
      if (entry.stats.residentReport.total > 90) {
        failures.push(
          `${name}: resident 5x5 batched draw calls ${entry.stats.residentReport.total} exceeds 90`
        );
      }
      if (entry.stats.residentReport.worstBlockCalls > 3) {
        failures.push(`${name}: a resident block cost more than 3 draw calls`);
      }
    }
    const street = report.street as { stats: IHarnessStats };
    if (street.stats.drawCallsRendered > 260) {
      failures.push(`street frame issued ${street.stats.drawCallsRendered} draw calls`);
    }

    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 4).join(' | ')}`);
    }
  } finally {
    await browser?.close();
    server.close();
    await rm(BUILD_DIR, { recursive: true, force: true });
  }

  await writeFile(path.join(OUT_DIR, 'city-report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log('\n──────── result ────────');
  if (failures.length > 0) {
    console.error('CITY HARNESS FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('CITY HARNESS PASSED');
  console.log(`screenshots: ${OUT_DIR}`);
}

main().catch((error) => {
  console.error('city harness crashed:', error);
  process.exit(1);
});
