/**
 * ATLAS PACKING — no island may wear another island's paint
 *
 * The generator's unwrap deliberately stacks islands that share a look (both
 * arms, both hands). It also stacks islands that DO NOT share a look: the
 * collar with the boots, the ears with the gloves, Genos' vent grilles with his
 * pauldrons. On a flat white stand-in atlas that is invisible; on a real one
 * the last island baked wins and everything else wears its colours.
 *
 * These tests pin the fix. `findPaintCollisions` reports overlapping islands
 * whose paint differs, and after `prepareRosterGeometry` there must be none —
 * for every character, at every LOD, using the SAME plan, because all three
 * LODs share one texture.
 */

import { describe, expect, it } from 'vitest';
import type { LodLevel } from '@/characters/mesh';
import { UV_REGIONS } from '@/characters/mesh';
import {
  findPaintCollisions,
  measureHead,
  prepareRosterGeometry,
  rectContaining,
} from '../geometry';
import { buildRosterMesh, listRoster, rosterEntry } from '../roster';

const LODS: readonly LodLevel[] = [0, 1, 2];

describe('atlas packing', () => {
  for (const entry of listRoster()) {
    it(`${entry.id} has no conflicting island overlaps after preparation`, () => {
      const build = buildRosterMesh(entry, 0);
      const prepared = prepareRosterGeometry(build);
      expect(prepared.clean).toBe(true);
      expect(
        findPaintCollisions(build),
        `${entry.name} still bakes differently-painted islands on top of one another`
      ).toEqual([]);
      build.geometry.dispose();
    });
  }

  it('finds the collisions it is meant to find, before the fix', () => {
    // Saitama's raw build stacks the collar on the boots and the ears on the
    // gloves. If this ever returns nothing, the detector has stopped working.
    const raw = buildRosterMesh(rosterEntry('chr.saitama'), 0);
    expect(findPaintCollisions(raw).length).toBeGreaterThan(0);
    raw.geometry.dispose();
  });

  it('lands every vertex inside a named rectangle', () => {
    for (const entry of listRoster()) {
      const build = buildRosterMesh(entry, 0);
      prepareRosterGeometry(build);
      const uv = build.geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        expect(rectContaining(u, v, u, v), `${entry.id} vertex ${i} at ${u},${v}`).toBeDefined();
      }
      build.geometry.dispose();
    }
  });

  it('reuses one plan across all three LODs, so one texture serves them all', () => {
    const entry = rosterEntry('chr.saitama');
    const lod0 = buildRosterMesh(entry, 0);
    const plan = prepareRosterGeometry(lod0).plan;

    for (const lod of LODS.slice(1)) {
      const build = buildRosterMesh(entry, lod);
      const prepared = prepareRosterGeometry(build, plan);
      expect(prepared.clean).toBe(true);
      // The cape must land in the same rectangle at every level, or the lower
      // LODs would need their own atlas.
      for (const [name, move] of prepared.plan.moves) {
        const original = plan.moves.get(name);
        if (original !== undefined) expect(move.dest).toEqual(original.dest);
      }
      build.geometry.dispose();
    }
    lod0.geometry.dispose();
  });

  it('moves the cape out of the full-sheet unwrap the generator gives it', () => {
    const build = buildRosterMesh(rosterEntry('chr.saitama'), 0);
    const cape = build.regions.find((region) => region.name === 'cape');
    expect(cape).toBeDefined();
    const prepared = prepareRosterGeometry(build);
    expect(prepared.remapped).toContain('cape');
    expect(prepared.plan.moves.get('cape')?.dest).toEqual(UV_REGIONS.cloth);
    build.geometry.dispose();
  });
});

describe('head measurement', () => {
  it('measures a head from the geometry, and scales with the profile', () => {
    const tatsumaki = buildRosterMesh(rosterEntry('chr.tatsumaki'), 0);
    const king = buildRosterMesh(rosterEntry('chr.deepSeaKing'), 0);
    const small = measureHead(tatsumaki);
    const large = measureHead(king);

    expect(small.halfWidth).toBeGreaterThan(0.05);
    expect(small.halfWidth).toBeLessThan(0.12);
    expect(large.halfWidth).toBeGreaterThan(small.halfWidth * 1.5);
    expect(small.height).toBeGreaterThan(0.1);
    expect(large.height).toBeGreaterThan(small.height);
    // Characters face -Z, so the front of the face is at negative Z.
    expect(small.faceZ).toBeLessThan(0);
    tatsumaki.geometry.dispose();
    king.geometry.dispose();
  });
});
