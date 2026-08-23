/**
 * THE AUDITOR ITSELF
 *
 * Every topology guarantee this unit advertises rests on `analyseTopology`, and
 * `topology.test.ts` only ever shows it clean characters. If the auditor
 * silently stopped counting — a wrong weld quantisation, an early `continue`, an
 * edge-key collision — every one of those assertions would keep passing on a
 * mesh full of holes. So this file feeds it geometry whose defects are known by
 * construction and checks that it FINDS them. The same argument applies to
 * `analyseSkinning`, which elsewhere only ever sees valid input.
 *
 * The fixture is a unit `BoxGeometry`: indexed, 24 vertices (4 per face), 12
 * triangles, outward-wound, with corner positions bit-identical across faces so
 * the position weld collapses it to the 8 real corners.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  analyseSkinning,
  analyseTopology,
  measureSilhouette,
  silhouetteDistance,
  weldMap,
} from '../analysis';

/** A fresh unit cube. */
function box(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

/** The cube's index as a mutable plain array, for the negative cases. */
function indexOf(geometry: THREE.BufferGeometry): number[] {
  return Array.from(geometry.getIndex()!.array as ArrayLike<number>);
}

/** One vertex carrying explicit skin attributes. */
function skinned(index: number[], weight: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
  return geometry;
}

describe('analyseTopology', () => {
  it('reports a closed cube exactly', () => {
    const report = analyseTopology(box());

    expect(report.vertices).toBe(24);
    expect(report.weldedVertices).toBe(8);
    expect(report.triangles).toBe(12);
    expect(report.components).toBe(1);
    expect(report.boundaryEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.degenerateTriangles).toBe(0);
    expect(report.watertight).toBe(true);
    expect(report.totalVolume).toBeCloseTo(1, 6);

    // 12 cube edges + one diagonal per face = 18, so euler = 8 - 18 + 12 = 2.
    const component = report.perComponent[0]!;
    expect(component.vertices).toBe(8);
    expect(component.edges).toBe(18);
    expect(component.faces).toBe(12);
    expect(component.euler).toBe(2);
  });

  it('detects a hole', () => {
    const geometry = box();
    const index = indexOf(geometry);
    // Drop one face: its two triangles. The shared diagonal vanishes from the
    // edge map entirely; only the four perimeter edges drop to one triangle.
    geometry.setIndex(index.slice(0, index.length - 6));

    const report = analyseTopology(geometry);
    expect(report.triangles).toBe(10);
    expect(report.boundaryEdges).toBe(4);
    expect(report.watertight).toBe(false);
  });

  it('detects inverted winding', () => {
    const geometry = box();
    const index = indexOf(geometry);
    for (let t = 0; t < index.length; t += 3) {
      const swap = index[t + 1]!;
      index[t + 1] = index[t + 2]!;
      index[t + 2] = swap;
    }
    geometry.setIndex(index);

    // Still a perfectly closed manifold — only the orientation is wrong, which
    // is exactly what "positive signed volume per component" is there to catch.
    const report = analyseTopology(geometry);
    expect(report.boundaryEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.totalVolume).toBeLessThan(0);
    expect(report.perComponent[0]!.volume).toBeLessThan(0);
  });

  it('detects a non-manifold edge', () => {
    const geometry = box();
    const index = indexOf(geometry);
    // A third copy of the first triangle: its three edges now carry three
    // incident triangles apiece.
    geometry.setIndex([...index, index[0]!, index[1]!, index[2]!]);

    const report = analyseTopology(geometry);
    expect(report.nonManifoldEdges).toBe(3);
    expect(report.watertight).toBe(false);
  });

  it('detects a degenerate triangle', () => {
    const geometry = box();
    geometry.setIndex([...indexOf(geometry), 0, 0, 1]);

    const report = analyseTopology(geometry);
    expect(report.degenerateTriangles).toBe(1);
    // A degenerate triangle contributes no face anywhere.
    const faces = report.perComponent.reduce((sum, c) => sum + c.faces, 0);
    expect(faces).toBe(12);
  });

  it('throws on a non-indexed geometry', () => {
    expect(() => analyseTopology(box().toNonIndexed())).toThrow(/must be indexed/);
  });
});

describe('weldMap', () => {
  it('welds by position to 0.01 mm', () => {
    // 1 µm quantises into the same bucket; 1 m obviously does not.
    expect(Array.from(weldMap([0, 0, 0, 1e-6, 0, 0, 1, 0, 0], 3))).toEqual([0, 0, 2]);
    // 20 µm is two buckets apart, so the two stay distinct.
    expect(Array.from(weldMap([0, 0, 0, 2e-5, 0, 0], 2))).toEqual([0, 1]);
  });
});

describe('analyseSkinning', () => {
  it('passes a single rigid influence', () => {
    const report = analyseSkinning(skinned([0, 0, 0, 0], [1, 0, 0, 0]), 4);
    expect(report.maxWeightError).toBe(0);
    expect(report.negativeWeights).toBe(0);
    expect(report.outOfRangeIndices).toBe(0);
    expect(report.unsortedVertices).toBe(0);
    expect(report.influenceHistogram[0]).toBe(1);
    expect(report.ok).toBe(true);
  });

  it('counts four influences', () => {
    const report = analyseSkinning(skinned([0, 1, 2, 3], [0.4, 0.3, 0.2, 0.1]), 4);
    expect(report.influenceHistogram[3]).toBe(1);
    expect(report.ok).toBe(true);
  });

  it('flags weights that are not sorted descending', () => {
    const report = analyseSkinning(skinned([0, 0, 0, 0], [0.2, 0.8, 0, 0]), 4);
    expect(report.unsortedVertices).toBe(1);
    // Slot 0 being the dominant bone is part of the contract `ok` summarises.
    expect(report.ok).toBe(false);
  });

  it('flags a negative weight', () => {
    const report = analyseSkinning(skinned([0, 0, 0, 0], [-0.1, 1.1, 0, 0]), 4);
    expect(report.negativeWeights).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('flags an out-of-range bone index', () => {
    const report = analyseSkinning(skinned([9, 0, 0, 0], [1, 0, 0, 0]), 4);
    expect(report.outOfRangeIndices).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('flags weights that do not sum to one', () => {
    const report = analyseSkinning(skinned([0, 0, 0, 0], [0.5, 0, 0, 0]), 4);
    expect(report.maxWeightError).toBeCloseTo(0.5);
    expect(report.ok).toBe(false);
  });

  it('throws on an unskinned geometry', () => {
    expect(() => analyseSkinning(box(), 4)).toThrow(/not skinned/);
  });
});

describe('measureSilhouette', () => {
  it('measures a silhouette from vertices, not surface', () => {
    const silhouette = measureSilhouette(box());
    expect(silhouette.height).toBe(1);
    expect(silhouette.width).toBe(1);
    expect(silhouette.depth).toBe(1);

    // This pins the sampler's known semantics: it samples VERTICES, not the
    // surface, so a coarse mesh leaves empty bands. A cube has vertices only on
    // its two end planes, so only the first and last bands report any width.
    expect(silhouette.profile).toHaveLength(12);
    expect(silhouette.profile[0]).toBe(1);
    expect(silhouette.profile[11]).toBe(1);
    expect(silhouette.profile[5]).toBe(0);
  });

  it('is a zero, symmetric distance', () => {
    const a = measureSilhouette(box());
    const b = measureSilhouette(new THREE.BoxGeometry(2, 1, 1));
    expect(silhouetteDistance(a, a)).toBe(0);
    expect(silhouetteDistance(a, b)).toBeGreaterThan(0);
    expect(silhouetteDistance(a, b)).toBe(silhouetteDistance(b, a));
  });
});
