/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE SHARED MONSTER STATE MACHINE                                        ║
 * ║                                                                          ║
 * ║      idle → alerted → pursue → attack → stagger → dead                   ║
 * ║                                                                          ║
 * ║  ONE machine, every monster in the game. A new monster is a row in       ║
 * ║  `archetypes.ts`, never a new state and never a new branch.              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHY SIX STATES AND NOT SIXTEEN ────────────────────────────────────────
 * Every state costs a transition edge against every other state, and unwired
 * edges are where monsters get stuck: a `search` state nothing exits, a `flee`
 * state that cannot re-engage, a `summon` state with no path to `dead`. Six is
 * the smallest set that expresses "hasn't noticed / has noticed / closing /
 * swinging / interrupted / gone", and everything finer — which attack, which
 * wind-up frame, whether the flyer is climbing — is a FIELD, not a state.
 *
 * ── THE DEADLOCK GUARANTEE, AND HOW IT IS MADE RATHER THAN HOPED FOR ──────
 * Three mechanisms, all asserted in `__tests__/fsm.test.ts`:
 *
 *   1. TABLE     `MONSTER_TRANSITIONS` is total: every state has an entry,
 *                every non-`dead` state has at least one outgoing edge, every
 *                state is reachable from `idle`, and `dead` is reachable from
 *                every state.
 *   2. WATCHDOG  every transient state carries a maximum residence time and a
 *                legal fallback. A brain that forgets to transition — because
 *                its target despawned mid-wind-up, because a chunk unloaded
 *                under it, because of a bug not yet written — is pushed back
 *                to a safe state by the machine itself.
 *   3. TERMINAL  `dead` has no outgoing edges ON PURPOSE. That is an absorbing
 *                final state, not a deadlock: a dead monster is recycled by
 *                the pool, and `reset()` is the only way back, which is
 *                exactly the property a pool needs.
 *
 * Implements `IStateMachine<MonsterState>` from `@/types` so the animator, the
 * HUD and the spawner can read it through the shared contract.
 */

import type { IStateMachine } from '@/types';
import { MONSTER_STATES, type MonsterState } from './types';

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Legal transitions, exhaustively.
 *
 * Read a row as "from this state, the machine may go to". `dead` is reachable
 * from everywhere because anything can be killed at any moment — including
 * mid-wind-up, which is the single most common death in this game.
 */
export const MONSTER_TRANSITIONS: Readonly<Record<MonsterState, readonly MonsterState[]>> =
  Object.freeze({
    /** Noticed something, was hit, or died. Nothing else happens to an idler. */
    idle: Object.freeze<MonsterState[]>(['alerted', 'stagger', 'dead']),
    /** Committed to a target, gave up on it, was hit, or died. `attack` is
        reachable directly because a monster can be alerted by something
        already standing on top of it. */
    alerted: Object.freeze<MonsterState[]>(['idle', 'pursue', 'attack', 'stagger', 'dead']),
    /** Arrived, lost the target, gave up, was hit, or died. */
    pursue: Object.freeze<MonsterState[]>(['idle', 'alerted', 'attack', 'stagger', 'dead']),
    /** Target left, target lost, target gone, was hit, or died. */
    attack: Object.freeze<MonsterState[]>(['idle', 'alerted', 'pursue', 'stagger', 'dead']),
    /** Recovered into any live state, or died on the floor. Never straight
        back into `attack`: a stagger that ends in a swing is not a stagger. */
    stagger: Object.freeze<MonsterState[]>(['idle', 'alerted', 'pursue', 'dead']),
    /** Absorbing. Only `reset()` leaves, and only via the pool. */
    dead: Object.freeze<MonsterState[]>([]),
  });

/**
 * States a monster may re-enter from itself.
 *
 * Only `attack`: throwing a second swing is a genuine re-entry — the wind-up
 * restarts, the clip restarts, the timer restarts. Re-entering `pursue` or
 * `idle` would silently reset `timeInState` and quietly defeat the watchdog,
 * so those return false instead.
 */
export const MONSTER_SELF_TRANSITIONS: ReadonlySet<MonsterState> = new Set<MonsterState>([
  'attack',
]);

/* -------------------------------------------------------------------------- */
/* Watchdogs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Maximum seconds a monster may remain in each state before the machine
 * intervenes.
 *
 * `idle` and `dead` are `Infinity` and that is correct: idling forever is what
 * a monster with nothing to chase is supposed to do, and it has three
 * outgoing edges so it is not a trap. Every TRANSIENT state is finite.
 *
 * The numbers are generous — three times the longest legitimate stay — because
 * this is a safety net, not a design tool. A watchdog that fires during normal
 * play is a bug in the brain, and `MonsterFsm.watchdogTrips` counts them so it
 * shows up in the harness rather than as a monster standing very still.
 */
export const MONSTER_STATE_TIMEOUT_SECONDS: Readonly<Record<MonsterState, number>> = Object.freeze({
  idle: Number.POSITIVE_INFINITY,
  alerted: 8,
  pursue: 45,
  attack: 6,
  stagger: 12,
  dead: Number.POSITIVE_INFINITY,
});

/** Where a state goes when its watchdog fires. Must be a legal transition. */
export const MONSTER_STATE_FALLBACK: Readonly<Record<MonsterState, MonsterState>> = Object.freeze({
  idle: 'idle',
  alerted: 'idle',
  pursue: 'alerted',
  attack: 'pursue',
  stagger: 'idle',
  dead: 'dead',
});

/* -------------------------------------------------------------------------- */
/* Machine                                                                    */
/* -------------------------------------------------------------------------- */

/** Listener bookkeeping. Kept in subscription order, like the event bus. */
type Listener = () => void;

/**
 * The monster state machine.
 *
 * Cheap by construction: two string fields, a float, and two maps that are
 * only allocated when someone actually subscribes. Hundreds of these tick on a
 * phone, so it does not allocate per frame and does not close over anything.
 */
export class MonsterFsm implements IStateMachine<MonsterState> {
  private state: MonsterState;
  private prior: MonsterState | undefined;
  private elapsed = 0;

  private enterListeners: Map<MonsterState, Listener[]> | undefined;
  private exitListeners: Map<MonsterState, Listener[]> | undefined;

  /** Transitions performed, including forced ones. Diagnostics. */
  transitions = 0;
  /** Times the watchdog had to rescue this machine. Should stay 0. */
  watchdogTrips = 0;

  constructor(initial: MonsterState = 'idle') {
    this.state = initial;
  }

  get current(): MonsterState {
    return this.state;
  }

  get previous(): MonsterState | undefined {
    return this.prior;
  }

  get timeInState(): number {
    return this.elapsed;
  }

  /** True when `next` is a legal destination from the current state. */
  canTransition(next: MonsterState): boolean {
    if (next === this.state) return MONSTER_SELF_TRANSITIONS.has(next);
    return MONSTER_TRANSITIONS[this.state].includes(next);
  }

  /**
   * Request a transition.
   *
   * @param force Bypass the table. Reserved for two callers: death (which may
   *   arrive in any state, from any source, at any time) and the pool's
   *   `reset`. Everything else goes through the table, so an illegal edge
   *   fails loudly at the call site instead of quietly becoming legal.
   * @returns false when the transition was refused.
   */
  transition(next: MonsterState, force = false): boolean {
    if (!force && !this.canTransition(next)) return false;
    if (next === this.state && !MONSTER_SELF_TRANSITIONS.has(next) && !force) return false;

    this.fire(this.exitListeners, this.state);
    this.prior = this.state;
    this.state = next;
    this.elapsed = 0;
    this.transitions++;
    this.fire(this.enterListeners, next);
    return true;
  }

  /**
   * Advance the clock and run the watchdog.
   *
   * The watchdog is checked AFTER the clock advances, so a state whose timeout
   * is exactly its legitimate duration gets its full duration.
   */
  update(dt: number): void {
    this.elapsed += dt;
    const limit = MONSTER_STATE_TIMEOUT_SECONDS[this.state];
    if (this.elapsed <= limit) return;

    const fallback = MONSTER_STATE_FALLBACK[this.state];
    if (fallback === this.state) return;
    this.watchdogTrips++;
    // Forced: the fallback table is validated against the transition table by
    // `__tests__/fsm.test.ts`, so this can never introduce an illegal edge —
    // but a watchdog that could itself be refused would not be a watchdog.
    this.transition(fallback, true);
  }

  /** Subscribe to entering a state. Returns an unsubscribe function. */
  onEnter(state: MonsterState, cb: Listener): () => void {
    this.enterListeners ??= new Map();
    return MonsterFsm.subscribe(this.enterListeners, state, cb);
  }

  /** Subscribe to leaving a state. Returns an unsubscribe function. */
  onExit(state: MonsterState, cb: Listener): () => void {
    this.exitListeners ??= new Map();
    return MonsterFsm.subscribe(this.exitListeners, state, cb);
  }

  /**
   * Return to a clean `idle`, for the pool.
   *
   * Listeners are NOT dropped: the owning `Monster` subscribes once at
   * construction and is reused with its machine, so clearing them here would
   * silently unwire every recycled monster after the first death.
   */
  reset(initial: MonsterState = 'idle'): void {
    this.prior = undefined;
    this.state = initial;
    this.elapsed = 0;
    this.transitions = 0;
    this.watchdogTrips = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private static subscribe(
    map: Map<MonsterState, Listener[]>,
    state: MonsterState,
    cb: Listener
  ): () => void {
    const list = map.get(state);
    if (list === undefined) map.set(state, [cb]);
    else list.push(cb);
    return () => {
      const current = map.get(state);
      if (current === undefined) return;
      const index = current.indexOf(cb);
      if (index >= 0) current.splice(index, 1);
    };
  }

  /**
   * Dispatch over a SNAPSHOT, matching the event bus's mutation-safety rule:
   * a listener that transitions the machine (which is normal — an `onEnter`
   * for `stagger` legitimately schedules a return to `pursue`) must not shift
   * the array out from under the loop.
   */
  private fire(map: Map<MonsterState, Listener[]> | undefined, state: MonsterState): void {
    const list = map?.get(state);
    if (list === undefined || list.length === 0) return;
    for (const cb of list.slice()) {
      try {
        cb();
      } catch (error) {
        // One bad listener must never break a monster's brain mid-frame.
        console.error(`[monster.fsm] listener for '${state}' threw:`, error);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Table analysis — used by the tests and by the harness                      */
/* -------------------------------------------------------------------------- */

/** A finding from `analyseTransitionTable`. Empty array means a sound table. */
export interface ITransitionFlaw {
  readonly state: MonsterState;
  readonly kind: 'no-exit' | 'unreachable' | 'no-path-to-dead' | 'illegal-fallback' | 'no-watchdog';
  readonly detail: string;
}

/**
 * Prove the table is sound.
 *
 * Runs in a unit test AND in the harness, because "the FSM cannot deadlock" is
 * a claim about a data structure and a claim about a data structure should be
 * checked against the data structure rather than against a play session.
 */
export function analyseTransitionTable(): ITransitionFlaw[] {
  const flaws: ITransitionFlaw[] = [];

  /* 1. every non-terminal state can be left */
  for (const state of MONSTER_STATES) {
    const exits = MONSTER_TRANSITIONS[state];
    if (state === 'dead') continue;
    if (exits.length === 0) {
      flaws.push({ state, kind: 'no-exit', detail: `'${state}' has no outgoing transitions` });
    }
  }

  /* 2. every state is reachable from idle */
  const reachable = reachableFrom('idle');
  for (const state of MONSTER_STATES) {
    if (!reachable.has(state)) {
      flaws.push({ state, kind: 'unreachable', detail: `'${state}' is unreachable from 'idle'` });
    }
  }

  /* 3. death is always available — a monster must never become unkillable by
        walking into the wrong state */
  for (const state of MONSTER_STATES) {
    if (state === 'dead') continue;
    if (!reachableFrom(state).has('dead')) {
      flaws.push({
        state,
        kind: 'no-path-to-dead',
        detail: `'dead' is unreachable from '${state}'`,
      });
    }
  }

  /* 4. every transient state has a finite watchdog and a legal fallback */
  for (const state of MONSTER_STATES) {
    if (state === 'dead' || state === 'idle') continue;
    const limit = MONSTER_STATE_TIMEOUT_SECONDS[state];
    if (!Number.isFinite(limit) || limit <= 0) {
      flaws.push({
        state,
        kind: 'no-watchdog',
        detail: `'${state}' has no finite watchdog (${limit})`,
      });
      continue;
    }
    const fallback = MONSTER_STATE_FALLBACK[state];
    if (fallback === state || !MONSTER_TRANSITIONS[state].includes(fallback)) {
      flaws.push({
        state,
        kind: 'illegal-fallback',
        detail: `watchdog fallback '${state}' → '${fallback}' is not a legal transition`,
      });
    }
  }

  return flaws;
}

/** Breadth-first closure over the transition table. */
export function reachableFrom(start: MonsterState): Set<MonsterState> {
  const seen = new Set<MonsterState>([start]);
  const queue: MonsterState[] = [start];
  while (queue.length > 0) {
    const state = queue.shift()!;
    for (const next of MONSTER_TRANSITIONS[state]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}
