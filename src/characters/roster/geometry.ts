/**
 * GEOMETRY PREPARATION — one atlas, one draw call, no overlaps
 *
 * The mesh generator hands over geometry whose UVs are packed into the named
 * rectangles of `UV_REGIONS`… with one exception. The cape is not a swept ring
 * set: it emits its sheet directly into the mesh builder and writes RAW 0..1
 * UVs, so its island covers the ENTIRE atlas and overlaps every other region.
 *
 * That is invisible against the flat white stand-in atlas the mesh harness
 * uses, and catastrophic against a real one: a cape sampling the whole sheet
 * wears a smeared copy of the face, both arms and the boots. Since a character
 * is baked into ONE texture so it can draw in ONE call, the fix belongs here —
 * downstream of the generator, upstream of the bake — rather than in the mesh
 * workstream's files.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 * Any region whose UV bounding box is not contained in a named rectangle is
 * re-fitted into a rectangle nothing else is using. The assignment is computed
 * ONCE, at LOD0, and reused for every lower LOD, so all three LODs keep sharing
 * a single texture — which is the property the whole atlas design rests on.
 */

import type * as THREE from 'three';
import type { HumanoidBuild, MeshRegionInfo, UVRect, UVRegionName } from '@/characters/mesh';
import { HEAD_LANDMARK_V, UV_REGIONS } from '@/characters/mesh';

/** Rectangles a displaced island may be re-fitted into, in preference order. */
const SPARE_RECTS: readonly UVRegionName[] = ['cloth', 'panel', 'hair', 'trim', 'extremity'];

/** Tolerance when testing containment; UV rects are already inset by padding. */
const CONTAIN_EPSILON = 1e-4;

/** Where each remapped region was sent. Shared across a character's LODs. */
export interface AtlasPlan {
  /** Region name -> destination rectangle. */
  readonly moves: ReadonlyMap<string, UVRect>;
  /** Named rectangles the character occupies after remapping. */
  readonly used: readonly UVRegionName[];
}

/** Result of preparing one build. */
export interface PreparedGeometry {
  readonly plan: AtlasPlan;
  /** Regions that were moved, for the report. */
  readonly remapped: readonly string[];
  /** True when every vertex now lies inside exactly one named rectangle. */
  readonly clean: boolean;
}

function contains(rect: UVRect, u0: number, v0: number, u1: number, v1: number): boolean {
  return (
    u0 >= rect.u0 - CONTAIN_EPSILON &&
    v0 >= rect.v0 - CONTAIN_EPSILON &&
    u1 <= rect.u1 + CONTAIN_EPSILON &&
    v1 <= rect.v1 + CONTAIN_EPSILON
  );
}

/** Bounding box of one region's UVs. */
function regionBounds(
  geometry: THREE.BufferGeometry,
  region: MeshRegionInfo
): { u0: number; v0: number; u1: number; v1: number } {
  const index = geometry.getIndex();
  const uv = geometry.getAttribute('uv');
  if (index === null) throw new Error('roster: geometry must be indexed');
  let u0 = Number.POSITIVE_INFINITY;
  let v0 = Number.POSITIVE_INFINITY;
  let u1 = Number.NEGATIVE_INFINITY;
  let v1 = Number.NEGATIVE_INFINITY;
  for (let i = region.indexStart; i < region.indexStart + region.indexCount; i++) {
    const vertex = index.getX(i);
    const u = uv.getX(vertex);
    const v = uv.getY(vertex);
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  return { u0, v0, u1, v1 };
}

/** The named rectangle containing a bounding box, or undefined. */
export function rectContaining(
  u0: number,
  v0: number,
  u1: number,
  v1: number
): UVRegionName | undefined {
  for (const name of Object.keys(UV_REGIONS) as UVRegionName[]) {
    if (contains(UV_REGIONS[name], u0, v0, u1, v1)) return name;
  }
  return undefined;
}

/**
 * Re-fit displaced islands and report the atlas layout.
 *
 * Mutates `build.geometry`'s uv attribute in place. Idempotent: a build whose
 * islands are already inside named rectangles is left untouched.
 */
export function prepareRosterGeometry(build: HumanoidBuild, plan?: AtlasPlan): PreparedGeometry {
  const geometry = build.geometry;
  const index = geometry.getIndex();
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  if (index === null) throw new Error('roster: geometry must be indexed');

  const used = new Set<UVRegionName>();
  const displaced: MeshRegionInfo[] = [];

  for (const region of build.regions) {
    const bounds = regionBounds(geometry, region);
    const rect = rectContaining(bounds.u0, bounds.v0, bounds.u1, bounds.v1);
    if (rect === undefined) displaced.push(region);
    else used.add(rect);
  }

  const moves = new Map<string, UVRect>(plan?.moves ?? []);
  const remapped: string[] = [];

  for (const region of displaced) {
    let target = moves.get(region.name);
    if (target === undefined) {
      const free = SPARE_RECTS.find((name) => !used.has(name));
      // Nothing free: share the cloth rectangle rather than leave the island
      // straddling the whole sheet, which is strictly worse.
      const name = free ?? 'cloth';
      target = UV_REGIONS[name];
      used.add(name);
      moves.set(region.name, target);
    }

    const bounds = regionBounds(geometry, region);
    const spanU = Math.max(bounds.u1 - bounds.u0, 1e-6);
    const spanV = Math.max(bounds.v1 - bounds.v0, 1e-6);
    const scaleU = (target.u1 - target.u0) / spanU;
    const scaleV = (target.v1 - target.v0) / spanV;

    // Vertices are shared only within an island (the generator duplicates the
    // seam column), so rewriting by index touches nothing else.
    const seen = new Set<number>();
    for (let i = region.indexStart; i < region.indexStart + region.indexCount; i++) {
      const vertex = index.getX(i);
      if (seen.has(vertex)) continue;
      seen.add(vertex);
      const u = target.u0 + (uv.getX(vertex) - bounds.u0) * scaleU;
      const v = target.v0 + (uv.getY(vertex) - bounds.v0) * scaleV;
      uv.setXY(vertex, u, v);
    }
    remapped.push(region.name);
  }

  if (remapped.length > 0) uv.needsUpdate = true;

  // Re-verify: after the move every island must sit inside a named rectangle.
  let clean = true;
  for (const region of build.regions) {
    const bounds = regionBounds(geometry, region);
    const rect = rectContaining(bounds.u0, bounds.v0, bounds.u1, bounds.v1);
    if (rect === undefined) clean = false;
    else used.add(rect);
  }

  return {
    plan: { moves, used: [...used].sort() },
    remapped,
    clean,
  };
}

/* -------------------------------------------------------------------------- */
/* Head measurement                                                           */
/* -------------------------------------------------------------------------- */

/** Metric facts about a head, resolved from the geometry rather than guessed. */
export interface HeadMetrics {
  /** Half-width of the head at the brow, in metres. */
  readonly halfWidth: number;
  /** Half-depth (front-to-back) at the brow, in metres. */
  readonly halfDepth: number;
  /** World Y of the brow ring. */
  readonly browY: number;
  /** Distance from chin to crown, in metres. */
  readonly height: number;
  /** Z of the face surface at the brow (characters face -Z). */
  readonly faceZ: number;
}

/** Atlas v for a strand-local head landmark. */
export function headLandmarkV(local: number): number {
  const rect = UV_REGIONS.body;
  return rect.v0 + (rect.v1 - rect.v0) * local;
}

/**
 * Measure the head from the built vertices.
 *
 * Deriving this from the proportion tables would duplicate `resolveDimensions`
 * and drift the moment an archetype tweak lands; measuring the actual ring is
 * both shorter and correct by construction. Face art is placed in METRES, so
 * this number is what makes a 1.18x head scale move the eyes with it.
 */
export function measureHead(build: HumanoidBuild): HeadMetrics {
  const geometry = build.geometry;
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const browV = headLandmarkV(HEAD_LANDMARK_V.brow);
  const chinV = headLandmarkV(HEAD_LANDMARK_V.chin);
  const crownV = headLandmarkV(HEAD_LANDMARK_V.crown);
  const body = UV_REGIONS.body;
  const tolerance = (body.v1 - body.v0) * 0.012;

  let halfWidth = 0;
  let halfDepth = 0;
  let browY = 0;
  let faceZ = 0;
  let samples = 0;
  let chinY = Number.POSITIVE_INFINITY;
  let crownY = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < position.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (u < body.u0 - 1e-4 || u > body.u1 + 1e-4) continue;

    if (Math.abs(v - browV) < tolerance) {
      const x = Math.abs(position.getX(i));
      const z = position.getZ(i);
      if (x > halfWidth) halfWidth = x;
      if (Math.abs(z) > halfDepth) halfDepth = Math.abs(z);
      if (z < faceZ) faceZ = z;
      browY += position.getY(i);
      samples++;
    }
    if (Math.abs(v - chinV) < tolerance) chinY = Math.min(chinY, position.getY(i));
    if (Math.abs(v - crownV) < tolerance) crownY = Math.max(crownY, position.getY(i));
  }

  const y = samples > 0 ? browY / samples : 0;
  const height = Number.isFinite(chinY) && crownY > chinY ? crownY - chinY : 0.22;
  return {
    halfWidth: halfWidth > 1e-4 ? halfWidth : 0.08,
    halfDepth: halfDepth > 1e-4 ? halfDepth : 0.1,
    browY: y,
    height,
    faceZ,
  };
}
