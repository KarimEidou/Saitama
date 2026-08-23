/**
 * The shockwave layer: shell identity across compaction, the expansion curve,
 * and the CPU sample that the dust front rides.
 *
 * The layer swap-removes dead shells, so a shell's SLOT is not its identity.
 * The dust front rides one specific shell for the whole of its life and asks
 * the layer where that shell's leading edge is on every frame — if the handle
 * it holds can be silently transferred to another shell, or silently killed by
 * an unrelated shell expiring, the dust wall stops early or forms around the
 * wrong punch.
 *
 * The expansion curve carries two numeric promises the class header makes in
 * prose — born at a tenth of the range, and front-loaded by `t^0.42` — and
 * `sampleFront` makes a third: that it and `SHOCKWAVE_VERTEX` derive from one
 * formula. A tuning edit to `radiusAt` or a sign slip in the arc frame would
 * otherwise ship in silence.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vfxProfileFor } from '../constants';
import { createArcGridGeometry } from '../geometry';
import { ShockwaveLayer, createShockwaveParams } from '../shockwave-layer';

function makeLayer(tier: 'low' | 'medium' = 'medium'): ShockwaveLayer {
  const profile = vfxProfileFor(tier);
  return new ShockwaveLayer(
    createArcGridGeometry(profile.shockwaveArcSegments, profile.shockwaveRadialSegments),
    new THREE.MeshBasicMaterial(),
    profile
  );
}

/** The angle about world +Y of a point relative to an origin, in radians. */
function azimuthOf(point: THREE.Vector3, ox: number, oz: number): number {
  return Math.atan2(point.x - ox, point.z - oz);
}

describe('ShockwaveLayer', () => {
  it('keeps a handle valid when an earlier shell is compacted away', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();

    p.life = 1;
    p.x = 10;
    const cone = layer.emit(p);
    const coneGeneration = layer.generationOf(cone);
    p.life = 3;
    p.x = 20;
    const skirt = layer.emit(p);
    const skirtGeneration = layer.generationOf(skirt);

    // The cone dies first and the skirt is swapped down into its slot.
    layer.update(1.5);
    expect(layer.activeCount).toBe(1);
    expect(layer.isAlive(cone, coneGeneration)).toBe(false);

    // The skirt is the one the dust front is riding: it must still resolve,
    // and it must resolve to the geometry it was emitted with.
    expect(layer.isAlive(skirt, skirtGeneration)).toBe(true);
    const moved = layer.indexOf(skirt, skirtGeneration);
    expect(moved).toBe(0);
    expect(layer.originX(moved)).toBe(20);
  });

  it('never lets a stale handle match the shell that reused its slot', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();

    p.life = 1;
    const first = layer.emit(p);
    const firstGeneration = layer.generationOf(first);
    layer.update(1.5);
    expect(layer.activeCount).toBe(0);

    p.life = 3;
    const second = layer.emit(p);
    expect(second).toBe(first);
    expect(layer.isAlive(first, firstGeneration)).toBe(false);
    expect(layer.isAlive(second, layer.generationOf(second))).toBe(true);
  });

  it('does not confuse two punches whose shells interleave', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();

    // Punch A: three short-lived shells at x = 0.
    p.x = 0;
    for (const life of [0.5, 0.7, 0.4]) {
      p.life = life;
      layer.emit(p);
    }
    // Punch B: three long-lived shells at x = 100. B rides its ground skirt.
    p.x = 100;
    p.life = 5;
    layer.emit(p);
    p.life = 6;
    const bSkirt = layer.emit(p);
    const bGeneration = layer.generationOf(bSkirt);
    p.life = 4;
    layer.emit(p);

    // Every shell of A expires; B's shells are shuffled down into their slots.
    layer.update(1);
    expect(layer.activeCount).toBe(3);
    const resolved = layer.indexOf(bSkirt, bGeneration);
    expect(resolved).toBeGreaterThanOrEqual(0);
    expect(layer.originX(resolved)).toBe(100);
  });

  it('forgets every handle after a clear', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();
    p.life = 3;
    const shell = layer.emit(p);
    const generation = layer.generationOf(shell);
    layer.clear();
    expect(layer.isAlive(shell, generation)).toBe(false);
    expect(layer.indexOf(shell, generation)).toBe(-1);
  });

  it('is born already a tenth of the way out, not as a dot', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();
    p.range = 100;
    p.life = 1;
    p.start = 0.1;
    layer.emit(p);
    // START = 0.10: a wave that begins at zero radius is invisible for exactly
    // the frames the 90 ms impact freeze holds on screen.
    expect(layer.radiusOf(0)).toBeCloseTo(10, 6);
  });

  it('front-loads the expansion: over half the distance in the first fifth', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();
    p.range = 100;
    p.life = 1;
    p.start = 0.1;
    layer.emit(p);
    layer.update(0.2);
    // 100 * (0.1 + 0.9 * 0.2^0.42).
    expect(layer.radiusOf(0)).toBeCloseTo(55.7799, 3);
    expect((layer.radiusOf(0) - 10) / 90).toBeGreaterThan(0.5);
  });

  it('normalises the direction at the door and anchors the shader radius', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();
    p.dx = 0;
    p.dy = 0;
    p.dz = 5;
    p.halfAngle = 0.4;
    p.range = 100;
    p.start = 0.1;
    const index = layer.emit(p);
    layer.prepare();

    const axis = layer.mesh.geometry.getAttribute('iAxis').array as Float32Array;
    const origin = layer.mesh.geometry.getAttribute('iOrigin').array as Float32Array;
    expect([axis[0], axis[1], axis[2]]).toEqual([0, 0, 1]);
    // iAxis.w is the radius the vertex shader expands to; it must be the same
    // number `sampleFront` and the dust front are using on the CPU.
    expect(axis[3]).toBeCloseTo(layer.radiusOf(index), 5);
    expect(origin[3]).toBeCloseTo(0.4, 6);
  });

  it('samples a ground skirt on the arc the shader draws', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();
    p.x = 10;
    p.y = 2;
    p.z = -5;
    p.dx = 0;
    p.dy = 0;
    p.dz = 1;
    p.kind = 0;
    p.halfAngle = 0.4;
    p.range = 100;
    p.start = 0.1;
    layer.emit(p);
    const radius = layer.radiusOf(0);
    const out = new THREE.Vector3();

    // The mid-arc sample lies exactly along the propagation direction.
    layer.sampleFront(0, 0.5, out);
    expect(out.x).toBeCloseTo(10, 6);
    expect(out.y).toBeCloseTo(2, 6);
    expect(out.z).toBeCloseTo(-5 + radius, 5);

    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      layer.sampleFront(0, u, out);
      // The skirt is flat; the dust front adds its own height on top of this.
      expect(out.y).toBe(2);
      expect(Math.hypot(out.x - 10, out.z - -5)).toBeCloseTo(radius, 5);
    }

    const mid = azimuthOf(layer.sampleFront(0, 0.5, out), 10, -5);
    const left = azimuthOf(layer.sampleFront(0, 0, out), 10, -5);
    const right = azimuthOf(layer.sampleFront(0, 1, out), 10, -5);
    expect(mid - left).toBeCloseTo(0.4, 6);
    expect(right - mid).toBeCloseTo(0.4, 6);
  });

  it('samples an axial cone on the shader-clamped cone surface', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();
    p.dx = 0;
    p.dy = 1;
    p.dz = 0;
    p.kind = 1;
    p.halfAngle = 0.5;
    p.range = 100;
    p.start = 0.1;
    layer.emit(p);
    const radius = layer.radiusOf(0);
    const out = new THREE.Vector3();

    for (const u of [0, 0.2, 0.5, 0.75]) {
      layer.sampleFront(0, u, out);
      // Along the axis: exactly the radius. Across it: the cone's rho.
      expect(out.y).toBeCloseTo(radius, 5);
      expect(Math.hypot(out.x, out.z)).toBeCloseTo(radius * Math.tan(0.5), 5);
    }

    // A 180-degree half-angle is clamped to 1.35 rad, exactly as
    // SHOCKWAVE_VERTEX clamps it — otherwise `tan` runs away to infinity.
    const wide = makeLayer();
    p.halfAngle = Math.PI;
    wide.emit(p);
    wide.sampleFront(0, 0.3, out);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(radius * Math.tan(1.35), 4);
  });

  it('centres a near-vertical skirt on +Z, exactly as the vertex shader does', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();
    p.x = 0;
    p.y = 0;
    p.z = 0;
    // Flat length ~7.1e-5, under the shader's 1e-4 fallback threshold.
    p.dx = 5e-5;
    p.dy = 1;
    p.dz = 5e-5;
    p.kind = 0;
    p.halfAngle = 0.4;
    p.range = 100;
    p.start = 0.1;
    p.life = 1;
    const index = layer.emit(p);
    const out = layer.sampleFront(index, 0.5, new THREE.Vector3());
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.z).toBeCloseTo(layer.radiusOf(index), 6);
  });

  it('refuses to overflow its capacity', () => {
    const layer = makeLayer('low');
    expect(layer.capacity).toBe(4);
    const p = createShockwaveParams();
    p.life = 5;
    expect([layer.emit(p), layer.emit(p), layer.emit(p), layer.emit(p)]).toEqual([0, 1, 2, 3]);
    expect(layer.emit(p)).toBe(-1);
    expect(layer.activeCount).toBe(4);
  });

  it('retires exactly the shells whose life has run out', () => {
    const layer = makeLayer();
    const p = createShockwaveParams();
    p.life = 0.5;
    layer.emit(p);
    p.life = 2;
    p.x = 42;
    layer.emit(p);

    layer.update(1);
    expect(layer.activeCount).toBe(1);
    expect(layer.originX(0)).toBe(42);

    const before = layer.progressOf(0);
    layer.update(0);
    layer.update(-1);
    expect(layer.activeCount).toBe(1);
    expect(layer.progressOf(0)).toBe(before);
  });

  it('answers out-of-range slots with sentinels rather than throwing', () => {
    const layer = makeLayer();
    expect(layer.radiusOf(-1)).toBe(0);
    expect(layer.progressOf(99)).toBe(1);
    expect(layer.originX(5)).toBe(0);
    expect(layer.originY(5)).toBe(0);
    expect(layer.originZ(5)).toBe(0);
    expect(layer.sampleFront(-1, 0.5, new THREE.Vector3()).toArray()).toEqual([0, 0, 0]);
  });
});
