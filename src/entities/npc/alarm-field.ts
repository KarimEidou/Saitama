/**
 * ALARM FIELD — panic as a scalar that spreads
 *
 * One float per 12 m cell, 0 (nothing is wrong) to 1 (a building is falling on
 * me). Seeded by monster positions and by explosion events, propagated across
 * the city at 10 Hz, and sampled by every civilian to choose what to do.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY A FIELD AND NOT PER-AGENT PERCEPTION
 *
 *  Two hundred and fifty agents each raycasting to each of several monsters
 *  is 250 x N visibility tests per frame, and it produces a crowd that reacts
 *  in a perfect circle around each threat — everyone inside the radius panics
 *  on the same frame, everyone outside is oblivious, and the boundary between
 *  them is a visible ring that moves with the monster.
 *
 *  A field costs one array read per agent and gets the emergent behaviour for
 *  free: panic ARRIVES somewhere. It rounds corners, it lags behind the
 *  threat, it lingers after the monster has moved on, and the people who see
 *  the wave of running people before they see the monster turn and run too.
 *  That last one is the behaviour that sells a city as populated, and it is
 *  not something per-agent perception produces at all.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── PROPAGATION IS RATE-LIMITED MAX-TRANSFER, NOT DIFFUSION ───────────────
 * The obvious implementation is a heat equation. It is the wrong one. Heat
 * spreads as sqrt(t), so the front visibly decelerates: the near end of the
 * street panics in a quarter of a second and the far end two blocks away takes
 * fifteen. Worse, diffusion CONSERVES the seeded quantity, so a big scare
 * spread over a big area ends up below every threshold and nobody reacts.
 *
 * Instead each cell targets `transfer x (best neighbour)` and is allowed to
 * approach that target at a bounded rate. Amplitude therefore falls off
 * geometrically with distance (a fixed, tunable RANGE) while the threshold
 * crossing advances at a bounded, near-constant SPEED. Range and speed become
 * two independent dials, which is what a designer actually wants, and the
 * scheme is unconditionally stable — there is no CFL condition to violate when
 * someone changes the cell size.
 *
 * ── IT PROPAGATES THROUGH WALLS, ON PURPOSE ───────────────────────────────
 * Buildings block the flow field, not this one. You do not need line of sight
 * to a two-hundred-tonne monster to know something is very wrong; you hear it,
 * you feel it through the pavement, and you see everyone on your street start
 * running. Blocking alarm at walls produces sharp panic shadows in the middle
 * of a crowd, which reads as a bug even though it is geometrically correct.
 */

import { clamp01 } from '@/util';
import {
  ALARM_DECAY,
  ALARM_DT,
  ALARM_GATE,
  ALARM_RISE,
  ALARM_TRANSFER,
  FIELD_CELL,
  FIELD_COUNT,
  FIELD_DIM,
  IMPULSE_SEED_SECONDS,
  THREAT_SEED_RADIUS,
} from './constants';
import { cellCentreX, cellCentreZ, cellX, cellZ } from './obstacles';
import type { IAlarmImpulse, IThreatSource } from './types';

/** Diagonal transfer is weaker by the extra distance travelled. */
const DIAGONAL_TRANSFER = Math.pow(ALARM_TRANSFER, Math.SQRT2);

export class AlarmField {
  /**
   * Double-buffered because the step reads every cell's four-neighbourhood: an
   * in-place update would let a cell already advanced this tick feed the one
   * next to it, so alarm would race ahead along +X and +Z and lag along -X and
   * -Z. The front would be a diamond with a bias, which is visible.
   */
  private valueBuffer = new Float32Array(FIELD_COUNT);
  private nextBuffer = new Float32Array(FIELD_COUNT);
  /** This tick's seeds, rebuilt every tick from threats and impulses. */
  private readonly seed = new Float32Array(FIELD_COUNT);

  private readonly impulses: IAlarmImpulse[] = [];
  private accumulator = 0;
  private ticks = 0;
  private lastMs = 0;
  private peak = 0;

  /** Current alarm per cell, 0..1. Valid until the next tick. */
  get value(): Float32Array {
    return this.valueBuffer;
  }

  /** Alarm ticks executed since construction. */
  get tickCount(): number {
    return this.ticks;
  }

  /** Milliseconds the last tick cost. */
  get lastTickMs(): number {
    return this.lastMs;
  }

  /** Highest alarm anywhere in the field after the last tick. */
  get peakAlarm(): number {
    return this.peak;
  }

  /** Live impulse seeds. */
  get impulseCount(): number {
    return this.impulses.length;
  }

  /** Wipe the field and every pending impulse. */
  reset(): void {
    this.valueBuffer.fill(0);
    this.nextBuffer.fill(0);
    this.seed.fill(0);
    this.impulses.length = 0;
    this.accumulator = 0;
    this.ticks = 0;
    this.peak = 0;
  }

  /** Alarm at a world position, 0..1. Nearest-cell; agents are not sub-metre. */
  sample(x: number, z: number): number {
    return this.valueBuffer[cellZ(z) * FIELD_DIM + cellX(x)]!;
  }

  /** Alarm at a cell index. */
  at(index: number): number {
    return this.valueBuffer[index]!;
  }

  /**
   * Seed a transient scare: an explosion, a shockwave, a collapsing building.
   *
   * Impulses feed the field for `IMPULSE_SEED_SECONDS` rather than being added
   * once, because a single injection lands entirely inside one 100 ms tick and
   * the rate limiter — which is what stops the field from teleporting — throws
   * most of it away. A short sustained source produces the bang AND the wave.
   */
  addImpulse(x: number, z: number, intensity: number, radius: number): void {
    this.impulses.push({
      x,
      z,
      intensity: clamp01(intensity),
      radius: Math.max(FIELD_CELL, radius),
      remaining: IMPULSE_SEED_SECONDS,
    });
  }

  /**
   * Advance the field. Call every frame; it ticks internally at `ALARM_HZ`.
   *
   * Fixed internal ticks rather than a variable step: the propagation is a
   * rate limiter, so a variable dt would make the front speed a function of
   * frame rate, and the determinism test would fail on any machine with a
   * different frame time.
   */
  update(dt: number, threats: readonly IThreatSource[]): void {
    this.accumulator += dt;
    // Cap the catch-up. A hitch (a chunk upload, a tab regaining focus) must
    // not spend a hundred ticks unrolling in one frame.
    if (this.accumulator > ALARM_DT * 6) this.accumulator = ALARM_DT * 6;
    let ran = false;
    const start = performance.now();
    while (this.accumulator >= ALARM_DT) {
      this.accumulator -= ALARM_DT;
      this.tick(threats);
      ran = true;
    }
    if (ran) this.lastMs = performance.now() - start;
  }

  /** One 100 ms step. Exposed for tests that want to drive it exactly. */
  tick(threats: readonly IThreatSource[]): void {
    this.buildSeeds(threats);
    this.propagate();
    this.ticks++;
  }

  /* ------------------------------------------------------------------ */
  /* Seeding                                                            */
  /* ------------------------------------------------------------------ */

  private buildSeeds(threats: readonly IThreatSource[]): void {
    this.seed.fill(0);
    for (const threat of threats) {
      this.stamp(
        threat.position.x,
        threat.position.z,
        clamp01(threat.intensity),
        THREAT_SEED_RADIUS
      );
    }
    for (let i = this.impulses.length - 1; i >= 0; i--) {
      const impulse = this.impulses[i]!;
      impulse.remaining -= ALARM_DT;
      if (impulse.remaining <= 0) {
        // Swap-remove: order does not matter and splice would be O(n).
        this.impulses[i] = this.impulses[this.impulses.length - 1]!;
        this.impulses.pop();
        continue;
      }
      this.stamp(impulse.x, impulse.z, impulse.intensity, impulse.radius);
    }
  }

  /** Write a radial seed, keeping the maximum where sources overlap. */
  private stamp(x: number, z: number, intensity: number, radius: number): void {
    if (intensity <= 0) return;
    const cells = Math.ceil(radius / FIELD_CELL);
    const cx = cellX(x);
    const cz = cellZ(z);
    const gx0 = Math.max(0, cx - cells);
    const gx1 = Math.min(FIELD_DIM - 1, cx + cells);
    const gz0 = Math.max(0, cz - cells);
    const gz1 = Math.min(FIELD_DIM - 1, cz + cells);
    const invR = 1 / radius;
    for (let gz = gz0; gz <= gz1; gz++) {
      const dz = cellCentreZ(gz) - z;
      const row = gz * FIELD_DIM;
      for (let gx = gx0; gx <= gx1; gx++) {
        const dx = cellCentreX(gx) - x;
        const d = Math.sqrt(dx * dx + dz * dz) * invR;
        if (d >= 1) continue;
        // Smoothstep rather than linear: a linear cone leaves a visible
        // gradient discontinuity at the rim that a crowd lines itself up on.
        const falloff = 1 - d * d * (3 - 2 * d);
        const v = intensity * falloff;
        const i = row + gx;
        if (v > this.seed[i]!) this.seed[i] = v;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Propagation                                                        */
  /* ------------------------------------------------------------------ */

  private propagate(): void {
    const value = this.valueBuffer;
    const next = this.nextBuffer;
    const seed = this.seed;
    const rise = ALARM_RISE * ALARM_DT;
    const decay = ALARM_DECAY * ALARM_DT;
    let peak = 0;

    for (let gz = 0; gz < FIELD_DIM; gz++) {
      const row = gz * FIELD_DIM;
      const hasUp = gz > 0;
      const hasDown = gz < FIELD_DIM - 1;
      for (let gx = 0; gx < FIELD_DIM; gx++) {
        const i = row + gx;
        const hasLeft = gx > 0;
        const hasRight = gx < FIELD_DIM - 1;

        // Best alarm reachable from a neighbour, attenuated by one cell of
        // travel, and only from neighbours that have crossed the gate. `max`
        // and not a sum: alarm is an intensity, not a quantity, and summing
        // makes a wide-open plaza louder than a narrow street for no reason a
        // player would ever accept.
        let best = 0;
        if (hasLeft && value[i - 1]! > best) best = value[i - 1]!;
        if (hasRight && value[i + 1]! > best) best = value[i + 1]!;
        if (hasUp && value[i - FIELD_DIM]! > best) best = value[i - FIELD_DIM]!;
        if (hasDown && value[i + FIELD_DIM]! > best) best = value[i + FIELD_DIM]!;
        const orthoTarget = best >= ALARM_GATE ? best * ALARM_TRANSFER : 0;

        let diag = 0;
        if (hasLeft && hasUp && value[i - FIELD_DIM - 1]! > diag) diag = value[i - FIELD_DIM - 1]!;
        if (hasRight && hasUp && value[i - FIELD_DIM + 1]! > diag) diag = value[i - FIELD_DIM + 1]!;
        if (hasLeft && hasDown && value[i + FIELD_DIM - 1]! > diag) diag = value[i + FIELD_DIM - 1]!;
        if (hasRight && hasDown && value[i + FIELD_DIM + 1]! > diag) {
          diag = value[i + FIELD_DIM + 1]!;
        }
        const diagTarget = diag >= ALARM_GATE ? diag * DIAGONAL_TRANSFER : 0;

        const current = value[i]!;
        // Orthogonal and diagonal neighbours are rate-limited SEPARATELY, the
        // diagonal one by 1/sqrt(2). A single shared rate limit makes the front
        // travel a full cell diagonally in the same time it travels one
        // orthogonally, so the wave expands as a square rotated 45 degrees —
        // grid anisotropy, and extremely visible once a crowd is standing in it.
        let v = current;
        if (orthoTarget > v) v = current + Math.min(rise, orthoTarget - current);
        if (diagTarget > current) {
          const diagValue = current + Math.min(rise * Math.SQRT1_2, diagTarget - current);
          if (diagValue > v) v = diagValue;
        }
        if (seed[i]! > v) {
          // A seed is a source, not a neighbour: it is not rate-limited, or a
          // detonation would take four seconds to become frightening.
          v = seed[i]!;
        }
        if (v === current && current > 0) {
          // Falling: exponential relaxation towards zero (or towards whatever
          // the neighbours still support), so a cell that has lost its source
          // drains smoothly instead of stepping down.
          const floor = Math.max(orthoTarget, diagTarget, seed[i]!);
          v = current - Math.min(decay, current - floor);
        }
        next[i] = v;
        if (v > peak) peak = v;
      }
    }

    this.valueBuffer = next;
    this.nextBuffer = value;
    this.peak = peak;
  }

  /* ------------------------------------------------------------------ */
  /* Measurement                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Radius in metres of the outermost cell around `(x, z)` whose alarm is at
   * or above `threshold`. This is THE measurable definition of "the panic
   * front", and the harness differentiates it to report metres per second.
   *
   * Returns 0 when the centre itself is below the threshold.
   */
  frontRadius(x: number, z: number, threshold: number): number {
    let best = -1;
    for (let gz = 0; gz < FIELD_DIM; gz++) {
      const row = gz * FIELD_DIM;
      const dz = cellCentreZ(gz) - z;
      for (let gx = 0; gx < FIELD_DIM; gx++) {
        if (this.valueBuffer[row + gx]! < threshold) continue;
        const dx = cellCentreX(gx) - x;
        const d = dx * dx + dz * dz;
        if (d > best) best = d;
      }
    }
    return best < 0 ? 0 : Math.sqrt(best);
  }

  /** Cells at or above a threshold. Cheap proxy for "how much of the city is panicking". */
  countAbove(threshold: number): number {
    let n = 0;
    for (let i = 0; i < FIELD_COUNT; i++) if (this.valueBuffer[i]! >= threshold) n++;
    return n;
  }

  /**
   * Order-independent hash of the field, for determinism assertions.
   *
   * Quantised to 1/4096 before hashing: two runs that agree to within a
   * quarter of a thousandth are the same run, and demanding bit equality of
   * floats that have been through a rate limiter is a test of the FPU, not of
   * the simulation.
   */
  hash(): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < FIELD_COUNT; i++) {
      const q = Math.round(this.valueBuffer[i]! * 4096);
      h = Math.imul(h ^ q, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
}
