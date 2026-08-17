/**
 * PHYSICS HARNESS
 *
 * Exercises the physics wrapper in a real browser and publishes measurements to
 * `window.__PHYSICS_HARNESS__` for `harness/physics.verify.ts` to assert on.
 *
 * Five scenarios, in order:
 *   1. DEBRIS   — 300 pooled pieces dropped into an arena and settled, with the
 *                 CPU cost of the simulation step measured while every body is
 *                 still awake (the worst case, not the flattering average).
 *   2. RAGDOLL  — nine ragdolls spawned against a cap of eight, blended from a
 *                 posed skeleton, then checked for joint separation and jitter.
 *   3. DETERMINISM — the same seeded 300-body scenario run twice in two fresh
 *                 worlds; final transforms compared for EXACT equality.
 *   4. CHARACTER — run, dash, jump to apex, and a 40 m drop that must fire
 *                 `PlayerLanded` with `createsCrater`.
 *   5. RENDER   — the settled pile is drawn so the screenshot proves the state
 *                 is real geometry and not an empty scene.
 *
 * ── ABOUT TIMING ───────────────────────────────────────────────────────────
 * The verification browser runs SwiftShader, a CPU rasteriser. Frame rate here
 * is a measure of the software renderer and says NOTHING about the game, so no
 * fps is reported. The physics step is different: it is wasm on a real CPU, so
 * `performance.now()` around `world.step()` is a genuine measurement.
 */

import * as THREE from 'three';
import { EventBus, createRng } from '@/util';
import type { PlayerLandedEvent } from '@/types';
import {
  CharacterController,
  DASH_SPEED,
  DEBRIS_HARD_CAP,
  DebrisPool,
  FIXED_STEP,
  GROUND_SLAM_FALL_HEIGHT,
  ImpulsePropagator,
  JUMP_APEX_HEIGHT,
  MAX_ACTIVE_RAGDOLLS,
  PhysicsWorld,
  RAGDOLL_BODY_COUNT,
  RUN_SPEED,
  type Ragdoll,
  RagdollManager,
  SIM_BUDGET_MS,
  createReferenceRig,
  initPhysics,
  physicsInitDurationMs,
  poseRigIdle,
} from '@/physics';
import {
  generateDebrisField,
  makeArenaWalls,
  makeGround,
  maxAbsDifference,
  snapshotPositions,
} from '@/physics/test-support';

/* -------------------------------------------------------------------------- */
/* Result shape                                                               */
/* -------------------------------------------------------------------------- */

interface TimingSummary {
  samples: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

interface HarnessReport {
  seed: string;
  rapierInitMs: number;
  debris: {
    spawned: number;
    simulated: number;
    ballistic: number;
    stepsAwake: number;
    stepsTotal: number;
    /** Cost of the first few steps, excluded from the summaries below. */
    warmupMs: number[];
    /** Step cost while all 300 bodies are awake — the number that matters. */
    awake: TimingSummary;
    /** Step cost across the whole settle, sleeping bodies included. */
    whole: TimingSummary;
    /** Pool update (mesh sync + ballistic integration) cost. */
    poolUpdate: TimingSummary;
    awakeAtEnd: number;
    settledAtEnd: number;
    lowestY: number;
    highestY: number;
    /** Resting height range of the ballistic (non-simulated) pieces. */
    ballisticLowestY: number;
    ballisticHighestY: number;
    budgetMs: number;
  };
  ragdoll: {
    spawned: number;
    bodiesEach: number;
    cap: number;
    activeAfterCap: number;
    frozenAfterCap: number;
    blendAtOneFrame: number;
    blendAfterWindow: number;
    maxJointSeparationM: number;
    maxSpeedAfterSettleMs: number;
    maxSpeedDuringSettleMs: number;
    anyNonFinite: boolean;
    lowestY: number;
    stepMs: TimingSummary;
  };
  determinism: {
    bodies: number;
    values: number;
    maxDelta: number;
    identical: boolean;
    differentSeedDelta: number;
  };
  character: {
    runDistanceM: number;
    dashDistanceM: number;
    jumpApexM: number;
    targetApexM: number;
    landingImpactSpeed: number;
    landingFallHeight: number;
    createsCrater: boolean;
    playerLandedEvents: number;
    groundSlamAffected: number;
  };
  render: {
    drawCalls: number;
    triangles: number;
    frames: number;
    width: number;
    height: number;
  };
  errors: string[];
}

declare global {
  interface Window {
    __PHYSICS_READY__?: boolean;
    __PHYSICS_HARNESS__?: HarnessReport;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const SEED = 'saitama-physics-harness';
const panel = document.getElementById('panel') as HTMLElement;
const errors: string[] = [];

/**
 * Update the on-page status and hand control back to the browser.
 *
 * The scenarios are long synchronous blocks, so without an explicit yield the
 * page never paints any of these and simply looks hung.
 */
async function status(text: string): Promise<void> {
  panel.innerHTML = `<h1>Physics harness</h1><span class="dim">${text}</span>`;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function summarise(samples: readonly number[]): TimingSummary {
  if (samples.length === 0) return { samples: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    samples: sorted.length,
    avgMs: round(total / sorted.length),
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
    maxMs: round(sorted[sorted.length - 1]!),
  };
}

function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/* -------------------------------------------------------------------------- */
/* Scenario 1 — 300 debris pieces                                             */
/* -------------------------------------------------------------------------- */

interface DebrisScene {
  world: PhysicsWorld;
  pool: DebrisPool;
  report: HarnessReport['debris'];
}

const AWAKE_STEPS = 240;
const SETTLE_STEPS = 1200;
/**
 * Steps excluded from the timing summary.
 *
 * The very first steps after 300 bodies appear pay for the initial BVH build
 * and for V8 tiering up the wasm module — tens of milliseconds that recur
 * never again. Reporting them inside the average would misrepresent the
 * steady-state cost, so they are excluded and listed separately instead.
 */
const WARMUP_STEPS = 8;

function runDebrisScenario(container: THREE.Object3D): DebrisScene {
  const world = new PhysicsWorld({ contactEvents: false });
  makeGround(world);
  makeArenaWalls(world, 7, 5);

  const pool = new DebrisPool(world, {
    capacity: DEBRIS_HARD_CAP,
    container,
    rng: createRng(`${SEED}:debris`),
    // Keep the pile alive for the screenshot instead of fading it out.
    restSeconds: 1e6,
    material: new THREE.MeshStandardMaterial({
      color: 0x9a938a,
      roughness: 0.92,
      metalness: 0.02,
      vertexColors: true,
    }),
  });

  const rng = createRng(SEED);
  const specs = generateDebrisField(rng, DEBRIS_HARD_CAP, {
    spread: 4.5,
    minHeight: 2,
    maxHeight: 20,
    minSize: 0.2,
    maxSize: 0.62,
    impulse: 25,
    // A fifth of the field is gravel, which skips the solver entirely.
    gravelFraction: 0.2,
  });

  // Give each piece a slightly different tone so the pile reads as rubble
  // rather than as one grey blob — and so the screenshot has real variance.
  const tint = createRng(`${SEED}:tint`);
  for (const spec of specs) {
    const count = spec.chunk.geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    const shade = tint.range(0.35, 1.0);
    const warm = tint.range(0.85, 1.15);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = shade * warm;
      colors[i * 3 + 1] = shade;
      colors[i * 3 + 2] = shade * (2 - warm);
    }
    spec.chunk.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    pool.spawn(spec.chunk, spec.matrix, spec.impulse);
  }

  const awakeSamples: number[] = [];
  const wholeSamples: number[] = [];
  const poolSamples: number[] = [];
  const warmupSamples: number[] = [];

  for (let i = 0; i < SETTLE_STEPS; i++) {
    const t0 = performance.now();
    world.step(FIXED_STEP, 1);
    const t1 = performance.now();
    pool.update(FIXED_STEP);
    const t2 = performance.now();

    const stepMs = t1 - t0;
    if (i < WARMUP_STEPS) warmupSamples.push(round(stepMs, 2));
    else {
      wholeSamples.push(stepMs);
      poolSamples.push(t2 - t1);
      if (i < AWAKE_STEPS) awakeSamples.push(stepMs);
    }
  }

  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  let lowestY = Infinity;
  let highestY = -Infinity;
  let ballisticLowestY = Infinity;
  let ballisticHighestY = -Infinity;
  for (const piece of pool.pieces) {
    if (piece.bodyHandle < 0) {
      // Ballistic pieces live only as meshes; read the mesh instead.
      ballisticLowestY = Math.min(ballisticLowestY, piece.mesh.position.y);
      ballisticHighestY = Math.max(ballisticHighestY, piece.mesh.position.y);
      continue;
    }
    world.getBody(piece.bodyHandle)!.getTransform(position, rotation);
    lowestY = Math.min(lowestY, position.y);
    highestY = Math.max(highestY, position.y);
  }

  return {
    world,
    pool,
    report: {
      spawned: pool.count,
      simulated: pool.simulatedCount,
      ballistic: pool.ballisticCount,
      stepsAwake: AWAKE_STEPS - WARMUP_STEPS,
      stepsTotal: SETTLE_STEPS - WARMUP_STEPS,
      warmupMs: warmupSamples,
      awake: summarise(awakeSamples),
      whole: summarise(wholeSamples),
      poolUpdate: summarise(poolSamples),
      awakeAtEnd: world.activeBodyCount,
      settledAtEnd: pool.settledCount,
      lowestY: round(lowestY, 3),
      highestY: round(highestY, 3),
      ballisticLowestY: round(ballisticLowestY, 3),
      ballisticHighestY: round(ballisticHighestY, 3),
      budgetMs: SIM_BUDGET_MS,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Scenario 2 — ragdolls                                                      */
/* -------------------------------------------------------------------------- */

interface RagdollScene {
  world: PhysicsWorld;
  manager: RagdollManager;
  ragdolls: Ragdoll[];
  group: THREE.Group;
  report: HarnessReport['ragdoll'];
}

/** Largest gap between the two anchor points of any joint, in metres. */
function maxJointSeparation(ragdolls: readonly Ragdoll[]): number {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const q = new THREE.Quaternion();
  let worst = 0;
  for (const ragdoll of ragdolls) {
    // A disposed ragdoll's joints are freed wasm handles; a frozen one is
    // motionless. Neither is worth measuring, and the first would trap.
    if (ragdoll.isDisposed || ragdoll.frozen) continue;
    for (const segment of ragdoll.segments) {
      const joint = segment.joint;
      if (joint === undefined) continue;
      const p1 = joint.body1().translation();
      const r1 = joint.body1().rotation();
      const p2 = joint.body2().translation();
      const r2 = joint.body2().rotation();
      const anchor1 = joint.anchor1();
      const anchor2 = joint.anchor2();
      a.set(anchor1.x, anchor1.y, anchor1.z)
        .applyQuaternion(q.set(r1.x, r1.y, r1.z, r1.w))
        .add(new THREE.Vector3(p1.x, p1.y, p1.z));
      b.set(anchor2.x, anchor2.y, anchor2.z)
        .applyQuaternion(q.set(r2.x, r2.y, r2.z, r2.w))
        .add(new THREE.Vector3(p2.x, p2.y, p2.z));
      worst = Math.max(worst, a.distanceTo(b));
    }
  }
  return worst;
}

function maxLimbSpeed(ragdolls: readonly Ragdoll[]): number {
  const v = new THREE.Vector3();
  let max = 0;
  for (const ragdoll of ragdolls) {
    if (ragdoll.isDisposed || ragdoll.frozen) continue;
    for (const segment of ragdoll.segments) {
      segment.body.getLinearVelocity(v);
      max = Math.max(max, v.length());
    }
  }
  return max;
}

function runRagdollScenario(): RagdollScene {
  const world = new PhysicsWorld({ contactEvents: false });
  makeGround(world);
  const manager = new RagdollManager(world);
  const rng = createRng(`${SEED}:ragdoll`);
  const group = new THREE.Group();

  const ragdolls: Ragdoll[] = [];
  const SPAWN_COUNT = MAX_ACTIVE_RAGDOLLS + 1; // one over the cap, on purpose
  for (let i = 0; i < SPAWN_COUNT; i++) {
    const rig = createReferenceRig(
      1.7 + rng.range(0, 0.15),
      new THREE.Vector3(rng.range(-5, 5), 0.02, rng.range(-4, 4))
    );
    poseRigIdle(rig);
    ragdolls.push(
      manager.spawn(
        rig,
        { driveSkeleton: false },
        // A firm shove, not a catapult: enough to topple, not to test the clamp.
        new THREE.Vector3(rng.range(-120, 120), rng.range(40, 120), rng.range(-120, 120)),
        new THREE.Vector3(rng.range(-0.2, 0.2), 1.3, 0)
      )
    );
  }

  const activeAfterCap = manager.activeCount;
  const frozenAfterCap = ragdolls.filter((r) => r.frozen).length;

  // One frame in: the blend must barely have started.
  world.step(FIXED_STEP, 1);
  manager.update(FIXED_STEP);
  const blendAtOneFrame = round(ragdolls[ragdolls.length - 1]!.blend, 4);

  const stepSamples: number[] = [];
  let maxSeparation = 0;
  let maxSpeedDuring = 0;
  const SETTLE = 300;
  for (let i = 0; i < SETTLE; i++) {
    const t0 = performance.now();
    world.step(FIXED_STEP, 1);
    stepSamples.push(performance.now() - t0);
    manager.update(FIXED_STEP);
    maxSeparation = Math.max(maxSeparation, maxJointSeparation(ragdolls));
    maxSpeedDuring = Math.max(maxSpeedDuring, maxLimbSpeed(ragdolls));
  }

  // Build simple capsule proxies so the ragdolls appear in the screenshot.
  const material = new THREE.MeshStandardMaterial({
    color: 0xffd23f,
    roughness: 0.5,
    metalness: 0.1,
  });
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  let anyNonFinite = false;
  let lowestY = Infinity;
  for (const ragdoll of ragdolls) {
    if (ragdoll.isDisposed) continue;
    for (const segment of ragdoll.segments) {
      segment.body.getTransform(position, rotation);
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
        anyNonFinite = true;
        continue;
      }
      lowestY = Math.min(lowestY, position.y);
      const radius = Math.max(0.03, segment.spec.radiusScale * 1.75);
      const length = Math.max(0.08, segment.spec.lengthScale * 1.75);
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 8), material);
      mesh.castShadow = true;
      mesh.position.copy(position);
      mesh.quaternion.copy(rotation);
      group.add(mesh);
    }
  }

  return {
    world,
    manager,
    ragdolls,
    group,
    report: {
      spawned: SPAWN_COUNT,
      bodiesEach: RAGDOLL_BODY_COUNT,
      cap: MAX_ACTIVE_RAGDOLLS,
      activeAfterCap,
      frozenAfterCap,
      blendAtOneFrame,
      blendAfterWindow: round(ragdolls[ragdolls.length - 1]!.blend, 4),
      maxJointSeparationM: round(maxSeparation, 5),
      maxSpeedAfterSettleMs: round(maxLimbSpeed(ragdolls), 5),
      maxSpeedDuringSettleMs: round(maxSpeedDuring, 3),
      anyNonFinite,
      lowestY: round(lowestY, 3),
      stepMs: summarise(stepSamples),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Scenario 3 — determinism                                                   */
/* -------------------------------------------------------------------------- */

/** Headless 300-body run used twice to prove reproducibility. */
function determinismRun(seed: string): Float64Array {
  const world = new PhysicsWorld({ contactEvents: false });
  makeGround(world);
  makeArenaWalls(world, 7, 5);
  const pool = new DebrisPool(world, {
    capacity: DEBRIS_HARD_CAP,
    rng: createRng(`${seed}:debris`),
    restSeconds: 1e6,
  });
  const specs = generateDebrisField(createRng(seed), DEBRIS_HARD_CAP, {
    spread: 4.5,
    minHeight: 2,
    maxHeight: 20,
    minSize: 0.22,
    maxSize: 0.62,
    impulse: 25,
  });
  for (const spec of specs) pool.spawn(spec.chunk, spec.matrix, spec.impulse);
  for (let i = 0; i < 600; i++) {
    world.step(FIXED_STEP, 1);
    pool.update(FIXED_STEP);
  }
  const snapshot = snapshotPositions(
    pool.pieces.filter((p) => p.bodyHandle >= 0).map((p) => world.getBody(p.bodyHandle)!)
  );
  for (const spec of specs) spec.geometry.dispose();
  pool.dispose();
  world.dispose();
  return snapshot;
}

function runDeterminismScenario(): HarnessReport['determinism'] {
  const a = determinismRun(`${SEED}:det`);
  const b = determinismRun(`${SEED}:det`);
  const c = determinismRun(`${SEED}:det-other`);
  const delta = maxAbsDifference(a, b);
  return {
    bodies: a.length / 7,
    values: a.length,
    maxDelta: delta,
    identical: delta === 0,
    differentSeedDelta: round(maxAbsDifference(a, c), 4),
  };
}

/* -------------------------------------------------------------------------- */
/* Scenario 4 — character controller                                          */
/* -------------------------------------------------------------------------- */

function runCharacterScenario(): HarnessReport['character'] {
  const bus = new EventBus();
  const landings: PlayerLandedEvent[] = [];
  bus.on('PlayerLanded', (event) => landings.push(event));

  const world = new PhysicsWorld({ eventBus: bus, contactEvents: false });
  makeGround(world);
  const propagator = new ImpulsePropagator(world, { rng: createRng(`${SEED}:shock`) });
  propagator.attach(bus);

  // Loose rubble for the ground slam to shove.
  for (let i = 0; i < 12; i++) {
    world.createBody({
      type: 'dynamic',
      shape: { kind: 'box', halfExtents: new THREE.Vector3(0.25, 0.25, 0.25) },
      position: new THREE.Vector3(Math.cos(i) * 3, 0.3, Math.sin(i) * 3),
      layer: 'debris',
      collidesWith: ['world', 'debris', 'player'],
      density: 2400,
    });
  }

  const player = new CharacterController(world, {
    position: new THREE.Vector3(0, 1.2, 0),
    intent: 'serious',
    rng: createRng(`${SEED}:slam`),
  });
  const still = new THREE.Vector3(0, 0, 0);
  const forward = new THREE.Vector3(0, 0, -1);

  const settle = (steps: number): void => {
    for (let i = 0; i < steps; i++) {
      player.move(still, FIXED_STEP);
      world.step(FIXED_STEP, 1);
    }
  };
  settle(30);

  // Run for one second.
  const runStart = player.translation.z;
  for (let i = 0; i < 60; i++) {
    player.moveInDirection(forward, FIXED_STEP);
    world.step(FIXED_STEP, 1);
  }
  const runDistance = Math.abs(player.translation.z - runStart);

  // Dash for one second.
  player.dashing = true;
  const dashStart = player.translation.z;
  for (let i = 0; i < 60; i++) {
    player.moveInDirection(forward, FIXED_STEP);
    world.step(FIXED_STEP, 1);
  }
  const dashDistance = Math.abs(player.translation.z - dashStart);
  player.dashing = false;

  // Jump and measure the apex.
  settle(20);
  const takeOff = player.translation.y;
  player.jump();
  let apex = takeOff;
  for (let i = 0; i < 900; i++) {
    player.move(still, FIXED_STEP);
    world.step(FIXED_STEP, 1);
    apex = Math.max(apex, player.translation.y);
    if (i > 5 && player.isGrounded) break;
  }

  // A 40 m drop onto the rubble: must crater and shove.
  landings.length = 0;
  player.setPosition(new THREE.Vector3(0, 40, 0));
  for (let i = 0; i < 900; i++) {
    player.move(still, FIXED_STEP);
    world.step(FIXED_STEP, 1);
    if (i > 5 && player.isGrounded) break;
  }

  const landing = landings[landings.length - 1];
  const report: HarnessReport['character'] = {
    runDistanceM: round(runDistance, 3),
    dashDistanceM: round(dashDistance, 3),
    jumpApexM: round(apex - takeOff, 3),
    targetApexM: JUMP_APEX_HEIGHT,
    landingImpactSpeed: round(landing?.impactSpeed ?? 0, 3),
    landingFallHeight: round(landing?.fallHeight ?? 0, 3),
    createsCrater: landing?.createsCrater ?? false,
    playerLandedEvents: landings.length,
    groundSlamAffected: player.lastGroundSlamAffected,
  };

  propagator.detach();
  player.dispose();
  world.dispose();
  return report;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function buildScene(debrisContainer: THREE.Object3D, ragdollGroup: THREE.Group): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141922);
  scene.fog = new THREE.Fog(0x141922, 24, 70);

  const hemi = new THREE.HemisphereLight(0x9fb6d8, 0x2b2620, 1.1);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff2d8, 2.4);
  key.position.set(9, 14, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 45;
  key.shadow.camera.left = -14;
  key.shadow.camera.right = 14;
  key.shadow.camera.top = 14;
  key.shadow.camera.bottom = -14;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x5fa8ff, 0.9);
  rim.position.set(-8, 5, -9);
  scene.add(rim);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // A grid gives the flat floor some structure in the screenshot.
  const grid = new THREE.GridHelper(60, 60, 0x4c5566, 0x333a45);
  grid.position.y = 0.002;
  scene.add(grid);

  scene.add(debrisContainer);
  ragdollGroup.position.set(5.5, 0, 7.5);
  scene.add(ragdollGroup);
  return scene;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

function renderPanel(report: HarnessReport): void {
  const ok = (value: boolean): string => (value ? 'ok' : 'bad');
  const d = report.debris;
  const r = report.ragdoll;
  const c = report.character;
  panel.innerHTML =
    `<h1>Physics harness</h1>` +
    `<span class="dim">seed</span> ${report.seed}\n` +
    `<span class="dim">rapier init</span> ${report.rapierInitMs.toFixed(1)} ms\n\n` +
    `<b>DEBRIS</b>  ${d.spawned} pieces (${d.simulated} solved, ${d.ballistic} ballistic)\n` +
    `  step, all awake  avg <b class="${ok(d.awake.avgMs < d.budgetMs)}">${d.awake.avgMs.toFixed(3)} ms</b>` +
    `  p95 ${d.awake.p95Ms.toFixed(3)}  max ${d.awake.maxMs.toFixed(3)}\n` +
    `  step, full settle avg ${d.whole.avgMs.toFixed(3)} ms   budget ${d.budgetMs} ms\n` +
    `  pool update      avg ${d.poolUpdate.avgMs.toFixed(3)} ms\n` +
    `  settled ${d.settledAtEnd}/${d.spawned}   y range ${d.lowestY} … ${d.highestY}\n\n` +
    `<b>RAGDOLL</b>  ${r.spawned} spawned, cap ${r.cap}, ${r.bodiesEach} bodies each\n` +
    `  active ${r.activeAfterCap}, frozen ${r.frozenAfterCap}\n` +
    `  blend 1 frame ${r.blendAtOneFrame}  ->  ${r.blendAfterWindow}\n` +
    `  joint separation max <b class="${ok(r.maxJointSeparationM < 0.05)}">${r.maxJointSeparationM} m</b>\n` +
    `  limb speed after settle <b class="${ok(r.maxSpeedAfterSettleMs < 0.5)}">${r.maxSpeedAfterSettleMs} m/s</b>\n` +
    `  non-finite ${r.anyNonFinite ? '<b class="bad">yes</b>' : '<b class="ok">none</b>'}` +
    `   step avg ${r.stepMs.avgMs.toFixed(3)} ms\n\n` +
    `<b>DETERMINISM</b>  ${report.determinism.bodies} bodies, ` +
    `${report.determinism.values} values\n` +
    `  max |delta| <b class="${ok(report.determinism.identical)}">${report.determinism.maxDelta}</b>` +
    `  (different seed: ${report.determinism.differentSeedDelta})\n\n` +
    `<b>CHARACTER</b>\n` +
    `  run ${c.runDistanceM} m/s   dash ${c.dashDistanceM} m/s   ` +
    `(target ${RUN_SPEED} / ${DASH_SPEED})\n` +
    `  jump apex <b class="${ok(Math.abs(c.jumpApexM - c.targetApexM) < 1.5)}">${c.jumpApexM} m</b>` +
    ` (target ${c.targetApexM})\n` +
    `  landing ${c.landingFallHeight} m at ${c.landingImpactSpeed} m/s  ` +
    `crater <b class="${ok(c.createsCrater)}">${c.createsCrater}</b>` +
    ` (threshold ${GROUND_SLAM_FALL_HEIGHT} m)\n` +
    `  ground slam moved ${c.groundSlamAffected} bodies\n\n` +
    `<span class="dim">SwiftShader software rendering — fps is meaningless here` +
    ` and is deliberately not reported. CPU step times are real.</span>` +
    (report.errors.length > 0 ? `\n\n<b class="bad">ERRORS</b>\n${report.errors.join('\n')}` : '');
}

async function main(): Promise<void> {
  await status('loading rapier…');
  await initPhysics();

  await status('scenario 1/4 — dropping 300 debris pieces…');
  const debrisContainer = new THREE.Group();
  const debris = runDebrisScenario(debrisContainer);

  await status('scenario 2/4 — ragdolls…');
  const ragdoll = runRagdollScenario();

  await status('scenario 3/4 — determinism…');
  const determinism = runDeterminismScenario();

  await status('scenario 4/4 — character controller…');
  const character = runCharacterScenario();

  await status('rendering…');
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = buildScene(debrisContainer, ragdoll.group);
  const camera = new THREE.PerspectiveCamera(
    46,
    window.innerWidth / window.innerHeight,
    0.1,
    200
  );
  camera.position.set(12.5, 8.5, 17.5);
  camera.lookAt(0.6, 0.6, 3.6);

  let frames = 0;
  for (let i = 0; i < 3; i++) {
    renderer.render(scene, camera);
    frames++;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  renderer.render(scene, camera);
  frames++;

  const report: HarnessReport = {
    seed: SEED,
    rapierInitMs: round(physicsInitDurationMs(), 2),
    debris: debris.report,
    ragdoll: ragdoll.report,
    determinism,
    character,
    render: {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      frames,
      width: renderer.domElement.width,
      height: renderer.domElement.height,
    },
    errors,
  };

  renderPanel(report);
  window.__PHYSICS_HARNESS__ = report;
  window.__PHYSICS_READY__ = true;
  console.log('[physics-harness]', JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  errors.push(message);
  panel.innerHTML = `<h1>Physics harness</h1><b class="bad">FAILED</b>\n${message}`;
  window.__PHYSICS_HARNESS__ = {
    seed: SEED,
    rapierInitMs: 0,
    errors,
  } as unknown as HarnessReport;
  window.__PHYSICS_READY__ = true;
  console.error('[physics-harness] failed', error);
});
