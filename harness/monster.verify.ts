/**
 * MONSTER HARNESS VERIFICATION
 *
 * Builds `harness/monster.html` with Vite, serves it, drives it in headless
 * Chromium and screenshots the Boros arena into `docs/screenshots/`.
 *
 * The screenshot is evidence, not the test. The real assertions run inside the
 * page — and crucially, they run against the REAL `HitResolver` from
 * `src/gameplay/combat`, which no unit test inside `src/entities/monster` may
 * import. The boss phase gate is checked in BOTH directions here, and this is
 * the only place in the repository where that is possible.
 *
 * The SwiftShader flags are passed even though the page draws on a 2D canvas,
 * so the harness behaves identically if it is ever given a WebGL view. No
 * frame rate is measured or reported: SwiftShader is CPU software rendering
 * and any number from it would describe the software rasteriser, not the game.
 *
 * Run: `npx tsx harness/monster.verify.ts`
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
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-monster-harness');
const SHOT = path.join(OUT_DIR, 'monster-boss-encounter.png');
const REPORT = path.join(OUT_DIR, 'monster-report.json');

/** 980 px arena plus the 400 px verification column. */
const VIEWPORT = { width: 1424, height: 1012 };

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

interface ICheck {
  readonly group: string;
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

interface IResults {
  readonly checks: ICheck[];
  readonly failures: string[];
  readonly gate: {
    readonly closedHit?: { killed: boolean; phaseGated: boolean; instantKill: boolean };
    readonly openHit?: { killed: boolean; phaseGated: boolean; instantKill: boolean };
    readonly healthWhileGated: number;
    readonly phaseEvents: number;
    readonly punchesAbsorbed: number;
  };
  readonly tiers: readonly {
    tier: string;
    archetypeId: string;
    maxHealth: number;
    killed: boolean;
    instantKill: boolean;
  }[];
  readonly ally: {
    readonly fast: { allyDowned: number; allySurvived: boolean; reachedFinisher: boolean };
    readonly slow: {
      allyDowned: number;
      allySurvived: boolean;
      reachedFinisher: boolean;
      downedAt?: number;
    };
  };
  readonly spawn: {
    readonly orders: number;
    readonly worstRing: number;
    readonly closest: number;
    readonly rejected: number;
    readonly peakConcurrent: number;
  };
  readonly phase: { phaseIndex: number; title: string; phaseResolved: boolean };
}

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
      rollupOptions: { input: { monsterHarness: path.join(ROOT, 'harness', 'monster.html') } },
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
  const raw = await sharp(file).resize(96, 96, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }
  return { stdDev, colours: seen.size };
}

async function main(): Promise<void> {
  const failures: string[] = [];
  await mkdir(OUT_DIR, { recursive: true });

  console.log('building harness bundle...');
  await buildHarness();

  const { server, port } = await serve(BUILD_DIR);
  const url = `http://127.0.0.1:${port}/harness/monster.html`;
  console.log(`serving ${BUILD_DIR} at ${url}`);

  let browser: Browser | undefined;
  let results: IResults | undefined;
  let pixels: { stdDev: number; colours: number } | undefined;

  try {
    browser = await chromium.launch({ args: SWIFTSHADER_ARGS });
    const page: Page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

    const consoleErrors: string[] = [];
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => window.__MONSTER_READY__ === true, undefined, {
      timeout: 180_000,
    });

    results = (await page.evaluate(() =>
      window.__MONSTER_HARNESS__!.results()
    )) as unknown as IResults;

    await page.screenshot({ path: SHOT, type: 'png' });
    pixels = await analyse(SHOT);

    /* ---------------------------- assertions ---------------------------- */
    for (const failure of results.failures) failures.push(failure);

    /* The gate, restated here rather than trusted to the page's own verdict:
       these two lines are the whole workstream. */
    if (results.gate.closedHit?.killed !== false || results.gate.closedHit.phaseGated !== true) {
      failures.push('GATE CLOSED direction failed — a gated boss died to a lethal punch');
    }
    if (results.gate.openHit?.killed !== true || results.gate.openHit.instantKill !== true) {
      failures.push('GATE OPEN direction failed — a resolved boss survived a lethal punch');
    }
    if (results.ally.fast.allyDowned !== 0) {
      failures.push('Deep Sea King FAST branch failed — the ally went down anyway');
    }
    if (results.ally.slow.allyDowned !== 1) {
      failures.push(
        `Deep Sea King SLOW branch failed — AllyDowned fired ${results.ally.slow.allyDowned} times, expected 1`
      );
    }
    if (results.spawn.worstRing > 1) {
      failures.push(`spawn director placed a monster in R${results.spawn.worstRing}`);
    }

    if (pixels.stdDev < 10) failures.push(`screenshot looks flat (stdDev ${pixels.stdDev})`);
    if (pixels.colours < 100) failures.push(`too few colours (${pixels.colours})`);
    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 4).join(' | ')}`);
    }

    await writeFile(
      REPORT,
      `${JSON.stringify({ results, pixels, viewport: VIEWPORT }, null, 2)}\n`,
      'utf8'
    );

    console.log('\n──────── checks ────────');
    for (const check of results.checks) {
      console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  [${check.group}] ${check.name}`);
      console.log(`        ${check.detail}`);
    }
    console.log('\n──────── gate ────────');
    console.log(JSON.stringify(results.gate, null, 2));
    console.log('\n──────── deep sea king ────────');
    console.log(JSON.stringify(results.ally, null, 2));
    console.log('\n──────── spawn ────────');
    console.log(JSON.stringify(results.spawn, null, 2));
    console.log('\n──────── pixels ────────');
    console.log(JSON.stringify(pixels, null, 2));
    console.log(`saved: ${SHOT}`);
    console.log(`saved: ${REPORT}`);
  } finally {
    await browser?.close();
    server.close();
    await rm(BUILD_DIR, { recursive: true, force: true });
  }

  console.log('\n──────── result ────────');
  if (failures.length > 0) {
    console.error('MONSTER HARNESS FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`MONSTER HARNESS PASSED (${results?.checks.length ?? 0} checks)`);
}

main().catch((error) => {
  console.error('monster harness crashed:', error);
  process.exit(1);
});
