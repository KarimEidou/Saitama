/**
 * BROWSER HARNESS FOR THE OVERLAY TESTS
 *
 * The overlay's whole job is to make a layout engine put a ring somewhere, and
 * Node has no layout engine. Vitest here runs in the `node` environment with
 * neither jsdom nor happy-dom in the tree — and even with one, a DOM shim would
 * be testing the shim: jsdom returns a zeroed `getBoundingClientRect()` for
 * everything, resolves no `calc()`, and evaluates no `env()`, which between
 * them are the three things these assertions are about.
 *
 * So: bundle the probe with Vite, load it into headless Chromium via Playwright,
 * and measure. Same pattern, and the same reasoning, as
 * `src/audio/__tests__/browser-harness.ts`, which renders the synthesiser in a
 * real `OfflineAudioContext` for the same reason. It is why CI installs
 * Chromium, so the second use of it is nearly free.
 *
 * The browser is launched ONCE per test file and every scenario runs in the
 * same page, so the whole thing costs a few seconds.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium, type Browser, type Page } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../../../..');
const SRC_ROOT = path.resolve(HERE, '../../..');
const PROBE_ENTRY = path.resolve(HERE, 'overlay-probe.ts');

/** A page with the probe installed. Drive it with `page.evaluate`. */
export interface IOverlaySession {
  readonly page: Page;
  setViewport(width: number, height: number): Promise<void>;
  close(): Promise<void>;
}

/** Bundle the probe entry into a single self-contained IIFE. */
async function bundleProbe(): Promise<string> {
  const result = (await build({
    root: PROJECT_ROOT,
    // The project config is for the game bundle; a lib build needs its own.
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@': SRC_ROOT } },
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: {
        entry: PROBE_ENTRY,
        formats: ['iife'],
        name: '__OVERLAY_PROBE_BUNDLE__',
        fileName: () => 'overlay-probe.js',
      },
    },
  })) as unknown as
    { output: { type: string; code?: string }[] }[] | { output: { type: string; code?: string }[] };

  const output = Array.isArray(result) ? result[0]!.output : result.output;
  const chunk = output.find((o) => o.type === 'chunk' && typeof o.code === 'string');
  if (!chunk?.code) throw new Error('overlay probe bundle produced no chunk');
  return chunk.code;
}

let cached: Promise<IOverlaySession> | undefined;

/** Open the shared session. Cached: the whole file shares one browser. */
export function openOverlaySession(): Promise<IOverlaySession> {
  cached ??= open();
  return cached;
}

async function open(): Promise<IOverlaySession> {
  const code = await bundleProbe();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      // Required in a container: no user namespaces, small /dev/shm.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // `viewport-fit=cover` is what makes `env(safe-area-inset-*)` meaningful at
    // all; without it the overlay's inset expressions never see a notch even
    // when the platform reports one.
    await page.setContent(
      '<!doctype html><html><head><meta name="viewport" ' +
        'content="width=device-width,initial-scale=1,viewport-fit=cover">' +
        '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;' +
        'background:#070a10}</style></head><body></body></html>'
    );
    await page.addScriptTag({ content: code });
    if (pageErrors.length > 0) {
      throw new Error(`overlay probe page errors: ${pageErrors.join('; ')}`);
    }

    const owned = browser;
    return {
      page,
      async setViewport(width: number, height: number): Promise<void> {
        await page.setViewportSize({ width, height });
      },
      async close(): Promise<void> {
        await owned.close();
      },
    };
  } catch (error) {
    await browser?.close();
    throw error;
  }
}
