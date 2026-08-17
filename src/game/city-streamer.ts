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
 *
 * ── AND EVERYTHING PAST THE RESIDENT RING ──────────────────────────────────
 * A radius of one is 288 m of city on a 1536 m map. Past it there was nothing
 * at all, and a street that ends in empty sky at 150 m does not read as "the
 * draw distance is short" — it reads as broken. So this file also owns the
 * IMPOSTOR RING: `src/world/streaming/impostor-ring.ts` and its residency
 * material, driven from THIS city's plan. See `bakeSkyline` below.
 */

import * as THREE from 'three';
import type { DistrictType, IEventBus, IQualityTier } from '@/types';
import {
  CityGenerator,
  blockSeed,
  buildBlockMesh,
  buildGroundMesh,
  polygonBounds,
  polygonCentroid,
  shadeTint,
  subdivideBlock,
  tintToRgb,
  type IBlockMesh,
  type ICityChunkBuild,
  type ICityPlanIndex,
  type IPlanBlock,
  type IPlanZone,
  type IPlanZoneParams,
  type MaterialResolver,
} from '@/world/city';
import {
  ImpostorRing,
  StreamingMaterials,
  IMPOSTOR_ALWAYS_VISIBLE,
  chunkIndexForPosition,
  hashGeometry,
  type IImpostorBuildResult,
  type IImpostorStats,
} from '@/world/streaming';
import {
  CHUNK_SIZE,
  CHUNK_COORD_MIN,
  CHUNK_COORD_MAX,
  WORLD_MIN,
  WORLD_MAX,
} from '@/spatial';
import type { SpatialIndex } from '@/spatial';
import type { DestructionSystem } from '@/gameplay/destruction';
import type { PhysicsWorld } from '@/physics';
import type { IObstacleRect } from '@/entities/npc';
import { createLogger, createRng, type IRandom } from '@/util';
import {
  COLLIDER_RADIUS,
  FULL_DETAIL_RADIUS,
  IMPOSTOR_ALBEDO,
  IMPOSTOR_GROUND_COLOUR,
  IMPOSTOR_GROUND_DEPTH,
  IMPOSTOR_HEIGHT_SCALE,
  IMPOSTOR_PLAN_SCALE,
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
/* The distant skyline                                                        */
/* -------------------------------------------------------------------------- */

/**
 * THE IMPOSTOR BAKE — ONE DRAW CALL FOR EVERYTHING PAST THE RESIDENT RING
 *
 * `ImpostorRing` (in `src/world/streaming`) is the mesh, the upload and the
 * residency wiring: one merged buffer covering all 256 chunks, every vertex
 * tagged with the chunk it came from, and a 16x16 residency texture read in the
 * vertex shader that collapses any vertex whose real chunk is loaded. That is
 * what keeps 1 100+ distant buildings at ONE draw call while never drawing over
 * streamed geometry — splitting the mesh to skip resident chunks would cost the
 * very draw call that justifies it.
 *
 * What it is NOT is a source of geometry. Its companion baker,
 * `buildImpostorGeometry(seed)`, silhouettes `chunk-layout.ts` — the streaming
 * workstream's own placeholder city, which its header calls a placeholder in as
 * many words. This game's world is `assets/district/cityz.plan.json` through
 * `CityGenerator`, and the two are DIFFERENT CITIES. Measured, before choosing:
 *
 *   • mean |Δ tallest building| per chunk: 18.9 m over 249 chunks;
 *   • chunk (2,0) — 200 m down the avenue from spawn, in shot at boot — is a
 *     21 m shed in the placeholder and an 84 m tower in the real plan;
 *   • the placeholder puts its block at 8..88 m inside each 96 m chunk, the
 *     plan at 18..87, so placeholder silhouettes stand up to 10 m INSIDE the
 *     real carriageway — closing the avenue this task exists to open.
 *
 * So the mesh is theirs and the buildings are ours. This function walks the
 * SAME plan the resident chunks are generated from and emits one five-face box
 * per building, which is why the far city lines up with the near one exactly:
 * same footprints, same heights, same streets between them.
 *
 * ── WHY THE FOOTPRINTS AND HEIGHTS ARE EXACT AND NOT MERELY SIMILAR ────────
 * `generateBlock` derives its buildings from three things: `subdivideBlock` for
 * the lots, a per-lot density roll, and a shaped height roll. The first is a
 * public export and is called here verbatim; the rolls are drawn from
 * `rng.derive('buildings')`, and `derive()` is keyed by LABEL off the base seed
 * rather than by the parent's consumed state — so this file can reproduce that
 * stream without reproducing the mesh generation that normally consumes it.
 * The result is byte-identical heights: 429/429 buildings matched
 * `CityGenerator` exactly across 36 sampled chunks.
 *
 * The coupling is real and is worth stating plainly: `readBuildRng` mirrors the
 * ORDER in which `makeRecipe` draws from that stream. If someone adds a roll
 * there and not here, the far city drifts from the near one. That is why
 * `impostorDrift` exists — every chunk that becomes resident re-checks its own
 * silhouettes against the buildings actually generated, and the counter is on
 * the debug HUD. Silent drift is the failure mode; a counter is the fix.
 *
 * ── WHY NOT JUST GENERATE THE REAL CHUNKS ──────────────────────────────────
 * Measured: 256 chunks through `CityGenerator` at its cheapest `box` detail is
 * 4 228 ms. The silhouette walk is 41 ms. That is the whole argument.
 *
 * ── WHAT IT DELIBERATELY LEAVES OUT ────────────────────────────────────────
 * Courtyard sheds, park planting and rooftop clutter: interior, low, and
 * invisible past the first row of façades. Damage: the bake is once, at boot,
 * and a missing corner is not resolvable at 800 m — the same limitation the
 * original ring shipped with, for the same reason.
 */

/** One distant building: an axis-aligned box and the colours to paint it. */
interface ISkylineBox {
  readonly chunk: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly height: number;
  /** Packed 0xRRGGBB façade tint, as `generateBuilding` bakes it. */
  readonly facade: number;
  readonly roof: number;
}

/** The bake, plus what the drift check needs to police it. */
interface ISkylineBake {
  readonly result: IImpostorBuildResult;
  /**
   * Silhouette heights per chunk, one array PER PLAN BLOCK in
   * `ICityPlanIndex.blocksByChunk` order, each in the order `generateBlock`
   * emits its perimeter buildings. That is the shape the drift check needs:
   * `build.blocks[j].buildings[k].height` must equal entry `[j][k]`.
   */
  readonly heightsByChunk: ReadonlyMap<number, readonly (readonly number[])[]>;
}

/** Style keys `pickStyle` weighs, in the order it weighs them. */
const STYLE_KEYS = [
  'residential',
  'commercial',
  'skyscraper',
  'industrial',
  'shophouse',
  'apartment',
  'civic',
  'ruins',
] as const;

/** `[0,1]` clamp, matching `block.ts`'s own. */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Pack a linear 0..1 triple back into 0xRRGGBB. */
function packTint(tint: readonly [number, number, number]): number {
  const r = Math.max(0, Math.min(255, Math.round(tint[0] * 255)));
  const g = Math.max(0, Math.min(255, Math.round(tint[1] * 255)));
  const b = Math.max(0, Math.min(255, Math.round(tint[2] * 255)));
  return (r << 16) | (g << 8) | b;
}

/**
 * Draw one building's worth of `buildRng`, returning its storey count.
 *
 * MIRRORS `makeRecipe` in `src/world/city/block.ts`. Every draw is here, in
 * order, including the ones whose values are thrown away — a stream read out of
 * step is a different city, not a slightly different one. The rolls whose
 * results this function ignores are marked; they must not be removed.
 */
function readBuildRng(
  rng: IRandom,
  params: IPlanZoneParams,
  block: IPlanBlock,
  isCorner: boolean,
  isPrimary: boolean
): { floors: number; tint: number } {
  const [minFloors, maxFloors] = params.floorRange;
  const roll = Math.pow(rng.next(), params.heightExponent);
  let floors = Math.round(minFloors + roll * (maxFloors - minFloors));
  floors += block.heightBias;
  if (isCorner) floors += rng.int(0, 2);
  if (isPrimary) floors += rng.int(0, 2);
  if (maxFloors >= 6 && rng.bool(0.07)) floors = Math.round(floors * rng.range(1.5, 2.4));
  floors = Math.max(1, Math.min(maxFloors * 2 + 6, floors));

  // pickStyle: one weighted draw over the styles whose weight is above zero.
  const styles: string[] = [];
  const weights: number[] = [];
  for (const key of STYLE_KEYS) {
    const w = params.styleWeights[key];
    if (w !== undefined && w > 0) {
      styles.push(key);
      weights.push(w);
    }
  }
  const style = styles.length === 0 ? 'residential' : rng.weighted(styles, weights);
  const tint = params.tints[rng.int(0, params.tints.length - 1)] ?? 0xffffff;
  rng.nextUint32(); // recipe seed — consumed, unused here
  // parapetHeight is only rolled for non-industrial styles.
  if (style !== 'industrial') rng.range(0.7, 1.15);
  return { floors, tint };
}

/** Every silhouette a plan block contributes, in `generateBlock`'s own order. */
function blockSilhouettes(
  planVersion: number,
  block: IPlanBlock,
  zone: IPlanZone,
  chunk: number,
  exclusions: readonly (readonly [number, number, number])[]
): ISkylineBox[] {
  // Parks and craters have no lots at all; `generateBlock` skips subdivision
  // for them and fills them with planting instead, which is not skyline.
  if (zone.kind === 'park' || zone.kind === 'crater') return [];

  const params = zone.params;
  const rng = createRng(blockSeed(planVersion, block.id));
  const lots = subdivideBlock(block.outline, params, block, rng.derive('lots'));
  const buildRng = rng.derive('buildings');
  const density = clamp01(params.density * block.density);
  const out: ISkylineBox[] = [];

  for (const lot of lots) {
    // Order matters: the density roll happens BEFORE the exclusion test in
    // `generateBlock`, and a lot skipped by density never touches `makeRecipe`.
    if (!lot.isPrimary && !buildRng.bool(density)) continue;
    const centre = polygonCentroid(lot.footprint);
    let excluded = false;
    for (const [ex, ez, radius] of exclusions) {
      if (Math.hypot(centre[0] - ex, centre[1] - ez) < radius) {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;

    const { floors, tint } = readBuildRng(buildRng, params, block, lot.isCorner, lot.isPrimary);
    const bounds = polygonBounds(lot.footprint);
    const rgb = tintToRgb(tint);
    out.push({
      chunk,
      minX: bounds.minX,
      minZ: bounds.minZ,
      maxX: bounds.maxX,
      maxZ: bounds.maxZ,
      // `computeFloorTops`: the ground floor is taller than the rest.
      height: params.floorHeight * (params.groundFloorScale + floors - 1),
      facade: packTint(rgb),
      roof: packTint(shadeTint(rgb, 0.62)),
    });
  }
  return out;
}

/** A hand-placed landmark's silhouette. Straight plan data — no rolls at all. */
function landmarkSilhouettes(index: ICityPlanIndex): ISkylineBox[] {
  const out: ISkylineBox[] = [];
  for (const landmark of index.plan.landmarks) {
    const cos = Math.cos(landmark.rotationY);
    const sin = Math.sin(landmark.rotationY);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const [lx, lz] of landmark.footprint) {
      const x = landmark.position[0] + lx * cos + lz * sin;
      const z = landmark.position[1] - lx * sin + lz * cos;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX)) continue;
    const rgb = tintToRgb(landmark.tint);
    out.push({
      // The chunk `indexPlan` files this landmark under, so residency
      // suppresses the silhouette exactly when the real one is built.
      chunk: chunkIndex(
        Math.floor(landmark.position[0] / CHUNK_SIZE),
        Math.floor(landmark.position[1] / CHUNK_SIZE)
      ),
      minX,
      minZ,
      maxX,
      maxZ,
      height: landmark.floors * landmark.floorHeight,
      facade: packTint(rgb),
      roof: packTint(shadeTint(rgb, 0.62)),
    });
  }
  return out;
}

/**
 * Walk the whole plan and pack every silhouette into one indexed buffer.
 *
 * Exactly sized up front: the box count is known before a byte is written, so
 * there is no doubling, no reallocation and no trailing `slice`. Five faces per
 * box — the floor of a building standing on the ground is never visible.
 */
function bakeSkyline(index: ICityPlanIndex): ISkylineBake {
  const started = performance.now();
  const plan = index.plan;

  const boxes: ISkylineBox[] = [];
  const heightsByChunk = new Map<number, number[][]>();
  for (let chunk = 0; chunk < index.blocksByChunk.length; chunk++) {
    const planBlocks = index.blocksByChunk[chunk]!;
    if (planBlocks.length === 0) continue;
    const perBlock: number[][] = [];
    for (const block of planBlocks) {
      const silhouettes = blockSilhouettes(
        plan.planVersion,
        block,
        index.zoneOfBlock(block),
        chunk,
        exclusionsForChunk(index, block.chunk[0], block.chunk[1])
      );
      boxes.push(...silhouettes);
      perBlock.push(silhouettes.map((s) => s.height));
    }
    heightsByChunk.set(chunk, perBlock);
  }
  boxes.push(...landmarkSilhouettes(index));

  /* ---- pack ----------------------------------------------------------- */

  // One world ground quad plus five faces per box, four vertices each.
  const vertexCount = 4 + boxes.length * 20;
  const indexCount = 6 + boxes.length * 30;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Uint8Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const chunkIds = new Uint16Array(vertexCount);

  let v = 0;
  let i = 0;
  let maxY = 0;

  /** Append one quad, wound counter-clockwise as seen from the normal. */
  const quad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    colour: number,
    chunk: number
  ): void => {
    const p = v * 3;
    positions[p] = ax; positions[p + 1] = ay; positions[p + 2] = az;
    positions[p + 3] = bx; positions[p + 4] = by; positions[p + 5] = bz;
    positions[p + 6] = cx; positions[p + 7] = cy; positions[p + 8] = cz;
    positions[p + 9] = dx; positions[p + 10] = dy; positions[p + 11] = dz;
    const r = (colour >> 16) & 0xff;
    const g = (colour >> 8) & 0xff;
    const b = colour & 0xff;
    for (let k = 0; k < 4; k++) {
      normals[p + k * 3] = nx;
      normals[p + k * 3 + 1] = ny;
      normals[p + k * 3 + 2] = nz;
      colors[p + k * 3] = r;
      colors[p + k * 3 + 1] = g;
      colors[p + k * 3 + 2] = b;
      chunkIds[v + k] = chunk;
    }
    indices[i] = v; indices[i + 1] = v + 1; indices[i + 2] = v + 2;
    indices[i + 3] = v; indices[i + 4] = v + 2; indices[i + 5] = v + 3;
    v += 4;
    i += 6;
  };

  // Ground first, tagged never-suppressed and pushed below y=0 so a resident
  // chunk's own road always wins the depth test.
  const groundY = -IMPOSTOR_GROUND_DEPTH;
  quad(
    WORLD_MIN, groundY, WORLD_MAX,
    WORLD_MAX, groundY, WORLD_MAX,
    WORLD_MAX, groundY, WORLD_MIN,
    WORLD_MIN, groundY, WORLD_MIN,
    0, 1, 0,
    IMPOSTOR_GROUND_COLOUR,
    IMPOSTOR_ALWAYS_VISIBLE
  );

  for (const box of boxes) {
    const midX = (box.minX + box.maxX) * 0.5;
    const midZ = (box.minZ + box.maxZ) * 0.5;
    const halfX = (box.maxX - box.minX) * 0.5 * IMPOSTOR_PLAN_SCALE;
    const halfZ = (box.maxZ - box.minZ) * 0.5 * IMPOSTOR_PLAN_SCALE;
    const x0 = midX - halfX;
    const x1 = midX + halfX;
    const z0 = midZ - halfZ;
    const z1 = midZ + halfZ;
    const y1 = box.height * IMPOSTOR_HEIGHT_SCALE;
    if (y1 > maxY) maxY = y1;
    const side = box.facade;
    const c = box.chunk;
    quad(x1, 0, z1, x1, 0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, side, c);
    quad(x0, 0, z0, x0, 0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, side, c);
    quad(x0, 0, z1, x1, 0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, side, c);
    quad(x1, 0, z0, x0, 0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, side, c);
    quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, box.roof, c);
  }

  // The mesh is the world. Its bounding sphere is the world's, and the mesh is
  // never frustum-culled anyway — it IS the horizon.
  const centreY = (groundY + maxY) * 0.5;
  const halfWorld = (WORLD_MAX - WORLD_MIN) * 0.5;
  const radius = Math.sqrt(2 * halfWorld * halfWorld + (maxY - centreY) * (maxY - centreY));

  const buffers = {
    positions,
    normals,
    colors,
    indices,
    vertexCount,
    indexCount,
    boundingSphere: [(WORLD_MIN + WORLD_MAX) * 0.5, centreY, (WORLD_MIN + WORLD_MAX) * 0.5, radius] as const,
  };

  return {
    result: {
      kind: 'impostor',
      id: 0,
      seed: plan.worldSeed,
      buffers,
      chunkIds,
      buildingCount: boxes.length,
      generationTimeMs: performance.now() - started,
      bytes:
        positions.byteLength +
        normals.byteLength +
        colors.byteLength +
        indices.byteLength +
        chunkIds.byteLength,
      contentHash: hashGeometry(buffers),
    },
    heightsByChunk,
  };
}

/**
 * Landmark exclusion circles a chunk's procedural fill must respect.
 *
 * Copied in shape from `generateChunk`, because a lot suppressed there and not
 * here would leave a silhouette standing inside the Hero Association building.
 */
function exclusionsForChunk(
  index: ICityPlanIndex,
  cx: number,
  cz: number
): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const landmark of index.plan.landmarks) {
    const dx = landmark.position[0] - (cx + 0.5) * CHUNK_SIZE;
    const dz = landmark.position[1] - (cz + 0.5) * CHUNK_SIZE;
    if (Math.hypot(dx, dz) < CHUNK_SIZE + landmark.exclusionRadius) {
      out.push([landmark.position[0], landmark.position[1], landmark.exclusionRadius]);
    }
  }
  return out;
}

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

  /** Owns the residency texture the impostor's vertex shader reads. */
  private readonly streamingMaterials: StreamingMaterials;
  /** The whole far city, in one mesh, one material, one draw call. */
  private readonly impostorRing: ImpostorRing;
  private readonly impostorHeights: ReadonlyMap<number, readonly (readonly number[])[]>;

  private residentRadius: number;
  private focusChunkX = 0;
  private focusChunkZ = 0;
  private focusValid = false;

  /** Buildings the 16-slot budget could not address. Surfaced, never aliased. */
  unaddressableBuildings = 0;
  /**
   * Buildings whose real height did not match the silhouette baked for them.
   *
   * Always zero on a healthy build. Non-zero means `readBuildRng` has fallen out
   * of step with `makeRecipe` and the far city is quietly a different city from
   * the near one — see the header on `bakeSkyline`.
   */
  impostorDrift = 0;
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

    // ── The distant skyline ───────────────────────────────────────────────
    // Baked HERE, in the constructor, and not behind a flag: a city whose
    // horizon appears a second after the first frame is worse than one that
    // never had it, and the whole bake is ~50 ms of arithmetic against a 6 s
    // boot budget. It also means the world looks COMPLETE from frame one, while
    // `buildImmediate(BOOT_RADIUS)` has only raised the chunk under the
    // player's feet and the other eight are still arriving one per 0.4 s.
    //
    // Main thread rather than a worker. The worker path in
    // `src/world/streaming` bakes its own placeholder city (see `bakeSkyline`),
    // and moving THIS bake off-thread means shipping the plan JSON and the
    // whole of `@/world/city` into the worker bundle for 50 ms — a bad trade
    // that this file is not the place to make.
    const bake = bakeSkyline(options.generator.index);
    this.impostorHeights = bake.heightsByChunk;
    this.streamingMaterials = new StreamingMaterials({
      // The city's own material library owns every OTHER material in the
      // world, but not this one: the impostor has no maps, no UVs and one
      // vertex attribute nothing else declares. A Lambert is the right amount
      // of shading for a silhouette a quarter of a kilometre away, and it is
      // one program.
      impostorMaterial: new THREE.MeshLambertMaterial({
        vertexColors: true,
        // Stands in for the façade albedo maps the resident city samples and
        // the impostor does not. See `IMPOSTOR_ALBEDO`.
        color: new THREE.Color(IMPOSTOR_ALBEDO, IMPOSTOR_ALBEDO, IMPOSTOR_ALBEDO),
        side: THREE.FrontSide,
      }),
    });
    this.streamingMaterials.impostor.name = 'city.impostor';
    this.impostorRing = new ImpostorRing(this.streamingMaterials);
    this.impostorRing.apply(bake.result);
    this.impostorRing.attach(this.scene);
    // Cascade-aware, like every other lit material in the scene. An
    // unregistered one accumulates all three cascade lights instead of one and
    // renders three times too bright — see `registerMaterials` above.
    this.registerMaterials?.(this.impostorRing.root);

    const stats = this.impostorRing.getStats();
    log.info(
      `impostor ring: ${stats.buildings} buildings ${stats.triangles} tris ` +
        `${(stats.bytes / 1024).toFixed(0)} KB, bake ${stats.generationTimeMs.toFixed(0)}ms ` +
        `upload ${stats.uploadTimeMs.toFixed(1)}ms`
    );
  }

  get residentCount(): number {
    return this.resident.size;
  }

  /** The distant skyline. One draw call, for verification and the debug HUD. */
  get impostor(): ImpostorRing {
    return this.impostorRing;
  }

  /** Bake and upload cost of the skyline. A BOOT cost, never a frame cost. */
  get impostorStats(): IImpostorStats {
    return this.impostorRing.getStats();
  }

  /**
   * Show or hide the distant skyline.
   *
   * Diagnostics only — it exists so a harness can measure the draw call the
   * ring adds by taking `renderer.info.render.calls` on either side of it.
   */
  setImpostorVisible(visible: boolean): void {
    this.impostorRing.root.visible = visible;
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

    // ══════════════════════════════════════════════════════════════════════
    //  THE CHUNK IS REAL NOW — STOP DRAWING ITS SILHOUETTE
    // ══════════════════════════════════════════════════════════════════════
    // Set in the same statement sequence that adds the group to the scene, so
    // there is never a frame in which both the impostor and the real chunk are
    // drawn. Two overlapping copies of the same block is doubled geometry and,
    // at 94% scale, a shimmering rim of z-fighting along every façade.
    this.streamingMaterials.setResident(index, true);
    this.checkImpostorDrift(index, build);

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

  /**
   * Prove the silhouette matched the building it stood for.
   *
   * The only moment the two representations of a chunk both exist is the moment
   * one replaces the other, which makes this the only place the impostor can be
   * checked against ground truth for free — the real geometry has just been
   * generated and the silhouette is already in memory.
   *
   * Compared per plan block and per building, in emission order. `build.blocks`
   * is plan blocks first and landmark blocks after, and within a block the
   * perimeter lots come before the courtyard fill, so the leading `heights`
   * entries line up with the leading buildings by construction.
   */
  private checkImpostorDrift(index: number, build: ICityChunkBuild): void {
    const perBlock = this.impostorHeights.get(index);
    if (perBlock === undefined) return;
    let drifted = 0;
    for (let b = 0; b < perBlock.length && b < build.blocks.length; b++) {
      const heights = perBlock[b]!;
      const buildings = build.blocks[b]!.buildings;
      for (let k = 0; k < heights.length; k++) {
        const real = buildings[k];
        // A silhouette with no building behind it is drift too: it means the
        // density or exclusion tests disagreed, not just the height roll.
        if (real === undefined || Math.abs(real.height - heights[k]!) > 1e-3) drifted++;
      }
    }
    if (drifted === 0) return;
    this.impostorDrift += drifted;
    log.warn(
      `impostor drift: ${drifted} of chunk ${index}'s silhouettes do not match the ` +
        `buildings generated for it — readBuildRng is out of step with makeRecipe`
    );
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
    // The silhouette takes over again the instant the real geometry leaves, so
    // an evicted chunk becomes distant city rather than a hole in the horizon.
    this.streamingMaterials.setResident(index, false);

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
    this.impostorRing.detach(this.scene);
    this.impostorRing.dispose();
    this.streamingMaterials.dispose();
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
