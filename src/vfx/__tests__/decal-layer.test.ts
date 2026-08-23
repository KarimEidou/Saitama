/**
 * The decal layer: the ring buffer, and the "cost nothing per frame" promise.
 *
 * This is the only VFX state that outlives the moment, and the class header
 * makes a performance claim about it — "two hundred permanent cracks cost
 * nothing per frame at all". A one-character edit (moving `dirty = true` out of
 * `update`'s zero-lifetime guard, or dropping `prepare`'s early-out) turns the
 * whole instance buffer into a full re-upload every frame with nothing visibly
 * different, so the promise is asserted here as buffer versions that must not
 * move. `BufferAttribute.version` increments on every `needsUpdate = true`,
 * which is what makes upload-gating observable without a renderer.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SpriteMode, vfxProfileFor } from '../constants';
import { createQuadGeometry } from '../geometry';
import { DecalLayer, createDecalParams } from '../decal-layer';

function makeLayer(tier: 'low' | 'medium' = 'low'): DecalLayer {
  return new DecalLayer(createQuadGeometry(), new THREE.MeshBasicMaterial(), vfxProfileFor(tier));
}

/** Upload counters of all five instance attributes. */
function versions(layer: DecalLayer): number[] {
  return ['iPosSize', 'iColor', 'iParams', 'iMotion', 'iShade'].map(
    (name) => (layer.mesh.geometry.getAttribute(name) as THREE.BufferAttribute).version
  );
}

function attribute(layer: DecalLayer, name: string): Float32Array {
  return layer.mesh.geometry.getAttribute(name).array as Float32Array;
}

describe('DecalLayer', () => {
  it('uploads nothing at all on a quiet frame', () => {
    const layer = makeLayer();
    const p = createDecalParams();
    for (let i = 0; i < 3; i++) layer.emit(p);
    layer.prepare();

    const settled = versions(layer);
    for (let i = 0; i < 10; i++) {
      layer.update(1 / 60);
      layer.prepare();
    }
    // The header's promise, stated as a test.
    expect(versions(layer)).toEqual(settled);
  });

  it('uploads exactly once when something changes', () => {
    const layer = makeLayer();
    const p = createDecalParams();
    for (let i = 0; i < 3; i++) layer.emit(p);
    layer.prepare();
    const settled = versions(layer);

    layer.emit(p);
    layer.prepare();
    expect(versions(layer)).toEqual(settled.map((v) => v + 1));

    layer.prepare();
    expect(versions(layer)).toEqual(settled.map((v) => v + 1));
  });

  it('recycles the OLDEST entry, not an arbitrary one', () => {
    const layer = makeLayer();
    expect(layer.capacity).toBe(48);
    const p = createDecalParams();
    for (let i = 0; i < 48; i++) {
      p.x = i;
      layer.emit(p);
    }
    expect(layer.activeCount).toBe(48);
    expect(layer.recycled).toBe(0);

    p.x = 999;
    layer.emit(p);
    layer.prepare();
    expect(layer.activeCount).toBe(48);
    expect(layer.recycled).toBe(1);
    // Slot 0 held the oldest crack, so that is the one the city forgets.
    expect(attribute(layer, 'iPosSize')[0]).toBe(999);
    expect(attribute(layer, 'iPosSize')[4]).toBe(1);

    p.x = 998;
    layer.emit(p);
    layer.prepare();
    expect(attribute(layer, 'iPosSize')[4]).toBe(998);
    expect(attribute(layer, 'iPosSize')[8]).toBe(2);
  });

  it('normalises the surface normal', () => {
    const layer = makeLayer();
    const p = createDecalParams();
    p.nx = 0;
    p.ny = 5;
    p.nz = 0;
    p.aspect = 2.6;
    layer.emit(p);
    layer.prepare();

    const motion = attribute(layer, 'iMotion');
    expect([motion[0], motion[1], motion[2]]).toEqual([0, 1, 0]);
    expect(motion[3]).toBeCloseTo(2.6, 6);
  });

  it('falls back to +Y rather than storing an unusable normal', () => {
    const layer = makeLayer();
    const p = createDecalParams();
    const normals: [number, number, number][] = [
      [0, 0, 0],
      [NaN, 1, 0],
      [0, Infinity, 0],
      [0, -Infinity, 0],
    ];
    for (const [nx, ny, nz] of normals) {
      p.nx = nx;
      p.ny = ny;
      p.nz = nz;
      layer.emit(p);
    }
    layer.prepare();

    // SPRITE_VERTEX normalises iMotion.xyz; a zero or non-finite normal there
    // is 0/0 and every vertex of the quad gets a NaN gl_Position.
    const motion = attribute(layer, 'iMotion');
    for (let i = 0; i < normals.length; i++) {
      expect([motion[i * 4], motion[i * 4 + 1], motion[i * 4 + 2]]).toEqual([0, 1, 0]);
    }
  });

  it('is always surface-mode, decal-styled and never eroded', () => {
    const layer = makeLayer();
    layer.emit(createDecalParams());
    layer.prepare();

    const shade = attribute(layer, 'iShade');
    const params = attribute(layer, 'iParams');
    expect(shade[2]).toBe(SpriteMode.Surface);
    expect(shade[3]).toBe(1);
    // Cracks darken, never add, and must never dissolve.
    expect(params[2]).toBe(0);
    expect(params[3]).toBe(0);
  });

  it('fades a timed decal out and then stops costing anything', () => {
    const layer = makeLayer();
    const p = createDecalParams();
    p.lifetime = 0.5;
    p.alpha = 1;
    layer.emit(p);

    layer.update(0.25);
    layer.prepare();
    expect(attribute(layer, 'iColor')[3]).toBeCloseTo(0.5, 5);

    layer.update(0.3);
    layer.prepare();
    expect(attribute(layer, 'iColor')[3]).toBe(0);

    const settled = versions(layer);
    for (let i = 0; i < 20; i++) {
      layer.update(1 / 60);
      layer.prepare();
    }
    // `timedCount` is back to zero, so ageing is a single early-out again.
    expect(versions(layer)).toEqual(settled);
  });

  it('never fades a permanent decal, however long the encounter runs', () => {
    const layer = makeLayer();
    const p = createDecalParams();
    p.alpha = 1;
    p.lifetime = 0;
    layer.emit(p);
    // A timed neighbour, so `update` really walks the buffer for a while.
    p.lifetime = 0.5;
    layer.emit(p);

    for (let i = 0; i < 600; i++) layer.update(1 / 60);
    layer.prepare();
    expect(attribute(layer, 'iColor')[3]).toBe(1);
    expect(attribute(layer, 'iColor')[7]).toBe(0);
  });

  it('clears back to an empty buffer', () => {
    const layer = makeLayer();
    const p = createDecalParams();
    for (let i = 0; i < 5; i++) {
      p.x = i;
      layer.emit(p);
    }
    layer.prepare();
    layer.clear();

    expect(layer.activeCount).toBe(0);
    expect((layer.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);

    p.x = 77;
    layer.emit(p);
    layer.prepare();
    expect(layer.activeCount).toBe(1);
    expect(attribute(layer, 'iPosSize')[0]).toBe(77);
  });
});
