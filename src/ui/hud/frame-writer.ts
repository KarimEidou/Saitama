/**
 * THE 60 Hz WRITE DISCIPLINE
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE RULE
 *
 *  Everything on the per-frame path writes CSS CUSTOM PROPERTIES and nothing
 *  else. Not `style.width`, not `style.transform`, not `textContent`.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS IS STRICTER THAN "DON'T TRIGGER LAYOUT" ───────────────────────
 * The expensive failure is not one write, it is INTERLEAVING: a write
 * invalidates layout, a subsequent read (`getBoundingClientRect`, `offsetWidth`,
 * `getComputedStyle`) forces the browser to resolve it synchronously, and the
 * next write invalidates it again. Doing that once per HUD element per frame is
 * how a 60 Hz UI turns into a 24 Hz one on a mid-tier phone, and it never shows
 * up in a profile as anything but "Recalculate Style".
 *
 * A rule phrased as "avoid layout-triggering properties" cannot be checked,
 * because the list is long, version-dependent, and includes things nobody
 * expects (`textContent` on an auto-sized box). A rule phrased as "every write
 * is a custom property" is a one-line assertion. So that is the rule.
 *
 * ── HOW ANYTHING MOVES, THEN ───────────────────────────────────────────────
 * The STYLESHEET composes. JS writes `--fill`, CSS reads
 * `transform: scaleX(var(--fill))`. JS writes `--charge`, CSS reads
 * `stroke-dashoffset: calc(var(--circ) * (1 - var(--charge)))`. JS writes
 * `--sec`, CSS reads `counter-reset: sec var(--sec)` and prints it through
 * `content: counter(sec, decimal-leading-zero)`.
 *
 * That last one is the trick that makes a ticking clock legal: the digits are
 * GENERATED CONTENT derived from a custom property, so a timer counting down at
 * 60 Hz never touches a text node.
 *
 * ── WHY `setProperty` AND NEVER `el.style.foo = …` ─────────────────────────
 * `CSSStyleDeclaration.prototype.setProperty` is a single function, so the
 * harness can wrap it, record every property name written during a scripted
 * animation, and assert the set contains nothing but `--*`. Direct property
 * assignment goes through per-property accessors and is invisible to that
 * instrumentation. Routing every write through one door is what makes the claim
 * testable rather than aspirational.
 */

/** A custom property name. The type system enforces the leading `--`. */
export type CssVarName = `--${string}`;

/** Records what a frame wrote, for the harness and for leak detection. */
export interface IFrameWriterStats {
  /** Writes that actually reached the CSSOM this frame. */
  readonly writes: number;
  /** Writes skipped because the value was unchanged. */
  readonly skipped: number;
  /** Distinct property names ever written by this writer. */
  readonly names: readonly string[];
}

/**
 * The only object allowed to touch the DOM during `update(dt)`.
 *
 * Deduplicates: a boredom meter that has not moved costs zero CSSOM writes and
 * therefore zero style recalculation. Most frames of most HUD elements are
 * no-ops, which is the entire performance story.
 */
export class FrameWriter {
  private writeCount = 0;
  private skipCount = 0;
  private readonly seen = new Set<string>();
  /** Last written value per element per property. */
  private readonly cache = new WeakMap<Element, Map<string, string>>();

  /**
   * Set a custom property, skipping the write when the value is unchanged.
   *
   * @throws when `name` is not a custom property. In development this fires on
   *   the first frame; there is no silent degradation.
   */
  set(element: Element, name: CssVarName, value: string): void {
    if (!name.startsWith('--')) {
      throw new Error(
        `FrameWriter: "${name}" is not a custom property. The 60 Hz path may ` +
          `only write --custom-properties; compose the real property in CSS.`
      );
    }
    let entry = this.cache.get(element);
    if (entry === undefined) {
      entry = new Map();
      this.cache.set(element, entry);
    }
    if (entry.get(name) === value) {
      this.skipCount++;
      return;
    }
    entry.set(name, value);
    this.seen.add(name);
    this.writeCount++;
    (element as HTMLElement | SVGElement).style.setProperty(name, value);
  }

  /** Set a numeric custom property, rounded to `decimals`. */
  setNumber(element: Element, name: CssVarName, value: number, decimals = 3): void {
    this.set(element, name, roundTo(value, decimals));
  }

  /**
   * Set an INTEGER custom property destined for `counter-reset`.
   *
   * `counter-reset: n var(--n)` is invalid at computed-value time if `--n` is
   * not an integer, and an invalid `counter-reset` does not fall back — the
   * counter silently stays at zero and the readout prints `0` forever while the
   * variable reads correct in devtools. Rounding here is not a nicety.
   */
  setInteger(element: Element, name: CssVarName, value: number): void {
    const safe = Number.isFinite(value) ? Math.round(value) : 0;
    this.set(element, name, String(safe));
  }

  /** Set a pixel length. */
  setPx(element: Element, name: CssVarName, value: number, decimals = 1): void {
    this.set(element, name, `${roundTo(value, decimals)}px`);
  }

  /** Forget an element's cached values, e.g. after its node was replaced. */
  invalidate(element: Element): void {
    this.cache.delete(element);
  }

  get stats(): IFrameWriterStats {
    return { writes: this.writeCount, skipped: this.skipCount, names: [...this.seen] };
  }

  resetStats(): void {
    this.writeCount = 0;
    this.skipCount = 0;
  }
}

/**
 * Round without exponential notation and without a trailing `.000`.
 *
 * `String(1e-7)` is `"1e-7"`, which is a valid CSS number, but `String(1e-21)`
 * is `"1e-21"` and CSS number parsing tops out well before that. Fixed notation
 * sidesteps the whole class.
 */
export function roundTo(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '0';
  const text = value.toFixed(decimals);
  // Trim trailing zeros, then a trailing dot: "1.500" -> "1.5", "2.000" -> "2".
  return decimals > 0 ? text.replace(/\.?0+$/, '') || '0' : text;
}
