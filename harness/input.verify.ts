/**
 * INPUT VERIFICATION — real touch events, real browser, real assertions.
 *
 * Serves the repo through Vite, opens `harness/input.html` in headless
 * Chromium, and drives it with SYNTHESISED HARDWARE TOUCH EVENTS via
 * `Input.dispatchTouchEvent` over CDP. Playwright's own `page.touchscreen`
 * only does single-finger taps, and this system's entire reason for existing
 * is what happens when three fingers are down at once — so the touch stream is
 * built by hand.
 *
 * CDP touch conventions, established empirically against this Chromium build:
 *   touchStart  — pass EVERY currently-active point, including the new one.
 *                 Points already present do not re-fire `pointerdown`.
 *   touchMove   — pass every active point, with updated positions.
 *   touchEnd    — pass the points that are ENDING (not the survivors).
 *   touchCancel — must pass an EMPTY array; cancels every active point.
 *                 There is no per-point cancel in CDP; single-pointer cancel
 *                 is covered by the unit tests via `TouchCore.cancelPointer`.
 *
 * Run: `npx tsx harness/input.verify.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createServer, type ViteDevServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const VIEWPORT = { width: 1024, height: 640 }; // landscape phone / tablet

/* -------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* -------------------------------------------------------------------------- */

const failures: string[] = [];
const passes: string[] = [];
let scenario = '';

function group(name: string): void {
  scenario = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 62 - name.length))}`);
}

function ok(label: string, detail = ''): void {
  passes.push(`${scenario}: ${label}`);
  console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
}

function fail(label: string, detail: string): void {
  failures.push(`${scenario}: ${label} — ${detail}`);
  console.log(`  FAIL  ${label}  ${detail}`);
}

function check(condition: boolean, label: string, detail = ''): void {
  if (condition) ok(label, detail);
  else fail(label, detail || 'condition was false');
}

function close(actual: number, expected: number, tolerance: number, label: string): void {
  const delta = Math.abs(actual - expected);
  if (delta <= tolerance) ok(label, `${actual.toFixed(4)} ~= ${expected} (+/-${tolerance})`);
  else fail(label, `expected ${expected} +/-${tolerance}, got ${actual.toFixed(4)}`);
}

/* -------------------------------------------------------------------------- */
/* Multi-touch driver                                                         */
/* -------------------------------------------------------------------------- */

interface TouchPoint {
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
  force: number;
  id: number;
}

class MultiTouch {
  private readonly active = new Map<number, TouchPoint>();

  constructor(private readonly cdp: CDPSession) {}

  private point(id: number, x: number, y: number): TouchPoint {
    return { x, y, radiusX: 3, radiusY: 3, force: 1, id };
  }

  private all(): TouchPoint[] {
    return [...this.active.values()];
  }

  async down(id: number, x: number, y: number): Promise<void> {
    this.active.set(id, this.point(id, x, y));
    await this.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: this.all(),
    });
  }

  async moveTo(id: number, x: number, y: number): Promise<void> {
    if (!this.active.has(id)) throw new Error(`touch ${id} is not down`);
    this.active.set(id, this.point(id, x, y));
    await this.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: this.all(),
    });
  }

  /** Interpolated drag, so the browser sees a plausible gesture. */
  async dragTo(id: number, x: number, y: number, steps = 6): Promise<void> {
    const from = this.active.get(id);
    if (!from) throw new Error(`touch ${id} is not down`);
    const x0 = from.x;
    const y0 = from.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.moveTo(id, x0 + (x - x0) * t, y0 + (y - y0) * t);
    }
  }

  async up(id: number): Promise<void> {
    const point = this.active.get(id);
    if (!point) return;
    this.active.delete(id);
    await this.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [point],
    });
  }

  /** Browser steals the gesture / OS interrupt. Cancels EVERY active point. */
  async cancelAll(): Promise<void> {
    if (this.active.size === 0) return;
    this.active.clear();
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  }

  async releaseAll(): Promise<void> {
    for (const id of [...this.active.keys()]) await this.up(id);
  }

  get count(): number {
    return this.active.size;
  }
}

/* -------------------------------------------------------------------------- */
/* Page helpers                                                               */
/* -------------------------------------------------------------------------- */

type Snapshot = {
  frame: number;
  device: string;
  move: { x: number; y: number; magnitude: number; angle: number; active: boolean };
  look: { x: number; y: number; magnitude: number; angle: number; active: boolean };
  buttons: Record<
    string,
    { pressed: boolean; held: boolean; released: boolean; holdTime: number; value: number }
  >;
  pointers: { id: number; x: number; y: number }[];
  pinchDelta: number;
  twistDelta: number;
  anyActive: boolean;
};

function makeHelpers(page: Page) {
  return {
    frames: (n = 2) => page.evaluate((count) => window.__INPUT_HARNESS__!.waitFrames(count), n),
    snapshot: () =>
      page.evaluate(() => window.__INPUT_HARNESS__!.snapshot()) as unknown as Promise<Snapshot>,
    pointers: () => page.evaluate(() => window.__INPUT_HARNESS__!.pointers()),
    peaks: () => page.evaluate(() => window.__INPUT_HARNESS__!.peaks()),
    clearPeaks: () => page.evaluate(() => window.__INPUT_HARNESS__!.clearPeaks()),
    gestures: () => page.evaluate(() => window.__INPUT_HARNESS__!.gestures()),
    clearGestures: () => page.evaluate(() => window.__INPUT_HARNESS__!.clearGestures()),
    pressed: () => page.evaluate(() => window.__INPUT_HARNESS__!.pressedSince()),
    /** Edges last one frame; a Playwright round trip is several. */
    lastPressed: (action: string) =>
      page.evaluate((value) => window.__INPUT_HARNESS__!.lastPressed(value), action),
    clearPressed: () => page.evaluate(() => window.__INPUT_HARNESS__!.clearPressed()),
    haptics: () => page.evaluate(() => window.__INPUT_HARNESS__!.hapticCounts()),
    hapticCalls: () => page.evaluate(() => window.__INPUT_HARNESS__!.hapticPluginCalls()),
    rejections: () => page.evaluate(() => window.__INPUT_HARNESS__!.unhandledRejections()),
    reset: () => page.evaluate(() => window.__INPUT_HARNESS__!.resetAll()),
    setInteract: (label: string | null) =>
      page.evaluate((value) => window.__INPUT_HARNESS__!.setInteract(value), label),
    setSafeArea: (insets: { top: number; right: number; bottom: number; left: number }) =>
      page.evaluate((value) => window.__INPUT_HARNESS__!.setSafeArea(value), insets),
    buttonCentre: (id: string) =>
      page.evaluate((value) => window.__INPUT_HARNESS__!.buttonCentre(value), id),
  };
}

/* -------------------------------------------------------------------------- */
/* Screenshot analysis                                                        */
/* -------------------------------------------------------------------------- */

async function assertNotBlank(file: string, label: string): Promise<void> {
  const image = sharp(file);
  const meta = await image.metadata();
  const stats = await image.stats();
  const channels = stats.channels.slice(0, 3);
  const stdDev = channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length;

  const raw = await sharp(file).resize(64, 64, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }

  const blank = stdDev < 1.5 || seen.size < 8;
  const detail = `${meta.width}x${meta.height} stdDev=${stdDev.toFixed(2)} colors=${seen.size}`;
  if (blank) fail(`${label} screenshot is not blank`, detail);
  else ok(`${label} screenshot is not blank`, detail);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  await mkdir(SHOTS, { recursive: true });

  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;

  try {
    server = await createServer({
      root: ROOT,
      logLevel: 'warn',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await server.listen();
    const base = server.resolvedUrls?.local?.[0];
    if (!base) throw new Error('vite did not report a local URL');
    const url = new URL('harness/input.html', base).toString();
    console.log(`serving ${url}`);

    browser = await chromium.launch({
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction(() => window.__HARNESS_READY__ === true, undefined, {
      timeout: 30_000,
    });

    const cdp = await context.newCDPSession(page);
    const touch = new MultiTouch(cdp);
    const h = makeHelpers(page);

    const config = await page.evaluate(() => window.__INPUT__!.config());
    const DEAD = config.stickDeadZonePx;
    const FULL = config.stickFullDeflectionPx;
    console.log(
      `tuning: deadZone=${DEAD}px fullDeflection=${FULL}px degPerPx=${config.cameraDegPerPx}`
    );

    /* Anchor for stick gestures: left half, in the clear lane below the
       readout panels, so the ring is visible in the evidence screenshots. */
    const SX = 300;
    const SY = 430;
    /* Anchor for camera gestures: right half, clear of the thumb-arc buttons. */
    const CX = 680;
    const CY = 300;

    /* ==================================================================== */
    group('1. stick vector for a known drag');
    /* ==================================================================== */
    await h.reset();
    await touch.down(1, SX, SY);
    await h.frames(2);
    let s = await h.snapshot();
    close(s.move.magnitude, 0, 0.001, 'centred on touch-down');
    check(s.move.active, 'stick reports active while the thumb is down');

    await touch.dragTo(1, SX, SY - FULL);
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 1, 0.02, 'full-deflection drag north -> magnitude 1');
    close(s.move.y, 1, 0.02, 'north drag -> y = +1 (positive is UP)');
    close(s.move.x, 0, 0.02, 'north drag -> x = 0');
    close((s.move.angle * 180) / Math.PI, 90, 2, 'north drag -> angle 90 degrees');
    await touch.up(1);
    await h.frames(2);

    await touch.down(1, SX, SY);
    await h.frames(2);
    await touch.dragTo(1, SX + FULL, SY);
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.x, 1, 0.02, 'east drag -> x = +1');
    close((s.move.angle * 180) / Math.PI, 0, 2, 'east drag -> angle 0 degrees');
    await touch.up(1);
    await h.frames(2);

    /* Diagonal: the same 120px of travel, at 45 degrees. */
    const leg = FULL * Math.SQRT1_2;
    await touch.down(1, SX, SY);
    await h.frames(2);
    await touch.dragTo(1, SX + leg, SY - leg);
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 1, 0.02, 'DIAGONAL not clamped short — magnitude still 1');
    close((s.move.angle * 180) / Math.PI, 45, 2, 'diagonal drag -> angle 45 degrees');
    await touch.up(1);
    await h.frames(2);

    /* ==================================================================== */
    group('2. dead zone and full-deflection clamping');
    /* ==================================================================== */
    await h.reset();
    await touch.down(1, SX, SY);
    await h.frames(2);

    await touch.moveTo(1, SX, SY - (DEAD - 6));
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 0, 0.0001, `${DEAD - 6}px of travel stays inside the dead zone`);

    await touch.moveTo(1, SX, SY - (DEAD + 4));
    await h.frames(3);
    s = await h.snapshot();
    check(
      s.move.magnitude > 0 && s.move.magnitude < 0.15,
      'just past the dead zone is a nudge, not a lurch',
      `magnitude=${s.move.magnitude.toFixed(4)}`
    );

    const mid = DEAD + (FULL - DEAD) / 2;
    await touch.moveTo(1, SX, SY - mid);
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 0.5, 0.02, 'halfway between dead zone and full = 0.5');

    await touch.moveTo(1, SX, SY - FULL * 3);
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 1, 0.001, 'triple the full-deflection distance still clamps to 1');
    await touch.up(1);
    await h.frames(2);
    s = await h.snapshot();
    close(s.move.magnitude, 0, 0.0001, 'stick centres when the thumb lifts');

    /* ==================================================================== */
    group('3. floating origin (never a fixed stick)');
    /* ==================================================================== */
    await h.reset();
    for (const [ox, oy] of [
      [120, 500],
      [430, 250],
      [260, 570],
    ] as const) {
      await touch.down(1, ox, oy);
      await h.frames(2);
      await touch.dragTo(1, ox, oy - FULL);
      await h.frames(3);
      s = await h.snapshot();
      close(s.move.magnitude, 1, 0.03, `origin anchors at (${ox},${oy}) wherever the thumb lands`);
      await touch.up(1);
      await h.frames(2);
    }

    /* ==================================================================== */
    group('4. camera drag');
    /* ==================================================================== */
    await h.reset();
    await h.clearPeaks();
    await touch.down(2, CX, CY);
    await h.frames(2);
    await touch.dragTo(2, CX + 240, CY, 12);
    await h.frames(3);
    let peaks = await h.peaks();
    check(
      peaks.lookAbsX > 0.02,
      'rightward drag produces a look rate',
      `peak |look.x|=${peaks.lookAbsX.toFixed(4)}`
    );
    s = await h.snapshot();
    check(s.look.x > 0, 'rightward drag -> positive look.x', `look.x=${s.look.x.toFixed(4)}`);
    await touch.up(2);
    await h.frames(30);
    s = await h.snapshot();
    close(s.look.magnitude, 0, 0.001, 'look decays to rest after the finger lifts');

    await h.clearPeaks();
    await touch.down(2, CX, CY + 120);
    await h.frames(2);
    await touch.dragTo(2, CX, CY - 120, 12);
    await h.frames(3);
    s = await h.snapshot();
    check(
      s.look.y > 0,
      'upward drag -> positive look.y (looks up)',
      `look.y=${s.look.y.toFixed(4)}`
    );
    await touch.up(2);
    await h.frames(20);

    /* ==================================================================== */
    group('5. MULTI-TOUCH: stick + camera + button simultaneously');
    /* ==================================================================== */
    await h.reset();
    await h.clearPeaks();
    const punchCentre = await h.buttonCentre('punch');
    if (!punchCentre) throw new Error('punch button not found in the overlay');

    await touch.down(1, SX, SY); // left half  -> stick
    await touch.down(2, CX, CY); // right half -> camera
    await touch.down(3, punchCentre.x, punchCentre.y); // -> button
    await h.frames(3);

    const roles = (await h.pointers()).map((p) => `${p.role}${p.button ? `:${p.button}` : ''}`);
    check(roles.length === 3, 'three pointers tracked at once', `roles=[${roles.join(', ')}]`);
    check(
      roles.includes('stick') && roles.includes('camera') && roles.includes('button:punch'),
      'roles assigned correctly and independently',
      `roles=[${roles.join(', ')}]`
    );

    await touch.dragTo(1, SX, SY - FULL, 6);
    await touch.dragTo(2, CX + 200, CY, 10);
    await h.frames(3);

    s = await h.snapshot();
    peaks = await h.peaks();
    close(s.move.magnitude, 1, 0.03, 'stick still reads full deflection while the camera pans');
    close(s.move.y, 1, 0.03, 'stick direction unaffected by the other two fingers');
    check(
      peaks.lookAbsX > 0.02,
      'camera pans while the stick is deflected',
      `peak |look.x|=${peaks.lookAbsX.toFixed(4)}`
    );
    check(s.buttons.punch.held, 'punch stays held throughout');
    check(
      s.pointers.length === 3,
      'InputState.pointers reports all three',
      `n=${s.pointers.length}`
    );
    check(peaks.pointerCount === 3, 'peak pointer count is 3');

    /* Lift only the camera finger; the other two must be untouched. */
    await touch.up(2);
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 1, 0.03, 'lifting the camera finger leaves the stick alone');
    check(s.buttons.punch.held, 'lifting the camera finger leaves the button held');
    check(s.pointers.length === 2, 'two pointers remain', `n=${s.pointers.length}`);

    await touch.releaseAll();
    await h.frames(3);

    /* ==================================================================== */
    group('6. pointercancel mid-drag releases cleanly (no stuck stick)');
    /* ==================================================================== */
    await h.reset();
    await touch.down(1, SX, SY);
    await h.frames(2);
    await touch.dragTo(1, SX + FULL, SY - FULL, 8);
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 1, 0.03, 'stick is deflected before the cancel');

    await touch.cancelAll();
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 0, 0.0001, 'CANCEL -> stick returns to centre');
    check(!s.move.active, 'CANCEL -> stick reports inactive');
    check(s.pointers.length === 0, 'CANCEL -> no pointers left', `n=${s.pointers.length}`);

    /* Ten frames later it must still be released — not just for one frame. */
    await h.frames(10);
    s = await h.snapshot();
    close(s.move.magnitude, 0, 0.0001, 'still centred ten frames after the cancel');

    /* And a fresh touch must work normally. */
    await touch.down(1, SX, SY);
    await h.frames(2);
    await touch.dragTo(1, SX, SY - FULL);
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 1, 0.03, 'a fresh drag after a cancel works normally');
    await touch.up(1);
    await h.frames(2);

    /* Cancel with a full multi-touch load: nothing may survive. */
    await h.reset();
    await touch.down(1, SX, SY);
    await touch.down(2, CX, CY);
    await touch.down(3, punchCentre.x, punchCentre.y);
    await touch.dragTo(1, SX, SY - FULL, 4);
    await h.frames(3);
    check((await h.snapshot()).buttons.punch.held, 'punch held before the multi-touch cancel');
    await touch.cancelAll();
    await h.frames(4);
    s = await h.snapshot();
    close(s.move.magnitude, 0, 0.0001, 'multi-touch cancel -> stick released');
    check(!s.buttons.punch.held, 'multi-touch cancel -> button released');
    check(s.pointers.length === 0, 'multi-touch cancel -> no pointers left');
    check(
      (await h.lastPressed('heavyPunch')) === null,
      'multi-touch cancel -> no phantom charged punch fired'
    );
    await h.frames(8);
    s = await h.snapshot();
    check(
      !s.buttons.punch.held && !s.move.active && s.pointers.length === 0,
      'multi-touch cancel -> nothing is stuck eight frames later'
    );

    /* ==================================================================== */
    group('7. pinch changes the camera arm length');
    /* ==================================================================== */
    await h.reset();
    await h.clearPeaks();
    await touch.down(1, CX - 100, CY);
    await touch.down(2, CX + 100, CY); // span 200px
    await h.frames(3);
    await touch.moveTo(2, CX + 220, CY); // span 320px
    await h.frames(3);
    peaks = await h.peaks();
    check(
      peaks.pinchMax > 1.05,
      'spreading two fingers reports pinchDelta > 1',
      `max=${peaks.pinchMax.toFixed(4)}`
    );

    await h.clearPeaks();
    await touch.moveTo(2, CX + 20, CY); // span 120px
    await h.frames(3);
    peaks = await h.peaks();
    check(
      peaks.pinchMin < 0.95,
      'closing two fingers reports pinchDelta < 1',
      `min=${peaks.pinchMin.toFixed(4)}`
    );

    await h.clearPeaks();
    await touch.moveTo(1, CX - 100, CY - 60);
    await touch.moveTo(2, CX + 20, CY + 60);
    await h.frames(3);
    peaks = await h.peaks();
    check(
      peaks.twistAbs > 0.01,
      'rotating two fingers reports a twist',
      `|twist|=${peaks.twistAbs.toFixed(4)}`
    );

    /* Let the look smoother fully settle first, otherwise the decay tail of
       the rotation above would be mistaken for a snap. */
    await h.frames(40);
    s = await h.snapshot();
    close(s.look.magnitude, 0, 0.0001, 'look is at rest before the lift');
    await h.clearPeaks();
    await touch.up(2);
    await h.frames(4);
    peaks = await h.peaks();
    check(
      peaks.lookAbsX < 0.005,
      'lifting one of two fingers does NOT snap the camera',
      `peak |look.x|=${peaks.lookAbsX.toFixed(4)}`
    );
    await touch.releaseAll();
    await h.frames(3);

    /* ==================================================================== */
    group('8. action buttons, charge ring and haptics');
    /* ==================================================================== */
    await h.reset();
    await h.clearPressed();

    /* Tap = light punch, no heavy. */
    await touch.down(3, punchCentre.x, punchCentre.y);
    await h.frames(2);
    s = await h.snapshot();
    check(s.buttons.punch.held, 'punch button press registers');
    check((await h.pressed()).includes('punch'), 'punch fires its pressed edge on touch-down');
    await touch.up(3);
    await h.frames(3);
    check((await h.lastPressed('heavyPunch')) === null, 'a quick tap does NOT fire heavyPunch');

    /* Hold = charge, release = heavy punch with the ratio. */
    await h.clearPressed();
    await touch.down(3, punchCentre.x, punchCentre.y);
    await page.waitForTimeout((config.chargeFullSec + 0.25) * 1000);
    await h.frames(3);
    const chargeRatio = await page.evaluate(
      () => window.__INPUT_HARNESS__!.manager.touch!.chargeRatio
    );
    close(chargeRatio, 1, 0.001, 'charge ring fills to 1.0 on a long hold');
    const haptics = await h.haptics();
    check(
      (haptics.chargeComplete ?? 0) >= 1,
      'charge-complete haptic cue fired',
      JSON.stringify(haptics)
    );
    const hapticCalls = await h.hapticCalls();
    check(
      hapticCalls.includes('notification:SUCCESS'),
      'the haptics wrapper reached the plugin with the mapped pattern',
      hapticCalls.slice(0, 4).join(', ')
    );

    /* The ring is a real, PAINTED DOM element — not just a number in a struct
       and not just an attribute. Everything below is read from COMPUTED style,
       because an attribute can read correct while a stylesheet quietly
       overrides it (SVG presentation attributes lose to any CSS rule). */
    const ring = (await page.evaluate(`(() => {
      const svg = document.querySelector('.opm-charge');
      const fill = svg && svg.querySelector('.opm-charge-fill');
      if (!svg || !fill) return null;
      const svgStyle = getComputedStyle(svg);
      const fillStyle = getComputedStyle(fill);
      const box = fill.getBoundingClientRect();
      return {
        charging: svg.getAttribute('data-charging'),
        full: svg.getAttribute('data-full'),
        dashOffset: parseFloat(fillStyle.strokeDashoffset),
        dashArray: fillStyle.strokeDasharray,
        stroke: fillStyle.stroke,
        opacity: svgStyle.opacity,
        radiusPx: box.width / 2,
      };
    })()`)) as {
      charging: string;
      full: string;
      dashOffset: number;
      dashArray: string;
      stroke: string;
      opacity: string;
      radiusPx: number;
    } | null;
    check(ring !== null, 'radial charge-ring element exists on the punch button');
    if (ring) {
      check(ring.charging === 'true', 'charge ring is marked charging', JSON.stringify(ring));
      check(ring.full === 'true', 'charge ring is marked full at ratio 1');
      close(ring.dashOffset, 0, 0.5, 'charge ring is fully closed (COMPUTED dashoffset 0)');
      check(Number(ring.opacity) > 0.9, 'charge ring is visible', `opacity=${ring.opacity}`);
      check(
        ring.radiusPx > 30,
        'charge ring has a real painted radius',
        `${ring.radiusPx.toFixed(1)}px`
      );
      check(
        ring.stroke.replace(/\s/g, '') === 'rgb(255,90,60)',
        'charge ring turns red at full charge',
        ring.stroke
      );
    }

    await touch.up(3);
    await h.frames(3);
    const heavy = await h.lastPressed('heavyPunch');
    check(heavy !== null, 'releasing a full charge fires heavyPunch');
    if (heavy) close(heavy.value, 1, 0.02, 'heavyPunch carries the charge ratio');

    /* Partway through a charge the ring must be PARTLY drawn, not all-or-nothing. */
    await h.clearPressed();
    await touch.down(3, punchCentre.x, punchCentre.y);
    await page.waitForTimeout(
      (config.chargeStartSec + (config.chargeFullSec - config.chargeStartSec) * 0.45) * 1000
    );
    await h.frames(2);
    const partial = (await page.evaluate(
      `parseFloat(getComputedStyle(document.querySelector('.opm-charge-fill')).strokeDashoffset)`
    )) as number;
    const circumference = 2 * Math.PI * 45;
    check(
      partial > circumference * 0.1 && partial < circumference * 0.9,
      'charge ring sweeps progressively, not all-or-nothing',
      `dashoffset=${partial.toFixed(1)} of ${circumference.toFixed(1)}`
    );
    await touch.up(3);
    await h.frames(3);
    const partialHeavy = await h.lastPressed('heavyPunch');
    check(partialHeavy !== null, 'a partial charge still fires heavyPunch');
    if (partialHeavy) {
      check(
        partialHeavy.value > 0.1 && partialHeavy.value < 0.95,
        'a partial charge carries a partial ratio',
        `value=${partialHeavy.value.toFixed(3)}`
      );
    }

    /* Jump. */
    const jumpCentre = await h.buttonCentre('jump');
    check(jumpCentre !== null, 'jump button is laid out on the thumb arc');
    if (jumpCentre) {
      await touch.down(4, jumpCentre.x, jumpCentre.y);
      await h.frames(2);
      check((await h.snapshot()).buttons.jump.held, 'jump button press registers');
      await touch.up(4);
      await h.frames(2);
    }

    /* Dash toggles. */
    const dashCentre = await h.buttonCentre('dash');
    check(dashCentre !== null, 'dash button is laid out on the thumb arc');
    if (dashCentre) {
      await touch.down(5, dashCentre.x, dashCentre.y);
      await touch.up(5);
      await h.frames(3);
      check((await h.snapshot()).buttons.sprint.held, 'dash TOGGLES sprint on and stays on');
      await touch.down(5, dashCentre.x, dashCentre.y);
      await touch.up(5);
      await h.frames(3);
      check(!(await h.snapshot()).buttons.sprint.held, 'tapping dash again toggles sprint off');
    }

    /* Interact is context-sensitive. */
    check((await h.buttonCentre('interact')) === null, 'interact button is hidden with no target');
    await h.setInteract('SMASH');
    await h.frames(2);
    const interactCentre = await h.buttonCentre('interact');
    check(interactCentre !== null, 'interact button appears when a target is in range');
    if (interactCentre) {
      await touch.down(6, interactCentre.x, interactCentre.y);
      await h.frames(2);
      check((await h.snapshot()).buttons.interact.held, 'interact button press registers');
      await touch.up(6);
      await h.frames(2);
    }
    await h.setInteract(null);
    await h.frames(2);
    check((await h.buttonCentre('interact')) === null, 'interact hides again when out of range');

    /* ==================================================================== */
    group('9. gestures');
    /* ==================================================================== */
    /* First: the SHIPPED thresholds are what the design says they are. The
       recogniser behaviour at those exact boundaries is pinned by the unit
       tests in `src/ui/input/touch-core.test.ts`, which have a perfect clock. */
    close(config.doubleTapWindow, 0.28, 1e-9, 'shipped doubleTapWindow is 0.28s');
    close(config.tapMaxDurationSec, 0.25, 1e-9, 'shipped tapMaxDurationSec is 0.25s');
    close(config.twoFingerTapWindowSec, 0.2, 1e-9, 'shipped twoFingerTapWindowSec is 0.2s');
    close(config.swipeUpMinPx, 46, 1e-9, 'shipped swipeUpMinPx is 46px');
    close(config.swipeUpMaxSec, 0.4, 1e-9, 'shipped swipeUpMaxSec is 0.4s');

    /* Now widen the TIME windows for this scenario only. A single CDP
       `dispatchTouchEvent` round trip costs 55-180ms against SwiftShader —
       one whole double-tap window per event — so at shipped thresholds this
       scenario would be testing the transport, not the recogniser. Distances
       and directions stay at their shipped values; only the clocks move. */
    await page.evaluate(
      `window.__INPUT__.setConfig({ tapMaxDurationSec: 1.5, doubleTapWindow: 2.0,` +
        ` twoFingerTapWindowSec: 1.5, swipeUpMaxSec: 2.5 })`
    );
    await page.evaluate(`window.__INPUT__.disable()`);
    await h.reset();
    await h.clearGestures();
    await h.clearPressed();

    /* Double tap -> jump. */
    await touch.down(1, SX, SY);
    await touch.up(1);
    await h.frames(2);
    await touch.down(1, SX + 6, SY + 4);
    await touch.up(1);
    await h.frames(3);
    check((await h.gestures()).includes('doubleTapJump'), 'double tap recognised');
    check((await h.pressed()).includes('jump'), 'double tap fires jump');

    /* Two-finger tap -> lockOn. */
    await h.clearGestures();
    await h.clearPressed();
    await touch.down(1, CX - 60, CY);
    await touch.down(2, CX + 60, CY);
    await touch.up(1);
    await touch.up(2);
    await h.frames(3);
    check((await h.gestures()).includes('twoFingerTapLock'), 'two-finger tap recognised');
    check((await h.pressed()).includes('lockOn'), 'two-finger tap fires lockOn');
    check(!(await h.pressed()).includes('jump'), 'two-finger tap is NOT also read as a double tap');

    /* Swipe up on the punch button -> uppercut. */
    await h.clearGestures();
    await h.clearPressed();
    await touch.down(3, punchCentre.x, punchCentre.y);
    await touch.dragTo(3, punchCentre.x, punchCentre.y - 90, 4);
    await h.frames(3);
    check((await h.gestures()).includes('swipeUpUppercut'), 'swipe up on punch recognised');
    check((await h.pressed()).includes('special'), 'swipe up fires the uppercut (special)');
    await touch.up(3);
    await h.frames(3);
    check(
      (await h.lastPressed('heavyPunch')) === null,
      'the uppercut consumes the press — no charged punch on release'
    );

    /* A drag that is too SHORT is still not an uppercut, even with the clocks
       widened — the distance threshold is unchanged and still enforced. */
    await h.clearGestures();
    await h.clearPressed();
    await touch.down(3, punchCentre.x, punchCentre.y);
    await touch.dragTo(3, punchCentre.x, punchCentre.y - (config.swipeUpMinPx - 16), 3);
    await h.frames(3);
    check(
      !(await h.gestures()).includes('swipeUpUppercut'),
      'a short upward drag on punch is NOT an uppercut'
    );
    await touch.up(3);
    await h.frames(3);

    /* Restore the shipped thresholds for everything that follows. */
    await page.evaluate(
      `window.__INPUT__.setConfig({ tapMaxDurationSec: ${config.tapMaxDurationSec},` +
        ` doubleTapWindow: ${config.doubleTapWindow},` +
        ` twoFingerTapWindowSec: ${config.twoFingerTapWindowSec},` +
        ` swipeUpMaxSec: ${config.swipeUpMaxSec} })`
    );
    await page.evaluate(`window.__INPUT__.disable()`);
    const restored = await page.evaluate(() => window.__INPUT__!.config());
    close(restored.doubleTapWindow, config.doubleTapWindow, 1e-9, 'shipped thresholds restored');

    /* ==================================================================== */
    group('10. keyboard produces the identical InputState');
    /* ==================================================================== */
    await h.reset();
    await touch.down(1, SX, SY);
    await h.frames(2);
    await touch.dragTo(1, SX, SY - FULL);
    await h.frames(3);
    const touchNorth = await h.snapshot();
    await touch.up(1);
    await h.frames(4);

    await page.keyboard.down('w');
    await h.frames(3);
    const keyNorth = await h.snapshot();
    await page.keyboard.up('w');
    await h.frames(3);

    close(
      keyNorth.move.magnitude,
      touchNorth.move.magnitude,
      0.02,
      'keyboard W == touch north (magnitude)'
    );
    close(keyNorth.move.y, touchNorth.move.y, 0.02, 'keyboard W == touch north (y)');
    close(keyNorth.move.x, touchNorth.move.x, 0.02, 'keyboard W == touch north (x)');
    check(keyNorth.device === 'keyboard', 'device switches to keyboard', keyNorth.device);

    /* Diagonal parity — the case that catches square/circle mistakes. */
    await touch.down(1, SX, SY);
    await h.frames(2);
    await touch.dragTo(1, SX + leg, SY - leg);
    await h.frames(3);
    const touchNE = await h.snapshot();
    await touch.up(1);
    await h.frames(4);

    await page.keyboard.down('w');
    await page.keyboard.down('d');
    await h.frames(3);
    const keyNE = await h.snapshot();
    await page.keyboard.up('w');
    await page.keyboard.up('d');
    await h.frames(3);
    close(
      keyNE.move.magnitude,
      touchNE.move.magnitude,
      0.02,
      'keyboard W+D == touch diagonal (magnitude)'
    );
    close(keyNE.move.x, touchNE.move.x, 0.02, 'keyboard W+D == touch diagonal (x)');
    close(keyNE.move.y, touchNE.move.y, 0.02, 'keyboard W+D == touch diagonal (y)');

    /* Buttons. */
    await page.keyboard.down('j');
    await h.frames(3);
    check((await h.snapshot()).buttons.punch.held, 'keyboard J holds punch');
    await page.keyboard.up('j');
    await h.frames(3);
    await page.keyboard.down('Shift');
    await h.frames(3);
    check((await h.snapshot()).buttons.sprint.held, 'keyboard Shift holds sprint');
    await page.keyboard.up('Shift');
    await h.frames(3);

    /* ==================================================================== */
    group('11. gamepad produces the identical InputState');
    /* ==================================================================== */
    await h.reset();
    /* Evaluated as a STRING, not a function: tsx compiles this file with
       esbuild's `keepNames`, which injects a `__name` helper that does not
       exist inside the page realm. Strings bypass the transform entirely. */
    await page.evaluate(`(() => {
      const buttons = [];
      for (let i = 0; i < 17; i++) buttons.push({ pressed: false, value: 0, touched: false });
      const pad = {
        id: 'synthetic pad', index: 0, connected: true, mapping: 'standard',
        axes: [0, 0, 0, 0], buttons,
      };
      window.__PAD__ = pad;
      Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        value: function () { return [window.__PAD__]; },
      });
    })()`);

    await page.evaluate(`window.__PAD__.axes[1] = -1`);
    await h.frames(4);
    const padNorth = await h.snapshot();
    close(
      padNorth.move.magnitude,
      touchNorth.move.magnitude,
      0.02,
      'gamepad stick north == touch north (magnitude)'
    );
    close(padNorth.move.y, touchNorth.move.y, 0.02, 'gamepad stick north == touch north (y)');
    check(padNorth.device === 'gamepad', 'device switches to gamepad', padNorth.device);

    await page.evaluate(`(() => { window.__PAD__.axes[0] = 1; window.__PAD__.axes[1] = -1; })()`);
    await h.frames(4);
    const padNE = await h.snapshot();
    close(
      padNE.move.magnitude,
      touchNE.move.magnitude,
      0.02,
      'gamepad diagonal == touch diagonal (magnitude)'
    );
    close(padNE.move.x, touchNE.move.x, 0.02, 'gamepad diagonal == touch diagonal (x)');
    close(padNE.move.y, touchNE.move.y, 0.02, 'gamepad diagonal == touch diagonal (y)');

    await page.evaluate(
      `(() => { const p = window.__PAD__; p.axes[0] = 0; p.axes[1] = 0;` +
        ` p.buttons[2] = { pressed: true, value: 1 }; })()`
    );
    await h.frames(4);
    check((await h.snapshot()).buttons.punch.held, 'gamepad X holds punch');

    await page.evaluate(`(() => { window.__PAD__.buttons[10] = { pressed: true, value: 1 }; })()`);
    await h.frames(4);
    check(
      (await h.snapshot()).buttons.sprint.held,
      'gamepad L3 holds sprint (matches dash toggle)'
    );

    await page.evaluate(`(() => { window.__PAD__ = null; })()`);
    await h.frames(4);
    s = await h.snapshot();
    check(
      !s.buttons.punch.held && !s.buttons.sprint.held,
      'unplugging the pad mid-press releases everything'
    );

    /* ==================================================================== */
    group('12. synthetic injection (window.__INPUT__)');
    /* ==================================================================== */
    await h.reset();
    await page.evaluate(() => window.__INPUT__!.setMove(0, 1));
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.y, 1, 0.001, 'window.__INPUT__.setMove drives the move axis exactly');
    check(s.device === 'synthetic', 'device reports synthetic while armed', s.device);

    await page.evaluate(() => window.__INPUT__!.tap('punch'));
    await h.frames(1);
    const historyAfterTap = (await page.evaluate(() =>
      window.__INPUT_HARNESS__!.history(6)
    )) as unknown as Snapshot[];
    check(
      historyAfterTap.some((state) => state.buttons.punch.pressed),
      'window.__INPUT__.tap produces a real pressed edge'
    );

    /* A real touch must be ignored while the synthetic driver is armed. */
    await touch.down(1, SX, SY);
    await touch.dragTo(1, SX + FULL, SY, 4);
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.y, 1, 0.001, 'a real touch cannot corrupt a scripted run');
    await touch.releaseAll();

    await page.evaluate(() => window.__INPUT__!.disable());
    await h.frames(3);
    s = await h.snapshot();
    close(s.move.magnitude, 0, 0.001, 'disable() hands control back with nothing latched');

    /* ==================================================================== */
    group('13. safe-area-aware layout');
    /* ==================================================================== */
    await h.reset();
    const beforeInsets = await h.buttonCentre('punch');
    await h.setSafeArea({ top: 0, right: 44, bottom: 34, left: 0 });
    await h.frames(2);
    const afterInsets = await h.buttonCentre('punch');
    if (beforeInsets && afterInsets) {
      close(
        beforeInsets.x - afterInsets.x,
        44,
        1.5,
        'right inset pushes the arc left by exactly 44px'
      );
      close(
        beforeInsets.y - afterInsets.y,
        34,
        1.5,
        'bottom inset pushes the arc up by exactly 34px'
      );
    } else {
      fail('safe-area insets move the thumb arc', 'punch button not measurable');
    }
    await h.setSafeArea({ top: 0, right: 0, bottom: 0, left: 0 });
    await h.frames(2);

    /* ==================================================================== */
    group('14. evidence screenshots');
    /* ==================================================================== */
    await h.reset();
    await h.setInteract('SMASH');
    /* Recreate the flagship multi-touch state and photograph it. */
    await touch.down(1, SX, SY);
    await touch.down(2, CX + 20, CY - 40);
    await touch.down(3, punchCentre.x, punchCentre.y);
    await h.frames(2);
    await touch.dragTo(1, SX + 70, SY - 92, 6);
    await touch.dragTo(2, CX + 170, CY - 10, 8);
    await h.frames(3);

    const multitouchShot = path.join(SHOTS, 'input-multitouch.png');
    await page.screenshot({ path: multitouchShot, type: 'png' });
    await assertNotBlank(multitouchShot, 'multi-touch');

    s = await h.snapshot();
    check(s.pointers.length === 3, 'screenshot captures three live pointers');
    check(s.buttons.punch.held, 'screenshot captures a held, charging punch');
    check(s.move.magnitude > 0, 'screenshot captures a deflected stick');

    await touch.releaseAll();
    await h.frames(4);
    await h.setInteract(null);

    /* A second shot showing the gesture log and a full charge. */
    await h.clearGestures();
    await touch.down(1, SX, SY);
    await touch.up(1);
    await h.frames(2);
    await touch.down(1, SX + 5, SY + 5);
    await touch.up(1);
    await h.frames(3);
    await touch.down(3, punchCentre.x, punchCentre.y);
    await page.waitForTimeout((config.chargeFullSec + 0.2) * 1000);
    await h.frames(3);

    const chargeShot = path.join(SHOTS, 'input-harness.png');
    await page.screenshot({ path: chargeShot, type: 'png' });
    await assertNotBlank(chargeShot, 'harness');
    await touch.releaseAll();
    await h.frames(3);

    console.log(`\nsaved: ${multitouchShot}`);
    console.log(`saved: ${chargeShot}`);

    /* ==================================================================== */
    group('15. no console errors, no leaked rejections');
    /* ==================================================================== */
    check(
      consoleErrors.length === 0,
      'the harness ran without console errors',
      consoleErrors.slice(0, 3).join(' | ')
    );
    /* The page fires the REAL @capacitor/haptics at boot. Its web fallback
       rejects on a browser with no vibration API — the wrapper must swallow
       that rather than leaking an unhandled rejection into the game loop. */
    const rejections = await h.rejections();
    check(
      rejections.length === 0,
      'haptics no-op cleanly on web — no unhandled promise rejections',
      rejections.slice(0, 3).join(' | ')
    );

    await writeFile(
      path.join(SHOTS, 'input-harness.json'),
      JSON.stringify(
        {
          generated: new Date().toISOString(),
          viewport: VIEWPORT,
          tuning: config,
          checks: { passed: passes.length, failed: failures.length },
        },
        null,
        2
      ),
      'utf8'
    );
  } finally {
    await browser?.close();
    await server?.close();
  }

  console.log(`\n──────── result ────────`);
  console.log(`${passes.length} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error('\nINPUT VERIFICATION FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('INPUT VERIFICATION PASSED');
}

main().catch((error) => {
  console.error('input verification crashed:', error);
  process.exit(1);
});
