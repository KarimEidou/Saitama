/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE PHASE GATE — THE SINGLE MOST IMPORTANT TEST IN THIS MODULE          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Asserted in BOTH directions, because the two failure modes are opposite and
 * both are fatal:
 *
 *   gate stuck CLOSED → bosses are unkillable, forever, and the only way out
 *                       is a bug report from someone who spent four minutes
 *                       punching a man who would not die.
 *   gate stuck OPEN   → every boss dies during its own establishing shot and
 *                       the entire encounter design — the swarm, the beams,
 *                       the rain, the nine seconds of Collapsing Star — never
 *                       happens at all.
 *
 * The gate is checked against a transcription of the combat resolver's branch
 * (`fixtures.ts`), and against the same assertions run through the REAL
 * resolver in `harness/monster.ts`.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '@/util';
import { BossEncounter, PHASE_STALL_SECONDS } from '../boss-encounter';
import { BOSS_SCRIPTS, bossScript } from '../boss-scripts';
import { makeBrain, mirrorOf, mirrorPunch, recordingBus } from './fixtures';
import type { IBossPhase, IBossScript } from '../types';

const ORIGIN = { x: 0, y: 0, z: 0 };

/** Boss at the origin, player wherever the test puts them. */
function scene(
  encounterId: string,
  ally?: { id: string; displayName: string; position: { x: number; y: number; z: number } }
) {
  const recorder = recordingBus();
  const script = bossScript(encounterId);
  const boss = makeBrain(script.archetypeId, recorder.bus, ORIGIN, 'boss#1');
  const encounter = new BossEncounter({
    bus: recorder.bus,
    script,
    boss,
    rng: createRng('encounter-test'),
    ally,
    onSummon: (_archetypeId, count) => Array.from({ length: count }, (_unused, i) => `summon#${i}`),
  });
  return { recorder, script, boss, encounter, target: mirrorOf(boss) };
}

/** Drive the encounter with the player standing on top of the boss. */
function run(
  encounter: BossEncounter,
  seconds: number,
  playerAt: { x: number; y: number; z: number } = ORIGIN,
  dt = 1 / 60
): void {
  for (let t = 0; t < seconds; t += dt) encounter.update(dt, playerAt);
}

/* -------------------------------------------------------------------------- */
/* THE GATE                                                                   */
/* -------------------------------------------------------------------------- */

describe('the boss phase gate', () => {
  it('DIRECTION 1 — a lethal punch during an unresolved phase does NOT kill', () => {
    const { encounter, boss, target } = scene('boss.boros');
    encounter.begin(0);

    expect(encounter.phaseResolved).toBe(false);
    expect(boss.phaseResolved).toBe(false);

    const hit = mirrorPunch(target, 'normal');

    expect(hit.killed).toBe(false);
    expect(hit.instantKill).toBe(false);
    expect(hit.phaseGated).toBe(true);
    expect(target.dead).toBe(false);
    // Chip damage ships at 0 — the boss loses NOTHING. The gate is narrative,
    // and a boss whose health moved would be a boss with a health bar.
    expect(boss.health).toBe(boss.archetype.maxHealth);
  });

  it('DIRECTION 1 — no intent short of the gate can force it', () => {
    const { encounter, target } = scene('boss.boros');
    encounter.begin(0);
    for (const intent of ['normal', 'serious', 'full'] as const) {
      const hit = mirrorPunch(target, intent);
      expect(hit.phaseGated).toBe(true);
      expect(hit.killed).toBe(false);
    }
    // A hundred punches later he is still standing, because punching is not
    // what the gate is measuring.
    for (let i = 0; i < 100; i++) mirrorPunch(target, 'full');
    expect(target.dead).toBe(false);
  });

  it('DIRECTION 2 — the SAME punch kills once the phase resolves', () => {
    const { encounter, boss, target, recorder } = scene('boss.boros');
    encounter.begin(0);

    // Walk the script to the finisher, feeding it exactly what each phase
    // asks for: engaged time, hits, and nothing else.
    driveToFinisher(encounter);

    expect(encounter.phaseResolved).toBe(true);
    expect(boss.phaseResolved).toBe(true);

    const hit = mirrorPunch(target, 'normal');
    expect(hit.killed).toBe(true);
    expect(hit.instantKill).toBe(true);
    expect(hit.phaseGated).toBe(false);
    expect(target.dead).toBe(true);
    expect(boss.health).toBe(0);

    // And the gate travelled over the bus, which is how combat learns it.
    const phases = recorder.ofType('BossPhaseChanged');
    expect(phases.at(-1)!.isFinalPhase).toBe(true);
    expect(phases.at(-1)!.entityId).toBe('boss#1');
  });

  it('emits BossPhaseChanged for every transition, final flag last only', () => {
    const { encounter, recorder, script } = scene('boss.boros');
    encounter.begin(0);
    driveToFinisher(encounter);

    const phases = recorder.ofType('BossPhaseChanged');
    expect(phases).toHaveLength(script.phases.length);
    phases.forEach((event, index) => {
      expect(event.phase).toBe(index);
      expect(event.isFinalPhase).toBe(index === script.phases.length - 1);
      expect(event.healthFraction).toBeGreaterThan(0);
      expect(event.healthFraction).toBeLessThanOrEqual(1);
    });
  });

  it('starts every boss gated, before a phase has even been entered', () => {
    for (const script of BOSS_SCRIPTS) {
      const { boss } = scene(script.encounterId);
      expect(boss.phaseResolved).toBe(false);
    }
  });

  it('leaves every NON-boss killable from its first frame, at every tier', () => {
    const recorder = recordingBus();
    for (const id of [
      'mob.wolf.pest',
      'mob.tiger.brute',
      'mob.demon.carapace',
      'mob.dragon.leviathan',
      'mob.god.harbinger',
    ]) {
      const brain = makeBrain(id, recorder.bus, ORIGIN, `${id}#1`);
      expect(brain.phaseResolved).toBe(true);
      const hit = mirrorPunch(mirrorOf(brain), 'normal');
      expect(hit.instantKill).toBe(true);
      expect(hit.phaseGated).toBe(false);
    }
  });

  it('does not open the gate for health reaching zero', () => {
    const { encounter, boss, target } = scene('boss.boros');
    encounter.begin(0);
    // Something else in the world hurts him badly. Combat's own chip damage is
    // 0, but a collapsing building or an ally could in principle write here.
    boss.health = 0;
    expect(encounter.phaseResolved).toBe(false);
    expect(mirrorPunch(target, 'full').phaseGated).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Phase progression                                                          */
/* -------------------------------------------------------------------------- */

describe('phase progression', () => {
  it('will not advance while the player stays out of the engage radius', () => {
    const { encounter } = scene('boss.boros');
    encounter.begin(0);
    // Two hundred metres away: the arena clock never runs.
    run(encounter, 60, { x: 400, y: 0, z: 0 });
    expect(encounter.currentPhaseIndex).toBe(0);
    expect(encounter.phaseResolved).toBe(false);
  });

  it('will not advance without hits, however long the player stands there', () => {
    const { encounter } = scene('boss.boros');
    encounter.begin(0);
    run(encounter, 60, ORIGIN); // engaged, but never touched
    expect(encounter.currentPhaseIndex).toBe(0);
  });

  it('runs Boros through arena → survival → burst → finisher, in order', () => {
    const { encounter, recorder } = scene('boss.boros');
    encounter.begin(0);

    run(encounter, 7);
    encounter.onBossHit();
    encounter.onBossHit();
    run(encounter, 0.2);
    expect(encounter.currentPhaseIndex).toBe(1);
    expect(encounter.state().kind).toBe('survival');
    expect(encounter.phaseResolved).toBe(false);

    // The survival phase asks for nothing but presence. Nine seconds of it.
    run(encounter, 5);
    expect(encounter.currentPhaseIndex).toBe(1);
    expect(encounter.phaseResolved).toBe(false);
    run(encounter, 5);
    expect(encounter.currentPhaseIndex).toBe(2);

    run(encounter, 5);
    for (let i = 0; i < 4; i++) encounter.onBossHit();
    run(encounter, 0.2);
    expect(encounter.currentPhaseIndex).toBe(3);
    expect(encounter.state().kind).toBe('finisher');
    expect(encounter.phaseResolved).toBe(true);

    // The survival phase actually fired its meteors rather than merely
    // claiming to: 9 s at 1.1 s cadence is eight-ish bursts.
    const shockwaves = recorder.ofType('ShockwaveFired');
    expect(shockwaves.length).toBeGreaterThan(8);
    expect(shockwaves.some((s) => s.power >= 1e6)).toBe(true);
    expect(shockwaves.every((s) => s.sourceId === 'boss#1')).toBe(true);
  });

  it('holds Mosquito Girl in the swarm phase until the swarm is dead', () => {
    const { encounter } = scene('boss.mosquitoGirl');
    encounter.begin(0);
    expect(encounter.summonsAlive).toBe(14);

    run(encounter, 30);
    expect(encounter.currentPhaseIndex).toBe(0);

    for (let i = 0; i < 13; i++) encounter.onMonsterKilled(`summon#${i}`);
    run(encounter, 1);
    expect(encounter.currentPhaseIndex).toBe(0); // one left, and one is enough

    encounter.onMonsterKilled('summon#13');
    run(encounter, 0.2);
    expect(encounter.currentPhaseIndex).toBe(1);
  });

  it('makes Vaccine Man phase two only advance inside melee range', () => {
    const { encounter } = scene('boss.vaccineMan');
    encounter.begin(0);
    run(encounter, 10, { x: 60, y: 0, z: 0 }); // inside the 110 m bombardment radius
    expect(encounter.currentPhaseIndex).toBe(1);

    // Still 60 m away. The descent phase engages at 18 m — the whole phase IS
    // the approach, so hanging back does nothing at all.
    run(encounter, 30, { x: 60, y: 0, z: 0 });
    for (let i = 0; i < 3; i++) encounter.onBossHit();
    run(encounter, 1, { x: 60, y: 0, z: 0 });
    expect(encounter.currentPhaseIndex).toBe(1);

    run(encounter, 5, { x: 8, y: 0, z: 0 });
    expect(encounter.currentPhaseIndex).toBe(2);
    expect(encounter.phaseResolved).toBe(true);
  });

  it('force-advances a phase that stalls, rather than becoming unkillable', () => {
    const { encounter } = scene('boss.mosquitoGirl');
    encounter.begin(0);
    // The host never services the summons and they never die. Without the
    // guard this boss is immortal; with it, the encounter reports the bug and
    // keeps the game playable.
    run(encounter, PHASE_STALL_SECONDS + 5, ORIGIN, 0.5);
    expect(encounter.stallTrips).toBeGreaterThan(0);
    expect(encounter.currentPhaseIndex).toBeGreaterThan(0);
  });

  it('never emits EncounterEnded — combat owns that event', () => {
    const { encounter, recorder } = scene('boss.boros');
    encounter.begin(0);
    driveToFinisher(encounter);
    encounter.onBossKilled();
    expect(recorder.ofType('EncounterEnded')).toHaveLength(0);
    expect(recorder.ofType('EncounterStarted')).toHaveLength(1);
    expect(recorder.ofType('EncounterStarted')[0]!.isBoss).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Deep Sea King — the branch                                                 */
/* -------------------------------------------------------------------------- */

describe('Deep Sea King: the ally branch', () => {
  const ALLY = { id: 'mumen-rider', displayName: 'Mumen Rider', position: { x: 30, y: 0, z: 0 } };

  it('PLAYER FAST — reaching the ally in time means AllyDowned never fires', () => {
    const { encounter, recorder } = scene('boss.deepSeaKing', {
      ...ALLY,
      position: { ...ALLY.position },
    });
    encounter.begin(0);

    // The player runs straight there and arrives at t = 8 s, inside the 18 s
    // window and inside the 14 m rescue radius.
    for (let t = 0; t < 8; t += 1 / 60) encounter.update(1 / 60, { x: 0, y: 0, z: 0 });
    for (let t = 0; t < 12; t += 1 / 60) encounter.update(1 / 60, { x: 28, y: 0, z: 0 });

    expect(recorder.ofType('AllyDowned')).toHaveLength(0);
    expect(encounter.allySurvived).toBe(true);
    expect(encounter.state().allyDownIn).toBeUndefined();
  });

  it('PLAYER SLOW — dawdling past the window fires AllyDowned exactly once', () => {
    const { encounter, recorder } = scene('boss.deepSeaKing', {
      ...ALLY,
      position: { ...ALLY.position },
    });
    encounter.begin(0);

    // The player clears the street first. Twenty-five seconds, never within
    // 14 m of Mumen Rider.
    run(encounter, 25, { x: -60, y: 0, z: 0 });

    const downed = recorder.ofType('AllyDowned');
    expect(downed).toHaveLength(1);
    expect(downed[0]!.entityId).toBe('mumen-rider');
    expect(downed[0]!.displayName).toBe('Mumen Rider');
    expect(downed[0]!.killerId).toBe('boss#1');
    expect(encounter.allySurvived).toBe(false);

    // And it never fires twice, however long the encounter runs.
    run(encounter, 60, { x: -60, y: 0, z: 0 });
    expect(recorder.ofType('AllyDowned')).toHaveLength(1);
  });

  it("PLAYER SLOW — the clock is the script's 18 s, to the frame", () => {
    // The beat is a WALL CLOCK the player cannot negotiate with, and its value
    // is a number in `boss-scripts.ts` rather than an emergent property of
    // anything. Asserted against the elapsed time the event was emitted at,
    // because "it fires eventually" would still pass with the clock broken.
    const { encounter, recorder } = scene('boss.deepSeaKing', {
      ...ALLY,
      position: { ...ALLY.position },
    });
    encounter.begin(0);

    const dt = 1 / 60;
    let firedAt = -1;
    for (let t = 0; t < 30; t += dt) {
      encounter.update(dt, { x: -60, y: 0, z: 0 });
      if (firedAt < 0 && recorder.ofType('AllyDowned').length > 0) firedAt = t + dt;
    }
    expect(firedAt).toBeGreaterThan(18 - dt * 2);
    expect(firedAt).toBeLessThan(18 + dt * 2);
    expect(recorder.ofType('AllyDowned')).toHaveLength(1);
  });

  it('the fight is IDENTICAL either way — the branch costs him, not the boss', () => {
    const fast = scene('boss.deepSeaKing', { ...ALLY, position: { ...ALLY.position } });
    fast.encounter.begin(0);
    for (let t = 0; t < 6; t += 1 / 60) fast.encounter.update(1 / 60, { x: 28, y: 0, z: 0 });
    driveToFinisher(fast.encounter);

    const slow = scene('boss.deepSeaKing', { ...ALLY, position: { ...ALLY.position } });
    slow.encounter.begin(0);
    run(slow.encounter, 20, { x: -60, y: 0, z: 0 });
    driveToFinisher(slow.encounter);

    expect(fast.encounter.phaseResolved).toBe(true);
    expect(slow.encounter.phaseResolved).toBe(true);
    expect(fast.encounter.currentPhaseIndex).toBe(slow.encounter.currentPhaseIndex);
    expect(mirrorPunch(fast.target, 'normal').killed).toBe(true);
    expect(mirrorPunch(slow.target, 'normal').killed).toBe(true);
  });

  it('yields to the hero-NPC system when IT downs the ally first', () => {
    const { encounter, recorder } = scene('boss.deepSeaKing', {
      ...ALLY,
      position: { ...ALLY.position },
    });
    encounter.begin(0);
    run(encounter, 4, { x: -60, y: 0, z: 0 });

    // Mumen Rider's own health ran out at t = 4 s. The crowd workstream owns
    // that and emits its own `AllyDowned`; the script must consume it rather
    // than fire a second one fourteen seconds later.
    encounter.onAllyDowned('mumen-rider');
    run(encounter, 40, { x: -60, y: 0, z: 0 });

    expect(recorder.ofType('AllyDowned')).toHaveLength(0);
    expect(encounter.allySurvived).toBe(false);
  });

  it('ignores an AllyDowned for somebody else entirely', () => {
    const { encounter } = scene('boss.deepSeaKing', { ...ALLY, position: { ...ALLY.position } });
    encounter.begin(0);
    encounter.onAllyDowned('genos');
    run(encounter, 25, { x: -60, y: 0, z: 0 });
    expect(encounter.allySurvived).toBe(false); // the clock still ran out
  });

  it('counts down visibly while the beat is pending', () => {
    const { encounter } = scene('boss.deepSeaKing', { ...ALLY, position: { ...ALLY.position } });
    encounter.begin(0);
    run(encounter, 6, { x: -60, y: 0, z: 0 });
    const remaining = encounter.state().allyDownIn;
    expect(remaining).toBeDefined();
    expect(remaining!).toBeGreaterThan(11);
    expect(remaining!).toBeLessThan(13);
  });

  it('reaches the finisher when the host registered NO ally at all', () => {
    // `ally` is optional, and `MonsterSystem.startBossEncounter` defaults its
    // options bag to `{}`. `tickAllyBeat` bails out immediately with no ally,
    // so the phase-0 beat could never be consumed and `canAdvance` returned
    // false for ever: the encounter pinned at phase 0, the gate stuck CLOSED,
    // and the player left punching an immortal boss until the 240 s stall
    // guard force-advanced it. Four minutes is not a fallback, it is the bug.
    const { encounter, recorder } = scene('boss.deepSeaKing');
    encounter.begin(0);
    driveToFinisher(encounter);

    expect(encounter.phaseResolved).toBe(true);
    expect(encounter.currentPhaseIndex).toBe(encounter.script.phases.length - 1);
    expect(encounter.stallTrips).toBe(0);
    expect(encounter.duration).toBeLessThan(PHASE_STALL_SECONDS);
    expect(recorder.ofType('AllyDowned')).toHaveLength(0);
    expect(encounter.state().allyDownIn).toBeUndefined();
  });

  it('runs the ally clock on WALL time, not on engaged time', () => {
    // The whole point: standing 400 m away does not pause somebody else's
    // death. Every other phase condition pauses; this one does not.
    const { encounter, recorder } = scene('boss.deepSeaKing', {
      ...ALLY,
      position: { ...ALLY.position },
    });
    encounter.begin(0);
    run(encounter, 20, { x: 900, y: 0, z: 900 });
    expect(recorder.ofType('AllyDowned')).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The ally beat is per phase                                                 */
/* -------------------------------------------------------------------------- */

describe('a script with more than one ally beat', () => {
  /** A phase row, for scripts that exist only in this file. */
  function rescue(id: string, downAt: number): IBossPhase {
    return {
      id,
      kind: 'rescue',
      title: id,
      durationSeconds: 0,
      hitsToAdvance: 0,
      engageRadiusMetres: 500,
      pulsePeriodSeconds: 0,
      pulseRangeMetres: 0,
      pulseHalfAngleRad: Math.PI,
      pulsePower: 0,
      allyDownAtSeconds: downAt,
      allyRescueRadiusMetres: 14,
    };
  }

  const TWO_BEATS: IBossScript = Object.freeze({
    encounterId: 'test.twoRescues',
    archetypeId: 'boss.deepSeaKing',
    title: 'Two Rescues',
    arenaRadiusMetres: 90,
    tests: 'Two ally beats in one script — the per-phase reset.',
    phases: Object.freeze([
      rescue('first', 5),
      rescue('second', 5),
      rescue('third', 5),
      { ...rescue('done', 5), kind: 'finisher' as const, allyDownAtSeconds: undefined },
    ]),
  });

  it('re-arms a resolved beat for the next phase, but never for a fallen ally', () => {
    // `allyBeatConsumed` was declared once and reset nowhere, unlike every
    // other per-phase accumulator. The moment a script carried a second rescue
    // beat it would be silently pre-consumed: no `AllyDowned`, no HUD
    // countdown, and `canAdvance` waving straight through a phase that was
    // supposed to be about somebody's life. The module advertises exactly this
    // kind of data-only edit as safe.
    const recorder = recordingBus();
    const ally = { id: 'mumen-rider', displayName: 'Mumen Rider', position: { x: 30, y: 0, z: 0 } };
    const boss = makeBrain(TWO_BEATS.archetypeId, recorder.bus, ORIGIN, 'boss#1');
    const encounter = new BossEncounter({
      bus: recorder.bus,
      script: TWO_BEATS,
      boss,
      rng: createRng('two-beats'),
      ally,
    });
    encounter.begin(0);

    // Phase 0: the player is standing on the ally, so the beat resolves as a
    // RESCUE on the first frame and the phase (0 s, 0 hits) advances.
    encounter.update(1 / 60, { x: 28, y: 0, z: 0 });
    expect(encounter.currentPhaseIndex).toBe(1);
    expect(encounter.allySurvived).toBe(true);

    // Phase 1 carries its own beat, and it must be pending again — this is the
    // assertion the un-reset flag failed.
    expect(encounter.state().allyDownIn).toBeGreaterThan(0);
    run(encounter, 6, { x: -300, y: 0, z: 0 });
    expect(recorder.ofType('AllyDowned')).toHaveLength(1);
    expect(encounter.allySurvived).toBe(false);

    // Phase 2 carries one too — but Mumen Rider is already down and a fallen
    // ally cannot fall twice, so it resolves on entry and the script runs on
    // instead of arming a beat nobody is left to lose.
    run(encounter, 20, { x: -300, y: 0, z: 0 });
    expect(recorder.ofType('AllyDowned')).toHaveLength(1);
    expect(encounter.allySurvived).toBe(false);
    expect(encounter.currentPhaseIndex).toBe(TWO_BEATS.phases.length - 1);
    expect(encounter.phaseResolved).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('produces an identical event stream from an identical seed and script', () => {
    const replay = (): string => {
      const { encounter, recorder } = scene('boss.boros');
      encounter.begin(0);
      driveToFinisher(encounter);
      return JSON.stringify(recorder.events.map((e) => ({ ...e, time: 0, frame: 0 })));
    };
    expect(replay()).toBe(replay());
  });
});

/* -------------------------------------------------------------------------- */
/* Helper                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Feed an encounter exactly what its phases ask for until the gate opens.
 *
 * Deliberately generic: it reads the script rather than hard-coding a
 * sequence, so adding a phase to any boss cannot make this helper silently
 * stop reaching the finisher.
 */
function driveToFinisher(encounter: BossEncounter): void {
  const script = encounter.script;
  let guard = 0;
  while (!encounter.phaseResolved && guard++ < 200) {
    const phase = script.phases[encounter.currentPhaseIndex]!;
    run(encounter, Math.max(0.5, phase.durationSeconds + 0.5));
    for (let i = encounter.state().hits; i < phase.hitsToAdvance; i++) encounter.onBossHit();
    if (phase.requireSummonsCleared === true) {
      for (let i = 0; i < (phase.summonCount ?? 0); i++) encounter.onMonsterKilled(`summon#${i}`);
    }
    run(encounter, 0.5);
  }
}
