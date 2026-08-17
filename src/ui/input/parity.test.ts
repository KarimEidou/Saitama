/**
 * DEVICE PARITY
 *
 * The claim under test: for equivalent physical input, touch, keyboard,
 * gamepad and the synthetic driver produce the SAME `InputState`. If that
 * holds, every automated test and the desktop build can drive the real game
 * loop through the same struct, and no gameplay code ever branches on device.
 *
 * These tests build FOUR managers, drive each through its own backend, and
 * compare the resulting snapshots field by field.
 */

import { describe, expect, it } from 'vitest';
import type { InputState } from '@/types';
import { DEFAULT_INPUT_TUNING } from './config';
import type { GamepadLike } from './gamepad-source';
import { createInputManager, type IInputManager } from './input-manager';
import { diffInputStates } from './state';

const DT = 1 / 60;
const T = DEFAULT_INPUT_TUNING;
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

function touchManager(): IInputManager {
  const manager = createInputManager({
    headless: true,
    keyboard: false,
    gamepad: false,
    exposeTestBridge: false,
  });
  manager.touch!.core.setViewport(W, H);
  return manager;
}

function keyboardManager(): IInputManager {
  return createInputManager({
    headless: true,
    touch: false,
    gamepad: false,
    exposeTestBridge: false,
  });
}

function gamepadManager(pad: PadState): IInputManager {
  return createInputManager({
    headless: true,
    touch: false,
    keyboard: false,
    exposeTestBridge: false,
    getGamepads: () => [pad as unknown as GamepadLike],
  });
}

function syntheticManager(): IInputManager {
  const manager = createInputManager({
    headless: true,
    touch: false,
    keyboard: false,
    gamepad: false,
    exposeTestBridge: false,
  });
  manager.syntheticEnabled = true;
  return manager;
}

/** Poll `count` times and return the last snapshot. */
function run(manager: IInputManager, count: number, startFrame = 0): InputState {
  let state = manager.state;
  for (let i = 0; i < count; i++) {
    state = manager.poll(startFrame + i, (startFrame + i) * DT);
  }
  return state;
}

function expectSame(a: InputState, b: InputState, label: string): void {
  const diffs = diffInputStates(a, b, { ignoreHoldTime: false });
  expect(diffs, `${label}: ${diffs.join('; ')}`).toEqual([]);
}

/* ========================================================================== */

describe('move axis parity', () => {
  it('full north: touch === keyboard === gamepad === synthetic', () => {
    const touch = touchManager();
    const keys = keyboardManager();
    const pad = makePad();
    const gamepad = gamepadManager(pad);
    const synth = syntheticManager();

    // Touch: land the thumb, drag exactly full-deflection north.
    touch.touch!.core.handle({ id: 1, x: 200, y: 400, phase: 'down', time: 0 });
    touch.touch!.core.handle({
      id: 1,
      x: 200,
      y: 400 - T.stickFullDeflectionPx,
      phase: 'move',
      time: 0,
    });
    keys.keyboard!.keyDown('KeyW');
    pad.axes[1] = -1; // stick fully up
    synth.synthetic.setMove(0, 1);

    const a = run(touch, 3);
    const b = run(keys, 3);
    const c = run(gamepad, 3);
    const d = run(synth, 3);

    expect(a.move.magnitude).toBeCloseTo(1, 5);
    expect(a.move.y).toBeCloseTo(1, 5);
    expectSame(a, b, 'touch vs keyboard');
    expectSame(b, c, 'keyboard vs gamepad');
    expectSame(c, d, 'gamepad vs synthetic');
  });

  it('full north-east diagonal is NOT clamped short on any device', () => {
    const touch = touchManager();
    const keys = keyboardManager();
    const pad = makePad();
    const gamepad = gamepadManager(pad);
    const synth = syntheticManager();

    const leg = T.stickFullDeflectionPx * Math.SQRT1_2;
    touch.touch!.core.handle({ id: 1, x: 200, y: 400, phase: 'down', time: 0 });
    touch.touch!.core.handle({ id: 1, x: 200 + leg, y: 400 - leg, phase: 'move', time: 0 });

    keys.keyboard!.keyDown('KeyW');
    keys.keyboard!.keyDown('KeyD');

    // A physical stick's gate is square: the corner is (1, -1).
    pad.axes[0] = 1;
    pad.axes[1] = -1;

    synth.synthetic.setMove(Math.SQRT1_2, Math.SQRT1_2);

    const a = run(touch, 3);
    const b = run(keys, 3);
    const c = run(gamepad, 3);
    const d = run(synth, 3);

    // The bug this guards against: a diagonal that reaches only 0.707 or 0.866.
    expect(a.move.magnitude).toBeCloseTo(1, 4);
    expect(b.move.magnitude).toBeCloseTo(1, 4);
    expect(c.move.magnitude).toBeCloseTo(1, 4);
    expectSame(a, b, 'touch vs keyboard');
    expectSame(b, c, 'keyboard vs gamepad');
    expectSame(c, d, 'gamepad vs synthetic');
  });

  it('a half-deflection push agrees between touch and synthetic', () => {
    const touch = touchManager();
    const synth = syntheticManager();
    const half = T.stickDeadZonePx + (T.stickFullDeflectionPx - T.stickDeadZonePx) * 0.5;

    touch.touch!.core.handle({ id: 1, x: 200, y: 400, phase: 'down', time: 0 });
    touch.touch!.core.handle({ id: 1, x: 200 + half, y: 400, phase: 'move', time: 0 });
    synth.synthetic.setMove(0.5, 0);

    expectSame(run(touch, 3), run(synth, 3), 'touch vs synthetic');
  });

  it('all four report a centred, inactive stick when idle', () => {
    const pad = makePad();
    const managers = [touchManager(), keyboardManager(), gamepadManager(pad), syntheticManager()];
    const states = managers.map((m) => run(m, 3));
    for (const state of states) {
      expect(state.move.magnitude).toBe(0);
      expect(state.move.active).toBe(false);
    }
    // Synthetic is deliberately "active" while armed, so compare the first three.
    expectSame(states[0]!, states[1]!, 'touch vs keyboard');
    expectSame(states[1]!, states[2]!, 'keyboard vs gamepad');
  });
});

/* ========================================================================== */

describe('button parity', () => {
  it('punch produces identical edges from every device', () => {
    const touch = touchManager();
    const keys = keyboardManager();
    const pad = makePad();
    const gamepad = gamepadManager(pad);
    const synth = syntheticManager();

    touch.touch!.core.handle({
      id: 1,
      x: 950,
      y: 520,
      phase: 'down',
      time: 0,
      hit: { kind: 'button', button: 'punch' },
    });
    keys.keyboard!.keyDown('KeyJ');
    pad.buttons[2] = { pressed: true, value: 1 };
    synth.synthetic.press('punch');

    // Frame 1: pressed everywhere.
    for (const m of [touch, keys, gamepad, synth]) {
      const s = m.poll(0, 0);
      expect(s.buttons.punch, m.activeDevice).toMatchObject({ pressed: true, held: true });
    }
    // Frame 2: held, not pressed.
    for (const m of [touch, keys, gamepad, synth]) {
      const s = m.poll(1, DT);
      expect(s.buttons.punch, m.activeDevice).toMatchObject({ pressed: false, held: true });
      expect(s.buttons.punch.holdTime).toBeCloseTo(DT, 9);
    }
  });

  it('a charged punch fires heavyPunch with the same ratio from touch, key and pad', () => {
    const touch = touchManager();
    const keys = keyboardManager();
    const pad = makePad();
    const gamepad = gamepadManager(pad);

    touch.touch!.core.handle({
      id: 1,
      x: 950,
      y: 520,
      phase: 'down',
      time: 0,
      hit: { kind: 'button', button: 'punch' },
    });
    keys.keyboard!.keyDown('KeyJ');
    pad.buttons[2] = { pressed: true, value: 1 };

    const holdFrames = Math.ceil(T.chargeFullSec / DT) + 4;
    run(touch, holdFrames);
    run(keys, holdFrames);
    run(gamepad, holdFrames);

    touch.touch!.core.handle({ id: 1, x: 950, y: 520, phase: 'up', time: holdFrames * DT });
    keys.keyboard!.keyUp('KeyJ');
    pad.buttons[2] = { pressed: false, value: 0 };

    const a = touch.poll(holdFrames, holdFrames * DT);
    const b = keys.poll(holdFrames, holdFrames * DT);
    const c = gamepad.poll(holdFrames, holdFrames * DT);

    expect(a.buttons.heavyPunch.pressed).toBe(true);
    expect(a.buttons.heavyPunch.value).toBeCloseTo(1, 3);
    expectSame(a, b, 'touch vs keyboard');
    expectSame(b, c, 'keyboard vs gamepad');
  });

  it('a quick tap never fires heavyPunch on any device', () => {
    const touch = touchManager();
    const keys = keyboardManager();
    const pad = makePad();
    const gamepad = gamepadManager(pad);

    touch.touch!.core.handle({
      id: 1,
      x: 950,
      y: 520,
      phase: 'down',
      time: 0,
      hit: { kind: 'button', button: 'punch' },
    });
    keys.keyboard!.keyDown('KeyJ');
    pad.buttons[2] = { pressed: true, value: 1 };
    run(touch, 2);
    run(keys, 2);
    run(gamepad, 2);

    touch.touch!.core.handle({ id: 1, x: 950, y: 520, phase: 'up', time: 2 * DT });
    keys.keyboard!.keyUp('KeyJ');
    pad.buttons[2] = { pressed: false, value: 0 };

    const a = touch.poll(2, 2 * DT);
    const b = keys.poll(2, 2 * DT);
    const c = gamepad.poll(2, 2 * DT);
    expect(a.buttons.heavyPunch.pressed).toBe(false);
    expectSame(a, b, 'touch vs keyboard');
    expectSame(b, c, 'keyboard vs gamepad');
  });

  it('sprint is identical whether it came from a toggle, a key or L3', () => {
    const touch = touchManager();
    const keys = keyboardManager();
    const pad = makePad();
    const gamepad = gamepadManager(pad);

    touch.touch!.core.setDashToggle(true);
    keys.keyboard!.keyDown('ShiftLeft');
    pad.buttons[10] = { pressed: true, value: 1 };

    const a = run(touch, 4);
    const b = run(keys, 4);
    const c = run(gamepad, 4);
    expect(a.buttons.sprint.held).toBe(true);
    expectSame(a, b, 'touch vs keyboard');
    expectSame(b, c, 'keyboard vs gamepad');
  });

  it('gesture-driven lockOn matches a key press and R3', () => {
    const touch = touchManager();
    const keys = keyboardManager();
    const pad = makePad();
    const gamepad = gamepadManager(pad);
    const core = touch.touch!.core;

    // Two-finger tap on the camera half.
    core.handle({ id: 1, x: 650, y: 300, phase: 'down', time: 0 });
    core.handle({ id: 2, x: 800, y: 320, phase: 'down', time: 0.03 });
    core.handle({ id: 1, x: 650, y: 300, phase: 'up', time: 0.09 });
    core.handle({ id: 2, x: 800, y: 320, phase: 'up', time: 0.09 });
    keys.keyboard!.keyDown('KeyQ');
    pad.buttons[11] = { pressed: true, value: 1 };

    const a = touch.poll(0, 0);
    const b = keys.poll(0, 0);
    const c = gamepad.poll(0, 0);
    expect(a.buttons.lockOn.pressed).toBe(true);
    expect(b.buttons.lockOn.pressed).toBe(true);
    expect(c.buttons.lockOn.pressed).toBe(true);
  });
});

/* ========================================================================== */

describe('look axis parity', () => {
  it('keyboard look keys and a gamepad right stick agree exactly', () => {
    const keys = keyboardManager();
    const pad = makePad();
    const gamepad = gamepadManager(pad);

    keys.keyboard!.keyDown('Period'); // look right
    pad.axes[2] = 1;

    const b = run(keys, 3);
    const c = run(gamepad, 3);
    expect(b.look.x).toBeCloseTo(1, 5);
    expectSame(b, c, 'keyboard vs gamepad');
  });

  it('touch drag and synthetic agree once the smoother has converged', () => {
    const touch = touchManager();
    const core = touch.touch!.core;
    core.handle({ id: 1, x: 700, y: 300, phase: 'down', time: 0 });

    // Drag at a constant rate for long enough for the exponential smoother to
    // settle, then compare against the analytic rate.
    let x = 700;
    let state = touch.state;
    for (let i = 1; i <= 90; i++) {
      x += 3;
      core.handle({ id: 1, x, y: 300, phase: 'move', time: i * DT });
      state = touch.poll(i, i * DT);
    }
    const expectedDegPerSec = (3 * T.cameraDegPerPx) / DT;
    const expectedNormalised = expectedDegPerSec / T.lookFullRateDegPerSec;
    expect(state.look.x).toBeCloseTo(expectedNormalised, 2);
  });
});

/* ========================================================================== */

describe('device reporting', () => {
  it('reports which backend produced the frame', () => {
    const touch = touchManager();
    touch.touch!.core.handle({ id: 1, x: 200, y: 400, phase: 'down', time: 0 });
    expect(run(touch, 2).device).toBe('touch');

    const keys = keyboardManager();
    keys.keyboard!.keyDown('KeyW');
    expect(run(keys, 2).device).toBe('keyboard');

    const pad = makePad();
    pad.axes[1] = -1;
    expect(run(gamepadManager(pad), 2).device).toBe('gamepad');

    const synth = syntheticManager();
    synth.synthetic.setMove(1, 0);
    expect(run(synth, 2).device).toBe('synthetic');
  });

  it('merges simultaneous devices instead of letting them fight', () => {
    const manager = createInputManager({ headless: true, exposeTestBridge: false });
    manager.touch!.core.setViewport(W, H);
    manager.touch!.core.setDashToggle(true); // sprint from touch
    manager.keyboard!.keyDown('KeyW'); // move from keyboard

    const state = run(manager, 3);
    expect(state.buttons.sprint.held).toBe(true);
    expect(state.move.y).toBeCloseTo(1, 5);
  });

  it('lets the larger stick magnitude win, so an idle pad cannot veto a thumb', () => {
    const pad = makePad();
    pad.axes[0] = 0.2; // a lightly-leaning stick
    const manager = createInputManager({
      headless: true,
      keyboard: false,
      exposeTestBridge: false,
      getGamepads: () => [pad as unknown as GamepadLike],
    });
    manager.touch!.core.setViewport(W, H);
    manager.touch!.core.handle({ id: 1, x: 200, y: 400, phase: 'down', time: 0 });
    manager.touch!.core.handle({
      id: 1,
      x: 200,
      y: 400 - T.stickFullDeflectionPx,
      phase: 'move',
      time: 0,
    });

    const state = run(manager, 3);
    expect(state.move.y).toBeCloseTo(1, 4);
    expect(state.move.x).toBeCloseTo(0, 4);
  });
});
