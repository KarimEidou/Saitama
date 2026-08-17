/**
 * UV ATLAS LAYOUT
 *
 * Every strand is unwrapped cylindrically — u runs around the ring, v runs
 * along the sweep — and that 0..1 square is packed into a rectangle of a
 * single shared atlas. One atlas means one texture bind, which is what lets a
 * crowd of civilians render in one draw call.
 *
 * ── THE SEAM IS AT THE BACK ───────────────────────────────────────────────
 * Ring parameter t=0 sits at -axisB, which for an upright body is directly
 * behind the character (see `evalRingPoint` in loft.ts). The face therefore
 * lands in the MIDDLE of its rectangle instead of being sliced in half. That
 * is the single most important property of this layout, because the face is
 * the only part of a stylised character where texture detail earns its budget.
 *
 * Orientation check for face art: u increases back -> character's RIGHT ->
 * front -> character's LEFT. A viewer facing the character sees the
 * character's right at LOWER u, i.e. on the viewer's left — so a face drawn
 * the way you would draw it on paper maps on unmirrored.
 *
 * ── V IS AUTHORED, NOT ARC-PROPORTIONAL ───────────────────────────────────
 * Each cross-section carries an explicit v. Two reasons: the head gets ~40% of
 * the body rectangle for ~13% of the surface (texel density where it matters),
 * and — more importantly — every LOD lands on the SAME v values, so all three
 * LODs share one texture. Arc-length parameterisation would silently shift the
 * mapping every time a section was dropped.
 *
 * Rectangles are inset by `PADDING` so bilinear filtering and mip generation
 * cannot bleed one region's pixels into its neighbour.
 */

import type { UVRect } from './types';

/** Atlas gutter, in normalised units (~4 px at 1024). */
const PADDING = 0.004;

function rect(u0: number, v0: number, u1: number, v1: number): UVRect {
  return { u0: u0 + PADDING, v0: v0 + PADDING, u1: u1 - PADDING, v1: v1 - PADDING };
}

/** Named atlas regions. */
export const UV_REGIONS = {
  /**
   * Torso, neck and head — one continuous strand, so one rectangle. Occupies
   * the whole top half of the sheet; the face lands in its upper ~40%.
   */
  body: rect(0.0, 0.5, 1.0, 1.0),
  /** Both arms; they are mirror images and share the unwrap. */
  arm: rect(0.0, 0.25, 0.25, 0.5),
  /** Both legs. */
  leg: rect(0.25, 0.25, 0.5, 0.5),
  /** Hands, feet, thumbs, ears, nose. */
  extremity: rect(0.5, 0.25, 0.75, 0.5),
  /** Hair shells and sculpted lobes. */
  hair: rect(0.75, 0.25, 1.0, 0.5),
  /** Cape, coat, skirt. */
  cloth: rect(0.0, 0.0, 0.5, 0.25),
  /** Gloves, boots, belt, collar. */
  trim: rect(0.5, 0.0, 0.75, 0.25),
  /** Mechanical panels and vents. */
  panel: rect(0.75, 0.0, 1.0, 0.25),
} as const;

export type UVRegionName = keyof typeof UV_REGIONS;

/** Map a 0..1 strand-local (u, v) into an atlas rectangle. */
export function packUV(rectangle: UVRect, u: number, v: number, out: [number, number]): void {
  out[0] = rectangle.u0 + (rectangle.u1 - rectangle.u0) * u;
  out[1] = rectangle.v0 + (rectangle.v1 - rectangle.v0) * v;
}

/* -------------------------------------------------------------------------- */
/* Face placement                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Strand-local v of each head landmark, mirroring the cross-section table in
 * body.ts.
 *
 * Published because a face is painted, not modelled: eyes, brows and mouth are
 * texture, and whoever authors that texture (or generates it) needs to know
 * exactly which texel row is the brow. These values are identical across all
 * three LODs by construction — that is the whole reason v is authored rather
 * than derived from arc length.
 */
export const HEAD_LANDMARK_V = {
  chin: 0.585,
  jaw: 0.63,
  mouth: 0.68,
  cheek: 0.725,
  brow: 0.775,
  forehead: 0.82,
  skull: 0.865,
  crown: 0.93,
} as const;

/** Ring parameter of the face centre-line. t=0 is the back of the head. */
export const FACE_CENTER_U = 0.5;

/**
 * Ring parameter offset for a lateral distance on the face, in metres.
 *
 * Near the front of the head the ring's arc speed is 2*PI*radiusA, so a
 * feature `metres` to one side of the centre-line sits this far along in
 * parameter space. Saves every caller from rediscovering the same derivative.
 */
export function faceOffsetU(metres: number, headHalfWidth: number): number {
  return metres / (Math.PI * 2 * Math.max(headHalfWidth, 1e-4));
}

/** Atlas UV for a point on the face, given its ring parameter and landmark v. */
export function faceUV(u: number, v: number): [number, number] {
  const out: [number, number] = [0, 0];
  packUV(UV_REGIONS.body, u, v, out);
  return out;
}
