/**
 * WORLD STREAMING BARREL
 *
 *   import { StreamingSystem, ChunkDamageState } from '@/world/streaming';
 *
 * Everything this workstream owns:
 *
 *   streaming-system.ts  the budgeted update loop, priority, eviction, events
 *   chunk.ts             one `IChunk`: the upload, and nothing but the upload
 *   worker-pool.ts       two workers, bounded in flight, cancellable
 *   chunk-worker.ts      the worker entry and the generator registry
 *   chunk-geometry.ts    ring-specific geometry emission (no `three`)
 *   chunk-layout.ts      the deterministic block/lot/building layout
 *   priority-queue.ts    (ring, angle, distance) min-heap, re-scored per frame
 *   lod-rings.ts         hysteretic ring assignment
 *   damage-state.ts      the 8 KB persistent destruction bitmask
 *   impostor-ring.ts     one pre-baked mesh for the whole far city
 *   materials.ts         the two shared materials and the residency texture
 *
 * Other systems consume this through `IStreamingSystem` from `@/types` and the
 * `ChunkStreamedIn` / `ChunkStreamedOut` events on the bus. The concrete
 * exports here exist for the bootstrap that wires the game together and for the
 * verification harness.
 *
 * NOTE ON IMPORTS: `chunk-geometry`, `chunk-layout`, `priority-queue`,
 * `lod-rings`, `damage-state` and `protocol` depend on nothing but `@/util` and
 * `@/spatial/constants`, which is what makes them usable inside a worker.
 * Importing THIS barrel pulls in `three` through the scene-side modules, so
 * worker code must import those files directly.
 */

export {
  StreamingSystem,
  chunkIndexForPosition,
  coordForChunkIndex,
  type IStreamingSystemOptions,
  type IStreamingDetailedStats,
  type IColliderSink,
  type ICrowdSink,
  type GpuUploadHook,
} from './streaming-system';

export { StreamedChunk, type IChunkHost } from './chunk';

export { ImpostorRing, type IImpostorStats } from './impostor-ring';

export {
  StreamingMaterials,
  IMPOSTOR_ALWAYS_VISIBLE,
  type IStreamingMaterialOptions,
} from './materials';

export {
  ChunkDamageState,
  damageSlot,
  DAMAGE_TOTAL_BYTES,
  type IDamageStats,
} from './damage-state';

export {
  ChunkPriorityQueue,
  scoreChunk,
  chunkDistanceUnits,
  type IQueuedChunk,
  type IPriorityView,
} from './priority-queue';

export {
  RingAssigner,
  ringForDistance,
  ringWithHysteresis,
  residentRadiusFor,
  shouldEvict,
  shouldLoad,
} from './lod-rings';

export {
  ChunkWorkerPool,
  type IWorkerPoolOptions,
  type IWorkerPoolStats,
} from './worker-pool';

export {
  DEFAULT_GENERATOR,
  handleRequest,
  registerChunkGenerator,
  responseTransferables,
  type ChunkGeneratorFn,
  type ImpostorGeneratorFn,
} from './chunk-worker';

export {
  buildChunkGeometry,
  buildImpostorGeometry,
  hashGeometry,
  type ChunkBuildOutput,
  type ImpostorBuildOutput,
} from './chunk-geometry';

export {
  layoutChunk,
  fracturePieces,
  districtFor,
  DISTRICT_NAMES,
  DISTRICT_DOWNTOWN,
  DISTRICT_RESIDENTIAL,
  DISTRICT_INDUSTRIAL,
  DISTRICT_PARK,
  DISTRICT_WATERFRONT,
  type IChunkLayout,
  type IBuildingLayout,
  type IPropLayout,
  type ISpawnLayout,
  type IFracturePiece,
} from './chunk-layout';

export {
  geometryBytes,
  geometryTransferables,
  type IChunkJob,
  type IImpostorJob,
  type IChunkBuildResult,
  type IImpostorBuildResult,
  type IGeometryBuffers,
  type IColliderBox,
  type ICrowdSlot,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol';

export {
  STREAMING_WORKER_COUNT,
  MAX_IN_FLIGHT_JOBS,
  MAX_UPLOADS_PER_FRAME,
  MAX_UNLOADS_PER_FRAME,
  UPLOAD_BUDGET_MS,
  UNLOAD_BUDGET_MS,
  RING_COUNT,
  RING_R0,
  RING_R1,
  RING_R2,
  RING_R3,
  RING_OUTER_CHUNKS,
  RING_HYSTERESIS_CHUNKS,
  RESIDENT_RADIUS_CHUNKS_BY_TIER,
  EVICT_MARGIN_CHUNKS,
  RING_PRIORITY_STRIDE,
  ANGLE_PRIORITY_WEIGHT,
  PVS_PRIORITY_PENALTY,
  RING_CROWD_MODE,
  RING_COLLIDER_MODE,
  RING_DESTRUCTIBLE,
  STREAMING_LOD_LEVELS,
  MAX_BUILDINGS_PER_CHUNK,
  FRACTURE_PIECES_PER_BUILDING,
  DAMAGE_BITS_PER_CHUNK,
  DAMAGE_WORDS_PER_CHUNK,
  STREET_WIDTH,
  BLOCK_SIZE,
  FLOOR_HEIGHT,
  type CrowdMode,
  type ColliderMode,
} from './constants';
