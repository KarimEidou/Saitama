/**
 * LOCOMOTION STATE MACHINE
 *
 * Eight states, speed-driven:
 *
 *      idle ⇄ walk ⇄ run ⇄ dash
 *        │      │      │     │
 *        └──────┴──┬───┴─────┘
 *                  ↓
 *            jumpLaunch ──→ fall ──→ land ──→ (idle/walk/run/dash)
 *                  ↑          │
 *                  └──────────┘   (coyote jump out of a fall)
 *                             └──→ hardLand   (fall ≥ 15 m: crater)
 *
 * ── WHY A TABLE AND NOT A PILE OF `if`s ────────────────────────────────────
 * The interesting transitions in a character controller are the ILLEGAL ones.
 * `hardLand → jumpLaunch` is absent on purpose: a cratering landing is a beat
 * the player has to sit through, and that single missing edge is what stops a
 * twenty-eight-metre drop from being cancellable into another jump. Written as
 * conditionals that rule would be invisible; written as a table it is one line
 * you can point at in review.
 *
 * ── THE STATE IS DERIVED, NOT COMMANDED ────────────────────────────────────
 * `resolveGroundState()` picks the ground state from SPEED, not from what the
 * stick is doing. A character being shoved along at 8 m/s with no input is
 * running, and a character mashing the stick into a wall at 0 m/s is idle. The
 * animator reads this, so getting it from measured motion is what keeps feet
 * from sliding.
 *
 * TYPE-ONLY dependencies: `@/types` and `@/util`. This module knows nothing
 * about physics, rendering or input.
 */

import type { ActorState, ClipName, IStateMachine } from '@/types';
import type { IPlayerLocomotionTuning } from './tuning';

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The player's locomotion states.
 *
 * Distinct from `ActorState` (shared with NPCs and monsters) because the
 * player has two landing flavours and NPCs have none; `toActorState()` below
 * projects onto the shared vocabulary for the animator.
 */
export type PlayerLocoState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'dash'
  | 'jumpLaunch'
  | 'fall'
  | 'land'
  | 'hardLand';

/** Every state, in the order a debug HUD should list them. */
export const PLAYER_LOCO_STATES: readonly PlayerLocoState[] = Object.freeze([
  'idle',
  'walk',
  'run',
  'dash',
  'jumpLaunch',
  'fall',
  'land',
  'hardLand',
]);

/** True for states where the character is off the ground. */
export function isAirborneState(state: PlayerLocoState): boolean {
  return state === 'jumpLaunch' || state === 'fall';
}

/** True for states that lock out a new jump until they finish. */
export function isRecoveryState(state: PlayerLocoState): boolean {
  return state === 'land' || state === 'hardLand';
}

/* -------------------------------------------------------------------------- */
/* Projections onto the shared vocabulary                                     */
/* -------------------------------------------------------------------------- */

/** Project onto the `ActorState` shared with every other actor. */
export function toActorState(state: PlayerLocoState): ActorState {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'walk':
      return 'walk';
    case 'run':
      return 'run';
    case 'dash':
      return 'sprint';
    case 'jumpLaunch':
      return 'jump';
    case 'fall':
      return 'fall';
    case 'land':
    case 'hardLand':
      return 'land';
  }
}

/**
 * The animation slot this state wants.
 *
 * Identical to `toActorState` today because `ActorState` and `ClipName` share
 * their names by design (see entity.ts). Kept as its own function so a future
 * hard-landing clip can diverge without touching the state machine.
 */
export function toClipName(state: PlayerLocoState): ClipName {
  return toActorState(state) as ClipName;
}

/* -------------------------------------------------------------------------- */
/* Transition table                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Legal transitions, keyed by source state.
 *
 * `fall` is reachable from everything: the ground can vanish under you at any
 * moment (a building is punched out from under the player, a platform is
 * destroyed) and no state should be able to refuse that.
 */
const TRANSITIONS: Readonly<Record<PlayerLocoState, readonly PlayerLocoState[]>> = Object.freeze({
  idle: ['walk', 'run', 'dash', 'jumpLaunch', 'fall'],
  walk: ['idle', 'run', 'dash', 'jumpLaunch', 'fall'],
  run: ['idle', 'walk', 'dash', 'jumpLaunch', 'fall'],
  dash: ['idle', 'walk', 'run', 'jumpLaunch', 'fall'],
  // A launch can be cut short by a ceiling (straight to fall) or by landing on
  // something one frame later (a jump up a single step).
  jumpLaunch: ['fall', 'land', 'hardLand'],
  // fall -> jumpLaunch is THE coyote-time edge.
  fall: ['jumpLaunch', 'land', 'hardLand'],
  land: ['idle', 'walk', 'run', 'dash', 'jumpLaunch', 'fall'],
  // Deliberately no 'jumpLaunch': a cratering landing must play out.
  hardLand: ['idle', 'walk', 'run', 'dash', 'fall'],
});

/* -------------------------------------------------------------------------- */
/* Speed-driven resolution                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Which ground state a given planar speed reads as.
 *
 * @param speed    Measured planar speed in m/s — what actually happened, not
 *                 what was requested.
 * @param dashing  True while the dash action is held AND the character is
 *                 actually moving.
 */
export function resolveGroundState(
  tuning: IPlayerLocomotionTuning,
  speed: number,
  dashing: boolean
): PlayerLocoState {
  if (speed <= tuning.idleSpeedThreshold) return 'idle';
  if (dashing) return 'dash';
  return speed >= tuning.runSpeedThreshold ? 'run' : 'walk';
}

/* -------------------------------------------------------------------------- */
/* The machine                                                                */
/* -------------------------------------------------------------------------- */

type Callback = () => void;

/**
 * `IStateMachine<PlayerLocoState>` with enter/exit hooks and a legality table.
 *
 * Allocation-free on the hot path: `update()` adds a float, `transition()`
 * walks one small array. The callback lists are only touched on an actual
 * change of state.
 */
export class LocomotionStateMachine implements IStateMachine<PlayerLocoState> {
  private state: PlayerLocoState;
  private prior: PlayerLocoState | undefined;
  private elapsed = 0;
  /** Monotonic count of accepted transitions; diagnostics and tests. */
  private changes = 0;

  private readonly enterHooks = new Map<PlayerLocoState, Callback[]>();
  private readonly exitHooks = new Map<PlayerLocoState, Callback[]>();

  constructor(initial: PlayerLocoState = 'idle') {
    this.state = initial;
  }

  get current(): PlayerLocoState {
    return this.state;
  }

  get previous(): PlayerLocoState | undefined {
    return this.prior;
  }

  get timeInState(): number {
    return this.elapsed;
  }

  /** Accepted transitions since construction. */
  get transitionCount(): number {
    return this.changes;
  }

  update(dt: number): void {
    this.elapsed += dt;
  }

  canTransition(next: PlayerLocoState): boolean {
    if (next === this.state) return false;
    return TRANSITIONS[this.state].includes(next);
  }

  /**
   * Request a transition.
   *
   * @param force Bypass the legality table. Reserved for hard resets
   *              (respawn, teleport, cutscene hand-off) — gameplay code should
   *              never need it, and a `force` in a diff is a design question.
   */
  transition(next: PlayerLocoState, force = false): boolean {
    if (next === this.state) return false;
    if (!force && !this.canTransition(next)) return false;

    const exiting = this.state;
    this.prior = exiting;
    this.state = next;
    this.elapsed = 0;
    this.changes++;

    // Snapshot before dispatch: a hook that subscribes or unsubscribes must
    // not mutate the list being walked.
    const exitList = this.exitHooks.get(exiting);
    if (exitList !== undefined && exitList.length > 0) {
      for (const cb of exitList.slice()) cb();
    }
    const enterList = this.enterHooks.get(next);
    if (enterList !== undefined && enterList.length > 0) {
      for (const cb of enterList.slice()) cb();
    }
    return true;
  }

  onEnter(state: PlayerLocoState, cb: Callback): () => void {
    return this.subscribe(this.enterHooks, state, cb);
  }

  onExit(state: PlayerLocoState, cb: Callback): () => void {
    return this.subscribe(this.exitHooks, state, cb);
  }

  /** Drop every hook. Called by the owner's `dispose()`. */
  clearHooks(): void {
    this.enterHooks.clear();
    this.exitHooks.clear();
  }

  private subscribe(
    map: Map<PlayerLocoState, Callback[]>,
    state: PlayerLocoState,
    cb: Callback
  ): () => void {
    let list = map.get(state);
    if (list === undefined) {
      list = [];
      map.set(state, list);
    }
    list.push(cb);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const i = list.indexOf(cb);
      if (i !== -1) list.splice(i, 1);
    };
  }
}
