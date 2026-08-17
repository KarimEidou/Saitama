/**
 * BROWSER HARNESS FOR THE RENDER TESTS
 *
 * Node has no Web Audio implementation, so the only way to render this
 * synthesiser is inside a real browser. This bundles `offline-probe.ts` with
 * Vite, loads it into headless Chromium via Playwright, runs every probe
 * through `OfflineAudioContext`, and brings the measurements back.
 *
 * Why this rather than a Web Audio mock: a mock would test the mock. The
 * numbers asserted in `render.test.ts` come out of the same DSP engine that
 * runs on the player's device, executing the same graph, at the same sample
 * rate. The clock is the only difference.
 *
 * The browser is launched ONCE per test file and every probe is rendered in a
 * single page evaluation, which keeps the whole suite to a few tens of
 * seconds.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium, type Browser } from 'playwright';
import type { IProbeMetrics } from '../testing/offline-probe';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../../..');
const SRC_ROOT = path.resolve(HERE, '../..');
const PROBE_ENTRY = path.resolve(HERE, '../testing/probe-entry.ts');

/** Everything one harness run produces. */
export interface IProbeSuite {
  /** Every probe, rendered through the full master chain. */
  readonly all: readonly IProbeMetrics[];
  /** Every voice again with the limiter and clipper bypassed. */
  readonly raw: readonly IProbeMetrics[];
  /** Lookup by probe name. */
  get(name: string): IProbeMetrics;
  /** Lookup in the limiter-bypassed set. */
  getRaw(name: string): IProbeMetrics;
  readonly bundleBytes: number;
  readonly renderMs: number;
}

let cached: Promise<IProbeSuite> | undefined;

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
        name: '__AUDIO_PROBE_BUNDLE__',
        fileName: () => 'audio-probe.js',
      },
    },
  })) as unknown as
    | { output: { type: string; code?: string }[] }[]
    | { output: { type: string; code?: string }[] };

  const output = Array.isArray(result) ? result[0]!.output : result.output;
  const chunk = output.find((o) => o.type === 'chunk' && typeof o.code === 'string');
  if (!chunk?.code) throw new Error('audio probe bundle produced no chunk');
  return chunk.code;
}

/** Render every probe. Cached: the whole suite shares one browser run. */
export function renderProbeSuite(): Promise<IProbeSuite> {
  cached ??= run();
  return cached;
}

async function run(): Promise<IProbeSuite> {
  const code = await bundleProbe();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      // Required in a container: no user namespaces, small /dev/shm.
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: code });

    const started = Date.now();
    const data = await page.evaluate(async () => {
      const probe = (
        globalThis as unknown as {
          __AUDIO_PROBE__: {
            renderAllProbes: () => Promise<unknown[]>;
            renderRawVoiceProbes: () => Promise<unknown[]>;
          };
        }
      ).__AUDIO_PROBE__;
      const all = await probe.renderAllProbes();
      const raw = await probe.renderRawVoiceProbes();
      return { all, raw };
    });
    const renderMs = Date.now() - started;
    if (pageErrors.length > 0) {
      throw new Error(`audio probe page errors: ${pageErrors.join('; ')}`);
    }

    const all = data.all as IProbeMetrics[];
    const raw = data.raw as IProbeMetrics[];
    const byName = new Map(all.map((m) => [m.name, m]));
    const rawByName = new Map(raw.map((m) => [m.name, m]));

    return {
      all,
      raw,
      bundleBytes: code.length,
      renderMs,
      get(name: string): IProbeMetrics {
        const m = byName.get(name);
        if (!m) throw new Error(`no probe named "${name}" (have ${all.length})`);
        return m;
      },
      getRaw(name: string): IProbeMetrics {
        const m = rawByName.get(name);
        if (!m) throw new Error(`no raw probe named "${name}"`);
        return m;
      },
    };
  } finally {
    await browser?.close();
  }
}

/** Decode the base64 Int16 mono PCM a probe shipped back. */
export function decodePcm(base64: string): Float32Array {
  const binary = Buffer.from(base64, 'base64');
  const samples = binary.byteLength >> 1;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = binary.readInt16LE(i * 2) / 32767;
  }
  return out;
}
