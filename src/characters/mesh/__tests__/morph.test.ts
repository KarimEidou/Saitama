/**
 * MORPH TARGETS AND CROWD VARIATION
 *
 * Morph targets are derived by rebuilding the character with a perturbed
 * profile and subtracting positions. That only works because topology depends
 * exclusively on the LOD and the costume, never on the profile's scalars — so
 * these tests pin that invariant down rather than the deltas themselves.
 *
 * If someone later makes a section count depend on `bulk`, the vertex counts
 * diverge and the build throws instead of silently emitting a garbage morph.
 * The test below is what makes that failure loud.
 */

import { describe, expect, it } from 'vitest';
import { buildHumanoid, CROWD_MORPHS } from '../assemble';
import { buildCivilian, civilianProfile, showcaseBodies } from '../characters';

describe('morph targets', () => {
  it('derives one target per spec, vertex-compatible with the base', () => {
    const recipe = showcaseBodies()[4]!;
    const build = buildHumanoid(recipe.profile, {
      ...recipe.options,
      morphTargets: CROWD_MORPHS,
    });

    const targets = build.geometry.morphAttributes.position;
    expect(targets).toBeDefined();
    expect(targets!).toHaveLength(CROWD_MORPHS.length);
    expect(build.geometry.morphTargetsRelative).toBe(true);

    const base = build.geometry.getAttribute('position');
    for (const target of targets!) {
      expect(target.count).toBe(base.count);
      expect(target.itemSize).toBe(3);
    }
  });

  it('names its targets so three.js can build a dictionary', () => {
    const recipe = showcaseBodies()[4]!;
    const build = buildHumanoid(recipe.profile, {
      ...recipe.options,
      morphTargets: CROWD_MORPHS,
    });
    const names = build.geometry.morphAttributes.position!.map((a) => a.name);
    expect(names).toEqual(CROWD_MORPHS.map((m) => m.name));
    expect(build.morphNames).toEqual(names);
  });

  it('produces deltas that actually move something', () => {
    const recipe = showcaseBodies()[4]!;
    const build = buildHumanoid(recipe.profile, {
      ...recipe.options,
      morphTargets: CROWD_MORPHS,
    });

    build.geometry.morphAttributes.position!.forEach((target, i) => {
      let maxDelta = 0;
      const array = target.array as Float32Array;
      for (let k = 0; k < array.length; k++) maxDelta = Math.max(maxDelta, Math.abs(array[k]!));
      expect(maxDelta, `${CROWD_MORPHS[i]!.name} is inert`).toBeGreaterThan(0.004);
      // A morph that moved the whole body a metre is a bug, not a shape.
      expect(maxDelta).toBeLessThan(0.35);
    });
  });

  it('leaves the base mesh untouched', () => {
    const recipe = showcaseBodies()[4]!;
    const plain = buildHumanoid(recipe.profile, recipe.options);
    const morphed = buildHumanoid(recipe.profile, {
      ...recipe.options,
      morphTargets: CROWD_MORPHS,
    });
    const a = plain.geometry.getAttribute('position').array as Float32Array;
    const b = morphed.geometry.getAttribute('position').array as Float32Array;
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBe(a[i]);
  });

  it('emits no morph attributes when none were asked for', () => {
    const recipe = showcaseBodies()[0]!;
    const build = buildHumanoid(recipe.profile, recipe.options);
    expect(build.geometry.morphAttributes.position).toBeUndefined();
    expect(build.morphNames).toHaveLength(0);
  });
});

describe('procedural civilians', () => {
  it('is deterministic per seed', () => {
    for (const seed of [0, 1, 4242, 987654]) {
      const a = civilianProfile(seed);
      const b = civilianProfile(seed);
      expect(a).toEqual(b);
    }
  });

  it('spreads across archetypes, heights and palettes', () => {
    const archetypes = new Set<string>();
    const skins = new Set<number>();
    const cloths = new Set<number>();
    let minHeight = Infinity;
    let maxHeight = -Infinity;

    for (let seed = 0; seed < 120; seed++) {
      const profile = civilianProfile(seed * 2654435761);
      archetypes.add(profile.archetype);
      skins.add(profile.skinTone!);
      cloths.add(profile.primaryColor!);
      minHeight = Math.min(minHeight, profile.height);
      maxHeight = Math.max(maxHeight, profile.height);
    }

    expect(archetypes.size).toBeGreaterThanOrEqual(3);
    expect(skins.size).toBeGreaterThanOrEqual(5);
    expect(cloths.size).toBeGreaterThanOrEqual(6);
    expect(minHeight).toBeGreaterThanOrEqual(1.05);
    expect(maxHeight).toBeLessThanOrEqual(2.02);
    expect(maxHeight - minHeight).toBeGreaterThan(0.35);
  });

  it('builds a complete civilian from nothing but a seed', () => {
    const build = buildCivilian(7, 0);
    expect(build.stats.bones).toBe(27);
    expect(build.stats.triangles).toBeGreaterThan(1000);
    expect(build.geometry.getAttribute('color')).toBeDefined();
    expect(build.geometry.getAttribute('uv')).toBeDefined();
  });
});
