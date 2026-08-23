/**
 * THE SYSTEM, END TO END
 *
 * One owner, one subscription set, one tick — checked against the bus rather
 * than against internal state wherever possible, because the bus is the only
 * thing the rest of the game can actually see.
 */

import { describe, expect, it, vi } from 'vitest';
import { MAX_SCRIPTED_MINIONS, MonsterSystem } from '../monster-system';
import { MONSTER_ARCHETYPES, monsterArchetype } from '../archetypes';
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
    // The id is a wave COUNTER. The HUD's name slot is fed by `displayName`,
    // which has to be an archetype's name — without it the encounter card read
    // the tail of `wave.0` and showed the player a literal "0".
    const names = MONSTER_ARCHETYPES.map((a) => a.name);
    for (const event of started) expect(names).toContain(event.displayName);
  });

  it('ignores a malformed shockwave rather than waking the whole map', () => {
    // INFINITY is what the power guard still carries alone: `log10(Infinity)`
    // is `Infinity`, `clamp01` pins that at 1, and a full-intensity pulse wakes
    // every monster on the map. NaN is belt and braces now that `clamp01`
    // floors it at 0 and the `intensity <= 0` bail catches it. A non-finite
    // ORIGIN is worse than either and guarded on its own account: it writes NaN
    // into `lastKnown`, then into `yaw`, then into `position`, and the monster
    // is gone from the world with no way back short of `reset()`.
    const { recorder, monsters } = system('nan-wave');
    const far = monsters.spawn(monsterArchetype('mob.wolf.pest'), { x: 5000, y: 0, z: 0 });
    const wave = {
      origin: ORIGIN,
      direction: { x: 0, y: 0, z: 1 },
      range: 10,
      angle: 0.4,
      intent: 'normal' as const,
      punchKind: 'normal' as const,
      sourceId: 'player',
    };

    recorder.bus.emit('ShockwaveFired', { ...wave, power: Number.NaN });
    expect(far.brain.state).toBe('idle');

    recorder.bus.emit('ShockwaveFired', {
      ...wave,
      power: 1e6,
      origin: { x: Number.NaN, y: 0, z: 0 },
    });
    run(monsters, 1, [], ORIGIN, 0.5);
    expect(far.brain.state).toBe('idle');
    expect(Number.isFinite(far.brain.position.x)).toBe(true);
  });

  it('goes quiet after dispose instead of repopulating itself', () => {
    // The subscriptions are gone and the map is cleared, but `update` still ran
    // the director, which still issued orders, which `materialise` still turned
    // into live monsters — none of them reachable by `EntityKilled` any more,
    // so none of them could ever die or be swept.
    const { recorder, monsters } = system('disposed');
    monsters.director.setPacing('peak');
    monsters.dispose();
    run(monsters, 60, [], ORIGIN, 0.5);
    expect(monsters.count).toBe(0);
    expect(recorder.bus.listenerCount('EntityKilled')).toBe(0);
    expect(() => {
      monsters.dispose();
    }).not.toThrow();
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
/* Encounter teardown — the boss must not outlive its own script              */
/* -------------------------------------------------------------------------- */

describe('closing an encounter', () => {
  const ENDED = {
    outcome: 'fled',
    duration: 12,
    civiliansLost: 0,
    collateralCost: 0,
  } as const;

  it('releases the boss when the fight ends without a victory', () => {
    const { recorder, monsters } = system('flee');
    monsters.startBossEncounter('boss.boros', ORIGIN);
    const boss = monsters.boss!;
    expect(monsters.isPhaseResolved(boss.id)).toBe(false);

    recorder.bus.emit('EncounterEnded', { encounterId: 'boss.boros', ...ENDED });

    expect(monsters.activeEncounter).toBeUndefined();
    // The script that was going to open the gate is gone, and nothing else in
    // the game can produce `isFinalPhase: true` — so leaving it closed means a
    // 24 000-HP monster walking the city that absorbs every lethal punch for
    // the rest of the session, with no corpse timer and no recycler that can
    // see it.
    expect(monsters.isPhaseResolved(boss.id)).toBe(true);
    expect(mirrorPunch(combatTargetFor(monsters, boss.id), 'normal').killed).toBe(true);
    expect(boss.scripted).toBe(false);
    expect(recorder.ofType('BossPhaseChanged').at(-1)!.isFinalPhase).toBe(true);
  });

  it('releases it on abortEncounter, and when a second encounter opens over it', () => {
    const { monsters } = system('abort');
    monsters.startBossEncounter('boss.boros', ORIGIN);
    const first = monsters.boss!;
    monsters.abortEncounter();
    expect(monsters.activeEncounter).toBeUndefined();
    expect(monsters.isPhaseResolved(first.id)).toBe(true);
    expect(first.scripted).toBe(false);

    monsters.startBossEncounter('boss.vaccineMan', ORIGIN);
    const second = monsters.boss!;
    monsters.startBossEncounter('boss.deepSeaKing', { x: 80, y: 0, z: 0 });
    expect(monsters.boss!.id).not.toBe(second.id);
    expect(monsters.isPhaseResolved(second.id)).toBe(true);
    expect(monsters.isPhaseResolved(monsters.boss!.id)).toBe(false);
  });

  it('takes the scripted swarm with it', () => {
    const { recorder, monsters } = system('swarm-close');
    monsters.startBossEncounter('boss.mosquitoGirl', ORIGIN);
    expect(monsters.count).toBe(15); // the boss and her fourteen

    recorder.bus.emit('EncounterEnded', { encounterId: 'boss.mosquitoGirl', ...ENDED });

    // Nothing downstream can ever retire a scripted minion — the director
    // ignores them by design and they have no corpse timer — so the script
    // that placed them is the only thing that can take them away.
    expect(monsters.all().filter((m) => m.archetype.id === 'mob.swarm.mosquito')).toHaveLength(0);
    expect(monsters.count).toBe(1);
  });

  it('bounds the swarm however often the boss summons', () => {
    const { monsters } = system('swarm-cap');
    monsters.startBossEncounter('boss.mosquitoGirl', ORIGIN);
    const swarm = (): number =>
      monsters.all().filter((m) => m.archetype.id === 'mob.swarm.mosquito').length;
    expect(swarm()).toBe(14);

    // Her `summon` ATTACK runs on a 16 s cooldown for the whole encounter and
    // its minions are tracked by nothing: three or four extra volleys in a
    // leisurely fight used to leave fifty-plus permanent, inert entities, each
    // a full brain per frame, a combat target and a crowd threat.
    for (let i = 0; i < 8; i++) monsters.summon('mob.swarm.mosquito', 14, ORIGIN);
    expect(swarm()).toBeLessThanOrEqual(MAX_SCRIPTED_MINIONS);
    expect(swarm()).toBeGreaterThanOrEqual(14);
  });
});

/* -------------------------------------------------------------------------- */
/* The shared IActor / IMonster contract                                      */
/* -------------------------------------------------------------------------- */

describe('the IActor entry points', () => {
  it('despawns a monster killed through takeDamage, and says so on the bus', () => {
    const { recorder, monsters } = system('actor-damage', { corpseSeconds: 1 });
    const monster = monsters.spawn(monsterArchetype('mob.wolf.pest'), ORIGIN);

    expect(monster.takeDamage(monster.maxHealth)).toBe(monster.maxHealth);
    expect(monster.isDead).toBe(true);

    // The corpse timer is written from `EntityKilled` and from nowhere else,
    // and the director's other removal path cannot see a dead monster — so a
    // kill that published nothing left the monster ticking, holding its scene
    // node and its pooled body, and being published to combat, for ever.
    const killed = recorder.ofType('EntityKilled');
    expect(killed).toHaveLength(1);
    expect(killed[0]!.entityId).toBe(monster.id);
    expect(killed[0]!.rewardPoints).toBe(monster.archetype.rewardPoints);

    run(monsters, 2, [], ORIGIN, 0.5);
    expect(monsters.get(monster.id)).toBeUndefined();
  });

  it('counts a minion killed that way against its phase', () => {
    const { monsters } = system('actor-minion');
    monsters.startBossEncounter('boss.mosquitoGirl', ORIGIN);
    const minion = monsters.all().find((m) => m.archetype.id === 'mob.swarm.mosquito')!;
    minion.takeDamage(minion.maxHealth);
    // Otherwise `requireSummonsCleared` waits on a monster that is already
    // dead, and the phase stalls for the full 240 s guard.
    expect(monsters.activeEncounter!.summonsAlive).toBe(13);
  });

  it('refuses to kill a gated boss, whatever hits it', () => {
    const { recorder, monsters } = system('actor-gate');
    monsters.startBossEncounter('boss.deepSeaKing', ORIGIN);
    const boss = monsters.boss!;
    expect(boss.brain.phaseResolved).toBe(false);

    // An ally's attack, a collapsing girder: 9 800 damage during phase 0 used
    // to set health to 0 and call `onKilled` outright — the "boss that died at
    // 0 HP" outcome the contract says never happens.
    boss.takeDamage(1e9);
    expect(boss.isDead).toBe(false);
    expect(boss.health).toBe(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    boss.kill();
    warn.mockRestore();
    expect(boss.isDead).toBe(false);
    expect(recorder.ofType('EntityKilled')).toHaveLength(0);
    expect(monsters.activeEncounter!.finished).toBe(false);
  });

  it('reports the seconds until the next attack is actually permitted', () => {
    const { recorder, monsters } = system('cooldown');
    const monster = monsters.spawn(monsterArchetype('mob.wolf.pest'), ORIGIN);
    expect(monster.attackCooldownRemaining).toBe(0);

    // Step to just past the end of a swing's recovery. `attackPhase` is
    // undefined there but the 1.1 s cooldown is still running — precisely the
    // window the old getter reported as 0, "ready to attack".
    const player = makeTarget('player', 0, 1.2);
    let released = -1;
    for (let t = 0; t < 4; t += 1 / 60) {
      monsters.update(1 / 60, { time: t, focus: ORIGIN, targets: [player] });
      if (released < 0 && recorder.ofType('ShockwaveFired').length > 0) released = t;
      if (released >= 0 && t > released + 0.6) break;
    }
    expect(released).toBeGreaterThan(0);
    expect(monster.snapshot().attackPhase).toBeUndefined();
    expect(monster.attackCooldownRemaining).toBeGreaterThan(0);
    expect(monster.attackCooldownRemaining).toBeLessThan(monster.archetype.attackCooldown);
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
