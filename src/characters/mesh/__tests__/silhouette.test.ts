/**
 * PROPORTIONS AND SILHOUETTE VARIETY
 *
 * Two claims are checked here, and both are things that look fine in a
 * screenshot right up until they are not.
 *
 * HEIGHT IS EXACT. `BodyProfile.height` is a contract — camera framing,
 * collision capsules, cover heights and hit volumes all read it. So a bald
 * character's crown must land on that number, not near it. Hair and helmets
 * legitimately sit above it, which is why the exact check uses a bald build.
 *
 * FEET TOUCH THE GROUND. y=0 is the sole. A character floating or sinking by a
 * centimetre is invisible in a turntable and glaring the moment it walks.
 *
 * SILHOUETTES DIFFER. Bounding boxes are a weak claim — two very different
 * bodies can share one. Sampling width across twelve height bands captures
 * where the mass actually sits, which is what "distinct body types" has to
 * mean if it means anything.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { measureSilhouette, silhouetteDistance } from '../analysis';
import { buildHumanoid, type HumanoidBuild } from '../assemble';
import { buildCharacter, buildCivilian, showcaseBodies } from '../characters';
import type { BodyProfile } from '@/types';

const BALD: BodyProfile = {
  archetype: 'hero',
  height: 1.75,
  shoulderWidth: 1.0,
  bulk: 1.0,
  limbLength: 1.0,
  headScale: 1.0,
  uniformScale: 1,
  seed: 9,
};

/** Bounding box of one named region's own vertices. */
function regionBox(build: HumanoidBuild, name: string): THREE.Box3 {
  const region = build.regions.find((entry) => entry.name === name);
  expect(region, `region ${name}`).toBeDefined();
  const index = build.geometry.getIndex()!;
  const position = build.geometry.getAttribute('position');
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let i = 0; i < region!.indexCount; i++) {
    const vertex = index.getX(region!.indexStart + i);
    box.expandByPoint(point.fromBufferAttribute(position as THREE.BufferAttribute, vertex));
  }
  return box;
}

describe('proportions', () => {
  it('puts the crown exactly on the requested height', () => {
    for (const height of [1.2, 1.55, 1.75, 1.92, 2.4]) {
      const build = buildHumanoid({ ...BALD, height }, { hair: { style: 'bald', color: 0 } });
      const box = build.geometry.boundingBox!;
      expect(box.max.y, `height ${height}`).toBeCloseTo(height, 2);
    }
  });

  it('honours uniformScale on top of height', () => {
    const build = buildHumanoid(
      { ...BALD, height: 1.75, uniformScale: 1.4 },
      { hair: { style: 'bald', color: 0 } }
    );
    expect(build.geometry.boundingBox!.max.y).toBeCloseTo(1.75 * 1.4, 2);
  });

  it('stands the soles on y = 0', () => {
    for (const recipe of showcaseBodies()) {
      const build = buildHumanoid(recipe.profile, recipe.options);
      const min = build.geometry.boundingBox!.min.y;
      expect(min, `${recipe.name} sole`).toBeGreaterThan(-0.002);
      expect(min, `${recipe.name} sole`).toBeLessThan(0.002);
    }
  });

  it('keeps limb-length changes from altering standing height', () => {
    for (const limbLength of [0.85, 1.0, 1.15]) {
      const build = buildHumanoid({ ...BALD, limbLength }, { hair: { style: 'bald', color: 0 } });
      expect(build.geometry.boundingBox!.max.y).toBeCloseTo(1.75, 2);
    }
    // ...but it MUST change the proportions, or the parameter is a no-op.
    // The gain is sub-linear by design: longer legs make the rig taller, and
    // the renormalisation back onto `height` shrinks everything again. A 35%
    // limb increase therefore buys ~17% more thigh and a torso that is
    // correspondingly shorter, which is exactly the leggy silhouette wanted.
    const short = buildHumanoid({ ...BALD, limbLength: 0.85 }).rig.dims;
    const long = buildHumanoid({ ...BALD, limbLength: 1.15 }).rig.dims;
    expect(long.thigh).toBeGreaterThan(short.thigh * 1.12);
    expect(long.hipJointY).toBeGreaterThan(short.hipJointY * 1.08);
    expect(long.headTopY - long.neckY).toBeLessThan(short.headTopY - short.neckY);
  });

  it('mirrors the body about x within a millimetre', () => {
    const build = buildCharacter('saitama', 0);
    const rest = build.rig.restPosition;
    expect(rest.LeftArm.x).toBeCloseTo(-rest.RightArm.x, 6);
    expect(rest.LeftUpLeg.x).toBeCloseTo(-rest.RightUpLeg.x, 6);
    // The character faces -Z, so the character's LEFT is -X.
    expect(rest.LeftArm.x).toBeLessThan(0);
    expect(rest.RightArm.x).toBeGreaterThan(0);
  });

  it('mirrors the MESH of a paired part, not only its bones', () => {
    // Rest bones say nothing about the ring frames the two sides were lofted
    // in: with one shared frame hint the ear frame's B axis comes out down on
    // one side and up on the other, so the table's graduated `offB` droops the
    // left ear and cocks the right one.
    const build = buildCharacter('saitama', 0);
    const left = regionBox(build, 'earLeft');
    const right = regionBox(build, 'earRight');

    expect(left.max.y, 'ear tops').toBeCloseTo(right.max.y, 6);
    expect(left.min.y, 'ear bottoms').toBeCloseTo(right.min.y, 6);
    expect(left.min.z, 'ear depth').toBeCloseTo(right.min.z, 6);
    expect(left.min.x, 'ear reach').toBeCloseTo(-right.max.x, 6);
    expect(left.max.x).toBeLessThan(0);
  });

  it('mirrors the mesh about x, vertex for vertex', () => {
    // Rest bones are four numbers; every asymmetry the generator can actually
    // produce lives in the MESH — a frame hint that is not mirrored between
    // sides, a `sign` applied to a centre but not to an offset, a strand built
    // for one side and copied. Mirroring is guaranteed by construction here
    // (mirrored ring centres, identical shapes, and a ring-parameter sample set
    // that is symmetric under k <-> n-k), so the check can be exact.
    //
    // LOD1 has no ears, nose or thumbs, and `bald` emits no hair lobes — those
    // are the only parts that are legitimately not mirrored (sculpted hair
    // lobes are seeded and asymmetric on purpose).
    const build = buildHumanoid(BALD, { lod: 1, hair: { style: 'bald', color: 0 } });
    const p = build.geometry.getAttribute('position');

    const left: number[][] = [];
    const right: number[][] = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      if (Math.abs(x) < 1e-9) continue; // centre-line vertices are their own mirror
      (x < 0 ? left : right).push([x, p.getY(i), p.getZ(i)]);
    }

    expect(left.length).toBe(right.length);
    expect(left.length).toBeGreaterThan(200);

    // Nearest-neighbour rather than a quantised string key: mirrored
    // coordinates come out of exactly-negating float operations, but a value
    // sitting on a rounding boundary would round in opposite directions on the
    // two sides.
    for (const [x, y, z] of left) {
      let best = Infinity;
      for (const [rx, ry, rz] of right) {
        best = Math.min(best, Math.hypot(rx! + x!, ry! - y!, rz! - z!));
        if (best < 1e-6) break;
      }
      expect(
        best,
        `no mirror for ${x!.toFixed(4)}, ${y!.toFixed(4)}, ${z!.toFixed(4)}`
      ).toBeLessThan(1e-6);
    }
  });

  it('reports the standing height, not the hair', () => {
    // `HumanoidStats.height` is the contract camera framing and collision
    // capsules read; helmets, spikes and horns legitimately sit above the
    // crown, so the bounding box is NOT that number.
    const build = buildCharacter('mumenRider', 0);
    expect(build.stats.height).toBeCloseTo(1.71, 6);
    expect(build.geometry.boundingBox!.max.y).toBeGreaterThan(build.stats.height + 0.005);
  });
});

describe('silhouette variety', () => {
  it('gives seven measurably different showcase bodies', () => {
    const measured = showcaseBodies().map((recipe) => ({
      name: recipe.name,
      silhouette: measureSilhouette(buildHumanoid(recipe.profile, recipe.options).geometry),
    }));
    expect(measured).toHaveLength(7);

    let worst = Number.POSITIVE_INFINITY;
    let worstPair = '';
    for (let i = 0; i < measured.length; i++) {
      for (let j = i + 1; j < measured.length; j++) {
        const distance = silhouetteDistance(measured[i]!.silhouette, measured[j]!.silhouette);
        if (distance < worst) {
          worst = distance;
          worstPair = `${measured[i]!.name} / ${measured[j]!.name}`;
        }
      }
    }
    expect(worst, `closest pair ${worstPair}`).toBeGreaterThan(0.015);
  });

  it('separates heavy from lithe at the waist, not just overall', () => {
    const [heavy, lithe] = [
      buildHumanoid({ ...BALD, archetype: 'heavy', bulk: 1.5 }),
      buildHumanoid({ ...BALD, archetype: 'lithe', bulk: 0.8 }),
    ];
    const a = measureSilhouette(heavy.geometry);
    const b = measureSilhouette(lithe.geometry);
    // Band 4 of 12 is roughly the waist on an adult.
    expect(a.profile[4]!).toBeGreaterThan(b.profile[4]! * 1.25);
  });

  it('varies procedural civilians without a shared template', () => {
    const measured = Array.from({ length: 10 }, (_, i) =>
      measureSilhouette(buildCivilian(i * 6151 + 11, 0).geometry)
    );
    let identical = 0;
    for (let i = 0; i < measured.length; i++) {
      for (let j = i + 1; j < measured.length; j++) {
        if (silhouetteDistance(measured[i]!, measured[j]!) < 0.004) identical++;
      }
    }
    expect(identical).toBe(0);
  });
});
