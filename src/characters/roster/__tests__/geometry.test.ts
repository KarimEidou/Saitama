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
  type AtlasPlan,
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
    for (const entry of listRoster()) {
      const lod0 = buildRosterMesh(entry, 0);
      const plan = prepareRosterGeometry(lod0).plan;

      for (const lod of LODS.slice(1)) {
        const build = buildRosterMesh(entry, lod);
        const prepared = prepareRosterGeometry(build, plan);
        expect(prepared.clean).toBe(true);
        // The atlas was rasterised from the LOD0 layout, so a lower LOD may not
        // add moves of its own — decimation shifts a region's mean colour and
        // can make a rectangle look shared that was not, which would squeeze
        // the island into a sub-cell the sheet never painted.
        expect(prepared.unplanned, `${entry.id} LOD${lod}`).toEqual([]);
        expect(prepared.plan.moves.size, `${entry.id} LOD${lod}`).toBe(plan.moves.size);
        // The cape must land in the same rectangle at every level, or the lower
        // LODs would need their own atlas.
        for (const [name, move] of prepared.plan.moves) {
          const original = plan.moves.get(name);
          expect(original, `${entry.id} LOD${lod} invented a move for ${name}`).toBeDefined();
          expect(move.dest).toEqual(original!.dest);
        }
        build.geometry.dispose();
      }
      lod0.geometry.dispose();
    }
  });

  it('never invents a move the supplied plan does not have', () => {
    const entry = rosterEntry('chr.saitama');
    const lod0 = buildRosterMesh(entry, 0);
    const plan = prepareRosterGeometry(lod0).plan;
    expect(plan.moves.has('collar')).toBe(true);

    // A plan with one split dropped stands in for the real hazard: a lower LOD
    // whose decimated vertex colours quantise into a different bucket and make
    // a rectangle look shared. Either way the plan is what the atlas was baked
    // against, so it wins — loudly, not silently.
    const stripped: AtlasPlan = {
      moves: new Map([...plan.moves].filter(([name]) => name !== 'collar')),
      used: plan.used,
    };
    const build = buildRosterMesh(entry, 0);
    const prepared = prepareRosterGeometry(build, stripped);

    expect(prepared.plan.moves.has('collar')).toBe(false);
    expect(prepared.unplanned).toContain('collar');
    build.geometry.dispose();
    lod0.geometry.dispose();
  });

  it('is idempotent — a second preparation is a no-op, not a second split', () => {
    // The split pass keys off vertex COLOUR, which a UV move does not change,
    // and always maps from the full named rectangle. Re-running it would
    // subdivide `trim` again and squeeze each quarter-sized island into a
    // quarter of a quarter: a collar wearing a smear of the boot cell.
    const build = buildRosterMesh(rosterEntry('chr.saitama'), 0);
    const first = prepareRosterGeometry(build);
    const uv = build.geometry.getAttribute('uv');
    const before = Array.from(uv.array);

    const second = prepareRosterGeometry(build);
    expect(second).toBe(first);
    expect(Array.from(uv.array)).toEqual(before);
    expect(findPaintCollisions(build)).toEqual([]);
    build.geometry.dispose();
  });

  it('reports a small island buried whole inside a large one', () => {
    const build = buildRosterMesh(rosterEntry('chr.saitama'), 0);
    prepareRosterGeometry(build);
    expect(findPaintCollisions(build)).toEqual([]);

    // Bury the collar inside the body rectangle. 100% of the collar is lost to
    // whichever triangle rasterises last, but it covers well under 2% of its
    // burier — so a rule that normalises by the first box's area sees nothing.
    const collar = build.regions.find((region) => region.name === 'collar');
    expect(collar).toBeDefined();
    const body = UV_REGIONS.body;
    const index = build.geometry.getIndex()!;
    const uv = build.geometry.getAttribute('uv');
    const width = (body.u1 - body.u0) * 0.05;
    const height = (body.v1 - body.v0) * 0.05;
    for (let i = collar!.indexStart; i < collar!.indexStart + collar!.indexCount; i++) {
      const vertex = index.getX(i);
      uv.setXY(vertex, body.u0 + width * (vertex % 2), body.v0 + height * (vertex % 2));
    }

    const collisions = findPaintCollisions(build);
    expect(collisions.some((pair) => pair.includes('collar'))).toBe(true);
    build.geometry.dispose();
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
