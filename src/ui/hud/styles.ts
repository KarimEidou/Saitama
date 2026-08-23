/**
 * THE HUD STYLESHEET
 *
 * One string, injected once. Every layout decision and every animation lives
 * here, so the TypeScript builds a tree and then only ever writes custom
 * properties into it.
 *
 * ── THE PANEL LANGUAGE: A HERO ASSOCIATION FILE ────────────────────────────
 * Every panel used to get the identical treatment — 10 px radius, a 1 px
 * hairline all round, a whisper of gradient, a 20 px drop shadow — so the rank
 * chip, the boredom meter, the threat banner and the property-damage invoice
 * were visually interchangeable. A Tiger-level threat was drawn with exactly
 * the same weight as the hero name that never changes. That is a weather
 * widget. Nothing in it was from the Association.
 *
 * The source material has a very specific look, and the game already has the
 * IDEAS: a tier system, a seat number, a civilian ledger, a damage invoice.
 * They were rendered as generic chrome. So:
 *
 *   THE PLATE      A chamfered rectangle — square at the top-left where the ink
 *                  rule starts, cut across the top-right and bottom-left. Not a
 *                  border-radius: `--hud-radius` is 0 and every corner in the
 *                  HUD is either square or cut. `clip-path` is composited and
 *                  static, so the shape costs a single paint-time mask.
 *
 *   ONE INK RULE   One 3 px rule down the leading edge, and NO hairline round
 *                  the rest. The rule carries the meaning — class colour on the
 *                  hero file, tier colour on the incident, urgency on the duty
 *                  strip, alert colour on a bulletin — so the panel's identity
 *                  is legible before a single word is read. `.hud-tracker` was
 *                  already doing exactly this with `border-left`; it is now the
 *                  system rather than one panel's exception.
 *
 *   THE LEAN       `skewX(-3deg)`, on the BACKING LAYER only. A 3° lean is the
 *                  single strongest "this is not a generic card" signal
 *                  available for one declaration, and putting it on a
 *                  `::before` instead of the panel box keeps the type upright
 *                  on the pixel grid and — the reason it is not on the box —
 *                  keeps `getBoundingClientRect()` reporting the LAYOUT
 *                  rectangle. Every geometry assertion in `harness/hud.verify`
 *                  measures those rects; a skewed box reports a bounding box
 *                  ~1.6 px wider on each side than anything the layout knows
 *                  about, which would spend the safe-area and overlap budgets
 *                  on a decoration.
 *
 *   HALFTONE       A 3 px dot screen at 5.5 % alpha, composed INTO
 *                  `--hud-panel` above `var(--hud-surface)`. One extra paint
 *                  layer, no image, no request. It is what stops a flat fill
 *                  reading as a flat fill.
 *
 *   INK ON PAPER   Semantic colour appears in exactly three places: the edge
 *                  rule, the numeral glyph, and the meter fill. No panel is
 *                  ever TINTED — the primary button's `color-mix` background
 *                  and the selected row's wash are both edge-and-ink now. That
 *                  raises the panel contrast `__tests__/palette.test.ts`
 *                  measures, and it makes High contrast the palette the design
 *                  was drawn for rather than a degradation of it.
 *
 * ── FIVE TYPE SIZES, NOT SEVENTEEN ─────────────────────────────────────────
 * The sheet used to contain 10, 11, 11.5, 12, 13, 14, 15, 16, 17, 18, 19, 20,
 * 21, 22, 23, 26 and 52 px. There was no system, which is precisely why nothing
 * lined up — the loading row's baseline mismatch was two of those steps meeting.
 * Everything is now one of five, anchored at 13 px on a ~1.35 ratio:
 *
 *   --t-micro   10   labels, tabular meta, chips        tracking .14em
 *   --t-body    13   prose, hints, blurbs               tracking .01em
 *   --t-title   18   panel titles, row titles, names    tracking .06em
 *   --t-readout 24   every live number on the HUD       tracking .01em
 *   --t-hero    44   the rank-board standing, the boot  tracking .06em
 *
 * TRACKING IS A FUNCTION OF SIZE. Uniform heavy tracking (.14em labels, .12em
 * buttons, .16em tier words) at every size flattens the hierarchy the sizes are
 * trying to establish: it makes 10 px look like 18 px look like 24 px. Heavy
 * tracking survives only where it earns its keep — 10 px uppercase, where the
 * letterforms need the air. `__tests__/styles.test.ts` fails the build if a
 * sixth size appears.
 *
 * ── THE LAYOUT CONSTRAINT NOBODY WRITES DOWN ───────────────────────────────
 * On a phone held in landscape — which is how this game is played — the bottom
 * of BOTH lower corners is under a hand. `src/ui/input` anchors the stick 96 px
 * inside the bottom-left safe corner and strikes its button arc out to ~222 px
 * from the bottom-right one. `THUMB_RESERVE_PX` and `STICK_RESERVE_PX` are the
 * quarter-discs that leaves.
 *
 * On the 844x390 profile that ships, the arithmetic is brutal and worth writing
 * down: 390 − 21 (home indicator) − 240 (the deeper reserve) = 129. The combat
 * HUD gets y ∈ [8, 129]. ONE HUNDRED AND TWENTY-ONE PIXELS, at 130 % HUD scale
 * as well as at 100 %. That is the whole budget, and it is why:
 *
 *   · the rank chip and the boredom meter are ONE plate (the hero file),
 *   · the ledger and the collateral ticker are ONE plate (the incident cost),
 *   · the encounter card and the boss bar are ONE plate (the incident),
 *   · the quest tracker is a single-line DUTY STRIP, not a card.
 *
 * Four panels became three plates and a strip, and the band went from
 * overflowing at 100 % to fitting at 130 %.
 *
 * ── WHERE THE ALERTS WENT, AND WHY ─────────────────────────────────────────
 * The threat banner used to be `left:50%` in the z-index 4 layer while the
 * encounter card was grid-area 1/2 in the z-index 2 layer: two layout systems
 * claiming one rectangle. Measured on a real device it covered 85.2 % of the
 * card — 100 % of its width, 46 of its 54 px — and its own 3-cycle throb
 * animated the buried card back into view three times. Two elements, one
 * rectangle, saying nearly the same thing.
 *
 * There is no free rectangle left in the landscape band, so the bulletin goes
 * where the free rectangle actually is: the CORRIDOR between the two hands,
 * above the charge arc. In portrait and on a tablet there is no corridor and
 * there is height to spare, so it sits under the band instead. Two placements,
 * each derived from which free space that shape of screen has.
 *
 * ── WHY THERE IS NO `backdrop-filter` ──────────────────────────────────────
 * A blurred HUD panel looks expensive because it is: `backdrop-filter` forces
 * the compositor to read back and blur the frame behind every panel, every
 * frame, on a tile-based mobile GPU that would much rather not.
 *
 * ── AND WHY THERE ARE NO DROP SHADOWS EITHER ───────────────────────────────
 * `clip-path` clips an outer `box-shadow` away with everything else the element
 * paints, so a chamfered plate cannot have one; the alternative,
 * `filter:drop-shadow`, is a per-element filter pass — the same trade this file
 * already refuses above. The separation comes from OPACITY instead, which the
 * panels needed anyway: `--hud-surface` is 82 % opaque, tuned against the dusk
 * sky in the committed reference shots, and the shipping game is DAYTIME. The
 * rank chip's fill measurably swung rgb(30,32,37)→(39,44,52) with the windows
 * behind it. `--hud-panel` now lays the palette's own surface down TWICE, so
 * every palette composes to ~97 % by its own colour rather than by a literal,
 * and the city bleed drops from ~18 % to ~3 %.
 *
 * ── EVERY ANIMATED PROPERTY IS COMPOSITED ──────────────────────────────────
 * `transform` and `opacity` only, and only three motions exist:
 *
 *   STAMP    entry. scale(1.06)→1 with opacity, 120 ms, plus a one-shot
 *            speed-line sweep that wipes across and fades. It is a rubber stamp
 *            hitting paper, not a card sliding in.
 *   BREATHE  idle. The boredom meter's slow sweep, scoped to the FILL — over
 *            the empty TRACK it was an indeterminate spinner shimmering on a
 *            bar that said zero.
 *   PULSE    urgent. A hard `steps(1,end)` flash. Never a fade: a fade reads as
 *            a rendering artefact, a flash reads as an alarm.
 *
 * All three are killed outright by `[data-reduced-motion='true']` at the bottom
 * of this file.
 *
 * ── HOW THIS FILE IS PARSED, AND WHAT THAT FORBIDS ─────────────────────────
 * `__tests__/styles.test.ts` reads this stylesheet with a REGULAR EXPRESSION,
 * not a CSS parser:
 *
 *     (?:^|[\n},])\s*ESCAPED_SELECTOR\s*\{([^{}]*)\}
 *
 * Two rules follow from that, and breaking either fails the build with a
 * confusing message rather than a useful one:
 *
 *   EVERY INSPECTED RULE STANDS ALONE. `.hud-boredom,.hud-tracker{…}` matches
 *   nothing, and the failure reads "no rule for .hud-boredom". Since the guards
 *   are now COMPLETENESS guards — every rule that paints a fill must be listed,
 *   every rule that takes a touch must be listed — that applies to any rule
 *   carrying `transform:scaleX(var(--` or `pointer-events:auto`.
 *
 *   NO NESTED BRACES INSIDE A RULE BODY. No CSS nesting, no `&`, no `@supports`
 *   inside a rule. Media queries are fine: the regex anchors on a newline, so
 *   rules inside one are found normally.
 *
 * Upgrading that regex to a real parser is a reasonable change. It is not one
 * that rides along with a redesign, because a parser that quietly accepts what
 * the regex rejects removes the guard on the day it is most likely to matter.
 */

import { CSS_NUMBER_STYLES } from './css-number';
import { SAFE_AREA_STYLES } from './safe-area';
import {
  MIN_TAP_PX,
  PALETTES,
  STICK_RESERVE_PX,
  THUMB_RESERVE_PX,
  type PaletteName,
} from './tokens';

export const HUD_STYLE_ID = 'opm-hud-styles';

/**
 * Font stack.
 *
 * Bebas Neue is a condensed display face and the reason the HUD can put
 * "NOTHING FEELS LIKE ANYTHING" on one line at 390 px. It is loaded by
 * `fonts.ts`, which the app bootstrap and the harness import; if it is absent
 * the stack degrades to Inter and then to the system UI face, and the layout
 * still holds because every label box is sized in `ch`-free absolute terms.
 */
const DISPLAY_FONT = `'Bebas Neue','Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`;
const TEXT_FONT = `'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`;

/** Palette custom properties for one palette. */
function paletteVars(name: PaletteName): string {
  const p = PALETTES[name];
  return [
    `--hud-accent:${p.accent}`,
    `--hud-saved:${p.saved}`,
    `--hud-lost:${p.lost}`,
    `--hud-collateral:${p.collateral}`,
    `--hud-commit:${p.commit}`,
    `--hud-rival:${p.rival}`,
    `--hud-ink:${p.ink}`,
    `--hud-ink-muted:${p.inkMuted}`,
    `--hud-surface:${p.surface}`,
    `--hud-line:${p.line}`,
  ].join(';');
}

function allPalettes(): string {
  return (Object.keys(PALETTES) as PaletteName[])
    .map((name) => `.hud-root[data-palette='${name}']{${paletteVars(name)}}`)
    .join('\n');
}

export function hudStyles(): string {
  return `
/* ========================================================================== */
/* Registered properties                                                      */
/* Registering a custom property as <number> gives it a TYPE, which is what   */
/* lets it be transitioned and interpolated. Without this, --boredom is a     */
/* token string and transition: --boredom does nothing at all.              */
/* ========================================================================== */
/* --fill INHERITS, and that is load-bearing rather than incidental: one of its  */
/* consumers is a ::after pseudo-element (.hud-standing__bar) and a writer can   */
/* only reach the ORIGINATING element. A pseudo inherits from its originator      */
/* exactly as a child does, so with inherits:false the registered initial-value  */
/* wins inside ::after and the rank board's progress sliver reads 0 forever.     */
@property --boredom{syntax:'<number>';inherits:true;initial-value:0}
@property --charge{syntax:'<number>';inherits:true;initial-value:0}
@property --fill{syntax:'<number>';inherits:true;initial-value:0}
@property --collateral{syntax:'<number>';inherits:false;initial-value:0}

${SAFE_AREA_STYLES}
${CSS_NUMBER_STYLES}

/* ========================================================================== */
/* Root                                                                       */
/* ========================================================================== */
.hud-root{
  position:fixed;inset:0;pointer-events:none;
  font-family:${TEXT_FONT};
  color:var(--hud-ink);
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
  --hud-scale:1;
  /* Zero, and it stays zero. Every corner in this HUD is square or chamfered;
     the token survives because the meter TRACKS read it, and a square-ended
     meter is the point rather than an oversight. */
  --hud-radius:0px;
  --hud-chamfer:9px;
  --hud-plate:polygon(0 0,calc(100% - var(--hud-chamfer)) 0,100% var(--hud-chamfer),100% 100%,var(--hud-chamfer) 100%,0 calc(100% - var(--hud-chamfer)));
  --hud-skew:-3deg;
  --hud-rule:3px;
  --hud-edge:var(--hud-line);
  --hud-gap:8px;
  /* The type scale. Five steps, 13 px anchor, ~1.35 ratio. See the header. */
  --t-micro:calc(10px * var(--hud-scale));
  --t-body:calc(13px * var(--hud-scale));
  --t-title:calc(18px * var(--hud-scale));
  --t-readout:calc(24px * var(--hud-scale));
  --t-hero:calc(44px * var(--hud-scale));
  /* The two hands, as the rectangles they actually occupy. Mirrored from
     tokens.ts, which mirrors src/ui/input; the harness asserts both against the
     input layer's OWN exported arc geometry, so a retune fails loudly. */
  --hud-thumb-reserve:${THUMB_RESERVE_PX}px;
  --hud-stick-reserve:${STICK_RESERVE_PX}px;
  --hud-reserve-l:var(--hud-stick-reserve);
  --hud-reserve-r:var(--hud-thumb-reserve);
  --hud-pause-size:${MIN_TAP_PX}px;
  /* What one row of the combat band is allowed to cost, measured from the top
     inset. The tallest plate is the hero file — micro overline, 24 px readout,
     a meter rule and its padding — and this is that, rounded up to the next
     even number. harness/hud.verify.ts reads it off the root and fails if
     row one outgrows it, so the number is a promise rather than a comment. */
  --hud-band-row:64px;
  /* And what the whole band costs: both rows plus the gap between them. The
     alert stack hangs off the bottom of this, so the bulletin cannot drift into
     the band by growing a row taller. */
  --hud-band-h:124px;
  /* The charge arc's box, so the alert stack can sit on top of it without
     either one knowing the other's markup. */
  --hud-arc-w:184px;
  --hud-arc-h:104px;
  --hud-arc-lift:10px;
  /* One reading measure for the boot card: bar, readout row and flavour line
     all share it, so the three cannot rag against each other. 420 px at 13 px
     is ~64 characters, inside the 45-75 a line wants. */
  --hud-measure:min(calc(420px * var(--hud-scale)),78vw);
  /* A meter track has to read as a CONTAINER or the fill inside it is not a
     proportion, it is a floating dash. WCAG 1.4.11 wants 3:1 for a component
     boundary and the old rgba(255,255,255,.10) measured 1.24:1 on the boot
     screen. .36 over the composed panel measures ~3.2:1. */
  --hud-track:rgba(255,255,255,.36);
  --hud-halftone:rgba(255,255,255,.055);
  /* THE PLATE FILL. Four layers, no colour: the halftone dot screen — one dot
     per 3 px cell — over the palette's own surface, laid down THREE TIMES.
     Alpha composes to 1-(1-a)^n, so the default 0.82 becomes 0.994 and High
     contrast's 0.92 becomes 0.9995: every palette gets denser BY ITS OWN COLOUR
     rather than by a literal, which is what keeps five surface values from
     becoming dead data again. Measured, that takes the daylight bleed through
     a panel from ~18 % to under 1 %, and the rank chip stops changing colour
     with the windows behind it.
     There is no vertical gradient on the plate. There used to be one and it was
     part of the problem — a barely-there wash is the house style of every card
     in every framework. What a stamped plate has instead is a LIT TOP EDGE, one
     hard pixel, declared with the edge rule on the backing layer below. */
  --hud-panel:
    radial-gradient(circle at 0 0,var(--hud-halftone) 0 0.8px,transparent 0.9px) 0 0/3px 3px,
    linear-gradient(var(--hud-surface),var(--hud-surface)),
    linear-gradient(var(--hud-surface),var(--hud-surface)),
    linear-gradient(var(--hud-surface),var(--hud-surface));
  ${paletteVars('default')};
}
${allPalettes()}
.hud-root *{box-sizing:border-box;margin:0}
.hud-root [hidden]{display:none !important}
/* Which bottom corner each hand claims. HudManager.applySettings publishes
   data-stick-hand; the reserves swap so the charge arc keeps clearing the
   STICK on whichever side it is, not just the side it defaulted to. */
.hud-root[data-stick-hand='right']{--hud-reserve-l:var(--hud-thumb-reserve);--hud-reserve-r:var(--hud-stick-reserve)}

.hud-layer{position:absolute;inset:0;pointer-events:none}
.hud-layer--world{z-index:0}
.hud-layer--hud{z-index:2}
.hud-layer--alerts{z-index:4}
.hud-layer--screen{z-index:6}

/* ========================================================================== */
/* The plate                                                                  */
/* ========================================================================== */
/* The panel itself holds NO paint. Everything visible is on the ::before, and
   that is the point: the backing layer carries the chamfer and the 3° lean,
   while the element keeps an upright, un-skewed layout box for
   getBoundingClientRect() and for the type inside it. contain:layout makes
   the panel a containing block AND a stacking context, which is what lets the
   backing sit at z-index -1 — behind the content, in front of nothing. */
/* 5/6 px of vertical padding rather than 6/7. Two pixels a plate does not sound
   like a decision until the band is 121 px tall at 130 % HUD scale, at which
   point it is most of the margin. */
.hud-panel{
  position:relative;
  padding:5px 11px 6px;
  contain:layout style;
}
.hud-panel::before{
  content:'';position:absolute;inset:0;z-index:-1;
  background:var(--hud-panel);
  box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-edge),inset 0 1px 0 0 var(--hud-line);
  clip-path:var(--hud-plate);
  transform:skewX(var(--hud-skew));
}
/* ---- type primitives --------------------------------------------------- */
.hud-label{
  font-family:${DISPLAY_FONT};
  font-size:var(--t-micro);
  letter-spacing:.14em;text-transform:uppercase;
  color:var(--hud-ink-muted);line-height:1.1;white-space:nowrap;
}
/* Every live number on the playing HUD, at one size. The rank, the fight
   clock, the ledger counts, the yen, the quest clock — they were 19, 21, 23,
   17 and 20 px, which is why no two of them ever sat on a shared baseline. */
.hud-readout{
  font-family:${DISPLAY_FONT};
  font-size:var(--t-readout);
  line-height:1;letter-spacing:.01em;
  font-variant-numeric:tabular-nums;
}
/* A classification stamp: the one place an all-round outline survives, because
   a stamp is exactly what it is. Never rendered without its word inside it. */
.hud-chip{
  font-family:${DISPLAY_FONT};font-size:var(--t-micro);letter-spacing:.14em;
  padding:2px 6px 1px;border:1px solid currentColor;
  color:var(--hud-chip-color,var(--hud-ink-muted));flex:0 0 auto;
  clip-path:var(--hud-plate);--hud-chamfer:4px;
}

/* ---- controls ---------------------------------------------------------- */
.hud-btn{
  pointer-events:auto;position:relative;
  min-height:${MIN_TAP_PX}px;min-width:${MIN_TAP_PX}px;
  font-family:${DISPLAY_FONT};
  font-size:var(--t-title);
  letter-spacing:.06em;text-transform:uppercase;
  color:var(--hud-ink);
  background:none;border:none;
  padding:9px 16px;cursor:pointer;
  transition:transform .08s ease-out,color .12s;
  touch-action:none;will-change:transform;contain:layout style;
}
.hud-btn::before{
  content:'';position:absolute;inset:0;z-index:-1;
  background:var(--hud-panel);
  box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-edge),inset 0 1px 0 0 var(--hud-line);
  clip-path:var(--hud-plate);
  transform:skewX(var(--hud-skew));
}
.hud-btn[data-pressed]{transform:scale(.95)}
/* Ink, not a wash. The old rule filled the button with 26 % of the accent,
   which is a TINTED PANEL — the one thing the language does not do — and it
   dropped the panel contrast the palette test measures. The edge rule and the
   glyph carry it instead, and High contrast gets louder rather than muddier. */
.hud-btn--primary{--hud-edge:var(--hud-accent);color:var(--hud-accent)}
.hud-btn--ghost{--hud-edge:transparent}

/* ========================================================================== */
/* Combat HUD — the top band                                                  */
/* ========================================================================== */
.hud-top{
  position:absolute;
  top:var(--hud-sa-t);left:var(--hud-sa-l);right:var(--hud-sa-r);
  display:grid;
  grid-template-columns:auto minmax(0,1fr) auto;
  grid-template-rows:auto auto;
  align-items:start;
  gap:var(--hud-gap);
  pointer-events:none;
}
/* The flanks size to their plates and the MIDDLE takes what is left, which is
   the opposite of the old 1fr / auto / 1fr. Two equal side columns look tidy in
   a diagram and are wrong here: the register on the right is the widest thing
   in the band and it was being handed the same width as the hero file, so it
   wrapped to two rows and drove row one from 57 px to 97 px. */
.hud-top__left{grid-area:1 / 1;display:flex;flex-direction:column;align-items:flex-start;min-width:0}
.hud-top__centre{grid-area:1 / 2;display:flex;flex-direction:column;align-items:stretch;min-width:0}
/* The reserve for the pause affordance, which is absolutely positioned in the
   same corner. Expressed in terms of --hud-pause-size so the button and the
   space kept clear for it cannot drift apart. */
.hud-top__right{
  grid-area:1 / 3;display:flex;flex-direction:column;
  align-items:stretch;min-width:0;
  padding-right:calc(var(--hud-pause-size) + 6px);
}

/* ---- the hero file ----------------------------------------------------- */
/* Rank chip and boredom meter, which were two panels saying two halves of one
   sentence: who the Association thinks you are, and how much you care about it.
   THREE ROWS, and every one of them had to be argued for against a 121 px band:
     1  the caption row — RANK, and the mood word that captions the meter,
     2  the seat row — the class stencil, the number, and the gain it is earning,
     3  the meter.
   Two things lost that argument and the report says what they cost. The
   SEAT-PROGRESS sliver: an unlabelled 2 px dash whose content is on the rank
   board in words. The HERO NAME: it never changes, it captions nothing, and at
   130 % HUD scale it was competing with the mood word for the same 160 px —
   "CAPED BALDY" is on the pause screen and the rank board, and C-388 is who the
   Association says he is, which is the joke.
   The rank is now the largest thing in the corner by 2.4x with RANK demoted to
   an overline, which is what turns a widget into a title card. */
.hud-rankchip{
  --hud-edge:var(--hud-class,var(--hud-accent));
  display:flex;align-items:center;gap:9px;
  width:min(calc(232px * var(--hud-scale)),44vw);
}
.hud-rankchip__class{
  flex:0 0 auto;
  font-family:${DISPLAY_FONT};font-size:var(--t-readout);line-height:1;
  color:var(--hud-class,var(--hud-accent));
  padding:3px 7px 1px;border:1px solid currentColor;
  clip-path:var(--hud-plate);--hud-chamfer:4px;
}
.hud-rankchip__file{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.hud-rankchip__head{display:flex;align-items:baseline;gap:8px;min-width:0}
/* The overline. 10 px, tracked, muted — the WORD is the caption and the number
   under it is the content, which is the exact inverse of how it read before. */
.hud-rankchip__overline{
  font-family:${DISPLAY_FONT};font-size:var(--t-micro);letter-spacing:.14em;
  color:var(--hud-ink-muted);line-height:1.1;flex:0 0 auto;
}
.hud-rankchip__seat{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0}
.hud-rankchip__rank{
  font-family:${DISPLAY_FONT};font-size:var(--t-readout);line-height:1;letter-spacing:.01em;
  font-variant-numeric:tabular-nums;color:var(--hud-class,var(--hud-accent));flex:0 0 auto;
}

/* ---- boredom, inside the hero file ------------------------------------- */
/* The game's real progress bar. Presented as a MOOD: a word, a slow breath,
   and a fill that drains of colour rather than filling up with it. The mood
   word and the gain share the seat row's baseline, so the meter costs the
   plate one 5 px rule rather than a row of its own. */
/* The mood word captions the meter from the row above it, right-aligned so the
   two captions bracket the plate. .06em rather than .14em because it is not a
   label — "NOTHING FEELS LIKE ANYTHING" is twenty-seven characters, and heavy
   tracking on twenty-seven characters costs 49 px that a 121 px band does not
   have to give it. */
.hud-boredom__mood{
  font-family:${DISPLAY_FONT};font-size:var(--t-micro);
  letter-spacing:.06em;text-transform:uppercase;
  color:var(--hud-mood,var(--hud-ink-muted));line-height:1.1;
  text-align:right;flex:1 1 auto;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;
}
/* GAIN, not RANK. The overline two lines above says "RANK" and means a ladder
   position; this said "RANK ×0.83" and meant a multiplier, so the eye parsed
   the second as "rank times zero". One word, two meanings, 20 px apart. It also
   carried a title tooltip, on a touch device, where no player will ever see
   it — the visible word now says what the tooltip said. */
.hud-boredom__mult{
  font-family:${DISPLAY_FONT};font-size:var(--t-micro);letter-spacing:.14em;
  color:var(--hud-ink-muted);white-space:nowrap;flex:0 0 auto;
}
.hud-boredom__mult[data-throttled='true']{color:var(--hud-lost)}
.hud-boredom__track{
  position:relative;height:5px;overflow:hidden;
  background:var(--hud-track);border-radius:var(--hud-radius);
}
.hud-boredom__fill{
  position:absolute;inset:0;transform-origin:0 50%;transform:scaleX(var(--boredom,0));
  background:linear-gradient(90deg,
    color-mix(in srgb,var(--hud-mood,#54e08a) 30%,transparent),
    var(--hud-mood,#54e08a));
  will-change:transform;
}
/* BREATHE. Slows as he stops caring — 2.4 s engaged, 12 s numb — which is the
   difference between a HUD element that is alive and one that has given up.
   It lives INSIDE the fill now. Over the track it played unconditionally, so at
   --boredom:0 the player watched a shimmer travel across an empty bar: the
   universal language for "indeterminate, still loading". It was animating the
   absence of the thing it was meant to be animating. */
.hud-boredom__breath{
  position:absolute;inset:0;opacity:.5;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.32),transparent);
  transform:translateX(-100%);
  animation:hud-breath var(--hud-breath,3s) ease-in-out infinite;
  will-change:transform;
}
@keyframes hud-breath{
  0%{transform:translateX(-100%)}
  60%,100%{transform:translateX(240%)}
}

/* ---- the incident ------------------------------------------------------ */
/* Encounter card and boss bar, one plate: the tier word, the name, the clock,
   and the health rule under all three. Two panels stacked in the centre column
   is two ink rules and two chamfers to say one thing. */
.hud-encounter{
  --hud-edge:var(--hud-tier,var(--hud-accent));
  display:grid;row-gap:4px;
  width:min(calc(560px * var(--hud-scale)),100%);
}
.hud-encounter__head{display:flex;align-items:baseline;gap:9px;min-width:0}
/* Colour is the accelerator; the word is the message. No five-hue ramp survives
   dichromacy alone, so the tier NEVER appears without its word — as a
   classification stamp, which is what the Association would actually print.
   The word "THREAT" that used to precede it is gone: this is the incident
   plate, and the alert banner that also said THREAT is no longer lying on top
   of it. */
.hud-encounter__tier{--hud-chip-color:var(--hud-tier,var(--hud-accent));align-self:center}
.hud-encounter__name{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;
  flex:1 1 auto;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.hud-encounter__clock{
  font-family:${DISPLAY_FONT};font-size:var(--t-readout);line-height:1;letter-spacing:.01em;
  font-variant-numeric:tabular-nums;color:var(--hud-ink);flex:0 0 auto;
}
.hud-encounter__clock .hud-num{font-size:inherit}
.hud-encounter__sep{opacity:.55}
/* Boss health: the plate's base rule, only the geometry the compositor can do */
.hud-boss{height:5px;overflow:hidden;background:var(--hud-track);border-radius:var(--hud-radius)}
/* display:block is not decoration. The fill is a <span>, and a non-replaced
   INLINE box is not a transformable element (CSS Transforms 1) and ignores
   height (CSS 2.1) — so without this the bar has no box, no transform, and
   paints nothing whatever --fill says. --fill:1 is the honest default the
   dead var(--fill,1) fallback could never supply: --fill is a REGISTERED
   property, so it is never guaranteed-invalid and the fallback never fires. */
.hud-boss__fill{
  --fill:1;
  display:block;height:100%;transform-origin:0 50%;transform:scaleX(var(--fill));
  background:linear-gradient(90deg,var(--hud-tier,#ff4d4d),color-mix(in srgb,var(--hud-tier,#ff4d4d) 40%,#fff));
  will-change:transform;
}

/* ---- the incident cost ------------------------------------------------- */
/* Civilian ledger and collateral ticker, one plate — because they are one
   document: what this fight has cost so far. Four cells reading left to right
   with the labels ON TOP, which is how a printed register reads and which also
   deletes a whole class of bug: right-aligning a TRACKED label puts the trailing
   letter-space inside the alignment, so every counter sat a letter and a half
   left of its own label and overhung it by ~1 px. Left-aligned columns cannot
   do that. */
.hud-ledger{
  --hud-edge:var(--hud-saved);
  display:flex;flex-wrap:wrap;align-items:flex-start;
  column-gap:12px;row-gap:3px;
}
.hud-ledger[data-lost='true']{--hud-edge:var(--hud-lost)}
.hud-ledger__cell{display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:0}
.hud-ledger__value{
  font-family:${DISPLAY_FONT};font-size:var(--t-readout);line-height:1;letter-spacing:.01em;
  font-variant-numeric:tabular-nums;
}
.hud-ledger__cell--saved .hud-ledger__value{color:var(--hud-saved)}
.hud-ledger__cell--lost .hud-ledger__value{color:var(--hud-lost)}
.hud-ledger__cell--cost .hud-ledger__value{color:var(--hud-collateral)}
/* A lost civilian is the only counter that gets to move: one STAMP, driven by
   re-adding the attribute, so it cannot be mistaken for decoration. */
.hud-ledger__cell--lost[data-bump='true'] .hud-ledger__value{animation:hud-stamp-mark .32s cubic-bezier(.2,.9,.3,1)}
.hud-ledger__witness{color:var(--hud-ink-muted)}
.hud-ledger__track{
  flex:1 0 100%;height:4px;margin-top:2px;overflow:hidden;
  background:var(--hud-track);border-radius:var(--hud-radius);
}
/* propertyDamageScore, NOT yen. Yen is unbounded and would peg this meter on
   the first serious punch of the game; the score is the compressed 0..1 field
   that exists precisely so a meter has something honest to read.
   display:block for the same reason as .hud-boss__fill — see there. */
.hud-ledger__fill{
  display:block;height:100%;transform-origin:0 50%;transform:scaleX(var(--collateral,0));
  background:linear-gradient(90deg,var(--hud-collateral),#ff4d4d);
  will-change:transform;
}

/* ---- the duty strip ---------------------------------------------------- */
/* The pinned quest, spanning the whole band as ROW TWO: what it is, what is
   left of it, and — loudly — the clock.
   It used to be a 200x112 card in the centre column, and the harness caught
   exactly what that cost: it hung 105 px into the hand reserve on the shipping
   profile and it won three hit-test probes off the movement stick. A strip that
   spans the band has the width to say the same thing on one line, and one line
   fits.
   The objective LIST and the conflict warning went with the card. Both are in
   the quest log, one tap away, with room to print them properly — and on a
   121 px band they were the two rows that pushed the strip into a hand.
   The edge rule carries urgency, which is what the old border-left did and
   what this whole language is generalised from. */
.hud-tracker{
  grid-area:2 / 1 / auto / -1;
  --hud-edge:var(--hud-accent);
  display:flex;align-items:stretch;justify-content:space-between;
  gap:6px;min-height:${MIN_TAP_PX}px;
  background:linear-gradient(var(--hud-line),var(--hud-line)) 0 50% / 100% 1px no-repeat;
}
/* The ROW spans the band so its button lands under the pause button on every
   profile; the PLATE inside it is sized to what it is SAYING, capped for
   reading. Two reasons, and the second is the one that matters: a duty line
   1008 px wide on a tablet is not a line, it is a horizon — and a full-width
   plate is the heaviest single object in a 121 px band, mostly to hold its own
   emptiness. Sized to content it reads as a strip torn off a longer document,
   with the city visible in the gap before the button. */
.hud-tracker__plate{
  flex:0 1 auto;min-width:0;display:flex;align-items:center;gap:12px;
  width:max-content;max-width:min(calc(760px * var(--hud-scale)),100%);
}
/* THE ONE WAY INTO THE QUEST LOG FROM A FIGHT, and it is a separate 44 px
   button rather than the strip itself for a reason the harness measures:
   src/ui/input treats the leading 45 % of the viewport as stick input AT EVERY
   HEIGHT, so a tappable strip spanning the band steals a movement touch — the
   hit-ownership grid caught the old centre-column card doing exactly that. The
   button sits at the TRAILING end of a strip that spans the whole band, which
   puts it in the trailing 55 % on every profile the harness drives. */
.hud-tracker__open{
  flex:0 0 auto;width:${MIN_TAP_PX}px;padding:0;
  display:grid;place-items:center;
  font-size:var(--t-body);letter-spacing:.06em;color:var(--hud-ink-muted);
}
.hud-tracker[data-urgency='soon']{--hud-edge:var(--hud-collateral)}
.hud-tracker[data-urgency='critical']{--hud-edge:var(--hud-lost)}
.hud-tracker[data-errand='true']{--hud-edge:var(--hud-commit)}
.hud-tracker__main{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}
.hud-tracker__title{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;line-height:1.15;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
/* An objective row, and it is the SAME row on two screens: objective-row.ts
   builds it for the quest log and the strip builds one of them for itself.
   Only the strip clips it to a line — the log has the width to wrap, and a
   truncated objective in a screen the player opened to read objectives would be
   the wrong half of the trade. */
.hud-tracker__obj{
  display:flex;gap:7px;align-items:baseline;min-width:0;
  font-size:var(--t-body);color:var(--hud-ink-muted);line-height:1.25;
}
.hud-tracker__obj[data-complete='true']{color:var(--hud-saved)}
.hud-tracker__count{font-variant-numeric:tabular-nums;color:var(--hud-ink);flex:0 0 auto}
.hud-tracker__plate .hud-tracker__obj{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hud-tracker__what{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.hud-tracker__clock{
  display:flex;align-items:baseline;gap:2px;flex:0 0 auto;
  font-family:${DISPLAY_FONT};font-size:var(--t-readout);line-height:1;letter-spacing:.01em;
  font-variant-numeric:tabular-nums;
}
/* PULSE. A hard flash, never a fade — a fade reads as a rendering artefact. */
.hud-tracker[data-urgency='critical'] .hud-tracker__clock{
  color:var(--hud-lost);
  animation:hud-pulse 1s steps(1,end) infinite;
}
@keyframes hud-pulse{0%,60%{opacity:1}61%,100%{opacity:.35}}

/* ---- charge arc -------------------------------------------------------- */
/* Sits centre-bottom, in the corridor BETWEEN the two thumbs, and appears
   only while charging. It is not a copy of the input layer's ring on the
   punch button: that ring answers "how long have I held this", and this arc
   answers "what am I about to do to the neighbourhood".
   Visibility is a NUMBER, not a class or an attribute: --hud-on is 0 or 1
   and CSS derives opacity and the entry transform from it, so appearing and
   disappearing stay inside the custom-property-only rule.
   CENTRED IN THE SAFE BOX, not at left:50%. Those are two different axes and
   they were 12.5 px apart on any single-notch device — invisible on the shots
   in docs/ only because iOS symmetrises landscape insets. left/right/auto
   margins centre in the box that actually exists, and need no translate.
   The width is the smaller of the type-scaled box and the CORRIDOR between the
   two hands, which is the one panel in this HUD that had no --hud-scale term at
   all and was 184 px wide in a gap measuring 286. */
.hud-charge{
  position:absolute;
  left:var(--hud-sa-l);right:var(--hud-sa-r);
  bottom:calc(var(--hud-sa-b) + var(--hud-arc-lift));
  width:min(calc(var(--hud-arc-w) * var(--hud-scale)),calc(100vw - var(--hud-sa-l) - var(--hud-sa-r) - var(--hud-reserve-l) - var(--hud-reserve-r)));
  height:var(--hud-arc-h);margin:0 auto;
  opacity:var(--hud-on,0);
  transform:translateY(calc((1 - var(--hud-on,0)) * 10px))
            scale(calc(.94 + .06 * var(--hud-on,0)));
  transition:opacity .12s ease-out,transform .12s ease-out;
  pointer-events:none;
}
.hud-charge svg{display:block;width:100%;height:100%;overflow:visible}
.hud-charge__track{fill:none;stroke:var(--hud-track);stroke-width:7;stroke-linecap:butt}
.hud-charge__fill{
  fill:none;stroke:var(--hud-intent,var(--hud-commit));stroke-width:7;stroke-linecap:butt;
  stroke-dasharray:var(--hud-arc-len,239);
  stroke-dashoffset:calc(var(--hud-arc-len,239) * (1 - var(--charge,0)));
}
.hud-charge__tick{stroke:rgba(255,255,255,.55);stroke-width:2}
/* The intent word is GENERATED CONTENT from a custom property, for the same
   reason the timer digits are: it changes while the player is holding the
   button, and a text-node swap is not allowed on that path. */
.hud-charge__label{
  position:absolute;left:0;right:0;bottom:15px;text-align:center;
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;
  color:var(--hud-intent,var(--hud-commit));
}
.hud-charge__label::after{content:var(--hud-intent-label,'NORMAL')}
.hud-charge__cost{
  position:absolute;left:0;right:0;bottom:0;text-align:center;
  font-size:var(--t-micro);letter-spacing:.14em;color:var(--hud-collateral);
  opacity:var(--hud-on,0);
}
.hud-charge__cost .hud-num{font-size:inherit}

/* ---- pause affordance -------------------------------------------------- */
/* Top-right of the safe area and nowhere near a thumb, because a pause button
   under a thumb is pressed by accident during every fight.
   MIN_TAP_PX, not a smaller circle that "looks tighter": this is the only
   in-game escape hatch, and tokens.ts calls anything under 44 px a bug rather
   than a style. .hud-top__right reserves --hud-pause-size for it.
   It used to inherit .hud-btn--ghost's background:none, which left the ONLY
   way out of the game as a 1 px hairline and an unshadowed white glyph — about
   1.2:1 over a lit building facade. It is a plate now, like everything else a
   finger is meant to find. */
.hud-pausebtn{
  position:absolute;top:var(--hud-sa-t);right:var(--hud-sa-r);
  --hud-edge:var(--hud-accent);--hud-chamfer:7px;
  width:var(--hud-pause-size);height:var(--hud-pause-size);
  min-width:var(--hud-pause-size);min-height:var(--hud-pause-size);
  padding:0;display:grid;place-items:center;
  color:var(--hud-accent);
  font-size:var(--t-title);letter-spacing:0;
}

/* ========================================================================== */
/* Alerts                                                                     */
/* ========================================================================== */
/* THE BULLETIN, and where it is allowed to be.
   Default placement — portrait and tablet — is directly under the band, in the
   safe box, centred by margins rather than by a translate off left:50%. The
   stack hangs from --hud-band-h so a band that grows a pixel cannot push a
   bulletin onto a plate. */
.hud-alerts{
  position:absolute;
  top:calc(var(--hud-sa-t) + var(--hud-band-h) + var(--hud-gap));
  left:var(--hud-sa-l);right:var(--hud-sa-r);margin:0 auto;
  width:max-content;max-width:min(calc(340px * var(--hud-scale)),74vw);
  display:flex;flex-direction:column;align-items:stretch;gap:5px;
  pointer-events:none;
}
/* Sized to its CONTENT, capped, never a fixed 420 px slab. The old banner held
   125 px of title and 181 px of body inside 420 px, with 116 px of nothing
   between the accent rule and the first letter on each side — 57 % of the box
   was empty, so the two accents read as free-floating brackets rather than as
   the edges of anything. */
.hud-alert{
  --hud-edge:var(--hud-alert-color,var(--hud-accent));
  display:flex;align-items:baseline;gap:9px;text-align:left;
  animation:hud-stamp .12s cubic-bezier(.2,.9,.3,1);
}
/* SPEED LINES. One shot, scaled out from the leading edge and then faded — a
   stamp hitting paper. It replaces the old translateY slide, which was the
   motion of a notification tray. It carries the plate's own chamfer and lean so
   it wipes the shape rather than a rectangle around it. */
.hud-alert::after{
  content:'';position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(100deg,var(--hud-alert-color,var(--hud-accent)) 0 1px,transparent 1px 7px);
  clip-path:var(--hud-plate);
  transform-origin:0 50%;
  animation:hud-sweep .34s cubic-bezier(.2,.9,.3,1) forwards;
}
.hud-alert__chip{color:var(--hud-alert-color,var(--hud-accent));align-self:center}
.hud-alert__main{min-width:0;display:flex;flex-direction:column;gap:1px}
.hud-alert__title{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;
  color:var(--hud-alert-color,var(--hud-accent));line-height:1.15;
  min-width:0;overflow:hidden;text-overflow:ellipsis;
}
.hud-alert__body{
  font-size:var(--t-body);color:var(--hud-ink-muted);line-height:1.3;
  min-width:0;overflow:hidden;text-overflow:ellipsis;
}
/* PULSE, on the classification stamp alone. The old rule throbbed the WHOLE
   banner's opacity down to .62 three times, which — with the banner sitting on
   the encounter card — animated the thing underneath it into view. */
.hud-alert[data-kind='threat'] .hud-alert__chip{animation:hud-pulse 1.1s steps(1,end) 3}
@keyframes hud-stamp{from{opacity:0;transform:scale(1.06)}to{opacity:1;transform:none}}
@keyframes hud-stamp-mark{0%{transform:scale(1)}30%{transform:scale(1.28)}100%{transform:scale(1)}}
@keyframes hud-sweep{
  0%{transform:skewX(var(--hud-skew)) scaleX(0);opacity:.42}
  70%{transform:skewX(var(--hud-skew)) scaleX(1);opacity:.22}
  100%{transform:skewX(var(--hud-skew)) scaleX(1);opacity:0}
}

/* ========================================================================== */
/* World-space markers (CSS2DRenderer positions these)                        */
/* ========================================================================== */
/* three writes transform and display on .hud-marker itself, so the      */
/* marker's OWN chrome must not depend on either — everything here is painted  */
/* from custom properties and static geometry.                                 */
/* The host is FULL-BLEED on purpose: CSS2DRenderer projects into the box it
   was given, so insetting it would shift every marker sideways by the notch
   width. Markers are clipped to the safe box instead, which keeps the
   projection honest and still stops a pin drawing under a cutout. */
.hud-markers{
  position:absolute;inset:0;overflow:hidden;pointer-events:none;
  clip-path:inset(var(--hud-sa-t) var(--hud-sa-r) var(--hud-sa-b) var(--hud-sa-l));
}
.hud-marker{
  position:absolute;pointer-events:none;
  display:flex;flex-direction:column;align-items:center;gap:2px;
  font-family:${DISPLAY_FONT};letter-spacing:.14em;white-space:nowrap;
  text-shadow:0 1px 3px rgba(0,0,0,.95);
}
.hud-marker__pip{
  width:12px;height:12px;border:2px solid var(--hud-marker-color,var(--hud-accent));
  background:rgba(5,8,14,.55);
}
.hud-marker[data-kind='threat'] .hud-marker__pip{transform:rotate(45deg)}
.hud-marker[data-kind='objective'] .hud-marker__pip{border-radius:50%}
.hud-marker[data-kind='civilian'] .hud-marker__pip{border-radius:50%;width:9px;height:9px}
.hud-marker[data-kind='errand'] .hud-marker__pip{border-radius:2px}
.hud-marker__label{font-size:var(--t-micro);color:var(--hud-marker-color,var(--hud-accent))}
.hud-marker__dist{font-size:var(--t-micro);color:var(--hud-ink-muted);letter-spacing:.14em}
.hud-marker[data-far='true'] .hud-marker__label{display:none}

/* ========================================================================== */
/* Screens                                                                    */
/* ========================================================================== */
.hud-screen{
  position:absolute;inset:0;display:flex;pointer-events:auto;
  background:radial-gradient(120% 90% at 50% 0%,rgba(4,6,11,.80),rgba(2,3,6,.94));
  padding:calc(var(--hud-sa-t) + 10px) calc(var(--hud-sa-r) + 10px)
          calc(var(--hud-sa-b) + 10px) calc(var(--hud-sa-l) + 10px);
  animation:hud-screen-in .16s ease-out;
}
@keyframes hud-screen-in{from{opacity:0}to{opacity:1}}
.hud-screen--centre{align-items:center;justify-content:center}
/* A document lies FLAT. The lean is for field plates stamped in a hurry; the
   paperwork the Association files is not in a hurry, and a 3° skew over 400 px
   of sheet is a 21 px lean, which stops being a signal and starts being a
   rendering fault. Same chamfer, same ink rule, no skew — so the sheet reads as
   the same institution's stationery without pretending to be a stamp. */
.hud-sheet{
  --hud-edge:var(--hud-accent);--hud-chamfer:14px;
  display:flex;flex-direction:column;
  width:100%;max-width:640px;max-height:100%;margin:0 auto;
  background:var(--hud-panel);background-color:var(--hud-surface);
  box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-edge),inset 0 1px 0 0 var(--hud-line);
  clip-path:var(--hud-plate);
  overflow:hidden;
}
.hud-sheet--wide{max-width:820px}
/* A menu of four destinations, not a form: narrower than the reading sheets. */
.hud-sheet--narrow{max-width:420px}
.hud-menu{display:grid;gap:var(--hud-gap)}
.hud-sheet__head{
  display:flex;align-items:baseline;gap:10px;
  padding:11px 16px;border-bottom:1px solid var(--hud-line);flex:0 0 auto;
}
.hud-sheet__title{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;
  text-transform:uppercase;color:var(--hud-accent);flex:1 1 auto;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.hud-sheet__sub{font-size:var(--t-body);color:var(--hud-ink-muted)}
.hud-sheet__body{
  flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;
  padding:12px 16px;-webkit-overflow-scrolling:touch;touch-action:pan-y;
}
.hud-sheet__foot{
  display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;
  padding:10px 16px;border-top:1px solid var(--hud-line);flex:0 0 auto;
}

.hud-section{margin:0 0 14px}
.hud-section:last-child{margin-bottom:0}
.hud-section__title{
  font-family:${DISPLAY_FONT};font-size:var(--t-micro);letter-spacing:.14em;text-transform:uppercase;
  color:var(--hud-ink-muted);padding-bottom:4px;margin-bottom:7px;
  border-bottom:1px solid var(--hud-line);
}
.hud-note{font-size:var(--t-body);line-height:1.45;color:var(--hud-ink-muted);margin-top:7px}

/* ---- lists ------------------------------------------------------------- */
/* A register entry: chamfered, faint paper tint, and an ink rule that only
   appears when the row means something. */
.hud-row{
  position:relative;display:flex;align-items:center;gap:10px;
  padding:8px 11px;
  background:rgba(255,255,255,.03);clip-path:var(--hud-plate);
  margin-bottom:6px;
}
.hud-row:last-child{margin-bottom:0}
.hud-row--button{pointer-events:auto;cursor:pointer;width:100%;text-align:left;min-height:${MIN_TAP_PX}px}
/* Edge and ink, not a wash. A 10 %-accent background on the selected row was
   the same tinted-panel move the primary button was making, and it made the
   row's own text harder to read to say something a 3 px rule says louder. */
.hud-row[data-selected='true']{box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-accent)}
.hud-row[data-selected='true'] .hud-row__title{color:var(--hud-accent)}
.hud-row__main{flex:1 1 auto;min-width:0}
.hud-row__title{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;line-height:1.15;
  overflow:hidden;text-overflow:ellipsis;
}
.hud-row__meta{font-size:var(--t-body);color:var(--hud-ink-muted);line-height:1.35;margin-top:2px}
/* THE SUPERMARKET WARNING. It used to sit on the combat tracker as well, and
   losing that live position is the one thing this redesign took away that the
   player will miss — so here it gets the room it never had there: its own rule,
   its own colour, and no truncation. */
.hud-quest__conflict{
  margin-top:6px;padding:4px 0 4px 10px;
  box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-collateral);
  color:var(--hud-collateral);font-size:var(--t-body);line-height:1.35;
}
.hud-row__value{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;
  font-variant-numeric:tabular-nums;text-align:right;flex:0 0 auto;
}

/* ---- rank board -------------------------------------------------------- */
.hud-standing{display:flex;align-items:flex-end;gap:14px;margin-bottom:12px}
.hud-standing__rank{
  font-family:${DISPLAY_FONT};font-size:var(--t-hero);line-height:.82;letter-spacing:.06em;
  color:var(--hud-class,var(--hud-accent));
}
.hud-standing__meta{flex:1 1 auto;min-width:0}
.hud-standing__bar{height:3px;background:var(--hud-track);border-radius:var(--hud-radius);overflow:hidden;margin-top:6px}
.hud-standing__bar::after{
  content:'';display:block;height:100%;background:var(--hud-accent);
  transform-origin:0 50%;transform:scaleX(var(--fill,0));
}
.hud-rival{box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-rival)}
.hud-rival[data-above='false']{box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-ink-muted)}
.hud-rival__gap{color:var(--hud-rival);font-family:${DISPLAY_FONT}}
.hud-rival[data-above='false'] .hud-rival__gap{color:var(--hud-ink-muted)}
.hud-feed__delta{font-family:${DISPLAY_FONT};font-variant-numeric:tabular-nums}
.hud-feed__delta[data-sign='up']{color:var(--hud-saved)}
.hud-feed__delta[data-sign='down']{color:var(--hud-lost)}
.hud-feed__delta[data-sign='flat']{color:var(--hud-ink-muted)}

/* ---- invoice ----------------------------------------------------------- */
.hud-invoice{font-variant-numeric:tabular-nums}
.hud-invoice__line{
  display:flex;align-items:baseline;gap:10px;padding:5px 0;
  border-bottom:1px dashed var(--hud-line);
}
.hud-invoice__line:last-child{border-bottom:none}
.hud-invoice__key{flex:1 1 auto;color:var(--hud-ink-muted);font-size:var(--t-body)}
.hud-invoice__val{font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em}
.hud-invoice__line--total{
  margin-top:6px;border-top:1px solid var(--hud-line);border-bottom:none;padding-top:9px;
}
.hud-invoice__line--total .hud-invoice__val{font-size:var(--t-readout);letter-spacing:.01em}
.hud-invoice__sub{font-size:var(--t-body);color:var(--hud-ink-muted);text-align:right}
.hud-invoice__val--saved{color:var(--hud-saved)}
.hud-invoice__val--lost{color:var(--hud-lost)}
.hud-invoice__val--collateral{color:var(--hud-collateral)}
/* The verdict is the one editorial line on the screen, so it gets the loudest
   thing the language has that is not a tint: the ink rule, and the ink. */
.hud-verdict{
  margin-top:10px;padding:9px 12px;
  box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-verdict,var(--hud-accent));
  background:rgba(255,255,255,.03);clip-path:var(--hud-plate);
  color:var(--hud-verdict,var(--hud-accent));font-size:var(--t-body);line-height:1.45;
}

/* ---- settings ---------------------------------------------------------- */
.hud-setting{display:flex;align-items:center;gap:10px;padding:7px 0;min-height:48px}
.hud-setting__label{flex:1 1 auto;min-width:0}
.hud-setting__name{font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em}
.hud-setting__hint{font-size:var(--t-body);color:var(--hud-ink-muted);line-height:1.3;margin-top:1px}
.hud-seg{display:flex;gap:3px;flex:0 0 auto;background:rgba(255,255,255,.05);padding:3px}
/* The segmented options are the ONLY control on the settings screen, chosen
   over sliders precisely because they can be full tap targets. 38 px was not
   one. */
.hud-seg__opt{
  pointer-events:auto;cursor:pointer;min-height:${MIN_TAP_PX}px;min-width:${MIN_TAP_PX}px;padding:6px 11px;
  border:none;background:none;color:var(--hud-ink-muted);
  font-family:${DISPLAY_FONT};font-size:var(--t-body);letter-spacing:.06em;
  text-transform:uppercase;touch-action:none;
}
/* Ink and an underscore rule. The selected option used to be a tinted pill,
   which is a panel with a colour wash on it — the move this language does not
   make anywhere else. */
.hud-seg__opt[aria-pressed='true']{
  color:var(--hud-accent);
  box-shadow:inset 0 -2px 0 0 var(--hud-accent);
}
.hud-swatches{display:flex;gap:5px;flex:0 0 auto}
.hud-swatch{
  width:14px;height:14px;border:1px solid rgba(255,255,255,.25);
  background:var(--hud-swatch-color,transparent);
}

/* ---- loading ----------------------------------------------------------- */
/* THE BOOT CARD.
   Four separate defects lived on this screen and all four came from the same
   two decisions: centring inside an ASYMMETRIC padding box, and centring TEXT
   that carries heavy tracking.
     · The box was padded calc(safe-inset + 16px) per side, so on a notched
       phone the "centre" was the centre of a lopsided rectangle: predicted
       content centre 213.5 CSS px against a true 220, and the ink measured
       213.17. The padding is symmetric now — max() of each opposing pair — so
       centred means centred and nothing lands under a cutout either way.
     · CSS adds letter-spacing AFTER the final glyph too, so centred tracked
       text sits half a tracking unit left: the title measured 2.00 px off
       centre at .16em/22px, the subtitle 1.83 px at .3em/12px, and the two
       untracked tip lines measured 0.17 and 0.33 px, i.e. dead centre. Nothing
       on this screen is centred any more. It is a FILED CARD, set flush left
       against one measure, and the whole class of error goes with it.
     · The bar, the readout row and the flavour line now share --hud-measure.
       They were 320 px, 320 px and 460 px, so the flavour line overhung the bar
       by 68 px on each side and ran ~83 characters — past readable — under a
       symmetric bar it did not line up with.
     · Every size here was a fixed literal (22/12/11/13/11.5 px), so the one
       screen a player stares at for the whole boot ignored their HUD scale
       setting entirely. */
.hud-loading{
  position:absolute;inset:0;display:grid;place-items:center;
  background:var(--hud-panel);background-color:var(--hud-surface);
  pointer-events:auto;
  padding:calc(max(var(--hud-sa-t),var(--hud-sa-b)) + 16px) calc(max(var(--hud-sa-l),var(--hud-sa-r)) + 16px);
}
.hud-loading__card{
  --hud-edge:var(--hud-accent);
  display:flex;flex-direction:column;align-items:stretch;
  width:var(--hud-measure);
}
.hud-loading__title{
  font-family:${DISPLAY_FONT};font-size:clamp(var(--t-readout),7vw,var(--t-hero));
  letter-spacing:.06em;text-transform:uppercase;color:var(--hud-accent);line-height:1;
}
.hud-loading__sub{
  font-family:${DISPLAY_FONT};letter-spacing:.14em;font-size:var(--t-micro);
  color:var(--hud-ink-muted);margin-top:3px;
}
.hud-loading__track{
  height:5px;margin-top:22px;overflow:hidden;
  background:var(--hud-track);border-radius:var(--hud-radius);
}
.hud-loading__fill{
  display:block;height:100%;background:var(--hud-accent);
  transform-origin:0 50%;transform:scaleX(var(--fill,0));
  will-change:transform;
}
/* The percentage LEADS the row, at the same x as the fill's origin. It used to
   trail it: .hud-loading__label took flex:1 1 auto in a row exactly as wide as
   the bar, so the label ate every spare pixel and left the number stranded
   238 px from the fill head with a 167 px void in between — and the row's
   justify-content:center was dead code for the same reason. */
.hud-loading__row{display:flex;align-items:baseline;gap:10px;margin-top:9px}
.hud-loading__pct{
  font-family:${DISPLAY_FONT};font-size:var(--t-readout);line-height:1;letter-spacing:.01em;
  color:var(--hud-accent);flex:0 0 auto;
}
.hud-loading__label{
  font-family:${DISPLAY_FONT};font-size:var(--t-micro);letter-spacing:.14em;text-transform:uppercase;
  color:var(--hud-ink-muted);
  flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.hud-loading__tip{
  font-size:var(--t-body);line-height:1.55;color:var(--hud-ink-muted);
  margin-top:22px;padding-left:11px;
  box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-line);
}

/* ========================================================================== */
/* Landscape phone — the constrained case, and the one that ships             */
/* ========================================================================== */
/* 121 px of band, and the arithmetic is at the top of this file. Everything
   below is what fitting in it costs. */
@media (max-height:520px){
  .hud-root{--hud-gap:6px;--hud-band-row:64px;--hud-band-h:114px;--hud-arc-w:150px;--hud-arc-h:86px}
  .hud-rankchip{width:min(calc(206px * var(--hud-scale)),26vw)}
  /* ONE LINE. The strip's two rows become one row so the band closes above the
     hands at 130 % HUD scale as well as at 100 %; the quest name and its lead
     objective share a baseline instead of stacking. */
  .hud-tracker__main{flex-direction:row;align-items:baseline;gap:10px}
  .hud-sheet{max-height:100%}
  /* THE BULLETIN GOES TO THE CORRIDOR. There is no room under the band on this
     profile — the band ends where the hands begin — and the corridor between
     the two hands, above the charge arc, is the only rectangle left. Anchored
     to the arc's own box so the two cannot collide when a threat is classified
     mid-charge, and low enough that the bulletin starts below the vertical
     midpoint rather than reaching back up towards a plate. */
  .hud-alerts{
    top:auto;
    bottom:calc(var(--hud-sa-b) + var(--hud-arc-lift) + var(--hud-arc-h) + var(--hud-gap));
    max-width:min(calc(300px * var(--hud-scale)),38vw);
  }
  /* One at a time, here only. Three stacked bulletins is already more than
     anyone reads mid-fight — alerts.ts says exactly that about its own queue —
     and a stack of three reaches back up into the band on a 390 px viewport.
     The queue still holds three; this screen shows the newest. */
  .hud-alerts > *:nth-child(n+2){display:none}
  .hud-setting{min-height:${MIN_TAP_PX}px}
}

/* Narrow portrait: ONE COLUMN, and the order is the order it is read in.
   Two columns of 184 px could not hold the register — four cells of a printed
   tally do not fit in half of a 390 px phone, and it wrapped to three rows and
   drove the band to 136 px. Full width fits all four on one line with room
   over.
   The persistent plates come first and the TRANSIENT ones last: the incident
   and its cost appear and disappear together when a fight starts and ends, so
   putting them at the bottom means nothing above them ever moves. */
@media (orientation:portrait) and (max-width:460px){
  .hud-root{--hud-band-h:216px}
  .hud-top{grid-template-columns:minmax(0,1fr);row-gap:6px}
  .hud-top__left{grid-area:1 / 1}
  .hud-tracker{grid-area:2 / 1}
  .hud-top__centre{grid-area:3 / 1;align-items:stretch}
  .hud-top__right{grid-area:4 / 1;padding-right:0}
  .hud-rankchip{width:min(calc(232px * var(--hud-scale)),100%)}
  .hud-sheet{max-width:100%}
}

/* ========================================================================== */
/* Reduced motion                                                             */
/* ========================================================================== */
.hud-root[data-reduced-motion='true'] *,
.hud-root[data-reduced-motion='true'] *::before,
.hud-root[data-reduced-motion='true'] *::after{
  animation:none !important;transition:none !important;
}
@media (prefers-reduced-motion:reduce){
  .hud-root *,.hud-root *::before,.hud-root *::after{animation:none !important;transition:none !important}
}
`;
}

/**
 * Inject the stylesheet once per document.
 *
 * Returns the `<style>` node so a caller can dispose it; re-injecting is a
 * no-op, which matters because the harness mounts several HUDs into one page.
 */
export function ensureHudStyles(doc: Document): HTMLStyleElement {
  const existing = doc.getElementById(HUD_STYLE_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = doc.createElement('style');
  style.id = HUD_STYLE_ID;
  style.textContent = hudStyles();
  doc.head.appendChild(style);
  return style;
}
