/**
 * CITY GENERATION — PUBLIC SURFACE
 *
 *   import { CityGenerator, buildChunkNodes } from '@/world/city';
 *
 * Streaming calls `CityGenerator.generate(cx, cz)` — off the main thread if it
 * wants to; nothing above `runtime.ts` touches Three.js — and hands the result
 * to `buildChunkNodes` to get scene nodes.
 *
 * The authoring module (`authoring/author-plan.ts`) is deliberately NOT
 * exported: it imports `node:fs` and exists only to regenerate the committed
 * plan JSON.
 */

export { CityGenerator, detailForDistance, reportDrawCalls, DETAIL_BANDS } from './city';
export type { ICityOptions, IDrawCallReport } from './city';

export { generateChunk, transferables } from './chunk';
export type { ICityChunkBuild, IChunkGenOptions } from './chunk';

export { generateBlock, subdivideBlock } from './block';
export type {
  IBlockBuild,
  IBlockGenOptions,
  IBlockSpawn,
  IBuildingSummary,
  ILot,
} from './block';

export { generateBuilding, PANEL_WIDTH } from './building';
export type { BuildingDetail, IBuildingBuild, IBuildingRecipe } from './building';

export { generateGround, mergeChunkGrounds, GROUND_SLOT_COUNT, KERB_HEIGHT, GroundSlot } from './ground';
export type { IGroundBuild, IGroundContext, IGroundMaterials } from './ground';

export { generateLandmark } from './landmarks';
export type { ILandmarkBuild } from './landmarks';

export {
  COLLAPSE_SUPPORT_RATIO,
  QUADRANTS,
  STRUCTURE_DENSITY,
  collapsingFloors,
  materialiseFractureChunk,
  neighboursOf,
  quadrantOf,
  rebaseLayout,
  remainingSupport,
  verifyPartition,
} from './fracture';
export type {
  IBuildingFractureChunk,
  IFloorSupport,
  IFractureLayout,
  IFractureSlotRange,
  IPartitionReport,
} from './fracture';

export {
  MAT_SLOT_COUNT,
  MatSlot,
  MeshBuilder,
  mergeGeometries,
} from './mesh-builder';
export type {
  AABB6,
  IGeometryBuffers,
  IMaterialGroup,
  IMergedGeometry,
  IPlacement,
} from './mesh-builder';

export {
  CITY_MATERIALS,
  MATERIAL_TILE_SIZE,
  allCityMaterialKeys,
  shadeTint,
  tintToRgb,
  uvScaleFor,
  verifyMaterialTable,
} from './materials';
export type { IBlockMaterialSet } from './materials';

export { PANEL_KINDS, emitPanel, panelSupport } from './facade';
export type { FacadeDetail, IFacadeAttachment, IPanelContext, PanelKind } from './facade';

export { PROP_ASSETS, allPropAssetKeys, batchProps, pickProp, propDestructible, propRadius } from './props';
export type { IRawPlacement } from './props';

export { blockSeed, indexPlan, landmarkSeed, loadPlan, validatePlan } from './plan';
export type { ICityPlanIndex } from './plan';

export type {
  ICityPlan,
  IPlanBlock,
  IPlanCrater,
  IPlanIntersection,
  IPlanLandmark,
  IPlanProp,
  IPlanRoad,
  IPlanZone,
  IPlanZoneParams,
  LandmarkKind,
  RoadMarkings,
  RoadSurface,
  ZoneKind,
} from './plan-types';

export {
  buildBlockMesh,
  buildChunkNodes,
  buildGroundMesh,
  chunkBounds,
  createRegistryResolver,
  destroyFractureChunk,
  extractDebrisGeometry,
  installDestructionHook,
  repairBlock,
  toBufferGeometry,
  toChunkPayload,
} from './runtime';
export type { IBlockMesh, IChunkNodes, MaterialResolver } from './runtime';

export {
  chamferPolygon,
  circlePolygon,
  ensureCCW,
  offsetPolygon,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  polygonCentroid,
  polygonPerimeter,
  rectPolygon,
  resampleSpline,
  triangulate,
} from './polygon';
export type { IRect2, Polygon, Vec2 } from './polygon';
