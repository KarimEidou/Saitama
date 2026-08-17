/**
 * CHARACTER ROSTER — surfaces, faces and the cast list
 *
 *   import { listRoster, bakeCharacterAtlas, createRosterMaterial } from
 *     '@/characters/roster';
 *
 * The mesh workstream builds bodies; this one decides what they are made of
 * and paints their faces. Between them a character goes from "correct
 * geometry" to "something you would recognise across a street".
 *
 * ── THE PIPELINE, END TO END ──────────────────────────────────────────────
 *   1. `listRoster()`            the cast, as data: recipe + colour table +
 *                                surface classes + face.
 *   2. `prepareRosterGeometry()` re-fits any island the generator left
 *                                straddling the atlas (the cape) so ONE
 *                                texture can serve the whole character.
 *   3. `bakeCharacterAtlas()`    rasterises the mesh in UV space and resolves
 *                                albedo / ORM / normal / emissive per texel,
 *                                mixing CC0 detail maps with synthesised
 *                                weave, wear and ray-traced occlusion.
 *   4. `createRosterMaterial()`  binds those maps to ONE `MeshStandardMaterial`
 *                                with three optional shader injections: face
 *                                expressions, crowd tinting, proximity dither.
 *
 * ── WHAT IS GUARANTEED ────────────────────────────────────────────────────
 *   - One draw call per character. Metalness varies per texel, so metal is
 *     metal and cotton is cotton inside a single material.
 *   - Every character has a face at the exact landmarks the mesh published,
 *     in four expressions selectable by a uniform.
 *   - Zero third-party character assets: every mesh is generated, every
 *     texture is either synthesised here or CC0 with a recorded author.
 *   - Deterministic: same seed, byte-identical atlases.
 */

export { ATLAS_SIZE, bakeCharacterAtlas } from './atlas';

export {
  CLASS_MATCH_EPSILON,
  auditColors,
  buildClassifier,
  classifyTriangles,
  type ClassifyAudit,
  type ColorClassifier,
} from './classify';

export {
  CROWD_ATTRIBUTES,
  attachCrowdAttributes,
  attachSoloCrowdColors,
  buildCrowdAttributes,
  crowdColors,
  distinctCrowdPalettes,
  type CrowdAttributes,
  type CrowdColors,
} from './crowd';

export {
  FACE_TILE_WIDTH,
  baseFace,
  expressionForBoredom,
  faceGlows,
  faceRegion,
  faceSvg,
  type FaceLayer,
  type FaceRegion,
} from './face';

export {
  findPaintCollisions,
  headLandmarkV,
  measureHead,
  prepareRosterGeometry,
  rectContaining,
  type AtlasPlan,
  type HeadMetrics,
  type PreparedGeometry,
  type RegionMove,
} from './geometry';

export {
  characterDir,
  entryAssetIds,
  entryExpressions,
  entryGlows,
  mapAssetId,
  mapFileName,
  materialAssetId,
  materialSpecFor,
  type CharacterMapRole,
} from './manifest';

export {
  REQUIRED_MAPS,
  auditMaterial,
  createRosterMaterial,
  getExpression,
  getProximityFade,
  proximityFadeAmount,
  setExpression,
  setProximityFade,
  type MaterialAudit,
  type RosterMaterial,
  type RosterMaterialOptions,
  type RosterTextures,
  type RosterUniforms,
} from './materials';

export { THREAT_TIERS, mookEntry, monsterRecipe, namedMonsters, tierMooks } from './monsters';

export {
  RosterRuntime,
  type IBakedAssetSource,
  type IRosterBody,
  type IRosterRuntimeOptions,
} from './runtime';

export {
  CROWD_SEED,
  buildRosterMesh,
  civilianEntry,
  entryClasses,
  entryColorObjects,
  heroEntries,
  heroMeshIds,
  listRoster,
  paletteColors,
  rosterEntry,
  rosterIds,
} from './roster';

export {
  DEFAULT_SURFACES,
  detailMaterialIds,
  resolveSurfaces,
  usedDetailMaterialIds,
} from './surfaces';

export {
  EXPRESSIONS,
  SURFACE_CLASSES,
  TINT_MASK_LEVEL,
  type AtlasBakeOptions,
  type AtlasMaps,
  type BrowShape,
  type ClassColor,
  type DetailSpec,
  type DetailTile,
  type Expression,
  type EyeShape,
  type FacePatch,
  type FaceRect,
  type FaceStyle,
  type MicroPattern,
  type MouthShape,
  type OcclusionSampler,
  type RosterEntry,
  type RosterKind,
  type SurfaceClass,
  type SurfaceStyle,
  type SurfaceOverrides,
  type SurfaceStyleSet,
  type SurfaceStyleOverride,
  type TintSlot,
} from './types';
