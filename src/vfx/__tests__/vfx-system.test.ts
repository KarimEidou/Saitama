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
    // Attenuated from the CAMERA — 61 m from the impact against a 136 m
    // falloff, so about a third of the raw trauma. This read 0.9 before the
    // shake listener was wired up, because an unsynced listener sits at the
    // world origin, which in this fixture is exactly where the punch lands.
    expect(d.trauma).toBeGreaterThan(0.25);
    vfx.dispose();
  });

  it('matches the shell arc to the combat cone rather than approximating it', () => {
    const { vfx, bus } = makeSystem();
    fireShockwave(bus, { angle: 0.384 });
    vfx.update(1 / 60);
    const axis = (vfx.meshes[1]!.geometry.getAttribute('iOrigin').array as Float32Array).slice(
      0,
      4
    );
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

  it('keeps the dust front alive after the leading cone expires', () => {
    // The three shells have different lives, and the one the dust front rides
    // is the LONGEST. When the axial cone dies the layer compacts and the skirt
    // moves to another slot — a handle that cannot survive that move silently
    // ends the dust wall a fifth of the way from the end of its life, on every
    // single punch.
    const { vfx, bus } = makeSystem();
    fireShockwave(bus);
    // t = 0.55 s: the cone (life 0.52 s) is gone, the skirt (0.65 s) is not.
    for (let i = 0; i < 33; i++) vfx.update(1 / 60);
    expect(vfx.diagnostics().shockwaves).toBe(1);
    const midway = vfx.diagnostics().sprites;

    for (let i = 0; i < 5; i++) vfx.update(1 / 60);
    expect(vfx.diagnostics().shockwaves).toBe(1);
    expect(vfx.diagnostics().sprites).toBeGreaterThan(midway);
    vfx.dispose();
  });

  it('builds a real wave when a shockwave is spawned directly', () => {
    // `spawn` used to return a live handle for these three names and then draw
    // nothing at all, while holding a priority-1 slot that nothing can evict.
    const { vfx } = makeSystem();
    const handle = vfx.spawn('shockwaveCone', {
      position: new THREE.Vector3(),
      direction: new THREE.Vector3(0, 0, 1),
      scale: 60,
      intensity: 0.9,
      intent: 'serious',
    });
    vfx.update(1 / 60);
    expect(handle?.alive).toBe(true);
    const d = vfx.diagnostics();
    expect(d.shockwaves).toBe(3);
    expect(d.sprites).toBeGreaterThan(60);
    expect(d.decals).toBeGreaterThan(10);
    vfx.dispose();
  });

  it('tints an effect from the spawn colour', () => {
    const { vfx } = makeSystem();
    vfx.spawn('bloodSpray', {
      position: new THREE.Vector3(),
      color: 0x8b0000,
      intensity: 1,
    });
    vfx.update(1 / 60);
    const color = vfx.meshes[2]!.geometry.getAttribute('iColor').array as Float32Array;
    const n = vfx.diagnostics().sprites;
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      // Dark red: red only. The default spark colour is warm white and has
      // substantial green and blue in it.
      expect(color[i * 4]!).toBeGreaterThan(0);
      expect(color[i * 4 + 1]!).toBe(0);
      expect(color[i * 4 + 2]!).toBe(0);
    }
    vfx.dispose();
  });

  it('releases attached objects on clear', () => {
    // A slot that keeps its `attachTo` after a fast travel pins the whole
    // despawned subtree — meshes, geometries, materials, textures — for as long
    // as the system lives, and `dispose()` goes through `clear()` too.
    const { vfx } = makeSystem();
    const monster = new THREE.Object3D();
    vfx.spawn('punchImpact', { position: new THREE.Vector3(), attachTo: monster });
    vfx.clear();
    const slots = (vfx as unknown as { slots: { attach: THREE.Object3D | undefined }[] }).slots;
    expect(slots.some((slot) => slot.attach !== undefined)).toBe(false);
    vfx.dispose();
  });

  it('drops coalesced event bursts on an aborted encounter', () => {
    // The chunks arrive in the same frame the encounter is abandoned, and
    // `update()` flushes before anything else — so an accumulator that survives
    // `clear()` spawns a ghost debris burst at the abandoned coordinates on the
    // very next frame.
    const { vfx, bus } = makeSystem();
    for (let i = 0; i < 12; i++) {
      bus.emit('ChunkDetached', {
        structureId: 'tower',
        chunkIndex: i,
        position: { x: 300 + i, y: 20, z: -120 },
        mass: 400,
        impulse: { x: 2000, y: 6000, z: 0 },
        material: 'concrete',
        collateralCost: 10,
      } as never);
    }
    bus.emit('EncounterEnded', {
      encounterId: 'e1',
      outcome: 'aborted',
      duration: 12,
      civiliansLost: 0,
      collateralCost: 0,
    } as never);
    vfx.update(1 / 60);
    expect(vfx.activeCount).toBe(0);
    expect(vfx.diagnostics().sprites).toBe(0);
    vfx.dispose();
  });

  it('cracks a wall in the wall plane rather than in world XZ', () => {
    // The branch fan used to be laid out in world XZ whatever the normal was,
    // so half of a wall's branches floated in front of it and half were buried
    // inside it.
    const { vfx } = makeSystem();
    vfx.spawn('groundCrack', {
      position: new THREE.Vector3(20, 4, 0),
      direction: new THREE.Vector3(1, 0, 0),
      scale: 3,
    });
    vfx.update(1 / 60);
    const n = vfx.diagnostics().decals;
    expect(n).toBeGreaterThan(4);
    const positions = vfx.meshes[0]!.geometry.getAttribute('iPosSize').array as Float32Array;
    for (let i = 0; i < n; i++) {
      expect(Math.abs(positions[i * 4]! - 20), `decal ${i} left the wall`).toBeLessThan(1e-4);
    }
    vfx.dispose();
  });

  it('moves a trail without differencing the jump into velocity', () => {
    const { vfx } = makeSystem();
    const target = new THREE.Object3D();
    target.position.set(0, 5, 0);
    target.updateMatrixWorld(true);
    const handle = vfx.addTrail(target, 'dust', 5);
    for (let i = 0; i < 10; i++) {
      target.position.x += 0.5;
      target.updateMatrixWorld(true);
      vfx.update(1 / 60);
    }
    const before = vfx.diagnostics().sprites;

    // A teleport. Differenced, this is 60 km/s and lays a solid line of streaks
    // across the city — it filled the entire pool before `setPosition` was
    // implemented for trail handles.
    target.position.set(1000, 5, 0);
    target.updateMatrixWorld(true);
    handle?.setPosition(target.position);
    vfx.update(1 / 60);
    expect(vfx.diagnostics().sprites).toBeLessThan(before + 20);
    vfx.dispose();
  });

  it('attenuates shake from the camera, not from the world origin', () => {
    // Every shake in this system is distance-attenuated with a 40-80 m falloff
    // against a listener that only `update()` used to move. A fight anywhere
    // but the middle of the map produced no shake at all until the first frame
    // after the punch — and none ever, on a system whose camera arrived late.
    const far = new THREE.Vector3(1200, 0, -800);
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
    camera.position.set(1200, 2, -800);
    camera.updateMatrixWorld(true);

    const constructed = new VFXSystem({
      tier: 'medium',
      camera,
      seed: 'test',
      generateTextures: false,
    });
    constructed.spawn('punchImpact', { position: far, intensity: 1 });
    expect(constructed.shake.trauma).toBeGreaterThan(0.5);
    constructed.dispose();

    const late = new VFXSystem({ tier: 'medium', seed: 'test', generateTextures: false });
    late.setCamera(camera);
    late.spawn('punchImpact', { position: far, intensity: 1 });
    expect(late.shake.trauma).toBeGreaterThan(0.5);
    late.dispose();
  });

  it('reports decal eviction, which the return value cannot', () => {
    const { vfx } = makeSystem('low');
    const position = new THREE.Vector3();
    const normal = new THREE.Vector3(0, 1, 0);
    const capacity = vfx.diagnostics().decalCapacity;
    for (let i = 0; i < capacity; i++) {
      position.set(i, 0, 0);
      vfx.addDecal({ position, normal, size: 2, materialKey: 'crack' });
    }
    expect(vfx.diagnostics().decalsRecycled).toBe(0);
    for (let i = 0; i < 10; i++) {
      position.set(i, 0, 5);
      // Still true — recycling the oldest crack IS the contract.
      expect(vfx.addDecal({ position, normal, size: 2, materialKey: 'crack' })).toBe(true);
    }
    expect(vfx.diagnostics().decalsRecycled).toBe(10);
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
      expect(vfx.diagnostics().shockwaves).toBeLessThanOrEqual(vfx.diagnostics().shockwaveCapacity);
    }
    vfx.dispose();
  });

  it('holds the frame during an impact freeze instead of running through it', () => {
    // The renderer drops the clock to 4% for 90 ms. Fed the scaled delta, an
    // effect should barely advance — that hang IS the beat.
    const { vfx, bus } = makeSystem();
    fireShockwave(bus);
    vfx.update(1 / 60);
    const radius = () => (vfx.meshes[1]!.geometry.getAttribute('iAxis').array as Float32Array)[3]!;
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
