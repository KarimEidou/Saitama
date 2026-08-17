/**
 * WORLD / STREAMING / CITY INTERFACE CONTRACT
 *
 * Owned by: world-streaming and city-generation workstreams.
 * Consumed by: renderer, entity spawning, gameplay, verification.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * COORDINATE CONVENTION (binding for all workstreams):
 *   - Right-handed, Y-up. +X east, +Z south, -Z north.
 *   - 1 world unit == 1 metre.
 *   - Ground plane sits at y = 0; buildings extrude towards +Y.
 */

import type * as THREE from 'three';
import type { IDisposable, IUpdatable, IQualityTier } from './engine';
import type { FractureChunk } from './destruction';

/* -------------------------------------------------------------------------- */
/* Chunk addressing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Integer chunk address on the XZ plane. World position of a chunk origin is
 * `(x * chunkSize, 0, z * chunkSize)`.
 */
export interface IChunkCoord {
  readonly x: number;
  readonly z: number;
}

/** Canonical string form of a chunk coord, e.g. "12,-4". Use for map keys. */
export type ChunkKey = string;

/** Axis-aligned world-space bounds. */
export interface IWorldBounds {
  readonly min: THREE.Vector3;
  readonly max: THREE.Vector3;
}

/** Lifecycle of a streamed chunk. Transitions are strictly monotonic per load. */
export type ChunkState =
  /** Known to exist, nothing allocated. */
  | 'unloaded'
  /** Async generation/fetch in flight. */
  | 'loading'
  /** Geometry built, not yet added to the scene. */
  | 'ready'
  /** In the scene graph and rendering. */
  | 'active'
  /** Being torn down; resources releasing. */
  | 'unloading'
  /** Load failed; see `IChunk.error`. */
  | 'error';

/* -------------------------------------------------------------------------- */
/* Chunks                                                                     */
/* -------------------------------------------------------------------------- */

/** One streamed tile of the open world. */
export interface IChunk extends IDisposable {
  /** Integer address. */
  readonly coord: IChunkCoord;
  /** `${coord.x},${coord.z}` — stable map key. */
  readonly key: ChunkKey;
  /** World-space AABB covering all content in this chunk. */
  readonly bounds: IWorldBounds;
  /** Current lifecycle state. */
  state: ChunkState;
  /** Scene node holding every object in this chunk. Added/removed as a unit. */
  readonly root: THREE.Group;
  /** Active LOD band index into `IWorldConfig.lodLevels`. */
  lodIndex: number;
  /** Distance in metres from the streaming focus to the chunk centre. */
  distanceToFocus: number;
  /** City blocks contained in this chunk (undefined for non-urban chunks). */
  blocks?: ICityBlock[];
  /** Populated when `state === 'error'`. */
  error?: string;
  /** Monotonic frame index of the last time this chunk was visible. */
  lastSeenFrame: number;
  /** Approximate GPU bytes held, for budget accounting. */
  readonly memoryBytes: number;

  /** Build content. Resolves when `state` becomes 'ready'. */
  load(signal?: AbortSignal): Promise<void>;
  /** Attach `root` to the scene. */
  activate(scene: THREE.Scene): void;
  /** Detach from the scene but keep resources for fast re-activation. */
  deactivate(scene: THREE.Scene): void;
  /** Switch LOD band. Cheap; called every frame as distance changes. */
  setLOD(lodIndex: number): void;
}

/* -------------------------------------------------------------------------- */
/* Level of detail                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A render LOD band, selected by distance from the camera.
 * (Distinct from `IAssetLOD` in assets.ts, which describes a decimated mesh
 * variant produced by the asset pipeline.)
 */
export interface ILODLevel {
  /** Band index; 0 is highest detail. */
  readonly index: number;
  /** Band applies while distance >= this value, in metres. */
  readonly minDistance: number;
  /** Band applies while distance < this value. Use Infinity for the last. */
  readonly maxDistance: number;
  /** Fraction of source triangles retained (0..1). */
  readonly meshDetail: number;
  /** Whether props/street furniture are spawned in this band. */
  readonly includeProps: boolean;
  /** Whether interiors/detail meshes are spawned. */
  readonly includeInteriors: boolean;
  /** Whether objects in this band may cast shadows. */
  readonly castShadows: boolean;
  /** Texture mip bias; positive values force blurrier mips to save bandwidth. */
  readonly textureBias: number;
  /** Collapse the whole chunk into a single merged/instanced draw. */
  readonly useImpostors: boolean;
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                  */
/* -------------------------------------------------------------------------- */

/** Chunk streaming manager. Exactly one instance owns all chunk lifetimes. */
export interface IStreamingSystem extends IUpdatable, IDisposable {
  /** Immutable world configuration. */
  readonly config: IWorldConfig;
  /** Chunks currently in any state other than 'unloaded'. */
  readonly loadedChunks: ReadonlyMap<ChunkKey, IChunk>;
  /** Point streaming is centred on — normally the player position. */
  focus: THREE.Vector3;

  /** Convert a world position to the chunk containing it. */
  worldToChunk(position: THREE.Vector3): IChunkCoord;
  /** World-space centre of a chunk. */
  chunkToWorld(coord: IChunkCoord): THREE.Vector3;
  /** Canonical map key for a coord. */
  chunkKey(coord: IChunkCoord): ChunkKey;
  /** Look up a live chunk, if resident. */
  getChunk(coord: IChunkCoord): IChunk | undefined;

  /** Force a chunk to load immediately, bypassing the distance heuristic. */
  requestChunk(coord: IChunkCoord, priority?: number): Promise<IChunk>;
  /** Hint that a chunk may be needed soon (e.g. player heading). */
  prefetch(coord: IChunkCoord): void;
  /** Drop a chunk regardless of distance. */
  evictChunk(coord: IChunkCoord): void;
  /** Block until every in-flight load settles. Used by tests and fast-travel. */
  waitForIdle(): Promise<void>;
  /** Re-evaluate budgets after a quality-tier change. */
  applyQuality(tier: IQualityTier): void;
  /** Snapshot for the debug HUD and automated verification. */
  getStats(): IStreamingStats;
}

/** Streaming telemetry. */
export interface IStreamingStats {
  activeChunks: number;
  loadingChunks: number;
  pooledChunks: number;
  totalMemoryBytes: number;
  loadsThisSecond: number;
  evictionsThisSecond: number;
  /** Milliseconds spent generating chunks in the last frame. */
  generationTimeMs: number;
}

/* -------------------------------------------------------------------------- */
/* City generation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Architectural style. Drives material palette and silhouette rules.
 * Z-City / A-City style districts from the source material.
 */
export type BuildingStyle =
  | 'residential'
  | 'commercial'
  | 'skyscraper'
  | 'industrial'
  | 'shophouse'
  | 'apartment'
  | 'civic'
  | 'ruins';

/** Procedural recipe for a single building. */
export interface IBuildingSpec {
  /** Stable id, unique within its block. */
  readonly id: string;
  /**
   * Ground-plane outline in LOCAL metres, counter-clockwise winding, relative
   * to the building origin. Usually 4 points, but arbitrary convex polygons
   * are permitted.
   */
  readonly footprint: readonly THREE.Vector2[];
  /** Storey count. Height is `floors * floorHeight`. */
  readonly floors: number;
  /** Metres per storey. Typically 3.0–4.5. */
  readonly floorHeight: number;
  /** Architectural style. */
  readonly style: BuildingStyle;
  /**
   * Key into `IAssetRegistry` for the façade material.
   * MUST match an `IMaterialAsset.id` in the asset manifest.
   */
  readonly materialKey: string;
  /** Optional distinct material for the roof. */
  readonly roofMaterialKey?: string;
  /** World-space position of the footprint origin. */
  readonly position: THREE.Vector3;
  /** Rotation about Y in radians. */
  readonly rotationY: number;
  /** Deterministic seed for façade detail (windows, signage). */
  readonly seed: number;
  /** Whether this building participates in destruction (Task: combat/destruction). */
  readonly destructible: boolean;
  /** Structural integrity budget; higher survives more punches. */
  readonly integrity: number;
}

/** Road/street classification. Drives width and traffic density. */
export type RoadClass = 'alley' | 'street' | 'avenue' | 'highway';

/** A road segment bounding city blocks. */
export interface IRoadSegment {
  readonly id: string;
  readonly start: THREE.Vector3;
  readonly end: THREE.Vector3;
  readonly width: number;
  readonly roadClass: RoadClass;
  /** Whether pedestrian sidewalks are generated alongside. */
  readonly hasSidewalk: boolean;
}

/** A city block: the parcel bounded by roads, containing buildings and props. */
export interface ICityBlock {
  readonly id: string;
  /** Chunk this block belongs to. */
  readonly chunk: IChunkCoord;
  /** Block outline in world space, counter-clockwise. */
  readonly outline: readonly THREE.Vector2[];
  /** World AABB. */
  readonly bounds: IWorldBounds;
  /** Buildings placed in this block. */
  readonly buildings: readonly IBuildingSpec[];
  /** Roads bounding this block. */
  readonly roads: readonly IRoadSegment[];
  /** Prop placements (streetlights, benches, signage, vehicles). */
  readonly props: readonly IPropPlacement[];
  /** District classification, drives NPC and monster spawn tables. */
  readonly district: DistrictType;
  /** Deterministic seed used to generate this block. */
  readonly seed: number;
  /** Points where NPCs/monsters may be spawned. */
  readonly spawnPoints: readonly ISpawnPoint[];
}

/** District classification, mirroring the source material's city zones. */
export type DistrictType =
  | 'downtown'
  | 'residential'
  | 'industrial'
  | 'park'
  | 'waterfront'
  | 'wasteland'
  | 'heroAssociation';

/** A single prop instance. Props are usually GPU-instanced by materialKey. */
export interface IPropPlacement {
  /** Key into `IAssetRegistry` — must match an `IModelAsset.id`. */
  readonly assetKey: string;
  readonly position: THREE.Vector3;
  readonly rotationY: number;
  readonly scale: number;
  /** Whether this prop can be destroyed/knocked over. */
  readonly destructible: boolean;
}

/** A location where an actor may be spawned. */
export interface ISpawnPoint {
  readonly position: THREE.Vector3;
  readonly rotationY: number;
  /** What may spawn here. */
  readonly kind: 'npc' | 'monster' | 'hero' | 'player' | 'vehicle';
  /** Optional tag constraining the spawn table, e.g. 'dragon-tier'. */
  readonly tag?: string;
}

/* -------------------------------------------------------------------------- */
/* World configuration                                                        */
/* -------------------------------------------------------------------------- */

/** Immutable top-level world parameters. Set once at boot. */
export interface IWorldConfig {
  /** Master seed. Identical seeds MUST yield an identical world. */
  readonly seed: number;
  /** Edge length of one chunk in metres. */
  readonly chunkSize: number;
  /**
   * World extent in chunks from origin along each axis. The playable area is
   * `(2 * worldRadiusChunks + 1)^2` chunks.
   */
  readonly worldRadiusChunks: number;
  /** LOD bands, ordered by ascending distance. Index 0 is highest detail. */
  readonly lodLevels: readonly ILODLevel[];
  /** Chunks kept resident around the focus point (Chebyshev radius). */
  readonly streamingRadiusChunks: number;
  /** Radius at which chunks are evicted. Must exceed streamingRadiusChunks. */
  readonly evictionRadiusChunks: number;
  /** Max chunk loads permitted per frame; guards frame-time spikes. */
  readonly maxConcurrentLoads: number;
  /** Soft GPU memory ceiling for resident chunks, in bytes. */
  readonly memoryBudgetBytes: number;
  /** Ground plane Y coordinate. */
  readonly groundLevel: number;
  /** Gravity in m/s^2, negative is down. */
  readonly gravity: number;
}

/* -------------------------------------------------------------------------- */
/* District planning                                                          */
/* -------------------------------------------------------------------------- */

/**
 * High-level layout plan for a district, produced BEFORE any chunk geometry
 * exists.
 *
 * Planning is deliberately separated from generation: the planner runs over
 * the whole world from the master seed and decides where downtown, the
 * waterfront and the wasteland go, so districts stay coherent across chunk
 * boundaries. Chunk generation then only ever consults the plan — it never
 * makes global decisions locally, which is what stops a skyscraper appearing
 * one chunk away from farmland.
 */
export interface DistrictPlan {
  readonly id: string;
  readonly district: DistrictType;
  /** District centre in world space. */
  readonly centre: THREE.Vector2;
  /** Approximate radius in metres. */
  readonly radius: number;
  /** Chunks this district covers. */
  readonly chunks: readonly IChunkCoord[];
  /** Building styles permitted here, with relative weights. */
  readonly styleWeights: Readonly<Partial<Record<BuildingStyle, number>>>;
  /** Storey-count range for buildings, as [min, max]. */
  readonly floorRange: readonly [number, number];
  /** 0..1 fraction of block area covered by buildings. */
  readonly density: number;
  /** Road classes generated within this district. */
  readonly roadClasses: readonly RoadClass[];
  /** Ambient NPC population multiplier; 1.0 is baseline. */
  readonly populationDensity: number;
  /** Monster spawn-rate multiplier. */
  readonly threatDensity: number;
  /** Deterministic seed derived from the master seed and district id. */
  readonly seed: number;
  /** Named landmarks anchored in this district. */
  readonly landmarks?: readonly ILandmark[];
}

/** A hand-authored or specially generated point of interest. */
export interface ILandmark {
  readonly id: string;
  readonly name: string;
  readonly position: THREE.Vector3;
  /** Asset key of a bespoke model, when the landmark is not procedural. */
  readonly assetKey?: string;
  /** Radius in metres within which procedural generation is suppressed. */
  readonly exclusionRadius: number;
  readonly kind: 'heroAssociationHQ' | 'monument' | 'stadium' | 'crater' | 'shelter' | 'custom';
}

/* -------------------------------------------------------------------------- */
/* Chunk payload                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The serialisable result of generating one chunk.
 *
 * Kept free of live `THREE.Object3D`s on purpose so generation can run inside
 * a Web Worker and the payload can be structured-cloned (or transferred) back
 * to the main thread, which then builds the scene nodes. Typed arrays here are
 * transferable — list them in the worker's transfer array to avoid a copy.
 */
export interface ChunkPayload {
  readonly coord: IChunkCoord;
  readonly key: ChunkKey;
  /** Seed used, so generation can be reproduced exactly. */
  readonly seed: number;
  /** Blocks laid out in this chunk. */
  readonly blocks: readonly ICityBlock[];
  /** Merged terrain/ground geometry as raw attribute buffers. */
  readonly terrain?: {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly uvs: Float32Array;
    readonly indices: Uint32Array;
  };
  /**
   * Instanced prop batches: one entry per (assetKey, LOD) pair, with a packed
   * 4x4 matrix buffer. Far cheaper than one Object3D per prop.
   */
  readonly instances: readonly IInstanceBatch[];
  /** Navigation geometry for this chunk, when generated. */
  readonly navGeometry?: {
    readonly positions: Float32Array;
    readonly indices: Uint32Array;
  };
  /**
   * Pre-computed fracture data for destructible structures in this chunk,
   * keyed by destructible id.
   */
  readonly fractures?: Readonly<Record<string, readonly FractureChunk[]>>;
  /** Spawn points aggregated from all blocks. */
  readonly spawnPoints: readonly ISpawnPoint[];
  /** Milliseconds the generator spent producing this payload. */
  readonly generationTimeMs: number;
  /** Approximate bytes, for the streaming memory budget. */
  readonly estimatedBytes: number;
}

/** A batch of GPU-instanced props sharing one asset and LOD. */
export interface IInstanceBatch {
  /** Must match an `IModelAsset.id`. */
  readonly assetKey: string;
  /** LOD index this batch renders at. */
  readonly lod: number;
  /** Packed column-major 4x4 matrices, 16 floats per instance. */
  readonly matrices: Float32Array;
  /** Instance count; `matrices.length === count * 16`. */
  readonly count: number;
  /** Optional per-instance tint, 3 floats per instance. */
  readonly colors?: Float32Array;
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                */
/* -------------------------------------------------------------------------- */

/** Named weather states affecting lighting, particles and audio. */
export type WeatherKind = 'clear' | 'overcast' | 'rain' | 'storm' | 'fog' | 'ash';

/** Queryable environment state, driven by the day/night system. */
export interface IEnvironmentState {
  /** Current weather. */
  weather: WeatherKind;
  /** 0..1 blend into the current weather. */
  weatherIntensity: number;
  /** Wind direction (unit, XZ) and strength in m/s. */
  wind: { direction: THREE.Vector2; speed: number };
  /** Fog density in 1/metres. */
  fogDensity: number;
}
