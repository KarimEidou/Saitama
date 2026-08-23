/**
 * PROP PLACEMENT
 *
 * `writeMatrix` and `yawAlong` are the only hand-written transform code in the
 * unit, and they are what decides where a lamp post stands and which way a car
 * points. Both are asserted against three's own composition rather than against
 * themselves, because a self-consistent wrong matrix is exactly the failure the
 * determinism suite cannot see.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { allPropAssetKeys, batchProps, propDestructible, propRadius, yawAlong } from '../props';
import type { IRawPlacement } from '../props';

const PLACEMENTS: readonly IRawPlacement[] = [
  {
    assetKey: 'model.prop.street_lamp_01',
    x: 12.5,
    y: 0,
    z: -403.25,
    rotationY: 0,
    scale: 1,
    destructible: true,
  },
  {
    assetKey: 'model.prop.covered_car',
    x: -88,
    y: 0.5,
    z: 17,
    rotationY: 1.2,
    scale: 1.06,
    destructible: true,
  },
  {
    assetKey: 'model.prop.covered_car',
    x: 640.5,
    y: 0,
    z: -12.75,
    rotationY: -2.4,
    scale: 0.94,
    destructible: true,
  },
  {
    assetKey: 'model.prop.fire_hydrant',
    x: 3,
    y: 0,
    z: 4,
    rotationY: Math.PI / 2,
    scale: 1,
    destructible: true,
  },
];

describe('instance matrices', () => {
  it('packs a column-major TRS matrix three decomposes back to the placement', () => {
    const batches = batchProps(PLACEMENTS);
    const byKey = new Map(batches.map((b) => [b.assetKey, b]));
    for (const key of new Set(PLACEMENTS.map((p) => p.assetKey))) {
      const batch = byKey.get(key)!;
      const mine = PLACEMENTS.filter((p) => p.assetKey === key);
      expect(batch.count).toBe(mine.length);
      expect(batch.matrices.length).toBe(mine.length * 16);
      for (let i = 0; i < mine.length; i++) {
        const m = new THREE.Matrix4().fromArray(batch.matrices, i * 16);
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        m.decompose(position, quaternion, scale);
        expect(position.x).toBeCloseTo(mine[i].x, 3);
        expect(position.y).toBeCloseTo(mine[i].y, 3);
        expect(position.z).toBeCloseTo(mine[i].z, 3);
        expect(scale.x).toBeCloseTo(mine[i].scale, 5);
        expect(scale.y).toBeCloseTo(mine[i].scale, 5);
        expect(scale.z).toBeCloseTo(mine[i].scale, 5);
        const euler = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ');
        expect(euler.x).toBeCloseTo(0, 5);
        expect(euler.z).toBeCloseTo(0, 5);
        expect(euler.y).toBeCloseTo(mine[i].rotationY, 4);
      }
    }
  });

  it('matches three.compose element for element', () => {
    const p = PLACEMENTS[1];
    const [batch] = batchProps([p]);
    const expected = new THREE.Matrix4().compose(
      new THREE.Vector3(p.x, p.y, p.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rotationY, 0)),
      new THREE.Vector3(p.scale, p.scale, p.scale)
    );
    for (let e = 0; e < 16; e++) expect(batch.matrices[e]).toBeCloseTo(expected.elements[e], 5);
  });

  it('aims a model built along local +Z down the direction it is given', () => {
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [3, 4],
    ] as const) {
      const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        yawAlong(dx, dz)
      );
      const want = new THREE.Vector3(dx, 0, dz).normalize();
      expect(forward.x).toBeCloseTo(want.x, 5);
      expect(forward.z).toBeCloseTo(want.z, 5);
    }
  });

  it('emits one batch per asset key, key-sorted, and nothing for no placements', () => {
    const batches = batchProps(PLACEMENTS);
    const keys = batches.map((b) => b.assetKey);
    expect(keys).toEqual([...new Set(keys)].sort());
    expect(batches.reduce((n, b) => n + b.count, 0)).toBe(PLACEMENTS.length);
    expect(batchProps([])).toEqual([]);
  });

  it('classifies the props that must not be knocked over', () => {
    expect(propDestructible('model.prop.water_manhole_cover')).toBe(false);
    expect(propDestructible('model.building.modular_chainlink_fence')).toBe(false);
    expect(propDestructible('model.prop.covered_car')).toBe(true);
    expect(propRadius('model.prop.covered_car')).toBeGreaterThan(
      propRadius('model.prop.street_rat')
    );
    for (const key of allPropAssetKeys()) expect(propRadius(key)).toBeGreaterThan(0);
  });
});
