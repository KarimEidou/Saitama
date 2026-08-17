/**
 * PHYSICS HARNESS DRIVER
 *
 * Serves `harness/physics.html` through Vite, drives it with headless Chromium,
 * reads the measurements the page publishes, screenshots the result and asserts
 * on all of it.
 *
 *   npx tsx harness/physics.verify.ts
 *
 * Exit 0 = pass, 1 = fail.
 *
 * ── WHY THE SCREENSHOT IS CHECKED, NOT JUST TAKEN ──────────────────────────
 * A WebGL page that throws still "loads" and still screenshots — as a flat
 * fill. So the image is read back and its pixel statistics asserted: standard
 * deviation above 10 and a healthy count of distinct colours. That is the
 * difference between proving 300 bodies came to rest in a pile and proving a
 * web server answered.
 *
 * ── WHY NO FPS ─────────────────────────────────────────────────────────────
 * Chromium here rasterises through SwiftShader on the CPU. Any frame rate it
 * produces measures a software rasteriser, not the game, so none is reported.
 * The simulation step is wasm on a real CPU and IS measured.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots');
const SHOT = path.join(SHOT_DIR, 'physics-debris-pile.png');

const VIEWPORT = { width: 1280, height: 800 };
/**
 * Physics scenarios run to completion before the first paint, and this repo is
 * built by many agents running their own SwiftShader harnesses at the same
 * time. The work itself is ~15 s; the headroom is for machine contention.
 */
const READY_TIMEOUT_MS = 900_000;

/* -------------------------------------------------------------------------- */
/* Result shape — mirrors harness/physics.ts                                  */
/* -------------------------------------------------------------------------- */

interface TimingSummary {
  samples: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface HarnessReport {
  seed: string;
  rapierInitMs: number;
  debris: {
    spawned: number;
    simulated: number;
    ballistic: number;
    stepsAwake: number;
    stepsTotal: number;
    warmupMs: number[];
    awake: TimingSummary;
    whole: TimingSummary;
    poolUpdate: TimingSummary;
    awakeAtEnd: number;
    settledAtEnd: number;
    lowestY: number;
    highestY: number;
    ballisticLowestY: number;
    ballisticHighestY: number;
    budgetMs: number;
  };
  ragdoll: {
    spawned: number;
    bodiesEach: number;
    cap: number;
    activeAfterCap: number;
    frozenAfterCap: number;
    blendAtOneFrame: number;
    blendAfterWindow: number;
    maxJointSeparationM: number;
    maxSpeedAfterSettleMs: number;
    maxSpeedDuringSettleMs: number;
    anyNonFinite: boolean;
    lowestY: number;
    stepMs: TimingSummary;
  };
  determinism: {
    bodies: number;
    values: number;
    maxDelta: number;
    identical: boolean;
    differentSeedDelta: number;
  };
  character: {
    runDistanceM: number;
    dashDistanceM: number;
    jumpApexM: number;
    targetApexM: number;
    landingImpactSpeed: number;
    landingFallHeight: number;
    createsCrater: boolean;
    playerLandedEvents: number;
    groundSlamAffected: number;
  };
  render: {
    drawCalls: number;
    triangles: number;
    frames: number;
    width: number;
    height: number;
  };
  errors: string[];
}

interface PixelReport {
  width: number;
  height: number;
  stdDev: number;
  mean: number;
  distinctColors: number;
  nonBackgroundFraction: number;
}

/* -------------------------------------------------------------------------- */
/* Screenshot analysis                                                        */
/* -------------------------------------------------------------------------- */

async function analyseScreenshot(file: string): Promise<PixelReport> {
  const image = sharp(file);
  const meta = await image.metadata();
  const stats = await image.stats();

  const colorChannels = stats.channels.slice(0, 3);
  const stdDev = colorChannels.reduce((sum, c) => sum + c.stdev, 0) / colorChannels.length;
  const mean = colorChannels.reduce((sum, c) => sum + c.mean, 0) / colorChannels.length;

  // Distinct colours on a coarse grid: catches a uniform fill that still has a
  // little compression noise.
  const raw = await sharp(file).resize(96, 96, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const seen = new Set<number>();
  let nonBackground = 0;
  let sampled = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const r = raw[i]!;
    const g = raw[i + 1]!;
    const b = raw[i + 2]!;
    seen.add((r << 16) | (g << 8) | b);
    sampled++;
    // The scene background is 0x141922 before tone mapping; anything much
    // brighter is geometry.
    if (r + g + b > 120) nonBackground++;
  }

  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    stdDev,
    mean,
    distinctColors: seen.size,
    nonBackgroundFraction: sampled === 0 ? 0 : nonBackground / sampled,
  };
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

async function startServer(): Promise<{ server: ViteDevServer; url: string }> {
  const server = await createServer({
    // The repo's vite.config.ts targets the game bundle; the harness only needs
    // the `@` alias, so an inline config keeps the two independent.
    configFile: false,
    root: ROOT,
    resolve: { alias: { '@': path.join(ROOT, 'src') } },
    optimizeDeps: { include: ['three', '@dimforge/rapier3d-compat'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'warn',
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('vite dev server did not report a URL');
  return { server, url };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function fmt(value: number, digits = 3): string {
  return value.toFixed(digits);
}

async function main(): Promise<void> {
  const failures: string[] = [];
  await mkdir(SHOT_DIR, { recursive: true });

  const { server, url } = await startServer();
  const pageUrl = new URL('harness/physics.html', url).href;
  console.log(`serving ${ROOT} at ${url}`);
  console.log(`opening ${pageUrl}`);

  let browser: Browser | undefined;
  let report: HarnessReport | undefined;
  let pixels: PixelReport | undefined;

  try {
    browser = await chromium.launch({
      args: [
        // No GPU in this environment; SwiftShader rasterises on the CPU.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const page: Page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(pageUrl, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => window.__PHYSICS_READY__ === true, undefined, {
      timeout: READY_TIMEOUT_MS,
    });

    report = (await page.evaluate(() => window.__PHYSICS_HARNESS__)) as HarnessReport | undefined;
    await page.screenshot({ path: SHOT, type: 'png' });
    pixels = await analyseScreenshot(SHOT);

    /* ----------------------------- assertions ---------------------------- */
    if (report === undefined) {
      failures.push('window.__PHYSICS_HARNESS__ was never populated');
    } else if (report.debris === undefined) {
      failures.push(
        `harness aborted before publishing results: ${report.errors.join(' | ') || 'no detail'}`
      );
    } else {
      if (report.errors.length > 0) {
        failures.push(`harness reported errors: ${report.errors.join(' | ')}`);
      }

      // Debris.
      const d = report.debris;
      if (d.spawned !== 300) failures.push(`expected 300 debris pieces, got ${d.spawned}`);
      if (d.simulated + d.ballistic !== d.spawned) {
        failures.push(`piece accounting mismatch: ${d.simulated} + ${d.ballistic} != ${d.spawned}`);
      }
      if (d.ballistic < 1) failures.push('no piece took the ballistic path — threshold never hit');
      if (d.settledAtEnd < d.simulated * 0.9) {
        failures.push(`only ${d.settledAtEnd}/${d.simulated} pieces settled`);
      }
      if (d.lowestY < -0.6) failures.push(`a piece tunnelled through the floor (y=${d.lowestY})`);
      if (d.highestY > 12) failures.push(`a piece never came down (y=${d.highestY})`);
      if (d.ballisticLowestY < 0) {
        failures.push(`a ballistic piece rests below the ground (y=${d.ballisticLowestY})`);
      }
      if (d.ballisticHighestY > 0.4) {
        failures.push(`a ballistic piece never landed (y=${d.ballisticHighestY})`);
      }
      if (d.awake.avgMs > d.budgetMs) {
        failures.push(
          `simulation step over budget: ${fmt(d.awake.avgMs)} ms avg vs ${d.budgetMs} ms`
        );
      }

      // Ragdolls.
      const r = report.ragdoll;
      if (r.bodiesEach !== 13) failures.push(`expected 13 bodies per ragdoll, got ${r.bodiesEach}`);
      if (r.activeAfterCap > r.cap) {
        failures.push(`ragdoll cap breached: ${r.activeAfterCap} active vs cap ${r.cap}`);
      }
      if (r.frozenAfterCap < 1) failures.push('spawning past the cap froze nothing');
      if (r.anyNonFinite) failures.push('a ragdoll body reached a non-finite transform');
      if (r.maxJointSeparationM > 0.1) {
        failures.push(`ragdoll joints separated by ${r.maxJointSeparationM} m`);
      }
      if (r.maxSpeedAfterSettleMs > 0.75) {
        failures.push(`ragdolls still jittering: ${r.maxSpeedAfterSettleMs} m/s after settle`);
      }
      if (r.lowestY < -0.5) failures.push(`a ragdoll limb fell through the floor (${r.lowestY})`);
      if (!(r.blendAtOneFrame < 0.25 && r.blendAfterWindow === 1)) {
        failures.push(
          `blend curve wrong: ${r.blendAtOneFrame} after one frame, ${r.blendAfterWindow} after the window`
        );
      }

      // Determinism — the hard requirement.
      const det = report.determinism;
      if (!det.identical || det.maxDelta !== 0) {
        failures.push(
          `NON-DETERMINISTIC: same seed produced max |delta| = ${det.maxDelta} across ` +
            `${det.values} values`
        );
      }
      if (det.differentSeedDelta <= 0.1) {
        failures.push(
          `a different seed produced the same result (${det.differentSeedDelta}) — ` +
            `the seed is not actually being used`
        );
      }

      // Character.
      const c = report.character;
      if (Math.abs(c.runDistanceM - 9) > 0.6) {
        failures.push(`run speed ${c.runDistanceM} m/s, expected ~9`);
      }
      if (Math.abs(c.dashDistanceM - 22) > 1.2) {
        failures.push(`dash speed ${c.dashDistanceM} m/s, expected ~22`);
      }
      if (Math.abs(c.jumpApexM - c.targetApexM) > 1.5) {
        failures.push(`jump apex ${c.jumpApexM} m, expected ~${c.targetApexM}`);
      }
      if (!c.createsCrater) failures.push('a 40 m drop did not register as a ground slam');
      if (c.playerLandedEvents !== 1) {
        failures.push(`expected exactly one PlayerLanded event, got ${c.playerLandedEvents}`);
      }
      if (c.groundSlamAffected < 1) failures.push('the ground slam moved no debris');

      // Render.
      if (report.render.drawCalls < 10) {
        failures.push(`suspiciously few draw calls (${report.render.drawCalls})`);
      }
      if (report.render.triangles < 1000) {
        failures.push(`suspiciously few triangles (${report.render.triangles})`);
      }
    }

    // Screenshot.
    if (pixels.stdDev <= 10) {
      failures.push(`screenshot looks blank: stdDev ${fmt(pixels.stdDev, 2)} (needs > 10)`);
    }
    if (pixels.distinctColors < 64) {
      failures.push(`screenshot has only ${pixels.distinctColors} distinct colours`);
    }
    if (pixels.nonBackgroundFraction < 0.05) {
      failures.push(
        `screenshot is ${fmt((1 - pixels.nonBackgroundFraction) * 100, 1)}% background — ` +
          `nothing was drawn`
      );
    }
    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
    }
  } finally {
    await browser?.close();
    await server.close();
  }

  /* -------------------------------- report -------------------------------- */
  if (report !== undefined && report.debris !== undefined) {
    const d = report.debris;
    const r = report.ragdoll;
    const c = report.character;
    console.log('\n════════ PHYSICS HARNESS ════════');
    console.log(`seed                 ${report.seed}`);
    console.log(`rapier init          ${fmt(report.rapierInitMs, 1)} ms`);
    console.log('\n── debris ──');
    console.log(`pieces               ${d.spawned} (${d.simulated} solved, ${d.ballistic} ballistic)`);
    console.log(
      `step, all awake      avg ${fmt(d.awake.avgMs)} ms  p50 ${fmt(d.awake.p50Ms)}  ` +
        `p95 ${fmt(d.awake.p95Ms)}  max ${fmt(d.awake.maxMs)}   (${d.stepsAwake} steps)`
    );
    console.log(
      `step, full settle    avg ${fmt(d.whole.avgMs)} ms  p95 ${fmt(d.whole.p95Ms)}   ` +
        `(${d.stepsTotal} steps)`
    );
    console.log(`pool update          avg ${fmt(d.poolUpdate.avgMs)} ms`);
    console.log(`warm-up steps        ${d.warmupMs.join(', ')} ms (excluded above)`);
    console.log(`budget               ${d.budgetMs} ms`);
    console.log(`settled / awake      ${d.settledAtEnd} settled, ${d.awakeAtEnd} bodies awake`);
    console.log(`pile height          ${d.lowestY} … ${d.highestY} m`);
    console.log(
      `ballistic rest y     ${d.ballisticLowestY} … ${d.ballisticHighestY} m`
    );
    console.log('\n── ragdolls ──');
    console.log(`spawned              ${r.spawned} (cap ${r.cap}), ${r.bodiesEach} bodies each`);
    console.log(`after cap            ${r.activeAfterCap} active, ${r.frozenAfterCap} frozen`);
    console.log(`blend                ${r.blendAtOneFrame} after 1 frame -> ${r.blendAfterWindow}`);
    console.log(`joint separation     max ${r.maxJointSeparationM} m`);
    console.log(
      `limb speed           ${r.maxSpeedDuringSettleMs} m/s peak, ` +
        `${r.maxSpeedAfterSettleMs} m/s after settle`
    );
    console.log(`non-finite           ${r.anyNonFinite ? 'YES' : 'none'}`);
    console.log(`step (117 bodies)    avg ${fmt(r.stepMs.avgMs)} ms`);
    console.log('\n── determinism ──');
    console.log(`bodies compared      ${report.determinism.bodies} (${report.determinism.values} values)`);
    console.log(`max |delta|          ${report.determinism.maxDelta}`);
    console.log(`different seed       ${report.determinism.differentSeedDelta}`);
    console.log('\n── character ──');
    console.log(`run / dash           ${c.runDistanceM} / ${c.dashDistanceM} m per second`);
    console.log(`jump apex            ${c.jumpApexM} m (target ${c.targetApexM})`);
    console.log(
      `landing              ${c.landingFallHeight} m at ${c.landingImpactSpeed} m/s, ` +
        `crater=${c.createsCrater}, moved ${c.groundSlamAffected} bodies`
    );
    console.log('\n── render (SwiftShader; no fps reported) ──');
    console.log(
      `draw calls           ${report.render.drawCalls}, triangles ${report.render.triangles}`
    );
  }
  if (pixels !== undefined) {
    console.log('\n── screenshot ──');
    console.log(`file                 ${SHOT}`);
    console.log(`size                 ${pixels.width}x${pixels.height}`);
    console.log(`stdDev               ${fmt(pixels.stdDev, 2)}   (must exceed 10)`);
    console.log(`mean                 ${fmt(pixels.mean, 2)}`);
    console.log(`distinct colours     ${pixels.distinctColors}`);
    console.log(`non-background       ${fmt(pixels.nonBackgroundFraction * 100, 1)}%`);
  }

  console.log('\n════════ result ════════');
  if (failures.length > 0) {
    console.error('PHYSICS HARNESS FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('PHYSICS HARNESS PASSED');
}

main().catch((error: unknown) => {
  console.error('physics harness crashed:', error);
  process.exit(1);
});
