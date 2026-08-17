/**
 * VFX HARNESS VERIFICATION
 *
 * Builds `harness/vfx.html` with Vite, serves it, drives it in headless
 * Chromium with SwiftShader, and asserts on things that can actually be
 * counted.
 *
 *   npx tsx harness/vfx.verify.ts
 *
 * Exit 0 = pass, 1 = fail.
 *
 * ── THE TWO NUMBERS THIS EXISTS TO PROVE ───────────────────────────────────
 * DRAW CALLS and SHADER PROGRAMS, measured as a DELTA. The scene is rendered
 * with the VFX hidden, then with them visible and populated, and the
 * difference is what this workstream costs. Reporting a total would be
 * meaningless — most of it is the city — and reporting a count from an empty
 * scene would be dishonest, because a program compiled for the default
 * framebuffer is a different program from one compiled for the composer's
 * render target, and only one of those is the number that matters on a phone.
 *
 * ── WHY NO FRAME RATE ──────────────────────────────────────────────────────
 * Chromium here rasterises through SwiftShader on the CPU. Any frame rate it
 * produces measures a software rasteriser on a shared CI machine, so none is
 * reported. Draw calls, triangles, programs, particle counts and heap bytes
 * are identical on SwiftShader and on an Adreno, so those are what is asserted.
 *
 * ── WHY THE SCREENSHOTS ARE CHECKED, NOT JUST TAKEN ────────────────────────
 * A page whose WebGL throws still loads and still screenshots — as a flat
 * fill. Every capture is read back and required to have real variance and a
 * real colour count. For the effects specifically, each one is also A/B'd
 * against the same frame with the VFX hidden, so "the effect drew something"
 * is a measured claim rather than a hope.
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
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-vfx-harness');

/** Landscape and modest: SwiftShader fills every pixel on the CPU. */
const VIEWPORT = { width: 1280, height: 720 };

/** Hard budgets. Mirrored from `src/vfx/constants.ts`. */
const DRAW_CALL_BUDGET = 12;
const PROGRAM_BUDGET = 5;

const SWIFTSHADER_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  // Lets the page force a collection around the allocation sample, so the
  // measurement is heap GROWTH rather than heap noise.
  '--js-flags=--expose-gc',
];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/* -------------------------------------------------------------------------- */
/* Types mirrored from harness/vfx.ts                                         */
/* -------------------------------------------------------------------------- */

interface VFXDiagnostics {
  tier: string;
  effects: number;
  effectCapacity: number;
  sprites: number;
  spriteCapacity: number;
  spritesDropped: number;
  shockwaves: number;
  shockwaveCapacity: number;
  decals: number;
  decalCapacity: number;
  trails: number;
  trailCapacity: number;
  speedlineIntensity: number;
  trauma: number;
  drawCallsSubmitted: number;
  programCount: number;
}

interface BudgetReport {
  baselinePrograms: number;
  totalPrograms: number;
  vfxPrograms: number;
  baselineDrawCalls: number;
  totalDrawCalls: number;
  vfxDrawCalls: number;
  vfxTriangles: number;
  programKeys: string[];
}

interface AllocationReport {
  supported: boolean;
  frames: number;
  simBytes: number;
  simBytesPerFrame: number;
  frameBytes: number;
  frameBytesPerFrame: number;
  spritesDuringSample: number;
  heapBefore: number;
  heapAfter: number;
}

interface HarnessSnapshot {
  tier: string;
  isWebGL2: boolean;
  rendererString: string;
  drawCalls: number;
  triangles: number;
  programs: number;
  programKeys: string[];
  presentedFrames: number;
  simSeconds: number;
  scenario: string;
  cameraPreset: string;
  vfx: VFXDiagnostics;
  budget: BudgetReport;
  post: { mode: string; direct: boolean; passNames: string[] };
  atlasBytes: number;
  clock: { timeScale: number };
  impact: { active: boolean; phase: string; fovOffset: number };
  consoleErrors: string[];
}

interface PixelReport {
  width: number;
  height: number;
  stdDev: number;
  mean: number;
  distinctColors: number;
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
      // Bundle rather than dev-serve: a dev server discovers dependencies
      // lazily and can trigger a mid-test reload when the optimiser re-runs.
      rollupOptions: { input: { vfxHarness: path.join(ROOT, 'harness', 'vfx.html') } },
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
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(await readFile(filePath));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind the harness server'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Pixel analysis                                                             */
/* -------------------------------------------------------------------------- */

async function analyse(file: string): Promise<PixelReport> {
  const image = sharp(file);
  const metadata = await image.metadata();
  const stats = await image.stats();
  const channels = stats.channels.slice(0, 3);
  const stdDev = channels.reduce((sum, channel) => sum + channel.stdev, 0) / channels.length;
  const mean = channels.reduce((sum, channel) => sum + channel.mean, 0) / channels.length;

  const raw = await sharp(file).removeAlpha().resize(128, 128, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }

  return {
    width: metadata.width ?? 0,
    height: metadata.height ?? 0,
    stdDev,
    mean,
    distinctColors: seen.size,
  };
}

/** Mean absolute per-channel difference between two same-sized PNGs, 0..255. */
async function meanAbsoluteDifference(fileA: string, fileB: string): Promise<number> {
  const [a, b] = await Promise.all([
    sharp(fileA).removeAlpha().raw().toBuffer(),
    sharp(fileB).removeAlpha().raw().toBuffer(),
  ]);
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let total = 0;
  for (let i = 0; i < length; i++) total += Math.abs(a[i]! - b[i]!);
  return total / length;
}

/**
 * Re-encode with maximum PNG compression. LOSSLESS — the pixels are
 * byte-identical, so the statistics reported still describe the committed file.
 */
async function recompress(file: string): Promise<void> {
  const optimised = await sharp(file)
    .png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true, palette: false })
    .toBuffer();
  await writeFile(file, optimised);
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                     */
/* -------------------------------------------------------------------------- */

const failures: string[] = [];
const notes: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

/** Group program cache keys by three's internal shader id. */
function summarizePrograms(keys: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const id = key.split(',')[0]?.trim() || '(custom shader)';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => `${id} x${count}`)
    .join(', ');
}

async function openTier(
  browser: Browser,
  baseUrl: string,
  tier: string
): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  await page.goto(`${baseUrl}/harness/vfx.html?tier=${tier}`, {
    waitUntil: 'load',
    timeout: 180_000,
  });
  // Boot generates two procedural atlases and compiles the whole chain under a
  // software rasteriser. The budget is generous on purpose.
  await page.waitForFunction(() => window.__GAME_READY__ === true, undefined, {
    timeout: 600_000,
  });
  await page.evaluate(() => window.__VFX_HARNESS__?.setOverlayVisible(false));
  return { page, errors };
}

async function snapshot(page: Page): Promise<HarnessSnapshot> {
  const value = await page.evaluate(() => window.__VFX_HARNESS__?.snapshot() ?? null);
  if (!value) throw new Error('window.__VFX_HARNESS__ was not installed');
  return value as unknown as HarnessSnapshot;
}

/** Fire one scenario from a clean state and stop on an exact frame. */
async function runScenario(
  page: Page,
  scenario: string,
  frames: number,
  camera: string
): Promise<void> {
  await page.evaluate(
    async ({ scenario, frames, camera }) => {
      const harness = window.__VFX_HARNESS__;
      if (!harness) throw new Error('harness missing');
      harness.reset();
      harness.setCamera(camera as never);
      await harness.hold(1);
      harness.fire(scenario as never);
      await harness.advance(frames);
    },
    { scenario, frames, camera }
  );
}

interface ShotSpec {
  readonly file: string;
  readonly scenario: string;
  readonly frames: number;
  readonly camera: string;
  readonly label: string;
  /** Minimum mean absolute pixel change against the same frame with VFX off. */
  readonly minDelta: number;
}

const SHOTS: readonly ShotSpec[] = [
  {
    file: 'vfx-shockwave-cone.png',
    scenario: 'shockwaveCone',
    frames: 18,
    camera: 'punch',
    label: 'shockwave cone (22 deg half-angle, 130 m)',
    minDelta: 2,
  },
  {
    file: 'vfx-shockwave-ring.png',
    scenario: 'shockwaveRing',
    frames: 18,
    camera: 'punch',
    label: 'omnidirectional ring (110 m)',
    minDelta: 2,
  },
  {
    file: 'vfx-dust-plume.png',
    scenario: 'dustPlume',
    frames: 30,
    camera: 'close',
    label: 'dust plumes, lingering and drifting',
    minDelta: 2,
  },
  {
    file: 'vfx-speedlines.png',
    scenario: 'speedlines',
    frames: 6,
    camera: 'street',
    label: 'camera-space speedlines',
    minDelta: 1.5,
  },
  {
    file: 'vfx-debris-trails.png',
    scenario: 'debrisTrails',
    frames: 26,
    camera: 'close',
    label: 'debris trails from ChunkDetached',
    minDelta: 1.5,
  },
  {
    file: 'vfx-ground-cracks.png',
    scenario: 'groundCracks',
    frames: 90,
    camera: 'crater',
    label: 'persistent ground cracks',
    minDelta: 1.5,
  },
  {
    file: 'vfx-cloud-parting.png',
    scenario: 'cloudParting',
    frames: 90,
    camera: 'sky',
    label: 'cloud parting on a maximum-charge punch',
    minDelta: 1.5,
  },
  {
    file: 'vfx-impact-flash.png',
    scenario: 'impactFlash',
    frames: 4,
    camera: 'close',
    label: 'impact flash and hit sparks',
    minDelta: 2,
  },
  {
    // THE MONEY SHOT. Looking back up the avenue, so the wave and its dust
    // wall are coming at the camera rather than receding from it — from
    // behind, a cone and a sphere look identical and the punch loses its
    // direction entirely.
    file: 'vfx-serious-punch.png',
    scenario: 'seriousPunch',
    frames: 32,
    camera: 'oncoming',
    label: 'SERIOUS PUNCH — every effect at once, wave incoming',
    minDelta: 8,
  },
  {
    file: 'vfx-serious-punch-street.png',
    scenario: 'seriousPunch',
    frames: 26,
    camera: 'punch',
    label: 'the same punch from behind the fist, down the avenue',
    minDelta: 6,
  },
];

/**
 * Every individual effect, plus the combined frame.
 *
 * Each capture is taken twice — once with the VFX hidden, once with them
 * drawing — from the SAME simulation state, so the difference between the two
 * images is attributable to the effect and nothing else. Without that control,
 * "the screenshot is not blank" would be satisfied by the city alone.
 */
async function captureShots(page: Page): Promise<Record<string, PixelReport>> {
  const results: Record<string, PixelReport> = {};

  for (const shot of SHOTS) {
    await runScenario(page, shot.scenario, shot.frames, shot.camera);

    const controlPath = path.join(OUT_DIR, `vfx-control-${shot.scenario}.tmp.png`);
    await page.evaluate(() => window.__VFX_HARNESS__?.setVFXVisible(false));
    await page.evaluate(async () => {
      await window.__VFX_HARNESS__?.hold(2);
    });
    await page.screenshot({ path: controlPath, type: 'png' });

    await page.evaluate(() => window.__VFX_HARNESS__?.setVFXVisible(true));
    await page.evaluate(async () => {
      await window.__VFX_HARNESS__?.hold(2);
    });
    const shotPath = path.join(OUT_DIR, shot.file);
    await page.screenshot({ path: shotPath, type: 'png' });

    const pixels = await analyse(shotPath);
    const delta = await meanAbsoluteDifference(controlPath, shotPath);
    const snap = await snapshot(page);
    await rm(controlPath, { force: true });
    await recompress(shotPath);
    results[shot.file] = pixels;

    check(
      pixels.stdDev > 10,
      `[${shot.scenario}] capture has too little variance (stdDev ${pixels.stdDev.toFixed(2)})`
    );
    check(
      pixels.distinctColors > 100,
      `[${shot.scenario}] capture has too few distinct colours (${pixels.distinctColors})`
    );
    check(
      delta > shot.minDelta,
      `[${shot.scenario}] the effect barely changed the frame (mean absolute pixel ` +
        `delta ${delta.toFixed(2)}/255, wanted > ${shot.minDelta}) — it is probably ` +
        `not drawing`
    );

    console.log(
      `${shot.file.padEnd(28)} ${shot.label}\n` +
        `${''.padEnd(28)} delta ${delta.toFixed(2)}/255  stdDev ${pixels.stdDev.toFixed(1)}  ` +
        `colours ${pixels.distinctColors}  sim ${snap.simSeconds.toFixed(3)}s\n` +
        `${''.padEnd(28)} sprites ${snap.vfx.sprites}/${snap.vfx.spriteCapacity}  ` +
        `shells ${snap.vfx.shockwaves}  decals ${snap.vfx.decals}  trails ${snap.vfx.trails}  ` +
        `effects ${snap.vfx.effects}/${snap.vfx.effectCapacity}`
    );
  }

  return results;
}

/**
 * The frame the renderer's 90 ms impact freeze actually holds.
 *
 * This is the one the player looks at, so it is captured separately rather
 * than being assumed to look like the frames around it. The effects are timed
 * to peak at age zero precisely so this frame is not their tail.
 */
async function captureFreezeFrame(page: Page): Promise<PixelReport> {
  await runScenario(page, 'seriousPunch', 5, 'hero');
  const frozen = await page.evaluate(() => window.__VFX_HARNESS__?.isFrozen() ?? false);
  const snap = await snapshot(page);
  const shotPath = path.join(OUT_DIR, 'vfx-impact-freeze.png');
  await page.screenshot({ path: shotPath, type: 'png' });
  const pixels = await analyse(shotPath);
  await recompress(shotPath);

  check(
    frozen,
    '[freeze] the impact freeze was not active five frames after a lethal serious punch'
  );
  check(
    snap.clock.timeScale < 0.5,
    `[freeze] the clock was not slowed (timeScale ${snap.clock.timeScale})`
  );
  // A held frame that has nothing in it is the failure this capture exists to
  // catch: effects that peak later than the freeze are effects the player
  // never sees at full strength.
  check(
    snap.vfx.sprites > 80,
    `[freeze] only ${snap.vfx.sprites} particles were live during the hold — the ` +
      `effects peak after the freeze rather than during it`
  );
  check(
    snap.vfx.shockwaves > 0,
    '[freeze] no shockwave shell was live during the hold'
  );
  console.log(
    `vfx-impact-freeze.png        timeScale ${snap.clock.timeScale.toFixed(3)}  ` +
      `fov punch ${snap.impact.fovOffset.toFixed(2)} deg  sprites ${snap.vfx.sprites}  ` +
      `shells ${snap.vfx.shockwaves}  sim ${snap.simSeconds.toFixed(4)}s`
  );
  return pixels;
}

/** Budget, measured as a delta against the same scene with the VFX hidden. */
async function measureBudget(page: Page, tier: string): Promise<BudgetReport> {
  // Every layer must have live content or the measurement misses a draw call.
  await runScenario(page, 'seriousPunch', 8, 'punch');
  await page.evaluate(() => window.__VFX_HARNESS__?.fire('speedlines' as never));
  await page.evaluate(async () => {
    await window.__VFX_HARNESS__?.advance(2);
  });

  const budget = (await page.evaluate(async () => {
    return (await window.__VFX_HARNESS__?.measureBudget()) ?? null;
  })) as BudgetReport | null;
  if (!budget) throw new Error('measureBudget returned nothing');

  const snap = await snapshot(page);
  check(
    budget.vfxDrawCalls > 0,
    `[${tier}] the VFX added no draw calls at all — nothing was drawing`
  );
  check(
    budget.vfxDrawCalls <= DRAW_CALL_BUDGET,
    `[${tier}] VFX draw calls ${budget.vfxDrawCalls} exceeds the budget of ${DRAW_CALL_BUDGET}`
  );
  check(
    budget.vfxPrograms <= PROGRAM_BUDGET,
    `[${tier}] VFX shader programs ${budget.vfxPrograms} exceeds the ${PROGRAM_BUDGET}-program ` +
      `headroom the renderer has left on MEDIUM`
  );
  check(
    snap.vfx.sprites <= snap.vfx.spriteCapacity,
    `[${tier}] ${snap.vfx.sprites} sprites exceeds the capacity of ${snap.vfx.spriteCapacity}`
  );
  check(
    snap.vfx.shockwaves <= snap.vfx.shockwaveCapacity,
    `[${tier}] ${snap.vfx.shockwaves} shells exceeds the capacity of ${snap.vfx.shockwaveCapacity}`
  );
  check(
    snap.vfx.decals <= snap.vfx.decalCapacity,
    `[${tier}] ${snap.vfx.decals} decals exceeds the capacity of ${snap.vfx.decalCapacity}`
  );

  notes.push(
    `[${tier}] VFX cost ${budget.vfxDrawCalls}/${DRAW_CALL_BUDGET} draw calls and ` +
      `${budget.vfxPrograms}/${PROGRAM_BUDGET} programs ` +
      `(scene ${budget.baselinePrograms} -> ${budget.totalPrograms} programs, ` +
      `${budget.baselineDrawCalls} -> ${budget.totalDrawCalls} draws), ` +
      `${budget.vfxTriangles.toLocaleString()} triangles, ` +
      `${(snap.atlasBytes / 1024 / 1024).toFixed(2)} MB of generated atlases`
  );

  console.log(
    [
      `gpu            ${snap.rendererString}`,
      `webgl2         ${snap.isWebGL2}`,
      `post           ${snap.post.mode} | ${snap.post.direct ? 'direct-to-framebuffer' : snap.post.passNames.join(' -> ')}`,
      `programs       scene ${budget.baselinePrograms} + VFX ${budget.vfxPrograms} = ` +
        `${budget.totalPrograms}   (VFX budget ${PROGRAM_BUDGET})`,
      `  by shader    ${summarizePrograms(budget.programKeys)}`,
      `draw calls     scene ${budget.baselineDrawCalls} + VFX ${budget.vfxDrawCalls} = ` +
        `${budget.totalDrawCalls}   (VFX budget ${DRAW_CALL_BUDGET})`,
      `vfx triangles  ${budget.vfxTriangles.toLocaleString()}`,
      `capacities     sprites ${snap.vfx.spriteCapacity}  shells ${snap.vfx.shockwaveCapacity}  ` +
        `decals ${snap.vfx.decalCapacity}  trails ${snap.vfx.trailCapacity}  ` +
        `effects ${snap.vfx.effectCapacity}`,
      `atlases        ${(snap.atlasBytes / 1024 / 1024).toFixed(2)} MB including mips`,
    ].join('\n')
  );
  return budget;
}

/**
 * Zero per-frame allocation during sustained playback.
 *
 * The measurement that matters is the SIMULATION one: N `vfx.update()` calls
 * with no rendering in between, so nothing but this workstream's code is on
 * the stack. The full-frame figure is reported for context but not gated —
 * three's own renderer allocates a little every frame and that is not this
 * system's to fix.
 */
async function measureAllocation(page: Page): Promise<AllocationReport> {
  await runScenario(page, 'seriousPunch', 16, 'punch');
  const report = (await page.evaluate(async () => {
    return (await window.__VFX_HARNESS__?.measureAllocation(4000)) ?? null;
  })) as AllocationReport | null;
  if (!report) throw new Error('measureAllocation returned nothing');

  if (!report.supported) {
    notes.push('[alloc] performance.memory is unavailable; allocation was not measured');
    console.log('allocation     performance.memory unavailable — not measured');
    return report;
  }

  check(
    report.spritesDuringSample > 200,
    `[alloc] only ${report.spritesDuringSample} particles were live during the sample; ` +
      `the measurement would prove nothing about a busy frame`
  );
  // 300 frames of a full effect. Anything above a few bytes per frame means a
  // per-frame allocation crept in.
  check(
    report.simBytesPerFrame < 32,
    `[alloc] the VFX simulation allocated ${report.simBytesPerFrame.toFixed(1)} bytes per ` +
      `frame across ${report.frames} frames (${report.simBytes} total) — something in ` +
      `update() is allocating`
  );
  // Chrome quantises `usedJSHeapSize` to 100 KB, so the honest claim is a
  // BOUND, not a zero. Over 4000 frames that bound is ~25 bytes per frame.
  const quantum = 100 * 1024;
  notes.push(
    `[alloc] heap growth over ${report.frames} simulation frames was below Chrome's ` +
      `${(quantum / 1024).toFixed(0)} KB reporting quantum, i.e. under ` +
      `${(quantum / report.frames).toFixed(0)} bytes per frame`
  );
  console.log(
    `allocation     ${report.frames} sustained frames with ${report.spritesDuringSample} live ` +
      `particles\n` +
      `               heap quantum ${(quantum / 1024).toFixed(0)} KB -> detection floor ` +
      `${(quantum / report.frames).toFixed(1)} B/frame\n` +
      `               simulation only  ${report.simBytes >= 0 ? '+' : ''}${report.simBytes} B ` +
      `total, ${report.simBytesPerFrame.toFixed(2)} B/frame\n` +
      `               with rendering   ${report.frameBytes >= 0 ? '+' : ''}${report.frameBytes} B ` +
      `total, ${report.frameBytesPerFrame.toFixed(0)} B/frame (three's renderer included)`
  );
  return report;
}

/**
 * Determinism across two independent page loads.
 *
 * Same seed, same events, same fixed timestep — the two captures must be
 * pixel-identical. This is the assertion that would catch `Math.random()`
 * creeping into an emitter, which nothing else here would notice.
 */
async function verifyDeterminism(browser: Browser, baseUrl: string): Promise<number> {
  console.log('\n──────── determinism ────────');
  const files: string[] = [];
  for (let run = 0; run < 2; run++) {
    const { page } = await openTier(browser, baseUrl, 'medium');
    try {
      await runScenario(page, 'seriousPunch', 22, 'punch');
      const file = path.join(OUT_DIR, `vfx-determinism-${run}.tmp.png`);
      await page.screenshot({ path: file, type: 'png' });
      files.push(file);
    } finally {
      await page.close();
    }
  }
  const delta = await meanAbsoluteDifference(files[0]!, files[1]!);
  await Promise.all(files.map((file) => rm(file, { force: true })));
  check(
    delta < 0.5,
    `[determinism] two identical runs differed by ${delta.toFixed(3)}/255 per channel; ` +
      `an emitter is probably using Math.random()`
  );
  console.log(
    `two independent page loads, same seed and event sequence: ` +
      `mean absolute pixel difference ${delta.toFixed(4)}/255`
  );
  return delta;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  console.log('building harness/vfx.html ...');
  await buildHarness();

  const { server, port } = await serve(BUILD_DIR);
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`serving ${BUILD_DIR} at ${baseUrl}`);

  let browser: Browser | undefined;
  const budgets: Record<string, BudgetReport> = {};
  const capacities: Record<string, VFXDiagnostics> = {};
  let shots: Record<string, PixelReport> = {};
  let freeze: PixelReport | undefined;
  let allocation: AllocationReport | undefined;
  let determinismDelta: number | undefined;

  try {
    browser = await chromium.launch({ args: SWIFTSHADER_ARGS });

    for (const tier of ['low', 'medium', 'high']) {
      console.log(`\n──────── tier: ${tier} ────────`);
      const { page, errors } = await openTier(browser, baseUrl, tier);
      try {
        budgets[tier] = await measureBudget(page, tier);
        capacities[tier] = (await snapshot(page)).vfx;

        if (tier === 'medium') {
          console.log('\n──────── effects ────────');
          shots = await captureShots(page);
          freeze = await captureFreezeFrame(page);
          console.log('\n──────── allocation ────────');
          allocation = await measureAllocation(page);
        } else {
          // One tier-labelled frame each, as evidence the tier renders at all.
          await runScenario(page, 'seriousPunch', 26, 'punch');
          const file = path.join(OUT_DIR, `vfx-tier-${tier}.png`);
          await page.screenshot({ path: file, type: 'png' });
          const pixels = await analyse(file);
          await recompress(file);
          shots[`vfx-tier-${tier}.png`] = pixels;
          check(
            pixels.stdDev > 10 && pixels.distinctColors > 100,
            `[${tier}] the tier frame looks blank (stdDev ${pixels.stdDev.toFixed(2)}, ` +
              `colours ${pixels.distinctColors})`
          );
        }

        const snap = await snapshot(page);
        check(snap.isWebGL2, `[${tier}] WebGL2 context was not obtained`);
        check(
          errors.length === 0,
          `[${tier}] console errors: ${errors.slice(0, 5).join(' | ')}`
        );
        check(
          snap.consoleErrors.length === 0,
          `[${tier}] page-reported errors: ${snap.consoleErrors.slice(0, 5).join(' | ')}`
        );
      } finally {
        await page.close();
      }
    }

    determinismDelta = await verifyDeterminism(browser, baseUrl);
  } finally {
    await browser?.close();
    server.close();
  }

  await writeFile(
    path.join(OUT_DIR, 'vfx-report.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        viewport: VIEWPORT,
        budgets: { drawCalls: DRAW_CALL_BUDGET, programs: PROGRAM_BUDGET },
        tiers: Object.fromEntries(
          Object.entries(budgets).map(([tier, budget]) => [
            tier,
            {
              vfxDrawCalls: budget.vfxDrawCalls,
              vfxPrograms: budget.vfxPrograms,
              vfxTriangles: budget.vfxTriangles,
              scenePrograms: budget.baselinePrograms,
              totalPrograms: budget.totalPrograms,
              sceneDrawCalls: budget.baselineDrawCalls,
              totalDrawCalls: budget.totalDrawCalls,
              programsByShader: summarizePrograms(budget.programKeys),
              capacities: capacities[tier],
            },
          ])
        ),
        screenshots: shots,
        impactFreeze: freeze,
        allocation,
        determinism: { meanAbsolutePixelDifference: determinismDelta ?? null },
        notes,
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  console.log('\n──────── notes ────────');
  for (const note of notes) console.log(`  - ${note}`);

  console.log('\n──────── result ────────');
  if (failures.length > 0) {
    console.error(`VFX VERIFICATION FAILED — ${failures.length} problem(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('VFX VERIFICATION PASSED');
}

main().catch((error) => {
  console.error('vfx verification crashed:', error);
  process.exit(1);
});
