/**
 * PLAYER HARNESS DRIVER
 *
 * Serves `harness/player.html` through Vite, drives it with headless Chromium,
 * reads the measurements the page publishes, screenshots the four captured
 * poses and asserts on all of it.
 *
 *   npx tsx harness/player.verify.ts
 *
 * Exit 0 = pass, 1 = fail.
 *
 * ── WHY THE SCREENSHOTS ARE CHECKED, NOT JUST TAKEN ────────────────────────
 * A WebGL page that throws still "loads" and still screenshots, as a flat
 * fill. Each pose image is read back and its pixel statistics asserted:
 * standard deviation above 10 and a healthy count of distinct colours. That is
 * the difference between proving the camera framed a leap and proving a web
 * server answered.
 *
 * ── WHY NO FPS ─────────────────────────────────────────────────────────────
 * Chromium rasterises through SwiftShader on the CPU here, so any frame rate
 * would measure a software renderer. The controller, camera and solver run on
 * a real CPU and ARE measured, in milliseconds.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOT_DIR = path.join(ROOT, 'docs', 'screenshots');

const VIEWPORT = { width: 1280, height: 800 };
/**
 * The scenarios build ~30 Rapier worlds and simulate ~20 000 frames. The work
 * itself is ~40 s; the rest is headroom for a box running several agents'
 * SwiftShader harnesses at once.
 */
const READY_TIMEOUT_MS = 900_000;

/** Poses the page captures, in the order they happen in a playthrough. */
const POSES = ['run', 'charge', 'apex', 'alley', 'hardland'] as const;

/* -------------------------------------------------------------------------- */
/* Result shape — mirrors harness/player.ts                                   */
/* -------------------------------------------------------------------------- */

interface MirrorCheck {
  name: string;
  player: number;
  source: number;
  match: boolean;
}

interface SpeedResult {
  target: number;
  topSpeed: number;
  timeTo90PctSec: number;
  timeToMaxSec: number;
  distanceM: number;
}

interface Pose {
  name: string;
  label: string;
  detail: string;
  armLength: number;
  fov: number;
}

interface HarnessReport {
  seed: string;
  mirrors: MirrorCheck[];
  run: SpeedResult;
  dash: SpeedResult;
  jump: {
    tapApexM: number;
    heldApexM: number;
    predictedHeldApexM: number;
    physicsSingleShotApexM: number;
    tapCreatesCrater: boolean;
    heldCreatesCrater: boolean;
    airborneSecondsHeld: number;
  };
  landing: {
    fallHeightM: number;
    impactSpeedMps: number;
    createsCrater: boolean;
    fromBus: boolean;
    recoverySeconds: number;
    measuredHardLandSeconds: number;
    playerLandedEvents: number;
    groundSlamAffected: number;
    speedRetention: number;
  };
  coyote: {
    tunedWindowSec: number;
    physicsWindowSec: number;
    lastAcceptedFrames: number;
    lastAcceptedMs: number;
    firstRejectedFrames: number;
    firstRejectedMs: number;
  };
  buffer: {
    tunedWindowSec: number;
    earliestAcceptedFrames: number;
    earliestAcceptedMs: number;
    tooEarlyFrames: number;
    latencyFrames: number;
  };
  camera: {
    restingArmM: number;
    chargingArmM: number;
    apexArmM: number;
    armAtJumpApexM: number;
    apexHeightAtSampleM: number;
    fovAtRestDeg: number;
    fovAtDashDeg: number;
    orbitDegPerSec: number;
    orbitTargetDegPerSec: number;
    impactLagPeakM: number;
    impactLagFrames: number;
    fovSuspendedFrames: number;
    fovAfterExternalOverride: number;
  };
  clearance: {
    frames: number;
    minClearanceM: number;
    minArmM: number;
    penetrationFrames: number;
    maxPenetrationM: number;
    occludedFrames: number;
    alleyWidthM: number;
    minPivotClearanceM: number;
  };
  determinism: {
    values: number;
    maxDelta: number;
    identical: boolean;
    differentScriptDelta: number;
  };
  timings: {
    frames: number;
    wholeFrameMs: number;
    cameraOnlyMs: number;
    physicsStepMs: number;
    controllerAndSolverMs: number;
    method: string;
  };
  render: {
    drawCalls: number;
    triangles: number;
    width: number;
    height: number;
    characterTriangles: number;
    proceduralCharacter: boolean;
  };
  poses: Pose[];
  errors: string[];
}

interface PixelReport {
  file: string;
  width: number;
  height: number;
  stdDev: number;
  mean: number;
  distinctColors: number;
  nonBackgroundFraction: number;
}

/* -------------------------------------------------------------------------- */
/* Screenshot analysis                                                        */
/* -------------------------------------------------------------------------- */

async function analyseScreenshot(file: string): Promise<PixelReport> {
  const image = sharp(file);
  const meta = await image.metadata();
  const stats = await image.stats();

  const colorChannels = stats.channels.slice(0, 3);
  const stdDev = colorChannels.reduce((sum, c) => sum + c.stdev, 0) / colorChannels.length;
  const mean = colorChannels.reduce((sum, c) => sum + c.mean, 0) / colorChannels.length;

  const raw = await sharp(file).resize(96, 96, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const seen = new Set<number>();
  let nonBackground = 0;
  let sampled = 0;
  let modeKey = -1;
  const counts = new Map<number, number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const key = (raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!;
    seen.add(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    sampled++;
  }
  let best = -1;
  for (const [key, count] of counts) {
    if (count > best) {
      best = count;
      modeKey = key;
    }
  }
  for (const [key, count] of counts) if (key !== modeKey) nonBackground += count;

  return {
    file,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    stdDev,
    mean,
    distinctColors: seen.size,
    nonBackgroundFraction: sampled === 0 ? 0 : nonBackground / sampled,
  };
}

function fmt(value: number, digits = 3): string {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });

  const server: ViteDevServer = await createServer({
    root: ROOT,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address !== null ? address.port : 5173;
  const pageUrl = `http://127.0.0.1:${port}/harness/player.html`;

  const failures: string[] = [];
  let report: HarnessReport | undefined;
  const pixels: PixelReport[] = [];
  let browser: Browser | undefined;

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

    const page: Page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(pageUrl, { waitUntil: 'load', timeout: 180_000 });
    await page.waitForFunction(() => window.__PLAYER_READY__ === true, undefined, {
      timeout: READY_TIMEOUT_MS,
    });

    report = (await page.evaluate(() => window.__PLAYER_HARNESS__)) as HarnessReport | undefined;

    for (const pose of POSES) {
      const shown = await page.evaluate((name) => window.__PLAYER_SHOT__?.(name) ?? false, pose);
      if (!shown) {
        failures.push(`pose "${pose}" was never captured by the harness`);
        continue;
      }
      const file = path.join(SHOT_DIR, `player-${pose}.png`);
      await page.screenshot({ path: file, type: 'png' });
      pixels.push(await analyseScreenshot(file));
    }

    /* ----------------------------- assertions ---------------------------- */
    if (report === undefined) {
      failures.push('window.__PLAYER_HARNESS__ was never populated');
    } else if (report.run === undefined) {
      failures.push(
        `harness aborted before publishing results: ${report.errors?.join(' | ') || 'no detail'}`
      );
    } else {
      if (report.errors.length > 0) {
        failures.push(`harness reported errors: ${report.errors.join(' | ')}`);
      }

      // Mirrored constants: a drift here is a silent feel regression.
      for (const mirror of report.mirrors) {
        if (!mirror.match) {
          failures.push(
            `tuning drift: ${mirror.name} is ${mirror.player} but the source module says ` +
              `${mirror.source}`
          );
        }
      }

      // Speed.
      if (Math.abs(report.run.topSpeed - report.run.target) > 0.15) {
        failures.push(`run top speed ${report.run.topSpeed} m/s, expected ~${report.run.target}`);
      }
      if (Math.abs(report.dash.topSpeed - report.dash.target) > 0.35) {
        failures.push(`dash top speed ${report.dash.topSpeed} m/s, expected ~${report.dash.target}`);
      }
      if (report.run.timeTo90PctSec <= 0 || report.run.timeTo90PctSec > 0.35) {
        failures.push(`run reaches 90% in ${report.run.timeTo90PctSec}s — too sluggish`);
      }

      // Jump.
      const j = report.jump;
      if (j.tapApexM >= 15) failures.push(`a tapped jump reached ${j.tapApexM} m — it would crater`);
      if (j.tapApexM < 8) failures.push(`a tapped jump only reached ${j.tapApexM} m`);
      if (j.heldApexM < 20) failures.push(`a held leap only reached ${j.heldApexM} m`);
      if (Math.abs(j.heldApexM - j.predictedHeldApexM) > 1.5) {
        failures.push(
          `held apex ${j.heldApexM} m does not match the tuning's prediction ` +
            `${j.predictedHeldApexM} m`
        );
      }
      if (j.tapCreatesCrater) failures.push('a tapped hop cratered the ground');
      if (!j.heldCreatesCrater) failures.push('a full leap did NOT crater the ground');

      // Landing.
      const l = report.landing;
      if (!l.createsCrater) failures.push('the hard landing did not register as a ground slam');
      if (!l.fromBus) failures.push('the landing was not sourced from the physics PlayerLanded event');
      if (l.playerLandedEvents < 1) failures.push('no PlayerLanded event was emitted');
      if (l.groundSlamAffected < 0) failures.push('ground-slam reporting is broken');
      if (l.measuredHardLandSeconds < l.recoverySeconds - 0.05) {
        failures.push(
          `hard-landing recovery lasted ${l.measuredHardLandSeconds}s but was tuned for ` +
            `${l.recoverySeconds}s`
        );
      }
      if (l.speedRetention > 0.6) {
        failures.push(`a crater kept ${fmt(l.speedRetention * 100, 0)}% of the run speed`);
      }

      // Coyote.
      const c = report.coyote;
      if (c.lastAcceptedFrames < 1) failures.push('coyote time never accepted a jump');
      if (c.firstRejectedFrames < 0) {
        failures.push('coyote time accepted every delay — the window is not bounded');
      }
      if (c.lastAcceptedMs > c.tunedWindowSec * 1000 + 40) {
        failures.push(
          `coyote window measured ${c.lastAcceptedMs} ms, far above the tuned ` +
            `${c.tunedWindowSec * 1000} ms`
        );
      }

      // Buffering.
      const b = report.buffer;
      if (b.earliestAcceptedFrames < 4) {
        failures.push(`jump buffering only reached back ${b.earliestAcceptedFrames} frames`);
      }
      if (b.latencyFrames > 3) {
        failures.push(`a buffered jump took ${b.latencyFrames} frames to fire after touchdown`);
      }

      // Camera.
      const cam = report.camera;
      if (Math.abs(cam.restingArmM - 4.5) > 0.15) {
        failures.push(`resting arm ${cam.restingArmM} m, expected 4.5`);
      }
      if (Math.abs(cam.chargingArmM - 9) > 0.4) {
        failures.push(`charging arm ${cam.chargingArmM} m, expected 9`);
      }
      if (Math.abs(cam.armAtJumpApexM - cam.apexArmM) > 1.2) {
        failures.push(
          `arm at jump apex ${cam.armAtJumpApexM} m, expected ~${cam.apexArmM} ` +
            `(height at sample ${cam.apexHeightAtSampleM} m)`
        );
      }
      if (Math.abs(cam.fovAtRestDeg - 55) > 1) {
        failures.push(`resting FOV ${cam.fovAtRestDeg}°, expected 55`);
      }
      if (Math.abs(cam.fovAtDashDeg - 72) > 1.5) {
        failures.push(`dash FOV ${cam.fovAtDashDeg}°, expected 72`);
      }
      if (Math.abs(cam.orbitDegPerSec - cam.orbitTargetDegPerSec) > 4) {
        failures.push(
          `orbit rate ${cam.orbitDegPerSec}°/s, expected ${cam.orbitTargetDegPerSec} — ` +
            `\`look\` is a RATE, not a delta`
        );
      }
      if (cam.impactLagFrames < 5) {
        failures.push(`impact lag lasted ${cam.impactLagFrames} frames — it never engaged`);
      }
      if (cam.fovSuspendedFrames < 10) {
        failures.push('the camera kept writing FOV while another system owned it');
      }

      // Clearance — the assertion that matters most.
      const cl = report.clearance;
      if (cl.frames < 100) failures.push(`clearance sweep only ran ${cl.frames} frames`);
      if (cl.penetrationFrames > 0) {
        failures.push(
          `CAMERA PENETRATED GEOMETRY on ${cl.penetrationFrames}/${cl.frames} frames ` +
            `(worst ${cl.maxPenetrationM} m)`
        );
      }
      if (cl.occludedFrames < 20) {
        failures.push(
          `the arm was only occluded on ${cl.occludedFrames} frames — the alley test is not ` +
            `actually exercising the collision sweep`
        );
      }
      if (cl.minClearanceM <= 0.02) {
        failures.push(`camera came within ${cl.minClearanceM} m of a surface`);
      }

      // Determinism.
      const d = report.determinism;
      if (!d.identical || d.maxDelta !== 0) {
        failures.push(
          `NON-DETERMINISTIC: the same script produced max |delta| ${d.maxDelta} across ` +
            `${d.values} values`
        );
      }
      if (d.differentScriptDelta <= 1e-6) {
        failures.push('a different script produced an identical result — the comparison is blind');
      }

      // Render.
      if (report.render.triangles < 500) {
        failures.push(`suspiciously few triangles (${report.render.triangles})`);
      }
    }

    // Screenshots.
    for (const pixel of pixels) {
      const name = path.basename(pixel.file);
      if (pixel.stdDev <= 10) {
        failures.push(`${name} looks blank: stdDev ${fmt(pixel.stdDev, 2)} (needs > 10)`);
      }
      if (pixel.distinctColors < 100) {
        failures.push(`${name} has only ${pixel.distinctColors} distinct colours (needs > 100)`);
      }
      if (pixel.nonBackgroundFraction < 0.05) {
        failures.push(`${name} is almost entirely one colour — nothing was drawn`);
      }
    }
    if (consoleErrors.length > 0) {
      failures.push(`console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
    }
  } finally {
    await browser?.close();
    await server.close();
  }

  /* -------------------------------- report -------------------------------- */
  if (report !== undefined && report.run !== undefined) {
    const r = report;
    console.log('\n════════ PLAYER HARNESS ════════');
    console.log(`seed                 ${r.seed}`);
    console.log(
      `character            ${r.render.proceduralCharacter ? 'Saitama' : 'capsule proxy'}, ` +
        `${r.render.characterTriangles} tris`
    );

    console.log('\n── mirrored constants ──');
    for (const m of r.mirrors) {
      console.log(`${m.name.padEnd(22)}${m.player}  vs  ${m.source}  ${m.match ? 'ok' : 'DRIFT'}`);
    }

    console.log('\n── locomotion ──');
    console.log(
      `run                  ${fmt(r.run.topSpeed)} m/s (target ${r.run.target}) · ` +
        `90% in ${fmt(r.run.timeTo90PctSec)} s · max in ${fmt(r.run.timeToMaxSec)} s`
    );
    console.log(
      `dash                 ${fmt(r.dash.topSpeed)} m/s (target ${r.dash.target}) · ` +
        `90% in ${fmt(r.dash.timeTo90PctSec)} s`
    );
    console.log(
      `jump apex            tap ${fmt(r.jump.tapApexM, 2)} m · held ${fmt(r.jump.heldApexM, 2)} m ` +
        `(tuning predicts ${fmt(r.jump.predictedHeldApexM, 2)}, a single-shot launch would be ` +
        `${fmt(r.jump.physicsSingleShotApexM, 2)})`
    );
    console.log(
      `airtime (held leap)  ${fmt(r.jump.airborneSecondsHeld, 2)} s · craters: ` +
        `tap ${r.jump.tapCreatesCrater}, held ${r.jump.heldCreatesCrater}`
    );
    console.log(
      `landing              ${fmt(r.landing.fallHeightM, 2)} m at ` +
        `${fmt(r.landing.impactSpeedMps, 2)} m/s · crater ${r.landing.createsCrater} · ` +
        `moved ${r.landing.groundSlamAffected} bodies`
    );
    console.log(
      `landing recovery     tuned ${fmt(r.landing.recoverySeconds, 3)} s · measured ` +
        `${fmt(r.landing.measuredHardLandSeconds, 3)} s · kept ` +
        `${fmt(r.landing.speedRetention * 100, 0)}% of the run speed`
    );

    console.log('\n── forgiveness windows ──');
    console.log(
      `coyote               accepted up to ${fmt(r.coyote.lastAcceptedMs, 1)} ms after the ledge ` +
        `(${r.coyote.lastAcceptedFrames} frames), rejected at ` +
        `${fmt(r.coyote.firstRejectedMs, 1)} ms · tuned ${r.coyote.tunedWindowSec * 1000} ms`
    );
    console.log(
      `jump buffer          accepted up to ${fmt(r.buffer.earliestAcceptedMs, 1)} ms before ` +
        `touchdown (${r.buffer.earliestAcceptedFrames} frames), dropped at ` +
        `${r.buffer.tooEarlyFrames} frames · fires ${r.buffer.latencyFrames} frame(s) after contact`
    );

    console.log('\n── camera ──');
    console.log(
      `arm length           resting ${fmt(r.camera.restingArmM, 2)} m · charging ` +
        `${fmt(r.camera.chargingArmM, 2)} m · at apex ${fmt(r.camera.armAtJumpApexM, 2)} m ` +
        `(target ${r.camera.apexArmM}, sampled at ${fmt(r.camera.apexHeightAtSampleM, 1)} m up)`
    );
    console.log(
      `fov                  ${fmt(r.camera.fovAtRestDeg, 1)}° at rest → ` +
        `${fmt(r.camera.fovAtDashDeg, 1)}° at dash`
    );
    console.log(
      `orbit                ${fmt(r.camera.orbitDegPerSec, 1)}°/s at full look ` +
        `(target ${r.camera.orbitTargetDegPerSec})`
    );
    console.log(
      `impact lag           ${r.camera.impactLagFrames} frames engaged · peak positional ` +
        `offset ${fmt(r.camera.impactLagPeakM, 3)} m`
    );
    console.log(
      `fov cooperation      stood down for ${r.camera.fovSuspendedFrames} frames while another ` +
        `system held it; resumed at ${fmt(r.camera.fovAfterExternalOverride, 2)}°`
    );

    console.log('\n── camera vs geometry ──');
    console.log(
      `alley                ${r.clearance.alleyWidthM} m wide, ${r.clearance.frames} frames, ` +
        `arm occluded on ${r.clearance.occludedFrames}`
    );
    console.log(
      `penetration          ${r.clearance.penetrationFrames} frames ` +
        `(worst ${fmt(r.clearance.maxPenetrationM, 4)} m)`
    );
    console.log(
      `min clearance        ${fmt(r.clearance.minClearanceM, 3)} m camera-to-surface · ` +
        `${fmt(r.clearance.minPivotClearanceM, 3)} m pivot-to-surface`
    );
    console.log(`shortest arm         ${fmt(r.clearance.minArmM, 3)} m`);

    console.log('\n── determinism ──');
    console.log(
      `same script          max |delta| ${r.determinism.maxDelta} across ${r.determinism.values} ` +
        `values — ${r.determinism.identical ? 'EXACT' : 'DIVERGED'}`
    );
    console.log(`one frame changed    delta ${fmt(r.determinism.differentScriptDelta, 4)}`);

    console.log('\n── CPU (SwiftShader; no fps reported) ──');
    console.log(`whole frame          ${fmt(r.timings.wholeFrameMs, 4)} ms`);
    console.log(`  camera rig         ${fmt(r.timings.cameraOnlyMs, 4)} ms`);
    console.log(`  controller+solver  ${fmt(r.timings.controllerAndSolverMs, 4)} ms`);
    console.log(`  solver alone       ${fmt(r.timings.physicsStepMs, 4)} ms`);
    console.log(`method               ${r.timings.method}`);
  }

  if (pixels.length > 0) {
    console.log('\n── screenshots ──');
    for (const p of pixels) {
      console.log(
        `${path.basename(p.file).padEnd(24)}${p.width}x${p.height} · stdDev ` +
          `${fmt(p.stdDev, 2)} · ${p.distinctColors} colours · ` +
          `${fmt(p.nonBackgroundFraction * 100, 1)}% non-background`
      );
    }
  }

  console.log('\n════════ result ════════');
  if (failures.length > 0) {
    console.error('PLAYER HARNESS FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('PLAYER HARNESS PASSED');
}

main().catch((error: unknown) => {
  console.error('player harness crashed:', error);
  process.exit(1);
});
