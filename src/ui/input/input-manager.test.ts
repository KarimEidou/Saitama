/**
 * INPUT MANAGER — arbitration, live re-tuning, and the enable/disable contract.
 *
 * `parity.test.ts` proves the backends agree. These tests cover what the
 * manager itself owns: which contribution wins an axis, what happens to a
 * sidelined backend's accumulated state, and keeping the two names for the
 * stick radius from drifting apart.
 */

import { describe, expect, it } from 'vitest';
import type { GamepadLike } from './gamepad-source';
import { createInputManager } from './input-manager';

const DT = 1 / 60;
const W = 1000;
const H = 600;

interface PadState {
  axes: number[];
  buttons: { pressed: boolean; value: number }[];
}

function makePad(): PadState {
  return {
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
}

/* ========================================================================== */

describe('setTuning', () => {
  it('keeps stickRadius and stickFullDeflectionPx in sync, from either name', () => {
    const manager = createInputManager({ headless: true, exposeTestBridge: false });

    manager.setTuning({ stickRadius: 240 });
    expect(manager.tuning.stickRadius).toBe(240);
    expect(manager.tuning.stickFullDeflectionPx).toBe(240);

    manager.setTuning({ stickFullDeflectionPx: 90 });
    expect(manager.tuning.stickFullDeflectionPx).toBe(90);
    expect(manager.tuning.stickRadius).toBe(90);
  });

  it('accumulates successive patches instead of resetting to the defaults', () => {
    const manager = createInputManager({ headless: true, exposeTestBridge: false });
    manager.setTuning({ stickDeadZonePx: 20 });
    manager.setTuning({ lookSensitivity: 2 });
    expect(manager.tuning.stickDeadZonePx).toBe(20);
    expect(manager.tuning.lookSensitivity).toBe(2);
  });

  it('a re-tuned stick radius reaches the touch core', () => {
    const manager = createInputManager({
      headless: true,
      keyboard: false,
      gamepad: false,
      exposeTestBridge: false,
    });
    const core = manager.touch!.core;
    core.setViewport(W, H);
    manager.setTuning({ stickRadius: 240, stickDeadZonePx: 0 });

    core.handle({ id: 1, x: 200, y: 400, phase: 'down', time: 0 });
    core.handle({ id: 1, x: 200, y: 400 - 120, phase: 'move', time: DT });
    // 120px is only half of the new 240px full deflection.
    expect(manager.poll(0, 0).move.magnitude).toBeCloseTo(0.5, 4);
  });
});

/* ========================================================================== */

describe('enabled', () => {
  it('does not flush a disabled period of drag into the first frame back', () => {
    const manager = createInputManager({
      headless: true,
      keyboard: false,
      gamepad: false,
      exposeTestBridge: false,
    });
    const core = manager.touch!.core;
    core.setViewport(W, H);
    manager.poll(0, 0);

    manager.enabled = false;
    // The backend is not torn down by `enabled = false`, so its listeners keep
    // feeding the core: a thumb sweeps the camera half for a long time.
    core.handle({ id: 1, x: 700, y: 300, phase: 'down', time: DT });
    for (let i = 1; i <= 60; i++) {
      core.handle({ id: 1, x: 700 + i * 50, y: 300, phase: 'move', time: (i + 1) * DT });
    }
    expect(manager.poll(1, DT).look.magnitude).toBe(0);

    manager.enabled = true;
    const state = manager.poll(2, 2 * DT);
    expect(state.look.magnitude).toBe(0);
    expect(state.pointers).toHaveLength(0);
  });
});

/* ========================================================================== */

describe('axis arbitration', () => {
  it('breaks a LOOK tie by recency, exactly as it does for move', () => {
    const pad = makePad();
    const manager = createInputManager({
      headless: true,
      keyboard: false,
      exposeTestBridge: false,
      getGamepads: () => [pad as unknown as GamepadLike],
    });
    const core = manager.touch!.core;
    core.setViewport(W, H);

    // A fast thumb sweep LEFT saturates the look rate at magnitude 1...
    core.handle({ id: 1, x: 700, y: 300, phase: 'down', time: 0 });
    manager.poll(0, 0);
    core.handle({ id: 1, x: 400, y: 300, phase: 'move', time: DT });
    expect(manager.poll(1, DT).look.x).toBeCloseTo(-1, 6);

    // ...and stays saturated for several frames after the thumb lifts. Poll
    // once so the lifted pointer is reported and touch stops claiming frames.
    core.handle({ id: 1, x: 400, y: 300, phase: 'up', time: 2 * DT });
    manager.poll(2, 2 * DT);

    // The player has picked up a controller and pushed the right stick RIGHT:
    // same magnitude, opposite direction, more recently active.
    pad.axes[2] = 1;
    const state = manager.poll(3, 3 * DT);
    expect(state.device).toBe('gamepad');
    expect(state.look.x).toBeCloseTo(1, 6);
  });

  it('a decaying mouse-look smoother no longer claims the frame device', () => {
    const manager = createInputManager({
      headless: true,
      gamepad: false,
      mouseLook: true,
      exposeTestBridge: false,
    });
    manager.touch!.core.setViewport(W, H);
    manager.keyboard!.mouseMove(200, 0);
    expect(manager.poll(0, 0).device).toBe('keyboard');

    // The smoother is still decaying when the player taps an on-screen button.
    manager.touch!.core.handle({
      id: 1,
      x: 950,
      y: 520,
      phase: 'down',
      time: DT,
      hit: { kind: 'button', button: 'jump' },
    });
    const state = manager.poll(1, DT);
    expect(state.device).toBe('touch');
    expect(state.buttons.jump.pressed).toBe(true);
    // The decaying look still REACHES the state; it just does not own the device.
    expect(state.look.magnitude).toBeGreaterThan(0);
  });
});
