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

  // Full-deflection ring and dead-zone ring, to scale.
  const deadFraction = DEFAULT_INPUT_TUNING.stickDeadZonePx / DEFAULT_INPUT_TUNING.stickFullDeflectionPx;
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

  // Move vector (gold) — drawn last so it is always readable.
  ctx.strokeStyle = '#ffd230';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + state.move.x * SCOPE_R, cy - state.move.y * SCOPE_R);
  ctx.stroke();

  ctx.fillStyle = '#ffd230';
  ctx.beginPath();
  ctx.arc(cx + state.move.x * SCOPE_R, cy - state.move.y * SCOPE_R, 6, 0, Math.PI * 2);
  ctx.fill();
}

/* -------------------------------------------------------------------------- */
/* Render loop                                                                */
/* -------------------------------------------------------------------------- */

let frameIndex = 0;
let lastPointerSignature = '';
let lastGestureSignature = ' ';
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
    .map((p) => `${p.id}:${p.role}:${p.button ?? ''}:${p.x.toFixed(0)}:${p.y.toFixed(0)}:${p.travelPx.toFixed(0)}`)
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
    cell.meta.textContent = b.held || b.released ? `${b.value.toFixed(2)} ${b.holdTime.toFixed(2)}s` : '';
    cell.row.dataset.state = b.pressed ? 'pressed' : b.held ? 'held' : b.released ? 'released' : 'idle';
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

function tick(nowMs: number): void {
  requestAnimationFrame(tick);
  const state = manager.poll(frameIndex, nowMs / 1000);
  frameIndex++;

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
