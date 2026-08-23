/**
 * THE `IMonster` ADAPTER
 *
 * `monster.ts` is the ten per cent of this module that touches `three`: a
 * transform, a scene root, an optional pooled `ICharacterInstance`, and — the
 * part with no other way of announcing a regression — the `ActorStateView`
 * projection that maps six monster states onto the shared `ActorState`
 * vocabulary the animator and the HUD read.
 *
 * Everything here is deterministic and renderer-free. `__tests__/` is exempt
 * from the `three`-confinement rule (`imports.test.ts`), so a real `Object3D`
 * stands in for a body rather than a mock of one.
 *
 * NOT TESTED HERE: `takeDamage()`, `kill()` and the numeric contract of
 * `attackCooldownRemaining`. Those are asserted through the system, in
 * `monster-system.test.ts`, where the bus can see them.
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ActorState, ClipName, ICharacterInstance } from '@/types';
import { createRng } from '@/util';
import { ACTOR_TO_MONSTER_STATE, MONSTER_TO_ACTOR_STATE, Monster, createMonster } from '../monster';
import { monsterArchetype } from '../archetypes';
import { MONSTER_STATES } from '../types';
import type { IMonsterWorld, MonsterState } from '../types';
import { makeTarget, recordingBus } from './fixtures';

const ORIGIN = { x: 0, y: 0, z: 0 };

/** Every clip the brain can ask for, so `has()` is never the reason one is skipped. */
const ALL_CLIPS: readonly ClipName[] = [
  'idle',
  'walk',
  'run',
  'sprint',
  'attack',
  'heavyAttack',
  'hit',
  'stagger',
  'death',
  'taunt',
  'special',
];

interface IStub {
  readonly instance: ICharacterInstance;
  readonly root: THREE.Object3D;
  readonly played: { clip: ClipName; fade: number | undefined }[];
}

/**
 * A bodiless stand-in for a pooled character instance.
 *
 * Deliberately local rather than in `fixtures.ts`: every other test file in
 * this module imports those fixtures and none of them needs `three`.
 */
function stubInstance(available: readonly ClipName[] = ALL_CLIPS): IStub {
  const played: { clip: ClipName; fade: number | undefined }[] = [];
  const root = new THREE.Object3D();
  const instance = {
    root,
    animator: {
      current: undefined,
      available,
      has: (clip: ClipName): boolean => available.includes(clip),
      play: (clip: ClipName, options?: { fade?: number }): void => {
        played.push({ clip, fade: options?.fade });
      },
    },
  } as unknown as ICharacterInstance;
  return { instance, root, played };
}

/** A monster with its own recording bus and a deterministic stream. */
function monsterOf(archetypeId: string, id = `${archetypeId}#1`): Monster {
  const { bus } = recordingBus();
  return createMonster(id, monsterArchetype(archetypeId), bus, createRng(id), { ...ORIGIN });
}

function worldWith(targets: ReturnType<typeof makeTarget>[], time = 0): IMonsterWorld {
  return { time, targets };
}

/* -------------------------------------------------------------------------- */
/* The ActorState projection                                                  */
/* -------------------------------------------------------------------------- */

describe('the ActorState projection', () => {
  it('is total in one direction and honestly partial in the other', () => {
    for (const state of MONSTER_STATES) {
      expect(MONSTER_TO_ACTOR_STATE[state], state).toBeDefined();
    }
    expect(Object.keys(MONSTER_TO_ACTOR_STATE).sort()).toEqual([...MONSTER_STATES].sort());

    for (const [actor, monster] of Object.entries(ACTOR_TO_MONSTER_STATE)) {
      expect(MONSTER_STATES, actor).toContain(monster);
    }

    // The three that carry a monster vocabulary the shared contract has no
    // word for. Getting these wrong silently mis-animates every monster.
    expect(MONSTER_TO_ACTOR_STATE.alerted).toBe('idle');
    expect(MONSTER_TO_ACTOR_STATE.pursue).toBe('run');
    expect(MONSTER_TO_ACTOR_STATE.dead).toBe('death');
  });

  it('follows the brain, and reports `previous` only once there is one', () => {
    const monster = monsterOf('mob.wolf.pest');
    expect(monster.stateMachine.current).toBe('idle');
    expect(monster.stateMachine.previous).toBeUndefined();

    expect(monster.brain.fsm.transition('alerted')).toBe(true);
    expect(monster.stateMachine.current).toBe('idle'); // alerted projects to idle
    expect(monster.stateMachine.previous).toBe('idle');

    expect(monster.brain.fsm.transition('pursue')).toBe(true);
    expect(monster.stateMachine.current).toBe('run');

    monster.brain.fsm.transition('dead', true);
    expect(monster.stateMachine.current).toBe('death');
    expect(monster.stateMachine.previous).toBe('run');
  });

  it('refuses an actor state monsters do not have, rather than guessing', () => {
    const monster = monsterOf('mob.tiger.brute');
    const before = monster.brain.fsm.current;

    for (const unmapped of ['block', 'dodge', 'jump', 'fall', 'land', 'flee'] as ActorState[]) {
      expect(monster.stateMachine.transition(unmapped), unmapped).toBe(false);
      expect(monster.stateMachine.canTransition(unmapped), unmapped).toBe(false);
    }
    expect(monster.brain.fsm.current).toBe(before);

    // A no-op unsubscribe, not a thrown one — and a subscription that never
    // fires, however the brain moves.
    const cb = vi.fn();
    const offEnter = monster.stateMachine.onEnter('jump', cb);
    const offExit = monster.stateMachine.onExit('block', cb);
    monster.brain.fsm.transition('alerted');
    monster.brain.fsm.transition('pursue');
    monster.brain.fsm.transition('dead', true);
    expect(cb).not.toHaveBeenCalled();
    expect(() => {
      offEnter();
      offExit();
    }).not.toThrow();
  });

  it('routes a MAPPED actor state through the FSM table rather than around it', () => {
    const monster = monsterOf('mob.tiger.brute');
    // idle → pursue is not a legal edge, and `run` maps to `pursue`.
    expect(monster.stateMachine.canTransition('run')).toBe(false);
    expect(monster.stateMachine.transition('run')).toBe(false);
    expect(monster.brain.fsm.current).toBe('idle');

    monster.brain.fsm.transition('alerted');
    expect(monster.stateMachine.canTransition('run')).toBe(true);
    expect(monster.stateMachine.transition('run')).toBe(true);
    expect(monster.brain.fsm.current).toBe('pursue');

    // A real subscription still works, through the projection.
    const seen: MonsterState[] = [];
    monster.stateMachine.onEnter('death', () => seen.push('dead'));
    monster.brain.fsm.transition('dead', true);
    expect(seen).toEqual(['dead']);
  });

  it('leaves the clock alone — the brain owns it, and ticking twice doubles it', () => {
    const monster = monsterOf('mob.wolf.pest');
    monster.brain.fsm.update(0.5);
    const before = monster.stateMachine.timeInState;
    expect(before).toBeCloseTo(0.5, 10);
    monster.stateMachine.update(1);
    expect(monster.stateMachine.timeInState).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* The body                                                                   */
/* -------------------------------------------------------------------------- */

describe('attaching a pooled body', () => {
  it('parents it and scales it to the archetype', () => {
    const monster = monsterOf('mob.swarm.mosquito'); // scale 0.28
    const stub = stubInstance();
    monster.attach(stub.instance);

    expect(stub.root.parent).toBe(monster.root);
    expect(stub.root.scale.x).toBeCloseTo(0.28, 6);
    expect(monster.character).toBe(stub.instance);

    // Attaching the SAME instance again is a no-op, not a second child.
    monster.attach(stub.instance);
    expect(monster.root.children).toHaveLength(1);
  });

  it('detaches the previous body when a second one arrives', () => {
    const monster = monsterOf('mob.swarm.mosquito');
    const first = stubInstance();
    const second = stubInstance();
    monster.attach(first.instance);
    monster.attach(second.instance);

    expect(first.root.parent).toBeNull();
    expect(second.root.parent).toBe(monster.root);
    expect(monster.root.children).toHaveLength(1);
  });

  it('hands a pooled body back at the scale it arrived with', () => {
    // `attach` writes OUR scale onto a root the character factory owns and
    // pools. Returning a `mob.swarm.mosquito` body at 0.28 gives the next
    // caller to draw that pooled instance a quarter-size character — a
    // cross-workstream corruption the roster cannot defend against.
    const monster = monsterOf('mob.swarm.mosquito');
    const stub = stubInstance();
    monster.attach(stub.instance);
    expect(stub.root.scale.x).toBeCloseTo(0.28, 6);

    expect(monster.detach()).toBe(stub.instance);
    expect(stub.root.scale.x).toBe(1);
    expect(stub.root.parent).toBeNull();
    expect(monster.character).toBeUndefined();

    // And nothing to give back the second time.
    expect(monster.detach()).toBeUndefined();
  });

  it('restores a non-unit factory scale rather than assuming 1', () => {
    const monster = monsterOf('mob.swarm.mosquito');
    const stub = stubInstance();
    stub.root.scale.setScalar(2.5);
    monster.attach(stub.instance);
    expect(stub.root.scale.x).toBeCloseTo(0.28, 6);
    monster.detach();
    expect(stub.root.scale.x).toBeCloseTo(2.5, 6);
  });

  it('plays nothing, and throws nothing, when there is no body to play on', () => {
    const monster = monsterOf('mob.wolf.pest');
    expect(() => {
      monster.playAnimation('idle');
    }).not.toThrow();

    const stub = stubInstance(['idle', 'walk', 'run', 'attack', 'death']);
    monster.attach(stub.instance);
    monster.playAnimation('taunt'); // the animator does not have it
    expect(stub.played).toHaveLength(0);
    monster.playAnimation('idle');
    expect(stub.played).toEqual([{ clip: 'idle', fade: 0.15 }]);
  });
});

/* -------------------------------------------------------------------------- */
/* Ticking                                                                    */
/* -------------------------------------------------------------------------- */

describe('the tick', () => {
  it('drives the animator from the brain, and fades death more slowly', () => {
    const monster = monsterOf('mob.wolf.pest', 'm#anim');
    const stub = stubInstance();
    monster.attach(stub.instance);

    const world = worldWith([makeTarget('player', 0, 2)]);
    for (let i = 0; i < 60; i++) monster.tick(1 / 60, worldWith([...world.targets], i / 60));

    expect(stub.played.length).toBeGreaterThan(0);
    expect(stub.played.at(-1)!.clip).toBe(monster.brain.clip);

    // A monster snapping into a death pose in 150 ms reads as a bug, so the
    // one clip that gets a slower crossfade is the one nobody sees blend.
    monster.brain.fsm.transition('dead', true);
    monster.tick(1 / 60, world);
    expect(stub.played.at(-1)).toEqual({ clip: 'death', fade: 0.22 });
  });

  it('syncs the transform from `update(dt)` without stepping the brain', () => {
    const monster = monsterOf('mob.wolf.pest');
    monster.brain.position.x = 12.5;
    monster.brain.position.z = -3;
    const age = monster.brain.age;

    monster.update(0.5);

    expect(monster.brain.age).toBe(age); // `update` is not a tick
    expect(monster.transform.position.x).toBe(monster.brain.position.x);
    expect(monster.transform.position.z).toBe(monster.brain.position.z);
  });

  it('does not rebuild the quaternion for a monster that is not turning', () => {
    // The `yaw` setter rebuilds a quaternion AND the forward vector — four
    // transcendental calls, per monster, per frame. A corpse never turns
    // again (`MonsterBrain.update` returns early when dead) yet used to pay
    // for that for the whole `corpseSeconds` window.
    const monster = monsterOf('mob.wolf.pest', 'm#still');
    monster.brain.fsm.transition('dead', true);
    const spy = vi.spyOn(monster.transform.rotation, 'setFromAxisAngle');

    for (let i = 0; i < 60; i++) monster.tick(1 / 60, worldWith([], i / 60));

    expect(spy).not.toHaveBeenCalled();
    expect(monster.transform.yaw).toBe(monster.brain.yaw);
  });

  it('still follows the brain the moment it does turn', () => {
    const monster = monsterOf('mob.wolf.pest', 'm#turn');
    const spy = vi.spyOn(monster.transform.rotation, 'setFromAxisAngle');
    const targets = [makeTarget('player', 5, 0)];

    for (let i = 0; i < 60; i++) monster.tick(1 / 60, worldWith(targets, i / 60));

    expect(monster.brain.yaw).not.toBe(0); // it really did turn
    expect(spy).toHaveBeenCalled();
    expect(monster.transform.yaw).toBe(monster.brain.yaw);
    expect(monster.transform.forward.x).toBeCloseTo(Math.sin(monster.brain.yaw), 10);
    expect(monster.transform.forward.z).toBeCloseTo(Math.cos(monster.brain.yaw), 10);
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

describe('lifecycle', () => {
  it('is inert once disposed, and disposes idempotently', () => {
    const parent = new THREE.Object3D();
    const { bus } = recordingBus();
    const monster = new Monster({
      id: 'm#disposed',
      archetype: monsterArchetype('mob.wolf.pest'),
      bus,
      rng: createRng('m#disposed'),
      position: { ...ORIGIN },
      parent,
    });
    expect(monster.root.parent).toBe(parent);

    monster.dispose();
    expect(monster.root.parent).toBeNull();
    expect(monster.active).toBe(false);

    const age = monster.age;
    monster.tick(1, worldWith([makeTarget('player', 0, 2)]));
    expect(monster.age).toBe(age);

    expect(() => {
      monster.dispose();
    }).not.toThrow();
  });

  it('recycles back to a clean placement', () => {
    const monster = monsterOf('mob.tiger.brute', 'm#recycled');
    const stub = stubInstance();
    monster.attach(stub.instance);
    monster.age = 42;
    monster.bossPhaseIndex = 3;
    monster.target = monster;
    monster.active = false;

    monster.recycle({ x: 10, y: 1, z: -4 }, 0.75);

    expect(monster.transform.position.x).toBe(10);
    expect(monster.transform.position.y).toBe(1);
    expect(monster.transform.position.z).toBe(-4);
    expect(monster.transform.yaw).toBe(0.75);
    expect(monster.brain.yaw).toBe(0.75);
    expect(monster.age).toBe(0);
    expect(monster.active).toBe(true);
    expect(monster.target).toBeUndefined();
    expect(monster.bossPhaseIndex).toBe(0);
    expect(monster.phase).toBe(0);
    expect(monster.brain.state).toBe('idle');
  });
});

/* -------------------------------------------------------------------------- */
/* The shared contract's surface                                              */
/* -------------------------------------------------------------------------- */

describe('the IMonster surface', () => {
  it('answers identity from the archetype, which is the only source', () => {
    const archetype = monsterArchetype('mob.demon.carapace');
    const monster = monsterOf('mob.demon.carapace', 'm#id');

    expect(monster.type).toBe('monster');
    expect(monster.faction).toBe('monster');
    expect(monster.id).toBe('m#id');
    expect(monster.spec).toBe(archetype);
    expect(monster.archetype).toBe(archetype);
    expect(monster.radius).toBe(archetype.radiusMetres);
    expect(monster.animations).toBe(archetype.animations);
    expect(monster.displayName).toBe(archetype.name);
    expect(monster.isDead).toBe(false);
    expect(monster.phase).toBe(monster.bossPhaseIndex);
    expect(monster.root.name).toBe('monster:m#id');
  });

  it('keeps the deliberately inert setters inert', () => {
    const archetype = monsterArchetype('mob.tiger.brute');
    const monster = monsterOf('mob.tiger.brute');

    // A caller wanting a tougher or faster monster wants a different row in
    // the table, not a mutated instance.
    monster.maxHealth = 1;
    monster.moveSpeed = 1;
    expect(monster.maxHealth).toBe(archetype.maxHealth);
    expect(monster.moveSpeed).toBe(archetype.movement.runSpeed);

    // Cooldowns are per-attack and owned by the brain; one writable scalar
    // cannot express the set.
    monster.attackCooldownRemaining = 99;
    expect(monster.attackCooldownRemaining).toBe(monster.brain.attackCooldownRemaining);
  });

  it('writes health through to the brain, and heals up to the archetype cap', () => {
    const monster = monsterOf('mob.tiger.brute');
    monster.health = 5;
    expect(monster.brain.health).toBe(5);
    expect(monster.health).toBe(5);

    monster.heal(3);
    expect(monster.health).toBe(8);

    monster.health = monster.maxHealth - 1;
    monster.heal(1000);
    expect(monster.health).toBe(monster.maxHealth);

    monster.heal(-5); // a negative heal is not a wound
    expect(monster.health).toBe(monster.maxHealth);

    // Nothing heals a corpse.
    monster.health = 10;
    monster.brain.fsm.transition('dead', true);
    monster.heal(50);
    expect(monster.health).toBe(10);
  });

  it('forwards its snapshot straight from the brain', () => {
    const monster = monsterOf('mob.wolf.pest', 'm#snap');
    const snapshot = monster.snapshot();
    expect(snapshot.id).toBe('m#snap');
    expect(snapshot.archetypeId).toBe('mob.wolf.pest');
    expect(snapshot.state).toBe(monster.brain.state);
    expect(snapshot.clip).toBe(monster.brain.clip);
  });
});
