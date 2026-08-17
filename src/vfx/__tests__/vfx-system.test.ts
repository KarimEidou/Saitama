/**
 * The VFX system: event reactions, the effect budget, persistent decals,
 * handle lifetimes and determinism.
 *
 * Textures are skipped here — generating two 512px atlases per test would
 * dominate the run and none of these assertions look at a texel.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEventBus } from '@/util';
import type { IEventBus } from '@/types';
import { VFXSystem } from '../vfx-system';

function makeSystem(tier: 'low' | 'medium' | 'high' = 'medium'): {
  vfx: VFXSystem;
  bus: IEventBus;
  camera: THREE.PerspectiveCamera;
} {
  const bus = createEventBus();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  camera.position.set(0, 12, 60);
  camera.lookAt(0, 2, 0);
  camera.updateMatrixWorld(true);
  const vfx = new VFXSystem({ tier, bus, camera, seed: 'test', generateTextures: false });
  return { vfx, bus, camera };
}

const ORIGIN = { x: 0, y: 0, z: 0 };

function fireShockwave(bus: IEventBus, overrides: Partial<Record<string, unknown>> = {}): void {
  bus.emit('ShockwaveFired', {
    origin: ORIGIN,
    direction: { x: 0, y: 0, z: 1 },
    power: 5e5,
    range: 160,
    angle: 0.384,
    intent: 'serious',
    punchKind: 'normal',
    ...overrides,
  } as never);
}

describe('VFXSystem', () => {
  it('submits exactly four meshes — the whole suite', () => {
    const { vfx } = makeSystem();
    expect(vfx.meshes).toHaveLength(4);
    expect(vfx.root.children).toHaveLength(4);
    vfx.dispose();
  });

  it('reports the tier capacity from the quality contract', () => {
    expect(makeSystem('low').vfx.capacity).toBe(4);
    expect(makeSystem('medium').vfx.capacity).toBe(8);
    expect(makeSystem('high').vfx.capacity).toBe(16);
  });

  it('turns one ShockwaveFired into shells, dust, cracks and speedlines', () => {
    const { vfx, bus } = makeSystem();
    fireShockwave(bus);
    vfx.update(1 / 60);
    const d = vfx.diagnostics();
    expect(d.effects).toBe(1);
    // Three shells: axial cone, ground skirt, trailing skirt.
    expect(d.shockwaves).toBe(3);
    expect(d.sprites).toBeGreaterThan(60);
    expect(d.decals).toBeGreaterThan(10);
    expect(d.speedlineIntensity).toBeGreaterThan(0.3);
    expect(d.trauma).toBeGreaterThan(0.3);
    vfx.dispose();
  });

  it('matches the shell arc to the combat cone rather than approximating it', () => {
    const { vfx, bus } = makeSystem();
    fireShockwave(bus, { angle: 0.384 });
    vfx.update(1 / 60);
    const axis = (
      vfx.meshes[1]!.geometry.getAttribute('iOrigin').array as Float32Array
    ).slice(0, 4);
    expect(axis[3]).toBeCloseTo(0.384, 5);
    vfx.dispose();
  });

  it('keeps growing the dust front while the shell lives', () => {
    const { vfx, bus } = makeSystem();
    fireShockwave(bus);
    vfx.update(1 / 60);
    const first = vfx.diagnostics().sprites;
    for (let i = 0; i < 10; i++) vfx.update(1 / 60);
    expect(vfx.diagnostics().sprites).toBeGreaterThan(first);
    vfx.dispose();
  });

  it('parts the clouds only for a genuine serious punch', () => {
    const restrained = makeSystem();
    fireShockwave(restrained.bus, { intent: 'restrained', power: 30 });
    restrained.vfx.update(1 / 60);
    const quiet = restrained.vfx.diagnostics().sprites;

    const serious = makeSystem();
    fireShockwave(serious.bus, { intent: 'full', power: 1e6 });
    serious.vfx.update(1 / 60);
    expect(serious.vfx.diagnostics().sprites).toBeGreaterThan(quiet * 2);
  });

  it('never parts the clouds on the LOW tier', () => {
    const { vfx } = makeSystem('low');
    expect(vfx.profile.cloudParting).toBe(false);
    vfx.dispose();
  });

  it('drops the lowest-priority effect when the budget is full', () => {
    const { vfx, bus } = makeSystem('low');
    // Four ambient dust requests fill the LOW tier's four slots.
    for (let i = 0; i < 4; i++) {
      bus.emit('ImpulseApplied', {
        targetId: i as never,
        impulse: { x: 0, y: 3e4, z: 0 },
        point: { x: i * 5, y: 0, z: 0 },
      } as never);
      vfx.update(1 / 60);
    }
    expect(vfx.activeCount).toBe(4);
    // A shockwave outranks all of them and must get in.
    fireShockwave(bus);
    vfx.update(1 / 60);
    expect(vfx.diagnostics().shockwaves).toBeGreaterThan(0);
    vfx.dispose();
  });

  it('refuses a low-priority request when everything live outranks it', () => {
    const { vfx } = makeSystem('low');
    const position = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      expect(vfx.spawn('shockwaveRing', { position, priority: 1 })).toBeDefined();
    }
    expect(vfx.spawn('dustCloud', { position, priority: 0.2 })).toBeUndefined();
    vfx.dispose();
  });

  it('coalesces a burst of ChunkDetached into one effect', () => {
    const { vfx, bus } = makeSystem();
    for (let i = 0; i < 40; i++) {
      bus.emit('ChunkDetached', {
        structureId: 'tower',
        chunkIndex: i,
        position: { x: i * 0.5, y: 20, z: 0 },
        mass: 400,
        impulse: { x: 2000, y: 6000, z: 0 },
        material: 'concrete',
        collateralCost: 10,
      } as never);
    }
    vfx.update(1 / 60);
    expect(vfx.activeCount).toBe(1);
    // Every piece still gets its own streak, up to the trail budget.
    expect(vfx.diagnostics().trails).toBe(vfx.diagnostics().trailCapacity);
    vfx.dispose();
  });

  it('lays trail streaks behind flying chunks', () => {
    const { vfx, bus } = makeSystem();
    bus.emit('ChunkDetached', {
      structureId: 'tower',
      chunkIndex: 0,
      position: { x: 0, y: 30, z: 0 },
      mass: 500,
      impulse: { x: 15000, y: 9000, z: 0 },
      material: 'concrete',
      collateralCost: 4,
    } as never);
    vfx.update(1 / 60);
    const start = vfx.diagnostics().sprites;
    for (let i = 0; i < 8; i++) vfx.update(1 / 60);
    expect(vfx.diagnostics().sprites).toBeGreaterThan(start);
    vfx.dispose();
  });

  it('craters the ground on a hard landing and leaves the damage there', () => {
    const { vfx, bus } = makeSystem();
    bus.emit('PlayerLanded', {
      position: { x: 5, y: 0, z: 5 },
      impactSpeed: 48,
      fallHeight: 120,
      createsCrater: true,
      intent: 'serious',
    } as never);
    vfx.update(1 / 60);
    const decals = vfx.diagnostics().decals;
    expect(decals).toBeGreaterThan(5);
    // Ten seconds later the cracks are still there. That is the point.
    for (let i = 0; i < 600; i++) vfx.update(1 / 60);
    expect(vfx.diagnostics().decals).toBe(decals);
    vfx.dispose();
  });

  it('recycles the oldest decal rather than refusing the newest', () => {
    const { vfx } = makeSystem('low');
    const position = new THREE.Vector3();
    const normal = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 200; i++) {
      position.set(i, 0, 0);
      expect(vfx.addDecal({ position, normal, size: 2, materialKey: 'crack' })).toBe(true);
    }
    expect(vfx.diagnostics().decals).toBe(vfx.diagnostics().decalCapacity);
    vfx.dispose();
  });

  it('invalidates a handle once its slot is reused', () => {
    const { vfx } = makeSystem('low');
    const position = new THREE.Vector3();
    const handle = vfx.spawn('dustCloud', { position, lifetime: 0.1 });
    expect(handle?.alive).toBe(true);
    vfx.update(0.5);
    expect(handle?.alive).toBe(false);
    // The slot is reused; the stale handle must still report dead.
    vfx.spawn('dustCloud', { position });
    expect(handle?.alive).toBe(false);
    vfx.dispose();
  });

  it('kills an effect on demand', () => {
    const { vfx } = makeSystem();
    const handle = vfx.spawn('shockwaveRing', { position: new THREE.Vector3() });
    handle?.kill();
    expect(handle?.alive).toBe(false);
    expect(vfx.activeCount).toBe(0);
    vfx.dispose();
  });

  it('follows an attached object', () => {
    const { vfx } = makeSystem();
    const target = new THREE.Object3D();
    target.position.set(10, 0, 0);
    target.updateMatrixWorld(true);
    const handle = vfx.addTrail(target, 'dust', 4);
    expect(handle).toBeDefined();
    for (let i = 0; i < 20; i++) {
      target.position.x += 1.5;
      target.updateMatrixWorld(true);
      vfx.update(1 / 60);
    }
    expect(vfx.diagnostics().sprites).toBeGreaterThan(0);
    vfx.dispose();
  });

  it('wipes everything on an aborted encounter but not on a victory', () => {
    const { vfx, bus } = makeSystem();
    fireShockwave(bus);
    vfx.update(1 / 60);
    expect(vfx.diagnostics().sprites).toBeGreaterThan(0);

    bus.emit('EncounterEnded', {
      encounterId: 'e1',
      outcome: 'victory',
      duration: 12,
      civiliansLost: 0,
      collateralCost: 0,
    } as never);
    vfx.update(1 / 60);
    expect(vfx.diagnostics().sprites).toBeGreaterThan(0);

    bus.emit('EncounterEnded', {
      encounterId: 'e1',
      outcome: 'aborted',
      duration: 12,
      civiliansLost: 0,
      collateralCost: 0,
    } as never);
    vfx.update(1 / 60);
    expect(vfx.diagnostics().sprites).toBe(0);
    expect(vfx.diagnostics().decals).toBe(0);
    vfx.dispose();
  });

  it('replays identically from the same seed and event sequence', () => {
    const run = (): number => {
      const { vfx, bus } = makeSystem();
      fireShockwave(bus);
      bus.emit('PlayerLanded', {
        position: { x: 3, y: 0, z: -2 },
        impactSpeed: 40,
        fallHeight: 90,
        createsCrater: true,
        intent: 'full',
      } as never);
      for (let i = 0; i < 40; i++) vfx.update(1 / 60);
      const checksum = vfx.checksum();
      vfx.dispose();
      return checksum;
    };
    expect(run()).toBe(run());
  });

  it('diverges when the seed changes', () => {
    const run = (seed: string): number => {
      const bus = createEventBus();
      const vfx = new VFXSystem({ tier: 'medium', bus, seed, generateTextures: false });
      fireShockwave(bus);
      for (let i = 0; i < 30; i++) vfx.update(1 / 60);
      const checksum = vfx.checksum();
      vfx.dispose();
      return checksum;
    };
    expect(run('a')).not.toBe(run('b'));
  });

  it('never exceeds the sprite capacity, however hard it is pushed', () => {
    const { vfx, bus } = makeSystem('low');
    for (let frame = 0; frame < 120; frame++) {
      fireShockwave(bus, { power: 1e6, intent: 'full' });
      vfx.update(1 / 60);
      expect(vfx.diagnostics().sprites).toBeLessThanOrEqual(vfx.diagnostics().spriteCapacity);
      expect(vfx.diagnostics().shockwaves).toBeLessThanOrEqual(
        vfx.diagnostics().shockwaveCapacity
      );
    }
    vfx.dispose();
  });

  it('holds the frame during an impact freeze instead of running through it', () => {
    // The renderer drops the clock to 4% for 90 ms. Fed the scaled delta, an
    // effect should barely advance — that hang IS the beat.
    const { vfx, bus } = makeSystem();
    fireShockwave(bus);
    vfx.update(1 / 60);
    const radius = () =>
      (vfx.meshes[1]!.geometry.getAttribute('iAxis').array as Float32Array)[3]!;
    const before = radius();
    // 90 ms of real time at timeScale 0.04.
    for (let i = 0; i < 6; i++) vfx.update((0.09 / 6) * 0.04);
    const during = radius();
    expect(during - before).toBeLessThan(before * 0.35);
    // ...and it must be a real, formed wave already, not a dot.
    expect(before).toBeGreaterThan(10);
    vfx.dispose();
  });
});
