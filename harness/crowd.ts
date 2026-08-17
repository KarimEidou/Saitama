/**
 * CROWD HARNESS — the browser half
 *
 * Builds a real street in City Z, drops a monster at the end of it, and runs
 * `CrowdSystem` through a scripted panic while measuring everything the claim
 * rests on:
 *
 *   DRAW CALLS   250 VAT civilians rendered in a scene containing nothing but
 *                the crowd, so `renderer.info.render.calls` is the crowd's
 *                number and not the street's.
 *   CPU TIME     `performance.now()` around the simulation update, reported as
 *                a mean and a 95th percentile. NEVER frames per second: CI
 *                renders through SwiftShader on the CPU, so a frame time there
 *                is a measurement of a software rasteriser.
 *   PANIC RATE   the alarm front's radius sampled every tenth of a second and
 *                differentiated, in metres per second.
 *   SEPARATION   the smallest centre-to-centre distance between any two agents
 *                on any frame of the whole run.
 *   CONTAINMENT  agents found standing inside a building, sampled across the
 *                run. Must be zero.
 *   CONVERGENCE  every walkable cell's trajectory through the flow field.
 *   ACCOUNTING   `CivilianSaved` / `CivilianLost` captured off the bus, with
 *                the ledger's line-of-sight flags alongside.
 *   DETERMINISM  a second, identically-configured system driven through the
 *                same script; the two state hashes must match.
 */

import * as THREE from 'three';
import { EventBus, clamp01, createRng } from '@/util';
import { layoutChunk } from '@/world/streaming/chunk-layout';
import { STREET_WIDTH } from '@/world/streaming/constants';
import { buildCharacter, buildHumanoid, showcaseBodies } from '@/characters/mesh';
import { createCharacterParts } from '@/characters/mesh';
import { ProceduralAnimator } from '@/characters/anim';
import {
  CrowdSystem,
  FIELD_DIM,
  MOOD_NAMES,
  NEAR_RADIUS,
  cellCentreX,
  cellCentreZ,
  type HeroNpcId,
  type IObstacleRect,
} from '@/entities/npc';

declare global {
  interface Window {
    __HARNESS_READY__?: boolean;
    __HARNESS_ERROR__?: string;
    __HARNESS_STATS__?: unknown;
    __CROWD_HARNESS__?: { mode: string };
  }
}

type Mode = 'panic' | 'fields' | 'calm';

const params = new URLSearchParams(window.location.search);
const MODE = (params.get('mode') ?? 'panic') as Mode;
const SEED = Number(params.get('seed') ?? 20250817);

/** Street the whole scene is staged on: `x = 0` is a road centre-line. */
const STREET_X = 0;
/** Where the player (and the camera's subject) stands. */
const PLAYER_Z = 20;
/** Where the monster lands. */
const MONSTER_Z = -42;

/**
 * Radius of the plaza cleared out of the middle of the generated city.
 *
 * City Z's layout generator produces 16 m street canyons between 30 m blocks,
 * and a camera standing in one of those sees about six people — the other 244
 * are behind a wall. That is a true picture of a street and a useless picture
 * of a crowd. So the harness clears a plaza, which every real city has, and
 * stages the rout in it. The obstacle field is built from the SAME rectangles
 * that are drawn, so nothing about the navigation is being faked: the
 * civilians are routing around exactly the buildings you can see.
 */
const PLAZA_RADIUS = 62;

/** Fixed simulation step. Nothing here is driven by wall-clock time. */
const DT = 1 / 60;
/** Frames of calm before the monster arrives. */
const CALM_FRAMES = 240;
/** Frames of panic after it does. */
const PANIC_FRAMES = 660;
/**
 * Frame of the panic phase the picture is taken on.
 *
 * Three and a half seconds in, which is when a rout LOOKS like a rout: the
 * front has just swept the plaza, the crowd is mid-flight and still dense, and
 * the people who have NOT moved are standing out against everybody sprinting
 * past them. Eleven seconds in, everyone who was going to run has run and the
 * frame is an empty square with some bodies in it — which is a truthful
 * picture of the aftermath and a useless one of the panic.
 */
const PICTURE_FRAME = 210;
/**
 * Frames after the player kills it.
 *
 * The picture is taken at the END of the panic phase, before this runs — a
 * screenshot of a street that has already calmed down proves nothing. The
 * recovery phase exists so the SAVE path is exercised: nobody is ever credited
 * with a rescue while the monster is still standing there.
 */
const RECOVERY_FRAMES = 900;

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

const view = document.getElementById('view') as HTMLCanvasElement;
const map = document.getElementById('map') as HTMLCanvasElement;

const renderer = new THREE.WebGLRenderer({
  canvas: view,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x0a0e16, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e16);
// Heavy fog. Two jobs: it hides the edge of the simulated band so the crowd
// does not visibly stop existing at 150 m, and it separates the running
// foreground from the buildings, which is most of what makes a dense street
// legible at all.
scene.fog = new THREE.Fog(0x0f1626, 45, 210);

const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 600);

function addLights(target: THREE.Scene): void {
  const sun = new THREE.DirectionalLight(0xffe9c8, 3.1);
  sun.position.set(-40, 70, 30);
  target.add(sun);
  // Low warm bounce from the road and a cold sky term: a flat ambient makes
  // 250 identical-material bodies read as cardboard.
  target.add(new THREE.HemisphereLight(0x8fb6ff, 0x2a2015, 0.6));
  const rim = new THREE.DirectionalLight(0xff9a5a, 1.1);
  rim.position.set(30, 12, -60);
  target.add(rim);
}
addLights(scene);

/* -------------------------------------------------------------------------- */
/* City                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Buildings from the streaming workstream's real layout generator.
 *
 * Not a hand-drawn test grid: the crowd has to cope with 4 m alleys, blocks
 * that do not line up and buildings that touch at a corner, and a tidy grid of
 * squares hides exactly those cases.
 */
function cityRects(): IObstacleRect[] {
  const rects: IObstacleRect[] = [];
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      for (const b of layoutChunk(SEED, cx, cz).buildings) {
        const cxm = (b.minX + b.maxX) * 0.5;
        const czm = (b.minZ + b.maxZ) * 0.5;
        // Clear the plaza. See `PLAZA_RADIUS`.
        if (cxm * cxm + czm * czm < PLAZA_RADIUS * PLAZA_RADIUS) continue;
        rects.push({ minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ, height: b.height });
      }
    }
  }
  return rects;
}

/**
 * Spawn points for the crowd, published the way the streaming system would.
 *
 * `CrowdSystem` implements `ICrowdSink`, so this is the real integration path
 * rather than a harness back door — and feeding it plaza-only slots is how the
 * whole population ends up somewhere a camera can see it. Without this the 250
 * civilians distribute themselves across four square blocks of street and the
 * picture contains a dozen of them.
 */
function publishCrowdSlots(target: CrowdSystem): void {
  const slots: { x: number; y: number; z: number; rotationY: number }[] = [];
  const rng = createRng(SEED).derive('plaza-slots');
  for (let i = 0; i < 900; i++) {
    const angle = rng.range(0, Math.PI * 2);
    // sqrt keeps the distribution uniform by area rather than clustering at
    // the centre, which would make the plaza look like a drain.
    const radius = Math.sqrt(rng.next()) * (PLAZA_RADIUS - 6);
    slots.push({
      x: Math.cos(angle) * radius,
      y: 0,
      z: Math.sin(angle) * radius,
      rotationY: rng.range(-Math.PI, Math.PI),
    });
  }
  target.setChunkCrowd(0, 'skinned', slots);
}

const rects = cityRects();

/** One `InstancedMesh` of boxes for every building in range. */
function buildCity(target: THREE.Scene): { group: THREE.Group; count: number } {
  const group = new THREE.Group();
  group.name = 'city';

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600),
    new THREE.MeshStandardMaterial({ color: 0x242a36, roughness: 0.97, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // Road stripe down the street the action happens on, so the frame has a
  // ground plane with structure in it rather than a grey void.
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(STREET_WIDTH, 800),
    new THREE.MeshStandardMaterial({ color: 0x24272e, roughness: 0.92 })
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(STREET_X, 0.01, 0);
  group.add(road);

  const visible = rects.filter(
    (r) => Math.abs((r.minX + r.maxX) * 0.5) < 280 && Math.abs((r.minZ + r.maxZ) * 0.5) < 280
  );
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0.02 });
  const mesh = new THREE.InstancedMesh(geometry, material, visible.length);
  mesh.name = 'buildings';
  const matrix = new THREE.Matrix4();
  const colour = new THREE.Color();
  const rng = createRng(SEED).derive('facade');
  visible.forEach((r, i) => {
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    matrix.compose(
      new THREE.Vector3((r.minX + r.maxX) * 0.5, r.height * 0.5, (r.minZ + r.maxZ) * 0.5),
      new THREE.Quaternion(),
      new THREE.Vector3(w, r.height, d)
    );
    mesh.setMatrixAt(i, matrix);
    const shade = 0.16 + rng.next() * 0.12;
    mesh.setColorAt(i, colour.setRGB(shade * 0.95, shade, shade * 1.1));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  target.add(group);
  return { group, count: visible.length };
}

const city = buildCity(scene);

/* -------------------------------------------------------------------------- */
/* Crowd                                                                      */
/* -------------------------------------------------------------------------- */

const bus = new EventBus();
const savedEvents: { id: string; byPlayer: boolean; delta: number }[] = [];
const lostEvents: { id: string; byPlayer: boolean; delta: number }[] = [];
const allyDowned: string[] = [];
bus.on('CivilianSaved', (e) =>
  savedEvents.push({ id: e.entityId, byPlayer: e.byPlayer, delta: e.reputationDelta })
);
bus.on('CivilianLost', (e) =>
  lostEvents.push({ id: e.entityId, byPlayer: e.causedByPlayer, delta: e.reputationDelta })
);
bus.on('AllyDowned', (e) => allyDowned.push(e.displayName));

function makeSystem(targetScene: THREE.Scene | undefined, targetBus: EventBus): CrowdSystem {
  const built = new CrowdSystem({
    scene: targetScene,
    bus: targetBus,
    seed: SEED,
    playerId: 'player',
  });
  built.setObstacles(rects);
  built.setPlayer(STREET_X, PLAYER_Z);
  // The allies are part of the simulation, not decoration: they occupy space
  // civilians steer around and their attacks seed the alarm field. The twin
  // system used for the determinism check therefore gets the same three, just
  // without bodies.
  publishCrowdSlots(built);
  built.addHero('genos', STREET_X - 7.5, -18);
  built.addHero('mumenRider', STREET_X + 4.5, -8);
  built.addHero('tatsumaki', STREET_X + 11, -30);
  return built;
}

const system = makeSystem(scene, bus);

/* -------------------------------------------------------------------------- */
/* Actors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The thing everyone is running from.
 *
 * Built from the mesh generator's showcase monster body, NOT from the monster
 * workstream — the crowd system must never import that, and for the purposes
 * of this harness a threat is a position, an intensity and a silhouette.
 */
function buildMonster(): THREE.Object3D {
  const recipe = showcaseBodies().find((b) => b.profile.archetype === 'monsterHumanoid');
  const group = new THREE.Group();
  if (recipe === undefined) return group;
  const build = buildHumanoid(recipe.profile, { ...recipe.options, lod: 1 });
  const parts = createCharacterParts(
    build,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.05 })
  );
  const animator = new ProceduralAnimator(parts, parts.root, { seed: 9, initial: 'idle' });
  animator.play('taunt', { fade: 0 });
  // Scaled up hard: at 2.45 m the showcase monster is a large man, and the
  // thing that empties a district is not a large man.
  parts.root.scale.setScalar(4.4);
  parts.root.position.set(STREET_X, 0, MONSTER_Z);
  parts.root.rotation.y = Math.PI;
  group.add(parts.root);
  monsterAnimator = animator;
  return group;
}

let monsterAnimator: ProceduralAnimator | undefined;
const monsterGroup = buildMonster();
// Hidden in the control: a monster standing in the square that nobody reacts
// to would make the calm frame ambiguous rather than a control.
monsterGroup.visible = MODE !== 'calm';
scene.add(monsterGroup);
const monsterPosition = new THREE.Vector3(STREET_X, 0, MONSTER_Z);

/**
 * Give the already-registered allies visible bodies.
 *
 * Built AFTER `makeSystem` rather than passed into it, so the determinism twin
 * can run the same three ally brains without paying for three skinned meshes.
 * A body changes nothing about what an ally decides.
 */
function dressAllies(): void {
  const characters: Record<HeroNpcId, 'genos' | 'mumenRider' | 'tatsumaki'> = {
    genos: 'genos',
    mumenRider: 'mumenRider',
    tatsumaki: 'tatsumaki',
  };
  for (const ally of system.allies) {
    const characterId = characters[ally.heroId];
    const build = buildCharacter(characterId, 1);
    const parts = createCharacterParts(
      build,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.08 })
    );
    const animator = new ProceduralAnimator(parts, parts.root, {
      seed: characterId.length * 17,
      variants: { idle: 'combat' },
    });
    parts.root.position.copy(ally.transform.position);
    parts.root.rotation.y = Math.PI;
    scene.add(parts.root);
    allyBodies.push({ ally, root: parts.root, animator });
  }
}

const allyBodies: {
  ally: (typeof system.allies)[number];
  root: THREE.Object3D;
  animator: ProceduralAnimator;
}[] = [];
dressAllies();

/* -------------------------------------------------------------------------- */
/* Measurement                                                                */
/* -------------------------------------------------------------------------- */

interface FrontSample {
  readonly t: number;
  readonly radius: number;
}

const simSamples: number[] = [];
const frontSamples: FrontSample[] = [];
let minSeparation = Infinity;
let buildingPenetrations = 0;
let penetrationChecks = 0;
let peakFlee = 0;
let peakGawk = 0;
let peakCower = 0;

function sampleFrame(elapsed: number, panicking: boolean): void {
  simSamples.push(system.lastStats.simMs);
  const separation = system.steering.lastReport.minSeparation;
  if (separation < minSeparation) minSeparation = separation;

  const moods = system.lastStats.moods;
  if (moods.flee > peakFlee) peakFlee = moods.flee;
  if (moods.gawk > peakGawk) peakGawk = moods.gawk;
  if (moods.cower > peakCower) peakCower = moods.cower;

  // Containment: sampled rather than every frame, because the check is O(n)
  // against the rect buckets and the harness is measuring the simulation, not
  // itself.
  if (simSamples.length % 5 === 0) {
    for (let i = 0; i < system.agents.extent; i++) {
      if (system.agents.active[i] === 0) continue;
      penetrationChecks++;
      if (!system.obstacles.isWalkable(system.agents.posX[i]!, system.agents.posZ[i]!)) {
        buildingPenetrations++;
      }
    }
  }

  if (panicking && simSamples.length % 6 === 0) {
    frontSamples.push({
      t: elapsed,
      radius: system.alarm.frontRadius(monsterPosition.x, monsterPosition.z, 0.15),
    });
  }
}

/** Least-squares slope of the front radius against time, m/s. */
function frontSpeed(samples: readonly FrontSample[]): number {
  if (samples.length < 3) return 0;
  // Only the expanding part: once the front saturates against the transfer
  // range it stops moving, and averaging that in would report half the speed.
  const peak = samples[samples.length - 1]!.radius;
  const rising = samples.filter((s) => s.radius < peak * 0.97 && s.radius > 12);
  if (rising.length < 3) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const s of rising) {
    sx += s.t;
    sy += s.radius;
    sxx += s.t * s.t;
    sxy += s.t * s.radius;
  }
  const n = rising.length;
  const denominator = n * sxx - sx * sx;
  return denominator === 0 ? 0 : (n * sxy - sx * sy) / denominator;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

/* -------------------------------------------------------------------------- */
/* The script                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run the same sequence of inputs against a system.
 *
 * Extracted so the determinism check can drive a second, identically
 * configured system through it and compare state hashes.
 */
function runScript(
  target: CrowdSystem,
  sampling: boolean,
  targetBus: EventBus,
  onPeak?: () => void
): void {
  let elapsed = 0;
  for (let f = 0; f < CALM_FRAMES; f++) {
    target.update(DT);
    elapsed += DT;
    if (sampling) sampleFrame(elapsed, false);
  }

  if (MODE !== 'calm') {
    target.setThreats([
      { id: 'monster', position: monsterPosition, intensity: 1, tier: 'dragon' },
    ]);
    targetBus.emit('EncounterStarted', {
      encounterId: 'harness',
      threatTier: 'dragon',
      position: monsterPosition,
      radius: 40,
      participantIds: ['monster'],
      isBoss: true,
    });
  }

  for (let f = 0; f < PANIC_FRAMES; f++) {
    // THE PICTURE IS TAKEN HERE, mid-rout, before the square empties.
    if (f === PICTURE_FRAME) onPeak?.();
    // Halfway through, the monster swings and takes a building with it. Two
    // events, both of which the crowd system only learns about from the bus.
    if (MODE !== 'calm' && f === SHOCKWAVE_FRAME) {
      targetBus.emit('ShockwaveFired', {
        origin: { x: STREET_X, y: 2, z: MONSTER_Z + 10 },
        direction: { x: 0, y: 0, z: 1 },
        power: 120000,
        range: 70,
        angle: 0.75,
        intent: 'serious',
        punchKind: 'heavy',
        sourceId: 'monster',
      });
      for (let piece = 0; piece < 6; piece++) {
        targetBus.emit('ChunkDetached', {
          structureId: 'harness-block',
          chunkIndex: piece,
          position: { x: STREET_X - 9 + piece * 3, y: 12, z: MONSTER_Z + 26 },
          mass: 5200,
          impulse: { x: 0, y: -400, z: 900 },
          material: 'concrete',
          collateralCost: 900,
        });
      }
    }
    target.update(DT);
    elapsed += DT;
    if (sampling) sampleFrame(elapsed, MODE !== 'calm');
  }

  // The player arrives and ends it. Everyone still frightened nearby is about
  // to be credited as a rescue — which is the only way a save ever fires.
  if (MODE !== 'calm') {
    targetBus.emit('EntityKilled', {
      entityId: 'monster',
      entityType: 'monster',
      faction: 'monster',
      position: monsterPosition,
      killerId: 'player',
      threatTier: 'dragon',
      intent: 'serious',
      rewardPoints: 400,
    });
    target.setThreats([]);
  }
  for (let f = 0; f < RECOVERY_FRAMES; f++) {
    target.update(DT);
    elapsed += DT;
    if (sampling) sampleFrame(elapsed, false);
  }
}

/** Frame of the panic phase on which the monster takes a building with it. */
const SHOCKWAVE_FRAME = 240;

/* -------------------------------------------------------------------------- */
/* Draw calls                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Count the crowd's draw calls, and nothing else's.
 *
 * The instanced crowd is temporarily re-parented into an otherwise empty
 * scene. Measuring the whole street instead would fold in the ground, the road,
 * the building instance mesh and three skinned allies, and the number would be
 * true but would not be the number the claim is about.
 */
function measureCrowdDrawCalls(): {
  crowd: number;
  full: number;
  triangles: number;
  packed: number;
} {
  const crowdRenderer = system.renderer;
  const crowdGroup = crowdRenderer?.group;
  const isolated = new THREE.Scene();
  addLights(isolated);
  const parent = crowdGroup?.parent ?? null;
  if (crowdGroup !== undefined) isolated.add(crowdGroup);

  // Pack EVERY civilian into the instance buffers, including the sixteen the
  // near tier has taken over with real skeletons. The claim being measured is
  // "250 VAT civilians in six draw calls", so the measurement has to actually
  // contain 250 of them rather than the 236 that happen to be instanced at
  // this instant.
  crowdRenderer?.update(system.agents, 0, EMPTY_SKIP);
  const packed = crowdRenderer?.lastStats.instances ?? 0;

  const probe = camera.clone();
  probe.position.set(STREET_X + 4, 44, PLAYER_Z + 40);
  probe.lookAt(STREET_X, 1, -20);
  probe.updateMatrixWorld(true);

  renderer.info.reset();
  renderer.render(isolated, probe);
  const crowd = renderer.info.render.calls;
  const triangles = renderer.info.render.triangles;

  if (crowdGroup !== undefined && parent !== null) parent.add(crowdGroup);

  // Repack with the real skip set before the picture: leaving the near tier
  // instanced as well would draw a VAT ghost standing inside every skinned
  // civilian.
  const skip = new Set<number>();
  for (let i = 0; i < system.agents.extent; i++) {
    if (system.agents.active[i] === 1 && system.agents.tier[i] === 1) skip.add(i);
  }
  crowdRenderer?.update(system.agents, 0, skip);

  renderer.info.reset();
  renderer.render(scene, camera);
  const full = renderer.info.render.calls;
  return { crowd, full, triangles, packed };
}

const EMPTY_SKIP: ReadonlySet<number> = new Set<number>();

/* -------------------------------------------------------------------------- */
/* Camera                                                                     */
/* -------------------------------------------------------------------------- */

function frameCamera(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  // Low and off to one side of the road, looking back up it past the running
  // crowd towards the monster. Eye height, because a crowd photographed from
  // above reads as a diagram and a crowd photographed from head height reads
  // as being in it.
  camera.position.set(STREET_X + 10, 5.2, PLAYER_Z + 21);
  camera.lookAt(STREET_X - 3, 2.6, MONSTER_Z + 16);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/* -------------------------------------------------------------------------- */
/* Field diagram                                                              */
/* -------------------------------------------------------------------------- */

const MOOD_COLOURS = ['#5aa9ff', '#ffd230', '#ff6b6b', '#b07cff', '#6f7d95'];

/**
 * Top-down 2D diagram of everything that is otherwise invisible.
 *
 * The alarm field as a heat map, the flee flow as arrows, buildings as blocks,
 * and every agent as a dot in its mood colour. This is the view that makes
 * "panic propagates outward" something you can see rather than something you
 * read in a log.
 */
function drawFields(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  map.width = width;
  map.height = height;
  const context = map.getContext('2d');
  if (context === null) return;

  const span = 340;
  const scale = Math.min(width, height) / span;
  const originX = width * 0.5 - STREET_X * scale;
  const originZ = height * 0.5;
  const toX = (x: number): number => originX + x * scale;
  const toZ = (z: number): number => originZ + z * scale;

  context.fillStyle = '#05070c';
  context.fillRect(0, 0, width, height);

  // Alarm heat map, one quad per field cell in view.
  for (let gz = 0; gz < FIELD_DIM; gz++) {
    const wz = cellCentreZ(gz);
    if (Math.abs(wz) > span) continue;
    for (let gx = 0; gx < FIELD_DIM; gx++) {
      const wx = cellCentreX(gx);
      if (Math.abs(wx - STREET_X) > span) continue;
      const alarm = system.alarm.value[gz * FIELD_DIM + gx]!;
      if (alarm < 0.01) continue;
      const a = clamp01(alarm);
      context.fillStyle = `rgba(${Math.round(120 + a * 135)}, ${Math.round(60 - a * 40)}, ${Math.round(40 + (1 - a) * 60)}, ${0.14 + a * 0.5})`;
      const px = toX(wx - 6);
      const pz = toZ(wz - 6);
      context.fillRect(px, pz, 12 * scale + 1, 12 * scale + 1);
    }
  }

  // Buildings.
  context.fillStyle = 'rgba(46, 60, 92, 0.55)';
  context.strokeStyle = 'rgba(90, 120, 180, 0.45)';
  context.lineWidth = 1;
  for (const r of rects) {
    const x = toX(r.minX);
    const z = toZ(r.minZ);
    const w = (r.maxX - r.minX) * scale;
    const d = (r.maxZ - r.minZ) * scale;
    if (x + w < 0 || z + d < 0 || x > width || z > height) continue;
    context.fillRect(x, z, w, d);
    context.strokeRect(x, z, w, d);
  }

  // Flee flow arrows, every fourth cell so the field is legible.
  context.strokeStyle = 'rgba(120, 230, 255, 0.55)';
  context.lineWidth = 1.2;
  const dir: [number, number] = [0, 0];
  for (let gz = 0; gz < FIELD_DIM; gz += 3) {
    const wz = cellCentreZ(gz);
    if (Math.abs(wz) > span * 0.5) continue;
    for (let gx = 0; gx < FIELD_DIM; gx += 3) {
      const wx = cellCentreX(gx);
      if (Math.abs(wx - STREET_X) > span * 0.5) continue;
      if (system.alarm.value[gz * FIELD_DIM + gx]! < 0.05) continue;
      system.flow.sampleDirection(system.flow.flee, wx, wz, dir);
      if (dir[0] === 0 && dir[1] === 0) continue;
      const x = toX(wx);
      const z = toZ(wz);
      const len = 7;
      context.beginPath();
      context.moveTo(x - dir[0] * len * 0.5, z - dir[1] * len * 0.5);
      context.lineTo(x + dir[0] * len * 0.5, z + dir[1] * len * 0.5);
      context.stroke();
      context.beginPath();
      context.arc(x + dir[0] * len * 0.5, z + dir[1] * len * 0.5, 1.6, 0, Math.PI * 2);
      context.fill();
    }
  }

  // Agents.
  for (let i = 0; i < system.agents.extent; i++) {
    if (system.agents.active[i] === 0) continue;
    const x = toX(system.agents.posX[i]!);
    const z = toZ(system.agents.posZ[i]!);
    context.fillStyle = MOOD_COLOURS[system.agents.mood[i]!] ?? '#ffffff';
    context.beginPath();
    context.arc(x, z, 2.4, 0, Math.PI * 2);
    context.fill();
    // A short tick showing which way they are facing, so a wall of gawkers
    // all turned towards the monster is visible as such.
    const yaw = system.agents.yaw[i]!;
    context.strokeStyle = context.fillStyle;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, z);
    context.lineTo(x + Math.sin(yaw) * 6, z - Math.cos(yaw) * 6);
    context.stroke();
  }

  // The monster and the player.
  context.fillStyle = '#ff3b3b';
  context.beginPath();
  context.arc(toX(monsterPosition.x), toZ(monsterPosition.z), 9, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#ffd230';
  context.beginPath();
  context.arc(toX(STREET_X), toZ(PLAYER_Z), 5, 0, Math.PI * 2);
  context.fill();

  // Simulated band.
  context.strokeStyle = 'rgba(255, 210, 48, 0.35)';
  context.setLineDash([6, 6]);
  context.lineWidth = 1.5;
  for (const radius of [NEAR_RADIUS, 150]) {
    context.beginPath();
    context.arc(toX(STREET_X), toZ(PLAYER_Z), radius * scale, 0, Math.PI * 2);
    context.stroke();
  }
  context.setLineDash([]);
}

/* -------------------------------------------------------------------------- */
/* Overlay                                                                    */
/* -------------------------------------------------------------------------- */

function text(id: string, html: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.innerHTML = html;
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Place the ally bodies and settle their animators for the frame.
 *
 * The allies' brains run inside `CrowdSystem`; their meshes are the harness's
 * business. Settling only at the moment of the picture rather than every frame
 * keeps three procedural animators out of a nine-hundred-frame loop that is
 * measuring something else.
 */
function presentAllies(): void {
  for (const body of allyBodies) {
    body.root.position.copy(body.ally.transform.position);
    body.root.rotation.y = body.ally.transform.yaw;
    const status = body.ally.status();
    if (status.isDead) body.animator.play('death', { fade: 0, loop: 'once', clampWhenFinished: true });
    else if (status.state === 'knocked-down') body.animator.play('stagger', { fade: 0 });
    else body.animator.play('attack', { fade: 0 });
    for (let i = 0; i < 24; i++) body.animator.update(DT);
  }
}

interface PeakSnapshot {
  fleeConvergence: ReturnType<CrowdSystem['flow']['checkConvergence']>;
  commuteConvergence: ReturnType<CrowdSystem['flow']['checkConvergence']>;
  directionsIntoWalls: number;
  moods: Record<string, number>;
  total: number;
  near: number;
  far: number;
  gawkFraction: number;
  panicFraction: number;
  draws: { crowd: number; full: number; triangles: number; packed: number };
  render: NonNullable<typeof system.renderer>['lastStats'] | undefined;
}

function main(): void {
  frameCamera();
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  if (monsterAnimator !== undefined) {
    // Settle the monster's pose so it is mid-roar rather than in a bind pose.
    for (let i = 0; i < 90; i++) monsterAnimator.update(DT);
  }

  let peak: PeakSnapshot | undefined;

  runScript(system, true, bus, () => {
    presentAllies();
    const draws = measureCrowdDrawCalls();
    if (MODE === 'fields') {
      view.classList.add('hidden');
      map.classList.remove('hidden');
      drawFields();
    }
    const stats = system.lastStats;
    peak = {
      // Convergence is captured HERE and not at the end of the run: after the
      // player kills the monster the flee field has no sources, so a
      // convergence report taken then walks zero cells and proves nothing.
      fleeConvergence: system.flow.checkConvergence(system.flow.flee, system.obstacles, true),
      commuteConvergence: system.flow.checkConvergence(
        system.flow.commuteA,
        system.obstacles,
        false
      ),
      directionsIntoWalls:
        system.flow.countDirectionsIntoWalls(system.flow.flee, system.obstacles) +
        system.flow.countDirectionsIntoWalls(system.flow.commuteA, system.obstacles),
      moods: { ...stats.moods },
      total: stats.total,
      near: stats.near,
      far: stats.far,
      gawkFraction: system.gawkFraction,
      panicFraction: system.panicFraction,
      draws,
      render: system.renderer?.lastStats,
    };
  });

  const snapshot = peak ?? {
    fleeConvergence: { tested: 0, converged: 0, cycles: 0, stalled: 0, longestWalk: 0 },
    commuteConvergence: { tested: 0, converged: 0, cycles: 0, stalled: 0, longestWalk: 0 },
    directionsIntoWalls: 0,
    moods: { commute: 0, gawk: 0, flee: 0, cower: 0, down: 0 },
    total: 0,
    near: 0,
    far: 0,
    gawkFraction: 0,
    panicFraction: 0,
    draws: { crowd: 0, full: 0, triangles: 0, packed: 0 },
    render: undefined,
  };
  const stats = system.lastStats;

  // Determinism: a second system, configured identically and fed an identical
  // event stream on its own bus, driven through the identical script. Same
  // seed must mean the same city full of the same people making the same
  // decisions.
  const referenceHash = system.hash();
  const twinBus = new EventBus();
  const twin = makeSystem(undefined, twinBus);
  runScript(twin, false, twinBus);
  const twinHash = twin.hash();
  twin.dispose();

  const speed = frontSpeed(frontSamples);

  const moodLine = MOOD_NAMES.map(
    (name) => `<span class="${name}">${name} ${snapshot.moods[name]}</span>`
  ).join('  ');

  text(
    'headline',
    MODE === 'calm'
      ? `<b>CONTROL — no threat</b>\n<span class="dim">the same street, the same ${snapshot.total} people, nothing wrong</span>\n${moodLine}`
      : MODE === 'fields'
        ? `<b>ALARM AND FLOW</b>\n<span class="dim">heat map is the alarm field · arrows are the flee flow · ticks are facing</span>\n${moodLine}`
        : `<b>DRAGON-LEVEL, CITY Z</b>\n<span class="dim">${snapshot.total} civilians simulated · ${snapshot.near} skinned · ${snapshot.far} estimated beyond the band</span>\n${moodLine}`
  );

  text(
    'legend',
    `<span class="dim">MOODS</span>\n` +
      `<span class="sw" style="background:#5aa9ff"></span>commute\n` +
      `<span class="sw" style="background:#ffd230"></span>gawk <span class="dim">(filming you)</span>\n` +
      `<span class="sw" style="background:#ff6b6b"></span>flee\n` +
      `<span class="sw" style="background:#b07cff"></span>cower\n` +
      `<span class="sw" style="background:#6f7d95"></span>down`
  );

  text(
    'numbers',
    `<span class="ok">${snapshot.draws.crowd} draw calls</span> <span class="dim">for ${snapshot.draws.packed} VAT civilians</span>\n` +
      `<span class="dim">${(snapshot.draws.triangles / 1000).toFixed(0)}k tris · palettes ${(((snapshot.render?.paletteBytes ?? 0) / 1024) | 0)} KB · ${snapshot.render?.distinctOffsets ?? 0} distinct gait phases</span>\n` +
      `<span class="dim">sim ${mean(simSamples).toFixed(3)} ms/frame mean · ${percentile(simSamples, 0.95).toFixed(3)} ms p95</span>\n` +
      `<span class="dim">panic front ${speed.toFixed(1)} m/s · min separation ${minSeparation === Infinity ? 'n/a' : `${minSeparation.toFixed(3)} m`}</span>\n` +
      `<span class="${buildingPenetrations === 0 ? 'ok' : 'warn'}">${buildingPenetrations} agents inside buildings</span> <span class="dim">over ${penetrationChecks} checks</span>\n` +
      `<span class="dim">saved ${stats.saved} (${stats.witnessedSaves} witnessed) · lost ${stats.lost}</span>`
  );

  const allies = system.allyStatus();
  window.__HARNESS_STATS__ = {
    mode: MODE,
    seed: SEED,
    buildings: city.count,
    agents: snapshot.total,
    near: snapshot.near,
    mid: snapshot.total - snapshot.near,
    farEstimate: snapshot.far,
    moods: snapshot.moods,
    gawkFraction: snapshot.gawkFraction,
    panicFraction: snapshot.panicFraction,
    peakFlee,
    peakGawk,
    peakCower,
    crowdDrawCalls: snapshot.draws.crowd,
    sceneDrawCalls: snapshot.draws.full,
    crowdTriangles: snapshot.draws.triangles,
    instances: snapshot.draws.packed,
    archetypeMeshes: snapshot.render?.activeMeshes ?? 0,
    distinctOffsets: snapshot.render?.distinctOffsets ?? 0,
    paletteBytes: snapshot.render?.paletteBytes ?? 0,
    simMsMean: mean(simSamples),
    simMsP95: percentile(simSamples, 0.95),
    simMsMax: simSamples.length === 0 ? 0 : Math.max(...simSamples),
    alarmMs: stats.alarmMs,
    flowMs: stats.flowMs,
    frames: simSamples.length,
    frontSamples: frontSamples.slice(0, 400),
    frontSpeed: speed,
    frontFinal: frontSamples.length === 0 ? 0 : frontSamples[frontSamples.length - 1]!.radius,
    minSeparation: minSeparation === Infinity ? -1 : minSeparation,
    buildingPenetrations,
    penetrationChecks,
    fleeConvergence: snapshot.fleeConvergence,
    commuteConvergence: snapshot.commuteConvergence,
    directionsIntoWalls: snapshot.directionsIntoWalls,
    saved: stats.saved,
    lost: stats.lost,
    witnessedSaves: stats.witnessedSaves,
    savedEvents: savedEvents.length,
    lostEvents: lostEvents.length,
    lostByPlayer: lostEvents.filter((e) => e.byPlayer).length,
    savedByPlayer: savedEvents.filter((e) => e.byPlayer).length,
    outcomesWithLineOfSight: system.outcomes.filter((o) => o.witnessedByPlayer).length,
    outcomesWithBystanders: system.outcomes.filter((o) => o.bystanders > 0).length,
    allies: allies.map((a) => ({
      name: a.displayName,
      health: a.health,
      maxHealth: a.maxHealth,
      reEngagements: a.reEngagements,
      dead: a.isDead,
    })),
    allyDowned,
    mumenReEngagements: mumenKnockdownTest(),
    determinismHash: referenceHash,
    determinismTwinHash: twinHash,
    deterministic: referenceHash === twinHash,
  };
  window.__CROWD_HARNESS__ = { mode: MODE };
  window.__HARNESS_READY__ = true;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/**
 * Knock Mumen Rider down six times and count how often he gets up.
 *
 * Run at the very end so it cannot perturb the measured simulation. The answer
 * has to be six. It is the game's thesis stated as an integer.
 */
function mumenKnockdownTest(): number {
  const mumen = system.allies.find((a) => a.heroId === 'mumenRider');
  if (mumen === undefined) return -1;
  const before = mumen.reEngagements;
  for (let round = 0; round < 6; round++) {
    mumen.knockdown();
    for (let f = 0; f < 130; f++) mumen.update(DT);
  }
  return mumen.reEngagements - before;
}

try {
  main();
} catch (error) {
  window.__HARNESS_ERROR__ = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  window.__HARNESS_READY__ = true;
}
