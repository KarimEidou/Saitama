/**
 * KEYBOARD (+ MOUSE) BACKEND
 *
 * The header of `keyboard-source.ts` promises the backend can be driven in Node
 * with no DOM — these tests take it up on that, and cover the branches
 * `parity.test.ts` cannot see through the manager merge: opposite-key
 * cancellation, the auto-repeat filter, `preventDefault` policy, blur, the
 * mouse-look smoother's drain, and `heldKeys()`.
 *
 * Two rigs: one driving the plain methods, one dispatching through a fake
 * `EventTarget` so the DOM handlers are exercised without a DOM.
 */

import { describe, expect, it } from 'vitest';
import { InputContribution } from './backend';
import { DEFAULT_INPUT_TUNING, resolveTuning } from './config';
import { createKeyboardSource, DEFAULT_KEY_MAP } from './keyboard-source';

const DT = 1 / 60;
const T = DEFAULT_INPUT_TUNING;

function fakeTarget() {
  const handlers = new Map<string, (event: Event) => void>();
  const target = {
    addEventListener: (type: string, fn: (e: Event) => void) => void handlers.set(type, fn),
    removeEventListener: (type: string) => void handlers.delete(type),
    dispatchEvent: () => true,
  } as unknown as EventTarget;
  return { target, handlers };
}

interface KeyInit {
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** A `KeyboardEvent` stub that records whether its default was suppressed. */
function keyEvent(code: string, init: KeyInit = {}) {
  let prevented = false;
  const event = {
    code,
    repeat: init.repeat ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    preventDefault: () => {
      prevented = true;
    },
  };
  return {
    event: event as unknown as Event,
    get prevented() {
      return prevented;
    },
  };
}

function makeRig(options: { target?: EventTarget | null; tuning?: typeof T } = {}) {
  let completions = 0;
  const source = createKeyboardSource(options.tuning ?? T, {
    target: options.target === undefined ? null : options.target,
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

/* ========================================================================== */
/* Movement                                                                   */
/* ========================================================================== */

describe('movement', () => {
  it('reaches the unit circle on a cardinal AND on a diagonal', () => {
    const rig = makeRig();
    rig.source.keyDown('KeyW');
    let out = rig.frame();
    expect(out.hasMove).toBe(true);
    expect(out.moveY).toBeCloseTo(1, 6);

    // W+D is the square's corner: it must be MAPPED onto the circle, not
    // clipped, or keyboard diagonals run 29% slower than touch diagonals.
    rig.source.keyDown('KeyD');
    out = rig.frame();
    expect(Math.hypot(out.moveX, out.moveY)).toBeCloseTo(1, 6);
    expect(out.moveX).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('cancels opposite keys to CENTRED, not to a half-magnitude vector', () => {
    const rig = makeRig();
    rig.source.keyDown('KeyW');
    rig.source.keyDown('KeyS');
    expect(rig.frame().hasMove).toBe(false);
  });

  it('treats the arrow keys as aliases of WASD', () => {
    const wasd = makeRig();
    wasd.source.keyDown('KeyW');
    const a = wasd.frame();

    const arrows = makeRig();
    arrows.source.keyDown('ArrowUp');
    const b = arrows.frame();

    expect(b.hasMove).toBe(a.hasMove);
    expect(b.moveX).toBeCloseTo(a.moveX, 9);
    expect(b.moveY).toBeCloseTo(a.moveY, 9);
  });
});

/* ========================================================================== */
/* Key handling                                                               */
/* ========================================================================== */

describe('key handling', () => {
  it('every mapped key contributes its action', () => {
    const rig = makeRig();
    for (const [code, action] of Object.entries(DEFAULT_KEY_MAP)) {
      rig.source.keyDown(code);
      expect(rig.frame().held.get(action), code).toBe(1);
      rig.source.keyUp(code);
    }
  });

  it('keyUp for a key that was never held is a no-op', () => {
    const rig = makeRig();
    expect(() => rig.source.keyUp('KeyJ')).not.toThrow();
    const out = rig.frame();
    expect(out.pulses.size).toBe(0);
    expect(out.held.size).toBe(0);
  });

  it('heldKeys() is sorted and deduplicated', () => {
    const rig = makeRig();
    rig.source.keyDown('KeyW');
    rig.source.keyDown('KeyA');
    rig.source.keyDown('KeyW');
    expect(rig.source.heldKeys()).toEqual(['KeyA', 'KeyW']);
  });

  it('a repeated keyDown does not restart the punch charge', () => {
    const rig = makeRig();
    rig.source.keyDown('KeyJ');
    // Just past chargeStartSec, so a release is worth a heavyPunch...
    const frames = Math.ceil(T.chargeStartSec / DT) + 2;
    for (let i = 0; i < frames; i++) rig.frame();
    // ...and the OS's auto-repeat must not reset the clock back to zero.
    rig.source.keyDown('KeyJ');
    rig.source.keyUp('KeyJ');
    expect(rig.frame().pulses.get('heavyPunch')).toBeGreaterThan(0);
  });

  it('drops held keys when disabled, and does not resurrect them', () => {
    const rig = makeRig();
    rig.source.keyDown('KeyW');
    expect(rig.frame().hasMove).toBe(true);
    rig.source.enabled = false;
    rig.source.enabled = true;
    expect(rig.frame().hasMove).toBe(false);
    expect(rig.source.heldKeys()).toEqual([]);
  });
});

/* ========================================================================== */
/* DOM wiring                                                                 */
/* ========================================================================== */

describe('DOM handlers', () => {
  it('ignores an auto-repeat event that arrives before any real keydown', () => {
    const { target, handlers } = fakeTarget();
    const source = createKeyboardSource(T, { target });
    handlers.get('keydown')!(keyEvent('KeyW', { repeat: true }).event);
    expect(source.heldKeys()).toEqual([]);
  });

  it('ignores unbound keys entirely', () => {
    const { target, handlers } = fakeTarget();
    const source = createKeyboardSource(T, { target });
    handlers.get('keydown')!(keyEvent('KeyZ').event);
    expect(source.heldKeys()).toEqual([]);
  });

  it('suppresses the browser default for a bound key, repeats INCLUDED', () => {
    const { target, handlers } = fakeTarget();
    const source = createKeyboardSource(T, { target });
    const onKeyDown = handlers.get('keydown')!;

    const first = keyEvent('Space');
    onKeyDown(first.event);
    expect(first.prevented).toBe(true);
    expect(source.heldKeys()).toEqual(['Space']);

    // A HELD Space keeps firing repeat events. Each one that escapes scrolls
    // the host page, so the default must be suppressed before the filter —
    // while the key itself stays un-re-registered.
    const repeat = keyEvent('Space', { repeat: true });
    onKeyDown(repeat.event);
    expect(repeat.prevented).toBe(true);
    expect(source.heldKeys()).toEqual(['Space']);
  });

  it('leaves unbound keys and modifier combinations to the browser', () => {
    const { target, handlers } = fakeTarget();
    createKeyboardSource(T, { target });
    const onKeyDown = handlers.get('keydown')!;

    const unbound = keyEvent('KeyZ');
    onKeyDown(unbound.event);
    expect(unbound.prevented).toBe(false);

    // Ctrl+R / Cmd+L / Alt+Tab belong to the browser and the OS.
    const reload = keyEvent('KeyR', { ctrlKey: true });
    onKeyDown(reload.event);
    expect(reload.prevented).toBe(false);

    const boundWithCtrl = keyEvent('KeyW', { ctrlKey: true });
    onKeyDown(boundWithCtrl.event);
    expect(boundWithCtrl.prevented).toBe(false);
  });

  it('blur drops every key and abandons a charge in flight', () => {
    const { target, handlers } = fakeTarget();
    const source = createKeyboardSource(T, { target });
    const out = new InputContribution();
    const onKeyDown = handlers.get('keydown')!;

    onKeyDown(keyEvent('KeyW').event);
    onKeyDown(keyEvent('KeyJ').event);
    for (let i = 0; i < 40; i++) {
      out.reset();
      source.sample(DT, i * DT, out);
    }
    expect(source.heldKeys()).toEqual(['KeyJ', 'KeyW']);

    handlers.get('blur')!(new Event('blur'));
    expect(source.heldKeys()).toEqual([]);

    out.reset();
    source.sample(DT, 41 * DT, out);
    expect(out.hasMove).toBe(false);
    expect(out.held.size).toBe(0);
    expect(out.pulses.has('heavyPunch')).toBe(false);
  });

  it('keyup through the DOM releases the key', () => {
    const { target, handlers } = fakeTarget();
    const source = createKeyboardSource(T, { target });
    handlers.get('keydown')!(keyEvent('KeyW').event);
    handlers.get('keyup')!(keyEvent('KeyW').event);
    expect(source.heldKeys()).toEqual([]);
  });

  it('dispose() detaches every listener', () => {
    const { target, handlers } = fakeTarget();
    const source = createKeyboardSource(T, { target });
    expect(handlers.size).toBeGreaterThan(0);
    source.dispose();
    expect(handlers.size).toBe(0);
  });
});

/* ========================================================================== */
/* Look                                                                       */
/* ========================================================================== */

describe('look', () => {
  it('a held look key reaches full deflection', () => {
    const rig = makeRig();
    rig.source.keyDown('Period');
    const out = rig.frame();
    expect(out.hasLook).toBe(true);
    expect(out.lookX).toBeCloseTo(1, 6);
    expect(out.lookY).toBeCloseTo(0, 6);
  });

  it('mouse-look accumulates, then drains to nothing', () => {
    const rig = makeRig();
    rig.source.mouseMove(120, 0);
    const first = rig.frame();
    expect(first.hasLook).toBe(true);
    expect(first.lookX).toBeGreaterThan(0);

    // With no further input the smoother decays and eventually settles, at
    // which point the backend stops reporting a look at all.
    let settledAfter = -1;
    for (let i = 0; i < 200; i++) {
      if (!rig.frame().hasLook) {
        settledAfter = i;
        break;
      }
    }
    expect(settledAfter).toBeGreaterThanOrEqual(0);
  });
});

/* ========================================================================== */
/* Tuning                                                                     */
/* ========================================================================== */

describe('setTuning', () => {
  it('honours a live re-tune of the charge window', () => {
    const rig = makeRig();
    rig.source.keyDown('KeyJ');
    rig.frame();
    rig.frame();
    // Under the DEFAULT 1.0s window a charge needs 60 frames; 10 is nothing.
    expect(rig.chargeCompletions).toBe(0);

    rig.source.setTuning(resolveTuning({ chargeFullSec: 0.1 }));
    for (let i = 0; i < 8; i++) rig.frame();
    expect(rig.chargeCompletions).toBe(1);
  });
});
