/**
 * PLAYER HARNESS
 *
 * Runs `src/entities/player/**` against the REAL Rapier character controller
 * and the REAL input manager, in a browser, and publishes every measurement to
 * `window.__PLAYER_HARNESS__` for `harness/player.verify.ts` to assert on.
 *
 * ── HOW THE GAME IS DRIVEN ─────────────────────────────────────────────────
 * Entirely through the synthetic input driver — `manager.synthetic.setMove()`,
 * `.press()`, `.tap()`. Not one fake `TouchEvent` appears in this file. The
 * synthetic backend is exclusive while enabled, and produces an `InputState`
 * that is bit-identical to what a thumb produces (verified by the input
 * workstream to four decimal places), so a scripted run and a played run are
 * the same run.
 *
 * ── SCENARIOS ──────────────────────────────────────────────────────────────
 *   1  MIRRORS     tuning constants duplicated from physics and input, checked
 *                  against the live modules — a drift fails the harness
 *   2  RUN/DASH    top speed and time-to-speed on a flat plane
 *   3  JUMP        tap apex vs held apex, and the crater on the way down
 *   4  COYOTE      binary-swept: the last delay after a ledge exit that is
 *                  still accepted, and the first that is not
 *   5  BUFFER      swept the same way, before touchdown
 *   6  CAMERA      orbit rate, arm length in each state, FOV at rest and dash
 *   7  ALLEY       a dash through a 2.4 m corridor with the camera orbiting,
 *                  measuring the clearance between the camera and geometry
 *                  EVERY frame — the assertion that matters most
 *   8  DETERMINISM the same script twice in two fresh worlds, compared exactly
 *   9  TIMINGS     batched CPU cost of the controller, camera and solver
 *  10  POSES       four framings captured for the screenshot sequence
 *
 * ── WHY THE SCENARIOS DO NOT RENDER ────────────────────────────────────────
 * Nothing measured here needs a rasteriser, and this box runs several
 * SwiftShader harnesses at once. Poses captured during the scenarios are
 * replayed at the end for the screenshots, so the framing on screen is the
 * framing the camera actually chose, not a re-staged approximation.
 */

import * as THREE from 'three';
import { EventBus, createRng } from '@/util';
import type { InputState, PhysicsLayer } from '@/types';
import {
  CharacterController,
  COYOTE_TIME,
  DASH_SPEED,
  FIXED_STEP,
  GROUND_SLAM_FALL_HEIGHT,
  JUMP_SPEED,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PhysicsWorld,
  RUN_SPEED,
  apexHeightForSpeed,
  initPhysics,
} from '@/physics';
import { DEFAULT_INPUT_TUNING, createInputManager, type IInputManager } from '@/ui/input';
import {
  DEFAULT_PLAYER_TUNING,
  PlayerRig,
  createPhysicsCameraProbe,
  heldJumpApex,
} from '@/entities/player';

/* -------------------------------------------------------------------------- */
/* Report shape                                                               */
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
  player: [number, number, number];
  playerYaw: number;
  camera: [number, number, number];
  quaternion: [number, number, number, number];
  fov: number;
  armLength: number;
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
    /** Airborne time on the clock when the last accepted jump was requested. */
    effectiveWindowMs: number;
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

declare global {
  interface Window {
    __PLAYER_READY__?: boolean;
    __PLAYER_HARNESS__?: HarnessReport;
    __PLAYER_SHOT__?: (pose: string) => boolean;
  }
}

/* -------------------------------------------------------------------------- */
/* Level                                                                      */
/* -------------------------------------------------------------------------- */

const SEED = 'saitama-player-harness';
const DT = FIXED_STEP;
const ALLEY_WIDTH = 2.4;
const ALLEY_CENTRE_Z = 0;
const ALLEY_START_X = 8;
const ALLEY_END_X = 68;
const LEDGE_TOP_Y = 6;
/** Where every locomotion scenario starts. A long, empty lane along -Z. */
const LANE_X = -5;
const LANE_START_Z = 118;

interface Box {
  readonly centre: THREE.Vector3;
  readonly half: THREE.Vector3;
  readonly colour: number;
}

/** A footprint towers must not overlap, so the scenarios run on clear ground. */
interface Keepout {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

const KEEPOUTS: readonly Keepout[] = [
  // The locomotion lane: 30 m wide, the full length of the ground plane. Every
  // speed, jump and determinism run happens inside it, so a tower here would
  // silently turn "top speed" into "top speed until it hit a building" — which
  // is exactly what the first run of this harness measured.
  { minX: -22, maxX: 12, minZ: -160, maxZ: 160 },
  // The alley and its approach.
  { minX: -6, maxX: 78, minZ: -16, maxZ: 16 },
  // The ledge used by the coyote sweep, plus its landing area.
  { minX: -62, maxX: -14, minZ: 12, maxZ: 50 },
];

function overlapsKeepout(x: number, z: number, hx: number, hz: number): boolean {
  return KEEPOUTS.some(
    (k) => x - hx < k.maxX && x + hx > k.minX && z - hz < k.maxZ && z + hz > k.minZ
  );
}

/**
 * A deliberately awkward test level.
 *
 * A clear lane for the speed runs, a raised ledge with a hard edge for the
 * coyote sweep, a 2.4 m alley with 12 m walls for the camera clearance sweep,
 * and a district of towers around all of it so the 14 m apex pull-back has
 * something to actually show.
 */
function buildLevel(): Box[] {
  const boxes: Box[] = [];
  const rng = createRng(`${SEED}:level`);

  // Ground: top surface at y = 0.
  boxes.push({
    centre: new THREE.Vector3(0, -1, 0),
    half: new THREE.Vector3(170, 1, 170),
    colour: 0x2a2f3a,
  });

  // Ledge with a clean edge at x = -26, standing 6 m proud.
  boxes.push({
    centre: new THREE.Vector3(-39, LEDGE_TOP_Y / 2, 30),
    half: new THREE.Vector3(13, LEDGE_TOP_Y / 2, 9),
    colour: 0x39404e,
  });

  // Alley: two 3 m thick, 12 m tall walls with a 2.4 m gap between them.
  const wallHalfZ = 1.5;
  const inner = ALLEY_WIDTH / 2;
  const alleyHalfX = (ALLEY_END_X - ALLEY_START_X) / 2;
  const alleyMidX = (ALLEY_END_X + ALLEY_START_X) / 2;
  for (const sign of [1, -1]) {
    boxes.push({
      centre: new THREE.Vector3(alleyMidX, 6, ALLEY_CENTRE_Z + sign * (inner + wallHalfZ)),
      half: new THREE.Vector3(alleyHalfX, 6, wallHalfZ),
      colour: 0x4a4034,
    });
  }

  // A district of towers, so the apex shot has a skyline. Deterministic, and
  // never inside a keepout.
  for (let gx = 0; gx < 9; gx++) {
    for (let gz = 0; gz < 11; gz++) {
      const x = -100 + gx * 26;
      const z = -130 + gz * 26;
      const hx = rng.range(4, 7);
      const hz = rng.range(4, 7);
      const height = rng.range(9, 36);
      if (overlapsKeepout(x, z, hx, hz)) continue;
      boxes.push({
        centre: new THREE.Vector3(x, height / 2, z),
        half: new THREE.Vector3(hx, height / 2, hz),
        colour: [0x3b4250, 0x46403a, 0x333b46, 0x4d453c][rng.int(0, 3)]!,
      });
    }
  }
  return boxes;
}

const LEVEL = buildLevel();

/* -------------------------------------------------------------------------- */
/* Simulation                                                                 */
/* -------------------------------------------------------------------------- */

const WORLD_COLLIDES: readonly PhysicsLayer[] = ['player', 'monster', 'npc', 'debris', 'ragdoll'];

interface Sim {
  readonly world: PhysicsWorld;
  readonly bus: EventBus;
  readonly controller: CharacterController;
  readonly rig: PlayerRig;
  readonly camera: THREE.PerspectiveCamera;
  readonly landings: { fallHeight: number; impactSpeed: number; createsCrater: boolean }[];
  step(input: InputState): void;
  dispose(): void;
}

interface SimOptions {
  /**
   * Scatter loose crates down the lane.
   *
   * They exist purely as WITNESSES to the ground slam: the physics module
   * pushes nearby dynamic bodies on a cratering landing, and with an empty
   * level "moved 0 bodies" proves nothing either way.
   */
  readonly debris?: boolean;
}

/** Build a fresh world, level, character controller and player rig. */
function makeSim(
  spawn: THREE.Vector3,
  root?: THREE.Object3D | null,
  options: SimOptions = {}
): Sim {
  const bus = new EventBus();
  const world = new PhysicsWorld({ eventBus: bus, contactEvents: false });
  for (const box of LEVEL) {
    world.createBody({
      type: 'fixed',
      shape: { kind: 'box', halfExtents: box.half },
      position: box.centre,
      layer: 'world',
      collidesWith: WORLD_COLLIDES,
      friction: 0.85,
      restitution: 0.02,
    });
  }

  if (options.debris === true) {
    const rng = createRng(`${SEED}:debris`);
    for (let i = 0; i < 90; i++) {
      const z = LANE_START_Z - 20 - i * 3;
      world.createBody({
        type: 'dynamic',
        shape: { kind: 'box', halfExtents: new THREE.Vector3(0.16, 0.16, 0.16) },
        position: new THREE.Vector3(LANE_X + rng.range(-5, 5), 0.17, z + rng.range(-1.5, 1.5)),
        layer: 'debris',
        collidesWith: ['world', 'debris'],
        density: 2400,
        friction: 0.7,
        restitution: 0.05,
      });
    }
  }

  const controller = new CharacterController(world, {
    position: spawn.clone(),
    height: PLAYER_HEIGHT,
    radius: PLAYER_RADIUS,
    // World geometry ONLY. The crates above must not be shoved aside by a
    // 22 m/s capsule before the slam gets a chance to move them, and a
    // locomotion harness has nothing to say about capsule-vs-crate contacts.
    collidesWith: ['world'],
    emitLandingEvents: true,
    groundSlamShock: true,
    rng: createRng(`${SEED}:slam`),
  });

  // Settle onto the ground before the player controller reads a contact state.
  const zero = new THREE.Vector3();
  for (let i = 0; i < 20; i++) {
    controller.move(zero, DT);
    world.step(DT, 1);
  }

  const landings: { fallHeight: number; impactSpeed: number; createsCrater: boolean }[] = [];
  bus.on('PlayerLanded', (e) => {
    landings.push({
      fallHeight: e.fallHeight,
      impactSpeed: e.impactSpeed,
      createsCrater: e.createsCrater,
    });
  });

  const camera = new THREE.PerspectiveCamera(55, 16 / 10, 0.1, 900);
  const rig = new PlayerRig({
    controller,
    camera,
    bus,
    root: root ?? null,
    footOffsetM: footOffset,
    probe: createPhysicsCameraProbe(world, { exclude: [controller.body.handle] }),
    cameraYaw: 0,
  });

  return {
    world,
    bus,
    controller,
    rig,
    camera,
    landings,
    step(input: InputState): void {
      rig.update(input, DT);
      world.step(DT, 1);
      rig.postPhysics(input, DT);
    },
    dispose(): void {
      rig.dispose();
      controller.dispose();
      world.dispose();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Input plumbing                                                             */
/* -------------------------------------------------------------------------- */

let manager: IInputManager;
let frameIndex = 0;
let simTime = 0;

function poll(): InputState {
  frameIndex++;
  simTime += DT;
  return manager.poll(frameIndex, simTime);
}

/** Reset the synthetic driver to a clean, released state. */
function clearInput(): void {
  manager.synthetic.clear();
  manager.reset();
  manager.syntheticEnabled = true;
}

/* -------------------------------------------------------------------------- */
/* Scene (for the pose screenshots only)                                      */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const panel = document.getElementById('panel') as HTMLElement;
const caption = document.getElementById('caption') as HTMLElement;
const errors: string[] = [];

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let characterRoot: THREE.Object3D | null = null;
let characterTriangles = 0;
let proceduralCharacter = false;
let footOffset = PLAYER_HEIGHT / 2;

async function status(text: string): Promise<void> {
  panel.innerHTML = `<h1>Player harness</h1><span class="dim">${text}</span>`;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildScene(): void {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1d2a3a);
  scene.fog = new THREE.Fog(0x1d2a3a, 120, 420);

  // Bright enough that the SHAPE of the framing is readable. A dark harness
  // screenshot passes every pixel-statistics check and still tells you nothing
  // about composition, which is the only thing these images are for.
  scene.add(new THREE.HemisphereLight(0xbcd2f0, 0x4a4034, 2.6));
  const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
  sun.position.set(-40, 60, 30);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9ab4d8, 1.1);
  fill.position.set(35, 25, -40);
  scene.add(fill);

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const byColour = new Map<number, Box[]>();
  for (const box of LEVEL) {
    const list = byColour.get(box.colour);
    if (list) list.push(box);
    else byColour.set(box.colour, [box]);
  }
  const matrix = new THREE.Matrix4();
  for (const [colour, boxes] of byColour) {
    const material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.94 });
    const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
    boxes.forEach((box, i) => {
      matrix.compose(
        box.centre,
        new THREE.Quaternion(),
        new THREE.Vector3(box.half.x * 2, box.half.y * 2, box.half.z * 2)
      );
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
  }

  // A grid on the ground plane gives the eye a speed and scale reference,
  // which is most of what makes a traversal screenshot readable at all.
  const grid = new THREE.GridHelper(320, 80, 0x8a9ab5, 0x4c586b);
  grid.position.y = 0.02;
  scene.add(grid);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
}

/**
 * Add the real Saitama mesh if the character generator cooperates, else a
 * clearly-labelled capsule proxy.
 *
 * The framing judgement at the end of this harness is only worth something
 * against a human-shaped, human-scaled silhouette, so it is worth the try —
 * but a camera harness that cannot run because a mesh generator moved would
 * be worth nothing at all.
 */
async function buildCharacterVisual(): Promise<void> {
  try {
    const mesh = await import('@/characters/mesh');
    const build = mesh.buildCharacter('saitama', 0);
    const slots = mesh.usedSlots(build);
    const materials = slots.map(
      (slot) =>
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: slot === 'metal' ? 0.3 : slot === 'skin' ? 0.72 : 0.9,
          metalness: slot === 'metal' ? 0.85 : 0,
        })
    );
    const parts = mesh.createCharacterParts(build, materials);
    characterRoot = parts.root;
    const index = build.geometry.getIndex();
    characterTriangles = index ? index.count / 3 : 0;
    build.geometry.computeBoundingBox();
    const minY = build.geometry.boundingBox?.min.y ?? 0;
    // Capsule centre sits `PLAYER_HEIGHT/2` above the soles; the mesh's own
    // origin may not be at its soles, so read it rather than assume it.
    footOffset = PLAYER_HEIGHT / 2 + minY;
    proceduralCharacter = true;
  } catch (error) {
    errors.push(`character mesh unavailable, using a capsule proxy: ${String(error)}`);
    const geometry = new THREE.CapsuleGeometry(
      PLAYER_RADIUS,
      PLAYER_HEIGHT - PLAYER_RADIUS * 2,
      6,
      12
    );
    geometry.translate(0, PLAYER_HEIGHT / 2, 0);
    const proxy = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xf2d24b, roughness: 0.6 })
    );
    characterRoot = proxy;
    characterTriangles = geometry.getIndex() ? geometry.getIndex()!.count / 3 : 0;
    footOffset = PLAYER_HEIGHT / 2;
  }
  if (characterRoot) scene.add(characterRoot);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function round(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

const poses: Pose[] = [];

function capturePose(sim: Sim, name: string, label: string, detail: string): void {
  if (poses.some((p) => p.name === name)) return;
  const c = sim.camera;
  poses.push({
    name,
    label,
    detail,
    player: [sim.rig.controller.position.x, sim.rig.controller.position.y, sim.rig.controller.position.z],
    playerYaw: sim.rig.controller.yaw,
    camera: [c.position.x, c.position.y, c.position.z],
    quaternion: [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w],
    fov: c.fov,
    armLength: sim.rig.camera.armLength,
  });
}

/* -------------------------------------------------------------------------- */
/* Scenario 1 — mirrored constants                                            */
/* -------------------------------------------------------------------------- */

function checkMirrors(): MirrorCheck[] {
  const L = DEFAULT_PLAYER_TUNING.locomotion;
  const C = DEFAULT_PLAYER_TUNING.camera;
  const pairs: [string, number, number][] = [
    ['runSpeed', L.runSpeed, RUN_SPEED],
    ['dashSpeed', L.dashSpeed, DASH_SPEED],
    ['jumpSpeed', L.jumpSpeed, JUMP_SPEED],
    ['coyoteSeconds', L.coyoteSeconds, COYOTE_TIME],
    ['hardLandFallHeightM', L.hardLandFallHeightM, GROUND_SLAM_FALL_HEIGHT],
    ['lookFullRateDegPerSec', C.lookFullRateDegPerSec, DEFAULT_INPUT_TUNING.lookFullRateDegPerSec],
    ['chargeStartSeconds', C.chargeStartSeconds, DEFAULT_INPUT_TUNING.chargeStartSec],
  ];
  return pairs.map(([name, player, source]) => ({
    name,
    player: round(player, 6),
    source: round(source, 6),
    match: Math.abs(player - source) < 1e-9,
  }));
}

/* -------------------------------------------------------------------------- */
/* Scenario 2 — run and dash                                                  */
/* -------------------------------------------------------------------------- */

function measureSpeed(dash: boolean): SpeedResult {
  const sim = makeSim(new THREE.Vector3(LANE_X, 1.5, LANE_START_Z));
  clearInput();
  manager.synthetic.setMove(0, 1);
  if (dash) manager.synthetic.press('sprint');

  const target = dash ? DASH_SPEED : RUN_SPEED;
  const start = sim.rig.controller.position.clone();
  let topSpeed = 0;
  let to90 = -1;
  let toMax = -1;

  const frames = 240;
  for (let i = 0; i < frames; i++) {
    sim.step(poll());
    const speed = sim.rig.controller.speed;
    topSpeed = Math.max(topSpeed, speed);
    if (to90 < 0 && speed >= target * 0.9) to90 = i + 1;
    if (toMax < 0 && speed >= target * 0.995) toMax = i + 1;
    if (!dash && i === 100) {
      capturePose(
        sim,
        'run',
        'Run — 9 m/s',
        'Resting 4.5 m arm, FOV widened with speed, look-at leading the run.'
      );
    }
  }

  const distance = sim.rig.controller.position.distanceTo(start);
  sim.dispose();
  return {
    target,
    topSpeed: round(topSpeed, 3),
    timeTo90PctSec: to90 < 0 ? -1 : round(to90 * DT, 4),
    timeToMaxSec: toMax < 0 ? -1 : round(toMax * DT, 4),
    distanceM: round(distance, 3),
  };
}

/* -------------------------------------------------------------------------- */
/* Scenario 3/4 — jump and landing                                            */
/* -------------------------------------------------------------------------- */

interface JumpRun {
  apex: number;
  crater: boolean;
  airborne: number;
  fallHeight: number;
  impactSpeed: number;
  fromBus: boolean;
  recovery: number;
  hardFrames: number;
  slamAffected: number;
  landedEvents: number;
  speedBefore: number;
  speedAfter: number;
  armAtApex: number;
  heightAtArmSample: number;
}

function measureJump(hold: boolean, moving: boolean): JumpRun {
  const sim = makeSim(new THREE.Vector3(LANE_X, 1.5, LANE_START_Z), null, { debris: true });
  clearInput();
  if (moving) {
    manager.synthetic.setMove(0, 1);
    manager.synthetic.press('sprint');
    for (let i = 0; i < 180; i++) sim.step(poll());
  }

  manager.synthetic.press('jump');
  let apex = 0;
  let armAtApex = 0;
  let heightAtArmSample = 0;
  let airborneFrames = 0;
  let hardFrames = 0;
  let speedBefore = sim.rig.controller.speed;
  let landedAt = -1;
  let craterLanding: ReturnType<() => typeof sim.rig.controller.landing> | undefined;
  let speedAtCrater = 0;
  let speedAfterCrater = 0;

  for (let i = 0; i < 420; i++) {
    if (!hold && i === 1) manager.synthetic.release('jump');
    if (hold && i === 40) manager.synthetic.release('jump');
    sim.step(poll());

    const player = sim.rig.controller;
    if (!player.isGrounded) {
      airborneFrames++;
      if (player.heightAboveGround > apex) {
        apex = player.heightAboveGround;
        armAtApex = sim.rig.camera.armLength;
        heightAtArmSample = player.heightAboveGround;
        if (hold && moving && apex > 20) {
          capturePose(
            sim,
            'apex',
            `Apex — ${apex.toFixed(1)} m up`,
            'Arm extended toward 14 m, pitch biased down: the district is the shot.'
          );
        }
      }
      speedBefore = player.speed;
    }
    if (player.state === 'hardLand') {
      if (hardFrames === 0) {
        // The FIRST crater is the one this scenario is about. Reading
        // `player.landing` at the end instead would report whatever the
        // character last touched down from while running out the clock.
        craterLanding = player.landing;
        speedAtCrater = speedBefore;
        speedAfterCrater = player.speed;
      }
      hardFrames++;
      if (hardFrames === 3) {
        capturePose(
          sim,
          'hardland',
          'Hard landing — crater',
          'Recovery beat: control is throttled and the arm is snapping back to 4.5 m.'
        );
      }
    }
    if (landedAt < 0 && player.landing !== undefined) landedAt = i;
  }

  const landing = craterLanding ?? sim.rig.controller.landing;
  const result: JumpRun = {
    apex: round(apex, 3),
    crater: landing?.hard ?? false,
    airborne: round(airborneFrames * DT, 4),
    fallHeight: round(landing?.fallHeight ?? 0, 3),
    impactSpeed: round(landing?.impactSpeed ?? 0, 3),
    fromBus: landing?.fromBus ?? false,
    recovery: round(landing?.recoverySeconds ?? 0, 4),
    hardFrames,
    slamAffected: sim.controller.lastGroundSlamAffected,
    landedEvents: sim.landings.length,
    speedBefore: round(craterLanding ? speedAtCrater : speedBefore, 3),
    speedAfter: round(craterLanding ? speedAfterCrater : sim.rig.controller.speed, 3),
    armAtApex: round(armAtApex, 3),
    heightAtArmSample: round(heightAtArmSample, 3),
  };
  sim.dispose();
  return result;
}

/* -------------------------------------------------------------------------- */
/* Scenario 5 — coyote time                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Walk off the ledge, wait `delayFrames`, tap jump, and report whether the
 * character left the ground again.
 *
 * The delay is counted from the first frame the controller OBSERVES the loss
 * of ground contact, which is what the coyote window is measured against.
 */
function coyoteAttempt(delayFrames: number): boolean {
  const sim = makeSim(new THREE.Vector3(-32, LEDGE_TOP_Y + 1.2, 30));
  clearInput();
  // Run east, off the ledge edge at x = -14.
  manager.synthetic.setMove(1, 0);
  let left = false;
  for (let i = 0; i < 400 && !left; i++) {
    sim.step(poll());
    if (!sim.rig.controller.isGrounded) left = true;
  }
  if (!left) {
    sim.dispose();
    return false;
  }

  for (let i = 0; i < delayFrames; i++) sim.step(poll());

  const yBefore = sim.rig.controller.position.y;
  const vyBefore = sim.rig.controller.verticalSpeed;
  let launched = false;
  sim.rig.controller.stateMachine.onEnter('jumpLaunch', () => {
    launched = true;
  });
  manager.synthetic.tap('jump');
  for (let i = 0; i < 4; i++) sim.step(poll());
  const rose = sim.rig.controller.verticalSpeed > vyBefore + 5;
  void yBefore;
  sim.dispose();
  return launched && rose;
}

/* -------------------------------------------------------------------------- */
/* Scenario 6 — jump buffering                                                */
/* -------------------------------------------------------------------------- */

interface BufferAttempt {
  accepted: boolean;
  latencyFrames: number;
}

/**
 * Hop, tap jump `beforeFrames` before the touchdown found by a dry run, and
 * report how many frames after touchdown the new jump actually fired.
 */
function bufferAttempt(beforeFrames: number, landFrame: number): BufferAttempt {
  const sim = makeSim(new THREE.Vector3(LANE_X, 1.5, LANE_START_Z));
  clearInput();
  manager.synthetic.press('jump');
  sim.step(poll());
  manager.synthetic.release('jump');

  const pressAt = landFrame - beforeFrames;
  let relaunchFrame = -1;
  sim.rig.controller.stateMachine.onEnter('jumpLaunch', () => {
    if (relaunchFrame < 0) relaunchFrame = current;
  });

  let current = 1;
  for (; current < landFrame + 30; current++) {
    if (current === pressAt) manager.synthetic.tap('jump');
    sim.step(poll());
  }
  sim.dispose();
  return {
    accepted: relaunchFrame >= 0,
    latencyFrames: relaunchFrame < 0 ? -1 : relaunchFrame - landFrame,
  };
}

/** Frame index at which a tapped hop touches down again. */
function findHopLandingFrame(): number {
  const sim = makeSim(new THREE.Vector3(LANE_X, 1.5, LANE_START_Z));
  clearInput();
  manager.synthetic.press('jump');
  sim.step(poll());
  manager.synthetic.release('jump');
  let landFrame = -1;
  for (let i = 1; i < 400; i++) {
    sim.step(poll());
    if (landFrame < 0 && i > 6 && sim.rig.controller.isGrounded) landFrame = i;
  }
  sim.dispose();
  return landFrame;
}

/* -------------------------------------------------------------------------- */
/* Scenario 7 — camera behaviour                                              */
/* -------------------------------------------------------------------------- */

function measureCamera(): HarnessReport['camera'] {
  const C = DEFAULT_PLAYER_TUNING.camera;
  const sim = makeSim(new THREE.Vector3(LANE_X, 1.5, LANE_START_Z));
  clearInput();

  // Resting.
  for (let i = 0; i < 120; i++) sim.step(poll());
  const restingArm = sim.rig.camera.armLength;
  const fovAtRest = sim.camera.fov;

  // Orbit: one second at full look deflection, summed along the shortest arc.
  let previous = sim.rig.camera.yaw;
  let swept = 0;
  manager.synthetic.setLook(1, 0);
  for (let i = 0; i < 60; i++) {
    sim.step(poll());
    let delta = sim.rig.camera.yaw - previous;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    swept += Math.abs(delta);
    previous = sim.rig.camera.yaw;
  }
  manager.synthetic.setLook(0, 0);

  // Charging a serious punch.
  manager.synthetic.press('punch');
  for (let i = 0; i < 200; i++) sim.step(poll());
  const chargingArm = sim.rig.camera.armLength;
  capturePose(
    sim,
    'charge',
    'Charging a serious punch',
    'Arm at 9 m: the wind-up is framed wide so the release has somewhere to go.'
  );

  // Release: `heavyPunch` fires on release with the charge ratio, which is the
  // trigger for the three-frame positional lag.
  manager.synthetic.release('punch');
  manager.synthetic.tap('heavyPunch', 1);
  manager.synthetic.setMove(0, 1);
  manager.synthetic.press('sprint');
  let lagPeak = 0;
  let lagFrames = 0;
  for (let i = 0; i < 60; i++) {
    sim.step(poll());
    const diagnostics = sim.rig.camera.diagnostics();
    if (diagnostics.impactLag > 0) lagFrames++;
    // The lag is how far the OUTPUT position trails the position the rig would
    // otherwise have used — not how far the camera moved this frame.
    lagPeak = Math.max(lagPeak, diagnostics.impactLagOffsetM);
  }

  // Dash FOV.
  for (let i = 0; i < 240; i++) sim.step(poll());
  const fovAtDash = sim.camera.fov;

  // Cooperation: stand in for the impact freeze — snapshot, punch in, restore.
  const snapshot = sim.camera.fov;
  sim.camera.fov = snapshot - 8;
  let suspended = 0;
  for (let i = 0; i < 20; i++) {
    sim.step(poll());
    if (sim.rig.camera.diagnostics().fovSuspended) suspended++;
  }
  const fovDuringOverride = sim.camera.fov;
  sim.camera.fov = snapshot;
  sim.step(poll());
  const fovAfter = sim.camera.fov;

  sim.dispose();
  return {
    restingArmM: round(restingArm, 3),
    chargingArmM: round(chargingArm, 3),
    apexArmM: C.armLengthApexM,
    armAtJumpApexM: 0,
    apexHeightAtSampleM: 0,
    fovAtRestDeg: round(fovAtRest, 3),
    fovAtDashDeg: round(fovAtDash, 3),
    orbitDegPerSec: round((swept * 180) / Math.PI, 2),
    orbitTargetDegPerSec: C.lookFullRateDegPerSec,
    impactLagPeakM: round(lagPeak, 4),
    impactLagFrames: lagFrames,
    fovSuspendedFrames: suspended,
    fovAfterExternalOverride: round(fovDuringOverride - (snapshot - 8), 6) === 0
      ? round(fovAfter, 3)
      : Number.NaN,
  };
}

/* -------------------------------------------------------------------------- */
/* Scenario 8 — camera clearance through a tight alley                        */
/* -------------------------------------------------------------------------- */

const CLEARANCE_DIRS: readonly THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

const tmpDir = new THREE.Vector3();

/**
 * Dash the length of the alley with the camera orbiting continuously, and
 * measure the camera against geometry EVERY frame, two ways:
 *
 *   PENETRATION  a ray from the pivot to the camera. Any hit shorter than the
 *                arm means something is between them, i.e. the camera is on
 *                the far side of a wall. This must never happen.
 *   CLEARANCE    six axis rays from the camera position. The shortest hit is
 *                how close the camera got to any surface at all.
 *
 * The second number is the honest one: "never penetrated" is easy, "never got
 * closer than N centimetres" is what tells you whether the near plane is safe.
 */
function measureClearance(): HarnessReport['clearance'] {
  const sim = makeSim(new THREE.Vector3(ALLEY_START_X - 4, 1.5, ALLEY_CENTRE_Z));
  clearInput();
  // Aim the camera east and let the character follow: the movement stick is
  // camera-relative, so pointing the camera IS pointing the run.
  sim.rig.camera.yaw = -Math.PI / 2;
  manager.synthetic.setMove(0, 1);
  manager.synthetic.press('sprint');

  let frames = 0;
  let minClearance = Number.POSITIVE_INFINITY;
  let minArm = Number.POSITIVE_INFINITY;
  let minPivotClearance = Number.POSITIVE_INFINITY;
  let penetrationFrames = 0;
  let maxPenetration = 0;
  let occludedFrames = 0;
  const exclude = [sim.controller.body.handle];

  // Phase 1 runs the corridor; phase 2 parks in the middle of it and orbits,
  // so the arm spends real time pointing straight into a wall rather than
  // glancing off one on the way past.
  const ENTER = 120;
  const ORBIT = 480;
  for (let i = 0; i < ENTER + ORBIT; i++) {
    if (i === ENTER) {
      manager.synthetic.setMove(0, 0);
      manager.synthetic.release('sprint');
    }
    if (i >= ENTER) {
      // Yaw sweeps continuously; pitch sweeps through the whole tuned band, so
      // the arm is driven into the ground and into the sky as well as the walls.
      manager.synthetic.setLook(0.62, 0.6 * Math.sin((i - ENTER) / 22));
    }
    sim.step(poll());
    frames++;

    const pivot = sim.rig.camera.pivotPosition;
    const cameraPos = sim.camera.position;
    const arm = cameraPos.distanceTo(pivot);
    minArm = Math.min(minArm, arm);
    if (sim.rig.camera.isOccluded) occludedFrames++;

    // Penetration: is anything between the pivot and the camera?
    if (arm > 1e-4) {
      tmpDir.copy(cameraPos).sub(pivot).multiplyScalar(1 / arm);
      const hit = sim.world.raycast({
        origin: pivot,
        direction: tmpDir,
        maxDistance: arm,
        layers: ['world'],
        exclude,
      });
      if (hit !== undefined && hit.distance < arm - 1e-3) {
        penetrationFrames++;
        maxPenetration = Math.max(maxPenetration, arm - hit.distance);
      }
    }

    // Clearance: how close is the camera to any surface?
    for (const dir of CLEARANCE_DIRS) {
      const hit = sim.world.raycast({
        origin: cameraPos,
        direction: dir,
        maxDistance: 2.5,
        layers: ['world'],
        exclude,
      });
      if (hit !== undefined) minClearance = Math.min(minClearance, hit.distance);
    }

    // And how close is the PIVOT to a wall? A pivot inside geometry is the one
    // failure the arm sweep cannot dig itself out of.
    for (const dir of CLEARANCE_DIRS) {
      const hit = sim.world.raycast({
        origin: pivot,
        direction: dir,
        maxDistance: 2.5,
        layers: ['world'],
        exclude,
      });
      if (hit !== undefined) minPivotClearance = Math.min(minPivotClearance, hit.distance);
    }

    // Capture the alley pose only when the pitch sweep is near neutral and the
    // arm is genuinely pinned by a wall: a shot taken at the top of the pitch
    // sweep is a top-down view that says nothing about the clearance rule.
    if (
      i > ENTER + 60 &&
      sim.rig.camera.isOccluded &&
      Math.abs(sim.rig.camera.diagnostics().pitchDeg - 12) < 4
    ) {
      capturePose(
        sim,
        'alley',
        'Alley — 2.4 m of clearance',
        'Arm collapsed against the wall, camera held out of the geometry.'
      );
    }
  }

  const result: HarnessReport['clearance'] = {
    frames,
    minClearanceM: round(minClearance, 4),
    minArmM: round(minArm, 4),
    penetrationFrames,
    maxPenetrationM: round(maxPenetration, 4),
    occludedFrames,
    alleyWidthM: ALLEY_WIDTH,
    minPivotClearanceM: round(minPivotClearance, 4),
  };
  sim.dispose();
  return result;
}

/* -------------------------------------------------------------------------- */
/* Scenario 9 — determinism                                                   */
/* -------------------------------------------------------------------------- */

const SCRIPT: readonly { frames: number; apply: () => void }[] = [
  { frames: 45, apply: () => manager.synthetic.setMove(0, 1) },
  { frames: 35, apply: () => manager.synthetic.press('sprint') },
  { frames: 1, apply: () => manager.synthetic.press('jump') },
  { frames: 25, apply: () => manager.synthetic.setLook(0.6, 0.2) },
  { frames: 1, apply: () => manager.synthetic.release('jump') },
  { frames: 55, apply: () => manager.synthetic.setMove(0.8, 0.6) },
  { frames: 40, apply: () => manager.synthetic.setLook(-0.4, 0) },
  { frames: 60, apply: () => manager.synthetic.release('sprint') },
  { frames: 70, apply: () => manager.synthetic.setMove(-1, 0.2) },
  { frames: 60, apply: () => manager.synthetic.setMove(0, 0) },
];

function runScript(variant: number): number[] {
  const sim = makeSim(new THREE.Vector3(LANE_X, 1.5, LANE_START_Z));
  clearInput();
  manager.synthetic.setLook(0, 0);
  for (const step of SCRIPT) {
    step.apply();
    // The variant perturbs ONE step, to prove the comparison can fail.
    const frames = variant === 1 && step.frames === 55 ? 56 : step.frames;
    for (let i = 0; i < frames; i++) sim.step(poll());
  }
  const player = sim.rig.controller;
  const out = [
    player.position.x,
    player.position.y,
    player.position.z,
    player.velocity.x,
    player.velocity.z,
    player.yaw,
    sim.camera.position.x,
    sim.camera.position.y,
    sim.camera.position.z,
    sim.rig.camera.armLength,
    sim.camera.fov,
  ];
  sim.dispose();
  return out;
}

/* -------------------------------------------------------------------------- */
/* Scenario 10 — CPU cost                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Batched timings.
 *
 * `performance.now()` is clamped to ~100 µs in a non-cross-origin-isolated
 * page, which is two orders of magnitude coarser than a single controller
 * update. So nothing here times one call: each phase is measured as one block
 * of `N` iterations and divided. That is a real measurement of a real cost; a
 * per-call `now()` here would be a measurement of the clock.
 */
function measureTimings(): HarnessReport['timings'] {
  const sim = makeSim(new THREE.Vector3(LANE_X, 1.5, LANE_START_Z));
  clearInput();
  manager.synthetic.setMove(0, 1);
  manager.synthetic.press('sprint');
  manager.synthetic.setLook(0.4, 0);
  for (let i = 0; i < 60; i++) sim.step(poll());

  const N = 900;
  const inputs: InputState[] = [];
  for (let i = 0; i < N; i++) inputs.push(poll());

  // Whole frame: rig update + solver step + post-step + camera.
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const input = inputs[i]!;
    sim.rig.update(input, DT);
    sim.world.step(DT, 1);
    sim.rig.postPhysics(input, DT);
  }
  const wholeMs = (performance.now() - t0) / N;

  // Camera alone, against the same geometry (five arm rays plus the pivot ray).
  const t1 = performance.now();
  for (let i = 0; i < N; i++) sim.rig.camera.update(inputs[i]!, DT);
  const cameraMs = (performance.now() - t1) / N;

  // Solver alone, with the character standing still.
  const t2 = performance.now();
  for (let i = 0; i < N; i++) sim.world.step(DT, 1);
  const physicsMs = (performance.now() - t2) / N;

  sim.dispose();
  return {
    frames: N,
    wholeFrameMs: round(wholeMs, 4),
    cameraOnlyMs: round(cameraMs, 4),
    physicsStepMs: round(physicsMs, 4),
    controllerAndSolverMs: round(wholeMs - cameraMs, 4),
    method: `mean of ${N} iterations per block; performance.now() is clamped to ~100 µs so single calls are not timed`,
  };
}

/* -------------------------------------------------------------------------- */
/* Pose replay                                                                */
/* -------------------------------------------------------------------------- */

function installShotApi(): void {
  const camera = new THREE.PerspectiveCamera(55, 16 / 10, 0.1, 900);
  window.__PLAYER_SHOT__ = (name: string): boolean => {
    const pose = poses.find((p) => p.name === name);
    if (pose === undefined) return false;
    if (characterRoot !== null) {
      characterRoot.position.set(pose.player[0], pose.player[1] - footOffset, pose.player[2]);
      characterRoot.rotation.set(0, pose.playerYaw, 0);
      characterRoot.updateMatrixWorld(true);
    }
    camera.position.set(pose.camera[0], pose.camera[1], pose.camera[2]);
    camera.quaternion.set(
      pose.quaternion[0],
      pose.quaternion[1],
      pose.quaternion[2],
      pose.quaternion[3]
    );
    camera.fov = pose.fov;
    camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.render(scene, camera);

    caption.style.display = 'block';
    caption.innerHTML =
      `<b>${pose.label}</b>${pose.detail} ` +
      `<span class="dim">· arm ${pose.armLength.toFixed(2)} m · fov ${pose.fov.toFixed(1)}°</span>`;
    return true;
  };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  await status('initialising physics…');
  await initPhysics();

  buildScene();
  await status('building the character…');
  await buildCharacterVisual();

  manager = createInputManager({
    mount: document.body,
    touch: false,
    keyboard: false,
    gamepad: false,
    headless: false,
  });
  manager.syntheticEnabled = true;

  await status('scenario 1/9 — mirrored constants');
  const mirrors = checkMirrors();

  await status('scenario 2/9 — run');
  const run = measureSpeed(false);
  await status('scenario 2/9 — dash');
  const dash = measureSpeed(true);

  await status('scenario 3/9 — tap jump');
  const tap = measureJump(false, false);
  await status('scenario 3/9 — held leap');
  const held = measureJump(true, true);

  await status('scenario 4/9 — coyote time');
  let lastAccepted = -1;
  let firstRejected = -1;
  for (let delay = 0; delay <= 14; delay++) {
    const accepted = coyoteAttempt(delay);
    if (accepted) lastAccepted = delay;
    else if (firstRejected < 0) firstRejected = delay;
  }

  await status('scenario 5/9 — jump buffering');
  const hopLandFrame = findHopLandingFrame();
  let earliestAccepted = -1;
  let tooEarly = -1;
  let latency = -1;
  for (let before = 1; before <= 24; before++) {
    const attempt = bufferAttempt(before, hopLandFrame);
    if (attempt.accepted) {
      earliestAccepted = before;
      if (latency < 0 || attempt.latencyFrames > latency) latency = attempt.latencyFrames;
    } else if (tooEarly < 0) tooEarly = before;
  }

  await status('scenario 6/9 — camera');
  const camera = measureCamera();
  camera.armAtJumpApexM = held.armAtApex;
  camera.apexHeightAtSampleM = held.heightAtArmSample;

  await status('scenario 7/9 — camera clearance through the alley');
  const clearance = measureClearance();

  await status('scenario 8/9 — determinism');
  const a = runScript(0);
  const b = runScript(0);
  const c = runScript(1);
  let maxDelta = 0;
  for (let i = 0; i < a.length; i++) maxDelta = Math.max(maxDelta, Math.abs(a[i]! - b[i]!));
  let variantDelta = 0;
  for (let i = 0; i < a.length; i++) variantDelta = Math.max(variantDelta, Math.abs(a[i]! - c[i]!));

  await status('scenario 9/9 — CPU cost');
  const timings = measureTimings();

  installShotApi();
  window.__PLAYER_SHOT__?.('run');

  const report: HarnessReport = {
    seed: SEED,
    mirrors,
    run,
    dash,
    jump: {
      tapApexM: tap.apex,
      heldApexM: held.apex,
      predictedHeldApexM: round(heldJumpApex(DEFAULT_PLAYER_TUNING.locomotion), 3),
      physicsSingleShotApexM: round(apexHeightForSpeed(JUMP_SPEED), 3),
      tapCreatesCrater: tap.crater,
      heldCreatesCrater: held.crater,
      airborneSecondsHeld: held.airborne,
    },
    landing: {
      fallHeightM: held.fallHeight,
      impactSpeedMps: held.impactSpeed,
      createsCrater: held.crater,
      fromBus: held.fromBus,
      recoverySeconds: held.recovery,
      measuredHardLandSeconds: round(held.hardFrames * DT, 4),
      playerLandedEvents: held.landedEvents,
      groundSlamAffected: held.slamAffected,
      speedRetention: held.speedBefore > 0.01 ? round(held.speedAfter / held.speedBefore, 4) : -1,
    },
    coyote: {
      tunedWindowSec: DEFAULT_PLAYER_TUNING.locomotion.coyoteSeconds,
      physicsWindowSec: COYOTE_TIME,
      lastAcceptedFrames: lastAccepted,
      lastAcceptedMs: round(lastAccepted * DT * 1000, 2),
      firstRejectedFrames: firstRejected,
      firstRejectedMs: round(firstRejected * DT * 1000, 2),
      // The sweep counts frames AFTER the exit was observed, and one frame of
      // airborne time is already on the clock by then.
      effectiveWindowMs: round((lastAccepted + 1) * DT * 1000, 2),
    },
    buffer: {
      tunedWindowSec: DEFAULT_PLAYER_TUNING.locomotion.jumpBufferSeconds,
      earliestAcceptedFrames: earliestAccepted,
      earliestAcceptedMs: round(earliestAccepted * DT * 1000, 2),
      tooEarlyFrames: tooEarly,
      latencyFrames: latency,
    },
    camera,
    clearance,
    determinism: {
      values: a.length,
      maxDelta,
      identical: maxDelta === 0,
      differentScriptDelta: round(variantDelta, 6),
    },
    timings,
    render: {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      width: renderer.domElement.width,
      height: renderer.domElement.height,
      characterTriangles: Math.round(characterTriangles),
      proceduralCharacter,
    },
    poses,
    errors,
  };

  window.__PLAYER_HARNESS__ = report;
  const bad = (v: boolean): string => (v ? 'ok' : 'bad');
  panel.innerHTML =
    `<h1>Player harness</h1>` +
    `<span class="dim">run</span> ${run.topSpeed} m/s (t90 ${run.timeTo90PctSec}s)\n` +
    `<span class="dim">dash</span> ${dash.topSpeed} m/s\n` +
    `<span class="dim">apex</span> tap ${tap.apex} m · held ${held.apex} m\n` +
    `<span class="dim">coyote</span> ${report.coyote.lastAcceptedMs} ms accepted\n` +
    `<span class="dim">buffer</span> ${report.buffer.earliestAcceptedMs} ms early\n` +
    `<span class="${bad(clearance.penetrationFrames === 0)}">camera penetrations ` +
    `${clearance.penetrationFrames}</span> · min clearance ${clearance.minClearanceM} m\n` +
    `<span class="${bad(report.determinism.identical)}">determinism ` +
    `${report.determinism.identical ? 'exact' : `delta ${maxDelta}`}</span>`;
  window.__PLAYER_READY__ = true;
}

main().catch((error: unknown) => {
  errors.push(`harness crashed: ${String(error)}`);
  window.__PLAYER_HARNESS__ = { errors } as unknown as HarnessReport;
  window.__PLAYER_READY__ = true;
  panel.innerHTML = `<h1>Player harness</h1><span class="bad">${String(error)}</span>`;
  console.error(error);
});

