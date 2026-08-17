/**
 * HARNESS DRIVER — renders roster.html headlessly and screenshots each mode
 *
 * Runs the character bake if its output is missing, serves the repo through an
 * in-process Vite server (so `@/` aliases resolve exactly as they do in the
 * game), drives headless Chromium over SwiftShader, and writes the frames to
 * `docs/screenshots/`.
 *
 * It does not trust `__HARNESS_READY__`. A WebGL page that throws still
 * "loads" and still screenshots, so every mode publishes its own measurements
 * to `__HARNESS_STATS__`, this driver asserts them, and then reads the pixels
 * back and rejects a frame that is blank, flat, or contains a single magenta
 * missing-texture pixel.
 *
 * Run: `npx tsx harness/roster.shot.ts [--skip-bake]`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const CHR_DIR = path.join(ROOT, 'public', 'assets', 'chr');
const BASIS_SRC = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
const BASIS_DST = path.join(ROOT, 'public', 'assets', 'basis');

/** SwiftShader flags: the CI container has no GPU. */
const CHROME_FLAGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

interface CharacterRow {
  id: string;
  name: string;
  kind: string;
  threat?: string;
  triangles: number;
  height: number;
  drawCalls: number;
  textureBytes: number;
  maps: string[];
  missing: string[];
  features: string;
  aoChannel: number;
}

interface FrameStats {
  distinctColors: number;
  stdDev: number;
  magentaPixels: number;
  meanLuma: number;
}

interface ModeStats {
  mode: string;
  environment: string;
  frame: FrameStats;
  characters?: CharacterRow[];
  sceneCalls?: number;
  sceneTriangles?: number;
  totalTextureBytes?: number;
  metalness?: { high: number; low: number; mean: number; maxRoughSpread: number };
  instances?: number;
  drawCalls?: number;
  distinctPalettes?: number;
  proximityFadeCurve?: number[];
  triangles?: number;
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

const MODES: readonly Mode[] = [
  { name: 'sheet', file: 'roster-contact-sheet.png', width: 1920, height: 840 },
  { name: 'face', file: 'roster-face-saitama.png', width: 1600, height: 900 },
  { name: 'metal', file: 'roster-metal-genos.png', width: 1600, height: 900 },
  { name: 'crowd', file: 'roster-crowd.png', width: 1600, height: 760 },
];

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Run the baker as a child process so its console output is visible. */
async function runBake(): Promise<void> {
  console.log('baking characters (this writes public/assets/chr/, gitignored)…');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'tools/build-characters.ts'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`bake exited ${code}`))));
    child.on('error', reject);
  });
}

/**
 * Put the Basis transcoder somewhere the dev server will serve verbatim.
 *
 * `KTX2Loader` fetches `basis_transcoder.js` and its wasm from a directory at
 * runtime. Importing them through Vite would transform the UMD bundle into an
 * ES module and break it, so they are copied into the gitignored
 * `public/assets/` tree and requested by absolute path.
 */
async function stageTranscoder(): Promise<void> {
  await mkdir(BASIS_DST, { recursive: true });
  for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
    await copyFile(path.join(BASIS_SRC, file), path.join(BASIS_DST, file));
  }
}

async function main(): Promise<void> {
  const skipBake = process.argv.includes('--skip-bake');
  const baked = await exists(path.join(CHR_DIR, 'saitama', 'albedo.high.png'));
  if (!baked && !skipBake) await runBake();
  else if (!baked) throw new Error('no baked characters; run tools/build-characters.ts first');

  await stageTranscoder();

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

      const target = new URL('harness/roster.html', url);
      target.searchParams.set('mode', mode.name);
      await page.goto(target.href, { waitUntil: 'load', timeout: 180_000 });
      await page.waitForFunction(() => window.__HARNESS_READY__ === true, undefined, {
        timeout: 240_000,
      });

      const pageError = await page.evaluate(() => window.__HARNESS_ERROR__);
      if (pageError !== undefined) throw new Error(`harness (${mode.name}) threw:\n${pageError}`);

      const stats = (await page.evaluate(() => window.__HARNESS_STATS__)) as ModeStats;
      collected[mode.name] = stats;

      assertCommon(mode.name, stats);
      if (mode.name === 'sheet') assertSheet(stats);
      if (mode.name === 'metal') assertMetal(stats);
      if (mode.name === 'crowd') assertCrowd(stats);

      const out = path.join(OUT_DIR, mode.file);
      await writeFile(out, await page.screenshot({ type: 'png' }));
      check(consoleErrors.length === 0, `${mode.name}: no console errors`);
      if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 6).join('\n'));
      console.log(`  screenshot -> ${path.relative(ROOT, out)}`);
      await page.close();
    }

    await writeFile(
      path.join(OUT_DIR, 'roster-report.json'),
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
  console.log('\nroster harness PASS');
}

function assertCommon(name: string, stats: ModeStats): void {
  check(
    stats.environment.startsWith('hdri'),
    `${name}: lit by the real CC0 HDRI (${stats.environment})`
  );
  check(
    stats.frame.distinctColors > 100,
    `${name}: real content (${stats.frame.distinctColors} colours)`
  );
  check(
    stats.frame.stdDev > 10,
    `${name}: not a flat fill (stdDev ${stats.frame.stdDev.toFixed(1)})`
  );
  check(
    stats.frame.magentaPixels === 0,
    `${name}: no missing-texture magenta (${stats.frame.magentaPixels} px)`
  );

  for (const row of stats.characters ?? []) {
    check(row.missing.length === 0, `${name}: ${row.id} binds every required map`);
    check(row.drawCalls <= 1, `${name}: ${row.id} renders in ${row.drawCalls} draw call`);
    check(row.aoChannel === 0, `${name}: ${row.id} reads AO from UV0`);
    check(row.maps.includes('map'), `${name}: ${row.id} has a base-colour map`);
  }
}

function assertSheet(stats: ModeStats): void {
  const rows = stats.characters ?? [];
  check(rows.length >= 14, `${rows.length} characters in the cast`);
  check(
    rows.some((row) => row.id === 'chr.saitama'),
    'Saitama present'
  );
  const tiers = new Set(rows.map((row) => row.threat).filter(Boolean));
  check(tiers.size === 5, `all five threat tiers represented (${[...tiers].join(', ')})`);
  const monsters = rows.filter((row) => row.kind === 'monster');
  check(monsters.length >= 9, `${monsters.length} monsters`);
  const tallest = rows.reduce((max, row) => Math.max(max, row.height), 0);
  const shortest = rows.reduce((min, row) => Math.min(min, row.height), 99);
  check(
    tallest > 3 && shortest < 1.6,
    `silhouette range ${shortest.toFixed(2)}–${tallest.toFixed(2)} m`
  );
  const budget = rows.every((row) => row.triangles <= 4000);
  check(budget, 'every character fits the 4000-triangle LOD0 budget');
  const mb = (stats.totalTextureBytes ?? 0) / 1048576;
  check(mb > 0, `${mb.toFixed(1)} MB of character textures resident (high tier, uncompressed)`);
}

function assertMetal(stats: ModeStats): void {
  const metal = stats.metalness;
  if (metal === undefined) {
    failures.push('metal: no ORM histogram');
    return;
  }
  check(
    metal.high > 0.02,
    `${(metal.high * 100).toFixed(1)}% of Genos' atlas is fully metallic (metalness > 0.78)`
  );
  check(
    metal.low > 0.2,
    `${(metal.low * 100).toFixed(1)}% is fully dielectric — metal did not leak everywhere`
  );
  check(
    metal.maxRoughSpread > 0.05,
    `roughness varies by ${(metal.maxRoughSpread * 100).toFixed(0)}% across the metal, ` +
      'so the highlight breaks up instead of sliding'
  );
}

function assertCrowd(stats: ModeStats): void {
  check(stats.instances === 220, `${stats.instances} civilians instanced`);
  check(
    (stats.drawCalls ?? 99) <= 4,
    `${stats.drawCalls} draw calls for ${stats.instances} civilians plus the ground`
  );
  check(
    (stats.distinctPalettes ?? 0) > 150,
    `${stats.distinctPalettes} distinct wardrobes — the crowd is not clones`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
