/**
 * The locomotion state machine: the transition table, the speed-driven
 * resolution and the projections onto the shared actor vocabulary.
 */

import { describe, it, expect } from 'vitest';
import {
  LocomotionStateMachine,
  PLAYER_LOCO_STATES,
  isAirborneState,
  isRecoveryState,
  resolveGroundState,
  toActorState,
  toClipName,
  type PlayerLocoState,
} from '../locomotion';
import { DEFAULT_LOCOMOTION_TUNING } from '../tuning';

const T = DEFAULT_LOCOMOTION_TUNING;

describe('transition table', () => {
  it('starts idle with no previous state', () => {
    const m = new LocomotionStateMachine();
    expect(m.current).toBe('idle');
    expect(m.previous).toBeUndefined();
    expect(m.timeInState).toBe(0);
  });

  it('allows the ground states to reach each other', () => {
    const ground: PlayerLocoState[] = ['idle', 'walk', 'run', 'dash'];
    for (const from of ground) {
      for (const to of ground) {
        if (from === to) continue;
        const m = new LocomotionStateMachine(from);
        expect(m.transition(to), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it('lets a fall become a jump — this edge IS coyote time', () => {
    const m = new LocomotionStateMachine('fall');
    expect(m.canTransition('jumpLaunch')).toBe(true);
  });

  it('refuses to cancel a cratering landing into a jump', () => {
    const m = new LocomotionStateMachine('hardLand');
    expect(m.canTransition('jumpLaunch')).toBe(false);
    expect(m.transition('jumpLaunch')).toBe(false);
    expect(m.current).toBe('hardLand');
    // …but an ordinary landing is cancellable, which is the bunny-hop.
    expect(new LocomotionStateMachine('land').canTransition('jumpLaunch')).toBe(true);
  });

  it('can always fall — the ground can be destroyed under any state', () => {
    for (const state of PLAYER_LOCO_STATES) {
      if (state === 'fall') continue;
      const m = new LocomotionStateMachine(state);
      expect(m.canTransition('fall'), `${state} -> fall`).toBe(true);
    }
  });

  it('treats a self-transition as a no-op', () => {
    const m = new LocomotionStateMachine('run');
    expect(m.transition('run')).toBe(false);
    expect(m.transitionCount).toBe(0);
  });

  it('honours force for hard resets', () => {
    const m = new LocomotionStateMachine('hardLand');
    expect(m.transition('jumpLaunch', true)).toBe(true);
    expect(m.current).toBe('jumpLaunch');
  });

  it('resets timeInState on a change and accumulates otherwise', () => {
    const m = new LocomotionStateMachine();
    m.update(0.5);
    expect(m.timeInState).toBeCloseTo(0.5, 10);
    m.transition('walk');
    expect(m.timeInState).toBe(0);
    m.update(0.25);
    expect(m.timeInState).toBeCloseTo(0.25, 10);
    expect(m.previous).toBe('idle');
  });
});

describe('hooks', () => {
  it('fires exit then enter, and unsubscribes cleanly', () => {
    const m = new LocomotionStateMachine();
    const order: string[] = [];
    const offExit = m.onExit('idle', () => order.push('exit idle'));
    m.onEnter('walk', () => order.push('enter walk'));
    m.transition('walk');
    expect(order).toEqual(['exit idle', 'enter walk']);

    offExit();
    m.transition('idle');
    order.length = 0;
    m.transition('walk');
    expect(order).toEqual(['enter walk']);
  });

  it('survives a hook that unsubscribes during dispatch', () => {
    const m = new LocomotionStateMachine();
    const seen: string[] = [];
    const off: (() => void) | undefined = m.onEnter('walk', () => {
      seen.push('a');
      off?.();
    });
    m.onEnter('walk', () => seen.push('b'));
    expect(() => m.transition('walk')).not.toThrow();
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('speed-driven resolution', () => {
  it('reads idle below the threshold whatever the stick says', () => {
    expect(resolveGroundState(T, 0, true)).toBe('idle');
    expect(resolveGroundState(T, T.idleSpeedThreshold, true)).toBe('idle');
  });

  it('separates walk from run at the run threshold', () => {
    expect(resolveGroundState(T, T.runSpeedThreshold - 0.01, false)).toBe('walk');
    expect(resolveGroundState(T, T.runSpeedThreshold, false)).toBe('run');
    expect(resolveGroundState(T, T.runSpeed, false)).toBe('run');
  });

  it('reads dash whenever the dash action is driving actual motion', () => {
    expect(resolveGroundState(T, 1, true)).toBe('dash');
    expect(resolveGroundState(T, T.dashSpeed, true)).toBe('dash');
  });
});

describe('projections', () => {
  it('maps every state onto an actor state and a clip', () => {
    for (const state of PLAYER_LOCO_STATES) {
      expect(typeof toActorState(state)).toBe('string');
      expect(typeof toClipName(state)).toBe('string');
    }
    expect(toActorState('dash')).toBe('sprint');
    expect(toActorState('hardLand')).toBe('land');
    expect(toClipName('jumpLaunch')).toBe('jump');
  });

  it('classifies airborne and recovery states', () => {
    expect(isAirborneState('jumpLaunch')).toBe(true);
    expect(isAirborneState('fall')).toBe(true);
    expect(isAirborneState('run')).toBe(false);
    expect(isRecoveryState('land')).toBe(true);
    expect(isRecoveryState('hardLand')).toBe(true);
    expect(isRecoveryState('idle')).toBe(false);
  });
});
