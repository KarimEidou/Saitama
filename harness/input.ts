/**
 * INPUT HARNESS
 *
 * A standalone page that mounts the real touch controls and renders every
 * value the input system produces, live. It exists to make multi-touch
 * behaviour VISIBLE — both to a human poking at a phone and to
 * `harness/input.verify.ts`, which drives it with real synthesised touch
 * events over CDP and asserts on the results.
 *
 * Nothing in here is game code. It imports `@/ui/input` exactly the way the
 * game will and does nothing else.
 *
 * Serve with `npm run dev` and open `/harness/input.html`.
 */

import type { ButtonState, InputState, PointerSample } from '@/types';
import {
  createHaptics,
  createInputManager,
  DEFAULT_INPUT_TUNING,
  INPUT_ACTIONS,
  type GestureEvent,
  type IInputManager,
  type PointerDebug,
} from '@/ui/input';

/* -------------------------------------------------------------------------- */
/* Harness API (what Playwright talks to)                                     */
/* -------------------------------------------------------------------------- */

interface HarnessPeaks {
  moveMagnitude: number;
  lookAbsX: number;
  lookAbsY: number;
  pointerCount: number;
  pinchMax: number;
  pinchMin: number;
  twistAbs: number;
}

/**
 * Where the stick READS from and where it is PAINTED, in one struct.
 *
 * They are separate numbers derived by separate modules (`touch-core` decides
 * the origin, `touch-overlay` decides the ring), and the whole anchored layout
 * is only honest while they agree — a ring painted somewhere the origin is not
 * is the failure this control has actually shipped. Reading both here is what
 * lets `input.verify.ts` assert on the difference rather than on a magnitude
 * that happens to come out right either way.
 */
export interface StickProbe {
  /** Origin the deflection is measured from. `null` when no thumb is on it. */
  origin: { x: number; y: number } | null;
  /** The thumb driving it, same frame. */
  thumb: { x: number; y: number } | null;
  /** Centre and radius of the painted ring, straight off its layout box. */
  ring: { x: number; y: number; radius: number } | null;
}

export interface IInputHarness {
  readonly ready: boolean;
  readonly manager: IInputManager;
  /** Current frame's snapshot, deep-copied and JSON-safe. */
  snapshot(): InputState;
  /** Live pointer table straight from the core. */
  pointers(): PointerDebug[];
  /** Recognised gestures, newest last. */
  gestures(): string[];
  clearGestures(): void;
  /** Frame counter of the render loop. */
  frame(): number;
  /** Resolves after `count` more polls have run. */
  waitFrames(count: number): Promise<number>;
  /** Origin, thumb and painted ring for the movement stick. */
  stickProbe(): StickProbe;
  /**
   * Stop the input clock. Polls keep running (so `waitFrames` still resolves)
   * but every one of them sees `dt === 0`, so nothing in the input layer that
   * measures a DURATION advances until `advanceClock()` says it may.
   *
   * Returns the frozen time, in seconds. Idempotent.
   */
  freezeClock(): number;
  /** Move the frozen clock forward by exactly this many seconds. */
  advanceClock(seconds: number): number;
  /** Hand the clock back to `requestAnimationFrame`. */
  thawClock(): void;
  /** Whether the clock is currently frozen. */
  clockFrozen(): boolean;
  /** Extremes since the last `clearPeaks()`. Drags are transient; peaks are not. */
  peaks(): HarnessPeaks;
  clearPeaks(): void;
  /** Buttons that have shown a `pressed` edge since the last clear. */
  pressedSince(): string[];
  /**
   * The `ButtonState` captured on the most recent frame where this action's
   * `pressed` edge was true. Edges last exactly one frame, and a Playwright
   * round trip is several frames long, so polling `snapshot()` will miss them.
   */
  lastPressed(action: string): ButtonState | null;
  clearPressed(): void;
  /** Last N snapshots, oldest first. */
  history(count?: number): InputState[];
  setInteract(label: string | null): void;
  setSafeArea(insets: { top: number; right: number; bottom: number; left: number }): void;
  /** Screen-space centre of an on-screen button, for aiming touch events. */
  buttonCentre(id: string): { x: number; y: number } | null;
  hapticCounts(): Readonly<Record<string, number>>;
  /** Native/web plugin calls the haptics wrapper actually made. */
  hapticPluginCalls(): string[];
  /** Unhandled promise rejections seen on this page. Must stay empty. */
  unhandledRejections(): string[];
  resetAll(): void;
}

declare global {
  interface Window {
    __INPUT_HARNESS__?: IInputHarness;
    __HARNESS_READY__?: boolean;
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

const gestureLog: GestureEvent[] = [];

/* Any promise rejection at all is a failure — the haptics wrapper in
   particular MUST never leak one, because `@capacitor/haptics`' web fallback
   throws when the browser has no vibration API (which is every desktop
   browser and every CI box). */
const rejections: string[] = [];
window.addEventListener('unhandledrejection', (event) => {
  rejections.push(String(event.reason));
});

/* Stub plugin so the FULL haptics call path runs headlessly: cue -> cooldown
   -> pattern mapping -> plugin method. Without it, `supported` is false in a
   browser with no motor and the interesting half never executes. */
const pluginCalls: string[] = [];
const stubHaptics = createHaptics({
  forceSupported: true,
  impl: {
    impact: (options) => {
      pluginCalls.push(`impact:${options.style}`);
      return Promise.resolve();
    },
    notification: (options) => {
      pluginCalls.push(`notification:${options.type}`);
      return Promise.resolve();
    },
  },
});

/* A SECOND sink using the REAL @capacitor/haptics, fired once at boot. Its web
   implementation rejects on a browser with no `navigator.vibrate`; this proves
   the wrapper swallows that instead of leaking an unhandled rejection. */
const realHapticsProbe = createHaptics({ forceSupported: true });
realHapticsProbe.play('chargeComplete');

const manager = createInputManager({
  mount: document.body,
  mouseLook: false,
  haptics: stubHaptics,
  onGesture: (event) => {
    gestureLog.push(event);
    if (gestureLog.length > 40) gestureLog.shift();
  },
});

const peaks: HarnessPeaks = {
  moveMagnitude: 0,
  lookAbsX: 0,
  lookAbsY: 0,
  pointerCount: 0,
  pinchMax: 1,
  pinchMin: 1,
  twistAbs: 0,
};

const pressedSince = new Set<string>();
const lastPressedState = new Map<string, ButtonState>();
const history: InputState[] = [];
const HISTORY_LIMIT = 300;

/* -------------------------------------------------------------------------- */
/* DOM plumbing                                                               */
/* -------------------------------------------------------------------------- */

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from input.html`);
  return node as T;
}

const out = {
  frame: el('v-frame'),
  device: el('v-device'),
  anyActive: el('v-anyactive'),
  move: el('v-move'),
  moveBar: el('v-move-bar'),
  look: el('v-look'),
  lookBar: el('v-look-bar'),
  pinch: el('v-pinch'),
  twist: el('v-twist'),
  charge: el('v-charge'),
  chargeBar: el('v-charge-bar'),
  dash: el('v-dash'),
  interact: el('v-interact'),
  pointerBody: el('pointer-body'),
  pointerCount: el('v-pointer-count'),
  buttonGrid: el('button-grid'),
  gestureList: el('gesture-list'),
  haptics: el('v-haptics'),
  peaks: el('v-peaks'),
};

/* ---- stick / camera zone markers ----
   Painted from the LIVE tuning, never from constants baked into input.html.
   The hand and both zone fractions are settable at runtime through
   `__INPUT__.setConfig`, and a marker that does not follow them is worse than
   no marker at all: it states, in paint, that the zone is somewhere it is not.
   That is exactly what the old fixed 50% line did once `stickZoneFraction`
   became 0.45 and `stickZoneTopFraction` handed the top of the screen back to
   the camera.

   Held in a map for the same reason `out` is: `el()` throws on a missing id,
   so the page and this module cannot drift apart silently. */
const zone = {
  split: el('zone-split'),
  top: el('zone-top'),
  stickLabel: el('zone-stick'),
  cameraLabel: el('zone-camera'),
};
let lastZoneSignature = '';

function syncZoneMarkers(): void {
  const tuning = manager.tuning;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const signature = `${tuning.stickHand}:${tuning.stickZoneFraction}:${tuning.stickZoneTopFraction}:${w}x${h}`;
  // Cheap enough to ask every frame, expensive enough to write only on change:
  // this runs inside the input path the harness exists to measure.
  if (signature === lastZoneSignature) return;
  lastZoneSignature = signature;

  const band = w * tuning.stickZoneFraction;
  const splitX = tuning.stickHand === 'right' ? w - band : band;
  const splitY = h * tuning.stickZoneTopFraction;
  document.body.dataset.stickHand = tuning.stickHand;
  document.documentElement.style.setProperty('--zone-x', `${splitX.toFixed(1)}px`);
  document.documentElement.style.setProperty('--zone-y', `${splitY.toFixed(1)}px`);

  const widthPct = Math.round(tuning.stickZoneFraction * 100);
  const heightPct = Math.round((1 - tuning.stickZoneTopFraction) * 100);
  zone.stickLabel.textContent = `stick zone · ${tuning.stickHand} ${widthPct}% · lower ${heightPct}%`;
  zone.cameraLabel.textContent = 'camera · drag + pinch + twist';
}

/** One row per action, built once and mutated thereafter. */
const buttonCells = new Map<string, { row: HTMLElement; flags: HTMLElement; meta: HTMLElement }>();
for (const action of INPUT_ACTIONS) {
  const row = document.createElement('div');
  row.className = 'btn-cell';
  row.dataset.action = action;
  row.dataset.state = 'idle';

  const name = document.createElement('span');
  name.className = 'btn-name';
  name.textContent = action;

  const flags = document.createElement('span');
  flags.className = 'btn-flags';
  flags.textContent = '...';
  flags.dataset.testid = `flags-${action}`;

  const meta = document.createElement('span');
  meta.className = 'btn-meta';
  meta.textContent = '';

  row.append(name, flags, meta);
  out.buttonGrid.appendChild(row);
  buttonCells.set(action, { row, flags, meta });
}

/* -------------------------------------------------------------------------- */
/* Vector scope                                                               */
/* -------------------------------------------------------------------------- */

const scope = el<HTMLCanvasElement>('scope');
const ctx = scope.getContext('2d');
const SCOPE_R = 78;

function drawScope(state: InputState, pointerSamples: readonly PointerSample[]): void {
  if (!ctx) return;
  const w = scope.width;
  const h = scope.height;
  const cx = w / 2;
  const cy = h / 2;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b0f17';
  ctx.fillRect(0, 0, w, h);

  // Full-deflection ring and dead-zone ring, to scale, in RAW THUMB-TRAVEL
  // space: the outer ring is `stickFullDeflectionPx` of travel from the
  // stick's origin and the dashed one is `stickDeadZonePx`. Travel is measured
  // from wherever `stickOriginFor` put that origin — the anchor for a thumb
  // that grabbed the ring, the touch point for one that did not — so this
  // scope is the same picture in both stick layouts.
  const deadFraction =
    DEFAULT_INPUT_TUNING.stickDeadZonePx / DEFAULT_INPUT_TUNING.stickFullDeflectionPx;
  ctx.strokeStyle = 'rgba(255,210,48,0.35)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, SCOPE_R, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, SCOPE_R * deadFraction, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Cross-hairs.
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath();
  ctx.moveTo(cx - SCOPE_R, cy);
  ctx.lineTo(cx + SCOPE_R, cy);
  ctx.moveTo(cx, cy - SCOPE_R);
  ctx.lineTo(cx, cy + SCOPE_R);
  ctx.stroke();

  // Pointer dots, mapped from normalised viewport space onto the scope box.
  for (const sample of pointerSamples) {
    ctx.fillStyle = 'rgba(120,220,255,0.85)';
    ctx.beginPath();
    ctx.arc(sample.x * w, sample.y * h, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Look vector (green).
  if (state.look.magnitude > 0) {
    ctx.strokeStyle = '#5ce88a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + state.look.x * SCOPE_R, cy - state.look.y * SCOPE_R);
    ctx.stroke();
  }

  /* Move vector (gold) — drawn last so it is always readable.

     `state.move` is already dead-zoned and RENORMALISED by `radialDeflection`:
     magnitude 0 is the dead-zone EDGE and 1 is full deflection. The two rings
     above are in raw travel, so plotting the normalised magnitude straight
     onto them draws a stick at 40% of its usable range INSIDE the dashed
     dead-zone ring — a reader concludes the stick is producing no motion while
     it is driving the character at 40% speed. Map it back to travel first, so
     the knob and the rings are in the same space. */
  const travelScale =
    state.move.magnitude > 0
      ? ((deadFraction + state.move.magnitude * (1 - deadFraction)) / state.move.magnitude) *
        SCOPE_R
      : 0;
  const moveX = cx + state.move.x * travelScale;
  const moveY = cy - state.move.y * travelScale;

  ctx.strokeStyle = '#ffd230';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(moveX, moveY);
  ctx.stroke();

  ctx.fillStyle = '#ffd230';
  ctx.beginPath();
  ctx.arc(moveX, moveY, 6, 0, Math.PI * 2);
  ctx.fill();
}

/* -------------------------------------------------------------------------- */
/* Render loop                                                                */
/* -------------------------------------------------------------------------- */

let frameIndex = 0;
/* Sentinels for the two "has this changed since the last render?" checks.
   `null`, not a string: the EMPTY string is a real signature (no pointers
   down, no gestures logged), so seeding with `''` skipped the first render
   entirely and left the "no active pointers" placeholder and the pointer
   count unwritten until something had been touched and released. */
let lastPointerSignature: string | null = null;
let lastGestureSignature: string | null = null;
const frameWaiters: { target: number; resolve: (frame: number) => void }[] = [];

function fmt(value: number, digits = 3): string {
  return value.toFixed(digits);
}

function render(state: InputState, pointerDebug: PointerDebug[]): void {
  out.frame.textContent = String(state.frame);
  out.device.textContent = state.device;
  out.device.dataset.value = state.device;
  out.anyActive.textContent = state.anyActive ? 'YES' : 'no';
  out.anyActive.dataset.value = String(state.anyActive);

  out.move.textContent =
    `x ${fmt(state.move.x)}  y ${fmt(state.move.y)}  |m| ${fmt(state.move.magnitude)}  ` +
    `${fmt((state.move.angle * 180) / Math.PI, 1)}deg  ${state.move.active ? 'ACTIVE' : 'idle'}`;
  out.moveBar.style.width = `${(state.move.magnitude * 100).toFixed(1)}%`;

  out.look.textContent =
    `x ${fmt(state.look.x)}  y ${fmt(state.look.y)}  |m| ${fmt(state.look.magnitude)}  ` +
    `~${fmt(state.look.x * DEFAULT_INPUT_TUNING.lookFullRateDegPerSec, 1)} deg/s`;
  out.lookBar.style.width = `${(state.look.magnitude * 100).toFixed(1)}%`;

  out.pinch.textContent = fmt(state.pinchDelta, 4);
  out.twist.textContent = `${fmt(state.twistDelta, 4)} rad`;

  const charge = manager.touch?.chargeRatio ?? 0;
  out.charge.textContent = fmt(charge, 2);
  out.chargeBar.style.width = `${(charge * 100).toFixed(1)}%`;
  out.dash.textContent = manager.touch?.dashOn ? 'ON' : 'off';
  out.dash.dataset.value = String(manager.touch?.dashOn ?? false);
  out.interact.textContent = manager.touch?.core.isInteractAvailable ? 'available' : 'hidden';
  out.interact.dataset.value = String(manager.touch?.core.isInteractAvailable ?? false);

  /* pointers — rebuilt only when something actually changed, because tearing
     down and re-creating rows every frame is the single most expensive thing
     this page can do and it skews the very input latency we are measuring. */
  const pointerSignature = pointerDebug
    .map(
      (p) =>
        `${p.id}:${p.role}:${p.button ?? ''}:${p.x.toFixed(0)}:${p.y.toFixed(0)}:${p.travelPx.toFixed(0)}`
    )
    .join('|');
  if (pointerSignature !== lastPointerSignature) {
    lastPointerSignature = pointerSignature;
    out.pointerCount.textContent = String(pointerDebug.length);
    out.pointerBody.textContent = '';
    for (const p of pointerDebug) {
      const row = document.createElement('div');
      row.className = 'ptr-row';
      row.dataset.pointerId = String(p.id);
      row.dataset.role = p.role;
      row.innerHTML =
        `<span class="ptr-id">#${p.id}</span>` +
        `<span class="ptr-role role-${p.role}">${p.role}${p.button ? `:${p.button}` : ''}</span>` +
        `<span class="ptr-pos">${p.x.toFixed(0)}, ${p.y.toFixed(0)}</span>` +
        `<span class="ptr-travel">${p.travelPx.toFixed(0)}px</span>`;
      out.pointerBody.appendChild(row);
    }
    if (pointerDebug.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ptr-row empty';
      empty.textContent = 'no active pointers';
      out.pointerBody.appendChild(empty);
    }
  }

  /* buttons */
  for (const action of INPUT_ACTIONS) {
    const cell = buttonCells.get(action)!;
    const b = state.buttons[action];
    const flags = `${b.pressed ? 'P' : '.'}${b.held ? 'H' : '.'}${b.released ? 'R' : '.'}`;
    cell.flags.textContent = flags;
    cell.meta.textContent =
      b.held || b.released ? `${b.value.toFixed(2)} ${b.holdTime.toFixed(2)}s` : '';
    cell.row.dataset.state = b.pressed
      ? 'pressed'
      : b.held
        ? 'held'
        : b.released
          ? 'released'
          : 'idle';
  }

  /* gestures — only when the log changed */
  const gestureSignature = gestureLog.map((g) => g.gesture).join('|');
  if (gestureSignature !== lastGestureSignature) {
    lastGestureSignature = gestureSignature;
    out.gestureList.textContent = '';
    for (const event of gestureLog.slice(-6).reverse()) {
      const item = document.createElement('div');
      item.className = 'gesture-item';
      item.dataset.gesture = event.gesture;
      item.textContent = `${event.gesture} @ ${event.x.toFixed(0)},${event.y.toFixed(0)}`;
      out.gestureList.appendChild(item);
    }
    if (gestureLog.length === 0) {
      const item = document.createElement('div');
      item.className = 'gesture-item empty';
      item.textContent = 'none yet';
      out.gestureList.appendChild(item);
    }
  }

  const counts = manager.haptics.counts;
  const cues = Object.keys(counts);
  out.haptics.textContent = cues.length
    ? cues.map((cue) => `${cue}:${counts[cue]}`).join('  ')
    : 'none';

  out.peaks.textContent =
    `mv ${fmt(peaks.moveMagnitude, 2)} lk ${fmt(peaks.lookAbsX, 2)} ` +
    `n${peaks.pointerCount} pn ${fmt(peaks.pinchMin, 2)}/${fmt(peaks.pinchMax, 2)}`;

  drawScope(state, state.pointers);
}

/* The time handed to `manager.poll()`. `null` is the wall clock, which is what
   a real session runs on. A number means the clock is FROZEN there and moves
   only when `advanceClock()` says so.

   Freezing exists because every duration threshold in the input layer —
   `ChargeTracker` above all — is accumulated from the `dt` BETWEEN TWO POLLS,
   and a gesture driven from Playwright is only ever as quick as the transport
   and the machine allow. Two `Input.dispatchTouchEvent` round trips plus the
   assertions between them cost 100-500ms against SwiftShader, measured; the
   charge starts at 0.22s. A test for "a quick tap does not charge" written
   against the wall clock therefore measures the CI box, and it says so by
   passing on an idle machine and failing on a loaded one. Frozen, the poll dt
   is exactly zero until the test asks for more, so a tap lasts 80ms because
   the test said 80ms. */
let frozenTime: number | null = null;

function tick(nowMs: number): void {
  requestAnimationFrame(tick);
  const state = manager.poll(frameIndex, frozenTime ?? nowMs / 1000);
  frameIndex++;
  syncZoneMarkers();

  /* peaks — a drag between two polls would otherwise be invisible */
  if (state.move.magnitude > peaks.moveMagnitude) peaks.moveMagnitude = state.move.magnitude;
  if (Math.abs(state.look.x) > peaks.lookAbsX) peaks.lookAbsX = Math.abs(state.look.x);
  if (Math.abs(state.look.y) > peaks.lookAbsY) peaks.lookAbsY = Math.abs(state.look.y);
  if (state.pointers.length > peaks.pointerCount) peaks.pointerCount = state.pointers.length;
  if (state.pinchDelta > peaks.pinchMax) peaks.pinchMax = state.pinchDelta;
  if (state.pinchDelta < peaks.pinchMin) peaks.pinchMin = state.pinchDelta;
  if (Math.abs(state.twistDelta) > peaks.twistAbs) peaks.twistAbs = Math.abs(state.twistDelta);
  for (const action of INPUT_ACTIONS) {
    if (state.buttons[action].pressed) {
      pressedSince.add(action);
      lastPressedState.set(action, { ...state.buttons[action] });
    }
  }

  history.push(state);
  if (history.length > HISTORY_LIMIT) history.shift();

  render(state, manager.touch?.debugPointers() ?? []);

  for (let i = frameWaiters.length - 1; i >= 0; i--) {
    if (frameIndex >= frameWaiters[i]!.target) {
      frameWaiters[i]!.resolve(frameIndex);
      frameWaiters.splice(i, 1);
    }
  }

  if (!window.__HARNESS_READY__ && frameIndex >= 2) window.__HARNESS_READY__ = true;
}

requestAnimationFrame(tick);

/* -------------------------------------------------------------------------- */
/* Harness API                                                                */
/* -------------------------------------------------------------------------- */

const harness: IInputHarness = {
  ready: true,
  manager,

  snapshot(): InputState {
    return JSON.parse(JSON.stringify(manager.state)) as InputState;
  },

  pointers(): PointerDebug[] {
    return manager.touch?.debugPointers() ?? [];
  },

  gestures(): string[] {
    return gestureLog.map((g) => g.gesture);
  },

  clearGestures(): void {
    gestureLog.length = 0;
  },

  frame(): number {
    return frameIndex;
  },

  waitFrames(count: number): Promise<number> {
    return new Promise((resolve) => {
      frameWaiters.push({ target: frameIndex + Math.max(1, count), resolve });
    });
  },

  stickProbe(): StickProbe {
    const live = manager.touch?.core.stick ?? null;
    /* The ring's own layout box, not a recomputed anchor. Re-deriving the
       anchor here would only prove this file can do the same arithmetic as
       `stick-geometry.ts`; measuring the box proves the ring is where the
       arithmetic says, which is the thing that has actually been wrong. */
    const node = document.querySelector<HTMLElement>('.opm-stick');
    const box = node?.getBoundingClientRect();
    return {
      origin: live ? { x: live.originX, y: live.originY } : null,
      thumb: live ? { x: live.x, y: live.y } : null,
      ring:
        box && box.width > 0
          ? { x: box.left + box.width / 2, y: box.top + box.height / 2, radius: box.width / 2 }
          : null,
    };
  },

  freezeClock(): number {
    frozenTime ??= performance.now() / 1000;
    return frozenTime;
  },

  advanceClock(seconds: number): number {
    if (frozenTime === null) {
      throw new Error('advanceClock() with a running clock — call freezeClock() first');
    }
    // Negative would run the charge backwards; `manager.poll` clamps dt at 0
    // anyway, so it would silently do nothing rather than fail a test loudly.
    frozenTime += Math.max(0, seconds);
    return frozenTime;
  },

  thawClock(): void {
    /* The next poll's dt becomes the REAL time that has passed since the
       freeze, which is the honest answer: the game was running all along and
       only this page's idea of the clock stopped. */
    frozenTime = null;
  },

  clockFrozen(): boolean {
    return frozenTime !== null;
  },

  peaks(): HarnessPeaks {
    return { ...peaks };
  },

  clearPeaks(): void {
    peaks.moveMagnitude = 0;
    peaks.lookAbsX = 0;
    peaks.lookAbsY = 0;
    peaks.pointerCount = 0;
    peaks.pinchMax = 1;
    peaks.pinchMin = 1;
    peaks.twistAbs = 0;
  },

  pressedSince(): string[] {
    return [...pressedSince];
  },

  lastPressed(action: string): ButtonState | null {
    const state = lastPressedState.get(action);
    return state ? { ...state } : null;
  },

  clearPressed(): void {
    pressedSince.clear();
    lastPressedState.clear();
  },

  history(count = 60): InputState[] {
    return history.slice(-count).map((s) => JSON.parse(JSON.stringify(s)) as InputState);
  },

  setInteract(label: string | null): void {
    manager.setInteractPrompt(label);
  },

  setSafeArea(insets): void {
    manager.setSafeArea(insets);
  },

  buttonCentre(id: string): { x: number; y: number } | null {
    const node = document.querySelector<HTMLElement>(`[data-opm-button='${id}']`);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  },

  hapticCounts(): Readonly<Record<string, number>> {
    return { ...manager.haptics.counts };
  },

  hapticPluginCalls(): string[] {
    return [...pluginCalls];
  },

  unhandledRejections(): string[] {
    return [...rejections];
  },

  resetAll(): void {
    /* Thaw FIRST. A frozen clock left behind by one scenario would silently
       stop every timer in the next one, and a suite of tests that all pass
       because nothing can ever time out is worse than a suite that fails. */
    frozenTime = null;
    manager.reset();
    manager.syntheticEnabled = false;
    manager.setInteractPrompt(null);
    manager.touch?.setDashToggle(false);
    gestureLog.length = 0;
    pressedSince.clear();
    lastPressedState.clear();
    history.length = 0;
    this.clearPeaks();
  },
};

window.__INPUT_HARNESS__ = harness;
