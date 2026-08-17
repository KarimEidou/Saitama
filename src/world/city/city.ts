/**
 * CITY FACADE — THE ENTRY POINT OTHER SYSTEMS CALL
 *
 * One object that owns the loaded plan and turns chunk coordinates into
 * geometry. Streaming holds one of these (per worker, if generation is
 * threaded) and asks it for chunks; nothing else in the codebase needs to know
 * that a plan, a zoning table or a panel kit exist.
 *
 * Everything here is PURE with respect to a given plan: `generate(cx, cz)` may
 * be called in any order, on any thread, any number of times, and returns the
 * same bytes. That is the property the whole design is built to preserve, and
 * it is what `determinism.test.ts` pins down.
 */

import { CHUNK_COORD_MAX, CHUNK_COORD_MIN, CHUNK_SIZE } from '@/spatial/constants';
import type { ILODLevel, IWorldConfig } from '@/types';
import { loadPlan, type ICityPlanIndex } from './plan';
import type { ICityPlan } from './plan-types';
import { generateChunk, type ICityChunkBuild, type IChunkGenOptions } from './chunk';
import type { BuildingDetail } from './building';
import { allCityMaterialKeys } from './materials';
import { allPropAssetKeys } from './props';

/** Options for the generator as a whole. */
export interface ICityOptions {
  /** Detail used when a caller does not specify one. */
  readonly defaultDetail?: BuildingDetail;
  /** Include street furniture by default. */
  readonly includeProps?: boolean;
}

/**
 * Detail bands by distance in metres from the streaming focus.
 *
 * The bands are what keeps the visible city inside the draw-call budget: the
 * near ring is fully detailed, the middle drops facade relief, and everything
 * beyond becomes an extruded footprint with a roof — which is all you can
 * resolve at that range anyway, and which is exactly what a top-down district
 * map wants.
 */
export const DETAIL_BANDS: readonly { readonly maxDistance: number; readonly detail: BuildingDetail }[] =
  [
    { maxDistance: 160, detail: 'full' },
    { maxDistance: 380, detail: 'reduced' },
    { maxDistance: Infinity, detail: 'box' },
  ];

/** Pick a building detail for a chunk at a given distance from the focus. */
export function detailForDistance(distance: number): BuildingDetail {
  for (const band of DETAIL_BANDS) if (distance < band.maxDistance) return band.detail;
  return 'box';
}

/** The city generator. */
export class CityGenerator {
  readonly index: ICityPlanIndex;
  private readonly options: Required<ICityOptions>;

  constructor(plan: ICityPlan, options: ICityOptions = {}) {
    this.index = loadPlan(plan);
    this.options = {
      defaultDetail: options.defaultDetail ?? 'full',
      includeProps: options.includeProps ?? true,
    };
  }

  /** The plan this generator was built from. */
  get plan(): ICityPlan {
    return this.index.plan;
  }

  /** Generate one chunk. */
  generate(cx: number, cz: number, overrides: Partial<IChunkGenOptions> = {}): ICityChunkBuild {
    return generateChunk(this.index, cx, cz, {
      detail: overrides.detail ?? this.options.defaultDetail,
      includeProps: overrides.includeProps ?? this.options.includeProps,
      includeGround: overrides.includeGround,
    });
  }

  /** Generate a square region of chunks, in row-major order. */
  generateRegion(
    centreX: number,
    centreZ: number,
    radiusChunks: number,
    overrides: Partial<IChunkGenOptions> = {}
  ): ICityChunkBuild[] {
    const out: ICityChunkBuild[] = [];
    for (let cz = centreZ - radiusChunks; cz <= centreZ + radiusChunks; cz++) {
      for (let cx = centreX - radiusChunks; cx <= centreX + radiusChunks; cx++) {
        if (cx < CHUNK_COORD_MIN || cx > CHUNK_COORD_MAX) continue;
        if (cz < CHUNK_COORD_MIN || cz > CHUNK_COORD_MAX) continue;
        out.push(this.generate(cx, cz, overrides));
      }
    }
    return out;
  }

  /** Every chunk in the world. Only for offline analysis and the district map. */
  generateAll(overrides: Partial<IChunkGenOptions> = {}): ICityChunkBuild[] {
    return this.generateRegion(0, 0, 8, overrides);
  }

  /** Asset ids the city needs resident before it can render correctly. */
  requiredAssets(): { materials: string[]; models: string[] } {
    return { materials: allCityMaterialKeys(), models: allPropAssetKeys() };
  }

  /** A world config matching the plan, for `IStreamingSystem`. */
  worldConfig(lodLevels: readonly ILODLevel[]): IWorldConfig {
    return {
      seed: this.plan.worldSeed,
      chunkSize: CHUNK_SIZE,
      worldRadiusChunks: (this.plan.chunkGrid >> 1) - 1,
      lodLevels,
      streamingRadiusChunks: 2,
      evictionRadiusChunks: 4,
      maxConcurrentLoads: 2,
      memoryBudgetBytes: 192 * 1024 * 1024,
      groundLevel: this.plan.groundLevel,
      gravity: -19.6,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Budget accounting                                                          */
/* -------------------------------------------------------------------------- */

/** Draw-call breakdown for a set of chunks. */
export interface IDrawCallReport {
  readonly chunks: number;
  readonly blocks: number;
  /** Draw calls from merged block geometry (3 per block at most). */
  readonly blockCalls: number;
  /** Draw calls from ground, after merging the region. */
  readonly groundCalls: number;
  /** Draw calls from instanced props, after merging batches across chunks. */
  readonly propCalls: number;
  readonly total: number;
  readonly triangles: number;
  /** Highest per-block draw-call count seen; must never exceed 3. */
  readonly worstBlockCalls: number;
}

/**
 * Count what a resident set actually costs, with the region-level merges the
 * runtime performs applied.
 *
 * Counting per chunk in isolation over-reports badly: ground merges across the
 * whole region into four calls, and prop batches merge by asset key. This
 * reports the number a frame would really issue.
 */
export function reportDrawCalls(builds: readonly ICityChunkBuild[]): IDrawCallReport {
  let blocks = 0;
  let blockCalls = 0;
  let triangles = 0;
  let worstBlockCalls = 0;
  const groundSets = new Set<string>();
  const propKeys = new Set<string>();

  for (const build of builds) {
    triangles += build.triangles;
    for (const block of build.blocks) {
      blocks++;
      blockCalls += block.drawCalls;
      if (block.drawCalls > worstBlockCalls) worstBlockCalls = block.drawCalls;
    }
    if (build.ground) {
      const m = build.ground.materials;
      groundSets.add(`${m.road}|${m.paving}|${m.lot}|${m.markings}`);
    }
    for (const batch of build.instances) propKeys.add(batch.assetKey);
  }

  const groundCalls = groundSets.size * 4;
  const propCalls = propKeys.size;
  return {
    chunks: builds.length,
    blocks,
    blockCalls,
    groundCalls,
    propCalls,
    total: blockCalls + groundCalls + propCalls,
    triangles,
    worstBlockCalls,
  };
}
