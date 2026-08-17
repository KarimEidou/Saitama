/**
 * PROCEDURAL HUMANOID — INTERNAL TYPES
 *
 * These describe how a humanoid is DESCRIBED before it is triangulated. The
 * public, cross-system contracts live in `@/types` (character.ts); nothing in
 * this file is part of the shared architecture — it is the vocabulary of the
 * generator itself.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE CENTRAL IDEA: A BODY IS A SET OF LOFTED STRANDS
 *
 *  Every part of a character (torso, arm, thigh, finger, cape, hair curl) is
 *  a STRAND: an ordered list of cross-section RINGS swept along a spline.
 *  Triangulating a strand is trivial, but the real payoff is skinning.
 *
 *  A ring knows its own parametric position along the bone chain it belongs
 *  to, so its four bone influences are COMPUTED, not painted. There is no
 *  weight transfer step, no heat diffusion, no manual cleanup — the loft *is*
 *  the bind pose, so weights fall out of the same parameter that positioned
 *  the ring in the first place. That removes the single hardest part of
 *  procedural rigging.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── FRAME CONVENTION (read before authoring any shape) ────────────────────
 *
 * World space is right-handed, Y-up, and characters FACE -Z (see
 * `ITransform.forward` in types/entity.ts). Therefore, for an upright
 * character, +X is the character's RIGHT and -X is their LEFT. Mixamo's own
 * rigs face +Z; ours are mirrored to match the engine, so `LeftArm` sits at
 * negative X. Bone NAMES stay Mixamo-compatible, which is what retargeting
 * keys off.
 *
 * Each ring is drawn in a local 2-D frame (`axisA`, `axisB`) perpendicular to
 * the strand's travel direction (`axis`). The frame always satisfies
 *
 *     cross(axisA, axisB) === axis
 *
 * which is what keeps triangle winding outward-facing for every strand
 * regardless of which way it travels. Because the strand direction differs
 * per body part, `radiusA` / `radiusB` are deliberately NOT named x/z: what
 * they mean is per-strand and documented at each call site.
 */

import type * as THREE from 'three';
import type { BoneName } from '@/types';

/* -------------------------------------------------------------------------- */
/* Skinning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Exactly four bone influences, normalised to sum to 1.
 *
 * Four is not a stylistic choice: it is the width of the `skinIndex` /
 * `skinWeight` vertex attributes that every GPU skinning path expects. Slots
 * beyond the influences a vertex actually needs carry weight 0 and repeat a
 * VALID bone index, never -1 — an out-of-range index reads garbage from the
 * bone texture on some mobile drivers even when its weight is zero.
 */
export interface SkinWeight4 {
  readonly index: readonly [number, number, number, number];
  readonly weight: readonly [number, number, number, number];
}

/** One bone's span within a chain, measured in the chain's own parameter. */
export interface ChainSpan {
  readonly bone: BoneName;
  /** Parameter at which this bone starts owning the surface. */
  readonly start: number;
  /** Parameter at which the next bone takes over. */
  readonly end: number;
  /**
   * Half-width of the smooth crossfade centred on `end`. Wider windows give
   * rounder joint deformation but bleed influence further down the limb.
   */
  readonly blend?: number;
}

/** A localised extra influence layered on top of a chain. */
export interface SkinBias {
  readonly bone: BoneName;
  /** Chain parameter the bias is centred on. */
  readonly at: number;
  /** Distance over which the bias fades to nothing. */
  readonly range: number;
  /** Peak weight contributed at `at`, before renormalisation. */
  readonly amount: number;
}

/**
 * An ordered bone chain plus optional localised bias.
 *
 * `bias` exists for the seams between strands: the first rings of an arm sit
 * physically inside the ribcage, so they must partly follow `Spine2` or the
 * shoulder tears open when the spine twists.
 */
export interface SkinChain {
  readonly spans: readonly ChainSpan[];
  readonly bias?: readonly SkinBias[];
}

/* -------------------------------------------------------------------------- */
/* Cross-sections                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A closed cross-section outline: a superellipse with independent radii.
 *
 * A circle makes everything read as plumbing. Real torsos are wide, shallow
 * and slightly boxy; `exponent` is what buys that — 2 is a pure ellipse,
 * 2.6 is a rounded rectangle (ribcage, pelvis), 4+ is hard-surface (Genos'
 * forearms), below 2 pinches into a lens (cape rims, ears).
 */
export interface RingShape {
  /** Radius along the ring frame's first axis. */
  readonly radiusA: number;
  /** Radius along the ring frame's second axis. */
  readonly radiusB: number;
  /** Superellipse exponent. Default 2 (ellipse). */
  readonly exponent?: number;
  /** Multiplier applied to the +B half only (chest vs back, calf vs shin). */
  readonly frontScale?: number;
  /** Multiplier applied to the -B half only. */
  readonly backScale?: number;
  /** Centre displacement along the frame's first axis. */
  readonly offsetA?: number;
  /** Centre displacement along the frame's second axis (belly, jaw, seat). */
  readonly offsetB?: number;
}

/** One cross-section placed in model space. */
export interface Ring {
  /** Centre of the cross-section, in model space (metres). */
  readonly center: THREE.Vector3;
  readonly shape: RingShape;
  /** Bone influences shared by every vertex generated from this ring. */
  readonly skin: SkinWeight4;
  /** Texture V coordinate for this ring, 0..1 within the strand's UV rect. */
  readonly v: number;
  /**
   * Explicit sweep direction. When omitted the strand uses a central
   * difference of neighbouring centres, which bends rings naturally through
   * curves (spine, calf, cape).
   */
  readonly axis?: THREE.Vector3;
  /** Extra roll of the ring frame about `axis`, in radians. */
  readonly roll?: number;
  /** Per-ring colour override; falls back to the strand's paint colour. */
  readonly color?: THREE.Color;
}

/** How a strand terminates. */
export type CapMode =
  /** Fan to a single pole placed just beyond the last ring. Rounds the end. */
  | 'pole'
  /** Flat disc. Only for ends hidden inside another volume. */
  | 'flat'
  /** Leave open. Produces a boundary — never watertight. Debug only. */
  | 'none';

/** A swept surface: the unit of construction for the whole character. */
export interface Strand {
  readonly name: string;
  readonly rings: readonly Ring[];
  /** Vertices generated per ring. Higher = rounder and more expensive. */
  readonly radialSegments: number;
  readonly capStart: CapMode;
  readonly capEnd: CapMode;
  /**
   * Explicit pole-cap height, in metres. When omitted a pole rises by ~0.92 of
   * the rim's minor radius, which is right for a limb end but wrong for a
   * skull: a cranium's last ring is WIDE and the remaining height is small, so
   * the default turns the crown into a cone. Authoring the height lets the cap
   * be the shallow spherical segment a head actually needs.
   */
  readonly poleStart?: number;
  readonly poleEnd?: number;
  /** Atlas rectangle this strand's UVs are packed into. */
  readonly uvRect: UVRect;
  /** Material slot for the triangles of this strand. */
  readonly slot: MeshSlot;
  /** Base vertex colour, used where a ring supplies no override. */
  readonly color: THREE.Color;
  /**
   * Preferred direction for the ring frame's first axis. Orthonormalised
   * against the sweep direction; the second axis is then derived so that
   * `cross(axisA, axisB) === axis`.
   */
  readonly frameHint: THREE.Vector3;
  /**
   * Vertices sharing a position AND a smoothing group get one averaged
   * normal. Different groups crease. Strand surfaces normally share a group
   * with their pole caps (round limb ends) but not with flat caps or panels.
   */
  readonly smoothGroup: number;
}

/* -------------------------------------------------------------------------- */
/* Material slots and UV atlas                                                */
/* -------------------------------------------------------------------------- */

/**
 * Material slot index written into `geometry.groups`.
 *
 * A caller that passes ONE material gets one draw call and the slots are
 * ignored by three.js — region colour still comes through as vertex colour.
 * A caller that passes an ARRAY gets per-slot materials (metal for Genos,
 * cloth for the cape) at the cost of one draw call per slot.
 */
export const MeshSlot = {
  Skin: 0,
  Cloth: 1,
  Accent: 2,
  Hair: 3,
  Metal: 4,
} as const;
export type MeshSlot = (typeof MeshSlot)[keyof typeof MeshSlot];

/** Human-readable slot names, indexed by slot value. */
export const SLOT_NAMES: readonly string[] = ['skin', 'cloth', 'accent', 'hair', 'metal'];

/** A rectangle in the 0..1 texture atlas. */
export interface UVRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/* -------------------------------------------------------------------------- */
/* Build description                                                          */
/* -------------------------------------------------------------------------- */

/** Detail tier. 0 is the hero LOD; 2 is the crowd LOD. */
export type LodLevel = 0 | 1 | 2;

/** Which optional features a LOD carries. */
export interface LodSettings {
  readonly level: LodLevel;
  /** Radial segments for the torso/head strand. */
  readonly torsoSegments: number;
  /** Radial segments for arms and legs. */
  readonly limbSegments: number;
  /** Radial segments for hands, feet and small parts. */
  readonly detailSegments: number;
  readonly hands: boolean;
  readonly feet: boolean;
  readonly ears: boolean;
  readonly nose: boolean;
  readonly thumbs: boolean;
  /** Garment shells are skipped entirely at the crowd LOD. */
  readonly garments: boolean;
  /** Hard-surface panels and vents. */
  readonly panels: boolean;
}

/** Which garment pieces a character wears. */
export interface GarmentSpec {
  readonly jumpsuit?: boolean;
  readonly cape?: boolean;
  readonly coat?: boolean;
  readonly skirt?: boolean;
  readonly gloves?: boolean;
  readonly boots?: boolean;
  readonly belt?: boolean;
  readonly collar?: boolean;
  /** Cloth colour; falls back to `BodyProfile.primaryColor`. */
  readonly primary?: number;
  /** Trim colour; falls back to `BodyProfile.secondaryColor`. */
  readonly accent?: number;
  /** Cape colour when it differs from the jumpsuit. */
  readonly capeColor?: number;
}

/** Low-poly sculpted hair. Strands are shells and lobes, never cards. */
export interface HairSpec {
  readonly style: 'bald' | 'bob' | 'spiky' | 'short' | 'long';
  readonly color: number;
  /** How far the hair shell floats off the scalp, in normalised units. */
  readonly thickness?: number;
  /** Number of sculpted lobes for `bob` / `spiky`. */
  readonly lobes?: number;
  /**
   * Hairline height as a fraction of head length above the chin. Overrides
   * the per-style default — a bike helmet is the `short` shell pulled down
   * over the ears.
   */
  readonly line?: number;
}

/** Genos-style mechanical detailing. */
export interface HardSurfaceSpec {
  /** Which limbs become machinery. */
  readonly arms?: boolean;
  readonly legs?: boolean;
  readonly torso?: boolean;
  readonly metalColor: number;
  readonly ventColor: number;
  /** Panel rows added around each mechanical strand. */
  readonly panelRows?: number;
}

/** A morph target derived by re-lofting with a perturbed profile. */
export interface MorphSpec {
  readonly name: string;
  /** Additive deltas applied to the profile before re-lofting. */
  readonly delta: {
    readonly bulk?: number;
    readonly shoulderWidth?: number;
    readonly headScale?: number;
    readonly limbLength?: number;
    readonly muscle?: number;
    readonly belly?: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/** Where one named region lives inside the merged index buffer. */
export interface MeshRegionInfo {
  readonly name: string;
  readonly slot: MeshSlot;
  readonly indexStart: number;
  readonly indexCount: number;
  readonly triangles: number;
}

/** Counts and budget evidence for a built mesh. */
export interface HumanoidStats {
  readonly lod: LodLevel;
  readonly vertices: number;
  readonly triangles: number;
  readonly bones: number;
  /** Distinct closed surfaces after welding by position. */
  readonly components: number;
  /** Standing height actually achieved, in metres. */
  readonly height: number;
}
