/**
 * HEAD DETAILING — ears and nose
 *
 * The skull itself is the top of the torso strand (see body.ts). What is left
 * is the two features that do the most work per triangle on a stylised head.
 *
 * EARS are worth ~50 triangles each because they are what tells a viewer that
 * a smooth ovoid is a head at all. Without them a bald character — which
 * Saitama is — reads as an egg on a stick from every angle except dead front.
 *
 * The NOSE is deliberately tiny. One Punch Man's line art gives Saitama barely
 * a nose at all, and a procedurally generated realistic nose at this budget
 * looks worse than none. A 4 mm wedge catches a highlight and stops the
 * profile silhouette from being a perfect arc, which is the whole job.
 *
 * Both attach with rigid `Head` weights: they are bone-rigid in reality too.
 */

import * as THREE from 'three';
import { clamp01 } from '@/util';
import type { LodSettings, Ring, RingShape, Strand } from './types';
import { MeshSlot } from './types';
import { UV_REGIONS } from './uv';
import { makeStrand, rigidSkin } from './loft';
import type { BodyContext } from './body';
import { SMOOTH } from './body';

/** Interpolate a strand's cross-section at an arbitrary height. */
export function sampleStrandAtHeight(
  strand: Strand,
  y: number
): { center: THREE.Vector3; shape: RingShape } {
  const rings = strand.rings;
  let lo = rings[0]!;
  let hi = rings[rings.length - 1]!;
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i]!;
    const b = rings[i + 1]!;
    if (y >= a.center.y && y <= b.center.y) {
      lo = a;
      hi = b;
      break;
    }
  }
  const span = hi.center.y - lo.center.y;
  const t = span <= 1e-9 ? 0 : clamp01((y - lo.center.y) / span);
  const mix = (a: number | undefined, b: number | undefined, fallback: number): number =>
    (a ?? fallback) + ((b ?? fallback) - (a ?? fallback)) * t;

  return {
    center: lo.center.clone().lerp(hi.center, t),
    shape: {
      radiusA: mix(lo.shape.radiusA, hi.shape.radiusA, 0),
      radiusB: mix(lo.shape.radiusB, hi.shape.radiusB, 0),
      exponent: mix(lo.shape.exponent, hi.shape.exponent, 2),
      offsetB: mix(lo.shape.offsetB, hi.shape.offsetB, 0),
    },
  };
}

/**
 * Ear cross-sections. `at` is outward travel in normalised units.
 *
 * Sized from life: an ear is ~6 cm tall, ~3 cm front-to-back, and stands off
 * the skull by little more than a centimetre. Getting that last number wrong is
 * what makes procedural heads look like they have handles.
 */
const EAR_SECTIONS: readonly { at: number; a: number; b: number; offB: number; v: number }[] = [
  { at: 0.0, a: 0.005, b: 0.009, offB: 0.0, v: 0.0 },
  { at: 0.0045, a: 0.008, b: 0.016, offB: 0.001, v: 0.35 },
  { at: 0.0085, a: 0.007, b: 0.014, offB: 0.0015, v: 0.7 },
  { at: 0.0115, a: 0.003, b: 0.006, offB: 0.002, v: 0.95 },
];

/**
 * One ear: a flattened lobe pushed out of the side of the skull.
 *
 * It starts INSIDE the head (at 86% of the skull's half-width) so the two
 * volumes interpenetrate and there is no seam to hide, which is the whole
 * reason parts of this generator are separate closed shells rather than one
 * stitched surface.
 */
export function buildEarStrand(
  ctx: BodyContext,
  torso: Strand,
  side: 'Left' | 'Right'
): Strand | undefined {
  if (!ctx.lod.ears) return undefined;
  const d = ctx.rig.dims;
  const u = d.unit;
  const headLength = d.headTopY - d.chinY;
  const earY = d.chinY + headLength * 0.55;
  const head = sampleStrandAtHeight(torso, earY);
  const sign = side === 'Left' ? -1 : 1;
  const skull = d.headScale;

  const rings: Ring[] = EAR_SECTIONS.map((section) => ({
    center: new THREE.Vector3(
      sign * (head.shape.radiusA * 0.93 + section.at * u * skull),
      earY,
      head.center.z - 0.008 * u * skull
    ),
    shape: {
      radiusA: section.a * u * skull,
      radiusB: section.b * u * skull,
      exponent: 2.1,
      offsetB: section.offB * u * skull,
    },
    skin: rigidSkin('Head', ctx.rig.index),
    v: section.v,
  }));

  return makeStrand(`ear${side}`, rings, {
    radialSegments: Math.max(5, ctx.lod.detailSegments - 2),
    uvRect: UV_REGIONS.extremity,
    slot: MeshSlot.Skin,
    color: ctx.skinColor,
    frameHint: new THREE.Vector3(0, 0, -1),
    smoothGroup: SMOOTH.ear,
  });
}

/**
 * Nose cross-sections, swept forward from inside the face.
 *
 * Deliberately tiny. One Punch Man draws Saitama with almost no nose at all,
 * and a procedurally generated realistic nose at this triangle budget looks
 * worse than none. ~2.5 cm wide and standing 1.3 cm off the face is enough to
 * catch a highlight and break the profile arc, which is the entire job.
 */
const NOSE_SECTIONS: readonly { at: number; a: number; b: number; offB: number; v: number }[] = [
  { at: -0.01, a: 0.006, b: 0.005, offB: 0.0, v: 0.0 },
  { at: 0.0, a: 0.0075, b: 0.006, offB: 0.0015, v: 0.45 },
  { at: 0.007, a: 0.004, b: 0.0035, offB: 0.003, v: 0.9 },
];

/** A small wedge on the face centre-line, swept forward. */
export function buildNoseStrand(
  ctx: BodyContext,
  torso: Strand,
  faceZ: number
): Strand | undefined {
  if (!ctx.lod.nose) return undefined;
  const d = ctx.rig.dims;
  const u = d.unit;
  const skull = d.headScale;
  const headLength = d.headTopY - d.chinY;
  // 0.36 of head height, which puts the nose BELOW the eye line (~0.48). The
  // eye line is not the middle of a head; it only feels like it.
  const noseY = d.chinY + headLength * 0.36;
  const head = sampleStrandAtHeight(torso, noseY);
  // The torso frame's B axis points FORWARD (-Z), so the face surface sits at
  // centre.z - (radiusB + offsetB).
  const front = head.center.z - (head.shape.offsetB ?? 0) - head.shape.radiusB + faceZ;

  const rings: Ring[] = NOSE_SECTIONS.map((section) => ({
    center: new THREE.Vector3(0, noseY, front - section.at * u * skull),
    shape: {
      radiusA: section.a * u * skull,
      radiusB: section.b * u * skull,
      exponent: 2.2,
      offsetB: section.offB * u * skull,
    },
    skin: rigidSkin('Head', ctx.rig.index),
    v: section.v,
  }));

  return makeStrand('nose', rings, {
    radialSegments: Math.max(5, ctx.lod.detailSegments - 2),
    uvRect: UV_REGIONS.extremity,
    slot: MeshSlot.Skin,
    color: ctx.skinColor,
    frameHint: new THREE.Vector3(1, 0, 0),
    smoothGroup: SMOOTH.nose,
  });
}

/** Head landmark heights, for hair and headgear. */
export function headMetrics(lod: LodSettings, ctx: BodyContext): {
  chinY: number;
  topY: number;
  length: number;
  browY: number;
  crownY: number;
} {
  const d = ctx.rig.dims;
  const length = d.headTopY - d.chinY;
  return {
    chinY: d.chinY,
    topY: d.headTopY,
    length,
    browY: d.chinY + length * 0.62,
    crownY: d.chinY + length * 0.9,
  };
}
