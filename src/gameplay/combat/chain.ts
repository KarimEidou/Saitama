/**
 * CONSECUTIVE NORMAL PUNCHES
 *
 * Rapid taps chain. Each additional link multiplies `power`, and because the
 * audio system derives its intensity from `log10(power) / 6`, a geometric rise
 * in power is a LINEAR rise in perceived loudness and pitch — which is exactly
 * the ramp `punch.consecutive` → `punch.barrage` was built to play.
 *
 * ── THE ONLY HARD REQUIREMENT ──────────────────────────────────────────────
 * The power sequence must be STRICTLY MONOTONIC until it saturates. The audio
 * workstream measured its pitch rise against a monotonic input; feeding it a
 * sequence that dips would make a barrage audibly stumble mid-chain. The unit
 * tests assert monotonicity directly rather than trusting the formula.
 *
 * ── WHY A CHAIN EXISTS AT ALL ──────────────────────────────────────────────
 * Mechanically it changes nothing: the first punch already killed whatever it
 * touched. The chain is pure escalation of PRESENTATION — louder, faster,
 * shakier — and that is the point. It is the game letting the player express
 * frustration at an enemy that was never a threat, which is the joke the whole
 * character is built on.
 */

import type { PunchKind } from '@/types';
import type { ICombatTuning } from './tuning';

/** Live chain state. */
export interface IChainState {
  /** Links so far. 0 when no chain is running. */
  readonly length: number;
  /** Seconds remaining in the window before the chain lapses. */
  readonly windowRemaining: number;
  /** Longest chain reached since the last `reset`. */
  readonly longest: number;
}

/**
 * Tracks how many taps have landed inside the chain window.
 *
 * Time is passed in explicitly rather than read from a clock, so a replay can
 * drive it from recorded timestamps and get the same chain lengths.
 */
export class PunchChain {
  private readonly tuning: ICombatTuning;
  private length = 0;
  private lastTime = Number.NEGATIVE_INFINITY;
  private longest = 0;

  constructor(tuning: ICombatTuning) {
    this.tuning = tuning;
  }

  /**
   * Register a tap at `time` seconds.
   * @returns the 1-based index of this punch within its chain.
   */
  punch(time: number): number {
    if (time - this.lastTime <= this.tuning.chainWindowSeconds) this.length++;
    else this.length = 1;
    this.lastTime = time;
    if (this.length > this.longest) this.longest = this.length;
    return this.length;
  }

  /** Lapse the chain when the window has passed. Call once per frame. */
  update(time: number): void {
    if (this.length > 0 && time - this.lastTime > this.tuning.chainWindowSeconds) {
      this.length = 0;
    }
  }

  state(time: number): IChainState {
    const remaining =
      this.length === 0
        ? 0
        : Math.max(0, this.tuning.chainWindowSeconds - (time - this.lastTime));
    return { length: this.length, windowRemaining: remaining, longest: this.longest };
  }

  reset(): void {
    this.length = 0;
    this.lastTime = Number.NEGATIVE_INFINITY;
    this.longest = 0;
  }

  get longestReached(): number {
    return this.longest;
  }
}

/**
 * `power` for the nth link of a chain (1-based).
 *
 * Geometric with a ceiling. Strictly increasing while below the ceiling, flat
 * afterwards — never decreasing, which is the property the audio ramp needs.
 */
export function chainPower(index: number, tuning: ICombatTuning): number {
  const links = Math.max(1, Math.floor(index)) - 1;
  const raw = tuning.normalPower * Math.pow(tuning.chainPowerGrowth, links);
  return Math.min(raw, tuning.chainPowerCeiling);
}

/**
 * Punch kind for the nth link.
 *
 * The first tap is an ordinary `normal` so a single punch sounds like a punch;
 * from the threshold on it is `consecutive`, which is the kind the audio map
 * routes to the chain voices and escalates into `punch.barrage` once the
 * log-normalised power passes 0.7.
 */
export function chainKind(index: number, tuning: ICombatTuning): PunchKind {
  return index >= tuning.chainKindThreshold ? 'consecutive' : 'normal';
}
