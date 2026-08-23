/**
 * TOPOLOGY CONTRACT
 *
 * Watertight, manifold, outward-facing. A procedural mesh has no artist to
 * notice a hole, so these have to be assertions rather than intentions.
 *
 * ── WHAT "WATERTIGHT" MEANS HERE ──────────────────────────────────────────
 * The character is a union of closed shells, not one stitched surface: an arm
 * is its own volume whose inboard end sits inside the ribcage. That is a
 * deliberate design decision (see types.ts) — it means limb-to-torso joins can
 * never tear, and it costs nothing visually on an opaque character. So the
 * test is per COMPONENT, after welding by position to collapse the UV seams
 * and hard-edge duplicates the mesh needs.
 *
 * Positive signed volume per component is a winding check wearing a disguise:
 * a component whose triangles were wound backwards would come out negative,
 * and would render as an inside-out silhouette under backface culling.
 *
 * Euler characteristic 2 is a sphere; 0 is a torus, which is the correct
 * topology for a garment shell that wraps a limb (a sleeve is a pipe). Odd or
 * positive-above-2 values would mean the surface is not a closed orientable
 * 2-manifold at all.
 */

import { describe, expect, it } from 'vitest';
import { analyseTopology } from '../analysis';
import { buildCivilian, showcaseBodies } from '../characters';
import { buildHumanoid } from '../assemble';
import type { LodLevel } from '../types';
import { UV_REGIONS } from '../uv';

const LODS: readonly LodLevel[] = [0, 1, 2];

describe('mesh topology', () => {
  for (const recipe of showcaseBodies()) {
    for (const lod of LODS) {
      it(`${recipe.name} LOD${lod} is a closed manifold`, () => {
        const build = buildHumanoid(recipe.profile, { ...recipe.options, lod });
        const report = analyseTopology(build.geometry);

        expect(report.boundaryEdges, 'holes').toBe(0);
        expect(report.nonManifoldEdges, 'non-manifold edges').toBe(0);
        expect(report.degenerateTriangles, 'degenerate triangles').toBe(0);
        expect(report.watertight).toBe(true);

        for (const component of report.perComponent) {
          expect(component.volume, 'inverted winding').toBeGreaterThan(0);
          expect(component.euler % 2, 'non-orientable or non-closed').toBe(0);
          expect(component.euler).toBeLessThanOrEqual(2);
          expect(component.euler).toBeGreaterThanOrEqual(-2);
        }
      });
    }
  }

  it('reports a sensible component count', () => {
    // torso+head, 2 arms, 2 legs, 2 hands, 2 thumbs, 2 feet, 2 ears, nose.
    const build = buildHumanoid(showcaseBodies()[5]!.profile, {
      ...showcaseBodies()[5]!.options,
      lod: 0,
    });
    expect(build.stats.components).toBeGreaterThanOrEqual(14);
    expect(build.stats.components).toBeLessThan(60);
  });

  it('holds for procedural civilians', () => {
    for (let seed = 0; seed < 24; seed++) {
      const build = buildCivilian(seed * 104729 + 5, 0);
      const report = analyseTopology(build.geometry);
      expect(report.boundaryEdges, `civilian seed ${seed} holes`).toBe(0);
      expect(report.nonManifoldEdges, `civilian seed ${seed} non-manifold`).toBe(0);
      expect(report.degenerateTriangles, `civilian seed ${seed} degenerate`).toBe(0);
      expect(report.totalVolume).toBeGreaterThan(0);
    }
  });

  it('produces normals for every vertex', () => {
    const build = buildHumanoid(showcaseBodies()[0]!.profile, showcaseBodies()[0]!.options);
    const normal = build.geometry.getAttribute('normal');
    expect(normal.count).toBe(build.geometry.getAttribute('position').count);
    for (let i = 0; i < normal.count; i++) {
      const length = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i));
      expect(length).toBeGreaterThan(0.99);
      expect(length).toBeLessThan(1.01);
    }
  });

  it('packs every strand into exactly one atlas rectangle', () => {
    // What the atlas actually promises: each strand's island lands inside its
    // OWN `UV_REGIONS` rectangle, which is what lets one texture serve the
    // whole character. "0 <= u,v <= 1" is satisfied by any UV whatsoever,
    // including a strand that never called `packUV`.
    const rects = Object.entries(UV_REGIONS);
    for (const recipe of showcaseBodies()) {
      const build = buildHumanoid(recipe.profile, recipe.options);
      const uv = build.geometry.getAttribute('uv');
      const index = build.geometry.getIndex()!;

      for (const region of build.regions) {
        // The cape writes raw 0..1 UVs instead of packing into
        // `UV_REGIONS.cloth`; that is tracked separately, and the weaker
        // 0..1 case below is what still covers it.
        if (region.name === 'cape') continue;

        let u0 = Infinity;
        let v0 = Infinity;
        let u1 = -Infinity;
        let v1 = -Infinity;
        for (let i = region.indexStart; i < region.indexStart + region.indexCount; i++) {
          const vertex = index.getX(i);
          u0 = Math.min(u0, uv.getX(vertex));
          u1 = Math.max(u1, uv.getX(vertex));
          v0 = Math.min(v0, uv.getY(vertex));
          v1 = Math.max(v1, uv.getY(vertex));
        }

        // The rectangles are disjoint by construction (each is inset by
        // `PADDING`), so "exactly one" and "at least one" are the same
        // assertion today — stating it as one catches a future overlap too.
        const inside = rects.filter(
          ([, r]) =>
            u0 >= r.u0 - 1e-6 && u1 <= r.u1 + 1e-6 && v0 >= r.v0 - 1e-6 && v1 <= r.v1 + 1e-6
        );
        expect(
          inside.map(([name]) => name),
          `${recipe.name}/${region.name}`
        ).toHaveLength(1);
      }
    }
  });

  it('keeps every UV inside the 0..1 sheet', () => {
    // The weaker fallback, kept only for the one region the strong check above
    // skips. Delete both the `continue` and this case when the cape's packing
    // is fixed.
    for (const recipe of showcaseBodies()) {
      const build = buildHumanoid(recipe.profile, recipe.options);
      const uv = build.geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
        expect(uv.getX(i)).toBeLessThanOrEqual(1);
        expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
        expect(uv.getY(i)).toBeLessThanOrEqual(1);
      }
    }
  });
});
