/**
 * THE STATE MACHINE, PROVED RATHER THAN DESCRIBED
 *
 * "The FSM cannot deadlock" is a claim about a data structure, so it is
 * checked against the data structure — every state reachable, every non-dead
 * state exitable, `dead` reachable from everywhere, every transient state
 * watchdogged — and then fuzzed with ten thousand random transitions to catch
 * anything the static analysis cannot see.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '@/util';
import {
  MonsterFsm,
  MONSTER_STATE_FALLBACK,
  MONSTER_STATE_TIMEOUT_SECONDS,
  MONSTER_TRANSITIONS,
  analyseTransitionTable,
  reachableFrom,
} from '../fsm';
import { MONSTER_STATES, type MonsterState } from '../types';

describe('transition table', () => {
  it('is sound: no dead ends, nothing unreachable, death always available', () => {
    expect(analyseTransitionTable()).toEqual([]);
  });

  it('covers every state exactly once with no strays', () => {
    expect(Object.keys(MONSTER_TRANSITIONS).sort()).toEqual([...MONSTER_STATES].sort());
    for (const state of MONSTER_STATES) {
      for (const next of MONSTER_TRANSITIONS[state]) {
        expect(MONSTER_STATES).toContain(next);
      }
      // No self-loops in the table: re-entry is handled explicitly by
      // MONSTER_SELF_TRANSITIONS so it can never be an accident.
      expect(MONSTER_TRANSITIONS[state]).not.toContain(state);
    }
  });

  it('makes every state reachable from idle', () => {
    const reachable = reachableFrom('idle');
    for (const state of MONSTER_STATES) expect(reachable.has(state)).toBe(true);
  });

  it('makes `dead` an absorbing state and the only one', () => {
    expect(MONSTER_TRANSITIONS.dead).toHaveLength(0);
    for (const state of MONSTER_STATES) {
      if (state === 'dead') continue;
      expect(MONSTER_TRANSITIONS[state].length).toBeGreaterThan(0);
    }
  });

  it('never lets a stagger flow straight back into an attack', () => {
    // A stagger that ends in a swing is not a stagger. This is the one edge
    // the machine deliberately withholds, so it is asserted rather than
    // trusted to the table's shape.
    expect(MONSTER_TRANSITIONS.stagger).not.toContain('attack');
  });
});

describe('watchdog', () => {
  it('gives every transient state a finite timeout and a legal fallback', () => {
    for (const state of MONSTER_STATES) {
      if (state === 'idle' || state === 'dead') continue;
      const limit = MONSTER_STATE_TIMEOUT_SECONDS[state];
      expect(Number.isFinite(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
      const fallback = MONSTER_STATE_FALLBACK[state];
      expect(MONSTER_TRANSITIONS[state]).toContain(fallback);
    }
  });

  it('rescues a machine parked in a transient state', () => {
    const fsm = new MonsterFsm('idle');
    fsm.transition('alerted');
    for (let i = 0; i < 200; i++) fsm.update(0.1);
    expect(fsm.current).not.toBe('alerted');
    expect(fsm.watchdogTrips).toBeGreaterThan(0);
  });

  it('leaves an idler alone forever — idling is not a deadlock', () => {
    const fsm = new MonsterFsm('idle');
    for (let i = 0; i < 10_000; i++) fsm.update(0.1);
    expect(fsm.current).toBe('idle');
    expect(fsm.watchdogTrips).toBe(0);
  });
});

describe('transitions', () => {
  it('refuses illegal edges and permits legal ones', () => {
    const fsm = new MonsterFsm('idle');
    expect(fsm.transition('attack')).toBe(false);
    expect(fsm.current).toBe('idle');
    expect(fsm.transition('alerted')).toBe(true);
    expect(fsm.transition('pursue')).toBe(true);
    expect(fsm.transition('attack')).toBe(true);
  });

  it('allows re-entry into attack and nowhere else', () => {
    const fsm = new MonsterFsm('idle');
    fsm.transition('alerted');
    fsm.transition('pursue');
    fsm.transition('attack');
    fsm.update(0.5);
    expect(fsm.timeInState).toBeCloseTo(0.5, 6);
    expect(fsm.transition('attack')).toBe(true);
    expect(fsm.timeInState).toBe(0);
    expect(fsm.transition('pursue')).toBe(true);
    expect(fsm.transition('pursue')).toBe(false);
  });

  it('lets death arrive from any state, because it can', () => {
    for (const state of MONSTER_STATES) {
      if (state === 'dead') continue;
      const fsm = new MonsterFsm(state);
      expect(fsm.transition('dead', true)).toBe(true);
      expect(fsm.current).toBe('dead');
    }
  });

  it('fires enter and exit listeners in subscription order', () => {
    const fsm = new MonsterFsm('idle');
    const log: string[] = [];
    fsm.onExit('idle', () => log.push('exit-idle-1'));
    fsm.onExit('idle', () => log.push('exit-idle-2'));
    fsm.onEnter('alerted', () => log.push('enter-alerted'));
    fsm.transition('alerted');
    expect(log).toEqual(['exit-idle-1', 'exit-idle-2', 'enter-alerted']);
  });

  it('survives a listener that transitions the machine underneath it', () => {
    const fsm = new MonsterFsm('idle');
    fsm.onEnter('alerted', () => {
      fsm.transition('pursue');
    });
    expect(() => fsm.transition('alerted')).not.toThrow();
    expect(fsm.current).toBe('pursue');
  });

  it('keeps listeners across a pool reset', () => {
    const fsm = new MonsterFsm('idle');
    let entered = 0;
    fsm.onEnter('alerted', () => entered++);
    fsm.transition('alerted');
    fsm.transition('dead', true);
    fsm.reset();
    fsm.transition('alerted');
    expect(entered).toBe(2);
  });
});

describe('fuzz', () => {
  it('never deadlocks and never leaves a valid state, over 10k random steps', () => {
    const rng = createRng('fsm-fuzz');
    const fsm = new MonsterFsm('idle');
    const visited = new Set<MonsterState>(['idle']);

    for (let step = 0; step < 10_000; step++) {
      fsm.update(rng.range(0.001, 0.4));
      expect(MONSTER_STATES).toContain(fsm.current);
      visited.add(fsm.current);

      // Random requests, most of them illegal. The machine must reject rather
      // than corrupt, and every legal request must land.
      const requested = rng.pick(MONSTER_STATES);
      const allowed = fsm.canTransition(requested);
      const result = fsm.transition(requested);
      expect(result).toBe(allowed);
      visited.add(fsm.current);

      // Once dead, resurrect through the pool path only, so the fuzz keeps
      // exercising the live states rather than parking in the absorbing one.
      if (fsm.current === 'dead') fsm.reset();
    }

    for (const state of MONSTER_STATES) expect(visited.has(state)).toBe(true);
  });

  it('never exceeds a transient timeout by more than one tick', () => {
    const rng = createRng('fsm-timeout');
    const fsm = new MonsterFsm('idle');
    let maxOvershoot = 0;

    for (let step = 0; step < 5000; step++) {
      const dt = rng.range(0.001, 0.5);
      const before = fsm.current;
      fsm.update(dt);
      const limit = MONSTER_STATE_TIMEOUT_SECONDS[before];
      if (Number.isFinite(limit) && fsm.current === before) {
        maxOvershoot = Math.max(maxOvershoot, fsm.timeInState - limit);
      }
      if (rng.bool(0.05)) {
        const requested = rng.pick(MONSTER_STATES);
        if (fsm.canTransition(requested)) fsm.transition(requested);
      }
      if (fsm.current === 'dead') fsm.reset();
    }
    expect(maxOvershoot).toBeLessThanOrEqual(0);
  });
});
