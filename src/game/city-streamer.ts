/**
 * CITY RESIDENCY — the ring of City Z that exists right now.
 *
 * ── WHY THIS EXISTS AND `src/world/streaming` DOES NOT DRIVE IT ────────────
 * There are two world generators in this repository and they emit different
 * things. `src/world/streaming` emits `IGeometryBuffers` — positions, normals,
 * Uint8 colours, indices — built in a worker and uploaded on a budget. It is
 * the better SCHEDULER. `src/world/city` emits pre-fractured blocks: per-vertex
 * UVs, a per-vertex `aDestroyed` byte, material groups, and an `IFractureLayout`
 * per building describing every floor and quadrant as an index range.
 *
 * Only the second one can be destroyed. `DestructionSystem.register` takes an
 * `IStructureLayout`, which is the city generator's baked table and nothing
 * else, and a serious punch that does not take a building apart is not this
 * game. So the city generator is the world, and this file is the residency
 * manager it never shipped with. See the report for what that costs.
 *
 * ── WHAT IT DOES PER CHUNK ─────────────────────────────────────────────────
 *   generate   `CityGenerator.generate(cx, cz, { detail })`, detail by distance
 *   build      block meshes + ground, through the shared material library
 *   destroy    every building registered with `DestructionSystem`, addressed
 *              into the 8 KB persistent bitmask (16 buildings per chunk)
 *   collide    one box body per building, plus the chunk's ground slab
 *   populate   crowd spawn slots and obstacle rectangles
 *   index      static AABBs into the quadtree, for culling
 *
 * ── THE BUDGET, AND WHAT IT COSTS ──────────────────────────────────────────
 * Generation is 30-800 ms per chunk on the MAIN THREAD, measured, so exactly
 * one chunk is built per `STREAM_INTERVAL_SECONDS` and never two in a frame.
 * The boot path calls `buildImmediate` for the ring that is unavoidably in
 * shot; everything beyond arrives during play.
 *
 * Be honest about the consequence: crossing a chunk boundary at dash speed
 * (22 m/s, one boundary every four seconds) is a visible hitch, because the
 * work is synchronous and there is nowhere else to put it. `src/world/streaming`
 * solves exactly this with a worker pool — it is the right long-term home, and
 * moving there means teaching its worker protocol to carry UVs, material groups
 * and the per-vertex destruction byte the pre-fractured city needs.
 */

import * as THREE from 'three';
import type { DistrictType, IEventBus, IQualityTier } from '@/types';
import {
  CityGenerator,
  buildBlockMesh,
  buildGroundMesh,
  type IBlockMesh,
  type ICityChunkBuild,
  type MaterialResolver,
} from '@/world/city';
import { chunkIndexForPosition } from '@/world/streaming';
import { CHUNK_SIZE, CHUNK_COORD_MIN, CHUNK_COORD_MAX } from '@/spatial';
import type { SpatialIndex } from '@/spatial';
import type { DestructionSystem } from '@/gameplay/destruction';
import type { PhysicsWorld } from '@/physics';
import type { IObstacleRect } from '@/entities/npc';
import { createLogger } from '@/util';
import {
  COLLIDER_RADIUS,
  FULL_DETAIL_RADIUS,
  REDUCED_DETAIL_RADIUS,
  RESIDENT_RADIUS_BY_TIER,
  STREAM_INTERVAL_SECONDS,
} from './config';

const log = createLogger('game:city');

/** Resolves a prop asset key to drawable geometry, or undefined while loading. */
export type PropResolver = (
  assetKey: string
) => { geometry: THREE.BufferGeometry; material: THREE.Material } | undefined;

/** Damage slots the 8 KB persistent bitmask addresses per 96 m chunk. */
const DAMAGE_SLOTS_PER_CHUNK = 16;

/* -------------------------------------------------------------------------- */
/* Records                                                                    */
/* -------------------------------------------------------------------------- */

/** Everything the game holds onto for one resident chunk. */
export interface IResidentChunk {
  readonly index: number;
  readonly cx: number;
  readonly cz: number;
  readonly group: THREE.Group;
  readonly build: ICityChunkBuild;
  readonly blocks: readonly IBlockMesh[];
  /** Prop instances, added late — see `attachProps`. */
  readonly props: THREE.InstancedMesh[];
  /** Ids registered with destruction, so they can be unregistered on evict. */
  readonly structureIds: readonly string[];
  /** Physics body handles owned by this chunk. */
  readonly bodyHandles: readonly number[];
  /** Quadtree handles, released on evict. */
  readonly staticHandles: readonly number[];
  readonly obstacles: readonly IObstacleRect[];
  readonly buildMs: number;
  readonly drawCalls: number;
}

export interface ICityStreamerOptions {
  readonly generator: CityGenerator;
  readonly scene: THREE.Scene;
  readonly resolve: MaterialResolver;
  readonly destruction: DestructionSystem;
  readonly physics?: PhysicsWorld;
  readonly spatial?: SpatialIndex;
  readonly bus?: IEventBus;
  readonly quality?: IQualityTier;
  /**
   * Make a freshly built chunk's materials cascade-aware.
   *
   * NOT optional in practice. `ShadowSystem` patches `lights_fragment_begin`
   * so a registered material accumulates the sun ONCE across all cascades; an
   * unregistered one takes the ordinary branch and accumulates ALL THREE
   * cascade lights, which is a district rendered three times too bright. There
   * is no counter to check — the only symptom is that everything is blown out,
   * which is exactly how this was found.
   */
  readonly registerMaterials?: (root: THREE.Object3D) => void;
  /** Notified whenever the resident set changes, so obstacles can be republished. */
  readonly onResidencyChanged?: (chunks: readonly IResidentChunk[]) => void;
}

/* -------------------------------------------------------------------------- */
/* Streamer                                                                   */
/* -------------------------------------------------------------------------- */

export class CityStreamer {
  private readonly generator: CityGenerator;
  private readonly scene: THREE.Scene;
  private readonly resolve: MaterialResolver;
  private readonly destruction: DestructionSystem;
  private readonly physics: PhysicsWorld | undefined;
  private readonly spatial: SpatialIndex | undefined;
  private readonly onResidencyChanged: ICityStreamerOptions['onResidencyChanged'];
  private readonly registerMaterials: ICityStreamerOptions['registerMaterials'];

  private readonly resident = new Map<number, IResidentChunk>();
  private readonly pending: { cx: number; cz: number; index: number; distance: number }[] = [];
  /** Next free damage slot per chunk. The mask addresses 16 buildings each. */
  private readonly slotCursor = new Map<number, number>();
  private readonly districtByChunk = new Map<number, DistrictType>();

  private residentRadius: number;
  private focusChunkX = 0;
  private focusChunkZ = 0;
  private focusValid = false;

  /** Buildings the 16-slot budget could not address. Surfaced, never aliased. */
  unaddressableBuildings = 0;
  /** Cumulative wall-clock milliseconds spent generating chunks. */
  totalBuildMs = 0;
  /** Milliseconds the most recent chunk cost. */
  lastBuildMs = 0;
  /**
   * Where the most recent chunk's milliseconds went.
   *
   * Kept permanently rather than behind a debug flag: chunk build is the single
   * largest main-thread cost in this game and "the world took nine seconds" is
   * not an actionable sentence without this breakdown.
   */
  readonly lastBuildBreakdown = { generate: 0, mesh: 0, register: 0, physics: 0, ground: 0 };

  private sinceLastBuild = 0;
  private resolveModel: PropResolver | undefined;

  constructor(options: ICityStreamerOptions) {
    this.generator = options.generator;
    this.scene = options.scene;
    this.resolve = options.resolve;
    this.destruction = options.destruction;
    this.physics = options.physics;
    this.spatial = options.spatial;
    this.onResidencyChanged = options.onResidencyChanged;
    this.registerMaterials = options.registerMaterials;
    this.residentRadius = RESIDENT_RADIUS_BY_TIER[options.quality ?? 'medium'];
  }

  get residentCount(): number {
    return this.resident.size;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get chunks(): readonly IResidentChunk[] {
    return [...this.resident.values()];
  }

  setQuality(quality: IQualityTier): void {
    this.residentRadius = RESIDENT_RADIUS_BY_TIER[quality];
  }

  /** District at a world position, from whatever chunk is resident there. */
  districtAt(x: number, z: number): DistrictType {
    return this.districtByChunk.get(chunkIndexForPosition(x, z)) ?? 'residential';
  }

  /**
   * Materialise street furniture on every resident chunk that has none yet.
   *
   * Idempotent and cheap to call repeatedly: a chunk is skipped once its props
   * exist, and a batch whose model has not loaded yet is left for the next call
   * rather than resolved to nothing permanently.
   */
  attachProps(resolveModel: PropResolver): number {
    this.resolveModel = resolveModel;
    const matrix = new THREE.Matrix4();
    let added = 0;
    for (const chunk of this.resident.values()) {
      if (chunk.props.length > 0) continue;
      let complete = true;
      const meshes: THREE.InstancedMesh[] = [];
      for (const batch of chunk.build.instances) {
        const model = resolveModel(batch.assetKey);
        if (model === undefined) {
          complete = false;
          continue;
        }
        const mesh = new THREE.InstancedMesh(model.geometry, model.material, batch.count);
        mesh.name = `props:${batch.assetKey}`;
        for (let i = 0; i < batch.count; i++) {
          matrix.fromArray(batch.matrices, i * 16);
          mesh.setMatrixAt(i, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        meshes.push(mesh);
      }
      // All or nothing per chunk: a half-populated street that fills in over
      // the next few seconds is more distracting than one that arrives at once.
      if (!complete || meshes.length === 0) {
        for (const mesh of meshes) mesh.dispose();
        continue;
      }
      for (const mesh of meshes) chunk.group.add(mesh);
      chunk.props.push(...meshes);
      this.registerMaterials?.(chunk.group);
      added += meshes.length;
    }
    return added;
  }

  /**
   * Distinct prop models the RESIDENT chunks reference.
   *
   * The manifest holds 39 prop models and 24 MB of GLB; a nine-chunk ring
   * references about half of them. Loading only these is the difference between
   * street furniture appearing a few seconds after boot and appearing after
   * every model in the game has been decoded.
   */
  requiredPropModels(): string[] {
    const keys = new Set<string>();
    for (const chunk of this.resident.values()) {
      if (chunk.props.length > 0) continue;
      for (const batch of chunk.build.instances) keys.add(batch.assetKey);
    }
    return [...keys].sort();
  }

  /** Obstacle rectangles for every resident building. Fed to the crowd. */
  obstacleRects(): IObstacleRect[] {
    const out: IObstacleRect[] = [];
    for (const chunk of this.resident.values()) out.push(...chunk.obstacles);
    return out;
  }

  /**
   * Re-score the resident set against a new focus.
   *
   * Cheap and idempotent: it only moves chunks between the resident map and the
   * pending queue. No geometry is generated here.
   */
  setFocus(x: number, z: number): void {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    if (this.focusValid && cx === this.focusChunkX && cz === this.focusChunkZ) return;
    this.focusChunkX = cx;
    this.focusChunkZ = cz;
    this.focusValid = true;
    this.rescore();
  }

  /**
   * Build at most one chunk, at most every `STREAM_INTERVAL_SECONDS`.
   *
   * One per interval is not a throttle chosen for comfort. The cheapest chunk in
   * the plan is 30 ms and the most expensive is 1.5 s, so two in a frame is a
   * guaranteed stall and a millisecond budget cannot prevent it — the cost is
   * only known after it has been paid. Spacing them in TIME also survives a
   * slow renderer, where a frame-time budget would never have anything left
   * over and the world would simply stop arriving.
   */
  update(dt: number): boolean {
    this.sinceLastBuild += dt;
    if (this.sinceLastBuild < STREAM_INTERVAL_SECONDS) return false;
    const next = this.pending.shift();
    if (next === undefined) return false;
    this.sinceLastBuild = 0;
    this.build(next.cx, next.cz, next.distance);
    return true;
  }

  /** Build everything within `radius` of the focus now. The boot path. */
  buildImmediate(radius: number): void {
    if (!this.focusValid) return;
    for (let d = 0; d <= radius; d++) {
      for (let cz = this.focusChunkZ - d; cz <= this.focusChunkZ + d; cz++) {
        for (let cx = this.focusChunkX - d; cx <= this.focusChunkX + d; cx++) {
          if (Math.max(Math.abs(cx - this.focusChunkX), Math.abs(cz - this.focusChunkZ)) !== d) {
            continue;
          }
          if (!inWorld(cx, cz)) continue;
          const index = chunkIndex(cx, cz);
          if (this.resident.has(index)) continue;
          this.build(cx, cz, d);
        }
      }
    }
    this.rescore();
  }

  /* ---------------------------------------------------------------------- */
  /* Residency                                                              */
  /* ---------------------------------------------------------------------- */

  private rescore(): void {
    this.pending.length = 0;
    const wanted = new Set<number>();

    for (let cz = this.focusChunkZ - this.residentRadius; cz <= this.focusChunkZ + this.residentRadius; cz++) {
      for (let cx = this.focusChunkX - this.residentRadius; cx <= this.focusChunkX + this.residentRadius; cx++) {
        if (!inWorld(cx, cz)) continue;
        const index = chunkIndex(cx, cz);
        wanted.add(index);
        if (this.resident.has(index)) continue;
        const distance = Math.max(Math.abs(cx - this.focusChunkX), Math.abs(cz - this.focusChunkZ));
        this.pending.push({ cx, cz, index, distance });
      }
    }
    // Nearest first: the chunk the player is about to walk into matters more
    // than the one behind them, and both are already in the queue.
    this.pending.sort((a, b) => a.distance - b.distance);

    // Evict with one chunk of hysteresis, so walking a chunk boundary back and
    // forth does not rebuild a 400 ms chunk twice a second.
    for (const [index, chunk] of this.resident) {
      if (wanted.has(index)) continue;
      const distance = Math.max(
        Math.abs(chunk.cx - this.focusChunkX),
        Math.abs(chunk.cz - this.focusChunkZ)
      );
      if (distance <= this.residentRadius + 1) continue;
      this.evict(index);
    }
    this.onResidencyChanged?.(this.chunks);
  }

  /* ---------------------------------------------------------------------- */
  /* Build                                                                  */
  /* ---------------------------------------------------------------------- */

  private build(cx: number, cz: number, distance: number): void {
    const index = chunkIndex(cx, cz);
    if (this.resident.has(index)) return;

    const started = performance.now();
    // Explicit bands by CHUNK DISTANCE, not `detailForDistance(metres)`.
    // A chunk two rings out has its near edge at 96 m and its far edge at
    // 288 m, so any single distance handed to the metre-based helper is a lie
    // about most of it — and the version that rounds up costs 100 k vertices
    // per chunk for facade relief nobody can resolve at that range. Sixteen of
    // those is the whole vertex budget spent on the ring you cannot see.
    const detail =
      distance <= FULL_DETAIL_RADIUS
        ? 'full'
        : distance <= REDUCED_DETAIL_RADIUS
          ? 'reduced'
          : 'box';

    const breakdown = this.lastBuildBreakdown;
    let phase = performance.now();
    // Props are LAID OUT here and MATERIALISED later. The placement is part of
    // the chunk's deterministic layout and costs almost nothing; the models are
    // 24 MB of GLB that must not be on the boot path, so `attachProps` adds the
    // instanced meshes once they land. A chunk with no props is a chunk that
    // renders early, not a chunk that never gets street furniture.
    const build = this.generator.generate(cx, cz, { detail, includeProps: true });
    breakdown.generate = performance.now() - phase;
    this.districtByChunk.set(index, build.district);

    const group = new THREE.Group();
    group.name = `city:${cx},${cz}`;
    group.matrixAutoUpdate = false;

    const blocks: IBlockMesh[] = [];
    const structureIds: string[] = [];
    const bodyHandles: number[] = [];
    const staticHandles: number[] = [];
    const obstacles: IObstacleRect[] = [];
    let drawCalls = 0;

    breakdown.mesh = 0;
    breakdown.register = 0;
    breakdown.physics = 0;
    for (const block of build.blocks) {
      if (block.geometry.buffers.vertexCount === 0) continue;
      phase = performance.now();
      const mesh = buildBlockMesh(block, this.resolve);
      breakdown.mesh += performance.now() - phase;
      blocks.push(mesh);
      group.add(mesh.mesh);
      drawCalls += mesh.drawCalls;

      const summaries = new Map(block.buildings.map((b) => [b.id, b]));
      // Sorted, so a damage slot addresses the same building on every run and a
      // save restored tomorrow puts the hole back in the same wall.
      for (const id of Object.keys(mesh.fractures).sort()) {
        const layout = mesh.fractures[id];
        const summary = summaries.get(id);
        if (layout === undefined || summary === undefined) continue;

        const used = this.slotCursor.get(index) ?? 0;
        let slotChunk: number | undefined;
        let slotBuilding: number | undefined;
        if (used < DAMAGE_SLOTS_PER_CHUNK) {
          slotChunk = index;
          slotBuilding = used;
          this.slotCursor.set(index, used + 1);
        } else {
          this.unaddressableBuildings++;
        }

        phase = performance.now();
        this.destruction.register({
          id,
          layout,
          target: mesh,
          position: { x: summary.position[0], y: summary.position[1], z: summary.position[2] },
          chunkIndex: slotChunk,
          buildingIndex: slotBuilding,
        });
        breakdown.register += performance.now() - phase;
        structureIds.push(id);

        const [minX, minY, minZ, maxX, maxY, maxZ] = summary.bounds;
        obstacles.push({ minX, minZ, maxX, maxZ, height: maxY - minY });

        if (this.physics !== undefined && distance <= COLLIDER_RADIUS) {
          phase = performance.now();
          const handle = this.addBuildingCollider(minX, minY, minZ, maxX, maxY, maxZ);
          breakdown.physics += performance.now() - phase;
          if (handle !== undefined) bodyHandles.push(handle);
        }
        if (this.spatial !== undefined) {
          staticHandles.push(
            this.spatial.insertStatic(minX, minY, minZ, maxX, maxY, maxZ, id)
          );
        }
      }
    }

    phase = performance.now();
    if (build.ground !== undefined) {
      const ground = buildGroundMesh(build.ground, this.resolve);
      group.add(ground);
      drawCalls += build.ground.drawCalls;
    }
    breakdown.ground = performance.now() - phase;

    this.scene.add(group);
    this.registerMaterials?.(group);

    // The ground SLAB. City ground is a visual mesh with kerbs and markings;
    // physics gets one box per chunk so a fall never leaves the world and
    // debris has something to land on.
    if (this.physics !== undefined && distance <= COLLIDER_RADIUS) {
      const handle = this.addGroundSlab(cx, cz);
      if (handle !== undefined) bodyHandles.push(handle);
    }

    const buildMs = performance.now() - started;
    this.totalBuildMs += buildMs;
    this.lastBuildMs = buildMs;

    this.resident.set(index, {
      index,
      cx,
      cz,
      group,
      build,
      blocks,
      structureIds,
      bodyHandles,
      staticHandles,
      obstacles,
      props: [],
      buildMs,
      drawCalls,
    });
    if (this.resolveModel !== undefined) this.attachProps(this.resolveModel);
    log.info(
      `chunk (${cx},${cz}) detail=${detail} ${buildMs.toFixed(0)}ms ` +
        `[gen ${breakdown.generate.toFixed(0)} mesh ${breakdown.mesh.toFixed(0)} ` +
        `reg ${breakdown.register.toFixed(0)} phys ${breakdown.physics.toFixed(0)} ` +
        `ground ${breakdown.ground.toFixed(0)}] ` +
        `${structureIds.length} buildings ${drawCalls} draws`
    );
    this.onResidencyChanged?.(this.chunks);
  }

  private addBuildingCollider(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number
  ): number | undefined {
    const physics = this.physics;
    if (physics === undefined) return undefined;
    const body = physics.createBody({
      type: 'fixed',
      shape: {
        kind: 'box',
        halfExtents: new THREE.Vector3(
          Math.max(0.1, (maxX - minX) * 0.5),
          Math.max(0.1, (maxY - minY) * 0.5),
          Math.max(0.1, (maxZ - minZ) * 0.5)
        ),
      },
      position: new THREE.Vector3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
      layer: 'world',
      collidesWith: ['player', 'monster', 'npc', 'debris', 'projectile', 'ragdoll'],
      friction: 0.85,
      restitution: 0.01,
    });
    return body.handle;
  }

  private addGroundSlab(cx: number, cz: number): number | undefined {
    const physics = this.physics;
    if (physics === undefined) return undefined;
    const body = physics.createBody({
      type: 'fixed',
      shape: {
        kind: 'box',
        halfExtents: new THREE.Vector3(CHUNK_SIZE * 0.5, 0.5, CHUNK_SIZE * 0.5),
      },
      position: new THREE.Vector3((cx + 0.5) * CHUNK_SIZE, -0.5, (cz + 0.5) * CHUNK_SIZE),
      layer: 'world',
      collidesWith: ['player', 'monster', 'npc', 'debris', 'projectile', 'ragdoll'],
      friction: 0.9,
      restitution: 0.02,
    });
    return body.handle;
  }

  /* ---------------------------------------------------------------------- */
  /* Eviction                                                               */
  /* ---------------------------------------------------------------------- */

  private evict(index: number): void {
    const chunk = this.resident.get(index);
    if (chunk === undefined) return;
    this.resident.delete(index);

    for (const id of chunk.structureIds) this.destruction.unregister(id);
    if (this.physics !== undefined) {
      for (const handle of chunk.bodyHandles) this.physics.removeBody(handle);
    }
    if (this.spatial !== undefined) {
      for (const handle of chunk.staticHandles) this.spatial.removeStatic(handle);
    }

    for (const mesh of chunk.props) mesh.dispose();
    chunk.props.length = 0;
    this.scene.remove(chunk.group);
    disposeGroup(chunk.group);
    log.debug(`evicted chunk (${chunk.cx},${chunk.cz})`);
  }

  dispose(): void {
    for (const index of [...this.resident.keys()]) this.evict(index);
    this.pending.length = 0;
    this.slotCursor.clear();
    this.districtByChunk.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function inWorld(cx: number, cz: number): boolean {
  return (
    cx >= CHUNK_COORD_MIN && cx <= CHUNK_COORD_MAX && cz >= CHUNK_COORD_MIN && cz <= CHUNK_COORD_MAX
  );
}

/** `(cz + 8) * 16 + (cx + 8)` — the convention every system in the repo shares. */
function chunkIndex(cx: number, cz: number): number {
  return (cz + 8) * 16 + (cx + 8);
}

/**
 * Free a chunk's GPU memory.
 *
 * Geometry only. Materials are SHARED across every chunk by the material
 * library and disposing one here would blank the rest of the city.
 */
function disposeGroup(group: THREE.Group): void {
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    // Instanced props SHARE the registry's geometry with every other chunk;
    // disposing it here empties the street furniture of the whole city.
    if ((mesh as THREE.InstancedMesh).isInstancedMesh === true) return;
    mesh.geometry.dispose();
  });
  group.clear();
}
