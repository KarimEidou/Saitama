/**
 * HUD VERIFICATION
 *
 * Bundles `harness/hud.html` with Vite, serves it, drives it in headless
 * Chromium with SwiftShader, and asserts the things a unit test cannot reach.
 *
 * ── THE CLAIMS UNDER TEST ──────────────────────────────────────────────────
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
 *   5. NOTHING PAINTS ON ANYTHING ELSE. No two panels in a scene share more
 *      than a rounding error's worth of area. This is the claim whose absence
 *      let a threat banner sit on top of the encounter card through every gate
 *      this project has: safe-area containment and thumb clearance are both
 *      satisfied by two panels stacked on the same pixels.
 *
 *   6. THE BAND FITS. Nothing in the top half reaches down into a hand, at
 *      100% HUD scale and at 130% — the scale where a font fallback grows a row
 *      past the height it was designed for.
 *
 *   7. THE CONTROLS OWN THE TOUCH. Every point on the arc and in the stick
 *      band hit-tests into `.opm-input-root`. A stick that is drawn right and
 *      hit-tested by a stray HUD layer looks perfect in a screenshot.
 *
 *   8. MOUNT PARITY. The controls mount where `src/game/game.ts` mounts them
 *      and stack where the shipping page stacks them, so these screenshots are
 *      frames the game can actually produce.
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
  uninstrumentedReads: string[];
  layoutShift: number;
  layoutShiftObserved: boolean;
  setPropertyCalls: number;
  writerWrites: number;
  writerSkipped: number;
}

interface IPanelRect {
  id: string;
  kind: 'panel' | 'marker';
  screen: string;
  /** DOM index chain relative to `.hud-root`. See `harness/hud.ts`. */
  path: string;
  /** A modal screen is painting over this box. */
  occluded: boolean;
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

interface IHitSample {
  label: string;
  x: number;
  y: number;
  owner: string;
}

interface IHitOwnership {
  zone: { x: number; y: number; width: number; height: number };
  sampled: number;
  stolen: IHitSample[];
}

interface IMountParity {
  inputParent: string;
  parentIsBody: boolean;
  siblings: boolean;
  inputZIndex: number;
  uiZIndex: number;
  probe: string[];
  hudAbove: boolean;
}

interface IBandBudget {
  declared: number | null;
  declaredRaw: string;
  gap: number;
  rowOneBottom: number | null;
  insetTop: number;
  members: string[];
}

/* -------------------------------------------------------------------------- */
/* Panel geometry                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How much area two panels may share before it is an overlap, in px².
 *
 * Not zero. Rects come back at sub-pixel precision on a dpr-3 viewport, and two
 * panels laid out edge to edge can share a hairline of a few hundredths of a
 * pixel without a single pixel of ink landing twice. Four square pixels is
 * below the area of one dpr-1 pixel of genuine double-painting and far above
 * any rounding artefact; the real failures this catches are three and four
 * orders of magnitude larger.
 */
const OVERLAP_TOLERANCE_PX2 = 4;

/**
 * Pairs of panel ids allowed to overlap.
 *
 * EMPTY, and it stays empty until somebody can write down why a pair of
 * readable boxes is allowed to share pixels. Every entry is a hole in claim 5,
 * so every entry needs a comment saying what the pair is and why the overlap is
 * intended — "it fails and I do not want to fix the layout" is not a reason.
 */
const OVERLAP_ALLOWED: readonly (readonly [string, string])[] = [];

interface IOverlap {
  a: IPanelRect;
  b: IPanelRect;
  area: number;
}

/**
 * Is `ancestor` a DOM ancestor of (or the same node as) `descendant`?
 *
 * Compared SEGMENT-WISE and never with `startsWith`: `"0/1"` is a string prefix
 * of `"0/11"` and those are siblings, not relatives. That one shortcut would
 * silently excuse a real overlap every time a container happened to have more
 * than ten children.
 */
function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // The empty path is `.hud-root` itself, which is an ancestor of everything.
  if (ancestor === '') return true;
  const a = ancestor.split('/');
  const d = descendant.split('/');
  if (a.length > d.length) return false;
  return a.every((segment, index) => segment === d[index]);
}

/** Does `outer` fully contain `inner`, allowing for sub-pixel rounding? */
function rectContains(outer: IPanelRect, inner: IPanelRect): boolean {
  const slack = 0.5;
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

/**
 * Every pair of panels sharing more than a rounding error, worst first.
 *
 * ── THE TWO WAYS THIS CHECK FIRES ON ITSELF ────────────────────────────────
 *
 *   THE SAME BOX, TWICE. `panels()` matches an alert as both its
 *   `[data-hud="alerts"]` container and its `.hud-alert` child, with rects that
 *   agree to the pixel. Reported naively that is a 19 530 px² "overlap" of the
 *   alert layer with itself, sitting at the top of the list above the real
 *   failure. A box CONTAINED IN A DOM ANCESTOR is therefore dropped before the
 *   pairs are formed: anything it overlaps, its ancestor overlaps by at least
 *   as much, so detection loses nothing and the surviving report names the
 *   outer box, which is the one a human recognises.
 *
 *   Containment alone is NOT enough to drop a box — it has to be containment by
 *   an ANCESTOR. Dropping any box contained in any other box would delete the
 *   card that a banner has completely covered, i.e. the worst overlap there is,
 *   and the check would report nothing at all.
 *
 *   WORLD-SPACE PINS. Markers are projected, not laid out: two objectives
 *   behind one another on screen legitimately produce overlapping pins, and no
 *   HUD change can prevent it without detaching a pin from the thing it points
 *   at. They are excluded for the same reason the thumb assertion excludes
 *   them.
 *
 * Panels a modal screen is covering are excluded too — see `IPanelRect`.
 */
function findOverlaps(panels: readonly IPanelRect[]): IOverlap[] {
  const boxes = panels.filter((panel) => panel.kind !== 'marker' && !panel.occluded);
  const distinct = boxes.filter(
    (box, index) =>
      !boxes.some(
        (other, otherIndex) =>
          otherIndex !== index && isAncestorPath(other.path, box.path) && rectContains(other, box)
      )
  );

  const found: IOverlap[] = [];
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      const a = distinct[i]!;
      const b = distinct[j]!;
      // A descendant that OVERFLOWS its ancestor survived the filter above; it
      // still is not painting on a second panel, it is painting on its own box.
      if (isAncestorPath(a.path, b.path) || isAncestorPath(b.path, a.path)) continue;
      if (
        OVERLAP_ALLOWED.some(
          ([one, two]) => (one === a.id && two === b.id) || (one === b.id && two === a.id)
        )
      ) {
        continue;
      }
      const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (width <= 0 || height <= 0) continue;
      const area = width * height;
      if (area <= OVERLAP_TOLERANCE_PX2) continue;
      found.push({ a, b, area });
    }
  }
  return found.sort((left, right) => right.area - left.area);
}

function describeRect(panel: IPanelRect): string {
  return `${panel.id}[${panel.x.toFixed(0)},${panel.y.toFixed(0)} ${panel.width.toFixed(0)}x${panel.height.toFixed(0)}]`;
}

function describeOverlaps(overlaps: readonly IOverlap[]): string {
  const shown = overlaps
    .slice(0, 6)
    .map((o) => `${describeRect(o.a)} × ${describeRect(o.b)} = ${o.area.toFixed(0)}px²`)
    .join('; ');
  return overlaps.length > 6 ? `${shown}; +${overlaps.length - 6} more` : shown;
}

/**
 * Panels that start in the top half and reach down into a hand.
 *
 * The thumb assertion measures a quarter-DISC struck from each bottom corner,
 * which is the shape of a hand. This measures the BAND below the reserve, which
 * is the shape of the constraint the top-band layout is built on: `styles.ts`
 * puts the whole combat HUD in the top band because on a 390 px-tall landscape
 * viewport the bottom reserve is more than half the screen. A panel that starts
 * up in the band and then grows down through that line has stopped being a
 * top-band panel, and it does that long before its corner enters either disc.
 */
function bandIntruders(
  panels: readonly IPanelRect[],
  profile: IProfile,
  reserve: number
): IPanelRect[] {
  const floor = profile.height - profile.insets.bottom - reserve;
  return panels.filter(
    (panel) =>
      panel.kind !== 'marker' &&
      !panel.occluded &&
      panel.y < profile.height / 2 &&
      panel.y + panel.height > floor + 0.5
  );
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
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
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
    // Only the STOLEN probes are kept. A passing grid is thousands of points
    // that all say the same thing; a failing one is a short list of coordinates
    // somebody has to go and look at.
    const hitReports: Record<string, string[]> = {};

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

        /* ---- mount parity ---- */
        // Needs a scene with a HUD button in it: the empirical half of the
        // check reads the hit-test chain at one, and the boot screen has none.
        await setScene(page, 'combat');
        const parity = (await page.evaluate(() =>
          window.__HUD_HARNESS__!.mountParity()
        )) as IMountParity;
        report.mountParity = parity;

        check(
          'the controls mount on document.body, where `game.ts` mounts them',
          parity.parentIsBody && parity.siblings,
          `.opm-input-root parent: ${parity.inputParent}, sibling of #ui-root: ${parity.siblings}`
        );
        check(
          'the HUD paints ABOVE the controls, as it does in the shipping page',
          parity.hudAbove && parity.uiZIndex > parity.inputZIndex,
          parity.hudAbove
            ? `#ui-root z-index ${parity.uiZIndex} over .opm-input-root z-index ${parity.inputZIndex}`
            : // The inverse order is what shipped in every screenshot in
              // docs/screenshots/ for as long as the overlay was mounted inside
              // #ui-root, so name the chain rather than just failing.
              `hit-test chain at a HUD button, topmost first: ${parity.probe.join(' > ')}`
        );
      }

      const scenes = [...CORE_SCENES, ...(profile.id === 'phone-landscape' ? VARIANT_SCENES : [])];

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
            : outside.slice(0, 3).map(describeRect).join(' ')
        );

        /* ---- panel vs panel ---- */
        // Runs in EVERY scene, modal included: two rows colliding inside a
        // settings sheet is the same bug as a banner landing on the encounter
        // card, and the sheet is where a font fallback shows up first.
        const overlaps = findOverlaps(panels);
        check(
          `${scene} @ ${profile.id} has no panel painting on another`,
          overlaps.length === 0,
          overlaps.length === 0
            ? `${panels.length} panels, no pair sharing more than ${OVERLAP_TOLERANCE_PX2}px²`
            : describeOverlaps(overlaps)
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
            // World-space markers are exempt for a different reason: they are
            // not LAID OUT. A pin's position is a world point projected through
            // the camera, so the only way to keep one out of a thumb quadrant
            // is to detach it from the thing it points at. THUMB_RESERVE_PX
            // scopes its claim to HUD chrome, and this assertion has to scope
            // itself the same way or it is unsatisfiable by any HUD change.
            if (panel.kind === 'marker') return false;
            return dRight < geometry.hudReserve || dLeft < geometry.stickReserve;
          });
          check(
            `${scene} @ ${profile.id} keeps the thumb corners clear`,
            intruders.length === 0,
            intruders.length === 0
              ? 'no readable panel inside either hand'
              : intruders.map((p) => p.id).join(', ')
          );

          /* ---- the top band fits above both hands ---- */
          // The reserve is whichever hand claims more, read from the tokens
          // through the input layer rather than copied: retuning either one
          // moves this line with it.
          const reserve = Math.max(geometry.hudReserve, geometry.stickReserve);
          const reaching = bandIntruders(panels, profile, reserve);
          check(
            `${scene} @ ${profile.id} keeps the top band above the hands`,
            reaching.length === 0,
            reaching.length === 0
              ? `nothing above the halfway line reaches past y=${(profile.height - profile.insets.bottom - reserve).toFixed(0)}`
              : reaching
                  .map(
                    (p) =>
                      `${describeRect(p)} reaches y=${(p.y + p.height).toFixed(0)}, ` +
                      `${(p.y + p.height - (profile.height - profile.insets.bottom - reserve)).toFixed(0)}px into the reserve`
                  )
                  .join('; ')
          );

          /* ---- the declared band budget ---- */
          const budget = (await page.evaluate(() =>
            window.__HUD_HARNESS__!.bandBudget()
          )) as IBandBudget;
          if (budget.declared === null) {
            // Skipped, loudly. A budget assertion against a budget nobody has
            // declared would be an assertion against a number this file made
            // up, which is worse than no assertion at all.
            console.log(
              `  [skip] ${scene} @ ${profile.id} band budget — .hud-root declares no --hud-band-row` +
                (budget.declaredRaw === '' ? '' : ` (unparseable: "${budget.declaredRaw}")`)
            );
          } else if (budget.rowOneBottom === null) {
            console.log(
              `  [skip] ${scene} @ ${profile.id} band budget — the top band is not laid out`
            );
          } else {
            const used = budget.rowOneBottom - budget.insetTop;
            check(
              `${scene} @ ${profile.id} row 1 fits its declared budget`,
              used <= budget.declared + budget.gap + 0.5,
              `row 1 runs ${used.toFixed(1)}px from the top inset against a ${budget.declared}px budget ` +
                `+ ${budget.gap}px gap (${budget.members.join(', ')})`
            );
          }

          /* ---- who owns the touch ---- */
          // Both hands, though today neither value moves anything.
          // `IHudSettings.stickHand` exists and the settings screen writes it,
          // and nothing carries it across to the input layer: the settings
          // bridge in `game.ts` forwards look sensitivity, invert, haptics and
          // the stick LAYOUT, and not the hand. So the swept band is the same
          // one whichever value is set, and it is left that way ON PURPOSE — a
          // harness that forwarded the setting itself would be asserting a
          // behaviour the game does not have. The loop stays because the day
          // that bridge learns the field, the mirrored layout is already
          // covered rather than needing to be remembered.
          const stolen: string[] = [];
          let sampled = 0;
          for (const hand of ['left', 'right'] as const) {
            await page.evaluate((value) => {
              window.__HUD_HARNESS__!.setSettings({ stickHand: value as never });
            }, hand);
            const ownership = (await page.evaluate(() =>
              window.__HUD_HARNESS__!.hitOwnership()
            )) as IHitOwnership;
            sampled += ownership.sampled;
            for (const sample of ownership.stolen) {
              stolen.push(`${hand}/${sample.label}@${sample.x},${sample.y} -> ${sample.owner}`);
            }
          }
          await page.evaluate(() => {
            window.__HUD_HARNESS__!.setSettings({ stickHand: 'left' as never });
          });

          if (stolen.length > 0) hitReports[`${scene}@${profile.id}`] = stolen;
          check(
            `${scene} @ ${profile.id} lets the controls own every touch they need`,
            stolen.length === 0,
            stolen.length === 0
              ? `${sampled} probes across the arc and the stick band, all into .opm-input-root`
              : stolen.slice(0, 4).join('; ') +
                  (stolen.length > 4 ? `; +${stolen.length - 4} more` : '')
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
          measurement.directWrites.length === 0 ? 'none' : measurement.directWrites.join(', ')
        );
        check(
          'ZERO forced reflows — no layout property is read during the window',
          measurement.reads.length === 0 && measurement.uninstrumentedReads.length === 0,
          measurement.uninstrumentedReads.length > 0
            ? // A probe that cannot see an accessor reports zero reads of it,
              // which is indistinguishable from a pass. Fail loudly instead.
              `the probe could not instrument ${measurement.uninstrumentedReads.join(', ')} — ` +
                `a read of those would go unreported`
            : measurement.reads.length === 0
              ? `${measurement.frames} frames, ${measurement.setPropertyCalls} CSSOM writes, 0 layout reads, every watched accessor instrumented`
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
        for (const palette of [
          'deuteranopia',
          'protanopia',
          'tritanopia',
          'highContrast',
        ] as const) {
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
          overflow.length === 0
            ? 'nothing overflows the safe box'
            : overflow.map((p) => p.id).join(', ')
        );

        /* The VERTICAL half of the same question, and the half that actually
           bites: 130% is where a row that was tuned to the pixel at 100% grows
           past the band and starts down towards a hand. Horizontal overflow is
           caught by a `min-width:0` grid column; height has nothing catching
           it, which is exactly why it needs an assertion. */
        const scaledReserve = Math.max(geometry.hudReserve, geometry.stickReserve);
        const scaledReaching = bandIntruders(scaledPanels, profile, scaledReserve);
        check(
          'the top band still clears the hands at HUD scale 130%',
          scaledReaching.length === 0,
          scaledReaching.length === 0
            ? `nothing above the halfway line reaches past y=${(profile.height - profile.insets.bottom - scaledReserve).toFixed(0)}`
            : scaledReaching
                .map((p) => `${describeRect(p)} reaches y=${(p.y + p.height).toFixed(0)}`)
                .join('; ')
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
    report.stolenTouches = hitReports;

    check(
      'no console errors from any profile',
      consoleErrors.length === 0,
      consoleErrors.length === 0 ? 'clean' : consoleErrors.slice(0, 4).join(' | ')
    );
  } finally {
    await browser?.close();
    server.close();
    // Nothing outside this block reads BUILD_DIR — the reports and screenshots
    // all go to OUT_DIR — so the Vite tree in os.tmpdir() is pure residue.
    await rm(BUILD_DIR, { recursive: true, force: true });
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

/* `window.__HUD_HARNESS__` is declared once, by the page that installs it
   (`harness/hud.ts`). Both files are in the tsconfig program, so the global
   reaches the `page.evaluate` callbacks above from there. Mirroring the shape
   here as well is what let the two copies drift apart. */

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
