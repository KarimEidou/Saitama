/**
 * SYNTHETIC DRIVER + TEST BRIDGE
 *
 * These tests are the contract every downstream workstream codes against. If
 * one of them changes, someone else's E2E test breaks.
 */

import { describe, expect, it } from 'vitest';
import { createInputTestBridge } from './test-bridge';
import { createInputManager, type IInputManager } from './input-manager';
import { INPUT_ACTIONS } from './buttons';
import { applyInputPatch, cloneInputState, inputStatesEqual, neutralInputState } from './state';

const DT = 1 / 60;

function makeManager(): IInputManager {
  return createInputManager({
    headless: true,
    touch: false,
    keyboard: false,
    gamepad: false,
    exposeTestBridge: false,
  });
}

/** Poll once, advancing the clock by one frame. */
function step(manager: IInputManager, frame: number) {
  return manager.poll(frame, frame * DT);
}

describe('setState — the IInputSource entry point', () => {
  it('arms the synthetic driver on first use, with no separate enable step', () => {
    const manager = makeManager();
    expect(manager.syntheticEnabled).toBe(false);
    manager.setState({ move: { x: 1, y: 0 } });
    expect(manager.syntheticEnabled).toBe(true);
    const state = step(manager, 0);
    expect(state.device).toBe('synthetic');
    expect(state.move.x).toBeCloseTo(1, 6);
  });

  it('derives magnitude, angle and active from a bare x/y', () => {
    const manager = makeManager();
    manager.setState({ move: { x: 0, y: 1 } });
    const state = step(manager, 0);
    expect(state.move).toMatchObject({ x: 0, y: 1, magnitude: 1, active: true });
    expect(state.move.angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('accepts a button shorthand', () => {
    const manager = makeManager();
    manager.setState({ buttons: { punch: true, sprint: 0.5 } });
    const state = step(manager, 0);
    expect(state.buttons.punch.held).toBe(true);
    expect(state.buttons.sprint.value).toBeCloseTo(0.5, 6);
  });

  it('LATCHES: what you set persists across frames', () => {
    const manager = makeManager();
    manager.setState({ move: { x: 1, y: 0 } });
    for (let frame = 0; frame < 10; frame++) {
      expect(step(manager, frame).move.x, `frame ${frame}`).toBeCloseTo(1, 6);
    }
  });

  it('produces REAL edges: pressed once, then held', () => {
    const manager = makeManager();
    manager.setState({ buttons: { jump: true } });
    expect(step(manager, 0).buttons.jump).toMatchObject({ pressed: true, held: true });
    expect(step(manager, 1).buttons.jump).toMatchObject({ pressed: false, held: true });
    expect(step(manager, 2).buttons.jump.holdTime).toBeCloseTo(2 * DT, 9);

    manager.setState({ buttons: { jump: false } });
    expect(step(manager, 3).buttons.jump).toMatchObject({ held: false, released: true });
  });

  it('clamps an over-long vector to the unit circle', () => {
    const manager = makeManager();
    manager.setState({ move: { x: 5, y: 5 } });
    const state = step(manager, 0);
    expect(state.move.magnitude).toBeCloseTo(1, 6);
  });

  it('is exclusive — real backends are ignored while armed', () => {
    const manager = createInputManager({ headless: true, exposeTestBridge: false });
    manager.touch!.core.setViewport(1000, 600);
    manager.keyboard!.keyDown('KeyD'); // would move east
    manager.setState({ move: { x: 0, y: 1 } }); // synthetic says north
    const state = step(manager, 0);
    expect(state.move.y).toBeCloseTo(1, 5);
    expect(state.move.x).toBeCloseTo(0, 5);
    expect(state.device).toBe('synthetic');
  });

  it('hands control back cleanly, with nothing latched', () => {
    const manager = createInputManager({ headless: true, exposeTestBridge: false });
    manager.setState({ move: { x: 1, y: 0 }, buttons: { punch: true } });
    step(manager, 0);
    manager.syntheticEnabled = false;
    const state = step(manager, 1);
    expect(state.move.magnitude).toBe(0);
    expect(state.buttons.punch.held).toBe(false);
    expect(state.buttons.punch.released).toBe(false);
  });
});

describe('press / release / tap', () => {
  it('tap is held for exactly one poll', () => {
    const manager = makeManager();
    manager.syntheticEnabled = true;
    manager.synthetic.tap('jump');
    expect(step(manager, 0).buttons.jump).toMatchObject({ pressed: true, held: true });
    expect(step(manager, 1).buttons.jump).toMatchObject({ held: false, released: true });
    expect(step(manager, 2).buttons.jump.released).toBe(false);
  });

  it('press latches until release', () => {
    const manager = makeManager();
    manager.syntheticEnabled = true;
    manager.synthetic.press('block');
    step(manager, 0);
    expect(step(manager, 1).buttons.block.held).toBe(true);
    manager.synthetic.release('block');
    expect(step(manager, 2).buttons.block.released).toBe(true);
  });

  it('carries an analogue value through', () => {
    const manager = makeManager();
    manager.syntheticEnabled = true;
    manager.synthetic.press('heavyPunch', 0.62);
    expect(step(manager, 0).buttons.heavyPunch.value).toBeCloseTo(0.62, 6);
  });

  it('clear() releases everything but stays armed', () => {
    const manager = makeManager();
    manager.setState({ move: { x: 1, y: 0 }, buttons: { punch: true } });
    step(manager, 0);
    manager.synthetic.clear();
    const state = step(manager, 1);
    expect(state.move.magnitude).toBe(0);
    expect(state.buttons.punch.released).toBe(true);
    expect(manager.syntheticEnabled).toBe(true);
  });

  it('every action in the contract is drivable', () => {
    const manager = makeManager();
    manager.syntheticEnabled = true;
    for (const action of INPUT_ACTIONS) {
      manager.synthetic.press(action);
    }
    const state = step(manager, 0);
    for (const action of INPUT_ACTIONS) {
      expect(state.buttons[action].held, action).toBe(true);
    }
  });
});

describe('pinch, twist and pointers', () => {
  it('pinch applies to the next poll only', () => {
    const manager = makeManager();
    manager.syntheticEnabled = true;
    manager.synthetic.setPinch(1.25);
    expect(step(manager, 0).pinchDelta).toBeCloseTo(1.25, 6);
    expect(step(manager, 1).pinchDelta).toBe(1);
  });

  it('twist applies to the next poll only', () => {
    const manager = makeManager();
    manager.syntheticEnabled = true;
    manager.synthetic.setTwist(0.4);
    expect(step(manager, 0).twistDelta).toBeCloseTo(0.4, 6);
    expect(step(manager, 1).twistDelta).toBe(0);
  });

  it('injected pointers reach InputState.pointers', () => {
    const manager = makeManager();
    manager.syntheticEnabled = true;
    manager.synthetic.setPointers([
      { id: 7, x: 0.25, y: 0.5, dx: 0, dy: 0, pressure: 1, down: true, up: false },
    ]);
    const state = step(manager, 0);
    expect(state.pointers).toHaveLength(1);
    expect(state.pointers[0]).toMatchObject({ id: 7, x: 0.25, y: 0.5 });
  });
});

describe('scripted sequences', () => {
  it('runs a queued script one step at a time', () => {
    const manager = makeManager();
    manager.syntheticEnabled = true;
    manager.synthetic.queue([
      { frames: 3, patch: { move: { x: 0, y: 1 } }, label: 'run north' },
      { frames: 1, taps: ['punch'], label: 'punch' },
      { frames: 2, patch: { move: null }, label: 'stop' },
    ]);

    const north = [step(manager, 0), step(manager, 1), step(manager, 2)];
    for (const state of north) expect(state.move.y).toBeCloseTo(1, 6);

    const punch = step(manager, 3);
    expect(punch.buttons.punch.pressed).toBe(true);

    const stop = step(manager, 4);
    expect(stop.move.magnitude).toBe(0);
    step(manager, 5);
    expect(manager.synthetic.scriptRunning).toBe(false);
  });
});

describe('window.__INPUT__ bridge', () => {
  it('exposes a JSON-serialisable snapshot', () => {
    const manager = makeManager();
    const bridge = createInputTestBridge(manager);
    bridge.setMove(0, 1);
    bridge.press('sprint');
    step(manager, 0);

    const snapshot = bridge.snapshot();
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    expect(roundTripped.move.y).toBeCloseTo(1, 6);
    expect(roundTripped.buttons.sprint.held).toBe(true);
    // Round-tripping through JSON must not change anything.
    expect(inputStatesEqual(snapshot, roundTripped, { ignoreTiming: false })).toBe(true);
  });

  it('snapshot is a deep copy — mutating it cannot corrupt the manager', () => {
    const manager = makeManager();
    const bridge = createInputTestBridge(manager);
    bridge.setMove(1, 0);
    step(manager, 0);
    const snapshot = bridge.snapshot();
    // `InputState` is deeply readonly to consumers; a replay tool holding a
    // clone is entitled to scribble on it, so the cast is the point of the test.
    (snapshot.buttons.punch as { held: boolean }).held = true;
    expect(manager.state.buttons.punch.held).toBe(false);
  });

  it('step() advances the manager for pages with no render loop', () => {
    const manager = makeManager();
    const bridge = createInputTestBridge(manager);
    bridge.tap('jump');
    const first = bridge.step(0, 0);
    expect(first.buttons.jump.pressed).toBe(true);
    const second = bridge.step(1, DT);
    expect(second.buttons.jump.released).toBe(true);
  });

  it('reset() releases everything and hands control back', () => {
    const manager = makeManager();
    const bridge = createInputTestBridge(manager);
    bridge.setMove(1, 0);
    step(manager, 0);
    bridge.reset();
    expect(bridge.enabled).toBe(false);
    expect(step(manager, 1).move.magnitude).toBe(0);
  });

  it('reports the active device and haptic counts', () => {
    const manager = makeManager();
    const bridge = createInputTestBridge(manager);
    bridge.setMove(1, 0);
    step(manager, 0);
    expect(bridge.device()).toBe('synthetic');
    manager.haptics.play('kill');
    expect(bridge.hapticCounts().kill).toBe(1);
  });

  it('exposes tuning and accepts overrides', () => {
    const manager = makeManager();
    const bridge = createInputTestBridge(manager);
    expect(bridge.config().stickDeadZonePx).toBe(56);
    bridge.setConfig({ stickDeadZonePx: 20 });
    expect(bridge.config().stickDeadZonePx).toBe(20);
  });
});

describe('state helpers', () => {
  it('applyInputPatch derives anyActive', () => {
    const base = neutralInputState();
    expect(base.anyActive).toBe(false);
    expect(applyInputPatch(base, { buttons: { punch: true } }).anyActive).toBe(true);
    expect(applyInputPatch(base, { move: { x: 0.4, y: 0 } }).anyActive).toBe(true);
    expect(applyInputPatch(base, { pinchDelta: 1.1 }).anyActive).toBe(true);
  });

  it('cloneInputState produces an independent copy', () => {
    const state = applyInputPatch(neutralInputState(), { buttons: { punch: true } });
    const copy = cloneInputState(state);
    (copy.buttons.punch as { held: boolean }).held = false;
    expect(state.buttons.punch.held).toBe(true);
  });

  it('inputStatesEqual ignores device and timing by default', () => {
    const a = neutralInputState(1, 0.5, 'touch');
    const b = neutralInputState(99, 42, 'gamepad');
    expect(inputStatesEqual(a, b)).toBe(true);
    expect(inputStatesEqual(a, b, { ignoreDevice: false })).toBe(false);
  });
});
