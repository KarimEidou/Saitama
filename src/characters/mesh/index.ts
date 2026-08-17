/**
 * PROCEDURAL HUMANOID MESH GENERATOR
 *
 *   import { buildCharacter, buildCivilian, createCharacterParts } from
 *     '@/characters/mesh';
 *
 * Every character in this game is generated here: heroes, civilians and
 * monsters all come out of one loft-based generator driven by `BodyProfile`.
 *
 * ── THE IDEA IN ONE PARAGRAPH ─────────────────────────────────────────────
 * A body is a set of STRANDS — ordered cross-sections swept along a spline.
 * Because the loft IS the bind pose, every ring already knows its parametric
 * position along a bone chain, so its four skin weights are computed exactly
 * rather than painted. Rigging, normally the expensive half of character work,
 * falls out of the same parameter that placed the geometry. Garments reuse the
 * body's own rings, so cloth inherits correct weights for free too.
 *
 * ── WHAT IS GUARANTEED ────────────────────────────────────────────────────
 *   - Mixamo-compatible bone names (`BoneName`), 27 bones, identity rest
 *     rotations, mirrored so the character faces -Z like every other entity.
 *   - Exactly four skin influences per vertex, summing to 1, all indices in
 *     range, unused slots zero-weighted but valid.
 *   - Closed, manifold, outward-wound geometry: no holes, no non-manifold
 *     edges, positive volume per component.
 *   - Three LODs sharing ONE UV unwrap, so all three share one texture.
 *   - Deterministic: same profile and seed produce byte-identical meshes.
 *
 * All of the above is asserted in `__tests__`, not merely intended.
 */

export {
  buildHumanoid,
  buildHumanoidLODs,
  bodysuitCostume,
  casualCostume,
  resolvePalette,
  lodForDistance,
  CROWD_MORPHS,
  LOD_BUDGET,
  LOD_DISTANCES,
  LOD_SETTINGS,
  type HumanoidBuild,
  type HumanoidOptions,
  type Palette,
} from './assemble';

export {
  buildCharacter,
  buildCivilian,
  characterRecipe,
  civilianOptions,
  civilianProfile,
  showcaseBodies,
  type CharacterId,
  type CharacterRecipe,
} from './characters';

export {
  createCharacterParts,
  createSkinnedMesh,
  usedSlots,
  type CharacterParts,
} from './instance';

export {
  buildRig,
  resolveDimensions,
  restPositions,
  BONE_ORDER,
  BONE_PARENT,
  type HumanoidRig,
  type RigDimensions,
} from './rig';

export { resolveShape, type ShapeOverrides, type ShapeParams } from './shape';

export {
  analyseSkinning,
  analyseTopology,
  measureSilhouette,
  silhouetteDistance,
  type ComponentReport,
  type Silhouette,
  type SkinReport,
  type TopologyReport,
} from './analysis';

export {
  FACE_CENTER_U,
  faceOffsetU,
  faceUV,
  HEAD_LANDMARK_V,
  UV_REGIONS,
  type UVRegionName,
} from './uv';

export {
  MeshSlot,
  SLOT_NAMES,
  type GarmentSpec,
  type HairSpec,
  type HardSurfaceSpec,
  type HumanoidStats,
  type LodLevel,
  type LodSettings,
  type MeshRegionInfo,
  type MorphSpec,
  type Ring,
  type RingShape,
  type SkinWeight4,
  type Strand,
  type UVRect,
} from './types';

export type { BodyPart, Coat, PaintFn } from './body';
