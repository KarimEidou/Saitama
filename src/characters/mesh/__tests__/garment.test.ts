/**
 * GARMENT DRAPE
 *
 * Cloth is generated from the body's own rings, so it inherits the body's
 * skinning and its manifold guarantees for free — but it also inherits the
 * loft's rules, and both of the pieces that leave the body break one of them
 * if they are authored carelessly.
 *
 * A DRESS reverses its sweep at the hem fold. The loft reads sweep direction
 * from a central difference of ring CENTRES and parallel-transports the ring
 * frame along it, so a reversal flips the frame 180 degrees and mirrors the
 * ring parameter — the hem strip then crosses itself into a bowtie that no
 * topology check notices, because every count stays correct while only the
 * positions go wrong. The fold rings therefore pin their own sweep direction,
 * and that is what this file checks.
 *
 * A CAPE is a genuine parametric surface, so its thickness has to follow a
 * numerically differentiated normal. Forward differences clamp at the far
 * edges, which used to hand the whole trailing column and hem row a fixed
 * fallback normal and turn the shell inside out along them.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BodyProfile } from '@/types';
import { lerp } from '@/util';
import { casualCostume, LOD_SETTINGS, resolvePalette } from '../assemble';
import { buildTorsoStrand, type BodyContext } from '../body';
import { characterRecipe } from '../characters';
import { buildCape, buildDress, ringAtV } from '../garment';
import { loftStrand, MeshBuilder } from '../loft';
import { buildRig } from '../rig';
import { resolveShape } from '../shape';

const HEAVY: BodyProfile = {
  archetype: 'heavy',
  height: 1.74,
  shoulderWidth: 1.12,
  bulk: 1.52,
  limbLength: 0.97,
  headScale: 1.0,
  uniformScale: 1,
  seed: 41,
};

function context(profile: BodyProfile): BodyContext {
  const palette = resolvePalette(profile);
  return {
    rig: buildRig(profile),
    shape: resolveShape(profile),
    lod: LOD_SETTINGS[0],
    paint: casualCostume(palette),
    skinColor: palette.skin,
  };
}

/** Ring angle of a lofted vertex about its own ring centre. */
function ringAngle(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  id: number,
  center: THREE.Vector3
): number {
  return Math.atan2(position.getZ(id) - center.z, position.getX(id) - center.x);
}

describe('dress and skirt', () => {
  it('keeps one ring frame across the hem fold', () => {
    const ctx = context(characterRecipe('tatsumaki').profile);
    const d = ctx.rig.dims;
    const torso = buildTorsoStrand(ctx);
    const skirt = buildDress(ctx, {
      name: 'skirt',
      torso,
      v0: 0.16,
      hemY: lerp(d.hipJointY, d.kneeY, 0.45),
      offset: 0.008 * d.unit,
      flare: 1.22,
      color: new THREE.Color(0x16171b),
    });

    const builder = new MeshBuilder();
    loftStrand(builder, skirt);
    const position = builder.build().geometry.getAttribute('position');

    // Ring rows come first and in order, `radialSegments + 1` vertices each
    // (the last column duplicates the first so u can reach 1).
    const columns = skirt.radialSegments + 1;
    for (let i = 0; i + 1 < skirt.rings.length; i++) {
      for (let k = 0; k < columns; k++) {
        const lo = ringAngle(position, i * columns + k, skirt.rings[i]!.center);
        const hi = ringAngle(position, (i + 1) * columns + k, skirt.rings[i + 1]!.center);
        const delta = Math.abs(((lo - hi + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        // A flipped frame mirrors the ring parameter, so matching columns end
        // up half a turn apart and the quad between them crosses the garment.
        expect(delta, `ring ${i}->${i + 1}, column ${k}`).toBeLessThan(0.35);
      }
    }
  });

  it('carries the belly push forward, not backward, into the cloth', () => {
    const ctx = context(HEAVY);
    const d = ctx.rig.dims;
    const torso = buildTorsoStrand(ctx);
    const skirt = buildDress(ctx, {
      name: 'skirt',
      torso,
      v0: 0.16,
      hemY: lerp(d.hipJointY, d.kneeY, 0.45),
      offset: 0.008 * d.unit,
      flare: 1.22,
      color: new THREE.Color(0x40587e),
    });

    // The torso sweeps up and the dress sweeps down, so their frames' B axes
    // point opposite ways: the same world-space push has OPPOSITE signs.
    const waist = ringAtV(torso, 0.16).shape.offsetB ?? 0;
    expect(waist, 'a heavy build pushes its belly forward').toBeGreaterThan(1e-4);
    expect(skirt.rings[0]!.shape.offsetB ?? 0).toBeCloseTo(-waist, 6);
  });

  it('does not let a coat get shallower as it falls', () => {
    const ctx = context(HEAVY);
    const d = ctx.rig.dims;
    const torso = buildTorsoStrand(ctx);
    const coat = buildDress(ctx, {
      name: 'coat',
      torso,
      v0: 0.34,
      hemY: lerp(d.hipJointY, d.kneeY, 0.6),
      offset: 0.012 * d.unit,
      flare: 1.16,
      color: new THREE.Color(0x40587e),
    });

    // Sampling the reference ring ABOVE the start resolves it to the yoke,
    // whose front-to-back depth is 23% less than the chest's — so the hem drew
    // in instead of draping out.
    const hem = coat.rings[coat.rings.length - 3]!;
    expect(hem.shape.radiusB).toBeGreaterThan(coat.rings[0]!.shape.radiusB);
  });
});

describe('cape', () => {
  it('thickens along the surface normal at every edge', () => {
    const ctx = context(characterRecipe('saitama').profile);
    const d = ctx.rig.dims;
    const torso = buildTorsoStrand(ctx);
    const columns = 9;
    const rows = 8;

    const builder = new MeshBuilder();
    buildCape(ctx, builder, torso, {
      attachV: 0.452,
      hemY: lerp(d.hipsY, d.crotchY, 0.7),
      halfTop: 0.19,
      halfBottom: 0.36,
      flare: 1.68,
      thickness: 0.0045 * d.unit,
      color: new THREE.Color(0xf4f2ea),
      columns,
      rows,
    });
    const position = builder.build().geometry.getAttribute('position');

    // Outer and inner shell vertices alternate, column-major.
    const axisZ = ringAtV(torso, 0.452).center.z;
    const radius = (id: number): number => Math.hypot(position.getX(id), position.getZ(id) - axisZ);

    for (let i = 0; i <= columns; i++) {
      for (let j = 0; j <= rows; j++) {
        const outer = 2 * (i * (rows + 1) + j);
        expect(radius(outer), `column ${i}, row ${j}`).toBeGreaterThan(radius(outer + 1));
      }
    }
  });
});
