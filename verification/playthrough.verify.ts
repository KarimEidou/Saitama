/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE FINAL PLAYTHROUGH — boot to boss, one continuous session            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `integration.verify.ts` proves the systems compose. `soak.verify.ts` proves
 * the loop survives a long run. Neither one plays the game: nobody had yet
 * driven a single session from the loading screen to a monster standing over
 * an ally, photographed every beat on the way, and then LOOKED at the results.
 *
 * That is this file. One page, one boot, ten beats in order, a screenshot at
 * each, and a counted budget at the end.
 *
 * ── HOW IT DRIVES ──────────────────────────────────────────────────────────
 * `window.__INPUT__` — the synthetic input bridge every build installs,
 * production included. Never synthesised touch events: those exercise the
 * gesture recogniser, which is `harness/input`'s job. The bridge writes
 * `InputState` through the same `ButtonTracker` a thumb goes through, so a
 * 0.2 s charge really is a 0.2 s charge.
 *
 * The three scripted doors on `Game` — `spawnEncounter`, `faceNearestMonster`,
 * `faceNearestStructure` — place and aim. They are the deterministic entry the
 * composition root already exposes for exactly this; the spawn director's own
 * pacing decides when a fight happens, and a verification run cannot wait for
 * a die roll.
 *
 * ── WHAT IS ASSERTED, AND WHAT IS ONLY REPORTED ────────────────────────────
 * ASSERTED   zero console errors, zero page errors, zero diagnostic errors,
 *            zero 404s across the whole run; the loop still drawing at the
 *            end; chunks built AND evicted; a lethal tap firing the hit-stop;
 *            a Serious Punch detaching structure chunks; a monster engaging a
 *            HARMABLE ally; night darker than noon; the HUD screens mounting;
 *            the held jump clearing the district; the heap flat across laps.
 *
 * REPORTED   draw calls, triangles and texture bytes per tier against their
 *            budgets — breaches are printed as failures, never hidden, but the
 *            actual numbers are always printed first so the reader can see
 *            what the budget is being missed BY.
 *
 * NEVER      frame rate. The only GL here is SwiftShader, a CPU rasteriser
 *            running around one frame per second; any number derived from it
 *            says nothing whatsoever about a phone.
 *
 * ── THE `sharp` TRAP ───────────────────────────────────────────────────────
 * `sharp(file).extract(rect).stats()` DOES NOT CROP. `stats()` reads the input
 * and ignores the queued pipeline, so a region assertion written that way is
 * measuring the whole image and passes vacuously. Every region here is
 * materialised with `.toBuffer()` and re-opened. This has bitten three agents
 * on this project.
 *
 * Run: `npx tsx verification/playthrough.verify.ts`
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
const OUT = path.join(ROOT, 'verification');

/**
 * Portrait, phone-shaped, DPR 1.
 *
 * 540x960 rather than 720x1280: every pixel here is rasterised on the CPU and
 * read back over CDP, and the measured cost is roughly quadratic in area — the
 * larger viewport costs ~2.5 s per frame and ~22 s per capture, this one about
 * a third of that. Nothing asserted below needs more pixels, and the captures
 * are still large enough to read a HUD label.
 */
const VIEW = { width: 540, height: 960 };

/** Budgets, per render tier. Draw calls and triangles are PER FRAME. */
const BUDGETS = {
  low: { drawCalls: 220, triangles: 450_000, textureBytes: 300 * 1024 * 1024 },
  high: { drawCalls: 420, triangles: 1_100_000, textureBytes: 550 * 1024 * 1024 },
} as const;

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
  /** Paths that 404'd. A shipped build must produce none. */
  readonly misses: string[];
}

function serveDist(): Promise<IServed> {
  const misses: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.join(DIST, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '') file = path.join(DIST, 'index.html');
    if (!file.startsWith(DIST) || !existsSync(file)) {
      misses.push(url.pathname);
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
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
      resolve({ server, port: address.port, misses });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Capture and image analysis                                                 */
/* -------------------------------------------------------------------------- */

interface IShot {
  readonly name: string;
  readonly file: string;
  readonly stdDev: number;
  readonly mean: number;
  readonly colors: number;
  readonly blank: boolean;
}

/** Whole-image statistics. `blank` catches a frame that presented nothing. */
async function analyse(name: string, file: string): Promise<IShot> {
  const stats = await sharp(file).stats();
  const colour = stats.channels.slice(0, 3);
  const stdDev = colour.reduce((sum, c) => sum + c.stdev, 0) / colour.length;
  const mean = colour.reduce((sum, c) => sum + c.mean, 0) / colour.length;
  const raw = await sharp(file).resize(64, 64, { fit: 'fill' }).raw().toBuffer();
  const seen = new Set<number>();
  for (let i = 0; i + 2 < raw.length; i += 3) {
    seen.add((raw[i]! << 16) | (raw[i + 1]! << 8) | raw[i + 2]!);
  }
  return { name, file, stdDev, mean, colors: seen.size, blank: stdDev <= 8 || seen.size <= 60 };
}

/**
 * Mean brightness of one region.
 *
 * `.toBuffer()` FIRST. See the header: `extract().stats()` silently measures
 * the whole image.
 */
async function regionMean(
  file: string,
  rect: { left: number; top: number; width: number; height: number }
): Promise<number> {
  const cropped = await sharp(file).extract(rect).toBuffer();
  const stats = await sharp(cropped).stats();
  const colour = stats.channels.slice(0, 3);
  return colour.reduce((sum, c) => sum + c.mean, 0) / colour.length;
}

/**
 * Fraction of pixels in a region that differ between two captures by more than
 * `threshold` (0-255, per channel, summed over RGB).
 *
 * Both regions are materialised before they are read, for the reason above.
 */
async function regionDiff(
  a: string,
  b: string,
  rect: { left: number; top: number; width: number; height: number },
  threshold = 24
): Promise<number> {
  const bufA = await sharp(a).extract(rect).raw().toBuffer();
  const bufB = await sharp(b).extract(rect).raw().toBuffer();
  const channels = Math.round(bufA.length / (rect.width * rect.height));
  let differing = 0;
  let total = 0;
  for (let i = 0; i + channels - 1 < bufA.length; i += channels) {
    const delta =
      Math.abs(bufA[i]! - bufB[i]!) +
      Math.abs(bufA[i + 1]! - bufB[i + 1]!) +
      Math.abs(bufA[i + 2]! - bufB[i + 2]!);
    if (delta > threshold) differing++;
    total++;
  }
  return total === 0 ? 0 : differing / total;
}

/* -------------------------------------------------------------------------- */
/* Driving                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Advance real frames. `requestAnimationFrame` is the game's only clock.
 *
 * SOURCE TEXT, not a closure: tsx compiles this file with esbuild's
 * `keepNames`, which rewrites every NAMED function — including an arrow
 * function bound to a `const` — into a call to a `__name` helper that exists
 * in this module and not in the page. Serialising such a closure throws
 * `__name is not defined` inside the browser. Every page-side helper below is
 * a string for the same reason.
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

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

/* -------------------------------------------------------------------------- */
/* Page-side instrumentation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Install `window.__PT__`: an event ledger plus a wrapper around
 * `ImpactFreeze.trigger`.
 *
 * The hit-stop is 90 REAL milliseconds at full intensity and less at a jab's.
 * A SwiftShader frame here is around a second, so by the time the harness can
 * sample `freeze.getState()` the freeze has always already expired — reading
 * the state after the fact would report `idle` on a working hit-stop and be
 * indistinguishable from one that never fired. Wrapping `trigger` records the
 * moment it happens, with the clock and camera as they were left, which is the
 * only observation of a sub-frame effect this environment can make honestly.
 */
const INSTRUMENT = `(() => {
  const g = window.__GAME__;
  const pt = {
    freezes: [], killed: [], damaged: [], detached: [], allyDowned: [],
    shockwaves: [], civilianLost: [], encounters: [],
  };
  window.__PT__ = pt;

  const rawTrigger = g.freeze.trigger;
  g.freeze.trigger = function (intensity) {
    rawTrigger.call(g.freeze, intensity);
    const s = g.freeze.getState();
    pt.freezes.push({
      requested: intensity,
      intensity: s.intensity,
      phase: s.phase,
      timeScale: s.timeScale,
      fovOffset: Number(s.fovOffset.toFixed(3)),
      frame: window.__GAME_DIAG__.frameCount,
    });
  };

  g.bus.on('EntityKilled', (e) => pt.killed.push({
    id: String(e.entityId), type: e.entityType, intent: e.intent,
    tier: e.threatTier || '', killer: String(e.killerId || ''),
    frame: window.__GAME_DIAG__.frameCount,
  }));
  g.bus.on('EntityDamaged', (e) => { if (pt.damaged.length < 200) pt.damaged.push({
    id: String(e.entityId), amount: Math.round(e.amount), intent: e.intent,
    left: Math.round(e.healthRemaining), attacker: String(e.attackerId || ''),
  }); });
  g.bus.on('ChunkDetached', (e) => { if (pt.detached.length < 400) pt.detached.push({
    structure: e.structureId, chunk: e.chunkIndex, mass: Math.round(e.mass),
    frame: window.__GAME_DIAG__.frameCount,
  }); });
  g.bus.on('AllyDowned', (e) => pt.allyDowned.push({ id: String(e.entityId || e.heroId || '?') }));
  g.bus.on('ShockwaveFired', (e) => { if (pt.shockwaves.length < 200) pt.shockwaves.push({
    intent: e.intent, kind: e.punchKind, power: Math.round(e.power),
    range: Number(e.range.toFixed(1)), source: String(e.sourceId || 'player'),
    frame: window.__GAME_DIAG__.frameCount,
  }); });
  g.bus.on('CivilianLost', (e) => pt.civilianLost.push({ id: String(e.entityId) }));
  g.bus.on('EncounterStarted', (e) => pt.encounters.push({ id: e.encounterId, tier: e.threatTier }));
  return true;
})()`;

/**
 * Everything worth reading in one round trip.
 *
 * `getDiagnostics(scene)` walks the whole scene graph to total texture and
 * geometry bytes, which is not free — so it is asked for here, at the sample
 * points, and never inside a per-frame loop.
 */
const SNAPSHOT = `(() => {
  const g = window.__GAME__;
  const d = window.__GAME_DIAG__;
  const w = d.world;
  const rd = g.renderer.getDiagnostics(g.scene);
  return {
    frame: d.frameCount,
    drawCalls: d.drawCalls,
    triangles: d.triangles,
    tier: d.quality,
    assetTier: w.assetTier,
    resolutionScale: w.resolutionScale,
    programs: w.shaderPrograms,
    residentChunks: w.residentChunks,
    chunkIndex: w.chunkIndex,
    structures: w.registeredStructures,
    chunksDetached: w.chunksDetached,
    debrisLive: w.debrisLive,
    monsters: w.monsters,
    civilians: w.civilians,
    civiliansLost: w.civiliansLost,
    allies: w.allies,
    alliesDown: w.alliesDown,
    witnesses: w.witnesses,
    rosterResident: w.rosterResident,
    rosterBytes: w.rosterBytes,
    impostorBuildings: w.impostorBuildings,
    impostorDrift: w.impostorDrift,
    physicsBodies: w.physicsBodies,
    vfxEffects: w.vfxEffects,
    x: Number(w.playerPosition.x.toFixed(1)),
    y: Number(w.playerPosition.y.toFixed(2)),
    z: Number(w.playerPosition.z.toFixed(1)),
    state: w.playerState,
    timeOfDay: Number(w.timeOfDay.toFixed(4)),
    dayPhase: w.dayPhase,
    exposure: Number(w.exposure.toFixed(3)),
    rank: w.rank,
    errors: (d.errors || []).slice(),
    textureBytes: rd.memory ? rd.memory.textureBytes : -1,
    textureCount: rd.memory ? rd.memory.textureCount : -1,
    geometryBytes: rd.memory ? rd.memory.geometryBytes : -1,
    sceneTriangles: rd.memory ? rd.memory.triangles : -1,
    instances: rd.memory ? rd.memory.instanceCount : -1,
  };
})()`;

interface ISnapshot {
  frame: number;
  drawCalls: number;
  triangles: number;
  tier: string;
  assetTier: string;
  resolutionScale: number;
  programs: number;
  residentChunks: number;
  chunkIndex: number;
  structures: number;
  chunksDetached: number;
  debrisLive: number;
  monsters: number;
  civilians: number;
  civiliansLost: number;
  allies: number;
  alliesDown: number;
  witnesses: number;
  rosterResident: number;
  rosterBytes: number;
  impostorBuildings: number;
  impostorDrift: number;
  physicsBodies: number;
  vfxEffects: number;
  x: number;
  y: number;
  z: number;
  state: string;
  timeOfDay: number;
  dayPhase: string;
  exposure: number;
  rank: string;
  errors: string[];
  textureBytes: number;
  textureCount: number;
  geometryBytes: number;
  sceneTriangles: number;
  instances: number;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const failures: string[] = [];
  const notes: string[] = [];
  const shots: IShot[] = [];
  const report: Record<string, unknown> = {};

  if (!existsSync(DIST)) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });

  const served = await serveDist();
  const base = `http://127.0.0.1:${served.port}/`;
  say(`serving dist/ at ${base}`);

  let browser: Browser | undefined;
  const consoleErrors: string[] = [];

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
      viewport: VIEW,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400));
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    const cdp = await page.context().newCDPSession(page);

    const snap = (): Promise<ISnapshot> => page.evaluate(SNAPSHOT) as Promise<ISnapshot>;

    /*
     * NOTHING IN THIS GAME CATCHES A PLAYER WHO LEAVES THE WORLD.
     *
     * There is no kill plane, no respawn and no depth clamp: once the capsule
     * is under the road it accelerates downward forever while the loop, the
     * HUD and the diagnostics all carry on as if the session were fine. The
     * first pass of this file put the player at an ally who had wandered two
     * hundred metres into unstreamed city, he dropped through the hole, and
     * three beats plus the entire draw-call budget were then measured from
     * three hundred metres underground — where frustum culling deletes most of
     * the city and the numbers look BETTER than they are.
     *
     * So every teleport is followed by this check. Each recovery is recorded
     * and reported: the harness working around the hole does not make the hole
     * go away.
     */
    const outOfWorld: string[] = [];
    const ensureGrounded = async (label: string): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const where = (await page.evaluate(
          `({ x: window.__GAME_DIAG__.world.playerPosition.x,
              y: window.__GAME_DIAG__.world.playerPosition.y,
              z: window.__GAME_DIAG__.world.playerPosition.z,
              state: window.__GAME_DIAG__.world.playerState })`
        )) as { x: number; y: number; z: number; state: string };
        if (where.y > -2) return;
        say(`  !! ${label}: player at y=${where.y.toFixed(1)} ('${where.state}') — re-placing`);
        outOfWorld.push(`${label}: y=${where.y.toFixed(1)} state=${where.state}`);
        await page.evaluate(
          `(() => { const g = window.__GAME__;
             const p = g.player.controller.position;
             g.cityStreamer.setFocus(p.x, p.z);
             g.cityStreamer.buildImmediate(1);
             g.player.controller.setPosition(g.camera.position.clone().set(p.x, 2, p.z)); })()`
        );
        await frames(page, 6);
      }
    };

    const shoot = async (name: string): Promise<IShot> => {
      const file = path.join(OUT, `${name}.png`);
      const started = Date.now();
      await page.screenshot({ path: file, type: 'png', timeout: 300_000 });
      const shot = await analyse(name, file);
      shots.push(shot);
      say(
        `    shot ${name}  stdDev ${shot.stdDev.toFixed(1)}  colours ${shot.colors}` +
          `  mean ${shot.mean.toFixed(1)}  (${((Date.now() - started) / 1000).toFixed(0)}s)` +
          (shot.blank ? '   <-- BLANK' : '')
      );
      if (shot.blank) failures.push(`screenshot "${name}" is blank — nothing was presented`);
      return shot;
    };

    /* ══════════════════ BEAT 1 — BOOT ══════════════════════════════════ */
    say('\n[beat 1] boot -> loading -> first frame of City Z');
    const wall0 = Date.now();
    await page.goto(`${base}?tier=high&nosave=1`, { waitUntil: 'load', timeout: 300_000 });
    // The pre-HUD boot screen is live from the first paint. Photograph it
    // before waiting for READY, so the loading state is on the record too.
    await page.waitForFunction(() => document.getElementById('boot-screen') !== null, undefined, {
      timeout: 60_000,
    });
    await shoot('play-01a-loading');
    await page.waitForFunction(() => window.__GAME_READY__ === true, undefined, {
      timeout: 300_000,
    });
    const wallMs = Date.now() - wall0;
    const boot = await page.evaluate(
      `({ bootTimeMs: window.__GAME_DIAG__.bootTimeMs, boot: window.__GAME_DIAG__.boot,
          bridge: window.__INPUT__ ? window.__INPUT__.version : -1,
          online: window.__GAME_DIAG__.systems.online.length,
          skipped: window.__GAME_DIAG__.systems.skipped,
          failed: window.__GAME_DIAG__.systems.failed })`
    );
    say(`  ready in ${(boot as { bootTimeMs: number }).bootTimeMs} ms (wall ${wallMs} ms)`);
    say(`  boot phases ${JSON.stringify((boot as { boot: unknown }).boot)}`);
    say(`  input bridge v${(boot as { bridge: number }).bridge}`);
    if ((boot as { bridge: number }).bridge < 0) failures.push('window.__INPUT__ was not installed');
    report.boot = boot;

    await page.evaluate(INSTRUMENT);
    await frames(page, 12);
    const spawned = await snap();
    say(
      `  spawn: tier ${spawned.tier}/${spawned.assetTier}  ${spawned.residentChunks} chunks  ` +
        `${spawned.structures} structures  ${spawned.civilians} civilians  ` +
        `${spawned.allies} allies  roster ${spawned.rosterResident} ` +
        `(${(spawned.rosterBytes / 1048576).toFixed(1)} MB)`
    );
    if (spawned.tier !== 'high') failures.push(`render tier is '${spawned.tier}', wanted high`);
    if (spawned.rosterResident < 4) {
      failures.push(
        `only ${spawned.rosterResident} baked character atlases resident — the cast has no faces`
      );
    }
    await shoot('play-01b-city-z');
    report.spawn = spawned;

    /* ══════════════════ BEAT 2 — TRAVERSE + LEAK LAPS ══════════════════ */
    say('\n[beat 2] traverse — dash down an avenue until chunks evict, and back');
    await page.evaluate(`window.__INPUT__.enable()`);

    /*
     * HOW FAR A LEG HAS TO GO, AND WHY IT IS MEASURED RATHER THAN GUESSED.
     *
     * Chunks are 96 m. `CityStreamer` keeps a square ring of `residentRadius`
     * around the focus and evicts only past `residentRadius + 1` — one whole
     * chunk of hysteresis, so that walking a boundary back and forth does not
     * rebuild a 400 ms chunk twice a second. At the high tier's radius that
     * means a chunk is not dropped until the focus has moved TWO chunks away
     * from it, i.e. the better part of 200 m.
     *
     * A leg of a fixed frame count is therefore a coin toss: 24 frames of dash
     * moved the player 22 m in an earlier run of this file and evicted exactly
     * nothing, which made the "streams out" claim pass or fail on the
     * acceleration curve. So each leg now runs until the STREAMER'S OWN focus
     * chunk has moved, with a frame cap as a backstop.
     *
     * TWO chunks is the exact threshold, not a margin: the trailing edge of the
     * ring sits at `residentRadius`, a move of M chunks puts it at
     * `residentRadius + M`, and eviction needs that to exceed
     * `residentRadius + 1`. So M = 2 evicts and M = 1 provably cannot.
     */
    const LEG_CHUNKS = 2;
    const LEG_FRAME_CAP = 200;
    const SAMPLE_EVERY = 10;

    const everResident = new Set<number>();
    const chunkSamples: number[][] = [];
    const heap: number[] = [];
    let evicted = 0;
    let built = 0;

    const sampleChunks = async (): Promise<{ cx: number; cz: number; resident: number[] }> => {
      const now = (await page.evaluate(
        `(() => { const s = window.__GAME__.cityStreamer;
           return { cx: s.focusChunkX, cz: s.focusChunkZ,
                    resident: s.chunks.map((c) => c.index) }; })()`
      )) as { cx: number; cz: number; resident: number[] };
      const set = new Set(now.resident);
      const previous = chunkSamples[chunkSamples.length - 1];
      if (previous !== undefined) {
        for (const index of previous) if (!set.has(index)) evicted++;
        for (const index of now.resident) if (!previous.includes(index)) built++;
      }
      for (const index of now.resident) everResident.add(index);
      chunkSamples.push(now.resident);
      return now;
    };

    const readHeap = async (label: string): Promise<void> => {
      // A real collection before the reading. Without it the series measures
      // when the collector happened to run, not what the game retained.
      await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
      const used = (await page.evaluate(
        `(performance.memory ? performance.memory.usedJSHeapSize : -1)`
      )) as number;
      heap.push(used);
      const now = await snap();
      say(
        `    ${label}: at (${now.x}, ${now.z})  chunk ${now.chunkIndex}  ` +
          `resident ${now.residentChunks}  heap ${(used / 1048576).toFixed(1)} MB`
      );
    };

    const start = await sampleChunks();
    await readHeap('start   ');

    // Two laps over the same ground. The lap is a leak probe and a streaming
    // probe at once: the same chunks are built, evicted and built AGAIN, which
    // is where a retained scene graph or an unreleased physics body shows up as
    // a heap that never comes back down.
    let shotDash = false;
    for (let lap = 0; lap < 2; lap++) {
      for (const leg of [0, 1] as const) {
        if (!(lap === 0 && leg === 0)) {
          // Turn 180 and keep RUNNING FORWARD rather than reversing the stick:
          // a backwards sprint points the camera the wrong way and every
          // capture on the return leg would be of the street behind.
          await page.evaluate(
            `(() => { const g = window.__GAME__;
               g.player.controller.yaw += Math.PI;
               g.player.camera.yaw = g.player.controller.yaw; })()`
          );
        }
        await page.evaluate(
          `(() => { window.__INPUT__.setMove(0, 1); window.__INPUT__.press('sprint'); })()`
        );
        const from = chunkSamples.length === 0 ? start : await sampleChunks();
        let driven = 0;
        for (;;) {
          await frames(page, SAMPLE_EVERY);
          driven += SAMPLE_EVERY;
          const now = await sampleChunks();
          const moved = Math.max(Math.abs(now.cx - from.cx), Math.abs(now.cz - from.cz));
          if (!shotDash && driven >= 30) {
            shotDash = true;
            const mid = await snap();
            say(`    mid-dash at (${mid.x}, ${mid.z}) state '${mid.state}'`);
            await shoot('play-02a-dash');
          }
          if (moved >= LEG_CHUNKS || driven >= LEG_FRAME_CAP) {
            say(
              `    leg ${lap + 1}.${leg + 1}: ${driven} frames, focus chunk moved ` +
                `${moved} (${from.cx},${from.cz}) -> (${now.cx},${now.cz})`
            );
            break;
          }
        }
        await page.evaluate(
          `(() => { window.__INPUT__.setMove(0, 0); window.__INPUT__.release('sprint'); })()`
        );
        await frames(page, 4);
        await sampleChunks();
        await readHeap(`lap ${lap + 1} leg ${leg + 1}`);
      }
    }

    const afterLaps = await snap();
    await shoot('play-02b-avenue');
    say(
      `  chunk indices ever resident: ${everResident.size}  ` +
        `built ${built}  evicted ${evicted}  resident now ${afterLaps.residentChunks}`
    );
    if (built < 1) failures.push('no city chunk was ever built while traversing');
    if (evicted < 1) failures.push('no city chunk was ever evicted — streaming is one-way');
    if (everResident.size <= afterLaps.residentChunks) {
      failures.push('the resident set never changed — the player never left its chunks');
    }
    report.streaming = {
      distinctChunks: everResident.size,
      built,
      evicted,
      residentAtEnd: afterLaps.residentChunks,
      samples: chunkSamples.length,
    };

    // ---- leak verdict ----
    // Lap 1 is EXCLUDED from the comparison on purpose: it is the lap that
    // grows the crowd to its cap, fills the prop cache and compiles the shader
    // variants the far end of the avenue needs. A leak is what survives the
    // SECOND traversal of ground the game has already seen, so the reading
    // that matters is lap 2's end against lap 1's end.
    const heapMb = heap.map((b) => Number((b / 1048576).toFixed(1)));
    const lapEnds = heap.slice(1);
    const growth =
      lapEnds.length >= 4 ? (lapEnds[3]! - lapEnds[1]!) / 1048576 : 0;
    const totalGrowth = heap.length >= 2 ? (heap[heap.length - 1]! - heap[0]!) / 1048576 : 0;
    say(`  heap at each leg end (MB): ${heapMb.join('  ->  ')}`);
    say(
      `  growth lap1-end -> lap2-end: ${growth.toFixed(1)} MB   ` +
        `(whole beat, cold start included: ${totalGrowth.toFixed(1)} MB)`
    );
    // 12 MB across a repeat of identical ground. Generous on purpose: JS heaps
    // move, and a real retention bug on a scene graph this size leaks tens of
    // megabytes per lap, not single digits.
    if (growth > 12) {
      failures.push(
        `heap grew ${growth.toFixed(1)} MB repeating a lap the game had already streamed — leak`
      );
    }
    report.leak = {
      legEndsHeapMb: heapMb,
      lapOverLapGrowthMb: Number(growth.toFixed(2)),
      wholeBeatGrowthMb: Number(totalGrowth.toFixed(2)),
    };

    /* ══════════════════ BEAT 3 — CROWD ═════════════════════════════════ */
    say('\n[beat 3] crowd — civilians animating, not T-posed');
    // Face the nearest near-tier civilian and freeze everything that is not
    // the crowd, so the capture pair below differs ONLY by the crowd's motion.
    const civilian = await page.evaluate(`(() => {
      const g = window.__GAME__;
      const p = g.player.controller.position;
      let best = null;
      for (const body of g.crowd.nearBodies.values()) {
        const q = body.transform.position;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (best === null || d < best.d) best = { d: d, x: q.x, z: q.z, id: String(body.id || '') };
      }
      if (best === null) return null;
      // Stand off a little so the body is framed rather than filling the lens.
      const k = Math.max(0.001, best.d);
      g.player.controller.setPosition(g.camera.position.clone().set(
        best.x + (p.x - best.x) / k * 5.5, 1.4, best.z + (p.z - best.z) / k * 5.5));
      g.player.controller.yaw = Math.atan2(
        g.player.controller.position.x - best.x, g.player.controller.position.z - best.z);
      g.player.camera.yaw = g.player.controller.yaw;
      return best;
    })()`);
    say(`  nearest near-tier civilian: ${JSON.stringify(civilian)}`);
    if (civilian === null) failures.push('no near-tier civilian bodies exist');
    await frames(page, 6);

    const poseA = (await page.evaluate(`(() => {
      const g = window.__GAME__;
      const out = [];
      for (const body of g.crowd.nearBodies.values()) {
        let sum = 0, bones = 0;
        body.root.traverse((n) => {
          if (n.isBone) { bones++;
            sum += Math.abs(n.quaternion.x) + Math.abs(n.quaternion.y) +
                   Math.abs(n.quaternion.z) + Math.abs(n.position.y); }
        });
        out.push({ bones: bones, sig: Number(sum.toFixed(6)) });
        if (out.length >= 8) break;
      }
      return out;
    })()`)) as { bones: number; sig: number }[];

    await shoot('play-03a-crowd');
    await frames(page, 3);
    const poseB = (await page.evaluate(`(() => {
      const g = window.__GAME__;
      const out = [];
      for (const body of g.crowd.nearBodies.values()) {
        let sum = 0, bones = 0;
        body.root.traverse((n) => {
          if (n.isBone) { bones++;
            sum += Math.abs(n.quaternion.x) + Math.abs(n.quaternion.y) +
                   Math.abs(n.quaternion.z) + Math.abs(n.position.y); }
        });
        out.push({ bones: bones, sig: Number(sum.toFixed(6)) });
        if (out.length >= 8) break;
      }
      return out;
    })()`)) as { bones: number; sig: number }[];
    await shoot('play-03b-crowd-moved');

    const moving = poseA.filter((a, i) => poseB[i] !== undefined && poseB[i]!.sig !== a.sig).length;
    const boneCount = poseA[0]?.bones ?? 0;
    say(`  near bodies sampled ${poseA.length} (${boneCount} bones each), pose changed on ${moving}`);
    if (poseA.length > 0 && moving === 0) {
      failures.push('every near-tier civilian held an identical bone pose across frames — T-posed');
    }
    const crowdStats = (await page.evaluate(
      `(() => { const c = window.__GAME__.crowd;
        const r = c.renderer ? c.renderer.lastStats : null;
        return { stats: c.lastStats, instanced: r }; })()`
    )) as { stats: Record<string, number>; instanced: Record<string, number> | null };
    say(`  crowd ${JSON.stringify(crowdStats.stats).slice(0, 220)}`);
    say(`  instanced ${JSON.stringify(crowdStats.instanced)}`);
    if (crowdStats.instanced !== null && (crowdStats.instanced.distinctOffsets ?? 0) < 20) {
      failures.push('the instanced crowd shares too few gait offsets — 250 people marching in step');
    }
    // Pixels, not just numbers: the pair above is three frames apart with the
    // camera nailed down, so anything that moved is the crowd.
    const crowdDelta = await regionDiff(
      path.join(OUT, 'play-03a-crowd.png'),
      path.join(OUT, 'play-03b-crowd-moved.png'),
      { left: 0, top: Math.round(VIEW.height * 0.35), width: VIEW.width, height: 320 }
    );
    say(`  pixels changed in the crowd band across 3 frames: ${(crowdDelta * 100).toFixed(2)}%`);
    notes.push(`crowd band pixel delta over 3 frames: ${(crowdDelta * 100).toFixed(2)}%`);
    report.crowd = { ...crowdStats, posesChanged: moving, bandDelta: crowdDelta };

    /* ══════════════════ BEAT 4 — NORMAL PUNCH ══════════════════════════ */
    say('\n[beat 4] normal punch — tap-kill a monster, hit-stop must fire');
    /*
     * THE TAP REACHES 1.2 METRES. That is the whole design of the normal
     * punch — "to use it you must cross the street with your body" — and it
     * is measured from a fist socket 0.45 m above the controller origin to
     * the target's AIM POINT, half a body above its feet, with the target's
     * own radius counted in. Spawning a monster at a comfortable-looking
     * three metres and tapping produces a punch that resolves, hits nothing,
     * and kills nothing: `combat.diagnostics().punches` still increments, so
     * an assertion written against the punch COUNT passes while the beat it
     * claims to prove never happened.
     *
     * So the distance is solved rather than guessed: place the monster, read
     * the real reach, the real aim point and the real radius out of the live
     * systems, and set the stand-off so the target sphere is unambiguously
     * inside the contact cone.
     */
    const target = await page.evaluate(
      `String(window.__GAME__.spawnEncounter('mob.wolf.pest', 2.0))`
    );
    say(`  spawned ${target}`);
    if (target === 'undefined') failures.push('spawnEncounter could not place a monster');
    await page.evaluate(`window.__GAME__.faceNearestMonster()`);
    await frames(page, 3);

    const reach = (await page.evaluate(`(() => {
      const g = window.__GAME__;
      // THE MONSTER THIS BEAT SPAWNED, by id. Not "the first one combat knows
      // about": the spawn director populates the district on its own schedule,
      // so that list routinely starts with something three hundred metres away
      // and the beat then teleports the player across the map to punch it.
      const wantedId = ${JSON.stringify(target)};
      const all = g.monsters.describeForCombat();
      const nearest = all.find((m) => String(m.id) === wantedId) || all[0];
      if (!nearest) return null;
      const aim = g.combat.targets.get(nearest.id);
      if (!aim) return null;
      const reachM = g.combat.tuning.normalReachMetres;
      const p = g.player.controller.position;
      const dy = (p.y + 0.45) - aim.position.y;
      // Largest horizontal stand-off at which the target sphere still meets
      // the cone, then back off to 75% of it so a frame of drift cannot miss.
      const span = (reachM + aim.radius) * (reachM + aim.radius) - dy * dy;
      const wanted = 0.75 * Math.sqrt(Math.max(0.09, span));
      const dx = p.x - aim.position.x;
      const dz = p.z - aim.position.z;
      const h = Math.max(1e-3, Math.hypot(dx, dz));
      g.player.controller.setPosition(g.camera.position.clone().set(
        aim.position.x + (dx / h) * wanted, p.y, aim.position.z + (dz / h) * wanted));
      g.player.controller.yaw = Math.atan2(
        g.player.controller.position.x - aim.position.x,
        g.player.controller.position.z - aim.position.z);
      g.player.camera.yaw = g.player.controller.yaw;
      const q = g.player.controller.position;
      const centre = Math.hypot(q.x - aim.position.x, (q.y + 0.45) - aim.position.y,
                                q.z - aim.position.z);
      return { id: String(nearest.id), reach: reachM, radius: Number(aim.radius.toFixed(3)),
               standoff: Number(wanted.toFixed(3)), was: Number(h.toFixed(3)),
               centreDistance: Number(centre.toFixed(3)),
               surfaceGap: Number((centre - aim.radius).toFixed(3)) };
    })()`)) as {
      id: string;
      reach: number;
      radius: number;
      standoff: number;
      was: number;
      centreDistance: number;
      surfaceGap: number;
    } | null;
    say(`  reach check ${JSON.stringify(reach)}`);
    if (reach === null) failures.push('no monster to punch');
    else if (reach.surfaceGap > reach.reach) {
      failures.push(
        `the monster is ${reach.surfaceGap} m from the fist but the tap reaches ${reach.reach} m`
      );
    }
    await frames(page, 3);
    await shoot('play-04a-monster');

    const freezesBefore = (await page.evaluate(`window.__PT__.freezes.length`)) as number;
    await page.evaluate(`window.__INPUT__.tap('punch')`);
    await frames(page, 1);
    await shoot('play-04b-punch');
    await frames(page, 8);

    const punch = (await page.evaluate(`(() => {
      const g = window.__GAME__;
      const pt = window.__PT__;
      return {
        punches: g.combat.diagnostics().punches,
        monsters: g.monsters.count,
        killed: pt.killed.slice(),
        freezes: pt.freezes.slice(),
        lastPunch: g.combat.lastPunch ? {
          intent: g.combat.lastPunch.punch.intent, kind: g.combat.lastPunch.punch.kind,
          charge: g.combat.lastPunch.punch.charge,
          hits: g.combat.lastPunch.hits.length,
          kills: g.combat.lastPunch.kills,
          instantKills: g.combat.lastPunch.hits.filter((h) => h.instantKill).length,
        } : null,
      };
    })()`)) as {
      punches: number;
      monsters: number;
      killed: { id: string; intent: string; tier: string }[];
      freezes: { intensity: number; timeScale: number; fovOffset: number; phase: string }[];
      lastPunch: { intent: string; kind: string; hits: number; kills: number } | null;
    };
    say(`  punches ${punch.punches}  monsters left ${punch.monsters}`);
    say(`  last punch ${JSON.stringify(punch.lastPunch)}`);
    say(`  kills ${JSON.stringify(punch.killed)}`);
    say(`  hit-stops ${JSON.stringify(punch.freezes)}`);
    if (punch.punches < 1) failures.push('the normal punch never resolved');
    const normalKill = punch.killed.find((k) => k.intent === 'normal');
    if (normalKill === undefined) {
      failures.push('the tapped punch killed nothing at `normal` intent');
    }
    const newFreezes = punch.freezes.slice(freezesBefore);
    if (newFreezes.length === 0) {
      failures.push(
        'HIT-STOP DID NOT FIRE on a lethal tap — the freeze is meant to key on lethality, not charge'
      );
    } else {
      const strongest = newFreezes.reduce((a, b) => (b.intensity > a.intensity ? b : a));
      say(
        `  strongest hit-stop: intensity ${strongest.intensity.toFixed(3)}  ` +
          `timeScale ${strongest.timeScale.toFixed(3)}  fov punch ${strongest.fovOffset} deg`
      );
      if (strongest.timeScale >= 1) {
        failures.push('the hit-stop fired but did not slow the clock');
      }
    }
    report.normalPunch = punch;

    /* ══════════════════ BEAT 5 — SERIOUS PUNCH ═════════════════════════ */
    say('\n[beat 5] serious punch — hold past the 0.14 s discriminator, release');
    /*
     * TWO STRUCTURE INDEXES, AND ONLY ONE OF THEM IS FED.
     *
     * `DestructionSystem.structures` is populated by `CityStreamer` on every
     * chunk build, and it is the one that breaks buildings — the release below
     * detaches hundreds of chunks out of it.
     *
     * `CombatSystem.structures` is a SECOND index with its own `sweepCone`,
     * and `CombatSystem.addStructure()` — its only way in — has no callers
     * anywhere in this repository. It is therefore permanently empty, which
     * makes `chargeForecast()` return zero structures and ¥0 forever — and
     * that zero is what the charge ring's price tag renders.
     *
     * So this beat aims with `faceNearestStructure` (which reads the
     * destruction index) and REPORTS the forecast rather than trusting it.
     * Asserting on the forecast here would fail the beat for a HUD bug while
     * the building it is aimed at falls over perfectly.
     */
    const aimed = (await page.evaluate(`(() => {
      const g = window.__GAME__;
      const faced = g.faceNearestStructure();
      const forecast = g.combat.chargeForecast(1);
      return { faced: faced, forecastStructures: forecast.structures,
               forecastYen: forecast.yen,
               destructionIndex: g.destruction.structures.size,
               combatIndex: g.combat.structures.size };
    })()`)) as {
      faced: boolean;
      forecastStructures: number;
      forecastYen: number;
      destructionIndex: number;
      combatIndex: number;
    };
    say(
      `  aimed at nearest structure: ${aimed.faced};  destruction index holds ` +
        `${aimed.destructionIndex}, combat's own index holds ${aimed.combatIndex}`
    );
    say(
      `  charge forecast: ${aimed.forecastStructures} structures, ¥${aimed.forecastYen}` +
        (aimed.combatIndex === 0 ? '   <-- forecast is dead, see below' : '')
    );
    if (!aimed.faced) failures.push('there was no structure to aim at');
    if (aimed.combatIndex === 0 && aimed.destructionIndex > 0) {
      failures.push(
        `CombatSystem.addStructure() has no callers: its StructureIndex is empty while ` +
          `destruction holds ${aimed.destructionIndex}, so chargeForecast() and the HUD's ` +
          `property-damage price tag are permanently ¥0`
      );
    }
    report.chargeForecast = aimed;
    await frames(page, 4);
    await page.evaluate(`window.__INPUT__.press('punch')`);
    // The clock charges up to MAX_DELTA (1/15 s) a frame, so ten frames is
    // about 0.67 s of held game time — comfortably past `tapMaxHoldSeconds`
    // (0.14 s) and most of the way to the 1.2 s full charge.
    await frames(page, 10);
    const charge = (await page.evaluate(`(() => {
      const d = window.__GAME__.combat.diagnostics();
      return { charging: d.charging, charge: d.charge, seconds: d.chargeSeconds,
               range: d.chargeRangeMetres, yen: d.chargeForecastYen };
    })()`)) as { charging: boolean; charge: number; seconds: number; range: number; yen: number };
    say(
      `  held ${charge.seconds.toFixed(3)} s  charge ${(charge.charge * 100).toFixed(0)}%  ` +
        `cone ${charge.range.toFixed(1)} m  forecast ¥${charge.yen}`
    );
    if (charge.seconds < 0.14) failures.push(`only held ${charge.seconds.toFixed(3)} s, needed 0.14`);
    if (!charge.charging) failures.push('combat never entered the charging state');
    await shoot('play-05a-charging');

    const wavesBefore = (await page.evaluate(`window.__PT__.shockwaves.length`)) as number;
    await page.evaluate(`window.__INPUT__.release('punch')`);
    await frames(page, 2);
    await shoot('play-05b-shockwave');
    const serious = (await page.evaluate(`(() => {
      const g = window.__GAME__;
      return {
        waves: window.__PT__.shockwaves.slice(${wavesBefore}),
        vfx: JSON.parse(JSON.stringify(g.vfx.diagnostics())),
        lastPunch: g.combat.lastPunch ? {
          intent: g.combat.lastPunch.punch.intent, kind: g.combat.lastPunch.punch.kind,
          charge: g.combat.lastPunch.punch.charge,
          hits: g.combat.lastPunch.hits.length,
          structures: g.combat.lastPunch.structures ? g.combat.lastPunch.structures.length : -1,
        } : null,
      };
    })()`)) as {
      waves: { intent: string; kind: string; range: number; power: number }[];
      vfx: Record<string, number> | null;
      lastPunch: { intent: string; kind: string } | null;
    };
    say(`  shockwaves ${JSON.stringify(serious.waves)}`);
    say(`  vfx ${JSON.stringify(serious.vfx)}`);
    if (serious.waves.length === 0) failures.push('the released charge fired no shockwave');
    else if (serious.waves.every((w) => w.intent === 'normal')) {
      failures.push('the charged release still reported `normal` intent');
    }
    report.seriousPunch = { charge, ...serious };

    /* ══════════════════ BEAT 6 — DESTRUCTION ═══════════════════════════ */
    say('\n[beat 6] destruction — a building actually breaking');
    await frames(page, 3);
    await shoot('play-06a-collapse');
    const collapse1 = await snap();
    say(`  chunks detached ${collapse1.chunksDetached}  debris live ${collapse1.debrisLive}`);
    await frames(page, 8);
    await shoot('play-06b-debris');
    const collapse2 = await snap();
    say(`  after settling: detached ${collapse2.chunksDetached}  debris ${collapse2.debrisLive}`);
    const detached = (await page.evaluate(`window.__PT__.detached.slice(0, 6)`)) as unknown[];
    say(`  first detachments ${JSON.stringify(detached)}`);
    if (collapse2.chunksDetached < 1) {
      failures.push('the Serious Punch detached no structure chunks — nothing broke');
    }
    if (Math.max(collapse1.debrisLive, collapse2.debrisLive) < 1) {
      failures.push('no debris body was ever live — the collapse produced no physics');
    }
    report.destruction = {
      detachedAtImpact: collapse1.chunksDetached,
      detachedAfter: collapse2.chunksDetached,
      debrisPeak: Math.max(collapse1.debrisLive, collapse2.debrisLive),
      firstDetachments: detached,
    };

    /* ══════════════════ BEAT 7 — ALLY IN DANGER ════════════════════════ */
    say('\n[beat 7] ally in danger — a monster engaging Genos or Mumen Rider');
    // Stand the player off to one side of the ally and TURN TO FACE HIM, then
    // let `spawnEncounter` place the monster along that same forward axis —
    // past the ally, so the shot has the ally between Saitama and the threat.
    // `MonsterSystem.spawn` takes a resolved archetype object the page cannot
    // import, so `spawnEncounter` is the only door in from here.
    const staging = (await page.evaluate(`(() => {
      const g = window.__GAME__;
      const ally = g.crowd.allies.find((a) => a.heroId === 'mumenRider') || g.crowd.allies[0];
      if (!ally) return null;
      const a = ally.transform.position;
      // GROUND FIRST. The allies drift with the player and routinely end a
      // traverse two hundred metres away, outside the resident ring — placing
      // the capsule there before the chunks exist drops it through the world.
      // buildImmediate() is synchronous, so after it returns there is a road.
      g.cityStreamer.setFocus(a.x, a.z + 9);
      g.cityStreamer.buildImmediate(1);
      g.player.controller.setPosition(g.camera.position.clone().set(a.x, 2, a.z + 9));
      g.player.controller.yaw = Math.atan2(
        g.player.controller.position.x - a.x, g.player.controller.position.z - a.z);
      g.player.camera.yaw = g.player.controller.yaw;
      g.player.camera.pitch = -0.12;
      g.crowd.setPlayer(g.player.controller.position.x, g.player.controller.position.z);
      return { ally: ally.heroId, x: Number(a.x.toFixed(1)), z: Number(a.z.toFixed(1)),
               health: ally.health, residentChunks: g.cityStreamer.residentCount };
    })()`)) as {
      ally: string;
      x: number;
      z: number;
      health: number;
      residentChunks: number;
    } | null;
    say(`  staging ${JSON.stringify(staging)}`);
    if (staging === null) failures.push('no allies exist in the world');
    await frames(page, 8);
    await ensureGrounded('beat 7 staging');
    const threat = await page.evaluate(
      `String(window.__GAME__.spawnEncounter('mob.demon.carapace', 12))`
    );
    say(`  threat ${threat}`);
    if (threat === 'undefined') failures.push('could not place a monster next to the ally');
    await frames(page, 20);
    const engagement = (await page.evaluate(`(() => {
      const g = window.__GAME__;
      const out = { allies: [], monsters: [] };
      for (const a of g.crowd.allies) out.allies.push({
        id: a.heroId, health: Math.round(a.health), dead: !!a.isDead,
        x: Number(a.transform.position.x.toFixed(1)), z: Number(a.transform.position.z.toFixed(1)) });
      for (const m of g.monsters.all()) out.monsters.push({
        id: String(m.id), target: String(m.brain.currentTargetId || 'none'),
        harmable: !!m.brain.isTargetHarmable, state: String(m.brain.state || ''),
        x: Number(m.brain.position.x.toFixed(1)), z: Number(m.brain.position.z.toFixed(1)) });
      return out;
    })()`)) as {
      allies: { id: string; health: number; dead: boolean }[];
      monsters: { id: string; target: string; harmable: boolean }[];
    };
    say(`  ${JSON.stringify(engagement)}`);
    await shoot('play-07a-ally-threatened');
    const huntingAnAlly = engagement.monsters.filter((m) => m.target.startsWith('hero-')).length;
    const huntingHarmable = engagement.monsters.filter((m) => m.harmable).length;
    say(`  monsters hunting an ally: ${huntingAnAlly}, hunting anything harmable: ${huntingHarmable}`);
    if (huntingHarmable === 0) {
      failures.push('no monster on screen was hunting a harmable target');
    }

    // The designed proof. Runs the real MonsterBrain -> ShockwaveFired ->
    // CrowdSystem -> HeroNpc.takeDamage -> AllyDowned path in a tight loop and
    // leaves the world in the state it produces.
    //
    // 90 seconds rather than the 45 second default. The Harbinger is placed
    // beside Mumen Rider, and the damage falloff is `(1 - d/range)^1.4` — so
    // when the two allies have drifted thirty-odd metres apart during the
    // traverse, killing the first one and then WALKING to the second is most
    // of the budget. The window is the parameter the door exposes precisely so
    // a caller can give it enough time; shortening it does not make the claim
    // truer, it just fails to test it.
    const proof = (await page.evaluate(
      `JSON.parse(JSON.stringify(window.__GAME__.proveAlliesCanLose(90)))`
    )) as {
      genos: { before: number; after: number; dead: boolean };
      mumen: { before: number; after: number; dead: boolean };
      downedEvents: number;
      waves: number;
      retargets: number;
      targetTimeline: { at: number; id: string; harmable: boolean }[];
    };
    say(`  proveAlliesCanLose: ${JSON.stringify(proof).slice(0, 700)}`);
    if (!proof.mumen.dead) failures.push('Mumen Rider survived a sustained god-tier barrage');
    if (!proof.genos.dead) failures.push('Genos survived a sustained god-tier barrage');
    if (proof.downedEvents < 2) failures.push(`only ${proof.downedEvents} AllyDowned events`);
    await frames(page, 4);
    await shoot('play-07b-ally-down');
    report.allies = { engagement, proof };

    /* ══════════════════ BEAT 8 — NIGHT ═════════════════════════════════ */
    say('\n[beat 8] night — advance the day/night clock');
    // `proveAlliesCanLose` steps the monster and crowd systems in a tight loop
    // without physics, so the player is exactly where it left him — but the
    // god-tier barrage it runs can shove him, and everything from here on is a
    // photograph. Check the floor before spending four captures on it.
    await ensureGrounded('before beat 8');
    // The HUD is a DOM overlay and would dominate a whole-frame luminance
    // reading, so it is hidden for this pair and restored immediately after.
    // Both captures are otherwise identical: same camera, same world.
    await page.evaluate(`(() => { document.getElementById('ui-root').style.visibility = 'hidden'; })()`);
    await page.evaluate(`window.__GAME__.dayNight.setTimeOfDay(0.5)`);
    await frames(page, 8);
    const noonSnap = await snap();
    const noonShot = await shoot('play-08a-noon');
    await page.evaluate(`window.__GAME__.dayNight.setTimeOfDay(0.0)`);
    await frames(page, 8);
    const midnightSnap = await snap();
    const midnightShot = await shoot('play-08b-midnight');
    await page.evaluate(`(() => { document.getElementById('ui-root').style.visibility = ''; })()`);

    const skyNoon = await regionMean(noonShot.file, {
      left: 0,
      top: 0,
      width: VIEW.width,
      height: 260,
    });
    const skyNight = await regionMean(midnightShot.file, {
      left: 0,
      top: 0,
      width: VIEW.width,
      height: 260,
    });
    const frameRatio = midnightShot.mean / Math.max(1e-6, noonShot.mean);
    say(
      `  phase ${noonSnap.dayPhase} -> ${midnightSnap.dayPhase};  ` +
        `exposure ${noonSnap.exposure} -> ${midnightSnap.exposure}`
    );
    say(
      `  frame luminance noon ${noonShot.mean.toFixed(1)} -> midnight ` +
        `${midnightShot.mean.toFixed(1)}  (${(frameRatio * 100).toFixed(1)}% of noon)`
    );
    say(`  sky band noon ${skyNoon.toFixed(1)} -> midnight ${skyNight.toFixed(1)}`);
    if (midnightSnap.dayPhase !== 'midnight') {
      failures.push(`clock at 0.0 reported phase '${midnightSnap.dayPhase}', wanted midnight`);
    }
    if (midnightShot.mean >= noonShot.mean) {
      failures.push('midnight is not darker than noon');
    }
    // The brief is "~10% of noon". Anything under a quarter is a real night;
    // this reports the number and only fails when night is barely a dimming.
    if (frameRatio > 0.25) {
      failures.push(
        `midnight reads ${(frameRatio * 100).toFixed(0)}% of noon in frame luminance, ` +
          `wanted about 10% (fail threshold 25%)`
      );
    }
    notes.push(
      `midnight/noon frame luminance ratio ${(frameRatio * 100).toFixed(1)}% ` +
        `(sky band ${((skyNight / Math.max(1e-6, skyNoon)) * 100).toFixed(1)}%)`
    );
    report.dayNight = {
      noonMean: noonShot.mean,
      midnightMean: midnightShot.mean,
      ratio: frameRatio,
      skyNoon,
      skyNight,
      noonPhase: noonSnap.dayPhase,
      midnightPhase: midnightSnap.dayPhase,
    };

    // Back to daylight for the rest of the run.
    await page.evaluate(`window.__GAME__.dayNight.setTimeOfDay(0.42)`);
    await frames(page, 4);

    /* ══════════════════ BEAT 9 — HUD SCREENS ═══════════════════════════ */
    say('\n[beat 9] HUD screens — rank board, quest log, pause');
    for (const screen of ['rank', 'quests', 'pause'] as const) {
      await page.evaluate(`window.__GAME__.hud.show(${JSON.stringify(screen)})`);
      await frames(page, 5);
      const mounted = (await page.evaluate(
        `(() => {
           const n = document.querySelector('[data-screen="${screen}"]');
           if (n === null) return null;
           return {
             visible: getComputedStyle(n).display !== 'none' && getComputedStyle(n).visibility !== 'hidden',
             text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
           };
         })()`
      )) as { visible: boolean; text: string } | null;
      say(`  ${screen}: ${mounted === null ? 'NOT MOUNTED' : JSON.stringify(mounted)}`);
      if (mounted === null) failures.push(`HUD screen "${screen}" did not mount`);
      else if (mounted.text.length < 8) {
        failures.push(`HUD screen "${screen}" mounted empty`);
      }
      await shoot(`play-09-hud-${screen}`);
    }
    await page.evaluate(`window.__GAME__.hud.show('hud')`);
    await frames(page, 4);

    /* ══════════════════ BEAT 10 — JUMP APEX ════════════════════════════ */
    say('\n[beat 10] jump apex — the district from the top of a held jump');
    await ensureGrounded('before the jump');
    const beforeJump = await snap();
    say(`  standing at (${beforeJump.x}, ${beforeJump.y}, ${beforeJump.z}) state '${beforeJump.state}'`);
    if (beforeJump.y < -2) failures.push('could not get the player back onto solid ground to jump');
    await page.evaluate(
      `(() => { const g = window.__GAME__;
         // Pitch the camera down so the apex frames the district, not the sky.
         if (g.player.camera.pitch !== undefined) g.player.camera.pitch = -0.35;
         window.__INPUT__.setMove(0, 0);
         window.__INPUT__.press('jump'); })()`
    );
    let peak = -Infinity;
    let peakFrame = 0;
    let falling = 0;
    // 27 m under this world's gravity is a launch of roughly 23 m/s and about
    // 2.3 s of climb, which at the clock's 1/15 s ceiling is ~35 frames. The
    // cap is comfortably past that so the apex is never clipped by the loop.
    for (let i = 0; i < 48; i++) {
      await frames(page, 1);
      const y = (await page.evaluate(
        `window.__GAME_DIAG__.world.playerPosition.y`
      )) as number;
      if (y > peak) {
        peak = y;
        peakFrame = i;
        falling = 0;
      } else {
        falling++;
      }
      if (falling >= 2) break;
    }
    // RISE, not absolute Y: the apex the design promises is height above the
    // street the player left, and the street is not at zero everywhere.
    const rise = peak - beforeJump.y;
    say(
      `  apex ${peak.toFixed(1)} m absolute, ${rise.toFixed(1)} m above the street, ` +
        `after ${peakFrame + 1} frames of held jump`
    );
    await shoot('play-10-jump-apex');
    await page.evaluate(`window.__INPUT__.release('jump')`);
    // 27 m is the design figure for a held jump; 18 m still clears every
    // low-rise in City Z, so that is the failure line and the real number is
    // always printed.
    if (rise < 18) failures.push(`held jump rose ${rise.toFixed(1)} m, design apex is ~27 m`);
    report.jump = {
      apexMetres: Number(peak.toFixed(2)),
      riseMetres: Number(rise.toFixed(2)),
      fromY: beforeJump.y,
      framesToApex: peakFrame + 1,
    };

    // Land before the budget reading, so the shot is of a settled world.
    for (let i = 0; i < 20; i++) {
      await frames(page, 1);
      const state = (await page.evaluate(`window.__GAME_DIAG__.world.playerState`)) as string;
      if (state !== 'fall' && state !== 'jumpLaunch') break;
    }

    /* ══════════════════ BUDGETS — HIGH TIER ════════════════════════════ */
    say('\n[budget] high tier, counted on a live frame');
    // FROM STREET LEVEL, LOOKING AT THE CITY. A budget read from a camera that
    // has fallen through the world is a lie in the flattering direction: the
    // frustum deletes most of the district and the triangle count collapses to
    // a third while the shadow cascades — which do not care where the camera
    // is — keep the draw calls high.
    await ensureGrounded('before the budget reading');
    await page.evaluate(
      `(() => { const g = window.__GAME__; g.player.camera.pitch = -0.05; })()`
    );
    await frames(page, 6);
    const highBudget = await snap();
    say(
      `  measured from (${highBudget.x}, ${highBudget.y}, ${highBudget.z}) with ` +
        `${highBudget.residentChunks} chunks resident, ${highBudget.civilians} civilians, ` +
        `${highBudget.monsters} monsters, ${highBudget.debrisLive} debris`
    );
    // Attribution: how much of the per-frame total is the shadow pass? The
    // renderer resets `info` at the top of its own `render()`, so a frame with
    // shadows off and one with them on differ by exactly the shadow cost.
    const noShadow = (await page.evaluate(`(() => {
      const g = window.__GAME__;
      const was = g.renderer.raw.shadowMap.enabled;
      g.renderer.raw.shadowMap.enabled = false;
      g.renderer.render(g.scene, g.camera);
      const s = { drawCalls: g.renderer.raw.info.render.calls,
                  triangles: g.renderer.raw.info.render.triangles };
      g.renderer.raw.shadowMap.enabled = was;
      g.renderer.render(g.scene, g.camera);
      return s;
    })()`)) as { drawCalls: number; triangles: number };
    say(
      `  draw calls  ${highBudget.drawCalls} / ${BUDGETS.high.drawCalls}` +
        `   (without the shadow pass: ${noShadow.drawCalls})`
    );
    say(
      `  triangles   ${highBudget.triangles.toLocaleString()} / ` +
        `${BUDGETS.high.triangles.toLocaleString()}` +
        `   (without the shadow pass: ${noShadow.triangles.toLocaleString()})`
    );
    say(
      `  textures    ${(highBudget.textureBytes / 1048576).toFixed(1)} MB / ` +
        `${BUDGETS.high.textureBytes / 1048576} MB  across ${highBudget.textureCount} textures`
    );
    say(
      `  geometry ${(highBudget.geometryBytes / 1048576).toFixed(1)} MB, ` +
        `${highBudget.sceneTriangles.toLocaleString()} resident tris, ` +
        `${highBudget.instances} instances, ${highBudget.programs} shader programs`
    );
    if (highBudget.drawCalls > BUDGETS.high.drawCalls) {
      failures.push(
        `HIGH draw calls ${highBudget.drawCalls} over budget ${BUDGETS.high.drawCalls}` +
          ` (+${highBudget.drawCalls - BUDGETS.high.drawCalls})`
      );
    }
    if (highBudget.triangles > BUDGETS.high.triangles) {
      failures.push(
        `HIGH triangles ${highBudget.triangles.toLocaleString()} over budget ` +
          `${BUDGETS.high.triangles.toLocaleString()} ` +
          `(${(highBudget.triangles / BUDGETS.high.triangles).toFixed(2)}x)`
      );
    }
    if (highBudget.textureBytes > BUDGETS.high.textureBytes) {
      failures.push(
        `HIGH texture memory ${(highBudget.textureBytes / 1048576).toFixed(1)} MB over budget ` +
          `${BUDGETS.high.textureBytes / 1048576} MB`
      );
    }
    report.budgetHigh = { ...highBudget, withoutShadowPass: noShadow, budget: BUDGETS.high };

    /* ══════════════════ LIVENESS ═══════════════════════════════════════ */
    say('\n[liveness] is the loop still drawing?');
    const beforeIdle = await snap();
    await frames(page, 6);
    const finalSnap = await snap();
    const rawCalls = (await page.evaluate(
      `window.__GAME__.renderer.raw.info.render.calls`
    )) as number;
    say(`  frame ${beforeIdle.frame} -> ${finalSnap.frame};  renderer.info.render.calls ${rawCalls}`);
    if (rawCalls <= 0) failures.push('renderer.info.render.calls is 0 — the last frame drew nothing');
    if (finalSnap.frame <= beforeIdle.frame) failures.push('the frame counter stopped advancing');
    if (finalSnap.errors.length > 0) {
      failures.push(`${finalSnap.errors.length} diagnostic errors: ${finalSnap.errors.join(' | ')}`);
    }
    if (finalSnap.impostorDrift > 0) {
      failures.push(`${finalSnap.impostorDrift} impostor silhouettes disagree with their building`);
    }
    report.final = finalSnap;
    report.ledger = await page.evaluate(`(() => {
      const p = window.__PT__;
      return { freezes: p.freezes.length, killed: p.killed.length, detached: p.detached.length,
               shockwaves: p.shockwaves.length, allyDowned: p.allyDowned.length,
               civilianLost: p.civilianLost.length, encounters: p.encounters };
    })()`);
    say(`  ledger ${JSON.stringify(report.ledger)}`);
    report.outOfWorld = outOfWorld;
    if (outOfWorld.length > 0) {
      say(`  player left the world ${outOfWorld.length} time(s): ${outOfWorld.join('; ')}`);
      failures.push(
        `the player fell out of the world ${outOfWorld.length} time(s) and nothing in the game ` +
          `recovered him — no kill plane, no respawn, no depth clamp (${outOfWorld[0]})`
      );
    }

    /* ══════════════════ BUDGETS — LOW TIER ═════════════════════════════ */
    say('\n[budget] low tier, second page, same city');
    const lowPage = await browser.newPage({
      viewport: VIEW,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    const lowErrors: string[] = [];
    lowPage.on('console', (m) => {
      if (m.type() === 'error') lowErrors.push(m.text().slice(0, 400));
    });
    lowPage.on('pageerror', (e) => lowErrors.push(`pageerror: ${e.message}`));
    await lowPage.goto(`${base}?tier=low&nosave=1`, { waitUntil: 'load', timeout: 300_000 });
    await lowPage.waitForFunction(() => window.__GAME_READY__ === true, undefined, {
      timeout: 300_000,
    });
    // Fill the resident ring so the reading is of a populated city, not of the
    // one chunk that happened to be built at first frame.
    await lowPage.evaluate(`window.__GAME__.cityStreamer.buildImmediate(1)`);
    await frames(lowPage, 10);
    const lowBudget = (await lowPage.evaluate(SNAPSHOT)) as ISnapshot;
    await lowPage.screenshot({ path: path.join(OUT, 'play-11-low-tier.png'), timeout: 300_000 });
    shots.push(await analyse('play-11-low-tier', path.join(OUT, 'play-11-low-tier.png')));
    say(`  render tier ${lowBudget.tier}, asset tier ${lowBudget.assetTier}`);
    say(`  draw calls  ${lowBudget.drawCalls} / ${BUDGETS.low.drawCalls}`);
    say(
      `  triangles   ${lowBudget.triangles.toLocaleString()} / ` +
        `${BUDGETS.low.triangles.toLocaleString()}`
    );
    say(
      `  textures    ${(lowBudget.textureBytes / 1048576).toFixed(1)} MB / ` +
        `${BUDGETS.low.textureBytes / 1048576} MB  across ${lowBudget.textureCount} textures`
    );
    say(`  ${lowBudget.residentChunks} chunks, ${lowBudget.civilians} civilians, ${lowBudget.programs} programs`);
    if (lowBudget.tier !== 'low') failures.push(`low page came up at tier '${lowBudget.tier}'`);
    if (lowBudget.drawCalls > BUDGETS.low.drawCalls) {
      failures.push(
        `LOW draw calls ${lowBudget.drawCalls} over budget ${BUDGETS.low.drawCalls}` +
          ` (+${lowBudget.drawCalls - BUDGETS.low.drawCalls})`
      );
    }
    if (lowBudget.triangles > BUDGETS.low.triangles) {
      failures.push(
        `LOW triangles ${lowBudget.triangles.toLocaleString()} over budget ` +
          `${BUDGETS.low.triangles.toLocaleString()} ` +
          `(${(lowBudget.triangles / BUDGETS.low.triangles).toFixed(2)}x)`
      );
    }
    if (lowBudget.textureBytes > BUDGETS.low.textureBytes) {
      failures.push(
        `LOW texture memory ${(lowBudget.textureBytes / 1048576).toFixed(1)} MB over budget ` +
          `${BUDGETS.low.textureBytes / 1048576} MB`
      );
    }
    if (lowBudget.errors.length > 0) {
      failures.push(`low tier recorded ${lowBudget.errors.length} diagnostic errors`);
    }
    consoleErrors.push(...lowErrors);
    report.budgetLow = { ...lowBudget, budget: BUDGETS.low };
    await lowPage.close();
  } finally {
    // Written in `finally` on purpose: a run that dies at beat seven still
    // leaves everything the first six beats measured on disk, which is the
    // difference between a diagnosable failure and starting over.
    report.shots = shots;
    report.notes = notes;
    await writeFile(
      path.join(OUT, 'playthrough-report.json'),
      `${JSON.stringify(report, null, 2)}\n`
    );
    await browser?.close();
    served.server.close();
  }

  /* ══════════════════ ERROR GATE ══════════════════════════════════════ */
  say('\n[errors] across the whole run');
  say(`  console + page errors: ${consoleErrors.length}`);
  for (const error of consoleErrors.slice(0, 10)) say(`    - ${error}`);
  say(`  server 404s: ${served.misses.length}`);
  for (const miss of [...new Set(served.misses)].slice(0, 10)) say(`    - ${miss}`);
  if (consoleErrors.length > 0) {
    failures.push(`${consoleErrors.length} console/page errors, first: ${consoleErrors[0]}`);
  }
  if (served.misses.length > 0) {
    failures.push(
      `${served.misses.length} asset 404s, e.g. ${[...new Set(served.misses)].slice(0, 3).join(', ')}`
    );
  }

  say('\n──────── notes ────────');
  for (const note of notes) say(`  ${note}`);

  say('\n──────── result ────────');
  if (failures.length > 0) {
    console.error(`PLAYTHROUGH FAILED — ${failures.length} problem(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  say('PLAYTHROUGH PASSED — ten beats, no errors, the loop still drawing.');
}

main().catch((error) => {
  console.error('playthrough crashed:', error);
  process.exit(1);
});
