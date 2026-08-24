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
 * ── AND THEY WERE MUTATION-TESTED, WHICH IS HOW THREE HOLES WERE FOUND ─────
 * A guard nobody has tried to defeat is a guard with an unknown radius. Every
 * assertion here was re-run against a mutated sheet, and three of them were
 * matching a SHAPE where they claimed to enforce a RULE:
 *
 *   THE LITERAL SUBSTRING. Both completeness filters read `body.includes(…)`.
 *   A fill written `transform: scaleX(var(--x))` with one space, or
 *   `scaleX(calc(…))` with a wrapper, vanished from both halves of its own
 *   guard. They are regexes now, declared once and shared by both halves.
 *
 *   THE EXACT SELECTOR. The tap-size loop read `ruleBodies(selector)`, which
 *   matches by string equality, so `.hud-sheet__foot .hud-btn{min-height:30px}`
 *   and `.hud-btn[data-compact]{min-height:28px}` both passed. It is a
 *   containment scan now.
 *
 *   THE BLACKLISTED FUNCTION. "Never tints a panel" tested for `color-mix(…
 *   var(--hud-accent…)` because both original bugs happened to be `color-mix`
 *   washes — so `background:var(--hud-accent)` and `background:rgba(255,210,
 *   48,.12)` walked through it, and nothing else in the repo would have caught
 *   either. It is a whitelist now: neutral tokens and near-achromatic literals,
 *   which needs no list of semantic names to keep up to date.
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
 * How a FILL and a CONTROL identify themselves to the completeness guards.
 *
 * Both used to be `body.includes('…')` against literal text — `'transform:
 * scaleX(var(--'` and `'pointer-events:auto'` — and a literal substring test is
 * a guard with a spelling requirement nothing enforces. The sheet is a template
 * literal, so neither prettier nor eslint normalises a byte of it; one space
 * after a colon, or a `calc()` inside the `scaleX`, and the rule vanished from
 * BOTH halves of its own guard. Mutation-tested against this suite:
 * `transform: scaleX(var(--charge))` MISSED, `scaleX(calc(var(--charge) * 1))`
 * MISSED, `pointer-events: auto` MISSED — a new meter with no `display:block`
 * or a new control with no tap size landing green on the day it is written,
 * which is the exact failure the completeness guards exist to end.
 *
 * Declared once and used by BOTH halves of each guard, because the other way
 * this fails is the two halves disagreeing: a filter that finds a rule the
 * per-selector assertion then does not recognise asserts nothing at all.
 */
const FILL_DECLARATION = /transform:\s*scaleX\(\s*(?:var|calc)\(/;
const TOUCH_DECLARATION = /pointer-events:\s*auto/;

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
      expect(body, selector).toMatch(FILL_DECLARATION);
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
    const found = RULES.filter((rule) => FILL_DECLARATION.test(rule.body)).map(
      (rule) => rule.selector
    );
    expect(found.length).toBeGreaterThan(0);
    for (const selector of found) expect(FILLS, `${selector} paints a fill`).toContain(selector);
  });

  it('draws every meter at one thickness, from one token', () => {
    // The HUD shipped five meters at three thicknesses — 5 px on the boss rule
    // and the boredom meter, 4 px plus a 2 px margin on the collateral track,
    // 3 px on the rank board's seat sliver, 5 px on the boot bar — so on the
    // boss screen, where three of them are visible in one band, the eye read a
    // stepped stair rather than a line. A meter is the same instrument wherever
    // it appears.
    // Found by what a meter IS rather than by a list: a track is the box
    // painted in `--hud-track`, which is the token whose whole job is to make a
    // meter read as a container.
    const tracks = RULES.filter((rule) => rule.body.includes('background:var(--hud-track)'));
    expect(tracks.length, 'no meter tracks found at all').toBeGreaterThan(3);
    for (const track of tracks) {
      expect(track.body, `${track.selector} sets its own thickness`).toContain(
        'height:var(--hud-meter-h)'
      );
    }
  });

  it('clips the breath to the fill it lives inside', () => {
    // The sweep is a child of `.hud-boredom__fill`, and the fill declared no
    // `overflow`, so `translateX(240%)` of the fill's width mapped through
    // `scaleX(var(--boredom))` to 2.4 × b of the TRACK's width — the shimmer
    // crossed the empty grey remainder at every reading except zero, and the
    // only thing stopping it was the box the fix had moved it out of. The
    // comment above the rule claimed the opposite.
    expect(ruleBody('.hud-boredom__fill')).toContain('overflow:hidden');
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

  it('writes no var() fallback on a registered property anywhere', () => {
    // The completeness half of the rule above, and the reason it is a guard
    // rather than a tidy-up: a fallback on a registered property reads as a
    // defensive default and defends nothing, so the next person to need a real
    // default writes another one instead of a declaration. Five of them shipped
    // — on `.hud-boredom__fill`, `.hud-ledger__fill`, `.hud-charge__fill`,
    // `.hud-standing__bar::after` and `.hud-loading__fill` — each harmless only
    // because it happened to repeat the registered initial-value.
    const registered = [...CSS.matchAll(/@property (--[a-z-]+)\{/g)].map((match) => match[1]!);
    expect(registered.length).toBeGreaterThan(0);
    for (const property of registered) {
      const withFallback = new RegExp(`var\\(${property}\\s*,`);
      expect(withFallback.test(BARE), `${property} carries a dead var() fallback`).toBe(false);
    }
    // And the one live fallback survives, because --hud-arc-len is NOT
    // registered and is written from TypeScript.
    expect(BARE).toContain('var(--hud-arc-len,239)');
  });
});

describe('reduced motion', () => {
  it('gives every animated pseudo-element a resting state to land on', () => {
    // `[data-reduced-motion='true'] *::after{animation:none !important}` does
    // not restore anything — it removes the animation and leaves the SPECIFIED
    // style standing. `.hud-alert::after` specified none, so the speed-line
    // hatch fell back to `opacity:1;transform:none`: a full-strength 1-in-7 px
    // screen in the alert's own colour, unskewed, painted permanently across a
    // threat bulletin, for exactly the players who asked for less motion.
    const sweep = ruleBody('.hud-alert::after');
    expect(sweep).toContain('opacity:0');
    expect(sweep).toMatch(/transform:skewX\(var\(--hud-skew\)\)/);
    // And under the type rather than over it: `::after` is a positioned
    // descendant, so with z-index:auto it paints above the in-flow headline —
    // in the same hue as the glyphs.
    expect(sweep).toContain('z-index:-1');
    // The keyframes still supply the visible pass, so nothing above changes
    // what the animation looks like while it runs.
    expect(CSS).toMatch(/@keyframes hud-sweep\{\s*0%\{[^}]*opacity:\.42/);
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

  it('gives every color-mix background a plain colour to fall back to', () => {
    // A DECLARATION THE PARSER DOES NOT UNDERSTAND IS DROPPED, and whatever
    // came before it in the same rule stands. That is the only fallback CSS
    // has, and this HUD has now shipped the alternative twice: `--fill`'s
    // `var(…, fallback)` that could never fire because the property was
    // registered, and a CSS counter reading a custom property, which the
    // shipping WebView rejected outright so every number on screen printed 0.
    // Both times the element painted NOTHING rather than something plainer,
    // and a meter that is not there is indistinguishable from a meter at zero.
    //
    // color-mix() is Chrome 111 / Safari 16.2 — most devices, not all — so a
    // gradient that names it needs a flat declaration ahead of it. Enforced
    // rather than remembered, because the rule is invisible in the one place
    // it matters: on a device that supports color-mix, a missing fallback
    // looks exactly like a present one.
    for (const rule of RULES) {
      const backgrounds = rule.body.match(/background(?:-color)?:[^;]*/g) ?? [];
      const mixedAt = backgrounds.findIndex((declaration) => declaration.includes('color-mix'));
      if (mixedAt < 0) continue;
      const plain = backgrounds
        .slice(0, mixedAt)
        .some((declaration) => !declaration.includes('color-mix'));
      expect(
        plain,
        `${rule.selector} paints with color-mix and has nothing to fall back to: ` +
          backgrounds[mixedAt]!.trim()
      ).toBe(true);
    }
  });

  it('never tints a panel with a semantic colour', () => {
    // COLOUR IS INK ON PAPER: it appears as the edge rule, the numeral, or the
    // meter fill, and nowhere else. `.hud-btn--primary` used to fill itself
    // with 26% of the accent and `.hud-row[data-selected]` with 10% of it, both
    // of which lower the panel contrast `palette.test.ts` measures in order to
    // say something a 3 px rule says louder.
    //
    // A WHITELIST, NOT A BLACKLIST, and the difference is the whole assertion.
    // Both bugs this guard was written from happened to be `color-mix` washes,
    // and the regex that replaced them encoded the SHAPE rather than the rule —
    // so the two most obvious ways to reintroduce a tinted panel walked
    // straight through it. Mutation-tested against this suite:
    // `.hud-btn--primary{background:var(--hud-accent)}` MISSED, and
    // `.hud-row{background:rgba(255,210,48,.12)}` MISSED. Nothing else in the
    // repo would have caught either: `palette.test.ts` measures PALETTES, not
    // the sheet, and a tint is precisely what lowers the panel contrast it
    // measures.
    //
    // The rule, enforced directly: a background may name only NEUTRAL tokens
    // and near-achromatic literals. That fails `var(--hud-accent)` on the token
    // check and `rgba(255,210,48,.12)` on the chroma check without enumerating
    // a single semantic name, so a sixth semantic token added to `tokens.ts`
    // tomorrow is covered on the day it lands.
    /** Structural paper. Everything else is ink. */
    const NEUTRAL_TOKENS = [
      '--hud-panel',
      '--hud-surface',
      '--hud-track',
      '--hud-halftone',
      '--hud-line',
    ];
    /**
     * Words a background may contain that are not colours.
     *
     * Deliberately small: an identifier that is not here fails, so a colour
     * KEYWORD — `red`, `gold`, `dodgerblue` — is caught by the same check that
     * catches a function nobody vetted.
     */
    const GRAMMAR = new Set([
      'none',
      'transparent',
      'linear-gradient',
      'radial-gradient',
      'repeating-linear-gradient',
      'color-mix',
      'in',
      'srgb',
      'var',
      'rgb',
      'rgba',
      'circle',
      'ellipse',
      'at',
      'to',
      'top',
      'bottom',
      'left',
      'right',
      'center',
      'no-repeat',
      'repeat',
      'deg',
      'px',
    ]);
    /** How far from grey a literal may sit, out of 255. */
    const MAX_CHROMA = 20;

    function chroma(channels: readonly number[]): number {
      return Math.max(...channels) - Math.min(...channels);
    }

    for (const rule of RULES) {
      // A METER FILL is the one place a background may be semantic — it is the
      // third of the three permitted uses, alongside the edge rule and the
      // numeral. A fill identifies itself by being a fill.
      if (FILL_DECLARATION.test(rule.body)) continue;
      // Two legitimate semantic backgrounds, each exempted with its reason.
      // `.hud-alert::after` is the speed-line hatch — a one-shot stamp sweep in
      // the bulletin's own colour, painted UNDER the type at z-index -1, which
      // is a motion cue rather than a fill. `.hud-swatch` is the palette
      // preview chip on the settings screen: its entire content is the colour
      // it is previewing.
      if (rule.selector === '.hud-alert::after' || rule.selector === '.hud-swatch') continue;

      for (const declaration of rule.body.match(/background(?:-color)?:[^;]*/g) ?? []) {
        const value = declaration.replace(/^background(?:-color)?:/, '');

        for (const [, token] of value.matchAll(/var\((--[a-z-]+)/g)) {
          expect(
            NEUTRAL_TOKENS,
            `${rule.selector} paints its panel with ${token}: ${declaration.trim()}`
          ).toContain(token);
        }

        for (const [, channels] of value.matchAll(/rgba?\(([^)]*)\)/g)) {
          const parts = channels!.split(',').slice(0, 3).map(Number);
          expect(
            chroma(parts),
            `${rule.selector} paints its panel with a colour: ${declaration.trim()}`
          ).toBeLessThanOrEqual(MAX_CHROMA);
        }

        for (const [hex] of value.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
          const full =
            hex.length === 4
              ? hex
                  .slice(1)
                  .split('')
                  .map((digit) => digit + digit)
                  .join('')
              : hex.slice(1);
          const parts = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
          expect(
            chroma(parts),
            `${rule.selector} paints its panel with a colour: ${declaration.trim()}`
          ).toBeLessThanOrEqual(MAX_CHROMA);
        }

        // Whatever is left over after the colours and the custom-property names
        // have been accounted for has to be grammar.
        const words = value
          .replace(/var\(--[a-z-]+/g, '')
          .replace(/#[0-9a-f]{3,6}\b/gi, '')
          .match(/[a-zA-Z][a-zA-Z-]*/g);
        for (const word of words ?? []) {
          expect(
            GRAMMAR.has(word),
            `${rule.selector} background names "${word}", which this guard has never vetted: ` +
              declaration.trim()
          ).toBe(true);
        }
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

describe('one text edge', () => {
  it('gives a stacked list a fixed stamp column', () => {
    // `.hud-alert__chip` was given this for a bulletin STACK that shows one
    // bulletin, and the two screens that stack six and seven of these rows did
    // not get it: measured in the quest log the card titles started at 143.89 /
    // 156.45 / 143.89 / 138.11 / 152.67 / 147.67, an 18.34 px rag down a list
    // whose left edge the eye is tracking, and the rank ladder had the same bug
    // at 5.78 px.
    for (const selector of ['.hud-alert__chip', '.hud-row .hud-chip']) {
      const body = ruleBody(selector);
      expect(body, selector).toMatch(/min-width:calc\([^;]*var\(--hud-scale\)/);
      expect(body, selector).toContain('text-align:center');
    }
    // And the objective marker inside a card, which is the same failure one
    // level deeper: a count 7 px wide for a bullet and 29 px for "0/40" put the
    // sentences of ONE quest card on three different x, a 22 px step in the
    // middle of a four-line card.
    const count = ruleBody('.hud-tracker__count');
    expect(count).toMatch(/min-width:calc\([^;]*var\(--hud-scale\)/);
    expect(count).toContain('text-align:right');
  });

  it('gives a tracked run its trailing letter-space back when it is right-aligned', () => {
    // CSS adds letter-spacing after the FINAL glyph too, so a right-aligned
    // tracked run stops one tracking unit short of the edge everything else is
    // aligned to. `.hud-boredom__mult` carried the compensation and its comment
    // claimed to be "the last right-aligned tracked run in the HUD"; it was
    // not, and a claim like that is what stops the next person looking.
    // The structural half: anything that declares both in one rule.
    for (const rule of RULES) {
      if (!/text-align:\s*right/.test(rule.body)) continue;
      if (!/letter-spacing:\.\d+em/.test(rule.body)) continue;
      expect(
        /margin-right:\s*-/.test(rule.body),
        `${rule.selector} is right-aligned and tracked but keeps its trailing space`
      ).toBe(true);
    }
    // The named half, for the runs whose alignment comes from the box around
    // them and which the structural half therefore cannot see.
    for (const selector of ['.hud-boredom__mult', '.hud-row__value', '.hud-invoice__val']) {
      expect(ruleBody(selector), selector).toMatch(/margin-right:-\.\d+em/);
    }
  });

  it('never declares an ellipsis on something that wraps', () => {
    // `text-overflow` only fires on content that overflows its line box in the
    // INLINE direction; content that wraps does not. Two rules declared it
    // against `white-space:normal` — `.hud-alert__title` and `.hud-row__title`,
    // plus `.hud-alert__body` — so the declaration did nothing at all except
    // tell the reader those strings were single-line and clipped when they are
    // multi-line and complete. Either it is one line and clipped, or it wraps
    // and says so.
    for (const rule of RULES) {
      if (!rule.body.includes('text-overflow:ellipsis')) continue;
      expect(
        /white-space:\s*nowrap/.test(rule.body) || rule.body.includes('-webkit-line-clamp'),
        `${rule.selector} ellipsises content that wraps, which never fires`
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

  it('never sizes a control below MIN_TAP_PX, in every media query', () => {
    // `tokens.ts` calls anything smaller "a bug, not a style" — and the pause
    // affordance (40 px) and every settings option (38 px) were smaller.
    //
    // EVERY rule, not the first one. This used to read `ruleBody(selector)`,
    // i.e. the top-level declaration only, while the HUD-scale guard sixty
    // lines below iterates `ruleBodies` precisely because "the shipping
    // landscape and portrait media queries re-declare several of these
    // selectors". Re-declaring a control's size in a media query is a live
    // pattern in this very sheet — `@media (max-height:520px){.hud-setting{
    // min-height:44px}}` — so an override that shrank `.hud-btn` or
    // `.hud-seg__opt` below the floor on the ONE profile that ships would have
    // passed this guard silently, which is the single failure mode it exists
    // to prevent.
    //
    // EVERY RULE WHOSE SELECTOR MENTIONS A CONTROL, not every rule whose
    // selector IS one, and that is the second half of the same hole. The loop
    // read `ruleBodies(selector)`, which matches on string EQUALITY, so the
    // guard saw `.hud-btn{…}` and nothing else — while the two most natural
    // ways to write the override it was written to catch both slipped past.
    // Mutation-tested against this suite: `@media (max-height:520px){
    // .hud-sheet__foot .hud-btn{min-height:30px}}` MISSED, and
    // `.hud-btn[data-compact]{min-height:28px}` MISSED, while the same
    // shrinkage written on the control's own selector was CAUGHT. The
    // completeness half below cannot cover it either — a descendant rule has no
    // reason to re-declare `pointer-events:auto`, so it never enters `found`.
    // A containment scan is the only shape that sees a control being resized by
    // a selector that is not its own name.
    const sized = RULES.filter((rule) =>
      CONTROLS.some((control) => rule.selector.includes(control))
    );
    expect(sized.length, 'the containment scan found no control rules at all').toBeGreaterThan(
      CONTROLS.length
    );
    for (const rule of sized) {
      // Rebuilt per body rather than shared: a /g regex carries `lastIndex`,
      // and the day this switches from `matchAll` to `exec` a shared literal
      // starts skipping every other rule.
      const sizes = /(?:^|[;\s])(min-width|min-height|width|height):(\d+(?:\.\d+)?)px/g;
      for (const [, property, value] of rule.body.matchAll(sizes)) {
        expect(Number(value), `${rule.selector} ${property}`).toBeGreaterThanOrEqual(MIN_TAP_PX);
      }
    }
    // And every control still has to EXIST, which the containment scan alone
    // would not notice: a selector deleted outright matches nothing and passes
    // a filter vacuously.
    for (const selector of CONTROLS) ruleBodies(selector);
  });

  it('lists every rule that takes a touch, so a new control cannot skip it', () => {
    // The completeness half, and the reason it matters is not tap size: a rule
    // that quietly claims `pointer-events:auto` in the wrong rectangle steals a
    // touch from the movement stick, which is invisible in every screenshot.
    // Anything added here has to be looked at.
    const found = RULES.filter((rule) => TOUCH_DECLARATION.test(rule.body)).map(
      (rule) => rule.selector
    );
    expect(found.length).toBeGreaterThan(0);
    for (const selector of found) {
      expect([...CONTROLS, ...LAYERS], `${selector} takes a touch`).toContain(selector);
    }
  });

  it('cuts the pause button and its reserve out of one token, and scales it', () => {
    // THE TOKEN USED TO BE A BARE `${MIN_TAP_PX}px` and this assertion used to
    // check for exactly that string, which encoded the bug rather than the
    // rule. `--hud-band-row` beside it is affine, so the pause chip was the one
    // control in the game that did not grow when a player raised HUD scale —
    // the only escape hatch there is, frozen at the setting a low-vision player
    // picks, next to a LOG button that grew with the type.
    // What has to hold is invariant 5, stated as two things: the token is never
    // below the floor, and it drives BOTH the button and the reserve.
    // EVERY declaration of it, not the first: `.hud-root` is declared several
    // times over — once by `safe-area.ts`, once here, and once per breakpoint —
    // so a guard that reads only the first would pass an override that reset
    // the token to a bare literal in the one media query that ships.
    const tokens = [...allDeclarations('.hud-root').matchAll(/--hud-pause-size:([^;]*)/g)].map(
      (match) => match[1]!
    );
    expect(tokens.length, 'nothing declares --hud-pause-size').toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token, 'the pause size must scale with the type').toContain('var(--hud-scale)');
      // AND IT NEEDS A CLAMPING FUNCTION, because --hud-scale goes DOWN as well
      // as up: the settings screen offers 85 %, and `calc(44px * .85)` is
      // 37.4 px. `max(44px, …)` is the floor invariant 5 asks for, stated in
      // the declaration rather than trusted to the range of a setting.
      expect(token, `--hud-pause-size:${token}`).toMatch(/max\(|clamp\(/);
      const literals = [...token.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
      expect(literals.length, `--hud-pause-size:${token}`).toBeGreaterThan(0);
      for (const value of literals) {
        expect(value, `--hud-pause-size:${token}`).toBeGreaterThanOrEqual(MIN_TAP_PX);
      }
    }

    expect(ruleBody('.hud-pausebtn')).toContain('width:var(--hud-pause-size)');
    // The right column keeps that much clear so the ledger cannot slide under
    // the button; the two numbers were separate literals and could drift.
    expect(ruleBody('.hud-top__right')).toContain('padding-right:calc(var(--hud-pause-size)');
    // And the LOG button under it is the SAME square, from the same token, so
    // the band's only control column cannot become a square over a rectangle —
    // which is what `align-items:stretch` made of it in portrait, 44x44 above
    // 44x65.19.
    expect(ruleBody('.hud-tracker__open')).toContain('width:var(--hud-pause-size)');
    expect(ruleBody('.hud-tracker__open')).toContain('height:var(--hud-pause-size)');
  });

  it('gives the only escape hatch in the game a plate to sit on', () => {
    // It used to inherit `.hud-btn--ghost{background:none}`, which left the
    // pause button as a 1 px hairline and an unshadowed glyph — about 1.2:1
    // over a lit building facade — and it is the only way out of a fight.
    expect(ruleBody('.hud-pausebtn')).not.toContain('background:none');
    // The backing still composes from the palette's own panel, and now declares
    // the surface under it as well. The plate was invisible on a SHEET —
    // `--hud-panel` is the surface laid down three times, so over a `.hud-sheet`
    // (whose fill IS that surface) it composited to the sheet's own colour and
    // measured 1.00:1. Every button on every modal was a hairline and a clipped
    // tick. The lift that fixes it is layered ABOVE `var(--hud-surface)`, which
    // is invariant 4: five palettes fill that slot and a flat fill would make
    // four of them dead data.
    const backing = ruleBody('.hud-btn::before');
    expect(backing).toContain('var(--hud-panel)');
    expect(backing).toContain('background-color:var(--hud-surface)');
    // A NEUTRAL lift, not a tint — the whitelist above enforces that for every
    // background in the sheet; this names the one that had to change.
    expect(backing).toMatch(/background:linear-gradient\(rgba\(255,255,255,/);
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
      const declarations = ruleBodies(selector).flatMap((body) => [
        ...body.matchAll(/(?:^|[;\s])(?:max-)?width:([^;]*)/g),
      ]);
      expect(declarations.length, selector).toBeGreaterThan(0);
      for (const [, value] of declarations) {
        // An INTRINSIC width states "I have no size of my own, ask the box
        // around me" and carries nothing that could go stale at 130 %. Anything
        // that does name a size has to name --hud-scale with it.
        if (/^(?:100%|auto|max-content|min-content|fit-content)$/.test(value!.trim())) continue;
        expect(value, selector).toContain('var(--hud-scale)');
      }
    }
  });

  it('keeps the band budget affine AND readable by the gate that enforces it', () => {
    // TWO HALVES OF ONE BUG, and the second half is the reason this is a test
    // rather than a comment.
    //
    // AFFINE. `--hud-band-row` is row one's declared height and `.hud-top`
    // makes it row one's MINIMUM height, so a flat value is a floor that binds
    // at the HUD scales where it happens to exceed the content and is inert
    // above them. It was flat, and row one's combat content runs 56.00 px at
    // 100 % and 66.50 at 130 %, so the duty strip and its 44 px LOG button
    // dropped exactly 3 px the moment a fight put a ledger in the row — at
    // 115 % and 130 % only. `harness/hud.verify.ts` measures CLS inside a
    // single scene and cannot see a jog between two.
    const root = allDeclarations('.hud-root');
    expect(root).toMatch(/--hud-band-row:calc\([^;]*var\(--hud-scale\)/);

    // READABLE. The harness reads this token back off the root with
    // `parseFloat`. An UNREGISTERED custom property computes to its token
    // stream — var() substituted, calc() NOT evaluated — so the day the budget
    // became affine, `parseFloat("calc(29px + 35px * 1)")` would have returned
    // NaN and the harness would have printed `[skip] … declares no
    // --hud-band-row` while still reporting every check passed. Registering it
    // as `<length>` is what makes the computed value a resolved px length.
    // A budget assertion that silently turns itself off is worse than none.
    expect(CSS).toMatch(/@property --hud-band-row\{syntax:'<length>';inherits:true;/);
  });

  it('never lets an alarm animate a readout to where it cannot be read', () => {
    // `hud-pulse` spends 39 % of every second at opacity .35, and
    // `questUrgency` holds `critical` for the last 45 seconds of a quest — so
    // on the clock itself that was up to forty-five continuous seconds of the
    // most time-critical number on the HUD reading 1.65:1 two frames in five.
    // The alarm belongs on something whose disappearance costs nothing: the
    // TIME caption flashes, the digits do not.
    const clock = ruleBody(`.hud-tracker[data-urgency='critical'] .hud-tracker__clock`);
    expect(clock).toContain('color:var(--hud-lost)');
    expect(clock, 'the readout itself must not blink').not.toContain('animation:');
    expect(
      ruleBody(`.hud-tracker[data-urgency='critical'] .hud-tracker__clock .hud-label`)
    ).toContain('animation:hud-pulse');
  });

  it('gives the world markers a plate, because a shadow is not contrast', () => {
    // The pins are the only "where do I go" element in the game and the only
    // type in this HUD painted straight onto the world. Their whole protection
    // was `text-shadow`, and a shadow cannot buy contrast when the background
    // is BRIGHTER than the ink: measured against the game's own daytime sky
    // fallback the distance run computes to 1.06:1. `harness/hud.html` renders
    // a dusk street, so no committed shot has ever shown this.
    for (const selector of ['.hud-marker__label', '.hud-marker__dist']) {
      const body = ruleBody(selector);
      expect(body, selector).toContain('background:var(--hud-panel)');
      // Composed from the palette's own surface, so all five stay live.
      expect(body, selector).toContain('background-color:var(--hud-surface)');
    }
  });

  it('gives the bulletin stack one text edge', () => {
    // A content-width stamp in a baseline row makes the headline's x origin a
    // function of how many letters the tier word has, and an untiered bulletin
    // used to carry no stamp and no gap at all — so a stack of three printed
    // three headlines on three measures, up to ~60 px apart at 130 %.
    const chip = ruleBody('.hud-alert__chip');
    expect(chip).toMatch(/min-width:calc\([^;]*var\(--hud-scale\)/);
    expect(chip).toContain('text-align:center');
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
