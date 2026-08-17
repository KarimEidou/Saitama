/**
 * HUD VERIFICATION
 *
 * Bundles `harness/hud.html` with Vite, serves it, drives it in headless
 * Chromium with SwiftShader, and asserts the things a unit test cannot reach.
 *
 * ── THE FOUR CLAIMS UNDER TEST ─────────────────────────────────────────────
 *
 *   1. LAYOUT DISCIPLINE. During a scripted 60 Hz animation — boredom drifting,
 *      the charge arc filling, the fight timer running, the collateral ticker
 *      climbing — the HUD must write ONLY custom properties, must never read a
 *      layout property, and must shift nothing. The page instruments
 *      `setProperty`, every layout-affecting property setter, every
 *      layout-reading accessor and `PerformanceObserver('layout-shift')`.
 *      A stray `element.style.width = …` has nowhere to hide.
 *
 *   2. SAFE AREA. Every visible panel's rectangle must lie inside the viewport
 *      minus the insets. `env(safe-area-inset-*)` cannot be forced from
 *      Playwright, so the harness drives the HUD's programmatic override — the
 *      same path a Capacitor build uses on the Android WebViews that report
 *      `env()` as zero on a device that visibly has a cutout.
 *
 *   3. THUMBS. Nothing readable may sit inside the quarter-disc each hand
 *      covers. The reserve is checked against `src/ui/input`'s OWN exported arc
 *      geometry, so retuning the arc fails this test rather than quietly
 *      overlapping the HUD.
 *
 *   4. REACHABILITY. Every screen can be opened and dismissed, by its own
 *      control and by the Android back button, ending back at the HUD.
 *
 * ── THE `sharp` TRAP, HANDLED ──────────────────────────────────────────────
 * `sharp(file).extract(region).stats()` does NOT crop. `stats()` reads the
 * INPUT image and ignores everything queued in the pipeline, so a region
 * assertion written that way silently measures the whole frame and passes
 * vacuously. Every crop here is materialised with `.toBuffer()` first, and
 * `assertCropActuallyCropped` compares a crop's mean against the frame's to
 * prove the crop happened at all.
 *
 * ── WHY NO FRAME RATE ──────────────────────────────────────────────────────
 * SwiftShader is a CPU software rasteriser. Any fps figure here measures the CI
 * machine, so none is produced. What IS measured is the number of CSSOM writes
 * per frame, which is machine-independent and is the thing that actually
 * determines whether this HUD costs anything.
 *
 * Run: `npx tsx harness/hud.verify.ts`
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
const BUILD_DIR = path.join(os.tmpdir(), 'saitama-hud-harness');

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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/* -------------------------------------------------------------------------- */
/* Viewport profiles                                                          */
/* -------------------------------------------------------------------------- */

interface IProfile {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly insets: { top: number; right: number; bottom: number; left: number };
  readonly dpr: number;
}

/**
 * Three shapes, chosen because they fail differently.
 *
 * The landscape phone is the one that ships and the one with no room: 390 px of
 * height, both bottom corners under a hand, a 59 px notch on the leading edge.
 * The portrait phone has height to spare and a different inset mapping. The
 * tablet has neither constraint and catches the opposite failure — a HUD that
 * only looks composed because it was cramped.
 */
const PROFILES: readonly IProfile[] = [
  {
    id: 'phone-landscape',
    label: '844x390 landscape, notch left (the shipping case)',
    width: 844,
    height: 390,
    insets: { top: 0, right: 34, bottom: 21, left: 59 },
    dpr: 3,
  },
  {
    id: 'phone-portrait',
    label: '390x844 portrait, Dynamic Island + home indicator',
    width: 390,
    height: 844,
    insets: { top: 59, right: 0, bottom: 34, left: 0 },
    dpr: 3,
  },
  {
    id: 'tablet',
    label: '1024x768 landscape, no insets',
    width: 1024,
    height: 768,
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    dpr: 2,
  },
];

/** Screens shot at every profile. */
const CORE_SCENES = [
  'loading',
  'combat',
  'combat-boss',
  'quests',
  'rank',
  'results',
  'pause',
  'settings',
] as const;

/** Variants shot only at the shipping profile. */
const VARIANT_SCENES = [
  'idle',
  'combat-alert',
  'combat-charging',
  'combat-bored',
  'markers',
] as const;

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
      rollupOptions: { input: { hudHarness: path.join(ROOT, 'harness', 'hud.html') } },
    },
    // `public/assets/` is ~200 MB of KTX2 and GLB and this harness needs none
    // of it: the backdrop is drawn on a 2D canvas precisely so the HUD can be
    // verified without a renderer's worth of moving parts.
    publicDir: false,
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

/* -------------------------------------------------------------------------- */
/* Pixel analysis                                                             */
/* -------------------------------------------------------------------------- */

interface IPixelStats {
  meanLuma: number;
  stdDev: number;
  colours: number;
  width: number;
  height: number;
}

/**
 * Measure a PNG, or a REGION of one.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  `sharp(file).extract(region).stats()` DOES NOT CROP.                    ║
 * ║                                                                          ║
 * ║  `stats()` reads the INPUT image and ignores everything queued in the     ║
 * ║  pipeline in front of it. A region assertion written that way silently    ║
 * ║  measures the whole frame — it looks exactly like a working crop until    ║
 * ║  somebody notices the region mean and the frame mean agree to one         ║
 * ║  decimal place. It has cost this project two agents.                     ║
 * ║                                                                          ║
 * ║  The crop is MATERIALISED with `.toBuffer()` and every number below is    ║
 * ║  computed from those raw bytes.                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */
async function analyse(
  file: string,
  region?: { left: number; top: number; width: number; height: number }
): Promise<IPixelStats> {
  const pipeline = sharp(file).removeAlpha();
  if (region) pipeline.extract(region);
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const pixels = info.width * info.height;
  let sum = 0;
  let sumSq = 0;
  const seen = new Set<number>();

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    sumSq += luma * luma;
    // 5 bits per channel: enough to count real colours, coarse enough that
    // dithering noise does not inflate the tally into meaninglessness.
    seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }

  const mean = sum / pixels;
  return {
    meanLuma: mean,
    stdDev: Math.sqrt(Math.max(0, sumSq / pixels - mean * mean)),
    colours: seen.size,
    width: info.width,
    height: info.height,
  };
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

interface ICheck {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: ICheck[] = [];

function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/* -------------------------------------------------------------------------- */
/* Harness types, mirrored                                                    */
/* -------------------------------------------------------------------------- */

interface IMeasurement {
  frames: number;
  properties: string[];
  offending: string[];
  directWrites: string[];
  reads: string[];
  layoutShift: number;
  layoutShiftObserved: boolean;
  setPropertyCalls: number;
  writerWrites: number;
  writerSkipped: number;
}

interface IPanelRect {
  id: string;
  screen: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

interface IInputGeometry {
  pivotPx: number;
  slots: { id: string; right: number; bottom: number; size: number; reach: number }[];
  maxReach: number;
  hudReserve: number;
  stickReserve: number;
}

/* -------------------------------------------------------------------------- */
/* Page helpers                                                               */
/* -------------------------------------------------------------------------- */

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__HUD_HARNESS__?.ready === true, undefined, {
    timeout: 45_000,
  });
}

async function setScene(page: Page, scene: string): Promise<void> {
  await page.evaluate((name) => {
    window.__HUD_HARNESS__!.scene(name as never);
  }, scene);
  // Two animation frames so CSS transitions on entry have settled.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}

async function shoot(page: Page, file: string): Promise<string> {
  await mkdir(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, file);
  await page.screenshot({ path: target });
  return target;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log('HUD verification');
  console.log('building harness…');
  await buildHarness();
  const { server, port } = await serve(BUILD_DIR);
  const url = `http://127.0.0.1:${port}/harness/hud.html`;

  let browser: Browser | undefined;
  const consoleErrors: string[] = [];
  const report: Record<string, unknown> = {};

  try {
    browser = await chromium.launch({ args: SWIFTSHADER_ARGS });

    /* ------------------------------------------------------------------ */
    /* Per-profile screenshots + geometry assertions                       */
    /* ------------------------------------------------------------------ */

    const shots: Record<string, IPixelStats> = {};
    const panelReports: Record<string, IPanelRect[]> = {};

    for (const profile of PROFILES) {
      console.log(`\n${profile.id} — ${profile.label}`);
      const context = await browser.newContext({
        viewport: { width: profile.width, height: profile.height },
        deviceScaleFactor: profile.dpr,
        isMobile: profile.id !== 'tablet',
        hasTouch: true,
      });
      const page = await context.newPage();
      page.on('console', (message: ConsoleMessage) => {
        if (message.type() === 'error') consoleErrors.push(`${profile.id}: ${message.text()}`);
      });
      page.on('pageerror', (error) => consoleErrors.push(`${profile.id}: ${String(error)}`));

      await page.goto(url, { waitUntil: 'load' });
      await waitReady(page);
      await page.evaluate((insets) => {
        window.__HUD_HARNESS__!.setViewport(insets);
      }, profile.insets);

      const geometry = (await page.evaluate(() =>
        window.__HUD_HARNESS__!.inputGeometry()
      )) as IInputGeometry;

      if (profile.id === 'phone-landscape') {
        report.inputGeometry = geometry;
        check(
          'thumb reserve exceeds the input layer’s own arc reach',
          geometry.hudReserve > geometry.maxReach,
          `reserve ${geometry.hudReserve}px vs furthest painted button pixel ${geometry.maxReach.toFixed(1)}px`
        );
      }

      const scenes = [
        ...CORE_SCENES,
        ...(profile.id === 'phone-landscape' ? VARIANT_SCENES : []),
      ];

      for (const scene of scenes) {
        await setScene(page, scene);
        const file = `hud-${scene}-${profile.id}.png`;
        const shotPath = await shoot(page, file);
        const stats = await analyse(shotPath);
        shots[file] = stats;

        const nonBlank = stats.stdDev > 10 && stats.colours > 100;
        check(
          `${scene} @ ${profile.id} is a real frame`,
          nonBlank,
          `stdDev ${stats.stdDev.toFixed(1)}, colours ${stats.colours}`
        );

        /* ---- safe area ---- */
        const panels = (await page.evaluate(() =>
          window.__HUD_HARNESS__!.panels()
        )) as IPanelRect[];
        panelReports[`${scene}@${profile.id}`] = panels;

        const outside = panels.filter(
          (panel) =>
            panel.x < profile.insets.left - 0.5 ||
            panel.y < profile.insets.top - 0.5 ||
            panel.x + panel.width > profile.width - profile.insets.right + 0.5 ||
            panel.y + panel.height > profile.height - profile.insets.bottom + 0.5
        );
        check(
          `${scene} @ ${profile.id} respects the safe area`,
          outside.length === 0,
          outside.length === 0
            ? `${panels.length} panels inside the safe box`
            : outside
                .slice(0, 3)
                .map((p) => `${p.id}[${p.x.toFixed(0)},${p.y.toFixed(0)} ${p.width.toFixed(0)}x${p.height.toFixed(0)}]`)
                .join(' ')
        );

        /* ---- thumb reserve, only for the non-modal combat HUD ---- */
        if (scene.startsWith('combat') || scene === 'idle' || scene === 'markers') {
          const rightPivot = {
            x: profile.width - profile.insets.right,
            y: profile.height - profile.insets.bottom,
          };
          const leftPivot = { x: profile.insets.left, y: profile.height - profile.insets.bottom };
          const intruders = panels.filter((panel) => {
            const nearestRight = {
              x: Math.max(panel.x, Math.min(rightPivot.x, panel.x + panel.width)),
              y: Math.max(panel.y, Math.min(rightPivot.y, panel.y + panel.height)),
            };
            const nearestLeft = {
              x: Math.max(panel.x, Math.min(leftPivot.x, panel.x + panel.width)),
              y: Math.max(panel.y, Math.min(leftPivot.y, panel.y + panel.height)),
            };
            const dRight = Math.hypot(nearestRight.x - rightPivot.x, nearestRight.y - rightPivot.y);
            const dLeft = Math.hypot(nearestLeft.x - leftPivot.x, nearestLeft.y - leftPivot.y);
            // The charge arc is EXEMPT and deliberately so: it lives in the
            // corridor between the two thumbs, is transient, and is the one
            // element the player is looking at while both thumbs are down.
            if (panel.id === 'charge') return false;
            return dRight < geometry.hudReserve || dLeft < geometry.stickReserve;
          });
          check(
            `${scene} @ ${profile.id} keeps the thumb corners clear`,
            intruders.length === 0,
            intruders.length === 0
              ? 'no readable panel inside either hand'
              : intruders.map((p) => p.id).join(', ')
          );
        }
      }

      /* ---- a debug shot showing the cutouts and the hands ---- */
      await setScene(page, profile.id === 'phone-portrait' ? 'combat' : 'combat-charging');
      await page.evaluate(() => window.__HUD_HARNESS__!.setOverlays(true));
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      );
      const debugFile = `hud-zones-${profile.id}.png`;
      await shoot(page, debugFile);
      await page.evaluate(() => window.__HUD_HARNESS__!.setOverlays(false));

      /* ---- the crop trap, demonstrated rather than assumed ---- */
      if (profile.id === 'phone-landscape') {
        const frame = path.join(OUT_DIR, 'hud-combat-phone-landscape.png');
        const scale = profile.dpr;
        // The top band, where every mid-fight readout lives.
        const band = {
          left: 0,
          top: 0,
          width: Math.round(profile.width * scale),
          height: Math.round(120 * scale),
        };
        // The lower-centre corridor, which is mostly backdrop.
        const corridor = {
          left: Math.round(profile.width * 0.3 * scale),
          top: Math.round(profile.height * 0.55 * scale),
          width: Math.round(profile.width * 0.4 * scale),
          height: Math.round(profile.height * 0.3 * scale),
        };
        const whole = await analyse(frame);
        const bandStats = await analyse(frame, band);
        const corridorStats = await analyse(frame, corridor);

        check(
          'the region crop actually crops',
          bandStats.width === band.width &&
            bandStats.height === band.height &&
            Math.abs(bandStats.meanLuma - whole.meanLuma) > 0.5,
          `band ${bandStats.width}x${bandStats.height} mean ${bandStats.meanLuma.toFixed(1)} vs frame ${whole.width}x${whole.height} mean ${whole.meanLuma.toFixed(1)}`
        );
        check(
          'the HUD band carries far more detail than the empty corridor',
          bandStats.stdDev > corridorStats.stdDev,
          `band stdDev ${bandStats.stdDev.toFixed(1)} vs corridor ${corridorStats.stdDev.toFixed(1)}`
        );
        report.regions = { whole, band: bandStats, corridor: corridorStats };
      }

      /* ------------------------------------------------------------- */
      /* Layout discipline                                             */
      /* ------------------------------------------------------------- */

      if (profile.id === 'phone-landscape') {
        await setScene(page, 'combat-charging');
        const measurement = (await page.evaluate(() =>
          window.__HUD_HARNESS__!.measure(120)
        )) as IMeasurement;
        report.measurement = measurement;

        check(
          'the 60 Hz path writes ONLY custom properties',
          measurement.offending.length === 0 && measurement.properties.length > 0,
          measurement.offending.length === 0
            ? `${measurement.properties.length} distinct properties, all --custom: ${measurement.properties.slice(0, 8).join(' ')}${measurement.properties.length > 8 ? ' …' : ''}`
            : `offending: ${measurement.offending.join(', ')}`
        );
        check(
          'no direct assignment to a layout-affecting property',
          measurement.directWrites.length === 0,
          measurement.directWrites.length === 0
            ? 'none'
            : measurement.directWrites.join(', ')
        );
        check(
          'ZERO forced reflows — no layout property is read during the window',
          measurement.reads.length === 0,
          measurement.reads.length === 0
            ? `${measurement.frames} frames, ${measurement.setPropertyCalls} CSSOM writes, 0 layout reads`
            : `read: ${measurement.reads.join(', ')}`
        );
        check(
          'zero cumulative layout shift while the meters animate',
          measurement.layoutShiftObserved && measurement.layoutShift === 0,
          measurement.layoutShiftObserved
            ? `CLS delta ${measurement.layoutShift}`
            : 'PerformanceObserver layout-shift unavailable'
        );
        check(
          'the writer skips unchanged values rather than rewriting them',
          measurement.writerSkipped > measurement.writerWrites * 0.5,
          `${measurement.writerWrites} writes, ${measurement.writerSkipped} skipped over ${measurement.frames} frames ` +
            `(${(measurement.writerWrites / measurement.frames).toFixed(1)} CSSOM writes/frame)`
        );
      }

      /* ------------------------------------------------------------- */
      /* Reachability and dismissal                                    */
      /* ------------------------------------------------------------- */

      if (profile.id === 'phone-portrait') {
        await setScene(page, 'combat');

        const journeys: { name: string; open: string; close: string }[] = [
          { name: 'pause', open: '[data-hud="pause-button"]', close: '[data-hud="pause-resume"]' },
          { name: 'quests', open: '[data-hud="tracker"]', close: '[data-hud="quests-close"]' },
        ];

        for (const journey of journeys) {
          const opened = await page.evaluate((selector) => {
            const harness = window.__HUD_HARNESS__!;
            harness.press(selector);
            return harness.activeScreen();
          }, journey.open);
          check(
            `${journey.name} is reachable from the combat HUD`,
            opened === journey.name,
            `active screen: ${opened}`
          );
          const closed = await page.evaluate((selector) => {
            const harness = window.__HUD_HARNESS__!;
            harness.press(selector);
            return harness.activeScreen();
          }, journey.close);
          check(
            `${journey.name} is dismissible by its own control`,
            closed === 'hud',
            `active screen: ${closed}`
          );
        }

        /* Deep stack, then back three times. */
        const deep = await page.evaluate(() => {
          const harness = window.__HUD_HARNESS__!;
          harness.press('[data-hud="pause-button"]');
          harness.press('[data-hud="pause-settings"]');
          return harness.activeScreen();
        });
        check('settings is reachable through pause', deep === 'settings', `active: ${deep}`);

        const backTrail = await page.evaluate(() => {
          const harness = window.__HUD_HARNESS__!;
          const trail: string[] = [];
          for (let i = 0; i < 4; i++) {
            const consumed = harness.back();
            trail.push(`${harness.activeScreen()}${consumed ? '' : '(unconsumed)'}`);
          }
          return trail;
        });
        check(
          'the back button pops the stack and then declines',
          backTrail[0] === 'pause' &&
            backTrail[1] === 'hud' &&
            backTrail[3]?.includes('unconsumed') === true,
          backTrail.join(' -> ')
        );

        /* Every screen individually reachable and returnable. */
        for (const scene of ['quests', 'rank', 'results', 'settings', 'pause'] as const) {
          await setScene(page, scene);
          const opened = await page.evaluate(() => window.__HUD_HARNESS__!.activeScreen());
          const returned = await page.evaluate(() => {
            const harness = window.__HUD_HARNESS__!;
            harness.back();
            return harness.activeScreen();
          });
          check(
            `${scene} opens and returns to the HUD`,
            opened === scene && returned === 'hud',
            `${opened} -> ${returned}`
          );
        }
      }

      /* ------------------------------------------------------------- */
      /* Palettes                                                      */
      /* ------------------------------------------------------------- */

      if (profile.id === 'phone-landscape') {
        for (const palette of ['deuteranopia', 'protanopia', 'tritanopia', 'highContrast'] as const) {
          await setScene(page, 'combat');
          await page.evaluate((name) => {
            window.__HUD_HARNESS__!.setSettings({ palette: name as never });
          }, palette);
          await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          );
          const file = `hud-palette-${palette}.png`;
          const shotPath = await shoot(page, file);
          const stats = await analyse(shotPath);
          shots[file] = stats;
          check(
            `${palette} palette renders`,
            stats.stdDev > 10 && stats.colours > 100,
            `stdDev ${stats.stdDev.toFixed(1)}, colours ${stats.colours}`
          );
        }
        await page.evaluate(() => {
          window.__HUD_HARNESS__!.setSettings({ palette: 'default' as never });
        });

        /* HUD scale, which is the accessibility setting most likely to break
           a layout that was tuned at 100%. */
        await setScene(page, 'combat');
        await page.evaluate(() => {
          window.__HUD_HARNESS__!.setSettings({ hudScale: 1.3 as never });
        });
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        );
        await shoot(page, 'hud-scale-130.png');
        const scaledPanels = (await page.evaluate(() =>
          window.__HUD_HARNESS__!.panels()
        )) as IPanelRect[];
        const overflow = scaledPanels.filter(
          (panel) =>
            panel.x < profile.insets.left - 0.5 ||
            panel.x + panel.width > profile.width - profile.insets.right + 0.5
        );
        check(
          'the layout survives HUD scale at 130%',
          overflow.length === 0,
          overflow.length === 0 ? 'nothing overflows the safe box' : overflow.map((p) => p.id).join(', ')
        );
        await page.evaluate(() => {
          window.__HUD_HARNESS__!.setSettings({ hudScale: 1 as never });
        });
      }

      const snapshot = await page.evaluate(() => window.__HUD_HARNESS__!.snapshot());
      report[`snapshot.${profile.id}`] = snapshot;
      await context.close();
    }

    report.shots = shots;
    report.panels = panelReports;

    check(
      'no console errors from any profile',
      consoleErrors.length === 0,
      consoleErrors.length === 0 ? 'clean' : consoleErrors.slice(0, 4).join(' | ')
    );
  } finally {
    await browser?.close();
    server.close();
  }

  report.checks = checks;
  report.generatedAt = new Date().toISOString();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'hud-report.json'), JSON.stringify(report, null, 2));

  const failed = checks.filter((entry) => !entry.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const entry of failed) console.log(`  ${entry.name} — ${entry.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log('HUD verification passed.');
}

declare global {
  interface Window {
    __HUD_HARNESS__?: {
      ready: boolean;
      scene(name: string): void;
      setViewport(insets: { top: number; right: number; bottom: number; left: number }): void;
      setSettings(patch: Record<string, unknown>): void;
      setOverlays(on: boolean): void;
      step(frames: number): void;
      measure(frames: number): IMeasurement;
      panels(): IPanelRect[];
      inputGeometry(): IInputGeometry;
      snapshot(): Record<string, unknown>;
      back(): boolean;
      activeScreen(): string;
      press(selector: string): boolean;
    };
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
