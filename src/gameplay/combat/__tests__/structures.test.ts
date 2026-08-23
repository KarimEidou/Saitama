/**
 * THE STRUCTURE INDEX — THE PRICE TAG'S DATA SOURCE
 *
 * `sweepCone`, `sweepRadius` and `forecastYen` were covered only indirectly,
 * through the system and resolver tests. They deserve their own file because
 * what they produce is the single number the whole game loop is built around:
 * "how much of City Z am I about to spend", shown live while the punch charges.
 *
 * The first case is the one that matters most. `add()` used to keep the
 * caller's box BY REFERENCE, so a caller filling one scratch `ICombatAabb` and
 * registering a row of buildings from it ended up with N structures that were
 * all the last box — and the symptom is a forecast quoting the wrong price,
 * silently. `ICombatAabb`'s `readonly` fields stop nothing: a mutable object is
 * assignable to it.
 */

import { describe, expect, it } from 'vitest';
import { aabbFromCentre, type ICombatAabb } from '../cone';
import { forecastYen, StructureIndex } from '../structures';
import { ZONING_YEN_PER_KG } from '../tuning';

/** A box a caller can move afterwards — exactly what a scratch box is. */
function mutableBox(): ICombatAabb & { minZ: number; maxZ: number } {
  return { minX: -1, minY: 0, minZ: -21, maxX: 1, maxY: 8, maxZ: -19 };
}

describe('StructureIndex.add', () => {
  it('COPIES the caller box instead of aliasing it', () => {
    const index = new StructureIndex();
    const box = mutableBox();
    index.add({ id: 'a', bounds: box });

    // The caller reuses their scratch box for the next building, 100 m away.
    box.minZ = -121;
    box.maxZ = -119;

    expect(index.get('a')!.bounds.minZ).toBe(-21);
    expect(index.get('a')!.bounds.maxZ).toBe(-19);
    expect(index.get('a')!.bounds).not.toBe(box);

    const swept = index.sweepCone({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 40, 0.4);
    expect(swept.map((s) => s.id)).toEqual(['a']);
  });

  it('fills in the mass and district defaults', () => {
    const index = new StructureIndex();
    const structure = index.add({ id: 'shopfront', bounds: mutableBox() });
    expect(structure.massKg).toBe(240_000);
    expect(structure.district).toBe('residential');
  });

  it('tracks get / remove / size / clear', () => {
    const index = new StructureIndex();
    index.add({ id: 'a', bounds: mutableBox() });
    index.add({ id: 'b', bounds: mutableBox() });
    expect(index.size).toBe(2);

    expect(index.remove('a')).toBe(true);
    expect(index.remove('a')).toBe(false);
    expect(index.get('a')).toBeUndefined();
    expect(index.size).toBe(1);

    index.clear();
    expect(index.size).toBe(0);
    expect(index.get('b')).toBeUndefined();
  });
});

describe('forecastYen', () => {
  it('prices intact mass at the zoning rate of the district it stands in', () => {
    const index = new StructureIndex();
    index.add({ id: 'a', bounds: mutableBox(), massKg: 1000, district: 'downtown' });
    expect(forecastYen([...index.values()])).toBe(1000 * ZONING_YEN_PER_KG.downtown);
  });

  it('prices nothing at nothing', () => {
    expect(forecastYen([])).toBe(0);
  });
});

describe('the sweeps', () => {
  it('sweepCone returns ids sorted ascending, whatever order they registered in', () => {
    // Byte-identical results between runs is the whole point of the sort: the
    // forecast is compared frame to frame and recorded in the replay log.
    const index = new StructureIndex();
    for (const id of ['c', 'a', 'b']) {
      index.add({ id, bounds: aabbFromCentre(0, 6, -20, 6, 6, 4), massKg: 1000 });
    }
    const swept = index.sweepCone({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 40, 0.4);
    expect(swept.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('sweepRadius returns ids sorted ascending too', () => {
    const index = new StructureIndex();
    for (const id of ['c', 'a', 'b']) {
      index.add({ id, bounds: aabbFromCentre(0, 6, -20, 6, 6, 4), massKg: 1000 });
    }
    const swept = index.sweepRadius({ x: 0, y: 1, z: 0 }, 40);
    expect(swept.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('finds nothing when the cone points away from the street', () => {
    const index = new StructureIndex();
    index.add({ id: 'a', bounds: aabbFromCentre(0, 6, -20, 6, 6, 4) });
    expect(index.sweepCone({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 40, 0.4)).toEqual([]);
    expect(index.sweepRadius({ x: 0, y: 1, z: 0 }, 5)).toEqual([]);
  });
});
