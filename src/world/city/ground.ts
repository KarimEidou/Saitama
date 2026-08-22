/**
 * GROUND, ROADS AND SIDEWALKS
 *
 * ── THE COMPLEMENT TRICK ───────────────────────────────────────────────────
 * Roads are not meshed as ribbons. Ribbons look correct in isolation and fall
 * apart at junctions: two carriageways crossing at the same height z-fight,
 * sidewalks overlap at every corner, and each fix costs more special cases
 * than the road network has junctions.
 *
 * Instead the carriageway is the COMPLEMENT of the parcels. A chunk lays down
 * asphalt across its whole 96 m, each block stamps a raised sidewalk and
 * parcel on top of it, and whatever asphalt is left over IS the road network —
 * including every intersection, corner radius and turning head, exactly
 * correct, with no junction logic at all. Lane markings are then painted along
 * the authored road centrelines, which is the one place the road graph is
 * genuinely needed.
 *
 * The asphalt is emitted as a coarse cell grid rather than one quad so cells
 * fully hidden under a parcel, or swallowed by a crater, can simply be
 * dropped.
 *
 * FOUR SLOTS, not three: carriageway, paving, parcel surface and markings. The
 * parcel surface earns its own slot because a park has to be grass and a
 * wasteland has to be dirt, and no amount of vertex tint turns asphalt into
 * either. `mergeChunkGrounds` collapses a whole resident region back down to
 * those four draw calls.
 */

import { createRng, hashString, type IRandom } from '@/util';
import { CHUNK_SIZE } from '@/spatial/constants';
import { MeshBuilder, mergeGeometries, type AABB6, type IGeometryBuffers } from './mesh-builder';
import { CITY_MATERIALS, shadeTint, uvScaleFor } from './materials';
import { offsetPolygon, triangulate, type Polygon } from './polygon';
import type { ICityPlan, IPlanBlock, IPlanCrater, IPlanRoad, IPlanZone } from './plan-types';

/** Material slots inside a ground geometry. */
export const enum GroundSlot {
  Road = 0,
  Paving = 1,
  Lot = 2,
  Markings = 3,
}

/** Number of ground material slots. */
export const GROUND_SLOT_COUNT = 4;

/** The four material ids a ground geometry binds, in slot order. */
export interface IGroundMaterials {
  readonly road: string;
  readonly paving: string;
  readonly lot: string;
  readonly markings: string;
}

/** Kerb height. Raising parcels 15 cm is what makes a street have edges. */
export const KERB_HEIGHT = 0.15;

/** Result of generating one chunk's ground. */
export interface IGroundBuild {
  readonly buffers: IGeometryBuffers;
  readonly materials: IGroundMaterials;
  /**
   * World AABB of the geometry actually emitted. It is NOT the chunk square:
   * a zebra crossing reaches up to the junction radius past the boundary, so
   * the chunk's own bounds have to fold this in to stay honest.
   */
  readonly bounds: AABB6;
  readonly triangles: number;
  readonly drawCalls: number;
}

/** Everything the ground pass needs about a chunk. */
export interface IGroundContext {
  readonly plan: ICityPlan;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly blocks: readonly IPlanBlock[];
  /** Zone for each entry of `blocks`, index-aligned. */
  readonly zones: readonly IPlanZone[];
  readonly roads: readonly IPlanRoad[];
  readonly craters: readonly IPlanCrater[];
  /** Sidewalk width in metres; uniform per block. */
  readonly sidewalkWidth: number;
}

/** Cells across a chunk for the carriageway grid. 8 gives 12 m cells. */
const ROAD_CELLS = 8;

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** Generate the ground plane, sidewalks, parcels and markings for one chunk. */
export function generateGround(ctx: IGroundContext): IGroundBuild {
  const builder = new MeshBuilder(GROUND_SLOT_COUNT);
  const materials = pickGroundMaterials(ctx);
  const roadUv = uvScaleFor(materials.road);
  const pavingUv = uvScaleFor(materials.paving);
  const lotUv = uvScaleFor(materials.lot);

  const x0 = ctx.chunkX * CHUNK_SIZE;
  const z0 = ctx.chunkZ * CHUNK_SIZE;
  const rng = createRng(((ctx.chunkX + 8) * 16 + (ctx.chunkZ + 8)) ^ 0x9d0b13);

  // One chunk is one fracture chunk as far as the builder is concerned: ground
  // is never destroyed piecewise, it is cratered, so the bookkeeping is a
  // formality that keeps the buffer shape uniform.
  builder.beginChunk();

  emitCarriageway(builder, ctx, x0, z0, roadUv, rng);
  for (let i = 0; i < ctx.blocks.length; i++) {
    // A crater parcel has no kerb, no pavement and no surface: the bowl IS the
    // ground there. Emitting the flat parcel anyway buries the crater under a
    // disc of dirt 15 cm above it, which is exactly what it looked like before.
    if (ctx.zones[i]?.kind === 'crater') continue;
    emitParcel(builder, ctx.blocks[i], ctx.zones[i], ctx.sidewalkWidth, pavingUv, lotUv);
  }
  emitMarkings(builder, ctx, x0, z0);
  for (const crater of ctx.craters) emitCrater(builder, crater, x0, z0, lotUv);

  const span = builder.endChunk();
  const buffers = builder.build();
  return {
    buffers,
    materials,
    bounds: span.bounds,
    triangles: buffers.indexCount / 3,
    drawCalls: buffers.groups.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Carriageway                                                                */
/* -------------------------------------------------------------------------- */

function emitCarriageway(
  builder: MeshBuilder,
  ctx: IGroundContext,
  x0: number,
  z0: number,
  uvScale: number,
  rng: IRandom
): void {
  const cell = CHUNK_SIZE / ROAD_CELLS;
  // Parcels are pushed out by the sidewalk band; a cell entirely inside that
  // union is never visible and is dropped.
  const covers = ctx.blocks
    .filter((_, i) => ctx.zones[i]?.kind !== 'crater')
    .map((b) => offsetPolygon(b.outline, -ctx.sidewalkWidth));

  for (let cz = 0; cz < ROAD_CELLS; cz++) {
    for (let cx = 0; cx < ROAD_CELLS; cx++) {
      const ax = x0 + cx * cell;
      const az = z0 + cz * cell;
      const bx = ax + cell;
      const bz = az + cell;
      if (covers.some((poly) => rectInsidePolygon(poly, ax, az, bx, bz))) continue;
      // A cell whose CENTRE is inside the crater is dropped. Not "any cell the
      // crater reaches": the bowl only covers the disc, so dropping every cell
      // that overlaps it would leave a ragged band of missing ground up to a
      // full 12 m cell wide outside the rim — a hole you fall through rather
      // than a shelf you stand on. The half-cell of asphalt that can overhang
      // the bowl is the deliberate lesser evil.
      const mx = (ax + bx) * 0.5;
      const mz = (az + bz) * 0.5;
      if (ctx.craters.some((c) => Math.hypot(mx - c.centre[0], mz - c.centre[1]) < c.radius)) {
        continue;
      }
      if (ctx.craters.some((c) => rectInsideCircle(c, ax, az, bx, bz))) continue;

      // Slight per-cell tint variation: asphalt is patched, not uniform.
      const wear = 0.88 + rng.next() * 0.2;
      quadXZ(
        builder,
        GroundSlot.Road,
        [
          [ax, az],
          [bx, az],
          [bx, bz],
          [ax, bz],
        ],
        0,
        uvScale,
        [wear, wear, wear * 0.99]
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Parcels                                                                    */
/* -------------------------------------------------------------------------- */

function emitParcel(
  builder: MeshBuilder,
  block: IPlanBlock,
  zone: IPlanZone,
  sidewalkWidth: number,
  pavingUv: number,
  lotUv: number
): void {
  const inner = block.outline;
  const outer = offsetPolygon(inner, -sidewalkWidth);
  const n = inner.length;

  // Sidewalk band between the kerb and the property line.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quadXZ(
      builder,
      GroundSlot.Paving,
      [outer[i], outer[j], inner[j], inner[i]],
      KERB_HEIGHT,
      pavingUv,
      [1, 1, 1]
    );
  }

  // Kerb face, outward-facing so it reads as a step down to the road.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = outer[i];
    const b = outer[j];
    builder.quad(
      GroundSlot.Paving,
      [b[0], 0, b[1]],
      [a[0], 0, a[1]],
      [a[0], KERB_HEIGHT, a[1]],
      [b[0], KERB_HEIGHT, b[1]],
      [0, 0, Math.hypot(b[0] - a[0], b[1] - a[1]) * pavingUv, KERB_HEIGHT * pavingUv],
      [0.86, 0.86, 0.85]
    );
  }

  // Parcel surface behind the property line.
  const lotTint = LOT_TINT[zone.params.lotSurface] ?? [1, 1, 1];
  builder.horizontalPolygon(
    GroundSlot.Lot,
    inner,
    triangulate(inner),
    KERB_HEIGHT,
    lotUv,
    lotTint,
    true
  );
}

const LOT_TINT: Readonly<Record<string, readonly [number, number, number]>> = {
  concrete: [0.94, 0.93, 0.91],
  asphalt: [0.8, 0.8, 0.81],
  gravel: [1, 0.98, 0.94],
  dirt: [0.98, 0.92, 0.84],
  grass: [1, 1, 1],
  cobble: [0.95, 0.94, 0.92],
};

/* -------------------------------------------------------------------------- */
/* Markings                                                                   */
/* -------------------------------------------------------------------------- */

const MARK_Y = 0.028;
const MARK_WHITE: readonly [number, number, number] = [1, 1, 1];

function emitMarkings(builder: MeshBuilder, ctx: IGroundContext, x0: number, z0: number): void {
  const uv = uvScaleFor(CITY_MATERIALS.road.markings);
  const x1 = x0 + CHUNK_SIZE;
  const z1 = z0 + CHUNK_SIZE;

  for (const road of ctx.roads) {
    if (road.markings === 'none') continue;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 0.5) continue;
      const dx = (b[0] - a[0]) / length;
      const dz = (b[1] - a[1]) / length;
      const nx = dz;
      const nz = -dx;

      // Centre line.
      const dash = road.markings === 'centre-solid' || road.markings === 'divided' ? length : 3.2;
      const gap = dash === length ? 0 : 3.4;
      const offsets =
        road.markings === 'divided' ? [-0.55, 0.55] : road.markings === 'lane-dashed' ? [0] : [0];

      for (const lateral of offsets) {
        let t = 0;
        while (t < length) {
          const seg = Math.min(dash, length - t);
          const sx = a[0] + dx * t + nx * lateral;
          const sz = a[1] + dz * t + nz * lateral;
          const ex = a[0] + dx * (t + seg) + nx * lateral;
          const ez = a[1] + dz * (t + seg) + nz * lateral;
          clippedStripe(builder, sx, sz, ex, ez, 0.14, uv, x0, z0, x1, z1);
          t += seg + gap;
        }
      }

      // Solid edge lines, set in from the kerb.
      const edge = road.width * 0.5 - 0.45;
      if (edge > 1) {
        for (const side of [-edge, edge]) {
          const sx = a[0] + nx * side;
          const sz = a[1] + nz * side;
          const ex = b[0] + nx * side;
          const ez = b[1] + nz * side;
          clippedStripe(builder, sx, sz, ex, ez, 0.12, uv, x0, z0, x1, z1);
        }
      }
    }
  }

  // Zebra crossings at signalled junctions inside this chunk.
  for (const junction of ctx.plan.intersections) {
    if (!junction.crossings) continue;
    const [jx, jz] = junction.position;
    if (jx < x0 - 24 || jx > x1 + 24 || jz < z0 - 24 || jz > z1 + 24) continue;
    for (const [dirX, dirZ] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const offset = junction.radius + 1.4;
      for (const sign of [-1, 1]) {
        const cx = jx + dirX * offset * sign;
        const cz = jz + dirZ * offset * sign;
        if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
        const acrossX = dirZ;
        const acrossZ = dirX;
        const halfSpan = junction.radius;
        for (let s = -halfSpan + 0.8; s < halfSpan - 0.4; s += 1.15) {
          const px = cx + acrossX * s;
          const pz = cz + acrossZ * s;
          stripe(
            builder,
            px - dirX * 1.5,
            pz - dirZ * 1.5,
            px + dirX * 1.5,
            pz + dirZ * 1.5,
            0.42,
            uv
          );
        }
      }
    }
  }
}

/**
 * A stripe clipped to the chunk it is being emitted into.
 *
 * `ctx.roads` holds every road whose padded bounding box touches this chunk,
 * and the committed plan's road segments are 768 m long — so an unclipped
 * stripe puts the WHOLE segment into each of the nine chunks the box spans:
 * nine coincident copies, a ~800 m bounding sphere on the ground mesh that
 * frustum culling can never reject, and a chunk AABB that no longer contains
 * its own geometry. Clipping makes the per-chunk markings a partition.
 *
 * The rect is treated as half-open on its max edges so a stripe lying exactly
 * on a chunk boundary belongs to one chunk rather than to both.
 */
function clippedStripe(
  builder: MeshBuilder,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  width: number,
  uv: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number
): void {
  const clipped = clipSegmentToRect(ax, az, bx, bz, x0, z0, x1 - EDGE_EPSILON, z1 - EDGE_EPSILON);
  if (!clipped) return;
  stripe(builder, clipped[0], clipped[1], clipped[2], clipped[3], width, uv);
}

/** Sub-millimetre inset that makes the chunk rect half-open on its max edges. */
const EDGE_EPSILON = 1e-6;

/**
 * Liang–Barsky: the part of segment a->b inside the rect, or undefined when
 * none of it is.
 */
function clipSegmentToRect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number
): [number, number, number, number] | undefined {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  const accept = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // parallel to this edge: inside or wholly out
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!accept(-dx, ax - x0)) return undefined;
  if (!accept(dx, x1 - ax)) return undefined;
  if (!accept(-dz, az - z0)) return undefined;
  if (!accept(dz, z1 - az)) return undefined;
  return [ax + dx * t0, az + dz * t0, ax + dx * t1, az + dz * t1];
}

/** One painted stripe: a thin quad lying just above the asphalt. */
function stripe(
  builder: MeshBuilder,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  width: number,
  uv: number
): void {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 1e-4) return;
  const nx = ((bz - az) / len) * width * 0.5;
  const nz = (-(bx - ax) / len) * width * 0.5;
  quadXZ(
    builder,
    GroundSlot.Markings,
    [
      [ax + nx, az + nz],
      [bx + nx, bz + nz],
      [bx - nx, bz - nz],
      [ax - nx, az - nz],
    ],
    MARK_Y,
    uv,
    MARK_WHITE
  );
}

/* -------------------------------------------------------------------------- */
/* Craters                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A bowl of rings, clipped to the chunk. The rim is raised and the floor is
 * dropped, so the hole reads from the ground and from the air; a flat disc of
 * darker texture does neither.
 */
function emitCrater(
  builder: MeshBuilder,
  crater: IPlanCrater,
  x0: number,
  z0: number,
  uvScale: number
): void {
  const rings = 7;
  const segments = 28;
  const x1 = x0 + CHUNK_SIZE;
  const z1 = z0 + CHUNK_SIZE;

  const height = (t: number, jitter: number) => {
    // t = 0 at the centre, 1 at the rim.
    if (t >= 1) return 0;
    const bowl = -crater.depth * (1 - t * t);
    const lip = crater.rim * Math.pow(t, 6);
    return bowl + lip + jitter;
  };

  /**
   * Rubble jitter, one value per LATTICE POINT.
   *
   * Drawing it per quad gives the two quads either side of an edge different
   * heights for the same XZ position — a 0.6 m step at every one of the ~370
   * internal seams, i.e. a bowl you can see through and a discontinuous
   * physics proxy. It is seeded from the crater id rather than from the
   * chunk's rng because the bowl spans several chunks and they have to agree
   * on the vertices they share.
   */
  const jitterRng = createRng(hashString(`crater:${crater.id}`));
  const jitter: number[][] = [];
  for (let r = 0; r <= rings; r++) {
    const row: number[] = [];
    for (let s = 0; s < segments; s++) row.push(jitterRng.range(-0.35, 0.35) * crater.rubble);
    // The centre ring is a single point; per-segment values there would spike
    // the bowl floor into a needle.
    if (r === 0) row.fill(row[0]);
    jitter.push(row);
  }
  const at = (r: number, s: number) => height(r / rings, jitter[r][s % segments]);

  for (let r = 0; r < rings; r++) {
    const t0 = r / rings;
    const t1 = (r + 1) / rings;
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      const pts: [number, number][] = [
        [
          crater.centre[0] + Math.cos(a0) * crater.radius * t0,
          crater.centre[1] + Math.sin(a0) * crater.radius * t0,
        ],
        [
          crater.centre[0] + Math.cos(a1) * crater.radius * t0,
          crater.centre[1] + Math.sin(a1) * crater.radius * t0,
        ],
        [
          crater.centre[0] + Math.cos(a1) * crater.radius * t1,
          crater.centre[1] + Math.sin(a1) * crater.radius * t1,
        ],
        [
          crater.centre[0] + Math.cos(a0) * crater.radius * t1,
          crater.centre[1] + Math.sin(a0) * crater.radius * t1,
        ],
      ];
      // Clip to the chunk so the crater streams with the chunks it touches.
      if (!pts.some((p) => p[0] >= x0 - 2 && p[0] <= x1 + 2 && p[1] >= z0 - 2 && p[1] <= z1 + 2)) {
        continue;
      }
      // Dark at the floor, bright at the blast rim: from directly above that
      // gradient is the only thing that says "hole" rather than "dirt patch".
      const shade = 0.42 + t1 * 0.72;
      // Wound tangential-then-radial so the face points up; the reverse
      // order gives a bowl you can only see from underneath.
      builder.quad(
        GroundSlot.Lot,
        [pts[0][0], at(r, s), pts[0][1]],
        [pts[1][0], at(r, s + 1), pts[1][1]],
        [pts[2][0], at(r + 1, s + 1), pts[2][1]],
        [pts[3][0], at(r + 1, s), pts[3][1]],
        [pts[0][0] * uvScale, pts[0][1] * uvScale, pts[2][0] * uvScale, pts[2][1] * uvScale],
        shadeTint([0.82, 0.78, 0.72], shade)
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Materials                                                                  */
/* -------------------------------------------------------------------------- */

function pickGroundMaterials(ctx: IGroundContext): IGroundMaterials {
  // The FIRST block's zone decides the surfaces for the whole chunk, so a
  // chunk never has two competing asphalts. The committed plan puts exactly
  // one parcel in each chunk, which is what makes "first" and "dominant" the
  // same thing; a chunk holding two parcels would take the plan-order one,
  // and its sidewalk width, rather than the larger.
  const zone = ctx.zones[0];
  const kind = zone?.kind ?? 'residential';
  const surface = zone?.params.lotSurface ?? 'concrete';

  const road =
    kind === 'crater' || kind === 'ghost'
      ? CITY_MATERIALS.road.damaged
      : kind === 'downtown' || kind === 'civic'
        ? CITY_MATERIALS.road.clean
        : kind === 'industrial'
          ? CITY_MATERIALS.road.rough
          : CITY_MATERIALS.road.worn;

  const paving =
    kind === 'downtown' || kind === 'civic'
      ? CITY_MATERIALS.ground.plaza
      : kind === 'shopping'
        ? CITY_MATERIALS.ground.sidewalkSlabs
        : CITY_MATERIALS.ground.sidewalkConcrete;

  const lot =
    surface === 'grass'
      ? CITY_MATERIALS.ground.grass
      : surface === 'gravel'
        ? CITY_MATERIALS.ground.gravel
        : surface === 'dirt'
          ? CITY_MATERIALS.ground.dirt
          : surface === 'cobble'
            ? CITY_MATERIALS.road.cobble
            : surface === 'asphalt'
              ? CITY_MATERIALS.road.worn
              : CITY_MATERIALS.ground.sidewalkConcrete;

  return { road, paving, lot, markings: CITY_MATERIALS.road.markings };
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Emit a flat, up-facing quad from four CCW points in the XZ plane. */
function quadXZ(
  builder: MeshBuilder,
  slot: number,
  ring: readonly (readonly [number, number])[],
  y: number,
  uvScale: number,
  color: readonly [number, number, number]
): void {
  builder.horizontalPolygon(slot, ring, [0, 1, 2, 0, 2, 3], y, uvScale, color, true);
}

function rectInsidePolygon(poly: Polygon, ax: number, az: number, bx: number, bz: number): boolean {
  // Cheap conservative test: axis-aligned parcels are the common case, and a
  // false negative only costs a hidden quad.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return ax >= minX && bx <= maxX && az >= minZ && bz <= maxZ;
}

function rectInsideCircle(
  crater: IPlanCrater,
  ax: number,
  az: number,
  bx: number,
  bz: number
): boolean {
  const r = crater.radius;
  const [cx, cz] = crater.centre;
  const corners: [number, number][] = [
    [ax, az],
    [bx, az],
    [bx, bz],
    [ax, bz],
  ];
  return corners.every(([x, z]) => (x - cx) ** 2 + (z - cz) ** 2 <= r * r);
}

/* -------------------------------------------------------------------------- */
/* Region merge                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Merge several chunks' ground into one geometry.
 *
 * Ground is generated per chunk so it can stream, but a resident region of 25
 * chunks would otherwise cost 100 draw calls before a single building is
 * drawn. Merging the region collapses that back to four. Only chunks sharing
 * the same four material ids can merge, so the result is grouped by material
 * set.
 */
export function mergeChunkGrounds(builds: readonly IGroundBuild[]): IGroundBuild[] {
  const byKey = new Map<string, IGroundBuild[]>();
  for (const build of builds) {
    const key = `${build.materials.road}|${build.materials.paving}|${build.materials.lot}|${build.materials.markings}`;
    const list = byKey.get(key);
    if (list) list.push(build);
    else byKey.set(key, [build]);
  }
  const out: IGroundBuild[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const group = byKey.get(key)!;
    const merged = mergeGeometries(
      group.map((g) => g.buffers),
      GROUND_SLOT_COUNT
    );
    const bounds: AABB6 = [
      Math.min(...group.map((g) => g.bounds[0])),
      Math.min(...group.map((g) => g.bounds[1])),
      Math.min(...group.map((g) => g.bounds[2])),
      Math.max(...group.map((g) => g.bounds[3])),
      Math.max(...group.map((g) => g.bounds[4])),
      Math.max(...group.map((g) => g.bounds[5])),
    ];
    out.push({
      buffers: merged.buffers,
      materials: group[0].materials,
      bounds,
      triangles: merged.buffers.indexCount / 3,
      drawCalls: merged.buffers.groups.length,
    });
  }
  return out;
}
