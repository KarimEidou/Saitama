/**
 * SKINNING CONTRACT
 *
 * The generator's central claim is that skin weights are ANALYTIC — computed
 * from each ring's parametric position along its bone chain rather than
 * painted. That claim is only worth anything if the output actually satisfies
 * the GPU skinning contract, so this file asserts it exhaustively across every
 * character, every LOD and a spread of procedural civilians.
 *
 * On "exactly four influences": four is the width of the `skinIndex` /
 * `skinWeight` attributes, not a requirement that every vertex be pulled by
 * four different bones. A vertex mid-forearm legitimately follows exactly one.
 * What must hold everywhere is: four slots present, weights summing to 1, no
 * negatives, every index in range even when its weight is zero (some mobile
 * drivers sample the bone texture before multiplying), and weights sorted so
 * slot 0 is the dominant bone.
 */

import { describe, expect, it } from 'vitest';
import { analyseSkinning } from '../analysis';
import { buildCharacter, buildCivilian, showcaseBodies } from '../characters';
import { buildHumanoid, CROWD_MORPHS } from '../assemble';
import type { LodLevel } from '../types';

const LODS: readonly LodLevel[] = [0, 1, 2];

describe('skin weights', () => {
  for (const recipe of showcaseBodies()) {
    for (const lod of LODS) {
      it(`${recipe.name} LOD${lod} satisfies the four-influence contract`, () => {
        const build = buildHumanoid(recipe.profile, { ...recipe.options, lod });
        const report = analyseSkinning(build.geometry, build.rig.bones.length);

        expect(report.vertices).toBeGreaterThan(100);
        expect(report.maxWeightError).toBeLessThan(1e-5);
        expect(report.negativeWeights).toBe(0);
        expect(report.outOfRangeIndices).toBe(0);
        expect(report.unsortedVertices).toBe(0);

        const attribute = build.geometry.getAttribute('skinWeight');
        expect(attribute.itemSize).toBe(4);
        expect(build.geometry.getAttribute('skinIndex').itemSize).toBe(4);
      });
    }
  }

  it('binds every vertex to a real bone', () => {
    const build = buildCharacter('saitama', 0);
    const skinIndex = build.geometry.getAttribute('skinIndex');
    const boneCount = build.rig.bones.length;
    for (let i = 0; i < skinIndex.count; i++) {
      for (let k = 0; k < 4; k++) {
        const index = skinIndex.getComponent(i, k);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(boneCount);
      }
    }
  });

  it('blends across joints rather than snapping', () => {
    // If weights were rigid per limb segment, no vertex anywhere would carry
    // two influences. Elbows, knees, waist and neck must produce plenty.
    const build = buildCharacter('saitama', 0);
    const report = analyseSkinning(build.geometry, build.rig.bones.length);
    const blended = report.influenceHistogram[1] + report.influenceHistogram[2] + report.influenceHistogram[3];
    expect(blended).toBeGreaterThan(report.vertices * 0.25);
  });

  it('holds for procedural civilians', () => {
    for (let seed = 0; seed < 24; seed++) {
      const build = buildCivilian(seed * 7919 + 13, 0);
      const report = analyseSkinning(build.geometry, build.rig.bones.length);
      expect(report.ok, `civilian seed ${seed}`).toBe(true);
      expect(report.unsortedVertices).toBe(0);
    }
  });

  it('holds with morph targets attached', () => {
    const recipe = showcaseBodies()[4]!;
    const build = buildHumanoid(recipe.profile, { ...recipe.options, morphTargets: CROWD_MORPHS });
    const report = analyseSkinning(build.geometry, build.rig.bones.length);
    expect(report.ok).toBe(true);
    expect(build.morphNames).toEqual(CROWD_MORPHS.map((m) => m.name));
  });
});
