/**
 * PROGRESSION + DAY/NIGHT VERIFICATION
 *
 * Bundles `harness/progression.html` with Vite, serves it, drives it in
 * headless Chromium with SwiftShader, and asserts on things that can be
 * counted or measured in pixels.
 *
 * ── THE ASSERTION THAT MATTERS ─────────────────────────────────────────────
 * The SAME view is screenshotted at six times of day and read back with
 * `sharp`. The four source HDRIs are NOT exposure matched — their peak
 * luminances span five orders of magnitude while their means sit within 1.5x
 * of each other — so a cycle that swaps or blends them without normalising
 * produces a midnight indistinguishable from noon. That failure is invisible
 * to every unit test and obvious in a mean-luminance comparison, which is why
 * this file exists.
 *
 * Two numbers are reported per shot: the mean luminance the SYSTEM intends
 * (`skyLuminance * exposure`, straight off the harness) and the mean luminance
 * the PIXELS actually came back with. If those disagree, the intent is not
 * reaching the screen.
 *
 * ── WHY NO FRAME RATE ──────────────────────────────────────────────────────
 * SwiftShader is a CPU software rasteriser. Any fps figure here measures the
 * CI machine, not the renderer, so none is produced.
 *
 * Run: `npx tsx harness/progression.verify.ts`
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
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-progression-harness');

/** Landscape and modest: SwiftShader fills every pixel on the CPU. */
const VIEWPORT = { width: 960, height: 540 };

/** Only the 3D stage, excluding the readout panel, is measured. */
const STAGE_CLIP = { x: 0, y: 0, width: 600, height: 540 };

const SWIFTSHADER_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
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
  '.wasm': 'application/wasm',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
};

/* -------------------------------------------------------------------------- */
/* Mirrored harness types                                                     */
/* -------------------------------------------------------------------------- */

interface ISkySnapshot {
  timeOfDay: number;
  phase: string;
  blendFrom: string;
  blendTo: string;
  blendAlpha: number;
  skyLuminance: number;
  exposure: number;
  netLuminance: number;
  sunElevationDegrees: number;
  sunAzimuthDegrees: number;
  sunIntensity: number;
  moonIntensity: number;
  moonIsKeyLight: boolean;
  nightFactor: number;
  windowLitFraction: number;
  streetLightsOn: boolean;
  shadowRadius: number;
  fogDensity: number;
  fogColor: string;
  ambientColor: string;
  groundColor: string;
  sunColor: string;
  hasMeasuredEnvironment: boolean;
}

interface IHarnessSnapshot {
  ready: boolean;
  assetsLoaded: boolean;
  iblMode: string;
  skiesLoaded: string[];
  skiesMissing: string[];
  normalisation: {
    sky: string;
    meanLuminance: number;
    maxLuminance: number;
    scale: number;
    measured: boolean;
    hasBakedSH: boolean;
  }[];
  radianceRebuilds: number;
  radianceResolution: number;
  environmentGpuBytes: number;
  litMaterials: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  sky: ISkySnapshot;
  progression: Record<string, unknown>;
  problems: string[];
}

interface IScenarioResult {
  name: string;
  detail: Record<string, number | string | boolean>;
}

interface IPixelStats {
  /** Mean of the perceptual luma channel, 0..255. */
  meanLuma: number;
  /** Standard deviation across channels; the blank-frame gate. */
  stdDev: number;
  /** Distinct quantised colours; the other blank-frame gate. */
  colours: number;
  meanR: number;
  meanG: number;
  meanB: number;
  /** Blue minus red, normalised. Positive is a cool image. */
  coolness: number;
  /** Fraction of pixels above 200/255 luma — the lit-window signature. */
  brightFraction: number;
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
      rollupOptions: {
        input: { progressionHarness: path.join(ROOT, 'harness', 'progression.html') },
      },
    },
    // `public/assets/` is ~200 MB of processed KTX2 and GLB. Copying it into
    // the build output would dominate the run; it is mounted off disk below.
    publicDir: false,
  };
  await build(config);
}

/**
 * Extra directories served alongside the bundle.
 *
 * `/assets` is BOTH Vite's own chunk directory (`build.assetsDir`) and the
 * processed asset root under `public/`. That collision is not hypothetical: it
 * silently 404s every JS chunk, the page loads as a blank white rectangle, and
 * the only symptom is the harness never signalling ready. The build output is
 * therefore checked FIRST and the mount is a fallback, so `/assets/three-*.js`
 * comes from the bundle and `/assets/env/*.ktx2` comes from `public/`.
 *
 * `public/assets/` is ~200 MB and is mounted off disk rather than copied.
 */
const MOUNTS: readonly (readonly [string, string])[] = [
  ['/assets', path.join(ROOT, 'public', 'assets')],
  ['/basis', path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis')],
];

function resolveMount(pathname: string, fallbackDir: string): string {
  const fromBuild = path.join(fallbackDir, pathname);
  if (existsSync(fromBuild)) return fromBuild;
  for (const [prefix, dir] of MOUNTS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return path.join(dir, pathname.slice(prefix.length));
    }
  }
  return fromBuild;
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

/* -------------------------------------------------------------------------- */
/* Pixel analysis                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read a PNG back and measure it.
 *
 * A page whose WebGL threw still screenshots — as a flat rectangle. `stdDev`
 * and `colours` are the gates that a broken renderer cannot satisfy;
 * `meanLuma` and `coolness` are what actually distinguish midnight from noon.
 */
async function analyse(file: string): Promise<IPixelStats> {
  const image = sharp(file).removeAlpha();
  const stats = await image.stats();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let bright = 0;
  const pixels = info.width * info.height;
  const seen = new Set<number>();

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    sumR += r;
    sumG += g;
    sumB += b;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma > 200) bright++;
    // Quantise to 5 bits per channel so JPEG-ish noise does not inflate the
    // count into meaninglessness.
    seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }

  const meanR = sumR / pixels;
  const meanG = sumG / pixels;
  const meanB = sumB / pixels;
  const stdDev =
    stats.channels.reduce((sum, channel) => sum + channel.stdev, 0) / stats.channels.length;

  return {
    meanLuma: 0.2126 * meanR + 0.7152 * meanG + 0.0722 * meanB,
    stdDev,
    colours: seen.size,
    meanR,
    meanG,
    meanB,
    coolness: (meanB - meanR) / Math.max(1, meanR + meanB),
    brightFraction: bright / pixels,
  };
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                     */
/* -------------------------------------------------------------------------- */

function fail(failures: string[], message: string): void {
  failures.push(message);
  console.error(`  FAIL  ${message}`);
}

function pass(message: string): void {
  console.log(`  ok    ${message}`);
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const report: Record<string, unknown> = {};

  console.log('building progression harness bundle...');
  await buildHarness();
  await mkdir(OUT_DIR, { recursive: true });

  const { server, port } = await serve(BUILD_DIR);
  const url = `http://127.0.0.1:${port}/harness/progression.html`;
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
    const page: Page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

    const consoleErrors: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(url, { waitUntil: 'load' });
    // Generous: this is SwiftShader decoding four HDRIs, convolving a PMREM
    // and compiling the cascade shaders on a CPU rasteriser.
    await page.waitForFunction(() => window.__PROGRESSION_HARNESS__?.ready === true, undefined, {
      timeout: 300_000,
    });

    /* ---------------------------------------------------------------- setup */
    const initial = (await page.evaluate(() =>
      window.__PROGRESSION_HARNESS__!.snapshot()
    )) as IHarnessSnapshot;
    const meta = await page.evaluate(() => window.__PROGRESSION_HARNESS__!.meta());
    report.meta = meta;
    report.setup = initial;

    console.log('\n── environment ──────────────────────────────────────────────');
    console.log(`  IBL mode        ${initial.iblMode}`);
    console.log(`  skies loaded    ${initial.skiesLoaded.join(', ') || 'NONE'}`);
    console.log(`  radiance        ${initial.radianceResolution}px`);
    console.log(`  env VRAM        ${(initial.environmentGpuBytes / 1048576).toFixed(2)} MB`);
    console.log(`  lit materials   ${initial.litMaterials}`);
    console.log('  normalisation (measured mean -> scale applied):');
    for (const row of initial.normalisation) {
      console.log(
        `    ${row.sky.padEnd(6)} mean=${row.meanLuminance.toFixed(4)} ` +
          `peak=${String(Math.round(row.maxLuminance)).padStart(7)} ` +
          `scale=x${row.scale.toFixed(4)} ` +
          `${row.measured ? 'measured' : 'UNMEASURED'} ${row.hasBakedSH ? 'sh9' : 'no-sh'}`
      );
    }

    if (initial.skiesLoaded.length < 4) {
      fail(failures, `only ${initial.skiesLoaded.length}/4 skies loaded from the manifest`);
    } else {
      pass('all four baked skies loaded through IAssetRegistry');
    }
    if (!initial.sky.hasMeasuredEnvironment) {
      fail(failures, 'no measured SH data — colours are running on the neutral fallback');
    } else {
      pass('measured SH data is driving the derived colours');
    }
    for (const row of initial.normalisation) {
      if (!row.measured) fail(failures, `sky "${row.sky}" has no measured mean luminance`);
    }

    // The finding, restated as an assertion against the live manifest.
    const means = initial.normalisation.map((r) => r.meanLuminance);
    const peaks = initial.normalisation.map((r) => r.maxLuminance);
    const meanSpread = Math.max(...means) / Math.min(...means);
    const peakSpread = Math.max(...peaks) / Math.min(...peaks);
    report.exposureMismatch = { meanSpread, peakSpread, means, peaks };
    console.log(
      `\n  peak spread ${peakSpread.toExponential(2)}x vs mean spread ${meanSpread.toFixed(2)}x ` +
        `— this is why normalisation is mandatory`
    );
    if (meanSpread > 3) {
      console.log('  NOTE: the source maps appear exposure matched after all; re-check the tuning');
    }

    /* ------------------------------------------------------- six screenshots */
    console.log('\n── six times of day, one camera ─────────────────────────────');
    const shots: {
      id: string;
      label: string;
      file: string;
      sky: ISkySnapshot;
      pixels: IPixelStats;
    }[] = [];

    const shotTimes = (await page.evaluate(() => window.__PROGRESSION_HARNESS__!.shotTimes())) as {
      id: string;
      t: number;
      label: string;
    }[];

    for (const shot of shotTimes) {
      await page.evaluate((t) => window.__PROGRESSION_HARNESS__!.setTimeOfDay(t), shot.t);
      // A few extra frames so the blended sky, the cascades and the shared
      // night uniform have all been through a full update before the capture.
      await page.evaluate(() => window.__PROGRESSION_HARNESS__!.settle(4));

      const file = path.join(OUT_DIR, `progression-sky-${shot.id}.png`);
      await page.screenshot({ path: file, clip: STAGE_CLIP });

      const snapshot = (await page.evaluate(() =>
        window.__PROGRESSION_HARNESS__!.snapshot()
      )) as IHarnessSnapshot;
      const pixels = await analyse(file);
      shots.push({ id: shot.id, label: shot.label, file, sky: snapshot.sky, pixels });

      console.log(
        `  ${shot.id.padEnd(9)} ${shot.label.padEnd(18)} ` +
          `intent(lum x exp)=${snapshot.sky.netLuminance.toFixed(4).padStart(7)}  ` +
          `pixels meanLuma=${pixels.meanLuma.toFixed(1).padStart(5)}  ` +
          `stdDev=${pixels.stdDev.toFixed(1).padStart(5)}  ` +
          `colours=${String(pixels.colours).padStart(5)}  ` +
          `cool=${pixels.coolness.toFixed(3).padStart(6)}  ` +
          `bright=${(pixels.brightFraction * 100).toFixed(2)}%`
      );
    }
    report.shots = shots.map((s) => ({
      id: s.id,
      label: s.label,
      file: path.relative(ROOT, s.file),
      sky: s.sky,
      pixels: s.pixels,
    }));

    /* --------------------------------------------------------- assertions */
    console.log('\n── sky assertions ──────────────────────────────────────────');

    for (const shot of shots) {
      if (shot.pixels.stdDev <= 10) {
        fail(failures, `${shot.id}: stdDev ${shot.pixels.stdDev.toFixed(1)} — frame looks blank`);
      }
      if (shot.pixels.colours <= 100) {
        fail(failures, `${shot.id}: only ${shot.pixels.colours} colours — frame looks blank`);
      }
    }
    if (failures.length === 0) pass('every frame is a real render (stdDev > 10, colours > 100)');

    const byId = new Map(shots.map((s) => [s.id, s]));
    const midnight = byId.get('midnight')!;
    const noon = byId.get('noon')!;
    const night = byId.get('night')!;
    const dusk = byId.get('dusk')!;
    const dawn = byId.get('dawn')!;

    // THE assertion. Everything else in this file is supporting evidence.
    const lumaRatio = midnight.pixels.meanLuma / Math.max(1e-6, noon.pixels.meanLuma);
    report.midnightNoonLumaRatio = lumaRatio;
    if (lumaRatio > 0.55) {
      fail(
        failures,
        `MIDNIGHT LOOKS LIKE NOON: mean luma ${midnight.pixels.meanLuma.toFixed(1)} vs ` +
          `${noon.pixels.meanLuma.toFixed(1)} (ratio ${lumaRatio.toFixed(3)}). The exposure ` +
          `normalisation against measured meanLuminance is not reaching the pixels.`
      );
    } else {
      pass(
        `night reads as night: midnight ${midnight.pixels.meanLuma.toFixed(1)} vs noon ` +
          `${noon.pixels.meanLuma.toFixed(1)} (ratio ${lumaRatio.toFixed(3)})`
      );
    }

    // All six must be measurably distinct from each other.
    let worstPair: { a: string; b: string; delta: number } | undefined;
    for (let i = 0; i < shots.length; i++) {
      for (let j = i + 1; j < shots.length; j++) {
        const a = shots[i]!;
        const b = shots[j]!;
        const delta =
          Math.abs(a.pixels.meanLuma - b.pixels.meanLuma) +
          60 * Math.abs(a.pixels.coolness - b.pixels.coolness);
        if (!worstPair || delta < worstPair.delta) {
          worstPair = { a: a.id, b: b.id, delta };
        }
      }
    }
    report.closestPair = worstPair;
    if (!worstPair || worstPair.delta < 2.5) {
      fail(
        failures,
        `two times of day are visually indistinguishable: ${worstPair?.a} vs ${worstPair?.b} ` +
          `(combined luma+colour delta ${worstPair?.delta.toFixed(2)})`
      );
    } else {
      pass(
        `all six times are measurably distinct (closest pair ${worstPair.a}/${worstPair.b}, ` +
          `delta ${worstPair.delta.toFixed(2)})`
      );
    }

    // Brightness must be ordered the way a day is.
    const ordered = [midnight, night, dawn, dusk, noon];
    if (!(midnight.pixels.meanLuma < dawn.pixels.meanLuma && dawn.pixels.meanLuma < noon.pixels.meanLuma)) {
      fail(
        failures,
        `brightness is not ordered midnight < dawn < noon: ` +
          ordered.map((s) => `${s.id}=${s.pixels.meanLuma.toFixed(1)}`).join(' ')
      );
    } else {
      pass('brightness is ordered midnight < dawn < noon');
    }

    // Night must be cooler than noon: the Purkinje shift plus the night sky.
    if (night.pixels.coolness <= noon.pixels.coolness) {
      fail(
        failures,
        `nightfall is not cooler than noon (${night.pixels.coolness.toFixed(3)} vs ` +
          `${noon.pixels.coolness.toFixed(3)})`
      );
    } else {
      pass(
        `nightfall is cooler than noon (${night.pixels.coolness.toFixed(3)} vs ` +
          `${noon.pixels.coolness.toFixed(3)})`
      );
    }

    // The street lights and window emissives must actually switch.
    if (!midnight.sky.streetLightsOn || !night.sky.streetLightsOn) {
      fail(failures, 'street lights are off at night');
    } else if (noon.sky.streetLightsOn || dusk.sky.streetLightsOn) {
      fail(failures, 'street lights are on in daylight');
    } else {
      pass('street lights switch on at night and off by day, via one shared uniform');
    }

    // The sun has to move. A static light would pass every luminance test.
    const azimuths = shots.map((s) => s.sky.sunAzimuthDegrees);
    const azimuthSpread = Math.max(...azimuths) - Math.min(...azimuths);
    const elevations = shots.map((s) => s.sky.sunElevationDegrees);
    report.sunTravel = { azimuthSpread, elevations };
    if (azimuthSpread < 120) {
      fail(failures, `the sun barely moves: azimuth spread only ${azimuthSpread.toFixed(0)} degrees`);
    } else {
      pass(`the sun travels ${azimuthSpread.toFixed(0)} degrees of azimuth across the six shots`);
    }
    if (Math.max(...elevations) < 60) {
      fail(failures, `noon elevation only ${Math.max(...elevations).toFixed(1)} degrees`);
    }
    if (Math.min(...elevations) > -10) {
      fail(failures, 'the sun never goes properly below the horizon');
    }

    // The pre-filtered radiance map has to have been rebuilt as the mix moved.
    const afterShots = (await page.evaluate(() =>
      window.__PROGRESSION_HARNESS__!.snapshot()
    )) as IHarnessSnapshot;
    if (afterShots.radianceRebuilds < 6) {
      fail(failures, `only ${afterShots.radianceRebuilds} radiance rebuilds across six times`);
    } else {
      pass(`radiance map rebuilt ${afterShots.radianceRebuilds} times as the blend moved`);
    }

    /* -------------------------------------------------- headless scenarios */
    console.log('\n── progression scenarios ───────────────────────────────────');
    const scenarios = (await page.evaluate(() =>
      window.__PROGRESSION_HARNESS__!.runScenarios()
    )) as IScenarioResult[];
    report.scenarios = scenarios;

    const byName = new Map(scenarios.map((s) => [s.name, s.detail]));
    for (const scenario of scenarios) {
      console.log(`  ${scenario.name}`);
      for (const [key, value] of Object.entries(scenario.detail)) {
        console.log(`      ${key.padEnd(28)} ${String(value)}`);
      }
    }

    const kills = byName.get('unwitnessedKills')!;
    const rescues = byName.get('witnessedRescues')!;
    const collateral = byName.get('unwitnessedCollateral')!;
    const genos = byName.get('genosIrony')!;
    const throttle = byName.get('boredomThrottle')!;
    const conflict = byName.get('questConflict')!;
    const timer = byName.get('evacuationTimer')!;

    console.log('\n── progression assertions ──────────────────────────────────');

    if ((kills.pointsGained as number) !== 0) {
      fail(failures, `200 unwitnessed kills moved rank by ${kills.pointsGained} points; expected 0`);
    } else {
      pass('200 unwitnessed kills moved rank by exactly 0 points');
    }
    if (kills.rank !== 'C-Class Rank 388') {
      fail(failures, `rank changed after unwitnessed kills: ${kills.rank}`);
    } else {
      pass('rank is still C-Class Rank 388 after 200 kills');
    }

    if ((rescues.pointsGained as number) < 100) {
      fail(failures, `20 witnessed rescues only banked ${rescues.pointsGained} points`);
    } else {
      pass(`20 witnessed rescues banked ${rescues.pointsGained} points -> ${rescues.rank}`);
    }
    if ((rescues.pointsGained as number) <= (kills.pointsGained as number)) {
      fail(failures, 'witnessed rescues did not outscore unwitnessed kills');
    }

    if ((collateral.reportRate as number) < 0.5) {
      fail(failures, `unwitnessed collateral reported at only ${collateral.reportRate}`);
    } else {
      pass(
        `collateral reported at ${collateral.reportRate} with NOBODY watching ` +
          `(${collateral.peakRank} -> ${collateral.rankAfter})`
      );
    }
    if ((collateral.pointsAfter as number) >= (collateral.peakPoints as number)) {
      fail(failures, 'reported collateral did not cost the player any rank');
    }

    if ((genos.ratio as number) <= 1.5) {
      fail(failures, `Genos banked only ${genos.ratio}x the player's credit at the same fights`);
    } else {
      pass(
        `Genos banked ${genos.ratio}x the player's credit at 10 shared incidents ` +
          `(${genos.playerRank} vs ${genos.genosRank})`
      );
    }
    if ((genos.endGap as number) <= 0) {
      fail(failures, 'Genos did not stay ahead of the player');
    }

    const throttleRatio = throttle.ratio as number;
    if (Math.abs(throttleRatio - (throttle.expectedFloor as number)) > 0.02) {
      fail(
        failures,
        `boredom throttle is ${throttleRatio}, expected ${throttle.expectedFloor} at max boredom`
      );
    } else {
      pass(`boredom throttles rank gain to x${throttleRatio} at maximum boredom`);
    }
    if (throttle.funFightsAtMaxBoredom !== false) {
      fail(failures, 'fun fights are still available at maximum boredom');
    } else {
      pass('fun-fight encounters are locked out at maximum boredom');
    }

    if (conflict.mosquito !== 'completed' || conflict.bargainSale !== 'failed') {
      fail(
        failures,
        `quest conflict wrong: mosquito=${conflict.mosquito} bargain=${conflict.bargainSale}`
      );
    } else {
      pass(
        `completing the subjugation failed the bargain sale, costing ` +
          `${conflict.boredomAfterMissingTheSale} boredom`
      );
    }

    if (timer.atTwentySeconds !== 'active' || timer.afterExpiry !== 'failed') {
      fail(
        failures,
        `evacuation timer wrong: at 20s=${timer.atTwentySeconds}, after expiry=${timer.afterExpiry}`
      );
    } else {
      pass('the rescue evacuation timer expires into a failed state');
    }

    /* ------------------------------------------------------ save round trip */
    console.log('\n── save round trip ─────────────────────────────────────────');
    const roundTrip = (await page.evaluate(() =>
      window.__PROGRESSION_HARNESS__!.runSaveRoundTrip()
    )) as {
      backend: string;
      exact: boolean;
      bytes: number;
      mismatches: string[];
      rank: string;
      boredom: number;
      questStates: number;
    };
    report.saveRoundTrip = roundTrip;
    console.log(
      `  backend=${roundTrip.backend} bytes=${roundTrip.bytes} ` +
        `rank="${roundTrip.rank}" boredom=${roundTrip.boredom.toFixed(4)} ` +
        `quests=${roundTrip.questStates}`
    );
    if (!roundTrip.exact) {
      fail(failures, `save round trip is NOT exact: ${roundTrip.mismatches.join(', ')}`);
    } else {
      pass(`save round trip is byte-exact through ${roundTrip.backend}`);
    }
    if (roundTrip.backend !== 'localStorage') {
      fail(failures, `expected the localStorage backend in a browser, got "${roundTrip.backend}"`);
    }

    /* --------------------------------------------------------- page health */
    const fatal = consoleErrors.filter(
      (text) => !/favicon|Failed to load resource.*404/i.test(text)
    );
    report.consoleErrors = fatal;
    if (fatal.length > 0) {
      fail(failures, `${fatal.length} console error(s): ${fatal.slice(0, 3).join(' | ')}`);
    } else {
      pass('no console errors');
    }
    if (initial.problems.length > 0) {
      fail(failures, `harness reported problems: ${initial.problems.join('; ')}`);
    }

    await page.close();
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  report.failures = failures;
  report.passed = failures.length === 0;
  await writeFile(path.join(OUT_DIR, 'progression-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log('\n────────────────────────────────────────────────────────────');
  if (failures.length > 0) {
    console.error(`${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('all progression + day/night checks passed');
  }
}

declare global {
  interface Window {
    __PROGRESSION_HARNESS__?: {
      ready: boolean;
      snapshot(): unknown;
      meta(): unknown;
      setTimeOfDay(t: number): void;
      step(dt?: number): void;
      settle(frames: number): void;
      runScenarios(): unknown;
      runSaveRoundTrip(): Promise<unknown>;
      shotTimes(): unknown;
    };
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
