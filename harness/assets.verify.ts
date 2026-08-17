/**
 * HARNESS DRIVER — asset runtime
 *
 * Serves the repo through an in-process Vite server so `@/` resolves exactly
 * as it does in the game, drives headless Chromium over SwiftShader, asserts
 * the measurements the page publishes, and screenshots the material grid.
 *
 * ── THE APK MIRROR ─────────────────────────────────────────────────────────
 * A middleware exposes `/apk-assets/*` as `/assets/*` with one difference:
 * every `.high.` and `.ultra.` file answers 404. That is precisely the Android
 * package — `assets.runtime.json` declares three tiers, the APK contains one,
 * and 26 declared files (13 high + 13 ultra) are simply absent.
 *
 * The 404 count is taken from PLAYWRIGHT'S side of the connection, not the
 * page's, so the runtime cannot mark its own homework: if it asks for a file
 * that is not there, the driver sees the 404 whatever the page reports.
 *
 * Run: `npx tsx harness/assets.verify.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium, type Page } from 'playwright';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const BASIS_SRC = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const BASIS_DST = path.join(ROOT, 'public', 'assets', 'basis');

/** The CI container has no GPU. */
const CHROME_FLAGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

/* -------------------------------------------------------------------------- */
/* Published shapes                                                           */
/* -------------------------------------------------------------------------- */

interface TextureRow {
  key: string;
  tier: string;
  gpuFormat: string;
  compressed: boolean;
  codec: string;
  colorSpace: string;
  width: number;
  height: number;
  gpuBytes: number;
  mipLevels: number;
  flipY: boolean;
  fallback: boolean;
}

interface MaterialRow {
  id: string;
  ormBound: boolean;
  aoChannel: number;
  aoIsRoughness: boolean;
  aoIsMetalness: boolean;
  albedoColorSpace: string;
  normalColorSpace: string;
  albedoCompressed: boolean;
  missing: string[];
  usesFallbackTexture: boolean;
  tiers: string[];
}

interface ModelRow {
  id: string;
  lodGroups: number;
  lodCount: number;
  triangles: number[];
  activeLevel: number;
  visiblePerGroup: number[];
  meshes: number;
  embeddedTexturesCompressed: number;
  embeddedTexturesTotal: number;
}

interface EnvironmentRow {
  key: string;
  mode: string;
  meanLuminance: number;
  maxLuminance: number;
  shCoefficients: number;
  minFilterIsLinear: boolean;
  magFilterIsLinear: boolean;
  equirectMapping: boolean;
  flipY: boolean;
  gpuBytes: number;
  fallback: boolean;
}

interface BudgetReport {
  budgetBytes: number;
  residentBefore: number;
  residentAfter: number;
  evicted: string[];
  pinned: string[];
  retainedKeys: string[];
  retainedStillResident: boolean;
  evictedWereUnreferenced: boolean;
  evictedInLruOrder: boolean;
  overBudget: boolean;
}

interface HarnessStats {
  mode: string;
  root: string;
  tier: string;
  tierReason: string;
  transcodeTarget: string;
  transcodeAvailable: string[];
  emulatedFormatsSuppressed: boolean;
  renderer: string;
  maxTextureSize: number;
  anisotropy: number;
  textures: TextureRow[];
  materials: MaterialRow[];
  models: ModelRow[];
  environments: EnvironmentRow[];
  budget?: BudgetReport;
  requestedTiers: string[];
  tierMisses: { key: string; tier: string; reason: string }[];
  unavailableTiers: string[];
  missing: string[];
  failures: { key: string; kind: string; reason: string }[];
  textureBytes: number;
  textureBudgetBytes: number;
  gpuBytes: number;
  progressSamples: { fraction: number; loaded: number; total: number; bytesLoaded: number }[];
  progressMonotonic: boolean;
  drawCalls: number;
  sceneTriangles: number;
  characterCount: number;
  loadMs: number;
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${message}`);
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mirror `/assets` at `/apk-assets` with the high and ultra tiers withheld.
 *
 * Installed as an inline plugin so `vite.config.ts` (owned by another
 * workstream) does not have to change. `configureServer` without a returned
 * hook installs BEFORE Vite's internal middlewares, which is what lets the
 * rewrite reach the public-dir handler.
 */
function apkMirror(): Plugin {
  return {
    name: 'harness-apk-mirror',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/apk-assets/')) {
          next();
          return;
        }
        if (/\.(high|ultra)\./.test(url)) {
          res.statusCode = 404;
          res.end('not packaged in the APK');
          return;
        }
        req.url = url.replace('/apk-assets/', '/assets/');
        next();
      });
    },
  };
}

/**
 * `KTX2Loader` fetches the Basis transcoder at runtime and evaluates it in a
 * worker. It must be served verbatim, so it is copied into the gitignored
 * `public/assets/` tree rather than imported through the bundler.
 */
async function stageTranscoder(): Promise<void> {
  await mkdir(BASIS_DST, { recursive: true });
  for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
    await copyFile(path.join(BASIS_SRC, file), path.join(BASIS_DST, file));
  }
}

/* -------------------------------------------------------------------------- */
/* Frame inspection                                                           */
/* -------------------------------------------------------------------------- */

interface FrameStats {
  distinctColors: number;
  stdDev: number;
  meanLuma: number;
  magentaPixels: number;
}

/**
 * Measure a PNG buffer.
 *
 * NOTE for anyone extending this: `sharp(file).extract(region).stats()` does
 * NOT crop — `stats()` reads the input and ignores the queued pipeline, so a
 * region assertion written that way passes vacuously. Materialise the crop
 * with `.toBuffer()` first, as `regionStats` below does.
 */
async function frameStats(buffer: Buffer): Promise<FrameStats> {
  const image = sharp(buffer);
  const stats = await image.stats();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  const colours = new Set<number>();
  let magenta = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    colours.add((r << 16) | (g << 8) | b);
    // The missing-texture checker's magenta, allowing for tone mapping.
    if (r > 180 && g < 90 && b > 120) magenta++;
  }

  const channels = stats.channels.slice(0, 3);
  return {
    distinctColors: colours.size,
    stdDev: channels.reduce((sum, channel) => sum + channel.stdev, 0) / channels.length,
    meanLuma: channels.reduce((sum, channel) => sum + channel.mean, 0) / channels.length,
    magentaPixels: magenta,
  };
}

/** Stats for one region. Materialises the crop first — see `frameStats`. */
async function regionStats(
  buffer: Buffer,
  region: { left: number; top: number; width: number; height: number }
): Promise<FrameStats> {
  const cropped = await sharp(buffer).extract(region).png().toBuffer();
  return frameStats(cropped);
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

interface RunResult {
  stats: HarnessStats;
  screenshot: Buffer;
  notFound: string[];
  requests: string[];
  consoleErrors: string[];
}

async function runMode(
  page: Page,
  url: string,
  query: Record<string, string>,
  size: { width: number; height: number }
): Promise<RunResult> {
  const notFound: string[] = [];
  const requests: string[] = [];
  const consoleErrors: string[] = [];

  page.on('response', (response) => {
    requests.push(response.url());
    if (response.status() === 404) notFound.push(response.url());
  });
  page.on('requestfailed', (request) => notFound.push(`${request.url()} (failed)`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const target = new URL('harness/assets.html', url);
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
  target.searchParams.set('w', String(size.width));
  target.searchParams.set('h', String(size.height));

  await page.setViewportSize(size);
  await page.goto(target.href, { waitUntil: 'load', timeout: 240_000 });
  await page.waitForFunction(() => window.__HARNESS_READY__ === true, undefined, {
    timeout: 420_000,
  });

  const pageError = await page.evaluate(() => window.__HARNESS_ERROR__);
  if (pageError !== undefined) throw new Error(`harness threw:\n${pageError}`);

  const stats = (await page.evaluate(() => window.__HARNESS_STATS__)) as HarnessStats;
  // Generous: several agents share four cores here, and SwiftShader's readback
  // of a 1600x900 buffer can overrun Playwright's 30 s default under load.
  const screenshot = await page.screenshot({ type: 'png', timeout: 180_000 });
  return { stats, screenshot, notFound, requests, consoleErrors };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  await stageTranscoder();
  await mkdir(OUT_DIR, { recursive: true });

  let server: ViteDevServer | undefined;
  const browser = await chromium.launch({ args: CHROME_FLAGS });
  const report: Record<string, unknown> = {};

  try {
    server = await createServer({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.ts'),
      plugins: [apkMirror()],
      logLevel: 'warn',
      server: { port: 0, strictPort: false, host: '127.0.0.1' },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) throw new Error('vite dev server did not report a URL');

    /* ---- 1. full tree: transcode, ORM, LODs, environments -------------- */
    console.log('\n─── grid (full asset tree) ───');
    const grid = await runMode(
      await browser.newPage(),
      url,
      { mode: 'grid' },
      { width: 1600, height: 900 }
    );
    report.grid = grid.stats;
    assertCommon('grid', grid);
    assertTranscode(grid.stats);
    assertOrm(grid.stats);
    assertModels(grid.stats);
    assertEnvironments(grid.stats, { expectPmremWhenNotMobile: true });
    assertProgress(grid.stats);

    const gridShot = path.join(OUT_DIR, 'assets-material-grid.png');
    await writeFile(gridShot, grid.screenshot);
    await assertFrame('grid', grid.screenshot);
    console.log(`  screenshot -> ${path.relative(ROOT, gridShot)}`);

    /* ---- 2. the APK: mobile only, and no 404 anywhere ------------------- */
    console.log('\n─── apk (mobile-only mirror, native signal) ───');
    const apk = await runMode(
      await browser.newPage(),
      url,
      { mode: 'grid', root: 'apk' },
      { width: 1600, height: 900 }
    );
    report.apk = apk.stats;
    assertCommon('apk', apk);
    assertTranscode(apk.stats);
    assertOrm(apk.stats);
    assertAndroidTier(apk);
    assertEnvironments(apk.stats, { expectPmremWhenNotMobile: false });

    const apkShot = path.join(OUT_DIR, 'assets-tier-fallback.png');
    await writeFile(apkShot, apk.screenshot);
    await assertFrame('apk', apk.screenshot);
    console.log(`  screenshot -> ${path.relative(ROOT, apkShot)}`);

    /* ---- 3. forced ultra against the APK: recovery, not a crash --------- */
    console.log('\n─── apk + forced ultra (recovery path) ───');
    const forced = await runMode(
      await browser.newPage(),
      url,
      { mode: 'grid', root: 'apk', tier: 'ultra' },
      { width: 900, height: 520 }
    );
    report.forcedUltra = forced.stats;
    assertForcedRecovery(forced);

    /* ---- 4. LRU under a squeezed budget --------------------------------- */
    console.log('\n─── budget (LRU + reference counts) ───');
    const budget = await runMode(
      await browser.newPage(),
      url,
      { mode: 'budget' },
      { width: 900, height: 520 }
    );
    report.budget = budget.stats;
    assertBudget(budget.stats);

    await writeFile(
      path.join(OUT_DIR, 'assets-report.json'),
      `${JSON.stringify(report, null, 2)}\n`
    );
    summarise(grid.stats, apk.stats, budget.stats);
  } finally {
    await browser.close();
    await server?.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\nasset harness PASS');
}

/* -------------------------------------------------------------------------- */
/* Assertion groups                                                           */
/* -------------------------------------------------------------------------- */

function assertCommon(name: string, run: RunResult): void {
  const { stats } = run;
  check(stats.textures.length >= 30, `${name}: ${stats.textures.length} textures resident`);
  check(stats.materials.length === 12, `${name}: ${stats.materials.length} materials built`);
  check(stats.models.length === 8, `${name}: ${stats.models.length} models loaded`);
  check(stats.missing.length === 0, `${name}: no assets fell back (${stats.missing.join(', ')})`);
  check(stats.failures.length === 0, `${name}: no load failures`);
  check(
    stats.materials.every((row) => !row.usesFallbackTexture),
    `${name}: no material bound the missing-texture pattern`
  );
  const noisy = run.consoleErrors.filter((text) => !text.includes('WebGL'));
  check(noisy.length === 0, `${name}: no console errors`);
  if (noisy.length > 0) console.log(noisy.slice(0, 6).join('\n'));
}

function assertTranscode(stats: HarnessStats): void {
  const compressed = stats.textures.filter((row) => row.compressed);
  check(
    compressed.length === stats.textures.length,
    `every texture is block-compressed on the GPU (${compressed.length}/${stats.textures.length})`
  );
  const formats = new Set(stats.textures.map((row) => row.gpuFormat));
  check(
    !formats.has('RGBAFormat'),
    `nothing fell back to uncompressed RGBA (targets: ${[...formats].join(', ')})`
  );
  check(
    stats.transcodeAvailable.length > 0,
    `transcode targets available: ${stats.transcodeAvailable.join(', ')}`
  );
  check(
    stats.textures.every((row) => row.mipLevels > 1),
    `every texture carries a mip chain`
  );
  check(
    stats.textures.every((row) => row.flipY === false),
    `no texture is re-flipped (bottom-left origin is baked in)`
  );
  const srgb = stats.textures.filter((row) => row.key.endsWith('.albedo'));
  check(
    srgb.length > 0 && srgb.every((row) => row.colorSpace === 'srgb'),
    `albedo maps are sRGB, data maps are linear`
  );
  check(
    stats.textures.filter((row) => row.key.endsWith('.normal')).every((row) => row.colorSpace === 'linear'),
    `normal maps are linear`
  );
}

function assertOrm(stats: HarnessStats): void {
  check(
    stats.materials.every((row) => row.ormBound),
    `every material bound its packed ORM map`
  );
  check(
    stats.materials.every((row) => row.aoIsRoughness && row.aoIsMetalness),
    `ORM serves aoMap, roughnessMap and metalnessMap from ONE texture`
  );
  check(
    stats.materials.every((row) => row.aoChannel === 0),
    `aoMap.channel === 0 on every material (UV0, not glTF's UV1 default)`
  );
  check(
    stats.materials.every((row) => row.albedoColorSpace === 'srgb'),
    `albedo bound as sRGB`
  );
  check(
    stats.materials.every((row) => row.normalColorSpace === ''),
    `normal bound with no transfer function`
  );
}

function assertModels(stats: HarnessStats): void {
  const withChain = stats.models.filter((row) => row.lodCount === 3);
  check(
    withChain.length === stats.models.length,
    `every model exposes its 3-LOD chain (${withChain.length}/${stats.models.length})`
  );
  check(
    stats.models.every((row) => row.activeLevel === 0),
    `models default to LOD0`
  );
  check(
    stats.models.every(
      (row) => row.triangles.length === 3 && row.triangles[0]! > row.triangles[2]!
    ),
    `LOD triangle counts descend (e.g. ${stats.models[0]?.triangles.join(' > ')})`
  );
  const groups = stats.models.reduce((sum, row) => sum + row.lodGroups, 0);
  check(
    stats.models.every(
      (row) =>
        row.visiblePerGroup.length === row.lodGroups &&
        row.visiblePerGroup.every((visible) => visible === 1)
    ),
    `exactly one level is visible in each of the ${groups} LOD groups — ` +
      `GLTFLoader would otherwise draw all three at once`
  );
  const embedded = stats.models.reduce((sum, row) => sum + row.embeddedTexturesTotal, 0);
  const embeddedCompressed = stats.models.reduce(
    (sum, row) => sum + row.embeddedTexturesCompressed,
    0
  );
  check(
    embedded > 0 && embeddedCompressed === embedded,
    `GLB-embedded KTX2 also transcodes compressed (${embeddedCompressed}/${embedded})`
  );
}

function assertEnvironments(
  stats: HarnessStats,
  options: { expectPmremWhenNotMobile: boolean }
): void {
  check(stats.environments.length === 2, `${stats.environments.length} environments loaded`);
  check(
    stats.environments.every((row) => row.minFilterIsLinear && row.magFilterIsLinear),
    `environment maps re-filtered to linear (KTX2Loader hands them back Nearest)`
  );
  check(
    stats.environments.every((row) => row.equirectMapping),
    `environment maps use EquirectangularReflectionMapping`
  );
  check(
    stats.environments.every((row) => row.shCoefficients === 27),
    `baked SH-9 present for every sky (27 coefficients)`
  );
  check(
    stats.environments.every((row) => row.meanLuminance > 0 && row.meanLuminance !== 1),
    `meanLuminance surfaced, not swallowed ` +
      `(${stats.environments.map((row) => row.meanLuminance.toFixed(3)).join(', ')})`
  );
  const peaks = stats.environments.map((row) => row.maxLuminance);
  check(
    peaks.every((peak) => peak > 0),
    `maxLuminance surfaced (${peaks.map((peak) => peak.toFixed(0)).join(', ')})`
  );

  const expected = stats.tier === 'mobile' ? 'sh' : options.expectPmremWhenNotMobile ? 'pmrem' : 'sh';
  check(
    stats.environments.every((row) => row.mode === expected),
    `tier '${stats.tier}' uses the ${expected.toUpperCase()} irradiance path`
  );
}

function assertProgress(stats: HarnessStats): void {
  check(stats.progressSamples.length > 0, `progress was reported during the load`);
  check(stats.progressMonotonic, `progress never went backwards`);
  check(
    stats.progressSamples.at(-1)?.fraction === 1,
    `progress finished at 1.0 (${stats.progressSamples.at(-1)?.fraction})`
  );
  const bytes = stats.progressSamples.at(-1)?.bytesLoaded ?? 0;
  check(bytes > 1_000_000, `progress is byte-weighted, not count-only (${mb(bytes)} reported)`);
}

/** THE live bug. Mobile tier on Android, and not one request outside it. */
function assertAndroidTier(run: RunResult): void {
  const { stats } = run;
  check(stats.tier === 'mobile', `native shell selected the mobile tier (got '${stats.tier}')`);
  check(
    stats.tierReason.includes('packaged'),
    `and did so because of what is PACKAGED, not a speed guess: ${stats.tierReason}`
  );
  check(
    stats.requestedTiers.every((tier) => tier === 'mobile'),
    `every texture came from the mobile tier (${stats.requestedTiers.join(', ')})`
  );

  const tieredRequests = run.requests.filter(
    (requestUrl) => /apk-assets/.test(requestUrl) && /\.(high|ultra)\./.test(requestUrl)
  );
  check(
    tieredRequests.length === 0,
    `zero requests for high/ultra files the package does not contain`
  );
  check(
    run.notFound.length === 0,
    `zero 404s across the whole boot (${run.notFound.slice(0, 3).join(', ')})`
  );
  check(stats.tierMisses.length === 0, `no tier misses had to be recovered from`);
  check(stats.missing.length === 0, `nothing fell back to a stand-in`);
}

/** Forcing a tier the package lacks must recover, not crash. */
function assertForcedRecovery(run: RunResult): void {
  const { stats } = run;
  check(
    run.notFound.length > 0,
    `forcing 'ultra' against the APK mirror does hit 404s (${run.notFound.length})`
  );
  check(stats.missing.length === 0, `…yet nothing fell back to a stand-in`);
  check(stats.failures.length === 0, `…and no asset failed outright`);
  check(
    stats.materials.every((row) => row.ormBound && row.aoChannel === 0),
    `…every material still built correctly`
  );
  check(
    stats.tierMisses.length > 0,
    `…the misses were recorded (${stats.tierMisses.length}) rather than swallowed`
  );
  check(
    stats.unavailableTiers.length > 0,
    `…and the dead tiers were written off (${stats.unavailableTiers.join(', ')}), ` +
      `so later assets stop probing them`
  );
  check(
    run.notFound.length < 26,
    `…which caps the damage at ${run.notFound.length} 404s instead of one per file`
  );
}

function assertBudget(stats: HarnessStats): void {
  const budget = stats.budget;
  if (budget === undefined) {
    failures.push('budget: the page published no LRU report');
    return;
  }
  check(budget.evicted.length > 0, `LRU evicted ${budget.evicted.length} texture(s) under pressure`);
  check(
    budget.retainedStillResident,
    `every referenced texture survived (${budget.retainedKeys.length} pinned by live materials)`
  );
  check(
    budget.evictedWereUnreferenced,
    `nothing evicted was still referenced — even though the unreferenced set was the MOST recently used`
  );
  check(budget.evictedInLruOrder, `eviction walked the LRU in order`);
  check(
    budget.residentAfter < budget.residentBefore,
    `resident texture memory fell ${mb(budget.residentBefore)} -> ${mb(budget.residentAfter)}`
  );
  check(
    budget.residentAfter <= budget.budgetBytes || budget.overBudget,
    `back inside the ${mb(budget.budgetBytes)} budget, or over it only because of pinned textures`
  );
  check(
    budget.pinned.length > 0,
    `${budget.pinned.length} referenced texture(s) were skipped rather than freed`
  );
}

async function assertFrame(name: string, screenshot: Buffer): Promise<void> {
  const frame = await frameStats(screenshot);
  check(
    frame.distinctColors > 100,
    `${name}: real content (${frame.distinctColors} distinct colours)`
  );
  check(frame.stdDev > 10, `${name}: not a flat fill (stdDev ${frame.stdDev.toFixed(1)})`);
  check(
    frame.meanLuma > 12,
    `${name}: not a black frame (mean luma ${frame.meanLuma.toFixed(1)})`
  );
  check(
    frame.magentaPixels < 400,
    `${name}: no missing-texture checker on screen (${frame.magentaPixels} magenta px)`
  );

  // The material spheres occupy the upper two thirds; the models the bottom
  // strip. Both bands must carry detail, or "the frame is not blank" is being
  // satisfied by the readout text alone.
  const meta = await sharp(screenshot).metadata();
  const width = meta.width ?? 1600;
  const height = meta.height ?? 900;
  const spheres = await regionStats(screenshot, {
    left: Math.round(width * 0.2),
    top: Math.round(height * 0.12),
    width: Math.round(width * 0.6),
    height: Math.round(height * 0.5),
  });
  const models = await regionStats(screenshot, {
    left: Math.round(width * 0.1),
    top: Math.round(height * 0.66),
    width: Math.round(width * 0.8),
    height: Math.round(height * 0.24),
  });
  check(
    spheres.stdDev > 12 && spheres.meanLuma > 15,
    `${name}: material band is lit and textured (stdDev ${spheres.stdDev.toFixed(1)}, ` +
      `luma ${spheres.meanLuma.toFixed(1)}, ${spheres.distinctColors} colours)`
  );
  check(
    models.stdDev > 8 && models.distinctColors > 100,
    `${name}: model band has geometry (stdDev ${models.stdDev.toFixed(1)}, ` +
      `${models.distinctColors} colours)`
  );
}

function summarise(grid: HarnessStats, apk: HarnessStats, budget: HarnessStats): void {
  console.log('\n─── summary ───');
  console.log(`  GPU              ${grid.renderer}`);
  console.log(
    `  transcode        ${grid.transcodeTarget} (available: ${grid.transcodeAvailable.join(', ')})`
  );
  console.log(`  desktop tier     ${grid.tier} — ${grid.tierReason}`);
  console.log(`  android tier     ${apk.tier} — ${apk.tierReason}`);
  const tiers = new Map<string, number>();
  for (const row of grid.textures) tiers.set(row.tier, (tiers.get(row.tier) ?? 0) + 1);
  console.log(
    `  texture tiers    ${[...tiers].map(([tier, count]) => `${count}x${tier}`).join(', ')}`
  );
  console.log(
    `  texture memory   ${mb(grid.textureBytes)} of ${mb(grid.textureBudgetBytes)} budget ` +
      `(${grid.textures.length} textures)`
  );
  console.log(`  total GPU bytes  ${mb(grid.gpuBytes)}`);
  console.log(
    `  environments     ${grid.environments.map((row) => `${row.key}=${row.mode}`).join(', ')} / ` +
      `${apk.environments.map((row) => `${row.key}=${row.mode}`).join(', ')} on android`
  );
  if (budget.budget) {
    console.log(
      `  LRU              evicted ${budget.budget.evicted.length}, pinned ` +
        `${budget.budget.pinned.length}, ${mb(budget.budget.residentBefore)} -> ` +
        `${mb(budget.budget.residentAfter)}`
    );
  }
  console.log(`  load time        grid ${grid.loadMs} ms, android ${apk.loadMs} ms`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
