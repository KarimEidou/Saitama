/**
 * AUTOMATED BUILD VERIFICATION
 *
 * Serves the production build, launches headless Chromium with SwiftShader,
 * waits for the game to signal readiness, and proves a real frame rendered.
 *
 * The last point is the one that matters: a WebGL page that throws still
 * "loads" successfully and still screenshots. So this harness does not trust
 * `__GAME_READY__` alone — it reads the pixels back and rejects a frame that
 * is blank, uniform, or a flat black fill. That is the difference between
 * verifying the toolchain and merely verifying that a server responded.
 *
 * Run: `npm run verify`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { IGameDiagnostics } from '../src/types/engine.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'verification');
const SCREENSHOT = path.join(OUT_DIR, 'task01-bootstrap.png');
/** Committed evidence copy — the only directory the binary guard allows. */
const DOCS_SHOT = path.join(ROOT, 'docs', 'screenshots', 'task01-bootstrap.png');

const VIEWPORT = { width: 900, height: 1600 }; // portrait, phone-like

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

/** Minimal static file server over `dist/`. No dependency on a CLI tool. */
function serveDist(): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let filePath = path.join(DIST, decodeURIComponent(url.pathname));
      if (url.pathname === '/' || url.pathname === '') filePath = path.join(DIST, 'index.html');
      // Contain path traversal.
      if (!filePath.startsWith(DIST)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500).end(String(error));
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

interface PixelReport {
  readonly width: number;
  readonly height: number;
  /** Mean per-channel standard deviation across the image. */
  readonly stdDev: number;
  /** Mean channel brightness 0..255. */
  readonly mean: number;
  /** Distinct colours sampled on a coarse grid. */
  readonly distinctColors: number;
  readonly isBlank: boolean;
}

/**
 * Analyse the screenshot. A correctly rendered 3D scene has meaningful
 * variance; a black or single-colour frame does not.
 */
async function analyseScreenshot(file: string): Promise<PixelReport> {
  const image = sharp(file);
  const meta = await image.metadata();
  const stats = await image.stats();

  // Consider only colour channels (drop alpha, which is uniformly opaque).
  const colorChannels = stats.channels.slice(0, 3);
  const stdDev = colorChannels.reduce((sum, c) => sum + c.stdev, 0) / colorChannels.length;
  const mean = colorChannels.reduce((sum, c) => sum + c.mean, 0) / colorChannels.length;

  // Count distinct colours on a downsampled grid — catches a uniform fill that
  // still has slight compression noise.
  const raw = await sharp(file).resize(64, 64, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }

  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    stdDev,
    mean,
    distinctColors: seen.size,
    // Blank means: essentially no variance AND almost no distinct colours.
    isBlank: stdDev < 1.5 || seen.size < 8,
  };
}

async function main(): Promise<void> {
  const failures: string[] = [];

  if (!existsSync(DIST)) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(path.dirname(DOCS_SHOT), { recursive: true });

  const { server, port } = await serveDist();
  const url = `http://127.0.0.1:${port}/`;
  console.log(`serving dist/ at ${url}`);

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      args: [
        // Software GL: there is no physical GPU in this environment.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });

    const page: Page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });

    // Wait for a frame to have actually presented.
    await page.waitForFunction(() => window.__GAME_READY__ === true, undefined, {
      timeout: 60_000,
    });
    console.log('__GAME_READY__ = true');

    // Let the animation advance so the frame is unambiguously live.
    await page.waitForTimeout(1200);

    const diag = (await page.evaluate(
      () => window.__GAME_DIAG__ ?? null
    )) as IGameDiagnostics | null;

    if (!diag) {
      failures.push('window.__GAME_DIAG__ was not populated');
    }

    await page.screenshot({ path: SCREENSHOT, type: 'png' });
    const pixels = await analyseScreenshot(SCREENSHOT);
    await writeFile(DOCS_SHOT, await readFile(SCREENSHOT));

    /* ---------------------------- assertions ---------------------------- */
    if (pixels.isBlank) {
      failures.push(
        `screenshot looks blank (stdDev=${pixels.stdDev.toFixed(2)}, ` +
          `distinctColors=${pixels.distinctColors})`
      );
    }
    if (diag && !diag.isWebGL2) failures.push('WebGL2 context was not obtained');
    if (diag && diag.drawCalls < 1) failures.push(`no draw calls issued (${diag.drawCalls})`);
    if (diag && diag.triangles < 100)
      failures.push(`suspiciously few triangles (${diag.triangles})`);
    if (diag && diag.frameCount < 2) failures.push(`too few frames rendered (${diag.frameCount})`);
    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
    }

    /* ------------------------------ report ------------------------------ */
    console.log('\n──────── __GAME_DIAG__ ────────');
    console.log(JSON.stringify(diag, null, 2));
    console.log('\n──────── screenshot ────────');
    console.log(JSON.stringify(pixels, null, 2));
    console.log(`saved: ${SCREENSHOT}`);
    console.log(`evidence copy: ${DOCS_SHOT}`);
  } finally {
    await browser?.close();
    server.close();
  }

  console.log('\n──────── result ────────');
  if (failures.length > 0) {
    console.error('VERIFICATION FAILED:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('VERIFICATION PASSED');
}

main().catch((error) => {
  console.error('verification crashed:', error);
  process.exit(1);
});
