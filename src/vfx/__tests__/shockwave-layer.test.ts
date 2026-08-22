/**
 * The shockwave layer: shell identity across compaction.
 *
 * The layer swap-removes dead shells, so a shell's SLOT is not its identity.
 * The dust front rides one specific shell for the whole of its life and asks
 * the layer where that shell's leading edge is on every frame — if the handle
 * it holds can be silently transferred to another shell, or silently killed by
 * an unrelated shell expiring, the dust wall stops early or forms around the
 * wrong punch.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vfxProfileFor } from '../constants';
import { createArcGridGeometry } from '../geometry';
import { ShockwaveLayer, createShockwaveParams } from '../shockwave-layer';

function makeLayer(): ShockwaveLayer {
  const profile = vfxProfileFor('medium');
  return new ShockwaveLayer(
    createArcGridGeometry(profile.shockwaveArcSegments, profile.shockwaveRadialSegments),
    new THREE.MeshBasicMaterial(),
    profile
  );
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
});
