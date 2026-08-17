/**
 * HARD SURFACE — the mechanical variant
 *
 * Genos is the character procedural generation is genuinely GOOD at. Organic
 * anatomy punishes a generator for every millimetre it gets wrong; machinery
 * rewards it, because machinery is repetition, symmetry and hard edges — which
 * is precisely what a loop can produce and a human artist finds tedious.
 *
 * Two mechanisms, both riding on the body's own rings:
 *
 *   PANELS  small boxes seated on the surface at a (v, angle) coordinate, with
 *           their own smoothing group so every edge stays razor sharp. 16
 *           triangles each. They inherit the host ring's skin weights, so they
 *           deform with the limb for free.
 *   PROFILE the costume's `Coat.exponent` bumps a cross-section toward a
 *           machined cylinder, so a mechanical forearm is the same table as a
 *           human one with the corners squared off.
 */

import * as THREE from 'three';
import type { HardSurfaceSpec, Ring, Strand } from './types';
import { MeshSlot } from './types';
import { UV_REGIONS } from './uv';
import { evalRingPoint, makeStrand } from './loft';
import type { BodyContext } from './body';
import { SMOOTH } from './body';
import { ringAtV } from './garment';

/** Point, outward normal and surface tangents at a strand's (v, t). */
export interface SurfaceFrame {
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  /** Direction the ring parameter advances in. */
  readonly around: THREE.Vector3;
  /** Direction the strand advances in. */
  readonly along: THREE.Vector3;
  readonly ring: Ring;
}

const _a = new THREE.Vector2();
const _b = new THREE.Vector2();

/**
 * Resolve a surface coordinate on a strand.
 *
 * The ring frame is rebuilt locally from the strand's hint rather than
 * replayed through parallel transport. On the near-straight sections panels
 * are placed on, the two agree to well under a degree, and the alternative is
 * threading transported frames through every consumer.
 */
export function surfaceFrameAt(strand: Strand, v: number, t: number): SurfaceFrame {
  const ring = ringAtV(strand, v);
  const ahead = ringAtV(strand, Math.min(1, v + 0.02));
  const behind = ringAtV(strand, Math.max(0, v - 0.02));

  const axis = ahead.center.clone().sub(behind.center);
  if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
  axis.normalize();

  const axisA = strand.frameHint.clone();
  axisA.addScaledVector(axis, -axisA.dot(axis));
  if (axisA.lengthSq() < 1e-10) axisA.set(axis.y, axis.z, axis.x);
  axisA.normalize();
  const axisB = new THREE.Vector3().crossVectors(axis, axisA);

  evalRingPoint(ring.shape, t, _a);
  evalRingPoint(ring.shape, (t + 0.01) % 1, _b);

  const point = ring.center
    .clone()
    .addScaledVector(axisA, _a.x)
    .addScaledVector(axisB, _a.y);
  const around = axisA
    .clone()
    .multiplyScalar(_b.x - _a.x)
    .addScaledVector(axisB, _b.y - _a.y);
  if (around.lengthSq() < 1e-14) around.copy(axisA);
  around.normalize();

  const normal = new THREE.Vector3().crossVectors(around, axis).normalize();
  // Force the normal outward: the cross product's sign depends on which way
  // the ring parameter runs relative to the sweep.
  const radial = point.clone().sub(ring.center);
  if (normal.dot(radial) < 0) normal.negate();

  return { point, normal, around, along: axis, ring };
}

export interface PanelSpec {
  readonly name: string;
  readonly source: Strand;
  readonly v: number;
  /** Ring parameter, 0 at the back of the body. */
  readonly t: number;
  /** Size across the ring, in metres. */
  readonly width: number;
  /** Size along the strand, in metres. */
  readonly height: number;
  readonly depth: number;
  readonly color: THREE.Color;
  readonly slot?: MeshSlot;
  readonly smoothGroup?: number;
}

/**
 * A rectangular plate seated on the surface.
 *
 * Built as a two-ring loft with a very high superellipse exponent, which is a
 * box with rounded micro-corners — it catches a specular edge highlight that a
 * true box misses, for the same triangle count.
 */
export function buildPanel(ctx: BodyContext, spec: PanelSpec): Strand {
  const frame = surfaceFrameAt(spec.source, spec.v, spec.t);
  const inset = spec.depth * 0.55;

  const shape = {
    radiusA: spec.width * 0.5,
    radiusB: spec.height * 0.5,
    exponent: 7,
  };

  const rings: Ring[] = [
    {
      center: frame.point.clone().addScaledVector(frame.normal, -inset),
      shape,
      skin: frame.ring.skin,
      v: 0,
      color: spec.color,
    },
    {
      center: frame.point.clone().addScaledVector(frame.normal, spec.depth),
      shape: { ...shape, radiusA: shape.radiusA * 0.92, radiusB: shape.radiusB * 0.92 },
      skin: frame.ring.skin,
      v: 1,
      color: spec.color,
    },
  ];

  return makeStrand(spec.name, rings, {
    radialSegments: 4,
    uvRect: UV_REGIONS.panel,
    slot: spec.slot ?? MeshSlot.Metal,
    color: spec.color,
    frameHint: frame.around,
    smoothGroup: spec.smoothGroup ?? SMOOTH.panel,
    capStart: 'flat',
    capEnd: 'flat',
  });
}

export interface PanelBandSpec {
  readonly name: string;
  readonly source: Strand;
  readonly v: number;
  readonly count: number;
  /** Angular coverage as a fraction of the ring; 1 wraps completely. */
  readonly coverage?: number;
  readonly offsetT?: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly color: THREE.Color;
  readonly slot?: MeshSlot;
}

/** A ring of identical plates — armour bands, vent grilles, knuckle guards. */
export function buildPanelBand(ctx: BodyContext, spec: PanelBandSpec): Strand[] {
  const coverage = spec.coverage ?? 1;
  const out: Strand[] = [];
  for (let i = 0; i < spec.count; i++) {
    const t =
      (spec.offsetT ?? 0) + (coverage * (i + 0.5)) / spec.count + (coverage < 1 ? (1 - coverage) / 2 : 0);
    out.push(
      buildPanel(ctx, {
        name: `${spec.name}${i}`,
        source: spec.source,
        v: spec.v,
        t: t % 1,
        width: spec.width,
        height: spec.height,
        depth: spec.depth,
        color: spec.color,
        slot: spec.slot,
        smoothGroup: SMOOTH.panel + i,
      })
    );
  }
  return out;
}

/**
 * The full mechanical dressing for one character.
 *
 * Placement is authored rather than randomised: a vent grille that wanders
 * between builds stops reading as engineering. The only variation comes from
 * the body proportions the panels are seated on.
 */
export function buildHardSurface(
  ctx: BodyContext,
  spec: HardSurfaceSpec,
  strands: { arms: readonly Strand[]; legs: readonly Strand[]; torso: Strand }
): Strand[] {
  if (!ctx.lod.panels) return [];
  const d = ctx.rig.dims;
  const u = d.unit;
  const metal = new THREE.Color(spec.metalColor);
  const vent = new THREE.Color(spec.ventColor);
  const out: Strand[] = [];
  const rows = spec.panelRows ?? 2;
  // Vent grilles and joint rings are millimetre details. Past the hero LOD
  // they cost real triangles and land on a handful of pixels, so only the
  // large plates that still read in silhouette survive.
  const fineDetail = ctx.lod.level === 0;

  if (spec.arms === true) {
    for (const arm of strands.arms) {
      const side = arm.name.endsWith('Left') ? 'L' : 'R';
      // Shoulder cap: one broad plate over the deltoid.
      out.push(
        buildPanel(ctx, {
          name: `pauldron${side}`,
          source: arm,
          v: 0.11,
          t: 0.25,
          width: 0.075 * u,
          height: 0.06 * u,
          depth: 0.012 * u,
          color: metal,
        })
      );
      if (!fineDetail) continue;
      // Forearm vent grille: the signature Genos read.
      for (let r = 0; r < rows; r++) {
        out.push(
          ...buildPanelBand(ctx, {
            name: `vent${side}${r}`,
            source: arm,
            v: 0.64 + r * 0.075,
            count: 4,
            coverage: 0.55,
            offsetT: 0.12,
            width: 0.02 * u,
            height: 0.014 * u,
            depth: 0.006 * u,
            color: vent,
          })
        );
      }
      // Elbow joint ring.
      out.push(
        ...buildPanelBand(ctx, {
          name: `elbow${side}`,
          source: arm,
          v: 0.5,
          count: 4,
          width: 0.022 * u,
          height: 0.03 * u,
          depth: 0.007 * u,
          color: metal,
        })
      );
    }
  }

  if (spec.legs === true) {
    for (const leg of strands.legs) {
      const side = leg.name.endsWith('Left') ? 'L' : 'R';
      out.push(
        buildPanel(ctx, {
          name: `kneeGuard${side}`,
          source: leg,
          v: 0.47,
          t: 0.5,
          width: 0.06 * u,
          height: 0.055 * u,
          depth: 0.012 * u,
          color: metal,
        })
      );
      if (!fineDetail) continue;
      out.push(
        ...buildPanelBand(ctx, {
          name: `shinVent${side}`,
          source: leg,
          v: 0.68,
          count: 3,
          coverage: 0.4,
          offsetT: 0.3,
          width: 0.022 * u,
          height: 0.016 * u,
          depth: 0.006 * u,
          color: vent,
        })
      );
    }
  }

  if (spec.torso === true) {
    out.push(
      buildPanel(ctx, {
        name: 'chestPlate',
        source: strands.torso,
        v: 0.33,
        t: 0.5,
        width: 0.09 * u,
        height: 0.1 * u,
        depth: 0.01 * u,
        color: metal,
      })
    );
    if (!fineDetail) return out;
    out.push(
      ...buildPanelBand(ctx, {
        name: 'backVent',
        source: strands.torso,
        v: 0.28,
        count: 2,
        coverage: 0.22,
        offsetT: 0.89,
        width: 0.03 * u,
        height: 0.05 * u,
        depth: 0.008 * u,
        color: vent,
      })
    );
  }

  return out;
}
