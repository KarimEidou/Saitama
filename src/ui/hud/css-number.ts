/**
 * NUMBERS THAT CHANGE 60 TIMES A SECOND WITHOUT TOUCHING A TEXT NODE
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 * An encounter timer, a civilian counter and a collateral ticker all have to
 * change while the fight is happening. `node.textContent = '1:07'` replaces a
 * text node, which dirties the containing box, which — if that box is
 * auto-sized, and in a HUD it always is — dirties its row, its column and the
 * flex line above it. Sixty times a second, on a phone, next to a renderer that
 * wants the whole frame budget.
 *
 * ── THE FIX ────────────────────────────────────────────────────────────────
 * CSS COUNTERS. `counter-reset` accepts a custom property, and `content:
 * counter(n)` prints it as generated content on a pseudo-element:
 *
 *     .n         { counter-reset: ni var(--n-i); }
 *     .n::after  { content: counter(ni); }
 *
 * Writing `--n-i` is a custom-property write, which is the only thing the 60 Hz
 * path is permitted to do. The digits are produced by the style engine.
 *
 * ── THE TWO WAYS THIS BITES ────────────────────────────────────────────────
 * 1. `counter-reset: ni var(--n-i)` is INVALID unless `--n-i` resolves to an
 *    <integer>. `--n-i: 1.5` does not round, it invalidates: the counter never
 *    resets, `counter(ni)` prints 0, and the variable reads `1.5` in devtools
 *    the whole time. `FrameWriter.setInteger` exists for exactly this. A
 *    fractional part is therefore carried as its OWN integer counter.
 * 2. A counter is scoped to its element's SUBTREE, so `counter-reset` on the
 *    box and `content: counter(...)` on that box's own `::after` works, and on
 *    a SIBLING does not. Every readout is a leaf element for this reason, which
 *    also means the shared `--n-i` name can never collide between instances:
 *    it is an inline style on a node with no element children.
 *
 * ── LAYOUT STABILITY ───────────────────────────────────────────────────────
 * Every readout is `font-variant-numeric: tabular-nums` and `contain: layout
 * style`, so a digit changing width can neither reflow its neighbours nor push
 * the row. The harness asserts a cumulative layout shift of exactly zero during
 * a scripted animation, which is the check that proves this rather than
 * assuming it.
 */

import { el } from './dom';
import type { CssVarName, FrameWriter } from './frame-writer';

const VAR_INT: CssVarName = '--n-i';
const VAR_FRAC: CssVarName = '--n-f';
const VAR_SIGN: CssVarName = '--n-sign';

/** How a {@link CssNumber} renders. */
export interface ICssNumberSpec {
  /** Root class, in addition to `hud-num`. */
  readonly className?: string;
  /** Fixed decimal places, 0..2. CSS can zero-pad two digits and no more. */
  readonly decimals?: number;
  /** Zero-pad the integer part to two digits, for clock seconds. */
  readonly pad2?: boolean;
  /** Literal shown before the digits, e.g. `¥`. */
  readonly prefix?: string;
  /** Literal shown after the digits, e.g. `B` or `s`. */
  readonly suffix?: string;
  /** Render `+`/`−` from the sign of the value. */
  readonly signed?: boolean;
  /** Debug handle; surfaces as `data-num`. */
  readonly id?: string;
}

/** A numeric readout driven entirely by custom properties. */
export class CssNumber {
  readonly element: HTMLElement;
  private readonly decimals: number;
  private readonly signed: boolean;
  private readonly fracScale: number;

  constructor(doc: Document, spec: ICssNumberSpec = {}) {
    this.decimals = Math.max(0, Math.min(2, spec.decimals ?? 0));
    this.signed = spec.signed === true;
    this.fracScale = 10 ** this.decimals;

    const classes = ['hud-num'];
    if (spec.className) classes.push(spec.className);
    if (spec.pad2) classes.push('hud-num--pad2');
    if (this.decimals > 0) classes.push(`hud-num--dec${this.decimals}`);

    this.element = el(doc, 'span', {
      className: classes.join(' '),
      dataset: spec.id ? { num: spec.id } : undefined,
      vars: {
        ...(spec.prefix ? { '--n-prefix': `'${escapeCssString(spec.prefix)}'` } : {}),
        ...(spec.suffix ? { '--n-suffix': `'${escapeCssString(spec.suffix)}'` } : {}),
      },
    });
  }

  /** Push a value. Safe to call every frame; unchanged values cost nothing. */
  write(writer: FrameWriter, value: number): void {
    const finite = Number.isFinite(value) ? value : 0;
    const magnitude = Math.abs(finite);
    // Round ONCE, on the scaled value, so 9.97 at one decimal becomes 10.0 and
    // never 9.10 — which is what rounding the two parts independently gives.
    const scaled = Math.round(magnitude * this.fracScale);
    const whole = Math.floor(scaled / this.fracScale);
    const frac = scaled - whole * this.fracScale;
    writer.setInteger(this.element, VAR_INT, whole);
    if (this.decimals > 0) writer.setInteger(this.element, VAR_FRAC, frac);
    if (this.signed) {
      writer.set(this.element, VAR_SIGN, scaled === 0 || finite > 0 ? "'+'" : "'−'");
    }
  }

  /**
   * Point the suffix at a custom property the caller owns, for units that
   * change (`K` -> `M` -> `B`). Set once at build time; the referenced property
   * is then written per frame like any other.
   */
  setSuffixVar(name: CssVarName): void {
    this.element.style.setProperty('--n-suffix', `var(${name}, '')`);
  }
}

/**
 * Escape a literal for a CSS string token.
 *
 * Only the backslash and the quote can break out; everything else — including
 * the yen sign and the CJK unit characters — is legal inside a quoted string.
 */
export function escapeCssString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * The stylesheet fragment the readouts need.
 *
 * Lives beside the class rather than in `styles.ts` so the counter contract and
 * the CSS implementing it cannot drift apart.
 */
export const CSS_NUMBER_STYLES = `
.hud-num{
  display:inline-block;
  font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1;
  /* Contain the digits: a width change dirties this box and stops there. */
  contain:layout style;
  counter-reset:ni var(--n-i,0) nf var(--n-f,0);
}
.hud-num::before{content:var(--n-sign,'') var(--n-prefix,'')}
.hud-num::after{content:counter(ni) var(--n-suffix,'')}
.hud-num--pad2::after{content:counter(ni,decimal-leading-zero) var(--n-suffix,'')}
.hud-num--dec1::after{content:counter(ni) '.' counter(nf) var(--n-suffix,'')}
.hud-num--dec2::after{content:counter(ni) '.' counter(nf,decimal-leading-zero) var(--n-suffix,'')}
`;
