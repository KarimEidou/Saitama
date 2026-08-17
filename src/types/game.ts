/**
 * GAME LOOP CONTRACT
 *
 * The top-level clock, tick scheduling and coarse game phase.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * Relationship to engine.ts:
 *   IUpdatable.update(dt)         — a system advancing itself by a delta.
 *   ITickable.tick(dt, elapsed)   — a participant registered with the game
 *                                   loop, which also receives absolute time.
 * A class may implement both; the loop only ever calls `tick`.
 */

/** A participant in the main game loop. */
export interface ITickable {
  /**
   * Advance one frame.
   * @param dt      Scaled delta in SECONDS (already multiplied by timeScale
   *                and clamped against tab-switch spikes).
   * @param elapsed Total scaled seconds since the clock started.
   */
  tick(dt: number, elapsed: number): void;
}

/**
 * Master clock. Owns the only source of truth for game time.
 *
 * Determinism note: `dt` is CLAMPED to `maxDelta` so a stalled frame cannot
 * teleport physics. Fixed-step consumers should use `fixedStep` accumulation
 * rather than raw `dt`.
 */
export interface IGameClock {
  /** Unscaled seconds since the previous frame, clamped to `maxDelta`. */
  readonly rawDelta: number;
  /** `rawDelta * timeScale`. What most systems should consume. */
  readonly delta: number;
  /** Total scaled seconds since start. */
  readonly elapsed: number;
  /** Total unscaled seconds since start (UI animations, profiling). */
  readonly unscaledElapsed: number;
  /** Frames rendered since start. */
  readonly frameCount: number;
  /**
   * Time multiplier. 0 pauses, 1 is normal, 0.15 is a slow-motion finisher.
   * Mutating this is the ONLY sanctioned way to pause or slow the game.
   */
  timeScale: number;
  /** Upper bound applied to `rawDelta`, in seconds. Typically 1/15. */
  readonly maxDelta: number;
  /** Fixed timestep for physics, in seconds. Typically 1/60. */
  readonly fixedStep: number;
  /**
   * Number of fixed steps to run this frame, from the accumulator.
   * Physics runs exactly this many sub-steps.
   */
  readonly fixedStepCount: number;
  /** Interpolation factor in 0..1 between the last two fixed steps. */
  readonly fixedAlpha: number;
}

/** Coarse application phase. Drives which systems tick and which UI shows. */
export type GamePhase =
  /** Bundle parsed, nothing initialised. */
  | 'boot'
  /** Core assets streaming in; loading screen visible. */
  | 'loading'
  /** Title / main menu. */
  | 'menu'
  /** Normal open-world play. */
  | 'playing'
  /** Paused by the player; timeScale is 0. */
  | 'paused'
  /** Scripted camera sequence; input is restricted. */
  | 'cutscene'
  /** Player defeated. */
  | 'gameOver'
  /** Unrecoverable error; see IGameState.error. */
  | 'error';

/** Top-level game state. */
export interface IGameState {
  readonly phase: GamePhase;
  /** 0..1 progress while `phase === 'loading'`. */
  readonly loadProgress: number;
  /** Human-readable loading step, shown on the boot screen. */
  readonly loadLabel: string;
  /** Populated when `phase === 'error'`. */
  readonly error?: string;
  /** True once the first frame has presented (mirrors window.__GAME_READY__). */
  readonly ready: boolean;
}

/**
 * The game loop itself. One instance, created by the bootstrap.
 *
 * Tick order is ascending `priority`. Suggested bands:
 *   0-99    input sampling
 *   100-299 AI / behaviour
 *   300-499 physics (fixed sub-stepped)
 *   500-699 world streaming
 *   700-799 animation
 *   800-899 camera
 *   900+    UI / HUD
 */
export interface IGameLoop {
  readonly clock: IGameClock;
  readonly state: IGameState;
  /** Register a tickable. Returns an unsubscribe function. */
  register(tickable: ITickable, priority: number, id?: string): () => void;
  /** Start requesting animation frames. */
  start(): void;
  /** Stop the loop without tearing down systems. */
  stop(): void;
  /** Convenience wrapper over `clock.timeScale = 0`. */
  pause(): void;
  /** Restore the pre-pause time scale. */
  resume(): void;
  /** Move to a new phase, running any transition side effects. */
  setPhase(phase: GamePhase): void;
}
