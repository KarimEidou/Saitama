/**
 * STATE CONSTRUCTION, PATCHING AND DERIVATION
 *
 * `state.ts` is described in its own header as "the entire contract between
 * input and the rest of the game", and it is what a replay or round-trip tool
 * downstream builds snapshots with. These tests pin the subtle parts: the
 * magnitude-honouring in `normaliseAxisPatch`, the `held` inference chain in
 * `normaliseButtonPatch`, and the per-action merge in `applyInputPatch` that
 * must PRESERVE actions the patch does not name rather than neutralising them.
 */

import { describe, expect, it } from 'vitest';
import type { PointerSample } from '@/types';
import { axisFromVector, NEUTRAL_AXIS } from './axis';
import { INPUT_ACTIONS, NEUTRAL_BUTTON, NEUTRAL_BUTTONS } from './buttons';
import {
  applyInputPatch,
  buttonPatchValue,
  deriveAnyActive,
  describeInputState,
  neutralInputState,
  normaliseAxisPatch,
  normaliseButtonPatch,
  type ButtonPatch,
} from './state';

const SAMPLE: PointerSample = {
  id: 3,
  x: 0.5,
  y: 0.5,
  dx: 0,
  dy: 0,
  pressure: 1,
  down: true,
  up: false,
};

/** The `deriveAnyActive` argument, fully neutral unless overridden. */
function parts(overrides: Partial<Parameters<typeof deriveAnyActive>[0]> = {}) {
  return {
    move: NEUTRAL_AXIS,
    look: NEUTRAL_AXIS,
    buttons: NEUTRAL_BUTTONS,
    pointers: [] as readonly PointerSample[],
    pinchDelta: 1,
    twistDelta: 0,
    ...overrides,
  };
}

/* ========================================================================== */

describe('normaliseAxisPatch', () => {
  it('clamps an over-long vector to the unit circle, preserving direction', () => {
    const axis = normaliseAxisPatch({ x: 3, y: 4 });
    expect(axis.magnitude).toBeCloseTo(1, 6);
    expect(axis.x).toBeCloseTo(0.6, 6);
    expect(axis.y).toBeCloseTo(0.8, 6);
    expect(axis.active).toBe(true);
  });

  it('honours an explicit magnitude as a rescale of the given direction', () => {
    const axis = normaliseAxisPatch({ x: 1, y: 0, magnitude: 0.5 });
    expect(axis.magnitude).toBeCloseTo(0.5, 6);
    expect(axis.x).toBeCloseTo(0.5, 6);
    expect(axis.y).toBeCloseTo(0, 6);
  });

  it('accepts a polar patch', () => {
    const axis = normaliseAxisPatch({ magnitude: 1, angle: Math.PI / 2 });
    expect(axis.x).toBeCloseTo(0, 6);
    expect(axis.y).toBeCloseTo(1, 6);
  });

  it('can be centred but ACTIVE — a thumb down and not yet moved', () => {
    const axis = normaliseAxisPatch({ active: true });
    expect(axis).toMatchObject({ x: 0, y: 0, magnitude: 0, active: true });
  });

  it('returns the shared neutral axis for nothing at all', () => {
    expect(normaliseAxisPatch(undefined)).toBe(NEUTRAL_AXIS);
    expect(normaliseAxisPatch(null)).toBe(NEUTRAL_AXIS);
    expect(normaliseAxisPatch({})).toBe(NEUTRAL_AXIS);
  });

  it('refuses a magnitude with no direction rather than inventing a heading', () => {
    expect(normaliseAxisPatch({ magnitude: 0.5 })).toBe(NEUTRAL_AXIS);
  });
});

/* ========================================================================== */

describe('normaliseButtonPatch', () => {
  it('expands the boolean shorthand', () => {
    expect(normaliseButtonPatch(true)).toMatchObject({ held: true, value: 1, pressed: false });
    expect(normaliseButtonPatch(false)).toBe(NEUTRAL_BUTTON);
    expect(normaliseButtonPatch(undefined)).toBe(NEUTRAL_BUTTON);
  });

  it('expands the analogue shorthand', () => {
    expect(normaliseButtonPatch(0.4)).toMatchObject({ held: true, value: 0.4 });
    expect(normaliseButtonPatch(0)).toBe(NEUTRAL_BUTTON);
  });

  it('infers held from pressed and from a non-zero value', () => {
    expect(normaliseButtonPatch({ pressed: true })).toMatchObject({ held: true, value: 1 });
    expect(normaliseButtonPatch({ value: 0.6 })).toMatchObject({ held: true, value: 0.6 });
  });

  it('an explicit held:false zeroes value, matching buttonPatchValue', () => {
    // A ButtonState that is up yet carries a value is a snapshot no real thumb
    // can produce, and `ButtonTracker.commit` never emits one.
    const patch = { held: false, value: 0.5 };
    expect(normaliseButtonPatch(patch)).toMatchObject({ held: false, value: 0 });
    expect(buttonPatchValue(patch)).toBe(0);
  });

  it('normaliseButtonPatch().value always equals buttonPatchValue()', () => {
    for (const patch of [
      true,
      false,
      0,
      0.4,
      1,
      { pressed: true },
      { value: 0.6 },
      { held: true },
      { held: false, value: 1 },
      { released: true },
    ] as ButtonPatch[]) {
      expect(normaliseButtonPatch(patch).value, JSON.stringify(patch)).toBeCloseTo(
        buttonPatchValue(patch),
        9
      );
    }
  });
});

/* ========================================================================== */

describe('applyInputPatch', () => {
  it('preserves actions the patch does not name', () => {
    const base = applyInputPatch(neutralInputState(), { buttons: { jump: true } });
    const next = applyInputPatch(base, { buttons: { punch: true } });
    expect(next.buttons.jump.held).toBe(true);
    expect(next.buttons.punch.held).toBe(true);
    for (const action of INPUT_ACTIONS) {
      if (action === 'jump' || action === 'punch') continue;
      expect(next.buttons[action], action).toBe(NEUTRAL_BUTTON);
    }
  });

  it('clears an axis with null, and preserves it when omitted', () => {
    const base = applyInputPatch(neutralInputState(), { move: { x: 1, y: 0 } });
    expect(applyInputPatch(base, { move: null }).move).toBe(NEUTRAL_AXIS);
    expect(applyInputPatch(base, { buttons: { jump: true } }).move).toBe(base.move);
  });

  it('lets an explicit anyActive override the derivation', () => {
    const state = applyInputPatch(neutralInputState(), {
      buttons: { punch: true },
      anyActive: false,
    });
    expect(state.anyActive).toBe(false);
  });

  it('freezes the result and its button record', () => {
    const state = applyInputPatch(neutralInputState(), { buttons: { punch: true } });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.buttons)).toBe(true);
  });
});

/* ========================================================================== */

describe('deriveAnyActive', () => {
  it('is false only for a completely neutral set', () => {
    expect(deriveAnyActive(parts())).toBe(false);
  });

  it('is true for anything at all being driven', () => {
    expect(deriveAnyActive(parts({ move: axisFromVector(0.4, 0) })), 'move').toBe(true);
    expect(deriveAnyActive(parts({ look: axisFromVector(0, 0.4) })), 'look').toBe(true);
    expect(deriveAnyActive(parts({ pointers: [SAMPLE] })), 'pointers').toBe(true);
    expect(deriveAnyActive(parts({ pinchDelta: 1.1 })), 'pinch').toBe(true);
    expect(deriveAnyActive(parts({ twistDelta: 0.2 })), 'twist').toBe(true);
    expect(
      deriveAnyActive(
        parts({ buttons: { ...NEUTRAL_BUTTONS, punch: normaliseButtonPatch(true) } })
      ),
      'held'
    ).toBe(true);
    expect(
      deriveAnyActive(
        parts({ buttons: { ...NEUTRAL_BUTTONS, punch: normaliseButtonPatch({ released: true }) } })
      ),
      'released'
    ).toBe(true);
  });
});

/* ========================================================================== */

describe('describeInputState', () => {
  it('names the frame, the device and every held action', () => {
    const state = applyInputPatch(neutralInputState(7, 1.5, 'gamepad'), {
      buttons: { punch: true, sprint: true },
    });
    const text = describeInputState(state);
    expect(text).toContain('f7');
    expect(text).toContain('gamepad');
    expect(text).toContain('punch');
    expect(text).toContain('sprint');
  });

  it('renders a neutral state without throwing', () => {
    expect(() => describeInputState(neutralInputState())).not.toThrow();
    expect(describeInputState(neutralInputState())).toContain('held[none]');
  });
});
