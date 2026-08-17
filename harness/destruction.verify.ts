/**
 * DESTRUCTION HARNESS VERIFICATION
 *
 * Bundles `harness/destruction.html` with Vite, serves it, drives it in
 * headless Chromium on SwiftShader, and writes three screenshots plus a report
 * into `docs/screenshots/`.
 *
 * The screenshots are EVIDENCE, not the test. The mid-collapse frame exists so
 * a person can answer the one question no assertion can: does this read as a
 * building coming down, or as geometry being switched off?
 *
 * The assertions here cover what a picture cannot:
 *
 *   • the normalised `aDestroyed` attribute really removes triangles on a real
 *     GPU pipeline — and writing 1 instead of 255 really does not, checked by
 *     reproducing the bug on purpose and requiring a bit-identical frame;
 *   • the 300-debris and 8-ragdoll caps hold under a punch that detaches and
 *     kills far more than either;
 *   • damage survives a stream-out / stream-in round trip onto freshly
 *     generated geometry;
 *   • the same seed and the same punch produce byte-identical rubble.
 *
 * NO FRAME TIMES. SwiftShader is a CPU rasteriser; a millisecond here says
 * nothing about a phone.
 *
 * Run: `npx tsx harness/destruction.verify.ts`
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
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-destruction-harness');

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
  '.wasm': 'application/wasm',
};

/* -------------------------------------------------------------------------- */
/* Shapes mirrored from the harness                                           */
/* -------------------------------------------------------------------------- */

interface IDestructionStats {
  readonly structures: number;
  readonly damagedStructures: number;
  readonly chunksDestroyed: number;
  readonly chunksDestroyedThisFrame: number;
  readonly debrisSpawned: number;
  readonly debrisLive: number;
  readonly visualOnlyDetaches: number;
  readonly collapsesTriggered: number;
  readonly floorsCollapsed: number;
  readonly pendingCollapseChunks: number;
  readonly ragdollsLaunched: number;
  readonly ragdollsSuppressed: number;
  readonly destroyedMassKg: number;
  readonly collateralTotal: number;
  readonly persistedPieces: number;
  readonly restoredChunks: number;
  readonly frame: number;
}

interface IHarnessStats {
  readonly frame: number;
  readonly structures: number;
  readonly unaddressableBuildings: number;
  readonly totalChunks: number;
  readonly destruction: IDestructionStats;
  readonly debrisLive: number;
  readonly debrisCapacity: number;
  readonly debrisSimulated: number;
  readonly debrisBallistic: number;
  readonly ragdollsActive: number;
  readonly ragdollsMax: number;
  readonly physicsBodies: number;
  readonly damagedChunks: number;
  readonly destroyedPieces: number;
  readonly damageResidentBytes: number;
  readonly detachEvents: number;
  readonly trianglesDrawn: number;
  readonly drawCalls: number;
  readonly generationMs: number;
}

interface IShaderTruthResult {
  readonly totalPixels: number;
  readonly changedWith255: number;
  readonly changedWith1: number;
  readonly hashIntact: number;
  readonly hashWith255: number;
  readonly hashWith1: number;
  readonly verticesFlagged: number;
}

interface IPersistenceResult {
  readonly buildingId: string;
  readonly destroyedBefore: number;
  readonly destroyedAfter: number;
  readonly identical: boolean;
  readonly meshWasPristine: boolean;
  readonly hiddenVerticesAfter: number;
  readonly maskPieces: number;
  readonly maskBytes: number;
}

interface IDeterminismResult {
  readonly runs: number;
  readonly detachCount: number;
  readonly identical: boolean;
  readonly firstDivergence: string | undefined;
  readonly digest: string;
}

declare global {
  interface Window {
    __DESTRUCTION_HARNESS__: {
      ready: boolean;
      reset(seed?: string): Promise<IHarnessStats>;
      punch(): IHarnessStats;
      step(frames: number): IHarnessStats;
      setLabel(text: string): void;
      render(): IHarnessStats;
      stats(): IHarnessStats | undefined;
      shaderTruth(): IShaderTruthResult;
      persistence(): IPersistenceResult;
      determinism(): Promise<IDeterminismResult>;
      punchSpec(): Record<string, number>;
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Bundle and serve                                                           */
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
      rollupOptions: {
        input: { destructionHarness: path.join(ROOT, 'harness', 'destruction.html') },
      },
    },
    publicDir: false,
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
        // Rapier's wasm is instantiated from a fetch; without this Chromium
        // refuses the streaming path and the harness never boots.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
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

/* -------------------------------------------------------------------------- */
/* Image analysis                                                             */
/* -------------------------------------------------------------------------- */

interface IPixelStats {
  readonly stdDev: number;
  readonly colours: number;
  readonly edgeDensity: number;
  readonly meanLuma: number;
}

/**
 * `sharp(file).extract(...).stats()` DOES NOT CROP.
 *
 * `stats()` reads the input and ignores whatever transforms are queued on the
 * pipeline, so a region assertion written that way passes vacuously against the
 * whole image. Two agents on this project have been caught by it. The fix is
 * to materialise through `.toBuffer()` first, which is what `regionStats` does
 * below — and there is an assertion at the bottom of `main` that proves the
 * crop actually happened.
 */
async function analyse(file: string): Promise<IPixelStats> {
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

interface IRegion {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Stats for a REGION, materialised through `toBuffer` so the crop is real. */
async function regionStats(file: string, region: IRegion): Promise<IPixelStats & { pixels: number }> {
  // MATERIALISE FIRST. See the note on `analyse`.
  const cropped = await sharp(file).extract(region).png().toBuffer();
  const stats = await sharp(cropped).stats();
  const channels = stats.channels.slice(0, 3);
  const meta = await sharp(cropped).metadata();
  const raw = await sharp(cropped).raw().toBuffer();

  const seen = new Set<number>();
  const channelCount = (meta.channels ?? 3) as number;
  for (let i = 0; i + 2 < raw.length; i += channelCount) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }
  return {
    stdDev: channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length,
    meanLuma: channels.reduce((sum, c) => sum + c.mean, 0) / channels.length,
    colours: seen.size,
    edgeDensity: 0,
    pixels: (meta.width ?? 0) * (meta.height ?? 0),
  };
}

/** Fraction of pixels that differ between two images of identical size. */
async function imageDifference(a: string, b: string): Promise<number> {
  const [rawA, rawB] = await Promise.all([
    sharp(a).removeAlpha().raw().toBuffer(),
    sharp(b).removeAlpha().raw().toBuffer(),
  ]);
  const length = Math.min(rawA.length, rawB.length);
  let differing = 0;
  for (let i = 0; i + 2 < length; i += 3) {
    if (
      Math.abs(rawA[i]! - rawB[i]!) > 8 ||
      Math.abs(rawA[i + 1]! - rawB[i + 1]!) > 8 ||
      Math.abs(rawA[i + 2]! - rawB[i + 2]!) > 8
    ) {
      differing++;
    }
  }
  return differing / (length / 3);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const failures: string[] = [];
  await mkdir(OUT_DIR, { recursive: true });

  console.log('building destruction harness bundle...');
  await buildHarness();

  const { server, port } = await serve(BUILD_DIR);
  const url = `http://127.0.0.1:${port}/harness/destruction.html`;
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
    await page.waitForFunction(() => window.__DESTRUCTION_HARNESS__?.ready === true, undefined, {
      timeout: 420_000,
    });

    const stage = page.locator('#stage');
    const punchSpec = await page.evaluate(() => window.__DESTRUCTION_HARNESS__.punchSpec());
    report.punch = punchSpec;
    console.log(`\npunch: ${JSON.stringify(punchSpec)}`);

    /* ---------------- 1. BEFORE ---------------- */

    const before = (await page.evaluate(() => {
      window.__DESTRUCTION_HARNESS__.setLabel('Before — City Z block, intact');
      return window.__DESTRUCTION_HARNESS__.render();
    })) as IHarnessStats;

    const beforeFile = path.join(OUT_DIR, 'destruction-before.png');
    await stage.screenshot({ path: beforeFile, type: 'png' });
    const beforePixels = await analyse(beforeFile);
    report.before = { stats: before, pixels: beforePixels };
    console.log(
      `\nbefore: ${before.structures} buildings, ${before.totalChunks.toLocaleString()} fracture chunks, ` +
        `${before.trianglesDrawn.toLocaleString()} triangles, ${before.drawCalls} draw calls`
    );
    console.log(
      `  pixels: stdDev=${beforePixels.stdDev.toFixed(1)} colours=${beforePixels.colours} ` +
        `edges=${(beforePixels.edgeDensity * 100).toFixed(1)}%`
    );

    /* ---------------- 2. THE PUNCH, MID-COLLAPSE ---------------- */

    const atPunch = (await page.evaluate(() => window.__DESTRUCTION_HARNESS__.punch())) as IHarnessStats;
    console.log(
      `\npunch frame: ${atPunch.destruction.chunksDestroyed} chunks off, ` +
        `${atPunch.destruction.collapsesTriggered} collapses queued ` +
        `(${atPunch.destruction.pendingCollapseChunks} chunks pending), ` +
        `${atPunch.destruction.debrisSpawned} debris bodies`
    );

    // 14 frames in: the collapse waves have all fired, the first pieces are
    // well clear of the wall and the upper storeys are still on their way down.
    const mid = (await page.evaluate(() => {
      window.__DESTRUCTION_HARNESS__.setLabel(
        'Mid-collapse — 14 frames after a full-charge serious punch'
      );
      return window.__DESTRUCTION_HARNESS__.step(14);
    })) as IHarnessStats;

    const midFile = path.join(OUT_DIR, 'destruction-mid-collapse.png');
    await stage.screenshot({ path: midFile, type: 'png' });
    const midPixels = await analyse(midFile);
    report.mid = { stats: mid, pixels: midPixels };
    console.log(
      `\nmid-collapse (frame ${mid.frame}): ${mid.destruction.chunksDestroyed} chunks off, ` +
        `${mid.debrisLive}/${mid.debrisCapacity} debris live ` +
        `(${mid.debrisSimulated} simulated + ${mid.debrisBallistic} ballistic), ` +
        `${mid.ragdollsActive}/${mid.ragdollsMax} ragdolls, ` +
        `${mid.destruction.pendingCollapseChunks} still queued`
    );
    console.log(
      `  pixels: stdDev=${midPixels.stdDev.toFixed(1)} colours=${midPixels.colours} ` +
        `edges=${(midPixels.edgeDensity * 100).toFixed(1)}%`
    );

    /* ---------------- 3. AFTER ---------------- */

    const after = (await page.evaluate(() => {
      window.__DESTRUCTION_HARNESS__.setLabel('After — the collapse settled, 4 s later');
      return window.__DESTRUCTION_HARNESS__.step(226);
    })) as IHarnessStats;

    const afterFile = path.join(OUT_DIR, 'destruction-after.png');
    await stage.screenshot({ path: afterFile, type: 'png' });
    const afterPixels = await analyse(afterFile);
    report.after = { stats: after, pixels: afterPixels };
    console.log(
      `\nafter (frame ${after.frame}): ${after.destruction.chunksDestroyed} chunks off ` +
        `(${(after.destruction.destroyedMassKg / 1000).toFixed(0)} t), ` +
        `${after.destruction.damagedStructures} buildings damaged, ` +
        `${after.destruction.collapsesTriggered} collapses, ` +
        `${after.destruction.visualOnlyDetaches} detaches over the debris budget`
    );
    console.log(
      `  pixels: stdDev=${afterPixels.stdDev.toFixed(1)} colours=${afterPixels.colours} ` +
        `edges=${(afterPixels.edgeDensity * 100).toFixed(1)}%`
    );

    /* ---------------- 4. THE SHADER TRUTH CHECK ---------------- */

    const shader = (await page.evaluate(() =>
      window.__DESTRUCTION_HARNESS__.shaderTruth()
    )) as IShaderTruthResult;
    report.shaderTruth = shader;
    const changed255 = (shader.changedWith255 / shader.totalPixels) * 100;
    const changed1 = (shader.changedWith1 / shader.totalPixels) * 100;
    console.log(
      `\nshader truth (${shader.verticesFlagged.toLocaleString()} vertices flagged):\n` +
        `  flag 255 -> ${changed255.toFixed(2)}% of the frame changed (hash ${shader.hashIntact.toString(16)} -> ${shader.hashWith255.toString(16)})\n` +
        `  flag   1 -> ${changed1.toFixed(4)}% of the frame changed (hash ${shader.hashWith1.toString(16)})`
    );

    /* ---------------- 5. PERSISTENCE ---------------- */

    const persistence = (await page.evaluate(() =>
      window.__DESTRUCTION_HARNESS__.persistence()
    )) as IPersistenceResult;
    report.persistence = persistence;
    console.log(
      `\npersistence: ${persistence.buildingId} — ${persistence.destroyedBefore} chunks destroyed, ` +
        `streamed out, regenerated (mesh pristine: ${persistence.meshWasPristine}), ` +
        `streamed in -> ${persistence.destroyedAfter} destroyed, identical: ${persistence.identical}, ` +
        `${persistence.hiddenVerticesAfter.toLocaleString()} vertices hidden on the fresh mesh`
    );
    console.log(
      `  8 KB bitmask: ${persistence.maskPieces} pieces recorded in ${persistence.maskBytes} B resident`
    );

    /* ---------------- 6. DETERMINISM ---------------- */

    const determinism = (await page.evaluate(() =>
      window.__DESTRUCTION_HARNESS__.determinism()
    )) as IDeterminismResult;
    report.determinism = determinism;
    console.log(
      `\ndeterminism: ${determinism.runs} runs x ${determinism.detachCount} detaches, ` +
        `identical: ${determinism.identical}, digest ${determinism.digest}` +
        (determinism.firstDivergence ? ` | diverged at ${determinism.firstDivergence}` : '')
    );

    /* ---------------- 7. PERSISTED VIEW ---------------- */

    await page.evaluate(() => {
      window.__DESTRUCTION_HARNESS__.setLabel(
        'Persisted — the damaged building streamed out and back in'
      );
      window.__DESTRUCTION_HARNESS__.render();
    });
    const persistedFile = path.join(OUT_DIR, 'destruction-persisted.png');
    await stage.screenshot({ path: persistedFile, type: 'png' });
    report.persistedPixels = await analyse(persistedFile);

    /* ======================= ASSERTIONS ======================= */

    // --- the shots are real renders, not blank canvases ---
    for (const [name, pixels] of [
      ['before', beforePixels],
      ['mid-collapse', midPixels],
      ['after', afterPixels],
    ] as const) {
      if (pixels.stdDev <= 10) {
        failures.push(`${name}: image is flat (stdDev ${pixels.stdDev.toFixed(1)}, need > 10)`);
      }
      if (pixels.colours <= 100) {
        failures.push(`${name}: only ${pixels.colours} distinct colours (need > 100)`);
      }
      if (pixels.edgeDensity < 0.04) {
        failures.push(
          `${name}: almost no edges (${(pixels.edgeDensity * 100).toFixed(1)}%) — probably empty sky`
        );
      }
    }

    // --- the punch actually did something, and something big ---
    if (before.destruction.chunksDestroyed !== 0) {
      failures.push(`before: ${before.destruction.chunksDestroyed} chunks were already destroyed`);
    }
    if (atPunch.destruction.chunksDestroyed < 40) {
      failures.push(`the punch only detached ${atPunch.destruction.chunksDestroyed} chunks`);
    }
    if (after.destruction.collapsesTriggered < 1) {
      failures.push('no building collapsed');
    }
    if (after.destruction.damagedStructures < 3) {
      failures.push(
        `only ${after.destruction.damagedStructures} buildings were damaged — the cone should ` +
          `reach a whole block`
      );
    }
    if (after.destruction.chunksDestroyed <= atPunch.destruction.chunksDestroyed) {
      failures.push('the collapse added nothing beyond the chunks the cone took directly');
    }
    if (after.detachEvents !== after.destruction.chunksDestroyed) {
      failures.push(
        `ChunkDetached emitted ${after.detachEvents} times for ` +
          `${after.destruction.chunksDestroyed} destroyed chunks — should be exactly one each`
      );
    }

    // --- the collapse was staggered, not a pop ---
    if (atPunch.destruction.pendingCollapseChunks <= 0) {
      failures.push('the collapse was not queued for later frames — nothing was staggered');
    }

    // --- the picture changed, a lot ---
    const beforeToMid = await imageDifference(beforeFile, midFile);
    const beforeToAfter = await imageDifference(beforeFile, afterFile);
    report.imageDifference = { beforeToMid, beforeToAfter };
    console.log(
      `\nimage difference: before -> mid ${(beforeToMid * 100).toFixed(1)}%, ` +
        `before -> after ${(beforeToAfter * 100).toFixed(1)}%`
    );
    if (beforeToMid < 0.02) {
      failures.push(
        `the mid-collapse frame differs from intact by only ${(beforeToMid * 100).toFixed(2)}% ` +
          `— the destruction is not visible`
      );
    }
    if (beforeToAfter < 0.02) {
      failures.push(
        `the settled frame differs from intact by only ${(beforeToAfter * 100).toFixed(2)}%`
      );
    }

    // --- THE NORMALISED-UINT8 TRAP, on a real GPU ---
    if (shader.changedWith255 / shader.totalPixels < 0.02) {
      failures.push(
        `writing DESTROYED_FLAG changed only ${changed255.toFixed(2)}% of the frame — the ` +
          `attribute is not removing triangles`
      );
    }
    if (shader.hashWith255 === shader.hashIntact) {
      failures.push('flagging every vertex destroyed produced a bit-identical frame');
    }
    if (shader.hashWith1 !== shader.hashIntact) {
      failures.push(
        `writing 1 instead of 255 changed the frame (${changed1.toFixed(4)}%) — the ` +
          `normalised-Uint8 regression no longer reproduces, so the trap test is meaningless`
      );
    }

    // --- caps ---
    if (after.debrisLive > after.debrisCapacity) {
      failures.push(`debris live ${after.debrisLive} exceeds capacity ${after.debrisCapacity}`);
    }
    if (mid.debrisLive > mid.debrisCapacity) {
      failures.push(`mid-collapse debris ${mid.debrisLive} exceeds capacity ${mid.debrisCapacity}`);
    }
    if (after.debrisCapacity !== 300) {
      failures.push(`debris capacity is ${after.debrisCapacity}, expected the 300 hard cap`);
    }
    if (after.destruction.debrisSpawned > after.debrisCapacity) {
      failures.push(
        `${after.destruction.debrisSpawned} bodies were spawned against a ${after.debrisCapacity} cap`
      );
    }
    if (after.destruction.chunksDestroyed <= after.debrisCapacity) {
      failures.push(
        `only ${after.destruction.chunksDestroyed} chunks came off — the cap was never actually ` +
          `put under pressure`
      );
    }
    if (after.destruction.visualOnlyDetaches < 1) {
      failures.push('no detach exceeded the debris budget, so the over-budget path is untested');
    }
    if (
      after.destruction.debrisSpawned + after.destruction.visualOnlyDetaches !==
      after.destruction.chunksDestroyed
    ) {
      failures.push(
        `debris ${after.destruction.debrisSpawned} + visual-only ` +
          `${after.destruction.visualOnlyDetaches} does not account for ` +
          `${after.destruction.chunksDestroyed} destroyed chunks`
      );
    }
    if (after.ragdollsActive > after.ragdollsMax) {
      failures.push(`ragdolls active ${after.ragdollsActive} exceeds cap ${after.ragdollsMax}`);
    }
    if (after.ragdollsMax !== 8) {
      failures.push(`ragdoll cap is ${after.ragdollsMax}, expected 8`);
    }
    if (after.destruction.ragdollsLaunched > 8) {
      failures.push(`${after.destruction.ragdollsLaunched} ragdolls were launched against a cap of 8`);
    }
    if (after.destruction.ragdollsLaunched < 1) {
      failures.push('no ragdoll was launched, so the cap was never exercised');
    }
    if (after.destruction.ragdollsSuppressed < 1) {
      failures.push('no ragdoll was suppressed — the cap was not put under pressure');
    }

    // --- persistence ---
    if (!persistence.meshWasPristine) {
      failures.push('the regenerated block mesh was not pristine, so the restore proves nothing');
    }
    if (!persistence.identical) {
      failures.push(
        `restored damage differs: ${persistence.destroyedBefore} chunks before, ` +
          `${persistence.destroyedAfter} after`
      );
    }
    if (persistence.destroyedAfter < 1) {
      failures.push('nothing was restored after the stream-out / stream-in round trip');
    }
    if (persistence.hiddenVerticesAfter < 1) {
      failures.push('the restored mesh has no hidden vertices — the replay did not touch geometry');
    }
    if (persistence.maskPieces < 1) {
      failures.push('nothing was written into the persistent 8 KB bitmask');
    }
    if (persistence.maskBytes > 8192) {
      failures.push(`the damage bitmask is holding ${persistence.maskBytes} B, over its 8 KB budget`);
    }

    // --- determinism ---
    if (!determinism.identical) {
      failures.push(
        `same seed produced different rubble${determinism.firstDivergence ? `: ${determinism.firstDivergence}` : ''}`
      );
    }
    if (determinism.detachCount < 40) {
      failures.push(`determinism run only detached ${determinism.detachCount} chunks`);
    }

    /* --- the region check, done properly --- */
    // The building line occupies the middle band of the frame. Comparing that
    // band before and after is what says the BUILDINGS changed rather than the
    // debris pile at the bottom of the shot.
    const stageBox = await stage.boundingBox();
    const width = Math.round(stageBox?.width ?? VIEWPORT.width - 340);
    const height = Math.round(stageBox?.height ?? VIEWPORT.height);
    const band: IRegion = {
      left: Math.round(width * 0.18),
      top: Math.round(height * 0.12),
      width: Math.round(width * 0.64),
      height: Math.round(height * 0.5),
    };
    const bandBefore = await regionStats(beforeFile, band);
    const bandAfter = await regionStats(afterFile, band);
    report.buildingBand = { region: band, before: bandBefore, after: bandAfter };
    console.log(
      `\nbuilding band ${band.width}x${band.height} (${bandBefore.pixels.toLocaleString()} px): ` +
        `luma ${bandBefore.meanLuma.toFixed(1)} -> ${bandAfter.meanLuma.toFixed(1)}, ` +
        `colours ${bandBefore.colours} -> ${bandAfter.colours}`
    );
    // The crop must actually be a crop. `sharp(...).extract(...).stats()`
    // silently ignores the extract; if that regression ever creeps back in,
    // this catches it because the pixel count would be the whole image.
    const expectedPixels = band.width * band.height;
    if (bandBefore.pixels !== expectedPixels) {
      failures.push(
        `region crop did not happen: ${bandBefore.pixels} px measured, ${expectedPixels} expected ` +
          `(the classic sharp extract/stats trap)`
      );
    }
    if (Math.abs(bandBefore.meanLuma - bandAfter.meanLuma) < 1) {
      failures.push('the building band looks unchanged after the collapse');
    }

    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 4).join(' | ')}`);
    }
    report.consoleErrors = consoleErrors.slice(0, 8);
  } finally {
    await browser?.close();
    server.close();
    await rm(BUILD_DIR, { recursive: true, force: true });
  }

  await writeFile(
    path.join(OUT_DIR, 'destruction-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  );

  console.log('\n──────── result ────────');
  if (failures.length > 0) {
    console.error('DESTRUCTION HARNESS FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('DESTRUCTION HARNESS PASSED');
  console.log(`screenshots: ${OUT_DIR}`);
}

main().catch((error) => {
  console.error('destruction harness crashed:', error);
  process.exit(1);
});
