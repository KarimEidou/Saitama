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
 * GENERATED CONTENT FROM A CUSTOM PROPERTY. JS formats the value into a CSS
 * <string> and writes it to one property; the stylesheet prints that string on
 * a pseudo-element:
 *
 *     .n::after { content: var(--n-text,'0') var(--n-suffix,''); }
 *
 * Writing `--n-text` is a custom-property write, which is the only thing the
 * 60 Hz path is permitted to do (`frame-writer.ts` explains why that rule is
 * phrased the way it is). No text node is replaced and nothing inside the box
 * can dirty the row above it — the digits are produced by the style engine out
 * of a value the engine already has.
 *
 * ── WHY NOT CSS COUNTERS, WHICH IS WHAT THIS USED TO DO ────────────────────
 * Until this was rewritten the digits came from a counter, which is smaller,
 * prettier, and does not work on the device this game ships on:
 *
 *     .n         { counter-reset: ni var(--n-i,0); }   <- DO NOT REINSTATE
 *     .n::after  { content: counter(ni); }
 *
 * On the shipping Android WebView EVERY numeric readout in the HUD printed
 * `0` — `RANK 0`, `RANK ×0.00`, `¥0.00B`, `0 PIECES`, the encounter clock
 * `0:00`, `0%` on the loading screen — while the identical code printed correct
 * values in headless Chromium. Three things measured off a device screenshot
 * pin the mechanism:
 *
 *   1. The loading bar's FILL was right. Its fill measured 206/960 of the
 *      track; `game.ts` maps progress through `0.14 + clamp01(p) * 0.36`, which
 *      puts the progress behind that bar at 0.2141 — the 21% the label beside
 *      it was refusing to print. So the value arrived, `frame()` ran, and the
 *      write happened. The number was there the whole time.
 *   2. The `%` suffix and the `×` prefix DID render. Both are `var()`
 *      substituted inside `content`, so var-in-content works in that engine.
 *   3. Only the digits were missing — and the digits were the one part routed
 *      through `counter-reset: ni var(--n-i,0)`.
 *
 * A `var()` that fails to substitute invalidates the WHOLE declaration at
 * computed-value time (CSS Variables 1 §3), and an invalid `counter-reset` does
 * not degrade: no counter named `ni` is ever instantiated, and `counter()` on a
 * counter that does not exist prints `0`. That is the failure exactly — every
 * readout, permanently, while `--n-i` reads the correct integer in devtools.
 *
 * The value being substituted was ALREADY a bare integer token (`FrameWriter`
 * guaranteed it), so there is no value this module could have written that
 * would make that engine accept it. Registering `--n-i` as
 * `@property syntax:'<integer>'` was weighed and rejected for the same reason:
 * the token going in is already `21`, registration cannot make it more of an
 * integer, and it would move the fix into a stylesheet this module does not
 * own. `content` substitution is the same trick minus the one step that engine
 * gets wrong — and it is what `.hud-charge__label::after` has been printing the
 * intent word with, on the same device, the whole time.
 *
 * The cost is that JS now does the zero-padding `counter(…,
 * decimal-leading-zero)` used to do. That is the entire reason `--n-i`/`--n-f`
 * and the `--pad2`/`--dec1`/`--dec2` rules are gone: one property, one rule.
 *
 * ── THE STRING ─────────────────────────────────────────────────────────────
 * Everything that lands in `content` must be a valid, QUOTED CSS <string>.
 * Three characters end one early — `'`, `\`, and a raw newline, which
 * terminates the token and takes the declaration with it — and `quoted()`
 * handles all three for every literal this module emits. The digits themselves
 * cannot contain any of them (they come out of `Number` and are `[0-9.]`), but
 * they go through the same door as the caller's `prefix`/`suffix`, which
 * absolutely can, and a test pins that alphabet rather than trusting this
 * paragraph.
 *
 * ── LAYOUT STABILITY, AND THE BASELINE ─────────────────────────────────────
 * `font-variant-numeric: tabular-nums` gives every digit the same advance, so a
 * readout that keeps its digit COUNT keeps its width and moves nothing. The
 * harness asserts a cumulative layout shift of exactly zero across 120 frames
 * of scripted animation, which is the check that proves it rather than assuming
 * it.
 *
 * This box also used to declare `contain: layout style`, and that cost us the
 * baseline. CSS Containment 2 is explicit: for the purpose of `vertical-align`
 * a layout-contained box "is treated as having no baseline", so an
 * `align-items: baseline` row holding one synthesises a baseline from its
 * BOTTOM MARGIN EDGE instead, and the digits float a descender above the label
 * they are aligned with — measured 4.0 CSS px at the loading row's 13 px type,
 * 4.0 px at the 19 px rank chip and the collateral row, 4.7 px at the 23 px
 * encounter clock, which is what made that clock's colon look detached. Six
 * baseline rows in `styles.ts` were affected.
 *
 * Layout containment was not buying the protection the comment here used to
 * claim, either: it isolates the INSIDE of the box, but the box's intrinsic
 * width still tracks its content, so it never stopped a digit change from
 * reflowing the row — only `contain: size` would, and that collapses the box to
 * nothing. `tabular-nums` is what actually holds the width, and the harness's
 * zero-CLS assertion still passes without the `layout` keyword.
 */

import { el } from './dom';
import { clampToFixedRange, type CssVarName, type FrameWriter } from './frame-writer';

/** The formatted digits, quoted, ready for `content`. */
const VAR_TEXT: CssVarName = '--n-text';
const VAR_SIGN: CssVarName = '--n-sign';

/** How a {@link CssNumber} renders. */
export interface ICssNumberSpec {
  /** Root class, in addition to `hud-num`. */
  readonly className?: string;
  /** Fixed decimal places, 0..2. */
  readonly decimals?: number;
  /**
   * Zero-pad the integer part to two digits, for clock seconds. Mutually
   * exclusive with `decimals`.
   */
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
  private readonly pad2: boolean;
  private readonly signed: boolean;
  private readonly fracScale: number;

  constructor(doc: Document, spec: ICssNumberSpec = {}) {
    /*
     * Two decimals is a product decision, not an engine limit any more — the
     * old cap existed because `counter(…, decimal-leading-zero)` pads exactly
     * two digits and no more. It stays because every readout in the HUD is
     * money, a multiplier or a clock, all of which are specified to two, and a
     * third digit of yen on a phone is noise the player cannot use.
     */
    this.decimals = Math.max(0, Math.min(2, spec.decimals ?? 0));
    this.pad2 = spec.pad2 === true;
    if (this.pad2 && this.decimals > 0) {
      throw new Error(
        'CssNumber: `pad2` and `decimals` cannot be combined. A zero-padded ' +
          'integer part with a fraction after it is not a format this HUD has ' +
          'a use for, and the readout that looks like it wants one — the ' +
          'encounter clock — wants two readouts with a literal colon between ' +
          'them so the colon can be styled. Use two, as the clock does.'
      );
    }
    this.signed = spec.signed === true;
    this.fracScale = 10 ** this.decimals;

    /*
     * The formatting classes no longer select anything: JS does the padding the
     * stylesheet used to. They stay because they are what the DOM says about
     * how a readout is formatted, and every tool that looks at this HUD from
     * the outside — the harness's panel dump, a screenshot being argued about,
     * devtools — reads the DOM.
     */
    const classes = ['hud-num'];
    if (spec.className) classes.push(spec.className);
    if (this.pad2) classes.push('hud-num--pad2');
    if (this.decimals > 0) classes.push(`hud-num--dec${this.decimals}`);

    this.element = el(doc, 'span', {
      className: classes.join(' '),
      dataset: spec.id ? { num: spec.id } : undefined,
      vars: {
        ...(spec.prefix ? { '--n-prefix': quoted(spec.prefix) } : {}),
        ...(spec.suffix ? { '--n-suffix': quoted(spec.suffix) } : {}),
      },
    });
  }

  /** Push a value. Safe to call every frame; unchanged values cost nothing. */
  write(writer: FrameWriter, value: number): void {
    const finite = Number.isFinite(value) ? value : 0;
    /*
     * Magnitude only. An unsigned readout has always printed `|value|` — the
     * minus sign is `signed`'s job, because a bare `-` in front of a display
     * face at 11 px reads as a hyphen and the HUD wants `−`.
     *
     * Clamped before it is scaled: `String(1e21)` is `"1e+21"`, and a readout
     * that prints `1e+21` in a display face is worse than one that prints a
     * saturated number. Nothing here is within twenty orders of magnitude of
     * the clamp, so reaching it means the value was already nonsense.
     */
    const magnitude = clampToFixedRange(Math.abs(finite));
    // Round ONCE, on the scaled value, so 9.97 at one decimal becomes 10.0 and
    // never 9.10 — which is what rounding the two parts independently gives.
    const scaled = Math.round(magnitude * this.fracScale);
    const whole = Math.floor(scaled / this.fracScale);
    let text = String(whole);
    if (this.pad2) text = text.padStart(2, '0');
    if (this.decimals > 0) {
      const frac = scaled - whole * this.fracScale;
      text += `.${String(frac).padStart(this.decimals, '0')}`;
    }
    /*
     * One property, one write. Dedupe stays where it has always been — in
     * `FrameWriter`, which compares this string against the last one it wrote
     * to this element and skips the CSSOM call when they match. Doing it here
     * instead would be marginally cheaper and would hide every skip from the
     * harness's writes-vs-skips count, which is the only number that says
     * whether the HUD is actually idle when it looks idle.
     */
    writer.set(this.element, VAR_TEXT, quoted(text));
    if (this.signed) {
      writer.set(this.element, VAR_SIGN, quoted(scaled === 0 || finite > 0 ? '+' : '−'));
    }
  }

  /**
   * Point the suffix at a custom property the caller owns, for units that
   * change (`K` -> `M` -> `B`). Set once at build time; the referenced property
   * is then written per frame like any other.
   *
   * The suffix is kept as its own `var()` inside `content` rather than folded
   * into `--n-text` precisely so this stays possible — and because that is the
   * half of the readout the device was already rendering correctly.
   */
  setSuffixVar(name: CssVarName): void {
    this.element.style.setProperty('--n-suffix', `var(${name}, '')`);
  }
}

/** Characters that would end a quoted CSS string early. */
const NEEDS_ESCAPE = /['\\\n\r\f]/;

/**
 * Wrap a literal as a CSS string token, escaping it only if it needs it.
 *
 * The test is one regex against a short string; the escape is five passes. The
 * digits — the only thing here written at 60 Hz — never need it, so they never
 * pay for it, and every literal still goes through one door that cannot emit an
 * unterminated string.
 */
function quoted(text: string): string {
  return `'${NEEDS_ESCAPE.test(text) ? escapeCssString(text) : text}'`;
}

/**
 * Escape a literal for a CSS string token.
 *
 * Three things break a quoted string: the backslash, the quote, and a RAW
 * NEWLINE — a CSS string cannot span lines, so a newline terminates the token
 * and the whole declaration is dropped rather than degrading. The backslash pass
 * must run first, or the escapes introduced below would be escaped again.
 * Everything else, including the yen sign and the CJK unit characters, is legal
 * inside a quoted string and is passed through.
 */
export function escapeCssString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\A ')
    .replace(/\r/g, '\\D ')
    .replace(/\f/g, '\\C ');
}

/**
 * The stylesheet fragment the readouts need.
 *
 * Lives beside the class rather than in `styles.ts` so the contract between the
 * property names and the CSS reading them cannot drift apart.
 */
export const CSS_NUMBER_STYLES = `
.hud-num{
  display:inline-block;
  font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1;
  /* \`style\`, never \`layout\`: a layout-contained box is treated as having NO
     BASELINE, and every baseline row in styles.ts then aligns this box by its
     bottom margin edge and floats the digits above the label. See the top of
     this file. What is left says only "no counter or quote inside this leaf
     escapes it", which is the whole truth about a box whose content is
     generated. */
  contain:style;
}
.hud-num::before{content:var(--n-sign,'') var(--n-prefix,'')}
.hud-num::after{content:var(--n-text,'0') var(--n-suffix,'')}
`;
