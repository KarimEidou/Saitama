/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  WHO A MONSTER FIGHTS — the game's only stake, asserted                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The premise is "Saitama is never in danger; the city is". Every gram of
 * tension in this game comes from people who can genuinely lose — Genos, Mumen
 * Rider, and two hundred and fifty civilians — so a monster that spends the
 * encounter swinging at the protagonist is not a difficulty problem, it is the
 * premise failing silently.
 *
 * It DID fail silently. A god-tier Harbinger was driven for sixty seconds
 * through the real path and reported:
 *
 *     lastTargetId : "player"          unchanged for the whole run
 *     Genos        : 420 → 420 HP      literally zero damage
 *     downedEvents : 0
 *     distances    : Genos 352 m, Mumen Rider 370 m from the fight
 *
 * The damage path was fine; the TARGET SELECTION was not. Two ideas fix it and
 * both are asserted below:
 *
 *   HARMABILITY  a target that cannot be hurt is worth a fraction of one that
 *                can, so an ally at thirty metres outranks the invulnerable
 *                man at ten — but not the one standing on the monster's foot,
 *                because he does get attacked in the source material.
 *   RE-TARGETING a fixation on someone unhurtable expires, on a clock and on a
 *                count of attacks that accomplished nothing. `lastTargetId`
 *                changing is the whole point.
 */

import { describe, expect, it } from 'vitest';
import { makeBrain, makeTarget, recordingBus } from './fixtures';
import type { IMonsterWorld } from '../types';

/** A world with a fixed target list and open ground. */
function world(targets: ReturnType<typeof makeTarget>[], time = 0): IMonsterWorld {
  return { time, targets };
}

/** Tick a brain, refreshing the world clock as it goes. */
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

/** Tick until `predicate` holds, returning the seconds it took (or -1). */
function tickUntil(
  brain: ReturnType<typeof makeBrain>,
  view: IMonsterWorld,
  limitSeconds: number,
  predicate: () => boolean,
  dt = 1 / 60
): number {
  for (let t = 0; t < limitSeconds; t += dt) {
    (view as { time: number }).time += dt;
    brain.update(dt, view);
    // Elapsed AFTER the step, so "true on the very first frame" reads as `dt`
    // rather than as 0 and cannot be confused with a failure.
    if (predicate()) return t + dt;
  }
  return -1;
}

/** The protagonist: an ordinary-looking hero who cannot be hurt. */
function saitama(x: number, z: number): ReturnType<typeof makeTarget> {
  return makeTarget('player', x, z, { faction: 'hero', priority: 1, harmable: false });
}

/* -------------------------------------------------------------------------- */
/* Harmability beats proximity                                                */
/* -------------------------------------------------------------------------- */

describe('a monster prefers a target it can actually hurt', () => {
  it('takes the ally at thirty metres over the invulnerable player at ten', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.god.harbinger', bus, { x: 0, y: 0, z: 0 }, 'harbinger#choice');
    const player = saitama(0, 10);
    const genos = makeTarget('hero-genos', 0, 30, { faction: 'hero', priority: 1.6 });

    tick(brain, world([player, genos]), 1);
    expect(brain.currentTargetId).toBe('hero-genos');
    expect(brain.isTargetHarmable).toBe(true);
  });

  it('takes a civilian over the player, at the same distance and lower priority', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus, { x: 0, y: 0, z: 0 }, 'brute#civ');
    const player = saitama(-3, 12);
    const civilian = makeTarget('civ-88', 3, 12, { faction: 'civilian', priority: 1 });

    tick(brain, world([player, civilian]), 1);
    expect(brain.currentTargetId).toBe('civ-88');
  });

  it('still swings at him when he is close enough to step on', () => {
    // Faithfulness, not politeness: monsters attack Saitama constantly. It has
    // simply never once worked. Zero weight would delete a beat the source
    // material is built on.
    const recorder = recordingBus();
    const brain = makeBrain('mob.tiger.brute', recorder.bus, { x: 0, y: 0, z: 0 }, 'brute#face');
    const player = saitama(0, 1.2);
    const genos = makeTarget('hero-genos', 0, 26, { faction: 'hero', priority: 1.6 });

    tick(brain, world([player, genos]), 1);
    expect(brain.currentTargetId).toBe('player');
    tick(brain, world([player, genos]), 1.5);
    expect(recorder.ofType('ShockwaveFired').length).toBeGreaterThan(0);
  });

  it('engages him perfectly normally when he is all there is', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.wolf.thug', bus, { x: 0, y: 0, z: 0 }, 'thug#alone');
    const view = world([saitama(0, 15)]);
    tick(brain, view, 2);
    expect(brain.currentTargetId).toBe('player');
    expect(['pursue', 'attack']).toContain(brain.state);
  });

  it('leaves the ally for the civilian only when the civilian is much closer', () => {
    const { bus } = recordingBus();
    const near = makeBrain('mob.demon.carapace', bus, { x: 0, y: 0, z: 0 }, 'carapace#near');
    // 1.6 priority against 1.0: the crossover sits at 1.6x the distance.
    tick(
      near,
      world([
        makeTarget('hero-genos', 0, 20, { faction: 'hero', priority: 1.6 }),
        makeTarget('civ-1', 0, 6, { faction: 'civilian', priority: 1 }),
      ]),
      1
    );
    expect(near.currentTargetId).toBe('civ-1');

    const far = makeBrain('mob.demon.carapace', bus, { x: 0, y: 0, z: 0 }, 'carapace#far');
    tick(
      far,
      world([
        makeTarget('hero-genos', 0, 12, { faction: 'hero', priority: 1.6 }),
        makeTarget('civ-1', 0, 10, { faction: 'civilian', priority: 1 }),
      ]),
      1
    );
    expect(far.currentTargetId).toBe('hero-genos');
  });
});

/* -------------------------------------------------------------------------- */
/* Peripheral awareness — and the stealth it deliberately preserves           */
/* -------------------------------------------------------------------------- */

describe('what a monster notices behind itself', () => {
  it('notices a civilian at its back — screaming is not directional', () => {
    const { bus } = recordingBus();
    // Facing +Z (yaw 0). The civilian is directly behind, well outside the
    // 65-degree cone and well outside the 2 m proximity margin.
    const brain = makeBrain('mob.tiger.brute', bus, { x: 0, y: 0, z: 0 }, 'brute#behind');
    tick(brain, world([makeTarget('civ-7', 0, -9, { faction: 'civilian', priority: 1 })]), 1);
    expect(brain.currentTargetId).toBe('civ-7');
  });

  it('does NOT notice the player at its back — walking up behind it still works', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus, { x: 0, y: 0, z: 0 }, 'brute#stealth');
    tick(brain, world([saitama(0, -9)]), 1);
    expect(brain.currentTargetId).toBeUndefined();
    expect(brain.state).toBe('idle');
  });
});

/* -------------------------------------------------------------------------- */
/* THE RE-TARGET                                                              */
/* -------------------------------------------------------------------------- */

describe('a monster gives up on a target it cannot hurt', () => {
  it('drops the player within seconds instead of locking on for a minute', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.god.harbinger', bus, { x: 0, y: 0, z: 0 }, 'harbinger#lock');
    const view = world([saitama(0, 4)]);

    // It commits first — this is a beat, not a flinch.
    tick(brain, view, 1);
    expect(brain.currentTargetId).toBe('player');

    const gaveUp = tickUntil(brain, view, 30, () => brain.currentTargetId !== 'player');
    expect(gaveUp).toBeGreaterThan(0);
    expect(gaveUp).toBeLessThan(10);
    expect(brain.retargets).toBeGreaterThanOrEqual(1);
    expect(brain.suppressedTargetId).toBe('player');
    // And it is a decision, not a crash: the machine is in a legal resting
    // state and the watchdog never had to rescue it.
    expect(brain.state).toBe('idle');
    expect(brain.fsm.watchdogTrips).toBe(0);
  });

  it('never lets `lastTargetId` sit unchanged for a minute — the reported bug', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.god.harbinger', bus, { x: 0, y: 0, z: 0 }, 'harbinger#minute');
    const view = world([saitama(0, 5)]);

    const seen: (string | undefined)[] = [];
    for (let t = 0; t < 60; t += 1 / 30) {
      (view as { time: number }).time += 1 / 30;
      brain.update(1 / 30, view);
      const id = brain.currentTargetId;
      if (seen.at(-1) !== id) seen.push(id);
    }
    // Engaged, dropped, engaged again: the lock cycles instead of welding.
    expect(seen.length).toBeGreaterThan(2);
    expect(seen).toContain('player');
    expect(seen).toContain(undefined);
    expect(brain.retargets).toBeGreaterThanOrEqual(2);
  });

  it('counts wasted ATTACKS, not just seconds', () => {
    const { bus } = recordingBus();
    // A pest swings every 1.1 s, so two futile hits land well inside the
    // five-second lock: whichever limit is reached first ends the engagement.
    const brain = makeBrain('mob.wolf.pest', bus, { x: 0, y: 0, z: 0 }, 'pest#futile');
    const view = world([saitama(0, 1.2)]);
    const gaveUp = tickUntil(brain, view, 20, () => brain.retargets > 0);
    expect(gaveUp).toBeGreaterThan(0);
    expect(gaveUp).toBeLessThan(6);
  });

  it('never picks him over the ally standing behind it', () => {
    // The exact geometry that shipped broken: at t=0 the player is the only
    // thing inside the vision cone and Mumen Rider is at the monster's back,
    // five metres from where a Harbinger was spawned next to him. Before the
    // fix that one frame decided the whole encounter.
    const { bus } = recordingBus();
    const brain = makeBrain('mob.god.harbinger', bus, { x: 0, y: 0, z: 0 }, 'harbinger#behind');
    const player = saitama(0, 6);
    const mumen = makeTarget('hero-mumenRider', 0, -14, { faction: 'hero', priority: 1.6 });

    const picked = tickUntil(
      brain,
      world([player, mumen]),
      5,
      () => brain.currentTargetId === 'hero-mumenRider'
    );
    expect(picked).toBeGreaterThan(0);
    expect(picked).toBeLessThan(1);
    // It never even engaged him, so there was nothing to give up on.
    expect(brain.retargets).toBe(0);
    expect(brain.isTargetHarmable).toBe(true);
  });

  it('switches to the ally who arrives late', () => {
    // Mumen Rider starts eighty metres out — beyond any awareness — so the
    // monster genuinely commits to the player first, gives up, and is looking
    // elsewhere by the time the bicycle gets there.
    const { bus } = recordingBus();
    const brain = makeBrain('mob.god.harbinger', bus, { x: 0, y: 0, z: 0 }, 'harbinger#late');
    const player = saitama(0, 6);
    const mumen = makeTarget('hero-mumenRider', 0, -80, { faction: 'hero', priority: 1.6 });
    const view = world([player, mumen]);

    tick(brain, view, 1);
    expect(brain.currentTargetId).toBe('player');

    let switched = -1;
    for (let t = 0; t < 30; t += 1 / 60) {
      // 6.2 m/s: Mumen Rider's own speed, on a bicycle, not retreating.
      mumen.position.z = Math.min(-4, -80 + t * 6.2);
      (view as { time: number }).time += 1 / 60;
      brain.update(1 / 60, view);
      if (switched < 0 && brain.currentTargetId === 'hero-mumenRider') switched = t;
    }
    expect(switched).toBeGreaterThan(0);
    expect(brain.retargets).toBeGreaterThanOrEqual(1);
    expect(brain.currentTargetId).toBe('hero-mumenRider');
  });

  it('comes back to him later — the suppression expires, it is not blindness', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus, { x: 0, y: 0, z: 0 }, 'brute#again');
    const view = world([saitama(0, 3)]);

    const gaveUp = tickUntil(brain, view, 20, () => brain.retargets > 0);
    expect(gaveUp).toBeGreaterThan(0);
    const cameBack = tickUntil(brain, view, 40, () => brain.currentTargetId === 'player');
    expect(cameBack).toBeGreaterThan(0);
    expect(brain.retargets).toBeGreaterThanOrEqual(1);
  });

  it('never gives up on a target it CAN hurt, however long the fight runs', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.god.harbinger', bus, { x: 0, y: 0, z: 0 }, 'harbinger#patient');
    const genos = makeTarget('hero-genos', 0, 8, { faction: 'hero', priority: 1.6 });
    tick(brain, world([genos]), 90, 1 / 30);
    expect(brain.currentTargetId).toBe('hero-genos');
    expect(brain.retargets).toBe(0);
    expect(brain.fsm.watchdogTrips).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* THE PILLAR — the fight stays where the people are                          */
/* -------------------------------------------------------------------------- */

describe('the world is what is in danger', () => {
  it('does not drag the fight away from the ally to reach the player', () => {
    // The failure, reproduced as arithmetic: the player 92 m south (where the
    // integration run's traverse left him), an ally 5 m away. Before the fix a
    // Harbinger walked to the player and the allies ended 350 m from the
    // fight. It must now still be standing next to the ally a minute later.
    const { bus } = recordingBus();
    const brain = makeBrain('mob.god.harbinger', bus, { x: 0, y: 0, z: 0 }, 'harbinger#stay');
    const player = saitama(0, -92);
    const mumen = makeTarget('hero-mumenRider', 4, 3, { faction: 'hero', priority: 1.6 });
    const view = world([player, mumen]);

    let worstDistanceToAlly = 0;
    for (let t = 0; t < 60; t += 1 / 30) {
      (view as { time: number }).time += 1 / 30;
      brain.update(1 / 30, view);
      const dx = brain.position.x - mumen.position.x;
      const dz = brain.position.z - mumen.position.z;
      worstDistanceToAlly = Math.max(worstDistanceToAlly, Math.hypot(dx, dz));
    }
    expect(brain.currentTargetId).toBe('hero-mumenRider');
    // Engagement range for the shortest attack in the set, not 350 m.
    expect(worstDistanceToAlly).toBeLessThan(20);
  });

  it('keeps threatening civilians: the cone lands on them, repeatedly', () => {
    // Civilians are the other half of the stake, and they are threatened the
    // only way this module ever threatens anything — a `ShockwaveFired` cone
    // that the crowd system resolves against the people standing in it.
    const recorder = recordingBus();
    const brain = makeBrain('mob.tiger.brute', recorder.bus, { x: 0, y: 0, z: 0 }, 'brute#crowd');
    const crowd = [
      makeTarget('civ-1', 0, 5, { faction: 'civilian', priority: 1 }),
      makeTarget('civ-2', 2, 7, { faction: 'civilian', priority: 1 }),
      makeTarget('civ-3', -3, 9, { faction: 'civilian', priority: 1 }),
    ];
    tick(brain, world([saitama(0, 2), ...crowd]), 12);

    const waves = recorder.ofType('ShockwaveFired');
    expect(waves.length).toBeGreaterThan(1);

    // At least one wave has a civilian inside its cone. Same test the crowd
    // system applies: within range, and within the half-angle.
    const covered = waves.some((wave) =>
      crowd.some((civilian) => {
        const dx = civilian.position.x - wave.origin.x;
        const dz = civilian.position.z - wave.origin.z;
        const distance = Math.hypot(dx, dz);
        if (distance > wave.range) return false;
        if (distance < 1e-3) return true;
        const dot = (dx * wave.direction.x + dz * wave.direction.z) / distance;
        return dot >= Math.cos(Math.min(wave.angle, Math.PI));
      })
    );
    expect(covered).toBe(true);
  });

  it('goes after the crowd once it has written the protagonist off', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.demon.howler', bus, { x: 0, y: 0, z: 0 }, 'howler#crowd');
    const player = saitama(0, 3);
    const civilian = makeTarget('civ-42', 0, 26, { faction: 'civilian', priority: 1 });
    const view = world([player, civilian]);
    const switched = tickUntil(brain, view, 30, () => brain.currentTargetId === 'civ-42');
    expect(switched).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism and hygiene                                                    */
/* -------------------------------------------------------------------------- */

describe('determinism of the new selection', () => {
  it('replays an identical encounter from an identical seed', () => {
    const replay = (): string => {
      const recorder = recordingBus();
      const brain = makeBrain('mob.god.harbinger', recorder.bus, { x: 0, y: 0, z: 0 }, 'replay#t');
      const player = saitama(0, 6);
      const mumen = makeTarget('hero-mumenRider', 3, -12, { faction: 'hero', priority: 1.6 });
      const civilian = makeTarget('civ-3', -8, 14, { faction: 'civilian', priority: 1 });
      const view = world([player, mumen, civilian]);
      for (let t = 0; t < 45; t += 1 / 60) {
        mumen.position.x = 3 + Math.sin(t * 0.7) * 9;
        (view as { time: number }).time += 1 / 60;
        brain.update(1 / 60, view);
      }
      return JSON.stringify({
        snapshot: brain.snapshot(),
        retargets: brain.retargets,
        events: recorder.events.map((e) => ({ ...e, time: 0, frame: 0 })),
      });
    };
    expect(replay()).toBe(replay());
  });

  it('forgets its grudges when it comes back from the pool', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus, { x: 0, y: 0, z: 0 }, 'brute#pool');
    tickUntil(brain, world([saitama(0, 3)]), 20, () => brain.retargets > 0);
    expect(brain.suppressedTargetId).toBe('player');

    brain.reset({ x: 0, y: 0, z: 0 }, 0);
    expect(brain.suppressedTargetId).toBeUndefined();
    expect(brain.retargets).toBe(0);
    expect(brain.isTargetHarmable).toBe(false); // no target at all
    // A recycled monster engages him again from a clean slate.
    tick(brain, world([saitama(0, 3)]), 1);
    expect(brain.currentTargetId).toBe('player');
  });

  it('reports harmability and re-targets in the snapshot', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.tiger.brute', bus, { x: 0, y: 0, z: 0 }, 'brute#snap');
    tick(brain, world([makeTarget('civ-9', 0, 8, { faction: 'civilian', priority: 1 })]), 1);
    const snapshot = brain.snapshot();
    expect(snapshot.targetId).toBe('civ-9');
    expect(snapshot.targetHarmable).toBe(true);
    expect(snapshot.retargets).toBe(0);
  });

  it('behaves exactly as before for a host that does not model invulnerability', () => {
    // `harmable` is optional and absent means harmable, so a caller that has
    // never heard of the field — every existing fixture — gets the old
    // proximity-and-priority behaviour and no re-targeting at all.
    const { bus } = recordingBus();
    const brain = makeBrain('mob.god.harbinger', bus, { x: 0, y: 0, z: 0 }, 'harbinger#legacy');
    const view = world([makeTarget('player', 0, 4)]);
    tick(brain, view, 40, 1 / 30);
    expect(brain.currentTargetId).toBe('player');
    expect(brain.retargets).toBe(0);
  });
});
