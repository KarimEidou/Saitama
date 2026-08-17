/**
 * RENDERER HARNESS VERIFICATION
 *
 * Builds `harness/renderer.html` with Vite, serves it, drives it in headless
 * Chromium with SwiftShader, and asserts on things that can actually be
 * counted.
 *
 * ── WHY NOT ASSERT ON FRAME RATE ───────────────────────────────────────────
 * SwiftShader is a CPU software rasteriser. A PBR scene with cascaded shadows
 * and a post chain runs at single-digit frames per second here no matter how
 * good the renderer is, and would run at single-digit frames per second if the
 * renderer were twice as fast. Any fps threshold would be measuring the CI
 * machine. So this harness asserts on COUNTED quantities — draw calls,
 * triangles, shader programs, texture bytes — which are identical on
 * SwiftShader and on an Adreno, plus pixel statistics of the actual output.
 *
 * ── WHY THE PIXEL CHECK IS THE REAL GATE ───────────────────────────────────
 * A page whose WebGL throws still loads, still reports `__GAME_READY__` if the
 * flag is set optimistically, and still screenshots — as a black rectangle.
 * Reading the PNG back and requiring real variance and a real colour count is
 * the only assertion that cannot be satisfied by a broken renderer.
 *
 * ── WHY ONE PAGE LOAD PER TIER ─────────────────────────────────────────────
 * Shader programs accumulate inside a WebGL context: switching tiers at runtime
 * leaves the previous tier's programs resident, so a post-switch count is a sum,
 * not a measurement. And default-framebuffer MSAA can only be chosen when the
 * context is created, so the LOW tier's real render path cannot be reached by
 * switching into it. Each tier therefore gets its own page load and its own
 * context. The runtime switch is exercised separately, and reported separately.
 *
 * Run: `npx tsx harness/renderer.verify.ts`
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
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-renderer-harness');

/** Landscape and modest: SwiftShader fills every pixel on the CPU. */
const VIEWPORT = { width: 960, height: 540 };

/**
 * Whole-game shader-program budget. Compile stalls are the #1 source of Android
 * frame hitches and `KHR_parallel_shader_compile` is absent in this target
 * environment, so there is no way to hide them.
 */
const PROGRAM_BUDGET = 24;

/**
 * The body of the smoothest, most metallic sphere in the grid (metalness 1.0,
 * roughness 0.045) at the harness's fixed camera pose. Deliberately a small box
 * INSIDE one sphere rather than a band across the row: a wider crop is mostly
 * sky and ground, whose brightness swamps the very thing being measured.
 *
 * Measured here: 33/255 with spherical harmonics alone, 120/255 once the
 * specular probe exists. That is the whole "black metal" problem in one number.
 */
const METAL_SPHERE_CROP = { left: 404, top: 110, width: 34, height: 34 };

/** The whole sphere grid, saved as small side-by-side evidence crops. */
const SPHERE_GRID_CROP = { left: 370, top: 85, width: 250, height: 300 };

/** Playwright's screenshot `clip` uses x/y; sharp's `extract` uses left/top. */
function toClip(region: { left: number; top: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return { x: region.left, y: region.top, width: region.width, height: region.height };
}

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
};

/* -------------------------------------------------------------------------- */
/* Types mirrored from the harness page                                       */
/* -------------------------------------------------------------------------- */

interface HarnessSnapshot {
  tier: string;
  isWebGL2: boolean;
  rendererString: string;
  vendor: string;
  maxTextureSize: number;
  maxAnisotropy: number;
  compressedFormats: string[];
  hasParallelShaderCompile: boolean;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
  programKeys: string[];
  frameCount: number;
  frameTimeMs: number;
  drawingBuffer: { width: number; height: number };
  pixelRatio: number;
  resolutionScale: number;
  medianFrameMs: number;
  materialCount: number;
  materialSignatures: string[];
  specularOnlyMaterials: number;
  warmup: {
    materials: number;
    meshes: number;
    compiled: number;
    programsAfter: number;
    durationMs: number;
    destinations: string[];
  };
  post: {
    mode: string;
    direct: boolean;
    passCount: number;
    passNames: string[];
    msaaSamples: number;
    bloomScale: number;
    bloomKind: string;
    bloomBytes: number;
  };
  shadows: {
    cascades: number;
    mapSize: number;
    maxDistance: number;
    shadowMapBytes: number;
    blobShadows: number;
    registeredMaterials: number;
  };
  environment: {
    mode: string;
    gpuBytes: number;
    resolution: number;
    hasSphericalHarmonics: boolean;
    lastBuildMs: number;
    specularOnly: boolean;
    specularCubeSize: number;
  };
  memory: {
    textureCount: number;
    textureBytes: number;
    geometryCount: number;
    geometryBytes: number;
    materialCount: number;
    meshCount: number;
    instanceCount: number;
    triangles: number;
  };
  clock: { timeScale: number; elapsed: number; unscaledElapsed: number };
  impact: { active: boolean; phase: string; fovOffset: number };
  cameraFov: number;
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
    // The harness page is built and served on its own; do not let a user-level
    // config file surprise us mid-verification.
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: {
      outDir: BUILD_DIR,
      emptyOutDir: true,
      sourcemap: false,
      // Bundle instead of dev-serving: a dev server discovers dependencies
      // lazily and can trigger a mid-test reload when the optimiser re-runs,
      // which shows up as a flaky "page navigated away" failure.
      rollupOptions: { input: { rendererHarness: path.join(ROOT, 'harness', 'renderer.html') } },
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

/**
 * Statistics of the captured frame.
 *
 * `stdDev` catches a flat fill of any colour; `distinctColors` catches a fill
 * with slight gradient noise that would still pass a variance check. A real PBR
 * render of this scene produces thousands of distinct colours.
 */
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

/**
 * Mean and spread of one rectangle of a screenshot.
 *
 * Used to make a claim about a specific part of the image rather than the frame
 * as a whole — "the metal spheres are not black" is invisible in a whole-frame
 * mean, because they are a small fraction of the pixels.
 *
 * NOTE: `sharp(...).extract(...).stats()` does NOT crop. `stats()` reads the
 * INPUT image and ignores everything queued in the pipeline, so the obvious
 * spelling silently returns whole-frame statistics and any assertion built on
 * it passes vacuously. The crop has to be materialised through `toBuffer()`
 * first, which is why this computes the statistics by hand.
 */
async function analyseRegion(
  file: string,
  region: { left: number; top: number; width: number; height: number }
): Promise<{ mean: number; stdDev: number }> {
  const { data, info } = await sharp(file)
    .extract(region)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const count = info.width * info.height * info.channels;
  if (count === 0) return { mean: 0, stdDev: 0 };

  let total = 0;
  for (let i = 0; i < count; i++) total += data[i]!;
  const mean = total / count;

  let variance = 0;
  for (let i = 0; i < count; i++) {
    const delta = data[i]! - mean;
    variance += delta * delta;
  }
  return { mean, stdDev: Math.sqrt(variance / count) };
}

/**
 * Re-encode a screenshot with maximum PNG compression.
 *
 * LOSSLESS — the pixels are byte-identical, so the statistics reported for the
 * captured frame still describe the committed file exactly. Palette
 * quantisation would shrink these further but would cap the image at 256
 * colours, contradicting the very distinct-colour count this harness reports.
 */
async function recompress(file: string): Promise<void> {
  const optimised = await sharp(file)
    .png({ compressionLevel: 9, effort: 10, adaptiveFiltering: true, palette: false })
    .toBuffer();
  await writeFile(file, optimised);
}

/**
 * Mean absolute per-channel difference between two same-sized PNGs, 0..255.
 *
 * Used for A/B assertions where "the image changed" is the claim. Comparing
 * summary statistics alone would pass for two completely different frames that
 * happen to share a histogram.
 */
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

/* -------------------------------------------------------------------------- */
/* Driver                                                                     */
/* -------------------------------------------------------------------------- */

const failures: string[] = [];
const notes: string[] = [];

/**
 * Group live program cache keys by three's internal shader id (the first field
 * of the key). Turns "33 programs" into "physical x9, depth x3, ..." — which is
 * the difference between knowing the budget is blown and knowing what blew it.
 */
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

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

async function openTier(
  browser: Browser,
  baseUrl: string,
  tier: string
): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  // Everything here is bounded by SwiftShader's frame rate, not by network or
  // script latency; the default 30s would fail on shader compilation alone.
  page.setDefaultTimeout(240_000);
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  await page.goto(`${baseUrl}/harness/renderer.html?tier=${tier}`, {
    waitUntil: 'load',
    timeout: 120_000,
  });
  // Shader compilation of the whole chain happens up front under SwiftShader,
  // which is slow; the budget is generous on purpose.
  await page.waitForFunction(() => window.__GAME_READY__ === true, undefined, {
    timeout: 240_000,
  });
  return { page, errors };
}

async function snapshot(page: Page): Promise<HarnessSnapshot> {
  const value = await page.evaluate(() => window.__RENDER_HARNESS__?.snapshot() ?? null);
  if (!value) throw new Error('window.__RENDER_HARNESS__ was not installed');
  return value as unknown as HarnessSnapshot;
}

async function waitFrames(page: Page, count: number): Promise<void> {
  // SwiftShader renders this scene at a few frames per second, so waiting on a
  // frame COUNT rather than a timeout is the only stable way to know the
  // picture has advanced. The page's default timeout (set in `openTier`) is
  // sized for that.
  await page.evaluate(async (frames) => {
    await window.__RENDER_HARNESS__?.waitFrames(frames);
  }, count);
}

async function verifyTier(
  browser: Browser,
  baseUrl: string,
  tier: string
): Promise<{ snapshot: HarnessSnapshot; pixels: PixelReport }> {
  console.log(`\n──────── tier: ${tier} ────────`);
  const { page, errors } = await openTier(browser, baseUrl, tier);
  try {
    // Let the orbit advance so the captured frame is provably live.
    await waitFrames(page, 8);

    const snap = await snapshot(page);
    const shotPath = path.join(OUT_DIR, `renderer-${tier}.png`);
    await page.screenshot({ path: shotPath, type: 'png' });
    const pixels = await analyse(shotPath);
    await recompress(shotPath);

    /* ------------------------------ asserts ---------------------------- */
    check(snap.isWebGL2, `[${tier}] WebGL2 context was not obtained`);
    check(snap.drawCalls > 0, `[${tier}] no draw calls issued (${snap.drawCalls})`);
    check(snap.triangles > 10_000, `[${tier}] suspiciously few triangles (${snap.triangles})`);
    check(snap.frameCount >= 8, `[${tier}] too few frames presented (${snap.frameCount})`);
    check(
      snap.warmup.compiled > 0,
      `[${tier}] shader warmup compiled nothing (${snap.warmup.compiled})`
    );
    // The warmed destination must be the one the tier actually draws to.
    const expectedDestination = tier === 'low' ? 'direct' : 'offscreen';
    check(
      snap.warmup.destinations.length === 1 && snap.warmup.destinations[0] === expectedDestination,
      `[${tier}] warmup targeted ${JSON.stringify(snap.warmup.destinations)}; ` +
        `expected exactly ["${expectedDestination}"] — warming the other destination ` +
        `doubles the material program count with unusable variants`
    );
    check(
      snap.shadows.registeredMaterials > 0,
      `[${tier}] no materials registered with the shadow system — CSM would ` +
        `over-light every unregistered material`
    );
    check(
      pixels.stdDev > 10,
      `[${tier}] screenshot has too little variance (stdDev ${pixels.stdDev.toFixed(2)})`
    );
    check(
      pixels.distinctColors > 100,
      `[${tier}] screenshot has too few distinct colours (${pixels.distinctColors})`
    );
    check(errors.length === 0, `[${tier}] console errors: ${errors.slice(0, 5).join(' | ')}`);
    check(
      snap.consoleErrors.length === 0,
      `[${tier}] page-reported errors: ${snap.consoleErrors.slice(0, 5).join(' | ')}`
    );

    // Tier-specific expectations.
    if (tier === 'low') {
      check(snap.post.direct, '[low] expected NO effect composer (direct to framebuffer)');
      check(snap.environment.mode === 'sh9', '[low] expected the spherical-harmonic IBL path');
      check(snap.environment.hasSphericalHarmonics, '[low] SH coefficients were not produced');
      check(
        snap.environment.specularOnly,
        '[low] SH path did not build the specular-only probe — smooth metal would render black'
      );
      check(
        snap.environment.specularCubeSize === 32,
        `[low] specular probe cube size is ${snap.environment.specularCubeSize}, expected 32`
      );
      // A full PMREM of a real 4096-wide HDRI is ~25 MB. The whole point of the
      // specular-only probe is that it is a rounding error next to that.
      check(
        snap.environment.gpuBytes > 0 && snap.environment.gpuBytes < 512 * 1024,
        `[low] specular probe is ${(snap.environment.gpuBytes / 1024).toFixed(0)} KB; ` +
          `expected a few hundred KB at most`
      );
      // Every managed material must carry the cancellation, or it is lit by the
      // SH probe AND the probe texture — a full stop of over-exposure that is
      // easy to mistake for "the new lighting looks brighter".
      check(
        snap.specularOnlyMaterials === snap.materialCount,
        `[low] only ${snap.specularOnlyMaterials}/${snap.materialCount} materials cancel ` +
          `the environment map's diffuse term; the rest are double-lit`
      );
      // A/B the probe against itself. Asserting an absolute brightness would
      // only prove the frame is not black; asserting the DIFFERENCE proves the
      // probe is what makes the metal legible.
      await page.evaluate(() => window.__RENDER_HARNESS__?.setCameraFrozen(true));
      await waitFrames(page, 2);

      const withProbeShot = path.join(OUT_DIR, 'renderer-metal-with-probe.png');
      await page.screenshot({ path: withProbeShot, type: 'png', clip: toClip(SPHERE_GRID_CROP) });
      const withProbe = await analyseRegion(shotPath, METAL_SPHERE_CROP);

      await page.evaluate(() => window.__RENDER_HARNESS__?.setSpecularProbe(false));
      await waitFrames(page, 3);
      const withoutShot = path.join(OUT_DIR, 'renderer-metal-sh-only.png');
      await page.screenshot({ path: withoutShot, type: 'png', clip: toClip(SPHERE_GRID_CROP) });
      const noProbeFull = path.join(OUT_DIR, 'renderer-low-no-specular.tmp.png');
      await page.screenshot({ path: noProbeFull, type: 'png' });
      const withoutProbe = await analyseRegion(noProbeFull, METAL_SPHERE_CROP);
      await rm(noProbeFull, { force: true });

      await page.evaluate(() => {
        window.__RENDER_HARNESS__?.setSpecularProbe(true);
        window.__RENDER_HARNESS__?.setCameraFrozen(false);
      });
      await Promise.all([recompress(withProbeShot), recompress(withoutShot)]);

      check(
        withProbe.mean - withoutProbe.mean > 40,
        `[low] the specular probe barely changed the smooth metal sphere ` +
          `(${withoutProbe.mean.toFixed(1)} -> ${withProbe.mean.toFixed(1)}/255); ` +
          `it should go from near-black to reflective`
      );
      check(
        withProbe.mean > 70,
        `[low] the smooth-metal sphere is still dark with the probe on ` +
          `(crop mean ${withProbe.mean.toFixed(1)}/255)`
      );
      check(
        withoutProbe.mean < 60,
        `[low] the SH-only control is not dark (${withoutProbe.mean.toFixed(1)}/255), so ` +
          `the A/B proves nothing — the crop is probably off the sphere`
      );
      console.log(
        `metal sphere   SH only ${withoutProbe.mean.toFixed(1)}/255 -> ` +
          `SH + ${(snap.environment.gpuBytes / 1024).toFixed(0)} KB specular probe ` +
          `${withProbe.mean.toFixed(1)}/255 (crops saved beside the screenshots)`
      );
      check(snap.shadows.cascades === 1, `[low] expected 1 cascade, got ${snap.shadows.cascades}`);
      check(
        snap.programs <= PROGRAM_BUDGET,
        `[low] ${snap.programs} shader programs exceeds the budget of ${PROGRAM_BUDGET}`
      );
    }

    if (tier === 'medium') {
      check(!snap.post.direct, '[medium] expected an effect composer');
      check(snap.post.mode === 'mid', `[medium] unexpected post mode "${snap.post.mode}"`);
      check(snap.environment.mode === 'pmrem', '[medium] expected the PMREM IBL path');
      check(
        snap.specularOnlyMaterials === 0,
        `[medium] ${snap.specularOnlyMaterials} materials are cancelling environment ` +
          `diffuse on a full-PMREM path, which would under-light them`
      );
      check(
        snap.shadows.cascades === 2,
        `[medium] expected 2 cascades, got ${snap.shadows.cascades}`
      );
      check(
        snap.post.bloomKind === 'dual',
        `[medium] expected the 3-program dual-filter bloom, got "${snap.post.bloomKind}"`
      );
      check(
        snap.programs <= PROGRAM_BUDGET,
        `[medium] ${snap.programs} shader programs exceeds the budget of ${PROGRAM_BUDGET}`
      );
      notes.push(
        `[medium] ${snap.programs}/${PROGRAM_BUDGET} programs — ` +
          `${PROGRAM_BUDGET - snap.programs} spare for the character, VFX and world ` +
          `workstreams' own material archetypes`
      );
    }

    if (tier === 'high') {
      check(snap.post.mode === 'high', `[high] unexpected post mode "${snap.post.mode}"`);
      check(
        snap.shadows.cascades === 3,
        `[high] expected 3 cascades, got ${snap.shadows.cascades}`
      );
      check(
        snap.shadows.mapSize === 2048,
        `[high] expected 2048px cascades, got ${snap.shadows.mapSize}`
      );
      // The HIGH chain is desktop-only; it is measured and reported, not gated.
      notes.push(
        `[high] ${snap.programs} shader programs with the full chain ` +
          `(${snap.post.passNames.join(' -> ')}) — desktop tier, not subject to the ` +
          `mobile ${PROGRAM_BUDGET}-program budget`
      );
    }

    // 25 sphere materials must collapse to a single program signature — the
    // core claim of MaterialLib.
    const sphereSignatures = snap.materialSignatures.filter((signature) =>
      signature.startsWith('standard/---/-')
    );
    check(
      sphereSignatures.length <= 2,
      `[${tier}] the 25-material sphere grid produced ${sphereSignatures.length} ` +
        `map-less signatures; expected them to share one`
    );

    console.log(
      [
        `gpu            ${snap.rendererString}`,
        `webgl2         ${snap.isWebGL2}   parallel-compile ${snap.hasParallelShaderCompile}`,
        `draw calls     ${snap.drawCalls}`,
        `triangles      ${snap.triangles.toLocaleString()}`,
        `programs       ${snap.programs} (budget ${PROGRAM_BUDGET})`,
        `  by shader    ${summarizePrograms(snap.programKeys)}`,
        `materials      ${snap.materialCount} across ${snap.materialSignatures.length} signatures`,
        `warmup         +${snap.warmup.compiled} programs, ${snap.warmup.meshes} probes, ` +
          `${snap.warmup.durationMs.toFixed(0)}ms, dest [${snap.warmup.destinations.join(', ')}]`,
        `post           ${snap.post.mode} | ${snap.post.direct ? 'direct-to-framebuffer' : snap.post.passNames.join(' -> ')}`,
        `shadows        ${snap.shadows.cascades} x ${snap.shadows.mapSize} over ${snap.shadows.maxDistance}m ` +
          `(${(snap.shadows.shadowMapBytes / 1024 / 1024).toFixed(1)} MB) | blobs ${snap.shadows.blobShadows}`,
        `ibl            ${snap.environment.mode}` +
          `${snap.environment.specularOnly ? ` + ${snap.environment.specularCubeSize}px specular-only probe` : ''} ` +
          `${(snap.environment.gpuBytes / 1024).toFixed(0)} KB in ${snap.environment.lastBuildMs.toFixed(0)}ms`,
        `bloom          ${snap.post.bloomKind}` +
          `${snap.post.bloomBytes > 0 ? ` pyramid ${(snap.post.bloomBytes / 1024).toFixed(0)} KB` : ''}`,
        `textures       ${snap.memory.textureCount} / ${(snap.memory.textureBytes / 1024 / 1024).toFixed(2)} MB`,
        `geometry       ${snap.memory.geometryCount} / ${(snap.memory.geometryBytes / 1024 / 1024).toFixed(2)} MB ` +
          `| ${snap.memory.instanceCount} instances`,
        `drawing buffer ${snap.drawingBuffer.width}x${snap.drawingBuffer.height} @ dpr ${snap.pixelRatio.toFixed(2)}`,
        `screenshot     ${pixels.width}x${pixels.height} stdDev ${pixels.stdDev.toFixed(2)} ` +
          `mean ${pixels.mean.toFixed(1)} colours ${pixels.distinctColors}`,
      ].join('\n')
    );
    console.log(`saved          ${shotPath}`);

    return { snapshot: snap, pixels };
  } finally {
    await page.close();
  }
}

/**
 * The behaviours that need a live page rather than a static snapshot: the
 * impact freeze's two timelines, the resolution governor's scaling, the global
 * dust mask, and a runtime tier change.
 */
async function verifyBehaviour(browser: Browser, baseUrl: string): Promise<void> {
  console.log('\n──────── behaviour ────────');
  const { page, errors } = await openTier(browser, baseUrl, 'medium');
  try {
    await waitFrames(page, 4);
    const before = await snapshot(page);

    /* --- impact freeze -------------------------------------------------- */
    // Sample immediately after the event: the freeze holds for 90ms of REAL
    // time, and under SwiftShader a single frame can exceed that, so the
    // measurement is taken synchronously rather than after a frame.
    const frozen = (await page.evaluate(() => {
      const harness = window.__RENDER_HARNESS__;
      if (!harness) return null;
      harness.emitLethalHit();
      const snap = harness.snapshot();
      return {
        timeScale: snap.clock.timeScale,
        fovOffset: snap.impact.fovOffset,
        active: snap.impact.active,
      };
    })) as { timeScale: number; fovOffset: number; active: boolean } | null;

    check(frozen !== null, '[behaviour] harness control surface missing');
    if (frozen) {
      check(frozen.active, '[behaviour] lethal-hit event did not activate the impact freeze');
      check(
        frozen.timeScale < 0.2,
        `[behaviour] impact freeze did not slow the clock (timeScale ${frozen.timeScale})`
      );
      check(
        frozen.fovOffset > 3,
        `[behaviour] impact freeze did not punch the FOV in (offset ${frozen.fovOffset.toFixed(2)} deg)`
      );
      console.log(
        `impact freeze  timeScale ${frozen.timeScale.toFixed(3)}, ` +
          `fov punch ${frozen.fovOffset.toFixed(2)} deg`
      );
    }

    // ...and it must recover on its own. Polling the freeze's own flag beats a
    // fixed wait: `IGameClock.rawDelta` is clamped to `maxDelta` (1/15s), so
    // under SwiftShader — where a frame can take half a second — a 290ms
    // recovery is charged 66ms per frame and needs ~5 frames, not 5 real
    // milliseconds. A timeout here would be flaky by construction.
    await page.waitForFunction(
      () => window.__RENDER_HARNESS__?.isImpactActive() === false,
      undefined,
      { timeout: 120_000 }
    );
    await waitFrames(page, 2);
    const recovered = await snapshot(page);
    check(
      recovered.clock.timeScale > 0.9999,
      `[behaviour] impact freeze never released the clock (timeScale ${recovered.clock.timeScale})`
    );
    check(
      Math.abs(recovered.impact.fovOffset) < 1e-6,
      `[behaviour] camera FOV did not return (offset ${recovered.impact.fovOffset.toFixed(3)})`
    );
    console.log(
      `recovery       timeScale ${recovered.clock.timeScale.toFixed(3)}, ` +
        `fov offset ${recovered.impact.fovOffset.toFixed(3)} deg`
    );

    /* --- resolution governor -------------------------------------------- */
    await page.evaluate(() => window.__RENDER_HARNESS__?.setResolutionScale(0.6));
    await waitFrames(page, 3);
    const scaled = await snapshot(page);
    check(
      Math.abs(scaled.resolutionScale - 0.6) < 1e-6,
      `[behaviour] governor did not take the forced scale (${scaled.resolutionScale})`
    );
    check(
      scaled.drawingBuffer.width < before.drawingBuffer.width,
      `[behaviour] drawing buffer did not shrink at 0.6x ` +
        `(${before.drawingBuffer.width} -> ${scaled.drawingBuffer.width})`
    );
    const expectedWidth = Math.floor(before.drawingBuffer.width * 0.6);
    check(
      Math.abs(scaled.drawingBuffer.width - expectedWidth) <= 2,
      `[behaviour] drawing buffer width ${scaled.drawingBuffer.width} does not match ` +
        `0.6x of ${before.drawingBuffer.width} (expected ~${expectedWidth})`
    );
    console.log(
      `governor       ${before.drawingBuffer.width}x${before.drawingBuffer.height} -> ` +
        `${scaled.drawingBuffer.width}x${scaled.drawingBuffer.height} at scale ` +
        `${scaled.resolutionScale.toFixed(2)}`
    );

    await page.evaluate(() => window.__RENDER_HARNESS__?.setResolutionScale(1));
    await waitFrames(page, 3);

    /* --- global damage/dust mask: a real A/B ---------------------------- */
    // Freezing the camera makes the two frames pixel-comparable, so the test
    // proves the injected uniform CHANGED THE IMAGE rather than merely proving
    // that a second frame also rendered something.
    await page.evaluate(() => window.__RENDER_HARNESS__?.setCameraFrozen(true));
    const cleanShot = path.join(OUT_DIR, 'renderer-dust-off.png');
    const dustShot = path.join(OUT_DIR, 'renderer-dust-mask.png');

    await page.evaluate(() => window.__RENDER_HARNESS__?.setDust(0));
    await waitFrames(page, 3);
    await page.screenshot({ path: cleanShot, type: 'png' });
    const clean = await analyse(cleanShot);

    await page.evaluate(() => window.__RENDER_HARNESS__?.setDust(0.85));
    await waitFrames(page, 3);
    await page.screenshot({ path: dustShot, type: 'png' });
    const dusty = await analyse(dustShot);

    const dustDelta = await meanAbsoluteDifference(cleanShot, dustShot);
    await Promise.all([recompress(cleanShot), recompress(dustShot)]);
    check(
      dusty.stdDev > 10 && dusty.distinctColors > 100,
      `[behaviour] dusty frame looks blank (stdDev ${dusty.stdDev.toFixed(2)}, ` +
        `colours ${dusty.distinctColors})`
    );
    check(
      dustDelta > 4,
      `[behaviour] the global damage/dust mask did not visibly change the frame ` +
        `(mean absolute pixel difference ${dustDelta.toFixed(2)}/255) — the shared ` +
        `uniform is probably not reaching the injected materials`
    );
    console.log(
      `dust mask      mean ${clean.mean.toFixed(1)} -> ${dusty.mean.toFixed(1)}, ` +
        `mean abs pixel delta ${dustDelta.toFixed(2)}/255 (saved ${dustShot})`
    );
    await page.evaluate(() => {
      window.__RENDER_HARNESS__?.setDust(0.06);
      window.__RENDER_HARNESS__?.setCameraFrozen(false);
    });

    /* --- runtime tier change -------------------------------------------- */
    await page.evaluate(() => window.__RENDER_HARNESS__?.setTier('high'));
    await waitFrames(page, 6);
    const switched = await snapshot(page);
    check(
      switched.shadows.cascades === 3,
      `[behaviour] runtime tier change did not rebuild the cascades ` +
        `(${switched.shadows.cascades})`
    );
    check(
      switched.post.mode === 'high',
      `[behaviour] runtime tier change did not rebuild the post chain ` + `(${switched.post.mode})`
    );
    check(switched.drawCalls > 0, '[behaviour] no draw calls after the runtime tier change');
    notes.push(
      `[behaviour] after a live medium->high switch the context holds ` +
        `${switched.programs} programs (both tiers' programs are resident; this is ` +
        `why per-tier counts are measured in separate contexts)`
    );
    console.log(
      `tier switch    medium -> high | cascades ${switched.shadows.cascades} | ` +
        `post ${switched.post.mode} | programs ${before.programs} -> ${switched.programs}`
    );

    check(errors.length === 0, `[behaviour] console errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  console.log('building harness/renderer.html ...');
  await buildHarness();

  const { server, port } = await serve(BUILD_DIR);
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`serving ${BUILD_DIR} at ${baseUrl}`);

  let browser: Browser | undefined;
  const results: Record<string, { snapshot: HarnessSnapshot; pixels: PixelReport }> = {};

  try {
    browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
    for (const tier of ['low', 'medium', 'high']) {
      results[tier] = await verifyTier(browser, baseUrl, tier);
    }
    await verifyBehaviour(browser, baseUrl);
  } finally {
    await browser?.close();
    server.close();
  }

  // Machine-readable evidence alongside the screenshots.
  await writeFile(
    path.join(OUT_DIR, 'renderer-report.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        viewport: VIEWPORT,
        programBudget: PROGRAM_BUDGET,
        tiers: Object.fromEntries(
          Object.entries(results).map(([tier, result]) => [
            tier,
            {
              programs: result.snapshot.programs,
              programsByShader: summarizePrograms(result.snapshot.programKeys),
              drawCalls: result.snapshot.drawCalls,
              triangles: result.snapshot.triangles,
              materials: result.snapshot.materialCount,
              materialSignatures: result.snapshot.materialSignatures,
              warmup: result.snapshot.warmup,
              post: result.snapshot.post,
              shadows: result.snapshot.shadows,
              environment: result.snapshot.environment,
              memory: result.snapshot.memory,
              drawingBuffer: result.snapshot.drawingBuffer,
              screenshot: result.pixels,
            },
          ])
        ),
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
    console.error(`RENDERER VERIFICATION FAILED — ${failures.length} problem(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('RENDERER VERIFICATION PASSED');
}

main().catch((error) => {
  console.error('renderer verification crashed:', error);
  process.exit(1);
});
