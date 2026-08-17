/**
 * HARNESS DRIVER — renders anim.html headlessly and screenshots each mode
 *
 * Runs a Vite dev server in-process (so `@/` aliases and TypeScript resolve
 * exactly as they do in the game), drives headless Chromium over SwiftShader,
 * and writes the frames to `docs/screenshots/`.
 *
 * It does not trust `__HARNESS_READY__`: a WebGL page that throws still
 * "loads" and still screenshots. Each mode publishes its own measurements to
 * `__HARNESS_STATS__`, this driver asserts them, and then reads the pixels
 * back and rejects a frame that is blank or a flat fill.
 *
 * Run: `npx tsx harness/anim.shot.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');

/** SwiftShader flags: the CI container has no GPU. */
const CHROME_FLAGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

interface WalkStats {
  mode: 'walk';
  phases: number;
  speed: number;
  cadence: number;
  strideLength: number;
  duty: number;
  maxContactDrift: number;
  maxFlatDrift: number;
  naiveContactDrift: number;
  reachDrop: number;
  stanceCounts: number[];
}

interface ClipsStats {
  mode: 'clips';
  clipCells: number;
  gaitCells: number;
  bodies: { name: string; height: number; legLength: number; cadence: number; stride: number }[];
  distinctPoses: number;
}

interface CrowdStats {
  mode: 'crowd';
  instances: number;
  drawCalls: number;
  triangles: number;
  textureBytes: number;
  textureSize: [number, number];
  quantisationMax: number;
  temporalMax: number;
  distinctOffsets: number;
  cpuReferences: number;
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
  { name: 'walk', file: 'anim-walk-cycle.png', width: 1840, height: 1080 },
  { name: 'clips', file: 'anim-clips.png', width: 1840, height: 1180 },
  { name: 'crowd', file: 'anim-vat-crowd.png', width: 1680, height: 920 },
];

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
      const page = await browser.newPage({
        viewport: { width: mode.width, height: mode.height },
      });
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('pageerror', (error) => consoleErrors.push(error.message));

      const target = new URL('harness/anim.html', url);
      target.searchParams.set('mode', mode.name);
      await page.goto(target.href, { waitUntil: 'load', timeout: 120_000 });
      await page.waitForFunction(() => window.__HARNESS_READY__ === true, undefined, {
        timeout: 120_000,
      });

      const pageError = await page.evaluate(() => window.__HARNESS_ERROR__);
      if (pageError !== undefined) throw new Error(`harness (${mode.name}) threw:\n${pageError}`);

      const stats = (await page.evaluate(() => window.__HARNESS_STATS__)) as
        | WalkStats
        | ClipsStats
        | CrowdStats;
      collected[mode.name] = stats;

      if (stats.mode === 'walk') assertWalk(stats);
      else if (stats.mode === 'clips') assertClips(stats);
      else assertCrowd(stats);

      const out = path.join(OUT_DIR, mode.file);
      const buffer = await page.screenshot({ type: 'png' });
      await writeFile(out, buffer);

      const variance = await page.evaluate(() => {
        const canvas = document.getElementById('view') as HTMLCanvasElement;
        const scratch = document.createElement('canvas');
        scratch.width = 128;
        scratch.height = 96;
        const context = scratch.getContext('2d');
        if (context === null) return { distinct: 0, stdDev: 0 };
        context.drawImage(canvas, 0, 0, 128, 96);
        const data = context.getImageData(0, 0, 128, 96).data;
        const colors = new Set<number>();
        let sum = 0;
        let sumSq = 0;
        for (let i = 0; i < data.length; i += 4) {
          colors.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
          const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
          sum += luma;
          sumSq += luma * luma;
        }
        const n = data.length / 4;
        const mean = sum / n;
        return { distinct: colors.size, stdDev: Math.sqrt(sumSq / n - mean * mean) };
      });
      check(variance.distinct > 100, `${mode.name}: real content (${variance.distinct} colours)`);
      check(
        variance.stdDev > 10,
        `${mode.name}: not a flat fill (stdDev ${variance.stdDev.toFixed(1)})`
      );
      check(consoleErrors.length === 0, `${mode.name}: no console errors`);
      if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5).join('\n'));

      console.log(`  screenshot -> ${path.relative(ROOT, out)}`);
      await page.close();
    }

    await writeFile(
      path.join(OUT_DIR, 'anim-report.json'),
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
  console.log('\nanim harness PASS');
}

function assertWalk(stats: WalkStats): void {
  check(stats.phases === 8, `8 walk phases rendered (got ${stats.phases})`);
  const spm = stats.cadence * 120;
  check(spm > 105 && spm < 135, `cadence ${spm.toFixed(0)} steps/min is human`);
  check(
    stats.strideLength > 1.2 && stats.strideLength < 1.55,
    `stride ${stats.strideLength.toFixed(2)} m is human`
  );
  check(
    stats.duty > 0.55 && stats.duty < 0.68,
    `duty ${(stats.duty * 100).toFixed(0)}% leaves a double-support phase`
  );
  check(
    stats.maxContactDrift < 0.0005,
    `planted contact drift ${(stats.maxContactDrift * 1000).toFixed(3)} mm per stance`
  );
  check(
    stats.maxFlatDrift < 0.0005,
    `flat-foot drift ${(stats.maxFlatDrift * 1000).toFixed(3)} mm per stance`
  );
  check(
    stats.naiveContactDrift > stats.maxContactDrift * 100,
    `naive control slides ${(stats.naiveContactDrift * 1000).toFixed(0)} mm — ` +
      `${Math.round(stats.naiveContactDrift / Math.max(1e-9, stats.maxContactDrift))}x worse`
  );
  check(
    stats.reachDrop < 0.06,
    `pelvis reach drop ${(stats.reachDrop * 1000).toFixed(0)} mm is a dip, not a crouch`
  );
  // Walking always has at least one foot down, and has two down some of the
  // time. A phase set with neither property is not a walk.
  check(
    stats.stanceCounts.every((n) => n >= 1),
    'never both feet airborne during a walk'
  );
  check(stats.stanceCounts.some((n) => n === 2), 'double support present');
  check(stats.stanceCounts.some((n) => n === 1), 'single support present');
}

function assertClips(stats: ClipsStats): void {
  check(stats.clipCells >= 16, `${stats.clipCells} clip poses rendered`);
  check(
    stats.distinctPoses === stats.clipCells,
    `all ${stats.clipCells} poses are distinct (got ${stats.distinctPoses})`
  );
  check(stats.bodies.length === 5, `${stats.bodies.length} body types side by side`);
  const child = stats.bodies.find((b) => b.name === 'Child');
  const monster = stats.bodies.find((b) => b.name === 'Monster humanoid');
  if (child === undefined || monster === undefined) {
    failures.push('child and monster bodies missing from the strip');
    return;
  }
  check(
    child.height < 1.3 && monster.height > 2.4,
    `proportion range ${child.height.toFixed(2)}–${monster.height.toFixed(2)} m`
  );
  check(
    child.cadence > monster.cadence * 1.3,
    `child steps ${(child.cadence / monster.cadence).toFixed(2)}x faster than the monster`
  );
  check(
    monster.stride > child.stride * 2,
    `monster stride ${monster.stride.toFixed(2)} m vs child ${child.stride.toFixed(2)} m`
  );
}

function assertCrowd(stats: CrowdStats): void {
  check(stats.instances === 250, `${stats.instances} civilians instanced`);
  // The whole point: one InstancedMesh for the crowd plus a floor plus three
  // CPU-skinned references. Anything near 250 would mean instancing failed.
  check(
    stats.drawCalls <= 8,
    `${stats.drawCalls} draw calls for ${stats.instances} characters + ${stats.cpuReferences} references`
  );
  check(stats.triangles > 50_000, `${(stats.triangles / 1000).toFixed(0)}k triangles drawn`);
  check(
    stats.textureBytes < 200 * 1024,
    `palette ${(stats.textureBytes / 1024).toFixed(1)} KB (${stats.textureSize.join('x')})`
  );
  check(
    stats.quantisationMax < 0.0015,
    `half-float round trip ${(stats.quantisationMax * 1000).toFixed(3)} mm per vertex`
  );
  check(
    stats.temporalMax < 0.05,
    `32-frame temporal error ${(stats.temporalMax * 1000).toFixed(1)} mm peak`
  );
  check(
    stats.distinctOffsets > 240,
    `${stats.distinctOffsets} distinct time offsets — the crowd is not marching`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
