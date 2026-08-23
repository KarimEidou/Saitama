/**
 * TOUCH OVERLAY — the DOM half of the on-screen controls.
 *
 * Renders the movement stick and the thumb-arc action buttons, and nothing
 * else: it holds no input state, makes no decisions, and is entirely driven by
 * `TouchCore` through `sync()`. Deleting this file would cost the game its
 * visuals and none of its behaviour, which is the intended split.
 *
 * ── TWO STICK LAYOUTS, AND WHY THE DEFAULT CHANGED ─────────────────────────
 * The stick used to be floating-only AND `opacity:0` until a finger was down,
 * which meant the game shipped with no visible movement control at all. The
 * player had to already know that dragging the empty left half of the screen
 * would summon one. The bug report this fixes reads, accurately, "the character
 * cannot be moved; the joystick is not even rendering."
 *
 *   ANCHORED (`floatingStick: false`, the default) — the ring lives at a fixed
 *   place near the stick hand's bottom corner, painted at `stickIdleOpacity`
 *   with nothing touching it, and CSS owns its position. Nothing in the
 *   per-frame path writes to `.opm-stick` at all; only the knob moves.
 *
 *   FLOATING (`floatingStick: true`) — the ring follows the thumb, as before,
 *   but is no longer invisible at rest: it idles at the same anchor the
 *   anchored layout uses, so there is something on screen to discover.
 *
 * ── LAYOUT NOTES ───────────────────────────────────────────────────────────
 * Buttons sit on an ARC struck from a pivot just inside the bottom corner
 * OPPOSITE the stick — that arc is the path a thumb actually sweeps when the
 * phone rests in the palm. A vertical stack or a 2x2 grid forces the thumb to
 * stretch and to re-grip, which is why every good mobile action game uses an
 * arc and every bad one uses a grid. `stickHand` mirrors which corner it is
 * struck from, via explicit `[data-hand]` rules rather than `direction: rtl`:
 * `direction` would also reverse the button LABELS' bidi resolution and the
 * flex ordering inside every button, to fix an offset.
 *
 * The pivot is offset from `env(safe-area-inset-*)`, not from the raw viewport
 * edge, so buttons clear the home indicator and rounded corners. Insets can
 * additionally be forced programmatically (`setSafeArea`) for platforms whose
 * WebView reports `env()` as 0 while still having a notch — and
 * `resolvedSafeArea()` reads the two back combined, because `TouchCore` has to
 * anchor its origin on the same number the CSS anchors the ring on.
 *
 * Everything is `will-change: transform` and updated by writing transforms and
 * CSS custom properties only — no layout-triggering property is touched in the
 * per-frame path.
 */

import type { SafeAreaInsets } from '@/types';
import { clamp01 } from '@/util';
import type { IInputTuning } from './config';
import {
  fixedStickAnchor,
  stickKnobTravelPx,
  stickReachPx,
  STICK_KNOB_RADIUS_PX,
  ZERO_SAFE_AREA,
} from './stick-geometry';
import type { TouchButtonId, TouchHit } from './touch-core';

export { fixedStickAnchor, stickReachPx, STICK_KNOB_RADIUS_PX };

/** Where a button sits on the thumb arc. Angles measured CCW from "due left". */
export interface IThumbArcSlot {
  readonly id: TouchButtonId;
  readonly label: string;
  readonly glyph: string;
  /** Degrees from the horizontal, sweeping up towards the screen's top. */
  readonly angleDeg: number;
  /** Distance from the pivot, CSS px. */
  readonly radiusPx: number;
  /** Diameter, CSS px. */
  readonly sizePx: number;
}

/** Pivot inset from the safe-area corner, CSS px. */
export const THUMB_PIVOT_PX = 16;

/**
 * The arc. Punch is closest to the pivot and largest because it is pressed an
 * order of magnitude more often than anything else.
 */
export const THUMB_ARC: readonly IThumbArcSlot[] = Object.freeze([
  { id: 'punch', label: 'PUNCH', glyph: '✦', angleDeg: 55, radiusPx: 86, sizePx: 84 },
  { id: 'jump', label: 'JUMP', glyph: '▲', angleDeg: 13, radiusPx: 136, sizePx: 64 },
  { id: 'dash', label: 'DASH', glyph: '»', angleDeg: 89, radiusPx: 136, sizePx: 60 },
  { id: 'interact', label: 'ACT', glyph: '◉', angleDeg: 47, radiusPx: 166, sizePx: 66 },
] as const);

/** Offsets of a slot's CENTRE from the safe-area corner, in CSS px. */
export function thumbArcOffset(slot: IThumbArcSlot): { right: number; bottom: number } {
  const radians = (slot.angleDeg * Math.PI) / 180;
  return {
    right: THUMB_PIVOT_PX + Math.cos(radians) * slot.radiusPx,
    bottom: THUMB_PIVOT_PX + Math.sin(radians) * slot.radiusPx,
  };
}

const STYLE_ID = 'opm-input-styles';
const CHARGE_CIRCUMFERENCE = 2 * Math.PI * 45;

function css(tuning: IInputTuning): string {
  // The ring is drawn at the VISUAL radius, not the input radius. Those were
  // the same number once and the ring came out 240px across.
  const ring = tuning.stickBaseRadiusPx * 2;
  const dead = tuning.stickDeadZonePx * 2;
  const inset = tuning.stickFixedInsetPx;
  const idle = clamp01(tuning.stickIdleOpacity);
  return `
/* fixed, not absolute: #ui-root pads itself by the safe-area insets, and an
   absolutely-positioned child would inherit that padding box and double-apply
   them. Fixed pins us to the visual viewport regardless of the mount point. */
.opm-input-root{position:fixed;inset:0;overflow:hidden;touch-action:none;
  pointer-events:auto;z-index:1;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;
  font-family:'Bebas Neue',Inter,system-ui,sans-serif;
  --opm-sa-ovl:0px;--opm-sa-ovr:0px;--opm-sa-ovt:0px;--opm-sa-ovb:0px;
  --opm-sa-l:max(env(safe-area-inset-left,0px),var(--opm-sa-ovl));
  --opm-sa-r:max(env(safe-area-inset-right,0px),var(--opm-sa-ovr));
  --opm-sa-t:max(env(safe-area-inset-top,0px),var(--opm-sa-ovt));
  --opm-sa-b:max(env(safe-area-inset-bottom,0px),var(--opm-sa-ovb));}
.opm-input-root *{box-sizing:border-box;touch-action:none;-webkit-user-select:none;user-select:none}

/* Zero-sized border box whose four borders ARE the resolved safe-area insets.
   Border widths are one of the few properties getComputedStyle resolves to
   used px, so this is how JS reads back a value that only CSS can evaluate:
   'max(env(...), <override>)'. Reading the custom property instead returns the
   unevaluated token stream, and reading the override alone is wrong by exactly
   the notch on every device where env() is the thing that works. */
.opm-sa-probe{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;visibility:hidden;
  border-style:solid;border-color:transparent;
  border-width:var(--opm-sa-t) var(--opm-sa-r) var(--opm-sa-b) var(--opm-sa-l)}

.opm-stick{position:absolute;width:${ring}px;height:${ring}px;
  pointer-events:none;opacity:${idle};transition:opacity .12s ease-out;
  will-change:transform,opacity;contain:layout style}
.opm-stick[data-active='true']{opacity:1}
/* FLOATING: positioned by transform from the top-left, centred by margins, and
   written by sync() every frame the thumb moves the origin. */
.opm-input-root[data-stick='floating'] .opm-stick{left:0;top:0;margin-left:${-ring / 2}px;margin-top:${-ring / 2}px}
/* ANCHORED: CSS owns the position outright and sync() never touches it — an
   inline transform left over from a floating session would outrank this, so
   setTuning() clears it. 'translate(+/-50%,50%)' puts the CENTRE on the offset,
   the same trick .opm-btn uses below. */
.opm-input-root[data-stick='fixed'] .opm-stick{bottom:calc(var(--opm-sa-b) + ${inset}px)}
.opm-input-root[data-stick='fixed'][data-hand='left'] .opm-stick{left:calc(var(--opm-sa-l) + ${inset}px);
  transform:translate(-50%,50%)}
.opm-input-root[data-stick='fixed'][data-hand='right'] .opm-stick{right:calc(var(--opm-sa-r) + ${inset}px);
  transform:translate(50%,50%)}
.opm-stick-base{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(255,210,48,.34);
  background:radial-gradient(circle,rgba(255,210,48,.10) 0%,rgba(255,210,48,.02) 62%,transparent 72%)}
/* The HOME PIP, sized to the dead zone. The knob does not move at all until
   the deflection clears the dead zone, so this marks where centre is once the
   knob has left it; at rest the knob covers it. */
.opm-stick-dead{position:absolute;left:50%;top:50%;width:${dead}px;height:${dead}px;margin-left:${-dead / 2}px;
  margin-top:${-dead / 2}px;border-radius:50%;border:1px dashed rgba(255,255,255,.20)}
.opm-stick-knob{position:absolute;left:50%;top:50%;
  width:${STICK_KNOB_RADIUS_PX * 2}px;height:${STICK_KNOB_RADIUS_PX * 2}px;
  margin-left:${-STICK_KNOB_RADIUS_PX}px;margin-top:${-STICK_KNOB_RADIUS_PX}px;
  border-radius:50%;background:radial-gradient(circle at 38% 32%,#fff6cf,#ffd230 46%,#c9860a 100%);
  box-shadow:0 6px 18px rgba(0,0,0,.55),0 0 22px rgba(255,210,48,.35);will-change:transform}

.opm-buttons{position:absolute;inset:0;pointer-events:none}
.opm-btn{position:absolute;pointer-events:auto;display:flex;flex-direction:column;align-items:center;
  justify-content:center;border-radius:50%;border:2px solid rgba(255,255,255,.30);
  background:radial-gradient(circle at 40% 32%,rgba(255,255,255,.20),rgba(18,22,30,.72) 68%);
  color:#f4f6fb;text-transform:uppercase;letter-spacing:.08em;
  box-shadow:0 8px 22px rgba(0,0,0,.5);
  bottom:calc(var(--opm-sa-b) + var(--opm-by));
  width:var(--opm-bs);height:var(--opm-bs);
  transform:translate(var(--opm-bmx,50%),50%) scale(var(--opm-press,1));
  transition:transform .07s ease-out,border-color .1s,background .1s;will-change:transform}
/* Mirrored by EXPLICIT rules, never by 'direction:rtl'. The arc offsets are
   already corner-relative ('thumbArcOffset'), so swapping the corner is the
   whole job — and 'direction' would have reached inside every button and
   reordered the glyph against its label as a side effect. */
.opm-input-root[data-hand='left'] .opm-btn{right:calc(var(--opm-sa-r) + var(--opm-bx))}
.opm-input-root[data-hand='right'] .opm-btn{left:calc(var(--opm-sa-l) + var(--opm-bx));--opm-bmx:-50%}
.opm-btn[data-down='true']{--opm-press:.9;border-color:rgba(255,210,48,.95);
  background:radial-gradient(circle at 40% 32%,rgba(255,232,150,.55),rgba(60,40,6,.85) 70%)}
.opm-btn[data-hidden='true']{display:none}
.opm-btn-glyph{font-size:calc(var(--opm-bs) * .34);line-height:1}
/* The GLYPH may scale with its button; the WORD may not. Deriving the label
   size from the diameter rendered DASH and JUMP at 9px and 9.6px — a 6.3px cap
   height on a phone held at arm's length, which is decoration, not a label.
   Floored at 10px and capped at 13 so the four buttons read as one set. */
.opm-btn-label{font-size:clamp(10px,calc(var(--opm-bs) * .15),13px);opacity:.95;margin-top:.18em}
.opm-btn[data-id='punch']{border-color:rgba(255,210,48,.55)}
.opm-btn[data-id='interact']{border-color:rgba(120,220,255,.7);color:#d6f4ff}

/* The ring sits OUTSIDE the button rim (negative inset) and is drawn in a
   colour that does not appear on the button itself, so charge state is legible
   with a thumb covering the glyph — which is the only time it matters. */
.opm-charge{position:absolute;inset:-11px;pointer-events:none;transform:rotate(-90deg);opacity:0;
  transition:opacity .1s;overflow:visible}
.opm-charge[data-charging='true']{opacity:1}
.opm-charge circle{fill:none;stroke-linecap:round}
.opm-charge-track{stroke:rgba(6,9,15,.85);stroke-width:7}
/* NOTE: stroke-dashoffset is deliberately NOT declared here. A CSS
   declaration outranks an SVG PRESENTATION ATTRIBUTE, so a rule here would
   silently override every setAttribute('stroke-dashoffset', ...) and freeze
   the ring at empty — it renders wrong while the attribute reads correct,
   which is exactly the kind of bug that survives a DOM assertion. The ring
   is driven by an INLINE STYLE instead, which outranks the stylesheet. */
.opm-charge-fill{stroke:#7ef0ff;stroke-width:7;stroke-dasharray:${CHARGE_CIRCUMFERENCE.toFixed(2)};
  filter:drop-shadow(0 0 6px rgba(126,240,255,.9))}
.opm-charge[data-full='true'] .opm-charge-fill{stroke:#ff5a3c;
  filter:drop-shadow(0 0 11px rgba(255,90,60,.95))}

.opm-prompt{position:absolute;
  bottom:calc(var(--opm-sa-b) + var(--opm-prompt-y,180px));
  transform:translate(var(--opm-bmx,50%),50%);
  padding:.25em .7em;border-radius:999px;background:rgba(10,14,22,.82);
  border:1px solid rgba(120,220,255,.5);color:#d6f4ff;font-size:13px;letter-spacing:.1em;
  text-transform:uppercase;white-space:nowrap;pointer-events:none;display:none}
/* Follows the arc it labels, by the same explicit pair of rules. */
.opm-input-root[data-hand='left'] .opm-prompt{right:calc(var(--opm-sa-r) + var(--opm-prompt-x,150px))}
.opm-input-root[data-hand='right'] .opm-prompt{left:calc(var(--opm-sa-l) + var(--opm-prompt-x,150px));
  --opm-bmx:-50%}
.opm-prompt[data-visible='true']{display:block}
`;
}

/** Handle returned by {@link createTouchOverlay}. */
export interface ITouchOverlay {
  readonly root: HTMLElement;
  /** Resolve a pointer-event target into a `TouchHit`. */
  resolveHit(target: EventTarget | null): TouchHit;
  /** Push the current frame's visual state. Cheap; transforms only. */
  sync(view: ITouchOverlayView): void;
  setSafeArea(insets: SafeAreaInsets): void;
  /**
   * The insets the LAYOUT is actually using: `max(env(...), override)`, read
   * back off the DOM. `TouchCore` anchors the fixed origin on this, so the ring
   * and the origin cannot disagree by the width of a notch. Forces style
   * resolution, so call it on layout changes only — never per frame.
   */
  resolvedSafeArea(): SafeAreaInsets;
  setInteractPrompt(label: string | null): void;
  setTuning(tuning: IInputTuning): void;
  dispose(): void;
}

/** Everything the overlay needs to draw a frame. */
export interface ITouchOverlayView {
  readonly stick: { originX: number; originY: number; x: number; y: number } | null;
  readonly chargeRatio: number;
  readonly charging: boolean;
  readonly buttonDown: Readonly<Record<TouchButtonId, boolean>>;
  readonly dashOn: boolean;
  readonly interactAvailable: boolean;
}

interface ButtonNodes {
  el: HTMLElement;
  charge?: SVGElement;
  chargeFill?: SVGCircleElement;
}

/**
 * Build the overlay DOM under `parent`.
 *
 * Returns `null` when there is no document (Node, workers) so the touch
 * backend can run headless — which is how the unit tests exercise the pointer
 * state machine without a browser.
 */
export function createTouchOverlay(
  parent: HTMLElement,
  tuning: IInputTuning
): ITouchOverlay | null {
  const doc = parent.ownerDocument;
  if (!doc) return null;

  // The stylesheet is shared by id and outlives any single overlay (`dispose()`
  // only removes `root`). Always REGENERATE it: the stick ring and dead-zone
  // circle are baked in from the tuning, so a second overlay created with a
  // different tuning would otherwise draw the first one's ring while `sync()`
  // clamps the knob to the new radius — a knob visibly outside its own ring.
  const existingStyle = doc.getElementById(STYLE_ID);
  const style = existingStyle ?? doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css(tuning);
  if (!existingStyle) doc.head.appendChild(style);

  const root = doc.createElement('div');
  root.className = 'opm-input-root';
  root.setAttribute('data-opm-input', 'root');
  // The two layout switches. Everything positional keys off these, so the
  // whole layout swap is a pair of attribute writes and no reflowing JS.
  root.dataset.stick = tuning.floatingStick ? 'floating' : 'fixed';
  root.dataset.hand = tuning.stickHand;

  /* ---- safe-area probe (see the .opm-sa-probe rule) ---- */
  const saProbe = doc.createElement('i');
  saProbe.className = 'opm-sa-probe';
  saProbe.setAttribute('aria-hidden', 'true');
  root.appendChild(saProbe);

  /* ---- movement stick ---- */
  const stickEl = doc.createElement('div');
  stickEl.className = 'opm-stick';
  stickEl.setAttribute('data-opm-input', 'stick');
  stickEl.dataset.active = 'false';
  const base = doc.createElement('div');
  base.className = 'opm-stick-base';
  const deadEl = doc.createElement('div');
  deadEl.className = 'opm-stick-dead';
  const knob = doc.createElement('div');
  knob.className = 'opm-stick-knob';
  knob.setAttribute('data-opm-input', 'knob');
  stickEl.append(base, deadEl, knob);
  root.appendChild(stickEl);

  /* ---- thumb-arc buttons ---- */
  const buttonLayer = doc.createElement('div');
  buttonLayer.className = 'opm-buttons';
  const nodes = new Map<TouchButtonId, ButtonNodes>();

  for (const slot of THUMB_ARC) {
    const offset = thumbArcOffset(slot);
    const el = doc.createElement('div');
    el.className = 'opm-btn';
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', slot.label);
    el.dataset.id = slot.id;
    el.dataset.down = 'false';
    el.dataset.opmButton = slot.id;
    el.style.setProperty('--opm-bx', `${offset.right.toFixed(1)}px`);
    el.style.setProperty('--opm-by', `${offset.bottom.toFixed(1)}px`);
    el.style.setProperty('--opm-bs', `${slot.sizePx}px`);
    if (slot.id === 'interact') el.dataset.hidden = 'true';

    const glyph = doc.createElement('span');
    glyph.className = 'opm-btn-glyph';
    glyph.textContent = slot.glyph;
    const label = doc.createElement('span');
    label.className = 'opm-btn-label';
    label.textContent = slot.label;
    el.append(glyph, label);

    const entry: ButtonNodes = { el };

    if (slot.id === 'punch') {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'opm-charge');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('data-charging', 'false');
      const track = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
      track.setAttribute('class', 'opm-charge-track');
      track.setAttribute('cx', '50');
      track.setAttribute('cy', '50');
      track.setAttribute('r', '45');
      const fill = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
      fill.setAttribute('class', 'opm-charge-fill');
      fill.setAttribute('cx', '50');
      fill.setAttribute('cy', '50');
      fill.setAttribute('r', '45');
      // Inline style, not a presentation attribute — see the CSS note above.
      fill.style.strokeDashoffset = String(CHARGE_CIRCUMFERENCE);
      svg.append(track, fill);
      el.appendChild(svg);
      entry.charge = svg;
      entry.chargeFill = fill;
    }

    buttonLayer.appendChild(el);
    nodes.set(slot.id, entry);
  }
  root.appendChild(buttonLayer);

  /* ---- context prompt ---- */
  const interactSlot = THUMB_ARC.find((s) => s.id === 'interact');
  const promptEl = doc.createElement('div');
  promptEl.className = 'opm-prompt';
  promptEl.dataset.visible = 'false';
  promptEl.setAttribute('data-opm-input', 'prompt');
  if (interactSlot) {
    const offset = thumbArcOffset(interactSlot);
    promptEl.style.setProperty('--opm-prompt-x', `${offset.right.toFixed(1)}px`);
    promptEl.style.setProperty(
      '--opm-prompt-y',
      `${(offset.bottom + slotRadius(interactSlot) + 22).toFixed(1)}px`
    );
  }
  root.appendChild(promptEl);

  parent.appendChild(root);

  /* ---- live state, so `sync` only touches the DOM when something changed -- */
  let lastStickActive: boolean | null = null;
  let lastOriginX = Number.NaN;
  let lastOriginY = Number.NaN;
  let lastKnobX = Number.NaN;
  let lastKnobY = Number.NaN;
  let lastCharge = -1;
  let lastCharging: boolean | null = null;
  let lastFull: boolean | null = null;
  let activeTuning = tuning;
  const lastDown: Record<string, boolean | null> = {};

  const win = doc.defaultView;

  /** The resolved insets, off the probe's border widths. */
  function readSafeArea(): SafeAreaInsets {
    if (!win?.getComputedStyle) return ZERO_SAFE_AREA;
    const style = win.getComputedStyle(saProbe);
    const px = (value: string): number => {
      const n = Number.parseFloat(value);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    return {
      top: px(style.borderTopWidth),
      right: px(style.borderRightWidth),
      bottom: px(style.borderBottomWidth),
      left: px(style.borderLeftWidth),
    };
  }

  /**
   * Park the FLOATING ring on the anchored layout's home position.
   *
   * Without this an idle floating stick paints at (0,0) — the top-left corner —
   * because `sync()` only ever wrote the origin transform while a finger was
   * down. That was invisible for as long as the ring was invisible at rest, and
   * became a bug the moment it was not. Idle is drawn at the same place the
   * anchored layout keeps it, so switching the setting moves the ring rather
   * than teleporting it.
   */
  function parkFloatingStick(): void {
    if (!activeTuning.floatingStick || !win) return;
    const home = fixedStickAnchor(activeTuning, win.innerWidth, win.innerHeight, readSafeArea());
    stickEl.style.transform = `translate3d(${home.x.toFixed(1)}px,${home.y.toFixed(1)}px,0)`;
    lastOriginX = home.x;
    lastOriginY = home.y;
  }
  parkFloatingStick();

  return {
    root,

    resolveHit(target: EventTarget | null): TouchHit {
      if (!target || !(target instanceof Element)) return null;
      const el = target.closest<HTMLElement>('[data-opm-button]');
      const id = el?.dataset.opmButton as TouchButtonId | undefined;
      if (!id) return null;
      if (el?.dataset.hidden === 'true') return null;
      return { kind: 'button', button: id };
    },

    sync(view: ITouchOverlayView): void {
      /* stick */
      const active = view.stick !== null;
      if (active !== lastStickActive) {
        stickEl.dataset.active = active ? 'true' : 'false';
        lastStickActive = active;
        if (!active) {
          // The knob has to be re-centred explicitly now. It never was before,
          // because the whole control faded to `opacity:0` on release and the
          // stale transform was invisible; a stick that is visible at rest
          // would instead sit there permanently deflected, reading as a
          // character walking into a wall.
          knob.style.transform = 'translate3d(0px,0px,0)';
          lastKnobX = 0;
          lastKnobY = 0;
          // A released floating stick goes home rather than being abandoned
          // wherever the thumb happened to stop. Idle now means "here is the
          // control", and it should be the same "here" every time.
          parkFloatingStick();
        }
      }
      if (view.stick) {
        const { originX, originY, x, y } = view.stick;
        // ANCHORED: the ring's position belongs to CSS. Writing a transform
        // here would drag the whole control off its anchor the first time a
        // thumb landed anywhere but dead centre.
        if (activeTuning.floatingStick && (originX !== lastOriginX || originY !== lastOriginY)) {
          stickEl.style.transform = `translate3d(${originX.toFixed(1)}px,${originY.toFixed(1)}px,0)`;
          lastOriginX = originX;
          lastOriginY = originY;
        }
        // The knob moves in RING space, not in input space. Deflection is
        // normalised by `stickFullDeflectionPx` (92) and then re-scaled onto
        // the travel the artwork actually has (`stickBaseRadiusPx` less the
        // knob's own radius, 41). Clamping the raw pixel delta instead — which
        // is what this did while the two radii were the same number — sends the
        // knob 92px out of a 76px ring and leaves it hanging outside its base.
        const dx = x - originX;
        const dy = y - originY;
        const distance = Math.hypot(dx, dy);
        const dead = activeTuning.stickDeadZonePx;
        const span = Math.max(activeTuning.stickFullDeflectionPx - dead, 1e-6);
        // Deliberately the SAME dead-zoned fraction gameplay receives (see
        // `radialDeflection`): a knob off centre now means the character is
        // moving. The old ring showed deflection the input layer was throwing
        // away, which is precisely how "the stick moves but nothing happens"
        // gets reported as a broken game.
        const fraction = clamp01((distance - dead) / span);
        const travel = fraction > 0 ? (stickKnobTravelPx(activeTuning) * fraction) / distance : 0;
        const kx = dx * travel;
        const ky = dy * travel;
        if (kx !== lastKnobX || ky !== lastKnobY) {
          knob.style.transform = `translate3d(${kx.toFixed(1)}px,${ky.toFixed(1)}px,0)`;
          lastKnobX = kx;
          lastKnobY = ky;
        }
      }

      /* buttons */
      for (const slot of THUMB_ARC) {
        const entry = nodes.get(slot.id);
        if (!entry) continue;
        const down =
          view.buttonDown[slot.id] === true || (slot.id === 'dash' && view.dashOn === true);
        if (lastDown[slot.id] !== down) {
          entry.el.dataset.down = down ? 'true' : 'false';
          lastDown[slot.id] = down;
        }
      }

      /* charge ring */
      const punch = nodes.get('punch');
      if (punch?.charge && punch.chargeFill) {
        const ratio = clamp01(view.chargeRatio);
        if (view.charging !== lastCharging) {
          punch.charge.setAttribute('data-charging', view.charging ? 'true' : 'false');
          lastCharging = view.charging;
        }
        const full = ratio >= 0.999;
        if (full !== lastFull) {
          punch.charge.setAttribute('data-full', full ? 'true' : 'false');
          lastFull = full;
        }
        if (Math.abs(ratio - lastCharge) > 0.005) {
          punch.chargeFill.style.strokeDashoffset = (CHARGE_CIRCUMFERENCE * (1 - ratio)).toFixed(2);
          lastCharge = ratio;
        }
      }
    },

    setSafeArea(insets: SafeAreaInsets): void {
      root.style.setProperty('--opm-sa-ovl', `${Math.max(0, insets.left)}px`);
      root.style.setProperty('--opm-sa-ovr', `${Math.max(0, insets.right)}px`);
      root.style.setProperty('--opm-sa-ovt', `${Math.max(0, insets.top)}px`);
      root.style.setProperty('--opm-sa-ovb', `${Math.max(0, insets.bottom)}px`);
      // The idle home moves with the corner it is measured from.
      parkFloatingStick();
    },

    resolvedSafeArea(): SafeAreaInsets {
      return readSafeArea();
    },

    setInteractPrompt(label: string | null): void {
      const entry = nodes.get('interact');
      if (entry) entry.el.dataset.hidden = label === null ? 'true' : 'false';
      promptEl.dataset.visible = label === null ? 'false' : 'true';
      if (label !== null) promptEl.textContent = label;
    },

    setTuning(next: IInputTuning): void {
      activeTuning = next;
      const style = doc.getElementById(STYLE_ID);
      if (style) style.textContent = css(next);
      root.dataset.stick = next.floatingStick ? 'floating' : 'fixed';
      root.dataset.hand = next.stickHand;
      // An inline `transform` written by a previous FLOATING session outranks
      // the stylesheet, so switching to the anchored layout without clearing it
      // would leave the ring frozen wherever the last drag ended — a fixed
      // stick pinned to the wrong fixed place. Clearing it is also what lets
      // the `[data-stick='fixed']` rule's own `translate(±50%,50%)` apply.
      stickEl.style.transform = '';
      lastOriginX = Number.NaN;
      lastOriginY = Number.NaN;
      parkFloatingStick();
    },

    dispose(): void {
      root.remove();
    },
  };
}

function slotRadius(slot: IThumbArcSlot): number {
  return slot.sizePx / 2;
}
