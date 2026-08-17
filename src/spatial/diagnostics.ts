/**
 * CULL-RATE MEASUREMENT
 *
 * "PVS eliminates 60-80% of what frustum culling keeps" is a claim, and a claim
 * about a culling structure is worth exactly as much as the harness that
 * measures it. This file is that harness: it sweeps street-level camera poses
 * over a real block layout and counts, per pose, what each stage rejects.
 *
 * Two rates are reported and they answer different questions:
 *
 *   CHUNK rate     what the streaming system cares about — how many 96 m tiles
 *                  have to be resident and submitted.
 *   INSTANCE rate  what the renderer cares about — how many draw calls survive.
 *
 * Both are measured against the same poses so the numbers are comparable, and
 * both count only chunks that actually hold geometry, because rejecting an
 * empty chunk is not an achievement.
 */

import { CHUNK_COUNT } from './constants';
import { Frustum, composeViewProjection } from './frustum';
import { IndexList } from './index-list';
import type { Quadtree } from './quadtree';
import type { PvsTable } from './pvs';
import type { ICameraSample } from './synthetic-city';

/** Camera intrinsics used for every sampled pose. */
export interface ICullMeasureOptions {
  /** Vertical field of view in degrees. */
  readonly fovDegrees?: number;
  readonly aspect?: number;
  readonly near?: number;
  /** Far plane in metres — the draw distance the quality tier allows. */
  readonly far?: number;
}

/** Everything one sweep measured. */
export interface ICullRateReport {
  readonly samples: number;
  /** Chunks holding at least one instance. The honest denominator. */
  readonly occupiedChunks: number;

  /** Mean occupied chunks kept by frustum culling alone. */
  readonly chunksAfterFrustum: number;
  /** Mean occupied chunks kept by frustum culling AND the PVS. */
  readonly chunksAfterPvs: number;
  /** Fraction of occupied chunks the frustum alone rejects. */
  readonly frustumChunkCullRate: number;
  /** Fraction of occupied chunks frustum + PVS reject. */
  readonly combinedChunkCullRate: number;
  /** Fraction of the frustum's survivors the PVS then removes. THE number. */
  readonly pvsEliminationRate: number;

  /** Mean instances kept by the hierarchical frustum cull alone. */
  readonly instancesAfterFrustum: number;
  /** Mean instances kept once the PVS is applied inside the walk. */
  readonly instancesAfterPvs: number;
  /** Fraction of frustum-visible instances the PVS removes. */
  readonly pvsInstanceEliminationRate: number;
  /** Total instances in the tree. */
  readonly totalInstances: number;

  /** Mean quadtree nodes visited per cull, with and without the PVS. */
  readonly nodesVisitedFrustum: number;
  readonly nodesVisitedWithPvs: number;

  /** Worst-case (max over samples) survivors, which is what frame time sees. */
  readonly worstChunksAfterFrustum: number;
  readonly worstChunksAfterPvs: number;
  readonly worstInstancesAfterPvs: number;
}

/**
 * Sweep camera poses and measure what each culling stage removes.
 *
 * Chunk-level counting uses the quadtree's own depth-4 node bounds, which are
 * the tight union of that chunk's contents — the same box the renderer would
 * test — rather than a nominal 96 m column.
 */
export function measureCullRates(
  quadtree: Quadtree,
  pvs: PvsTable,
  samples: readonly ICameraSample[],
  options: ICullMeasureOptions = {}
): ICullRateReport {
  const fov = ((options.fovDegrees ?? 60) * Math.PI) / 180;
  const aspect = options.aspect ?? 16 / 9;
  const near = options.near ?? 0.3;
  const far = options.far ?? 400;

  const frustum = new Frustum();
  const viewProjection = new Float64Array(16);
  const listA = new IndexList(4096);
  const listB = new IndexList(4096);
  const statsA = { ...EMPTY_STATS };
  const statsB = { ...EMPTY_STATS };

  const chunkBounds = new Float64Array(6);
  const occupied: number[] = [];
  for (let c = 0; c < CHUNK_COUNT; c++) {
    const node = quadtree.chunkNode(c);
    if (node >= 0 && quadtree.getNodeTotal(node) > 0) occupied.push(c);
  }

  let sumChunksFrustum = 0;
  let sumChunksPvs = 0;
  let sumInstFrustum = 0;
  let sumInstPvs = 0;
  let sumNodesFrustum = 0;
  let sumNodesPvs = 0;
  let worstChunksFrustum = 0;
  let worstChunksPvs = 0;
  let worstInstPvs = 0;

  for (let i = 0; i < samples.length; i++) {
    const cam = samples[i]!;
    composeViewProjection(
      viewProjection,
      cam.x,
      cam.y,
      cam.z,
      cam.yaw,
      cam.pitch,
      fov,
      aspect,
      near,
      far
    );
    frustum.setFromViewProjection(viewProjection);

    let keptFrustum = 0;
    let keptPvs = 0;
    for (let k = 0; k < occupied.length; k++) {
      const c = occupied[k]!;
      const node = quadtree.chunkNode(c);
      quadtree.getNodeBounds(node, chunkBounds);
      if (
        !frustum.testBox(
          chunkBounds[0]!,
          chunkBounds[1]!,
          chunkBounds[2]!,
          chunkBounds[3]!,
          chunkBounds[4]!,
          chunkBounds[5]!
        )
      ) {
        continue;
      }
      keptFrustum++;
      if (pvs.isVisible(cam.chunk, c)) keptPvs++;
    }

    quadtree.cullFrustum(frustum, listA, statsA);
    quadtree.cullFrustum(frustum, listB, statsB, pvs, cam.chunk);

    sumChunksFrustum += keptFrustum;
    sumChunksPvs += keptPvs;
    sumInstFrustum += listA.length;
    sumInstPvs += listB.length;
    sumNodesFrustum += statsA.nodesVisited;
    sumNodesPvs += statsB.nodesVisited;
    if (keptFrustum > worstChunksFrustum) worstChunksFrustum = keptFrustum;
    if (keptPvs > worstChunksPvs) worstChunksPvs = keptPvs;
    if (listB.length > worstInstPvs) worstInstPvs = listB.length;
  }

  const n = Math.max(1, samples.length);
  const meanChunksFrustum = sumChunksFrustum / n;
  const meanChunksPvs = sumChunksPvs / n;
  const meanInstFrustum = sumInstFrustum / n;
  const meanInstPvs = sumInstPvs / n;
  const denomChunks = Math.max(1, occupied.length);

  return {
    samples: samples.length,
    occupiedChunks: occupied.length,
    chunksAfterFrustum: meanChunksFrustum,
    chunksAfterPvs: meanChunksPvs,
    frustumChunkCullRate: 1 - meanChunksFrustum / denomChunks,
    combinedChunkCullRate: 1 - meanChunksPvs / denomChunks,
    pvsEliminationRate: meanChunksFrustum > 0 ? 1 - meanChunksPvs / meanChunksFrustum : 0,
    instancesAfterFrustum: meanInstFrustum,
    instancesAfterPvs: meanInstPvs,
    pvsInstanceEliminationRate: meanInstFrustum > 0 ? 1 - meanInstPvs / meanInstFrustum : 0,
    totalInstances: quadtree.count,
    nodesVisitedFrustum: sumNodesFrustum / n,
    nodesVisitedWithPvs: sumNodesPvs / n,
    worstChunksAfterFrustum: worstChunksFrustum,
    worstChunksAfterPvs: worstChunksPvs,
    worstInstancesAfterPvs: worstInstPvs,
  };
}

/** Human-readable one-screen summary. Used by the tests and the harness. */
export function formatCullReport(report: ICullRateReport): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  return [
    `samples ................... ${report.samples}`,
    `occupied chunks ........... ${report.occupiedChunks} / ${CHUNK_COUNT}`,
    `instances in tree ......... ${report.totalInstances}`,
    '',
    `chunks after frustum ...... ${report.chunksAfterFrustum.toFixed(2)} (cull ${pct(report.frustumChunkCullRate)})`,
    `chunks after frustum+PVS .. ${report.chunksAfterPvs.toFixed(2)} (cull ${pct(report.combinedChunkCullRate)})`,
    `PVS eliminates ............ ${pct(report.pvsEliminationRate)} of frustum survivors`,
    '',
    `instances after frustum ... ${report.instancesAfterFrustum.toFixed(1)}`,
    `instances after +PVS ...... ${report.instancesAfterPvs.toFixed(1)} (-${pct(report.pvsInstanceEliminationRate)})`,
    `nodes visited ............. ${report.nodesVisitedFrustum.toFixed(1)} -> ${report.nodesVisitedWithPvs.toFixed(1)}`,
    '',
    `worst-case chunks ......... ${report.worstChunksAfterFrustum} -> ${report.worstChunksAfterPvs}`,
    `worst-case instances ...... ${report.worstInstancesAfterPvs}`,
  ].join('\n');
}

const EMPTY_STATS = {
  nodesVisited: 0,
  nodesRejected: 0,
  nodesAccepted: 0,
  chunksRejectedByPvs: 0,
  itemsTested: 0,
  itemsVisible: 0,
};
