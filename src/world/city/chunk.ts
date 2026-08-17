/**
 * CHUNK ASSEMBLY
 *
 * Turns one 96 m chunk of the plan into geometry. This is the function the
 * streaming workstream calls, and it is deliberately FREE OF THREE.JS so it
 * can run inside a Web Worker: everything it returns is typed arrays and plain
 * objects, and `transferables()` lists the buffers to move rather than copy.
 * `runtime.ts` is the only place that touches `THREE`, on the main thread.
 *
 * A chunk's cost breaks down as:
 *
 *   blocks      3 draw calls each (facade / glass / roof), merged
 *   landmarks   3 draw calls each, merged the same way
 *   ground      4 draw calls (carriageway / paving / parcel / markings)
 *   props       1 draw call per distinct model, GPU-instanced
 *
 * `mergeChunkGrounds` in ground.ts collapses the ground of a whole resident
 * region back to four, and prop batches merge across chunks the same way, so a
 * 5 x 5 resident set is dominated by the per-block building cost rather than
 * by per-chunk overhead.
 */

import { CHUNK_SIZE, chunkIndex } from '@/spatial/constants';
import { mixSeeds } from '@/util';
import type { DistrictType, IInstanceBatch } from '@/types';
import { generateBlock, type IBlockBuild, type IBlockGenOptions, type IBlockSpawn } from './block';
import { generateGround, type IGroundBuild } from './ground';
import { generateLandmark } from './landmarks';
import { mergeGeometries, MAT_SLOT_COUNT } from './mesh-builder';
import { rebaseLayout, type IFractureLayout } from './fracture';
import { CITY_MATERIALS } from './materials';
import { batchProps, type IRawPlacement } from './props';
import type { ICityPlanIndex } from './plan';
import type { IPlanCrater, IPlanLandmark } from './plan-types';
import { polygonBounds, type Polygon } from './polygon';
import type { BuildingDetail } from './building';

/** Options for generating one chunk. */
export interface IChunkGenOptions {
  readonly detail: BuildingDetail;
  readonly includeProps: boolean;
  /** Include the merged ground plane. Off for pure geometry benchmarks. */
  readonly includeGround?: boolean;
}

/** A generated chunk, in worker-transferable form. */
export interface ICityChunkBuild {
  readonly coord: { readonly x: number; readonly z: number };
  readonly key: string;
  readonly index: number;
  readonly seed: number;
  readonly district: DistrictType;
  readonly blocks: readonly IBlockBuild[];
  readonly ground?: IGroundBuild;
  readonly instances: readonly IInstanceBatch[];
  readonly spawns: readonly IBlockSpawn[];
  readonly bounds: readonly [number, number, number, number, number, number];
  readonly triangles: number;
  /** Draw calls this chunk contributes when rendered on its own. */
  readonly drawCalls: number;
  readonly generationTimeMs: number;
  readonly estimatedBytes: number;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** Generate everything in one chunk. Deterministic and order-independent. */
export function generateChunk(
  index: ICityPlanIndex,
  cx: number,
  cz: number,
  options: IChunkGenOptions
): ICityChunkBuild {
  const started = now();
  const plan = index.plan;
  const dense = chunkIndex(cx, cz);
  const planBlocks = dense >= 0 ? index.blocksByChunk[dense] : [];
  const planLandmarks = dense >= 0 ? index.landmarksByChunk[dense] : [];

  // Landmarks suppress procedural fill around themselves, including across the
  // chunk boundary, so neighbours are consulted too.
  const exclusions: [number, number, number][] = [];
  for (const landmark of plan.landmarks) {
    const dx = landmark.position[0] - (cx + 0.5) * CHUNK_SIZE;
    const dz = landmark.position[1] - (cz + 0.5) * CHUNK_SIZE;
    if (Math.hypot(dx, dz) < CHUNK_SIZE + landmark.exclusionRadius) {
      exclusions.push([landmark.position[0], landmark.position[1], landmark.exclusionRadius]);
    }
  }

  const blockOptions: IBlockGenOptions = {
    planVersion: plan.planVersion,
    detail: options.detail,
    includeProps: options.includeProps,
    exclusions,
  };

  const blocks: IBlockBuild[] = [];
  const zones = [];
  for (const planBlock of planBlocks) {
    const zone = index.zoneOfBlock(planBlock);
    zones.push(zone);
    blocks.push(generateBlock(planBlock, zone, blockOptions));
  }

  for (const landmark of planLandmarks) {
    blocks.push(buildLandmarkBlock(landmark, plan.planVersion, options.detail, [cx, cz]));
  }

  const craters: IPlanCrater[] = plan.craters.filter((crater) => {
    const dx = crater.centre[0] - (cx + 0.5) * CHUNK_SIZE;
    const dz = crater.centre[1] - (cz + 0.5) * CHUNK_SIZE;
    return Math.hypot(dx, dz) < CHUNK_SIZE * 0.75 + crater.radius;
  });

  const ground =
    options.includeGround === false
      ? undefined
      : generateGround({
          plan,
          chunkX: cx,
          chunkZ: cz,
          blocks: planBlocks,
          zones,
          roads: dense >= 0 ? index.roadsByChunk[dense] : [],
          craters,
          sidewalkWidth: planBlocks.length > 0 ? planBlocks[0].sidewalk : 3,
        });

  // Aggregate props, including any hand-placed ones inside this chunk.
  const props: IRawPlacement[] = [];
  for (const block of blocks) props.push(...block.props);
  if (options.includeProps) {
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    for (const prop of plan.props) {
      if (
        prop.position[0] >= x0 &&
        prop.position[0] < x0 + CHUNK_SIZE &&
        prop.position[1] >= z0 &&
        prop.position[1] < z0 + CHUNK_SIZE
      ) {
        props.push({
          assetKey: prop.assetKey,
          x: prop.position[0],
          y: 0,
          z: prop.position[1],
          rotationY: prop.rotationY,
          scale: prop.scale,
          destructible: true,
        });
      }
    }
    addStreetLamps(index, cx, cz, props);
  }

  const instances = batchProps(props);

  const spawns: IBlockSpawn[] = [];
  for (const block of blocks) spawns.push(...block.spawns);
  for (const crater of craters) {
    spawns.push({
      x: crater.centre[0],
      y: -crater.depth * 0.6,
      z: crater.centre[1],
      rotationY: 0,
      kind: 'monster',
      tag: 'wasteland',
    });
  }

  let triangles = ground ? ground.triangles : 0;
  let drawCalls = ground ? ground.drawCalls : 0;
  let bytes = ground ? bufferBytes(ground) : 0;
  for (const block of blocks) {
    triangles += block.triangles;
    drawCalls += block.drawCalls;
    bytes += blockBytes(block);
  }
  drawCalls += instances.length;
  for (const batch of instances) bytes += batch.matrices.byteLength;

  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  let maxY = 0;
  for (const block of blocks) maxY = Math.max(maxY, block.bounds[4]);

  return {
    coord: { x: cx, z: cz },
    key: `${cx},${cz}`,
    index: dense,
    seed: mixSeeds(plan.worldSeed, dense >>> 0),
    district: blocks.length > 0 ? blocks[0].district : 'wasteland',
    blocks,
    ground,
    instances,
    spawns,
    bounds: [x0, -8, z0, x0 + CHUNK_SIZE, Math.max(4, maxY), z0 + CHUNK_SIZE],
    triangles,
    drawCalls,
    generationTimeMs: now() - started,
    estimatedBytes: bytes,
  };
}

/* -------------------------------------------------------------------------- */
/* Landmarks as blocks                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Wrap a landmark's buildings in the same merged, three-slot bundle an
 * ordinary block produces, so nothing downstream needs a special case for it.
 */
function buildLandmarkBlock(
  landmark: IPlanLandmark,
  planVersion: number,
  detail: BuildingDetail,
  chunk: readonly [number, number]
): IBlockBuild {
  const built = generateLandmark(landmark, planVersion, detail);
  const geometry = mergeGeometries(
    built.buildings.map((b) => b.buffers),
    MAT_SLOT_COUNT,
    built.placements
  );

  const fractures: Record<string, IFractureLayout> = {};
  for (let i = 0; i < built.buildings.length; i++) {
    fractures[built.buildings[i].id] = rebaseLayout(
      built.buildings[i].fracture,
      geometry.offsets[i].vertexOffset,
      geometry.offsets[i].slotIndexOffset
    );
  }

  const outline: Polygon = landmark.footprint.map((p) => [
    p[0] + landmark.position[0],
    p[1] + landmark.position[1],
  ]);
  const b = polygonBounds(outline);

  return {
    id: `landmark:${landmark.id}`,
    chunk,
    outline,
    district: 'heroAssociation',
    zoneId: `landmark:${landmark.id}`,
    zoneKind: 'civic',
    seed: planVersion,
    materials: {
      facade: landmark.facadeMaterial,
      glass: CITY_MATERIALS.glass,
      roof: landmark.roofMaterial,
    },
    geometry,
    fractures,
    buildings: built.buildings.map((building, i) => ({
      id: building.id,
      footprint: building.footprint,
      position: [built.placements[i].x, built.placements[i].y, built.placements[i].z] as const,
      rotationY: built.placements[i].rotationY,
      floors: building.floors,
      height: building.height,
      style: landmark.style,
      structureMaterial: built.structureMaterial,
      integrity: 4200,
      bounds: [
        building.bounds[0] + built.placements[i].x,
        built.placements[i].y,
        building.bounds[2] + built.placements[i].z,
        building.bounds[3] + built.placements[i].x,
        built.placements[i].y + building.bounds[4],
        building.bounds[5] + built.placements[i].z,
      ] as const,
      triangles: building.triangles,
    })),
    props: [],
    spawns: [
      {
        x: landmark.position[0],
        y: 0,
        z: landmark.position[1] + landmark.exclusionRadius * 0.7,
        rotationY: 0,
        kind: 'hero',
        tag: landmark.kind,
      },
    ],
    bounds: [b.minX, 0, b.minZ, b.maxX, built.height, b.maxZ],
    triangles: geometry.buffers.indexCount / 3,
    drawCalls: geometry.buffers.groups.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Street lighting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Lamp posts along every road that asks for them.
 *
 * Placed from the ROAD graph rather than the parcel edge so they march in a
 * straight line down a street instead of stepping in and out with the
 * building line — a detail the eye picks up immediately at street level.
 */
function addStreetLamps(
  index: ICityPlanIndex,
  cx: number,
  cz: number,
  out: IRawPlacement[]
): void {
  const dense = chunkIndex(cx, cz);
  if (dense < 0) return;
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const x1 = x0 + CHUNK_SIZE;
  const z1 = z0 + CHUNK_SIZE;

  for (const road of index.roadsByChunk[dense]) {
    if (road.lampSpacing <= 0) continue;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i];
      const b = road.points[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1) continue;
      const dx = (b[0] - a[0]) / len;
      const dz = (b[1] - a[1]) / len;
      const nx = dz;
      const nz = -dx;
      const offset = road.width * 0.5 + Math.max(1.1, road.sidewalk * 0.45);
      const steps = Math.floor(len / road.lampSpacing);
      for (let s = 0; s <= steps; s++) {
        const t = s * road.lampSpacing;
        for (const side of [-1, 1] as const) {
          const x = a[0] + dx * t + nx * offset * side;
          const z = a[1] + dz * t + nz * offset * side;
          if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
          out.push({
            assetKey: side > 0 ? 'model.prop.street_lamp_01' : 'model.prop.street_lamp_02',
            x,
            y: 0,
            z,
            // The lamp model's arm reaches along its local -Z, and it has to
            // reach OVER the carriageway. Yaw theta sends local -Z to
            // (-sin, -cos), so pointing it back at the road is
            // atan2(n * side), not atan2(-n * side).
            rotationY: Math.atan2(nx * side, nz * side),
            scale: 1,
            destructible: true,
          });
        }
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Accounting                                                                 */
/* -------------------------------------------------------------------------- */

function blockBytes(block: IBlockBuild): number {
  const b = block.geometry.buffers;
  return (
    b.positions.byteLength +
    b.normals.byteLength +
    b.uvs.byteLength +
    b.colors.byteLength +
    b.indices.byteLength +
    b.destroyed.byteLength
  );
}

function bufferBytes(ground: IGroundBuild): number {
  const b = ground.buffers;
  return (
    b.positions.byteLength +
    b.normals.byteLength +
    b.uvs.byteLength +
    b.colors.byteLength +
    b.indices.byteLength +
    b.destroyed.byteLength
  );
}

/** Every ArrayBuffer in a chunk, for a worker `postMessage` transfer list. */
export function transferables(build: ICityChunkBuild): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const push = (buffers: {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    colors: Float32Array;
    indices: Uint32Array;
    destroyed: Uint8Array;
  }) => {
    out.push(
      buffers.positions.buffer as ArrayBuffer,
      buffers.normals.buffer as ArrayBuffer,
      buffers.uvs.buffer as ArrayBuffer,
      buffers.colors.buffer as ArrayBuffer,
      buffers.indices.buffer as ArrayBuffer,
      buffers.destroyed.buffer as ArrayBuffer
    );
  };
  for (const block of build.blocks) push(block.geometry.buffers);
  if (build.ground) push(build.ground.buffers);
  for (const batch of build.instances) out.push(batch.matrices.buffer as ArrayBuffer);
  return out;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
