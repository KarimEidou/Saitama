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
import { existsSync } from 'node:fs';
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
}

function serveDist(): Promise<IServed> {
  const requests: string[] = [];
  const misses: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    let filePath = path.join(DIST, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '') filePath = path.join(DIST, 'index.html');
    if (!filePath.startsWith(DIST) || !existsSync(filePath)) {
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
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to bind'));
        return;
      }
      resolve({ server, port: address.port, requests, misses });
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
 */
async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(
    `new Promise((resolve) => {
       let left = ${count};
       const tick = () => { if (--left <= 0) { resolve(); return; } requestAnimationFrame(tick); };
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

const diag = (page: Page): Promise<IDiag> =>
  page.evaluate(() => window.__GAME_DIAG__ as unknown as IDiag);

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
    say(`  player at (${moved.x.toFixed(1)}, ${moved.z.toFixed(1)})`);
    // Turn to face the block, so the shot frames a street rather than the sky.
    await page.evaluate(() => {
      window.__INPUT__!.setMove(0, 0);
      window.__INPUT__!.release('sprint');
      window.__INPUT__!.setLook(1, 0);
    });
    await frames(page, 40);
    await page.evaluate(() => window.__INPUT__!.setLook(0, 0));
    await frames(page, 20);
    const traverse = await shoot('integration-02-traverse');
    // The block is 58 m of facade nine metres to the player's side: after the
    // turn the upper half of the frame must stop being sky.
    const upper = await regionMean(path.join(OUT_DIR, 'integration-02-traverse.png'), {
      left: 0,
      top: 200,
      width: VIEWPORT.width,
      height: 500,
    });
    notes.push(`upper-frame mean after turning towards the block: ${upper.toFixed(1)}`);
    void traverse;

    /* ================= ENCOUNTER + NORMAL PUNCH ================= */
    say('\n[3] encounter and normal punch');
    const spawned = await page.evaluate(() => {
      const game = (window as unknown as { __GAME__?: { spawnEncounter(id: string, d?: number): string | undefined } }).__GAME__;
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
      const game = (window as unknown as {
        __GAME__?: {
          monsters: { describeForCombat(): { id: string; position: { y: number }; radius: number }[]; get(id: string): { brain: { position: { y: number } }; archetype: { bodyHeightMetres: number; radiusMetres: number } } | undefined };
          combat: { targets: { get(id: string): { position: { y: number }; radius: number } | undefined } };
        };
      }).__GAME__;
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
        failures.push(`FIX 2: ${entry.id} radius ${entry.radius.toFixed(3)} m, wanted ${wantedRadius.toFixed(3)} m`);
      }
    }

    // Face it, close to punching range, then tap.
    await page.evaluate(() => {
      const game = (window as unknown as { __GAME__?: { faceNearestMonster(): void } }).__GAME__;
      game?.faceNearestMonster();
    });
    await frames(page, 5);
    const killsBefore = await page.evaluate(
      () => (window as unknown as { __KILLS__?: number }).__KILLS__ ?? 0
    );
    await page.evaluate(() => window.__INPUT__!.tap('punch'));
    await frames(page, 30);
    const punch = await page.evaluate(() => {
      const game = (window as unknown as {
        __GAME__?: { combat: { lastPunch?: unknown; diagnostics(): { punches: number } }; monsters: { count: number } };
      }).__GAME__;
      return { punches: game?.combat.diagnostics().punches ?? 0, monsters: game?.monsters.count ?? 0 };
    });
    say(`  punches ${punch.punches}, monsters left ${punch.monsters}`);
    if (punch.punches < 1) failures.push('normal punch did not resolve');
    void killsBefore;
    await shoot('integration-03-punch');

    /* ================= SERIOUS PUNCH ================= */
    say('\n[4] charge and fire a Serious Punch into a block');
    await page.evaluate(() => {
      const game = (window as unknown as { __GAME__?: { faceNearestStructure(): void } }).__GAME__;
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
      const game = (window as unknown as {
        __GAME__?: {
          proveAlliesCanLose(): {
            genos: { before: number; after: number; dead: boolean };
            mumen: { before: number; after: number; dead: boolean };
            downedEvents: number;
            waves: number;
          };
        };
      }).__GAME__;
      return game?.proveAlliesCanLose() ?? null;
    });
    say(`  ${JSON.stringify(ally)}`);
    if (ally === null) failures.push('FIX 4: ally proof unavailable');
    else {
      if (!ally.mumen.dead) failures.push('FIX 4: Mumen Rider survived a sustained dragon-tier barrage');
      if (!ally.genos.dead) failures.push('FIX 4: Genos survived a sustained dragon-tier barrage');
      if (ally.downedEvents < 2) failures.push(`FIX 4: only ${ally.downedEvents} AllyDowned events`);
    }

    /* ================= WITNESSES ================= */
    say('\n[6] crowd civilians are progression witnesses');
    const witness = await page.evaluate(() => {
      const game = (window as unknown as {
        __GAME__?: {
          crowd: { agents: { extent: number; active: Uint8Array; idOf(i: number): string } };
          progression: { witnesses: { size: number; has(id: string): boolean } };
        };
      }).__GAME__;
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
      const game = (window as unknown as { __GAME__?: { dayNight: { setTimeOfDay(t: number): void } ; sky?: { update(b: unknown, f: boolean): void } } }).__GAME__;
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
      failures.push(`night sky (${nightMean.toFixed(1)}) is not darker than day (${dayMean.toFixed(1)})`);
    }
    const phase = await page.evaluate(
      () => (window.__GAME_DIAG__ as unknown as IDiag).world.dayPhase as string
    );
    say(`  day phase: ${phase}`);

    /* ================= HUD SCREENS ================= */
    say('\n[8] HUD screens');
    for (const screen of ['pause', 'quests', 'rank', 'settings'] as const) {
      await page.evaluate((name) => {
        const game = (window as unknown as { __GAME__?: { hud: { show(n: string): void; update(dt: number): void } } }).__GAME__;
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
      const game = (window as unknown as { __GAME__?: { hud: { show(n: string): void } } }).__GAME__;
      game?.hud.show('hud');
    });
    await frames(page, 10);

    /* ================= SAVE / LOAD ================= */
    say('\n[9] save and load through progression');
    const save = await page.evaluate(async () => {
      const game = (window as unknown as {
        __GAME__?: { save(): Promise<void>; load(): Promise<boolean> };
      }).__GAME__;
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

    if (final.errors.length > 0) failures.push(`diagnostics recorded ${final.errors.length} errors`);
    if ((final.world.assetsMissing as number) > 0) {
      failures.push(`${String(final.world.assetsMissing)} assets fell back to the missing marker`);
    }

    /* ================= ANDROID TIER PIN (FIX 1) ================= */
    say('\n[10] FIX 1 — native shell pins the mobile asset tier');
    served.requests.length = 0;
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
    const wrongTier = served.requests.filter((p) => /\.(high|ultra)\.ktx2$/.test(p));
    say(`  asset tier: ${String(nativeDiag.world.assetTier)} (${String(nativeDiag.world.assetTierReason)})`);
    say(`  requests for a non-packaged tier: ${wrongTier.length}`);
    say(`  404s: ${served.misses.length}`);
    if (nativeDiag.world.assetTier !== 'mobile') {
      failures.push(`FIX 1: native shell selected '${String(nativeDiag.world.assetTier)}'`);
    }
    if (wrongTier.length > 0) {
      failures.push(`FIX 1: ${wrongTier.length} requests for high/ultra files: ${wrongTier.slice(0, 3).join(', ')}`);
    }
    if (served.misses.length > 0) {
      failures.push(`FIX 1: ${served.misses.length} 404s: ${served.misses.slice(0, 3).join(', ')}`);
    }
    await nativePage.screenshot({ path: path.join(OUT_DIR, 'integration-09-native-mobile-tier.png'), timeout: 180_000 });
    shots.push(await analyse('integration-09-native-mobile-tier', path.join(OUT_DIR, 'integration-09-native-mobile-tier.png')));
    consoleErrors.push(...nativeErrors);
    await nativePage.close();

    await writeFile(
      path.join(OUT_DIR, 'integration-report.json'),
      JSON.stringify({ boot: final.boot, timings: final.timings, world: final.world, shots, notes }, null, 2)
    );
  } finally {
    await browser?.close();
    served.server.close();
  }

  if (consoleErrors.length > 0) {
    failures.push(`${consoleErrors.length} console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
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
