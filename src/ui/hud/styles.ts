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
 *   --t-readout 24   every live number the player ACTS  tracking .01em
 *                    on
 *   --t-hero    44   the rank-board standing, the boot  tracking .06em
 *
 * "EVERY LIVE NUMBER" WAS A CATEGORY RULE, AND A CATEGORY RULE CAN INVERT A
 * HIERARCHY. It did, once, on the incident plate: `.hud-encounter__clock` is a
 * count-up with no threshold and nothing to act on, and it was set at 24 px in
 * full ink beside the name of the thing trying to kill you at 18. Read cold,
 * the shipping frame delivered "¥5.42B" and "0:06" before "MOSQUITO GIRL".
 * The clock is at --t-title now and the rule is stated as what it always meant:
 * the readout step is for a number the player is ACTING on — the seat, the
 * civilian counts, the yen, the quest clock that is running out. Demoting the
 * fight clock was the only move available, because the name cannot be promoted:
 * the incident head measures 302.32 px inside a 302.33 px plate, so 24 px type
 * on "Deep Sea King" would ellipsise it. It frees ~9 px, and that is headroom
 * rather than a promotion.
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
 * Six panels became three plates and a duty row, and the band went from
 * overflowing at 100 % — the right column reached 6 px into a hand at 130 % —
 * to closing at y=114 at 100 % and y=125 at 130 %, both above the 129 px line.
 * `--hud-band-row` is this file's own statement of that budget and the harness
 * fails if row one outgrows it.
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
 * behind it. `--hud-panel` now lays the palette's own surface down THREE TIMES,
 * so every palette composes to ~99 % by its own colour rather than by a
 * literal, and the city bleed drops from ~18 % to under 1 %.
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
 * THREE, and a screen opening is not one of them — see `.hud-screen`, which
 * used to cross-fade for 160 ms and cost this project every readable screenshot
 * of a modal it has ever committed.
 *
 * All three are killed outright by `[data-reduced-motion='true']` at the bottom
 * of this file — which is why EVERY animated rule here declares the state it
 * rests in. `animation:none` does not restore anything; it removes the
 * animation and leaves the SPECIFIED style standing. A rule whose only
 * invisibility came from a keyframe therefore becomes permanently visible for
 * the players who asked for less motion, at full strength, which is exactly
 * what `.hud-alert::after` did to a threat bulletin. If a keyframe is the only
 * thing hiding something, the rule is wrong.
 *
 * ── HOW THIS FILE IS PARSED, AND WHAT THAT FORBIDS ─────────────────────────
 * `__tests__/styles.test.ts` reads this stylesheet with a REGULAR EXPRESSION,
 * not a CSS parser:
 *
 *     (?:^|[\n},])\s*ESCAPED_SELECTOR\s*\{([^{}]*)\}
 *
 * Three rules follow from that, and breaking any of them fails the build with a
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
 *   NO SPACE AFTER THE COLON IN A DECLARATION. This sheet is a template
 *   literal, so neither prettier nor eslint normalises a single byte inside it,
 *   and the two completeness guards find their subjects by matching declaration
 *   TEXT. They are written whitespace- and wrapper-tolerant now — `/transform:\s
 *   *scaleX\(\s*(?:var|calc)\(/` and `/pointer-events:\s*auto/` — precisely
 *   because they were not, and a mutation test proved what that cost: a fill
 *   written `transform: scaleX(var(--charge))` or `scaleX(calc(var(--charge) *
 *   1))`, and a control written `pointer-events: auto`, each vanished from BOTH
 *   halves of its own guard and landed green on the day it was written. The
 *   convention still holds everywhere in this file — a scan of the
 *   comment-stripped sheet finds zero spaced declarations — and keeping it is
 *   how the guards stay cheap to read.
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
/* AND REGISTERING ONE MEANS NOTHING BELOW EVER NEEDS A var() FALLBACK. A       */
/* registered property with an initial-value is never guaranteed-invalid, so    */
/* var(--boredom,0) and its four siblings could not take their fallback under   */
/* any condition; they read as defensive defaults defending nothing, in a file  */
/* whose comments are the design record. The one surviving fallback is          */
/* var(--hud-arc-len,239), and it survives because --hud-arc-len is NOT         */
/* registered and is written from TS. Where a non-zero default is wanted the    */
/* declaration has to supply it — see .hud-boss__fill's --fill:1.               */
/* --fill INHERITS, and that is load-bearing rather than incidental: one of its  */
/* consumers is a ::after pseudo-element (.hud-standing__bar) and a writer can   */
/* only reach the ORIGINATING element. A pseudo inherits from its originator      */
/* exactly as a child does, so with inherits:false the registered initial-value  */
/* wins inside ::after and the rank board's progress sliver reads 0 forever.     */
@property --boredom{syntax:'<number>';inherits:true;initial-value:0}
@property --charge{syntax:'<number>';inherits:true;initial-value:0}
@property --fill{syntax:'<number>';inherits:true;initial-value:0}
@property --collateral{syntax:'<number>';inherits:false;initial-value:0}
/* AND ONE REGISTRATION THAT IS NOT ABOUT INTERPOLATION AT ALL. --hud-band-row  */
/* is the top band's declared budget and harness/hud.verify.ts reads it back    */
/* off the root with parseFloat, which is the whole reason it is "a promise     */
/* rather than a comment". An UNREGISTERED custom property computes to its       */
/* TOKEN STREAM: var() is substituted but calc() is not evaluated, so the moment */
/* the budget became affine in --hud-scale the harness would have read           */
/* "calc(29px + 35px * 1)", got NaN, and printed "[skip] … declares no           */
/* --hud-band-row". A budget assertion that silently turns itself off is worse   */
/* than none, because the report still says every check passed. Registering it   */
/* as <length> makes the computed value a resolved px length — 64px at 100 %,    */
/* 74.5px at 130 % — so the expression can scale and the gate can still read it. */
/* --hud-band-h needs no such treatment: nothing outside CSS reads it.           */
@property --hud-band-row{syntax:'<length>';inherits:true;initial-value:64px}

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
  /* The escape hatch, and the reserve that keeps the register out of its
     corner, from one number — invariant 5, and the reason the two cannot drift.
     AFFINE NOW, AND NEVER BELOW MIN_TAP_PX. It was a bare ${MIN_TAP_PX}px while
     --hud-band-row beside it is affine, which made the pause chip the ONE
     control in the game that does not grow when a player raises HUD scale: the
     single most important target on the screen, frozen at the setting a
     low-vision player picks, next to a LOG button that grew. max() keeps the
     44 px floor intact at every rung below 100 %, so the guard in
     __tests__/styles.test.ts still has a number to stand on.
     It costs the register width, and the cost is stated rather than discovered:
     .hud-top__right reserves this plus 6 px, so the ledger gives back whatever
     the chip takes. That is affordable because the ledger's four cells are
     165.67 px of a 187.67 px plate.
     WHAT IS NOT AFFORDABLE IS THE FULL AFFINE VALUE ON THE PROFILE THAT SHIPS,
     and the landscape block below caps it at 48 px for a reason measured there
     rather than guessed here: a 390 px-tall screen leaves 129 px above the
     hands, and 57.20 px of pause chip closed the band at y=138. Read that
     block before touching this expression — this line states the RULE (never
     below the tap floor, always affine) and that one states the CEILING the
     shipping viewport can pay for. */
  --hud-pause-size:max(${MIN_TAP_PX}px,calc(${MIN_TAP_PX}px * var(--hud-scale)));
  /* ONE GAUGE FOR EVERY METER. The HUD shipped five meters at three
     thicknesses — the boss rule and the boredom meter at 5 px, the collateral
     track at 4 with a 2 px margin over it, the rank board's seat sliver at 3,
     the boot bar at 5 — so on the boss screen, where three of them are visible
     at once, the eye read a stepped stair rather than a band. A meter is the
     same instrument wherever it appears, and an instrument has one gauge.
     5 px is the size the two most-seen meters already were, and it is the
     smallest bar that still reads as a CONTAINER with a proportion in it at
     --hud-track's 3.2:1 boundary contrast. */
  --hud-meter-h:5px;
  /* What ROW ONE of the combat band is allowed to cost, measured the way the
     harness measures it: from the top INSET, which on a landscape phone is 0
     while the band itself starts at the 8 px edge floor. So this is the tallest
     plate — the incident cost: micro label row, 24 px readout, the collateral
     rule and padding, 56 px — plus that floor. Measured at 64.0 against a 64 px
     budget, with the grid's own 6 px gap as the slack.
     It is read THREE times now, and that is why it had to stop being a
     constant: .hud-top makes it row one's MINIMUM height, .hud-pausebtn centres
     the button on it, and the harness measures row one against it.
     AFFINE, FOR THE SAME REASON --hud-band-h BELOW IS. A flat 64 px is a
     statement about row one at exactly one HUD scale, and row one's content is
     type: measured in combat on the shipping profile it runs 56.00 px at 100 %,
     61.23 at 115 % and 66.50 at 130 %. The floor therefore bound at 85 % and
     100 % and was INERT above, so the strip and its 44 px LOG button dropped
     3.00 px the instant a fight put a ledger in the row, and came back up when
     it ended — at 115 % and 130 % only. The comment on .hud-top claimed that
     jog fixed; it was fixed at two of the four rungs of the one accessibility
     control this game has, and nothing could see it, because the harness
     measures CLS inside a SINGLE scene and 66.5 px is still inside the 64 px
     budget plus the grid's 6 px gap.
     29 + 35 x scale is the line through those measurements plus the 8 px edge
     floor this token is measured from — 58.75 / 64 / 69.25 / 74.5 at the four
     rungs — so the floor tracks the content instead of crossing it. At 100 % it
     is still exactly 64 px, which is why every committed screenshot and the
     harness's budget figure are unchanged at the shipping setting.
     The 8 px is --hud-sa-t's own floor rather than a literal, and .hud-top
     subtracts it straight back out: this token is measured from the raw INSET
     because that is how the harness measures it, while the band starts at the
     edge floor. On a portrait phone the inset is 59 px, the subtraction goes
     negative, and max(0px,…) in .hud-top turns the floor off — which is right,
     because row one there is one plate and has nothing to be level with. */
  --hud-band-row:calc(29px + 35px * var(--hud-scale));
  /* And what the WHOLE band costs, every row and every gap. Nothing lays out
     against it; the alert stack hangs off the bottom of it, so a band that
     grows a row taller cannot push a bulletin onto a plate. Re-declared per
     breakpoint, because the band is two rows in landscape and four in
     portrait — except in landscape, where the bulletin is anchored to the
     charge arc at the BOTTOM of the screen instead and this token has no
     consumer at all. It is not redeclared there for exactly that reason.
     AFFINE, NOT A CONSTANT, and the constant was wrong in the direction that
     matters. A band is plate padding and grid gaps, which are fixed, plus type,
     which is not: measured on the tablet profile the band runs 112.94 px below
     its own top at 100 % HUD scale and 134.53 at 130 %. The old flat 124 px
     therefore put the bulletin's top edge at y=140 while the duty strip was
     still running to 142.5 — a bulletin landing on a plate, which is the exact
     failure the whole two-placement design exists to prevent, on the one
     accessibility setting the game has. Portrait was worse: 219.94 growing to
     260.03 against a token that said 216. 42 + 72 x scale is the line through
     the two measurements, rounded up so it over-states by ~1 px rather than
     under-stating by 19.
     MEASURED FROM THE BAND'S OWN TOP, i.e. from --hud-sa-t, which is where
     .hud-top starts and what its one consumer adds it to. --hud-band-row above
     is measured from the raw INSET instead because the harness measures it that
     way; the two origins differ by the 8 px edge floor on any screen whose
     inset is smaller than it, and reading this one from the inset spent that
     8 px twice on every tablet.
     AND THE AFFINE TERM HAS A FLOOR UNDER IT, because a band is not type all
     the way down. The duty strip carries min-height:${MIN_TAP_PX}px — a tap
     target, which does not shrink when the type does — so BELOW 100 % the line
     keeps falling while the band stops. Measured on the tablet at 85 % HUD
     scale the bulletin cleared the band by 2.33 px against a design gap of 8:
     a quarter of --hud-gap, on the accessibility setting's bottom rung, from a
     token whose comment claims it over-states. The floor is the band restated
     as what it is actually made of at that rung — row one, one gap, and a tap
     target — so the two cannot disagree again. It is inert at every rung: at
     85 %, where it comes closest, it falls 0.45 px short of the affine term
     (102.75 against 103.2), and that half a pixel is precisely why it is here.
     It is all the margin the line has left at the bottom rung, and a font
     fallback that makes the duty strip one pixel taller spends it. */
  --hud-band-h:max(calc(42px + 72px * var(--hud-scale)),calc(var(--hud-band-row) - var(--hud-sa-t) + var(--hud-gap) + ${MIN_TAP_PX}px));
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
   backing sit at z-index -1 — behind the content, in front of nothing.
   5/6 px of vertical padding rather than 6/7, which does not sound like a
   decision until the band is 121 px tall at 130 % HUD scale and two pixels a
   plate is most of the margin. */
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
/* EVERY LIVE NUMBER ON THE PLAYING HUD, AT ONE SIZE, FROM ONE RULE. The rank,
   the fight clock, the ledger counts, the yen, the quest clock and the boot
   percentage were 19, 21, 23, 17, 20 and 13 px in six separate declarations,
   which is why no two of them ever sat on a shared baseline and why fixing one
   never fixed the others. They all carry this class now. */
.hud-readout{
  font-family:${DISPLAY_FONT};
  font-size:var(--t-readout);
  line-height:1;letter-spacing:.01em;
  font-variant-numeric:tabular-nums;
}
/* A classification stamp: the one place an all-round outline survives, because
   a stamp is exactly what it is. Never rendered without its word inside it.

   ── THE ONE MICRO CONSUMER PROMOTED TO --t-body, AND WHY IT IS THIS ONE ────
   10 px is below the size a glance can read at arm's length, and the arithmetic
   is not close: on a 6.1" phone showing an 844 px-wide viewport, 1 CSS px is
   ~0.166 mm and Bebas's cap height is ~0.73em, so --t-micro subtends ~12.8
   arcmin at 325 mm against the ~16 the eye wants for comfortable glance
   reading. --t-body is 16.6, --t-title 23, --t-readout 30.6: the micro step is
   the only one under the floor, and downscaling the committed shots to what the
   device actually subtends turns every micro run into a smear while every other
   step stays legible.
   That matters most HERE, because of invariant 8. The tier word exists because
   no five-hue ramp survives dichromacy as colour alone — colour is the
   accelerator and the word is the message. Printed at 12.8 arcmin the word is
   only readable if the player stops and stares, which leaves a deuteranope
   mid-fight with a hue they cannot separate and a word they cannot read: the
   invariant satisfied in letter and defeated in function. Meanwhile the
   monster's proper name, which tells the player nothing they can act on, was
   getting 18 px right beside it.
   It costs nothing vertically. The stamp shares its row with .hud-encounter__
   name at --t-title, which is taller at both sizes, so row one's height and
   therefore --hud-band-row are untouched — measured 56.00 px at 100 % before
   and after. It costs ~8 px of the incident plate's width, which comes out of
   the enemy's name, and that is the trade stated in the right order.
   NOT THE WHOLE STEP, and the other micro consumers stay where they are.
   Raising --t-micro itself to 12 px would fix the ledger's captions too, and it
   would also add ~2.9 px to row one at 130 % against a band that closes 4.5 px
   above the hands there — spending the entire margin of the constraint this
   whole layout is built on, to fix labels whose numerals are already at 24 px
   and colour-coded. And .hud-boredom__mood cannot be promoted at all: "NOTHING
   FEELS LIKE ANYTHING" is 27 characters in a plate capped at 26vw, and there is
   no size at which that string is both complete and glance-legible. It is
   captioning a coloured meter directly beneath it, and it is read between
   fights rather than during one.
   The tracking drops with the promotion because tracking is a function of size
   in this sheet: .14em is for 10 px uppercase that needs the air, and
   styles.test.ts fails any rule above the micro step that keeps it. The
   padding-left correction is the same one three other rules carry — CSS adds
   letter-spacing after the FINAL glyph too, so without it the word sits half a
   tracking unit left of the centre of its own stamp, in both the content-sized
   case and the fixed-column case the alert stack now uses. */
.hud-chip{
  font-family:${DISPLAY_FONT};font-size:var(--t-body);letter-spacing:.06em;
  padding:2px 6px 1px calc(6px + .06em);border:1px solid currentColor;
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
  /* 16 px of paper on three sides, and the LEADING edge adds the ink rule on
     top of it. The rule is painted inside this box, so a flat 'padding:9px
     16px' measures the label from a box edge whose first 3 px the player reads
     as the edge itself — 13 px of clear space on the left against 16 on the
     right, which on a 110 px footer button is a visible 2.7 % lean into the
     rule. Same correction as '.hud-pausebtn' and '.hud-tracker__open' below,
     for the same reason: measure the type from the field, not from the box.
     It only started mattering when the plate became visible; against the
     invisible one the whole box was a guess. */
  padding:9px 16px 9px calc(16px + var(--hud-rule));cursor:pointer;text-align:left;
  transition:transform .08s ease-out,color .12s;
  touch-action:none;will-change:transform;contain:layout style;
}
/* A BUTTON HAS TO BE A BOX, AND OVER A SHEET THIS ONE WAS NOT.
   'background:var(--hud-panel)' alone is halftone over var(--hud-surface) laid
   down three times, so it composites to ~99.4 % of the surface. Over the city
   that is a plate you can see — the pause chip measures rgb(9.8,12.7,19.6)
   against a sky of rgb(37.0,31.9,47.9). Over a '.hud-sheet', whose fill IS
   --hud-surface, it composites to the sheet's own colour: 1.00:1, identical to
   the decimal. Every button on every modal was therefore a 1 px top hairline
   and a 3 px ink tick that the bottom-left chamfer clips to ~35 of its 44 px —
   the pause menu read as four list separators with an unexplained 16 px indent
   beside them, and the invoice's primary action FILE IT read as a rendering
   artefact hanging in mid-air where the top-right chamfer cut its hairline.
   THE LIFT GOES ABOVE var(--hud-surface), NOT INSTEAD OF IT. That is invariant
   4 and it is why this is a gradient layer rather than a flat colour: five
   palettes fill the surface slot, and a hard-coded fill makes four of them dead
   data. 'background-color' under the whole stack is the same double declaration
   '.hud-sheet' and '.hud-marker__label' already make, so the plate is opaque
   whatever is behind it.
   .05 rather than .03, and the two numbers are the same decision made twice:
   '.hud-row' lifts a register card by .03 and measures 1.10:1, which is plainly
   visible as a card on a reading sheet held still. A button is hit with a thumb
   during a fight, so it gets the next step up — and it is still a NEUTRAL wash,
   not a tint, so the panel contrast palette.test.ts measures is unmoved. */
.hud-btn::before{
  content:'';position:absolute;inset:0;z-index:-1;
  background:linear-gradient(rgba(255,255,255,.05),rgba(255,255,255,.05)),var(--hud-panel);
  background-color:var(--hud-surface);
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

/* ========================================================================== */
/* Combat HUD — the top band                                                  */
/* ========================================================================== */
/* ROW ONE IS A ROW, which means it has ONE bottom edge. It used to be
   'align-items:start', so each of the four boxes fell to its own content height
   and the band's dominant horizontal line — the one the eye uses to read a row
   AS a row — did not exist: rank chip closing at 61, encounter at 43, ledger at
   64, pause button at 52, four bottoms spread over 21 px. The encounter was the
   casualty, a 35 px stub suspended between a 53 px plate and a 56 px plate with
   27 px of bare sky under it while its neighbours cleared the duty strip by 6.
   Three plates that start at the same y and end wherever their text runs out
   read as three unrelated widgets, not as one filed row.
   'stretch' costs nothing — the row was already as tall as its tallest plate.
   THE ROW ALSO HAS A FLOOR, which is the other half of the same complaint. With
   the height driven purely by content, the ledger appearing when a fight starts
   pushed the duty strip and its LOG button down 3 px (idle tracker y=67, combat
   y=70), and the harness measures CLS inside a single scene, so no gate in this
   repo can see a jog between two. The floor is the row's own declared budget,
   measured the way --hud-band-row declares it — from the top INSET, while the
   band itself starts at the edge floor, hence subtracting --hud-sa-t back out.
   THE FLOOR ONLY WORKS IF IT TRACKS THE CONTENT, which is the correction this
   comment used to be missing. A flat 64 px floor is 56 px of row, and row one's
   combat content is 56 px at 100 % and 66.5 px at 130 % — so the floor bound at
   85 % and 100 % and did nothing at all above, and the jog it claims to have
   fixed came straight back at the two rungs a low-vision player is most likely
   to be on. --hud-band-row is affine now for exactly this reason, and it is the
   same line the content walks: at every rung the floor equals the combat row
   and idle is lifted to meet it, so the strip does not move whether or not a
   fight is on.
   minmax and NOT a fixed height: the ledger is 56 px at 100 % and 66.5 at
   130 %, and a 64 px box would clip it at the setting a low-vision player
   picks. max(0px,...) so a top inset deeper than the budget — a portrait phone,
   where row one is one plate and this floor means nothing — cannot produce a
   negative track and invalidate the whole declaration. */
.hud-top{
  position:absolute;
  top:var(--hud-sa-t);left:var(--hud-sa-l);right:var(--hud-sa-r);
  display:grid;
  grid-template-columns:auto minmax(0,1fr) auto;
  grid-template-rows:minmax(max(0px,calc(var(--hud-band-row) - var(--hud-sa-t))),auto) auto;
  align-items:stretch;
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
/* ── THE RESTING BAND IS A COMPOSITION, NOT COMBAT MINUS TWO PLATES ────────
   With no incident, '.hud-top__centre' and '.hud-top__right' hold nothing and
   the 1fr middle column simply held nothing with them: a 177 px chip at
   x 59..236 and then 530 px of sky before the pause button at 766 — 70.6 % of
   a 751 px safe box empty, in the state the player is in most of the time. The
   band became an L with a hole punched in it and the two right-hand controls
   read as orphans. Row TWO's 193 px gap is deliberate and argued for on
   '.hud-tracker__plate'; 530 px is not the same thing three times over.
   The hero file takes the room the incident would have taken. It is the only
   plate in the row, so it owns the row's measure, and the band's RIGHT EDGE
   stops moving between states: the file now closes at 754, six pixels — one
   grid gap — short of where the register closes at 760 when a fight is on. The
   pause chip gains a neighbour and the row reads as one filed line.
   WHAT THE PLAYER SEES CHANGE WHEN A FIGHT STARTS: the file's right edge, and
   nothing else. Its left edge, its top, its bottom, the duty strip and both
   controls all hold — which is the property '--hud-band-row' exists to protect,
   restated on the other axis. It is a re-layout at the one moment the whole
   band is already re-laying out, and it reads as the file yielding the room to
   the incident.
   AND THE MOOD METER IS WHAT FILLS IT. That is the editorial half: in the
   resting state the boredom meter is the only live number the band has, and
   this game's whole subject is that number. It goes from a 121 px bar to a
   ~640 px one exactly when there is nothing else to read.
   '.hud-top__centre' is taken out of flow rather than left underneath, because
   two grid items in one cell is how a bulletin ended up on an encounter card. */
.hud-top[data-encounter='none'] .hud-top__left{grid-area:1 / 1 / auto / 3}
.hud-top[data-encounter='none'] .hud-top__centre{display:none}
.hud-top[data-encounter='none'] .hud-rankchip{width:100%}
/* The seat row stops bracketing once the plate is wider than the seat row —
   see '.hud-rankchip__seat'. At 695 px, 'space-between' would put GAIN ×0.83 a
   clear 500 px from the seat it modifies. */
.hud-top[data-encounter='none'] .hud-rankchip__seat{justify-content:flex-start;gap:14px}

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
   The rank is the largest thing in the corner by 2.4x, which is what turns a
   widget into a title card.

   ── WHY THE MOOD WORD HAS ITS OWN LINE NOW ─────────────────────────────────
   It used to share the caption row with the RANK overline, right-aligned
   against it, and that arrangement had two costs. The small one: a caption two
   rows above the meter it captions. The large one: at 130 % HUD scale — the
   setting a low-vision player picks — the overline and the mood word wanted
   28 + 8 + 142 = 178 px of a file column measuring 160, so the meter's ONLY
   content rendered "GOING THROUGH THE MOT…". The header of this file and
   styles.test.ts both name that exact failure and claim it fixed; it was not,
   because the landscape override capped the plate at 26vw = 219.4 px, which at
   130 % is SMALLER than 206 x 1.3, so the var(--hud-scale) term never
   participated and the guard passed on an inert declaration.
   Three rows, re-dealt, at the same height as before:
     1  RANK 388 — the caption inline with the figure it captions — and, opposite
        it, GAIN xN.NN, the other labelled figure. Two labelled numbers, one
        baseline, bracketing the plate the way the two captions used to.
     2  the mood word, alone, FLUSH LEFT over the fill's own origin. A caption
        directly above its meter, set flush left against one measure, which is
        the pattern the boot card already uses.
     3  the meter.
   The widest row is now row 1 — a closed set of strings (RANK, three digits,
   GAIN and a two-decimal multiplier) — so the plate's declared width is derived
   from content that cannot grow, and the mood word, whose vocabulary is the
   five strings in BOREDOM_BANDS, fits under it at both scales with ~5 px to
   spare. Measured: 171 px needed at 100 %, 201 at 130 %.

   THE WIDTH IS AFFINE, NOT PROPORTIONAL, and that is the difference between a
   declaration that scales and one that only looks as if it does. Two thirds of
   this plate is type and scales; the other third — 22 px of plate padding and
   the 9 px gutter — is chrome and does not. k * var(--hud-scale) therefore
   over-provisions at 130 % by exactly the chrome it double-counts, and every
   px of that over-provision comes straight out of the incident plate in the
   middle of the row, where the enemy's name is. 80px + 97px x scale is the line
   through the two measured points: 177 at 100 %, 206 at 130 %. The vw cap
   stays, because on a 568 px landscape phone the chip WOULD eat the centre
   column — but on the 844 px profile that ships it no longer binds at 130 %,
   so the scale term is live rather than decorative. */
/* ── ROW ONE HAS ONE INTERNAL GRID, NOT THREE ──────────────────────────────
   The note above '.hud-top' argues that row one must have ONE bottom edge
   because "three plates that start at the same y and end wherever their text
   runs out read as three unrelated widgets". The plate BOXES do that now — all
   three are y 8..64. Their CONTENTS did not, because each plate used a
   different vertical strategy: this one centred a three-row column, the
   incident centred a two-row grid, the register top-aligned a two-row flex. So
   the band's two dominant lines — the readouts and the meters — were scattered:
   readouts on baselines 34.00 / 43.33 / 44.33, and on the boss screen three
   meters at y 47-52, 52-57 and 54-58, a stepped stair rather than a band.
   The grid is stated once and every plate fills it: CAPTION ROW at the content
   top (13), METER at the content bottom (53-58), whatever each plate puts in
   between. 'align-items:stretch' here, 'justify-content:space-between' on the
   file column, 'align-content:space-between' on the incident; the register was
   already flush to its own content box and is the plate the other two were
   fitted to.
   The stencil opts out with 'align-self:center', and it is the one thing in the
   plate that should: it is a stamp on a document, not a row of it, and
   stretching it to 45 px would turn a 30 px classification box into a bar. */
.hud-rankchip{
  --hud-edge:var(--hud-class,var(--hud-accent));
  display:flex;align-items:stretch;gap:9px;flex:1 1 auto;
  width:min(calc(80px + 97px * var(--hud-scale)),44vw);
}
.hud-rankchip__class{
  flex:0 0 auto;align-self:center;
  font-family:${DISPLAY_FONT};font-size:var(--t-readout);line-height:1;
  color:var(--hud-class,var(--hud-accent));
  padding:3px 7px 1px;border:1px solid currentColor;
  clip-path:var(--hud-plate);--hud-chamfer:4px;
}
.hud-rankchip__file{
  flex:1 1 auto;min-width:0;
  display:flex;flex-direction:column;justify-content:space-between;gap:1px;
}
/* 'space-between' BRACKETS THE PLATE ONLY WHILE THE PLATE IS SIZED TO THIS ROW.
   The width above is derived from exactly this line — RANK, three digits, GAIN
   and a two-decimal multiplier — so in landscape the slack it distributes is
   the ~10 px of over-provision that lets a four-digit seat fit, and putting it
   between the two figures is what lands GAIN's right edge on the meter track's.
   Wherever the plate is WIDER than this row, the same declaration stops
   bracketing and starts separating: measured across the portrait plate's 268 px
   measure it opened a 162.6 px void between "RANK 388" and "GAIN ×0.62", so a
   labelled pair read as two unrelated objects. Both places the plate is wider —
   portrait, and the resting band where the file takes the incident's room —
   cap the spread instead; see the overrides. */
.hud-rankchip__seat{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0}
/* A LABELLED FIGURE: caption and number on one baseline, read as one object.
   Same construction as the invoice's value column, same name. */
.hud-rankchip__figure{display:flex;align-items:baseline;gap:5px;min-width:0}
/* The overline. 10 px, tracked, muted — the WORD is the caption and the number
   BESIDE it is the content, which is the exact inverse of how it read before.
   It sat on the row above until it started costing the mood word its last
   twelve pixels; beside the figure it captions is where a caption belongs
   anyway, and it is now the same shape as GAIN xN.NN opposite it. */
.hud-rankchip__overline{
  font-family:${DISPLAY_FONT};font-size:var(--t-micro);letter-spacing:.14em;
  color:var(--hud-ink-muted);line-height:1.1;flex:0 0 auto;
}
.hud-rankchip__rank{color:var(--hud-class,var(--hud-accent));flex:0 0 auto}

/* ---- boredom, inside the hero file ------------------------------------- */
/* The game's real progress bar. Presented as a MOOD: a word, a slow breath,
   and a fill that drains of colour rather than filling up with it. */
/* The mood word captions the meter from the line DIRECTLY above it, flush left
   over the fill's own origin. Right-aligned it did two things wrong at once: it
   competed with the RANK overline for one row (see the plate note above), and a
   right-aligned TRACKED run stops one tracking unit short of its own box,
   because CSS adds letter-spacing after the final glyph too — measured, the
   mood word, the gain and the meter track ended at three different x on the
   plate's right edge. Flush left, the trailing space falls off the end where
   nothing is aligned to it, and the whole class of error goes with the
   alignment rather than being compensated for.
   .06em rather than .14em because it is not a label — "NOTHING FEELS LIKE
   ANYTHING" is twenty-seven characters, and heavy tracking on twenty-seven
   characters costs 49 px that a 121 px band does not have to give it. The
   ellipsis stays as a backstop for a mood string longer than the five in
   BOREDOM_BANDS; measured against the longest of those it never fires. */
.hud-boredom__mood{
  font-family:${DISPLAY_FONT};font-size:var(--t-micro);
  letter-spacing:.06em;text-transform:uppercase;
  color:var(--hud-mood,var(--hud-ink-muted));line-height:1.1;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;
}
/* GAIN, not RANK. The word RANK is now on the same baseline, five pixels from
   the seat number it captions; this said "RANK ×0.83" and meant a multiplier,
   so the eye parsed the second as "rank times zero". One word, two meanings,
   20 px apart. It also carried a title tooltip, on a touch device, where no
   player will ever see it — the visible word now says what the tooltip said.
   The negative right margin is the trailing letter-space coming back: CSS adds
   letter-spacing after the FINAL glyph, so this run stopped .14em short of the
   plate's right edge while the meter track under it did not — measured at 252.0
   against a track ending at 253.67 and a content edge of 254.0. The sheet
   already compensates for the CENTRED case on three selectors with
   padding-left; this is the same correction for the right-aligned one.
   IT IS NOT THE LAST ONE, and saying it was is precisely what stopped the next
   person looking. '.hud-row__value' and '.hud-invoice__val' are both
   right-aligned tracked runs sitting directly above an UNTRACKED line inside
   the same right-aligned box — the arrangement where a 1-2.7 px rag is most
   visible, and measured at 1.00 and 2.33 px — and both shipped without it. They
   carry it now. The rule, rather than the inventory: anything 'text-align:right'
   that also declares 'letter-spacing' owes its last tracking unit back. */
.hud-boredom__mult{
  font-family:${DISPLAY_FONT};font-size:var(--t-micro);letter-spacing:.14em;
  color:var(--hud-ink-muted);white-space:nowrap;flex:0 0 auto;
  margin-right:-.14em;
}
.hud-boredom__mult[data-throttled='true']{color:var(--hud-lost)}
.hud-boredom__track{
  position:relative;height:var(--hud-meter-h);overflow:hidden;
  background:var(--hud-track);border-radius:var(--hud-radius);
}
/* 'overflow:hidden' IS THE HALF OF THE BREATH FIX THAT WAS MISSING, and without
   it the comment below described a repair the code did not make. The sweep is a
   child of this box, but this box did not clip, so 'translateX(240%)' of the
   FILL's width mapped through 'scaleX(var(--boredom))' to 2.4 × b of the
   TRACK's width — and the only thing that ever stopped it was
   '.hud-boredom__track{overflow:hidden}', i.e. the exact box the sweep was
   moved out of. Only b=0 was actually fixed, because scaleX(0) collapses the
   child; at every other reading the shimmer still crossed the grey remainder
   that means "not yet". Sampled off a device-pixel crop at --boredom:.756, the
   empty columns ran luma 92.0-94.5 with the sweep off them and 107.9-117.3 with
   it on — a ~20-level wave travelling across the last quarter of the bar, once
   per cycle, saying "indeterminate" about the part of the meter that is not
   filled. */
.hud-boredom__fill{
  position:absolute;inset:0;overflow:hidden;
  transform-origin:0 50%;transform:scaleX(var(--boredom));
  /* TWO BACKGROUNDS, and the first one is not dead code. See the note on
     .hud-ledger__fill. */
  background:var(--hud-mood,#54e08a);
  background:linear-gradient(90deg,
    color-mix(in srgb,var(--hud-mood,#54e08a) 30%,transparent),
    var(--hud-mood,#54e08a));
  will-change:transform;
}
/* BREATHE. Slows as he stops caring — 2.4 s engaged, 12 s numb — which is the
   difference between a HUD element that is alive and one that has given up.
   It lives INSIDE the fill, and the fill CLIPS it — see above. Over the track
   it played unconditionally, so at --boredom:0 the player watched a shimmer
   travel across an empty bar: the universal language for "indeterminate, still
   loading". It was animating the absence of the thing it was meant to be
   animating. */
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
/* 'flex:1 1 auto' and 'align-content:space-between' are the two halves of
   sharing row one's INTERNAL grid: grow to the row's height (see '.hud-top'),
   and then put the head on the band's caption line and the health rule in the
   band's meter line. Grid's 'align-content' is 'stretch' by default and would
   have grown the 4 px gap between the head and the health rule instead, which
   is the one place in this plate where the spacing means something.
   IT WAS 'center', AND CENTRING IS WHAT SCATTERED THE BAND. A centred head put
   the fight clock's baseline at 43.33 while the hero file's seat number sat at
   34.00 and the boss rule floated at y 47-52 against a register track at 54-58.
   Anchored, the head opens at 13 beside the seat row and the rule closes at 58
   beside the collateral track: two lines across three plates instead of five.
   WHAT IT COSTS, SAID PLAINLY: an incident with no boss has no rule to put in
   the meter line, so the plate carries ~20 px of empty paper under its head
   instead of centring it. That is the grid showing rather than a pocket — the
   band reserves a meter line whether or not this incident has one, exactly as
   the register reserves one for a collateral track the player can switch off —
   and the alternative is the head sliding 10 px down the plate the moment a
   boss appears, which is a jog inside a single scene. */
.hud-encounter{
  --hud-edge:var(--hud-tier,var(--hud-accent));
  display:grid;row-gap:4px;align-content:space-between;flex:1 1 auto;
  width:min(calc(560px * var(--hud-scale)),100%);
}
/* THE HEAD CLIPS, and the clip is on the head rather than on the plate because
   the plate's backing LEANS. .hud-panel::before is skewed 3°, so overflow on
   .hud-encounter would shave ~1.5 px off the lean at the top-right and
   bottom-left — trading a collision for a rendering fault. Clipping the head
   instead stops the overflow at the paper's own margin, one step earlier.
   What it stops: the base grid gives the middle track minmax(0,1fr), so the
   flanks hold their max-content and the incident plate is the box that
   collapses. .hud-encounter__name is the only child with min-width:0, so it
   went to clientWidth 0 first — the monster's name gone, with no ellipsis to
   say so — and then the tier stamp and the fight clock, neither of which can
   shrink, walked straight out of the plate and printed on the civilian ledger
   beside it. Measured on a 461 px-wide portrait viewport: an 83 px clock
   overlapping the ledger by 82.7 px. Type with no plate under it, landing on
   another plate.
   The breakpoint below is the real fix and covers every portrait phone. This is
   the belt: on any screen the breakpoint does not anticipate — a 568 px-wide
   landscape phone, where the band cannot go single-column without leaving the
   121 px budget — the failure is now a legible truncation inside the plate
   instead of a collision on the plate next door. */
.hud-encounter__head{display:flex;align-items:baseline;gap:8px;min-width:0;overflow:hidden}
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
/* THE FIGHT CLOCK IS NOT A READOUT, AND THE CATEGORY RULE SAID IT WAS. Its
   content is 'encounter.elapsed' — a count-up with no threshold, nothing to
   act on, and no consequence for ignoring it — and at --t-readout in full
   --hud-ink it was set LARGER than, and in the same colour as, the name of the
   thing trying to kill you. Across the landscape band that produced five 24 px
   numbers against exactly two 18 px proper nouns, and read cold the shipping
   frame delivers "¥5.42B" and "0:06" before "MOSQUITO GIRL".
   Demoted, not the name promoted: the head measures 50.45 + 8 + 199.89 + 8 +
   35.98 = 302.32 px inside a 302.33 px measure, so it is already exactly full
   and 24 px type on "Deep Sea King" would ellipsise the one string the plate
   exists to print. It keeps the .hud-readout CLASS — tabular figures and the
   display face, so the digits still do not jitter — and only the size moves.
   No TIME caption, either, and that is the trade in the right order: the
   caption+figure pattern the rest of the HUD uses costs ~30 px of head and this
   demotion only frees 9. A two-digit-colon-two-digit run is legible as a clock
   without a word over it, which is the same argument .hud-tracker__clock's
   flashing TIME label already rests on. */
.hud-encounter__clock{font-size:var(--t-title);color:var(--hud-ink);flex:0 0 auto}
.hud-encounter__clock .hud-num{font-size:inherit}
.hud-encounter__sep{opacity:.55}
/* Boss health: the plate's base rule, only the geometry the compositor can do */
.hud-boss{height:var(--hud-meter-h);overflow:hidden;background:var(--hud-track);border-radius:var(--hud-radius)}
/* display:block is not decoration. The fill is a <span>, and a non-replaced
   INLINE box is not a transformable element (CSS Transforms 1) and ignores
   height (CSS 2.1) — so without this the bar has no box, no transform, and
   paints nothing whatever --fill says. --fill:1 is the honest default the
   dead var(--fill,1) fallback could never supply: --fill is a REGISTERED
   property, so it is never guaranteed-invalid and the fallback never fires. */
.hud-boss__fill{
  --fill:1;
  display:block;height:100%;transform-origin:0 50%;transform:scaleX(var(--fill));
  /* TWO BACKGROUNDS. See the note on .hud-ledger__fill. */
  background:var(--hud-tier,var(--hud-lost));
  background:linear-gradient(90deg,var(--hud-tier,var(--hud-lost)),color-mix(in srgb,var(--hud-tier,var(--hud-lost)) 40%,#fff));
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
/* TWO ROWS, ONE RHYTHM. The cells used to be content-sized against a
   flex-start line, so the LABEL row got a uniform 12 px column gap and the
   VALUE row inherited whatever each label happened to be wider than its own
   number: measured 28.7 / 22.3 / 44.9 px between "6", "2", "9" and "¥5.42B".
   The top row read as an even printed tally and the bottom row read as three
   orphan digits and then a lump — two rhythms in one plate, which is the thing
   that stops a register reading as a register. A cell that MAY GROW is what
   fixes it, and only where there is something to grow into.
   'justify-content:space-between' is gone, and the comment that used to sit
   here claimed a behaviour this rule has never had. Measured in landscape the
   four cells are 29.5 + 23.11 + 24.11 + 58.95 = 135.67 plus three 10 px gaps =
   165.67, which is EXACTLY the plate's content width — because '.hud-top__right'
   is an auto grid column and the plate is therefore sized to this line. There
   is never any free space in landscape for space-between to distribute; in
   portrait, where the plate is full-width and there is 186 px of it,
   'flex:1 1 auto' on the cells consumes every pixel before justify-content sees
   any. Inert in both directions, on the one declaration a reader would check
   first. What the value gaps ARE a function of, honestly stated: each figure
   sits under its own label, so the gap between two figures is the column gap
   plus however much wider the left label is than its own number — 19.02 /
   22.86 / 13.63 in landscape. That is what a printed register does, and it is
   the price of putting the label on top, which is the arrangement that deleted
   the trailing-letter-space bug this plate used to have.
   The collateral track is full-bleed (flex:1 0 100%) and the last cell ends
   flush with it, which is the plate's third right edge closed.
   'align-content:space-between' is what puts that track on the band's meter
   line rather than half a pixel above it. A wrapped flex container defaults to
   'align-content:normal', i.e. stretch, so the 1 px this plate has spare inside
   row one was split between its two lines and the track landed at 52.5..57.5
   against 53..58 on the two meters beside it. Anchoring the lines to the
   plate's own edges spends that pixel between them, where nothing is aligned
   to it. Inert when the collateral ticker is switched off and the plate is one
   line.
   10 px between columns rather than 12, and the two pixels are not a taste
   change: three gaps at 130 % HUD scale is 6 px of a row that was 51 px over
   budget, and the register is the widest plate in it. Uniform is what makes a
   tally read as a tally; 12 was not load-bearing, evenness is. */
.hud-ledger{
  --hud-edge:var(--hud-saved);
  display:flex;flex-wrap:wrap;align-items:flex-start;align-content:space-between;flex:1 1 auto;
  column-gap:10px;row-gap:3px;
}
.hud-ledger[data-lost='true']{--hud-edge:var(--hud-lost)}
.hud-ledger__cell{display:flex;flex-direction:column;align-items:flex-start;gap:1px;min-width:0;flex:1 1 auto}
.hud-ledger__cell--saved .hud-ledger__value{color:var(--hud-saved)}
.hud-ledger__cell--lost .hud-ledger__value{color:var(--hud-lost)}
.hud-ledger__cell--cost .hud-ledger__value{color:var(--hud-collateral)}
/* A lost civilian is the only counter that gets to move: one STAMP, driven by
   re-adding the attribute, so it cannot be mistaken for decoration. */
.hud-ledger__cell--lost[data-bump='true'] .hud-ledger__value{animation:hud-stamp-mark .32s cubic-bezier(.2,.9,.3,1)}
.hud-ledger__witness{color:var(--hud-ink-muted)}
/* The margin is gone with the thickness: this track was 4 px with 2 px of air
   over it and the two meters beside it were 5 px hard against their content, so
   the band's meter line was three different rules at three different y. One
   gauge, one line — see --hud-meter-h. The row-gap above it is the 3 px this
   plate already spends between its own rows, which is what the 2 px margin was
   approximating. */
.hud-ledger__track{
  flex:1 0 100%;height:var(--hud-meter-h);overflow:hidden;
  background:var(--hud-track);border-radius:var(--hud-radius);
}
/* propertyDamageScore, NOT yen. Yen is unbounded and would peg this meter on
   the first serious punch of the game; the score is the compressed 0..1 field
   that exists precisely so a meter has something honest to read.
   display:block for the same reason as .hud-boss__fill — see there.
   AND THE FAR END COMES FROM THE PALETTE. It was the literal #ff4d4d, which is
   not a fallback — it is the declared right half of a meter fill, one of the
   three places this design lets semantic colour appear at all — so four of the
   five palettes could not reach it. Deuteranopia moves --hud-lost to #ffd24a
   and --hud-collateral to #e8703c precisely because red does not separate for
   that viewer, and the property-damage meter still terminated in red; High
   contrast raised every other token and this one stayed put. Mixing the
   palette's own loss colour into its own collateral colour keeps the ramp's
   meaning — this is damage heading towards loss — and makes all five live.
   The same literal appeared twice on .hud-boss__fill in FALLBACK position,
   where it is reachable (--hud-tier is unregistered and written from TS); it is
   var(--hud-lost) there now for the same reason. */
.hud-ledger__fill{
  display:block;height:100%;transform-origin:0 50%;transform:scaleX(var(--collateral));
  /* ── TWO BACKGROUNDS, AND THE FIRST ONE IS THE METER ──────────────────────
     A declaration whose value the parser does not understand is DROPPED, and
     the one before it stands. That is the whole mechanism, and it is here
     because this HUD has already shipped the other outcome twice: --fill's
     var(…, fallback) that could never fire because the property was
     registered, and the CSS counter that reads a custom property, which the
     shipping WebView rejected outright so every number on the screen printed
     0. Both were a mechanism the sheet asked for and the device declined, and
     in both cases the element painted NOTHING rather than something plainer —
     which is the one failure mode a meter must not have, because a meter at
     zero and a meter that is not there look identical.
     color-mix() is Chrome 111 / Safari 16.2. That is most devices and not all
     of them, and on the ones it is not, this single declaration is the
     difference between a graded bar and no bar. The flat colour is the same
     token the gradient starts from, so where color-mix does work nothing about
     this rule changes; where it does not, the meter reads. Three lines for a
     class of bug this file has been bitten by twice.
     __tests__/styles.test.ts enforces the pair, so a fourth meter written with
     a bare color-mix background fails on the day it is written. */
  background:var(--hud-collateral);
  background:linear-gradient(90deg,var(--hud-collateral),color-mix(in srgb,var(--hud-collateral) 45%,var(--hud-lost)));
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
   what this whole language is generalised from.

   AND THERE IS NO LEADER ACROSS THE GAP ANY MORE. There were two attempts. The
   first was a hairline spanning the whole grid row, so what you actually SAW of
   it was whatever gap the pinned quest's title happened to leave — 196 px on
   the shipping phone, 635 px on a tablet, nothing at all if the title ran long
   — an element whose length is set by a string, and at 635 px the single
   longest graphic in the HUD, carrying nothing. The second was a 20x1 px tick
   terminating one 6 px gutter short of the button. Both are gone, and the tick
   is the one worth explaining, because it looked like a fix.
   It was painted in --hud-line, rgba(255,255,255,.14) — a wash designed to sit
   on a near-black plate — and this is the only ink in the HUD besides the world
   markers with no plate under it. Sampled off the committed dusk shot at device
   (2250,276) against the sky 14 px below it, it measures 1.54:1. Composite the
   same 14 % white over the daylight sky this game actually ships (the header of
   this file, and src/game/game.ts's rgb(143,169,196) fallback) and it is
   1.15:1; over a lit facade or a bright cloud, 1.01:1. That is not a faint
   line, it is no line. So in the shipping condition the player saw nothing, and
   at dusk they saw a detached 20 px dash floating in the sky six pixels from a
   button — a rendering artefact, not a leader. A leader that stops short of its
   destination and disappears on bright backgrounds is not leading anything.
   What it cost the player to delete: nothing they can name. The LOG button's
   own 3 px ink rule already terminates that end of the row, and it is the only
   thing there that has to be found. The gap it used to cross now shows the city,
   which is the same argument the plate beside it already makes for being sized
   to its content rather than spanning the band. */
.hud-tracker{
  grid-area:2 / 1 / auto / -1;
  --hud-edge:var(--hud-accent);
  display:flex;align-items:stretch;justify-content:space-between;
  gap:6px;min-height:${MIN_TAP_PX}px;
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
/* A SQUARE, AND THE SAME SQUARE AS THE PAUSE CHIP DIRECTLY ABOVE IT. The strip
   is 'align-items:stretch', so in portrait — where the strip is two lines tall —
   this button became a 44x65.19 box hanging under a 44x44 one: a square above a
   1:1.48 rectangle in a column of two, which is the arrangement that stops two
   controls reading as a pair. 'align-self:start' opts it out of the stretch and
   the two share one token, so they cannot drift when HUD scale moves either.
   The padding carries TWO corrections and both are one tracking unit of
   something. '.06em' is the trailing letter-space CSS adds after the final
   glyph, which pulls a centred tracked run half a unit left of its own axis.
   'var(--hud-rule)' is the 3 px ink rule painted INSIDE this box: 'place-items:
   center' computes its centre from the layout box (766..810, centre 788.0) when
   the field the player can actually read starts at 769 (centre 789.5). Measured
   off the shipping frame the LOG label inked 781.00..795.33 — 12.00 px of clear
   space on the left against 14.67 on the right, 2.67 px of asymmetry on a 44 px
   control, i.e. 6 % of its width. The trailing-space correction was already
   right, which is how you can tell the rule was simply never counted. */
.hud-tracker__open{
  flex:0 0 auto;align-self:start;
  width:var(--hud-pause-size);height:var(--hud-pause-size);
  padding:0 0 0 calc(var(--hud-rule) + .06em);
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
/* THE MARKER IS A COLUMN, so the objectives inside one card share a left edge.
   Content-sized it is 7.00 px for a bullet, 10.91 for a tick, 21.00 for "6/9"
   and 29.00 for "0/40" — so the SENTENCES in a single four-line quest card
   started at up to three different x. Measured in the log: card 0 ran 161.80
   and 171.89, card 4 ran 188.67 and 166.67 — a 22 px step in the middle of one
   card, on the screen a player opens specifically to read objectives. Same
   failure as the tier stamp one level up, and the same fix.
   30 px measures "0/40" at --t-body, which is the widest marker the quest model
   can produce with a two-digit requirement; the affine term is var(--hud-scale)
   rather than an em because the column has to hold GLYPHS and they scale, while
   an em column would over-provision out of the objective's own reading width.
   RIGHT-ALIGNED, and that is the half that makes it a column rather than a
   reserve: the counts then read DOWN the card as a tally — 6/9 over 1/4 over
   0/40, units under units — instead of as four unrelated tokens each stuck to
   the front of its own sentence. */
.hud-tracker__count{
  min-width:calc(30px * var(--hud-scale));text-align:right;
  font-variant-numeric:tabular-nums;color:var(--hud-ink);flex:0 0 auto;
}
.hud-tracker__plate .hud-tracker__obj{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hud-tracker__what{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.hud-tracker__clock{display:flex;align-items:baseline;gap:2px;flex:0 0 auto}
/* PULSE. A hard flash, never a fade — a fade reads as a rendering artefact.
   ON THE WORD, NOT ON THE NUMBER, and that is the whole of the fix. The flash
   used to be on .hud-tracker__clock, which is the box holding the digits, and
   hud-pulse spends 39 % of every second at opacity .35. questUrgency turns
   critical below 45 s, so this was up to forty-five continuous seconds of the
   most time-critical number on the HUD being unreadable two frames in five —
   at exactly the moment it matters most, and with a ~2-in-5 chance that any
   given glance lands on a frame the player cannot read. Measured in the dim
   phase, no pixel of the readout exceeded 2.48:1 against the plate and the red
   digits themselves composited to 1.65:1, against 6.17:1 in the bright phase.
   Both phases are in the committed evidence, which is how you can tell nobody
   chose it: the identical crop reads bright in hud-combat-phone-landscape.png
   and dim in hud-idle-phone-landscape.png.
   The alarm is kept and the number is not blinded, because the urgency was
   already being carried twice without the keyframe — the digits go
   var(--hud-lost) below, and the whole strip's ink rule goes red at
   [data-urgency='critical'] above. The flash now lives on the TIME caption,
   whose disappearance costs nothing at all: a two-digit-colon-two-digit run in
   the alarm colour is legible as a clock without a word over it. Same keyframe,
   same duty cycle, same alarm in the corner of the eye, and the readout stays
   at opacity 1.
   The keyframe is shared with the alert's classification stamp and is left
   exactly as it was, so no committed bulletin shot moves. That stamp flashes
   THREE times and stops; this one never stopped. */
.hud-tracker[data-urgency='critical'] .hud-tracker__clock{color:var(--hud-lost)}
.hud-tracker[data-urgency='critical'] .hud-tracker__clock .hud-label{
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
   CENTRED IN THE CORRIDOR, not at left:50% and not in the safe box either.
   Those are three different axes. left:50% was 12.5 px off the safe box on any
   single-notch device; the safe box in turn is 7.5 px off the corridor, because
   the two hands do not claim the same width — the stick reserve is 225 px and
   the thumb reserve 240. So the box is laid out inside the SAFE box, where it
   can never overflow an inset whatever the viewport does, and then slid by half
   the difference between the two reserves. That expression is also the ONLY
   thing that made [data-stick-hand='right'] mean anything: the swap trades the
   two reserves, and the old width formula subtracted BOTH of them, so their sum
   — and therefore every pixel of the result — was invariant under it. A rule
   that reads as handedness support now moves the arc 15 px when the hand
   changes. 'translate' rather than a term in 'transform', because 'transform'
   here is the entry animation and is transitioned; this offset is static.

   THE WIDTH HAS A FLOOR, and that floor is the difference between an arc and
   nothing at all. The corridor term goes NEGATIVE on any viewport narrower than
   8 + 8 + 225 + 240 = 481 px — which is every phone held in portrait, where the
   two quarter-discs overlap and there is no corridor between the hands to
   measure. min() took the negative branch, 'width' clamped it to 0, and the SVG
   track, the intent ring, the intent word and the yen forecast all collapsed;
   the two absolutely-positioned labels then overflowed the 0-width box and
   printed across the JUMP button. max() with a legible floor is what stops a
   corridor that does not exist from deleting the panel. The portrait block
   below drops the corridor term entirely rather than flooring it, because on
   that shape of screen the honest statement is that the arc clears the hands
   VERTICALLY — see --hud-arc-lift there.
   THE FLOOR IS THE LABEL'S CORRIDOR, not a round number, and the difference is
   what the panel does when the corridor is merely NARROW rather than absent.
   120px was picked as "legible"; the thing that actually needs width here is
   .hud-charge__label's own corridor between the arc's two legs, which the rule
   below derives as 2 x .57 x the box height, i.e. 1.14 x --hud-arc-h x scale —
   98px on this profile. Below that the label box is WIDER than the panel, and
   .hud-charge does not clip, so the intent word starts painting outside the
   gauge and into the hands: the exact failure the corridor is measured to
   avoid, reached from inside. At the floor the word exactly fits and nothing
   leaves the box.
   ON A 568x320 LANDSCAPE PHONE THE FLOOR STILL COSTS SOMETHING, and it is
   worth writing down rather than leaving to the next person to measure. The
   corridor there is 87px against a 98px floor, so the gauge overhangs 5.5px
   into each disc. It cannot be fixed by widening or narrowing anything: on a
   320px-tall landscape screen the two reserves are 225 and 240 and the top band
   alone runs 114px, so the BAND is already inside the hands and there is no
   rectangle left that clears them. That is a statement about the minimum
   viewport this HUD is designed for — 390px of height, per the arithmetic at
   the top of this file — not about the arc. */
.hud-charge{
  position:absolute;
  left:var(--hud-sa-l);right:var(--hud-sa-r);
  bottom:calc(var(--hud-sa-b) + var(--hud-arc-lift));
  width:min(calc(var(--hud-arc-w) * var(--hud-scale)),max(calc(var(--hud-arc-h) * var(--hud-scale) * 1.14),calc(100vw - var(--hud-sa-l) - var(--hud-sa-r) - var(--hud-reserve-l) - var(--hud-reserve-r))));
  height:calc(var(--hud-arc-h) * var(--hud-scale));margin:0 auto;
  translate:calc((var(--hud-reserve-l) - var(--hud-reserve-r)) / 2) 0;
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
  stroke-dashoffset:calc(var(--hud-arc-len,239) * (1 - var(--charge)));
}
.hud-charge__tick{stroke:rgba(255,255,255,.55);stroke-width:2}
/* The intent word is GENERATED CONTENT from a custom property, for the same
   reason the timer digits are: it changes while the player is holding the
   button, and a text-node swap is not allowed on that path.

   THE ONLY TWO STRINGS IN THIS HUD PAINTED STRAIGHT ONTO THE WORLD, and until
   now the only two with neither a plate under them nor a shadow behind them.
   '.hud-marker' — the other type with no plate — has carried
   'text-shadow:0 1px 3px rgba(0,0,0,.95)' for exactly this reason, and the
   '.hud-pausebtn' note below already makes the argument against the alternative:
   an unshadowed glyph over a lit facade measures about 1.2:1. Measured here,
   the intent word is 6.15:1 against the darkest road and 3.01:1 against the
   road stripe that crosses the same band — under the 3:1 floor for 18 px
   non-bold type, on the one word that says how much of the neighbourhood is
   about to be a hole. The shadow is the cheapest thing that fixes it and it
   costs no layout.

   AND THE WORD IS CONSTRAINED TO THE GAUGE'S OWN CORRIDOR. It used to be
   left:0;right:0 across the whole box, with no max-width and no nowrap — and
   the arc's two legs come DOWN through the left and right of that same box at
   the label's height. "NO RESTRAINT" cleared the stroke by under 3 px purely
   because that string happens to be the width it is; one more character, or a
   localised intent word, lands on the stroke, in the stroke's own colour.
   50% ± .57 × the box height is that corridor derived rather than eyeballed:
   the 148x100 viewBox is letterboxed to the box's HEIGHT, so the drawing scale
   is that height / 100, and the inner edge of either leg sits 57 viewBox units
   from the centre over the label's band. Expressed against 50% rather than
   against the box's own edges, it stays true when the box is wider than the
   drawing, which it is whenever the corridor cap does not bind.
   AND THE BOX HEIGHT NOW SCALES, which it did not: the width carried
   var(--hud-scale) and the height did not, so at 130 % HUD scale the box got
   wider, the SVG letterboxed to an unchanged 86 px, and the gauge stayed the
   size it is at 100 % while the intent word inside it grew by a third. The
   corridor stayed 98 px while "NO RESTRAINT" grew to 115 and would have
   ellipsised inside its own gauge. A gauge is furniture for the type in it; it
   scales with the type. The alert stack hangs off this box and takes the same
   term so the bulletin still clears the arc it sits on. */
.hud-charge__label{
  position:absolute;bottom:15px;text-align:center;
  left:calc(50% - var(--hud-arc-h) * var(--hud-scale) * .57);right:calc(50% - var(--hud-arc-h) * var(--hud-scale) * .57);
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;
  padding-left:.06em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--hud-intent,var(--hud-commit));
  text-shadow:0 1px 3px rgba(0,0,0,.95);
}
.hud-charge__label::after{content:var(--hud-intent-label,'NORMAL')}
.hud-charge__cost{
  position:absolute;left:0;right:0;bottom:0;text-align:center;
  font-size:var(--t-micro);letter-spacing:.14em;padding-left:.14em;
  color:var(--hud-collateral);
  text-shadow:0 1px 3px rgba(0,0,0,.95);
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
/* IT SHARES ROW ONE'S BOTTOM EDGE, which is what finally closes the gap to the
   LOG button under it. The history is worth keeping because each step was right
   about the previous one and wrong about the number.
   Top-aligned it closed at y=52 in a row that closes at 64, orphaning itself
   18 px above the LOG button in a band whose every other gap is 6 px. CENTRED
   on --hud-band-row it closed at 58 and the gap became 12 — still twice the
   band's own gap, and worse at HUD scale, because the button's height did not
   scale while the row's did: measured at 130 % the gap opened to 17.25 px while
   the band gap stayed 6. --hud-pause-size is affine now (see the token), and
   BOTTOM-anchoring is the other half: the button's last pixel is row one's last
   pixel, so the gap to the LOG button is exactly --hud-gap at every rung, by
   construction rather than by arithmetic that happens to come out.
   The row's declared height is measured from the top INSET while the band
   starts at the edge floor, hence subtracting --hud-sa-t back out. max(0px,…)
   is a floor, not a preference: in portrait the inset is 59 px and the budget
   is smaller than it, so the unclamped expression would lift the only escape
   hatch in the game under the Dynamic Island. In portrait it therefore hangs
   from the inset, 15 px above the LOG button rather than 6, because there row
   one's height is the hero file's own content (53 px) and nothing in CSS
   publishes that. That is the one rung of this that is still arithmetic.
   THE PADDING IS THE INK RULE. 'place-items:center' centres the glyph on the
   layout box (766..810, centre 788.0), but 3 px of that box is the solid rule,
   so the readable field is 769..810 and its centre is 789.5. Measured off the
   shipping frame the two pause bars inked 777.33..783.67 and 792.33..798.67:
   8.33 px of clear space inside the rule against 11.33 px to the right edge,
   3.00 px of lean into the rule on a 44 px control. There is no trailing
   letter-space to cancel here — letter-spacing is 0 on a two-glyph symbol — so
   the rule is the whole correction. */
.hud-pausebtn{
  position:absolute;right:var(--hud-sa-r);
  top:calc(var(--hud-sa-t) + max(0px,var(--hud-band-row) - var(--hud-sa-t) - var(--hud-pause-size)));
  --hud-edge:var(--hud-accent);--hud-chamfer:7px;
  width:var(--hud-pause-size);height:var(--hud-pause-size);
  min-width:var(--hud-pause-size);min-height:var(--hud-pause-size);
  padding:0 0 0 var(--hud-rule);display:grid;place-items:center;
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
   it wipes the shape rather than a rectangle around it.

   THE RESTING STATE IS DECLARED, and that is the whole rule rather than a
   tidy-up. This is the only animated rule in the sheet whose resting state
   differed from where its keyframes leave it: the hatch got its invisibility
   ONLY from 'hud-sweep' ending at opacity 0, so 'animation:none' — which is
   what [data-reduced-motion='true'] and 'prefers-reduced-motion' both do,
   further down this file — left the specified style standing: opacity 1,
   transform none. A 1-in-7 px hatch in the alert's own colour, at full
   strength, unskewed so it did not even follow the plate's lean, painted for
   ever across a bulletin whose entire job is to be read in under a second. It
   landed on exactly the players who asked for less motion, and no shot in
   docs/screenshots covers that state, so nothing caught it. 'hud-sweep''s 0 %
   frame sets opacity .42, so the animated appearance is bit-identical.

   AND IT SITS UNDER THE TYPE. '::after' is a positioned descendant with
   z-index:auto inside the stacking context '.hud-panel{contain:layout style}'
   creates, so it painted ABOVE the in-flow headline — in the same hue as the
   glyphs, which makes letterforms and hatch indistinguishable for the 340 ms
   it crosses them. z-index:-1 puts it in the same negative layer as the plate
   backing and later in tree order than it, so the sweep wipes the PLATE and
   the words stay on top of it. */
.hud-alert::after{
  content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;
  background:repeating-linear-gradient(100deg,var(--hud-alert-color,var(--hud-accent)) 0 1px,transparent 1px 7px);
  clip-path:var(--hud-plate);
  transform-origin:0 50%;
  opacity:0;transform:skewX(var(--hud-skew)) scaleX(1);
  animation:hud-sweep .34s cubic-bezier(.2,.9,.3,1) forwards;
}
/* THE STAMP IS A COLUMN, so the stack has ONE text edge.
   A content-width chip in a baseline flex row makes the headline's x origin a
   function of how many letters the tier word happens to have, and an untiered
   bulletin had no chip and no 9 px gap at all, so its headline started a whole
   stamp further left. The plates are align-items:stretch and line up to the
   pixel; the words inside them did not. Constructed on a tablet at 130 % — GOD,
   DRAGON, and an untiered quest notice — three flush 442 px plates gave three
   headlines three different measures, the widest rag being the missing stamp
   entirely at roughly 60 px. This file already names that failure at half the
   size: "two objects stacked in one rectangle, centred on two different axes
   7.5 px apart, is the misalignment nobody can name and everybody sees."
   The column is measured, not guessed: DRAGON is the longest word in
   TIER_LABEL and DANGER the longest in the kind stamps in alerts.ts, and both
   render 50.5 px wide at 100 % — glyphs at --t-body inside the chip's 14 px of
   chrome — so 56 px is the two of them plus 2.75 px of air on each side. The
   affine term is
   var(--hud-scale) rather than an em because the chrome does not scale and the
   type does; an em-based column over-provisions at 130 % out of the bulletin's
   own reading width.
   The other half of this lives in alerts.ts, which now emits a stamp for EVERY
   bulletin — the kind word where there is no tier — rather than reserving an
   empty outlined box. A blank stamp is a missing element; a filed notice that
   says what kind of notice it is, is what the Association would print. */
.hud-alert__chip{
  color:var(--hud-alert-color,var(--hud-accent));align-self:center;
  min-width:calc(56px * var(--hud-scale));text-align:center;
}
.hud-alert__main{min-width:0;display:flex;flex-direction:column;gap:1px}
/* NO 'text-overflow:ellipsis', BECAUSE IT NEVER FIRED. 'text-overflow' applies
   to content that overflows its line box in the INLINE direction; content that
   wraps does not overflow, and both of these compute to 'white-space:normal'.
   So the declaration did nothing except tell the next reader these were
   single-line clipped strings when they are multi-line and complete — which
   matters here more than anywhere, because the '.hud-alert__chip' fixed-
   column argument is about the bulletin stack having ONE text edge, and a
   headline that silently becomes two lines is the other half of that geometry.
   Wrapping is the right answer rather than 'white-space:nowrap': the stack is
   bottom-anchored in landscape with 78 px of measured headroom at 130 % HUD
   scale, so a second line grows upward into empty sky, and a bulletin that
   loses its last three words to an ellipsis has lost the notice. 'overflow:
   hidden' stays as the backstop for an unbreakable string — a URL, an
   untranslated identifier — which is the only case that can still overflow. */
.hud-alert__title{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;
  color:var(--hud-alert-color,var(--hud-accent));line-height:1.15;
  min-width:0;overflow:hidden;
}
.hud-alert__body{
  font-size:var(--t-body);color:var(--hud-ink-muted);line-height:1.3;
  min-width:0;overflow:hidden;
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
/* CSS adds letter-spacing after the FINAL glyph too, so a CENTRED tracked run
   sits half a tracking unit left of the thing it is centred under — measured at
   2.00 px on the old boot title. A padding-left equal to the tracking puts the
   ink back on the axis exactly, and under a projected map pin that axis is the
   pin. Same fix on the charge arc's two centred lines. */
/* EVERY MARKER GETS A PLATE, and this is the one place in the HUD where that
   was not already true. A pin is the only "where do I go" element the game has
   and the only type painted straight onto the world with nothing behind it; its
   whole protection was text-shadow:0 1px 3px rgba(0,0,0,.95), and a shadow
   cannot buy contrast when the background is BRIGHTER than the ink. Under 10 px
   type a 3 px shadow is a smear, not a backing.
   harness/hud.html renders a dusk street, so every committed marker shot
   flatters this and nothing had ever measured the condition the game actually
   ships: the header of this file says the shipping game is DAYTIME and
   src/game/game.ts confirms it with a rgb(143,169,196) sky fallback. Rendered
   over exactly that sky and read out of the raw pixels, the four pin colours
   measure 1.63:1 (ROUTE 7 TUNNEL, the objective yellow), 1.43:1 (CIVILIAN),
   1.81:1 (the errand cyan) and 1.09:1 for every "NN M" distance run — the
   muted ink is the same luminance as the sky. There is no shadow alpha that
   fixes that; the measured one is already at .95 and buys about six levels.
   On the plate the same four measure 13.49, 11.86, 14.99 and 7.59:1.
   The plate is the sheet's own idiom rather than a new one: --hud-panel over
   --hud-surface, the same double declaration .hud-sheet uses to guarantee
   opacity, so all five palettes compose it from their OWN surface value instead
   of a literal. --hud-chamfer:4px because a 9 px cut on a box this small eats
   the glyphs; it is the same 4 px the classification stamp uses.
   The padding is written long-hand because both runs carry a padding-left of
   one tracking unit — CSS adds letter-spacing after the final glyph, so a
   CENTRED tracked run sits half a unit left of the axis it is centred on, and
   under a projected pin that axis IS the pin. A plain 'padding:1px 5px' would
   have silently deleted that correction. */
.hud-marker__label{
  font-size:var(--t-micro);
  padding:1px 5px 1px calc(5px + .14em);
  color:var(--hud-marker-color,var(--hud-accent));
  background:var(--hud-panel);background-color:var(--hud-surface);
  clip-path:var(--hud-plate);--hud-chamfer:4px;
}
.hud-marker__dist{
  font-size:var(--t-micro);letter-spacing:.14em;
  padding:1px 5px 1px calc(5px + .14em);
  color:var(--hud-ink-muted);
  background:var(--hud-panel);background-color:var(--hud-surface);
  clip-path:var(--hud-plate);--hud-chamfer:4px;
}
.hud-marker[data-far='true'] .hud-marker__label{display:none}

/* ========================================================================== */
/* Screens                                                                    */
/* ========================================================================== */
/* A SCREEN DOES NOT ANIMATE IN, and that is a deliberate subtraction rather
   than an omission. There are three motion verbs in this HUD — stamp, breathe,
   pulse — and a 160 ms cross-fade of an entire modal was a fourth: it said
   nothing the scrim does not say instantly, it delayed the only escape hatch in
   the game by a tenth of a second, and it cost this project something concrete.
   Every modal shot in docs/screenshots was taken two frames after the screen
   opened, which is 33 ms into that fade, so every piece of committed evidence
   for the pause menu, the invoice and the settings sheet was a 20 %-opaque
   ghost with the city legible through it. Nobody could review those screens
   because nobody could see them.
   Stamping the sheet instead is not available: STAMP scales from 1.06, and a
   sheet already 751 px wide inside a 751 px safe box would spend 120 ms
   overflowing the notch. */
.hud-screen{
  position:absolute;inset:0;display:flex;pointer-events:auto;
  background:radial-gradient(120% 90% at 50% 0%,rgba(4,6,11,.80),rgba(2,3,6,.94));
  padding:calc(var(--hud-sa-t) + 10px) calc(var(--hud-sa-r) + 10px)
          calc(var(--hud-sa-b) + 10px) calc(var(--hud-sa-l) + 10px);
}
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
/* THE FOLD HAS TO SAY IT IS A FOLD. overflow-y:auto inside a sheet that is
   overflow:hidden and clipped to a chamfered polygon produces a knife-edge
   cut with nothing to indicate that anything is under it — and mobile WebViews
   only paint an overlay scrollbar WHILE a finger is moving, so on the shipping
   844x390 profile the player sees a numeral sawn in half and no reason to think
   the sheet scrolls. Measured there, every reading sheet hides most of itself:
   quests 232 of 601, rank 232 of 623, results 232 of 574, settings 232 of 851.
   The results screen's payoff — "Hero points awarded" — sits 264 px below a
   232 px fold.
   SIX LAYERS, TWO PAIRS, NO JAVASCRIPT AND NO LAYOUT READ. The last two are
   the fold bands and are attached to the SCROLL PORT, so they stay at the top
   and bottom of the window whatever the content does. The first four are
   attached LOCAL — they scroll with the content — and are painted in the
   panel's own surface, so they cover a fold band exactly when the content is
   against that end. The band therefore appears only when there is something
   past it, which is the whole point: a permanent gradient at both ends is a
   decoration that lies at the top of a short list.
   THE BAND IS LIT, NOT SHADOWED, and that is measurement rather than
   preference. A drop shadow is the reflex, and the reflex is wrong here: the
   composed sheet reads at luma 9.9 out of 255, so 55 % black over it lands at
   4.4 — a five-level move on a surface nobody can see five levels of. The same
   7 % of WHITE lands at 27, a seventeen-level move, and reads as the lip the
   next row is disappearing under. It is also the sheet's own idiom: every
   structural wash in this file (--hud-line, --hud-track, --hud-halftone) is
   white at low alpha over near-black.
   The covers are the surface laid down TWICE for the same reason --hud-panel
   lays it down three times: one 82 % layer leaves 18 % of the band standing,
   which is a visible seam at rest; two compose to 96.7 % and leave half a
   level. They are flat rather than fading, and exactly as tall as the band, so
   the two edges end together and neither shows.
   AND THE BAND HAS AUTHORITY NOW. The mechanism was right and the value was
   not: .07 over a composed sheet reading luma 9.9 lands at 27, a
   seventeen-level ramp under a headline that reads 202 — a signal seven times
   dimmer than the cut it is explaining. Sampled straight down the quest log it
   ramped 14 → 29 over 13.3 CSS px and then the row it was explaining was sawn
   through its cap height with no fade, no scrollbar and no count. Against what
   it is hiding — 232 of 601 px in the quest log, 232 of 851 in Settings, where
   HUD SCALE, the accessibility control, is below the fold — that is not a
   trade, it is a decoration.
   .16 lands at 49, a thirty-nine-level move, which reads as the lip the next
   row is going under; 22 px rather than 14 because at 14 the ramp was shorter
   than the cap height of the type crossing it, so it read as a soft edge on one
   glyph rather than as a fold under a row. It costs no extra layer, no
   JavaScript and no layout read: the four covers are resized to match so the
   two edges still end together, and the band still appears only when there is
   something past it. */
.hud-sheet__body{
  flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;
  padding:12px 16px;-webkit-overflow-scrolling:touch;touch-action:pan-y;
  background:
    linear-gradient(var(--hud-surface),var(--hud-surface)) 0 0 / 100% 22px no-repeat,
    linear-gradient(var(--hud-surface),var(--hud-surface)) 0 0 / 100% 22px no-repeat,
    linear-gradient(var(--hud-surface),var(--hud-surface)) 0 100% / 100% 22px no-repeat,
    linear-gradient(var(--hud-surface),var(--hud-surface)) 0 100% / 100% 22px no-repeat,
    linear-gradient(rgba(255,255,255,.16),transparent) 0 0 / 100% 22px no-repeat,
    linear-gradient(transparent,rgba(255,255,255,.16)) 0 100% / 100% 22px no-repeat;
  background-attachment:local,local,local,local,scroll,scroll;
}
.hud-sheet__foot{
  display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;
  padding:10px 16px;border-top:1px solid var(--hud-line);flex:0 0 auto;
}

/* Spacing goes on the TOP of a section, not the bottom, so a section is
   separated from whatever precedes it — including the rank board's assessment
   note, which is not a section and used to butt straight into "THE LADDER". */
.hud-section{margin:14px 0 0}
.hud-section:first-child{margin-top:0}
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
/* THE STAMP IS A COLUMN HERE TOO, and this is the screen where it matters most.
   '.hud-alert__chip' was given a fixed column for exactly this reason and its
   comment names the failure — "a content-width chip in a baseline flex row
   makes the headline's x origin a function of how many letters the tier word
   happens to have" — but the fix landed on the stack that shows ONE bulletin
   and not on the two screens that stack six and seven of these rows. Measured
   in the log, the card titles started at 143.89 / 156.45 / 143.89 / 138.11 /
   152.67 / 147.67: an 18.34 px rag down a list whose left edge the eye is
   tracking. The rank ladder had the same bug at 5.78 px.
   Same 56 px column, same derivation: DRAGON is the longest word in TIER_LABEL
   and DANGER the longest kind stamp in alerts.ts, both 50.5 px at 100 %, so
   56 px is the two of them plus 2.75 px of air a side. The ladder's stencils —
   S-16, B-1, C-1 — are shorter and centre inside it.
   Scoped to '.hud-row' rather than put on '.hud-chip' itself, because the
   incident plate's tier stamp is the one chip that must stay content-sized: it
   shares a 302 px measure with the monster's name and 6 px of reserve there
   comes straight out of the name. */
.hud-row .hud-chip{min-width:calc(56px * var(--hud-scale));text-align:center}
/* And the rows that carry NO stamp get the column as an indent, so the two
   sections of the rank board share one text edge. The assessment feed has no
   classification to print — a movement is not a hero — and it started 41 px
   left of the ladder above it, which the fixed column would have widened to 66.
   The reserve is the column plus this row's own gap, from the same expression,
   so the two cannot drift. */
.hud-row > .hud-row__main:first-child{margin-left:calc(56px * var(--hud-scale) + 10px)}
/* Edge and ink, not a wash. A 10 %-accent background on the selected row was
   the same tinted-panel move the primary button was making, and it made the
   row's own text harder to read to say something a 3 px rule says louder. */
.hud-row[data-selected='true']{box-shadow:inset var(--hud-rule) 0 0 0 var(--hud-accent)}
.hud-row[data-selected='true'] .hud-row__title{color:var(--hud-accent)}
.hud-row__main{flex:1 1 auto;min-width:0}
/* Wraps, and says so — see the note on '.hud-alert__title'. 'text-overflow'
   cannot fire on content that wraps, so the ellipsis here was describing a
   single-line clipped title that has never existed. A reading screen is the
   last place to truncate a request's name. */
.hud-row__title{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;line-height:1.15;
  overflow:hidden;
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
/* The trailing letter-space, given back. This run is right-aligned and tracked
   and sits directly over an untracked '.hud-row__meta' in the same right-
   aligned box, so the .06em CSS adds after the final glyph landed INSIDE the
   alignment and the clock stopped short of the line under it: measured
   "0:38" inking to 771.33 over "90 pts" at 770.33, and "6:51" to 770.67 over
   "no points" at 768.00. Same correction as '.hud-boredom__mult'. */
.hud-row__value{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;
  font-variant-numeric:tabular-nums;text-align:right;flex:0 0 auto;
  margin-right:-.06em;
}

/* ---- rank board -------------------------------------------------------- */
.hud-standing{display:flex;align-items:flex-end;gap:14px;margin-bottom:12px}
/* The same round-cap overshoot the boot title carries, and it IS needed here —
   checked rather than assumed. This is the sheet's other --t-hero run opening
   on a round C, and it sits on the body's left measure with two flat-sided runs
   directly under it: measured off the shipping frame its ink opened at 86.33
   against the "T" of THE LADDER at 85.00 and the "A" of the assessment note at
   85.33, so the largest type on the screen was the one that read as indented.
   PAID BACK ON THE RIGHT, which the boot title does not need to do: that one
   heads a stack and has nothing beside it, while this one is the first item in
   a flex row, so an uncompensated negative margin would drag the hero name and
   its progress bar 1.32 px left with it. An optical correction should move ink,
   not layout. The 1.32 px lands in a 14 px gap next to a flat "8". */
.hud-standing__rank{
  font-family:${DISPLAY_FONT};font-size:var(--t-hero);line-height:.82;letter-spacing:.06em;
  color:var(--hud-class,var(--hud-accent));
  margin-left:-.03em;margin-right:.03em;
}
.hud-standing__meta{flex:1 1 auto;min-width:0}
.hud-standing__bar{height:var(--hud-meter-h);background:var(--hud-track);border-radius:var(--hud-radius);overflow:hidden;margin-top:6px}
.hud-standing__bar::after{
  content:'';display:block;height:100%;background:var(--hud-accent);
  transform-origin:0 50%;transform:scaleX(var(--fill));
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
/* SOLID, like every other rule in the sheet system. This was the only dashed
   line in the HUD — '.hud-sheet__head', '.hud-section__title',
   '.hud-sheet__foot' and '.hud-btn::before' are all '1px solid var(--hud-line)'
   — and a dashed leader is a spreadsheet idiom, not an Association form's. One
   institution, one stationery. */
.hud-invoice__line{
  display:flex;align-items:baseline;gap:10px;padding:5px 0;
  border-bottom:1px solid var(--hud-line);
}
.hud-invoice__line:last-child{border-bottom:none}
.hud-invoice__key{flex:1 1 auto;color:var(--hud-ink-muted);font-size:var(--t-body)}
/* The trailing letter-space, given back — same correction as
   '.hud-row__value', and needed for the same reason: a right-aligned tracked
   figure sitting directly over its own untracked sub-line. Measured against a
   column edge at 738.5, "0" inked to 737.00 while "Nobody saw it…" reached
   734.67. The total row re-states it at its own tracking below; a flat .06em
   there would over-correct by 1.2 px, because that row is .01em at 24 px. */
.hud-invoice__val{
  font-family:${DISPLAY_FONT};font-size:var(--t-title);letter-spacing:.06em;
  margin-right:-.06em;
}
/* THE UNIT IS A CAPTION, NOT PART OF THE FIGURE. '.hud-invoice__val' is Bebas,
   which has no lowercase, so formatDuration's "1.4s" printed as "1.4S" and
   "1 of 1" as "1 OF 1" — the unit and the connective riding at figure size, in
   figure colour, with figure tracking, in a face where S and 5 are a glance
   apart. Everywhere else in this HUD a unit is a --t-micro muted caption beside
   its number (RANK 388, TIME 0:38, SAVED 6, 62% BAKING RADIANCE PROBES), which
   is the construction that makes those read as labelled figures at all.
   'results.ts' splits the unit out into a '.hud-label' span now; this rule only
   supplies the space between them, and 3 px is one word-space at --t-micro
   rather than a flex gap, so the unit still belongs to the number rather than
   being placed beside it.
   The second rule is the trailing-letter-space correction again, on the LAST
   unit only — a row like "Force committed" carries two labelled figures, and
   pulling the middle one leftward would tighten a separator instead of an
   edge. It composes with the figure's own -.06em to 1.68 px against the
   1.40 px owed, so a row ending in a unit overhangs its column by 0.28 px
   rather than falling 1.40 px short of it: a third of a device pixel at dpr3,
   and the last of this class of error on the sheet. */
.hud-invoice__unit{margin-left:3px}
.hud-invoice__unit:last-child{margin-right:-.06em}
/* THE VALUE COLUMN, and it is a column. Every row is a flex line with the key
   growing on the left and, on the right, a box holding the figure over its
   sub-line. That box had no CSS at all, so the figure sat LEFT-aligned inside a
   width set by the (usually wider) caption beneath it, and floated to wherever
   that caption happened to end: measured on the shipping profile against a
   column edge at x=738.5, "Witnesses 0" landed at 404.6 — 334 px adrift, mid-
   row, reading as though the 0 belonged to the label rather than to the ledger
   — with the property-damage yen 100 px out and the awarded hero points 174 px
   out. Those are the two largest figures in the game. On a screen dressed as a
   printed invoice the number column is the one thing that has to align.
   .hud-invoice__sub's existing text-align:right now agrees with the box
   around it instead of fighting it. */
.hud-invoice__figure{display:flex;flex-direction:column;align-items:flex-end;min-width:0;text-align:right}
.hud-invoice__line--total{
  margin-top:6px;border-top:1px solid var(--hud-line);border-bottom:none;padding-top:9px;
}
.hud-invoice__line--total .hud-invoice__val{font-size:var(--t-readout);letter-spacing:.01em;margin-right:-.01em}
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
       213.17. The first repair took max() of each opposing pair, which is
       SYMMETRIC but is not the safe box: max() throws the asymmetry away
       instead of honouring it. On the shipping profile (l59 r34, t0 b21) it
       padded 75/75 and 37/37, so 'place-items:center' centred the card on the
       raw viewport axis — 422.0/195.0 against a safe-box centre of 434.5/184.5,
       12.5 px and 10.5 px out. That is precisely the failure '.hud-charge'
       refuses two hundred lines up ("CENTRED IN THE SAFE BOX, not at left:50%.
       Those are two different axes and they were 12.5 px apart"), on the one
       screen where centring IS the composition and the player looks at nothing
       else for the whole boot. Four insets, used as four insets: the padding
       box IS the safe box, and its centre is the safe box's centre on any
       cutout, however lopsided.
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
  padding:calc(var(--hud-sa-t) + 16px) calc(var(--hud-sa-r) + 16px) calc(var(--hud-sa-b) + 16px) calc(var(--hud-sa-l) + 16px);
}
.hud-loading__card{
  --hud-edge:var(--hud-accent);
  display:flex;flex-direction:column;align-items:stretch;
  width:var(--hud-measure);
}
/* THE ONE PLACE COMPUTED ALIGNMENT AND OPTICAL ALIGNMENT DISAGREE ON THIS CARD.
   Every box here starts at x=224.5 and the boot card's whole argument is that
   it is set flush left against one measure — but a 44 px round "O" needs a
   small negative overshoot to LOOK flush against a flat-sided progress track
   and the flat "6" of 62%. Measured off the shipping frame: the title's ink
   opened at 226.00, the track and "CITY Z" at 225.00, the percentage at 225.33.
   So the largest and most deliberate piece of type on the screen was the one
   that read as indented, by 1.0-1.5 px.
   .03em, i.e. ~1.3 px at 44 px, which is the standard overshoot for a round cap
   and lands the O's extreme left on the measure rather than its bounding box.
   In em rather than px because the size is a clamp between two scale steps, so
   the correction has to travel with it — at 130 % HUD scale it is 1.7 px.
   Nothing else on this card needs it: C, 6 and the track are the three shapes
   that define the measure, and two of them are flat. */
.hud-loading__title{
  font-family:${DISPLAY_FONT};font-size:clamp(var(--t-readout),7vw,var(--t-hero));
  letter-spacing:.06em;text-transform:uppercase;color:var(--hud-accent);line-height:1;
  margin-left:-.03em;
}
.hud-loading__sub{
  font-family:${DISPLAY_FONT};letter-spacing:.14em;font-size:var(--t-micro);
  color:var(--hud-ink-muted);margin-top:3px;
}
.hud-loading__track{
  height:var(--hud-meter-h);margin-top:22px;overflow:hidden;
  background:var(--hud-track);border-radius:var(--hud-radius);
}
.hud-loading__fill{
  display:block;height:100%;background:var(--hud-accent);
  transform-origin:0 50%;transform:scaleX(var(--fill));
  will-change:transform;
}
/* The percentage LEADS the row, at the same x as the fill's origin. It used to
   trail it: .hud-loading__label took flex:1 1 auto in a row exactly as wide as
   the bar, so the label ate every spare pixel and left the number stranded
   238 px from the fill head with a 167 px void in between — and the row's
   justify-content:center was dead code for the same reason. */
.hud-loading__row{display:flex;align-items:baseline;gap:10px;margin-top:9px}
.hud-loading__pct{color:var(--hud-accent);flex:0 0 auto}
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
/* --hud-band-h is NOT redeclared here, and its absence is the point. Its only
   consumer is the alert stack's default top anchor, which this very block
   overrides to top:auto a dozen lines down — so the 114px that used to sit on
   this line had no consumer whatsoever, next to a comment upstream calling the
   token "a promise rather than a comment". A dead constant beside a live one is
   worse than no constant: the next person to reach for it gets a number that
   was never checked against anything.
   --hud-band-row is not redeclared here either, and for the same reason with
   one extra turn. It USED to be, as the literal 64px — a second copy of the
   base value, so the two could drift and one of them was already the only one
   anybody edited. Now that the base is affine the copy would have had to be the
   same expression written twice, which is the drift with the drift's excuse
   attached. Row one holds the same plates on this profile as on any other; the
   base line describes it. */
@media (max-height:520px){
  .hud-root{--hud-gap:6px;--hud-arc-w:150px;--hud-arc-h:86px}
  /* AND THE ONE TOKEN THAT CANNOT KEEP GROWING HERE, because on this profile
     the band's height is not a design choice, it is a subtraction. Measured on
     the shipping 844x390 landscape frame with a 21 px bottom inset: the hands
     reserve 240 px (--hud-thumb-reserve, and the duty strip spans the full
     width so it reaches into the thumb's quarter-disc as well as the stick's),
     which leaves 390 - 21 - 240 = 129 px between the raw top edge and the point
     where a plate starts painting on a control. Row one spends 8 + 66.50 of it
     at 130 % HUD scale — the edge floor plus the incident plate, both measured,
     see --hud-band-row — and the grid gap above spends 6. What is left for row
     two is 48.5 px, and --hud-pause-size wanted 57.20.
     So it closed the band at y=138 against a floor at 129: the duty strip and
     its LOG button painting 9 px into the hands, at the top rung of the one
     accessibility control this game has. The comment on the base token works
     the same profile out at "4.5 px above the hands" — that figure is this
     block with the chip held at the tap floor, i.e. it was written for a token
     that had not been made affine yet, and the affine change was never
     re-measured against a screen 390 px tall.
     CAPPED, NOT FROZEN, and the ceiling is the subtraction above rounded down
     to a whole pixel: the chip still grows from 44 to 48 across the ladder, so
     the argument the base token makes — that the most important control on the
     screen must not be the one that stays put when a low-vision player raises
     the type — survives everywhere it can be afforded. It is simply not
     affordable past 48 px on a viewport this short, and 130 % now closes the
     band at 128.5 with the floor at 129.
     BOTH SQUARES MOVE TOGETHER because it is the token that is capped and not
     the LOG button: '.hud-tracker__open' and '.hud-pausebtn' still cut their
     box out of one number, which is the invariant '__tests__/styles.test.ts'
     checks and the reason the two read as a pair down the trailing edge. */
  .hud-root{--hud-pause-size:clamp(${MIN_TAP_PX}px,calc(${MIN_TAP_PX}px * var(--hud-scale)),48px)}
  .hud-rankchip{width:min(calc(80px + 97px * var(--hud-scale)),26vw)}
  /* The reading sheets are 341 px tall on this profile and spend 109 of them on
     chrome — a 44 px head and a 65 px foot holding one 44 px button — so a
     third of the sheet was not content while 60-73 % of the content was under
     the fold. Tightening the two bands returns 16 px to the body without
     touching a tap target: the foot's button keeps its own 44 px min-height and
     the head holds no control at all. */
  .hud-sheet__head{padding:7px 16px}
  .hud-sheet__foot{padding:6px 16px}
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
     midpoint rather than reaching back up towards a plate.
     It takes the arc's corridor offset too, and for the obvious reason: two
     objects stacked in one rectangle, centred on two different axes 7.5 px
     apart, is the misalignment nobody can name and everybody sees. */
  .hud-alerts{
    top:auto;
    bottom:calc(var(--hud-sa-b) + var(--hud-arc-lift) + var(--hud-arc-h) * var(--hud-scale) + var(--hud-gap));
    max-width:min(calc(300px * var(--hud-scale)),38vw);
    translate:calc((var(--hud-reserve-l) - var(--hud-reserve-r)) / 2) 0;
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
   putting them at the bottom means nothing above them ever moves.

   ── 669 px, AND WHY IT IS NOT A ROUND NUMBER ───────────────────────────────
   The breakpoint was 460, which is roughly "a phone", and the two things this
   block fixes both break well above it.
     THE BAND. Above the breakpoint the base grid is three columns —
     auto minmax(0,1fr) auto — and the two flanks keep their max-content while
     the middle collapses. Swept at 20 px steps on a 900 px-tall portrait
     viewport, the incident plate holds its content again at 674 px and is
     already losing the monster's name at 669: 461 px gives it 22 px of width,
     with the tier stamp and the fight clock printing on the civilian ledger
     beside it. So the single column has to cover the whole range up to the
     width at which three columns are honest, and that width is measured, not
     chosen.
     THE ARC. .hud-charge's own note works out that the corridor between the two
     hands goes negative below 8 + 8 + 225 + 240 = 481 px, and this block is
     what repairs it — by dropping the corridor term and lifting the gauge over
     both quarter-discs instead. At 460 the repair stopped 21 px short of the
     failure, and the floor under the width kept the panel legible in the gap
     while laying it out at the very bottom of a screen that has no corridor at
     all: measured at 480x800, the gauge sat 164.8 px from the stick corner
     against a 225 px reserve, with the yen forecast under the JUMP button.
     Above 481 the corridor exists but stays narrower than the floor until about
     560 px, so the floored box overhung into both discs there too.
   One breakpoint, both failures, because they are the same failure: a band and
   a gauge sized for a rectangle the screen does not have. */
@media (orientation:portrait) and (max-width:669px){
  /* 233px at 100 %, and every one of those pixels is measured. The token has
     been wrong twice now, in the same direction: 216 let the band's last plate
     close 3.94px past it, 222 was fitted before the duty strip was allowed its
     second line, and either way the overrun lands a threat bulletin on the
     civilian ledger. Nothing in the repo checks it, because the harness reads
     --hud-band-row off the root and CORE_SCENES contains no alert scene, which
     means the top-anchored bulletin placement that BOTH the portrait phone and
     the tablet use has never been measured or screenshotted. See the harness
     spec in the report.
     83 + 150 x scale is the line through the WORST band this block can produce,
     swept across 320 / 360 / 390 / 480 / 540px-wide portrait viewports at all
     four HUD scales: four rows, three 6px gaps, and the duty strip at its fixed
     two-line height. Measured worst cases 208.7 / 230.2 / 252.7 / 275.2 against
     a declared 210.5 / 233 / 255.5 / 278, i.e. the token over-states by 1.8 to
     2.8px at every rung, which is the direction it has to be wrong in — and the
     8px gap the alert stack adds on top of it is on top of that.
     --hud-arc-lift is the other number this shape of screen needs of its own:
     the two hands do not leave a corridor at 390px — 225 + 240 is wider than
     the whole viewport — so the arc cannot go BETWEEN them and has to clear
     them vertically instead. The deeper reserve plus one gap is the shallowest
     lift that puts the whole box outside both quarter-discs, corners included. */
  .hud-root{--hud-band-h:calc(83px + 150px * var(--hud-scale));--hud-arc-lift:calc(var(--hud-thumb-reserve) + var(--hud-gap))}
  .hud-top{grid-template-columns:minmax(0,1fr);row-gap:6px}
  /* ONE RIGHT EDGE DOWN THE WHOLE BAND, and the reserve is what makes it one.
     Four flush-left plates used to step 240 / 332 / 382 / 382 across a 374px
     column, and the repair only reached the top two: the hero file and the duty
     strip cleared the pause/LOG gutter and the incident and the register did
     not, so a stack of four touching plates had two right edges 50px apart on a
     390px screen — 13% of the viewport, and after the type the most conspicuous
     thing in the frame. The comment that used to sit here called that two edges
     "each with a reason", which is true of each edge and not of the pair: the
     eye reads a stacked, touching column as ONE contour, and a contour that
     steps 50px twice reads as a mistake rather than as a gutter.
     Every row carries the reserve now, from the same token, so the gutter runs
     the height of the band and the two controls sit IN it rather than beside
     two of four plates. It costs the incident and the register 50px of measure
     apiece: the incident head drops from a 352px measure to 302 — the same
     measure it has in landscape, where "Deep Sea King" fits with room over —
     and the register's four cells need 165.67 of 302. Both affordable, and both
     stated so the next person does not have to re-measure them. */
  .hud-top__left{grid-area:1 / 1;padding-right:calc(var(--hud-pause-size) + 6px)}
  .hud-tracker{grid-area:2 / 1}
  .hud-top__centre{grid-area:3 / 1;align-items:stretch;padding-right:calc(var(--hud-pause-size) + 6px)}
  .hud-top__right{grid-area:4 / 1;padding-right:calc(var(--hud-pause-size) + 6px)}
  .hud-rankchip{width:100%}
  /* The seat row stops bracketing here for the same reason it stops in the
     resting band: this plate is 268px of measure against a 105px row, so
     'space-between' opened a 162.6px void between "RANK 388" and "GAIN ×0.62"
     and a labelled pair read as two unrelated objects. 14px is the gap that
     keeps the mult beside the seat it modifies without letting the two run
     together — one and a half word-spaces at --t-micro. */
  .hud-rankchip__seat{justify-content:flex-start;gap:14px}
  /* The resting-band overrides are re-stated here as no-ops on purpose. Their
     selectors carry an attribute and therefore out-specify this block's plain
     class rules, so without these two lines a portrait phone with no incident
     would take the landscape composition — a spanned grid-area in a
     single-column grid, and a hero file that stops honouring the button
     gutter. There is no void to fill in portrait: the band is one column and
     the file already spans it. */
  .hud-top[data-encounter='none'] .hud-top__left{grid-area:1 / 1}
  .hud-top[data-encounter='none'] .hud-rankchip{width:100%}
  /* THE OBJECTIVE GETS A SECOND LINE HERE, AND THE ROW GETS A FIXED HEIGHT.
     Clipping the duty line to one line is a LANDSCAPE argument — the band there
     is 121 px and the log is one tap away with the width to print the objective
     properly — and in portrait it buys nothing: there are ~160 CSS px of empty
     sky under the band, and the accessibility control that exists to make text
     easier to read was deleting a third of the only instruction on screen.
     Measured on the 390x844 profile, .hud-tracker__what wants 207 px against
     199.4 available at 100 % HUD scale, which loses the last word of "Carry the
     trapped commuters out", and 267 against 178.5 at 130 % — a third gone.
     TWO LINES, AND EXACTLY TWO. -webkit-line-clamp caps the objective at two
     lines and the min-height below floors the row at the height two lines need,
     so the ceiling and the floor are the same number and the row does not
     change height at all. That is not tidiness, it is the finding at the top of
     this file applied to the other axis: in portrait the duty strip is grid row
     TWO, above the incident and its cost, so a strip whose height followed its
     own text would move both of those plates every time the tracked objective
     crossed the one-line boundary — including mid-fight, because the quest log
     is one tap away. A fixed row cannot.
     The height is read off the type scale rather than fitted to it: 11 px of
     plate padding plus the 1 px gap inside .hud-tracker__main, then one title
     line at line-height 1.15 and two objective lines at 1.25. That is 65.2 px
     at 100 % and 81.2 at 130 %, and the measured row agrees to 0.02 px at both.
     Where the objective is short the plate simply carries more paper — its
     contents are centred, so it reads as an airier strip rather than as a
     hanging empty line.
     THE TITLE STAYS ON ONE LINE, and that is the trade, stated: at 130 % it
     wants 218 px against 213.5 and loses about two characters of "ROUTE 7
     TUNNEL COLLAPSE". Wrapping it too would double the row again for four and
     a half pixels, and the quest's full name is printed in the log — while the
     objective is the sentence that tells the player what to do next, which is
     not on screen anywhere else while a fight is on. */
  .hud-tracker{min-height:calc(12px + 1.15 * var(--t-title) + 2.5 * var(--t-body))}
  .hud-tracker__plate .hud-tracker__obj{white-space:normal}
  .hud-tracker__what{
    white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;
  }
  /* No corridor term. It describes a rectangle that does not exist at 390px,
     and min() taking its negative branch is what collapsed this panel to
     width:0 on every portrait phone.
     AND THE LIFT IS FLOORED AGAINST THE BAND, in the band's own tokens, so the
     two objects in this corridor cannot drift into each other. --hud-arc-lift
     raises the gauge 248px to clear the two overlapping quarter-discs; on a
     SHORT portrait phone that lift pushes it back up into the band, and the arc
     has no plate and no clip, so it drew its stroke, its two ticks, the intent
     word and the yen forecast straight across the ledger's numerals. Measured
     at 320x568 and 130 % HUD scale: 82.2px of overlap, with the gauge crossing
     "LOST 2" and the right leg running down through the collateral figure. Two
     elements, one rectangle — reached by the other object in the corridor.
     min() of the two, so the lift wins wherever there is room for it: on the
     390x844 profile the first branch is 282 and the second 451, i.e. today's
     value untouched. On 320x568 the second branch pins the gauge one gap under
     the band instead.
     WHAT THAT COSTS, said plainly: on a portrait phone that short the pinned
     box is inside the thumb's quarter-disc — 187px from the corner against a
     240px reserve. There is no third option. The band alone is 262px of a 568px
     screen at 130 %, so the free rectangle the gauge wants does not exist, and
     between drawing the gauge where a hand may cover it and drawing it on the
     ledger, the ledger wins: a hand moves, and a player can move it. Below this
     shape of screen the honest answer is to stop drawing the gauge, and that is
     a decision about a minimum supported viewport rather than about the arc. */
  /* AND THE CORRIDOR TRANSLATE GOES WITH THE CORRIDOR TERM. The base rule
     slides the gauge by half the difference between the two reserves so it
     centres on the corridor between the hands rather than on the safe box —
     and this block's whole argument is that there IS no corridor at 390px. The
     translate was left standing anyway, so the gauge, its intent word and its
     yen forecast sat 7.5px left of the safe-box centre on every portrait
     phone, off the axis of the two centred runs inside them; and
     [data-stick-hand='right'] flipped the whole panel 15px sideways in a layout
     where the hands no longer decide its x at all. The landscape block
     re-applies the same translate to .hud-alerts deliberately, which is what
     made the omission here asymmetric rather than uniform. */
  .hud-charge{
    width:min(calc(var(--hud-arc-w) * var(--hud-scale)),calc(100vw - var(--hud-sa-l) - var(--hud-sa-r)));
    bottom:min(calc(var(--hud-sa-b) + var(--hud-arc-lift)),calc(100% - var(--hud-sa-t) - var(--hud-band-h) - var(--hud-gap) - var(--hud-arc-h) * var(--hud-scale)));
    translate:0 0;
  }
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
