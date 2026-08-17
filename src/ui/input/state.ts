/**
 * INPUT STATE CONSTRUCTION, PATCHING AND COMPARISON
 *
 * `InputState` is the entire contract between input and the rest of the game.
 * Three things live here:
 *
 *   1. `neutralInputState()` — the baseline every patch merges over.
 *   2. `InputStatePatch` + `applyInputPatch()` — the ergonomic shape tests
 *      write. `{ move: { x: 1 }, buttons: { punch: true } }` is a legal patch;
 *      the derived fields (`magnitude`, `angle`, `active`, `anyActive`) are
 *      filled in for you, so a test can never accidentally hand the game an
 *      internally inconsistent snapshot.
 *   3. `inputStatesEqual()` — structural comparison used by the parity tests
 *      that prove touch, keyboard and gamepad agree.
 */

import type {
  AxisState,
  ButtonState,
  InputAction,
  InputDevice,
  InputState,
  PointerSample,
} from '@/types';
import { axesEqual, axisFromVector, NEUTRAL_AXIS } from './axis';
import { buttonsEqual, INPUT_ACTIONS, NEUTRAL_BUTTON, neutralButtons } from './buttons';

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

const NO_POINTERS: readonly PointerSample[] = Object.freeze([]);

/** A fully-populated snapshot with nothing pressed and nothing moving. */
export function neutralInputState(
  frame = 0,
  time = 0,
  device: InputDevice = 'synthetic'
): InputState {
  return Object.freeze({
    frame,
    time,
    device,
    move: NEUTRAL_AXIS,
    look: NEUTRAL_AXIS,
    buttons: Object.freeze(neutralButtons()),
    pointers: NO_POINTERS,
    pinchDelta: 1,
    twistDelta: 0,
    anyActive: false,
  });
}

/** Deep copy. `InputState` is JSON-safe by contract, so this is total. */
export function cloneInputState(state: InputState): InputState {
  const buttons = {} as Record<InputAction, ButtonState>;
  for (const action of INPUT_ACTIONS) {
    buttons[action] = { ...(state.buttons[action] ?? NEUTRAL_BUTTON) };
  }
  return {
    frame: state.frame,
    time: state.time,
    device: state.device,
    move: { ...state.move },
    look: { ...state.look },
    buttons,
    pointers: state.pointers.map((p) => ({ ...p })),
    pinchDelta: state.pinchDelta,
    twistDelta: state.twistDelta,
    anyActive: state.anyActive,
  };
}

/* -------------------------------------------------------------------------- */
/* Patching                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Shorthand accepted for a button inside a patch:
 *   `true`         -> held, value 1
 *   `false`        -> up
 *   `0.4`          -> held, value 0.4 (0 means up)
 *   `{ held, value, holdTime, ... }` -> explicit
 *
 * Edge flags (`pressed`/`released`) in an explicit object are ADVISORY: the
 * synthetic backend re-derives them from held-transitions so scripted input
 * obeys exactly the same edge rules as a real thumb. Set them directly only
 * when constructing a literal snapshot for a unit test.
 */
export type ButtonPatch = boolean | number | Partial<ButtonState>;

/** The ergonomic, deeply-partial shape tests and replays write. */
export interface InputStatePatch {
  frame?: number;
  time?: number;
  device?: InputDevice;
  /** Movement stick. `magnitude`/`angle`/`active` are derived if omitted. */
  move?: Partial<AxisState> | null;
  /** Look stick. Same derivation rules as `move`. */
  look?: Partial<AxisState> | null;
  buttons?: Partial<Record<InputAction, ButtonPatch>>;
  pointers?: readonly PointerSample[];
  pinchDelta?: number;
  twistDelta?: number;
  /** Derived from the rest when omitted. */
  anyActive?: boolean;
}

/**
 * Normalise a partial axis into a consistent `AxisState`.
 *
 * If `x`/`y` are supplied, `magnitude`/`angle`/`active` are RECOMPUTED from
 * them (an explicit `magnitude` is honoured only as a rescale of the given
 * direction). This is what lets `setMove(0, 1)` produce a fully-formed axis.
 */
export function normaliseAxisPatch(patch: Partial<AxisState> | null | undefined): AxisState {
  if (!patch) return NEUTRAL_AXIS;

  const hasVector = patch.x !== undefined || patch.y !== undefined;
  if (hasVector) {
    let x = patch.x ?? 0;
    let y = patch.y ?? 0;
    if (patch.magnitude !== undefined) {
      // Caller gave a direction AND a magnitude: honour the magnitude.
      const len = Math.hypot(x, y);
      if (len > 1e-9) {
        const s = patch.magnitude / len;
        x *= s;
        y *= s;
      }
    }
    return axisFromVector(x, y, patch.active);
  }

  if (patch.magnitude !== undefined && patch.angle !== undefined) {
    return axisFromVector(
      Math.cos(patch.angle) * patch.magnitude,
      Math.sin(patch.angle) * patch.magnitude,
      patch.active
    );
  }

  if (patch.active !== undefined) {
    return patch.active ? { x: 0, y: 0, magnitude: 0, angle: 0, active: true } : NEUTRAL_AXIS;
  }
  return NEUTRAL_AXIS;
}

/** Turn a `ButtonPatch` into a full `ButtonState` (edges as given, default false). */
export function normaliseButtonPatch(patch: ButtonPatch | undefined): ButtonState {
  if (patch === undefined) return NEUTRAL_BUTTON;
  if (patch === true) return { pressed: false, held: true, released: false, holdTime: 0, value: 1 };
  if (patch === false) return NEUTRAL_BUTTON;
  if (typeof patch === 'number') {
    return patch > 0
      ? { pressed: false, held: true, released: false, holdTime: 0, value: patch }
      : NEUTRAL_BUTTON;
  }
  const held = patch.held ?? ((patch.value ?? 0) > 0 || patch.pressed === true);
  return {
    pressed: patch.pressed ?? false,
    held,
    released: patch.released ?? false,
    holdTime: patch.holdTime ?? 0,
    value: patch.value ?? (held ? 1 : 0),
  };
}

/** Extract just the held VALUE from a button patch (what the tracker wants). */
export function buttonPatchValue(patch: ButtonPatch | undefined): number {
  if (patch === undefined || patch === false) return 0;
  if (patch === true) return 1;
  if (typeof patch === 'number') return patch > 0 ? patch : 0;
  if (patch.held === false) return 0;
  if (patch.value !== undefined) return patch.value;
  return patch.held || patch.pressed ? 1 : 0;
}

/** Merge a patch over a base snapshot, deriving every dependent field. */
export function applyInputPatch(base: InputState, patch: InputStatePatch): InputState {
  const move = patch.move !== undefined ? normaliseAxisPatch(patch.move) : base.move;
  const look = patch.look !== undefined ? normaliseAxisPatch(patch.look) : base.look;

  let buttons = base.buttons;
  if (patch.buttons) {
    const next = {} as Record<InputAction, ButtonState>;
    for (const action of INPUT_ACTIONS) {
      next[action] = Object.prototype.hasOwnProperty.call(patch.buttons, action)
        ? normaliseButtonPatch(patch.buttons[action])
        : (base.buttons[action] ?? NEUTRAL_BUTTON);
    }
    buttons = Object.freeze(next);
  }

  const pointers = patch.pointers ?? base.pointers;
  const pinchDelta = patch.pinchDelta ?? base.pinchDelta;
  const twistDelta = patch.twistDelta ?? base.twistDelta;

  return Object.freeze({
    frame: patch.frame ?? base.frame,
    time: patch.time ?? base.time,
    device: patch.device ?? base.device,
    move,
    look,
    buttons,
    pointers,
    pinchDelta,
    twistDelta,
    anyActive:
      patch.anyActive ??
      deriveAnyActive({ move, look, buttons, pointers, pinchDelta, twistDelta }),
  });
}

/** True when anything at all is being driven. */
export function deriveAnyActive(parts: {
  move: AxisState;
  look: AxisState;
  buttons: Readonly<Record<InputAction, ButtonState>>;
  pointers: readonly PointerSample[];
  pinchDelta: number;
  twistDelta: number;
}): boolean {
  if (parts.move.active || parts.look.active) return true;
  if (parts.pointers.length > 0) return true;
  if (Math.abs(parts.pinchDelta - 1) > 1e-6) return true;
  if (Math.abs(parts.twistDelta) > 1e-6) return true;
  for (const action of INPUT_ACTIONS) {
    const b = parts.buttons[action];
    if (b && (b.held || b.pressed || b.released)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

export interface IStateCompareOptions {
  /** Ignore `frame`/`time`. Default true — parity is about content, not clocks. */
  readonly ignoreTiming?: boolean;
  /** Ignore `device`. Default true — that field exists to DIFFER per backend. */
  readonly ignoreDevice?: boolean;
  /** Ignore `pointers`. Default true — only touch has any. */
  readonly ignorePointers?: boolean;
  /** Ignore `holdTime` (accumulates at different rates under different dt). */
  readonly ignoreHoldTime?: boolean;
  readonly epsilon?: number;
}

/** Human-readable list of the fields where two snapshots disagree. */
export function diffInputStates(
  a: InputState,
  b: InputState,
  options: IStateCompareOptions = {}
): string[] {
  const {
    ignoreTiming = true,
    ignoreDevice = true,
    ignorePointers = true,
    ignoreHoldTime = false,
    epsilon = 1e-4,
  } = options;
  const diffs: string[] = [];

  if (!ignoreTiming) {
    if (a.frame !== b.frame) diffs.push(`frame ${a.frame} != ${b.frame}`);
    if (Math.abs(a.time - b.time) > epsilon) diffs.push(`time ${a.time} != ${b.time}`);
  }
  if (!ignoreDevice && a.device !== b.device) diffs.push(`device ${a.device} != ${b.device}`);
  if (!axesEqual(a.move, b.move, epsilon)) {
    diffs.push(`move ${fmtAxis(a.move)} != ${fmtAxis(b.move)}`);
  }
  if (!axesEqual(a.look, b.look, epsilon)) {
    diffs.push(`look ${fmtAxis(a.look)} != ${fmtAxis(b.look)}`);
  }
  for (const action of INPUT_ACTIONS) {
    const ba = a.buttons[action] ?? NEUTRAL_BUTTON;
    const bb = b.buttons[action] ?? NEUTRAL_BUTTON;
    const same = ignoreHoldTime
      ? buttonsEqual({ ...ba, holdTime: 0 }, { ...bb, holdTime: 0 }, epsilon)
      : buttonsEqual(ba, bb, epsilon);
    if (!same) diffs.push(`buttons.${action} ${fmtButton(ba)} != ${fmtButton(bb)}`);
  }
  if (!ignorePointers && a.pointers.length !== b.pointers.length) {
    diffs.push(`pointers ${a.pointers.length} != ${b.pointers.length}`);
  }
  if (Math.abs(a.pinchDelta - b.pinchDelta) > epsilon) {
    diffs.push(`pinchDelta ${a.pinchDelta} != ${b.pinchDelta}`);
  }
  if (Math.abs(a.twistDelta - b.twistDelta) > epsilon) {
    diffs.push(`twistDelta ${a.twistDelta} != ${b.twistDelta}`);
  }
  if (a.anyActive !== b.anyActive) diffs.push(`anyActive ${a.anyActive} != ${b.anyActive}`);
  return diffs;
}

/** `diffInputStates(...).length === 0`, for use in assertions. */
export function inputStatesEqual(
  a: InputState,
  b: InputState,
  options?: IStateCompareOptions
): boolean {
  return diffInputStates(a, b, options).length === 0;
}

function fmtAxis(a: AxisState): string {
  return `(${a.x.toFixed(3)},${a.y.toFixed(3)}|m${a.magnitude.toFixed(3)}${a.active ? '+' : '-'})`;
}

function fmtButton(b: ButtonState): string {
  return `[${b.pressed ? 'P' : '.'}${b.held ? 'H' : '.'}${b.released ? 'R' : '.'} v${b.value.toFixed(2)} t${b.holdTime.toFixed(3)}]`;
}

/** One-line debug rendering, used by the harness and by failure messages. */
export function describeInputState(state: InputState): string {
  const pressed = INPUT_ACTIONS.filter((a) => state.buttons[a]?.held).join(',') || 'none';
  return (
    `f${state.frame} t${state.time.toFixed(2)} ${state.device} ` +
    `move${fmtAxis(state.move)} look${fmtAxis(state.look)} ` +
    `held[${pressed}] ptr${state.pointers.length} pinch${state.pinchDelta.toFixed(3)}`
  );
}
