/**
 * INSTANT-KILL SEMANTICS AND THE EVENT SEQUENCE
 *
 * The two things the rest of the game is entitled to rely on:
 *
 *  1. A LETHAL-INTENT HIT ON A NON-BOSS ALWAYS KILLS. Every tier, every health
 *     pool, every resistance table, no exceptions. A boss whose scripted phase
 *     has not resolved does not die, and cannot be made to.
 *
 *  2. THE EVENT ORDER IS A CONTRACT. `ShockwaveFired` first, always, even on a
 *     whiff; then per victim, nearest first, the death or the damage, then the
 *     faction consequence, then the impulse.
 */

import { describe, expect, it } from 'vitest';
import type { LethalIntent, ThreatTier } from '@/types';
import { createRng } from '@/util';
import { HitResolver } from '../resolver';
import { LinearScan, TargetRegistry } from '../targets';
import { DEFAULT_COMBAT_TUNING, LETHAL_INTENTS, isLethalIntent } from '../tuning';
import type { IPunchRequest } from '../types';
import { RecordingBus } from './fixtures';

const TUNING = DEFAULT_COMBAT_TUNING;
const ALL_TIERS: readonly ThreatTier[] = ['wolf', 'tiger', 'demon', 'dragon', 'god'];
const ALL_INTENTS: readonly LethalIntent[] = ['restrained', 'normal', 'serious', 'full'];

interface IHarness {
  bus: RecordingBus;
  registry: TargetRegistry;
  resolver: HitResolver;
}

function harness(): IHarness {
  const bus = new RecordingBus();
  const registry = new TargetRegistry();
  const resolver = new HitResolver({
    bus,
    registry,
    tuning: TUNING,
    broadPhase: new LinearScan(registry),
    rng: createRng('resolver-test'),
  });
  return { bus, registry, resolver };
}

/** A serious punch pointed down -Z, wide enough to sweep the whole test scene. */
function punch(overrides: Partial<IPunchRequest> = {}): IPunchRequest {
  return {
    origin: { x: 0, y: 1.4, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    power: 5e5,
    radius: 60,
    kind: 'serious',
    intent: 'serious',
    time: 1,
    sourceId: 'saitama',
    halfAngle: TUNING.seriousHalfAngleRad,
    knockbackMps: TUNING.seriousKnockbackMps,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Instant kill                                                               */
/* -------------------------------------------------------------------------- */

describe('instant-kill semantics', () => {
  it('kills every threat tier at every lethal intent, whatever its health', () => {
    for (const tier of ALL_TIERS) {
      for (const intent of LETHAL_INTENTS) {
        const { registry, resolver, bus } = harness();
        registry.add({
          id: 'target',
          type: 'monster',
          faction: 'monster',
          position: { x: 0, y: 1, z: -10 },
          radius: 1,
          // Absurd on purpose: the number must be irrelevant.
          maxHealth: 1e12,
          threatTier: tier,
          resistances: { blunt: 0 },
        });

        const outcome = resolver.resolve(punch({ intent }));
        expect(outcome.hits).toHaveLength(1);
        expect(outcome.hits[0]!.killed, `${tier} @ ${intent}`).toBe(true);
        expect(outcome.hits[0]!.instantKill).toBe(true);
        // No damage number was involved in reaching that conclusion.
        expect(outcome.hits[0]!.damage).toBe(0);
        expect(registry.get('target')!.health).toBe(0);
        expect(bus.ofType('EntityKilled')).toHaveLength(1);
        expect(bus.ofType('EntityKilled')[0]!.threatTier).toBe(tier);
      }
    }
  });

  it('ignores a total blunt immunity — lethal intent does not consult resistances', () => {
    const { registry, resolver } = harness();
    registry.add({
      id: 'immune',
      type: 'monster',
      faction: 'monster',
      position: { x: 0, y: 1, z: -10 },
      radius: 1,
      maxHealth: 500,
      resistances: { blunt: 0, energy: 0, explosive: 0 },
    });
    expect(resolver.resolve(punch()).hits[0]!.killed).toBe(true);
  });

  it('kills civilians and heroes exactly as readily as monsters', () => {
    const { registry, resolver, bus } = harness();
    registry.add({
      id: 'civ',
      type: 'npc',
      faction: 'civilian',
      position: { x: 0, y: 1, z: -8 },
      maxHealth: 30,
    });
    registry.add({
      id: 'ally',
      type: 'hero',
      faction: 'hero',
      position: { x: 0, y: 1, z: -12 },
      maxHealth: 90,
      displayName: 'Mumen Rider',
    });

    const outcome = resolver.resolve(punch({ intent: 'full' }));
    expect(outcome.kills).toBe(2);
    expect(outcome.civiliansKilled).toBe(1);
    expect(bus.ofType('CivilianLost')).toHaveLength(1);
    expect(bus.ofType('CivilianLost')[0]!.causedByPlayer).toBe(true);
    expect(bus.ofType('AllyDowned')).toHaveLength(1);
    expect(bus.ofType('AllyDowned')[0]!.displayName).toBe('Mumen Rider');
  });

  it('a restrained hit is NOT lethal — it applies a real, survivable number', () => {
    const { registry, resolver, bus } = harness();
    registry.add({
      id: 'civ',
      type: 'npc',
      faction: 'civilian',
      position: { x: 0, y: 1, z: -8 },
      maxHealth: 30,
    });
    const outcome = resolver.resolve(punch({ intent: 'restrained' }));
    expect(isLethalIntent('restrained')).toBe(false);
    expect(outcome.hits[0]!.killed).toBe(false);
    expect(outcome.hits[0]!.damage).toBe(TUNING.restrainedDamage);
    expect(registry.get('civ')!.health).toBe(30 - TUNING.restrainedDamage);
    expect(bus.ofType('EntityDamaged')).toHaveLength(1);
    expect(bus.ofType('EntityKilled')).toHaveLength(0);
  });

  it('a restrained hit can still finish someone already nearly dead', () => {
    const { registry, resolver, bus } = harness();
    registry.add({
      id: 'civ',
      type: 'npc',
      faction: 'civilian',
      position: { x: 0, y: 1, z: -8 },
      maxHealth: 30,
      health: 3,
    });
    expect(resolver.resolve(punch({ intent: 'restrained' })).hits[0]!.killed).toBe(true);
    expect(bus.ofType('CivilianLost')).toHaveLength(1);
  });

  it('never kills the same entity twice', () => {
    const { registry, resolver, bus } = harness();
    registry.add({
      id: 'monster',
      type: 'monster',
      faction: 'monster',
      position: { x: 0, y: 1, z: -10 },
      radius: 1,
    });
    resolver.resolve(punch());
    resolver.resolve(punch());
    resolver.resolve(punch());
    expect(bus.ofType('EntityKilled')).toHaveLength(1);
  });

  it('never hits the attacker with their own punch', () => {
    const { registry, resolver } = harness();
    registry.add({
      id: 'saitama',
      type: 'player',
      faction: 'hero',
      position: { x: 0, y: 1.4, z: 0 },
      radius: 0.5,
    });
    expect(resolver.resolve(punch()).hits).toHaveLength(0);
  });

  it('never hits an invulnerable target', () => {
    const { registry, resolver } = harness();
    registry.add({
      id: 'statue',
      type: 'prop',
      faction: 'neutral',
      position: { x: 0, y: 1, z: -10 },
      invulnerable: true,
    });
    expect(resolver.resolve(punch()).hits).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Bosses                                                                     */
/* -------------------------------------------------------------------------- */

describe('the boss gate is narrative, not HP', () => {
  function bossHarness(phaseResolved: boolean): IHarness {
    const h = harness();
    h.registry.add({
      id: 'boss',
      type: 'monster',
      faction: 'monster',
      position: { x: 0, y: 2, z: -14 },
      radius: 2.4,
      maxHealth: 100_000,
      threatTier: 'dragon',
      specId: 'deep-sea-king',
      isBoss: true,
      phaseResolved,
    });
    return h;
  }

  it('a boss in an unresolved phase does NOT die, at any intent', () => {
    for (const intent of ALL_INTENTS) {
      const { registry, resolver, bus } = bossHarness(false);
      const outcome = resolver.resolve(punch({ intent }));
      expect(outcome.hits, `${intent}`).toHaveLength(1);
      expect(outcome.hits[0]!.killed, `${intent}`).toBe(false);
      expect(outcome.hits[0]!.phaseGated).toBe(true);
      expect(outcome.hits[0]!.blocked).toBe(true);
      expect(registry.get('boss')!.dead).toBe(false);
      expect(bus.ofType('EntityKilled')).toHaveLength(0);
      expect(bus.ofType('EntityDamaged')).toHaveLength(1);
    }
  });

  it('no amount of punching can grind an unresolved boss down', () => {
    const { registry, resolver, bus } = bossHarness(false);
    for (let i = 0; i < 500; i++) resolver.resolve(punch({ intent: 'full' }));
    expect(registry.get('boss')!.health).toBeGreaterThanOrEqual(1);
    expect(registry.get('boss')!.dead).toBe(false);
    expect(bus.ofType('EntityKilled')).toHaveLength(0);
  });

  it('once the phase resolves, the very next lethal hit kills it in one', () => {
    const { registry, resolver, bus } = bossHarness(false);
    resolver.resolve(punch({ intent: 'full' }));
    expect(bus.ofType('EntityKilled')).toHaveLength(0);

    registry.get('boss')!.phaseResolved = true;
    const outcome = resolver.resolve(punch({ intent: 'full' }));
    expect(outcome.hits[0]!.killed).toBe(true);
    expect(outcome.hits[0]!.instantKill).toBe(true);
    // Health went straight to zero, not down by a chip.
    expect(registry.get('boss')!.health).toBe(0);
    expect(bus.ofType('EntityKilled')).toHaveLength(1);
  });

  it('a NON-boss is never gated, even mid-encounter', () => {
    const { registry, resolver } = harness();
    registry.add({
      id: 'minion',
      type: 'monster',
      faction: 'monster',
      position: { x: 0, y: 1, z: -10 },
      radius: 1,
      isBoss: false,
      phaseResolved: false,
    });
    expect(resolver.resolve(punch()).hits[0]!.killed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Event sequence                                                             */
/* -------------------------------------------------------------------------- */

describe('the emitted event sequence', () => {
  it('emits ShockwaveFired first, even when nothing is in range', () => {
    const { resolver, bus } = harness();
    const outcome = resolver.resolve(punch());
    expect(outcome.whiffed).toBe(true);
    expect(bus.types()).toEqual(['ShockwaveFired']);
  });

  it('orders each victim: kill, faction consequence, impulse', () => {
    const { registry, resolver, bus } = harness();
    registry.add({
      id: 'civ',
      type: 'npc',
      faction: 'civilian',
      position: { x: 0, y: 1, z: -6 },
    });
    registry.add({
      id: 'monster',
      type: 'monster',
      faction: 'monster',
      position: { x: 0, y: 1, z: -20 },
      radius: 1,
    });

    resolver.resolve(punch({ intent: 'full' }));
    expect(bus.types()).toEqual([
      'ShockwaveFired',
      // nearest first: the civilian at 6 m
      'EntityKilled',
      'CivilianLost',
      'ImpulseApplied',
      // then the monster at 20 m
      'EntityKilled',
      'ImpulseApplied',
    ]);
  });

  it('sorts victims by distance regardless of registration order', () => {
    const forward = harness();
    const reverse = harness();
    const positions: [string, number][] = [
      ['far', -30],
      ['near', -5],
      ['mid', -16],
    ];
    for (const [id, z] of positions) {
      forward.registry.add({ id, type: 'monster', faction: 'monster', position: { x: 0, y: 1, z } });
    }
    for (const [id, z] of [...positions].reverse()) {
      reverse.registry.add({ id, type: 'monster', faction: 'monster', position: { x: 0, y: 1, z } });
    }

    const a = forward.resolver.resolve(punch()).hits.map((h) => h.targetId);
    const b = reverse.resolver.resolve(punch()).hits.map((h) => h.targetId);
    expect(a).toEqual(['near', 'mid', 'far']);
    expect(b).toEqual(a);
  });

  it('breaks distance ties by id, so co-located targets still order stably', () => {
    const { registry, resolver } = harness();
    for (const id of ['zeta', 'alpha', 'mu']) {
      registry.add({ id, type: 'monster', faction: 'monster', position: { x: 0, y: 1.4, z: -10 } });
    }
    expect(resolver.resolve(punch()).hits.map((h) => h.targetId)).toEqual([
      'alpha',
      'mu',
      'zeta',
    ]);
  });

  it('stamps ShockwaveFired with the WAVE range, not the lethal radius', () => {
    const { resolver, bus } = harness();
    resolver.resolve(
      punch({
        radius: 10,
        halfAngle: Math.PI,
        kind: 'slam',
        shockwave: { range: 25, angle: Math.PI, force: 1, destroysTerrain: true, travelTime: 0 },
      })
    );
    const wave = bus.ofType('ShockwaveFired')[0]!;
    expect(wave.range).toBe(25);
    expect(wave.angle).toBe(Math.PI);
    expect(wave.punchKind).toBe('slam');
  });

  it('kills inside the LETHAL radius and only shoves beyond it', () => {
    const { registry, resolver } = harness();
    registry.add({ id: 'close', type: 'npc', faction: 'civilian', position: { x: 0, y: 1, z: -6 } });
    registry.add({ id: 'far', type: 'npc', faction: 'civilian', position: { x: 0, y: 1, z: -18 } });

    const outcome = resolver.resolve(
      punch({
        radius: 10,
        halfAngle: Math.PI,
        kind: 'slam',
        intent: 'serious',
        shockwave: { range: 25, angle: Math.PI, force: 1, destroysTerrain: true, travelTime: 0 },
      })
    );
    expect(outcome.hits.map((h) => h.targetId)).toEqual(['close']);
    // The one at 18 m is outside the crater but inside the pressure wave, which
    // physics propagates from `ShockwaveFired` — combat does not touch it.
    expect(outcome.civiliansKilled).toBe(1);
  });

  it('carries the punch power through to the event untouched', () => {
    const { resolver, bus } = harness();
    resolver.resolve(punch({ power: 2.5e6 }));
    expect(bus.ofType('ShockwaveFired')[0]!.power).toBe(2.5e6);
  });

  it('respects maxTargets, keeping the nearest', () => {
    const { registry, resolver } = harness();
    for (let i = 0; i < 5; i++) {
      registry.add({
        id: `m${i}`,
        type: 'monster',
        faction: 'monster',
        position: { x: 0, y: 1, z: -4 - i * 4 },
      });
    }
    const outcome = resolver.resolve(punch({ maxTargets: 1 }));
    expect(outcome.hits.map((h) => h.targetId)).toEqual(['m0']);
  });
});

/* -------------------------------------------------------------------------- */
/* Impulse and hit records                                                    */
/* -------------------------------------------------------------------------- */

describe('hit records', () => {
  it('reports an impulse in newton-seconds that scales with mass', () => {
    const { registry, resolver } = harness();
    registry.add({
      id: 'light',
      type: 'npc',
      faction: 'civilian',
      position: { x: 0, y: 1, z: -6 },
      massKg: 70,
    });
    registry.add({
      id: 'heavy',
      type: 'monster',
      faction: 'monster',
      position: { x: 0, y: 1, z: -6.0001 },
      radius: 0.45,
      massKg: 700,
    });
    const hits = resolver.resolve(punch()).hits;
    const light = hits.find((h) => h.targetId === 'light')!;
    const heavy = hits.find((h) => h.targetId === 'heavy')!;
    const magnitude = (v: { x: number; y: number; z: number }): number =>
      Math.hypot(v.x, v.y, v.z);
    expect(magnitude(heavy.impulse) / magnitude(light.impulse)).toBeCloseTo(10, 1);
  });

  it('attenuates the personal knockback with distance', () => {
    const { registry, resolver } = harness();
    registry.add({ id: 'near', type: 'npc', faction: 'civilian', position: { x: 0, y: 1, z: -3 } });
    registry.add({ id: 'far', type: 'npc', faction: 'civilian', position: { x: 0, y: 1, z: -50 } });
    const hits = resolver.resolve(punch()).hits;
    const mag = (id: string): number => {
      const v = hits.find((h) => h.targetId === id)!.impulse;
      return Math.hypot(v.x, v.y, v.z);
    };
    expect(mag('near')).toBeGreaterThan(mag('far'));
  });

  it('points the contact normal back at the attacker', () => {
    const { registry, resolver } = harness();
    registry.add({ id: 'm', type: 'monster', faction: 'monster', position: { x: 0, y: 1.4, z: -9 } });
    const hit = resolver.resolve(punch()).hits[0]!;
    expect(hit.normal.z).toBeCloseTo(1, 6);
    expect(hit.point.z).toBeCloseTo(-9 + 0.45, 5);
  });

  it('reports a critical only at full intent', () => {
    const { registry, resolver } = harness();
    registry.add({ id: 'm', type: 'monster', faction: 'monster', position: { x: 0, y: 1, z: -9 } });
    expect(resolver.resolve(punch({ intent: 'serious' })).hits[0]!.critical).toBe(false);
    registry.add({ id: 'n', type: 'monster', faction: 'monster', position: { x: 0, y: 1, z: -9 } });
    expect(resolver.resolve(punch({ intent: 'full' })).hits[0]!.critical).toBe(true);
  });

  it('reports a hit socket, drawn from the seeded stream', () => {
    const { registry, resolver } = harness();
    registry.add({ id: 'm', type: 'monster', faction: 'monster', position: { x: 0, y: 1, z: -9 } });
    expect(typeof resolver.resolve(punch()).hits[0]!.bone).toBe('string');
  });
});

/* -------------------------------------------------------------------------- */
/* Structures                                                                 */
/* -------------------------------------------------------------------------- */

describe('structural consequences', () => {
  it('a normal-intent tap reaches nothing structural', () => {
    const { bus, registry } = harness();
    const resolver = new HitResolver({
      bus,
      registry,
      tuning: TUNING,
      broadPhase: new LinearScan(registry),
      rng: createRng('structures'),
      structures: undefined,
    });
    const outcome = resolver.resolve(punch({ intent: 'normal', radius: 1.2 }));
    expect(outcome.destructiblesHit).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Witness                                                                    */
/* -------------------------------------------------------------------------- */

describe('witness', () => {
  it('needs a LIVING civilian within the witness radius', () => {
    const { registry, resolver } = harness();
    expect(resolver.isWitnessed({ x: 0, y: 1, z: 0 })).toBe(false);

    registry.add({ id: 'civ', type: 'npc', faction: 'civilian', position: { x: 0, y: 1, z: -20 } });
    expect(resolver.isWitnessed({ x: 0, y: 1, z: 0 })).toBe(true);

    registry.get('civ')!.dead = true;
    expect(resolver.isWitnessed({ x: 0, y: 1, z: 0 })).toBe(false);
  });

  it('respects the injected line-of-sight test', () => {
    const bus = new RecordingBus();
    const registry = new TargetRegistry();
    const resolver = new HitResolver({
      bus,
      registry,
      tuning: TUNING,
      broadPhase: new LinearScan(registry),
      rng: createRng('los'),
      lineOfSight: () => false,
    });
    registry.add({ id: 'civ', type: 'npc', faction: 'civilian', position: { x: 0, y: 1, z: -20 } });
    expect(resolver.isWitnessed({ x: 0, y: 1, z: 0 })).toBe(false);
  });

  it('ignores civilians beyond the witness radius', () => {
    const { registry, resolver } = harness();
    registry.add({
      id: 'civ',
      type: 'npc',
      faction: 'civilian',
      position: { x: 0, y: 1, z: -(TUNING.witnessRadiusMetres + 5) },
    });
    expect(resolver.isWitnessed({ x: 0, y: 1, z: 0 })).toBe(false);
  });
});
