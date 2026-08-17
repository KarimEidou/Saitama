/**
 * SPATIAL INDEX BARREL
 *
 *   import { SpatialIndex, buildPvs, generateSyntheticCity } from '@/spatial';
 *
 * Everything this workstream owns:
 *
 *   Quadtree            static instance AABBs over 1536 m, depth 6, 24 m leaves
 *   Frustum             plane-mask hierarchical culling primitives
 *   PvsTable / buildPvs precomputed 2D visibility, 8 KB for the whole city
 *   DynamicEntityGrid   24 m uniform grid rebuilt per frame; radius + cone
 *   GroundBVH           three-mesh-bvh wrapper for the merged ground mesh
 *   SpatialIndex        the facade that wires them together
 *
 * Importing this barrel pulls in `three` and `three-mesh-bvh` through
 * `GroundBVH`. Code that only needs the quadtree, PVS or entity grid should
 * import those modules directly — they depend on nothing but `@/util` and
 * type-only `three` declarations, which keeps them usable inside a worker.
 */

export {
  WORLD_SIZE,
  WORLD_MIN,
  WORLD_MAX,
  WORLD_DIAGONAL,
  CHUNK_SIZE,
  CHUNK_GRID,
  CHUNK_COUNT,
  CHUNK_COORD_MIN,
  CHUNK_COORD_MAX,
  QUADTREE_DEPTH,
  QUADTREE_LEAF_SIZE,
  QUADTREE_CHUNK_DEPTH,
  QUADTREE_NODE_COUNT,
  ENTITY_CELL_SIZE,
  ENTITY_GRID_DIM,
  PVS_MASK_BITS,
  PVS_MASK_WORDS,
  PVS_TOTAL_BYTES,
  PVS_DEFAULT_RAY_COUNT,
  isChunkInWorld,
  chunkIndex,
  chunkIndexAt,
  chunkIndexToX,
  chunkIndexToZ,
  chunkMinX,
  chunkMinZ,
  chunkCentreX,
  chunkCentreZ,
  chunkChebyshev,
  chunkKeyFromIndex,
  worldToChunkX,
  worldToChunkZ,
} from './constants';

export { IndexList, FloatList } from './index-list';

export {
  createAabb,
  emptyAabb,
  isAabbEmpty,
  aabbFromBox3,
  aabbToBox3,
  readAabb,
  writeAabb,
  rayBoxEntry,
  rayRectEntry2D,
  type IAabb,
} from './aabb';

export {
  Frustum,
  composeViewProjection,
  classifyCode,
  classifyMask,
  OUTSIDE,
  INTERSECTING,
  INSIDE,
  ALL_PLANES,
} from './frustum';

export {
  Quadtree,
  createCullStats,
  type IQuadtreeOptions,
  type IQuadtreeRayHit,
  type ICullStats,
  type IChunkVisibility,
} from './quadtree';

export {
  PvsTable,
  buildPvs,
  groundTruthVisible,
  type IFootprint,
  type IPvsBuildOptions,
  type IPvsStats,
} from './pvs';

export {
  DynamicEntityGrid,
  sphereInCone,
  ALL_LAYERS,
  type IEntityGridStats,
} from './entity-grid';

export {
  GroundBVH,
  createGroundHit,
  type IGroundHit,
  type IGroundBvhOptions,
} from './mesh-bvh';

export {
  SpatialIndex,
  type ISpatialIndexOptions,
  type ISpatialStats,
} from './spatial-index';

export {
  generateSyntheticCity,
  sampleStreetCameras,
  type ISyntheticCity,
  type ISyntheticCityOptions,
  type ISyntheticInstance,
  type IStreetPoint,
  type ICameraSample,
} from './synthetic-city';

export {
  measureCullRates,
  formatCullReport,
  type ICullMeasureOptions,
  type ICullRateReport,
} from './diagnostics';
