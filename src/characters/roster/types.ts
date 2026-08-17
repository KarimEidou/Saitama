/**
 * ROSTER — TYPES
 *
 * The vocabulary of "what a character is MADE of", as opposed to what shape it
 * is. Shape belongs to `@/characters/mesh`; motion belongs to
 * `@/characters/anim`; this workstream owns the surface.
 *
 * ── THE ONE IDEA THAT DRIVES EVERYTHING HERE ──────────────────────────────
 * The mesh generator paints REGION COLOUR into a vertex attribute and material
 * SLOT into `geometry.groups`. Neither is enough on its own to know what a
 * texel is made of:
 *
 *   - Slot is too coarse. Saitama's yellow jumpsuit, his skin and his red
 *     gloves all ride on `MeshSlot.Skin`, because they are all painted onto
 *     the body strands. Materialising by slot would make his suit "skin".
 *   - Colour alone is too fragile to read back from an 8-bit texture, but the
 *     vertex attribute is Float32 and the costume functions assign a small,
 *     KNOWN set of exact colours.
 *
 * So a character declares a COLOUR -> `SurfaceClass` table (`classify.ts`), and
 * everything downstream — roughness, metalness, which CC0 detail map tiles over
 * the region, whether a crowd instance may recolour it — keys off that class.
 * A unit test asserts every colour a build actually produces is declared, so
 * the table cannot silently drift away from the costume.
 */

import type { BodyProfile, ThreatTier } from '@/types';
import type { CharacterRecipe, LodLevel, Palette } from '@/characters/mesh';

/* -------------------------------------------------------------------------- */
/* Surface classes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a patch of a character is physically made of.
 *
 * This is the join key between the costume (which knows colours) and the
 * material set (which knows roughness, metalness and detail maps).
 */
export type SurfaceClass =
  /** Bare skin: face, forearms, legs. */
  | 'skin'
  /** Woven garment: jumpsuit, shirt, dress, trousers. */
  | 'cloth'
  /** Trim: belts, collars, cuffs — same weave, darker and tighter. */
  | 'accent'
  /** Gloves and boots. Reads as coated leather, not cotton. */
  | 'leather'
  /** Cape / long coat. Heavier canvas with a visible drape. */
  | 'cape'
  /** Sculpted hair shells and lobes. */
  | 'hair'
  /** Bare machined metal. The only class that is fully metallic. */
  | 'metal'
  /** Dark recessed vents and grilles inside the machinery. */
  | 'vent'
  /** Rubberised or ceramic joint sleeves between metal segments. */
  | 'joint'
  /** Painted armour plate — metal, but coated, so far less reflective. */
  | 'armor'
  /** Thick monster hide. Leathery, matte, coarse. */
  | 'hide'
  /** Insect carapace: hard, slightly waxy, faint iridescence. */
  | 'chitin'
  /** Overlapping scales. */
  | 'scale'
  /** Wet or slime-coated flesh. */
  | 'slime'
  /** Self-illuminated cores, eyes and energy vents. */
  | 'glow';

/** Every class, in a stable order. Used for tables and tests. */
export const SURFACE_CLASSES: readonly SurfaceClass[] = [
  'skin',
  'cloth',
  'accent',
  'leather',
  'cape',
  'hair',
  'metal',
  'vent',
  'joint',
  'armor',
  'hide',
  'chitin',
  'scale',
  'slime',
  'glow',
];

/* -------------------------------------------------------------------------- */
/* Detail sources                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Procedural micro-pattern layered on top of (or instead of) a CC0 photo map.
 *
 * The processed CC0 library is a CITY library — asphalt, brick, corrugated
 * iron. It has no cotton and no skin, because nothing in Z-City needed them.
 * Rather than mis-tile brick onto a jumpsuit, cloth-like classes synthesise
 * their weave here and use a CC0 map only for the irregular grain underneath.
 * Metal, which the library does have in abundance, uses the real thing.
 */
export type MicroPattern =
  | 'none'
  /** Plain over-under weave. Jumpsuit, shirt. */
  | 'weave'
  /** Diagonal rib. Trousers, heavy trim. */
  | 'twill'
  /** Coarse basket weave with slub. Cape, canvas. */
  | 'canvas'
  /** Pebbled grain with fine cracks. Gloves, boots. */
  | 'leather'
  /** Pores and faint fine lines. Skin. */
  | 'pores'
  /** Directional strands. Hair. */
  | 'strand'
  /** Brushed anisotropic streaks. Machined metal. */
  | 'brushed'
  /** Hexagonal cells. Insect carapace. */
  | 'hexcell'
  /** Overlapping lens scales. */
  | 'scale'
  /** Bumpy, irregular hide. */
  | 'pebble';

/** How a class draws its micro detail. */
export interface DetailSpec {
  /**
   * Manifest id of a processed CC0 material whose albedo/normal/ARM maps tile
   * under this class, or `undefined` for a purely synthetic surface.
   */
  readonly material?: string;
  /** Synthetic pattern layered on top. */
  readonly pattern: MicroPattern;
  /** Detail tile repeats across the region's atlas rectangle. */
  readonly tiles: number;
  /** 0..1 — how strongly the CC0 albedo modulates the base colour. */
  readonly albedoStrength: number;
  /** 0..1 — how strongly the CC0 normal contributes. */
  readonly normalStrength: number;
  /** 0..1 — how strongly the synthetic pattern contributes to relief. */
  readonly patternStrength: number;
  /** 0..1 — how strongly the CC0 ARM roughness modulates class roughness. */
  readonly roughnessStrength: number;
}

/* -------------------------------------------------------------------------- */
/* Surface styles                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Which per-instance tint slot a class listens to.
 *
 * Encoded into the atlas albedo's ALPHA channel so that ONE shared civilian
 * atlas can dress a whole crowd: the shader reads the mask, picks the matching
 * instanced colour attribute and multiplies. Heroes bake `none` everywhere,
 * which makes the mask channel inert.
 */
export type TintSlot = 'none' | 'hair' | 'skin' | 'accent' | 'cloth';

/** Alpha value written into the atlas for each tint slot. */
export const TINT_MASK_LEVEL: Readonly<Record<TintSlot, number>> = {
  none: 0,
  hair: 0.25,
  skin: 0.5,
  accent: 0.75,
  cloth: 1,
};

/** Everything the baker and the material factory need for one class. */
export interface SurfaceStyle {
  /** Base roughness before detail modulation. 0 = mirror, 1 = fully diffuse. */
  readonly roughness: number;
  /** Base metalness. Only genuinely metallic classes should be near 1. */
  readonly metalness: number;
  /** Baked ambient-occlusion strength, 0..1. */
  readonly ao: number;
  readonly detail: DetailSpec;
  readonly tint: TintSlot;
  /**
   * Emissive colour as a hex integer. Written into the character's emissive
   * atlas; `undefined` means this class never glows.
   */
  readonly emissive?: number;
  /** Emissive strength 0..1, multiplied into the emissive atlas. */
  readonly emissiveStrength?: number;
  /**
   * Multiplier applied to the baked base colour. Lets one costume colour serve
   * two classes (a cape that should read a touch dirtier than the shirt)
   * without inventing a new palette entry.
   */
  readonly tone?: number;
}

/** A complete per-class style table. Every class is present after resolution. */
export type SurfaceStyleSet = Readonly<Record<SurfaceClass, SurfaceStyle>>;

/* -------------------------------------------------------------------------- */
/* Faces                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Face expressions the atlas ships.
 *
 * Four, deliberately: they are stacked in one strip texture and selected by a
 * single shader uniform, so the cost of the set is four small tiles, not four
 * atlases. `bored` exists because the Boredom gameplay state needs somewhere
 * blanker than neutral to go, and for Saitama that vacancy is the character.
 */
export type Expression = 'neutral' | 'bored' | 'serious' | 'surprised';

/** Expression order inside the face strip. The shader indexes by this. */
export const EXPRESSIONS: readonly Expression[] = ['neutral', 'bored', 'serious', 'surprised'];

/** Eye construction. */
export type EyeShape =
  /** Tiny solid ovals. A blank stare with no sclera at all. */
  | 'dot'
  /** Almond with visible sclera and an iris. */
  | 'almond'
  /** Large anime eye: big iris, highlight, lash line. */
  | 'anime'
  /** Hard narrow slit. */
  | 'slit'
  /** Faceted compound eye. */
  | 'compound'
  /** Empty socket with a floating pupil. */
  | 'socket'
  /** Round fish eye with a ring iris. */
  | 'round';

/** Mouth construction. */
export type MouthShape = 'line' | 'small' | 'wide' | 'grin' | 'fanged' | 'mandible' | 'beak';

/** Brow construction. */
export type BrowShape = 'none' | 'faint' | 'thin' | 'bold' | 'angular';

/**
 * A face, in parameters.
 *
 * All horizontal measurements are METRES across the face, all vertical
 * measurements are strand-local `v` (the same `v` the mesh publishes in
 * `HEAD_LANDMARK_V`), so a face automatically follows the head it is painted
 * on: a 1.18x head scale moves every feature with it.
 */
export interface FaceStyle {
  readonly eye: EyeShape;
  /** Distance from the centre line to each eye centre, in metres. */
  readonly eyeSpread: number;
  /** Strand-local v of the eye centre. */
  readonly eyeV: number;
  /** Eye half-width in metres. */
  readonly eyeWidth: number;
  /** Eye half-height in metres. */
  readonly eyeHeight: number;
  readonly sclera: number;
  readonly iris: number;
  readonly pupil: number;
  readonly brow: BrowShape;
  readonly browColor: number;
  /** Strand-local v of the brow. */
  readonly browV: number;
  readonly mouth: MouthShape;
  /** Mouth half-width in metres. */
  readonly mouthWidth: number;
  /** Strand-local v of the mouth. */
  readonly mouthV: number;
  readonly mouthColor: number;
  /** Shadow under the eyes / in the sockets. */
  readonly shadow?: number;
  /** Emissive colour for eyes that light up. */
  readonly glow?: number;
  /** A visor band across the eyes (Mumen Rider's goggles). */
  readonly visor?: number;
  /** Face markings: stripes, scars, plating seams. */
  readonly marking?: 'none' | 'scar' | 'plate' | 'stripes' | 'gills';
  readonly markingColor?: number;
  /** Cheek/lip warmth multiplier, 0 disables. */
  readonly blush?: number;
}

/* -------------------------------------------------------------------------- */
/* Roster entries                                                             */
/* -------------------------------------------------------------------------- */

/** What part of the cast an entry belongs to. */
export type RosterKind = 'hero' | 'monster' | 'civilian';

/** A colour the costume paints, and what it is made of. */
export interface ClassColor {
  /** Hex as passed to `THREE.Color`, i.e. sRGB. */
  readonly hex: number;
  readonly surface: SurfaceClass;
  /** Human-readable note for the manifest and for debugging. */
  readonly note?: string;
}

/** One complete, materialised character. */
export interface RosterEntry {
  /** Stable id; also the asset key (`chr.saitama`) and the atlas directory. */
  readonly id: string;
  readonly name: string;
  readonly kind: RosterKind;
  /** Hero Association threat classification, for monsters. */
  readonly threat?: ThreatTier;
  /** Mesh recipe: profile plus costume. */
  readonly recipe: CharacterRecipe;
  /** Costume colour -> surface class table. */
  readonly colors: readonly ClassColor[];
  /** Per-class overrides layered over `DEFAULT_SURFACES`. */
  readonly surfaces?: Partial<Record<SurfaceClass, Partial<SurfaceStyle>>>;
  readonly face: FaceStyle;
  /** Deterministic seed for every random decision in the bake. */
  readonly seed: number;
  /** True when the crowd tint mask should be baked and instancing enabled. */
  readonly crowd?: boolean;
  /**
   * True for the character the camera collapses onto. Only this material gets
   * the proximity dither injection, so nothing else pays for a `discard`.
   */
  readonly player?: boolean;
  /** Expression baked into the albedo atlas (the GLB's own resting face). */
  readonly restExpression?: Expression;
}

/* -------------------------------------------------------------------------- */
/* Bake products                                                              */
/* -------------------------------------------------------------------------- */

/** One tiling CC0 detail source, decoded to raw pixels for the baker. */
export interface DetailTile {
  readonly id: string;
  readonly size: number;
  /** RGB, sRGB-encoded, `size * size * 3`. */
  readonly albedo: Uint8Array;
  /** RGB tangent-space normal (OpenGL convention), `size * size * 3`. */
  readonly normal: Uint8Array;
  /** Packed AO / roughness / metalness, `size * size * 3`. */
  readonly arm: Uint8Array;
  /** Mean albedo luminance, so the tile modulates rather than replaces. */
  readonly meanLuma: number;
  /** Mean roughness. */
  readonly meanRough: number;
}

/** A rasterised face patch, ready to composite into the atlas. */
export interface FacePatch {
  /** RGBA, `width * height * 4`, straight (non-premultiplied) alpha. */
  readonly rgba: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Where the face sits in the atlas, in UV. Also drives the shader uniform. */
export interface FaceRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/** The maps one character's atlas bake produces. */
export interface AtlasMaps {
  readonly size: number;
  /** RGBA sRGB. Alpha carries the crowd tint mask. */
  readonly albedo: Uint8Array;
  /** RGB linear: AO in R, roughness in G, metalness in B. */
  readonly orm: Uint8Array;
  /** RGB tangent-space normal. */
  readonly normal: Uint8Array;
  /** RGB sRGB emissive, or undefined when nothing on the character glows. */
  readonly emissive?: Uint8Array;
  /** Fraction of atlas texels covered by at least one triangle, 0..1. */
  readonly coverage: number;
  /** Triangles rasterised. */
  readonly triangles: number;
  /** Per-class texel counts, for the report. */
  readonly classTexels: Readonly<Partial<Record<SurfaceClass, number>>>;
}

/** Ambient-occlusion provider injected by the offline baker. */
export interface OcclusionSampler {
  /**
   * Occlusion for a batch of surface points. Returns one visibility value per
   * point in 0..1, where 1 is fully open sky and 0 is fully enclosed.
   */
  (positions: Float32Array, normals: Float32Array, count: number): Float32Array;
}

/** Everything `bakeCharacterAtlas` needs beyond the build itself. */
export interface AtlasBakeOptions {
  readonly size?: number;
  readonly seed?: number;
  /** CC0 detail tiles, keyed by manifest id. */
  readonly tiles?: ReadonlyMap<string, DetailTile>;
  /** Face art, already rasterised at the atlas patch size. */
  readonly face?: FacePatch;
  /** Face roughness/metalness layer, same size as `face`. */
  readonly faceOrm?: FacePatch;
  /** Face emissive layer, same size as `face`. */
  readonly faceEmissive?: FacePatch;
  /** Where the face patch lands. */
  readonly faceRect?: FaceRect;
  /** Ray-traced occlusion. Falls back to a curvature estimate when absent. */
  readonly occlusion?: OcclusionSampler;
  /** Resolution of the occlusion grid; the AO buffer is upsampled from it. */
  readonly occlusionSize?: number;
  /**
   * Replace class base colours with a neutral grey so per-instance tints carry
   * the hue. Used for the shared civilian sheet.
   */
  readonly neutralize?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Convenience                                                                */
/* -------------------------------------------------------------------------- */

/** A profile plus the LOD it should be built at. */
export interface RosterBuildRequest {
  readonly id: string;
  readonly lod: LodLevel;
}

/** Re-exported for callers that only import from this module. */
export type { BodyProfile, CharacterRecipe, Palette, ThreatTier };
