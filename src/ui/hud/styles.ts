/**
 * THE HUD STYLESHEET
 *
 * One string, injected once. Every layout decision and every animation lives
 * here, so the TypeScript builds a tree and then only ever writes custom
 * properties into it.
 *
 * ── THE LAYOUT CONSTRAINT NOBODY WRITES DOWN ───────────────────────────────
 * On a phone held in landscape — which is how this game is played — the bottom
 * 200 px of BOTH lower corners is under a hand. `src/ui/input` floats the stick
 * anywhere in the left half and strikes its button arc out to ~215 px from the
 * bottom-right safe-area corner. On a 390 px-tall landscape viewport that is
 * more than half the screen.
 *
 * So the combat HUD lives in the TOP BAND and nowhere else. Not as a style
 * choice — there is no other space. Everything that must be readable mid-fight
 * is inside `.hud-top`, and the only thing allowed below it is the charge arc,
 * which sits centre-bottom in the gap BETWEEN the two thumbs and is transient.
 *
 * ── WHY THERE IS NO `backdrop-filter` ──────────────────────────────────────
 * A blurred HUD panel looks expensive because it is: `backdrop-filter` forces
 * the compositor to read back and blur the frame behind every panel, every
 * frame, on a tile-based mobile GPU that would much rather not. Panels are flat
 * gradients with a hairline instead. On a dark game frame the difference is
 * invisible; in the frame budget it is not.
 *
 * ── EVERY ANIMATED PROPERTY IS COMPOSITED ──────────────────────────────────
 * `transform` and `opacity` only. A keyframe on `width` or `left` would defeat
 * the entire point of the custom-property discipline by moving the work into
 * the style engine instead of the compositor.
 */

import { CSS_NUMBER_STYLES } from './css-number';
import { SAFE_AREA_STYLES } from './safe-area';
import { PALETTES, THUMB_RESERVE_PX, type PaletteName } from './tokens';

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
@property --boredom{syntax:'<number>';inherits:true;initial-value:0}
@property --charge{syntax:'<number>';inherits:true;initial-value:0}
@property --fill{syntax:'<number>';inherits:false;initial-value:0}
@property --collateral{syntax:'<number>';inherits:false;initial-value:0}
@property --urgency{syntax:'<number>';inherits:true;initial-value:0}

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
  --hud-radius:10px;
  --hud-gap:8px;
  --hud-thumb-reserve:${THUMB_RESERVE_PX}px;
  --hud-panel:linear-gradient(180deg,rgba(14,19,29,.90),rgba(6,9,15,.86));
  --hud-shadow:0 6px 20px rgba(0,0,0,.55);
  ${paletteVars('default')};
}
${allPalettes()}
.hud-root *{box-sizing:border-box;margin:0}
.hud-root [hidden]{display:none !important}

.hud-layer{position:absolute;inset:0;pointer-events:none}
.hud-layer--world{z-index:0}
.hud-layer--hud{z-index:2}
.hud-layer--alerts{z-index:4}
.hud-layer--screen{z-index:6}

/* ========================================================================== */
/* Primitives                                                                 */
/* ========================================================================== */
.hud-panel{
  background:var(--hud-panel);
  border:1px solid var(--hud-line);
  border-radius:var(--hud-radius);
  box-shadow:var(--hud-shadow);
  padding:6px 9px;
  contain:layout style;
}
.hud-label{
  font-family:${DISPLAY_FONT};
  font-size:calc(10px * var(--hud-scale));
  letter-spacing:.14em;text-transform:uppercase;
  color:var(--hud-ink-muted);line-height:1.1;white-space:nowrap;
}
.hud-value{
  font-family:${DISPLAY_FONT};
  font-size:calc(20px * var(--hud-scale));
  line-height:1;letter-spacing:.02em;
}
.hud-btn{
  pointer-events:auto;
  min-height:44px;min-width:44px;
  font-family:${DISPLAY_FONT};
  font-size:calc(15px * var(--hud-scale));
  letter-spacing:.12em;text-transform:uppercase;
  color:var(--hud-ink);
  background:linear-gradient(180deg,rgba(255,255,255,.10),rgba(255,255,255,.02));
  border:1px solid var(--hud-line);border-radius:8px;
  padding:9px 16px;cursor:pointer;
  transition:transform .08s ease-out,border-color .12s,background .12s;
  touch-action:none;will-change:transform;
}
.hud-btn[data-pressed]{transform:scale(.95);border-color:var(--hud-accent)}
.hud-btn--primary{
  border-color:color-mix(in srgb,var(--hud-accent) 70%,transparent);
  background:linear-gradient(180deg,color-mix(in srgb,var(--hud-accent) 26%,transparent),rgba(0,0,0,.2));
  color:var(--hud-accent);
}
.hud-btn--ghost{background:none}
.hud-btn--icon{padding:0;width:44px;display:grid;place-items:center;font-size:18px}

/* ========================================================================== */
/* Combat HUD — the top band                                                  */
/* ========================================================================== */
.hud-top{
  position:absolute;
  top:var(--hud-sa-t);left:var(--hud-sa-l);right:var(--hud-sa-r);
  display:grid;
  grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);
  grid-template-rows:auto auto;
  align-items:start;
  gap:var(--hud-gap);
  pointer-events:none;
}
.hud-top__left{grid-area:1 / 1;display:flex;flex-direction:column;gap:var(--hud-gap);align-items:flex-start;min-width:0}
.hud-top__centre{grid-area:1 / 2;display:flex;flex-direction:column;gap:6px;align-items:center;min-width:0}
.hud-top__right{grid-area:1 / 3;display:flex;flex-direction:column;gap:var(--hud-gap);align-items:flex-end;min-width:0}
/* The tracker is a PLACED GRID ITEM rather than a member of a column.
   In landscape it hangs under the centre column, which is the only region of a
   390 px-tall viewport that is neither under a hand nor holding a live readout;
   in portrait it becomes fixed to the bottom-left, above the thumb reserve. Two
   very different places, one element, no duplicated DOM. */
.hud-tracker{grid-area:2 / 2;justify-self:center}

/* ---- rank chip --------------------------------------------------------- */
.hud-rankchip{display:flex;align-items:center;gap:8px;padding:5px 10px 6px}
.hud-rankchip__class{
  font-family:${DISPLAY_FONT};font-size:calc(22px * var(--hud-scale));line-height:.9;
  color:var(--hud-class,var(--hud-accent));
  padding:0 6px;border:1px solid currentColor;border-radius:5px;
}
.hud-rankchip__rank{font-family:${DISPLAY_FONT};font-size:calc(19px * var(--hud-scale));line-height:1}
.hud-rankchip__name{max-width:110px;overflow:hidden;text-overflow:ellipsis}
.hud-rankchip__pts{
  display:block;height:2px;width:64px;margin-top:3px;border-radius:2px;
  background:var(--hud-line);overflow:hidden;
}
.hud-rankchip__pts::after{
  content:'';display:block;height:100%;width:100%;
  background:var(--hud-accent);
  transform-origin:0 50%;transform:scaleX(var(--fill,0));
}

/* ---- boredom ----------------------------------------------------------- */
/* The game's real progress bar. Presented as a MOOD: a word, a slow breath,  */
/* and a fill that drains of colour rather than filling up with it.           */
.hud-boredom{width:min(214px,42vw);padding:6px 9px 7px}
.hud-boredom__head{display:flex;justify-content:space-between;align-items:baseline;gap:6px}
.hud-boredom__mood{
  font-family:${DISPLAY_FONT};font-size:calc(11px * var(--hud-scale));
  letter-spacing:.1em;text-transform:uppercase;
  color:var(--hud-mood,var(--hud-ink-muted));
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.hud-boredom__mult{
  font-family:${DISPLAY_FONT};font-size:calc(11px * var(--hud-scale));
  color:var(--hud-ink-muted);white-space:nowrap;
}
.hud-boredom[data-throttled='true'] .hud-boredom__mult{color:var(--hud-lost)}
.hud-boredom__track{
  position:relative;height:7px;margin-top:5px;border-radius:4px;overflow:hidden;
  background:rgba(255,255,255,.07);
}
.hud-boredom__fill{
  position:absolute;inset:0;transform-origin:0 50%;transform:scaleX(var(--boredom,0));
  background:linear-gradient(90deg,
    color-mix(in srgb,var(--hud-mood,#54e08a) 25%,transparent),
    var(--hud-mood,#54e08a));
  will-change:transform;
}
/* The breath. Slows as he stops caring — 2.4 s engaged, 12 s numb — which is  */
/* the difference between a HUD element that is alive and one that has given   */
/* up, and it says so without a number.                                        */
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

/* ---- encounter card ---------------------------------------------------- */
.hud-encounter{
  display:flex;align-items:center;gap:9px;padding:5px 12px 6px;
  border-color:color-mix(in srgb,var(--hud-tier,var(--hud-accent)) 55%,var(--hud-line));
}
.hud-encounter__tier{
  font-family:${DISPLAY_FONT};font-size:calc(11px * var(--hud-scale));letter-spacing:.16em;
  color:var(--hud-tier,var(--hud-accent));
}
.hud-encounter__name{
  font-family:${DISPLAY_FONT};font-size:calc(16px * var(--hud-scale));
  max-width:34vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.hud-encounter__clock{
  font-family:${DISPLAY_FONT};font-size:calc(23px * var(--hud-scale));line-height:1;
  color:var(--hud-ink);
}
.hud-encounter__clock .hud-num{font-size:inherit}
.hud-encounter__sep{opacity:.55}

/* boss bar: only geometry the compositor can do */
.hud-boss{width:min(340px,58vw);padding:5px 10px 7px}
.hud-boss__track{height:6px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden}
.hud-boss__fill{
  height:100%;transform-origin:0 50%;transform:scaleX(var(--fill,1));
  background:linear-gradient(90deg,var(--hud-tier,#ff4d4d),color-mix(in srgb,var(--hud-tier,#ff4d4d) 40%,#fff));
  will-change:transform;
}

/* ---- civilian ledger --------------------------------------------------- */
.hud-ledger{display:flex;gap:14px;padding:5px 11px 6px;align-items:flex-start}
.hud-ledger__cell{display:flex;flex-direction:column;align-items:flex-end;gap:1px}
.hud-ledger__value{
  font-family:${DISPLAY_FONT};font-size:calc(21px * var(--hud-scale));line-height:1;
}
.hud-ledger__cell--saved .hud-ledger__value{color:var(--hud-saved)}
.hud-ledger__cell--lost .hud-ledger__value{color:var(--hud-lost)}
/* A lost civilian is the only counter that gets to move. One 320 ms pulse,   */
/* driven by re-adding the class, so it cannot be mistaken for decoration.    */
.hud-ledger__cell--lost[data-bump='true'] .hud-ledger__value{animation:hud-bump .32s ease-out}
@keyframes hud-bump{
  0%{transform:scale(1)}35%{transform:scale(1.32)}100%{transform:scale(1)}
}
.hud-ledger__witness{color:var(--hud-ink-muted)}

/* ---- collateral ticker ------------------------------------------------- */
.hud-collateral{padding:5px 11px 7px;min-width:132px}
.hud-collateral__row{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
.hud-collateral__value{
  font-family:${DISPLAY_FONT};font-size:calc(19px * var(--hud-scale));line-height:1;
  color:var(--hud-collateral);
}
.hud-collateral__track{
  height:4px;margin-top:5px;border-radius:2px;overflow:hidden;background:rgba(255,255,255,.07);
}
/* propertyDamageScore, NOT yen. Yen is unbounded and would peg this meter on  */
/* the first serious punch of the game; the score is the compressed 0..1 field */
/* that exists precisely so a meter has something honest to read.              */
.hud-collateral__fill{
  height:100%;transform-origin:0 50%;transform:scaleX(var(--collateral,0));
  background:linear-gradient(90deg,var(--hud-collateral),#ff4d4d);
  will-change:transform;
}
.hud-collateral__debris{color:var(--hud-ink-muted);margin-top:3px;display:block}

/* ---- quest tracker ----------------------------------------------------- */
.hud-tracker{
  width:min(232px,46vw);padding:6px 10px 8px;
  border-left:2px solid var(--hud-accent);
}
.hud-tracker[data-urgency='soon']{border-left-color:var(--hud-collateral)}
.hud-tracker[data-urgency='critical']{border-left-color:var(--hud-lost)}
.hud-tracker[data-errand='true']{border-left-color:var(--hud-commit)}
.hud-tracker__title{
  font-family:${DISPLAY_FONT};font-size:calc(14px * var(--hud-scale));line-height:1.1;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.hud-tracker__obj{
  display:flex;gap:6px;align-items:baseline;margin-top:3px;
  font-size:calc(11px * var(--hud-scale));color:var(--hud-ink-muted);line-height:1.25;
}
.hud-tracker__obj[data-complete='true']{color:var(--hud-saved);text-decoration:line-through}
.hud-tracker__count{font-variant-numeric:tabular-nums;color:var(--hud-ink)}
.hud-tracker__clock{
  display:flex;align-items:baseline;gap:5px;margin-top:5px;
  font-family:${DISPLAY_FONT};font-size:calc(17px * var(--hud-scale));line-height:1;
}
.hud-tracker[data-urgency='critical'] .hud-tracker__clock{
  color:var(--hud-lost);
  animation:hud-pulse 1s steps(1,end) infinite;
}
@keyframes hud-pulse{0%,60%{opacity:1}61%,100%{opacity:.35}}
.hud-tracker__conflict{
  margin-top:5px;padding-top:5px;border-top:1px dashed var(--hud-line);
  color:var(--hud-collateral);font-size:calc(10px * var(--hud-scale));line-height:1.3;
}

/* ---- charge arc -------------------------------------------------------- */
/* Sits centre-bottom, in the corridor BETWEEN the two thumbs, and appears     */
/* only while charging. It is not a copy of the input layer's ring on the      */
/* punch button: that ring answers "how long have I held this", and this arc   */
/* answers "what am I about to do to the neighbourhood".                       */
/* Visibility is a NUMBER, not a class or an attribute: --hud-on is 0 or 1   */
/* and CSS derives opacity and the entry transform from it, so appearing and   */
/* disappearing stay inside the custom-property-only rule.                     */
.hud-charge{
  position:absolute;left:50%;bottom:calc(var(--hud-sa-b) + 10px);
  width:184px;height:104px;margin-left:-92px;
  opacity:var(--hud-on,0);
  transform:translateY(calc((1 - var(--hud-on,0)) * 10px))
            scale(calc(.94 + .06 * var(--hud-on,0)));
  transition:opacity .12s ease-out,transform .12s ease-out;
  pointer-events:none;
}
.hud-charge svg{display:block;width:100%;height:100%;overflow:visible}
.hud-charge__track{fill:none;stroke:rgba(255,255,255,.14);stroke-width:7;stroke-linecap:round}
.hud-charge__fill{
  fill:none;stroke:var(--hud-intent,var(--hud-commit));stroke-width:7;stroke-linecap:round;
  stroke-dasharray:var(--hud-arc-len,239);
  stroke-dashoffset:calc(var(--hud-arc-len,239) * (1 - var(--charge,0)));
  filter:drop-shadow(0 0 7px color-mix(in srgb,var(--hud-intent,#7ef0ff) 75%,transparent));
}
.hud-charge__tick{stroke:rgba(255,255,255,.55);stroke-width:2}
/* The intent word is GENERATED CONTENT from a custom property, for the same   */
/* reason the timer digits are: it changes while the player is holding the     */
/* button, and a text-node swap is not allowed on that path.                   */
.hud-charge__label{
  position:absolute;left:0;right:0;bottom:16px;text-align:center;
  font-family:${DISPLAY_FONT};font-size:15px;letter-spacing:.14em;
  color:var(--hud-intent,var(--hud-commit));
}
.hud-charge__label::after{content:var(--hud-intent-label,'NORMAL')}
.hud-charge__cost{
  position:absolute;left:0;right:0;bottom:1px;text-align:center;
  font-size:11px;color:var(--hud-collateral);
  opacity:var(--hud-on,0);
}
.hud-charge__cost .hud-num{font-size:inherit}

/* ---- pause affordance -------------------------------------------------- */
/* Top-right of the safe area and nowhere near a thumb, because a pause button */
/* under a thumb is pressed by accident during every fight.                    */
.hud-pausebtn{
  position:absolute;top:var(--hud-sa-t);right:var(--hud-sa-r);
  width:40px;height:40px;min-width:40px;min-height:40px;
  border-radius:50%;padding:0;display:grid;place-items:center;
  font-size:15px;letter-spacing:0;
}

/* ========================================================================== */
/* Alerts                                                                     */
/* ========================================================================== */
.hud-alerts{
  position:absolute;top:calc(var(--hud-sa-t) + 4px);left:50%;transform:translateX(-50%);
  display:flex;flex-direction:column;align-items:center;gap:5px;
  width:min(420px,80vw);pointer-events:none;
}
.hud-alert{
  width:100%;padding:6px 14px 7px;text-align:center;
  border-left:3px solid var(--hud-alert-color,var(--hud-accent));
  border-right:3px solid var(--hud-alert-color,var(--hud-accent));
  animation:hud-alert-in .22s cubic-bezier(.2,.9,.3,1);
}
.hud-alert__title{
  font-family:${DISPLAY_FONT};font-size:calc(15px * var(--hud-scale));letter-spacing:.13em;
  color:var(--hud-alert-color,var(--hud-accent));line-height:1.1;
}
.hud-alert__body{font-size:calc(11px * var(--hud-scale));color:var(--hud-ink-muted);margin-top:1px}
.hud-alert[data-kind='threat']{animation:hud-alert-in .22s cubic-bezier(.2,.9,.3,1),hud-throb 1.1s ease-in-out 3}
@keyframes hud-alert-in{from{opacity:0;transform:translateY(-8px) scale(.97)}to{opacity:1;transform:none}}
@keyframes hud-throb{0%,100%{opacity:1}50%{opacity:.62}}

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
  font-family:${DISPLAY_FONT};letter-spacing:.1em;white-space:nowrap;
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
.hud-marker__label{font-size:11px;color:var(--hud-marker-color,var(--hud-accent))}
.hud-marker__dist{font-size:10px;color:var(--hud-ink-muted)}
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
.hud-sheet{
  display:flex;flex-direction:column;
  width:100%;max-width:640px;max-height:100%;margin:0 auto;
  background:var(--hud-panel);border:1px solid var(--hud-line);
  border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.7);
  overflow:hidden;
}
.hud-sheet--wide{max-width:820px}
.hud-sheet__head{
  display:flex;align-items:center;gap:10px;
  padding:11px 14px;border-bottom:1px solid var(--hud-line);flex:0 0 auto;
}
.hud-sheet__title{
  font-family:${DISPLAY_FONT};font-size:calc(20px * var(--hud-scale));letter-spacing:.1em;
  text-transform:uppercase;color:var(--hud-accent);flex:1 1 auto;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.hud-sheet__sub{font-size:11px;color:var(--hud-ink-muted)}
.hud-sheet__body{
  flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;
  padding:12px 14px;-webkit-overflow-scrolling:touch;touch-action:pan-y;
}
.hud-sheet__foot{
  display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;
  padding:10px 14px;border-top:1px solid var(--hud-line);flex:0 0 auto;
}

.hud-section{margin:0 0 14px}
.hud-section:last-child{margin-bottom:0}
.hud-section__title{
  font-family:${DISPLAY_FONT};font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:var(--hud-ink-muted);padding-bottom:4px;margin-bottom:7px;
  border-bottom:1px solid var(--hud-line);
}
.hud-note{font-size:11px;line-height:1.45;color:var(--hud-ink-muted);margin-top:7px}

/* ---- lists ------------------------------------------------------------- */
.hud-row{
  display:flex;align-items:center;gap:10px;
  padding:8px 9px;border-radius:8px;border:1px solid transparent;
  background:rgba(255,255,255,.03);margin-bottom:6px;
}
.hud-row:last-child{margin-bottom:0}
.hud-row--button{pointer-events:auto;cursor:pointer;width:100%;text-align:left;min-height:44px}
.hud-row[data-selected='true']{
  border-color:color-mix(in srgb,var(--hud-accent) 60%,transparent);
  background:color-mix(in srgb,var(--hud-accent) 10%,transparent);
}
.hud-row__main{flex:1 1 auto;min-width:0}
.hud-row__title{
  font-family:${DISPLAY_FONT};font-size:calc(15px * var(--hud-scale));line-height:1.15;
  overflow:hidden;text-overflow:ellipsis;
}
.hud-row__meta{font-size:11px;color:var(--hud-ink-muted);line-height:1.35;margin-top:2px}
.hud-row__value{
  font-family:${DISPLAY_FONT};font-size:calc(17px * var(--hud-scale));
  font-variant-numeric:tabular-nums;text-align:right;flex:0 0 auto;
}
.hud-chip{
  font-family:${DISPLAY_FONT};font-size:10px;letter-spacing:.12em;
  padding:2px 6px;border-radius:4px;border:1px solid currentColor;
  color:var(--hud-chip-color,var(--hud-ink-muted));flex:0 0 auto;
}

/* ---- rank board -------------------------------------------------------- */
.hud-standing{display:flex;align-items:flex-end;gap:12px;margin-bottom:12px}
.hud-standing__rank{
  font-family:${DISPLAY_FONT};font-size:calc(52px * var(--hud-scale));line-height:.82;
  color:var(--hud-class,var(--hud-accent));
}
.hud-standing__meta{flex:1 1 auto;min-width:0}
.hud-standing__bar{height:3px;border-radius:2px;background:var(--hud-line);overflow:hidden;margin-top:6px}
.hud-standing__bar::after{
  content:'';display:block;height:100%;background:var(--hud-accent);
  transform-origin:0 50%;transform:scaleX(var(--fill,0));
}
.hud-rival{border-left:3px solid var(--hud-rival)}
.hud-rival[data-above='false']{border-left-color:var(--hud-ink-muted)}
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
.hud-invoice__key{flex:1 1 auto;color:var(--hud-ink-muted);font-size:12px}
.hud-invoice__val{font-family:${DISPLAY_FONT};font-size:calc(17px * var(--hud-scale))}
.hud-invoice__line--total{
  margin-top:6px;border-top:1px solid var(--hud-line);border-bottom:none;padding-top:9px;
}
.hud-invoice__line--total .hud-invoice__val{font-size:calc(26px * var(--hud-scale))}
.hud-invoice__sub{font-size:11px;color:var(--hud-ink-muted);text-align:right}
.hud-invoice__val--saved{color:var(--hud-saved)}
.hud-invoice__val--lost{color:var(--hud-lost)}
.hud-invoice__val--collateral{color:var(--hud-collateral)}
.hud-verdict{
  margin-top:10px;padding:9px 11px;border-radius:9px;
  border:1px solid color-mix(in srgb,var(--hud-verdict,var(--hud-accent)) 55%,transparent);
  background:color-mix(in srgb,var(--hud-verdict,var(--hud-accent)) 9%,transparent);
  color:var(--hud-verdict,var(--hud-accent));font-size:12px;line-height:1.45;
}

/* ---- settings ---------------------------------------------------------- */
.hud-setting{display:flex;align-items:center;gap:10px;padding:7px 0;min-height:48px}
.hud-setting__label{flex:1 1 auto;min-width:0}
.hud-setting__name{font-family:${DISPLAY_FONT};font-size:calc(14px * var(--hud-scale));letter-spacing:.06em}
.hud-setting__hint{font-size:11px;color:var(--hud-ink-muted);line-height:1.3;margin-top:1px}
.hud-seg{display:flex;gap:3px;flex:0 0 auto;background:rgba(255,255,255,.05);padding:3px;border-radius:9px}
.hud-seg__opt{
  pointer-events:auto;cursor:pointer;min-height:38px;min-width:44px;padding:6px 11px;
  border:none;border-radius:7px;background:none;color:var(--hud-ink-muted);
  font-family:${DISPLAY_FONT};font-size:calc(13px * var(--hud-scale));letter-spacing:.08em;
  text-transform:uppercase;touch-action:none;
}
.hud-seg__opt[aria-pressed='true']{
  background:color-mix(in srgb,var(--hud-accent) 22%,transparent);
  color:var(--hud-accent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--hud-accent) 45%,transparent);
}
.hud-swatches{display:flex;gap:5px;flex:0 0 auto}
.hud-swatch{
  width:14px;height:14px;border-radius:3px;border:1px solid rgba(255,255,255,.25);
}

/* ---- loading ----------------------------------------------------------- */
.hud-loading{
  position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:16px;
  background:#05070c;pointer-events:auto;
  padding:calc(var(--hud-sa-t) + 16px) calc(var(--hud-sa-r) + 16px)
          calc(var(--hud-sa-b) + 16px) calc(var(--hud-sa-l) + 16px);
}
.hud-loading__title{
  font-family:${DISPLAY_FONT};font-size:clamp(26px,8vw,54px);letter-spacing:.16em;
  text-transform:uppercase;color:var(--hud-accent);text-align:center;line-height:1;
}
.hud-loading__sub{
  font-family:${DISPLAY_FONT};letter-spacing:.3em;font-size:12px;
  color:var(--hud-ink-muted);text-align:center;
}
.hud-loading__track{
  width:min(62vw,320px);height:3px;border-radius:2px;
  background:rgba(255,255,255,.10);overflow:hidden;
}
.hud-loading__fill{
  height:100%;background:var(--hud-accent);
  transform-origin:0 50%;transform:scaleX(var(--fill,0));
  will-change:transform;
}
.hud-loading__row{
  display:flex;align-items:baseline;gap:10px;justify-content:center;
  width:min(62vw,320px);
}
.hud-loading__label{
  font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--hud-ink-muted);
  flex:1 1 auto;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.hud-loading__pct{
  font-family:${DISPLAY_FONT};font-size:13px;color:var(--hud-ink-muted);
}
.hud-loading__tip{
  max-width:min(88vw,460px);text-align:center;font-size:11.5px;line-height:1.55;
  color:var(--hud-ink-muted);
}

/* ========================================================================== */
/* Landscape phone — the constrained case, and the one that ships             */
/* ========================================================================== */
@media (max-height:520px){
  .hud-root{--hud-gap:6px}
  .hud-boredom{width:min(190px,32vw)}
  .hud-tracker{width:min(200px,32vw)}
  .hud-encounter__name{max-width:24vw}
  .hud-boss{width:min(300px,42vw)}
  .hud-charge{width:150px;height:86px;margin-left:-75px}
  .hud-sheet{max-height:100%}
  .hud-loading{gap:11px}
  .hud-loading__title{font-size:clamp(22px,5vh,34px)}
  /* Below this height the invoice cannot show everything at once, so it       */
  /* scrolls rather than shrinking the type past readable.                     */
  .hud-invoice__line--total .hud-invoice__val{font-size:calc(21px * var(--hud-scale))}
}

/* Narrow portrait: the top band stacks, and the tracker moves to the bottom  */
/* LEFT — which in portrait is above the thumb rather than under it, because  */
/* the reserve is measured from the bottom and portrait has 844 px of height. */
@media (orientation:portrait) and (max-width:460px){
  .hud-top{grid-template-columns:minmax(0,1fr) minmax(0,1fr);row-gap:6px}
  .hud-top__left{grid-area:1 / 1}
  .hud-top__right{grid-area:1 / 2}
  .hud-top__centre{grid-area:2 / 1 / auto / -1;align-items:flex-start}
  .hud-boredom{width:min(200px,50vw)}
  /* FIXED, not absolute. .hud-top is itself absolutely positioned with an
     auto height, so an absolutely-positioned child resolving bottom against
     IT lands above the top of the screen — which is precisely the bug the
     safe-area assertion caught, at y = -208. Fixed resolves against the
     viewport, which is what "above the thumb" means. */
  .hud-tracker{
    position:fixed;left:var(--hud-sa-l);
    bottom:calc(var(--hud-sa-b) + var(--hud-thumb-reserve));
    width:min(260px,68vw);
  }
  .hud-encounter__name{max-width:52vw}
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
