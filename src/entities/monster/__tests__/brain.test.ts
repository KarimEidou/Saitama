/**
 * THE BRAIN
 *
 * Perception, the attack timeline, staggering, steering, and the one thing a
 * monster actually puts on the bus: a `ShockwaveFired` cone. No damage, no
 * kills, no health arithmetic of its own — combat is authoritative on all
 * three and the brain only reacts.
 */

import { describe, expect, it } from 'vitest';
import { intentForPower, punchKindForAttack } from '../brain';
import { monsterArchetype } from '../archetypes';
import { MONSTER_STATE_TIMEOUT_SECONDS } from '../fsm';
import { makeBrain, makeTarget, recordingBus } from './fixtures';
import type { IMonsterWorld } from '../types';

/** A world with a fixed target list and open ground. */
function world(targets: ReturnType<typeof makeTarget>[], time = 0): IMonsterWorld {
  return { time, targets };
}

/** Tick a brain for `seconds`, refreshing the world clock as it goes. */
function tick(
  brain: ReturnType<typeof makeBrain>,
  view: IMonsterWorld,
  seconds: number,
  dt = 1 / 60
): void {
  for (let t = 0; t < seconds; t += dt) {
    (view as { time: number }).time += dt;
    brain.update(dt, view);
  }
}

/* -------------------------------------------------------------------------- */
/* Intent ladder                                                              */
/* -------------------------------------------------------------------------- */

describe('intent from power', () => {
  it('keeps a street pest from levelling a shopfront', () => {
    // Destruction only fractures structures above `normal` intent, so a
    // wolf-tier swipe has to read as `normal` or every missed jab takes a wall.
    expect(intentForPower(60)).toBe('normal');
    expect(intentForPower(900)).toBe('normal');
    expect(intentForPower(2600)).toBe('serious');
    expect(intentForPower(52000)).toBe('serious');
    expect(intentForPower(180000)).toBe('full');
    expect(intentForPower(1.4e6)).toBe('full');
  });

  it('rises monotonically with the archetype table', () => {
    const power = (id: string, attack: string): number =>
      monsterArchetype(id).attacks.find((a) => a.id === attack)!.wavePower;
    expect(intentForPower(power('mob.wolf.pest', 'swipe'))).toBe('normal');
    expect(intentForPower(power('mob.demon.carapace', 'sweep'))).toBe('serious');
    expect(intentForPower(power('boss.boros', 'collapsing-star'))).toBe('full');
  });

  it('routes a beam to the blast voice rather than to a fist', () => {
    const boros = monsterArchetype('boss.boros');
    expect(punchKindForAttack(boros.attacks.find((a) => a.id === 'collapsing-star')!)).toBe(
      'environmental'
    );
    expect(punchKindForAttack(boros.attacks.find((a) => a.id === 'meteoric-burst')!)).toBe('heavy');
    expect(punchKindForAttack(boros.attacks.find((a) => a.id === 'flurry')!)).toBe('normal');
    const brute = monsterArchetype('mob.tiger.brute');
    expect(punchKindForAttack(brute.attacks.find((a) => a.id === 'slam')!)).toBe('slam');
  });
});

/* -------------------------------------------------------------------------- */
/* The state progression                                                      */
/* -------------------------------------------------------------------------- */

describe('perception and states', () => {
  it('idles with nothing to notice', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.wolf.thug', bus);
    tick(brain, world([]), 5);
    expect(brain.state).toBe('idle');
    expect(brain.currentTargetId).toBeUndefined();
  });

  it('walks idle → alerted → pursue → attack as a target closes', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.wolf.thug', bus, { x: 0, y: 0, z: 0 });
    const player = makeTarget('player', 0, 15); // straight ahead, inside 22 m aggro
    const view = world([player]);

    tick(brain, view, 0.2);
    expect(brain.state).toBe('alerted');

    tick(brain, view, 1);
    expect(brain.state).toBe('pursue');

    tick(brain, view, 12);
    expect(brain.state).toBe('attack');
    expect(brain.currentTargetId).toBe('player');
  });

  it('ignores anything outside the aggro radius', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.wolf.thug', bus);
    tick(brain, world([makeTarget('player', 0, 200)]), 3);
    expect(brain.state).toBe('idle');
  });

  it('ignores other monsters entirely', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus);
    tick(brain, world([makeTarget('other', 0, 6, { faction: 'monster' })]), 3);
    expect(brain.state).toBe('idle');
  });

  it('gives up and returns to idle once memory expires', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.wolf.thug', bus);
    const player = makeTarget('player', 0, 12);
    const view = world([player]);
    tick(brain, view, 2);
    expect(brain.state).toBe('pursue');

    player.alive = false;
    tick(brain, view, brain.archetype.memorySeconds * 2 + 4);
    expect(brain.currentTargetId).toBeUndefined();
    expect(brain.state).toBe('idle');
  });

  it('prefers a high-priority ally over a closer civilian', () => {
    // This is how Mumen Rider ends up in front of the Deep Sea King without a
    // single line of script saying so.
    const { bus } = recordingBus();
    const brain = makeBrain('boss.deepSeaKing', bus);
    const civilian = makeTarget('civ', 0, 6, { faction: 'civilian', priority: 1 });
    const ally = makeTarget('mumen', 0, 18, { faction: 'hero', priority: 6 });
    tick(brain, world([civilian, ally]), 1);
    expect(brain.currentTargetId).toBe('mumen');
  });

  it('respects an injected line-of-sight test', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.wolf.thug', bus);
    const blind: IMonsterWorld = {
      time: 0,
      targets: [makeTarget('player', 0, 10)],
      lineOfSight: () => false,
    };
    tick(brain, blind, 3);
    expect(brain.state).toBe('idle');
  });

  it('forgets a target it cannot see, even while it is still well inside range', () => {
    // The incumbent skips both the "noticed" test and the line-of-sight test,
    // so a target behind a building anywhere inside `loseAggroMetres` stayed
    // the selected candidate for ever and the memory clock was compared
    // against nothing. `perceive` pets the `pursue` watchdog on every think and
    // the director never culls an engaged monster, so the lock was permanent:
    // a monster swinging at the spot it last saw somebody, all session.
    const { bus } = recordingBus();
    const brain = makeBrain('mob.wolf.thug', bus, { x: 0, y: 0, z: 0 }, 'thug#blocked');
    const player = makeTarget('player', 0, 12);
    let visible = true;
    const view: IMonsterWorld = { time: 0, targets: [player], lineOfSight: () => visible };

    tick(brain, view, 2);
    expect(brain.currentTargetId).toBe('player');

    // He steps behind a building at 20 m — half the 39.6 m retention radius,
    // so the scan still offers him every think.
    visible = false;
    player.position.z = 20;
    expect(20).toBeLessThan(brain.archetype.loseAggroMetres);

    tick(brain, view, brain.archetype.memorySeconds + 2);
    expect(brain.currentTargetId).toBeUndefined();
    expect(brain.state).not.toBe('pursue');
    expect(brain.fsm.watchdogTrips).toBe(0);
  });

  it('waits out its whole memory in `alerted` without tripping the watchdog', () => {
    // `notice` is how a shockwave wakes a district, and it produces an
    // `alerted` monster with NO target. Eight of the fourteen archetypes then
    // wait longer than the 8 s `alerted` watchdog allows, so every distant
    // explosion used to force-transition a stalker, a leviathan or a boss —
    // truncating the archetype's advertised memory AND poisoning
    // `watchdogTrips`, whose whole job is to surface a real brain bug.
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.stalker', bus, { x: 0, y: 0, z: 0 }, 'stalker#alerted');
    const memory = brain.archetype.memorySeconds;
    expect(memory).toBeGreaterThan(MONSTER_STATE_TIMEOUT_SECONDS.alerted);

    brain.notice(0, 0, 30, 1);
    expect(brain.state).toBe('alerted');

    tick(brain, world([]), memory - 1);
    expect(brain.state).toBe('alerted');
    expect(brain.fsm.watchdogTrips).toBe(0);

    tick(brain, world([]), 2);
    expect(brain.state).toBe('idle');
    expect(brain.fsm.watchdogTrips).toBe(0);
  });

  it('turns toward a noise it could not have seen', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.demon.howler', bus);
    expect(brain.state).toBe('idle');
    brain.notice(0, 0, 40, 1);
    expect(brain.state).toBe('alerted');
    // Out of hearing range: nothing happens.
    const quiet = makeBrain('mob.wolf.pest', bus, { x: 0, y: 0, z: 0 }, 'quiet#1');
    quiet.notice(0, 0, 5000, 1);
    expect(quiet.state).toBe('idle');
  });
});

/* -------------------------------------------------------------------------- */
/* Attacks                                                                    */
/* -------------------------------------------------------------------------- */

describe('attacks', () => {
  it('telegraphs, then releases exactly one shockwave per swing', () => {
    const recorder = recordingBus();
    const brain = makeBrain('mob.wolf.thug', recorder.bus);
    const view = world([makeTarget('player', 0, 1.2)]);

    // The wind-up is visible before anything is released.
    tick(brain, view, 0.8);
    expect(brain.state).toBe('attack');
    expect(recorder.ofType('ShockwaveFired')).toHaveLength(0);

    tick(brain, view, 0.6);
    const waves = recorder.ofType('ShockwaveFired');
    expect(waves.length).toBeGreaterThanOrEqual(1);
    const wave = waves[0]!;
    expect(wave.sourceId).toBe('mob.wolf.thug#test');
    expect(wave.intent).toBe('normal');
    expect(wave.range).toBeGreaterThan(0);
  });

  it('respects cooldowns rather than machine-gunning', () => {
    const recorder = recordingBus();
    const brain = makeBrain('mob.wolf.pest', recorder.bus);
    const view = world([makeTarget('player', 0, 1.2)]);
    tick(brain, view, 10);
    const waves = recorder.ofType('ShockwaveFired').length;
    // 10 s at a 1.1 s cooldown plus a 0.32 s wind-up: nowhere near one a frame.
    expect(waves).toBeGreaterThan(3);
    expect(waves).toBeLessThan(12);
  });

  it('lets the summoned swarm reach a target on the ground', () => {
    // The whole archetype was inert. `bite` reached 1.1 m while the movement
    // profile parks a mosquito at `hover ± bob` — 2.3 m to 4.5 m above someone
    // standing on the pavement — and attack legality is tested against the 3-D
    // distance, so its only attack failed every candidate check on every frame,
    // for every one of the fourteen a Mosquito Girl phase releases.
    const recorder = recordingBus();
    const brain = makeBrain('mob.swarm.mosquito', recorder.bus, { x: 0, y: 0, z: 0 }, 'swarm#bite');
    const view = world([makeTarget('civ-1', 0, 7, { faction: 'civilian', priority: 1 })]);
    tick(brain, view, 10);

    // Still a flyer — the fix is reach, not altitude.
    expect(brain.position.y).toBeGreaterThan(2);
    expect(recorder.ofType('ShockwaveFired').length).toBeGreaterThan(0);
  });

  it('never releases a summon without a callback to service it', () => {
    const recorder = recordingBus();
    const summoned: { archetypeId: string; count: number }[] = [];
    const brain = makeBrain('boss.mosquitoGirl', recorder.bus);
    const view = world([makeTarget('player', 0, 10)]);
    tick(brain, view, 6);
    expect(summoned).toHaveLength(0); // no callback was supplied
    // ...and the wave still went out, so audio and VFX still see the taunt.
    expect(recorder.ofType('ShockwaveFired').length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Damage reactions                                                           */
/* -------------------------------------------------------------------------- */

describe('damage', () => {
  it('staggers on an interrupting hit and recovers on its own clock', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus);
    const view = world([makeTarget('player', 0, 28)]);
    tick(brain, view, 2);
    expect(brain.state).toBe('pursue');

    const archetype = brain.archetype;
    brain.onDamaged(archetype.maxHealth * 0.5, archetype.maxHealth * 0.5);
    expect(brain.state).toBe('stagger');

    tick(brain, view, archetype.staggerSeconds + 0.5);
    expect(brain.state).not.toBe('stagger');
  });

  it('restarts the stagger on a second interrupting hit', () => {
    // Two heavy blows 0.3 s apart. The second is an interrupting hit by the
    // archetype's own threshold, so it must buy the full `staggerSeconds` —
    // the FSM used to refuse the self-transition, `onDamaged` discarded the
    // refusal, and the monster recovered 0.3 s early on the first hit's clock
    // while the second read to the player as having done nothing at all.
    const { bus } = recordingBus();
    const brain = makeBrain('mob.demon.carapace', bus, { x: 0, y: 0, z: 0 }, 'carapace#restagger');
    const view = world([makeTarget('player', 0, 28)]);
    tick(brain, view, 2);

    const archetype = brain.archetype;
    const heavy = archetype.maxHealth * archetype.staggerFraction + 1;
    brain.onDamaged(archetype.maxHealth - heavy, heavy);
    expect(brain.state).toBe('stagger');

    tick(brain, view, 0.3);
    brain.onDamaged(archetype.maxHealth - heavy * 2, heavy);
    expect(brain.state).toBe('stagger');
    expect(brain.fsm.timeInState).toBe(0);

    tick(brain, view, archetype.staggerSeconds - 0.4);
    expect(brain.state).toBe('stagger');
    tick(brain, view, 0.6);
    expect(brain.state).not.toBe('stagger');
  });

  it('shrugs off a hit below the interrupt threshold', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus);
    const view = world([makeTarget('player', 0, 28)]);
    tick(brain, view, 2);
    brain.onDamaged(brain.archetype.maxHealth - 1, 1);
    expect(brain.state).toBe('pursue');
  });

  it('dies from any state, and stays dead', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.demon.carapace', bus);
    const view = world([makeTarget('player', 0, 3)]);
    tick(brain, view, 3);
    brain.onKilled();
    expect(brain.state).toBe('dead');
    expect(brain.isDead).toBe(true);
    tick(brain, view, 30);
    expect(brain.state).toBe('dead');
    expect(brain.clip).toBe('death');
  });

  it('never decrements its own health — combat is authoritative', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.wolf.pest', bus);
    const view = world([makeTarget('player', 0, 1.2)]);
    tick(brain, view, 20);
    expect(brain.health).toBe(brain.archetype.maxHealth);
  });
});

/* -------------------------------------------------------------------------- */
/* Movement                                                                   */
/* -------------------------------------------------------------------------- */

describe('movement', () => {
  it('keeps a flyer in the air at its cruising altitude', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('boss.mosquitoGirl', bus, { x: 0, y: 0, z: 0 });
    const view = world([makeTarget('player', 0, 20)]);
    tick(brain, view, 12);
    const hover = brain.archetype.movement.hoverHeightMetres;
    const bob = brain.archetype.movement.bobAmplitudeMetres;
    expect(brain.position.y).toBeGreaterThan(hover - bob - 0.5);
    expect(brain.position.y).toBeLessThan(hover + bob + 0.5);
    // Four times the normal punch's 1.2 m reach. That is the test she IS.
    expect(hover).toBeGreaterThan(4);
  });

  it('keeps a ground monster on the ground the host describes', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus, { x: 0, y: 50, z: 0 });
    const view: IMonsterWorld = {
      time: 0,
      targets: [makeTarget('player', 0, 20)],
      groundHeight: () => 7,
    };
    tick(brain, view, 3);
    expect(brain.position.y).toBe(7);
  });

  it('closes distance when pursuing', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus, { x: 0, y: 0, z: 0 });
    const view = world([makeTarget('player', 0, 25)]);
    tick(brain, view, 4);
    expect(brain.position.z).toBeGreaterThan(3);
    expect(brain.distanceToTarget).toBeLessThan(25);
  });

  it('holds its standoff instead of shoving into the target', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('boss.vaccineMan', bus, { x: 0, y: 0, z: 0 });
    const view = world([makeTarget('player', 0, 70)]);
    tick(brain, view, 25);
    // 46 m of standoff. A gunner that closes to melee is not a gunner.
    expect(brain.distanceToTarget).toBeGreaterThan(30);
  });

  it('makes an erratic flyer wander off the straight line', () => {
    const { bus } = recordingBus();
    const straight = makeBrain('mob.tiger.brute', bus, { x: 0, y: 0, z: 0 }, 'straight#1');
    const erratic = makeBrain('mob.swarm.mosquito', bus, { x: 0, y: 0, z: 0 }, 'erratic#1');
    const view = world([makeTarget('player', 0, 40)]);
    tick(straight, view, 4);
    tick(erratic, view, 4);
    expect(Math.abs(erratic.position.x)).toBeGreaterThan(Math.abs(straight.position.x));
  });
});

/* -------------------------------------------------------------------------- */
/* Long-run stability and determinism                                         */
/* -------------------------------------------------------------------------- */

describe('stability', () => {
  it('never deadlocks or trips a watchdog over five simulated minutes', () => {
    const { bus } = recordingBus();
    for (const id of [
      'mob.wolf.pest',
      'mob.tiger.stalker',
      'mob.demon.howler',
      'mob.dragon.leviathan',
      'boss.mosquitoGirl',
    ]) {
      const brain = makeBrain(id, bus, { x: 0, y: 0, z: 0 }, `${id}#stability`);
      const player = makeTarget('player', 0, 20);
      const view = world([player]);
      for (let t = 0; t < 300; t += 1 / 30) {
        // The target wanders in and out of range, which is what actually
        // exercises the alerted/pursue/idle edges.
        player.position.z = 20 + Math.sin(t * 0.4) * 90;
        (view as { time: number }).time += 1 / 30;
        brain.update(1 / 30, view);
      }
      expect(brain.fsm.watchdogTrips, id).toBe(0);
      expect(Number.isFinite(brain.position.x), id).toBe(true);
      expect(Number.isFinite(brain.position.y), id).toBe(true);
      expect(Number.isFinite(brain.yaw), id).toBe(true);
    }
  });

  it('replays identically from an identical seed', () => {
    const replay = (): string => {
      const recorder = recordingBus();
      const brain = makeBrain('boss.mosquitoGirl', recorder.bus, { x: 0, y: 0, z: 0 }, 'replay#1');
      const player = makeTarget('player', 0, 18);
      const view = world([player]);
      for (let t = 0; t < 30; t += 1 / 60) {
        player.position.x = Math.sin(t) * 6;
        (view as { time: number }).time += 1 / 60;
        brain.update(1 / 60, view);
      }
      return JSON.stringify({
        snapshot: brain.snapshot(),
        events: recorder.events.map((e) => ({ ...e, time: 0, frame: 0 })),
      });
    };
    expect(replay()).toBe(replay());
  });

  it('comes back clean from the pool', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.demon.carapace', bus);
    tick(brain, world([makeTarget('player', 0, 5)]), 6);
    brain.onKilled();

    brain.reset({ x: 100, y: 0, z: 100 }, 1.5);
    expect(brain.state).toBe('idle');
    expect(brain.health).toBe(brain.archetype.maxHealth);
    expect(brain.currentTargetId).toBeUndefined();
    expect(brain.position.x).toBe(100);
    expect(brain.yaw).toBe(1.5);
    expect(brain.phaseResolved).toBe(true);
  });

  it('resets a boss back to GATED, never to killable', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('boss.boros', bus);
    brain.phaseResolved = true;
    brain.reset({ x: 0, y: 0, z: 0 }, 0);
    expect(brain.phaseResolved).toBe(false);
  });
});
