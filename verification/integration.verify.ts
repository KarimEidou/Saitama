/**
 * INTEGRATION VERIFICATION — the whole game, driven for ninety seconds.
 *
 * `verify.ts` proves the toolchain: a page loaded, a frame presented, the
 * pixels were not blank. This proves the GAME: that twenty-six systems compose
 * into something a player can drive from spawn to a collapsed city block, with
 * no uncaught errors and no console errors along the way.
 *
 * ── HOW IT DRIVES ──────────────────────────────────────────────────────────
 * Through `window.__INPUT__`, the synthetic input bridge every build installs.
 * Not synthesised touch events: those go through the touch backend's gesture
 * recogniser and prove that the recogniser works, which is `harness/input`'s
 * job and not this one. The bridge writes `InputState` directly, through the
 * same `ButtonTracker` a thumb goes through, so `pressed` / `released` /
 * `holdTime` are physically plausible and a 1.2 s charge is a 1.2 s charge.
 *
 * ── WHAT IS MEASURED, AND WHAT IS NOT ──────────────────────────────────────
 * Boot time and CPU frame-section timings from `performance.now()` are REAL.
 * Frame RATE is not reported anywhere in this file: the only GL available here
 * is SwiftShader, a CPU rasteriser, and a number derived from it says nothing
 * about a phone.
 *
 * Run: `npx tsx verification/integration.verify.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'verification');

/**
 * Portrait, phone-shaped, DPR 1.
 *
 * 720x1280 rather than a flagship's 1080x2400: every capture here is rasterised
 * by SwiftShader on the CPU and read back, which is by far the slowest step in
 * this file. The assertions are about geometry, brightness and DOM structure,
 * none of which need more pixels.
 */
const VIEWPORT = { width: 720, height: 1280 };

/** Boot budget on the `high` tier, milliseconds. */
const BOOT_BUDGET_MS = 6000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

interface IServed {
  readonly server: Server;
  readonly port: number;
  /** Every path requested, in order. The Android tier proof reads this. */
  readonly requests: string[];
  /** Paths that 404'd. Must be empty. */
  readonly misses: string[];
  /** Requests the handler itself threw on. Must be empty. */
  readonly errors: string[];
}

function serveDist(): Promise<IServed> {
  const requests: string[] = [];
  const misses: string[] = [];
  const errors: string[] = [];
  const server = createServer(async (req, res) => {
    // Wrapped, as `verify.ts` has always been: `decodeURIComponent('/%')` throws
    // synchronously and `readFile` on a directory rejects with EISDIR. Either
    // one leaves this async handler's promise unhandled, and Node's default
    // `--unhandled-rejections=throw` then tears the process down mid-run.
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      requests.push(url.pathname);
      let filePath = path.join(DIST, decodeURIComponent(url.pathname));
      if (url.pathname === '/' || url.pathname === '') filePath = path.join(DIST, 'index.html');
      // `DIST + path.sep`: a bare prefix test also accepts `<ROOT>/dist-notes`.
      const contained = filePath === DIST || filePath.startsWith(DIST + path.sep);
      if (!contained || !existsSync(filePath) || !statSync(filePath).isFile()) {
        misses.push(url.pathname);
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
      errors.push(`${url.pathname}: ${String(error)}`);
      res.writeHead(500).end(String(error));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind'));
        return;
      }
      resolve({ server, port: address.port, requests, misses, errors });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Screenshots                                                                */
/* -------------------------------------------------------------------------- */

interface IShotReport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly stdDev: number;
  readonly mean: number;
  readonly colors: number;
  readonly blank: boolean;
}

/**
 * Analyse a capture.
 *
 * NOTE ON `sharp`: `sharp(file).extract(rect).stats()` DOES NOT CROP. `stats()`
 * reads the input and ignores the queued pipeline, so any region assertion
 * written that way passes vacuously — it is measuring the whole image. Every
 * region here is materialised with `.toBuffer()` first and re-opened, which is
 * the only form that actually crops.
 */
async function analyse(name: string, file: string): Promise<IShotReport> {
  const meta = await sharp(file).metadata();
  const stats = await sharp(file).stats();
  const colour = stats.channels.slice(0, 3);
  const stdDev = colour.reduce((sum, c) => sum + c.stdev, 0) / colour.length;
  const mean = colour.reduce((sum, c) => sum + c.mean, 0) / colour.length;

  const raw = await sharp(file).resize(64, 64, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }
  return {
    name,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    stdDev,
    mean,
    colors: seen.size,
    blank: stdDev <= 10 || seen.size <= 100,
  };
}

/** Mean brightness of one region. Materialised first — see `analyse`. */
async function regionMean(
  file: string,
  rect: { left: number; top: number; width: number; height: number }
): Promise<number> {
  const cropped = await sharp(file).extract(rect).toBuffer();
  const stats = await sharp(cropped).stats();
  const colour = stats.channels.slice(0, 3);
  return colour.reduce((sum, c) => sum + c.mean, 0) / colour.length;
}

/** One region's RGB bytes. Materialised first, for the reason `analyse` gives. */
async function regionBytes(
  file: string,
  rect: { left: number; top: number; width: number; height: number }
): Promise<Buffer> {
  const cropped = await sharp(file).extract(rect).toBuffer();
  return sharp(cropped).removeAlpha().raw().toBuffer();
}

/**
 * Mean absolute per-pixel difference between the same region of two captures,
 * in 0..255.
 *
 * Why not compare the two region MEANS: a mean is very nearly invariant under
 * a camera rotation. Swing the view along a street lined with facades on both
 * sides and the band is made of different pixels but averages to the same
 * number — so "the mean barely moved" is evidence about the street, not about
 * the camera. Comparing the pixels themselves asks the question that was meant
 * all along: is this a different view of the world?
 */
async function regionDiff(
  fileA: string,
  fileB: string,
  rect: { left: number; top: number; width: number; height: number }
): Promise<number> {
  const [a, b] = await Promise.all([regionBytes(fileA, rect), regionBytes(fileB, rect)]);
  if (a.length !== b.length || a.length === 0) return Number.NaN;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!);
  return total / a.length;
}

/** Signed shortest difference between two headings, in degrees. */
function shortestAngleDeg(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/* -------------------------------------------------------------------------- */
/* Driving                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Advance real frames. `requestAnimationFrame` is the game's only clock.
 *
 * Passed as SOURCE TEXT rather than as a closure: tsx compiles this file with
 * esbuild's `keepNames`, which rewrites every named function into a call to a
 * `__name` helper that exists in this module and not in the page. A closure
 * with a named inner function therefore throws `__name is not defined` the
 * moment Playwright serialises it.
 *
 * DEADLINE: the promise below only ever resolved, and `page.evaluate` has no
 * timeout, so a page whose rAF stops firing — a lost GL context, a renderer
 * crash, a page throttled behind the second tab beat 10 opens — hung the run
 * forever with no output. 30 s per requested frame is ~10x the worst measured
 * SwiftShader frame, so this can only fire on a genuinely dead loop; the
 * rejection surfaces as an ordinary `page.evaluate` error and reaches
 * `main().catch(...)`.
 */
async function frames(page: Page, count: number): Promise<void> {
  const budgetMs = 60_000 + count * 30_000;
  await page.evaluate(
    `new Promise((resolve, reject) => {
       let left = ${count};
       const timer = setTimeout(() => reject(new Error(
         'frames(): requestAnimationFrame stalled with ' + left + ' of ${count} frames left after ${budgetMs} ms'
       )), ${budgetMs});
       const tick = () => {
         if (--left <= 0) { clearTimeout(timer); resolve(); return; }
         requestAnimationFrame(tick);
       };
       requestAnimationFrame(tick);
     })`
  );
}

interface IDiag {
  bootTimeMs: number;
  drawCalls: number;
  triangles: number;
  frameCount: number;
  quality: string;
  errors: string[];
  boot: Record<string, number>;
  timings: Record<string, number>;
  systems: { online: string[]; skipped: Record<string, string>; failed: Record<string, string> };
  world: Record<string, unknown>;
}

/**
 * `window.__GAME__` as this harness uses it.
 *
 * The composition root is not importable from here and no ambient declaration
 * covers `__GAME__` (`src/types/engine.ts` declares only `__GAME_READY__` and
 * `__GAME_DIAG__`), so the shape has to be asserted. Asserting it ONCE means
 * two call sites cannot state contradictory signatures for the same method and
 * have tsc accept both — which eleven separate inline casts, five of them
 * describing `combat` or `hud` with a different subset each, could.
 *
 * Type-only: erased before any of these closures reaches the page, so the
 * `__name` hazard documented above `frames()` does not apply.
 */
interface IGameWindow {
  __GAME__?: {
    spawnEncounter(id: string, distance?: number): string | undefined;
    faceNearestMonster(): void;
    faceNearestStructure(): void;
    /** The third-person rig. `diagnostics().yaw` is the camera's own heading. */
    player: { camera: { diagnostics(): { yaw: number } } };
    monsters: {
      count: number;
      describeForCombat(): { id: string; position: { y: number }; radius: number }[];
      get(id: string):
        | {
            brain: { position: { y: number } };
            archetype: { bodyHeightMetres: number; radiusMetres: number };
          }
        | undefined;
    };
    combat: {
      lastPunch?: unknown;
      diagnostics(): { punches: number };
      targets: { get(id: string): { position: { y: number }; radius: number } | undefined };
    };
    crowd: { agents: { extent: number; active: Uint8Array; idOf(i: number): string } };
    progression: { witnesses: { size: number; has(id: string): boolean } };
    dayNight: { setTimeOfDay(t: number): void };
    sky?: { update(b: unknown, f: boolean): void };
    hud: { show(name: string): void; update(dt: number): void };
    proveAlliesCanLose(): {
      genos: { before: number; after: number; dead: boolean };
      mumen: { before: number; after: number; dead: boolean };
      downedEvents: number;
      waves: number;
    };
    save(): Promise<void>;
    load(): Promise<boolean>;
  };
}

const diag = (page: Page): Promise<IDiag> =>
  page.evaluate(() => window.__GAME_DIAG__ as unknown as IDiag);

/** The camera rig's own heading, in degrees. */
const cameraYawDeg = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const game = (window as unknown as IGameWindow).__GAME__;
    return ((game?.player.camera.diagnostics().yaw ?? Number.NaN) * 180) / Math.PI;
  });

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

/** Log and flush. A run this long is unobservable through a buffered pipe. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const notes: string[] = [];

  if (!existsSync(DIST)) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });

  const served = await serveDist();
  const base = `http://127.0.0.1:${served.port}/`;
  say(`serving dist/ at ${base}`);

  let browser: Browser | undefined;
  const consoleErrors: string[] = [];
  const shots: IShotReport[] = [];

  try {
    browser = await chromium.launch({
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    const shoot = async (name: string): Promise<IShotReport> => {
      const file = path.join(OUT_DIR, `${name}.png`);
      await page.screenshot({ path: file, type: 'png', timeout: 180_000 });
      const report = await analyse(name, file);
      shots.push(report);
      say(
        `  shot ${name}: stdDev ${report.stdDev.toFixed(1)} colors ${report.colors}` +
          (report.blank ? '  <-- BLANK' : '')
      );
      if (report.blank) failures.push(`screenshot "${name}" is blank`);
      return report;
    };

    /* ================= BOOT ================= */
    say('\n[1] boot');
    const wallStart = Date.now();
    await page.goto(`${base}?tier=high&nosave=1`, { waitUntil: 'load', timeout: 180_000 });
    await page.waitForFunction(() => window.__GAME_READY__ === true, undefined, {
      timeout: 180_000,
    });
    const wallMs = Date.now() - wallStart;
    const booted = await diag(page);
    say(`  __GAME_READY__ after ${booted.bootTimeMs} ms (wall ${wallMs} ms)`);
    say(`  boot phases ${JSON.stringify(booted.boot)}`);
    if (booted.bootTimeMs > BOOT_BUDGET_MS) {
      failures.push(`boot took ${booted.bootTimeMs} ms, budget ${BOOT_BUDGET_MS} ms`);
    }
    if (booted.quality !== 'high') failures.push(`render tier is '${booted.quality}', wanted high`);

    const bridge = await page.evaluate(() => window.__INPUT__?.version ?? -1);
    if (bridge < 0) failures.push('window.__INPUT__ was not installed');
    say(`  input bridge v${bridge}`);

    await frames(page, 20);
    await shoot('integration-01-spawn');

    /* ================= TRAVERSE ================= */
    say('\n[2] traverse City Z');
    const spawnAt = await page.evaluate(() => {
      const p = (window.__GAME_DIAG__ as unknown as IDiag).world.playerPosition as {
        x: number;
        z: number;
      };
      return { x: p.x, z: p.z };
    });
    await page.evaluate(() => {
      window.__INPUT__!.enable();
      window.__INPUT__!.setMove(0, 1);
      window.__INPUT__!.press('sprint');
    });
    // 45 frames of dash, not 90. On SwiftShader a chunk-boundary crossing is a
    // 500-800 ms main-thread stall while `CityGenerator` builds the next chunk,
    // and a 22 m/s dash crosses one every four seconds. Reported in the notes
    // rather than hidden — it is the real cost of generating city chunks on the
    // main thread.
    await frames(page, 45);
    const moved = await page.evaluate(() => {
      const p = (window.__GAME_DIAG__ as unknown as IDiag).world.playerPosition as {
        x: number;
        z: number;
      };
      return { x: p.x, z: p.z };
    });
    const travelled = Math.hypot(moved.x - spawnAt.x, moved.z - spawnAt.z);
    say(
      `  player at (${moved.x.toFixed(1)}, ${moved.z.toFixed(1)}) — ` +
        `${travelled.toFixed(1)} m from spawn`
    );
    // ASSERTED, because "the screenshot was not blank" is true of a player who
    // never moved. The clock is capped at MAX_DELTA (1/15 s), so 45 frames is
    // about three seconds of game time; a 22 m/s dash covers ~66 m and even a
    // walk covers a dozen. 5 m is a floor for "locomotion is wired", not a
    // measurement of the dash.
    const TRAVERSE_FLOOR_M = 5;
    if (travelled < TRAVERSE_FLOOR_M) {
      failures.push(
        `45 frames of sprint moved the player ${travelled.toFixed(1)} m ` +
          `(floor ${TRAVERSE_FLOOR_M} m) — locomotion is not being driven`
      );
    }
    // STOP AND SETTLE BEFORE FRAMING ANYTHING. The baseline used to be captured
    // mid-dash and compared against a shot taken from a standstill, so most of
    // what separated the pair was the deceleration between them: the speed FOV
    // relaxing, the arm re-extending and the player coasting several metres.
    // Measured, that confound is worth ~64 points of band mean and ~70 points of
    // per-pixel difference — larger than the turn it was supposed to be
    // measuring. Settling first makes the pair differ by the TURN and nothing
    // else (the same window with no look input moves the band mean by 0.6 and
    // the pixels by 6.5).
    await page.evaluate(() => {
      window.__INPUT__!.setMove(0, 0);
      window.__INPUT__!.release('sprint');
    });
    await frames(page, 20);
    await shoot('integration-02a-pre-turn');
    const BAND = { left: 0, top: 200, width: VIEWPORT.width, height: 500 };
    const upperBefore = await regionMean(path.join(OUT_DIR, 'integration-02a-pre-turn.png'), BAND);

    // ══════════════════════════════════════════════════════════════════════
    //  TURN A QUARTER TURN — MEASURED ON THE CAMERA, NOT COUNTED IN FRAMES
    // ══════════════════════════════════════════════════════════════════════
    // `look` is a RATE: `setLook(1, 0)` is `lookFullRateDegPerSec` (220 °/s)
    // for as long as it stays latched, and the clock clamps `dt` to MAX_DELTA
    // (1/15 s). Every SwiftShader frame here is far slower than that, so each
    // one is a full 66.7 ms of game time — 14.7 degrees. A fixed count of 40
    // was therefore not "a turn" at all but 587 degrees, one and a half
    // revolutions, and where it stopped was a function of how many frames the
    // host managed to schedule: land near a multiple of 360 and the camera
    // comes back to the heading it started from, which is indistinguishable
    // from a camera that never turned. That is exactly how this read as
    // "the camera did not turn" while the rig was in fact sweeping 546°.
    //
    // So the drive is bounded by the ANGLE the camera actually reports, and
    // the frame count is only a safety net. A quarter turn is a real change of
    // view that cannot wrap onto itself.
    const TURN_TARGET_DEG = 90;
    // A STALL GUARD, not a budget. Every frame here is a clamped 66.7 ms of
    // game time, so the target is reached in about seven; the cap only exists
    // so a camera that ignores `setLook` fails instead of looping forever, and
    // it is loose enough that even an unthrottled 60 Hz loop (3.7 degrees a
    // frame) still gets there.
    const TURN_FRAME_CAP = 60;
    let lastYaw = await cameraYawDeg(page);
    const yawBefore = lastYaw;
    // Accumulated per FRAME, so it is monotone and immune to wrapping: the
    // total is what turned, not where it ended up.
    let swept = 0;
    let turnFrames = 0;
    await page.evaluate(() => window.__INPUT__!.setLook(1, 0));
    while (swept < TURN_TARGET_DEG && turnFrames < TURN_FRAME_CAP) {
      await frames(page, 1);
      turnFrames++;
      const yawNow = await cameraYawDeg(page);
      if (!Number.isFinite(yawNow)) break;
      swept += Math.abs(shortestAngleDeg(yawNow, lastYaw));
      lastYaw = yawNow;
    }
    await page.evaluate(() => window.__INPUT__!.setLook(0, 0));
    await frames(page, 20);
    await shoot('integration-02-traverse');

    // PROOF 1: the look input reached the camera. This is the whole chain —
    // `window.__INPUT__` -> synthetic backend -> `InputManager` axis merge ->
    // `InputState.look` -> `ThirdPersonCameraRig.readLook` — read off the rig's
    // own diagnostics rather than inferred from pixels.
    say(
      `  camera yaw ${yawBefore.toFixed(1)} -> ${lastYaw.toFixed(1)} deg, ` +
        `${swept.toFixed(1)} deg swept over ${turnFrames} look frames`
    );
    if (!(swept >= TURN_TARGET_DEG)) {
      failures.push(
        `${turnFrames} frames of look input swept the camera ${swept.toFixed(1)} deg ` +
          `(wanted ${TURN_TARGET_DEG}) — the camera did not turn`
      );
    }

    // PROOF 2: the rendered frame followed it. A yaw counter can move while the
    // scene is drawn from a stale transform, so the same band on both shots has
    // to actually be different pixels. Compared per pixel, NOT as two means:
    // the avenue is lined with facades on both sides, so a turn can leave the
    // band's average almost untouched — the failing measurement moved it by
    // 1.37 across a 546-degree sweep. The floor for this pair, measured with
    // the look input never set, is ~6.5; a quarter turn measures ~83.
    const upper = await regionMean(path.join(OUT_DIR, 'integration-02-traverse.png'), BAND);
    const framingDiff = await regionDiff(
      path.join(OUT_DIR, 'integration-02a-pre-turn.png'),
      path.join(OUT_DIR, 'integration-02-traverse.png'),
      BAND
    );
    const FRAMING_DIFF_FLOOR = 20;
    say(
      `  upper frame: mean ${upperBefore.toFixed(1)} -> ${upper.toFixed(1)}, ` +
        `per-pixel difference ${framingDiff.toFixed(1)}`
    );
    notes.push(
      `the turn swept ${swept.toFixed(1)} deg and changed the upper frame by ` +
        `${framingDiff.toFixed(1)} per pixel (mean ${upperBefore.toFixed(1)} -> ${upper.toFixed(1)})`
    );
    if (!(framingDiff >= FRAMING_DIFF_FLOOR)) {
      failures.push(
        `a ${swept.toFixed(1)} deg camera turn changed the upper frame by ` +
          `${framingDiff.toFixed(1)} per pixel (floor ${FRAMING_DIFF_FLOOR}) — ` +
          `the render is not following the camera`
      );
    }

    /* ================= ENCOUNTER + NORMAL PUNCH ================= */
    say('\n[3] encounter and normal punch');
    const spawned = await page.evaluate(() => {
      const game = (window as unknown as IGameWindow).__GAME__;
      // A real id from `MONSTER_ARCHETYPES`. `mob.tiger.brute` is 2.35 m tall
      // with a 0.85 m footprint, so the aim-point assertion below has a lift
      // (1.175 m) and a radius (0.987 m) that are visibly different from the
      // monster's own position and footprint — which is the whole point.
      return game?.spawnEncounter('mob.tiger.brute', 3.0) ?? undefined;
    });
    say(`  spawned ${String(spawned)}`);
    if (spawned === undefined) failures.push('could not spawn a monster');
    await frames(page, 10);

    // FIX 2 PROOF: the registered aim point must sit half a body above the
    // monster's feet, and the hit radius must be the torso, not the footprint.
    const aim = await page.evaluate(() => {
      const game = (window as unknown as IGameWindow).__GAME__;
      if (!game) return [];
      return game.monsters.describeForCombat().map((d) => {
        const monster = game.monsters.get(d.id)!;
        const target = game.combat.targets.get(d.id);
        return {
          id: d.id,
          feetY: monster.brain.position.y,
          aimY: target?.position.y ?? Number.NaN,
          radius: target?.radius ?? Number.NaN,
          height: monster.archetype.bodyHeightMetres,
          footprintRadius: monster.archetype.radiusMetres,
        };
      });
    });
    say(`  aim points ${JSON.stringify(aim)}`);
    for (const entry of aim) {
      const wantedLift = entry.height * 0.5;
      const wantedRadius = Math.max(entry.footprintRadius, entry.height * 0.42);
      if (Math.abs(entry.aimY - entry.feetY - wantedLift) > 1e-3) {
        failures.push(
          `FIX 2: ${entry.id} aim lift ${(entry.aimY - entry.feetY).toFixed(3)} m, wanted ${wantedLift.toFixed(3)} m`
        );
      }
      if (Math.abs(entry.radius - wantedRadius) > 1e-3) {
        failures.push(
          `FIX 2: ${entry.id} radius ${entry.radius.toFixed(3)} m, wanted ${wantedRadius.toFixed(3)} m`
        );
      }
    }

    // Face it, close to punching range, then tap.
    await page.evaluate(() => {
      const game = (window as unknown as IGameWindow).__GAME__;
      game?.faceNearestMonster();
    });
    await frames(page, 5);
    // (No kill counter is read here: `window.__KILLS__` is not installed by any
    // build in this repository, so the reading was a constant 0 that was then
    // `void`ed. The kill this beat cares about is proved by `monsters left`.)
    await page.evaluate(() => window.__INPUT__!.tap('punch'));
    await frames(page, 30);
    const punch = await page.evaluate(() => {
      const game = (window as unknown as IGameWindow).__GAME__;
      return {
        punches: game?.combat.diagnostics().punches ?? 0,
        monsters: game?.monsters.count ?? 0,
      };
    });
    say(`  punches ${punch.punches}, monsters left ${punch.monsters}`);
    if (punch.punches < 1) failures.push('normal punch did not resolve');
    await shoot('integration-03-punch');

    /* ================= SERIOUS PUNCH ================= */
    say('\n[4] charge and fire a Serious Punch into a block');
    await page.evaluate(() => {
      const game = (window as unknown as IGameWindow).__GAME__;
      game?.faceNearestStructure();
    });
    await frames(page, 5);
    await page.evaluate(() => window.__INPUT__!.press('punch'));
    // The charge completes at 1.2 s of GAME time. Frames here are far longer
    // than 16 ms, so 90 of them is several seconds of hold — well past full.
    await frames(page, 90);
    await shoot('integration-04-charging');
    await page.evaluate(() => window.__INPUT__!.release('punch'));
    await frames(page, 8);
    await shoot('integration-05-serious-punch');
    await frames(page, 90);
    await shoot('integration-06-collapse');

    const destruction = await diag(page);
    say(
      `  chunks detached ${String(destruction.world.chunksDetached)}, debris live ${String(destruction.world.debrisLive)}`
    );
    if ((destruction.world.chunksDetached as number) < 1) {
      failures.push('Serious Punch detached no structure chunks');
    }

    /* ================= ALLIES CAN LOSE ================= */
    say('\n[5] can the allies actually be downed');
    const ally = await page.evaluate(async () => {
      const game = (window as unknown as IGameWindow).__GAME__;
      return game?.proveAlliesCanLose() ?? null;
    });
    say(`  ${JSON.stringify(ally)}`);
    if (ally === null) failures.push('FIX 4: ally proof unavailable');
    else {
      if (!ally.mumen.dead)
        failures.push('FIX 4: Mumen Rider survived a sustained dragon-tier barrage');
      if (!ally.genos.dead) failures.push('FIX 4: Genos survived a sustained dragon-tier barrage');
      if (ally.downedEvents < 2)
        failures.push(`FIX 4: only ${ally.downedEvents} AllyDowned events`);
    }

    /* ================= WITNESSES ================= */
    say('\n[6] crowd civilians are progression witnesses');
    const witness = await page.evaluate(() => {
      const game = (window as unknown as IGameWindow).__GAME__;
      if (!game) return null;
      const agents = game.crowd.agents;
      const ids: string[] = [];
      for (let i = 0; i < agents.extent && ids.length < 20; i++) {
        if (agents.active[i] === 0) continue;
        ids.push(String(agents.idOf(i)));
      }
      return {
        liveCivilians: ids.length,
        registered: ids.filter((id) => game.progression.witnesses.has(id)).length,
        fieldSize: game.progression.witnesses.size,
        heroesRegistered: ['hero-genos', 'hero-mumenRider'].filter((id) =>
          game.progression.witnesses.has(id)
        ).length,
      };
    });
    say(`  ${JSON.stringify(witness)}`);
    if (witness === null || witness.fieldSize < 10) {
      failures.push('FIX 3: progression witness field is not fed by the crowd');
    } else if (witness.registered < witness.liveCivilians) {
      failures.push(
        `FIX 3: ${witness.registered}/${witness.liveCivilians} sampled civilians are registered witnesses`
      );
    }
    if (witness !== null && witness.heroesRegistered < 2) {
      failures.push('FIX 3: allies are not registered as high-credibility witnesses');
    }

    /* ================= NIGHT ================= */
    say('\n[7] advance to night');
    const dayMean = await regionMean(path.join(OUT_DIR, 'integration-06-collapse.png'), {
      left: 0,
      top: 0,
      width: VIEWPORT.width,
      height: 400,
    });
    await page.evaluate(() => {
      const game = (window as unknown as IGameWindow).__GAME__;
      game?.dayNight.setTimeOfDay(0.92);
    });
    await frames(page, 40);
    await shoot('integration-07-night');
    const nightMean = await regionMean(path.join(OUT_DIR, 'integration-07-night.png'), {
      left: 0,
      top: 0,
      width: VIEWPORT.width,
      height: 400,
    });
    say(`  sky band day ${dayMean.toFixed(1)} -> night ${nightMean.toFixed(1)}`);
    if (nightMean >= dayMean) {
      failures.push(
        `night sky (${nightMean.toFixed(1)}) is not darker than day (${dayMean.toFixed(1)})`
      );
    }
    const phase = await page.evaluate(
      () => (window.__GAME_DIAG__ as unknown as IDiag).world.dayPhase as string
    );
    say(`  day phase: ${phase}`);

    /* ================= HUD SCREENS ================= */
    say('\n[8] HUD screens');
    for (const screen of ['pause', 'quests', 'rank', 'settings'] as const) {
      await page.evaluate((name) => {
        const game = (window as unknown as IGameWindow).__GAME__;
        game?.hud.show(name);
      }, screen);
      await frames(page, 12);
      const nodes = await page.evaluate(
        (name) => document.querySelectorAll(`[data-screen="${name}"]`).length,
        screen
      );
      if (nodes < 1) failures.push(`HUD screen "${screen}" did not mount`);
      await shoot(`integration-08-hud-${screen}`);
    }
    await page.evaluate(() => {
      const game = (window as unknown as IGameWindow).__GAME__;
      game?.hud.show('hud');
    });
    await frames(page, 10);

    /* ================= SAVE / LOAD ================= */
    say('\n[9] save and load through progression');
    const save = await page.evaluate(async () => {
      const game = (window as unknown as IGameWindow).__GAME__;
      if (!game) return null;
      await game.save();
      const loaded = await game.load();
      return { loaded };
    });
    say(`  ${JSON.stringify(save)}`);
    if (save === null || !save.loaded) failures.push('save/load round trip failed');

    /* ================= FINAL ================= */
    await frames(page, 60);
    const final = await diag(page);
    say('\n──────── final __GAME_DIAG__ ────────');
    say(JSON.stringify({ boot: final.boot, timings: final.timings, world: final.world }, null, 1));
    say(`systems online: ${final.systems.online.length}`);
    say(`systems skipped: ${JSON.stringify(final.systems.skipped, null, 1)}`);
    say(`systems failed: ${JSON.stringify(final.systems.failed, null, 1)}`);
    say(`diag errors: ${JSON.stringify(final.errors)}`);

    if (final.errors.length > 0)
      failures.push(`diagnostics recorded ${final.errors.length} errors`);
    if ((final.world.assetsMissing as number) > 0) {
      failures.push(`${String(final.world.assetsMissing)} assets fell back to the missing marker`);
    }

    /* ================= ANDROID TIER PIN (FIX 1) ================= */
    say('\n[10] FIX 1 — native shell pins the mobile asset tier');
    // BOTH arrays are reset, and the pre-existing misses are reported under
    // their own label first. `misses` used to survive the reset, so a 404 from
    // beat 1 — nine beats and ninety seconds earlier, on a different page —
    // came out as "FIX 1: 1 404s" and sent the reader to `isCapacitorNative()`.
    if (served.misses.length > 0) {
      failures.push(
        `${served.misses.length} asset 404s before the native page opened: ` +
          `${[...new Set(served.misses)].slice(0, 3).join(', ')}`
      );
    }
    served.requests.length = 0;
    served.misses.length = 0;
    const nativePage = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const nativeErrors: string[] = [];
    nativePage.on('console', (m) => {
      if (m.type() === 'error') nativeErrors.push(m.text());
    });
    nativePage.on('pageerror', (e) => nativeErrors.push(`pageerror: ${e.message}`));
    // `?native=1` is what `isCapacitorNative()` cannot see in a desktop browser:
    // it makes the boot claim the Capacitor shell so the pin can be observed.
    await nativePage.goto(`${base}?native=1&nosave=1`, { waitUntil: 'load', timeout: 180_000 });
    await nativePage.waitForFunction(() => window.__GAME_READY__ === true, undefined, {
      timeout: 180_000,
    });
    await frames(nativePage, 90);
    const nativeDiag = await diag(nativePage);
    // The TIER TOKEN, not `.ktx2`. The pipeline tiers models as well as
    // textures — `public/assets/mdl/` holds 206 `.high.*` files including
    // `.glb`, `.glb.json` and `.bin` sidecars — and these harnesses serve an
    // UNPRUNED `dist/`, so a high-tier model request returns 200 and does not
    // show up as a miss either.
    const wrongTier = served.requests.filter((p) => /\.(high|ultra)\./.test(p));
    const mobileTier = served.requests.filter((p) => /\.mobile\./.test(p));
    say(
      `  asset tier: ${String(nativeDiag.world.assetTier)} (${String(nativeDiag.world.assetTierReason)})`
    );
    say(`  requests for a non-packaged tier: ${wrongTier.length}`);
    say(`  requests carrying the mobile token: ${mobileTier.length}`);
    notes.push(`native page requested ${mobileTier.length} mobile-tier files`);
    say(`  404s: ${served.misses.length}`);
    if (nativeDiag.world.assetTier !== 'mobile') {
      failures.push(`FIX 1: native shell selected '${String(nativeDiag.world.assetTier)}'`);
    }
    if (wrongTier.length > 0) {
      failures.push(
        `FIX 1: ${wrongTier.length} requests for high/ultra files: ${wrongTier.slice(0, 3).join(', ')}`
      );
    }
    if (served.misses.length > 0) {
      failures.push(`FIX 1: ${served.misses.length} 404s: ${served.misses.slice(0, 3).join(', ')}`);
    }
    await nativePage.screenshot({
      path: path.join(OUT_DIR, 'integration-09-native-mobile-tier.png'),
      timeout: 180_000,
    });
    // GATED, like every capture on the primary page. This one bypassed `shoot()`
    // because it targets a second page, and with it lost the only check
    // `analyse()` exists for: a native shell that boots to a black frame still
    // flips `__GAME_READY__`, still reports `assetTier: 'mobile'`, and used to
    // have its `"blank": true` written into the report and then ignored.
    const nativeShot = await analyse(
      'integration-09-native-mobile-tier',
      path.join(OUT_DIR, 'integration-09-native-mobile-tier.png')
    );
    shots.push(nativeShot);
    say(
      `  shot ${nativeShot.name}: stdDev ${nativeShot.stdDev.toFixed(1)} colors ${nativeShot.colors}` +
        (nativeShot.blank ? '  <-- BLANK' : '')
    );
    if (nativeShot.blank) failures.push(`screenshot "${nativeShot.name}" is blank`);
    consoleErrors.push(...nativeErrors);
    await nativePage.close();

    await writeFile(
      path.join(OUT_DIR, 'integration-report.json'),
      JSON.stringify(
        { boot: final.boot, timings: final.timings, world: final.world, shots, notes },
        null,
        2
      )
    );
  } finally {
    await browser?.close();
    served.server.close();
  }

  if (consoleErrors.length > 0) {
    failures.push(
      `${consoleErrors.length} console errors: ${consoleErrors.slice(0, 5).join(' | ')}`
    );
  }
  if (served.errors.length > 0) {
    failures.push(
      `${served.errors.length} requests threw in the harness server: ` +
        `${served.errors.slice(0, 3).join(' | ')}`
    );
  }

  say('\n──────── notes ────────');
  for (const note of notes) say(`  ${note}`);

  say('\n──────── result ────────');
  if (failures.length > 0) {
    console.error('INTEGRATION VERIFICATION FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  say('INTEGRATION VERIFICATION PASSED');
}

main().catch((error) => {
  console.error('integration verification crashed:', error);
  process.exit(1);
});
