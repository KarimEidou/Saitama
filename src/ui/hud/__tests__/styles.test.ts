/**
 * STYLESHEET TESTS
 *
 * The HUD writes custom properties and lets CSS compose every real property, so
 * a bug in the composition is invisible to every other test in this module: the
 * variable is written, reads correctly in devtools, and paints nothing. Four of
 * the six meters shipped that way.
 *
 * These assertions are deliberately structural rather than visual — there is no
 * browser here, so they check the two things that decided those bugs:
 *
 *   THE BOX      `transform` is ignored on a non-replaced INLINE box (CSS
 *                Transforms 1) and `height` does not apply to one (CSS 2.1). A
 *                fill rule put on a <span> therefore has to establish its own
 *                block box or it has no geometry at all.
 *   THE CASCADE  a REGISTERED custom property with `inherits:false` is not
 *                visible inside `::after`, and its `var(…, fallback)` never
 *                fires because a registered property is never
 *                guaranteed-invalid.
 *
 * Anything a browser could measure instead — computed `display`, real tap-target
 * rects — belongs in `harness/hud.verify.ts`; these are the guards that can run
 * in a unit test, on every commit.
 */

import { describe, expect, it } from 'vitest';
import { hudStyles } from '../styles';
import { MIN_TAP_PX, PALETTES, PALETTE_NAMES } from '../tokens';

const CSS = hudStyles();

/**
 * The declarations of every rule with exactly this selector.
 *
 * Anchored at a rule boundary so `.hud-boss` cannot match `.hud-boss__fill`,
 * and returning all of them because the shipping landscape and portrait media
 * queries re-declare several of these selectors.
 */
function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[\\n},])\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'g');
  const bodies = [...CSS.matchAll(pattern)].map((match) => match[1]!);
  expect(bodies.length, `no rule for "${selector}"`).toBeGreaterThan(0);
  return bodies;
}

/** The first, i.e. the top-level rule rather than a media-query override. */
function ruleBody(selector: string): string {
  return ruleBodies(selector)[0]!;
}

/* -------------------------------------------------------------------------- */

describe('the meters paint', () => {
  /** Every element a `--fill`/`--collateral`/`--boredom` scaleX is applied to. */
  const FILLS = [
    '.hud-boss__fill',
    '.hud-collateral__fill',
    '.hud-boredom__fill',
    '.hud-loading__fill',
    '.hud-rankchip__pts::after',
    '.hud-standing__bar::after',
  ];

  it('gives every scaleX fill a box that can be transformed', () => {
    for (const selector of FILLS) {
      const body = ruleBody(selector);
      expect(body, selector).toMatch(/transform:scaleX\(var\(--/);
      // `display:block` or `position:absolute` — either blockifies. Without one
      // the rule depends on the tag it happens to be put on, and two of these
      // are <span>s.
      expect(body, selector).toMatch(/display:block|position:absolute/);
    }
  });

  it('registers --fill as INHERITED, because two consumers are pseudo-elements', () => {
    // A writer can only reach the originating element; `::after` inherits from
    // it exactly as a child does. With `inherits:false` the registered
    // initial-value wins inside the pseudo and the sliver reads 0 forever.
    expect(CSS).toMatch(/@property --fill\{syntax:'<number>';inherits:true;initial-value:0\}/);
    for (const selector of ['.hud-rankchip__pts::after', '.hud-standing__bar::after']) {
      expect(ruleBody(selector), selector).toContain('var(--fill');
    }
  });

  it('gives the boss bar a real default rather than a dead var() fallback', () => {
    // `--fill` is registered, so `scaleX(var(--fill,1))` can never take the 1:
    // a registered property with an initial value is never guaranteed-invalid.
    // The declaration is the only thing that can say "full until told
    // otherwise", and the bar opens a boss fight before any health arrives.
    expect(ruleBody('.hud-boss__fill')).toContain('--fill:1');
  });
});

describe('the palette reaches the panels', () => {
  it('composes --hud-panel from the palette surface', () => {
    // `IHudPalette.surface` is documented as the panel fill and High contrast
    // sets an OPAQUE one on purpose. A hard-coded gradient here made four of
    // the five surface values dead data.
    expect(CSS).toMatch(/--hud-panel:[^;]*var\(--hud-surface\)/);
    expect(ruleBody('.hud-panel')).toContain('background:var(--hud-panel)');
    expect(ruleBody('.hud-sheet')).toContain('background:var(--hud-panel)');
  });

  it('publishes every palette surface, and consumes it', () => {
    for (const name of PALETTE_NAMES) {
      const body = ruleBody(`.hud-root[data-palette='${name}']`);
      expect(body, name).toContain(`--hud-surface:${PALETTES[name].surface}`);
    }
    expect(CSS.split('var(--hud-surface)').length - 1).toBeGreaterThan(0);
  });
});

describe('tap targets', () => {
  /** Everything the player is meant to hit. */
  const CONTROLS = [
    '.hud-btn',
    '.hud-btn--icon',
    '.hud-pausebtn',
    '.hud-seg__opt',
    '.hud-row--button',
  ];

  it('never sizes a control below MIN_TAP_PX', () => {
    // `tokens.ts` calls anything smaller "a bug, not a style" — and the pause
    // affordance (40 px) and every settings option (38 px) were smaller.
    const sizes = /(?:^|[;\s])(min-width|min-height|width|height):(\d+(?:\.\d+)?)px/g;
    for (const selector of CONTROLS) {
      const body = ruleBody(selector);
      for (const [, property, value] of body.matchAll(sizes)) {
        expect(Number(value), `${selector} ${property}`).toBeGreaterThanOrEqual(MIN_TAP_PX);
      }
    }
  });

  it('cuts the pause button and its reserve out of one token', () => {
    expect(CSS).toContain(`--hud-pause-size:${MIN_TAP_PX}px`);
    expect(ruleBody('.hud-pausebtn')).toContain('width:var(--hud-pause-size)');
    // The right column keeps that much clear so the ledger cannot slide under
    // the button; the two numbers were separate literals and could drift.
    expect(ruleBody('.hud-top__right')).toContain('padding-right:calc(var(--hud-pause-size)');
  });
});

describe('HUD scale', () => {
  it('scales every fixed-width panel with the type inside it, in every media query', () => {
    // At 130 % — the setting a low-vision player picks — a fixed container
    // around scaled type ellipsises the boredom mood word, which IS the meter
    // ("GOING THROUGH TH…"). The vw caps are untouched, so the default scale
    // renders identically.
    for (const selector of ['.hud-boredom', '.hud-tracker', '.hud-boss']) {
      const sized = ruleBodies(selector).filter((body) => /(?:^|[;\s])width:/.test(body));
      expect(sized.length, selector).toBeGreaterThan(0);
      for (const body of sized) {
        expect(body, selector).toMatch(/width:min\(calc\(\d+px \* var\(--hud-scale\)\)/);
      }
    }
  });
});
