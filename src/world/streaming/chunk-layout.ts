/**
 * DETERMINISTIC CHUNK LAYOUT — WORKER-SAFE, NO `three`, NO `Math.random`
 *
 * Where the buildings in a chunk are. This is the input to geometry generation
 * and it is computed identically on the main thread, on either worker, on a
 * phone and in a unit test, because streaming's correctness rests on exactly
 * one property: **a chunk's content must not depend on when it was loaded.**
 *
 * Three rules enforce that and they are not negotiable:
 *
 *  1. The only entropy source is `createChunkRng(seed, cx, cz)` from `@/util`.
 *     `Math.random()` would make the city different every session; a single
 *     shared generator threaded through the world would make chunk B depend on
 *     whether chunk A was generated first, which is the same bug wearing a
 *     disguise.
 *  2. Independent sub-streams via `derive()`. Adding a prop does not shift the
 *     building layout, so content can be extended without re-rolling the city.
 *  3. NO TRIGONOMETRY anywhere on the geometry path. `Math.sin`/`cos`/`log` are
 *     not bit-identical across platforms — the ES spec explicitly permits
 *     implementation-defined results — so a city built with them would differ
 *     between a phone and a desktop. Everything here is axis-aligned boxes and
 *     quarter-turn rotations, which is also what makes the merged block meshes
 *     and the impostor cheap.
 *
 * ── OWNERSHIP ──────────────────────────────────────────────────────────────
 * This is the streaming workstream's PLACEHOLDER layout: enough real city
 * structure (street grid, districts, blocks, lots, storey variation) to
 * exercise and measure the streamer, with none of the architectural ambition of
 * `src/world/city/**`. When the city workstream lands, its generator registers
 * itself under a new id in `chunk-worker.ts` and this file stops being used at
 * runtime while remaining the fixture the streaming tests are written against.
 */

import { createChunkRng, hashCoord, type IRandom } from '@/util';
import { CHUNK_SIZE, chunkIndex } from '@/spatial/constants';
import {
  ALLEY_WIDTH,
  BLOCK_SIZE,
  FLOOR_HEIGHT,
  FRACTURE_HEIGHT_BANDS,
  FRACTURE_PLAN_DIVISIONS,
  MAX_BUILDINGS_PER_CHUNK,
  STREET_WIDTH,
} from './constants';

/* -------------------------------------------------------------------------- */
/* Districts                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * District classes, in the same vocabulary as `DistrictType` in
 * `@/types/world`. Kept as a local numeric enum so the layout stays a pure
 * numeric structure that a worker can produce without importing type-only
 * modules at runtime.
 */
export const DISTRICT_DOWNTOWN = 0;
export const DISTRICT_RESIDENTIAL = 1;
export const DISTRICT_INDUSTRIAL = 2;
export const DISTRICT_PARK = 3;
export const DISTRICT_WATERFRONT = 4;

/** Human-readable district names, indexed by the constants above. */
export const DISTRICT_NAMES: readonly string[] = [
  'downtown',
  'residential',
  'industrial',
  'park',
  'waterfront',
];

/** Storey range per district, inclusive. */
const DISTRICT_FLOORS: readonly (readonly [number, number])[] = [
  [10, 26],
  [2, 6],
  [1, 4],
  [1, 2],
  [3, 9],
];

/** Fraction of lots actually built on, per district. */
const DISTRICT_FILL: readonly number[] = [0.94, 0.86, 0.7, 0.12, 0.8];

/**
 * Base façade colour per district as packed 0xRRGGBB. Districts read as
 * distinct masses from the air, which is what makes the impostor ring legible.
 */
const DISTRICT_BASE_COLOUR: readonly number[] = [
  0x6d7a92, 0x9a7f6a, 0x77726a, 0x4f6b4a, 0x6f8798,
];

/**
 * District for a chunk, from the world seed alone.
 *
 * A COARSE global rule, not a per-chunk roll: districts are decided on 4x4
 * chunk cells with a hash, so a downtown tower never appears one chunk from
 * farmland. This is the same separation of planning from generation that
 * `DistrictPlan` in `@/types/world` describes, reduced to the smallest form
 * that keeps chunks independently generatable.
 */
export function districtFor(seed: number, cx: number, cz: number): number {
  // Distance from the world centre in chunk units drives the broad zoning:
  // downtown in the middle, industry and water at the rim.
  const ring = Math.max(Math.abs(cx + 0.5), Math.abs(cz + 0.5));
  const cell = hashCoord(cx >> 2, cz >> 2, seed ^ 0x0d15) / 4294967296;

  if (ring < 2.5) return cell < 0.86 ? DISTRICT_DOWNTOWN : DISTRICT_PARK;
  if (ring < 5) {
    if (cell < 0.5) return DISTRICT_DOWNTOWN;
    if (cell < 0.86) return DISTRICT_RESIDENTIAL;
    return DISTRICT_PARK;
  }
  if (ring < 7) {
    if (cell < 0.55) return DISTRICT_RESIDENTIAL;
    if (cell < 0.8) return DISTRICT_INDUSTRIAL;
    return DISTRICT_PARK;
  }
  if (cell < 0.45) return DISTRICT_WATERFRONT;
  if (cell < 0.85) return DISTRICT_INDUSTRIAL;
  return DISTRICT_PARK;
}

/* -------------------------------------------------------------------------- */
/* Layout structures                                                          */
/* -------------------------------------------------------------------------- */

/** One building in a chunk. Axis-aligned; see the no-trigonometry rule. */
export interface IBuildingLayout {
  /** 0..15 within the chunk. The high half of its damage slot index. */
  readonly index: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly floors: number;
  /** `floors * FLOOR_HEIGHT`. */
  readonly height: number;
  /** Packed 0xRRGGBB façade colour. */
  readonly colour: number;
  /** Packed 0xRRGGBB roof colour. */
  readonly roofColour: number;
  /** True when this building participates in destruction (R0 only). */
  readonly destructible: boolean;
  /** Structural integrity budget, mirroring `IBuildingSpec.integrity`. */
  readonly integrity: number;
}

/** A piece of street furniture. Quarter-turn rotations only. */
export interface IPropLayout {
  readonly x: number;
  readonly z: number;
  readonly height: number;
  /** 0..3, a quarter turn about Y. */
  readonly quarterTurns: number;
  readonly colour: number;
}

/** A place an actor may stand. */
export interface ISpawnLayout {
  readonly x: number;
  readonly z: number;
  readonly quarterTurns: number;
}

/** Everything the geometry builder needs about one chunk. */
export interface IChunkLayout {
  readonly chunk: number;
  readonly cx: number;
  readonly cz: number;
  readonly seed: number;
  readonly district: number;
  readonly originX: number;
  readonly originZ: number;
  readonly buildings: readonly IBuildingLayout[];
  readonly props: readonly IPropLayout[];
  readonly spawns: readonly ISpawnLayout[];
  /** Packed 0xRRGGBB colour of the roadway. */
  readonly roadColour: number;
  /** Packed 0xRRGGBB colour of the pavement/sidewalk. */
  readonly pavementColour: number;
}

/* -------------------------------------------------------------------------- */
/* Colour helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Nudge a packed colour by a signed per-channel amount, clamped to 0..255. */
function shade(colour: number, delta: number): number {
  const r = Math.max(0, Math.min(255, ((colour >> 16) & 0xff) + delta));
  const g = Math.max(0, Math.min(255, ((colour >> 8) & 0xff) + delta));
  const b = Math.max(0, Math.min(255, (colour & 0xff) + delta));
  return (r << 16) | (g << 8) | b;
}

/** Per-channel jitter, so no two buildings are quite the same concrete. */
function jitter(colour: number, rng: IRandom, spread: number): number {
  const r = Math.max(0, Math.min(255, ((colour >> 16) & 0xff) + rng.int(-spread, spread)));
  const g = Math.max(0, Math.min(255, ((colour >> 8) & 0xff) + rng.int(-spread, spread)));
  const b = Math.max(0, Math.min(255, (colour & 0xff) + rng.int(-spread, spread)));
  return (r << 16) | (g << 8) | b;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Lay out one chunk. Pure: same arguments always produce the same result, with
 * no dependence on any other chunk or on call order.
 */
export function layoutChunk(seed: number, cx: number, cz: number): IChunkLayout {
  const base = createChunkRng(seed, cx, cz);
  // Independent sub-streams: adding props must not move a single building.
  const lots = base.derive('lots');
  const paint = base.derive('paint');
  const propRng = base.derive('props');
  const spawnRng = base.derive('spawns');

  const district = districtFor(seed, cx, cz);
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const half = STREET_WIDTH * 0.5;
  const blockMinX = originX + half;
  const blockMinZ = originZ + half;

  const floorRange = DISTRICT_FLOORS[district]!;
  const fill = DISTRICT_FILL[district]!;
  const baseColour = DISTRICT_BASE_COLOUR[district]!;

  /* -- buildings -------------------------------------------------------- */

  const buildings: IBuildingLayout[] = [];
  const subdivisions = lots.int(2, 3);
  const lotSize = (BLOCK_SIZE - ALLEY_WIDTH * (subdivisions - 1)) / subdivisions;

  for (let lz = 0; lz < subdivisions; lz++) {
    for (let lx = 0; lx < subdivisions; lx++) {
      if (buildings.length >= MAX_BUILDINGS_PER_CHUNK) break;
      if (lots.next() > fill) continue;

      const lotMinX = blockMinX + lx * (lotSize + ALLEY_WIDTH);
      const lotMinZ = blockMinZ + lz * (lotSize + ALLEY_WIDTH);
      // A small setback on each edge so façades are not perfectly flush —
      // flush façades collapse a city block into one flat wall, which flatters
      // both the occlusion culling and the eye.
      const minX = lotMinX + lots.range(0, lotSize * 0.12);
      const minZ = lotMinZ + lots.range(0, lotSize * 0.12);
      const maxX = lotMinX + lotSize - lots.range(0, lotSize * 0.12);
      const maxZ = lotMinZ + lotSize - lots.range(0, lotSize * 0.12);
      if (maxX - minX < 5 || maxZ - minZ < 5) continue;

      const floors = lots.int(floorRange[0], floorRange[1]);
      const colour = jitter(baseColour, paint, 22);
      buildings.push({
        index: buildings.length,
        minX,
        minZ,
        maxX,
        maxZ,
        floors,
        height: floors * FLOOR_HEIGHT,
        colour,
        roofColour: shade(colour, -34),
        destructible: district !== DISTRICT_PARK,
        integrity: 40 + floors * 18,
      });
    }
  }

  /* -- street furniture ------------------------------------------------- */

  const props: IPropLayout[] = [];
  const propCount = district === DISTRICT_PARK ? 4 : 8;
  const inset = half * 0.55;
  for (let p = 0; p < propCount; p++) {
    const along = propRng.range(6, CHUNK_SIZE - 6);
    const edge = propRng.int(0, 3);
    let x: number;
    let z: number;
    if (edge === 0) {
      x = originX + along;
      z = originZ + inset;
    } else if (edge === 1) {
      x = originX + along;
      z = originZ + CHUNK_SIZE - inset;
    } else if (edge === 2) {
      x = originX + inset;
      z = originZ + along;
    } else {
      x = originX + CHUNK_SIZE - inset;
      z = originZ + along;
    }
    props.push({
      x,
      z,
      height: propRng.range(3.2, 5.4),
      quarterTurns: propRng.int(0, 3),
      colour: propRng.bool(0.25) ? 0xd8c24a : 0x39414d,
    });
  }

  /* -- spawn slots ------------------------------------------------------ */

  const spawns: ISpawnLayout[] = [];
  const spawnCount = district === DISTRICT_DOWNTOWN ? 10 : district === DISTRICT_PARK ? 3 : 6;
  for (let s = 0; s < spawnCount; s++) {
    const along = spawnRng.range(4, CHUNK_SIZE - 4);
    const edge = spawnRng.int(0, 3);
    const lane = half * spawnRng.range(0.25, 0.85);
    let x: number;
    let z: number;
    if (edge === 0) {
      x = originX + along;
      z = originZ + lane;
    } else if (edge === 1) {
      x = originX + along;
      z = originZ + CHUNK_SIZE - lane;
    } else if (edge === 2) {
      x = originX + lane;
      z = originZ + along;
    } else {
      x = originX + CHUNK_SIZE - lane;
      z = originZ + along;
    }
    spawns.push({ x, z, quarterTurns: spawnRng.int(0, 3) });
  }

  return {
    chunk: chunkIndex(cx, cz),
    cx,
    cz,
    seed,
    district,
    originX,
    originZ,
    buildings,
    props,
    spawns,
    roadColour: district === DISTRICT_PARK ? 0x3a4638 : 0x33363c,
    pavementColour: district === DISTRICT_PARK ? 0x5a6b4e : 0x555a63,
  };
}

/* -------------------------------------------------------------------------- */
/* Fracture piece geometry                                                    */
/* -------------------------------------------------------------------------- */

/** One destructible piece of a building: an axis-aligned sub-box. */
export interface IFracturePiece {
  /** 0..15 within the building. The low half of its damage slot index. */
  readonly piece: number;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  /** Vertical band 0..3, 0 being at ground level. */
  readonly band: number;
}

/**
 * Split a building into its 16 fracture pieces: a 2x2 grid in plan by 4
 * vertical bands.
 *
 * Pre-computed and regular rather than a runtime Voronoi fracture, for the same
 * reason `FractureChunk` in `@/types/destruction` is pre-computed: a 300-body
 * collapse has to be affordable on a phone, and the piece a bit refers to has
 * to mean the same thing in a save file written six months ago.
 */
export function fracturePieces(building: IBuildingLayout): IFracturePiece[] {
  const pieces: IFracturePiece[] = [];
  const spanX = (building.maxX - building.minX) / FRACTURE_PLAN_DIVISIONS;
  const spanZ = (building.maxZ - building.minZ) / FRACTURE_PLAN_DIVISIONS;
  const spanY = building.height / FRACTURE_HEIGHT_BANDS;

  for (let band = 0; band < FRACTURE_HEIGHT_BANDS; band++) {
    for (let pz = 0; pz < FRACTURE_PLAN_DIVISIONS; pz++) {
      for (let px = 0; px < FRACTURE_PLAN_DIVISIONS; px++) {
        pieces.push({
          piece: band * FRACTURE_PLAN_DIVISIONS * FRACTURE_PLAN_DIVISIONS +
            pz * FRACTURE_PLAN_DIVISIONS +
            px,
          minX: building.minX + px * spanX,
          minY: band * spanY,
          minZ: building.minZ + pz * spanZ,
          maxX: building.minX + (px + 1) * spanX,
          maxY: (band + 1) * spanY,
          maxZ: building.minZ + (pz + 1) * spanZ,
          band,
        });
      }
    }
  }
  return pieces;
}
