/**
 * BLOCK GENERATION — LOTS, BUILDINGS, COURTYARDS, PROPS
 *
 * A block is the parcel bounded by roads. Everything inside it is derived from
 * `hash(blockId, planVersion)` and nothing inside it is stored in the plan.
 *
 * ── PERIMETER DEVELOPMENT ──────────────────────────────────────────────────
 * Lots are laid out around the EDGE of the parcel with a courtyard left in the
 * middle, which is how a Japanese city block is actually built: a continuous
 * street wall of narrow-frontage, deep buildings, with parking, bicycle racks
 * and service yards hidden behind. Scattering buildings inside the parcel
 * instead — the obvious approach — produces gaps you can see through to the
 * next street, and that single mistake is what makes most procedural cities
 * read as a diorama rather than a place.
 *
 * Corner parcels go to the east and west runs, so they are deeper than the
 * mid-block lots and get a storey or two more. Corners being special is a real
 * urban pattern and it gives the skyline something to do.
 *
 * ── WHY THE WHOLE BLOCK MERGES TO THREE DRAW CALLS ─────────────────────────
 * Every building in a block shares ONE facade material, ONE glass material and
 * ONE roof material, picked per block. Variety within the block comes from
 * per-building vertex tint, panel mix, height and footprint — never from a
 * fourth material, because a fourth material is a fourth draw call and the
 * budget is three.
 */

import { createRng, type IRandom } from '@/util';
import type { BuildingStyle, DistrictType, StructureMaterial } from '@/types';
import {
  MAT_SLOT_COUNT,
  mergeGeometries,
  type AABB6,
  type IMergedGeometry,
  type IPlacement,
} from './mesh-builder';
import { CITY_MATERIALS, type IBlockMaterialSet } from './materials';
import { generateBuilding, type BuildingDetail, type IBuildingBuild } from './building';
import { rebaseLayout, type IFractureLayout } from './fracture';
import { pickProp, propDestructible, propRadius, type IRawPlacement } from './props';
import type { IPlanBlock, IPlanZone, IPlanZoneParams, ZoneKind } from './plan-types';
import { blockSeed } from './plan';
import {
  polygonArea,
  polygonBounds,
  polygonCentroid,
  type Polygon,
  type Vec2,
} from './polygon';
import type { PanelKind } from './facade';

/** A single development parcel inside a block. */
export interface ILot {
  readonly footprint: Polygon;
  /** Outward direction of the street this lot fronts. */
  readonly facing: Vec2;
  readonly isCorner: boolean;
  /** True when the lot fronts an arterial rather than a side street. */
  readonly isPrimary: boolean;
  readonly area: number;
}

/** A generated block, ready to be added to a chunk payload. */
export interface IBlockBuild {
  readonly id: string;
  readonly chunk: readonly [number, number];
  readonly outline: Polygon;
  readonly district: DistrictType;
  readonly zoneId: string;
  readonly zoneKind: ZoneKind;
  readonly seed: number;
  readonly materials: IBlockMaterialSet;
  /** Merged block geometry. `groups.length` is the block's draw-call count. */
  readonly geometry: IMergedGeometry;
  /** Per-building fracture layouts, rebased into the MERGED buffer. */
  readonly fractures: Readonly<Record<string, IFractureLayout>>;
  readonly buildings: readonly IBuildingSummary[];
  readonly props: readonly IRawPlacement[];
  readonly spawns: readonly IBlockSpawn[];
  readonly bounds: AABB6;
  readonly triangles: number;
  readonly drawCalls: number;
}

/** Enough of a building to register it with physics and destruction. */
export interface IBuildingSummary {
  readonly id: string;
  readonly footprint: Polygon;
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly floors: number;
  readonly height: number;
  readonly style: BuildingStyle;
  readonly structureMaterial: StructureMaterial;
  readonly integrity: number;
  readonly bounds: AABB6;
  readonly triangles: number;
}

/** A spawn slot found during layout. */
export interface IBlockSpawn {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationY: number;
  readonly kind: 'npc' | 'monster' | 'hero' | 'player' | 'vehicle';
  readonly tag?: string;
}

/** Knobs a caller (streaming, the harness) sets per generation request. */
export interface IBlockGenOptions {
  readonly planVersion: number;
  readonly detail: BuildingDetail;
  readonly includeProps: boolean;
  /** Circles inside which no procedural building is placed (landmarks). */
  readonly exclusions?: readonly (readonly [number, number, number])[];
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** Generate one block deterministically from the plan. */
export function generateBlock(
  block: IPlanBlock,
  zone: IPlanZone,
  options: IBlockGenOptions
): IBlockBuild {
  const seed = blockSeed(options.planVersion, block.id);
  const rng = createRng(seed);
  const params = zone.params;

  const materials: IBlockMaterialSet = {
    facade: rng.weighted(params.facadeMaterials, params.facadeWeights),
    glass: CITY_MATERIALS.glass,
    roof: params.roofMaterials[rng.int(0, params.roofMaterials.length - 1)],
  };

  const lotRng = rng.derive('lots');
  const lots =
    zone.kind === 'park' || zone.kind === 'crater'
      ? []
      : subdivideBlock(block.outline, params, block, lotRng);

  const buildings: IBuildingBuild[] = [];
  const placements: IPlacement[] = [];
  const summaries: IBuildingSummary[] = [];
  const props: IRawPlacement[] = [];
  const spawns: IBlockSpawn[] = [];

  const buildRng = rng.derive('buildings');
  let index = 0;
  for (const lot of lots) {
    index++;
    if (!lot.isPrimary && !buildRng.bool(clamp01(params.density * block.density))) continue;
    const centre = polygonCentroid(lot.footprint);
    if (isExcluded(options.exclusions, centre[0], centre[1])) continue;

    const recipe = makeRecipe(
      `${block.id}.b${index}`,
      lot,
      centre,
      params,
      block,
      materials,
      options.detail,
      buildRng
    );
    const built = generateBuilding(recipe);
    buildings.push(built);
    placements.push({ x: centre[0], y: 0, z: centre[1], rotationY: 0 });
    summaries.push({
      id: recipe.id,
      footprint: built.footprint,
      position: [centre[0], 0, centre[1]],
      rotationY: 0,
      floors: built.floors,
      height: built.height,
      style: recipe.style,
      structureMaterial: recipe.structureMaterial,
      integrity: integrityFor(recipe.structureMaterial, built.floors, lot.area),
      bounds: [
        built.bounds[0] + centre[0],
        built.bounds[1],
        built.bounds[2] + centre[1],
        built.bounds[3] + centre[0],
        built.bounds[4],
        built.bounds[5] + centre[1],
      ],
      triangles: built.triangles,
    });

    // Doorstep NPC spawn, pushed out onto the pavement.
    spawns.push({
      x: centre[0] + lot.facing[0] * 4.5,
      y: 0,
      z: centre[1] + lot.facing[1] * 4.5,
      rotationY: Math.atan2(-lot.facing[0], -lot.facing[1]),
      kind: 'npc',
    });

    // Model overlays from the Poly Haven kit go on the buildings that hold the
    // primary frontage only. Every facade requesting a real fire escape would
    // multiply the instance count for detail nobody sees down a side street.
    if (lot.isPrimary) {
      for (const attachment of built.attachments) {
        props.push({
          assetKey: attachment.assetKey,
          x: centre[0] + attachment.position[0],
          y: attachment.position[1],
          z: centre[1] + attachment.position[2],
          rotationY: attachment.rotationY,
          scale: attachment.scale,
          destructible: true,
        });
      }
    }
  }

  // Courtyard: sheds, parked cars and the small structures that fill the
  // middle of a real block. Skipped for parks and craters.
  if (zone.kind !== 'park' && zone.kind !== 'crater') {
    fillCourtyard(block, zone, params, materials, options, rng.derive('yard'), (build, place, summary) => {
      buildings.push(build);
      placements.push(place);
      summaries.push(summary);
    }, props, spawns);
  }

  if (zone.kind === 'park') {
    emitParkPlanting(block, materials, options, rng.derive('park'), buildings, placements, summaries);
  }

  if (options.includeProps) {
    scatterProps(block, zone, params, rng.derive('props'), props);
  }

  const geometry = mergeGeometries(
    buildings.map((b) => b.buffers),
    MAT_SLOT_COUNT,
    placements
  );

  // Rebase every building's fracture layout into the merged buffer so the
  // destruction system can work on the block mesh directly.
  const fractures: Record<string, IFractureLayout> = {};
  for (let i = 0; i < buildings.length; i++) {
    fractures[buildings[i].id] = rebaseFracture(buildings[i].fracture, geometry.offsets[i]);
  }

  const outlineBounds = polygonBounds(block.outline);
  let maxY = 0;
  for (const s of summaries) maxY = Math.max(maxY, s.bounds[4]);

  return {
    id: block.id,
    chunk: block.chunk,
    outline: block.outline,
    district: zone.district,
    zoneId: zone.id,
    zoneKind: zone.kind,
    seed,
    materials,
    geometry,
    fractures,
    buildings: summaries,
    props,
    spawns,
    bounds: [
      outlineBounds.minX,
      0,
      outlineBounds.minZ,
      outlineBounds.maxX,
      maxY,
      outlineBounds.maxZ,
    ],
    triangles: geometry.buffers.indexCount / 3,
    drawCalls: geometry.buffers.groups.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Lot subdivision                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Split a parcel into street-fronting lots around a courtyard.
 *
 * Rectangular parcels — which is nearly all of them, because the road graph is
 * a grid — take the exact four-run path. Anything else (chamfered downtown
 * parcels, crater-clipped remnants) falls back to a single podium lot filling
 * the parcel, which is what those sites want anyway.
 */
export function subdivideBlock(
  outline: Polygon,
  params: IPlanZoneParams,
  block: IPlanBlock,
  rng: IRandom
): ILot[] {
  const b = polygonBounds(outline);
  const width = b.maxX - b.minX;
  const depthZ = b.maxZ - b.minZ;
  if (width < 6 || depthZ < 6) return [];

  const rectangular = outline.length === 4 && isAxisAlignedRect(outline);
  if (!rectangular) {
    return [
      {
        footprint: shrinkRect(b, params.setback),
        facing: [0, -1],
        isCorner: false,
        isPrimary: true,
        area: width * depthZ,
      },
    ];
  }

  const minSide = Math.min(width, depthZ);
  const wanted = rng.range(params.lotDepth[0], params.lotDepth[1]);
  const depth = Math.min(wanted, minSide * 0.44);
  const lots: ILot[] = [];

  // Small parcels take the whole footprint as one building rather than a ring
  // of slivers around a courtyard two metres across.
  if (minSide < depth * 2.3 + 6) {
    const runs = Math.max(1, Math.round(Math.max(width, depthZ) / rng.range(params.lotWidth[0], params.lotWidth[1])));
    const alongX = width >= depthZ;
    for (let i = 0; i < runs; i++) {
      const t0 = i / runs;
      const t1 = (i + 1) / runs;
      const rect = alongX
        ? { minX: b.minX + width * t0, maxX: b.minX + width * t1, minZ: b.minZ, maxZ: b.maxZ }
        : { minX: b.minX, maxX: b.maxX, minZ: b.minZ + depthZ * t0, maxZ: b.minZ + depthZ * t1 };
      lots.push({
        footprint: shrinkRect(rect, params.setback),
        facing: alongX ? [0, -1] : [-1, 0],
        isCorner: i === 0 || i === runs - 1,
        isPrimary: i === 0,
        area: (rect.maxX - rect.minX) * (rect.maxZ - rect.minZ),
      });
    }
    return lots;
  }

  // West and east runs take the corners and run the full depth of the parcel.
  pushRun(
    lots,
    { minX: b.minX, maxX: b.minX + depth, minZ: b.minZ, maxZ: b.maxZ },
    'z',
    [-1, 0],
    params,
    block,
    rng
  );
  pushRun(
    lots,
    { minX: b.maxX - depth, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ },
    'z',
    [1, 0],
    params,
    block,
    rng
  );
  // North and south runs fill between them.
  pushRun(
    lots,
    { minX: b.minX + depth, maxX: b.maxX - depth, minZ: b.minZ, maxZ: b.minZ + depth },
    'x',
    [0, -1],
    params,
    block,
    rng
  );
  pushRun(
    lots,
    { minX: b.minX + depth, maxX: b.maxX - depth, minZ: b.maxZ - depth, maxZ: b.maxZ },
    'x',
    [0, 1],
    params,
    block,
    rng
  );
  return lots;
}

interface IRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Split one perimeter run into individual street-frontage lots. */
function pushRun(
  out: ILot[],
  rect: IRect,
  axis: 'x' | 'z',
  facing: Vec2,
  params: IPlanZoneParams,
  block: IPlanBlock,
  rng: IRandom
): void {
  const runLength = axis === 'x' ? rect.maxX - rect.minX : rect.maxZ - rect.minZ;
  if (runLength < 4) return;
  const target = rng.range(params.lotWidth[0], params.lotWidth[1]);
  const count = Math.max(1, Math.round(runLength / target));

  // Uneven frontages: real streets are not a comb. Each lot's share is jittered
  // and then renormalised so the run still fills exactly.
  const shares: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const s = 0.7 + rng.next() * 0.6;
    shares.push(s);
    total += s;
  }

  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const span = (shares[i] / total) * runLength;
    const start = cursor;
    cursor += span;
    // The back edge wobbles so the courtyard is not a perfect rectangle.
    const backJitter = rng.range(0, Math.min(2.5, (axis === 'x' ? rect.maxZ - rect.minZ : rect.maxX - rect.minX) * 0.22));
    const lotRect: IRect =
      axis === 'x'
        ? {
            minX: rect.minX + start,
            maxX: rect.minX + cursor,
            minZ: facing[1] < 0 ? rect.minZ : rect.minZ + backJitter,
            maxZ: facing[1] < 0 ? rect.maxZ - backJitter : rect.maxZ,
          }
        : {
            minX: facing[0] < 0 ? rect.minX : rect.minX + backJitter,
            maxX: facing[0] < 0 ? rect.maxX - backJitter : rect.maxX,
            minZ: rect.minZ + start,
            maxZ: rect.minZ + cursor,
          };

    const w = lotRect.maxX - lotRect.minX;
    const d = lotRect.maxZ - lotRect.minZ;
    if (w < 3 || d < 3) continue;
    const edgeIndex = facing[0] < 0 ? 0 : facing[0] > 0 ? 2 : facing[1] < 0 ? 3 : 1;
    out.push({
      footprint: shrinkRect(lotRect, params.setback),
      facing,
      isCorner: i === 0 || i === count - 1,
      isPrimary: (block.frontage[edgeIndex] ?? false) && (i === 0 || i === count - 1),
      area: w * d,
    });
  }
}

function shrinkRect(rect: IRect, amount: number): Polygon {
  const a = Math.max(0, amount);
  const minX = rect.minX + a;
  const maxX = rect.maxX - a;
  const minZ = rect.minZ + a;
  const maxZ = rect.maxZ - a;
  return [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
}

function isAxisAlignedRect(poly: Polygon): boolean {
  for (let i = 0; i < 4; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % 4];
    if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) return false;
  }
  return polygonArea(poly) > 0;
}

/* -------------------------------------------------------------------------- */
/* Recipes                                                                    */
/* -------------------------------------------------------------------------- */

function makeRecipe(
  id: string,
  lot: ILot,
  centre: Vec2,
  params: IPlanZoneParams,
  block: IPlanBlock,
  materials: IBlockMaterialSet,
  detail: BuildingDetail,
  rng: IRandom
) {
  const [minFloors, maxFloors] = params.floorRange;
  // Height distribution: a shaped roll rather than uniform, so a zone gets a
  // few landmarks over a mass of mid-rise instead of a flat comb.
  const roll = Math.pow(rng.next(), params.heightExponent);
  let floors = Math.round(minFloors + roll * (maxFloors - minFloors));
  floors += block.heightBias;
  if (lot.isCorner) floors += rng.int(0, 2);
  if (lot.isPrimary) floors += rng.int(0, 2);
  floors = Math.max(1, Math.min(maxFloors + 4, floors));

  const style = pickStyle(params, rng);
  const tint = params.tints[rng.int(0, params.tints.length - 1)];

  return {
    id,
    footprint: lot.footprint,
    floors,
    floorHeight: params.floorHeight,
    groundFloorScale: params.groundFloorScale,
    style,
    facadeMaterial: materials.facade,
    roofMaterial: materials.roof,
    glassMaterial: materials.glass,
    tint,
    seed: rng.nextUint32(),
    detail,
    panelWeights: params.panelWeights as Readonly<Partial<Record<PanelKind, number>>>,
    groundWeights: params.groundWeights as Readonly<Partial<Record<PanelKind, number>>>,
    rooftopClutter: params.rooftopClutter,
    parapetHeight: style === 'industrial' ? 0.45 : rng.range(0.7, 1.15),
    litWindowChance: 0.16,
    structureMaterial: structureFor(style, materials.facade),
    heroOverlays: lot.isPrimary,
  };
}

function pickStyle(params: IPlanZoneParams, rng: IRandom): BuildingStyle {
  const styles: BuildingStyle[] = [];
  const weights: number[] = [];
  for (const key of [
    'residential',
    'commercial',
    'skyscraper',
    'industrial',
    'shophouse',
    'apartment',
    'civic',
    'ruins',
  ] as const) {
    const w = params.styleWeights[key];
    if (w !== undefined && w > 0) {
      styles.push(key);
      weights.push(w);
    }
  }
  if (styles.length === 0) return 'residential';
  return rng.weighted(styles, weights);
}

function structureFor(style: BuildingStyle, facadeMaterial: string): StructureMaterial {
  if (facadeMaterial.includes('brick')) return 'brick';
  if (facadeMaterial.includes('metal')) return 'metal';
  if (facadeMaterial.includes('planks')) return 'wood';
  if (style === 'industrial') return 'metal';
  return 'concrete';
}

/** Integrity budget: bigger, taller, heavier buildings survive more punches. */
function integrityFor(material: StructureMaterial, floors: number, area: number): number {
  const base = material === 'metal' ? 900 : material === 'brick' ? 700 : material === 'wood' ? 380 : 1000;
  return Math.round(base * (0.6 + floors * 0.14) * (0.5 + Math.min(2.5, area / 220)));
}

/* -------------------------------------------------------------------------- */
/* Courtyard, planting and props                                              */
/* -------------------------------------------------------------------------- */

type EmitBuilding = (
  build: IBuildingBuild,
  placement: IPlacement,
  summary: IBuildingSummary
) => void;

/** Sheds, garages and parked cars behind the street wall. */
function fillCourtyard(
  block: IPlanBlock,
  zone: IPlanZone,
  params: IPlanZoneParams,
  materials: IBlockMaterialSet,
  options: IBlockGenOptions,
  rng: IRandom,
  emit: EmitBuilding,
  props: IRawPlacement[],
  spawns: IBlockSpawn[]
): void {
  const b = polygonBounds(block.outline);
  const inset = 20;
  const w = b.maxX - b.minX - inset * 2;
  const d = b.maxZ - b.minZ - inset * 2;
  if (w < 8 || d < 8) return;

  const sheds = rng.int(0, zone.kind === 'industrial' ? 3 : 2);
  for (let i = 0; i < sheds; i++) {
    const sw = rng.range(4, Math.min(11, w * 0.6));
    const sd = rng.range(4, Math.min(9, d * 0.6));
    const cx = b.minX + inset + rng.next() * (w - sw) + sw * 0.5;
    const cz = b.minZ + inset + rng.next() * (d - sd) + sd * 0.5;
    if (isExcluded(options.exclusions, cx, cz)) continue;
    const footprint: Polygon = [
      [cx - sw * 0.5, cz - sd * 0.5],
      [cx + sw * 0.5, cz - sd * 0.5],
      [cx + sw * 0.5, cz + sd * 0.5],
      [cx - sw * 0.5, cz + sd * 0.5],
    ];
    const built = generateBuilding({
      id: `${block.id}.shed${i}`,
      footprint,
      floors: rng.int(1, 2),
      floorHeight: 3.1,
      groundFloorScale: 1,
      style: 'industrial',
      facadeMaterial: materials.facade,
      roofMaterial: materials.roof,
      glassMaterial: materials.glass,
      tint: params.tints[rng.int(0, params.tints.length - 1)],
      seed: rng.nextUint32(),
      detail: options.detail,
      panelWeights: { blank: 6, window: 2, ac_unit: 1 },
      groundWeights: { blank: 5, door: 2, window: 2 },
      rooftopClutter: params.rooftopClutter * 0.4,
      parapetHeight: 0.3,
      litWindowChance: 0.05,
      structureMaterial: 'metal',
    });
    emit(
      built,
      { x: cx, y: 0, z: cz, rotationY: 0 },
      {
        id: `${block.id}.shed${i}`,
        footprint: built.footprint,
        position: [cx, 0, cz],
        rotationY: 0,
        floors: built.floors,
        height: built.height,
        style: 'industrial',
        structureMaterial: 'metal',
        integrity: integrityFor('metal', built.floors, sw * sd),
        bounds: [
          built.bounds[0] + cx,
          0,
          built.bounds[2] + cz,
          built.bounds[3] + cx,
          built.bounds[4],
          built.bounds[5] + cz,
        ],
        triangles: built.triangles,
      }
    );
  }

  // Parked cars: a covered_car is a huge amount of "someone lives here" for
  // one instanced draw.
  const cars = rng.int(0, 4);
  for (let i = 0; i < cars; i++) {
    const x = b.minX + inset + rng.next() * w;
    const z = b.minZ + inset + rng.next() * d;
    if (isExcluded(options.exclusions, x, z)) continue;
    props.push({
      assetKey: 'model.prop.covered_car',
      x,
      y: 0,
      z,
      rotationY: rng.int(0, 3) * (Math.PI / 2) + rng.range(-0.12, 0.12),
      scale: 1,
      destructible: true,
    });
    if (i === 0) spawns.push({ x, y: 0, z, rotationY: 0, kind: 'vehicle' });
  }
}

/** Trees and hedges for a park block. */
function emitParkPlanting(
  block: IPlanBlock,
  materials: IBlockMaterialSet,
  options: IBlockGenOptions,
  rng: IRandom,
  buildings: IBuildingBuild[],
  placements: IPlacement[],
  summaries: IBuildingSummary[]
): void {
  const b = polygonBounds(block.outline);
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const count = Math.max(4, Math.round((w * d) / 190));

  for (let i = 0; i < count; i++) {
    const x = b.minX + 4 + rng.next() * (w - 8);
    const z = b.minZ + 4 + rng.next() * (d - 8);
    if (isExcluded(options.exclusions, x, z)) continue;
    const scale = rng.range(0.8, 1.5);
    // A tree is generated as a one-storey "building" so it inherits the block
    // merge, the fracture bookkeeping and the draw-call budget for free — the
    // facade material for a park zone is grass, so the canopy reads as foliage.
    const r = 1.9 * scale;
    const footprint: Polygon = [
      [x - r, z - r],
      [x + r, z - r],
      [x + r, z + r],
      [x - r, z + r],
    ];
    const built = generateBuilding({
      id: `${block.id}.tree${i}`,
      footprint,
      floors: 1,
      floorHeight: 3.4 * scale,
      groundFloorScale: 1,
      style: 'residential',
      facadeMaterial: materials.facade,
      roofMaterial: materials.roof,
      glassMaterial: materials.glass,
      tint: rng.pick([0x3f6b32, 0x4a7a38, 0x35602c, 0x568437]),
      seed: rng.nextUint32(),
      detail: 'box',
      panelWeights: { blank: 1 },
      groundWeights: { blank: 1 },
      rooftopClutter: 0,
      parapetHeight: 0,
      litWindowChance: 0,
      structureMaterial: 'wood',
    });
    buildings.push(built);
    placements.push({ x, y: 1.6 * scale, z, rotationY: rng.range(0, Math.PI) });
    summaries.push({
      id: `${block.id}.tree${i}`,
      footprint: built.footprint,
      position: [x, 1.6 * scale, z],
      rotationY: 0,
      floors: 1,
      height: built.height,
      style: 'residential',
      structureMaterial: 'wood',
      integrity: 40,
      bounds: [x - r, 0, z - r, x + r, 1.6 * scale + built.height, z + r],
      triangles: built.triangles,
    });
  }
}

/** Scatter street furniture along the parcel frontage. */
function scatterProps(
  block: IPlanBlock,
  zone: IPlanZone,
  params: IPlanZoneParams,
  rng: IRandom,
  out: IRawPlacement[]
): void {
  const outline = block.outline;
  let perimeter = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const count = Math.round((perimeter / 100) * params.propDensity);
  const placed: IRawPlacement[] = [];

  for (let i = 0; i < count; i++) {
    const t = rng.next() * perimeter;
    const point = walkPerimeter(outline, t);
    if (!point) continue;
    // Push out onto the pavement, not into the building line.
    const x = point.x + point.nx * rng.range(1.1, 2.4);
    const z = point.z + point.nz * rng.range(1.1, 2.4);
    const assetKey = pickProp(zone.kind, rng);
    const radius = propRadius(assetKey);
    if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < radius + propRadius(p.assetKey))) continue;
    const placement: IRawPlacement = {
      assetKey,
      x,
      y: 0,
      z,
      rotationY: Math.atan2(point.nx, point.nz) + rng.range(-0.3, 0.3),
      scale: rng.range(0.94, 1.06),
      destructible: propDestructible(assetKey),
    };
    placed.push(placement);
    out.push(placement);
  }
}

interface IPerimeterPoint {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

function walkPerimeter(outline: Polygon, distance: number): IPerimeterPoint | undefined {
  let remaining = distance;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (remaining <= len) {
      const t = len > 0 ? remaining / len : 0;
      // CCW ring in XZ: the outward normal is (dz, -dx) normalised.
      return {
        x: a[0] + dx * t,
        z: a[1] + dz * t,
        nx: len > 0 ? dz / len : 0,
        nz: len > 0 ? -dx / len : 0,
      };
    }
    remaining -= len;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isExcluded(
  exclusions: readonly (readonly [number, number, number])[] | undefined,
  x: number,
  z: number
): boolean {
  if (!exclusions) return false;
  for (const [cx, cz, r] of exclusions) {
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Shift a building's fracture ranges into the merged block buffer. */
function rebaseFracture(
  layout: IFractureLayout,
  offset: { readonly vertexOffset: number; readonly slotIndexOffset: readonly number[] }
): IFractureLayout {
  return rebaseLayout(layout, offset.vertexOffset, offset.slotIndexOffset);
}
