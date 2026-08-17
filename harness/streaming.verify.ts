/**
 * CHUNK STREAMING HARNESS VERIFICATION
 *
 * Builds `harness/streaming.html` with Vite, serves it, and drives it in
 * headless Chromium through the whole protocol this workstream has to answer
 * for:
 *
 *   1. fly the 1500 m district traverse three times, out and back each lap;
 *   2. assert the hard budget held — never more than two uploads in a frame,
 *      and never a frame that spent 50 ms uploading;
 *   3. assert the heap and the resident set are the same after lap 3 as after
 *      lap 1 (the leak detector);
 *   4. assert the load ORDER put what the camera faced ahead of what was
 *      behind it;
 *   5. destroy buildings, stream the chunk out, stream it back in, and assert
 *      the destruction is still there and byte-identical;
 *   6. reload the page and assert the same seed produced the same city;
 *   7. assert the entire far city renders in ONE draw call;
 *   8. screenshot, and check the pixels are a picture rather than a flat field.
 *
 * ── ON NUMBERS ─────────────────────────────────────────────────────────────
 * Everything reported is main-thread CPU time from `performance.now()`, chunk
 * counts, byte counts and heap. FRAME RATE IS NEVER REPORTED: this runs under
 * SwiftShader, a CPU rasteriser, so fps here would be a measurement of the
 * software renderer and would say nothing about the streaming system on a
 * phone. The upload timings are real because they bracket real work that
 * happens on the real main thread.
 *
 * Run: `npx tsx harness/streaming.verify.ts`
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
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-streaming-harness');
const SHOT = path.join(OUT_DIR, 'streaming-harness.png');
const REPORT = path.join(OUT_DIR, 'streaming-report.json');

const VIEWPORT = { width: 1440, height: 900 };

const SWIFTSHADER_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  // Not decoration: without these the leak detector has no heap to read and
  // no way to collapse garbage before reading it.
  '--js-flags=--expose-gc',
  '--enable-precise-memory-info',
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/* -------------------------------------------------------------------------- */
/* Shapes mirrored from the harness                                           */
/* -------------------------------------------------------------------------- */

interface ILapReport {
  lap: number;
  frames: number;
  uploads: number;
  evictions: number;
  maxUploadsPerFrame: number;
  maxUploadMs: number;
  p95UploadMs: number;
  meanUploadMs: number;
  maxChunkUploadMs: number;
  framesOver4ms: number;
  framesOver50ms: number;
  maxUnloadMs: number;
  ringTransitions: number;
  heapBytes: number;
  residentChunks: number;
  residentBytes: number;
  geometries: number;
}

interface IPriorityReport {
  sampled: number;
  aheadMeanRank: number;
  behindMeanRank: number;
  aheadWorstRank: number;
  behindBestRank: number;
  strictlyOrdered: boolean;
  firstTenAheadFraction: number;
}

interface IDamageReport {
  chunk: number;
  buildingsBefore: number;
  buildingsAfterDestroy: number;
  destroyedPiecesAfterDestroy: number;
  hashAfterDestroy: number;
  evicted: boolean;
  buildingsAfterReload: number;
  destroyedPiecesAfterReload: number;
  hashAfterReload: number;
  persisted: boolean;
}

interface IDeterminismReport {
  worldFingerprint: number;
  chunksHashed: number;
  workerAgreements: number;
  workerMismatches: number;
}

interface IImpostorReport {
  built: boolean;
  buildings: number;
  triangles: number;
  bytes: number;
  generationTimeMs: number;
  uploadTimeMs: number;
  drawCalls: number;
  contentHash: number;
}

interface ISnapshot {
  ready: boolean;
  workersInline: boolean;
  workerCount: number;
  residentChunks: number;
  chunksByRing: number[];
  queued: number;
  inFlight: number;
  uploadsLastFrame: number;
  uploadMsLastFrame: number;
  peakUploadMs: number;
  totalLoads: number;
  totalEvictions: number;
  residentBytes: number;
  streamedIn: number;
  streamedOut: number;
  colliderChunks: number;
  colliderBoxes: number;
  crowdChunks: number;
  crowdSlots: number;
  pvsBytes: number;
  pvsAverageVisible: number;
  visibleChunks: number;
  sceneDrawCalls: number;
  sceneTriangles: number;
  settleTimeouts: number;
}

/* -------------------------------------------------------------------------- */
/* Build + serve                                                              */
/* -------------------------------------------------------------------------- */

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
      // A real bundle, not a dev server: the worker has to come out of Vite's
      // `new Worker(new URL(...), { type: 'module' })` transform exactly as it
      // will in the shipped build, and a dev server resolves that differently.
      rollupOptions: { input: { streamingHarness: path.join(ROOT, 'harness', 'streaming.html') } },
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
  const raw = await sharp(file).resize(96, 96, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }
  return { stdDev, colours: seen.size };
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const failures: string[] = [];
  const warnings: string[] = [];
  await mkdir(OUT_DIR, { recursive: true });

  console.log('building harness bundle...');
  await buildHarness();

  const { server, port } = await serve(BUILD_DIR);
  const url = `http://127.0.0.1:${port}/harness/streaming.html`;
  console.log(`serving ${BUILD_DIR} at ${url}`);

  let browser: Browser | undefined;
  let boot: ISnapshot | undefined;
  let laps: ILapReport[] | undefined;
  let priority: IPriorityReport | undefined;
  let damage: IDamageReport | undefined;
  let determinismA: IDeterminismReport | undefined;
  let determinismB: IDeterminismReport | undefined;
  let impostor: IImpostorReport | undefined;
  let final: ISnapshot | undefined;
  let pixels: { stdDev: number; colours: number } | undefined;

  try {
    browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
    const page: Page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

    const consoleErrors: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    console.log('loading harness (cold start builds the whole resident set)...');
    await page.goto(url, { waitUntil: 'load', timeout: 180_000 });
    await page.waitForFunction(() => window.__STREAMING_READY__ === true, undefined, {
      timeout: 600_000,
    });

    boot = (await page.evaluate(() =>
      window.__STREAMING_HARNESS__!.snapshot()
    )) as unknown as ISnapshot;
    console.log(`cold start: ${boot.residentChunks} chunks resident, workers inline = ${boot.workersInline}`);

    // The cold start IS the priority experiment: nothing was resident, so the
    // order chunks arrived in is the streamer's own ordering, unpolluted.
    priority = (await page.evaluate(() =>
      window.__STREAMING_HARNESS__!.priorityReport()
    )) as unknown as IPriorityReport;

    impostor = (await page.evaluate(() =>
      window.__STREAMING_HARNESS__!.impostorReport()
    )) as unknown as IImpostorReport;

    determinismA = (await page.evaluate(() =>
      window.__STREAMING_HARNESS__!.determinismReport()
    )) as unknown as IDeterminismReport;

    console.log('flying 3 laps of the 1500 m traverse (out and back each)...');
    laps = (await page.evaluate(() =>
      window.__STREAMING_HARNESS__!.runLaps(3)
    )) as unknown as ILapReport[];

    console.log('damage persistence probe...');
    damage = (await page.evaluate(() =>
      window.__STREAMING_HARNESS__!.runDamageProbe()
    )) as unknown as IDamageReport;

    await page.evaluate(() => window.__STREAMING_HARNESS__!.setCameraForShot());
    final = (await page.evaluate(() =>
      window.__STREAMING_HARNESS__!.snapshot()
    )) as unknown as ISnapshot;

    // Generous: one full-size frame through a CPU rasteriser is not fast, and a
    // screenshot failure must be reported as a failure rather than crash the
    // run and take every measurement above it with it.
    try {
      await page.screenshot({ path: SHOT, type: 'png', timeout: 180_000 });
      pixels = await analyse(SHOT);
    } catch (error) {
      failures.push(`screenshot failed: ${String(error)}`);
    }

    // Second run, same seed: does the city come back identical? A FRESH PAGE,
    // not a reload of the one that just flew three laps — that page is holding
    // a settled world and a large GPU allocation, and navigating it in place
    // makes the second boot compete with the first one's teardown.
    console.log('opening a second page for the cross-run determinism check...');
    await page.close();
    const secondPage = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    secondPage.on('pageerror', (error) => consoleErrors.push(`pageerror(2): ${error.message}`));
    await secondPage.goto(url, { waitUntil: 'commit', timeout: 180_000 });
    await secondPage.waitForFunction(() => window.__STREAMING_READY__ === true, undefined, {
      timeout: 600_000,
    });
    determinismB = (await secondPage.evaluate(() =>
      window.__STREAMING_HARNESS__!.determinismReport()
    )) as unknown as IDeterminismReport;

    /* ---------------------------- assertions ---------------------------- */

    if (boot.workersInline) {
      failures.push('worker pool fell back to the inline path — no real Web Workers ran');
    }
    // The flight starts near the western edge, so the resident disc is clipped
    // by the world boundary — 77 of a possible 169 at the medium tier.
    if (boot.residentChunks < 50) {
      failures.push(`cold start left only ${boot.residentChunks} chunks resident`);
    }

    for (const lap of laps) {
      if (lap.maxUploadsPerFrame > 2) {
        failures.push(`lap ${lap.lap}: ${lap.maxUploadsPerFrame} uploads in one frame (cap is 2)`);
      }
      if (lap.framesOver50ms > 0) {
        failures.push(
          `lap ${lap.lap}: ${lap.framesOver50ms} frame(s) spent over 50 ms uploading ` +
            `(worst ${lap.maxUploadMs.toFixed(2)} ms)`
        );
      }
      if (lap.uploads < 50) {
        failures.push(`lap ${lap.lap}: only ${lap.uploads} uploads — the traverse did not stream`);
      }
      if (lap.framesOver4ms > lap.frames * 0.02) {
        warnings.push(
          `lap ${lap.lap}: ${lap.framesOver4ms}/${lap.frames} frames exceeded the 4 ms soft budget`
        );
      }
    }

    // Leak detector. Every lap ends where it began, so the resident set and the
    // live geometry count must be IDENTICAL between laps — those are exact and
    // are the real assertion. Heap is reported and bounded loosely, because a
    // JS heap figure includes whatever the engine has not felt like collecting.
    if (laps.length === 3) {
      const [one, two, three] = laps as [ILapReport, ILapReport, ILapReport];
      // Laps 2 and 3 start from an identical state and must therefore end in an
      // identical one — an EXACT comparison, and the real leak assertion.
      // Lap 1 starts from the cold boot instead, so its end state can legitimately
      // differ by a chunk or two of ring-hysteresis history; it is checked with a
      // tolerance rather than excused.
      if (three.residentChunks !== two.residentChunks) {
        failures.push(
          `resident chunks drifted between laps 2 and 3: ` +
            `${two.residentChunks} -> ${three.residentChunks}`
        );
      }
      if (three.residentBytes !== two.residentBytes) {
        failures.push(
          `resident bytes drifted between laps 2 and 3: ${two.residentBytes} -> ${three.residentBytes}`
        );
      }
      if (three.geometries !== two.geometries) {
        failures.push(
          `live GPU geometries drifted between laps 2 and 3: ${two.geometries} -> ${three.geometries}`
        );
      }
      if (Math.abs(three.residentChunks - one.residentChunks) > 4) {
        failures.push(
          `resident chunks drifted across all three laps: ` +
            `${one.residentChunks} -> ${three.residentChunks}`
        );
      }
      if (three.geometries > one.geometries + 4) {
        failures.push(
          `live GPU geometries grew across all three laps: ${one.geometries} -> ${three.geometries}`
        );
      }
      if (one.heapBytes > 0) {
        const growth = (three.heapBytes - one.heapBytes) / one.heapBytes;
        if (growth > 0.2) {
          failures.push(
            `heap grew ${(growth * 100).toFixed(1)}% across laps ` +
              `(${mb(one.heapBytes)} -> ${mb(three.heapBytes)})`
          );
        }
      } else {
        warnings.push('performance.memory unavailable — heap growth not measured');
      }
    } else {
      failures.push(`expected 3 laps, got ${laps.length}`);
    }

    if (priority.sampled < 20) {
      failures.push(`priority sample too small (${priority.sampled} chunks)`);
    }
    if (priority.aheadMeanRank >= priority.behindMeanRank) {
      failures.push(
        `load order ignored the view direction: mean arrival rank ahead ` +
          `${priority.aheadMeanRank.toFixed(1)} vs behind ${priority.behindMeanRank.toFixed(1)}`
      );
    }
    if (!priority.strictlyOrdered) {
      warnings.push(
        `load order is not strictly separated: worst chunk ahead arrived at rank ` +
          `${priority.aheadWorstRank}, best behind at ${priority.behindBestRank}`
      );
    }

    if (!damage.persisted) {
      failures.push(
        `damage did not survive the round trip: ${JSON.stringify(damage)}`
      );
    }
    if (damage.buildingsAfterDestroy !== damage.buildingsBefore - 2) {
      failures.push(
        `destroying two buildings left ${damage.buildingsAfterDestroy} standing, ` +
          `expected ${damage.buildingsBefore - 2}`
      );
    }

    if (determinismA.worldFingerprint !== determinismB.worldFingerprint) {
      failures.push(
        `same seed produced two different cities: ` +
          `${determinismA.worldFingerprint} vs ${determinismB.worldFingerprint}`
      );
    }
    if (determinismA.workerMismatches > 0 || determinismB.workerMismatches > 0) {
      failures.push(
        `worker and main thread disagreed on chunk content ` +
          `(${determinismA.workerMismatches} + ${determinismB.workerMismatches} mismatches)`
      );
    }
    if (determinismA.workerAgreements < 50) {
      failures.push(`only ${determinismA.workerAgreements} chunks cross-checked against a worker`);
    }

    if (!impostor.built) failures.push('the impostor ring never baked');
    if (impostor.drawCalls !== 1) {
      failures.push(`the far city took ${impostor.drawCalls} draw calls, expected exactly 1`);
    }
    if (impostor.buildings < 500) {
      failures.push(`impostor holds only ${impostor.buildings} buildings`);
    }

    if (final.colliderBoxes < 10) failures.push('no static colliders were published');
    if (final.crowdSlots < 10) failures.push('no crowd slots were published');
    if (final.settleTimeouts > 0) {
      failures.push(
        `${final.settleTimeouts} settle(s) gave up — the streamer never went quiet, ` +
          'so every "after settling" number above is suspect'
      );
    }
    if (final.chunksByRing[0]! < 1 || final.chunksByRing[1]! < 1) {
      failures.push(`ring populations look wrong: ${JSON.stringify(final.chunksByRing)}`);
    }

    if (pixels === undefined) {
      failures.push('no screenshot was produced');
    } else {
      if (pixels.stdDev <= 10) {
        failures.push(`screenshot looks flat (stdDev ${pixels.stdDev.toFixed(2)})`);
      }
      if (pixels.colours <= 100) failures.push(`too few distinct colours (${pixels.colours})`);
    }

    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 4).join(' | ')}`);
    }

    console.log('\n──────── cold start ────────');
    console.log(JSON.stringify(boot, null, 2));
    console.log('\n──────── laps ────────');
    for (const lap of laps) {
      console.log(
        `lap ${lap.lap}: ${lap.frames} frames, ${lap.uploads} uploads, ${lap.evictions} evictions | ` +
          `upload ms max ${lap.maxUploadMs.toFixed(2)} p95 ${lap.p95UploadMs.toFixed(2)} ` +
          `mean ${lap.meanUploadMs.toFixed(2)} | max uploads/frame ${lap.maxUploadsPerFrame} | ` +
          `>4ms ${lap.framesOver4ms} >50ms ${lap.framesOver50ms} | ` +
          `heap ${mb(lap.heapBytes)} | resident ${lap.residentChunks} chunks ${mb(lap.residentBytes)} | ` +
          `geometries ${lap.geometries} | ring changes ${lap.ringTransitions}`
      );
    }
    console.log('\n──────── priority ────────');
    console.log(JSON.stringify(priority, null, 2));
    console.log('\n──────── damage ────────');
    console.log(JSON.stringify(damage, null, 2));
    console.log('\n──────── determinism ────────');
    console.log(JSON.stringify({ firstRun: determinismA, secondRun: determinismB }, null, 2));
    console.log('\n──────── impostor ────────');
    console.log(JSON.stringify(impostor, null, 2));
    console.log('\n──────── pixels ────────');
    console.log(JSON.stringify(pixels, null, 2));
    console.log(`saved: ${SHOT}`);
  } finally {
    // Written from `finally` so a crash anywhere above still leaves the numbers
    // that were collected before it — a run that died at the screenshot should
    // not throw away three laps of measurements.
    const report = {
      generatedAt: new Date().toISOString(),
      note:
        'Main-thread milliseconds from performance.now(). Frame rate deliberately ' +
        'not reported: the run is under SwiftShader, a CPU rasteriser.',
      boot,
      priority,
      laps,
      damage,
      determinism: { firstRun: determinismA, secondRun: determinismB },
      impostor,
      final,
      pixels,
      warnings,
      failures,
    };
    await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`saved: ${REPORT}`);

    await browser?.close();
    server.close();
    await rm(BUILD_DIR, { recursive: true, force: true });
  }

  console.log('\n──────── result ────────');
  for (const warning of warnings) console.warn(`  ! ${warning}`);
  if (failures.length > 0) {
    console.error('STREAMING HARNESS FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('STREAMING HARNESS PASSED');
}

main().catch((error) => {
  console.error('streaming harness crashed:', error);
  process.exit(1);
});
