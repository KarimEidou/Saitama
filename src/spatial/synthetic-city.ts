/**
 * SYNTHETIC CITY-BLOCK LAYOUT — A FIXTURE, NOT THE CITY GENERATOR
 *
 * The real City Z is produced by the world-generation workstream. This file
 * exists because a culling structure cannot be evaluated against random boxes:
 * random boxes have no occlusion structure, so a PVS measured on them reports
 * a cull rate that says nothing about the game.
 *
 * What it produces is the geometry PVS culling actually depends on — a regular
 * street grid with solid blocks between the streets — at the exact dimensions
 * of City Z: one 96 m block per chunk, streets between them, buildings tall
 * enough that a footprint is a genuine sightline blocker. That makes the
 * measured cull rates in the test suite and the harness meaningful.
 *
 * Fully deterministic and order-independent: each chunk draws from a stream
 * derived from `(seed, chunkX, chunkZ)` via `createChunkRng`, so chunk 200 is
 * identical whether or not chunk 0 was generated first.
 */

import { createChunkRng, type IRandom } from '@/util';
import { CHUNK_GRID, CHUNK_SIZE, WORLD_MIN, chunkIndex } from './constants';
import type { IFootprint } from './pvs';

/** One static instance: a world-space AABB with the chunk that owns it. */
export interface ISyntheticInstance {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  /** Dense chunk index 0..255. */
  readonly chunk: number;
  /** True for buildings (occluders), false for props (non-occluding). */
  readonly occluder: boolean;
}

/** A street-level position a camera can legitimately stand at. */
export interface IStreetPoint {
  readonly x: number;
  readonly z: number;
  readonly chunk: number;
}

/** Layout knobs. */
export interface ISyntheticCityOptions {
  readonly seed?: number;
  /** Total street width between adjacent blocks, in metres. */
  readonly streetWidth?: number;
  /** Gap between buildings inside a block, in metres. */
  readonly alleyWidth?: number;
  /** Probability a chunk is an open park/plaza with no buildings. */
  readonly parkChance?: number;
  /** Probability a lot inside a block is actually built on. */
  readonly lotFillChance?: number;
  /** Metres per storey. */
  readonly floorHeight?: number;
  /** Storey range, inclusive. */
  readonly floorRange?: readonly [number, number];
  /** Street props (lamp posts, signage) generated per chunk. */
  readonly propsPerChunk?: number;
}

/** The generated layout. */
export interface ISyntheticCity {
  readonly seed: number;
  /** Every static AABB — buildings and props — for the quadtree. */
  readonly instances: readonly ISyntheticInstance[];
  /** Building footprints only, for the PVS builder. */
  readonly footprints: readonly IFootprint[];
  /** Camera sample positions on the street network. */
  readonly streetPoints: readonly IStreetPoint[];
  readonly buildingCount: number;
  readonly propCount: number;
  /** Chunks with no buildings at all. */
  readonly parkChunks: readonly number[];
}

/**
 * Generate the layout.
 *
 * Streets run along chunk boundaries, so a block is `96 - streetWidth` metres
 * across and every chunk boundary is a clear sightline corridor — the geometry
 * that makes a 2D PVS worth having in the first place.
 */
export function generateSyntheticCity(options: ISyntheticCityOptions = {}): ISyntheticCity {
  const seed = options.seed ?? 0x0c17972;
  const streetWidth = options.streetWidth ?? 16;
  const alleyWidth = options.alleyWidth ?? 4;
  const parkChance = options.parkChance ?? 0.1;
  const lotFillChance = options.lotFillChance ?? 0.86;
  const floorHeight = options.floorHeight ?? 3.6;
  const floorRange = options.floorRange ?? [3, 14];
  const propsPerChunk = options.propsPerChunk ?? 8;

  const instances: ISyntheticInstance[] = [];
  const footprints: IFootprint[] = [];
  const streetPoints: IStreetPoint[] = [];
  const parkChunks: number[] = [];
  let buildingCount = 0;
  let propCount = 0;

  const half = streetWidth * 0.5;

  for (let cz = 0; cz < CHUNK_GRID; cz++) {
    for (let cx = 0; cx < CHUNK_GRID; cx++) {
      const chunk = cz * CHUNK_GRID + cx;
      const rng = createChunkRng(seed, cx, cz);

      const originX = WORLD_MIN + cx * CHUNK_SIZE;
      const originZ = WORLD_MIN + cz * CHUNK_SIZE;
      const blockMinX = originX + half;
      const blockMinZ = originZ + half;
      const blockSize = CHUNK_SIZE - streetWidth;

      // Street sample points: the four mid-edges of the chunk, which sit in the
      // middle of the roadway rather than inside a building.
      streetPoints.push(
        { x: originX + CHUNK_SIZE * 0.5, z: originZ + half * 0.5, chunk },
        { x: originX + CHUNK_SIZE * 0.5, z: originZ + CHUNK_SIZE - half * 0.5, chunk },
        { x: originX + half * 0.5, z: originZ + CHUNK_SIZE * 0.5, chunk },
        { x: originX + CHUNK_SIZE - half * 0.5, z: originZ + CHUNK_SIZE * 0.5, chunk }
      );

      // Street furniture sits in the roadway. Props are NOT occluders — a lamp
      // post does not block a sightline, and treating it as one would make the
      // PVS wrongly optimistic.
      for (let p = 0; p < propsPerChunk; p++) {
        const alongEdge = rng.next() * CHUNK_SIZE;
        const edge = rng.int(0, 3);
        const inset = half * 0.6;
        let px: number;
        let pz: number;
        if (edge === 0) {
          px = originX + alongEdge;
          pz = originZ + inset;
        } else if (edge === 1) {
          px = originX + alongEdge;
          pz = originZ + CHUNK_SIZE - inset;
        } else if (edge === 2) {
          px = originX + inset;
          pz = originZ + alongEdge;
        } else {
          px = originX + CHUNK_SIZE - inset;
          pz = originZ + alongEdge;
        }
        const height = rng.range(2.5, 6);
        instances.push({
          minX: px - 0.25,
          minY: 0,
          minZ: pz - 0.25,
          maxX: px + 0.25,
          maxY: height,
          maxZ: pz + 0.25,
          chunk,
          occluder: false,
        });
        propCount++;
      }

      if (rng.next() < parkChance) {
        parkChunks.push(chunk);
        continue;
      }

      const subdivisions = rng.int(2, 3);
      const lotSize = (blockSize - alleyWidth * (subdivisions - 1)) / subdivisions;

      for (let lz = 0; lz < subdivisions; lz++) {
        for (let lx = 0; lx < subdivisions; lx++) {
          if (rng.next() > lotFillChance) continue;

          const lotMinX = blockMinX + lx * (lotSize + alleyWidth);
          const lotMinZ = blockMinZ + lz * (lotSize + alleyWidth);
          // Small random setback so façades are not perfectly flush; this is
          // what stops the PVS from degenerating into "the grid is one wall".
          const setbackX = rng.range(0, lotSize * 0.12);
          const setbackZ = rng.range(0, lotSize * 0.12);
          const minX = lotMinX + setbackX;
          const minZ = lotMinZ + setbackZ;
          const maxX = lotMinX + lotSize - rng.range(0, lotSize * 0.12);
          const maxZ = lotMinZ + lotSize - rng.range(0, lotSize * 0.12);
          if (maxX - minX < 4 || maxZ - minZ < 4) continue;

          const floors = rng.int(floorRange[0], floorRange[1]);
          instances.push({
            minX,
            minY: 0,
            minZ,
            maxX,
            maxY: floors * floorHeight,
            maxZ,
            chunk,
            occluder: true,
          });
          footprints.push({ minX, minZ, maxX, maxZ });
          buildingCount++;
        }
      }
    }
  }

  return {
    seed,
    instances,
    footprints,
    streetPoints,
    buildingCount,
    propCount,
    parkChunks,
  };
}

/** A camera pose used for cull-rate measurement. */
export interface ICameraSample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  /** Dense index of the chunk the camera stands in. */
  readonly chunk: number;
}

/**
 * Deterministic street-level camera poses over a generated city.
 *
 * Eye height is 1.7 m and pitch stays near horizontal, because that is where
 * PVS culling is decided — a camera looking down from 200 m sees over every
 * roof and no visibility structure can help it.
 */
export function sampleStreetCameras(
  city: ISyntheticCity,
  count: number,
  seed = 0xca5eca,
  eyeHeight = 1.7
): ICameraSample[] {
  const rng: IRandom = createChunkRng(seed, count, city.seed);
  const samples: ICameraSample[] = [];
  const points = city.streetPoints;
  if (points.length === 0) return samples;

  for (let i = 0; i < count; i++) {
    const point = points[rng.int(0, points.length - 1)]!;
    const jitterX = rng.range(-3, 3);
    const jitterZ = rng.range(-3, 3);
    const x = point.x + jitterX;
    const z = point.z + jitterZ;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    samples.push({
      x,
      y: eyeHeight,
      z,
      yaw: rng.range(0, Math.PI * 2),
      pitch: rng.range(-0.12, 0.12),
      chunk: chunkIndex(cx, cz),
    });
  }
  return samples;
}
