/**
 * CITY PLAN SCHEMA
 *
 * The shape of `assets/district/cityz.plan.json` — the authored half of the
 * hybrid.
 *
 * ── WHY A PLAN AT ALL ──────────────────────────────────────────────────────
 * A purely procedural city is legible as procedural within about ten seconds:
 * every junction is equivalent, nothing is anywhere for a reason, and there is
 * no route a player learns. What makes City Z feel like a place is a small
 * amount of authorship at the top — where the arterial roads run, where the
 * skyline peaks, which corner the Hero Association branch sits on, where the
 * crater from a past fight still is — and a large amount of determinism below.
 *
 * So the plan carries EXACTLY the decisions a level designer would want to
 * make by hand:
 *   • the arterial road graph, with widths and lane counts;
 *   • zoning polygons with their height/density/material curves;
 *   • landmark placements and their exclusion radii;
 *   • one authored parcel record per block, with a seed salt and local tuning.
 *
 * Everything INSIDE a block — lot subdivision, building footprints, storey
 * counts, facade panel choice, rooftop clutter, prop scatter — is derived from
 * `hash(blockId, planVersion)` and never stored. Editing the plan changes the
 * city; the seed guarantees the same city on every device, every run.
 *
 * The file is plain JSON with tuple coordinates rather than objects: it keeps
 * the committed artifact readable and diffable at ~150 KB instead of ~400 KB,
 * and it structured-clones into a worker for free.
 */

import type { BuildingStyle, DistrictType, RoadClass } from '@/types';
import type { Vec2 } from './polygon';

/* -------------------------------------------------------------------------- */
/* Roads                                                                      */
/* -------------------------------------------------------------------------- */

/** Lane-marking treatment painted onto a carriageway. */
export type RoadMarkings = 'none' | 'centre-dashed' | 'centre-solid' | 'lane-dashed' | 'divided';

/** Road surface family; resolved to a manifest material id by `materials.ts`. */
export type RoadSurface = 'asphalt-worn' | 'asphalt-rough' | 'asphalt-clean' | 'damaged' | 'cobble';

/**
 * One arterial or local road, as a polyline of control points.
 *
 * `curved` selects centripetal Catmull-Rom interpolation through the control
 * points; straight grid streets leave it false so their geometry is exact.
 */
export interface IPlanRoad {
  readonly id: string;
  readonly name?: string;
  readonly roadClass: RoadClass;
  /** Traffic lanes across the full carriageway, both directions. */
  readonly lanes: number;
  /** Carriageway width in metres, excluding sidewalks. */
  readonly width: number;
  /** Sidewalk width per side in metres. 0 means none. */
  readonly sidewalk: number;
  readonly surface: RoadSurface;
  readonly markings: RoadMarkings;
  /** Control points in world XZ metres. */
  readonly points: readonly Vec2[];
  readonly curved: boolean;
  /** Street lamps every N metres along each side. 0 disables. */
  readonly lampSpacing: number;
}

/** Junction type; drives crossings, signals and corner treatment. */
export type IntersectionKind = 'cross' | 'tee' | 'bend' | 'plaza' | 'terminus';

/** A junction of two or more roads. */
export interface IPlanIntersection {
  readonly id: string;
  readonly position: Vec2;
  readonly kind: IntersectionKind;
  /** Half-extent of the junction plate in metres. */
  readonly radius: number;
  readonly roads: readonly string[];
  readonly crossings: boolean;
  readonly signals: boolean;
}

/* -------------------------------------------------------------------------- */
/* Zoning                                                                     */
/* -------------------------------------------------------------------------- */

/** Zone family. Maps onto `DistrictType` but is finer-grained. */
export type ZoneKind =
  | 'downtown'
  | 'shopping'
  | 'apartment'
  | 'residential'
  | 'industrial'
  | 'civic'
  | 'park'
  | 'crater'
  | 'ghost';

/**
 * Generation parameters for a zone. These are the dials a designer actually
 * turns; every one of them is read by `block.ts` or `building.ts`.
 */
export interface IPlanZoneParams {
  /** Storey count range, inclusive. */
  readonly floorRange: readonly [number, number];
  /**
   * Height distribution exponent. 1 is uniform; >1 biases towards the low end
   * (a few towers over many mid-rises), <1 biases tall.
   */
  readonly heightExponent: number;
  readonly floorHeight: number;
  /** Ground-floor height multiplier — shopfronts are taller than flats. */
  readonly groundFloorScale: number;
  /** 0..1 chance a perimeter lot is built on rather than left as a gap. */
  readonly density: number;
  /** Street frontage width range for a lot, in metres. */
  readonly lotWidth: readonly [number, number];
  /** Depth from the street edge into the block, in metres. */
  readonly lotDepth: readonly [number, number];
  /** Metres the facade is pulled back from the parcel edge. */
  readonly setback: number;
  /** Relative weights over building styles. */
  readonly styleWeights: Readonly<Partial<Record<BuildingStyle, number>>>;
  /** Manifest material ids permitted for facades, with matching weights. */
  readonly facadeMaterials: readonly string[];
  readonly facadeWeights: readonly number[];
  readonly roofMaterials: readonly string[];
  /** Per-building tint palette as hex ints; multiplied into the facade map. */
  readonly tints: readonly number[];
  /** Relative weights over facade panel kinds on upper floors. */
  readonly panelWeights: Readonly<Record<string, number>>;
  /** Relative weights over facade panel kinds on the ground floor. */
  readonly groundWeights: Readonly<Record<string, number>>;
  /** 0..1 probabilities for optional facade features. */
  readonly balconyChance: number;
  readonly fireEscapeChance: number;
  readonly acUnitChance: number;
  readonly signageChance: number;
  /** 0..1 rooftop clutter density. */
  readonly rooftopClutter: number;
  /** Props scattered per 100 m of street frontage. */
  readonly propDensity: number;
  /** NPC population multiplier. */
  readonly populationDensity: number;
  /** Monster spawn multiplier. */
  readonly threatDensity: number;
  /** Ground surface inside the parcel, behind the sidewalk. */
  readonly lotSurface: 'concrete' | 'asphalt' | 'gravel' | 'dirt' | 'grass' | 'cobble';
}

/** A zoning polygon. Higher `priority` wins where zones overlap. */
export interface IPlanZone {
  readonly id: string;
  readonly name: string;
  readonly kind: ZoneKind;
  readonly district: DistrictType;
  readonly polygon: readonly Vec2[];
  readonly priority: number;
  readonly params: IPlanZoneParams;
}

/* -------------------------------------------------------------------------- */
/* Landmarks                                                                  */
/* -------------------------------------------------------------------------- */

/** Landmark archetype; selects a bespoke generator in `landmarks.ts`. */
export type LandmarkKind =
  | 'heroAssociation'
  | 'arcade'
  | 'apartment'
  | 'park'
  | 'crater'
  | 'tower'
  | 'monument';

/** A hand-placed point of interest that overrides procedural fill. */
export interface IPlanLandmark {
  readonly id: string;
  readonly name: string;
  readonly kind: LandmarkKind;
  /** World position of the landmark origin. */
  readonly position: Vec2;
  readonly rotationY: number;
  /** Footprint in LOCAL metres about the origin, CCW. */
  readonly footprint: readonly Vec2[];
  readonly floors: number;
  readonly floorHeight: number;
  readonly style: BuildingStyle;
  readonly facadeMaterial: string;
  readonly roofMaterial: string;
  readonly tint: number;
  /** Procedural fill is suppressed within this radius. */
  readonly exclusionRadius: number;
  /** Optional bespoke model id from `tools/manifest/models.json`. */
  readonly assetKey?: string;
  /** Free-form notes carried into `ILandmark.name` and debug overlays. */
  readonly description?: string;
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One authored parcel. The outline is baked rather than re-derived from the
 * road graph at load time, so a designer can nudge a single block without
 * touching the roads that produced it.
 */
export interface IPlanBlock {
  readonly id: string;
  /** Owning chunk coordinate, `[cx, cz]`, each in -8..7. */
  readonly chunk: readonly [number, number];
  /** Parcel outline in world XZ, CCW. */
  readonly outline: readonly Vec2[];
  /** Zone id this parcel takes its parameters from. */
  readonly zone: string;
  /** Extra entropy folded into the block seed; lets a designer reroll one block. */
  readonly salt: number;
  /** Multiplier on the zone density, 0..2. */
  readonly density: number;
  /** Additive storey bias, in floors. */
  readonly heightBias: number;
  /** Edges that face an arterial and therefore get the best frontage. */
  readonly frontage: readonly boolean[];
  /** Optional service alley splitting the parcel. */
  readonly alley?: { readonly axis: 'x' | 'z'; readonly offset: number; readonly width: number };
  readonly tags?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Terrain features                                                           */
/* -------------------------------------------------------------------------- */

/** A crater left by a past fight. Depresses terrain and wrecks what it touches. */
export interface IPlanCrater {
  readonly id: string;
  readonly centre: Vec2;
  readonly radius: number;
  readonly depth: number;
  /** Height of the debris rim above ground level. */
  readonly rim: number;
  /** 0..1 rubble scatter density inside the bowl. */
  readonly rubble: number;
  readonly description?: string;
}

/** A hand-placed prop that procedural scatter must not move or remove. */
export interface IPlanProp {
  readonly assetKey: string;
  readonly position: Vec2;
  readonly rotationY: number;
  readonly scale: number;
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

/** The complete authored plan. */
export interface ICityPlan {
  /**
   * Bumped on any authored change. It is mixed into every block seed, so a
   * plan edit deterministically rerolls procedural detail instead of leaving
   * stale geometry that no longer matches the new zoning.
   */
  readonly planVersion: number;
  readonly name: string;
  readonly description: string;
  /** Must equal `WORLD_SIZE` in `src/spatial/constants.ts`. */
  readonly worldSize: number;
  /** Must equal `CHUNK_SIZE`. */
  readonly chunkSize: number;
  /** Must equal `CHUNK_GRID`. */
  readonly chunkGrid: number;
  /** Master world seed. */
  readonly worldSeed: number;
  readonly groundLevel: number;
  readonly roads: readonly IPlanRoad[];
  readonly intersections: readonly IPlanIntersection[];
  readonly zones: readonly IPlanZone[];
  readonly landmarks: readonly IPlanLandmark[];
  readonly blocks: readonly IPlanBlock[];
  readonly craters: readonly IPlanCrater[];
  readonly props: readonly IPlanProp[];
}
