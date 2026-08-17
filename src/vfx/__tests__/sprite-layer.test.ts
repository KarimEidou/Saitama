/**
 * The sprite layer: capacity, retirement, depth ordering and the promise that
 * a frame of simulation allocates nothing.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SpriteMode, vfxProfileFor } from '../constants';
import { createQuadGeometry } from '../geometry';
import { SpriteLayer, createSpriteParams } from '../sprite-layer';

function makeLayer(capacity?: number): SpriteLayer {
  const profile = vfxProfileFor('medium');
  return new SpriteLayer(
    createQuadGeometry(),
    new THREE.MeshBasicMaterial(),
    profile,
    capacity ?? profile.spriteCapacity
  );
}

const eye = new THREE.Vector3(0, 0, 0);
const forward = new THREE.Vector3(0, 0, -1);

describe('SpriteLayer', () => {
  it('refuses to grow past its capacity and counts the drops', () => {
    const layer = makeLayer(4);
    const p = createSpriteParams();
    p.life = 10;
    for (let i = 0; i < 4; i++) expect(layer.emit(p)).toBe(true);
    expect(layer.emit(p)).toBe(false);
    expect(layer.emit(p)).toBe(false);
    expect(layer.activeCount).toBe(4);
    expect(layer.dropped).toBe(2);
    expect(layer.free).toBe(0);
  });

  it('retires particles when their life runs out', () => {
    const layer = makeLayer(8);
    const p = createSpriteParams();
    p.life = 1;
    layer.emit(p);
    p.life = 3;
    layer.emit(p);
    layer.update(1.5);
    expect(layer.activeCount).toBe(1);
    layer.update(2);
    expect(layer.activeCount).toBe(0);
  });

  it('keeps the live particles contiguous after a swap-remove', () => {
    const layer = makeLayer(8);
    const p = createSpriteParams();
    // Middle particle dies first; the last one must move into its slot and
    // still be simulated, not skipped.
    p.life = 5;
    p.x = 1;
    layer.emit(p);
    p.life = 0.5;
    p.x = 2;
    layer.emit(p);
    p.life = 5;
    p.x = 3;
    layer.emit(p);

    layer.update(1);
    expect(layer.activeCount).toBe(2);

    layer.prepare(eye, forward);
    const positions = layer.mesh.geometry.getAttribute('iPosSize').array as Float32Array;
    const seen = [positions[0], positions[4]].sort();
    expect(seen).toEqual([1, 3]);
  });

  it('integrates gravity and drag', () => {
    const layer = makeLayer(4);
    const p = createSpriteParams();
    p.life = 10;
    p.vy = 10;
    p.gravity = -10;
    layer.emit(p);
    layer.update(0.5);
    layer.prepare(eye, forward);
    const positions = layer.mesh.geometry.getAttribute('iPosSize').array as Float32Array;
    // v = 10 - 10*0.5 = 5, y = 5*0.5 = 2.5.
    expect(positions[1]).toBeCloseTo(2.5, 5);
  });

  it('writes instances back to front so transparency composites correctly', () => {
    const layer = makeLayer(16);
    const p = createSpriteParams();
    p.life = 10;
    // Camera looks down -Z from the origin, so -50 is the FARTHEST.
    for (const z of [-10, -50, -30]) {
      p.z = z;
      layer.emit(p);
    }
    layer.prepare(eye, forward);
    const positions = layer.mesh.geometry.getAttribute('iPosSize').array as Float32Array;
    expect([positions[2], positions[6], positions[10]]).toEqual([-50, -30, -10]);
  });

  it('publishes only the live instance count to the GPU', () => {
    const layer = makeLayer(32);
    const p = createSpriteParams();
    p.life = 10;
    for (let i = 0; i < 5; i++) layer.emit(p);
    layer.prepare(eye, forward);
    const geometry = layer.mesh.geometry as THREE.InstancedBufferGeometry;
    expect(geometry.instanceCount).toBe(5);
    const range = geometry.getAttribute('iPosSize').updateRanges[0];
    expect(range).toEqual({ start: 0, count: 20 });
  });

  it('grows the particle over its life and erodes it away entirely', () => {
    const layer = makeLayer(4);
    const p = createSpriteParams();
    p.life = 1;
    p.size0 = 2;
    p.size1 = 10;
    p.erode = 1.05;
    layer.emit(p);

    layer.update(0.5);
    layer.prepare(eye, forward);
    const positions = layer.mesh.geometry.getAttribute('iPosSize').array as Float32Array;
    const params = layer.mesh.geometry.getAttribute('iParams').array as Float32Array;
    expect(positions[3]!).toBeGreaterThan(2);
    expect(positions[3]!).toBeLessThan(10);
    // Erosion must be well on its way by the halfway point, or the puff pops
    // out of existence at the end instead of dissolving.
    expect(params[3]!).toBeGreaterThan(0.4);
  });

  it('hashes identical state identically and different state differently', () => {
    const a = makeLayer(8);
    const b = makeLayer(8);
    const p = createSpriteParams();
    p.life = 4;
    p.vx = 3;
    for (const layer of [a, b]) {
      layer.emit(p);
      layer.update(0.25);
    }
    expect(a.checksum()).toBe(b.checksum());

    b.update(0.25);
    expect(a.checksum()).not.toBe(b.checksum());
  });

  it('allocates nothing across a sustained frame loop', () => {
    // Not a heap probe — node's GC makes that unreliable in a unit test. This
    // asserts the STRUCTURAL property that makes zero allocation possible: the
    // typed arrays backing the instance attributes are never replaced, and the
    // update range object is reused rather than pushed anew.
    const layer = makeLayer(256);
    const p = createSpriteParams();
    p.life = 3;
    p.turbulence = 2;
    p.mode = SpriteMode.Billboard;

    const attributeNames = ['iPosSize', 'iColor', 'iParams', 'iMotion', 'iShade'] as const;
    const before = attributeNames.map((n) => layer.mesh.geometry.getAttribute(n).array);
    layer.prepare(eye, forward);
    const rangeIdentity = layer.mesh.geometry.getAttribute('iPosSize').updateRanges[0];

    for (let frame = 0; frame < 240; frame++) {
      for (let i = 0; i < 3; i++) {
        p.x = frame * 0.1;
        p.seed = (frame % 17) / 17;
        layer.emit(p);
      }
      layer.update(1 / 60);
      layer.prepare(eye, forward);
    }

    const after = attributeNames.map((n) => layer.mesh.geometry.getAttribute(n).array);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBe(before[i]);
    expect(layer.mesh.geometry.getAttribute('iPosSize').updateRanges[0]).toBe(rangeIdentity);
    expect(layer.activeCount).toBeGreaterThan(0);
    expect(layer.activeCount).toBeLessThanOrEqual(256);
  });
});
