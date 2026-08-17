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
import { measureSilhouette, silhouetteDistance } from '../analysis';
import { buildHumanoid } from '../assemble';
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
