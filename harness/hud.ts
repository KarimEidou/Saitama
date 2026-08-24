/**
 * HUD HARNESS
 *
 * Builds the real HUD, the real input overlay and a synthetic game frame, then
 * exposes `window.__HUD_HARNESS__` for Playwright to drive.
 *
 * ── WHAT THIS PAGE IS FOR ──────────────────────────────────────────────────
 * Five claims about `src/ui/hud/**` cannot be made in a unit test, because
 * they are claims about a browser:
 *
 *   1. LAYOUT DISCIPLINE. That the 60 Hz path writes only custom properties,
 *      performs no layout READS, and shifts nothing. The page instruments
 *      `CSSStyleDeclaration.prototype.setProperty`, every layout-triggering
 *      property setter, and every layout-reading accessor, then runs a scripted
 *      60 Hz animation and reports what was touched. There is nowhere for a
 *      stray `element.style.width = …` to hide.
 *
 *   2. SAFE AREA. That nothing readable sits under a notch or a home
 *      indicator. `env(safe-area-inset-*)` cannot be forced from Playwright, so
 *      the harness drives the HUD's programmatic override and measures every
 *      panel's rectangle against the resulting safe box.
 *
 *   3. THUMBS. That nothing readable sits under a hand. The page mounts the
 *      real `src/ui/input` overlay and reads its OWN exported arc geometry, so
 *      the reserve the HUD respects is checked against the buttons that
 *      actually exist rather than against a number copied into a comment.
 *
 *   4. HIT OWNERSHIP. That the controls actually RECEIVE the touches aimed at
 *      them. A stick drawn perfectly and hit-tested by something else is broken
 *      in a way no screenshot can show, so the page samples
 *      `elementFromPoint` over the arc and the stick band and reports anything
 *      that answered instead of `.opm-input-root`.
 *
 *   5. STACKING. That the HUD paints ABOVE the controls, as it does in the
 *      shipping page. That is a property of mount points and z-indices spread
 *      across two stylesheets and a bootstrap, and this page reproduces it
 *      rather than approximating it — see the mount comment below.
 *
 * ── THE BACKDROP IS NOT DECORATION ─────────────────────────────────────────
 * A HUD screenshotted on flat black always looks readable. This one is drawn
 * over a dusk street with a lit skyline, a crowd and a monster silhouette,
 * because the only interesting question about a combat HUD is whether you can
 * still see the fight.
 */

import '@/ui/hud/fonts';
import { hudFontsReady } from '@/ui/hud/fonts';
import * as THREE from 'three';
import { createEventBus, type EventBus } from '@/util';
import type { IEventBus, SafeAreaInsets, ThreatTier } from '@/types';
import {
  EDGE_FLOOR_PX,
  HudManager,
  MarkerLayer,
  NOTCHED_PORTRAIT_INSETS,
  STICK_RESERVE_PX,
  THUMB_RESERVE_PX,
  rotateInsets,
  type IHudSettings,
  type IQuestRow,
  type IRivalRow,
} from '@/ui/hud';
import {
  DEFAULT_INPUT_TUNING,
  THUMB_ARC,
  THUMB_PIVOT_PX,
  createTouchOverlay,
  fixedStickAnchor,
  isStickZone,
  resolveTuning,
  thumbArcOffset,
  type IInputTuning,
} from '@/ui/input';

/* -------------------------------------------------------------------------- */
/* Instrumentation — installed BEFORE the HUD exists                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything a frame is allowed to have touched.
 *
 * `setProperty` is a single function, so wrapping it catches every write the
 * HUD makes. The individual CSS property SETTERS on `CSSStyleDeclaration` are
 * accessor properties on the prototype, so those can be wrapped too — which is
 * what catches a direct `el.style.width = '10px'` that would otherwise slip
 * past a `setProperty`-only probe.
 */
interface IWriteProbe {
  /** Every property name written through `setProperty`, deduplicated. */
  readonly properties: Set<string>;
  /** Writes to a layout-affecting property by direct assignment. */
  readonly directWrites: string[];
  /** Layout READS: the thing that turns a write into a forced reflow. */
  readonly reads: string[];
  /** Total `setProperty` calls. */
  count: number;
  enabled: boolean;
}

const probe: IWriteProbe = {
  properties: new Set<string>(),
  directWrites: [],
  reads: [],
  count: 0,
  enabled: false,
};

/**
 * Properties whose assignment invalidates layout.
 *
 * Not exhaustive — it does not need to be. It is the set a HUD would plausibly
 * reach for, and any one of them appearing during the measured window is a
 * failure of the discipline regardless of what else is on the list.
 */
const LAYOUT_WRITE_PROPS = [
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'marginTop',
  'marginLeft',
  'padding',
  'paddingTop',
  'paddingLeft',
  'fontSize',
  'display',
  'position',
  'flex',
  'flexBasis',
  'gridTemplateColumns',
] as const;

/**
 * Accessors whose READ forces the browser to resolve pending layout.
 *
 * They are NOT all declared on the same interface: per CSSOM View, `offset*`
 * lives on `HTMLElement` while `client*`/`scroll*` live on `Element` (which is
 * why an SVG element has no `offsetWidth`). Looking every name up on
 * `Element.prototype` alone silently instruments six of the ten and leaves the
 * four most common reflow triggers unwatched, so the lookup below tries
 * `HTMLElement.prototype` first.
 */
const LAYOUT_READ_PROPS = [
  'offsetWidth',
  'offsetHeight',
  'offsetTop',
  'offsetLeft',
  'clientWidth',
  'clientHeight',
  'clientTop',
  'clientLeft',
  'scrollWidth',
  'scrollHeight',
] as const;

/**
 * Layout accessors the probe could NOT find, and therefore cannot see.
 *
 * Reported in `IMeasurement` rather than swallowed: a silent `continue` here is
 * exactly how "ZERO forced reflows" comes to mean "zero of the reflows we are
 * still watching for".
 */
const uninstrumentedReads: string[] = [];

function installProbe(): void {
  const style = CSSStyleDeclaration.prototype;

  const originalSetProperty = style.setProperty;
  style.setProperty = function (name: string, value: string | null, priority?: string) {
    if (probe.enabled) {
      probe.count++;
      probe.properties.add(name);
    }
    return originalSetProperty.call(this, name, value, priority);
  };

  for (const property of LAYOUT_WRITE_PROPS) {
    const descriptor = Object.getOwnPropertyDescriptor(style, property);
    if (!descriptor?.set || !descriptor.get) continue;
    const { get, set } = descriptor;
    Object.defineProperty(style, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get,
      set(value: string) {
        if (probe.enabled) probe.directWrites.push(property);
        set.call(this, value);
      },
    });
  }

  const originalRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (probe.enabled) probe.reads.push('getBoundingClientRect');
    return originalRect.call(this);
  };

  const originalComputed = window.getComputedStyle;
  window.getComputedStyle = function (element: Element, pseudo?: string | null) {
    if (probe.enabled) probe.reads.push('getComputedStyle');
    return originalComputed.call(window, element, pseudo);
  } as typeof window.getComputedStyle;

  for (const property of LAYOUT_READ_PROPS) {
    const target: object =
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, property) !== undefined
        ? HTMLElement.prototype
        : Element.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (!descriptor?.get) {
      uninstrumentedReads.push(property);
      continue;
    }
    const { get } = descriptor;
    Object.defineProperty(target, property, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get(this: Element) {
        if (probe.enabled) probe.reads.push(property);
        return get.call(this);
      },
    });
  }
}

installProbe();

/* -------------------------------------------------------------------------- */
/* Layout-shift observer                                                      */
/* -------------------------------------------------------------------------- */

interface ILayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

let cumulativeShift = 0;
let shiftBaseline = 0;

try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as ILayoutShiftEntry[]) {
      if (!entry.hadRecentInput) cumulativeShift += entry.value;
    }
  }).observe({ type: 'layout-shift', buffered: true });
} catch {
  // Older engines have no layout-shift entry type. The verifier reports the
  // observer as unavailable rather than silently claiming a zero.
  cumulativeShift = Number.NaN;
}

/* -------------------------------------------------------------------------- */
/* The synthetic game frame                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A street at dusk, drawn on a 2D canvas.
 *
 * Not three: this harness verifies DOM, and standing up a WebGL scene to prove
 * a HUD is legible would add a renderer's worth of failure modes to a test
 * about text. What is needed is a busy, mid-luminance, warm-and-cool frame with
 * high-frequency detail in the corners — which is exactly the case a HUD is
 * hardest to read against, and which a canvas can produce deterministically.
 */
function drawBackdrop(canvas: HTMLCanvasElement): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  /* sky */
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#1b2743');
  sky.addColorStop(0.45, '#4a3450');
  sky.addColorStop(0.72, '#8a4a3a');
  sky.addColorStop(1, '#2a1b1e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  /* sun */
  const sun = ctx.createRadialGradient(
    width * 0.7,
    height * 0.62,
    0,
    width * 0.7,
    height * 0.62,
    height * 0.5
  );
  sun.addColorStop(0, 'rgba(255,190,120,0.55)');
  sun.addColorStop(1, 'rgba(255,190,120,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, width, height);

  /* skyline — deterministic pseudo-random so shots are reproducible */
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  const horizon = height * 0.68;
  for (let layer = 0; layer < 3; layer++) {
    const depth = 1 - layer * 0.28;
    ctx.fillStyle = `rgba(${10 + layer * 6},${12 + layer * 8},${22 + layer * 10},${0.55 + layer * 0.2})`;
    let x = -30;
    while (x < width + 40) {
      const w = 26 + rand() * 62;
      const h = (40 + rand() * 150) * depth;
      ctx.fillRect(x, horizon - h, w, h + 10);
      /* lit windows */
      ctx.fillStyle = `rgba(255,214,140,${0.1 + layer * 0.05})`;
      for (let wy = horizon - h + 8; wy < horizon - 8; wy += 12) {
        for (let wx = x + 5; wx < x + w - 6; wx += 10) {
          if (rand() > 0.62) ctx.fillRect(wx, wy, 4, 6);
        }
      }
      ctx.fillStyle = `rgba(${10 + layer * 6},${12 + layer * 8},${22 + layer * 10},${0.55 + layer * 0.2})`;
      x += w + 6 + rand() * 12;
    }
  }

  /* road */
  const road = ctx.createLinearGradient(0, horizon, 0, height);
  road.addColorStop(0, '#20232c');
  road.addColorStop(1, '#0b0d12');
  ctx.fillStyle = road;
  ctx.fillRect(0, horizon, width, height - horizon);
  ctx.strokeStyle = 'rgba(255,220,150,0.25)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const y = horizon + (height - horizon) * t * t;
    ctx.beginPath();
    ctx.moveTo(width * (0.5 - 0.06 - t * 0.55), y);
    ctx.lineTo(width * (0.5 + 0.06 + t * 0.55), y);
    ctx.stroke();
  }

  /* crowd silhouettes */
  ctx.fillStyle = 'rgba(6,8,12,0.92)';
  for (let i = 0; i < 26; i++) {
    const t = rand();
    const y = horizon + 8 + t * (height - horizon - 20);
    const scale = 0.35 + t * 1.1;
    const x = rand() * width;
    ctx.fillRect(x, y - 26 * scale, 8 * scale, 26 * scale);
    ctx.beginPath();
    ctx.arc(x + 4 * scale, y - 29 * scale, 4 * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  /* the monster — a silhouette with a rim light, centred so the HUD has to
     work AROUND it rather than over empty sky */
  const mx = width * 0.5;
  const my = horizon + 14;
  const s = Math.min(width, height) * 0.34;
  ctx.save();
  ctx.translate(mx, my);
  ctx.fillStyle = 'rgba(4,5,9,0.96)';
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, 0);
  ctx.lineTo(-s * 0.34, -s * 0.9);
  ctx.lineTo(-s * 0.1, -s * 0.72);
  ctx.lineTo(0, -s * 1.15);
  ctx.lineTo(s * 0.12, -s * 0.72);
  ctx.lineTo(s * 0.36, -s * 0.92);
  ctx.lineTo(s * 0.5, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,140,90,0.75)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,90,60,0.95)';
  ctx.beginPath();
  ctx.arc(-s * 0.12, -s * 0.72, s * 0.045, 0, Math.PI * 2);
  ctx.arc(s * 0.12, -s * 0.72, s * 0.045, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  /* dust motes, so the frame has high-frequency detail in the corners */
  for (let i = 0; i < 90; i++) {
    const x = rand() * width;
    const y = rand() * height;
    ctx.fillStyle = `rgba(255,200,150,${0.05 + rand() * 0.13})`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The quest catalogue, as the HUD sees it.
 *
 * MIRRORED from `src/gameplay/progression/quest-defs.ts` rather than imported:
 * the HUD's contract is `IQuestRow`, and a harness that imported the quest
 * system would be testing the quest system's ability to produce rows instead of
 * the HUD's ability to draw them. The two that matter are here — the tunnel
 * evacuation, which is the urgent case, and the supermarket, which is the whole
 * design.
 */
const QUESTS: readonly IQuestRow[] = [
  {
    id: 'quest.rescue.tunnel',
    title: 'Route 7 Tunnel Collapse',
    description: 'Nine commuters are inside. The far section will not hold.',
    state: 'active',
    tier: 'wolf',
    errand: false,
    rewardPoints: 90,
    timeLimitSeconds: 150,
    timeRemaining: 38,
    objectives: [
      {
        id: 'tunnel.reach',
        description: 'Reach the tunnel mouth',
        current: 1,
        required: 1,
        complete: true,
        hidden: false,
      },
      {
        id: 'tunnel.rescue',
        description: 'Carry the trapped commuters out',
        current: 6,
        required: 9,
        complete: false,
        hidden: false,
      },
    ],
  },
  {
    id: 'quest.errand.bargain',
    title: 'Bargain Sale — Shopping District J',
    description: 'Ground beef is thirty percent off until six. Not Association business.',
    state: 'active',
    tier: 'wolf',
    errand: true,
    rewardPoints: 0,
    timeLimitSeconds: 660,
    timeRemaining: 411,
    conflictsWith: ['quest.subjugation.mosquito'],
    objectives: [
      {
        id: 'bargain.reach',
        description: 'Get to the supermarket',
        current: 0,
        required: 1,
        complete: false,
        hidden: false,
      },
      {
        id: 'bargain.buy',
        description: 'Buy: ground beef, cabbage, eggs, strawberries',
        current: 1,
        required: 4,
        complete: false,
        hidden: false,
      },
    ],
  },
  {
    id: 'quest.subjugation.mosquito',
    title: 'Subjugation Request: Mosquito Girl',
    description: 'Every animal in C-City has been drained. The swarm is being directed.',
    state: 'available',
    tier: 'demon',
    errand: false,
    rewardPoints: 240,
    conflictsWith: ['quest.errand.bargain'],
    objectives: [
      {
        id: 'mosquito.swarm',
        description: 'Thin the swarm',
        current: 0,
        required: 40,
        complete: false,
        hidden: false,
      },
      {
        id: 'mosquito.boss',
        description: 'Defeat Mosquito Girl',
        current: 0,
        required: 1,
        complete: false,
        hidden: false,
      },
    ],
  },
  {
    id: 'quest.duty.quota',
    title: 'C-Class Duty Quota',
    description: 'Resolve three incidents. It does not matter how well.',
    state: 'active',
    tier: 'wolf',
    errand: false,
    rewardPoints: 45,
    objectives: [
      {
        id: 'quota.incidents',
        description: 'Resolve reported incidents',
        current: 1,
        required: 3,
        complete: false,
        hidden: false,
      },
    ],
  },
  {
    id: 'quest.boss.asteroid',
    title: 'Absolute Emergency: Meteor over Z-City',
    description: 'A class-god object will strike in four minutes. There is no plan.',
    state: 'available',
    tier: 'god',
    errand: false,
    rewardPoints: 2200,
    timeLimitSeconds: 240,
    objectives: [
      {
        id: 'asteroid.destroy',
        description: 'Destroy the meteor',
        current: 0,
        required: 1,
        complete: false,
        hidden: false,
      },
    ],
  },
  {
    id: 'quest.subjugation.crablante',
    title: 'Subjugation Request: Crablante',
    description: 'A mutated crab is asking passers-by whether they have seen a bald man.',
    state: 'completed',
    tier: 'tiger',
    errand: false,
    rewardPoints: 60,
    objectives: [
      {
        id: 'crablante.defeat',
        description: 'Defeat Crablante',
        current: 1,
        required: 1,
        complete: true,
        hidden: false,
      },
    ],
  },
];

/**
 * The ladder, as `RivalTracker.snapshot()` would produce it.
 *
 * Mirrored for the same reason as the quests, and with the same numbers the
 * rival system actually uses: Genos at S-17 with a 2.4x credit multiplier, and
 * off-screen progress that keeps running while the player is shopping.
 */
const RIVALS: readonly IRivalRow[] = [
  {
    id: 'genos',
    displayName: 'Demon Cyborg',
    heroClass: 'S',
    rank: 16,
    seatsAbovePlayer: 1387,
    sharedCredit: 288,
    offscreenCredit: 96,
    jointIncidents: 2,
    moved: 'up',
  },
  {
    id: 'tank',
    displayName: 'Tanktop Master',
    heroClass: 'B',
    rank: 1,
    seatsAbovePlayer: 687,
    sharedCredit: 0,
    offscreenCredit: 42,
    jointIncidents: 0,
  },
  {
    id: 'mumen',
    displayName: 'Mumen Rider',
    heroClass: 'C',
    rank: 1,
    seatsAbovePlayer: 387,
    sharedCredit: 26,
    offscreenCredit: 18,
    jointIncidents: 1,
  },
];

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** The scripted states Playwright can jump to. */
export type HarnessScene =
  | 'loading'
  | 'idle'
  | 'combat'
  | 'combat-alert'
  | 'combat-charging'
  | 'combat-bored'
  | 'combat-boss'
  | 'quests'
  | 'rank'
  | 'results'
  | 'pause'
  | 'settings'
  | 'markers';

interface IHarnessApi {
  ready: boolean;
  scene(name: HarnessScene): void;
  setViewport(insets: Partial<SafeAreaInsets>): void;
  setSettings(patch: Partial<IHudSettings>): void;
  setOverlays(on: boolean): void;
  /** Advance the HUD by `frames` at exactly 1/60 s each. */
  step(frames: number): void;
  /** Run the layout-thrash measurement over a scripted animation. */
  measure(frames: number): IMeasurement;
  /** Rectangles of every HUD panel, for the safe-area assertion. */
  panels(): IPanelRect[];
  /** The input overlay's own geometry, read from its exported constants. */
  inputGeometry(): IInputGeometry;
  /** Who owns the touch at every point the thumbs actually reach. */
  hitOwnership(): IHitOwnership;
  /** Whether the controls mount and stack the way the shipping page does. */
  mountParity(): IMountParity;
  /** The top band's declared budget against the row it actually holds. */
  bandBudget(): IBandBudget;
  /** Whatever the HUD currently believes. */
  snapshot(): Record<string, unknown>;
  back(): boolean;
  activeScreen(): string;
  press(selector: string): boolean;
}

interface IMeasurement {
  frames: number;
  /** Every CSS property name written through `setProperty`. */
  properties: string[];
  /** Names that are NOT custom properties. Must be empty. */
  offending: string[];
  /** Direct assignments to a layout-affecting property. Must be empty. */
  directWrites: string[];
  /** Layout reads during the window. Must be empty. */
  reads: string[];
  /**
   * Accessors in `LAYOUT_READ_PROPS` that could not be instrumented at all.
   * Must be empty, or the read half of the claim has holes in it.
   */
  uninstrumentedReads: string[];
  /** Cumulative layout shift accrued during the window. Must be 0. */
  layoutShift: number;
  /** Whether the layout-shift observer is available at all. */
  layoutShiftObserved: boolean;
  setPropertyCalls: number;
  /** Writes the FrameWriter actually made vs. skipped as unchanged. */
  writerWrites: number;
  writerSkipped: number;
}

interface IPanelRect {
  id: string;
  /**
   * What kind of box this is.
   *
   * `panel` is laid-out HUD chrome — the HUD decides where it goes, so every
   * placement claim applies to it. `marker` is a world-space pin whose position
   * comes from projecting a world point through the camera; it obeys the safe
   * box (via `.hud-markers`'s clip-path) but nothing can keep it out of a
   * thumb's quadrant without detaching it from the thing it points at.
   */
  kind: 'panel' | 'marker';
  screen: string;
  /**
   * The box's position in the DOM, as an index chain relative to `.hud-root` —
   * `"0/2/1"` is "third child of the first child of the HUD root".
   *
   * Rectangles alone cannot tell an OVERLAP from the SAME BOX REPORTED TWICE.
   * The query below matches an alert as both its `[data-hud="alerts"]`
   * container and its `.hud-alert` child, and those two rects agree to the
   * pixel — so a pair-wise overlap check without a DOM relation opens by
   * accusing the alert layer of painting on itself. The chain gives every rect
   * an ancestry the check can test (one path is a prefix of the other, compared
   * SEGMENT-WISE — `"0/1"` is not an ancestor of `"0/11"`), and it costs the
   * report nothing but a short string that also makes it far easier to read.
   */
  path: string;
  /**
   * True when a modal screen is painting over this box.
   *
   * The combat HUD deliberately stays mounted under a pause sheet
   * (`manager.ts` keeps it visible so the fight is still legible behind the
   * scrim), so in every modal scene the whole top band "overlaps" the sheet.
   * That is the stack working, not a layout collision, and an overlap check
   * that reports it drowns the one real failure in twenty invented ones. The
   * manager's own `modal` flag — the same one that decides whether the game
   * clock pauses — is what marks them.
   */
  occluded: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

interface IInputGeometry {
  pivotPx: number;
  slots: { id: string; right: number; bottom: number; size: number; reach: number }[];
  maxReach: number;
  hudReserve: number;
  stickReserve: number;
}

/** One `elementFromPoint` probe and whatever answered it. */
interface IHitSample {
  /** What was being sampled: `stick-anchor`, `slot:punch`, `grid`. */
  label: string;
  x: number;
  y: number;
  /** A readable description of the element that took the touch. */
  owner: string;
}

interface IHitOwnership {
  /** Bounding box of the lattice points actually probed, in viewport px. */
  zone: { x: number; y: number; width: number; height: number };
  sampled: number;
  /** Probes the input overlay did NOT own. Must be empty. */
  stolen: IHitSample[];
}

/** Where the touch overlay is mounted, and how it stacks against the HUD. */
interface IMountParity {
  /** Description of `.opm-input-root`'s parent. */
  inputParent: string;
  parentIsBody: boolean;
  /** Both roots must be siblings, or comparing their z-indices proves nothing. */
  siblings: boolean;
  inputZIndex: number;
  uiZIndex: number;
  /** The hit-test chain at a HUD button, topmost first. */
  probe: string[];
  /** Empirical: where both roots cover a point, the HUD answers first. */
  hudAbove: boolean;
}

/** The top band's declared height budget, measured against what it holds. */
interface IBandBudget {
  /** `--hud-band-row` in px, or null when the HUD declares no budget. */
  declared: number | null;
  /** The raw token, so an unparseable declaration is visible, not silently skipped. */
  declaredRaw: string;
  /** `--hud-gap`, the slack the grid itself puts between the rows. */
  gap: number;
  /** Bottom edge of the lowest panel that starts in the band's FIRST row. */
  rowOneBottom: number | null;
  insetTop: number;
  members: string[];
}

declare global {
  interface Window {
    __HUD_HARNESS__?: IHarnessApi;
  }
}

const canvas = document.getElementById('backdrop') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const overlays = document.getElementById('overlays') as HTMLElement;
const banner = document.getElementById('banner') as HTMLElement;

const bus: IEventBus = createEventBus() as EventBus;

/* ── WHERE THE CONTROLS MOUNT, AND WHY IT IS NOT `#ui-root` ─────────────────
   The shipping page stacks three siblings on `document.body`: `#app` (z-index
   auto, holding the canvas), `.opm-input-root` (z-index 1, mounted on
   `document.body` by `src/game/game.ts`), and `#ui-root` (z-index 10). So in
   the real game the HUD paints ABOVE the controls and a modal sheet covers
   them completely.

   This page used to mount the overlay INSIDE `#ui-root`, where
   `.opm-input-root{z-index:1}` beats `.hud-root`'s `auto` and the controls
   paint over every HUD layer — the exact opposite order. The comment that
   stood here claimed that WAS the shipping order. It was not, and the cost of
   believing it is in `docs/screenshots/`: every modal shot showed a punch
   button sitting on top of the sheet, a frame the game cannot produce.

   Mounting on `document.body` is necessary but not sufficient. `#stage` is
   `position:fixed`, and a fixed element ALWAYS establishes a stacking context,
   so `#ui-root` nested inside it cannot out-paint a body-level `z-index:1`
   sibling however large its own z-index is — mounting on the body alone would
   invert the order again, in the other direction. The three overlay layers are
   therefore lifted out of `#stage` first, leaving it holding the backdrop
   canvas alone, which is exactly what `index.html`'s `#app` holds. Paint order
   is then decided by the z-indices the two stylesheets already declare
   (1 < 10 < 60 < 80) rather than by DOM order, which is why the overlay may be
   appended last and still land underneath.

   None of this is taken on trust: `mountParity()` re-derives it from the live
   document and the verifier asserts it. */
for (const layer of [uiRoot, overlays, banner]) document.body.appendChild(layer);
const touch = createTouchOverlay(document.body, DEFAULT_INPUT_TUNING);

/**
 * The tuning the overlay is currently drawn with — the input layer's half of
 * the settings bridge, kept here so `hitOwnership()` asks the same object the
 * controls were built from rather than the module default.
 *
 * It moves in `setSettings`, which is where the bridge lives. Before that
 * existed this was a constant, and the consequence was quiet: the HUD mirrored
 * on `stickHand` and the controls did not, so the harness's own mirrored sweep
 * probed a configuration the game cannot produce.
 */
let currentTuning: IInputTuning = DEFAULT_INPUT_TUNING;

let currentInsets: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
let modalOpen = false;

const hud = new HudManager({
  mount: uiRoot,
  bus,
  loadingLineIndex: 3,
  onModalChange: (modal) => {
    modalOpen = modal;
  },
  onSettingsChange: () => {
    /* the bootstrap would forward these; the harness only needs the HUD half */
  },
});

const markers = new MarkerLayer(document, { labelRange: 160, maxRange: 500 });
hud.root.insertBefore(markers.element, hud.root.firstChild);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
camera.position.set(0, 6, 26);
camera.lookAt(0, 2, 0);

let frameIndex = 0;
let scene: HarnessScene = 'loading';

/* -------------------------------------------------------------------------- */
/* Scene scripts                                                              */
/* -------------------------------------------------------------------------- */

function resetModel(): void {
  hud.store.setInvoice(null);
  hud.store.clearMarkers();
  hud.store.model.alerts = [];
  hud.store.model.encounter = null;
  hud.store.model.rankFeed = [];
  hud.show('hud');
}

function startEncounter(tier: ThreatTier, id: string, boss: boolean): void {
  bus.emit('EncounterStarted', {
    encounterId: id,
    threatTier: tier,
    position: { x: 0, y: 0, z: 0 },
    radius: 40,
    participantIds: [],
    isBoss: boss,
  });
}

function seedRank(boredom: number): void {
  hud.store.setRank({
    heroName: 'Caped Baldy',
    heroClass: 'C',
    rank: 388,
    points: 12.4,
    pointsToNextRank: 33.6,
    rankProgress: 0.27,
    reputation: 41,
    rankGainMultiplier: 1,
  });
  bus.emit('BoredomChanged', { value: boredom, previous: 0, reason: 'trivialVictory' });
  hud.store.setRivals(RIVALS);
  hud.store.setQuests(QUESTS, 'quest.rescue.tunnel');
  for (const movement of [
    { delta: 0, reason: 'incident resolved — unverified', seats: 0 },
    { delta: 12.4, reason: 'civilian rescue, witnessed', seats: 4 },
    { delta: -35, reason: 'reported collateral, Shopping District J', seats: -11 },
    { delta: 0, reason: '212 subjugations, no statement filed', seats: 0 },
  ]) {
    hud.store.model.rankFeed.push({
      id: hud.store.model.rankFeed.length + 1,
      time: 0,
      delta: movement.delta,
      reason: movement.reason,
      heroClass: 'C',
      rank: 388,
      seats: movement.seats,
    });
  }
}

function applyScene(name: HarnessScene): void {
  scene = name;
  resetModel();

  if (name === 'loading') {
    hud.store.setPhase('loading');
    hud.store.setLoading(0.62, 'Baking radiance probes');
    hud.show('boot');
    return;
  }

  hud.store.setPhase('playing');
  seedRank(name === 'combat-bored' ? 0.94 : name === 'combat-boss' ? 0.55 : 0.31);

  switch (name) {
    case 'idle':
      hud.store.setCharge(0, false, 'normal', 0);
      break;

    case 'combat':
    case 'combat-alert':
    case 'combat-charging':
    case 'combat-bored': {
      startEncounter('demon', 'encounter.mosquito', false);
      const encounter = hud.store.model.encounter!;
      encounter.name = 'Mosquito Girl';
      encounter.civiliansSaved = 6;
      encounter.civiliansLost = 2;
      encounter.debrisPieces = 1_412;
      encounter.debrisMassKg = 91_400;
      hud.store.setWitnesses(9);
      hud.store.setCollateral(4.3e9, 0.63);
      // The threat banner and the encounter card BOTH live at top-centre and
      // both appear the instant a fight starts. That is deliberate — for four
      // seconds the banner is the same information, louder — but it means the
      // resting-state shots have to be taken after it has expired, and the
      // banner needs a shot of its own. Hence `combat-alert`.
      hud.store.update(name === 'combat-alert' ? 1.2 : 6.5);
      if (name === 'combat-charging') {
        hud.store.setCharge(0.66, true, 'serious', 1.5e10);
      } else {
        hud.store.setCharge(0, false, 'normal', 0);
      }
      break;
    }

    case 'combat-boss': {
      startEncounter('dragon', 'encounter.deepSeaKing', true);
      const encounter = hud.store.model.encounter!;
      encounter.name = 'Deep Sea King';
      encounter.civiliansSaved = 21;
      encounter.civiliansLost = 0;
      encounter.debrisPieces = 306;
      encounter.debrisMassKg = 22_100;
      hud.store.setWitnesses(34);
      hud.store.setCollateral(9.4e8, 0.28);
      hud.store.setBoss(0.42, 2);
      hud.store.update(72);
      break;
    }

    case 'quests':
      hud.show('hud');
      hud.push('quests');
      break;

    case 'rank':
      hud.show('hud');
      hud.push('rank');
      break;

    case 'pause':
      startEncounter('demon', 'encounter.mosquito', false);
      hud.store.model.encounter!.name = 'Mosquito Girl';
      hud.store.update(6.5);
      hud.push('pause');
      break;

    case 'settings':
      hud.push('settings');
      break;

    case 'results':
      hud.store.setInvoice({
        encounterId: 'encounter.mosquito',
        name: 'Mosquito Girl',
        tier: 'demon',
        victory: true,
        timeToKill: 1.4,
        civiliansSaved: 6,
        civiliansLost: 0,
        alliesSaved: 1,
        alliesDowned: 0,
        propertyDamageYen: 1.5e10,
        propertyDamageScore: 0.86,
        witnessed: 0,
        kills: 41,
        seriousPunches: 1,
        normalPunches: 3,
        longestChain: 3,
        boredomBefore: 0.28,
        boredomAfter: 0.34,
        basePoints: 96,
        awardedPoints: 0,
        rivalCredit: [{ name: 'Demon Cyborg', points: 230.4 }],
        seats: 0,
      });
      break;

    case 'markers': {
      startEncounter('demon', 'encounter.mosquito', false);
      hud.store.model.encounter!.name = 'Mosquito Girl';
      hud.store.setCollateral(4.3e9, 0.63);
      hud.store.setWitnesses(9);
      hud.store.update(6.5);
      hud.store.setMarker({
        id: 'threat.mosquito',
        kind: 'threat',
        label: 'Mosquito Girl',
        tier: 'demon',
        x: 0,
        y: 4,
        z: 0,
      });
      hud.store.setMarker({
        id: 'objective.tunnel',
        kind: 'objective',
        label: 'Route 7 Tunnel',
        x: -14,
        y: 3,
        z: -6,
      });
      hud.store.setMarker({
        id: 'errand.market',
        kind: 'errand',
        label: 'Supermarket — sale ends 18:00',
        x: 15,
        y: 2.5,
        z: -4,
      });
      hud.store.setMarker({
        id: 'civ.7',
        kind: 'civilian',
        label: 'Civilian',
        x: 7,
        y: 1.6,
        z: 8,
      });
      hud.store.setMarker({
        id: 'ally.mumen',
        kind: 'ally',
        label: 'Mumen Rider',
        x: -8,
        y: 1.8,
        z: 6,
      });
      break;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Frame                                                                      */
/* -------------------------------------------------------------------------- */

const FIXED_DT = 1 / 60;

function step(frames: number): void {
  for (let i = 0; i < frames; i++) {
    frameIndex++;
    bus.setFrame(frameIndex, frameIndex * FIXED_DT);

    /* A scripted animation for the measurement window: the boredom meter
       drifting, the charge arc filling, and the fight timer running — i.e. all
       three of the things that move at 60 Hz during real play. */
    if (scene === 'combat-charging' || scene === 'combat') {
      const t = frameIndex * FIXED_DT;
      hud.store.model.boredom = 0.5 + 0.28 * Math.sin(t * 0.9);
      /* The charge arc animates ONLY in `combat-charging`. `combat` is the
         resting fight — `applyScene` zeroed the charge there deliberately, and
         driving it here would photograph every `hud-combat-*.png` mid serious
         punch and leave the most common state in the game unshot. */
      if (scene === 'combat-charging') {
        hud.store.setCharge(
          (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.98,
          true,
          'serious',
          1.5e10 * (Math.sin(t * 1.6) * 0.5 + 0.5)
        );
      }
      const encounter = hud.store.model.encounter;
      if (encounter) {
        encounter.collateralYen = 4.3e9 + 2e9 * (Math.sin(t * 0.7) * 0.5 + 0.5);
        encounter.collateralScore = 0.4 + 0.35 * (Math.sin(t * 0.7) * 0.5 + 0.5);
        encounter.debrisPieces = 1400 + Math.floor(t * 13);
      }
    }
    if (scene === 'loading') {
      hud.store.model.loading.progress = Math.min(
        1,
        hud.store.model.loading.progress + FIXED_DT * 0.08
      );
    }

    hud.update(FIXED_DT);
    /* Unconditional, as the shipping bootstrap does it: `MarkerLayer.update`
       is the ONLY thing that reconciles the marker DOM against the model, so
       gating it on the markers scene left five `CSS2DObject` elements parented
       in `.hud-markers` for the rest of the run — in every screenshot taken
       after it, and in every rectangle `panels()` reported. With an empty
       model it removes what is stale and does nothing else. */
    markers.update(hud.store.model, camera);
  }
}

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  drawBackdrop(canvas);
  markers.setSize(width, height);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}

/* -------------------------------------------------------------------------- */
/* API                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A node's DOM position as an index chain relative to `.hud-root`.
 *
 * Walking `parentElement` and recording each step's index among its siblings
 * produces a string that is a PREFIX of every descendant's string, which is the
 * whole point: an overlap check can then ask "are these two boxes the same box,
 * or one inside the other?" without shipping element references across the
 * `page.evaluate` boundary, where they cannot go. See `IPanelRect.path`.
 */
function domPath(node: HTMLElement): string {
  const segments: number[] = [];
  let current: HTMLElement | null = node;
  while (current !== null && current !== hud.root) {
    const parent: HTMLElement | null = current.parentElement;
    if (parent === null) break;
    segments.push(Array.from(parent.children).indexOf(current));
    current = parent;
  }
  return segments.reverse().join('/');
}

/**
 * Every VISIBLE, PAINTING HUD box, in viewport coordinates.
 *
 * Two exclusions, both of which the safe-area assertion would otherwise report
 * as violations that are not:
 *
 *   FULL-BLEED CONTAINERS. The CSS2D marker host and the HUD root are
 *   transparent boxes that span the viewport by definition. They paint nothing
 *   and cannot be "under the notch"; what could be under the notch is a MARKER,
 *   and those are clipped to the safe box by `.hud-markers`'s clip-path — so
 *   a marker's rect is INTERSECTED with that clip here before it is reported.
 *   `getBoundingClientRect()` is blind to an ancestor's `clip-path`, and
 *   reporting the pre-clip geometry would flag pins the browser never painted.
 *
 *   SCROLLED-OUT ROWS. A settings row below the fold of `.hud-sheet__body`
 *   reports a rect past the bottom of the screen because that is where it is —
 *   inside a scroll container, not under the home indicator. Anything clipped
 *   by its scrolling ancestor is skipped, which is the difference between
 *   measuring the layout and measuring the scroll position. A row that is
 *   PARTLY under the fold gets the same treatment a marker gets: its rect is
 *   intersected with the scroller's, because the half hanging past the fold is
 *   not painted. Reporting the whole box made the last row of the settings
 *   sheet appear to sit on top of the Close button in the foot below it, which
 *   is an artefact of `overflow-y:auto` and not something a player can see.
 */
function panelRects(): IPanelRect[] {
  const out: IPanelRect[] = [];
  const nodes = hud.root.querySelectorAll<HTMLElement>(
    '[data-hud], .hud-panel, .hud-sheet, .hud-btn, .hud-seg__opt, .hud-loading__track, .hud-marker'
  );
  const containers = new Set(['root', 'markers']);
  for (const node of nodes) {
    if (node.hidden) continue;
    if (node.dataset.hud && containers.has(node.dataset.hud)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    let box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };

    const scroller = node.closest<HTMLElement>('.hud-sheet__body');
    if (scroller && scroller !== node) {
      const clip = scroller.getBoundingClientRect();
      box = {
        left: Math.max(box.left, clip.left),
        top: Math.max(box.top, clip.top),
        right: Math.min(box.right, clip.right),
        bottom: Math.min(box.bottom, clip.bottom),
      };
      if (box.right - box.left < 1 || box.bottom - box.top < 1) continue;
    }

    /* A marker is clipped to the safe box by its host's `clip-path`, which
       `getBoundingClientRect()` does not see. Report what is PAINTED. The
       inset is `max(env, override, floor)`, exactly as the stylesheet
       composes it; `env()` is 0 on the harness page. */
    const markerHost = node.closest<HTMLElement>('.hud-markers');
    if (markerHost) {
      const host = markerHost.getBoundingClientRect();
      const clipLeft = host.left + Math.max(currentInsets.left, EDGE_FLOOR_PX);
      const clipTop = host.top + Math.max(currentInsets.top, EDGE_FLOOR_PX);
      const clipRight = host.right - Math.max(currentInsets.right, EDGE_FLOOR_PX);
      const clipBottom = host.bottom - Math.max(currentInsets.bottom, EDGE_FLOOR_PX);
      box = {
        left: Math.max(box.left, clipLeft),
        top: Math.max(box.top, clipTop),
        right: Math.min(box.right, clipRight),
        bottom: Math.min(box.bottom, clipBottom),
      };
      if (box.right - box.left < 1 || box.bottom - box.top < 1) continue;
    }

    const screenRoot = node.closest<HTMLElement>('[data-screen]');
    out.push({
      id: node.dataset.hud ?? node.className.split(' ')[0] ?? 'panel',
      kind: markerHost ? 'marker' : 'panel',
      screen: screenRoot?.dataset.screen ?? hud.active,
      path: domPath(node),
      // Chrome that belongs to the screen itself is never the thing being
      // covered; everything else is, for as long as the screen is up.
      occluded: modalOpen && screenRoot === null,
      x: box.left,
      y: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
      text: (node.textContent ?? '').trim().slice(0, 60),
    });
  }
  return out;
}

/** `div#ui-root.hud-root` — enough to recognise a thief in a failure line. */
function describeElement(element: Element | null): string {
  if (element === null) return 'nothing';
  const id = element.id === '' ? '' : `#${element.id}`;
  const classes = element.classList.length === 0 ? '' : `.${[...element.classList].join('.')}`;
  return `${element.tagName.toLowerCase()}${id}${classes}`;
}

/** Spacing of the sampling lattice over the stick band, CSS px. */
const HIT_GRID_PX = 40;

/**
 * WHO OWNS THE TOUCH — the check that would have caught the joystick bug.
 *
 * A control that is drawn correctly and does not RECEIVE the touch is broken in
 * a way no screenshot and no rectangle assertion can see: the pixels are right
 * in both. What decides it is hit testing, and hit testing is decided by
 * `pointer-events`, stacking order and mount point — three things spread across
 * two stylesheets and a bootstrap, none of which the layout claims cover.
 *
 * So this asks the browser directly, at the points a thumb actually lands: the
 * stick's resting anchor, every button centre on the arc, and a lattice over
 * the whole band `TouchCore` treats as stick input. Every one of them must
 * resolve into `.opm-input-root`. A HUD panel that forgot `pointer-events:none`,
 * a screen left mounted full-bleed after a dismiss, a z-order inversion — all
 * three show up here as the same failure, with the thief named.
 *
 * The geometry is READ FROM THE INPUT LAYER's own exports rather than copied,
 * for the same reason the thumb-reserve assertion reads them: a retuned arc must
 * fail this test, not quietly move out from under it.
 *
 * ── NOTHING HERE DESCRIBES A SHAPE ANY MORE ────────────────────────────────
 * This used to carry a note ending "if `isStickZone` and `fixedStickAnchor`
 * ever reach the barrel, delete the two derivations below and call them". They
 * have (`src/ui/input/index.ts` exports the whole of `stick-geometry.ts`), and
 * they are called. Two hand-written shapes went with them:
 *
 *   THE ANCHOR was probed one full deflection in from the bottom-left safe
 *   corner, under a comment saying the stick FLOATS and has no fixed origin.
 *   `DEFAULT_INPUT_TUNING.floatingStick` is `false` — the anchored ring is what
 *   ships — so that probed a point the ring is not at, in a corner the ring
 *   need not be in. `fixedStickAnchor` answers both questions, hand included.
 *
 *   THE BAND was `width * stickZoneFraction`, full height, pinned to the LEFT
 *   edge, and it over-claimed in two directions at once. It missed the widening
 *   `isStickZone` applies so the ring's own artwork cannot fall outside its
 *   zone; and its full height asserted that the stick band's top belongs to the
 *   controls, which is the opposite of what `stickZoneTopFraction` exists to
 *   say — the top of the screen is handed BACK to the camera and to the HUD, and
 *   `[data-hud="pause-button"]`, `[data-hud="quest-log-button"]` and the tracker
 *   plate are HUD controls that are SUPPOSED to take a touch up there. That
 *   over-claim passed only by luck of position: those three sit in the top
 *   RIGHT and the band was nailed to the left. Point the band at the right-hand
 *   layout the settings screen can now produce and it lands squarely on all
 *   three. So the band is `isStickZone`'s answer, whole — width, height and
 *   hand — and it is the same claim on both hands.
 *
 * Every point is now the input layer's own arithmetic. What is still chosen
 * here is one bit: WHICH CORNER the arc hangs off, because `thumbArcOffset`
 * reports a corner-relative offset and the corner is picked by the
 * `[data-hand]` rules in `touch-overlay.ts`, not by an exported function.
 */
function hitOwnership(): IHitOwnership {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const stolen: IHitSample[] = [];
  let sampled = 0;

  const probe = (label: string, x: number, y: number): void => {
    // `elementFromPoint` answers null outside the viewport, which would read as
    // a stolen touch. Clamp instead: the edge pixel is a real place to press.
    const px = Math.min(Math.max(x, 0), width - 1);
    const py = Math.min(Math.max(y, 0), height - 1);
    sampled++;
    const element = document.elementFromPoint(px, py);
    if (element?.closest('.opm-input-root')) return;
    stolen.push({ label, x: Math.round(px), y: Math.round(py), owner: describeElement(element) });
  };

  /* The anchor — the ring's painted centre, which is also the origin a thumb
     landing on it reads from. `fixedStickAnchor` measures it from the SAFE-AREA
     corner and picks the corner from `stickHand`, so this follows the setting
     instead of being nailed to the bottom left. It is the single most expensive
     point on the display to lose to a HUD panel. */
  const anchor = fixedStickAnchor(currentTuning, width, height, currentInsets);
  probe('stick-anchor', anchor.x, anchor.y);

  /* Button centres. `.opm-btn` is offset from the safe corner and then pulled
     back by `translate(50%,50%)`, so the centre lands exactly on the arc offset
     — the same number `inputGeometry()` reports. The arc hangs off the hand
     OPPOSITE the stick: `[data-hand='right']` trades `.opm-btn`'s `right` for a
     `left`, so the CORNER swaps with the setting while every distance stays
     `thumbArcOffset`'s. */
  const arcFromLeftEdge = currentTuning.stickHand === 'right';
  for (const slot of THUMB_ARC) {
    const offset = thumbArcOffset(slot);
    probe(
      `slot:${slot.id}`,
      arcFromLeftEdge
        ? currentInsets.left + offset.right
        : width - currentInsets.right - offset.right,
      height - currentInsets.bottom - offset.bottom
    );
  }

  /* The band: every lattice point `isStickZone` claims.
     The WHOLE viewport is swept and the predicate filters it, rather than a
     rectangle being derived and swept — the zone is a rectangle today, but the
     day it stops being one (the ring's artwork already widens it on a narrow
     phone) a derived rectangle would quietly stop covering it. Insets are
     passed because a touch on the notch strip still drives the character, and
     the anchor the zone is widened around moves with them. */
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let x = 0; x < width; x += HIT_GRID_PX) {
    for (let y = 0; y < height; y += HIT_GRID_PX) {
      if (!isStickZone(x, y, width, height, currentTuning, currentInsets)) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      probe('grid', x, y);
    }
  }

  /* Reported as the box the lattice actually covered rather than as the zone's
     own bounds. The two differ by up to one grid step at each edge, and it is
     the probed box a human needs when they go looking for a stolen point. An
     empty sweep reports a zero box, which is what `sampled` in the verifier's
     floor check is there to catch. */
  const zone = Number.isFinite(left)
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : { x: 0, y: 0, width: 0, height: 0 };

  return { zone, sampled, stolen };
}

/**
 * Does this page stack the controls and the HUD the way the shipping page does?
 *
 * Two answers, because either alone can be satisfied while the frame is still
 * wrong. The STRUCTURAL half re-derives the mount point and the two z-indices,
 * and only means anything when the roots are siblings — a z-index comparison
 * across stacking contexts is worth nothing, which is the trap that made the
 * old mount look correct. The EMPIRICAL half asks the browser: at the centre of
 * a HUD button, both roots are under the point, so whichever the hit-test chain
 * names first is the one painting on top.
 */
function mountParity(): IMountParity {
  const inputRoot = document.querySelector<HTMLElement>('.opm-input-root');
  const parent = inputRoot?.parentElement ?? null;

  const button = [...hud.root.querySelectorAll<HTMLElement>('.hud-btn')]
    .map((element) => element.getBoundingClientRect())
    .find((rect) => rect.width > 1 && rect.height > 1);
  const chain =
    button === undefined
      ? []
      : [
          ...document.elementsFromPoint(
            button.left + button.width / 2,
            button.top + button.height / 2
          ),
        ];
  const hudIndex = chain.findIndex((element) => hud.root.contains(element));
  const inputIndex = chain.findIndex((element) => element.closest('.opm-input-root') !== null);

  const zIndex = (element: Element | null): number =>
    element === null ? Number.NaN : Number.parseInt(getComputedStyle(element).zIndex, 10);

  return {
    inputParent: describeElement(parent),
    parentIsBody: parent === document.body,
    siblings: parent !== null && parent === uiRoot.parentElement,
    inputZIndex: zIndex(inputRoot),
    uiZIndex: zIndex(uiRoot),
    probe: chain.map(describeElement),
    hudAbove: hudIndex >= 0 && inputIndex >= 0 && hudIndex < inputIndex,
  };
}

/**
 * The top band's declared height budget, and what the band actually holds.
 *
 * `--hud-band-row` is the HUD's own statement of how tall one row of the combat
 * band is allowed to be. It does not exist yet; the verifier skips the
 * comparison when `declared` is null rather than inventing a number, because a
 * budget assertion against a made-up budget tests the number, not the layout.
 *
 * Which panels count as "row one" is decided by the GRID, not by which column
 * class a panel carries: the portrait media query moves `.hud-top__centre` down
 * to row 2, so a class-based split would report the wrong row on exactly the
 * profile whose band is tightest. `grid-template-rows` computes to the USED
 * track sizes in px, so the first track's end is the honest row boundary.
 */
function bandBudget(): IBandBudget {
  const rootStyle = getComputedStyle(hud.root);
  const declaredRaw = rootStyle.getPropertyValue('--hud-band-row').trim();
  const declared = Number.parseFloat(declaredRaw);
  const gap = Number.parseFloat(rootStyle.getPropertyValue('--hud-gap'));

  const top = hud.root.querySelector<HTMLElement>('.hud-top');
  const topRect = top?.getBoundingClientRect();
  const members: string[] = [];
  let rowOneBottom: number | null = null;

  if (top && topRect && topRect.height >= 1) {
    const track = Number.parseFloat(getComputedStyle(top).gridTemplateRows);
    const rowOneEnd = topRect.top + (Number.isFinite(track) ? track : topRect.height);
    for (const node of top.querySelectorAll<HTMLElement>('[data-hud], .hud-panel')) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.top >= rowOneEnd) continue;
      members.push(node.dataset.hud ?? node.className.split(' ')[0] ?? 'panel');
      rowOneBottom = Math.max(rowOneBottom ?? 0, rect.bottom);
    }
  }

  return {
    declared: Number.isFinite(declared) ? declared : null,
    declaredRaw,
    gap: Number.isFinite(gap) ? gap : 0,
    rowOneBottom,
    insetTop: currentInsets.top,
    members,
  };
}

const api: IHarnessApi = {
  ready: false,

  scene(name: HarnessScene): void {
    applyScene(name);
    step(2);
    banner.textContent = name;
  },

  setViewport(insets: Partial<SafeAreaInsets>): void {
    currentInsets = {
      top: Math.max(0, insets.top ?? 0),
      right: Math.max(0, insets.right ?? 0),
      bottom: Math.max(0, insets.bottom ?? 0),
      left: Math.max(0, insets.left ?? 0),
    };
    hud.refreshSafeArea(currentInsets);
    touch?.setSafeArea(currentInsets);
    // Mirror onto the page so `#ui-root`'s own padding matches index.html.
    const root = document.documentElement;
    root.style.setProperty('--safe-top', `${currentInsets.top}px`);
    root.style.setProperty('--safe-right', `${currentInsets.right}px`);
    root.style.setProperty('--safe-bottom', `${currentInsets.bottom}px`);
    root.style.setProperty('--safe-left', `${currentInsets.left}px`);
    overlays.style.setProperty('--sa-t', `${currentInsets.top}px`);
    overlays.style.setProperty('--sa-r', `${currentInsets.right}px`);
    overlays.style.setProperty('--sa-b', `${currentInsets.bottom}px`);
    overlays.style.setProperty('--sa-l', `${currentInsets.left}px`);
    overlays.style.setProperty('--thumb-r', `${THUMB_RESERVE_PX}px`);
    overlays.style.setProperty('--stick-r', `${STICK_RESERVE_PX}px`);
    resize();
  },

  /**
   * Both halves of the settings bridge, because the shipping one has two.
   *
   * `src/game/game.ts`'s `applySettings` (the `configure({…})` call around
   * :1560-1571) hands the input layer `floatingStick` and `stickHand` in the
   * same breath as it hands the HUD its own patch. Only the HUD half used to
   * be reproduced here, and the missing half was not a rounding error: the HUD
   * root took `data-stick-hand='right'` and swapped its two bottom reserves
   * while `.opm-input-root` kept `data-hand='left'`, so every mirrored probe
   * measured a mirrored HUD wrapped around an unmirrored control — the exact
   * frame `game.ts` was changed to stop producing.
   *
   * `applySettings` returns the RESOLVED settings rather than the patch, so a
   * caller that sends `{palette}` alone still re-states the stick knobs from
   * the model instead of dropping them back to the defaults; and the tuning
   * goes through `resolveTuning` with the live tuning as its base, which is
   * the same door `IInputManager.configure` uses.
   */
  setSettings(patch: Partial<IHudSettings>): void {
    const settings = hud.applySettings(patch);
    const next = resolveTuning(
      {
        floatingStick: settings.stickLayout === 'floating',
        stickHand: settings.stickHand,
      },
      currentTuning
    );
    // `setTuning` regenerates the overlay's whole stylesheet and re-parks the
    // ring, so it is called when something it draws actually moved.
    if (
      next.stickHand !== currentTuning.stickHand ||
      next.floatingStick !== currentTuning.floatingStick
    ) {
      currentTuning = next;
      touch?.setTuning(currentTuning);
    }
    step(2);
  },

  setOverlays(on: boolean): void {
    overlays.dataset.on = on ? 'true' : 'false';
    banner.dataset.on = on ? 'true' : 'false';
  },

  step,

  measure(frames: number): IMeasurement {
    // Settle first: the very first frame after a scene change legitimately
    // writes everything, and measuring it would be measuring the build.
    step(30);
    hud.resetWriterStats();
    probe.properties.clear();
    probe.directWrites.length = 0;
    probe.reads.length = 0;
    probe.count = 0;
    shiftBaseline = cumulativeShift;
    probe.enabled = true;
    step(frames);
    probe.enabled = false;

    const properties = [...probe.properties];
    const stats = hud.writerStats;
    return {
      frames,
      properties,
      offending: properties.filter((name) => !name.startsWith('--')),
      directWrites: [...new Set(probe.directWrites)],
      reads: [...new Set(probe.reads)],
      uninstrumentedReads: [...uninstrumentedReads],
      layoutShift: Number.isNaN(cumulativeShift) ? 0 : cumulativeShift - shiftBaseline,
      layoutShiftObserved: !Number.isNaN(cumulativeShift),
      setPropertyCalls: probe.count,
      writerWrites: stats.writes,
      writerSkipped: stats.skipped,
    };
  },

  panels: panelRects,

  inputGeometry(): IInputGeometry {
    const slots = THUMB_ARC.map((slot) => {
      const offset = thumbArcOffset(slot);
      return {
        id: slot.id,
        right: offset.right,
        bottom: offset.bottom,
        size: slot.sizePx,
        reach: Math.hypot(offset.right, offset.bottom) + slot.sizePx / 2,
      };
    });
    return {
      pivotPx: THUMB_PIVOT_PX,
      slots,
      maxReach: Math.max(...slots.map((s) => s.reach)),
      hudReserve: THUMB_RESERVE_PX,
      stickReserve: STICK_RESERVE_PX,
    };
  },

  hitOwnership,

  mountParity,

  bandBudget,

  snapshot(): Record<string, unknown> {
    const model = hud.store.model;
    return {
      scene,
      activeScreen: hud.active,
      stack: [...hud.stack],
      modalOpen,
      boredom: model.boredom,
      rank: { ...model.rank },
      rivals: model.rivals.length,
      quests: model.quests.length,
      tracked: model.trackedQuestId,
      alerts: model.alerts.map((a) => a.title),
      markers: model.markers.size,
      encounter: model.encounter ? { ...model.encounter } : null,
      invoice: model.invoice ? { ...model.invoice } : null,
      settings: { ...model.settings },
      insets: { ...currentInsets },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      cumulativeLayoutShift: Number.isNaN(cumulativeShift) ? null : cumulativeShift,
    };
  },

  back(): boolean {
    const consumed = hud.handleBack();
    step(2);
    return consumed;
  },

  activeScreen(): string {
    return hud.active;
  },

  /**
   * Press a control the way a thumb does.
   *
   * A bare `element.click()` is NOT equivalent: the HUD's controls fire on
   * `pointerup`, because on a touch WebView `click` arrives up to 300 ms behind
   * the synthetic-mouse dance and a pause menu that responds a third of a
   * second late feels broken. Dispatching the real pointer sequence exercises
   * the path players use, and the trailing `click` additionally proves the
   * double-fire guard works.
   */
  press(selector: string): boolean {
    const node = hud.root.querySelector<HTMLElement>(selector);
    if (!node) return false;
    const options: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
    };
    node.dispatchEvent(new PointerEvent('pointerdown', options));
    node.dispatchEvent(new PointerEvent('pointerup', options));
    node.dispatchEvent(new PointerEvent('click', options));
    step(2);
    return true;
  },
};

window.__HUD_HARNESS__ = api;

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

window.addEventListener('resize', () => {
  api.setViewport(currentInsets);
  step(1);
});

async function boot(): Promise<void> {
  await hudFontsReady(document);
  api.setViewport(rotateInsets(NOTCHED_PORTRAIT_INSETS, 'left'));
  applyScene('loading');
  step(4);
  api.ready = true;
  banner.textContent = 'ready';
}

void boot();
