/**
 * LANDMARKS
 *
 * The handful of places in City Z that must be recognisable rather than
 * plausible: the Hero Association's City Z branch, the covered shopping arcade
 * Saitama buys groceries in, the block he lives in, and the crater left by a
 * fight that happened before the player arrived.
 *
 * Landmarks are still generated, not modelled — they go through exactly the
 * same panel kit, the same fracture chunking and the same three material slots
 * as ordinary fill, so they are destructible on the same terms and cost the
 * same three draw calls. What makes them landmarks is that their footprint,
 * mass and silhouette are AUTHORED in the plan rather than rolled, plus a
 * little bespoke geometry each (a tower over a podium, an arcade canopy) that
 * the generic path would never produce.
 *
 * Each landmark also carries an exclusion radius that suppresses procedural
 * fill around it, so nothing grows through the front door.
 */

import { createRng } from '@/util';
import type { StructureMaterial } from '@/types';
import { generateBuilding, type BuildingDetail, type IBuildingBuild } from './building';
import { MatSlot, MeshBuilder, type IPlacement } from './mesh-builder';
import { CITY_MATERIALS, shadeTint, tintToRgb, uvScaleFor } from './materials';
import { landmarkSeed } from './plan';
import type { IPlanLandmark } from './plan-types';
import type { Polygon } from './polygon';

/** A landmark expanded into concrete buildings and their placements. */
export interface ILandmarkBuild {
  readonly id: string;
  readonly name: string;
  readonly buildings: readonly IBuildingBuild[];
  readonly placements: readonly IPlacement[];
  readonly structureMaterial: StructureMaterial;
  readonly exclusionRadius: number;
  readonly height: number;
}

/** Generate a landmark's geometry. */
export function generateLandmark(
  landmark: IPlanLandmark,
  planVersion: number,
  detail: BuildingDetail
): ILandmarkBuild {
  const seed = landmarkSeed(planVersion, landmark.id);
  switch (landmark.kind) {
    case 'heroAssociation':
      return buildHeroAssociation(landmark, seed, detail);
    case 'arcade':
      return buildArcade(landmark, seed, detail);
    default:
      return buildGeneric(landmark, seed, detail);
  }
}

/* -------------------------------------------------------------------------- */
/* Generic landmark                                                           */
/* -------------------------------------------------------------------------- */

function buildGeneric(
  landmark: IPlanLandmark,
  seed: number,
  detail: BuildingDetail
): ILandmarkBuild {
  const built = generateBuilding({
    id: landmark.id,
    footprint: landmark.footprint,
    floors: landmark.floors,
    floorHeight: landmark.floorHeight,
    groundFloorScale: 1.2,
    style: landmark.style,
    facadeMaterial: landmark.facadeMaterial,
    roofMaterial: landmark.roofMaterial,
    glassMaterial: CITY_MATERIALS.glass,
    tint: landmark.tint,
    seed,
    detail,
    panelWeights: { window: 6, balcony: 3, blank: 2, ac_unit: 2, fire_escape_anchor: 1 },
    groundWeights: { door: 3, window: 3, blank: 3, shopfront: 1 },
    rooftopClutter: 0.9,
    parapetHeight: 0.95,
    litWindowChance: 0.24,
    structureMaterial: 'concrete',
    heroOverlays: true,
  });
  return {
    id: landmark.id,
    name: landmark.name,
    buildings: [built],
    placements: [
      {
        x: landmark.position[0],
        y: 0,
        z: landmark.position[1],
        rotationY: landmark.rotationY,
      },
    ],
    structureMaterial: 'concrete',
    exclusionRadius: landmark.exclusionRadius,
    height: built.height,
  };
}

/* -------------------------------------------------------------------------- */
/* Hero Association, City Z branch                                            */
/* -------------------------------------------------------------------------- */

/**
 * A glazed tower on a wide civic podium, with a rooftop sign band.
 *
 * The podium/tower split is what makes a civic building read as institutional
 * rather than as another office block: the podium holds the street edge at
 * four storeys like its neighbours, and the tower steps back and goes up.
 */
function buildHeroAssociation(
  landmark: IPlanLandmark,
  seed: number,
  detail: BuildingDetail
): ILandmarkBuild {
  const rng = createRng(seed);
  const podiumFloors = 4;
  const podium = generateBuilding({
    id: `${landmark.id}.podium`,
    footprint: landmark.footprint,
    floors: podiumFloors,
    floorHeight: landmark.floorHeight,
    groundFloorScale: 1.5,
    style: 'civic',
    facadeMaterial: landmark.facadeMaterial,
    roofMaterial: landmark.roofMaterial,
    glassMaterial: CITY_MATERIALS.glass,
    tint: landmark.tint,
    seed: rng.nextUint32(),
    detail,
    panelWeights: { window: 8, blank: 2 },
    groundWeights: { shopfront: 5, door: 3, window: 2 },
    rooftopClutter: 0.7,
    parapetHeight: 1.25,
    litWindowChance: 0.55,
    structureMaterial: 'concrete',
    heroOverlays: true,
  });

  // Tower: the podium footprint scaled in, so it steps back on every side.
  const tower = generateBuilding({
    id: `${landmark.id}.tower`,
    footprint: scaleFootprint(landmark.footprint, 0.58),
    floors: Math.max(6, landmark.floors - podiumFloors),
    floorHeight: landmark.floorHeight,
    groundFloorScale: 1,
    style: 'skyscraper',
    facadeMaterial: landmark.facadeMaterial,
    roofMaterial: landmark.roofMaterial,
    glassMaterial: CITY_MATERIALS.glass,
    tint: landmark.tint,
    seed: rng.nextUint32(),
    detail,
    panelWeights: { window: 9, blank: 1 },
    groundWeights: { window: 9, blank: 1 },
    rooftopClutter: 1,
    parapetHeight: 1.5,
    litWindowChance: 0.6,
    structureMaterial: 'concrete',
    heroOverlays: true,
  });

  const podiumHeight = podium.height + 1.25;
  return {
    id: landmark.id,
    name: landmark.name,
    buildings: [podium, tower],
    placements: [
      { x: landmark.position[0], y: 0, z: landmark.position[1], rotationY: landmark.rotationY },
      {
        x: landmark.position[0],
        y: podiumHeight,
        z: landmark.position[1],
        rotationY: landmark.rotationY,
      },
    ],
    structureMaterial: 'concrete',
    exclusionRadius: landmark.exclusionRadius,
    height: podiumHeight + tower.height,
  };
}

function scaleFootprint(footprint: Polygon, factor: number): Polygon {
  let cx = 0;
  let cz = 0;
  for (const p of footprint) {
    cx += p[0];
    cz += p[1];
  }
  cx /= footprint.length;
  cz /= footprint.length;
  return footprint.map((p) => [cx + (p[0] - cx) * factor, cz + (p[1] - cz) * factor]);
}

/* -------------------------------------------------------------------------- */
/* Shotengai — the covered shopping arcade                                    */
/* -------------------------------------------------------------------------- */

/**
 * The arcade is a canopy, not a building: a translucent gabled roof spanning
 * the street on paired columns, with hanging signage down both sides.
 *
 * It is emitted as a single "building" with one storey so it inherits the
 * fracture chunking and the three-slot budget — the roof panels land in the
 * glass slot, so they glow at dusk exactly like the shopfronts under them.
 */
function buildArcade(
  landmark: IPlanLandmark,
  seed: number,
  detail: BuildingDetail
): ILandmarkBuild {
  const rng = createRng(seed);
  const builder = new MeshBuilder();
  const facadeUv = uvScaleFor(landmark.facadeMaterial);
  const glassUv = uvScaleFor(CITY_MATERIALS.glass);
  const tint = tintToRgb(landmark.tint);

  // Span and length come from the authored footprint's bounding box.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of landmark.footprint) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  const halfSpan = (maxX - minX) * 0.5;
  const length = maxZ - minZ;
  const eaves = 5.4;
  const ridge = 7.6;
  const bays = Math.max(4, Math.round(length / 6));
  const bayLength = length / bays;

  builder.beginChunk();
  for (let i = 0; i < bays; i++) {
    const z0 = minZ + i * bayLength;
    const z1 = z0 + bayLength;
    const shade = 0.86 + (i % 2) * 0.06;

    // Two roof planes meeting at a ridge. Wound so the outer face is up.
    for (const side of [-1, 1] as const) {
      builder.quad(
        MatSlot.Glass,
        [side * halfSpan, eaves, side > 0 ? z1 : z0],
        [side * halfSpan, eaves, side > 0 ? z0 : z1],
        [0, ridge, side > 0 ? z0 : z1],
        [0, ridge, side > 0 ? z1 : z0],
        [0, z0 * glassUv, halfSpan * glassUv, z1 * glassUv],
        [0.62 * shade, 0.66 * shade, 0.68 * shade]
      );
      // Rafter under the panel.
      builder.box(
        MatSlot.Facade,
        (side * halfSpan) / 2,
        (eaves + ridge) / 2 - 0.14,
        z0,
        halfSpan / 2,
        0.09,
        0.09,
        facadeUv,
        shadeTint(tint, 0.7)
      );
    }

    // Columns, both sides.
    for (const side of [-1, 1] as const) {
      builder.box(
        MatSlot.Facade,
        side * halfSpan,
        eaves * 0.5,
        z0,
        0.16,
        eaves * 0.5,
        0.16,
        facadeUv,
        shadeTint(tint, 0.9)
      );
      // Hanging shop banner: the vertical signage that makes a shotengai read.
      const banner = BANNER_TINTS[rng.int(0, BANNER_TINTS.length - 1)];
      builder.box(
        MatSlot.Glass,
        side * (halfSpan - 0.4),
        eaves - 1.35,
        z0 + bayLength * 0.5,
        0.05,
        0.85,
        bayLength * 0.3,
        glassUv,
        banner
      );
    }
  }
  // Ridge beam.
  builder.box(
    MatSlot.Facade,
    0,
    ridge,
    (minZ + maxZ) * 0.5,
    0.14,
    0.14,
    length * 0.5,
    facadeUv,
    shadeTint(tint, 0.8)
  );
  const span = builder.endChunk();
  const buffers = builder.build();

  const slotBase = [0, 1, 2].map((slot) => builder.slotOffset(slot));
  const parts = span.slotRanges
    .map((range, slot) => ({ slot, start: range[0] + slotBase[slot], count: range[1] }))
    .filter((p) => p.count > 0);

  const build: IBuildingBuild = {
    id: landmark.id,
    buffers,
    fracture: {
      chunks: [
        {
          index: 0,
          floor: 0,
          quadrant: 0,
          start: parts[0]?.start ?? 0,
          count: parts[0]?.count ?? 0,
          parts,
          vertexStart: span.vertexStart,
          vertexCount: span.vertexCount,
          centroid: span.centroid,
          volume: Math.max(1, span.volume),
          mass: Math.max(1, span.volume) * 620,
          aabb: span.bounds,
          grounded: true,
          neighbours: [],
          supportShare: 1,
        },
      ],
      floors: [{ floor: 0, y0: 0, y1: ridge, chunks: [0], totalSupport: 1 }],
      structureMaterial: 'metal',
      totalMass: Math.max(1, span.volume) * 620,
      collapseSupportRatio: 0.4,
      slotBase,
    },
    floors: 1,
    height: ridge,
    footprint: landmark.footprint,
    bounds: [minX, 0, minZ, maxX, ridge, maxZ],
    attachments: [],
    triangles: buffers.indexCount / 3,
    panelCount: bays * 2,
  };

  void detail;
  return {
    id: landmark.id,
    name: landmark.name,
    buildings: [build],
    placements: [
      { x: landmark.position[0], y: 0, z: landmark.position[1], rotationY: landmark.rotationY },
    ],
    structureMaterial: 'metal',
    exclusionRadius: landmark.exclusionRadius,
    height: ridge,
  };
}

const BANNER_TINTS: readonly (readonly [number, number, number])[] = [
  [0.9, 0.2, 0.18],
  [0.96, 0.72, 0.16],
  [0.18, 0.4, 0.8],
  [0.95, 0.94, 0.9],
  [0.16, 0.58, 0.4],
];
