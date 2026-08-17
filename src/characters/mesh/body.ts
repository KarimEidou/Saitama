/**
 * BODY LAYOUT — where the character actually gets its shape
 *
 * Everything here is a table of anatomical cross-sections plus the rules for
 * turning `ShapeParams` into concrete radii. Nothing here triangulates; that
 * is loft.ts's job.
 *
 * ── WHY TABLES AND NOT PRIMITIVES ─────────────────────────────────────────
 * The failure mode of every procedural humanoid is a torso that reads as a
 * lumpy cylinder. Three things prevent it, and all three live in this file:
 *
 *   1. Cross-sections are SUPERELLIPSES with independent width and depth. A
 *      real ribcage is ~1.45x as wide as it is deep and slightly boxy; a
 *      circle cannot read as a chest at any radius.
 *   2. There are landmarks, not a smooth taper: pelvis flare, waist pinch,
 *      rib swell, pec shelf, trapezius slope. The silhouette between hip and
 *      shoulder changes direction four times.
 *   3. The outline is OFFSET as well as scaled — the seat sits behind the
 *      spine, the belly in front of it, the jaw forward of the skull. Offsets
 *      are what make the side view read as a person rather than a lathe part.
 *
 * ── LOD ───────────────────────────────────────────────────────────────────
 * Every section carries a `tier`: 0 is structural and survives to the crowd
 * LOD, 2 is fine detail present only on the hero LOD. Filtering sections beats
 * decimating triangles afterwards because joints (elbow, knee, waist, brow)
 * are guaranteed to survive, so the silhouette degrades gracefully instead of
 * collapsing at its corners.
 */

import * as THREE from 'three';
import type { BoneName } from '@/types';
import { clamp01, lerp } from '@/util';
import type { LodSettings, Ring, RingShape, SkinChain, Strand } from './types';
import { MeshSlot } from './types';
import { UV_REGIONS } from './uv';
import { evaluateChain, makeStrand } from './loft';
import type { HumanoidRig } from './rig';
import type { ShapeParams } from './shape';

/* -------------------------------------------------------------------------- */
/* Paint hook                                                                 */
/* -------------------------------------------------------------------------- */

/** Which anatomical strand a section belongs to. */
export type BodyPart = 'torso' | 'arm' | 'leg' | 'hand' | 'foot' | 'ear' | 'nose';

/** What a costume does to one cross-section of the base body. */
export interface Coat {
  readonly color: THREE.Color;
  /**
   * Radial multiplier standing in for cloth thickness. A jumpsuit at this
   * budget is a recolour plus ~3% inflation: cloth genuinely thickens the
   * silhouette, and the step where inflation starts reads as a hem or a cuff
   * for exactly zero triangles.
   */
  readonly inflate?: number;
  /**
   * Additive superellipse exponent. A costume can make a cross-section boxier
   * without touching the anatomy table — this is what turns Genos' forearms
   * into machined cylinders while the rest of him stays organic.
   */
  readonly exponent?: number;
}

/** Costume lookup: resolves a body cross-section to its surface appearance. */
export type PaintFn = (part: BodyPart, key: string, at: number) => Coat;

/* -------------------------------------------------------------------------- */
/* Section tables                                                             */
/* -------------------------------------------------------------------------- */

/** One authored cross-section of a body part. */
export interface Section {
  readonly key: string;
  /** Position parameter; meaning is per-strand (height, or distance along). */
  readonly at: number;
  /** Texture v. Authored, so every LOD shares one unwrap. */
  readonly v: number;
  /** Radius along the ring frame's A axis, in normalised units. */
  readonly a: number;
  /** Radius along the ring frame's B axis, in normalised units. */
  readonly b: number;
  readonly e?: number;
  readonly offB?: number;
  readonly frontScale?: number;
  readonly backScale?: number;
  /** Radial gain per unit of `muscle`, on A and (optionally) B. */
  readonly mus?: number;
  readonly musB?: number;
  /** Radial gain per unit of `belly`. */
  readonly fat?: number;
  readonly fatB?: number;
  /** Forward push per unit of `belly`, in normalised units. */
  readonly fatOff?: number;
  /** 0 survives every LOD, 1 survives LOD1, 2 is hero-LOD only. */
  readonly tier: 0 | 1 | 2;
}

/**
 * Torso, neck and head as ONE strand.
 *
 * `at` is a normalised height: 0 at the crotch, 1 at the crown, with the
 * landmarks between resolved from the rig so limb length and head scale move
 * them correctly. Keeping the head continuous with the torso costs nothing and
 * removes the neck seam entirely.
 */
const TORSO_SECTIONS: readonly Section[] = [
  { key: 'crotch', at: 0.0, v: 0.0, a: 0.044, b: 0.046, e: 2.4, offB: -0.004, mus: 0.02, fat: 0.1, tier: 0 },
  { key: 'pelvisLow', at: 0.045, v: 0.035, a: 0.086, b: 0.06, e: 2.7, offB: -0.005, mus: 0.03, fat: 0.14, tier: 1 },
  { key: 'hips', at: 0.09, v: 0.07, a: 0.098, b: 0.063, e: 2.7, offB: -0.007, mus: 0.04, fat: 0.18, tier: 0 },
  { key: 'pelvisTop', at: 0.14, v: 0.105, a: 0.092, b: 0.059, e: 2.6, offB: -0.004, mus: 0.03, fat: 0.26, fatOff: 0.008, tier: 2 },
  { key: 'waist', at: 0.2, v: 0.15, a: 0.077, b: 0.052, e: 2.5, mus: -0.02, fat: 0.44, fatB: 0.5, fatOff: 0.026, tier: 0 },
  { key: 'ribLow', at: 0.26, v: 0.195, a: 0.082, b: 0.056, e: 2.45, mus: 0.05, fat: 0.4, fatB: 0.44, fatOff: 0.03, tier: 2 },
  { key: 'ribs', at: 0.32, v: 0.24, a: 0.086, b: 0.06, e: 2.4, mus: 0.11, fat: 0.28, fatOff: 0.024, tier: 1 },
  { key: 'chestLow', at: 0.38, v: 0.285, a: 0.089, b: 0.063, e: 2.35, mus: 0.16, musB: 0.2, fat: 0.18, fatOff: 0.014, tier: 2 },
  { key: 'chest', at: 0.44, v: 0.33, a: 0.09, b: 0.064, e: 2.3, offB: 0.002, mus: 0.2, musB: 0.26, fat: 0.11, tier: 0 },
  { key: 'chestTop', at: 0.5, v: 0.37, a: 0.087, b: 0.061, e: 2.25, mus: 0.21, musB: 0.22, fat: 0.07, tier: 1 },
  { key: 'armpit', at: 0.56, v: 0.41, a: 0.084, b: 0.056, e: 2.2, mus: 0.23, fat: 0.05, tier: 2 },
  { key: 'yoke', at: 0.63, v: 0.455, a: 0.07, b: 0.049, e: 2.1, offB: -0.002, mus: 0.22, fat: 0.05, tier: 0 },
  { key: 'neckBase', at: 0.69, v: 0.495, a: 0.043, b: 0.044, e: 2.0, mus: 0.16, fat: 0.07, tier: 1 },
  { key: 'neckMid', at: 0.75, v: 0.525, a: 0.036, b: 0.038, e: 2.0, offB: 0.002, mus: 0.14, fat: 0.08, tier: 2 },
  { key: 'jawUnder', at: 0.8, v: 0.55, a: 0.036, b: 0.042, e: 2.0, offB: 0.005, mus: 0.06, fat: 0.15, tier: 2 },
  { key: 'chin', at: 0.845, v: 0.585, a: 0.031, b: 0.042, e: 2.2, offB: 0.012, mus: 0.02, fat: 0.17, tier: 0 },
  { key: 'jaw', at: 0.872, v: 0.63, a: 0.039, b: 0.05, e: 2.3, offB: 0.009, mus: 0.02, fat: 0.14, tier: 1 },
  { key: 'mouth', at: 0.897, v: 0.68, a: 0.044, b: 0.055, e: 2.2, offB: 0.005, fat: 0.08, tier: 2 },
  { key: 'cheek', at: 0.918, v: 0.725, a: 0.046, b: 0.057, e: 2.15, offB: 0.002, fat: 0.06, tier: 1 },
  { key: 'brow', at: 0.936, v: 0.775, a: 0.046, b: 0.058, e: 2.1, tier: 0 },
  { key: 'forehead', at: 0.951, v: 0.82, a: 0.045, b: 0.056, e: 2.05, offB: -0.002, tier: 1 },
  { key: 'skull', at: 0.966, v: 0.865, a: 0.041, b: 0.05, e: 2.0, offB: -0.005, tier: 2 },
  { key: 'crown', at: 0.979, v: 0.93, a: 0.034, b: 0.041, e: 2.0, offB: -0.007, tier: 0 },
  // The apex stays WIDE and the pole cap over it is authored short (see
  // `poleEnd` below). Tapering the last ring instead is what turns a cranium
  // into a traffic cone — the radius has to fall off like a spherical segment,
  // and a spherical segment is fat right up until it closes.
  { key: 'apex', at: 0.99, v: 0.965, a: 0.024, b: 0.029, e: 2.0, offB: -0.008, tier: 0 },
];

/**
 * Arm, shoulder ball to wrist. `at` is distance from the shoulder joint as a
 * multiple of the upper arm; past 1.0 it continues into the forearm.
 * A = front-to-back, B = vertical (see the frame note in types.ts).
 */
const ARM_SECTIONS: readonly Section[] = [
  // Deltoid radii are measured, not guessed: bideltoid breadth minus the
  // shoulder joint's own offset leaves ~6 cm of muscle on an adult male. An
  // over-generous ball here is the single most common tell of a generated
  // character — it reads as shoulder pads, and no amount of costume work
  // hides it.
  { key: 'inboard', at: -0.3, v: 0.0, a: 0.027, b: 0.028, mus: 0.2, fat: 0.14, tier: 0 },
  { key: 'deltoidLow', at: -0.12, v: 0.05, a: 0.033, b: 0.035, mus: 0.28, fat: 0.16, tier: 2 },
  { key: 'deltoid', at: 0.06, v: 0.11, a: 0.036, b: 0.038, mus: 0.3, musB: 0.34, fat: 0.15, tier: 0 },
  { key: 'deltoidEnd', at: 0.24, v: 0.17, a: 0.034, b: 0.036, mus: 0.3, fat: 0.16, tier: 2 },
  { key: 'bicep', at: 0.45, v: 0.26, a: 0.032, b: 0.034, mus: 0.3, musB: 0.34, fat: 0.2, tier: 1 },
  { key: 'armMid', at: 0.65, v: 0.34, a: 0.03, b: 0.032, mus: 0.24, fat: 0.2, tier: 2 },
  { key: 'armLow', at: 0.82, v: 0.41, a: 0.027, b: 0.029, mus: 0.16, fat: 0.18, tier: 1 },
  { key: 'elbowUp', at: 0.94, v: 0.46, a: 0.025, b: 0.028, mus: 0.1, fat: 0.15, tier: 2 },
  { key: 'elbow', at: 1.0, v: 0.5, a: 0.024, b: 0.028, mus: 0.08, fat: 0.14, tier: 0 },
  { key: 'elbowDown', at: 1.06, v: 0.54, a: 0.025, b: 0.029, mus: 0.12, fat: 0.14, tier: 2 },
  { key: 'foreTop', at: 1.19, v: 0.61, a: 0.027, b: 0.03, mus: 0.24, fat: 0.16, tier: 0 },
  { key: 'foreMid', at: 1.36, v: 0.68, a: 0.025, b: 0.027, mus: 0.18, fat: 0.13, tier: 2 },
  { key: 'foreLow', at: 1.55, v: 0.76, a: 0.021, b: 0.022, mus: 0.1, fat: 0.09, tier: 1 },
  { key: 'foreEnd', at: 1.72, v: 0.84, a: 0.017, b: 0.018, mus: 0.05, fat: 0.06, tier: 2 },
  { key: 'wrist', at: 1.81, v: 0.9, a: 0.0155, b: 0.0145, e: 2.2, mus: 0.04, fat: 0.05, tier: 0 },
];

/**
 * Leg, hip ball to ankle. `at` is distance below the hip joint as a multiple
 * of the thigh; past 1.0 it continues down the shank.
 * A = lateral, B = front-to-back.
 */
const LEG_SECTIONS: readonly Section[] = [
  { key: 'hipIn', at: -0.2, v: 0.0, a: 0.047, b: 0.05, mus: 0.14, fat: 0.24, tier: 0 },
  { key: 'hipBall', at: -0.06, v: 0.04, a: 0.053, b: 0.056, mus: 0.18, fat: 0.3, tier: 2 },
  { key: 'thighTop', at: 0.08, v: 0.09, a: 0.055, b: 0.057, mus: 0.22, fat: 0.34, tier: 0 },
  { key: 'thighA', at: 0.24, v: 0.15, a: 0.052, b: 0.054, mus: 0.24, fat: 0.3, tier: 2 },
  { key: 'thighB', at: 0.42, v: 0.22, a: 0.048, b: 0.05, mus: 0.24, fat: 0.26, tier: 1 },
  { key: 'thighC', at: 0.6, v: 0.29, a: 0.043, b: 0.046, mus: 0.2, fat: 0.22, tier: 2 },
  { key: 'thighD', at: 0.78, v: 0.36, a: 0.038, b: 0.041, mus: 0.15, fat: 0.17, tier: 1 },
  { key: 'kneeUp', at: 0.92, v: 0.42, a: 0.035, b: 0.038, mus: 0.09, fat: 0.13, tier: 2 },
  { key: 'knee', at: 1.0, v: 0.47, a: 0.034, b: 0.037, e: 2.2, offB: 0.004, mus: 0.07, fat: 0.12, tier: 0 },
  { key: 'kneeDown', at: 1.08, v: 0.52, a: 0.034, b: 0.038, offB: -0.002, mus: 0.12, fat: 0.13, tier: 2 },
  { key: 'calf', at: 1.22, v: 0.59, a: 0.036, b: 0.04, offB: -0.007, mus: 0.24, musB: 0.3, fat: 0.16, tier: 0 },
  { key: 'calfLow', at: 1.4, v: 0.66, a: 0.032, b: 0.035, offB: -0.005, mus: 0.18, fat: 0.13, tier: 1 },
  { key: 'shin', at: 1.62, v: 0.74, a: 0.026, b: 0.028, offB: -0.002, mus: 0.09, fat: 0.08, tier: 1 },
  { key: 'shinLow', at: 1.82, v: 0.82, a: 0.021, b: 0.022, mus: 0.05, fat: 0.05, tier: 1 },
  { key: 'ankle', at: 2.0, v: 0.9, a: 0.019, b: 0.021, e: 2.2, mus: 0.03, fat: 0.04, tier: 0 },
];

/** Hand: a mitten paddle. A = across the palm, B = palm thickness. */
const HAND_SECTIONS: readonly Section[] = [
  { key: 'wrist', at: 0.0, v: 0.0, a: 0.019, b: 0.012, e: 2.3, tier: 0 },
  { key: 'palm', at: 0.22, v: 0.2, a: 0.028, b: 0.0145, e: 2.5, mus: 0.1, tier: 1 },
  { key: 'knuckle', at: 0.5, v: 0.45, a: 0.03, b: 0.0145, e: 2.6, mus: 0.1, tier: 0 },
  { key: 'fingers', at: 0.78, v: 0.7, a: 0.027, b: 0.0125, e: 2.5, tier: 1 },
  { key: 'tip', at: 0.97, v: 0.92, a: 0.015, b: 0.008, e: 2.3, tier: 0 },
];

/** Thumb stub. */
const THUMB_SECTIONS: readonly Section[] = [
  { key: 'base', at: 0.0, v: 0.0, a: 0.011, b: 0.011, tier: 0 },
  { key: 'mid', at: 0.45, v: 0.45, a: 0.0105, b: 0.0105, tier: 1 },
  { key: 'tip', at: 0.9, v: 0.9, a: 0.008, b: 0.008, tier: 0 },
];

/**
 * Foot, heel to toe tip. `at` is forward distance from the ankle in units of
 * `footForward`, negative behind it. A = half width, B = half height.
 */
const FOOT_SECTIONS: readonly Section[] = [
  { key: 'heel', at: -0.22, v: 0.0, a: 0.022, b: 0.03, e: 2.7, frontScale: 1.35, tier: 0 },
  { key: 'heelFront', at: -0.05, v: 0.12, a: 0.025, b: 0.03, e: 2.8, frontScale: 1.5, tier: 1 },
  { key: 'arch', at: 0.2, v: 0.3, a: 0.027, b: 0.028, e: 2.9, frontScale: 1.45, tier: 2 },
  { key: 'ball', at: 0.55, v: 0.5, a: 0.03, b: 0.026, e: 2.9, frontScale: 1.25, tier: 1 },
  { key: 'ballFront', at: 0.82, v: 0.66, a: 0.03, b: 0.022, e: 2.9, frontScale: 1.15, tier: 2 },
  { key: 'toeBase', at: 1.0, v: 0.78, a: 0.028, b: 0.019, e: 2.8, tier: 0 },
  { key: 'toeMid', at: 1.18, v: 0.9, a: 0.024, b: 0.016, e: 2.6, tier: 2 },
  { key: 'toeTip', at: 1.3, v: 0.98, a: 0.016, b: 0.012, e: 2.4, tier: 0 },
];

/* -------------------------------------------------------------------------- */
/* Section resolution                                                         */
/* -------------------------------------------------------------------------- */

/** Sections surviving this LOD, in order. Never fewer than two. */
function filterSections(sections: readonly Section[], lod: LodSettings): Section[] {
  const budget = 2 - lod.level;
  const kept = sections.filter((s) => s.tier <= budget);
  return kept.length >= 2 ? kept : sections.slice();
}

interface ResolveOptions {
  readonly unit: number;
  readonly scaleA: number;
  readonly scaleB: number;
  readonly bulk: number;
  /** Multiplier on authored offsets; matches the skull's own scale. */
  readonly offsetScale: number;
}

/** Turn a table row into a concrete cross-section, in metres. */
function resolveShapeAt(
  section: Section,
  shape: ShapeParams,
  coat: Coat,
  options: ResolveOptions
): RingShape {
  const mus = shape.muscle;
  const fat = shape.belly;
  const gainA = 1 + mus * (section.mus ?? 0) + fat * (section.fat ?? 0);
  const gainB = 1 + mus * (section.musB ?? section.mus ?? 0) + fat * (section.fatB ?? section.fat ?? 0);
  const inflate = coat.inflate ?? 1;
  const u = options.unit;

  return {
    radiusA: section.a * u * options.scaleA * options.bulk * gainA * inflate,
    radiusB: section.b * u * options.scaleB * options.bulk * gainB * inflate,
    exponent: (section.e ?? 2) + shape.angular * 1.6 + (coat.exponent ?? 0),
    frontScale: section.frontScale,
    backScale: section.backScale,
    offsetB: ((section.offB ?? 0) + fat * (section.fatOff ?? 0)) * u * options.offsetScale,
  };
}

/* -------------------------------------------------------------------------- */
/* Strand builders                                                            */
/* -------------------------------------------------------------------------- */

const FORWARD = new THREE.Vector3(0, 0, -1);
const BACK = new THREE.Vector3(0, 0, 1);
const RIGHT = new THREE.Vector3(1, 0, 0);
const LEFT = new THREE.Vector3(-1, 0, 0);

/** Smoothing-group ids. Distinct groups crease against each other. */
export const SMOOTH = {
  body: 1,
  hand: 2,
  foot: 3,
  ear: 4,
  nose: 5,
  garment: 6,
  hair: 7,
  panel: 100,
} as const;

/** Everything a strand builder needs. */
export interface BodyContext {
  readonly rig: HumanoidRig;
  readonly shape: ShapeParams;
  readonly lod: LodSettings;
  readonly paint: PaintFn;
  readonly skinColor: THREE.Color;
}

/* --------------------------------- torso --------------------------------- */

/** Bone spans down the spine, expressed in model-space height. */
function torsoChain(ctx: BodyContext): SkinChain {
  const d = ctx.rig.dims;
  const u = d.unit;
  const hipTop = lerp(d.hipsY, d.spineY, 0.6);
  const spineTop = lerp(d.spineY, d.spine1Y, 0.5);
  const spine1Top = lerp(d.spine1Y, d.spine2Y, 0.5);
  return {
    spans: [
      { bone: 'Hips', start: -1e9, end: hipTop, blend: 0.045 * u },
      { bone: 'Spine', start: hipTop, end: spineTop, blend: 0.04 * u },
      { bone: 'Spine1', start: spineTop, end: spine1Top, blend: 0.042 * u },
      { bone: 'Spine2', start: spine1Top, end: d.neckY, blend: 0.05 * u },
      { bone: 'Neck', start: d.neckY, end: d.headY, blend: 0.032 * u },
      { bone: 'Head', start: d.headY, end: 1e9 },
    ],
  };
}

/**
 * The torso/neck/head strand.
 *
 * The first and last rings are nudged so their pole caps land exactly on the
 * crotch and on `headTopY`. Without that the domes overshoot and the character
 * stands taller than `BodyProfile.height` claims — a silent way for every
 * camera framing and collision capsule in the game to be subtly wrong.
 */
export function buildTorsoStrand(ctx: BodyContext): Strand {
  const { rig, shape, lod, paint } = ctx;
  const d = rig.dims;
  const u = d.unit;
  const sections = filterSections(TORSO_SECTIONS, lod);
  const chain = torsoChain(ctx);

  // Landmark heights the normalised `at` parameter interpolates between.
  const stops: readonly (readonly [number, number])[] = [
    [0.0, d.crotchY],
    [0.09, d.hipsY],
    [0.2, d.spineY],
    [0.32, d.spine1Y],
    [0.5, d.spine2Y],
    [0.69, d.neckY],
    [0.845, d.chinY],
    [0.872, d.headY],
    [1.0, d.headTopY],
  ];

  const heightAt = (at: number): number => {
    for (let i = 1; i < stops.length; i++) {
      const [a1, y1] = stops[i]!;
      if (at <= a1) {
        const [a0, y0] = stops[i - 1]!;
        return lerp(y0, y1, (at - a0) / (a1 - a0));
      }
    }
    return stops[stops.length - 1]![1];
  };

  const centers: THREE.Vector3[] = [];
  const shapes: RingShape[] = [];
  const coats: Coat[] = [];

  for (const section of sections) {
    const y = heightAt(section.at);
    const isHead = section.at >= 0.845;
    const skull = d.headScale;
    const coat = paint('torso', section.key, section.at);

    const ringShape = resolveShapeAt(section, shape, coat, {
      unit: u,
      scaleA: isHead ? skull * lerp(1, 1.07, shape.juvenile) : 1,
      scaleB: isHead ? skull * lerp(1, 0.96, shape.juvenile) : 1,
      // Skulls barely change with body mass; torsos are all body mass.
      bulk: isHead ? lerp(1, shape.bulk, 0.18) : shape.bulk,
      offsetScale: isHead ? skull : 1,
    });

    // Shoulder width widens the trapezius yoke, tapering out before the neck
    // so a broad character does not also grow a broad throat.
    const rampIn = clamp01((section.at - 0.3) / 0.26);
    const rampOut = 1 - clamp01((section.at - 0.6) / 0.08);
    const yokePull = rampIn * rampOut;
    const widened: RingShape = {
      ...ringShape,
      radiusA: ringShape.radiusA * lerp(1, shape.yoke, yokePull * 0.85),
    };

    const t = clamp01((y - d.hipsY) / Math.max(d.neckY - d.hipsY, 1e-6));
    const z = -d.hunch * t * t - (isHead ? d.hunch * 0.25 : 0);
    centers.push(new THREE.Vector3(0, y, z));
    shapes.push(widened);
    coats.push(coat);
  }

  // Guarantee the sweep still ascends. A ring that ended up below its
  // predecessor would reverse the local sweep direction and turn the crown
  // inside out — the kind of failure that only appears for one unlucky
  // combination of head scale and bulk, so it is prevented structurally rather
  // than tuned around.
  const top = centers.length - 1;
  const minGap = 0.004 * u;
  for (let i = top - 1; i >= 0; i--) {
    if (centers[i]!.y > centers[i + 1]!.y - minGap) centers[i]!.y = centers[i + 1]!.y - minGap;
  }
  // The crown closes on exactly `headTopY`, so the character stands precisely
  // as tall as `BodyProfile.height` says.
  const poleEnd = Math.max(d.headTopY - centers[top]!.y, 0.002 * u);

  const rings: Ring[] = centers.map((center, i) => ({
    center,
    shape: shapes[i]!,
    skin: evaluateChain(chain, center.y, rig.index),
    v: sections[i]!.v,
    color: coats[i]!.color,
  }));

  return makeStrand('torso', rings, {
    radialSegments: lod.torsoSegments,
    uvRect: UV_REGIONS.body,
    slot: MeshSlot.Skin,
    color: ctx.skinColor,
    frameHint: RIGHT,
    smoothGroup: SMOOTH.body,
    // FLAT at the crotch, not a dome. A pelvis is far wider than the gap
    // between the thighs is tall, so a hemispherical closure would hang below
    // the crotch like a diaper. A flat disc tucked just above where the thighs
    // separate is invisible on every build and cannot invert.
    capStart: 'flat',
    capEnd: 'pole',
    poleEnd,
  });
}

/* ---------------------------------- arm ---------------------------------- */

function armChain(ctx: BodyContext, side: 'Left' | 'Right'): SkinChain {
  const d = ctx.rig.dims;
  const upper = d.upperArm;
  const fore = d.foreArm;
  return {
    spans: [
      { bone: `${side}Shoulder` as BoneName, start: -1e9, end: 0.1 * upper, blend: 0.16 * upper },
      { bone: `${side}Arm` as BoneName, start: 0.1 * upper, end: upper, blend: 0.17 * upper },
      { bone: `${side}ForeArm` as BoneName, start: upper, end: upper + fore, blend: 0.16 * fore },
      { bone: `${side}Hand` as BoneName, start: upper + fore, end: 1e9 },
    ],
    // The inboard rings sit inside the ribcage; without a Spine2 share the
    // shoulder tears open the first time the torso twists.
    bias: [{ bone: 'Spine2', at: -0.3 * upper, range: 0.42 * upper, amount: 0.5 }],
  };
}

/** One arm, deltoid ball to wrist. */
export function buildArmStrand(ctx: BodyContext, side: 'Left' | 'Right'): Strand {
  const { rig, shape, lod, paint } = ctx;
  const d = rig.dims;
  const origin = rig.restPosition[`${side}Arm` as BoneName];
  const dir = d.leftArmDir.clone();
  if (side === 'Right') dir.x *= -1;

  const sections = filterSections(ARM_SECTIONS, lod);
  const chain = armChain(ctx, side);

  const rings: Ring[] = sections.map((section) => {
    const dist = section.at * d.upperArm;
    const coat = paint('arm', section.key, section.at);
    return {
      center: origin.clone().addScaledVector(dir, dist),
      shape: resolveShapeAt(section, shape, coat, {
        unit: d.unit,
        scaleA: 1,
        scaleB: 1,
        bulk: shape.limb,
        offsetScale: 1,
      }),
      skin: evaluateChain(chain, dist, rig.index),
      v: section.v,
      color: coat.color,
    };
  });

  return makeStrand(`arm${side}`, rings, {
    radialSegments: lod.limbSegments,
    uvRect: UV_REGIONS.arm,
    slot: MeshSlot.Skin,
    color: ctx.skinColor,
    // Hints chosen so the ring's B axis points DOWN on both arms, which keeps
    // left and right cross-sections true mirror images.
    frameHint: side === 'Left' ? FORWARD : BACK,
    smoothGroup: SMOOTH.body,
  });
}

/* ---------------------------------- leg ---------------------------------- */

function legChain(ctx: BodyContext, side: 'Left' | 'Right'): SkinChain {
  const d = ctx.rig.dims;
  return {
    spans: [
      { bone: `${side}UpLeg` as BoneName, start: -1e9, end: d.thigh, blend: 0.17 * d.thigh },
      { bone: `${side}Leg` as BoneName, start: d.thigh, end: d.thigh + d.shank, blend: 0.14 * d.shank },
      { bone: `${side}Foot` as BoneName, start: d.thigh + d.shank, end: 1e9 },
    ],
    bias: [{ bone: 'Hips', at: -0.22 * d.thigh, range: 0.36 * d.thigh, amount: 0.6 }],
  };
}

/** One leg, hip ball to ankle. */
export function buildLegStrand(ctx: BodyContext, side: 'Left' | 'Right'): Strand {
  const { rig, shape, lod, paint } = ctx;
  const d = rig.dims;
  const hip = rig.restPosition[`${side}UpLeg` as BoneName];
  const knee = rig.restPosition[`${side}Leg` as BoneName];
  const ankle = rig.restPosition[`${side}Foot` as BoneName];

  const sections = filterSections(LEG_SECTIONS, lod);
  const chain = legChain(ctx, side);

  const rings: Ring[] = sections.map((section) => {
    const dist = section.at * d.thigh;
    const center =
      section.at <= 1
        ? hip.clone().lerp(knee, section.at)
        : knee.clone().lerp(ankle, (dist - d.thigh) / Math.max(d.shank, 1e-6));
    const coat = paint('leg', section.key, section.at);
    return {
      center,
      shape: resolveShapeAt(section, shape, coat, {
        unit: d.unit,
        scaleA: 1,
        scaleB: 1,
        bulk: shape.limb,
        offsetScale: 1,
      }),
      skin: evaluateChain(chain, dist, rig.index),
      v: section.v,
      color: coat.color,
    };
  });

  return makeStrand(`leg${side}`, rings, {
    radialSegments: lod.limbSegments,
    uvRect: UV_REGIONS.leg,
    slot: MeshSlot.Skin,
    color: ctx.skinColor,
    frameHint: LEFT,
    smoothGroup: SMOOTH.body,
  });
}

/* --------------------------------- hands --------------------------------- */

/** Mitten hand: a flattened paddle continuing the arm direction. */
export function buildHandStrand(ctx: BodyContext, side: 'Left' | 'Right'): Strand {
  const { rig, shape, lod, paint } = ctx;
  const d = rig.dims;
  const wrist = rig.restPosition[`${side}Hand` as BoneName];
  const dir = d.leftArmDir.clone();
  if (side === 'Right') dir.x *= -1;

  const sections = filterSections(HAND_SECTIONS, lod);
  const chain: SkinChain = {
    spans: [
      { bone: `${side}Hand` as BoneName, start: -1e9, end: d.hand * 0.5, blend: d.hand * 0.28 },
      { bone: `${side}HandIndex1` as BoneName, start: d.hand * 0.5, end: 1e9 },
    ],
  };

  const rings: Ring[] = sections.map((section) => {
    const coat = paint('hand', section.key, section.at);
    return {
      center: wrist.clone().addScaledVector(dir, section.at * d.hand),
      shape: resolveShapeAt(section, shape, coat, {
        unit: d.unit,
        scaleA: 1,
        scaleB: 1,
        bulk: shape.limb,
        offsetScale: 1,
      }),
      skin: evaluateChain(chain, section.at * d.hand, rig.index),
      v: section.v,
      color: coat.color,
    };
  });

  return makeStrand(`hand${side}`, rings, {
    radialSegments: lod.detailSegments,
    uvRect: UV_REGIONS.extremity,
    slot: MeshSlot.Skin,
    color: ctx.skinColor,
    frameHint: side === 'Left' ? FORWARD : BACK,
    smoothGroup: SMOOTH.hand,
  });
}

/** Thumb stub, angled forward off the palm. */
export function buildThumbStrand(ctx: BodyContext, side: 'Left' | 'Right'): Strand {
  const { rig, shape, lod, paint } = ctx;
  const d = rig.dims;
  const base = rig.restPosition[`${side}HandThumb1` as BoneName];
  const length = d.hand * 0.52;
  const dir = new THREE.Vector3(side === 'Left' ? -0.4 : 0.4, -0.1, -1).normalize();

  const sections = filterSections(THUMB_SECTIONS, lod);
  const chain: SkinChain = {
    spans: [
      { bone: `${side}Hand` as BoneName, start: -1e9, end: length * 0.22, blend: length * 0.2 },
      { bone: `${side}HandThumb1` as BoneName, start: length * 0.22, end: 1e9 },
    ],
  };

  const rings: Ring[] = sections.map((section) => {
    const coat = paint('hand', section.key, section.at);
    return {
      center: base.clone().addScaledVector(dir, section.at * length),
      shape: resolveShapeAt(section, shape, coat, {
        unit: d.unit,
        scaleA: 1,
        scaleB: 1,
        bulk: shape.limb,
        offsetScale: 1,
      }),
      skin: evaluateChain(chain, section.at * length, rig.index),
      v: section.v,
      color: coat.color,
    };
  });

  return makeStrand(`thumb${side}`, rings, {
    radialSegments: Math.max(4, lod.detailSegments - 2),
    uvRect: UV_REGIONS.extremity,
    slot: MeshSlot.Skin,
    color: ctx.skinColor,
    frameHint: RIGHT,
    smoothGroup: SMOOTH.hand,
  });
}

/* ---------------------------------- feet --------------------------------- */

/**
 * Foot, swept forward from the heel.
 *
 * Ring centres are lifted by exactly their own half-height so the sole lands
 * on y=0. Feet define ground contact for the whole game; letting them float or
 * sink by a centimetre is invisible in a turntable and glaring the moment a
 * character walks.
 */
export function buildFootStrand(ctx: BodyContext, side: 'Left' | 'Right'): Strand {
  const { rig, shape, lod, paint } = ctx;
  const d = rig.dims;
  const ankle = rig.restPosition[`${side}Foot` as BoneName];
  const sections = filterSections(FOOT_SECTIONS, lod);

  const chain: SkinChain = {
    spans: [
      { bone: `${side}Foot` as BoneName, start: -1e9, end: d.footForward, blend: 0.4 * d.footForward },
      { bone: `${side}ToeBase` as BoneName, start: d.footForward, end: 1e9 },
    ],
  };

  // A few degrees of toe-out. Feet pointing dead ahead read as a mannequin.
  const toeOut = (side === 'Left' ? -1 : 1) * 0.09;

  const rings: Ring[] = sections.map((section) => {
    const coat = paint('foot', section.key, section.at);
    const ringShape = resolveShapeAt(section, shape, coat, {
      unit: d.unit,
      scaleA: 1,
      scaleB: 1,
      // Feet barely track body mass; a heavy character does not get flippers.
      bulk: 1 + (shape.limb - 1) * 0.45,
      offsetScale: 1,
    });
    const forward = section.at * d.footForward;
    return {
      center: new THREE.Vector3(
        ankle.x + Math.sin(toeOut) * forward,
        ringShape.radiusB,
        ankle.z - Math.cos(toeOut) * forward
      ),
      shape: ringShape,
      skin: evaluateChain(chain, forward, rig.index),
      v: section.v,
      color: coat.color,
    };
  });

  return makeStrand(`foot${side}`, rings, {
    radialSegments: lod.detailSegments,
    uvRect: UV_REGIONS.extremity,
    slot: MeshSlot.Skin,
    color: ctx.skinColor,
    frameHint: LEFT,
    smoothGroup: SMOOTH.foot,
  });
}

/** Exposed so the garment layer can drape off the same numbers. */
export { TORSO_SECTIONS, ARM_SECTIONS, LEG_SECTIONS, filterSections, resolveShapeAt };
export type { ResolveOptions };
