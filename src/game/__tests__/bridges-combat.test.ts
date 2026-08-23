/**
 * THE AIM-POINT BRIDGE, AND THE ONE FIELD IT DELIBERATELY DOES NOT PUBLISH
 *
 * `bridges.ts`'s header states the failure this file exists to prevent: reading
 * `monster.brain.position` instead of `describeForCombat()` "type-checks
 * perfectly and produces a game where nothing can be hit", because combat
 * resolves a punch against a sphere centred on the registered point and a
 * monster's canonical position is at its FEET. The registration path and
 * `auditAimPoints`, the once-a-second guard against it, are pinned here.
 *
 * The second claim is subtler and is the reason a test rather than a comment
 * has to hold it: `sync()` republishes POSITION every frame and health NEVER.
 * Combat is authoritative on damage and death (`monster-system.ts` listens to
 * `EntityDamaged`/`EntityKilled` and a brain never decides it has died), so a
 * descriptor's `health` is combat's own number arriving back a frame late.
 * Writing it into the registry would be a stale poll overwriting the authority
 * — and the change is invisible: nothing type-checks differently and the
 * symptom is a monster that occasionally un-dies. `never republishes health`
 * below is what stops the class header being "fixed" by making the code match
 * a wrong sentence.
 *
 * The REAL `TargetRegistry` is used behind a stub `CombatSystem`, because the
 * `Infinity → 0` normalisation and the removal sweep are only meaningful
 * against the real add/remove/setPosition semantics. No renderer, no bus.
 */

import { describe, expect, it } from 'vitest';
import { StructureIndex, TargetRegistry, type CombatSystem } from '@/gameplay/combat';
import type { DestructionSystem } from '@/gameplay/destruction';
import type { MonsterSystem, IMonsterCombatDescriptor } from '@/entities/monster';
import { CombatTargetBridge, StructureBridge, auditAimPoints } from '../bridges';

/** Body height of the stub archetype. The lift is half of it. */
const HEIGHT = 3;

function descriptor(id: string, x: number, z: number, health = 100): IMonsterCombatDescriptor {
  return {
    id,
    type: 'monster',
    faction: 'monster',
    // The AIM POINT: feet plus half a body, exactly as `describeForCombat` does.
    position: { x, y: HEIGHT * 0.5, z },
    radius: HEIGHT * 0.42,
    massKg: 400,
    maxHealth: 100,
    health,
    displayName: 'test',
    threatTier: 'tiger',
    specId: 'mob.test',
    isBoss: false,
    phaseResolved: false,
    rewardPoints: 1,
  } as IMonsterCombatDescriptor;
}

/** Feet live where the descriptor says the torso is, minus half a body. */
function stubMonsters(list: () => IMonsterCombatDescriptor[]): MonsterSystem {
  return {
    describeForCombat: () => list(),
    get: (id: string) => {
      const d = list().find((entry) => entry.id === id);
      if (d === undefined) return undefined;
      return {
        brain: { position: { x: d.position.x, y: d.position.y - HEIGHT * 0.5, z: d.position.z } },
        archetype: { bodyHeightMetres: HEIGHT },
      };
    },
  } as unknown as MonsterSystem;
}

function stubCombat(): { combat: CombatSystem; registry: TargetRegistry } {
  const registry = new TargetRegistry();
  return {
    registry,
    combat: {
      addTarget: (spec: Parameters<TargetRegistry['add']>[0]) => registry.add(spec),
      targets: registry,
    } as unknown as CombatSystem,
  };
}

describe('CombatTargetBridge', () => {
  it('registers at the torso, not the feet', () => {
    const list = [descriptor('m1', 4, 7)];
    const { combat, registry } = stubCombat();
    const bridge = new CombatTargetBridge(
      stubMonsters(() => list),
      combat
    );

    bridge.sync();

    expect(bridge.report.registered).toBe(1);
    expect(bridge.report.updated).toBe(0);
    expect(bridge.report.removed).toBe(0);
    expect(bridge.report.minAimLift).toBeCloseTo(HEIGHT * 0.5, 6);
    expect(bridge.report.minRadius).toBe(HEIGHT * 0.42);

    const target = registry.get('m1');
    expect(target).toBeDefined();
    expect(target!.position.y).toBe(HEIGHT * 0.5);
    expect(target!.radius).toBe(HEIGHT * 0.42);
    expect(
      auditAimPoints(
        stubMonsters(() => list),
        combat
      )
    ).toEqual([]);
  });

  it('moves an existing target instead of re-adding it', () => {
    const entry = descriptor('m1', 0, 0);
    const list = [entry];
    const { combat, registry } = stubCombat();
    const bridge = new CombatTargetBridge(
      stubMonsters(() => list),
      combat
    );
    bridge.sync();

    (entry as { position: { x: number; y: number; z: number } }).position = {
      x: 12,
      y: HEIGHT * 0.5,
      z: -5,
    };
    bridge.sync();

    expect(bridge.report.registered).toBe(0);
    expect(bridge.report.updated).toBe(1);
    expect(registry.size).toBe(1);
    expect(registry.get('m1')!.position).toEqual({ x: 12, y: HEIGHT * 0.5, z: -5 });
  });

  it('never republishes health, because combat owns it', () => {
    const entry = descriptor('m1', 0, 0);
    const list = [entry];
    const { combat, registry } = stubCombat();
    const bridge = new CombatTargetBridge(
      stubMonsters(() => list),
      combat
    );
    bridge.sync();

    // Combat's own resolver is what writes health; this is the descriptor
    // trailing it by a frame. Publishing it back would undo whatever combat
    // has since decided — up to and including a death.
    (entry as { health: number }).health = 5;
    bridge.sync();

    expect(registry.get('m1')!.health).toBe(100);
  });

  it('removes a monster that stopped being described', () => {
    let list = [descriptor('m1', 0, 0)];
    const { combat, registry } = stubCombat();
    const bridge = new CombatTargetBridge(
      stubMonsters(() => list),
      combat
    );
    bridge.sync();

    list = [];
    bridge.sync();

    expect(bridge.report.removed).toBe(1);
    expect(registry.get('m1')).toBeUndefined();
  });

  it('reports zero, not Infinity, for a sync with nothing in it', () => {
    const { combat } = stubCombat();
    const bridge = new CombatTargetBridge(
      stubMonsters(() => []),
      combat
    );

    bridge.sync();

    // The HUD and the harness read these as metres. `Infinity` is the scratch
    // value the minimum starts at and must never escape the method.
    expect(bridge.report.minAimLift).toBe(0);
    expect(bridge.report.minRadius).toBe(0);
    expect(bridge.report.registered).toBe(0);
  });

  it('clears the registry and re-registers on the next sync', () => {
    const list = [descriptor('m1', 3, 3)];
    const { combat, registry } = stubCombat();
    const bridge = new CombatTargetBridge(
      stubMonsters(() => list),
      combat
    );
    bridge.sync();

    bridge.clear();
    expect(registry.get('m1')).toBeUndefined();

    // `clear()` has to forget its own bookkeeping too, or the monster is gone
    // from combat and the bridge still believes it is registered — a target
    // that can never be hit again and never removed.
    bridge.sync();
    expect(bridge.report.registered).toBe(1);
    expect(registry.get('m1')).toBeDefined();
  });
});

describe('auditAimPoints', () => {
  it('names a target registered at feet height', () => {
    const list = [descriptor('m1', 2, 2)];
    const { combat, registry } = stubCombat();
    // Registered WITHOUT the bridge, at the monster's own coordinates: the
    // exact bug the bridge's header describes, and the only symptom is that
    // punches thrown at chest height pass through it.
    registry.add({
      id: 'm1',
      type: 'monster',
      faction: 'monster',
      position: { x: 2, y: 0, z: 2 },
      radius: HEIGHT * 0.42,
    });

    const bad = auditAimPoints(
      stubMonsters(() => list),
      combat
    );

    expect(bad).toHaveLength(1);
    expect(bad[0]!.id).toBe('m1');
    expect(bad[0]!.lift).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Structures -> combat                                                       */
/* -------------------------------------------------------------------------- */

/**
 * THE INDEX NOTHING WAS FILLING.
 *
 * `CombatSystem.addStructure()` had no caller anywhere in `src/`, so combat's
 * `StructureIndex` was permanently empty while `DestructionSystem` held every
 * resident building — and `chargeForecast()`, which is the charge ring's
 * property-damage price tag, therefore returned ¥0 for every punch in a game
 * whose whole tension is the player weighing that number.
 *
 * A stub `DestructionSystem` (the real one wants meshes and a bus) exposing the
 * two fields the bridge reads, and the REAL `StructureIndex`, because the
 * add/remove semantics are the thing under test.
 */
function stubDestruction(
  list: () => {
    id: string;
    worldBounds: Float64Array;
    layout: { totalMass: number };
    originX: number;
    originZ: number;
  }[]
): DestructionSystem {
  return {
    get orderedStructures() {
      return list();
    },
  } as unknown as DestructionSystem;
}

function structure(id: string, x: number, z: number, mass: number) {
  return {
    id,
    worldBounds: Float64Array.from([x - 8, 0, z - 8, x + 8, 24, z + 8]),
    layout: { totalMass: mass },
    originX: x,
    originZ: z,
  };
}

describe('StructureBridge', () => {
  function harness(): {
    index: StructureIndex;
    combat: CombatSystem;
    live: ReturnType<typeof structure>[];
    bridge: StructureBridge;
  } {
    const index = new StructureIndex();
    const combat = {
      addStructure: (spec: Parameters<StructureIndex['add']>[0]) => index.add(spec),
      structures: index,
    } as unknown as CombatSystem;
    const live: ReturnType<typeof structure>[] = [];
    const bridge = new StructureBridge(
      stubDestruction(() => live),
      combat,
      () => 'downtown'
    );
    return { index, combat, live, bridge };
  }

  it('mirrors resident structures into combat, with their bounds, mass and zoning', () => {
    const { index, live, bridge } = harness();
    live.push(structure('blk.a', 0, -20, 500_000));
    bridge.sync();

    expect(index.size).toBe(1);
    expect(bridge.added).toBe(1);
    const mirrored = index.get('blk.a')!;
    expect(mirrored.massKg).toBe(500_000);
    expect(mirrored.district).toBe('downtown');
    expect(mirrored.bounds).toEqual({
      minX: -8,
      minY: 0,
      minZ: -28,
      maxX: 8,
      maxY: 24,
      maxZ: -12,
    });
  });

  it('registers each structure once, however often it syncs', () => {
    const { index, live, bridge } = harness();
    live.push(structure('blk.a', 0, -20, 500_000));
    bridge.sync();
    bridge.sync();
    bridge.sync();
    expect(index.size).toBe(1);
    expect(bridge.added).toBe(0);
    expect(bridge.removed).toBe(0);
  });

  it('drops a structure whose chunk was evicted', () => {
    const { index, live, bridge } = harness();
    live.push(structure('blk.a', 0, -20, 500_000), structure('blk.b', 0, -60, 300_000));
    bridge.sync();
    expect(index.size).toBe(2);

    live.splice(1, 1);
    bridge.sync();
    expect(index.size).toBe(1);
    expect(bridge.removed).toBe(1);
    expect(index.get('blk.b')).toBeUndefined();
  });

  /**
   * A build and an eviction in the SAME sweep leave the count unchanged while
   * the membership moved. A bridge that early-outs on the count alone keeps a
   * levelled block in the forecast for ever and never registers the new one.
   */
  it('is exact when a chunk is built and another evicted in the same sweep', () => {
    const { index, live, bridge } = harness();
    live.push(structure('blk.a', 0, -20, 500_000));
    bridge.sync();

    live.length = 0;
    live.push(structure('blk.c', 40, -20, 700_000));
    bridge.sync();

    expect(index.size).toBe(1);
    expect(bridge.added).toBe(1);
    expect(bridge.removed).toBe(1);
    expect(index.get('blk.c')).toBeDefined();
  });
});
