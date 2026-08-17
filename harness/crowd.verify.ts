/**
 * CROWD HARNESS DRIVER
 *
 * Serves `harness/crowd.html` through a real Vite build, drives it in headless
 * Chromium over SwiftShader, asserts the numbers the page publishes, and writes
 * the frames to `docs/screenshots/`.
 *
 * ── WHAT THIS ADDS OVER THE UNIT TESTS ────────────────────────────────────
 * `src/entities/npc/__tests__` already proves the simulation headlessly. What
 * it cannot prove is that the crowd RENDERS in six draw calls, because a draw
 * call only exists inside a real WebGL context. So the draw-call claim, the
 * VAT shader patch and the wardrobe recolour are only ever verified here.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT MEASURE ─────────────────────────────
 * Frames per second. The container has no GPU and rasterises through
 * SwiftShader on the CPU, so a frame time here is a measurement of a software
 * rasteriser and would be a lie about a phone. CPU SIMULATION time is
 * meaningful and is reported instead, taken with `performance.now()` around
 * the crowd update inside the page.
 *
 * Run: `npx tsx harness/crowd.verify.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');

/** The container has no GPU. */
const CHROME_FLAGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

interface ConvergenceReport {
  tested: number;
  converged: number;
  cycles: number;
  stalled: number;
  longestWalk: number;
}

interface CrowdStats {
  savedByPlayer: number;
  mode: string;
  seed: number;
  buildings: number;
  agents: number;
  near: number;
  mid: number;
  farEstimate: number;
  moods: Record<string, number>;
  gawkFraction: number;
  panicFraction: number;
  peakFlee: number;
  peakGawk: number;
  peakCower: number;
  crowdDrawCalls: number;
  sceneDrawCalls: number;
  crowdTriangles: number;
  instances: number;
  archetypeMeshes: number;
  distinctOffsets: number;
  paletteBytes: number;
  simMsMean: number;
  simMsMedian: number;
  simMsP95: number;
  simMsMax: number;
  alarmMs: number;
  flowMs: number;
  frames: number;
  frontSamples: { t: number; radius: number }[];
  frontSpeed: number;
  frontFinal: number;
  minSeparation: number;
  buildingPenetrations: number;
  penetrationChecks: number;
  fleeConvergence: ConvergenceReport;
  commuteConvergence: ConvergenceReport;
  directionsIntoWalls: number;
  saved: number;
  lost: number;
  witnessedSaves: number;
  savedEvents: number;
  lostEvents: number;
  lostByPlayer: number;
  outcomesWithLineOfSight: number;
  outcomesWithBystanders: number;
  allies: { name: string; health: number; maxHealth: number; reEngagements: number; dead: boolean }[];
  allyDowned: string[];
  mumenReEngagements: number;
  determinismHash: number;
  determinismTwinHash: number;
  deterministic: boolean;
}

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${message}`);
}

interface Mode {
  readonly name: string;
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

const ALL_MODES: readonly Mode[] = [
  { name: 'panic', file: 'crowd-panic.png', width: 1680, height: 940 },
  { name: 'fields', file: 'crowd-fields.png', width: 1280, height: 1280 },
  { name: 'calm', file: 'crowd-calm.png', width: 1680, height: 940 },
];

/** `npx tsx harness/crowd.verify.ts panic` runs one mode while iterating. */
const only = process.argv[2];
const MODES = only === undefined ? ALL_MODES : ALL_MODES.filter((m) => m.name === only);

/** A page that threw still screenshots — as a flat rectangle. Check pixels. */
async function analyse(file: string): Promise<{ stdDev: number; colours: number }> {
  const stats = await sharp(file).stats();
  const channels = stats.channels.slice(0, 3);
  const stdDev = channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length;
  const raw = await sharp(file).resize(96, 96, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  const stride = raw.length / (96 * 96);
  for (let i = 0; i + 2 < raw.length; i += stride) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }
  return { stdDev, colours: seen.size };
}

async function main(): Promise<void> {
  let server: ViteDevServer | undefined;
  const browser = await chromium.launch({ args: CHROME_FLAGS });
  const collected: Record<string, unknown> = {};

  try {
    server = await createServer({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.ts'),
      logLevel: 'warn',
      server: { port: 0, strictPort: false, host: '127.0.0.1' },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) throw new Error('vite dev server did not report a URL');
    await mkdir(OUT_DIR, { recursive: true });

    for (const mode of MODES) {
      console.log(`\n─── ${mode.name} ───`);
      const page = await browser.newPage({ viewport: { width: mode.width, height: mode.height } });
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(error.message));

      const target = new URL('harness/crowd.html', url);
      target.searchParams.set('mode', mode.name);
      await page.goto(target.href, { waitUntil: 'load', timeout: 240_000 });
      await page.waitForFunction(() => window.__HARNESS_READY__ === true, undefined, {
        timeout: 240_000,
      });

      const pageError = await page.evaluate(() => window.__HARNESS_ERROR__);
      if (pageError !== undefined) throw new Error(`harness (${mode.name}) threw:\n${pageError}`);

      const stats = (await page.evaluate(() => window.__HARNESS_STATS__)) as CrowdStats;
      collected[mode.name] = stats;

      const out = path.join(OUT_DIR, mode.file);
      await writeFile(out, await page.screenshot({ type: 'png' }));

      assertCommon(mode.name, stats);
      if (mode.name === 'panic') assertPanic(stats);
      if (mode.name === 'calm') assertCalm(stats);

      const pixels = await analyse(out);
      check(pixels.colours > 100, `${mode.name}: real content (${pixels.colours} colours)`);
      check(
        pixels.stdDev > 10,
        `${mode.name}: not a flat fill (stdDev ${pixels.stdDev.toFixed(1)})`
      );
      check(consoleErrors.length === 0, `${mode.name}: no console errors`);
      if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5).join('\n'));

      console.log(`  screenshot -> ${path.relative(ROOT, out)}`);
      await page.close();
    }

    await writeFile(
      path.join(OUT_DIR, 'crowd-report.json'),
      `${JSON.stringify(collected, null, 2)}\n`
    );
  } finally {
    await browser.close();
    await server?.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} harness assertion(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\ncrowd harness PASS');
}

/** Claims that hold whatever the street is doing. */
function assertCommon(name: string, stats: CrowdStats): void {
  /* ---- the headline number ---- */
  check(
    stats.instances >= 250,
    `${name}: ${stats.instances} civilians in the VAT instance buffers (${stats.agents} simulated, ${stats.near} of them also skinned)`
  );
  check(
    stats.crowdDrawCalls <= 6,
    `${name}: ${stats.crowdDrawCalls} draw calls for ${stats.instances} instanced civilians`
  );
  check(
    stats.archetypeMeshes <= 6 && stats.archetypeMeshes >= 4,
    `${name}: ${stats.archetypeMeshes} body archetypes on screen`
  );
  check(
    stats.distinctOffsets > 200,
    `${name}: ${stats.distinctOffsets} distinct gait phases — the crowd is not marching`
  );
  check(
    stats.paletteBytes < 1024 * 1024,
    `${name}: VAT palettes total ${(stats.paletteBytes / 1024).toFixed(0)} KB`
  );
  check(
    stats.crowdTriangles > 40_000,
    `${name}: ${(stats.crowdTriangles / 1000).toFixed(0)}k crowd triangles drawn`
  );

  /* ---- CPU cost. Never fps: SwiftShader would be measuring itself. ---- */
  // The MEDIAN is the assertion, not the mean or the p95. This container is
  // shared with a dozen other workstreams' builds and test runs, and a tail
  // percentile measured under that contention is a measurement of the other
  // workstreams. The median survives interference; the tail is reported so a
  // regression in it is still visible.
  check(
    stats.simMsMedian < 4,
    `${name}: sim ${stats.simMsMedian.toFixed(3)} ms/frame median (mean ${stats.simMsMean.toFixed(3)}, p95 ${stats.simMsP95.toFixed(3)}, worst ${stats.simMsMax.toFixed(1)} — the worst frame builds a skinned body)`
  );

  /* ---- physical constraints ---- */
  // 0.52 m is two body radii. Containment beats separation when the two
  // conflict, so the bound is 96 % of it rather than exactly it.
  check(
    stats.minSeparation > 0.52 * 0.96,
    `${name}: min separation ${stats.minSeparation.toFixed(3)} m over ${stats.frames} frames`
  );
  check(
    stats.buildingPenetrations === 0,
    `${name}: ${stats.buildingPenetrations} agents inside buildings across ${stats.penetrationChecks} checks`
  );

  /* ---- flow field ---- */
  for (const [label, report] of [
    ['flee', stats.fleeConvergence],
    ['commute', stats.commuteConvergence],
  ] as const) {
    check(
      report.cycles === 0 && report.stalled === 0 && report.converged === report.tested,
      `${name}: ${label} field converges — ${report.converged}/${report.tested} cells, ${report.cycles} cycles, longest walk ${report.longestWalk}`
    );
  }
  check(
    stats.directionsIntoWalls === 0,
    `${name}: ${stats.directionsIntoWalls} flow directions point into geometry`
  );

  /* ---- determinism ---- */
  check(
    stats.deterministic,
    `${name}: same seed produces an identical crowd (0x${stats.determinismHash.toString(16)})`
  );

  /* ---- allies ---- */
  check(
    stats.mumenReEngagements === 6,
    `${name}: Mumen Rider got back up ${stats.mumenReEngagements}/6 times`
  );
}

/** Claims specific to the street with a dragon-level monster at the end of it. */
function assertPanic(stats: CrowdStats): void {
  check(
    stats.frontSpeed > 15 && stats.frontSpeed < 60,
    `panic front advances at ${stats.frontSpeed.toFixed(1)} m/s`
  );
  check(
    stats.frontFinal > 90,
    `panic reached ${stats.frontFinal.toFixed(0)} m from the monster`
  );
  // Strictly outward WHILE the only source is the monster standing there.
  // After it swings and takes a building with it, the extra impulses push the
  // front further out and then expire, so the radius legitimately falls back
  // to the monster's own equilibrium — measuring monotonicity across that
  // would be asserting that alarm never decays.
  const beforeCollapse = stats.frontSamples.filter((s) => s.t < 7.5);
  const monotonic = beforeCollapse.every(
    (s, i) => i === 0 || s.radius >= beforeCollapse[i - 1]!.radius - 1e-6
  );
  check(
    monotonic && beforeCollapse.length > 20,
    `panic front never retreats while the monster stands there (${beforeCollapse.length} samples)`
  );

  check(stats.peakFlee > 20, `${stats.peakFlee} civilians running at the peak`);
  check(
    stats.peakGawk > 20,
    `${stats.peakGawk} civilians standing there filming at the peak (gawk is common, as intended)`
  );
  check(stats.peakCower > 0, `${stats.peakCower} civilians cornered or exhausted enough to cower`);

  /* ---- the allies ---- */
  // The monster's shockwave hits them too. Somebody on your side should be on
  // the ground by the end of a dragon-level encounter you were not present for.
  check(
    stats.allyDowned.length > 0,
    `AllyDowned fired for ${stats.allyDowned.join(', ') || 'nobody'}`
  );
  const survivors = stats.allies.filter((a) => !a.dead);
  check(
    survivors.length < stats.allies.length,
    `${stats.allies.length - survivors.length} of ${stats.allies.length} allies lost the fight`
  );

  /* ---- the ledger ---- */
  check(stats.lost > 0, `${stats.lost} civilians killed by the monster's shockwave and debris`);
  check(
    stats.lostEvents === stats.lost,
    `every loss emitted a CivilianLost event (${stats.lostEvents}/${stats.lost})`
  );
  check(
    stats.lostByPlayer === 0,
    `${stats.lostByPlayer} deaths blamed on the player — the monster fired, so none should be`
  );
  check(
    stats.outcomesWithBystanders > 0,
    `${stats.outcomesWithBystanders} outcomes had civilian witnesses`
  );
  check(
    stats.saved > 0 && stats.saved === stats.savedEvents,
    `${stats.saved} civilians escaped once the player killed it, all emitted (${stats.savedEvents})`
  );
  check(
    stats.savedByPlayer > 0,
    `${stats.savedByPlayer} of those saves are credited to the player`
  );
  check(
    stats.witnessedSaves > 0 && stats.witnessedSaves <= stats.saved,
    `${stats.witnessedSaves} of ${stats.saved} saves were in the player's line of sight`
  );
  check(
    stats.outcomesWithLineOfSight >= stats.witnessedSaves,
    `${stats.outcomesWithLineOfSight} outcomes carry the player line-of-sight flag on the ledger`
  );
}

/** The control: the same street with nothing wrong. */
function assertCalm(stats: CrowdStats): void {
  check(stats.moods.flee === 0, `nobody is running (${stats.moods.flee})`);
  check(stats.moods.cower === 0, `nobody is cowering (${stats.moods.cower})`);
  check(stats.moods.down === 0, `nobody is dead (${stats.moods.down})`);
  check(stats.lost === 0, `no civilians lost with no threat present`);
  check(
    stats.moods.commute > stats.agents * 0.9,
    `${stats.moods.commute}/${stats.agents} are simply walking somewhere`
  );
  check(stats.frontFinal === 0, `no alarm field at all (${stats.frontFinal})`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
