/**
 * GEOMETRY PREPARATION — one atlas, one draw call, no overlaps
 *
 * The mesh generator's UV layout is designed for a SHARED atlas where regions
 * deliberately stack: both arms use one unwrap, both hands use another. That is
 * exactly right when the two islands are painted the same, and exactly wrong
 * when they are not — and once a real texture replaces the flat white stand-in,
 * two failures become visible:
 *
 *   1. THE CAPE IS NOT IN A RECTANGLE. It is not a swept ring set; it emits its
 *      sheet directly into the mesh builder with RAW 0..1 UVs, so its island
 *      covers the ENTIRE atlas. Baked, a cape wears a smeared copy of the face,
 *      both arms and the boots.
 *   2. DIFFERENTLY-PAINTED ISLANDS SHARE A RECTANGLE. The collar, belt, cuffs
 *      and boots all pack into `trim`; both hands, both feet, both ears and the
 *      nose all pack into `extremity`; Genos' vent grilles share `panel` with
 *      his pauldrons. The last one baked wins and the rest wear its colours.
 *      This is not hypothetical — it is why Saitama's first render had a red
 *      rubber collar and skin-coloured gloves.
 *
 * Neither is a bug in the mesh workstream: its contract is a shared unwrap, and
 * a caller that bakes per-texel material has to resolve the sharing. So the fix
 * lives here, downstream of the generator and upstream of the bake.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 * Islands may overlap only when their SIGNATURE matches — same material slot,
 * same mean vertex colour. Anything outside every named rectangle is refitted
 * into a free one; any rectangle holding more than one signature is subdivided
 * and each signature gets its own cell. The assignment is computed ONCE, at
 * LOD0, and reused for every lower LOD, so all three LODs keep sharing a single
 * texture — which is the property the whole atlas design rests on.
 */

import type * as THREE from 'three';
import type { HumanoidBuild, MeshRegionInfo, UVRect, UVRegionName } from '@/characters/mesh';
import { HEAD_LANDMARK_V, UV_REGIONS } from '@/characters/mesh';

/** Rectangles a displaced island may be re-fitted into, in preference order. */
const SPARE_RECTS: readonly UVRegionName[] = ['cloth', 'panel', 'hair', 'trim', 'extremity'];

/** Tolerance when testing containment; UV rects are already inset by padding. */
const CONTAIN_EPSILON = 1e-4;

/** An affine UV move: everything inside `src` is refitted into `dest`. */
export interface RegionMove {
  readonly src: UVRect;
  readonly dest: UVRect;
}

/** Where each remapped region was sent. Shared across a character's LODs. */
export interface AtlasPlan {
  /** Region name -> affine move. */
  readonly moves: ReadonlyMap<string, RegionMove>;
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
  /** Regions that had to be split apart because they shared a rectangle. */
  readonly split: readonly string[];
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
/**
 * Appearance signature of one region.
 *
 * Two regions may share atlas texels only if they will be PAINTED THE SAME —
 * the left and right arm are literally the same unwrap and must keep sharing,
 * because that halves the arm's texture cost for free. But the mesh generator
 * also stacks regions that are painted differently into one rectangle: both
 * hands, both feet, both ears and the nose all land in `extremity`, and the
 * collar, belt, cuffs and boots all land in `trim`. Baking those on top of one
 * another means the last writer wins and everything else wears its colours —
 * which is precisely how Saitama ended up with a red rubber collar.
 *
 * The signature is the material slot plus the region's mean vertex colour,
 * quantised. Same signature = same paint = safe to overlap.
 */
function regionSignature(geometry: THREE.BufferGeometry, region: MeshRegionInfo): string {
  const index = geometry.getIndex()!;
  const color = geometry.getAttribute('color');
  let r = 0;
  let g = 0;
  let b = 0;
  const count = region.indexCount;
  for (let i = region.indexStart; i < region.indexStart + count; i++) {
    const vertex = index.getX(i);
    r += color.getX(vertex);
    g += color.getY(vertex);
    b += color.getZ(vertex);
  }
  const q = (value: number): number => Math.round((value / Math.max(count, 1)) * 48);
  return `${region.slot}:${q(r)},${q(g)},${q(b)}`;
}

/** Gutter inset applied to each sub-cell, in UV. ~3 texels at 1024. */
const CELL_PADDING = 0.003;

/** Split a rectangle into `count` cells, in a stable row-major order. */
function subdivide(rect: UVRect, count: number): UVRect[] {
  if (count <= 1) return [rect];
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const width = (rect.u1 - rect.u0) / columns;
  const height = (rect.v1 - rect.v0) / rows;
  const cells: UVRect[] = [];
  for (let i = 0; i < count; i++) {
    const column = i % columns;
    const row = Math.floor(i / columns);
    cells.push({
      u0: rect.u0 + column * width + CELL_PADDING,
      v0: rect.v0 + row * height + CELL_PADDING,
      u1: rect.u0 + (column + 1) * width - CELL_PADDING,
      v1: rect.v0 + (row + 1) * height - CELL_PADDING,
    });
  }
  return cells;
}

export function prepareRosterGeometry(build: HumanoidBuild, plan?: AtlasPlan): PreparedGeometry {
  const geometry = build.geometry;
  const index = geometry.getIndex();
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute;
  if (index === null) throw new Error('roster: geometry must be indexed');

  const used = new Set<UVRegionName>();
  const displaced: MeshRegionInfo[] = [];
  const byRect = new Map<UVRegionName, MeshRegionInfo[]>();

  for (const region of build.regions) {
    const bounds = regionBounds(geometry, region);
    const rect = rectContaining(bounds.u0, bounds.v0, bounds.u1, bounds.v1);
    if (rect === undefined) {
      displaced.push(region);
      continue;
    }
    used.add(rect);
    const list = byRect.get(rect);
    if (list === undefined) byRect.set(rect, [region]);
    else list.push(region);
  }

  const moves = new Map<string, RegionMove>(plan?.moves ?? []);
  const remapped: string[] = [];
  const split: string[] = [];

  // --- islands the generator left outside every rectangle (the cape) --------
  for (const region of displaced) {
    if (!moves.has(region.name)) {
      const free = SPARE_RECTS.find((name) => !used.has(name));
      // Nothing free: share the cloth rectangle rather than leave the island
      // straddling the whole sheet, which is strictly worse.
      const name = free ?? 'cloth';
      used.add(name);
      moves.set(region.name, { src: regionBounds(geometry, region), dest: UV_REGIONS[name] });
    }
    remapped.push(region.name);
  }

  // --- regions that share a rectangle but not a paint job -------------------
  for (const [name, regions] of byRect) {
    const signatures: string[] = [];
    const groupOf = new Map<string, number>();
    for (const region of regions) {
      const signature = regionSignature(geometry, region);
      if (!groupOf.has(signature)) {
        groupOf.set(signature, signatures.length);
        signatures.push(signature);
      }
    }
    if (signatures.length <= 1) continue;

    const cells = subdivide(UV_REGIONS[name], signatures.length);
    for (const region of regions) {
      if (moves.has(region.name)) continue;
      const group = groupOf.get(regionSignature(geometry, region))!;
      moves.set(region.name, { src: UV_REGIONS[name], dest: cells[group]! });
      split.push(region.name);
    }
  }

  // --- apply ---------------------------------------------------------------
  for (const region of build.regions) {
    const move = moves.get(region.name);
    if (move === undefined) continue;
    const spanU = Math.max(move.src.u1 - move.src.u0, 1e-6);
    const spanV = Math.max(move.src.v1 - move.src.v0, 1e-6);
    const scaleU = (move.dest.u1 - move.dest.u0) / spanU;
    const scaleV = (move.dest.v1 - move.dest.v0) / spanV;

    // Vertices are shared only within an island (the generator duplicates the
    // seam column), so rewriting by index touches nothing else.
    const seen = new Set<number>();
    for (let i = region.indexStart; i < region.indexStart + region.indexCount; i++) {
      const vertex = index.getX(i);
      if (seen.has(vertex)) continue;
      seen.add(vertex);
      const u = move.dest.u0 + (uv.getX(vertex) - move.src.u0) * scaleU;
      const v = move.dest.v0 + (uv.getY(vertex) - move.src.v0) * scaleV;
      uv.setXY(vertex, u, v);
    }
  }
  if (moves.size > 0) uv.needsUpdate = true;

  // Re-verify: after the moves every island must sit inside a named rectangle.
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
    split,
  };
}

/**
 * Regions that would overlap in the atlas after preparation.
 *
 * Two islands may legitimately share texels when they are painted identically
 * (both arms), so this reports only pairs whose PAINT differs — which is
 * exactly the class of bug that puts a boot's colour on a collar.
 */
export function findPaintCollisions(build: HumanoidBuild): string[] {
  const geometry = build.geometry;
  const boxes = build.regions.map((region) => ({
    name: region.name,
    signature: regionSignature(geometry, region),
    bounds: regionBounds(geometry, region),
  }));

  const collisions: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.signature === b.signature) continue;
      const overlapU = Math.min(a.bounds.u1, b.bounds.u1) - Math.max(a.bounds.u0, b.bounds.u0);
      const overlapV = Math.min(a.bounds.v1, b.bounds.v1) - Math.max(a.bounds.v0, b.bounds.v0);
      if (overlapU <= 1e-4 || overlapV <= 1e-4) continue;
      // Ignore hairline touches from the shared gutter.
      const areaA = (a.bounds.u1 - a.bounds.u0) * (a.bounds.v1 - a.bounds.v0);
      if ((overlapU * overlapV) / Math.max(areaA, 1e-9) < 0.02) continue;
      collisions.push(`${a.name} ↔ ${b.name}`);
    }
  }
  return collisions;
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
