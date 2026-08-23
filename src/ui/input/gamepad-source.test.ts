/**
 * GAMEPAD BACKEND
 *
 * Driven DIRECTLY, not through the manager: `parity.test.ts` only ever sees
 * what survives the merge, so everything the merge hides — the analogue trigger
 * threshold, the D-pad fold into the left stick, dead-zone rejection, a pad
 * yanked mid-charge — is only visible here, on the raw `InputContribution`.
 *
 * The backend takes an injectable `getGamepads` and `window` is undefined under
 * vitest's node environment, so no listeners attach and a literal
 * `{ axes, buttons }` is a complete fake.
 */

import { describe, expect, it } from 'vitest';
import { InputContribution } from './backend';
import { DEFAULT_INPUT_TUNING } from './config';
import { createGamepadSource, type GamepadLike } from './gamepad-source';

const DT = 1 / 60;
const T = DEFAULT_INPUT_TUNING;

interface PadState {
  id: string;
  axes: number[];
  buttons: { pressed: boolean; value: number }[];
}

function makePad(): PadState {
  return {
    id: 'test-pad',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
}

function makeRig(pads: () => readonly (GamepadLike | null)[]) {
  let completions = 0;
  const source = createGamepadSource(T, {
    getGamepads: pads,
    onChargeComplete: () => completions++,
  });
  const out = new InputContribution();
  let time = 0;
  return {
    source,
    out,
    get chargeCompletions() {
      return completions;
    },
    /** One poll, exactly as the manager does it: reset, then sample. */
    frame(dt = DT): InputContribution {
      time += dt;
      out.reset();
      source.sample(dt, time, out);
      return out;
    },
  };
}

/** A rig around a single mutable pad, which most cases want. */
function padRig() {
  const pad = makePad();
  const rig = makeRig(() => [pad as unknown as GamepadLike]);
  // Spreading `rig` would snapshot the `chargeCompletions` getter's value.
  return {
    pad,
    source: rig.source,
    out: rig.out,
    get chargeCompletions() {
      return rig.chargeCompletions;
    },
    frame: rig.frame,
  };
}

/* ========================================================================== */
/* Connection                                                                 */
/* ========================================================================== */

describe('pad selection', () => {
  it('contributes nothing when no pad is connected', () => {
    const rig = makeRig(() => []);
    const out = rig.frame();
    expect(out.hasMove).toBe(false);
    expect(out.hasLook).toBe(false);
    expect(out.held.size).toBe(0);
    expect(out.active).toBe(false);
    expect(rig.source.connectedId).toBe(null);
  });

  it('reports the id of the pad in use', () => {
    const rig = padRig();
    rig.frame();
    expect(rig.source.connectedId).toBe('test-pad');
  });

  it('falls back to a generic id for a pad that reports none', () => {
    const rig = makeRig(() => [{ axes: [0, 0, 0, 0], buttons: [] }]);
    rig.frame();
    expect(rig.source.connectedId).toBe('gamepad');
  });

  it('skips a pad flagged as disconnected', () => {
    const pad = makePad();
    pad.axes[1] = -1; // would be full-up if it were read at all
    const rig = makeRig(() => [{ ...pad, connected: false } as unknown as GamepadLike]);
    const out = rig.frame();
    expect(out.hasMove).toBe(false);
    expect(rig.source.connectedId).toBe(null);
  });
});

/* ========================================================================== */
/* Sticks                                                                     */
/* ========================================================================== */

describe('sticks', () => {
  it('reads the left stick, flipping Y so positive is UP', () => {
    const rig = padRig();
    rig.pad.axes[1] = -1; // hardware Y is positive DOWN
    const out = rig.frame();
    expect(out.hasMove).toBe(true);
    expect(out.moveY).toBeCloseTo(1, 6);
    expect(out.moveX).toBeCloseTo(0, 6);
    expect(out.active).toBe(true);
  });

  it('rejects a resting stick inside the dead zone', () => {
    const rig = padRig();
    rig.pad.axes[0] = 0.1; // below gamepadDeadZone (0.15)
    expect(T.gamepadDeadZone).toBe(0.15);
    expect(rig.frame().hasMove).toBe(false);
  });

  it('maps the square gate corner ONTO the unit circle, not inside it', () => {
    // The ordering guard: square -> circle FIRST, dead zone SECOND. A naive
    // dead-zone-first implementation yields ~0.866 here — a diagonal 13%
    // slower than a cardinal, on gamepad only.
    const rig = padRig();
    rig.pad.axes[0] = 1;
    rig.pad.axes[1] = -1;
    const out = rig.frame();
    expect(Math.hypot(out.moveX, out.moveY)).toBeCloseTo(1, 6);
  });

  it('merges the D-pad into the left stick', () => {
    const rig = padRig();
    rig.pad.buttons[15]!.pressed = true; // right
    expect(rig.frame().moveX).toBeCloseTo(1, 6);

    rig.pad.buttons[15]!.pressed = false;
    rig.pad.buttons[12]!.pressed = true; // up
    const out = rig.frame();
    expect(out.moveY).toBeCloseTo(1, 6);
    expect(out.moveX).toBeCloseTo(0, 6);
    // The D-pad is MOVEMENT, not a button: it contributes no held action.
    expect(out.held.size).toBe(0);
  });

  it('drives look from the right stick', () => {
    const rig = padRig();
    rig.pad.axes[2] = 1;
    const out = rig.frame();
    expect(out.hasLook).toBe(true);
    expect(out.lookX).toBeCloseTo(1, 6);
    expect(out.lookY).toBeCloseTo(0, 6);
  });
});

/* ========================================================================== */
/* Buttons                                                                    */
/* ========================================================================== */

describe('buttons', () => {
  it('maps digital buttons to their actions at full value', () => {
    const rig = padRig();
    rig.pad.buttons[0]!.pressed = true; // A
    rig.pad.buttons[10]!.pressed = true; // L3
    const out = rig.frame();
    expect(out.held.get('jump')).toBe(1);
    expect(out.held.get('sprint')).toBe(1);
    expect(out.held.size).toBe(2);
  });

  it('ignores buttons that are up, and indices with no mapping', () => {
    const rig = padRig();
    rig.pad.buttons[0]!.value = 1; // value without `pressed` is not a press
    rig.pad.buttons[14]!.pressed = true; // D-pad left: movement, not an action
    const out = rig.frame();
    expect(out.held.size).toBe(0);
    expect(out.moveX).toBeCloseTo(-1, 6);
  });

  it('holds an analogue trigger only past the threshold, at its raw value', () => {
    const rig = padRig();
    rig.pad.buttons[7] = { pressed: false, value: 0.2 }; // below 0.35
    expect(rig.frame().held.has('heavyPunch')).toBe(false);

    rig.pad.buttons[7] = { pressed: false, value: 0.6 };
    // The ANALOGUE value verbatim, not a digital 1.
    expect(rig.frame().held.get('heavyPunch')).toBeCloseTo(0.6, 6);
  });
});

/* ========================================================================== */
/* Charged punch                                                              */
/* ========================================================================== */

describe('charged punch', () => {
  it('fires heavyPunch on release, once the charge is full', () => {
    const rig = padRig();
    rig.pad.buttons[2]!.pressed = true;
    const frames = Math.ceil(T.chargeFullSec / DT) + 2;
    for (let i = 0; i < frames; i++) rig.frame();
    expect(rig.chargeCompletions).toBe(1);

    rig.pad.buttons[2]!.pressed = false;
    expect(rig.frame().pulses.get('heavyPunch')).toBeCloseTo(1, 6);
  });

  it('a quick tap fires no heavyPunch at all', () => {
    const rig = padRig();
    rig.pad.buttons[2]!.pressed = true;
    rig.frame();
    rig.frame();
    rig.pad.buttons[2]!.pressed = false;
    expect(rig.frame().pulses.has('heavyPunch')).toBe(false);
    expect(rig.chargeCompletions).toBe(0);
  });

  it('a pad yanked mid-charge fires no phantom blow', () => {
    const pad = makePad();
    let present = true;
    const rig = makeRig(() => (present ? [pad as unknown as GamepadLike] : []));

    pad.buttons[2]!.pressed = true;
    const frames = Math.ceil(T.chargeFullSec / DT) + 2;
    for (let i = 0; i < frames; i++) {
      expect(rig.frame().pulses.has('heavyPunch')).toBe(false);
    }

    present = false;
    expect(rig.frame().pulses.has('heavyPunch')).toBe(false);
    expect(rig.source.connectedId).toBe(null);

    present = true;
    pad.buttons[2]!.pressed = false;
    expect(rig.frame().pulses.has('heavyPunch')).toBe(false);
  });
});

/* ========================================================================== */
/* Lifecycle                                                                  */
/* ========================================================================== */

describe('lifecycle', () => {
  it('a disabled source contributes nothing and abandons the charge', () => {
    const rig = padRig();
    rig.pad.axes[1] = -1;
    rig.pad.buttons[2]!.pressed = true;
    for (let i = 0; i < 30; i++) rig.frame();

    rig.source.enabled = false;
    const idle = rig.frame();
    expect(idle.hasMove).toBe(false);
    expect(idle.held.size).toBe(0);
    expect(idle.pulses.size).toBe(0);
    expect(idle.active).toBe(false);

    rig.source.enabled = true;
    rig.pad.buttons[2]!.pressed = false;
    expect(rig.frame().pulses.has('heavyPunch')).toBe(false);
  });

  it('dispose() is idempotent', () => {
    const rig = padRig();
    rig.frame();
    expect(() => {
      rig.source.dispose();
      rig.source.dispose();
    }).not.toThrow();
  });
});
