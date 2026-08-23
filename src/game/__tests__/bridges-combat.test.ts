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
import { TargetRegistry, type CombatSystem } from '@/gameplay/combat';
import type { MonsterSystem, IMonsterCombatDescriptor } from '@/entities/monster';
import { CombatTargetBridge, auditAimPoints } from '../bridges';

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
