/**
 * THE SYSTEM, END TO END
 *
 * One owner, one subscription set, one tick — checked against the bus rather
 * than against internal state wherever possible, because the bus is the only
 * thing the rest of the game can actually see.
 */

import { describe, expect, it } from 'vitest';
import { MonsterSystem } from '../monster-system';
import { monsterArchetype } from '../archetypes';
import { mirrorPunch, makeTarget, recordingBus, type IMirrorTarget } from './fixtures';
import type { IMonsterTarget, Vec3 } from '../types';

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

function system(seed = 'system-test', overrides: Record<string, unknown> = {}) {
  const recorder = recordingBus();
  const monsters = new MonsterSystem({ bus: recorder.bus, seed, ...overrides });
  return { recorder, monsters };
}

function run(
  monsters: MonsterSystem,
  seconds: number,
  targets: readonly IMonsterTarget[] = [],
  focus: Vec3 = ORIGIN,
  dt = 1 / 30
): void {
  let time = 0;
  for (let t = 0; t < seconds; t += dt) {
    time += dt;
    monsters.update(dt, { time, focus, targets });
  }
}

/** Turn a live monster into the mirrored combat target the resolver would see. */
function combatTargetFor(monsters: MonsterSystem, id: string): IMirrorTarget {
  const descriptor = monsters.describeForCombat().find((d) => d.id === id)!;
  const monster = monsters.get(id)!;
  return {
    isBoss: descriptor.isBoss,
    get phaseResolved(): boolean {
      return monster.brain.phaseResolved;
    },
    set phaseResolved(value: boolean) {
      monster.brain.phaseResolved = value;
    },
    get health(): number {
      return monster.brain.health;
    },
    set health(value: number) {
      monster.brain.health = value;
    },
    dead: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

describe('lifecycle', () => {
  it('populates the world from the director and keeps it inside budget', () => {
    const { monsters } = system('populate');
    run(monsters, 400, [], ORIGIN, 0.5);
    expect(monsters.count).toBeGreaterThan(0);
    expect(monsters.count).toBeLessThanOrEqual(monsters.director.policy.maxActive + 2);
    for (const snapshot of monsters.snapshots()) {
      expect(Number.isFinite(snapshot.position.x)).toBe(true);
    }
  });

  it('kills a monster off the bus and sweeps the corpse afterwards', () => {
    const { recorder, monsters } = system('kill', { corpseSeconds: 2 });
    const monster = monsters.spawn(monsterArchetype('mob.tiger.brute'), ORIGIN);

    recorder.bus.emit('EntityKilled', {
      entityId: monster.id,
      entityType: 'monster',
      faction: 'monster',
      position: ORIGIN,
      intent: 'normal',
      rewardPoints: 18,
      threatTier: 'tiger',
    });
    expect(monster.isDead).toBe(true);
    expect(monsters.get(monster.id)).toBeDefined();

    run(monsters, 3, [], ORIGIN, 0.5);
    expect(monsters.get(monster.id)).toBeUndefined();
  });

  it('staggers a monster off EntityDamaged', () => {
    const { recorder, monsters } = system('damage');
    const monster = monsters.spawn(monsterArchetype('mob.tiger.brute'), ORIGIN);
    const player = makeTarget('player', 0, 24);
    run(monsters, 2, [player]);
    expect(monster.brain.state).toBe('pursue');

    recorder.bus.emit('EntityDamaged', {
      entityId: monster.id,
      entityType: 'monster',
      faction: 'monster',
      amount: monster.maxHealth * 0.5,
      damageType: 'blunt',
      intent: 'normal',
      healthRemaining: monster.maxHealth * 0.5,
      maxHealth: monster.maxHealth,
      point: ORIGIN,
      critical: false,
    });
    expect(monster.brain.state).toBe('stagger');
  });

  it('wakes the district when something goes off nearby', () => {
    const { recorder, monsters } = system('wake');
    const monster = monsters.spawn(monsterArchetype('mob.demon.howler'), ORIGIN);
    expect(monster.brain.state).toBe('idle');

    recorder.bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 0, z: 60 },
      direction: { x: 0, y: 0, z: 1 },
      power: 2.5e6,
      range: 180,
      angle: 0.4,
      intent: 'full',
      punchKind: 'serious',
      sourceId: 'player',
    });
    expect(monster.brain.state).toBe('alerted');
  });

  it('does not let monsters alert each other with their own noise', () => {
    const { recorder, monsters } = system('self-noise');
    const a = monsters.spawn(monsterArchetype('mob.demon.howler'), ORIGIN);
    recorder.bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 0, z: 20 },
      direction: { x: 0, y: 0, z: 1 },
      power: 1e5,
      range: 30,
      angle: 0.4,
      intent: 'serious',
      punchKind: 'environmental',
      sourceId: a.id,
    });
    expect(a.brain.state).toBe('idle');
  });

  it('announces an open-world wave once, when it actually engages', () => {
    const { recorder, monsters } = system('announce');
    monsters.director.setPacing('peak');
    run(monsters, 2, [], ORIGIN, 0.5);
    expect(recorder.ofType('EncounterStarted')).toHaveLength(0);

    // Put the player directly in front of whatever spawned — the director
    // faces every spawn at the focus, so "in front" is along its yaw. One
    // announcement, not one per monster and not one per frame.
    const first = monsters.all()[0]!;
    const ahead = {
      x: first.brain.position.x + Math.sin(first.brain.yaw) * 4,
      y: 0,
      z: first.brain.position.z + Math.cos(first.brain.yaw) * 4,
    };
    const player = makeTarget('player', ahead.x, ahead.z);
    run(monsters, 6, [player], ahead, 0.25);
    const started = recorder.ofType('EncounterStarted');
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(started[0]!.isBoss).toBe(false);
    expect(started[0]!.encounterId).toMatch(/^wave\./);
    const ids = started.map((e) => e.encounterId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('unsubscribes everything on dispose', () => {
    const { recorder, monsters } = system('dispose');
    monsters.spawn(monsterArchetype('mob.wolf.pest'), ORIGIN);
    expect(recorder.bus.listenerCount('EntityKilled')).toBe(1);
    monsters.dispose();
    for (const type of [
      'EntityKilled',
      'EntityDamaged',
      'ShockwaveFired',
      'AllyDowned',
      'EncounterEnded',
    ] as const) {
      expect(recorder.bus.listenerCount(type), type).toBe(0);
    }
    expect(monsters.count).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* THE GATE, through the system                                               */
/* -------------------------------------------------------------------------- */

describe('the phase gate, through the system', () => {
  it('gates the boss and frees every mook, in the same world at the same time', () => {
    const { monsters } = system('gate');
    monsters.startBossEncounter('boss.boros', ORIGIN);
    const boss = monsters.boss!;
    const mook = monsters.spawn(monsterArchetype('mob.dragon.leviathan'), { x: 20, y: 0, z: 0 });

    expect(monsters.isPhaseResolved(boss.id)).toBe(false);
    expect(monsters.isPhaseResolved(mook.id)).toBe(true);

    // A dragon-tier mook and a dragon-tier boss, one punch each.
    expect(mirrorPunch(combatTargetFor(monsters, mook.id), 'normal').killed).toBe(true);
    expect(mirrorPunch(combatTargetFor(monsters, boss.id), 'normal').phaseGated).toBe(true);
  });

  it('reports the gate to combat in the field combat reads', () => {
    const { monsters } = system('describe');
    monsters.startBossEncounter('boss.vaccineMan', ORIGIN);
    const boss = monsters.boss!;

    const before = monsters.describeForCombat().find((d) => d.id === boss.id)!;
    expect(before.phaseResolved).toBe(false);
    expect(before.isBoss).toBe(true);
    expect(before.specId).toBe('boss.vaccineMan');
    expect(before.threatTier).toBe('demon');

    boss.brain.phaseResolved = true;
    const after = monsters.describeForCombat().find((d) => d.id === boss.id)!;
    expect(after.phaseResolved).toBe(true);
  });

  it('places the swarm as scripted minions the director cannot touch', () => {
    const { monsters } = system('swarm');
    monsters.startBossEncounter('boss.mosquitoGirl', ORIGIN);
    expect(monsters.activeEncounter!.summonsAlive).toBe(14);
    const minions = monsters.all().filter((m) => m.archetype.id === 'mob.swarm.mosquito');
    expect(minions).toHaveLength(14);
    for (const minion of minions) {
      expect(minion.scripted).toBe(true);
      // Every one of them dies to a single punch. Fourteen punches, or one
      // serious punch and the block.
      expect(monsters.isPhaseResolved(minion.id)).toBe(true);
    }
  });

  it('counts a killed minion against the phase, through the bus', () => {
    const { recorder, monsters } = system('minion-count');
    monsters.startBossEncounter('boss.mosquitoGirl', ORIGIN);
    const minion = monsters.all().find((m) => m.archetype.id === 'mob.swarm.mosquito')!;
    recorder.bus.emit('EntityKilled', {
      entityId: minion.id,
      entityType: 'monster',
      faction: 'monster',
      position: ORIGIN,
      intent: 'normal',
      rewardPoints: 1,
      threatTier: 'wolf',
    });
    expect(monsters.activeEncounter!.summonsAlive).toBe(13);
  });

  it('suppresses open-world spawning for the duration of the encounter', () => {
    const { monsters } = system('quiet');
    monsters.director.setPacing('peak');
    monsters.startBossEncounter('boss.deepSeaKing', ORIGIN);
    const before = monsters.count;
    run(monsters, 200, [], ORIGIN, 0.5);
    // Only the boss (and its minions, of which the Deep Sea King has none).
    expect(monsters.count).toBe(before);
  });

  it('closes the encounter when combat says the fight ended', () => {
    const { recorder, monsters } = system('close');
    monsters.startBossEncounter('boss.boros', ORIGIN);
    expect(monsters.activeEncounter).toBeDefined();
    recorder.bus.emit('EncounterEnded', {
      encounterId: 'boss.boros',
      outcome: 'victory',
      duration: 42,
      civiliansLost: 0,
      collateralCost: 0,
    });
    expect(monsters.activeEncounter).toBeUndefined();
  });

  it('forwards an externally fired AllyDowned into the running script', () => {
    const { recorder, monsters } = system('ally');
    const ally = { id: 'mumen-rider', displayName: 'Mumen Rider', position: { x: 40, y: 0, z: 0 } };
    monsters.startBossEncounter('boss.deepSeaKing', ORIGIN, { ally });
    recorder.bus.emit('AllyDowned', {
      entityId: 'mumen-rider',
      displayName: 'Mumen Rider',
      position: ally.position,
    });
    expect(monsters.activeEncounter!.allySurvived).toBe(false);
    recorder.clear();
    run(monsters, 40, [], { x: -300, y: 0, z: 0 }, 0.5);
    // The script must not fire a second one eighteen seconds later.
    expect(recorder.ofType('AllyDowned')).toHaveLength(0);
  });

  it('exposes live phase state for the HUD', () => {
    const { monsters } = system('hud');
    monsters.startBossEncounter('boss.boros', ORIGIN);
    const state = monsters.phaseState()!;
    expect(state.encounterId).toBe('boss.boros');
    expect(state.phaseIndex).toBe(0);
    expect(state.title).toBe('The Arena');
    expect(state.phaseResolved).toBe(false);
    expect(state.isFinalPhase).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('replays a full session identically from the same seed', () => {
    const replay = (): string => {
      const { recorder, monsters } = system('replay-session');
      monsters.director.setPacing('build');
      const player = makeTarget('player', 0, 0);
      for (let t = 0; t < 200; t += 0.5) {
        player.position.x = Math.sin(t * 0.2) * 40;
        player.position.z = Math.cos(t * 0.2) * 40;
        monsters.update(0.5, {
          time: t,
          focus: player.position,
          targets: [player],
        });
      }
      const out = JSON.stringify({
        snapshots: monsters.snapshots(),
        events: recorder.events.map((e) => ({ ...e, time: 0, frame: 0 })),
      });
      monsters.dispose();
      return out;
    };
    expect(replay()).toBe(replay());
  });

  it('produces a different session from a different seed', () => {
    const capture = (seed: string): string => {
      const { monsters } = system(seed);
      run(monsters, 300, [], ORIGIN, 0.5);
      const out = JSON.stringify(monsters.snapshots().map((s) => s.archetypeId + s.position.x));
      monsters.dispose();
      return out;
    };
    expect(capture('alpha')).not.toBe(capture('beta'));
  });
});
