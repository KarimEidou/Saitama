/**
 * HAIR — sculpted shells, never strands
 *
 * Strand or card hair is not affordable here: cards need alpha blending (sort
 * order, overdraw, and a second draw call per head on a mobile tiler) and
 * strands need a simulation. Both are the wrong tool for a show whose hair is
 * drawn as flat, hard-edged SHAPES in the first place.
 *
 * So hair is geometry: a scalp shell offset off the skull, plus a handful of
 * tapered LOBES that carry the silhouette. Tatsumaki is the hard case in this
 * game and this is what solves her — her bob is four or five bold curls, and
 * five curved lobes at ~60 triangles each reproduce that read exactly, opaque,
 * in the same draw call as the body.
 *
 * Everything is rigidly weighted to `Head`, which is also what real hair does.
 */

import * as THREE from 'three';
import { TAU, lerp } from '@/util';
import { createRng } from '@/util';
import type { HairSpec, Ring, Strand } from './types';
import { MeshSlot } from './types';
import { UV_REGIONS } from './uv';
import { makeStrand, rigidSkin } from './loft';
import type { BodyContext } from './body';
import { SMOOTH } from './body';
import { sampleStrandAtHeight } from './head';

/**
 * Default hairline height as a fraction of head length above the chin.
 *
 * The brow sits at ~0.57, so every style starts above it: a rotationally
 * symmetric shell has no way to be low at the back and high at the front, so
 * a hairline that dips below the brow buries the face. Styles that should
 * cover more (a bike helmet) pass an explicit `line`.
 */
const HAIRLINE: Readonly<Record<HairSpec['style'], number>> = {
  bald: 1,
  short: 0.7,
  bob: 0.66,
  spiky: 0.68,
  long: 0.64,
};

/**
 * Scalp shell: the skull's own cross-sections pushed out by the hair
 * thickness, capped flat at the hairline and domed over the crown.
 *
 * The shell stops at the skull's own last ring and takes its pole height from
 * the remaining distance, exactly as the head does. Sampling the head above
 * its final ring would return that ring's tiny radius, inflate it, and grow a
 * pointed cap — hair in a party hat.
 */
function buildScalp(ctx: BodyContext, torso: Strand, spec: HairSpec, color: THREE.Color): Strand {
  const d = ctx.rig.dims;
  const length = d.headTopY - d.chinY;
  const thickness = (spec.thickness ?? 0.012) * d.unit * d.headScale;
  const startY = d.chinY + length * (spec.line ?? HAIRLINE[spec.style]);
  const apexY = torso.rings[torso.rings.length - 1]!.center.y;
  const rows = ctx.lod.level === 0 ? 5 : ctx.lod.level === 1 ? 4 : 3;

  const rings: Ring[] = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const y = lerp(startY, apexY, t);
    const head = sampleStrandAtHeight(torso, y);
    const grow = thickness * lerp(1, 0.8, t * t);
    rings.push({
      center: head.center.clone(),
      shape: {
        radiusA: head.shape.radiusA + grow,
        radiusB: head.shape.radiusB + grow,
        exponent: head.shape.exponent,
        offsetB: head.shape.offsetB,
      },
      skin: rigidSkin('Head', ctx.rig.index),
      v: t * 0.5,
      color,
    });
  }

  return makeStrand('hairScalp', rings, {
    radialSegments: ctx.lod.torsoSegments,
    uvRect: UV_REGIONS.hair,
    slot: MeshSlot.Hair,
    color,
    frameHint: new THREE.Vector3(1, 0, 0),
    smoothGroup: SMOOTH.hair,
    capStart: 'flat',
    capEnd: 'pole',
    poleEnd: Math.max(d.headTopY + thickness * 0.8 - apexY, 0.002 * d.unit),
  });
}

interface LobePlan {
  /** Ring parameter around the head; 0 is the back of the skull. */
  readonly around: number;
  /** Height on the skull, as a fraction of head length above the chin. */
  readonly height: number;
  readonly length: number;
  readonly radius: number;
  /** Initial travel direction, relative to the surface normal. */
  readonly droop: number;
  /** Second-order curl; positive flicks the tip outward and up. */
  readonly curl: number;
}

/**
 * One tapered curl.
 *
 * The path is a quadratic: it leaves the scalp along the surface normal biased
 * by `droop`, then bends by `curl`. Two terms is all a bold cartoon curl needs,
 * and a quadratic cannot self-intersect the way a hand-tuned spline can.
 */
function buildLobe(
  ctx: BodyContext,
  torso: Strand,
  plan: LobePlan,
  color: THREE.Color,
  index: number
): Strand {
  const d = ctx.rig.dims;
  const length = d.headTopY - d.chinY;
  const y = d.chinY + length * plan.height;
  const head = sampleStrandAtHeight(torso, y);
  const angle = TAU * plan.around - Math.PI / 2;

  const radial = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle)).normalize();
  const start = new THREE.Vector3(
    head.shape.radiusA * Math.cos(angle) * 0.92,
    y,
    head.center.z - head.shape.radiusB * Math.sin(angle) * 0.92
  );

  const travel = radial
    .clone()
    .multiplyScalar(0.5)
    .add(new THREE.Vector3(0, -plan.droop, 0))
    .normalize();
  // The curl term is mostly OUTWARD. Letting it lift as hard as it splays
  // turns a bob into an umbrella, which is the exact failure this style has to
  // avoid.
  const bend = radial.clone().multiplyScalar(plan.curl).add(new THREE.Vector3(0, plan.curl * 0.3, 0));

  const steps = ctx.lod.level === 0 ? 5 : 4;
  const span = plan.length * d.unit * d.headScale;
  const radius = plan.radius * d.unit * d.headScale;

  const rings: Ring[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const center = start
      .clone()
      .addScaledVector(travel, span * s)
      .addScaledVector(bend, span * s * s);
    // Wide at the root, knife-edged at the tip, and flattened against the
    // skull rather than round: a round lobe reads as a horn, a flattened one
    // reads as a lock of hair.
    const taper = Math.pow(1 - s, 0.7);
    rings.push({
      center,
      shape: {
        radiusA: radius * (0.32 + 0.78 * taper),
        radiusB: radius * (0.24 + 0.62 * taper),
        exponent: 2.3,
      },
      skin: rigidSkin('Head', ctx.rig.index),
      v: 0.5 + s * 0.5,
      color,
    });
  }

  return makeStrand(`hairLobe${index}`, rings, {
    radialSegments: Math.max(5, ctx.lod.detailSegments - 2),
    uvRect: UV_REGIONS.hair,
    slot: MeshSlot.Hair,
    color,
    frameHint: new THREE.Vector3(0, 1, 0),
    smoothGroup: SMOOTH.hair,
    capStart: 'pole',
    capEnd: 'pole',
  });
}

function lobePlans(spec: HairSpec, count: number, seed: number): LobePlan[] {
  const rng = createRng(seed).derive('hair');
  const plans: LobePlan[] = [];
  for (let i = 0; i < count; i++) {
    // Spread across the back and sides; leave the face clear.
    const spread = (i / Math.max(1, count - 1) - 0.5) * 0.82;
    const around = spread + rng.range(-0.02, 0.02);
    switch (spec.style) {
      case 'bob':
        // Roots just above the ear, tips level with the jaw and flicked out.
        plans.push({
          around,
          height: 0.66 + rng.range(-0.02, 0.02),
          length: 0.082,
          radius: 0.026,
          droop: 1.7,
          curl: 0.26 + rng.range(-0.04, 0.04),
        });
        break;
      case 'spiky':
        plans.push({
          around,
          height: 0.86 + rng.range(-0.04, 0.04),
          length: 0.045,
          radius: 0.018,
          droop: -0.8,
          curl: -0.12 + rng.range(-0.06, 0.06),
        });
        break;
      case 'long':
        plans.push({
          around: spread * 0.7,
          height: 0.7,
          length: 0.17,
          radius: 0.019,
          droop: 2.4,
          curl: 0.05,
        });
        break;
      default:
        plans.push({
          around,
          height: 0.76,
          length: 0.028,
          radius: 0.012,
          droop: 0.8,
          curl: 0.1,
        });
        break;
    }
  }
  return plans;
}

/** Every strand making up one head of hair. Empty for `bald`. */
export function buildHair(ctx: BodyContext, torso: Strand, spec: HairSpec): Strand[] {
  if (spec.style === 'bald') return [];
  const color = new THREE.Color(spec.color);
  const strands: Strand[] = [buildScalp(ctx, torso, spec, color)];

  if (ctx.lod.level >= 2) return strands;

  const requested = spec.lobes ?? (spec.style === 'bob' ? 5 : spec.style === 'spiky' ? 7 : 0);
  const count = ctx.lod.level === 0 ? requested : Math.ceil(requested * 0.5);
  if (count <= 0) return strands;

  const seed = ctx.rig.dims.profile.seed ?? 1337;
  lobePlans(spec, count, seed).forEach((plan, i) => {
    strands.push(buildLobe(ctx, torso, plan, color, i));
  });
  return strands;
}
