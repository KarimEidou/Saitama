/**
 * THE BOREDOM METER
 *
 * Killing instantly RAISES it, scaled by how trivial the target was.
 * It drains ONLY through heroism. Idleness raises it. Relief decays.
 *
 * These are the rules the tone of the whole game is built on — the renderer
 * desaturates off this number and the audio thins its arrangement to a single
 * drone at 0.8 — so each one is asserted directly rather than inferred from a
 * play session.
 */

import { describe, expect, it } from 'vitest';
import type { ThreatTier } from '@/types';
import { BoredomMeter } from '../boredom';
import { DEFAULT_COMBAT_TUNING, resolveCombatTuning } from '../tuning';
import { createScene, populateStreet, RecordingBus, STREET_HOSTILES } from './fixtures';

const TUNING = DEFAULT_COMBAT_TUNING;

function meter(initial = 0.5): { bus: RecordingBus; meter: BoredomMeter } {
  const bus = new RecordingBus();
  return { bus, meter: new BoredomMeter({ bus, tuning: TUNING, playerId: 'saitama', initial }) };
}

let victimCounter = 0;

/**
 * Emit a kill as the resolver would.
 *
 * `killerId` is `string | null` rather than `string | undefined` on purpose:
 * passing `undefined` to an optional parameter re-triggers its default, so a
 * test meaning "nobody killed it" would silently become "the player killed
 * it". `null` is mapped to an absent id at the emit site instead.
 */
function kill(
  bus: RecordingBus,
  tier: ThreatTier | undefined,
  killerId: string | null = 'saitama',
  faction: 'monster' | 'civilian' = 'monster'
): void {
  bus.emit('EntityKilled', {
    entityId: `victim-${victimCounter++}`,
    entityType: faction === 'monster' ? 'monster' : 'npc',
    faction,
    position: { x: 0, y: 0, z: 0 },
    killerId: killerId ?? undefined,
    threatTier: tier,
    intent: 'normal',
    rewardPoints: 10,
  });
}

/* -------------------------------------------------------------------------- */
/* Rising                                                                     */
/* -------------------------------------------------------------------------- */

describe('boredom rises on trivial kills', () => {
  it('rises on an instant kill', () => {
    const h = meter(0.4);
    kill(h.bus, 'wolf');
    expect(h.meter.value).toBeGreaterThan(0.4);
    const events = h.bus.ofType('BoredomChanged');
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe('trivialVictory');
    expect(events[0]!.previous).toBe(0.4);
    expect(events[0]!.value).toBe(h.meter.value);
  });

  it('rises MORE the more trivial the target was', () => {
    const deltas = new Map<ThreatTier, number>();
    for (const tier of ['wolf', 'tiger', 'demon', 'dragon', 'god'] as const) {
      const h = meter(0.2);
      kill(h.bus, tier);
      deltas.set(tier, h.meter.value - 0.2);
    }
    expect(deltas.get('wolf')!).toBeGreaterThan(deltas.get('tiger')!);
    expect(deltas.get('tiger')!).toBeGreaterThan(deltas.get('demon')!);
    expect(deltas.get('demon')!).toBeGreaterThan(deltas.get('dragon')!);
    expect(deltas.get('dragon')!).toBeGreaterThan(deltas.get('god')!);
  });

  it('still rises for a god-tier kill — one punch is one punch', () => {
    const h = meter(0.2);
    kill(h.bus, 'god');
    expect(h.meter.value).toBeGreaterThan(0.2);
    expect(h.meter.value - 0.2).toBeCloseTo(
      TUNING.boredomPerTrivialKill * TUNING.boredomTopTierRetention,
      6
    );
  });

  it('ignores kills the player did not make', () => {
    const h = meter(0.5);
    kill(h.bus, 'demon', 'genos');
    kill(h.bus, 'demon', null);
    expect(h.meter.value).toBe(0.5);
    expect(h.bus.ofType('BoredomChanged')).toHaveLength(0);
  });

  it('a civilian death is a tragedy, not a disappointment — it moves nothing', () => {
    const h = meter(0.5);
    kill(h.bus, undefined, 'saitama', 'civilian');
    expect(h.meter.value).toBe(0.5);
  });

  it('clamps at 1 no matter how many mobs are deleted', () => {
    const h = meter(0.9);
    for (let i = 0; i < 200; i++) kill(h.bus, 'wolf');
    expect(h.meter.value).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Falling                                                                    */
/* -------------------------------------------------------------------------- */

describe('boredom falls on heroism', () => {
  it('falls when a civilian is saved by the player', () => {
    const h = meter(0.6);
    h.bus.emit('CivilianSaved', {
      entityId: 'civ-1',
      position: { x: 0, y: 0, z: 0 },
      byPlayer: true,
      reputationDelta: 8,
    });
    expect(h.meter.value).toBeCloseTo(0.6 - TUNING.boredomPerCivilianSaved, 6);
    expect(h.bus.ofType('BoredomChanged')[0]!.reason).toBe('civilianSaved');
  });

  it('does NOT fall when a civilian escapes on their own', () => {
    const h = meter(0.6);
    h.bus.emit('CivilianSaved', {
      entityId: 'civ-1',
      position: { x: 0, y: 0, z: 0 },
      byPlayer: false,
      reputationDelta: 4,
    });
    expect(h.meter.value).toBe(0.6);
  });

  it('falls on a body-block, which is the biggest single drop available', () => {
    const h = meter(0.7);
    h.meter.reportHeroism('bodyBlock', 'mumen-rider');
    expect(h.meter.value).toBeCloseTo(0.7 - TUNING.boredomPerBodyBlock, 6);
    expect(h.bus.ofType('BoredomChanged')[0]!.reason).toBe('challengingFight');
  });

  it('falls on catching debris over a crowd', () => {
    const h = meter(0.7);
    h.meter.reportHeroism('debrisCaught');
    expect(h.meter.value).toBeCloseTo(0.7 - TUNING.boredomPerDebrisCaught, 6);
  });

  it('falls on a clean victory, reported as a restraint bonus', () => {
    const h = meter(0.7);
    h.meter.reportHeroism('cleanVictory');
    expect(h.meter.value).toBeCloseTo(0.7 - TUNING.boredomPerCleanVictory, 6);
    expect(h.bus.ofType('BoredomChanged')[0]!.reason).toBe('restraintBonus');
  });

  it('falls most of all for a fight that actually took time', () => {
    const h = meter(0.7);
    h.meter.reportHeroism('challenge');
    expect(h.meter.value).toBeCloseTo(0.7 - TUNING.boredomPerChallenge, 6);
    expect(TUNING.boredomPerChallenge).toBeGreaterThan(TUNING.boredomPerCivilianSaved);
  });

  it('clamps at 0', () => {
    const h = meter(0.05);
    for (let i = 0; i < 20; i++) h.meter.reportHeroism('bodyBlock');
    expect(h.meter.value).toBe(0);
  });

  it('one wolf kill is worth less than one rescue — heroism outpaces slaughter', () => {
    expect(TUNING.boredomPerCivilianSaved).toBeGreaterThan(TUNING.boredomPerTrivialKill);
  });
});

/* -------------------------------------------------------------------------- */
/* Drift                                                                      */
/* -------------------------------------------------------------------------- */

describe('idle rise and baseline decay', () => {
  it('rises while nothing is happening, but only after the idle delay', () => {
    const h = meter(0.3);
    for (let i = 0; i < 60 * 30; i++) h.meter.update(1 / 60, false);
    expect(h.meter.value).toBe(0.3);

    for (let i = 0; i < 60 * 60; i++) h.meter.update(1 / 60, false);
    expect(h.meter.value).toBeGreaterThan(0.3);
    const reasons = new Set(h.bus.ofType('BoredomChanged').map((e) => e.reason));
    expect(reasons.has('idle')).toBe(true);
  });

  it('does not rise from idleness during a fight', () => {
    const h = meter(0.3);
    for (let i = 0; i < 60 * 300; i++) h.meter.update(1 / 60, true);
    expect(h.meter.value).toBe(0.3);
  });

  it('drifts back UP toward the baseline after heroism, and stops there', () => {
    const h = meter(TUNING.boredomBaseline);
    h.meter.reportHeroism('bodyBlock');
    const low = h.meter.value;
    expect(low).toBeLessThan(TUNING.boredomBaseline);

    for (let i = 0; i < 60 * 600; i++) h.meter.update(1 / 60, true);
    expect(h.meter.value).toBeCloseTo(TUNING.boredomBaseline, 5);
    expect(h.bus.ofType('BoredomChanged').some((e) => e.reason === 'decay')).toBe(true);
  });

  it('never decays a kill back down — decay only runs upward', () => {
    const h = meter(0.9);
    for (let i = 0; i < 60 * 600; i++) h.meter.update(1 / 60, true);
    expect(h.meter.value).toBe(0.9);
  });

  it('banks sub-threshold moves instead of discarding them', () => {
    // 0.0025/s at 60 fps is 4.2e-5 per frame, far below the 5e-3 report
    // threshold. The VALUE must still climb the full amount; only the BUS
    // traffic is quantised. Getting this wrong means boredom never rises from
    // idling at all, which is the one thing the meter exists to model.
    const h = meter(0.3);
    const idleSeconds = 120;
    for (let i = 0; i < 60 * idleSeconds; i++) h.meter.update(1 / 60, false);

    const rising = idleSeconds - TUNING.boredomIdleAfterSeconds;
    const expected = 0.3 + rising * TUNING.boredomIdleRatePerSecond;
    expect(h.meter.value).toBeCloseTo(expected, 4);

    const events = h.bus.ofType('BoredomChanged').length;
    // One event per 5e-3 of movement, not one per frame.
    expect(events).toBeGreaterThan(0);
    expect(events).toBeLessThanOrEqual(
      Math.ceil((expected - 0.3) / TUNING.boredomEmitEpsilon) + 1
    );
    expect(events).toBeLessThan(60 * idleSeconds * 0.02);
  });

  it('reports a continuous previous -> value chain despite the quantisation', () => {
    const h = meter(0.3);
    for (let i = 0; i < 60 * 200; i++) h.meter.update(1 / 60, false);
    const events = h.bus.ofType('BoredomChanged');
    expect(events.length).toBeGreaterThan(2);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.previous).toBeCloseTo(events[i - 1]!.value, 9);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Through the whole system                                                   */
/* -------------------------------------------------------------------------- */

describe('boredom through the combat system', () => {
  it('a jab that deletes a demon raises it; saving someone lowers it again', () => {
    const scene = createScene({ boredom: 0.5 });
    populateStreet(scene);
    scene.attacker.moveTo(0, 1.4, -6.6);
    scene.attacker.faceTowards(0, 1, -8);

    scene.combat.normalPunch();
    const afterKill = scene.combat.boredom;
    expect(afterKill).toBeGreaterThan(0.5);

    scene.combat.reportHeroism('arrivedInTime', 'civ-3');
    expect(scene.combat.boredom).toBeLessThan(afterKill);
    // `arrivedInTime` routes through `CivilianSaved`, so the rest of the game
    // hears about the rescue — and the meter must not double-credit it.
    expect(scene.bus.ofType('CivilianSaved')).toHaveLength(1);
    expect(
      scene.bus.ofType('BoredomChanged').filter((e) => e.reason === 'civilianSaved')
    ).toHaveLength(1);
    scene.combat.dispose();
  });

  it('a flawless fight ends with a restraint bonus', () => {
    const scene = createScene({
      boredom: 0.5,
      tuning: { challengeSeconds: 1e9 },
    });
    populateStreet(scene);
    // Only the reachable monster is a hostile here — the boss stays out of it.
    scene.combat.beginEncounter({ encounterId: 'street', hostileIds: ['monster-01'], time: 0 });
    scene.attacker.moveTo(0, 1.4, -6.6);
    scene.attacker.faceTowards(0, 1, -8);
    scene.combat.normalPunch();

    const result = scene.combat.endEncounter();
    expect(result).toBeDefined();
    expect(result!.victory).toBe(true);
    expect(result!.propertyDamageYen).toBe(0);
    expect(result!.civiliansLost).toBe(0);

    const reasons = scene.bus.ofType('BoredomChanged').map((e) => e.reason);
    expect(reasons).toContain('trivialVictory');
    expect(reasons).toContain('restraintBonus');
    scene.combat.dispose();
  });

  it('a serious punch that levels the street earns no bonus at all', () => {
    const scene = createScene({ boredom: 0.5, tuning: { challengeSeconds: 1e9 } });
    populateStreet(scene);
    scene.combat.beginEncounter({
      encounterId: 'street',
      hostileIds: [...STREET_HOSTILES],
      time: 0,
    });
    // Resolve the boss's phase so the fight can actually end.
    scene.bus.emit('BossPhaseChanged', {
      entityId: 'boss-01',
      specId: 'deep-sea-king',
      previousPhase: 0,
      phase: 1,
      healthFraction: 1,
      isFinalPhase: true,
    });
    scene.combat.seriousPunch(1);
    // The destruction system's answer to that punch.
    for (let i = 0; i < 40; i++) {
      scene.bus.emit('ChunkDetached', {
        structureId: 'block-0',
        chunkIndex: i,
        position: { x: 0, y: 4, z: -24 },
        mass: 900,
        impulse: { x: 0, y: 0, z: 0 },
        material: 'concrete',
        collateralCost: 500,
      });
    }
    const result = scene.combat.endEncounter();
    expect(result).toBeDefined();
    expect(result!.civiliansLost).toBeGreaterThan(0);
    const reasons = scene.bus.ofType('BoredomChanged').map((e) => e.reason);
    expect(reasons).not.toContain('restraintBonus');
    scene.combat.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* Tuning surface                                                             */
/* -------------------------------------------------------------------------- */

describe('tuning', () => {
  it('resolves a patch over the defaults without mutating them', () => {
    const patched = resolveCombatTuning({ boredomPerTrivialKill: 0.5 });
    expect(patched.boredomPerTrivialKill).toBe(0.5);
    expect(patched.normalReachMetres).toBe(TUNING.normalReachMetres);
    expect(DEFAULT_COMBAT_TUNING.boredomPerTrivialKill).not.toBe(0.5);
  });
});
