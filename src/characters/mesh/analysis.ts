/**
 * GEOMETRY VALIDATION
 *
 * A procedural mesh has no artist to notice that it has a hole in it, so the
 * checks an artist would do by eye are done numerically here and asserted in
 * the unit tests. These functions are also exposed to the harness so the
 * on-screen readout shows the same numbers the tests do.
 *
 * ── WELDING FIRST ─────────────────────────────────────────────────────────
 * The mesh deliberately duplicates vertices: once per UV seam and once per
 * hard edge. Testing the raw index buffer would therefore report thousands of
 * "boundary" edges on a perfectly closed surface. Every topological check
 * below runs on positions welded to 0.01 mm, which is the only meaningful way
 * to ask whether a UV-seamed mesh is watertight.
 *
 * ── WHAT COUNTS AS CORRECT ────────────────────────────────────────────────
 * A character is a union of closed shells, not one stitched surface — an arm
 * is its own volume that begins inside the ribcage. So the test is per
 * COMPONENT: every edge bounded by exactly two triangles, positive signed
 * volume (which is a winding check in disguise), and an even Euler
 * characteristic no greater than 2 (spheres for body parts, tori for garment
 * shells that wrap a limb).
 */

import * as THREE from 'three';

const WELD_SCALE = 1e5;

/** Map every vertex to a representative index for its welded position. */
export function weldMap(positions: ArrayLike<number>, count: number): Int32Array {
  const map = new Int32Array(count);
  const seen = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key =
      `${Math.round(positions[i * 3]! * WELD_SCALE)}|` +
      `${Math.round(positions[i * 3 + 1]! * WELD_SCALE)}|` +
      `${Math.round(positions[i * 3 + 2]! * WELD_SCALE)}`;
    const existing = seen.get(key);
    if (existing === undefined) {
      seen.set(key, i);
      map[i] = i;
    } else {
      map[i] = existing;
    }
  }
  return map;
}

/** Per-component topology report. */
export interface ComponentReport {
  readonly vertices: number;
  readonly edges: number;
  readonly faces: number;
  readonly euler: number;
  readonly volume: number;
}

/** Whole-mesh topology report. */
export interface TopologyReport {
  readonly vertices: number;
  readonly weldedVertices: number;
  readonly triangles: number;
  readonly components: number;
  /** Edges with exactly one incident triangle. Any is a hole. */
  readonly boundaryEdges: number;
  /** Edges with three or more incident triangles. Any is non-manifold. */
  readonly nonManifoldEdges: number;
  /** Triangles with two or more identical welded corners. */
  readonly degenerateTriangles: number;
  readonly totalVolume: number;
  readonly perComponent: readonly ComponentReport[];
  readonly watertight: boolean;
}

class UnionFind {
  private readonly parent: Int32Array;
  constructor(size: number) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }
  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let cursor = x;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor]!;
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/** Full topological audit of an indexed geometry. */
export function analyseTopology(geometry: THREE.BufferGeometry): TopologyReport {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (index === null) throw new Error('analyseTopology: geometry must be indexed');

  const count = position.count;
  const positions = position.array as ArrayLike<number>;
  const weld = weldMap(positions, count);
  const indices = index.array;
  const triangles = indices.length / 3;

  const uf = new UnionFind(count);
  const edgeCounts = new Map<number, number>();
  const edgeOwner = new Map<number, number>();
  let degenerate = 0;

  const edgeKey = (a: number, b: number): number => (a < b ? a * count + b : b * count + a);

  for (let t = 0; t < triangles; t++) {
    const a = weld[indices[t * 3]!]!;
    const b = weld[indices[t * 3 + 1]!]!;
    const c = weld[indices[t * 3 + 2]!]!;
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    uf.union(a, b);
    uf.union(b, c);
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = edgeKey(x, y);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      if (!edgeOwner.has(key)) edgeOwner.set(key, a);
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  const edgesPerRoot = new Map<number, number>();
  for (const [key, n] of edgeCounts) {
    if (n === 1) boundaryEdges++;
    else if (n > 2) nonManifoldEdges++;
    const root = uf.find(edgeOwner.get(key)!);
    edgesPerRoot.set(root, (edgesPerRoot.get(root) ?? 0) + 1);
  }

  const vertsPerRoot = new Map<number, number>();
  const weldedSeen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const w = weld[i]!;
    if (weldedSeen.has(w)) continue;
    weldedSeen.add(w);
    const root = uf.find(w);
    vertsPerRoot.set(root, (vertsPerRoot.get(root) ?? 0) + 1);
  }

  const facesPerRoot = new Map<number, number>();
  const volumePerRoot = new Map<number, number>();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const pc = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let totalVolume = 0;

  for (let t = 0; t < triangles; t++) {
    const ia = indices[t * 3]!;
    const ib = indices[t * 3 + 1]!;
    const ic = indices[t * 3 + 2]!;
    const a = weld[ia]!;
    if (a === weld[ib]! || weld[ib]! === weld[ic]! || a === weld[ic]!) continue;
    const root = uf.find(a);
    facesPerRoot.set(root, (facesPerRoot.get(root) ?? 0) + 1);

    pa.fromArray(positions, ia * 3);
    pb.fromArray(positions, ib * 3);
    pc.fromArray(positions, ic * 3);
    cross.crossVectors(pb, pc);
    const signed = pa.dot(cross) / 6;
    volumePerRoot.set(root, (volumePerRoot.get(root) ?? 0) + signed);
    totalVolume += signed;
  }

  const perComponent: ComponentReport[] = [];
  for (const [root, faces] of facesPerRoot) {
    const vertices = vertsPerRoot.get(root) ?? 0;
    const edges = edgesPerRoot.get(root) ?? 0;
    perComponent.push({
      vertices,
      edges,
      faces,
      euler: vertices - edges + faces,
      volume: volumePerRoot.get(root) ?? 0,
    });
  }
  perComponent.sort((a, b) => b.faces - a.faces);

  return {
    vertices: count,
    weldedVertices: weldedSeen.size,
    triangles,
    components: perComponent.length,
    boundaryEdges,
    nonManifoldEdges,
    degenerateTriangles: degenerate,
    totalVolume,
    perComponent,
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Skinning validation                                                        */
/* -------------------------------------------------------------------------- */

export interface SkinReport {
  readonly vertices: number;
  /** Largest |sum(weights) - 1| across all vertices. */
  readonly maxWeightError: number;
  /** Any negative weight found. */
  readonly negativeWeights: number;
  /** Indices outside [0, boneCount). */
  readonly outOfRangeIndices: number;
  /** Weights not sorted descending within a vertex. */
  readonly unsortedVertices: number;
  /** How many vertices have 1, 2, 3 or 4 non-zero influences. */
  readonly influenceHistogram: readonly [number, number, number, number];
  readonly ok: boolean;
}

/**
 * Audit `skinIndex` / `skinWeight`.
 *
 * Four slots per vertex is the GPU contract, not a claim that every vertex
 * needs four bones — a point in the middle of a forearm legitimately follows
 * exactly one. What must hold is that the four weights sum to 1, that none is
 * negative, and that every index is in range EVEN WHEN ITS WEIGHT IS ZERO:
 * some mobile drivers sample the bone texture before multiplying by the
 * weight, so a stale -1 in an unused slot reads garbage and explodes the mesh.
 */
export function analyseSkinning(geometry: THREE.BufferGeometry, boneCount: number): SkinReport {
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  if (skinIndex === undefined || skinWeight === undefined) {
    throw new Error('analyseSkinning: geometry is not skinned');
  }

  const count = skinWeight.count;
  let maxError = 0;
  let negative = 0;
  let outOfRange = 0;
  let unsorted = 0;
  const histogram: [number, number, number, number] = [0, 0, 0, 0];

  for (let i = 0; i < count; i++) {
    let sum = 0;
    let nonZero = 0;
    let previous = Number.POSITIVE_INFINITY;
    let sortedOk = true;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(i, k);
      const b = skinIndex.getComponent(i, k);
      sum += w;
      if (w < 0) negative++;
      if (w > 1e-6) nonZero++;
      if (w > previous + 1e-6) sortedOk = false;
      previous = w;
      if (!Number.isInteger(b) || b < 0 || b >= boneCount) outOfRange++;
    }
    if (!sortedOk) unsorted++;
    maxError = Math.max(maxError, Math.abs(sum - 1));
    histogram[Math.min(3, Math.max(0, nonZero - 1))]++;
  }

  return {
    vertices: count,
    maxWeightError: maxError,
    negativeWeights: negative,
    outOfRangeIndices: outOfRange,
    unsortedVertices: unsorted,
    influenceHistogram: histogram,
    ok: maxError < 1e-5 && negative === 0 && outOfRange === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Silhouette measurement                                                     */
/* -------------------------------------------------------------------------- */

/** Coarse shape signature used to prove two body types differ. */
export interface Silhouette {
  readonly height: number;
  readonly width: number;
  readonly depth: number;
  /** Widths sampled at 12 evenly spaced heights, normalised by height. */
  readonly profile: readonly number[];
}

/**
 * Measure a front-view silhouette.
 *
 * Bounding boxes alone are a weak claim — two very different bodies can share
 * one. Sampling width at a dozen heights captures where the mass actually
 * sits, which is what "these are distinct body types" has to mean.
 */
export function measureSilhouette(geometry: THREE.BufferGeometry, bands = 12): Silhouette {
  const position = geometry.getAttribute('position');
  const box = new THREE.Box3().setFromBufferAttribute(position as THREE.BufferAttribute);
  const height = box.max.y - box.min.y;
  const widths = new Array<number>(bands).fill(0);

  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const band = Math.min(
      bands - 1,
      Math.max(0, Math.floor(((y - box.min.y) / Math.max(height, 1e-6)) * bands))
    );
    widths[band] = Math.max(widths[band]!, Math.abs(position.getX(i)) * 2);
  }

  return {
    height,
    width: box.max.x - box.min.x,
    depth: box.max.z - box.min.z,
    profile: widths.map((w) => w / Math.max(height, 1e-6)),
  };
}

/** L1 distance between two silhouette profiles. 0 means identical. */
export function silhouetteDistance(a: Silhouette, b: Silhouette): number {
  let sum = 0;
  const n = Math.min(a.profile.length, b.profile.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a.profile[i]! - b.profile[i]!);
  return sum / n;
}
