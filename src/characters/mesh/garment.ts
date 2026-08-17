/**
 * GARMENT LAYER
 *
 * Clothing is generated from the SAME rings as the body underneath it, which
 * is the whole reason it is cheap: a sleeve is the body's own cross-sections
 * pushed out by a few millimetres, so it drapes correctly by construction and
 * inherits the body's analytic skin weights for free. No cloth binding, no
 * weight transfer, no penetration cleanup.
 *
 * ── WHERE THE TRIANGLES GO ────────────────────────────────────────────────
 * A full double-walled jumpsuit shell over torso, arms and legs would roughly
 * double the character. It also would not look any different, because a
 * jumpsuit does not change the silhouette — it changes the COLOUR. So the
 * jumpsuit is a recolour plus ~3% inflation applied to the body itself (see
 * `Coat` in body.ts), and real geometry is spent only where cloth genuinely
 * departs from the body:
 *
 *   SLEEVES  cuffs, collars, belts, glove and boot tops — short tubes with
 *            flat caps, so the rim reads as a hard hem edge.
 *   DRESS    a flared tube with an inward hem fold, for skirts and coats.
 *   CAPE     a thickened sheet that hangs free of the body entirely.
 *
 * Every piece is a closed volume, so the watertight test holds across the
 * whole character rather than only the naked body.
 */

import * as THREE from 'three';
import { clamp01, lerp } from '@/util';
import type { LodSettings, Ring, RingShape, Strand } from './types';
import { MeshSlot } from './types';
import { UV_REGIONS } from './uv';
import { MeshBuilder, blendSkin, evaluateChain, makeStrand } from './loft';
import type { BodyContext } from './body';
import { SMOOTH } from './body';

/* -------------------------------------------------------------------------- */
/* Ring slicing                                                               */
/* -------------------------------------------------------------------------- */

function lerpShape(a: RingShape, b: RingShape, t: number): RingShape {
  const mix = (x: number | undefined, y: number | undefined, fallback: number): number =>
    lerp(x ?? fallback, y ?? fallback, t);
  return {
    radiusA: lerp(a.radiusA, b.radiusA, t),
    radiusB: lerp(a.radiusB, b.radiusB, t),
    exponent: mix(a.exponent, b.exponent, 2),
    frontScale: mix(a.frontScale, b.frontScale, 1),
    backScale: mix(a.backScale, b.backScale, 1),
    offsetA: mix(a.offsetA, b.offsetA, 0),
    offsetB: mix(a.offsetB, b.offsetB, 0),
  };
}

/** Interpolate a whole ring, skin weights included. */
export function lerpRing(a: Ring, b: Ring, t: number): Ring {
  return {
    center: a.center.clone().lerp(b.center, t),
    shape: lerpShape(a.shape, b.shape, t),
    skin: blendSkin(a.skin, b.skin, t),
    v: lerp(a.v, b.v, t),
    color: a.color,
  };
}

/** Sample a strand at texture parameter `v`. */
export function ringAtV(strand: Strand, v: number): Ring {
  const rings = strand.rings;
  if (v <= rings[0]!.v) return rings[0]!;
  for (let i = 1; i < rings.length; i++) {
    const hi = rings[i]!;
    if (v <= hi.v) {
      const lo = rings[i - 1]!;
      const span = hi.v - lo.v;
      return lerpRing(lo, hi, span <= 1e-9 ? 0 : (v - lo.v) / span);
    }
  }
  return rings[rings.length - 1]!;
}

/**
 * The rings of `strand` between v0 and v1, with exact rings inserted at both
 * ends so a garment edge lands where it was asked for rather than snapping to
 * whichever body section happened to survive the current LOD.
 */
export function sliceRings(strand: Strand, v0: number, v1: number): Ring[] {
  const out: Ring[] = [ringAtV(strand, v0)];
  for (const ring of strand.rings) {
    if (ring.v > v0 + 1e-4 && ring.v < v1 - 1e-4) out.push(ring);
  }
  out.push(ringAtV(strand, v1));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Sleeves: cuffs, collars, belts, boot and glove tops                        */
/* -------------------------------------------------------------------------- */

export interface SleeveSpec {
  readonly name: string;
  /** Source strand the sleeve wraps. */
  readonly source: Strand;
  readonly v0: number;
  readonly v1: number;
  /** Radial offset from the body, in metres. */
  readonly offset: number;
  /** Offset at the far end, when the piece tapers. Defaults to `offset`. */
  readonly offsetEnd?: number;
  readonly color: THREE.Color;
  readonly slot?: MeshSlot;
  /** Extra radial multiplier, for flared boot tops and gauntlet cuffs. */
  readonly flare?: number;
}

/**
 * A short tube riding on the body.
 *
 * Both ends are FLAT-capped. The cap disc is mostly buried inside the limb;
 * only the annulus between limb and cuff is visible, and because flat caps get
 * their own smoothing group it reads as a crisp hem rather than a smear.
 */
export function buildSleeve(ctx: BodyContext, spec: SleeveSpec): Strand {
  const source = spec.source;
  const slice = sliceRings(source, spec.v0, spec.v1);
  const span = Math.max(spec.v1 - spec.v0, 1e-6);
  const flare = spec.flare ?? 1;

  const rings: Ring[] = slice.map((ring) => {
    const t = clamp01((ring.v - spec.v0) / span);
    const offset = lerp(spec.offset, spec.offsetEnd ?? spec.offset, t);
    const scale = lerp(1, flare, t);
    return {
      center: ring.center.clone(),
      shape: {
        ...ring.shape,
        radiusA: (ring.shape.radiusA + offset) * scale,
        radiusB: (ring.shape.radiusB + offset) * scale,
      },
      skin: ring.skin,
      v: t,
      color: spec.color,
    };
  });

  return makeStrand(spec.name, rings, {
    radialSegments: source.radialSegments,
    uvRect: UV_REGIONS.trim,
    slot: spec.slot ?? MeshSlot.Accent,
    color: spec.color,
    frameHint: source.frameHint,
    smoothGroup: SMOOTH.garment,
    capStart: 'flat',
    capEnd: 'flat',
  });
}

/* -------------------------------------------------------------------------- */
/* Dresses, skirts and coat skirts                                            */
/* -------------------------------------------------------------------------- */

export interface DressSpec {
  readonly name: string;
  readonly torso: Strand;
  /** Torso v where the garment starts. */
  readonly v0: number;
  /** Absolute model-space Y of the hem. */
  readonly hemY: number;
  readonly offset: number;
  /** Radial multiplier at the hem. >1 flares, <1 is a pencil silhouette. */
  readonly flare: number;
  readonly color: THREE.Color;
  readonly slot?: MeshSlot;
  readonly rows?: number;
}

/**
 * A tube from the torso down past the hem, with an inward fold at the bottom.
 *
 * The fold matters: without it the hem is a flat disc and the garment reads as
 * a solid bell. Folding two rings back up and inward gives a visible lining
 * edge and hides the cap inside the skirt, for four extra rings of cost.
 */
export function buildDress(ctx: BodyContext, spec: DressSpec): Strand {
  const d = ctx.rig.dims;
  const waist = ringAtV(spec.torso, spec.v0);
  const hip = ringAtV(spec.torso, Math.min(spec.v0 + 0.12, 0.9));
  const rows = spec.rows ?? (ctx.lod.level === 0 ? 4 : 3);
  const chain = {
    spans: [
      { bone: 'Hips' as const, start: -1e9, end: 1e9 },
    ],
  };

  const topY = waist.center.y;
  const rings: Ring[] = [];
  const widest = Math.max(waist.shape.radiusA, hip.shape.radiusA);

  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const y = lerp(topY, spec.hemY, t);
    const scale = lerp(1, spec.flare, t * t);
    rings.push({
      center: new THREE.Vector3(0, y, lerp(waist.center.z, waist.center.z * 0.7, t)),
      shape: {
        radiusA: (lerp(waist.shape.radiusA, widest, t) + spec.offset) * scale,
        radiusB: (lerp(waist.shape.radiusB, hip.shape.radiusB, t) + spec.offset) * scale,
        exponent: lerp(waist.shape.exponent ?? 2, 2.4, t),
        offsetB: lerp(waist.shape.offsetB ?? 0, 0, t),
      },
      skin: i === 0 ? waist.skin : blendSkin(waist.skin, evaluateChain(chain, 0, ctx.rig.index), t * 0.85),
      v: t * 0.82,
      color: spec.color,
    });
  }

  // Hem fold: back up and inward, ending narrow enough to cap out of sight.
  const hem = rings[rings.length - 1]!;
  const fold = 0.03 * d.unit;
  rings.push({
    center: new THREE.Vector3(hem.center.x, hem.center.y + fold * 0.35, hem.center.z),
    shape: {
      radiusA: hem.shape.radiusA * 0.86,
      radiusB: hem.shape.radiusB * 0.86,
      exponent: hem.shape.exponent,
    },
    skin: hem.skin,
    v: 0.92,
    color: spec.color,
  });
  rings.push({
    center: new THREE.Vector3(hem.center.x, hem.center.y + fold * 1.5, hem.center.z),
    shape: {
      radiusA: hem.shape.radiusA * 0.72,
      radiusB: hem.shape.radiusB * 0.72,
      exponent: hem.shape.exponent,
    },
    skin: hem.skin,
    v: 1.0,
    color: spec.color,
  });

  return makeStrand(spec.name, rings, {
    radialSegments: spec.torso.radialSegments,
    uvRect: UV_REGIONS.cloth,
    slot: spec.slot ?? MeshSlot.Cloth,
    color: spec.color,
    frameHint: spec.torso.frameHint,
    smoothGroup: SMOOTH.garment,
    capStart: 'flat',
    capEnd: 'flat',
  });
}

/* -------------------------------------------------------------------------- */
/* Cape                                                                       */
/* -------------------------------------------------------------------------- */

export interface CapeSpec {
  /** Torso v where the cape hangs from. */
  readonly attachV: number;
  /** Absolute model-space Y of the hem. */
  readonly hemY: number;
  /** Half angular coverage at the top, as a ring parameter (0.25 = 90 deg). */
  readonly halfTop: number;
  readonly halfBottom: number;
  /** Radial multiplier at the hem; >1 lets the cape flare away from the legs. */
  readonly flare: number;
  readonly thickness: number;
  readonly color: THREE.Color;
  readonly columns?: number;
  readonly rows?: number;
}

const _tangentI = new THREE.Vector3();
const _tangentJ = new THREE.Vector3();
const _normal = new THREE.Vector3();

/**
 * A thickened sheet hanging off the shoulders.
 *
 * Unlike sleeves, a cape leaves the body, so it cannot be a scaled body ring —
 * it is a genuine parametric surface: angular coverage widens with height, the
 * radius flares, and the whole sheet drifts backwards so it clears the legs.
 *
 * It is skinned to the spine chain sampled at a height that slides from the
 * shoulders toward the hips as the cape descends. That is not cloth
 * simulation, but it does mean the hem trails the chest instead of welding to
 * it, which is most of what sells a cape in motion.
 */
export function buildCape(
  ctx: BodyContext,
  builder: MeshBuilder,
  torso: Strand,
  spec: CapeSpec
): void {
  const d = ctx.rig.dims;
  const lod = ctx.lod;
  const columns = spec.columns ?? (lod.level === 0 ? 9 : lod.level === 1 ? 7 : 5);
  const rows = spec.rows ?? (lod.level === 0 ? 8 : lod.level === 1 ? 5 : 3);

  const attach = ringAtV(torso, spec.attachV);
  const shoulderSkin = attach.skin;
  const hipRing = ringAtV(torso, 0.07);

  const axisA = new THREE.Vector3(1, 0, 0);
  const axisB = new THREE.Vector3(0, 0, -1);

  // Mid-surface sample.
  const point = (u: number, v: number, out: THREE.Vector3): THREE.Vector3 => {
    const half = lerp(spec.halfTop, spec.halfBottom, v * v);
    const t = lerp(-half, half, u);
    const y = lerp(attach.center.y, spec.hemY, v);
    const scale = lerp(1.04, spec.flare, v * v);
    const ra = attach.shape.radiusA * scale;
    const rb = attach.shape.radiusB * scale;
    const angle = Math.PI * 2 * t - Math.PI / 2;
    const z = lerp(attach.center.z, attach.center.z + 0.02 * d.unit, v);
    return out
      .set(0, y, z)
      .addScaledVector(axisA, ra * Math.cos(angle))
      .addScaledVector(axisB, rb * Math.sin(angle));
  };

  const mid = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const outer: number[][] = [];
  const inner: number[][] = [];
  const p = new THREE.Vector3();

  const capeSkinAt = (v: number): typeof shoulderSkin =>
    blendSkin(shoulderSkin, hipRing.skin, clamp01(v * 0.75));

  for (let i = 0; i <= columns; i++) {
    const colOuter: number[] = [];
    const colInner: number[] = [];
    const u = i / columns;
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      point(u, v, mid);
      point(Math.min(1, u + 1e-3), v, a);
      point(u, Math.min(1, v + 1e-3), b);
      _tangentI.subVectors(a, mid);
      _tangentJ.subVectors(b, mid);
      _normal.crossVectors(_tangentI, _tangentJ).normalize().negate();
      if (!Number.isFinite(_normal.x) || _normal.lengthSq() < 0.5) _normal.set(0, 0, 1);

      const skin = capeSkinAt(v);
      p.copy(mid).addScaledVector(_normal, spec.thickness);
      colOuter.push(builder.addVertex(p, u, v * 0.5, spec.color, skin, SMOOTH.garment));
      p.copy(mid).addScaledVector(_normal, -spec.thickness);
      colInner.push(builder.addVertex(p, u, 0.5 + v * 0.5, spec.color, skin, SMOOTH.garment));
    }
    outer.push(colOuter);
    inner.push(colInner);
  }

  builder.beginRegion('cape', MeshSlot.Cloth);

  for (let i = 0; i < columns; i++) {
    for (let j = 0; j < rows; j++) {
      builder.addQuad(outer[i]![j]!, outer[i]![j + 1]!, outer[i + 1]![j + 1]!, outer[i + 1]![j]!);
      builder.addQuad(inner[i]![j]!, inner[i + 1]![j]!, inner[i + 1]![j + 1]!, inner[i]![j + 1]!);
    }
  }

  // Rim: four strips closing the sheet into a solid. Shares the sheet's
  // vertices, so the fold is soft — at 7 mm thickness a hard crease would only
  // alias.
  for (let i = 0; i < columns; i++) {
    builder.addQuad(outer[i]![0]!, outer[i + 1]![0]!, inner[i + 1]![0]!, inner[i]![0]!);
    builder.addQuad(outer[i]![rows]!, inner[i]![rows]!, inner[i + 1]![rows]!, outer[i + 1]![rows]!);
  }
  for (let j = 0; j < rows; j++) {
    builder.addQuad(outer[0]![j]!, inner[0]![j]!, inner[0]![j + 1]!, outer[0]![j + 1]!);
    builder.addQuad(outer[columns]![j]!, outer[columns]![j + 1]!, inner[columns]![j + 1]!, inner[columns]![j]!);
  }

  builder.endRegion();
}

/* -------------------------------------------------------------------------- */
/* LOD gating                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whether a garment piece survives at this LOD.
 *
 * SILHOUETTE pieces (cape, coat, skirt) survive everywhere: losing a cape at
 * distance is a visible pop, because a cape is most of the shape.
 *
 * TRIM (cuffs, collars, belts, boot tops) is hero-LOD only. Those pieces stand
 * a few millimetres off the body and their COLOUR is already carried by the
 * body's own vertex colours, so dropping them past 12 m costs nothing visible
 * and buys back a third of the LOD1 budget.
 */
export function garmentAllowed(lod: LodSettings, kind: 'silhouette' | 'trim'): boolean {
  if (!lod.garments) return false;
  return kind === 'silhouette' || lod.level === 0;
}
