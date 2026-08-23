/**
 * STYLESHEET TESTS
 *
 * The HUD writes custom properties and lets CSS compose every real property, so
 * a bug in the composition is invisible to every other test in this module: the
 * variable is written, reads correctly in devtools, and paints nothing. Four of
 * the six meters shipped that way.
 *
 * These assertions are deliberately structural rather than visual — there is no
 * browser here, so they check the things that decided those bugs:
 *
 *   THE BOX      `transform` is ignored on a non-replaced INLINE box (CSS
 *                Transforms 1) and `height` does not apply to one (CSS 2.1). A
 *                fill rule put on a <span> therefore has to establish its own
 *                block box or it has no geometry at all.
 *   THE CASCADE  a REGISTERED custom property with `inherits:false` is not
 *                visible inside `::after`, and its `var(…, fallback)` never
 *                fires because a registered property is never
 *                guaranteed-invalid.
 *   THE SCALE    five type sizes, and a sixth fails the build. The sheet used
 *                to carry seventeen, which is why nothing lined up.
 *
 * Anything a browser could measure instead — computed `display`, real tap-target
 * rects, whether two panels overlap — belongs in `harness/hud.verify.ts`; these
 * are the guards that can run in a unit test, on every commit.
 *
 * ── THE HAND-MAINTAINED LISTS ARE NOW COMPLETENESS GUARDS ──────────────────
 * `FILLS` and `CONTROLS` used to be arrays somebody had to remember to add to,
 * which means they asserted things about the rules already in them and nothing
 * at all about a new one. Each is now checked BOTH WAYS: every listed selector
 * must satisfy its rule, AND every rule in the sheet that looks like a fill or
 * takes a touch must be listed. A new meter that forgets `display:block` now
 * fails on the day it is written rather than on the day somebody notices it
 * paints nothing.
 *
 * ── WHY THE SHEET IS PARSED WITH A REGEX ───────────────────────────────────
 * There is no CSS parser in this repo's dependency tree and adding one to run a
 * structural guard would be a larger change than the guard. The cost is a
 * contract the stylesheet has to keep, and it is written down at the top of
 * `styles.ts`: every rule these tests look at stands alone rather than in a
 * comma group, and no rule body contains a nested brace.
 */

import { describe, expect, it } from 'vitest';
import { hudStyles } from '../styles';
import { MIN_TAP_PX, PALETTES, PALETTE_NAMES } from '../tokens';

const CSS = hudStyles();

/**
 * The sheet with its comments removed.
 *
 * Comments carry CSS in prose — "`display:block` is not decoration", "it used
 * to inherit `background:none`" — and this file's whole job is to notice
 * declarations. Stripping them first is the difference between a guard and a
 * guard that reports its own documentation as a violation.
 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every `selector { body }` pair in the sheet, in source order.
 *
 * Anchored at a rule boundary — start of input, or the `}` `,` or newline that
 * ends the previous one — so a declaration cannot be mistaken for a selector.
 * `@` is excluded from the selector so `@media`, `@property` and `@keyframes`
 * headers do not match; the rules INSIDE a media query still do, because they
 * start on their own line, which is what the landscape and portrait overrides
 * need. A body cannot contain a brace, which is the contract `styles.ts`
 * documents at the top of itself: no nesting, no `&`, no `@supports` in a rule.
 */
const RULES: readonly { selector: string; body: string }[] = [
  ...BARE.matchAll(/(?:^|[\n},])\s*([^{}@\s][^{}@]*?)\s*\{([^{}]*)\}/g),
].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));

/**
 * The declarations of every rule with exactly this selector.
 *
 * Returns all of them because the shipping landscape and portrait media queries
 * re-declare several of these selectors — and because `.hud-root` is declared
 * twice on purpose, once by `safe-area.ts` and once here.
 */
function ruleBodies(selector: string): string[] {
  const bodies = RULES.filter((rule) => rule.selector === selector).map((rule) => rule.body);
  expect(bodies.length, `no rule for "${selector}"`).toBeGreaterThan(0);
  return bodies;
}

/** The first, i.e. the top-level rule rather than a media-query override. */
function ruleBody(selector: string): string {
  return ruleBodies(selector)[0]!;
}

/** Every declaration a selector makes anywhere in the sheet, as one string. */
function allDeclarations(selector: string): string {
  return ruleBodies(selector).join(';');
}

/* -------------------------------------------------------------------------- */

describe('the meters paint', () => {
  /** Every element a `--fill`/`--collateral`/`--boredom` scaleX is applied to. */
  const FILLS = [
    '.hud-boss__fill',
    '.hud-ledger__fill',
    '.hud-boredom__fill',
    '.hud-loading__fill',
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

  it('lists every fill in the sheet, so a new meter cannot skip the guard', () => {
    // The completeness half. A meter added without `display:block` used to be
    // invisible to this file entirely, because this file only knew the meters
    // somebody had remembered to type into the array above.
    const found = RULES.filter((rule) => rule.body.includes('transform:scaleX(var(--')).map(
      (rule) => rule.selector
    );
    expect(found.length).toBeGreaterThan(0);
    for (const selector of found) expect(FILLS, `${selector} paints a fill`).toContain(selector);
  });

  it('registers --fill as INHERITED, because one consumer is a pseudo-element', () => {
    // A writer can only reach the originating element; `::after` inherits from
    // it exactly as a child does. With `inherits:false` the registered
    // initial-value wins inside the pseudo and the sliver reads 0 forever.
    expect(CSS).toMatch(/@property --fill\{syntax:'<number>';inherits:true;initial-value:0\}/);
    expect(ruleBody('.hud-standing__bar::after')).toContain('var(--fill');
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
    // The plate's paint is on the backing pseudo-element, not on the panel box:
    // that is what lets the chamfer and the 3° lean happen without moving the
    // rectangle every geometry assertion in the harness measures.
    expect(ruleBody('.hud-panel::before')).toContain('background:var(--hud-panel)');
    expect(ruleBody('.hud-sheet')).toContain('background:var(--hud-panel)');
    expect(ruleBody('.hud-loading')).toContain('background:var(--hud-panel)');
  });

  it('lays the surface down repeatedly, which is the daylight fix', () => {
    // --hud-surface is 82% opaque, tuned against the dusk sky in the reference
    // shots; the shipping game is DAYTIME and ~18% of a lit facade came through
    // as visible banding across the rank chip. n layers compose to 1-(1-a)^n,
    // so every palette gets denser by ITS OWN colour rather than by a literal
    // that would make four of the five surfaces dead data again.
    const panel = /--hud-panel:([^;]*);/.exec(CSS)?.[1] ?? '';
    expect(panel.split('var(--hud-surface)').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('puts no vertical gradient on a plate', () => {
    // The old panel was "a barely-there vertical gradient", which is the house
    // style of every card in every framework and half of why six panels read as
    // interchangeable. A stamped plate gets a hard lit top edge instead.
    const panel = /--hud-panel:([^;]*);/.exec(CSS)?.[1] ?? '';
    expect(panel).not.toContain('180deg');
    expect(ruleBody('.hud-panel::before')).toContain('inset 0 1px 0 0 var(--hud-line)');
  });

  it('publishes every palette surface, and consumes it', () => {
    for (const name of PALETTE_NAMES) {
      const body = ruleBody(`.hud-root[data-palette='${name}']`);
      expect(body, name).toContain(`--hud-surface:${PALETTES[name].surface}`);
    }
    expect(CSS.split('var(--hud-surface)').length - 1).toBeGreaterThan(0);
  });

  it('never tints a panel with a semantic colour', () => {
    // COLOUR IS INK ON PAPER: it appears as the edge rule, the numeral, or the
    // meter fill, and nowhere else. `.hud-btn--primary` used to fill itself
    // with 26% of the accent and `.hud-row[data-selected]` with 10% of it, both
    // of which lower the panel contrast `palette.test.ts` measures in order to
    // say something a 3 px rule says louder.
    for (const rule of RULES) {
      // A METER FILL is the one place a background may be semantic — it is the
      // third of the three permitted uses, alongside the edge rule and the
      // numeral. A fill identifies itself by being a fill.
      if (rule.body.includes('transform:scaleX(var(--')) continue;
      const backgrounds = rule.body.match(/background(?:-color)?:[^;]*/g) ?? [];
      for (const declaration of backgrounds) {
        expect(
          /color-mix\([^)]*var\(--hud-(accent|tier|saved|lost|collateral|commit|rival|verdict|class)/.test(
            declaration
          ),
          `${rule.selector} tints its panel: ${declaration}`
        ).toBe(false);
      }
    }
  });
});

describe('the type scale', () => {
  /**
   * Five steps and nothing else.
   *
   * The sheet used to carry 10, 11, 11.5, 12, 13, 14, 15, 16, 17, 18, 19, 20,
   * 21, 22, 23, 26 and 52 px, which is not a scale, it is seventeen separate
   * decisions — and it is precisely why nothing lined up: the loading row's
   * baseline mismatch was two of those steps meeting at a `align-items:baseline`.
   */
  const STEPS = ['--t-micro', '--t-body', '--t-title', '--t-readout', '--t-hero'];

  it('declares all five steps as multiples of --hud-scale', () => {
    const root = allDeclarations('.hud-root');
    for (const step of STEPS) {
      expect(root, step).toMatch(new RegExp(`${step}:calc\\(\\d+px \\* var\\(--hud-scale\\)\\)`));
    }
  });

  it('sets every font-size from one of them, and never from a literal', () => {
    const sizes = [...CSS.matchAll(/font-size:([^;}]*)/g)].map((match) => match[1]!.trim());
    expect(sizes.length).toBeGreaterThan(20);
    for (const size of sizes) {
      // `inherit` is not a sixth step, it is a refusal to have a size — the
      // charge cost and the fight clock's digits defer to the box around them.
      if (size === 'inherit') continue;
      const tokens = [...size.matchAll(/var\((--t-[a-z]+)\)/g)].map((match) => match[1]!);
      expect(tokens.length, `font-size:${size} names no scale step`).toBeGreaterThan(0);
      for (const token of tokens) expect(STEPS, `font-size:${size}`).toContain(token);
      // A clamp is allowed — the boot title is fluid between two steps — but
      // both ends of it have to be steps, and nothing else may carry a px.
      const withoutTokens = size.replace(/var\(--t-[a-z]+\)/g, '');
      expect(withoutTokens, `font-size:${size} carries a literal size`).not.toMatch(
        /\d+(\.\d+)?px/
      );
    }
  });

  it('tracks by size: heavy only where 10 px needs the air', () => {
    // Uniform .12-.16em at every size flattens the hierarchy the sizes are
    // establishing — it makes 10 px look like 18 px look like 24 px. Heavy
    // tracking survives only on the micro step, which is uppercase and needs
    // it; everything above 15 px is ~.06em or tighter.
    for (const rule of RULES) {
      const tracking = /letter-spacing:\.(\d+)em/.exec(rule.body);
      if (tracking === null) continue;
      const em = Number(`0.${tracking[1]!}`);
      if (em <= 0.06) continue;
      expect(
        rule.body.includes('var(--t-micro)') || !rule.body.includes('font-size:'),
        `${rule.selector} tracks at ${em}em above the micro step`
      ).toBe(true);
    }
  });
});

describe('tap targets', () => {
  /**
   * Everything the player is meant to hit.
   *
   * The duty STRIP is deliberately not on it: `src/ui/input` claims the leading
   * 45 % of the viewport at every height, the strip spans the band, and a
   * tappable strip is therefore a strip that eats movement touches. Its 44 px
   * `.hud-tracker__open` button — a `.hud-btn`, at the strip's trailing end —
   * is the control, and the harness's hit-ownership grid is what settles it.
   */
  const CONTROLS = ['.hud-btn', '.hud-pausebtn', '.hud-seg__opt', '.hud-row--button'];
  /** Layer containers, which take the touch in order to BLOCK it. */
  const LAYERS = ['.hud-screen', '.hud-loading'];

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

  it('lists every rule that takes a touch, so a new control cannot skip it', () => {
    // The completeness half, and the reason it matters is not tap size: a rule
    // that quietly claims `pointer-events:auto` in the wrong rectangle steals a
    // touch from the movement stick, which is invisible in every screenshot.
    // Anything added here has to be looked at.
    const found = RULES.filter((rule) => rule.body.includes('pointer-events:auto')).map(
      (rule) => rule.selector
    );
    expect(found.length).toBeGreaterThan(0);
    for (const selector of found) {
      expect([...CONTROLS, ...LAYERS], `${selector} takes a touch`).toContain(selector);
    }
  });

  it('cuts the pause button and its reserve out of one token', () => {
    expect(CSS).toContain(`--hud-pause-size:${MIN_TAP_PX}px`);
    expect(ruleBody('.hud-pausebtn')).toContain('width:var(--hud-pause-size)');
    // The right column keeps that much clear so the ledger cannot slide under
    // the button; the two numbers were separate literals and could drift.
    expect(ruleBody('.hud-top__right')).toContain('padding-right:calc(var(--hud-pause-size)');
  });

  it('gives the only escape hatch in the game a plate to sit on', () => {
    // It used to inherit `.hud-btn--ghost{background:none}`, which left the
    // pause button as a 1 px hairline and an unshadowed glyph — about 1.2:1
    // over a lit building facade — and it is the only way out of a fight.
    expect(ruleBody('.hud-pausebtn')).not.toContain('background:none');
    expect(ruleBody('.hud-btn::before')).toContain('background:var(--hud-panel)');
  });
});

describe('the plate', () => {
  it('chamfers rather than rounds, from one polygon', () => {
    // `--hud-radius` is 0 and stays 0. The token survives because the meter
    // TRACKS read it, and a square-ended meter is the point.
    expect(allDeclarations('.hud-root')).toContain('--hud-radius:0px');
    expect(allDeclarations('.hud-root')).toMatch(/--hud-plate:polygon\(/);
    for (const selector of ['.hud-panel::before', '.hud-sheet', '.hud-row']) {
      expect(ruleBody(selector), selector).toContain('clip-path:var(--hud-plate)');
    }
  });

  it('draws ONE edge rule and no hairline round the rest', () => {
    // The whole language in one assertion: an inset box-shadow on the leading
    // edge, coloured by whatever that panel means, and no `border:` anywhere on
    // the plate. Six identical hairlines is why a Tiger-level threat used to be
    // drawn with the same weight as a hero name that never changes.
    const backing = ruleBody('.hud-panel::before');
    expect(backing).toMatch(/box-shadow:inset var\(--hud-rule\) 0 0 0 var\(--hud-edge\)/);
    expect(ruleBody('.hud-panel')).not.toMatch(/(?:^|[;\s])border:/);
  });

  it('keeps the lean OFF the layout box', () => {
    // `skewX` on the panel itself widens its bounding rect by ~1.6 px on each
    // side, and `harness/hud.verify.ts` spends that budget on safe-area
    // containment and panel-vs-panel overlap. The backing layer leans; the box
    // the browser reports does not.
    expect(ruleBody('.hud-panel::before')).toContain('transform:skewX(var(--hud-skew))');
    expect(ruleBody('.hud-panel')).not.toContain('skewX');
  });
});

describe('HUD scale', () => {
  it('scales every fixed-width panel with the type inside it, in every media query', () => {
    // At 130 % — the setting a low-vision player picks — a fixed container
    // around scaled type ellipsises the boredom mood word, which IS the meter
    // ("GOING THROUGH TH…"). The vw and 100% caps are untouched, so the default
    // scale renders identically.
    //
    // `.hud-charge` is on the list because it was the one panel with no scale
    // term at all: 184 px wide, in a corridor between the two hands that
    // measures 286 px on the shipping profile. `.hud-boredom` and `.hud-boss`
    // have left it because neither declares a width any more — they are rows
    // inside the plates they belong to — and the duty strip is listed as its
    // PLATE, because the row around it spans the band by grid stretch and has
    // no width of its own to scale.
    for (const selector of [
      '.hud-rankchip',
      '.hud-encounter',
      '.hud-tracker__plate',
      '.hud-charge',
    ]) {
      const sized = ruleBodies(selector).filter((body) => /(?:^|[;\s])width:/.test(body));
      expect(sized.length, selector).toBeGreaterThan(0);
      for (const body of sized) {
        const declaration = /(?:^|[;\s])width:([^;]*)/.exec(body)?.[1] ?? '';
        expect(declaration, selector).toContain('var(--hud-scale)');
      }
    }
  });

  it('drives the whole loading card off one measure', () => {
    // The track and its row were min(62vw,320px) and the flavour line was
    // min(88vw,460px), so the line overhung the bar by 68 px on each side and
    // ran ~83 characters — past the 45-75 a line wants — under a bar it did not
    // line up with. One token, three consumers, no rag.
    expect(allDeclarations('.hud-root')).toMatch(
      /--hud-measure:min\(calc\(\d+px \* var\(--hud-scale\)\)/
    );
    expect(ruleBody('.hud-loading__card')).toContain('width:var(--hud-measure)');
  });
});
