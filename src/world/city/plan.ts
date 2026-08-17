/**
 * PLAN LOADING, VALIDATION AND INDEXING
 *
 * `assets/district/cityz.plan.json` is data, and data that has been hand-edited
 * is data that is sometimes wrong. Everything downstream — block generation,
 * streaming, spawn placement — assumes the plan is internally consistent, so
 * the checks happen once, here, with messages a designer can act on rather
 * than a `TypeError` from three modules deeper.
 *
 * The index built alongside is what makes generation cheap: a chunk generator
 * asks "which blocks are in chunk (3, -5)?" hundreds of times a session, and
 * that must be an array lookup rather than a scan over 256 blocks.
 *
 * SEEDS. `blockSeed(planVersion, blockId)` is the single derivation point for
 * every procedural decision inside a block. It folds the plan version in, so
 * bumping the version after an authored change deterministically rerolls
 * procedural detail rather than leaving fill that no longer suits the new
 * zoning. Nothing in the city may call `Math.random()`.
 */

import { hashString, mixSeeds } from '@/util';
import {
  CHUNK_COORD_MAX,
  CHUNK_COORD_MIN,
  CHUNK_COUNT,
  CHUNK_GRID,
  CHUNK_SIZE,
  WORLD_SIZE,
  chunkIndex,
} from '@/spatial/constants';
import type { ICityPlan, IPlanBlock, IPlanLandmark, IPlanRoad, IPlanZone } from './plan-types';
import { pointInPolygon, polygonArea, polygonBounds, type Vec2 } from './polygon';

/**
 * Deterministic seed for everything generated inside a block.
 *
 * `hash(blockId, planVersion)` exactly as specified: the id gives spatial
 * independence (blocks generate in any order, on any thread, and match), the
 * version gives editability.
 */
export function blockSeed(planVersion: number, blockId: string): number {
  return mixSeeds(hashString(blockId), planVersion >>> 0);
}

/** Seed for a landmark's procedural detail. */
export function landmarkSeed(planVersion: number, landmarkId: string): number {
  return mixSeeds(hashString(`landmark:${landmarkId}`), planVersion >>> 0);
}

/* -------------------------------------------------------------------------- */
/* Index                                                                      */
/* -------------------------------------------------------------------------- */

/** Random-access views over a plan, built once at load. */
export interface ICityPlanIndex {
  readonly plan: ICityPlan;
  readonly zoneById: ReadonlyMap<string, IPlanZone>;
  readonly blockById: ReadonlyMap<string, IPlanBlock>;
  readonly roadById: ReadonlyMap<string, IPlanRoad>;
  readonly landmarkById: ReadonlyMap<string, IPlanLandmark>;
  /** Blocks per dense chunk index, 0..255. Always length `CHUNK_COUNT`. */
  readonly blocksByChunk: readonly (readonly IPlanBlock[])[];
  /** Landmarks per dense chunk index. */
  readonly landmarksByChunk: readonly (readonly IPlanLandmark[])[];
  /** Roads whose bounding box touches a chunk, per dense chunk index. */
  readonly roadsByChunk: readonly (readonly IPlanRoad[])[];
  /** Zone containing a world point, honouring `priority`. */
  zoneAt(x: number, z: number): IPlanZone | undefined;
  /** Zone a block belongs to; falls back to the point test at its centre. */
  zoneOfBlock(block: IPlanBlock): IPlanZone;
}

/** Build the index. Assumes the plan has already passed `validatePlan`. */
export function indexPlan(plan: ICityPlan): ICityPlanIndex {
  const zoneById = new Map(plan.zones.map((z) => [z.id, z]));
  const blockById = new Map(plan.blocks.map((b) => [b.id, b]));
  const roadById = new Map(plan.roads.map((r) => [r.id, r]));
  const landmarkById = new Map(plan.landmarks.map((l) => [l.id, l]));

  const blocksByChunk: IPlanBlock[][] = Array.from({ length: CHUNK_COUNT }, () => []);
  for (const block of plan.blocks) {
    const index = chunkIndex(block.chunk[0], block.chunk[1]);
    if (index >= 0) blocksByChunk[index].push(block);
  }

  const landmarksByChunk: IPlanLandmark[][] = Array.from({ length: CHUNK_COUNT }, () => []);
  for (const landmark of plan.landmarks) {
    const cx = Math.floor(landmark.position[0] / CHUNK_SIZE);
    const cz = Math.floor(landmark.position[1] / CHUNK_SIZE);
    const index = chunkIndex(cx, cz);
    if (index >= 0) landmarksByChunk[index].push(landmark);
  }

  const roadsByChunk: IPlanRoad[][] = Array.from({ length: CHUNK_COUNT }, () => []);
  for (const road of plan.roads) {
    const bounds = polygonBounds(road.points);
    const pad = road.width * 0.5 + road.sidewalk + 2;
    const cx0 = Math.max(CHUNK_COORD_MIN, Math.floor((bounds.minX - pad) / CHUNK_SIZE));
    const cx1 = Math.min(CHUNK_COORD_MAX, Math.floor((bounds.maxX + pad) / CHUNK_SIZE));
    const cz0 = Math.max(CHUNK_COORD_MIN, Math.floor((bounds.minZ - pad) / CHUNK_SIZE));
    const cz1 = Math.min(CHUNK_COORD_MAX, Math.floor((bounds.maxZ + pad) / CHUNK_SIZE));
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const index = chunkIndex(cx, cz);
        if (index >= 0) roadsByChunk[index].push(road);
      }
    }
  }

  // Zones sorted once by descending priority so the point test can stop early.
  const zonesByPriority = plan.zones.slice().sort((a, b) => b.priority - a.priority);
  const fallbackZone = zonesByPriority[zonesByPriority.length - 1];

  const zoneAt = (x: number, z: number): IPlanZone | undefined => {
    for (const zone of zonesByPriority) {
      if (pointInPolygon(zone.polygon, x, z)) return zone;
    }
    return undefined;
  };

  return {
    plan,
    zoneById,
    blockById,
    roadById,
    landmarkById,
    blocksByChunk,
    landmarksByChunk,
    roadsByChunk,
    zoneAt,
    zoneOfBlock(block) {
      const named = zoneById.get(block.zone);
      if (named) return named;
      let cx = 0;
      let cz = 0;
      for (const p of block.outline) {
        cx += p[0];
        cz += p[1];
      }
      const n = Math.max(1, block.outline.length);
      return zoneAt(cx / n, cz / n) ?? fallbackZone;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Check a plan against every invariant generation relies on. Returns human
 * readable problems; an empty array means the plan is safe to generate from.
 */
export function validatePlan(plan: ICityPlan): string[] {
  const problems: string[] = [];

  if (plan.worldSize !== WORLD_SIZE) {
    problems.push(`worldSize ${plan.worldSize} != WORLD_SIZE ${WORLD_SIZE}`);
  }
  if (plan.chunkSize !== CHUNK_SIZE) {
    problems.push(`chunkSize ${plan.chunkSize} != CHUNK_SIZE ${CHUNK_SIZE}`);
  }
  if (plan.chunkGrid !== CHUNK_GRID) {
    problems.push(`chunkGrid ${plan.chunkGrid} != CHUNK_GRID ${CHUNK_GRID}`);
  }
  if (!Number.isInteger(plan.planVersion) || plan.planVersion < 1) {
    problems.push(`planVersion must be a positive integer, got ${plan.planVersion}`);
  }

  const zoneIds = new Set<string>();
  for (const zone of plan.zones) {
    if (zoneIds.has(zone.id)) problems.push(`duplicate zone id "${zone.id}"`);
    zoneIds.add(zone.id);
    if (zone.polygon.length < 3) problems.push(`zone "${zone.id}" has < 3 vertices`);
    if (polygonArea(zone.polygon) <= 0) {
      problems.push(`zone "${zone.id}" is not wound counter-clockwise`);
    }
    const p = zone.params;
    if (p.floorRange[0] < 1 || p.floorRange[1] < p.floorRange[0]) {
      problems.push(`zone "${zone.id}" has an invalid floorRange`);
    }
    if (p.facadeMaterials.length !== p.facadeWeights.length) {
      problems.push(`zone "${zone.id}": facadeMaterials/facadeWeights length mismatch`);
    }
    if (p.facadeMaterials.length === 0) problems.push(`zone "${zone.id}" has no facade materials`);
    if (p.roofMaterials.length === 0) problems.push(`zone "${zone.id}" has no roof materials`);
    if (p.tints.length === 0) problems.push(`zone "${zone.id}" has no tints`);
    if (p.floorHeight <= 1.5) problems.push(`zone "${zone.id}" floorHeight is implausible`);
  }

  const blockIds = new Set<string>();
  for (const block of plan.blocks) {
    if (blockIds.has(block.id)) problems.push(`duplicate block id "${block.id}"`);
    blockIds.add(block.id);
    if (!zoneIds.has(block.zone)) {
      problems.push(`block "${block.id}" references unknown zone "${block.zone}"`);
    }
    if (block.outline.length < 3) problems.push(`block "${block.id}" has < 3 vertices`);
    if (polygonArea(block.outline) <= 0) {
      problems.push(`block "${block.id}" is not wound counter-clockwise`);
    }
    const [cx, cz] = block.chunk;
    if (cx < CHUNK_COORD_MIN || cx > CHUNK_COORD_MAX || cz < CHUNK_COORD_MIN || cz > CHUNK_COORD_MAX) {
      problems.push(`block "${block.id}" chunk (${cx}, ${cz}) is outside the world`);
    }
    if (block.frontage.length !== block.outline.length) {
      problems.push(`block "${block.id}" frontage length != outline length`);
    }
    // The parcel must actually sit in the chunk it claims, or streaming will
    // load geometry that is nowhere near the chunk it paid for.
    const bounds = polygonBounds(block.outline);
    const centreX = (bounds.minX + bounds.maxX) * 0.5;
    const centreZ = (bounds.minZ + bounds.maxZ) * 0.5;
    if (Math.floor(centreX / CHUNK_SIZE) !== cx || Math.floor(centreZ / CHUNK_SIZE) !== cz) {
      problems.push(
        `block "${block.id}" centre (${centreX.toFixed(1)}, ${centreZ.toFixed(1)}) is not in chunk (${cx}, ${cz})`
      );
    }
  }

  const roadIds = new Set<string>();
  for (const road of plan.roads) {
    if (roadIds.has(road.id)) problems.push(`duplicate road id "${road.id}"`);
    roadIds.add(road.id);
    if (road.points.length < 2) problems.push(`road "${road.id}" needs >= 2 control points`);
    if (road.width <= 2) problems.push(`road "${road.id}" width ${road.width} is implausible`);
    for (const p of road.points) {
      if (!withinWorld(p)) problems.push(`road "${road.id}" leaves the world at ${p.join(', ')}`);
    }
  }

  for (const junction of plan.intersections) {
    for (const id of junction.roads) {
      if (!roadIds.has(id)) {
        problems.push(`intersection "${junction.id}" references unknown road "${id}"`);
      }
    }
  }

  const landmarkIds = new Set<string>();
  for (const landmark of plan.landmarks) {
    if (landmarkIds.has(landmark.id)) problems.push(`duplicate landmark id "${landmark.id}"`);
    landmarkIds.add(landmark.id);
    if (landmark.footprint.length < 3) problems.push(`landmark "${landmark.id}" has < 3 vertices`);
    if (landmark.floors < 1) problems.push(`landmark "${landmark.id}" needs >= 1 floor`);
    if (!withinWorld(landmark.position)) {
      problems.push(`landmark "${landmark.id}" is outside the world`);
    }
  }

  for (const crater of plan.craters) {
    if (crater.radius <= 0) problems.push(`crater "${crater.id}" has a non-positive radius`);
    if (crater.depth <= 0) problems.push(`crater "${crater.id}" has a non-positive depth`);
  }

  return problems;
}

function withinWorld(p: Vec2): boolean {
  const half = WORLD_SIZE * 0.5;
  return p[0] >= -half && p[0] <= half && p[1] >= -half && p[1] <= half;
}

/** Validate and index in one step, throwing on the first batch of problems. */
export function loadPlan(plan: ICityPlan): ICityPlanIndex {
  const problems = validatePlan(plan);
  if (problems.length > 0) {
    throw new Error(`cityz.plan.json is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return indexPlan(plan);
}
