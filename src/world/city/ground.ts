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

import { createRng, type IRandom } from '@/util';
import { CHUNK_SIZE } from '@/spatial/constants';
import { MeshBuilder, mergeGeometries, type IGeometryBuffers } from './mesh-builder';
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
    emitParcel(builder, ctx.blocks[i], ctx.zones[i], ctx.sidewalkWidth, pavingUv, lotUv);
  }
  emitMarkings(builder, ctx, x0, z0);
  for (const crater of ctx.craters) emitCrater(builder, crater, x0, z0, lotUv, rng);

  builder.endChunk();
  const buffers = builder.build();
  return {
    buffers,
    materials,
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
  const covers = ctx.blocks.map((b) => offsetPolygon(b.outline, -ctx.sidewalkWidth));

  for (let cz = 0; cz < ROAD_CELLS; cz++) {
    for (let cx = 0; cx < ROAD_CELLS; cx++) {
      const ax = x0 + cx * cell;
      const az = z0 + cz * cell;
      const bx = ax + cell;
      const bz = az + cell;
      if (covers.some((poly) => rectInsidePolygon(poly, ax, az, bx, bz))) continue;
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
  builder.horizontalPolygon(GroundSlot.Lot, inner, triangulate(inner), KERB_HEIGHT, lotUv, lotTint, true);
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
          if (segmentTouchesRect(sx, sz, ex, ez, x0, z0, x1, z1)) {
            stripe(builder, sx, sz, ex, ez, 0.14, uv);
          }
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
          if (segmentTouchesRect(sx, sz, ex, ez, x0, z0, x1, z1)) {
            stripe(builder, sx, sz, ex, ez, 0.12, uv);
          }
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
  uvScale: number,
  rng: IRandom
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

  for (let r = 0; r < rings; r++) {
    const t0 = r / rings;
    const t1 = (r + 1) / rings;
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      const pts: [number, number][] = [
        [crater.centre[0] + Math.cos(a0) * crater.radius * t0, crater.centre[1] + Math.sin(a0) * crater.radius * t0],
        [crater.centre[0] + Math.cos(a1) * crater.radius * t0, crater.centre[1] + Math.sin(a1) * crater.radius * t0],
        [crater.centre[0] + Math.cos(a1) * crater.radius * t1, crater.centre[1] + Math.sin(a1) * crater.radius * t1],
        [crater.centre[0] + Math.cos(a0) * crater.radius * t1, crater.centre[1] + Math.sin(a0) * crater.radius * t1],
      ];
      // Clip to the chunk so the crater streams with the chunks it touches.
      if (!pts.some((p) => p[0] >= x0 - 2 && p[0] <= x1 + 2 && p[1] >= z0 - 2 && p[1] <= z1 + 2)) {
        continue;
      }
      const jitter = () => rng.range(-0.35, 0.35) * crater.rubble;
      const h0 = height(t0, jitter());
      const h1 = height(t1, jitter());
      const shade = 0.66 + t1 * 0.34;
      builder.quad(
        GroundSlot.Lot,
        [pts[0][0], h0, pts[0][1]],
        [pts[3][0], h1, pts[3][1]],
        [pts[2][0], h1, pts[2][1]],
        [pts[1][0], h0, pts[1][1]],
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
  // The busiest zone in the chunk decides the surfaces, so a chunk never has
  // two competing asphalts.
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

function rectInsidePolygon(
  poly: Polygon,
  ax: number,
  az: number,
  bx: number,
  bz: number
): boolean {
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

function segmentTouchesRect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number
): boolean {
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minZ = Math.min(az, bz);
  const maxZ = Math.max(az, bz);
  return maxX >= x0 && minX <= x1 && maxZ >= z0 && minZ <= z1;
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
    out.push({
      buffers: merged.buffers,
      materials: group[0].materials,
      triangles: merged.buffers.indexCount / 3,
      drawCalls: merged.buffers.groups.length,
    });
  }
  return out;
}
