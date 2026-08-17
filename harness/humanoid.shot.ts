/**
 * HARNESS DRIVER — renders humanoid.html headlessly and screenshots it
 *
 * Runs a Vite dev server in-process (so `@/` aliases and TypeScript resolve
 * exactly as they do in the game), drives headless Chromium over SwiftShader,
 * and writes the frame to `docs/screenshots/`.
 *
 * It does not trust `__HARNESS_READY__`: a WebGL page that throws still
 * "loads" and still screenshots. The page publishes its own measurements to
 * `__HARNESS_STATS__` and this driver asserts them, then reads the pixels back
 * and rejects a frame that is blank or a flat fill. Passing means the numbers
 * held AND something was genuinely drawn.
 *
 * Run: `npx tsx harness/humanoid.shot.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots', 'humanoid-mesh.png');

/** SwiftShader flags: the CI container has no GPU. */
const CHROME_FLAGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

interface CharacterStat {
  name: string;
  triangles: number;
  vertices: number;
  components: number;
  watertight: boolean;
  degenerate: number;
  maxWeightError: number;
  outOfRange: number;
  height: number;
}

interface HarnessStats {
  perCharacter: CharacterStat[];
  lodTriangles: number[];
  minSilhouetteDistance: number;
  minSilhouettePair: string;
  allWatertight: boolean;
  allSkinned: boolean;
}

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${message}`);
}

async function main(): Promise<void> {
  let server: ViteDevServer | undefined;
  const browser = await chromium.launch({ args: CHROME_FLAGS });

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

    const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));

    await page.goto(new URL('harness/humanoid.html', url).href, {
      waitUntil: 'load',
      timeout: 90_000,
    });
    await page.waitForFunction(() => window.__HARNESS_READY__ === true, undefined, {
      timeout: 90_000,
    });

    const pageError = await page.evaluate(() => window.__HARNESS_ERROR__);
    if (pageError !== undefined) throw new Error(`harness threw:\n${pageError}`);

    const stats = (await page.evaluate(() => window.__HARNESS_STATS__)) as HarnessStats;

    console.log('\nharness assertions');
    check(stats.perCharacter.length === 7, `7 bodies rendered (got ${stats.perCharacter.length})`);
    check(stats.allWatertight, 'every body watertight and non-degenerate');
    check(stats.allSkinned, 'every body has normalised, in-range skin weights');

    const maxTris = Math.max(...stats.perCharacter.map((c) => c.triangles));
    check(maxTris <= 4000, `LOD0 max ${maxTris} tris within the 4000 budget`);
    check(
      stats.lodTriangles[1]! <= 1600,
      `LOD1 ${stats.lodTriangles[1]} tris near the ~1.2k target`
    );
    check(stats.lodTriangles[2]! <= 560, `LOD2 ${stats.lodTriangles[2]} tris near the ~400 target`);
    check(
      stats.minSilhouetteDistance > 0.015,
      `silhouettes measurably distinct (closest pair ${stats.minSilhouetteDistance.toFixed(4)} — ` +
        `${stats.minSilhouettePair})`
    );
    check(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
    if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5).join('\n'));

    await mkdir(path.dirname(OUT), { recursive: true });
    const buffer = await page.screenshot({ type: 'png' });
    await writeFile(OUT, buffer);

    // Pixel sanity: a page that failed to draw still screenshots cleanly.
    const variance = await page.evaluate(() => {
      const canvas = document.getElementById('view') as HTMLCanvasElement;
      const scratch = document.createElement('canvas');
      scratch.width = 96;
      scratch.height = 64;
      const context = scratch.getContext('2d');
      if (context === null) return { distinct: 0, stdDev: 0 };
      context.drawImage(canvas, 0, 0, 96, 64);
      const data = context.getImageData(0, 0, 96, 64).data;
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
    check(variance.distinct > 300, `frame has real content (${variance.distinct} distinct colours)`);
    check(variance.stdDev > 8, `frame is not a flat fill (stdDev ${variance.stdDev.toFixed(1)})`);

    console.log(`\nper-character:`);
    for (const c of stats.perCharacter) {
      console.log(
        `  ${c.name.padEnd(18)} ${String(c.triangles).padStart(5)} tris  ` +
          `${String(c.vertices).padStart(5)} verts  ${String(c.components).padStart(3)} shells  ` +
          `h=${c.height.toFixed(3)}m  wErr=${c.maxWeightError.toExponential(1)}`
      );
    }
    console.log(`\nscreenshot -> ${path.relative(ROOT, OUT)}`);
  } finally {
    await browser.close();
    await server?.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} harness assertion(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\nhumanoid harness PASS');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
