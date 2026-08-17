/**
 * ADAPTIVE RESOLUTION GOVERNOR
 *
 * The single highest-leverage mobile performance feature in this renderer, and
 * the reason it is built before anything it protects.
 *
 * A mid-range Android phone is almost always FRAGMENT bound, not vertex or
 * draw-call bound: the same frame at 0.7x drawing-buffer scale costs roughly
 * half the fragment work while being nearly invisible in motion on a 5-inch
 * screen. Dropping to 0.7x buys more headroom than culling half the city, and
 * unlike an LOD change it is instant, reversible and content-independent.
 *
 * ── WHY MEDIAN, NOT MEAN ───────────────────────────────────────────────────
 * A GC pause, a shader compile or a chunk upload produces one 120ms frame. The
 * mean of a 30-frame window is dragged up by that single sample and the
 * governor over-reacts, dropping resolution for a hitch that has already
 * passed. The median ignores it, which is exactly the desired behaviour: react
 * to sustained load, ignore spikes.
 *
 * ── WHY HYSTERESIS ─────────────────────────────────────────────────────────
 * Scaling the drawing buffer reallocates render targets. Without a dwell time
 * the governor oscillates around the threshold, reallocating every few frames,
 * and the oscillation itself costs more than the resolution it saved. 500ms is
 * long enough for the new scale's cost to show up in a fresh 30-frame window.
 */

/** Tuning for `ResolutionGovernor`. All fields optional. */
export interface IResolutionGovernorOptions {
  /** Frame rate to defend. The frame budget is `1000 / targetFps` ms. */
  readonly targetFps?: number;
  /** Frames in the median window. */
  readonly sampleCount?: number;
  /** Lowest permitted scale. */
  readonly minScale?: number;
  /** Highest permitted scale. */
  readonly maxScale?: number;
  /** Scale granularity. */
  readonly step?: number;
  /** Minimum milliseconds between two scale changes. */
  readonly hysteresisMs?: number;
  /**
   * Median must exceed `budget * downTrigger` to scale DOWN. Slightly above 1
   * so a frame that merely grazes the budget does not cost resolution.
   */
  readonly downTrigger?: number;
  /**
   * Median must fall below `budget * upTrigger` to scale UP. Well under 1 so
   * we only climb back when there is real headroom, not when we are exactly at
   * budget because we already scaled down.
   */
  readonly upTrigger?: number;
  /** Called whenever the scale actually changes. */
  readonly onScaleChanged?: (scale: number, medianFrameMs: number) => void;
  /** Injectable clock, for deterministic tests. Defaults to `performance.now`. */
  readonly now?: () => number;
}

/** Snapshot of the governor's decision state, for the debug HUD. */
export interface IResolutionGovernorState {
  readonly scale: number;
  readonly medianFrameMs: number;
  readonly budgetMs: number;
  readonly samples: number;
  readonly msSinceChange: number;
  readonly changes: number;
}

const DEFAULTS = {
  targetFps: 60,
  sampleCount: 30,
  minScale: 0.6,
  maxScale: 1.0,
  step: 0.05,
  hysteresisMs: 500,
  downTrigger: 1.15,
  upTrigger: 0.8,
} as const;

export class ResolutionGovernor {
  /** Ring of the last `sampleCount` frame times, in milliseconds. */
  private readonly samples: Float64Array;
  /** Scratch buffer for the median sort. Preallocated: this runs every frame. */
  private readonly scratch: Float64Array;
  private head = 0;
  private filled = 0;

  private readonly sampleCount: number;
  private minScale: number;
  private maxScale: number;
  private readonly step: number;
  private readonly hysteresisMs: number;
  private readonly downTrigger: number;
  private readonly upTrigger: number;
  private readonly onScaleChanged: ((scale: number, medianFrameMs: number) => void) | undefined;
  private readonly now: () => number;

  private budgetMs: number;
  private currentScale: number;
  private lastChangeMs: number;
  private lastMedianMs = 0;
  private changeCount = 0;
  private enabledFlag = true;

  constructor(options: IResolutionGovernorOptions = {}) {
    this.sampleCount = Math.max(2, Math.floor(options.sampleCount ?? DEFAULTS.sampleCount));
    this.minScale = options.minScale ?? DEFAULTS.minScale;
    this.maxScale = options.maxScale ?? DEFAULTS.maxScale;
    this.step = options.step ?? DEFAULTS.step;
    this.hysteresisMs = options.hysteresisMs ?? DEFAULTS.hysteresisMs;
    this.downTrigger = options.downTrigger ?? DEFAULTS.downTrigger;
    this.upTrigger = options.upTrigger ?? DEFAULTS.upTrigger;
    this.onScaleChanged = options.onScaleChanged;
    this.now = options.now ?? (() => performance.now());

    this.budgetMs = 1000 / Math.max(1, options.targetFps ?? DEFAULTS.targetFps);
    this.currentScale = this.maxScale;
    this.lastChangeMs = this.now();

    this.samples = new Float64Array(this.sampleCount);
    this.scratch = new Float64Array(this.sampleCount);
  }

  /** Current drawing-buffer multiplier in `[minScale, maxScale]`. */
  get scale(): number {
    return this.currentScale;
  }

  /** Median of the current window, in milliseconds. 0 until the window fills. */
  get medianFrameMs(): number {
    return this.lastMedianMs;
  }

  /** The frame budget being defended, in milliseconds. */
  get budget(): number {
    return this.budgetMs;
  }

  /** When false, `sample()` still records but never changes the scale. */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  set enabled(value: boolean) {
    this.enabledFlag = value;
  }

  /** Re-target. Called when the quality tier changes. */
  setTargetFps(fps: number): void {
    this.budgetMs = 1000 / Math.max(1, fps);
  }

  /**
   * Clamp the scale range. Used when a tier change tightens the floor.
   * Re-clamps the current scale immediately.
   */
  setScaleRange(min: number, max: number): void {
    this.minScale = Math.min(min, max);
    this.maxScale = Math.max(min, max);
    const clamped = Math.min(this.maxScale, Math.max(this.minScale, this.currentScale));
    if (clamped !== this.currentScale) {
      this.currentScale = clamped;
      this.changeCount++;
      this.lastChangeMs = this.now();
      this.onScaleChanged?.(clamped, this.lastMedianMs);
    }
  }

  /** Force a scale, snapped to the step grid, and restart the dwell timer. */
  setScale(scale: number): void {
    const snapped = this.snap(scale);
    if (snapped === this.currentScale) return;
    this.currentScale = snapped;
    this.changeCount++;
    this.lastChangeMs = this.now();
    this.onScaleChanged?.(snapped, this.lastMedianMs);
  }

  /** Drop every sample and return to full scale. Call after a tier change. */
  reset(scale = this.maxScale): void {
    this.head = 0;
    this.filled = 0;
    this.lastMedianMs = 0;
    this.currentScale = this.snap(scale);
    this.lastChangeMs = this.now();
  }

  /**
   * Record one frame and possibly adjust the scale.
   *
   * @param frameMs Wall-clock milliseconds the last frame took.
   * @returns true when the scale changed and render targets must be resized.
   */
  sample(frameMs: number): boolean {
    // Guard against the pathological deltas a backgrounded tab produces: a
    // 4-second "frame" would otherwise poison the window for 30 frames.
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 2000) return false;

    this.samples[this.head] = frameMs;
    this.head = (this.head + 1) % this.sampleCount;
    if (this.filled < this.sampleCount) this.filled++;

    if (this.filled < this.sampleCount) return false;

    const now = this.now();
    if (now - this.lastChangeMs < this.hysteresisMs) return false;

    const median = this.computeMedian();
    this.lastMedianMs = median;
    if (!this.enabledFlag) return false;

    let next = this.currentScale;
    if (median > this.budgetMs * this.downTrigger) {
      next = this.currentScale - this.step;
    } else if (median < this.budgetMs * this.upTrigger) {
      next = this.currentScale + this.step;
    }

    next = this.snap(next);
    if (next === this.currentScale) return false;

    this.currentScale = next;
    this.changeCount++;
    this.lastChangeMs = now;
    // Fresh window: samples taken at the old scale say nothing about the new
    // one, and keeping them would make the next decision react to history.
    this.head = 0;
    this.filled = 0;
    this.onScaleChanged?.(next, median);
    return true;
  }

  /** Decision state, for the debug HUD. */
  getState(): IResolutionGovernorState {
    return {
      scale: this.currentScale,
      medianFrameMs: this.lastMedianMs,
      budgetMs: this.budgetMs,
      samples: this.filled,
      msSinceChange: this.now() - this.lastChangeMs,
      changes: this.changeCount,
    };
  }

  /** Median of the filled window. Allocation-free. */
  private computeMedian(): number {
    const n = this.filled;
    for (let i = 0; i < n; i++) this.scratch[i] = this.samples[i]!;
    // Insertion sort: n is 30 and the array is nearly sorted in practice, so
    // this beats a generic sort and, unlike Array.prototype.sort, allocates
    // nothing.
    for (let i = 1; i < n; i++) {
      const value = this.scratch[i]!;
      let j = i - 1;
      while (j >= 0 && this.scratch[j]! > value) {
        this.scratch[j + 1] = this.scratch[j]!;
        j--;
      }
      this.scratch[j + 1] = value;
    }
    const mid = n >> 1;
    return (n & 1) === 1 ? this.scratch[mid]! : (this.scratch[mid - 1]! + this.scratch[mid]!) * 0.5;
  }

  /** Snap to the step grid and clamp, avoiding float drift like 0.7499999. */
  private snap(scale: number): number {
    const clamped = Math.min(this.maxScale, Math.max(this.minScale, scale));
    return Math.round(clamped / this.step) * this.step;
  }
}
