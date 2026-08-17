/**
 * Trauma-based camera shake: composition, decay, distance falloff, determinism.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraShake } from '../camera-shake';

describe('CameraShake', () => {
  it('clamps trauma at 1 and composes additively', () => {
    const shake = new CameraShake();
    shake.add(0.4);
    shake.add(0.4);
    expect(shake.trauma).toBeCloseTo(0.8, 6);
    shake.add(0.9);
    expect(shake.trauma).toBe(1);
  });

  it('squares trauma, so a small hit is nearly invisible', () => {
    const shake = new CameraShake();
    shake.add(0.2);
    // 0.04, not 0.2 — this is the whole reason the API takes trauma.
    expect(shake.amplitude).toBeCloseTo(0.04, 6);
  });

  it('decays to nothing on its own', () => {
    const shake = new CameraShake({ decayRate: 2 });
    shake.add(1);
    shake.update(0.25);
    expect(shake.trauma).toBeCloseTo(0.5, 5);
    shake.update(1);
    expect(shake.trauma).toBe(0);
    expect(shake.offset.length()).toBe(0);
    expect(shake.roll).toBe(0);
  });

  it('attenuates by distance quadratically', () => {
    const near = new CameraShake();
    const far = new CameraShake();
    const position = new THREE.Vector3(0, 0, 0);
    near.listenerPosition.set(0, 0, 10);
    far.listenerPosition.set(0, 0, 50);
    near.addAtPosition(1, position, 100);
    far.addAtPosition(1, position, 100);
    expect(near.trauma).toBeCloseTo(0.81, 6);
    expect(far.trauma).toBeCloseTo(0.25, 6);
  });

  it('ignores anything beyond the falloff radius', () => {
    const shake = new CameraShake();
    shake.listenerPosition.set(0, 0, 200);
    shake.addAtPosition(1, new THREE.Vector3(), 100);
    expect(shake.trauma).toBe(0);
  });

  it('produces motion, and the same motion twice for the same seed', () => {
    const a = new CameraShake({ seed: 99 });
    const b = new CameraShake({ seed: 99 });
    const c = new CameraShake({ seed: 100 });
    for (const shake of [a, b, c]) {
      shake.add(1);
      for (let i = 0; i < 12; i++) shake.update(1 / 60);
    }
    expect(a.offset.length()).toBeGreaterThan(0);
    expect(a.offset.toArray()).toEqual(b.offset.toArray());
    expect(a.roll).toBe(b.roll);
    expect(c.offset.toArray()).not.toEqual(a.offset.toArray());
  });

  it('resets instantly', () => {
    const shake = new CameraShake();
    shake.add(1);
    shake.update(1 / 60);
    shake.reset();
    expect(shake.trauma).toBe(0);
    expect(shake.offset.length()).toBe(0);
  });
});
