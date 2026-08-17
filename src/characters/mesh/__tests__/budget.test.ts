/**
 * TRIANGLE BUDGETS AND LOD BEHAVIOUR
 *
 * The budget is not decoration. This game targets mid-tier Android with a
 *街 full of civilians; a character that quietly grows past 4000 triangles
 * multiplies by the crowd size and takes the frame rate with it. So the
 * ceilings are asserted rather than aspired to.
 *
 * The subtler assertion here is that all three LODs share ONE unwrap. Section
 * `v` values are authored (see uv.ts), so dropping a section at a lower LOD
 * cannot slide the texture — which is what lets one atlas serve the whole
 * ladder instead of three.
 */

import { describe, expect, it } from 'vitest';
import {
  BODY_BUDGET,
  buildHumanoid,
  buildHumanoidLODs,
  LOD_BUDGET,
  lodForDistance,
} from '../assemble';
import { buildCivilian, showcaseBodies } from '../characters';
import type { LodLevel } from '../types';

const LODS: readonly LodLevel[] = [0, 1, 2];

describe('triangle budgets', () => {
  for (const lod of LODS) {
    it(`every showcase body fits the LOD${lod} ceiling of ${LOD_BUDGET[lod]}`, () => {
      for (const recipe of showcaseBodies()) {
        const build = buildHumanoid(recipe.profile, { ...recipe.options, lod });
        expect(build.stats.triangles, `${recipe.name} LOD${lod}`).toBeLessThanOrEqual(
          LOD_BUDGET[lod]
        );
        expect(build.stats.triangles).toBeGreaterThan(0);
      }
    });
  }

  it('keeps the naked body inside the tighter body-only budget', () => {
    // This is the number the LOD design actually targets: ~2.6k / ~1.2k / ~400.
    // Everything above it is costume, hair and plating, which a caller chooses.
    for (const lod of LODS) {
      const build = buildHumanoid(showcaseBodies()[0]!.profile, { lod });
      expect(build.stats.triangles, `bare body LOD${lod}`).toBeLessThanOrEqual(BODY_BUDGET[lod]);
    }
  });

  it('keeps procedural civilians inside the LOD0 ceiling', () => {
    for (let seed = 0; seed < 32; seed++) {
      const build = buildCivilian(seed * 31337 + 7, 0);
      expect(build.stats.triangles, `civilian seed ${seed}`).toBeLessThanOrEqual(LOD_BUDGET[0]);
    }
  });

  it('falls monotonically across the ladder', () => {
    const recipe = showcaseBodies()[0]!;
    const [l0, l1, l2] = buildHumanoidLODs(recipe.profile, recipe.options);
    expect(l1.stats.triangles).toBeLessThan(l0.stats.triangles);
    expect(l2.stats.triangles).toBeLessThan(l1.stats.triangles);
    // A ladder that barely decimates is not a ladder.
    expect(l1.stats.triangles).toBeLessThan(l0.stats.triangles * 0.62);
    expect(l2.stats.triangles).toBeLessThan(l1.stats.triangles * 0.45);
  });

  it('reports the same bone count at every LOD', () => {
    const recipe = showcaseBodies()[2]!;
    const builds = buildHumanoidLODs(recipe.profile, recipe.options);
    for (const build of builds) expect(build.stats.bones).toBe(27);
  });

  it('shares one unwrap across the whole ladder', () => {
    const recipe = showcaseBodies()[0]!;
    const builds = buildHumanoidLODs(recipe.profile, recipe.options);

    // The crown survives at every LOD, so the topmost body vertex must land on
    // the same texel row regardless of detail tier.
    const topUV = builds.map((build) => {
      const position = build.geometry.getAttribute('position');
      const uv = build.geometry.getAttribute('uv');
      let best = -Infinity;
      let bestV = 0;
      for (let i = 0; i < position.count; i++) {
        if (position.getY(i) > best) {
          best = position.getY(i);
          bestV = uv.getY(i);
        }
      }
      return bestV;
    });
    expect(topUV[1]).toBeCloseTo(topUV[0]!, 3);
    expect(topUV[2]).toBeCloseTo(topUV[0]!, 3);
  });

  it('maps viewing distance onto the ladder', () => {
    expect(lodForDistance(2)).toBe(0);
    expect(lodForDistance(20)).toBe(1);
    expect(lodForDistance(80)).toBe(2);
  });

  it('emits material groups covering the whole index buffer', () => {
    for (const recipe of showcaseBodies()) {
      const build = buildHumanoid(recipe.profile, recipe.options);
      const groups = build.geometry.groups;
      expect(groups.length).toBeGreaterThan(0);
      let cursor = 0;
      for (const group of groups) {
        expect(group.start).toBe(cursor);
        cursor += group.count;
      }
      // Full coverage matters: with a material ARRAY, three.js draws only the
      // ranges groups name, so a gap would silently delete geometry.
      expect(cursor).toBe(build.geometry.getIndex()!.count);
    }
  });
});
