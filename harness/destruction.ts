/**
 * DESTRUCTION HARNESS
 *
 * A scripted full-charge serious punch through a City Z block, with every
 * collaborator being the real one:
 *
 *   city        `CityGenerator` -> pre-fractured block meshes, the real
 *               `aDestroyed` attribute and the real `installDestructionHook`
 *               vertex shader patch.
 *   physics     real Rapier world, real `DebrisPool` (300 hard cap, LRU, 12 s
 *               fade, ballistic gravel), real `RagdollManager` (8 active).
 *   streaming   real `ChunkDamageState`, the 8 KB persistent bitmask.
 *   destruction `DestructionSystem`, which imports NONE of the above. Each one
 *               is assigned into a structural port with no cast — the
 *               assignments below are themselves the proof that the ports
 *               match reality.
 *
 * ── WHAT THE HARNESS IS FOR ────────────────────────────────────────────────
 * One question a unit test cannot answer: does a collapse READ as a building
 * coming down, or as geometry being switched off? That is answered by looking
 * at `docs/screenshots/destruction-mid-collapse.png`.
 *
 * Everything else here is a check a picture cannot make — the normalised-Uint8
 * trap tested against a real GPU pipeline, the two budget ceilings under a
 * punch that far exceeds them, a stream-out/stream-in round trip, and
 * determinism.
 *
 * NO FRAME TIMES. SwiftShader is a CPU rasteriser.
 *
 * Playwright control surface: `window.__DESTRUCTION_HARNESS__`.
 */

import * as THREE from 'three';
import rawPlan from '../assets/district/cityz.plan.json';
import {
  CityGenerator,
  buildBlockMesh,
  buildGroundMesh,
  collapsingFloors,
  installDestructionHook,
  mergeChunkGrounds,
  type ICityChunkBuild,
  type ICityPlan,
} from '@/world/city';
import {
  DebrisPool,
  PhysicsWorld,
  RagdollManager,
  createReferenceRig,
  initPhysics,
  type IReferenceRig,
} from '@/physics';
import { ChunkDamageState, chunkIndexForPosition } from '@/world/streaming';
import {
  DestructionSystem,
  type IDestructionStats,
  type IStructureLayout,
} from '@/gameplay/destruction';
import { EventBus, createRng } from '@/util';
import type { EntityId, GameEventOf, Vec3 } from '@/types';
import { FallbackMaterialLibrary, buildProceduralSky } from './city.materials';

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('view') as HTMLCanvasElement;
const statsEl = document.getElementById('stats')!;
const overlayEl = document.getElementById('overlay')!;
const noteEl = document.getElementById('note')!;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  // The shader-truth check reads the framebuffer back after rendering, and a
  // discarded drawing buffer would make `readPixels` return whatever the
  // compositor left behind.
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.45;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const materials = new FallbackMaterialLibrary(4, installDestructionHook);
const sky = buildProceduralSky(renderer);
const plan = rawPlan as unknown as ICityPlan;
const generator = new CityGenerator(plan, { defaultDetail: 'full', includeProps: false });

const SEED_DEFAULT = 'city-z';
const FIXED_STEP = 1 / 60;

/**
 * The block the punch goes through.
 *
 * Chunk (1, -4) is the mid-rise commercial strip the city harness already
 * frames for its fracture view: buildings tall enough to have a collapse worth
 * watching, close enough together that one cone reaches several of them, and
 * on a straight street so the cone has somewhere to go.
 */
const FOCUS_CHUNK: readonly [number, number] = [1, -4];
const CHUNK_SIZE = 96;
const FOCUS_CENTRE = new THREE.Vector3(
  (FOCUS_CHUNK[0] + 0.5) * CHUNK_SIZE,
  0,
  (FOCUS_CHUNK[1] + 0.5) * CHUNK_SIZE
);

/** Where Saitama stands, and where he is looking. Street level, on the axis. */
const PUNCH_ORIGIN = new THREE.Vector3(FOCUS_CENTRE.x - 96, 1.7, FOCUS_CENTRE.z + 42);
const PUNCH_DIRECTION = new THREE.Vector3(1, 0.02, -0.16).normalize();
/** Serious punch at full charge: 22 degree half-angle, 180 m, 2.5e6 power. */
const PUNCH_RANGE = 180;
const PUNCH_HALF_ANGLE = 22 * (Math.PI / 180);
const PUNCH_POWER = 2.5e6;

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

interface IRegisteredBuilding {
  readonly id: string;
  readonly layout: IStructureLayout;
  readonly chunkIndex: number | undefined;
  readonly buildingIndex: number | undefined;
  readonly blockIndex: number;
}

interface IScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly chunks: readonly ICityChunkBuild[];
  readonly blockMeshes: ReturnType<typeof buildBlockMesh>[];
  readonly buildings: IRegisteredBuilding[];
  readonly debrisGroup: THREE.Group;
  readonly ragdollGroup: THREE.Group;
  /** Buildings the 16-slot-per-chunk bitmask could not address. */
  readonly unaddressableBuildings: number;
  readonly generationMs: number;
}

function makeScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = sky.texture;
  scene.environment = sky.environment;
  scene.environmentIntensity = 1.1;
  scene.fog = new THREE.Fog(0xb9c6d4, 260, 1300);

  const sun = new THREE.DirectionalLight(0xfff2dd, 3.2);
  sun.position.set(FOCUS_CENTRE.x - 150, 200, FOCUS_CENTRE.z - 120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 800;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  sun.target.position.copy(FOCUS_CENTRE);
  const cam = sun.shadow.camera;
  cam.left = -160;
  cam.right = 160;
  cam.top = 160;
  cam.bottom = -160;
  cam.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  scene.add(new THREE.HemisphereLight(0xa9c6e8, 0x6b6355, 0.9));
  return scene;
}

/**
 * Average vertex colour of the block geometry, used to tint the debris.
 *
 * The pooled debris meshes carry no vertex colours (they are boxes rewritten
 * in place, which is what makes a detach allocation-free), so without this
 * every falling piece is the pool's default grey and a collapse reads as a
 * building shedding gravel rather than shedding ITSELF.
 */
function averageFacadeColour(blocks: readonly ReturnType<typeof buildBlockMesh>[]): THREE.Color {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const block of blocks) {
    const colour = block.mesh.geometry.getAttribute('color');
    if (colour === undefined) continue;
    const array = colour.array as Float32Array;
    // Every 64th vertex is plenty for an average and keeps the boot cheap.
    for (let i = 0; i < array.length; i += 3 * 64) {
      r += array[i] ?? 0;
      g += array[i + 1] ?? 0;
      b += array[i + 2] ?? 0;
      n++;
    }
  }
  if (n === 0) return new THREE.Color(0x8a8580);
  return new THREE.Color(r / n, g / n, b / n);
}

function buildScene(): IScene {
  const scene = makeScene();
  const t0 = performance.now();

  const chunks: ICityChunkBuild[] = [];
  for (let cz = FOCUS_CHUNK[1] - 2; cz <= FOCUS_CHUNK[1] + 2; cz++) {
    for (let cx = FOCUS_CHUNK[0] - 2; cx <= FOCUS_CHUNK[0] + 2; cx++) {
      if (cx < -8 || cx > 7 || cz < -8 || cz > 7) continue;
      const distance = Math.max(Math.abs(cx - FOCUS_CHUNK[0]), Math.abs(cz - FOCUS_CHUNK[1]));
      chunks.push(
        generator.generate(cx, cz, {
          detail: distance <= 1 ? 'full' : distance <= 2 ? 'reduced' : 'box',
          includeProps: false,
        })
      );
    }
  }
  const generationMs = performance.now() - t0;

  const blockMeshes: ReturnType<typeof buildBlockMesh>[] = [];
  const buildings: IRegisteredBuilding[] = [];
  /** Next free damage slot per streaming chunk; the mask holds 16 per chunk. */
  const slotCursor = new Map<number, number>();
  let unaddressable = 0;

  for (const chunk of chunks) {
    for (const block of chunk.blocks) {
      if (block.geometry.buffers.vertexCount === 0) continue;
      const mesh = buildBlockMesh(block, (key) => materials.get(key));
      const blockIndex = blockMeshes.length;
      blockMeshes.push(mesh);
      scene.add(mesh.mesh);

      const summaries = new Map(block.buildings.map((b) => [b.id, b]));
      // Sorted, so a damage slot means the same building on every run.
      for (const id of Object.keys(mesh.fractures).sort()) {
        const layout = mesh.fractures[id]!;
        const summary = summaries.get(id);
        if (summary === undefined) continue;
        const streamingChunk = chunkIndexForPosition(summary.position[0], summary.position[2]);
        const used = slotCursor.get(streamingChunk) ?? 0;
        let chunkIndex: number | undefined;
        let buildingIndex: number | undefined;
        if (used < 16) {
          chunkIndex = streamingChunk;
          buildingIndex = used;
          slotCursor.set(streamingChunk, used + 1);
        } else {
          // The 8 KB budget addresses 16 buildings per 96 m chunk, and City Z
          // packs more than that into a dense block. Surfaced rather than
          // silently aliased onto somebody else's slot.
          unaddressable++;
        }
        buildings.push({ id, layout, chunkIndex, buildingIndex, blockIndex });
      }
    }
  }

  const grounds = chunks.map((c) => c.ground).filter((g): g is NonNullable<typeof g> => !!g);
  for (const merged of mergeChunkGrounds(grounds)) {
    scene.add(buildGroundMesh(merged, (key) => materials.get(key)));
  }

  const debrisGroup = new THREE.Group();
  debrisGroup.name = 'debris';
  scene.add(debrisGroup);

  const ragdollGroup = new THREE.Group();
  ragdollGroup.name = 'ragdolls';
  scene.add(ragdollGroup);

  // Looking down the street the punch travels, from the side and slightly
  // above: high enough to see whole facades come off, low enough that the
  // buildings still tower.
  const camera = new THREE.PerspectiveCamera(50, aspect(), 0.4, 1600);
  camera.position.set(FOCUS_CENTRE.x - 30, 44, FOCUS_CENTRE.z + 168);
  camera.lookAt(FOCUS_CENTRE.x + 46, 16, FOCUS_CENTRE.z - 6);

  return {
    scene,
    camera,
    chunks,
    blockMeshes,
    buildings,
    debrisGroup,
    ragdollGroup,
    unaddressableBuildings: unaddressable,
    generationMs,
  };
}

function aspect(): number {
  return (canvas.clientWidth || 1280) / Math.max(1, canvas.clientHeight || 720);
}

/* -------------------------------------------------------------------------- */
/* The wired-up world                                                         */
/* -------------------------------------------------------------------------- */

/** A visible stand-in for a monster, so a ragdoll launch is something to see. */
interface IVictim {
  readonly entityId: EntityId;
  readonly rig: IReferenceRig;
  readonly position: THREE.Vector3;
  ragdolled: boolean;
}

interface IWorld {
  readonly bus: EventBus;
  readonly physics: PhysicsWorld;
  readonly debris: DebrisPool;
  readonly ragdolls: RagdollManager;
  readonly damage: ChunkDamageState;
  readonly destruction: DestructionSystem;
  readonly scene: IScene;
  readonly victims: IVictim[];
  readonly detachLog: GameEventOf<'ChunkDetached'>[];
  frames: number;
}

let world: IWorld | undefined;
let seed = SEED_DEFAULT;

function makeVictimRig(position: THREE.Vector3, group: THREE.Group): IReferenceRig {
  const rig = createReferenceRig(1.75, position);
  // A box per bone, so the ragdoll manager driving the skeleton is visible.
  const material = new THREE.MeshStandardMaterial({ color: 0x8e3b3b, roughness: 0.7 });
  for (const [, bone] of rig.bones) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), material);
    box.castShadow = true;
    bone.add(box);
  }
  group.add(rig.root);
  return rig;
}

async function buildWorld(currentSeed: string): Promise<IWorld> {
  const bus = new EventBus();
  const scene = buildScene();

  const physics = new PhysicsWorld({ eventBus: bus, contactEvents: false });
  // The street the rubble lands on. One fixed box under the whole region: the
  // city's ground mesh is visual only, and debris falling through the world
  // would answer the "does it read as a collapse" question with "no".
  physics.createBody({
    type: 'fixed',
    shape: {
      kind: 'box',
      halfExtents: new THREE.Vector3(CHUNK_SIZE * 3, 0.5, CHUNK_SIZE * 3),
    },
    position: new THREE.Vector3(FOCUS_CENTRE.x, -0.5, FOCUS_CENTRE.z),
    layer: 'world',
    collidesWith: ['player', 'monster', 'npc', 'debris', 'projectile', 'ragdoll'],
    friction: 0.9,
    restitution: 0.02,
  });

  const debrisMaterial = new THREE.MeshStandardMaterial({
    color: averageFacadeColour(scene.blockMeshes),
    roughness: 0.96,
    metalness: 0,
  });
  const debris = new DebrisPool(physics, {
    container: scene.debrisGroup,
    material: debrisMaterial,
    rng: createRng(`${currentSeed}:debris`),
    groundY: 0,
  });
  const ragdolls = new RagdollManager(physics);
  const damage = new ChunkDamageState();

  const victims: IVictim[] = [];
  const victimRng = createRng(`${currentSeed}:victims`);
  for (let i = 0; i < 24; i++) {
    const position = new THREE.Vector3(
      PUNCH_ORIGIN.x + 24 + i * 5.5,
      0,
      PUNCH_ORIGIN.z - i * 0.9 + victimRng.range(-3, 3)
    );
    victims.push({
      entityId: `monster-${String(i).padStart(2, '0')}` as EntityId,
      rig: makeVictimRig(position, scene.ragdollGroup),
      position,
      ragdolled: false,
    });
  }
  const byId = new Map(victims.map((v) => [v.entityId, v]));

  /**
   * The ragdoll adapter.
   *
   * Destruction decides WHETHER and with WHAT impulse; it has no business
   * knowing what an entity's skeleton looks like, so resolving the rig lives
   * out here where the entities do.
   */
  const ragdollSink = {
    get activeCount(): number {
      return ragdolls.activeCount;
    },
    get maxActive(): number {
      return ragdolls.maxActive;
    },
    launch(entityId: EntityId, position: Vec3, impulse: Vec3): boolean {
      const victim = byId.get(entityId);
      if (victim === undefined || victim.ragdolled) return false;
      victim.ragdolled = true;
      ragdolls.spawn(
        victim.rig,
        { entityId, height: 1.75, mass: 78, driveSkeleton: true },
        new THREE.Vector3(impulse.x, impulse.y, impulse.z),
        new THREE.Vector3(position.x, position.y + 1, position.z)
      );
      return true;
    },
  };

  // ── THE WIRING, WHICH IS ALSO THE PORT PROOF ──────────────────────────────
  // `debris`, `damage` and `collapsingFloors` are the real implementations
  // from three other workstreams, assigned straight into the structural ports
  // with NO CAST. If any of those shapes drifts, this line stops compiling.
  const destruction = new DestructionSystem({
    bus,
    debris,
    damage,
    ragdolls: ragdollSink,
    collapsingFloors,
    seed: currentSeed,
  });

  for (const building of scene.buildings) {
    const blockMesh = scene.blockMeshes[building.blockIndex]!;
    const summary = findSummary(scene, building.id);
    destruction.register({
      id: building.id,
      layout: building.layout,
      // `IBlockMesh` satisfies `IDestructionTarget` as written.
      target: blockMesh,
      position: { x: summary[0], y: summary[1], z: summary[2] },
      chunkIndex: building.chunkIndex,
      buildingIndex: building.buildingIndex,
    });
  }

  const detachLog: GameEventOf<'ChunkDetached'>[] = [];
  bus.on('ChunkDetached', (event) => detachLog.push(event));

  return { bus, physics, debris, ragdolls, damage, destruction, scene, victims, detachLog, frames: 0 };
}

/** World position of a building, from the block summaries. */
function findSummary(scene: IScene, id: string): [number, number, number] {
  for (const chunk of scene.chunks) {
    for (const block of chunk.blocks) {
      for (const summary of block.buildings) {
        if (summary.id === id) {
          return [summary.position[0], summary.position[1], summary.position[2]];
        }
      }
    }
  }
  return [0, 0, 0];
}

/* -------------------------------------------------------------------------- */
/* Simulation                                                                 */
/* -------------------------------------------------------------------------- */

function step(frames: number): void {
  const w = world;
  if (w === undefined) return;
  for (let i = 0; i < frames; i++) {
    w.frames++;
    w.bus.setFrame(w.frames, w.frames * FIXED_STEP);
    w.physics.update(FIXED_STEP);
    w.debris.update(FIXED_STEP);
    w.ragdolls.update(FIXED_STEP);
    w.destruction.update(FIXED_STEP);
  }
}

/** Fire the scripted punch: a real `ShockwaveFired`, plus the deaths it causes. */
function punch(): void {
  const w = world;
  if (w === undefined) return;
  w.bus.emit('ShockwaveFired', {
    origin: PUNCH_ORIGIN,
    direction: PUNCH_DIRECTION,
    power: PUNCH_POWER,
    range: PUNCH_RANGE,
    angle: PUNCH_HALF_ANGLE,
    intent: 'full',
    punchKind: 'serious',
  });
  // Everything in the cone dies on the same frame. Combat would emit these;
  // the harness stands in for it so the ragdoll path is exercised.
  for (const victim of w.victims) {
    w.bus.emit('EntityKilled', {
      entityId: victim.entityId,
      entityType: 'monster',
      faction: 'monster',
      position: { x: victim.position.x, y: victim.position.y + 1, z: victim.position.z },
      intent: 'full',
      threatTier: 'tiger',
      rewardPoints: 40,
    });
  }
}

function render(): void {
  const w = world;
  if (w === undefined) return;
  const width = canvas.clientWidth || 1280;
  const height = canvas.clientHeight || 720;
  renderer.setSize(width, height, false);
  w.scene.camera.aspect = width / height;
  w.scene.camera.updateProjectionMatrix();
  renderer.info.reset();
  renderer.render(w.scene.scene, w.scene.camera);
  paint();
}

/* -------------------------------------------------------------------------- */
/* Readout                                                                    */
/* -------------------------------------------------------------------------- */

interface IHarnessStats {
  readonly frame: number;
  readonly structures: number;
  readonly unaddressableBuildings: number;
  readonly totalChunks: number;
  readonly destruction: IDestructionStats;
  readonly debrisLive: number;
  readonly debrisCapacity: number;
  readonly debrisSimulated: number;
  readonly debrisBallistic: number;
  readonly ragdollsActive: number;
  readonly ragdollsMax: number;
  readonly physicsBodies: number;
  readonly damagedChunks: number;
  readonly destroyedPieces: number;
  readonly damageResidentBytes: number;
  readonly detachEvents: number;
  readonly trianglesDrawn: number;
  readonly drawCalls: number;
  readonly generationMs: number;
}

function stats(): IHarnessStats | undefined {
  const w = world;
  if (w === undefined) return undefined;
  const d = w.destruction.diagnostics;
  const damageStats = w.damage.stats();
  let totalChunks = 0;
  for (const structure of w.destruction.orderedStructures) totalChunks += structure.chunkCount;
  return {
    frame: w.frames,
    structures: d.structures,
    unaddressableBuildings: w.scene.unaddressableBuildings,
    totalChunks,
    destruction: {
      structures: d.structures,
      damagedStructures: d.damagedStructures,
      chunksDestroyed: d.chunksDestroyed,
      chunksDestroyedThisFrame: d.chunksDestroyedThisFrame,
      debrisSpawned: d.debrisSpawned,
      debrisLive: d.debrisLive,
      visualOnlyDetaches: d.visualOnlyDetaches,
      collapsesTriggered: d.collapsesTriggered,
      floorsCollapsed: d.floorsCollapsed,
      pendingCollapseChunks: d.pendingCollapseChunks,
      ragdollsLaunched: d.ragdollsLaunched,
      ragdollsSuppressed: d.ragdollsSuppressed,
      destroyedMassKg: d.destroyedMassKg,
      collateralTotal: d.collateralTotal,
      persistedPieces: d.persistedPieces,
      restoredChunks: d.restoredChunks,
      frame: d.frame,
    },
    debrisLive: w.debris.count,
    debrisCapacity: w.debris.capacity,
    debrisSimulated: w.debris.simulatedCount,
    debrisBallistic: w.debris.ballisticCount,
    ragdollsActive: w.ragdolls.activeCount,
    ragdollsMax: w.ragdolls.maxActive,
    physicsBodies: w.physics.activeBodyCount,
    damagedChunks: damageStats.damagedChunks,
    destroyedPieces: damageStats.destroyedPieces,
    damageResidentBytes: damageStats.residentBytes,
    detachEvents: w.detachLog.length,
    trianglesDrawn: renderer.info.render.triangles,
    drawCalls: renderer.info.render.calls,
    generationMs: w.scene.generationMs,
  };
}

let overlayLabel = '';

function paint(): void {
  const s = stats();
  if (s === undefined) return;
  const d = s.destruction;
  const rows: [string, string][] = [
    ['frame', String(s.frame)],
    ['buildings registered', String(s.structures)],
    ['fracture chunks', s.totalChunks.toLocaleString()],
    ['— this punch —', ''],
    ['chunks destroyed', String(d.chunksDestroyed)],
    ['buildings damaged', String(d.damagedStructures)],
    ['collapses triggered', String(d.collapsesTriggered)],
    ['floors collapsing', String(d.floorsCollapsed)],
    ['queued to fall', String(d.pendingCollapseChunks)],
    ['mass down (t)', (d.destroyedMassKg / 1000).toFixed(0)],
    ['— debris —', ''],
    ['live / cap', `${s.debrisLive} / ${s.debrisCapacity}`],
    ['  simulated', String(s.debrisSimulated)],
    ['  ballistic', String(s.debrisBallistic)],
    ['bodies spawned', String(d.debrisSpawned)],
    ['visual-only detaches', String(d.visualOnlyDetaches)],
    ['— ragdolls —', ''],
    ['active / cap', `${s.ragdollsActive} / ${s.ragdollsMax}`],
    ['launched', String(d.ragdollsLaunched)],
    ['suppressed', String(d.ragdollsSuppressed)],
    ['— persistence —', ''],
    ['damaged chunks', String(s.damagedChunks)],
    ['pieces in bitmask', String(s.destroyedPieces)],
    ['mask bytes resident', String(s.damageResidentBytes)],
    ['restored on reload', String(d.restoredChunks)],
    ['— frame —', ''],
    ['ChunkDetached emitted', String(s.detachEvents)],
    ['triangles', s.trianglesDrawn.toLocaleString()],
    ['draw calls', String(s.drawCalls)],
    ['physics bodies', String(s.physicsBodies)],
  ];
  statsEl.innerHTML =
    '<table>' +
    rows
      .map(([k, v]) =>
        v === ''
          ? `<tr><td class="k" colspan="2" style="color:#7f8ea8">${k}</td></tr>`
          : `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`
      )
      .join('') +
    '</table>';
  noteEl.textContent =
    s.unaddressableBuildings > 0
      ? `${s.unaddressableBuildings} building(s) exceeded the 16-slot-per-chunk ` +
        `persistent bitmask and are damaged in the live geometry only.`
      : 'Every building fits the persistent bitmask.';
  overlayEl.textContent = overlayLabel;
}

/* -------------------------------------------------------------------------- */
/* Checks a picture cannot make                                               */
/* -------------------------------------------------------------------------- */

/** Read the framebuffer back and reduce it to a comparable fingerprint. */
function samplePixels(): { hash: number; nonBackground: number; bytes: Uint8Array } {
  const gl = renderer.getContext();
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  const bytes = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  let hash = 0x811c9dc5;
  let nonBackground = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const r = bytes[i]!;
    const g = bytes[i + 1]!;
    const b = bytes[i + 2]!;
    hash = Math.imul(hash ^ r, 0x01000193) >>> 0;
    hash = Math.imul(hash ^ g, 0x01000193) >>> 0;
    hash = Math.imul(hash ^ b, 0x01000193) >>> 0;
    // Sky is bright and blue-dominant; anything else is city.
    if (!(b > 150 && b > r + 8)) nonBackground++;
  }
  return { hash, nonBackground, bytes };
}

function differingPixels(a: Uint8Array, b: Uint8Array): number {
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (
      Math.abs(a[i]! - b[i]!) > 6 ||
      Math.abs(a[i + 1]! - b[i + 1]!) > 6 ||
      Math.abs(a[i + 2]! - b[i + 2]!) > 6
    ) {
      differing++;
    }
  }
  return differing;
}

export interface IShaderTruthResult {
  readonly totalPixels: number;
  /** Pixels that changed when the correct flag (255) was written. */
  readonly changedWith255: number;
  /** Pixels that changed when the buggy flag (1) was written. */
  readonly changedWith1: number;
  /** Framebuffer hashes, for an exact identity check. */
  readonly hashIntact: number;
  readonly hashWith255: number;
  readonly hashWith1: number;
  readonly verticesFlagged: number;
}

/**
 * THE NORMALISED-UINT8 TRAP, TESTED AGAINST A REAL GPU PIPELINE.
 *
 * Not "does the byte equal 255" — that is a unit test, and it would pass just
 * as happily if the shader threshold had moved. This writes the flag into the
 * live attribute, renders through the city's real `installDestructionHook`
 * material, and reads the framebuffer back:
 *
 *   255 -> a large fraction of the image must change (triangles gone)
 *     1 -> the image must be BIT-IDENTICAL to intact (nothing hidden)
 *
 * The second assertion is the valuable one. It is the bug, reproduced on
 * purpose, so nobody can "fix" the constant back to 1 and have the suite agree.
 */
function runShaderTruth(): IShaderTruthResult {
  const w = world;
  if (w === undefined) throw new Error('no world');

  // A block with plenty of visible facade: the one nearest the camera axis.
  const target = w.scene.blockMeshes.reduce((best, mesh) => {
    const a = (mesh.mesh.geometry.getAttribute('position').array as Float32Array).length;
    const b = (best.mesh.geometry.getAttribute('position').array as Float32Array).length;
    return a > b ? mesh : best;
  }, w.scene.blockMeshes[0]!);

  const attribute = target.destroyed;
  const array = attribute.array as Uint8Array;
  const backup = array.slice();

  render();
  const intact = samplePixels();

  // Every vertex of the block — the most visible possible change.
  const verticesFlagged = array.length;

  array.fill(255);
  attribute.needsUpdate = true;
  render();
  const with255 = samplePixels();

  array.set(backup);
  attribute.needsUpdate = true;
  render();

  array.fill(1);
  attribute.needsUpdate = true;
  render();
  const with1 = samplePixels();

  array.set(backup);
  attribute.needsUpdate = true;
  render();

  return {
    totalPixels: intact.bytes.length / 4,
    changedWith255: differingPixels(intact.bytes, with255.bytes),
    changedWith1: differingPixels(intact.bytes, with1.bytes),
    hashIntact: intact.hash,
    hashWith255: with255.hash,
    hashWith1: with1.hash,
    verticesFlagged,
  };
}

export interface IPersistenceResult {
  readonly buildingId: string;
  readonly destroyedBefore: number;
  readonly destroyedAfter: number;
  readonly identical: boolean;
  readonly meshWasPristine: boolean;
  readonly hiddenVerticesAfter: number;
  readonly maskPieces: number;
  readonly maskBytes: number;
}

/**
 * Stream a damaged building out and back in.
 *
 * The real round trip: unregister (chunk unloads, meshes thrown away), rebuild
 * the block from the SAME SEED — which the generator does deterministically,
 * producing pristine geometry — and register again. The hole has to come back
 * before the mesh is ever drawn.
 */
function runPersistence(): IPersistenceResult {
  const w = world;
  if (w === undefined) throw new Error('no world');

  const damaged = w.destruction.orderedStructures.find((s) => s.destroyedCount > 0);
  if (damaged === undefined) throw new Error('nothing was damaged');
  const id = damaged.id;
  const before = [...damaged.destroyed];
  const destroyedBefore = damaged.destroyedCount;
  const summary = findSummary(w.scene, id);
  const entry = w.scene.buildings.find((b) => b.id === id)!;

  // ---- stream out ----
  w.destruction.unregister(id);

  // ---- stream in: regenerate the block exactly as the worker would ----
  const rebuilt = generator.generate(
    Math.floor(summary[0] / CHUNK_SIZE),
    Math.floor(summary[2] / CHUNK_SIZE),
    { detail: 'full', includeProps: false }
  );
  let freshMesh: ReturnType<typeof buildBlockMesh> | undefined;
  let freshLayout: IStructureLayout | undefined;
  for (const block of rebuilt.blocks) {
    if (block.geometry.buffers.vertexCount === 0) continue;
    if (!(id in block.fractures)) continue;
    freshMesh = buildBlockMesh(block, (key) => materials.get(key));
    freshLayout = block.fractures[id]!;
    break;
  }
  if (freshMesh === undefined || freshLayout === undefined) {
    throw new Error(`could not regenerate ${id}`);
  }

  const freshArray = freshMesh.destroyed.array as Uint8Array;
  let pristine = true;
  for (let i = 0; i < freshArray.length; i++) {
    if (freshArray[i] !== 0) {
      pristine = false;
      break;
    }
  }

  const restored = w.destruction.register({
    id,
    layout: freshLayout,
    target: freshMesh,
    position: { x: summary[0], y: summary[1], z: summary[2] },
    chunkIndex: entry.chunkIndex,
    buildingIndex: entry.buildingIndex,
  });

  const after = [...restored.destroyed];
  let identical = after.length === before.length;
  if (identical) {
    for (let i = 0; i < after.length; i++) {
      if (after[i] !== before[i]) {
        identical = false;
        break;
      }
    }
  }

  let hidden = 0;
  for (let i = 0; i < freshArray.length; i++) if (freshArray[i]! / 255 > 0.5) hidden++;

  const maskStats = w.damage.stats();
  return {
    buildingId: id,
    destroyedBefore,
    destroyedAfter: restored.destroyedCount,
    identical,
    meshWasPristine: pristine,
    hiddenVerticesAfter: hidden,
    maskPieces: maskStats.destroyedPieces,
    maskBytes: maskStats.residentBytes,
  };
}

export interface IDeterminismResult {
  readonly runs: number;
  readonly detachCount: number;
  readonly identical: boolean;
  readonly firstDivergence: string | undefined;
  readonly digest: string;
}

/**
 * Same seed, same punch, same rubble.
 *
 * Runs the punch twice on freshly generated worlds and compares every
 * `ChunkDetached` field to the last bit. This is the property replay, netcode,
 * save files and every "it only happens sometimes" bug report rest on.
 */
async function runDeterminism(): Promise<IDeterminismResult> {
  const capture = async (): Promise<string[]> => {
    const fresh = await buildWorld(seed);
    const log: string[] = [];
    fresh.bus.on('ChunkDetached', (event) => {
      log.push(
        `${event.structureId}#${event.chunkIndex}|` +
          `${event.position.x},${event.position.y},${event.position.z}|` +
          `${event.impulse.x},${event.impulse.y},${event.impulse.z}|${event.mass}`
      );
    });
    fresh.bus.emit('ShockwaveFired', {
      origin: PUNCH_ORIGIN,
      direction: PUNCH_DIRECTION,
      power: PUNCH_POWER,
      range: PUNCH_RANGE,
      angle: PUNCH_HALF_ANGLE,
      intent: 'full',
      punchKind: 'serious',
    });
    for (let i = 0; i < 12; i++) fresh.destruction.update(FIXED_STEP);
    fresh.destruction.dispose();
    fresh.debris.dispose();
    fresh.ragdolls.dispose();
    fresh.physics.dispose();
    return log;
  };

  const a = await capture();
  const b = await capture();

  let identical = a.length === b.length;
  let firstDivergence: string | undefined;
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    if (a[i] !== b[i]) {
      identical = false;
      firstDivergence = `#${i}: "${a[i]}" vs "${b[i]}"`;
      break;
    }
  }
  if (a.length !== b.length && firstDivergence === undefined) {
    firstDivergence = `length ${a.length} vs ${b.length}`;
  }

  let digest = 0x811c9dc5;
  for (const line of a) {
    for (let i = 0; i < line.length; i++) {
      digest = Math.imul(digest ^ line.charCodeAt(i), 0x01000193) >>> 0;
    }
  }

  return {
    runs: 2,
    detachCount: a.length,
    identical,
    firstDivergence,
    digest: digest.toString(16),
  };
}

/* -------------------------------------------------------------------------- */
/* Control surface                                                            */
/* -------------------------------------------------------------------------- */

declare global {
  interface Window {
    __DESTRUCTION_HARNESS__: {
      ready: boolean;
      reset(nextSeed?: string): Promise<IHarnessStats>;
      punch(): IHarnessStats;
      step(frames: number): IHarnessStats;
      setLabel(text: string): void;
      render(): IHarnessStats;
      stats(): IHarnessStats | undefined;
      shaderTruth(): IShaderTruthResult;
      persistence(): IPersistenceResult;
      determinism(): Promise<IDeterminismResult>;
      punchSpec(): Record<string, number>;
    };
  }
}

function requireStats(): IHarnessStats {
  const s = stats();
  if (s === undefined) throw new Error('harness has no world');
  return s;
}

window.__DESTRUCTION_HARNESS__ = {
  ready: false,
  async reset(nextSeed?: string) {
    if (nextSeed !== undefined) seed = nextSeed;
    if (world !== undefined) {
      world.destruction.dispose();
      world.debris.dispose();
      world.ragdolls.dispose();
      world.physics.dispose();
    }
    world = await buildWorld(seed);
    render();
    return requireStats();
  },
  punch() {
    punch();
    render();
    return requireStats();
  },
  step(frames: number) {
    step(frames);
    render();
    return requireStats();
  },
  setLabel(text: string) {
    overlayLabel = text;
    paint();
  },
  render() {
    render();
    return requireStats();
  },
  stats,
  shaderTruth: runShaderTruth,
  persistence: runPersistence,
  determinism: runDeterminism,
  punchSpec() {
    return {
      originX: PUNCH_ORIGIN.x,
      originY: PUNCH_ORIGIN.y,
      originZ: PUNCH_ORIGIN.z,
      range: PUNCH_RANGE,
      halfAngleDeg: (PUNCH_HALF_ANGLE * 180) / Math.PI,
      power: PUNCH_POWER,
    };
  },
};

async function boot(): Promise<void> {
  await initPhysics();
  world = await buildWorld(seed);
  overlayLabel = 'City Z block, intact';
  render();
  window.addEventListener('resize', () => render());
  window.__DESTRUCTION_HARNESS__.ready = true;
}

void boot();
