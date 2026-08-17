/**
 * COMBAT HARNESS VERIFICATION
 *
 * Builds `harness/combat.html` with Vite, serves it, drives it in headless
 * Chromium and screenshots the shockwave resolution into `docs/screenshots/`.
 *
 * The screenshots are evidence, not the test. The assertions that matter live
 * in `src/gameplay/combat/__tests__/` and run headlessly. What this adds is
 * the two things a unit test in that directory CANNOT do:
 *
 *   1. Cross-check combat's mirrored `sphereInCone` against the real one in
 *      `src/spatial`, and its expectations against the real
 *      `DynamicEntityGrid`. The module is forbidden from importing either, so
 *      the comparison can only happen out here.
 *   2. Prove the whole thing survives a real bundle, runs in a browser, and
 *      produces a picture in which the resolution is legible — a cone, the
 *      things inside it struck through, and the things just outside it alive.
 *
 * NO FRAME RATE IS REPORTED. Chromium here runs on SwiftShader, a CPU software
 * rasteriser; any fps figure from it would describe this machine's CPU, not
 * the phone the game ships on.
 *
 * Run: `npx tsx harness/combat.verify.ts`
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
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-combat-harness');

const SHOT_CONE = path.join(OUT_DIR, 'combat-shockwave-cone.png');
const SHOT_NORMAL = path.join(OUT_DIR, 'combat-normal-punch.png');
const SHOT_SLAM = path.join(OUT_DIR, 'combat-ground-slam.png');
const REPORT = path.join(OUT_DIR, 'combat-report.json');

/** Wide enough for the 980 px map plus the stats column. */
const VIEWPORT = { width: 1360, height: 1010 };

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

/* -------------------------------------------------------------------------- */
/* Types mirrored from the harness                                            */
/* -------------------------------------------------------------------------- */

interface IMirrorReport {
  readonly samples: number;
  readonly disagreements: number;
  readonly accepted: number;
}

interface IBroadPhaseReport {
  readonly queries: number;
  readonly missedByGrid: number;
  readonly extraFromGrid: number;
  readonly totalHits: number;
}

interface IPunchSummary {
  readonly kind: string;
  readonly intent: string;
  readonly power: number;
  readonly rangeMetres: number;
  readonly halfAngleDeg: number;
  readonly kills: number;
  readonly civiliansKilled: number;
  readonly structuresHit: number;
  readonly forecastYen: number;
}

interface IEncounterSummary {
  readonly timeToKill: number;
  readonly civiliansLost: number;
  readonly civiliansSaved: number;
  readonly alliesSaved: number;
  readonly propertyDamageYen: number;
  readonly propertyDamageScore: number;
  readonly collateralCost: number;
  readonly debrisMassKg: number;
  readonly witnessed: number;
  readonly kills: number;
  readonly victory: boolean;
  readonly normalPunches: number;
  readonly seriousPunches: number;
  readonly longestChain: number;
  readonly boredomBefore: number;
  readonly boredomAfter: number;
}

interface ISnapshot {
  readonly mirror: IMirrorReport;
  readonly broadPhase: IBroadPhaseReport;
  readonly targets: number;
  readonly structures: number;
  readonly punch: IPunchSummary | undefined;
  readonly eventTypes: string[];
  readonly punchKinds: string[];
  readonly encounterEndedCollateral: number | undefined;
  readonly boredom: number;
  readonly result: IEncounterSummary | undefined;
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                   */
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
      // lazily and can reload mid-run when the optimiser re-triggers.
      rollupOptions: { input: { combatHarness: path.join(ROOT, 'harness', 'combat.html') } },
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

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const failures: string[] = [];
  await mkdir(OUT_DIR, { recursive: true });

  console.log('building harness bundle...');
  await buildHarness();

  const { server, port } = await serve(BUILD_DIR);
  const url = `http://127.0.0.1:${port}/harness/combat.html`;
  console.log(`serving ${BUILD_DIR} at ${url}`);

  let browser: Browser | undefined;
  const pixels: Record<string, { stdDev: number; colours: number }> = {};
  let cone: ISnapshot | undefined;
  let normal: ISnapshot | undefined;
  let slam: ISnapshot | undefined;
  let encounter: ISnapshot | undefined;

  try {
    browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
    const page: Page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

    const consoleErrors: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => window.__COMBAT_READY__ === true, undefined, {
      timeout: 120_000,
    });

    /* ---- 1. the serious punch, fully charged ------------------------- */
    await page.evaluate(() => {
      window.__COMBAT_HARNESS__!.reset();
      window.__COMBAT_HARNESS__!.fireSerious(1);
    });
    cone = (await page.evaluate(() =>
      window.__COMBAT_HARNESS__!.snapshot()
    )) as unknown as ISnapshot;
    await page.screenshot({ path: SHOT_CONE, type: 'png' });
    pixels.cone = await analyse(SHOT_CONE);

    /* ---- 2. the tap, for contrast ------------------------------------ */
    await page.evaluate(() => {
      window.__COMBAT_HARNESS__!.reset();
      window.__COMBAT_HARNESS__!.fireNormal();
    });
    normal = (await page.evaluate(() =>
      window.__COMBAT_HARNESS__!.snapshot()
    )) as unknown as ISnapshot;
    await page.screenshot({ path: SHOT_NORMAL, type: 'png' });
    pixels.normal = await analyse(SHOT_NORMAL);

    /* ---- 3. the ground slam ------------------------------------------ */
    await page.evaluate(() => {
      window.__COMBAT_HARNESS__!.reset();
      window.__COMBAT_HARNESS__!.fireSlam(40);
    });
    slam = (await page.evaluate(() =>
      window.__COMBAT_HARNESS__!.snapshot()
    )) as unknown as ISnapshot;
    await page.screenshot({ path: SHOT_SLAM, type: 'png' });
    pixels.slam = await analyse(SHOT_SLAM);

    /* ---- 4. a whole fight, through the synthetic input API ------------ */
    encounter = (await page.evaluate(() => {
      window.__COMBAT_HARNESS__!.runScriptedEncounter();
      return window.__COMBAT_HARNESS__!.snapshot();
    })) as unknown as ISnapshot;

    /* ----------------------------- assertions ------------------------- */

    // -- the mirror. A single disagreement means the broad phase and the kill
    //    test can pick different sets, i.e. a monster survives a punch.
    if (cone.mirror.disagreements !== 0) {
      failures.push(
        `combat's sphereInCone disagrees with src/spatial's on ` +
          `${cone.mirror.disagreements} of ${cone.mirror.samples} samples`
      );
    }
    if (cone.mirror.accepted < 1000) {
      failures.push(`mirror check accepted only ${cone.mirror.accepted} — sampling is degenerate`);
    }

    // -- the real grid must never under-report against the brute-force scan.
    if (cone.broadPhase.missedByGrid !== 0) {
      failures.push(
        `DynamicEntityGrid missed ${cone.broadPhase.missedByGrid} targets the linear scan found`
      );
    }
    if (cone.broadPhase.totalHits < 5000) {
      failures.push(`broad-phase comparison only covered ${cone.broadPhase.totalHits} hits`);
    }

    // -- the fully charged cone.
    if (cone.punch === undefined) failures.push('the serious punch produced no outcome');
    else {
      if (Math.round(cone.punch.rangeMetres) !== 180) {
        failures.push(`full charge produced a ${cone.punch.rangeMetres} m cone, expected 180 m`);
      }
      if (Math.abs(cone.punch.halfAngleDeg - 22) > 0.01) {
        failures.push(`cone half-angle is ${cone.punch.halfAngleDeg} deg, expected 22`);
      }
      if (cone.punch.intent !== 'full') {
        failures.push(`full charge produced intent "${cone.punch.intent}", expected "full"`);
      }
      if (cone.punch.power < 1e6) {
        failures.push(`full charge power is ${cone.punch.power}, expected to exceed 1e6`);
      }
      if (cone.punch.kills < 10) {
        failures.push(`the 180 m cone killed only ${cone.punch.kills}`);
      }
      if (cone.punch.civiliansKilled < 1) {
        failures.push('the 180 m cone killed no civilians — the collateral model is not wired');
      }
      if (cone.punch.structuresHit < 3) {
        failures.push(`the cone swept only ${cone.punch.structuresHit} structures`);
      }
    }

    // -- the tap: same lethality, none of the consequences. THE contrast.
    if (normal.punch === undefined) failures.push('the normal punch produced no outcome');
    else {
      if (Math.abs(normal.punch.rangeMetres - 1.2) > 1e-6) {
        failures.push(`the tap reached ${normal.punch.rangeMetres} m, expected 1.2 m`);
      }
      if (normal.punch.structuresHit !== 0) {
        failures.push(`the tap took ${normal.punch.structuresHit} buildings — it must take none`);
      }
      if (normal.punch.civiliansKilled !== 0) {
        failures.push('the tap killed a civilian');
      }
      if (cone.punch !== undefined && normal.punch.kills >= cone.punch.kills) {
        failures.push('the tap killed as much as the serious punch — the verbs are not distinct');
      }
    }

    // -- the slam is radial and kills less than it shoves.
    if (slam.punch === undefined) failures.push('the ground slam produced no outcome');
    else if (Math.abs(slam.punch.halfAngleDeg - 180) > 0.01) {
      failures.push(`the slam half-angle is ${slam.punch.halfAngleDeg} deg, expected 180 (radial)`);
    }

    // -- the scripted fight.
    const result = encounter.result;
    if (result === undefined) failures.push('the scripted encounter produced no EncounterResult');
    else {
      if (!result.victory) failures.push('the scripted encounter was not a victory');
      if (result.kills < 5) failures.push(`only ${result.kills} hostiles died`);
      if (result.propertyDamageYen <= 0) {
        failures.push('the invoice came to zero yen after levelling the street');
      }
      if (result.debrisMassKg <= 0) failures.push('no debris mass was accounted');
      if (result.seriousPunches !== 1) {
        failures.push(`the script threw ${result.seriousPunches} serious punches, expected 1`);
      }
      // ONE tap. The script taps once and then holds; if beginning the charge
      // still threw a free jab this would be 2, and the most important
      // decision in the game would be getting made by a button the player was
      // still pressing.
      if (result.normalPunches !== 1) {
        failures.push(
          `the script threw ${result.normalPunches} normal punches, expected 1 — ` +
            `the charge wind-up is throwing a free jab again`
        );
      }
      if (result.longestChain !== 1) {
        failures.push(`the chain reached ${result.longestChain} from a single tap`);
      }
      if (result.timeToKill <= 0) failures.push('timeToKill was not measured');
      if (result.boredomAfter <= result.boredomBefore) {
        failures.push('a fight of nothing but instant kills did not raise boredom');
      }

      // The bounded companion to the yen invoice: what a linear consumer reads.
      if (!(result.propertyDamageScore > 0 && result.propertyDamageScore < 1)) {
        failures.push(`propertyDamageScore is ${result.propertyDamageScore}, expected in (0, 1)`);
      }
      if (result.propertyDamageYen < 1e9) {
        failures.push('levelling the street billed under a billion yen');
      }
    }

    // -- the emit boundary carries the ACCOUNTING figure, not the invoice.
    const ended = encounter.eventTypes.filter((t) => t === 'EncounterEnded').length;
    if (ended !== 1) failures.push(`${ended} EncounterEnded events, expected 1`);
    if (result !== undefined && encounter.encounterEndedCollateral !== undefined) {
      if (Math.abs(encounter.encounterEndedCollateral - result.collateralCost) > 1) {
        failures.push(
          `EncounterEnded.collateralCost is ${encounter.encounterEndedCollateral}, ` +
            `expected the ChunkDetached sum ${result.collateralCost}`
        );
      }
      if (encounter.encounterEndedCollateral >= result.propertyDamageYen) {
        failures.push(
          'EncounterEnded.collateralCost is carrying the yen invoice — that is a ' +
            'unit mismatch against the per-chunk figure progression accumulates'
        );
      }
    }

    // -- the outbound event surface.
    const kinds = new Set(encounter.eventTypes);
    for (const required of [
      'ShockwaveFired',
      'EntityKilled',
      'ImpulseApplied',
      'CivilianLost',
      'ChunkDetached',
      'BoredomChanged',
      'EncounterEnded',
    ]) {
      if (!kinds.has(required)) failures.push(`no ${required} was emitted during the fight`);
    }

    // -- the pictures.
    for (const [name, shot] of Object.entries(pixels)) {
      if (shot.stdDev <= 10) failures.push(`${name} screenshot is flat (stdDev ${shot.stdDev})`);
      if (shot.colours <= 100) failures.push(`${name} screenshot has ${shot.colours} colours`);
    }

    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 4).join(' | ')}`);
    }

    await writeFile(
      REPORT,
      `${JSON.stringify({ cone, normal, slam, encounter, pixels }, null, 2)}\n`,
      'utf8'
    );

    console.log('\n──────── mirror parity ────────');
    console.log(JSON.stringify(cone.mirror, null, 2));
    console.log('\n──────── broad-phase parity ────────');
    console.log(JSON.stringify(cone.broadPhase, null, 2));
    console.log('\n──────── serious punch ────────');
    console.log(JSON.stringify(cone.punch, null, 2));
    console.log('\n──────── normal punch ────────');
    console.log(JSON.stringify(normal.punch, null, 2));
    console.log('\n──────── ground slam ────────');
    console.log(JSON.stringify(slam.punch, null, 2));
    console.log('\n──────── encounter result ────────');
    console.log(JSON.stringify(encounter.result, null, 2));
    console.log('\n──────── punches thrown ────────');
    console.log(encounter.punchKinds.join(' -> '));
    console.log('\n──────── event sequence (first 40) ────────');
    console.log(encounter.eventTypes.slice(0, 40).join(' -> '));
    console.log('\n──────── pixels ────────');
    console.log(JSON.stringify(pixels, null, 2));
    console.log(`saved: ${SHOT_CONE}`);
    console.log(`saved: ${SHOT_NORMAL}`);
    console.log(`saved: ${SHOT_SLAM}`);
    console.log(`saved: ${REPORT}`);
  } finally {
    await browser?.close();
    server.close();
    await rm(BUILD_DIR, { recursive: true, force: true });
  }

  console.log('\n──────── result ────────');
  if (failures.length > 0) {
    console.error('COMBAT HARNESS FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('COMBAT HARNESS PASSED');
}

main().catch((error) => {
  console.error('combat harness crashed:', error);
  process.exit(1);
});
