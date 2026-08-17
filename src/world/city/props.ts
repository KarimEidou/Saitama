/**
 * STREET FURNITURE
 *
 * Props are what turn a street from "correct" into "inhabited". They are also
 * the cheapest thing in the city per unit of read: a lamp post every 22 m, a
 * hydrant at a corner, an aircon unit on a wall and a covered car in a parking
 * bay do more for the sense of place than another thousand facade triangles.
 *
 * Every asset id here comes from the 39-model Poly Haven `hidden_alley` kit in
 * `tools/manifest/models.json`. Placements are emitted as `IInstanceBatch` —
 * one packed matrix buffer per (assetKey, LOD) — because a lamp post drawn 400
 * times must cost one draw call, not four hundred.
 *
 * `prop-proxies.ts` supplies stand-in geometry for any id the registry cannot
 * serve yet; that keeps the world legible while the GLB pipeline is still
 * transcoding, without ever letting a file path into this module.
 */

import type { IRandom } from '@/util';
import type { IInstanceBatch } from '@/types';
import type { ZoneKind } from './plan-types';

/** Model ids the city scatters, grouped by where they belong. */
export const PROP_ASSETS = {
  lamp: ['model.prop.street_lamp_01', 'model.prop.street_lamp_02'],
  sidewalk: [
    'model.prop.fire_hydrant',
    'model.prop.metal_trash_can',
    'model.prop.utility_box_01',
    'model.prop.utility_box_02',
    'model.prop.water_manhole_cover',
    'model.prop.security_light',
  ],
  alley: [
    'model.prop.old_tyre',
    'model.prop.barrel_stove',
    'model.prop.rusted_wheel_rim_01',
    'model.prop.rusted_wheel_rim_02',
    'model.prop.spray_paint_bottles_02',
    'model.prop.metal_trash_can',
    'model.prop.street_rat',
  ],
  industrial: [
    'model.prop.concrete_road_barrier',
    'model.prop.concrete_road_barrier_02',
    'model.building.modular_chainlink_fence',
    'model.building.modular_electricity_poles',
    'model.prop.covered_car',
  ],
  shopping: [
    'model.building.modular_street_seating',
    'model.building.rollershutter_door',
    'model.prop.metal_trash_can',
    'model.prop.utility_box_02',
  ],
  vehicle: ['model.prop.covered_car'],
  facade: [
    'model.prop.exterior_aircon_unit',
    'model.prop.security_camera_01',
    'model.prop.security_camera_02',
    'model.building.modular_metal_gutter',
    'model.building.modular_airduct_circular_01',
  ],
  rubble: ['model.prop.concrete_road_barrier', 'model.prop.old_tyre', 'model.prop.rusted_wheel_rim_01'],
} as const;

/** Every prop id the city can place, for preloading. */
export function allPropAssetKeys(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(PROP_ASSETS)) for (const key of list) out.add(key);
  return [...out].sort();
}

/** Relative weights over the scatter groups, per zone kind. */
const ZONE_SCATTER: Readonly<Record<ZoneKind, Readonly<Record<string, number>>>> = {
  downtown: { sidewalk: 6, shopping: 2, vehicle: 2, alley: 1 },
  shopping: { shopping: 6, sidewalk: 5, alley: 2, vehicle: 1 },
  apartment: { sidewalk: 5, alley: 3, vehicle: 3 },
  residential: { sidewalk: 4, alley: 3, vehicle: 3 },
  industrial: { industrial: 7, alley: 3, sidewalk: 2, vehicle: 2 },
  civic: { sidewalk: 7, shopping: 1, vehicle: 2 },
  park: { sidewalk: 3, shopping: 2 },
  crater: { rubble: 8, alley: 2 },
  ghost: { alley: 5, sidewalk: 2, rubble: 3, vehicle: 1 },
};

/** Pick a prop asset appropriate to a zone. */
export function pickProp(zone: ZoneKind, rng: IRandom): string {
  const table = ZONE_SCATTER[zone];
  const groups = Object.keys(table).sort();
  const weights = groups.map((g) => table[g]);
  const group = rng.weighted(groups, weights) as keyof typeof PROP_ASSETS;
  const list = PROP_ASSETS[group];
  return list[rng.int(0, list.length - 1)];
}

/* -------------------------------------------------------------------------- */
/* Batching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pack placements into one `IInstanceBatch` per asset key.
 *
 * Sorting by key before packing keeps batch ORDER deterministic; a Map's
 * insertion order would otherwise depend on the scatter sequence, and the
 * determinism test compares serialised output byte for byte.
 */
export function batchProps(placements: readonly IRawPlacement[], lod = 0): IInstanceBatch[] {
  const byKey = new Map<string, IRawPlacement[]>();
  for (const placement of placements) {
    const list = byKey.get(placement.assetKey);
    if (list) list.push(placement);
    else byKey.set(placement.assetKey, [placement]);
  }

  const batches: IInstanceBatch[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const list = byKey.get(key)!;
    const matrices = new Float32Array(list.length * 16);
    for (let i = 0; i < list.length; i++) {
      writeMatrix(matrices, i * 16, list[i]);
    }
    batches.push({ assetKey: key, lod, matrices, count: list.length });
  }
  return batches;
}

/** Column-major TRS matrix for a uniform-scaled, Y-rotated placement. */
function writeMatrix(out: Float32Array, offset: number, p: IRawPlacement): void {
  const c = Math.cos(p.rotationY) * p.scale;
  const s = Math.sin(p.rotationY) * p.scale;
  out[offset] = c;
  out[offset + 1] = 0;
  out[offset + 2] = -s;
  out[offset + 3] = 0;
  out[offset + 4] = 0;
  out[offset + 5] = p.scale;
  out[offset + 6] = 0;
  out[offset + 7] = 0;
  out[offset + 8] = s;
  out[offset + 9] = 0;
  out[offset + 10] = c;
  out[offset + 11] = 0;
  out[offset + 12] = p.x;
  out[offset + 13] = p.y;
  out[offset + 14] = p.z;
  out[offset + 15] = 1;
}

/**
 * A placement expressed without Three.js types, so the scatter pass can run in
 * a worker. `chunk.ts` converts to `IPropPlacement` at the boundary.
 */
export interface IRawPlacement {
  readonly assetKey: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationY: number;
  readonly scale: number;
  readonly destructible: boolean;
}

/**
 * Model forward axis convention.
 *
 * Every model in the Poly Haven `hidden_alley` kit is authored glTF-style,
 * pointing along its local +Z — `covered_car`, for instance, is 1.8 m across X
 * and 4.4 m along Z. Placement yaw therefore aligns local +Z with the wanted
 * direction: a yaw of theta sends +Z to `(sin theta, cos theta)` in (x, z), so
 * the rotation is `atan2(dirX, dirZ)`. Aligning +X instead parks every car
 * broadside across the carriageway, which is exactly what it did before this
 * was written down.
 */
export function yawAlong(dirX: number, dirZ: number): number {
  return Math.atan2(dirX, dirZ);
}

/** Nominal footprint radius per asset, used to keep scatter from overlapping. */
export function propRadius(assetKey: string): number {
  if (assetKey.includes('covered_car')) return 2.4;
  if (assetKey.includes('chainlink_fence')) return 2;
  if (assetKey.includes('electricity_poles')) return 0.6;
  if (assetKey.includes('street_lamp')) return 0.5;
  if (assetKey.includes('road_barrier')) return 1.2;
  if (assetKey.includes('street_seating')) return 1.4;
  if (assetKey.includes('manhole')) return 0.5;
  if (assetKey.includes('rat')) return 0.2;
  return 0.7;
}

/** True for props a punch should be able to send flying. */
export function propDestructible(assetKey: string): boolean {
  return !assetKey.includes('manhole') && !assetKey.includes('chainlink_fence');
}
