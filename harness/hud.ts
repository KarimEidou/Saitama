/**
 * HUD HARNESS
 *
 * Builds the real HUD, the real input overlay and a synthetic game frame, then
 * exposes `window.__HUD_HARNESS__` for Playwright to drive.
 *
 * ── WHAT THIS PAGE IS FOR ──────────────────────────────────────────────────
 * Three claims about `src/ui/hud/**` cannot be made in a unit test, because
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
import { THUMB_ARC, THUMB_PIVOT_PX, createTouchOverlay, thumbArcOffset } from '@/ui/input';
import { DEFAULT_INPUT_TUNING } from '@/ui/input';

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

/** Accessors whose READ forces the browser to resolve pending layout. */
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
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, property);
    if (!descriptor?.get) continue;
    const { get } = descriptor;
    Object.defineProperty(Element.prototype, property, {
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
function drawBackdrop(canvas: HTMLCanvasElement, seedTime: number): void {
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
  const sun = ctx.createRadialGradient(width * 0.7, height * 0.62, 0, width * 0.7, height * 0.62, height * 0.5);
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
      ctx.fillStyle = `rgba(255,214,140,${0.10 + layer * 0.05})`;
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

  void seedTime;
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
  screen: string;
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

declare global {
  interface Window {
    __HUD_HARNESS__?: IHarnessApi;
  }
}

const stage = document.getElementById('stage') as HTMLElement;
const canvas = document.getElementById('backdrop') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const overlays = document.getElementById('overlays') as HTMLElement;
const banner = document.getElementById('banner') as HTMLElement;

const bus: IEventBus = createEventBus() as EventBus;

/* The touch overlay, mounted FIRST so the HUD's layers stack over it exactly
   as they do in the shipping page. */
const touch = createTouchOverlay(uiRoot, DEFAULT_INPUT_TUNING);

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
      hud.store.setCharge(
        (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.98,
        true,
        'serious',
        1.5e10 * (Math.sin(t * 1.6) * 0.5 + 0.5)
      );
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
    if (scene === 'markers') markers.update(hud.store.model, camera);
  }
}

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  drawBackdrop(canvas, frameIndex);
  markers.setSize(width, height);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}

/* -------------------------------------------------------------------------- */
/* API                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every VISIBLE, PAINTING HUD box, in viewport coordinates.
 *
 * Two exclusions, both of which the safe-area assertion would otherwise report
 * as violations that are not:
 *
 *   FULL-BLEED CONTAINERS. The CSS2D marker host and the HUD root are
 *   transparent boxes that span the viewport by definition. They paint nothing
 *   and cannot be "under the notch"; what could be under the notch is a MARKER,
 *   and those are clipped to the safe box by `.hud-markers`'s clip-path.
 *
 *   SCROLLED-OUT ROWS. A settings row below the fold of `.hud-sheet__body`
 *   reports a rect past the bottom of the screen because that is where it is —
 *   inside a scroll container, not under the home indicator. Anything clipped
 *   by its scrolling ancestor is skipped, which is the difference between
 *   measuring the layout and measuring the scroll position.
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

    const scroller = node.closest<HTMLElement>('.hud-sheet__body');
    if (scroller && scroller !== node) {
      const clip = scroller.getBoundingClientRect();
      const visible =
        rect.bottom > clip.top + 0.5 &&
        rect.top < clip.bottom - 0.5 &&
        rect.right > clip.left + 0.5 &&
        rect.left < clip.right - 0.5;
      if (!visible) continue;
    }

    const screenRoot = node.closest<HTMLElement>('[data-screen]');
    out.push({
      id: node.dataset.hud ?? node.className.split(' ')[0] ?? 'panel',
      screen: screenRoot?.dataset.screen ?? hud.active,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      text: (node.textContent ?? '').trim().slice(0, 60),
    });
  }
  return out;
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

  setSettings(patch: Partial<IHudSettings>): void {
    hud.applySettings(patch);
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
  void stage;
}

void boot();
