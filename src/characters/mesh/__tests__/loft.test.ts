/**
 * LOFT SAMPLING AND CAPS
 *
 * Two properties of the lofting core that nothing else in the suite can see,
 * because both fail silently — the counts stay right and only the surface goes
 * wrong.
 *
 * WHICH POINTS EXIST. The ring parameter samples at `k / segments`, which lands
 * on the four axis extremes when there are four of them — and every
 * superellipse touches its bounding box exactly there, whatever its exponent.
 * A four-segment plate is therefore a rhombus of half the requested area
 * unless the samples are offset onto the corners.
 *
 * CAPS MATCH THEIR RIM. A flat cap duplicates the strand's own rim and relies
 * on the two copies being bit-identical in position, so the weld collapses
 * them and the surface stays closed. Deriving the cap from a different frame
 * than the surface used — by ignoring `Ring.roll`, say — opens a hole ringing
 * the cap that reads as a tear rather than a compile error.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { analyseTopology } from '../analysis';
import { casualCostume, LOD_SETTINGS, resolvePalette } from '../assemble';
import { buildArmStrand, SMOOTH, type BodyContext } from '../body';
import { characterRecipe } from '../characters';
import { buildPanel } from '../hardsurface';
import { loftStrand, makeStrand, MeshBuilder } from '../loft';
import { buildRig } from '../rig';
import { resolveShape } from '../shape';
import { MeshSlot, type Ring, type SkinWeight4 } from '../types';
import { UV_REGIONS } from '../uv';

const RIGID: SkinWeight4 = { index: [0, 0, 0, 0], weight: [1, 0, 0, 0] };

function context(): BodyContext {
  const profile = characterRecipe('genos').profile;
  const palette = resolvePalette(profile);
  return {
    rig: buildRig(profile),
    shape: resolveShape(profile),
    lod: LOD_SETTINGS[0],
    paint: casualCostume(palette),
    skinColor: palette.skin,
  };
}

/** Area of a planar quadrilateral from its four corners, in order. */
function quadArea(corners: readonly THREE.Vector3[]): number {
  const d0 = corners[2]!.clone().sub(corners[0]!);
  const d1 = corners[3]!.clone().sub(corners[1]!);
  return d0.cross(d1).length() * 0.5;
}

describe('loft sampling', () => {
  it('gives a hard-surface panel its full rectangular footprint', () => {
    const ctx = context();
    const u = ctx.rig.dims.unit;
    const width = 0.075 * u;
    const height = 0.06 * u;
    const panel = buildPanel(ctx, {
      name: 'pauldron',
      source: buildArmStrand(ctx, 'Left'),
      v: 0.11,
      t: 0.25,
      width,
      height,
      depth: 0.012 * u,
      color: new THREE.Color(0x98a2ad),
    });

    const builder = new MeshBuilder();
    loftStrand(builder, panel);
    const position = builder.build().geometry.getAttribute('position');

    const corners = [0, 1, 2, 3].map((k) =>
      new THREE.Vector3().fromBufferAttribute(position as THREE.BufferAttribute, k)
    );
    // A rhombus through the axis extremes covers exactly half the plate; the
    // exponent-7 corners cover ~82% of it.
    expect(quadArea(corners)).toBeGreaterThan(width * height * 0.7);
    expect(quadArea(corners)).toBeLessThanOrEqual(width * height);
  });
});

describe('flat caps', () => {
  it('stays closed when the capped ring carries a roll', () => {
    const rings: Ring[] = [
      {
        center: new THREE.Vector3(0, 0, 0),
        shape: { radiusA: 0.06, radiusB: 0.04, exponent: 2.4 },
        skin: RIGID,
        v: 0,
        roll: 0.2,
      },
      {
        center: new THREE.Vector3(0, 0.12, 0),
        shape: { radiusA: 0.055, radiusB: 0.038, exponent: 2.4 },
        skin: RIGID,
        v: 1,
      },
    ];

    const builder = new MeshBuilder();
    loftStrand(
      builder,
      makeStrand('rolled', rings, {
        radialSegments: 8,
        uvRect: UV_REGIONS.trim,
        slot: MeshSlot.Accent,
        color: new THREE.Color(0xffffff),
        frameHint: new THREE.Vector3(1, 0, 0),
        smoothGroup: SMOOTH.garment,
        capStart: 'flat',
        capEnd: 'flat',
      })
    );

    const report = analyseTopology(builder.build().geometry);
    expect(report.boundaryEdges, 'hole around the rolled cap').toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.watertight).toBe(true);
  });
});
