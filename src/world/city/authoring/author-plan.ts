/**
 * CITY Z — AUTHORING SOURCE FOR `assets/district/cityz.plan.json`
 *
 * This file is the LAYOUT DOCUMENT. Every coordinate in it was chosen, not
 * rolled: where Route Z runs, how wide the Central Crossing is, which corner
 * the Hero Association branch stands on, how far the shotengai reaches up the
 * main street, where the crater from a fight that happened before the player
 * arrived still is.
 *
 * What it emits is `cityz.plan.json`, which is the committed, hand-tunable
 * artifact the game actually reads. The 256 parcel records in that file are
 * DERIVED here rather than typed by hand, because a block is by definition the
 * land left over between roads — deriving it from the road graph is the only
 * way the two can never disagree. Editing the JSON afterwards is expected and
 * supported; nothing regenerates it behind your back.
 *
 * Run:  npx tsx src/world/city/authoring/author-plan.ts
 *
 * Nothing at RUNTIME imports this module. It exists so that a change to the
 * city's shape is a change to readable code plus a reviewable JSON diff,
 * rather than a hand-edit of 150 KB of coordinates.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  CHUNK_COORD_MAX,
  CHUNK_COORD_MIN,
  CHUNK_GRID,
  CHUNK_SIZE,
  WORLD_SIZE,
} from '../../../spatial/constants';
import { CITY_MATERIALS } from '../materials';
import { chamferPolygon, circlePolygon, polygonArea, type Vec2 } from '../polygon';
import type {
  ICityPlan,
  IPlanBlock,
  IPlanCrater,
  IPlanIntersection,
  IPlanLandmark,
  IPlanProp,
  IPlanRoad,
  IPlanZone,
  IPlanZoneParams,
  ZoneKind,
} from '../plan-types';

const HALF = WORLD_SIZE / 2;
const PLAN_VERSION = 1;
const WORLD_SEED = 0x5a17a3a;

/* ========================================================================== */
/* 1. THE ROAD GRAPH — authored                                               */
/* ========================================================================== */

/**
 * Two arterials cross at the origin: Route Z north-south and Central Boulevard
 * east-west. That crossing is City Z's centre and the widest piece of road in
 * the district — it is where a fight is meant to end up.
 *
 * Four secondary avenues quarter the map at +/-384 m, and a 96 m local grid on
 * the chunk boundaries fills in between. Aligning the local grid to the chunk
 * grid is not laziness: it means a parcel never straddles a streaming boundary,
 * so a chunk load never has to draw half a building.
 */
const ROAD_WIDTH = {
  arterial: 26,
  avenue: 18,
  street: 12,
  alley: 6,
} as const;

const SIDEWALK = {
  arterial: 5,
  avenue: 4,
  street: 3,
  alley: 1.2,
} as const;

interface IAxisRoad {
  readonly id: string;
  readonly name: string;
  readonly axis: 'x' | 'z';
  /** Constant coordinate of the centreline. */
  readonly at: number;
  readonly kind: keyof typeof ROAD_WIDTH;
  readonly lanes: number;
}

function authorRoads(): { roads: IPlanRoad[]; axes: IAxisRoad[] } {
  const axes: IAxisRoad[] = [
    { id: 'route-z', name: 'Route Z', axis: 'x', at: 0, kind: 'arterial', lanes: 4 },
    {
      id: 'central-boulevard',
      name: 'Central Boulevard',
      axis: 'z',
      at: 0,
      kind: 'arterial',
      lanes: 4,
    },
    { id: 'west-avenue', name: 'West Avenue', axis: 'x', at: -384, kind: 'avenue', lanes: 3 },
    { id: 'east-avenue', name: 'East Avenue', axis: 'x', at: 384, kind: 'avenue', lanes: 3 },
    { id: 'north-avenue', name: 'North Avenue', axis: 'z', at: -384, kind: 'avenue', lanes: 3 },
    { id: 'south-avenue', name: 'South Avenue', axis: 'z', at: 384, kind: 'avenue', lanes: 3 },
  ];

  // Local grid on every remaining chunk boundary.
  for (let i = CHUNK_COORD_MIN + 1; i <= CHUNK_COORD_MAX; i++) {
    const at = i * CHUNK_SIZE;
    if (axes.some((a) => a.axis === 'x' && a.at === at)) continue;
    axes.push({
      id: `street-x${i}`,
      name: `${i < 0 ? 'West' : 'East'} ${Math.abs(i)} Street`,
      axis: 'x',
      at,
      kind: 'street',
      lanes: 2,
    });
  }
  for (let i = CHUNK_COORD_MIN + 1; i <= CHUNK_COORD_MAX; i++) {
    const at = i * CHUNK_SIZE;
    if (axes.some((a) => a.axis === 'z' && a.at === at)) continue;
    axes.push({
      id: `street-z${i}`,
      name: `${i < 0 ? 'North' : 'South'} ${Math.abs(i)} Street`,
      axis: 'z',
      at,
      kind: 'street',
      lanes: 2,
    });
  }

  const roads: IPlanRoad[] = axes.map((axis) => ({
    id: axis.id,
    name: axis.name,
    roadClass: axis.kind === 'arterial' ? 'avenue' : axis.kind === 'avenue' ? 'avenue' : 'street',
    lanes: axis.lanes,
    width: ROAD_WIDTH[axis.kind],
    sidewalk: SIDEWALK[axis.kind],
    surface:
      axis.kind === 'arterial' ? 'asphalt-clean' : axis.kind === 'avenue' ? 'asphalt-worn' : 'asphalt-rough',
    markings: axis.lanes >= 4 ? 'divided' : axis.lanes >= 3 ? 'centre-dashed' : 'centre-dashed',
    points:
      axis.axis === 'x'
        ? ([
            [axis.at, -HALF],
            [axis.at, 0],
            [axis.at, HALF],
          ] as Vec2[])
        : ([
            [-HALF, axis.at],
            [0, axis.at],
            [HALF, axis.at],
          ] as Vec2[]),
    curved: false,
    lampSpacing: axis.kind === 'street' ? 26 : 22,
  }));

  return { roads, axes };
}

/** Junctions the plan cares about: the crossing and the four avenue nodes. */
function authorIntersections(): IPlanIntersection[] {
  const out: IPlanIntersection[] = [
    {
      id: 'central-crossing',
      position: [0, 0],
      kind: 'cross',
      radius: 18,
      roads: ['route-z', 'central-boulevard'],
      crossings: true,
      signals: true,
    },
  ];
  const avenueNodes: [string, string, number, number][] = [
    ['route-z', 'north-avenue', 0, -384],
    ['route-z', 'south-avenue', 0, 384],
    ['west-avenue', 'central-boulevard', -384, 0],
    ['east-avenue', 'central-boulevard', 384, 0],
    ['west-avenue', 'north-avenue', -384, -384],
    ['east-avenue', 'north-avenue', 384, -384],
    ['west-avenue', 'south-avenue', -384, 384],
    ['east-avenue', 'south-avenue', 384, 384],
  ];
  for (const [a, b, x, z] of avenueNodes) {
    out.push({
      id: `junction-${a}-${b}`,
      position: [x, z],
      kind: 'cross',
      radius: 13,
      roads: [a, b],
      crossings: true,
      signals: true,
    });
  }
  return out;
}

/* ========================================================================== */
/* 2. ZONING — authored                                                       */
/* ========================================================================== */

/** Shared defaults; each zone overrides only what makes it itself. */
function baseParams(): IPlanZoneParams {
  return {
    floorRange: [3, 6],
    heightExponent: 1.6,
    floorHeight: 3.3,
    groundFloorScale: 1.25,
    density: 0.86,
    lotWidth: [11, 19],
    lotDepth: [12, 18],
    setback: 0.4,
    styleWeights: { residential: 4, shophouse: 3, apartment: 3 },
    facadeMaterials: [
      CITY_MATERIALS.wall.plasterBeige,
      CITY_MATERIALS.wall.concretePlain,
      CITY_MATERIALS.wall.plasterWhite,
    ],
    facadeWeights: [3, 3, 2],
    roofMaterials: [CITY_MATERIALS.roof.bitumen, CITY_MATERIALS.roof.corrugated],
    tints: [0xd8d2c6, 0xc9c4bb, 0xe2ddd2, 0xbfb9ad, 0xd2cfc9],
    panelWeights: { window: 10, blank: 4, ac_unit: 3, balcony: 3, fire_escape_anchor: 1 },
    groundWeights: { shopfront: 3, door: 3, window: 3, blank: 3 },
    balconyChance: 0.3,
    fireEscapeChance: 0.15,
    acUnitChance: 0.3,
    signageChance: 0.35,
    rooftopClutter: 0.7,
    propDensity: 5,
    populationDensity: 1,
    threatDensity: 1,
    lotSurface: 'concrete',
  };
}

function zone(
  id: string,
  name: string,
  kind: ZoneKind,
  district: IPlanZone['district'],
  polygon: readonly Vec2[],
  priority: number,
  params: Partial<IPlanZoneParams>
): IPlanZone {
  const ring = polygonArea(polygon) > 0 ? polygon : polygon.slice().reverse();
  return { id, name, kind, district, polygon: ring, priority, params: { ...baseParams(), ...params } };
}

function authorZones(): IPlanZone[] {
  return [
    // The default: everything the specific zones do not claim.
    zone(
      'outer-residential',
      'Z-City Outskirts',
      'residential',
      'residential',
      [
        [-HALF, -HALF],
        [HALF, -HALF],
        [HALF, HALF],
        [-HALF, HALF],
      ],
      0,
      {
        floorRange: [2, 4],
        heightExponent: 1.8,
        density: 0.74,
        lotWidth: [9, 16],
        lotDepth: [10, 15],
        styleWeights: { residential: 6, shophouse: 2, apartment: 2 },
        facadeMaterials: [
          CITY_MATERIALS.wall.plasterBeige,
          CITY_MATERIALS.wall.plasterWhite,
          CITY_MATERIALS.wall.brickWeathered,
          CITY_MATERIALS.wall.concretePlain,
        ],
        facadeWeights: [3, 3, 2, 2],
        roofMaterials: [CITY_MATERIALS.roof.tilesGrey, CITY_MATERIALS.roof.corrugatedWorn],
        tints: [0xdad3c4, 0xe6e0d3, 0xc7bfae, 0xcfd2cd, 0xe0d6c6, 0xb9b3a6],
        panelWeights: { window: 10, blank: 5, ac_unit: 4, balcony: 4 },
        rooftopClutter: 0.45,
        propDensity: 3.5,
        populationDensity: 0.7,
      }
    ),

    // Mid ring: post-war apartment blocks, the danchi look.
    zone(
      'apartment-ring',
      'Z-City Housing Ring',
      'apartment',
      'residential',
      [
        [-540, -540],
        [540, -540],
        [540, 540],
        [-540, 540],
      ],
      1,
      {
        floorRange: [4, 9],
        heightExponent: 1.5,
        density: 0.88,
        lotWidth: [12, 22],
        lotDepth: [13, 19],
        styleWeights: { apartment: 6, residential: 3, commercial: 2 },
        facadeMaterials: [
          CITY_MATERIALS.wall.concretePlain,
          CITY_MATERIALS.wall.concreteDirty,
          CITY_MATERIALS.wall.plasterBeige,
          CITY_MATERIALS.wall.concretePainted,
        ],
        facadeWeights: [3, 3, 2, 2],
        tints: [0xd6d1c6, 0xc4c8c9, 0xdedad0, 0xb8bdbb, 0xcfc7b8],
        panelWeights: { window: 8, balcony: 7, blank: 3, ac_unit: 4, fire_escape_anchor: 2 },
        rooftopClutter: 0.8,
        propDensity: 5,
      }
    ),

    // Downtown: the tall core around the Central Crossing.
    zone(
      'downtown',
      'Z-City Central',
      'downtown',
      'downtown',
      chamferPolygon(
        [
          [-264, -264],
          [264, -264],
          [264, 264],
          [-264, 264],
        ],
        56
      ),
      3,
      {
        floorRange: [7, 20],
        heightExponent: 1.35,
        floorHeight: 3.7,
        groundFloorScale: 1.45,
        density: 0.95,
        lotWidth: [16, 30],
        lotDepth: [17, 26],
        setback: 0.2,
        styleWeights: { commercial: 5, skyscraper: 4, civic: 2 },
        facadeMaterials: [
          CITY_MATERIALS.wall.concretePlain,
          CITY_MATERIALS.wall.concreteLayers,
          CITY_MATERIALS.wall.concretePainted,
          CITY_MATERIALS.wall.plasterWhite,
        ],
        facadeWeights: [4, 3, 2, 2],
        roofMaterials: [CITY_MATERIALS.roof.bitumen, CITY_MATERIALS.roof.metalPlate],
        tints: [0xdcdcd8, 0xc6cbce, 0xe4e2dc, 0xb4bcc2, 0xd0cec6],
        panelWeights: { window: 14, blank: 2, ac_unit: 1 },
        groundWeights: { shopfront: 6, door: 2, window: 3 },
        rooftopClutter: 1,
        propDensity: 8,
        populationDensity: 2.2,
        threatDensity: 1.4,
        lotSurface: 'concrete',
      }
    ),

    // The shotengai: the covered shopping street that runs north from downtown.
    zone(
      'shotengai',
      'Z-City Shotengai',
      'shopping',
      'downtown',
      [
        [-108, -540],
        [108, -540],
        [108, -252],
        [-108, -252],
      ],
      5,
      {
        floorRange: [2, 5],
        heightExponent: 1.9,
        floorHeight: 3.2,
        groundFloorScale: 1.5,
        density: 0.97,
        lotWidth: [6.5, 12],
        lotDepth: [11, 16],
        setback: 0,
        styleWeights: { shophouse: 7, commercial: 3, residential: 2 },
        facadeMaterials: [
          CITY_MATERIALS.wall.plasterWhite,
          CITY_MATERIALS.wall.plasterBeige,
          CITY_MATERIALS.wall.brickRed,
          CITY_MATERIALS.wall.concretePainted,
        ],
        facadeWeights: [3, 3, 2, 2],
        roofMaterials: [CITY_MATERIALS.roof.corrugated, CITY_MATERIALS.roof.tilesGrey],
        tints: [0xe8e2d4, 0xd9cdb8, 0xcf9f86, 0xdcd9d2, 0xc8b9a2, 0xe3d7c0],
        panelWeights: { window: 9, blank: 3, ac_unit: 5, balcony: 3 },
        groundWeights: { shopfront: 12, door: 2 },
        signageChance: 0.9,
        rooftopClutter: 0.85,
        propDensity: 11,
        populationDensity: 2.6,
        lotSurface: 'cobble',
      }
    ),

    // The Hero Association's civic quarter, north-east.
    zone(
      'civic-quarter',
      'Hero Association Quarter',
      'civic',
      'heroAssociation',
      [
        [288, -480],
        [480, -480],
        [480, -288],
        [288, -288],
      ],
      6,
      {
        floorRange: [4, 10],
        heightExponent: 1.4,
        floorHeight: 3.8,
        groundFloorScale: 1.5,
        density: 0.8,
        lotWidth: [16, 26],
        lotDepth: [16, 24],
        setback: 1.2,
        styleWeights: { civic: 6, commercial: 3 },
        facadeMaterials: [CITY_MATERIALS.wall.plasterWhite, CITY_MATERIALS.wall.concretePlain],
        facadeWeights: [3, 2],
        roofMaterials: [CITY_MATERIALS.roof.bitumen, CITY_MATERIALS.roof.metalPlate],
        tints: [0xeceae4, 0xdfe2e4, 0xd6dade],
        panelWeights: { window: 14, blank: 3 },
        rooftopClutter: 0.9,
        propDensity: 7,
        populationDensity: 1.6,
        lotSurface: 'concrete',
      }
    ),

    // Industry in the south-east: long sheds, chainlink, corrugated iron.
    zone(
      'industrial-south',
      'Z-City Works',
      'industrial',
      'industrial',
      [
        [216, 264],
        [HALF, 264],
        [HALF, HALF],
        [216, HALF],
      ],
      4,
      {
        floorRange: [1, 3],
        heightExponent: 1.5,
        floorHeight: 4.6,
        groundFloorScale: 1.1,
        density: 0.66,
        lotWidth: [18, 36],
        lotDepth: [18, 30],
        setback: 1.5,
        styleWeights: { industrial: 8, commercial: 2 },
        facadeMaterials: [
          CITY_MATERIALS.wall.factoryPanel,
          CITY_MATERIALS.wall.corrugatedWorn,
          CITY_MATERIALS.wall.concreteDirty,
          CITY_MATERIALS.wall.container,
        ],
        facadeWeights: [3, 3, 2, 1],
        roofMaterials: [CITY_MATERIALS.roof.corrugatedWorn, CITY_MATERIALS.roof.rustCoarse],
        tints: [0xb9bcb8, 0xa8a49a, 0xc6c2b4, 0x9aa3a4, 0xb0a08c],
        panelWeights: { blank: 10, window: 4, ac_unit: 2 },
        groundWeights: { blank: 6, door: 3, shopfront: 1 },
        rooftopClutter: 1,
        propDensity: 6,
        populationDensity: 0.4,
        threatDensity: 1.5,
        lotSurface: 'gravel',
      }
    ),

    // The park, north-west.
    zone(
      'z-park',
      'Z-City Park',
      'park',
      'park',
      circlePolygon(-432, -432, 168, 14),
      7,
      {
        floorRange: [1, 1],
        density: 0,
        propDensity: 3,
        rooftopClutter: 0,
        facadeMaterials: [CITY_MATERIALS.ground.grass],
        facadeWeights: [1],
        roofMaterials: [CITY_MATERIALS.wall.planks],
        tints: [0x4a7a38],
        populationDensity: 1.4,
        threatDensity: 0.6,
        lotSurface: 'grass',
      }
    ),

    // The ghost town Saitama actually lives in: half-empty, half-derelict.
    zone(
      'ghost-town',
      'Z-City Ghost Town',
      'ghost',
      'wasteland',
      [
        [-HALF, 144],
        [-456, 144],
        [-456, 480],
        [-HALF, 480],
      ],
      5,
      {
        floorRange: [2, 4],
        heightExponent: 1.9,
        density: 0.5,
        lotWidth: [9, 17],
        lotDepth: [11, 16],
        styleWeights: { residential: 5, ruins: 3, apartment: 2 },
        facadeMaterials: [
          CITY_MATERIALS.wall.concreteCracked,
          CITY_MATERIALS.wall.plasterBroken,
          CITY_MATERIALS.wall.brickBroken,
          CITY_MATERIALS.wall.concreteDirty,
        ],
        facadeWeights: [3, 3, 2, 2],
        roofMaterials: [CITY_MATERIALS.roof.corrugatedWorn, CITY_MATERIALS.roof.rustFine],
        tints: [0xbdb6a6, 0xa9a396, 0xcabfae, 0x9d968a],
        panelWeights: { window: 7, blank: 8, ac_unit: 2, balcony: 2, fire_escape_anchor: 2 },
        groundWeights: { blank: 5, door: 3, window: 3, shopfront: 1 },
        rooftopClutter: 0.4,
        propDensity: 4,
        populationDensity: 0.15,
        threatDensity: 2.2,
        lotSurface: 'dirt',
      }
    ),

    // The crater: nothing is rebuilt here yet.
    zone(
      'old-crater',
      'The Crater',
      'crater',
      'wasteland',
      circlePolygon(504, 120, 118, 16),
      9,
      {
        floorRange: [1, 2],
        density: 0,
        propDensity: 6,
        rooftopClutter: 0,
        facadeMaterials: [CITY_MATERIALS.wall.concreteCracked],
        facadeWeights: [1],
        roofMaterials: [CITY_MATERIALS.ground.rubble],
        tints: [0xa89e90],
        populationDensity: 0,
        threatDensity: 3,
        lotSurface: 'dirt',
      }
    ),
  ];
}

/* ========================================================================== */
/* 3. LANDMARKS — authored                                                    */
/* ========================================================================== */

function rect(w: number, d: number): Vec2[] {
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ];
}

function authorLandmarks(): IPlanLandmark[] {
  return [
    {
      id: 'hero-association-z',
      name: 'Hero Association — City Z Branch',
      kind: 'heroAssociation',
      position: [384 - 48, -384 + 48],
      rotationY: 0,
      footprint: rect(44, 34),
      floors: 15,
      floorHeight: 3.9,
      style: 'civic',
      facadeMaterial: CITY_MATERIALS.wall.plasterWhite,
      roofMaterial: CITY_MATERIALS.roof.metalPlate,
      tint: 0xf0eee8,
      exclusionRadius: 34,
      description:
        'Glazed tower on a four-storey civic podium. Registration desk, ranking boards, and the only building in the district anyone gives directions from.',
    },
    {
      id: 'shotengai-arcade',
      name: 'Z-City Shotengai Arcade',
      kind: 'arcade',
      // Sits over Route Z, north of downtown; the canopy spans the carriageway.
      position: [0, -396],
      rotationY: 0,
      footprint: rect(26, 168),
      floors: 1,
      floorHeight: 4,
      style: 'shophouse',
      facadeMaterial: CITY_MATERIALS.wall.concretePainted,
      roofMaterial: CITY_MATERIALS.roof.corrugated,
      tint: 0xd8d4cb,
      exclusionRadius: 16,
      description:
        'The covered shopping street. Vegetables, a butcher, a bargain sale that matters more than most fights.',
    },
    {
      id: 'saitama-apartment',
      name: "Saitama's Apartment Block",
      kind: 'apartment',
      position: [-600, 300],
      rotationY: 0,
      footprint: rect(19, 13),
      floors: 3,
      floorHeight: 3.1,
      style: 'apartment',
      facadeMaterial: CITY_MATERIALS.wall.plasterBroken,
      roofMaterial: CITY_MATERIALS.roof.corrugatedWorn,
      tint: 0xc9c1b0,
      exclusionRadius: 22,
      description:
        'Three storeys, external walkways, mostly empty since the neighbourhood emptied out. Room 202.',
    },
    {
      id: 'z-park-pavilion',
      name: 'Z-City Park Pavilion',
      kind: 'park',
      position: [-432, -432],
      rotationY: 0,
      footprint: rect(14, 14),
      floors: 1,
      floorHeight: 3.6,
      style: 'civic',
      facadeMaterial: CITY_MATERIALS.wall.planks,
      roofMaterial: CITY_MATERIALS.roof.tilesCeramic,
      tint: 0xc3a883,
      exclusionRadius: 18,
      description: 'Timber pavilion at the centre of the park.',
    },
  ];
}

function authorCraters(): IPlanCrater[] {
  return [
    {
      id: 'old-crater',
      centre: [504, 120],
      radius: 112,
      depth: 15,
      rim: 3.2,
      rubble: 0.85,
      description:
        'Left by a fight nobody in City Z talks about. Two streets still dead-end into the rim.',
    },
  ];
}

function authorProps(): IPlanProp[] {
  return [
    // The vending machine corner outside Saitama's block; stand-ins from the
    // hidden_alley kit until a bespoke model exists.
    { assetKey: 'model.prop.utility_box_01', position: [-588, 292], rotationY: 0, scale: 1 },
    { assetKey: 'model.prop.metal_trash_can', position: [-586, 296], rotationY: 0.8, scale: 1 },
    { assetKey: 'model.prop.street_lamp_01', position: [-592, 288], rotationY: 0, scale: 1 },
    // Barriers still closing the streets that run into the crater.
    { assetKey: 'model.prop.concrete_road_barrier', position: [396, 120], rotationY: 0, scale: 1 },
    { assetKey: 'model.prop.concrete_road_barrier', position: [396, 126], rotationY: 0, scale: 1 },
    { assetKey: 'model.prop.concrete_road_barrier', position: [612, 120], rotationY: 0, scale: 1 },
    { assetKey: 'model.prop.concrete_road_barrier_02', position: [612, 126], rotationY: 0, scale: 1 },
  ];
}

/* ========================================================================== */
/* 4. PARCELS — derived from the road graph                                   */
/* ========================================================================== */

/**
 * A block is the land between roads. Deriving it rather than typing it is the
 * only way the parcel and the road that bounds it cannot disagree: each chunk
 * square is inset by the half-width plus sidewalk of whichever road runs along
 * each of its four edges.
 */
function deriveBlocks(axes: readonly IAxisRoad[], zones: readonly IPlanZone[]): IPlanBlock[] {
  const byAxisX = new Map<number, IAxisRoad>();
  const byAxisZ = new Map<number, IAxisRoad>();
  for (const axis of axes) {
    if (axis.axis === 'x') byAxisX.set(axis.at, axis);
    else byAxisZ.set(axis.at, axis);
  }

  const zonesByPriority = zones.slice().sort((a, b) => b.priority - a.priority);
  const blocks: IPlanBlock[] = [];

  for (let cz = CHUNK_COORD_MIN; cz <= CHUNK_COORD_MAX; cz++) {
    for (let cx = CHUNK_COORD_MIN; cx <= CHUNK_COORD_MAX; cx++) {
      const x0 = cx * CHUNK_SIZE;
      const z0 = cz * CHUNK_SIZE;
      const x1 = x0 + CHUNK_SIZE;
      const z1 = z0 + CHUNK_SIZE;

      const west = byAxisX.get(x0);
      const east = byAxisX.get(x1);
      const north = byAxisZ.get(z0);
      const south = byAxisZ.get(z1);

      const inset = (road: IAxisRoad | undefined) =>
        road ? ROAD_WIDTH[road.kind] / 2 + SIDEWALK[road.kind] : ROAD_WIDTH.street / 2 + SIDEWALK.street;

      const sidewalk = Math.max(
        west ? SIDEWALK[west.kind] : 0,
        east ? SIDEWALK[east.kind] : 0,
        north ? SIDEWALK[north.kind] : 0,
        south ? SIDEWALK[south.kind] : 0,
        SIDEWALK.street
      );

      // Property line: back off the carriageway AND the sidewalk.
      const minX = x0 + inset(west);
      const maxX = x1 - inset(east);
      const minZ = z0 + inset(north);
      const maxZ = z1 - inset(south);
      if (maxX - minX < 12 || maxZ - minZ < 12) continue;

      const centreX = (minX + maxX) * 0.5;
      const centreZ = (minZ + maxZ) * 0.5;
      const zone =
        zonesByPriority.find((z) => pointInRing(z.polygon, centreX, centreZ)) ??
        zonesByPriority[zonesByPriority.length - 1];

      const isArterial = (road: IAxisRoad | undefined) =>
        road !== undefined && (road.kind === 'arterial' || road.kind === 'avenue');

      // Outline order matches the CCW ring used everywhere else, so the
      // frontage flags line up edge-for-edge with `subdivideBlock`'s runs.
      const outline: Vec2[] = [
        [minX, minZ],
        [maxX, minZ],
        [maxX, maxZ],
        [minX, maxZ],
      ];

      // Taller nearer the centre, so the district has a skyline rather than a
      // plateau. Purely a bias; the zone still sets the range.
      const distance = Math.hypot(centreX, centreZ);
      const heightBias =
        zone.kind === 'downtown'
          ? Math.round(Math.max(0, 4 - distance / 90))
          : distance < 480
            ? Math.round(Math.max(0, 2 - distance / 260))
            : 0;

      blocks.push({
        id: `blk_${cx}_${cz}`,
        chunk: [cx, cz],
        outline,
        zone: zone.id,
        salt: 0,
        density: 1,
        heightBias,
        // Order matches the edge index `block.ts` derives from a lot's facing
        // direction: west, south, east, north.
        frontage: [
          isArterial(west),
          isArterial(south),
          isArterial(east),
          isArterial(north),
        ],
        sidewalk,
        tags: zone.kind === 'crater' ? ['crater'] : undefined,
      });
    }
  }
  return blocks;
}

function pointInRing(poly: readonly Vec2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > z !== b[1] > z) {
      const t = (z - a[1]) / (b[1] - a[1]);
      if (x < a[0] + t * (b[0] - a[0])) inside = !inside;
    }
  }
  return inside;
}

/* ========================================================================== */
/* 5. Emit                                                                    */
/* ========================================================================== */

/** Build the plan object. Exported so a test can regenerate and diff it. */
export function authorCityZPlan(): ICityPlan {
  const { roads, axes } = authorRoads();
  const zones = authorZones();
  const blocks = deriveBlocks(axes, zones);
  return {
    planVersion: PLAN_VERSION,
    name: 'City Z — Central District',
    description:
      'Hand-authored road graph, zoning and landmarks for City Z. Everything inside a block is generated from hash(blockId, planVersion); this file is the only authored input.',
    worldSize: WORLD_SIZE,
    chunkSize: CHUNK_SIZE,
    chunkGrid: CHUNK_GRID,
    worldSeed: WORLD_SEED,
    groundLevel: 0,
    roads,
    intersections: authorIntersections(),
    zones,
    landmarks: authorLandmarks(),
    blocks,
    craters: authorCraters(),
    props: authorProps(),
  };
}

/** Serialise with tuples kept on one line, so the diff stays reviewable. */
export function serialisePlan(plan: ICityPlan): string {
  const json = JSON.stringify(plan, null, 2);
  // Collapse `[\n  x,\n  y\n]` number pairs back onto one line.
  return (
    json.replace(/\[\s*\n\s*(-?[\d.e+-]+),\s*\n\s*(-?[\d.e+-]+)\s*\n\s*\]/g, '[$1, $2]') + '\n'
  );
}

function main(): void {
  const plan = authorCityZPlan();
  const out = path.resolve(import.meta.dirname, '../../../../assets/district/cityz.plan.json');
  mkdirSync(path.dirname(out), { recursive: true });
  const text = serialisePlan(plan);
  writeFileSync(out, text, 'utf8');
  console.log(
    `wrote ${out}\n  ${(text.length / 1024).toFixed(1)} KB` +
      `\n  ${plan.roads.length} roads, ${plan.zones.length} zones, ${plan.blocks.length} blocks,` +
      ` ${plan.landmarks.length} landmarks, ${plan.craters.length} craters`
  );
}

// Only run when invoked directly, never on import.
if (process.argv[1] && process.argv[1].endsWith('author-plan.ts')) main();
