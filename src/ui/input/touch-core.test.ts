import { describe, expect, it } from 'vitest';
import type { AxisState, ButtonState, InputAction } from '@/types';
import { axisFromVector, NEUTRAL_AXIS } from './axis';
import { InputContribution } from './backend';
import { ButtonTracker } from './buttons';
import { DEFAULT_INPUT_TUNING, resolveTuning, type IInputTuning } from './config';
import { fixedStickAnchor, isStickZone, ZERO_SAFE_AREA } from './stick-geometry';
import { TouchCore, type GestureEvent, type TouchButtonId, type TouchHit } from './touch-core';

const W = 1000;
const H = 600;
const DT = 1 / 60;
const T = DEFAULT_INPUT_TUNING;
/** The shipping tuning with the FLOATING layout selected, for the tests about it. */
const FLOATING = resolveTuning({ floatingStick: true });
/**
 * A point deep in the stick zone and far from the anchored stick's home, so the
 * origin lands under the thumb in BOTH layouts and a test that is about
 * something else (roles, cancellation, taps) does not have to care which is on.
 */
const FAR = { x: 200, y: 400 } as const;

interface Frame {
  readonly move: AxisState;
  readonly look: { x: number; y: number };
  readonly buttons: Readonly<Record<InputAction, ButtonState>>;
  readonly pinchDelta: number;
  readonly twistDelta: number;
  readonly pointerCount: number;
  readonly contribution: InputContribution;
}

/**
 * Mimics exactly what `InputManager` does with a contribution, so these tests
 * assert on the same numbers gameplay will see — not on core internals.
 */
function makeRig(tuning: IInputTuning = DEFAULT_INPUT_TUNING) {
  const gestures: GestureEvent[] = [];
  let chargeCompletions = 0;
  const core = new TouchCore(tuning, {
    onGesture: (event) => gestures.push(event),
    onChargeComplete: () => chargeCompletions++,
  });
  core.setViewport(W, H);

  const out = new InputContribution();
  const tracker = new ButtonTracker();
  let time = 0;

  function frame(dt = DT): Frame {
    time += dt;
    out.reset();
    core.sample(dt, time, out);
    for (const [action, value] of out.held) tracker.contribute(action, value);
    for (const [action, value] of out.pulses) tracker.pulse(action, value);
    for (const action of out.silentClears) tracker.clearSilently(action);
    const buttons = tracker.commit(dt);
    return {
      move: out.hasMove ? axisFromVector(out.moveX, out.moveY, true) : NEUTRAL_AXIS,
      look: { x: out.lookX, y: out.lookY },
      buttons,
      pinchDelta: out.pinchDelta,
      twistDelta: out.twistDelta,
      pointerCount: out.pointers.length,
      contribution: out,
    };
  }

  return {
    core,
    gestures,
    get chargeCompletions() {
      return chargeCompletions;
    },
    get now() {
      return time;
    },
    /** Advance the clock WITHOUT sampling, so events can be spaced in time. */
    wait(seconds: number) {
      time += seconds;
    },
    down(id: number, x: number, y: number, hit: TouchHit = null) {
      core.handle({ id, x, y, phase: 'down', time, hit });
    },
    button(id: number, x: number, y: number, name: TouchButtonId) {
      core.handle({ id, x, y, phase: 'down', time, hit: { kind: 'button', button: name } });
    },
    move(id: number, x: number, y: number) {
      core.handle({ id, x, y, phase: 'move', time });
    },
    up(id: number, x: number, y: number) {
      core.handle({ id, x, y, phase: 'up', time });
    },
    cancel(id: number, x: number, y: number) {
      core.handle({ id, x, y, phase: 'cancel', time });
    },
    frame,
  };
}

/* ========================================================================== */
/* Virtual stick                                                              */
/* ========================================================================== */

describe('virtual stick', () => {
  it('FLOATING anchors its origin wherever the thumb lands', () => {
    const rig = makeRig(FLOATING);
    rig.down(1, 137, 511);
    expect(rig.core.stick).toMatchObject({ originX: 137, originY: 511 });
    rig.up(1, 137, 511);
    rig.frame();

    rig.down(2, 402, 190);
    expect(rig.core.stick).toMatchObject({ originX: 402, originY: 190 });
  });

  it('ANCHORED aims a centred grab at the painted centre, to the pixel', () => {
    // What the aim tolerance is for. A thumb that meant the middle of the ring
    // gets the middle of the ring as its neutral, so the artwork's centre is
    // the stick's centre and the knob starts exactly under the home pip.
    const rig = makeRig();
    const anchor = fixedStickAnchor(T, W, H, ZERO_SAFE_AREA);

    rig.down(1, anchor.x + T.stickCaptureRadiusPx - 1, anchor.y);
    expect(rig.core.stick).toMatchObject({ originX: anchor.x, originY: anchor.y });
    expect(rig.frame().move.magnitude).toBe(0);
  });

  it('ANCHORED puts the origin under a thumb that landed off centre, and waits', () => {
    // The reading is RELATIVE from there: the 36px the thumb landed off centre
    // is not a direction the player asked for, and only the drag after it is.
    // Anchored and floating therefore feel identical under the thumb, and the
    // setting moves the artwork rather than re-teaching the control.
    const rig = makeRig();
    const anchor = fixedStickAnchor(T, W, H, ZERO_SAFE_AREA);
    const landing = { x: anchor.x + 36, y: anchor.y };

    rig.down(1, landing.x, landing.y);
    expect(rig.core.stick).toMatchObject({ originX: landing.x, originY: landing.y });
    expect(rig.frame().move.magnitude).toBe(0);

    const drag = 36;
    rig.move(1, landing.x + drag, landing.y);
    const f = rig.frame();
    expect(f.move.magnitude).toBeCloseTo(
      (drag - T.stickDeadZonePx) / (T.stickFullDeflectionPx - T.stickDeadZonePx),
      5
    );
    expect(f.move.x).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------------- */
  /* tap-without-drag                                                       */
  /* ---------------------------------------------------------------------- */

  it('ANCHORED: a stationary tap on the joystick commands NOTHING, at any radius', () => {
    // The shipped defect: `stickCaptureRadiusPx` (122) was a third larger than
    // full deflection (92), so capture snapped the origin onto the anchor and
    // the distance the thumb LANDED from centre became deflection with no drag
    // at all — 0.800 on the ring's painted edge, a flat 1.000 anywhere in the
    // 30px annulus outside the artwork. A first-time player's instinct is to
    // tap the control they can finally see, and the double-tap-to-jump gesture
    // is a tap on this same surface, so both of the first two things anyone
    // does to this stick ran the character off sideways.
    const anchor = fixedStickAnchor(T, W, H, ZERO_SAFE_AREA);
    for (const radius of [0, 12, 20, 40, 60, 76, 92, 110, 122]) {
      const rig = makeRig();
      const point = { x: anchor.x + radius, y: anchor.y };
      rig.down(1, point.x, point.y);
      // Ten frames, not one: the old reading was held for as long as the
      // finger rested there, not a flicker on the down edge.
      for (let i = 0; i < 10; i++) {
        expect(rig.frame().move.magnitude, `r=${radius} frame ${i}`).toBe(0);
      }
      rig.up(1, point.x, point.y);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* reverse-on-return                                                      */
  /* ---------------------------------------------------------------------- */

  it('ANCHORED: bringing the thumb back to the painted centre reads ZERO, not reverse', () => {
    // The shipped default combined an anchored ring with `stickOriginFollows`,
    // which walks the origin along behind the thumb past full deflection. That
    // is correct while the stick FLOATS, because the overlay paints the ring
    // from the origin and the artwork walks with it. The anchored ring is
    // placed by CSS and never repainted, so the origin walked away from its own
    // picture and stayed there for the rest of the touch: returning the thumb
    // to the middle of the ring — where every player believes neutral is —
    // commanded a FULL-SPEED SPRINT in the opposite direction.
    const anchor = fixedStickAnchor(T, W, H, ZERO_SAFE_AREA);
    for (const drag of [40, 92, 120, 150, 200, 300]) {
      const rig = makeRig();
      rig.down(1, anchor.x, anchor.y);
      rig.frame();
      rig.move(1, anchor.x, anchor.y - drag);
      const out = rig.frame();
      expect(out.move.magnitude, `drag ${drag}px out`).toBeCloseTo(
        Math.min(1, (drag - T.stickDeadZonePx) / (T.stickFullDeflectionPx - T.stickDeadZonePx)),
        5
      );
      expect(out.move.y, `drag ${drag}px is northward`).toBeGreaterThan(0);
      expect(rig.core.stick, `origin stayed on the ring after ${drag}px`).toMatchObject({
        originX: anchor.x,
        originY: anchor.y,
      });

      rig.move(1, anchor.x, anchor.y);
      expect(rig.frame().move.magnitude, `back on the ring centre after ${drag}px`).toBe(0);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* ring-outside-zone                                                      */
  /* ---------------------------------------------------------------------- */

  it('a thumb on the painted ring is the STICK on a 360px phone, not the camera', () => {
    // 360 CSS px is the most common Android width there is. The ring's inboard
    // edge is a constant 172px and `stickZoneFraction` put the boundary at
    // 162, so a 10px crescent of joystick — its inboard edge, the side the
    // thumb pushes into to walk across the screen — belonged to the CAMERA.
    // Press the control you can plainly see, and the horizon swings.
    const rig = makeRig();
    rig.core.setViewport(360, 640);
    const anchor = fixedStickAnchor(T, 360, 640, ZERO_SAFE_AREA);
    const edge = { x: anchor.x + T.stickBaseRadiusPx - 1, y: anchor.y };
    expect(360 * T.stickZoneFraction).toBeLessThan(edge.x);

    rig.down(1, edge.x, edge.y);
    expect(rig.core.debugPointers()[0]!.role).toBe('stick');
    rig.frame();
    rig.move(1, edge.x, edge.y - T.stickFullDeflectionPx);
    const f = rig.frame();
    expect(f.move.magnitude).toBeCloseTo(1, 5);
    expect(f.move.y).toBeCloseTo(1, 5);
    expect(Math.abs(f.look.x) + Math.abs(f.look.y)).toBe(0);
  });

  it('ANCHORED falls back to the touch point for a thumb nowhere near it', () => {
    // The alternative is a character that sprints off the instant a thumb lands
    // in the far corner of the stick zone, at a full deflection nobody asked
    // for. The ring stays painted at the anchor; only the origin moves.
    const rig = makeRig();
    const anchor = fixedStickAnchor(T, W, H, ZERO_SAFE_AREA);
    expect(Math.hypot(FAR.x - anchor.x, FAR.y - anchor.y)).toBeGreaterThan(T.stickCaptureRadiusPx);
    rig.down(1, FAR.x, FAR.y);
    expect(rig.core.stick).toMatchObject({ originX: FAR.x, originY: FAR.y });
    expect(rig.frame().move.magnitude).toBe(0);
  });

  it('ANCHORED measures its home from the SAFE-AREA corner, not the glass', () => {
    // Without this the ring (positioned by CSS from `env(safe-area-inset-*)`)
    // and the origin (computed here) sit 44px apart in landscape on a notched
    // phone: the stick reads from one place and is drawn in another.
    const rig = makeRig();
    rig.core.setSafeArea({ top: 0, right: 44, bottom: 34, left: 44 });
    const anchor = fixedStickAnchor(T, W, H, { top: 0, right: 44, bottom: 34, left: 44 });
    expect(anchor.x).toBe(44 + T.stickFixedInsetPx);
    expect(anchor.y).toBe(H - 34 - T.stickFixedInsetPx);
    rig.down(1, anchor.x, anchor.y);
    expect(rig.core.stick).toMatchObject({ originX: anchor.x, originY: anchor.y });
  });

  it('reads centred on touch-down, before any travel', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    const f = rig.frame();
    expect(f.move.magnitude).toBe(0);
    expect(f.move.active).toBe(true);
  });

  it('produces the expected vector for a known drag', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.frame();
    rig.move(1, 200, 400 - T.stickFullDeflectionPx); // 120px straight up
    const f = rig.frame();
    expect(f.move.magnitude).toBeCloseTo(1, 5);
    expect(f.move.y).toBeCloseTo(1, 5);
    expect(f.move.x).toBeCloseTo(0, 5);
  });

  it('honours the dead zone', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.move(1, 200, 400 - (T.stickDeadZonePx - 1));
    expect(rig.frame().move.magnitude).toBe(0);

    rig.move(1, 200, 400 - (T.stickDeadZonePx + 1));
    expect(rig.frame().move.magnitude).toBeGreaterThan(0);
  });

  it('clamps at full deflection however far the thumb goes', () => {
    const rig = makeRig();
    rig.down(1, 300, 300);
    rig.frame();
    rig.move(1, 300 + 900, 300);
    const f = rig.frame();
    expect(f.move.magnitude).toBe(1);
    expect(f.move.x).toBeCloseTo(1, 5);
  });

  it('FLOATING drags the origin along past full deflection so pulling back eases off', () => {
    const rig = makeRig(FLOATING);
    rig.down(1, 300, 300);
    rig.frame();
    rig.move(1, 500, 300); // 200px right, well past full deflection
    rig.frame();
    expect(rig.core.stick!.originX).toBeCloseTo(500 - T.stickFullDeflectionPx, 5);

    // The origin now trails exactly one full deflection behind the thumb, so
    // coming back that far LESS the dead zone re-centres immediately, rather
    // than the player having to retrace the whole overshoot first. It is only
    // safe here because the overlay paints the FLOATING ring from this origin,
    // so the picture walked with it.
    rig.move(1, 500 - (T.stickFullDeflectionPx - T.stickDeadZonePx + 1), 300);
    expect(rig.frame().move.magnitude).toBe(0);
  });

  it('ANCHORED never walks its origin, whatever stickOriginFollows is set to', () => {
    // `stickOriginFollows` is a FLOATING affordance and the layout is the gate:
    // there is no ring under an anchored origin to walk with it, so the flag
    // being on cannot be allowed to separate the two. It is reachable from
    // `window.__INPUT__.setConfig` and reads like a free improvement.
    for (const follows of [true, false]) {
      const rig = makeRig(resolveTuning({ stickOriginFollows: follows }));
      rig.down(1, 300, 300);
      rig.frame();
      rig.move(1, 500, 300);
      rig.frame();
      expect(rig.core.stick!.originX, `stickOriginFollows: ${follows}`).toBe(300);
      // Anchored is absolute for the life of the touch: 64px back from the
      // overshoot is still 136px out, which is still saturated.
      rig.move(1, 500 - 64, 300);
      expect(rig.frame().move.magnitude, `stickOriginFollows: ${follows}`).toBe(1);
    }
  });

  it('FLOATING can be configured not to follow, for a stick bolted to the glass', () => {
    const rig = makeRig(resolveTuning({ floatingStick: true, stickOriginFollows: false }));
    rig.down(1, 300, 300);
    rig.frame();
    rig.move(1, 500, 300);
    rig.frame();
    expect(rig.core.stick!.originX).toBe(300);
    rig.move(1, 500 - 64, 300);
    expect(rig.frame().move.magnitude).toBe(1);
  });

  it('centres when the thumb lifts', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.move(1, 200, 250);
    expect(rig.frame().move.magnitude).toBe(1);
    rig.up(1, 200, 250);
    const f = rig.frame();
    expect(f.move).toBe(NEUTRAL_AXIS);
    expect(rig.core.stick).toBeNull();
  });

  it('the TOP of the stick hand’s half is the camera, not the stick', () => {
    // A swipe up there is someone looking around. It used to walk the
    // character, because the stick zone ran the full height of the screen.
    const rig = makeRig();
    const high = H * T.stickZoneTopFraction - 1;
    expect(rig.core.isStickZone(120, high)).toBe(false);
    rig.down(1, 120, high);
    rig.frame();
    rig.move(1, 260, high);
    const f = rig.frame();
    expect(f.move.magnitude).toBe(0);
    expect(Math.abs(f.look.x)).toBeGreaterThan(0);
    expect(rig.core.debugPointers()[0]!.role).toBe('camera');
  });

  it('asks the same question the zone helper does, at its own viewport', () => {
    const rig = makeRig();
    for (const [x, y] of [
      [1, 1],
      [120, 560],
      [W * T.stickZoneFraction - 1, 560],
      [W * T.stickZoneFraction + 1, 560],
      [W - 1, H - 1],
    ] as const) {
      expect(rig.core.isStickZone(x, y), `(${x},${y})`).toBe(isStickZone(x, y, W, H, T));
    }
  });

  it('a second left-half finger does not steal the stick', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.move(1, 200, 280);
    rig.down(2, 100, 500);
    const f = rig.frame();
    expect(f.move.magnitude).toBe(1);
    expect(rig.core.stick!.originX).toBe(200);
  });
});

/* ========================================================================== */
/* Camera drag + pinch                                                        */
/* ========================================================================== */

describe('camera drag', () => {
  it('turns a right-half drag into a look rate with the right sign', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.frame();
    rig.move(1, 760, 300); // 60px right
    const right = rig.frame();
    expect(right.look.x).toBeGreaterThan(0);

    rig.move(1, 700, 300);
    rig.move(1, 640, 300);
    const left = rig.frame();
    expect(left.look.x).toBeLessThan(0);
  });

  it('dragging the thumb UP looks up (positive y)', () => {
    const rig = makeRig();
    rig.down(1, 700, 400);
    rig.frame();
    rig.move(1, 700, 340);
    expect(rig.frame().look.y).toBeGreaterThan(0);
  });

  it('applies 0.18 deg/px before smoothing', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.frame();
    rig.move(1, 800, 300); // 100px
    const f = rig.frame();
    // 100px * 0.18 = 18 degrees this frame; smoothing means the reported rate
    // is a fraction of the instantaneous 18/dt deg/s, but must be positive and
    // must not exceed the full rate.
    expect(f.look.x).toBeGreaterThan(0);
    expect(f.look.x).toBeLessThanOrEqual(1);
  });

  it('decays to rest once the finger lifts', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.frame();
    rig.move(1, 850, 300);
    rig.frame();
    rig.up(1, 850, 300);
    for (let i = 0; i < 60; i++) rig.frame();
    expect(Math.abs(rig.frame().look.x)).toBe(0);
  });
});

describe('pinch and twist', () => {
  it('reports a ratio above 1 when two camera fingers spread', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.down(2, 900, 300); // span 200
    rig.frame();
    rig.move(2, 960, 300); // span 260
    const f = rig.frame();
    expect(f.pinchDelta).toBeCloseTo(260 / 200, 4);
  });

  it('reports a ratio below 1 when they close', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.down(2, 900, 300);
    rig.frame();
    rig.move(2, 800, 300); // span 100
    expect(rig.frame().pinchDelta).toBeCloseTo(1 / T.pinchMaxRatioPerFrame, 4);
  });

  it('clamps the pinch ratio ONCE PER FRAME, not once per pointer event', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.down(2, 720, 300); // span 20
    rig.frame();
    // One frame's worth of coalesced moves on a high-rate digitiser, each
    // roughly doubling the span. Clamped per event these multiply to 1.5^3.
    rig.move(2, 740, 300); // span 40
    rig.move(2, 780, 300); // span 80
    rig.move(2, 860, 300); // span 160
    const f = rig.frame();
    expect(f.pinchDelta).toBeLessThanOrEqual(T.pinchMaxRatioPerFrame + 1e-9);
    expect(f.pinchDelta).toBeCloseTo(T.pinchMaxRatioPerFrame, 6);
  });

  it('ignores sub-pixel jitter', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.down(2, 900, 300);
    rig.frame();
    rig.move(2, 900.4, 300);
    expect(rig.frame().pinchDelta).toBe(1);
  });

  it('reports twist when the two fingers rotate', () => {
    const rig = makeRig();
    rig.down(1, 800, 300);
    rig.down(2, 900, 300); // angle 0
    rig.frame();
    rig.move(2, 800, 200); // angle -90deg
    expect(rig.frame().twistDelta).toBeCloseTo(-Math.PI / 2, 3);
  });

  it('resets to neutral on the following frame', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.down(2, 900, 300);
    rig.frame();
    rig.move(2, 960, 300);
    expect(rig.frame().pinchDelta).toBeGreaterThan(1);
    expect(rig.frame().pinchDelta).toBe(1);
  });

  it('does NOT jump the camera when one of two fingers lifts', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.down(2, 900, 300);
    rig.frame();
    rig.frame();
    rig.up(2, 900, 300); // centroid moves 100px, but must emit no look delta
    const f = rig.frame();
    expect(Math.abs(f.look.x)).toBeLessThan(1e-9);
  });

  it('does NOT jump the camera when a second finger arrives', () => {
    const rig = makeRig();
    rig.down(1, 700, 300);
    rig.frame();
    rig.down(2, 900, 300); // centroid jumps 100px right
    const f = rig.frame();
    expect(Math.abs(f.look.x)).toBeLessThan(1e-9);
  });
});

/* ========================================================================== */
/* MULTI-TOUCH — the point of the whole exercise                              */
/* ========================================================================== */

describe('multi-touch', () => {
  it('runs stick + camera drag + button press SIMULTANEOUSLY', () => {
    const rig = makeRig();
    rig.down(1, 200, 400); // left half -> stick
    rig.down(2, 800, 200); // right half -> camera
    rig.button(3, 950, 520, 'punch'); // button
    rig.frame();

    rig.move(1, 200, 400 - T.stickFullDeflectionPx);
    rig.move(2, 860, 200);
    const f = rig.frame();

    expect(f.move.magnitude).toBeCloseTo(1, 5);
    expect(f.move.y).toBeCloseTo(1, 5);
    expect(f.look.x).toBeGreaterThan(0);
    expect(f.buttons.punch.held).toBe(true);
    expect(f.pointerCount).toBe(3);
  });

  it('keeps a pointer in its original role even when it crosses the halves', () => {
    const rig = makeRig();
    rig.down(1, 200, 400); // stick
    rig.down(2, 800, 300); // camera
    rig.frame();

    rig.move(1, 900, 400); // stick thumb slides deep into the camera half
    const f = rig.frame();

    // Still the stick, pushing right at full deflection.
    expect(f.move.x).toBeCloseTo(1, 5);
    // And the camera did not move, because pointer 1 is not a camera pointer.
    expect(Math.abs(f.look.x)).toBeLessThan(1e-9);
  });

  it('a button press does not disturb the stick', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.move(1, 200, 300);
    const before = rig.frame().move;
    rig.button(2, 950, 520, 'jump');
    const after = rig.frame();
    expect(after.move.x).toBeCloseTo(before.x, 9);
    expect(after.move.y).toBeCloseTo(before.y, 9);
    expect(after.buttons.jump.pressed).toBe(true);
  });

  it('handles four fingers at once without dropping any', () => {
    const rig = makeRig();
    rig.down(1, 150, 500); // stick
    rig.down(2, 700, 200); // camera
    rig.down(3, 850, 250); // camera (pinch partner)
    rig.button(4, 950, 520, 'punch');
    const f = rig.frame();
    expect(f.pointerCount).toBe(4);
    expect(rig.core.activePointerCount).toBe(4);
    const roles = rig.core.debugPointers().map((p) => p.role);
    expect(roles).toEqual(['stick', 'camera', 'camera', 'button']);
  });

  it('releases one finger without disturbing the others', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.down(2, 800, 300);
    rig.button(3, 950, 520, 'punch');
    rig.move(1, 200, 280);
    rig.frame();

    rig.up(2, 800, 300); // lift only the camera finger
    const f = rig.frame();
    expect(f.move.magnitude).toBe(1);
    expect(f.buttons.punch.held).toBe(true);
    expect(rig.core.activePointerCount).toBe(2);
  });
});

/* ========================================================================== */
/* Cancellation — the stuck-stick class of bug                                */
/* ========================================================================== */

describe('pointer cancellation', () => {
  it('pointercancel mid-drag releases the stick cleanly — no stuck stick', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.move(1, 200, 250);
    expect(rig.frame().move.magnitude).toBe(1);

    rig.cancel(1, 200, 250);
    const f = rig.frame();
    expect(f.move).toBe(NEUTRAL_AXIS);
    expect(rig.core.stick).toBeNull();
    expect(rig.core.activePointerCount).toBe(0);

    // And it stays released on subsequent frames.
    expect(rig.frame().move.magnitude).toBe(0);
  });

  it('pointercancel on a held button releases it without a phantom charge', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    rig.frame();
    // charge well past full
    for (let i = 0; i < Math.ceil(T.chargeFullSec / DT) + 5; i++) rig.frame();
    expect(rig.core.chargeRatio).toBe(1);

    rig.cancel(1, 950, 520);
    const f = rig.frame();
    expect(f.buttons.punch.held).toBe(false);
    expect(f.buttons.heavyPunch.pressed).toBe(false);
    expect(rig.core.chargeRatio).toBe(0);
  });

  it('cancels only the named pointer, leaving the others alone', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.down(2, 800, 300);
    rig.move(1, 200, 280);
    rig.frame();

    rig.core.cancelPointer(1, rig.now);
    const f = rig.frame();
    expect(f.move.magnitude).toBe(0);
    expect(rig.core.activePointerCount).toBe(1);
    expect(rig.core.debugPointers()[0]!.role).toBe('camera');
  });

  it('cancelAll clears every pointer (window blur / app background)', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.down(2, 800, 300);
    rig.button(3, 950, 520, 'punch');
    rig.move(1, 200, 280);
    rig.frame();

    rig.core.cancelAll(rig.now);
    const f = rig.frame();
    expect(f.move.magnitude).toBe(0);
    expect(f.buttons.punch.held).toBe(false);
    expect(rig.core.activePointerCount).toBe(0);
  });

  it('does not recognise a tap from a cancelled pointer', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.cancel(1, 200, 400);
    rig.wait(0.05);
    rig.down(2, 200, 400);
    rig.up(2, 200, 400);
    const f = rig.frame();
    // Only one real tap happened, so no double-tap jump.
    expect(f.buttons.jump.pressed).toBe(false);
  });

  it('recovers from a duplicate pointerdown for a live id', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.move(1, 200, 280);
    rig.frame();
    rig.down(1, 700, 300); // same id, new place: we missed an `up`
    const f = rig.frame();
    expect(rig.core.activePointerCount).toBe(1);
    expect(rig.core.debugPointers()[0]!.role).toBe('camera');
    expect(f.move.magnitude).toBe(0);
  });

  it('reset() leaves nothing held', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.button(2, 950, 520, 'punch');
    rig.move(1, 200, 260);
    rig.frame();
    rig.core.reset();
    const f = rig.frame();
    expect(f.move.magnitude).toBe(0);
    expect(f.buttons.punch.held).toBe(false);
    expect(f.pointerCount).toBe(0);
  });

  it('reset() drops the dash LATCH — a backgrounded app must not resume sprinting', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'dash');
    rig.up(1, 950, 520);
    expect(rig.frame().buttons.sprint.held).toBe(true);

    rig.core.reset(); // window blur / visibility loss
    const f = rig.frame();
    expect(rig.core.isDashOn).toBe(false);
    expect(f.buttons.sprint.held).toBe(false);
    // ...and it stays off on every later frame, with no player input.
    expect(rig.frame().buttons.sprint.held).toBe(false);
  });
});

/* ========================================================================== */
/* Buttons                                                                    */
/* ========================================================================== */

describe('punch button and charge', () => {
  it('a tap fires punch and NOT heavyPunch', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    const pressFrame = rig.frame();
    expect(pressFrame.buttons.punch.pressed).toBe(true);

    rig.up(1, 950, 520);
    const releaseFrame = rig.frame();
    expect(releaseFrame.buttons.punch.released).toBe(true);
    expect(releaseFrame.buttons.heavyPunch.pressed).toBe(false);
  });

  it('a hold past the charge threshold fires heavyPunch on release, with the ratio', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    // Hold long enough to fill the ring completely.
    const frames = Math.ceil(T.chargeFullSec / DT) + 2;
    for (let i = 0; i < frames; i++) rig.frame();
    expect(rig.core.chargeRatio).toBeCloseTo(1, 3);

    rig.up(1, 950, 520);
    const f = rig.frame();
    expect(f.buttons.heavyPunch.pressed).toBe(true);
    expect(f.buttons.heavyPunch.value).toBeCloseTo(1, 2);
  });

  it('a partial charge fires heavyPunch with a partial ratio', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    const target = T.chargeStartSec + (T.chargeFullSec - T.chargeStartSec) * 0.5;
    const frames = Math.round(target / DT);
    for (let i = 0; i < frames; i++) rig.frame();
    rig.up(1, 950, 520);
    const f = rig.frame();
    expect(f.buttons.heavyPunch.value).toBeGreaterThan(0.3);
    expect(f.buttons.heavyPunch.value).toBeLessThan(0.7);
  });

  it('fires the charge-complete cue exactly once', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    for (let i = 0; i < 200; i++) rig.frame();
    expect(rig.chargeCompletions).toBe(1);
  });

  it('a second finger on the punch button does not restart the charge', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    for (let i = 0; i < 30; i++) rig.frame();
    const before = rig.core.chargeHoldTime;
    expect(before).toBeGreaterThan(T.chargeStartSec);

    rig.button(2, 950, 520, 'punch'); // an index finger brushes the same button
    rig.frame();
    expect(rig.core.chargeHoldTime).toBeGreaterThan(before);
  });

  it('the punch button stays held until the LAST finger lifts', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    rig.button(2, 950, 520, 'punch');
    expect(rig.frame().buttons.punch.held).toBe(true);

    rig.up(2, 950, 520); // the SECOND finger lifts first
    expect(rig.frame().buttons.punch.held).toBe(true);

    rig.up(1, 950, 520);
    const f = rig.frame();
    expect(f.buttons.punch.held).toBe(false);
    expect(f.buttons.punch.released).toBe(true);
  });

  it('exposes holdTime so the ring can be drawn from InputState alone', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    rig.frame();
    for (let i = 0; i < 30; i++) rig.frame();
    const f = rig.frame();
    expect(f.buttons.punch.holdTime).toBeGreaterThan(T.chargeStartSec);
  });
});

describe('jump, dash and interact buttons', () => {
  it('jump is a plain tap/hold', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'jump');
    expect(rig.frame().buttons.jump.pressed).toBe(true);
    expect(rig.frame().buttons.jump.held).toBe(true);
    rig.up(1, 950, 520);
    expect(rig.frame().buttons.jump.released).toBe(true);
  });

  it('dash TOGGLES sprint on press and stays on after the thumb lifts', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'dash');
    rig.up(1, 950, 520);
    expect(rig.frame().buttons.sprint.held).toBe(true);
    expect(rig.frame().buttons.sprint.held).toBe(true);

    rig.button(2, 950, 520, 'dash');
    rig.up(2, 950, 520);
    const f = rig.frame();
    expect(f.buttons.sprint.held).toBe(false);
    expect(f.buttons.sprint.released).toBe(true);
  });

  it('two fingers landing on DASH toggle sprint ONCE, not twice', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'dash');
    rig.button(2, 953, 523, 'dash'); // a second finger inside the same hit area
    expect(rig.frame().buttons.sprint.held).toBe(true);
    rig.up(1, 950, 520);
    rig.up(2, 953, 523);
    expect(rig.frame().buttons.sprint.held).toBe(true);
  });

  it('interact does nothing until a target is in range', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'interact');
    expect(rig.frame().buttons.interact.held).toBe(false);
    rig.up(1, 950, 520);
    rig.frame();

    rig.core.setInteractAvailable(true);
    rig.button(2, 950, 520, 'interact');
    expect(rig.frame().buttons.interact.pressed).toBe(true);
  });

  it('drops a held interact when the target goes out of range', () => {
    const rig = makeRig();
    rig.core.setInteractAvailable(true);
    rig.button(1, 950, 520, 'interact');
    expect(rig.frame().buttons.interact.held).toBe(true);
    rig.core.setInteractAvailable(false);
    const f = rig.frame();
    expect(f.buttons.interact.held).toBe(false);
    expect(f.buttons.interact.released).toBe(true);
  });
});

/* ========================================================================== */
/* Gestures                                                                   */
/* ========================================================================== */

describe('gestures', () => {
  it('double tap fires jump', () => {
    const rig = makeRig();
    rig.down(1, 300, 400);
    rig.wait(0.05);
    rig.up(1, 300, 400);
    rig.frame();
    rig.wait(0.08);
    rig.down(2, 305, 402);
    rig.wait(0.04);
    rig.up(2, 305, 402);
    const f = rig.frame();
    expect(f.buttons.jump.pressed).toBe(true);
    expect(rig.gestures.at(-1)?.gesture).toBe('doubleTapJump');
  });

  it('two taps too far apart in TIME are not a double tap', () => {
    const rig = makeRig();
    rig.down(1, 300, 400);
    rig.wait(0.05);
    rig.up(1, 300, 400);
    rig.frame();
    rig.wait(T.doubleTapWindow + 0.2);
    rig.down(2, 300, 400);
    rig.wait(0.04);
    rig.up(2, 300, 400);
    expect(rig.frame().buttons.jump.pressed).toBe(false);
  });

  it('two taps too far apart in SPACE are not a double tap', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.wait(0.05);
    rig.up(1, 200, 400);
    rig.frame();
    rig.wait(0.06);
    rig.down(2, 200 + T.doubleTapMaxDistPx + 40, 400);
    rig.wait(0.04);
    rig.up(2, 200 + T.doubleTapMaxDistPx + 40, 400);
    expect(rig.frame().buttons.jump.pressed).toBe(false);
  });

  it('a slow press is not a tap at all', () => {
    const rig = makeRig();
    rig.down(1, 300, 400);
    rig.wait(T.tapMaxDurationSec + 0.1);
    rig.up(1, 300, 400);
    rig.frame();
    rig.wait(0.05);
    rig.down(2, 300, 400);
    rig.wait(0.04);
    rig.up(2, 300, 400);
    expect(rig.frame().buttons.jump.pressed).toBe(false);
  });

  it('two-finger tap fires lockOn', () => {
    const rig = makeRig();
    rig.down(1, 650, 300);
    rig.wait(0.03);
    rig.down(2, 800, 320);
    rig.wait(0.06);
    rig.up(1, 650, 300);
    rig.up(2, 800, 320);
    const f = rig.frame();
    expect(f.buttons.lockOn.pressed).toBe(true);
    expect(rig.gestures.at(-1)?.gesture).toBe('twoFingerTapLock');
  });

  it('a two-finger tap is NOT also read as a double tap', () => {
    const rig = makeRig();
    rig.down(1, 650, 300);
    rig.wait(0.03);
    rig.down(2, 700, 320);
    rig.wait(0.06);
    rig.up(1, 650, 300);
    rig.up(2, 700, 320);
    const f = rig.frame();
    expect(f.buttons.lockOn.pressed).toBe(true);
    expect(f.buttons.jump.pressed).toBe(false);
  });

  it('swipe up on the punch button fires the uppercut and suppresses the charge', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    rig.frame();
    for (let i = 0; i < 12; i++) rig.frame(); // charge past the threshold
    rig.move(1, 950, 520 - (T.swipeUpMinPx + 10));
    const f = rig.frame();

    expect(f.buttons.special.pressed).toBe(true);
    expect(rig.gestures.at(-1)?.gesture).toBe('swipeUpUppercut');
    // The punch drops silently: no released edge that gameplay could mistake
    // for a fired charge.
    expect(f.buttons.punch.held).toBe(false);
    expect(f.buttons.punch.released).toBe(false);

    rig.up(1, 950, 460);
    const after = rig.frame();
    expect(after.buttons.heavyPunch.pressed).toBe(false);
  });

  it('a sideways drag on the punch button is not an uppercut', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    rig.frame();
    rig.move(1, 950 - 80, 520 - 20);
    const f = rig.frame();
    expect(f.buttons.special.pressed).toBe(false);
    expect(f.buttons.punch.held).toBe(true);
  });

  it('a slow upward drag on the punch button is not an uppercut', () => {
    const rig = makeRig();
    rig.button(1, 950, 520, 'punch');
    rig.frame();
    rig.wait(T.swipeUpMaxSec + 0.1);
    rig.move(1, 950, 520 - 100);
    expect(rig.frame().buttons.special.pressed).toBe(false);
  });
});

/* ========================================================================== */
/* Pointer samples                                                            */
/* ========================================================================== */

describe('pointer samples', () => {
  it('normalises to 0..1 viewport coordinates', () => {
    const rig = makeRig();
    rig.down(1, 250, 300);
    const sample = rig.frame().contribution.pointers[0]!;
    expect(sample.x).toBeCloseTo(0.25, 6);
    expect(sample.y).toBeCloseTo(0.5, 6);
    expect(sample.down).toBe(true);
    expect(sample.up).toBe(false);
  });

  it('reports movement deltas in normalised units', () => {
    const rig = makeRig();
    rig.down(1, 250, 300);
    rig.frame();
    rig.move(1, 350, 300);
    const sample = rig.frame().contribution.pointers[0]!;
    expect(sample.dx).toBeCloseTo(0.1, 6);
    expect(sample.dy).toBeCloseTo(0, 6);
  });

  it('reports a tap that begins and ends between two polls', () => {
    const rig = makeRig();
    rig.down(1, 250, 300);
    rig.up(1, 250, 300);
    const samples = rig.frame().contribution.pointers;
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ down: true, up: true });
    // ...and never again.
    expect(rig.frame().contribution.pointers).toHaveLength(0);
  });

  it('never reports a live id as lifted after a duplicate pointerdown', () => {
    const rig = makeRig();
    rig.down(1, 200, 400);
    rig.frame();
    rig.down(1, 700, 300); // same id, new place: we missed an `up`
    const samples = rig.frame().contribution.pointers;
    // The stale pointer is retired internally, but a consumer keyed on
    // `PointerSample.id` must not be told that finger 1 came up: it is down.
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ id: 1, down: true, up: false });
  });

  it('is sorted by id, so snapshots are stable', () => {
    const rig = makeRig();
    rig.down(5, 700, 300);
    rig.down(2, 200, 300);
    rig.down(9, 800, 300);
    const ids = rig.frame().contribution.pointers.map((p) => p.id);
    expect(ids).toEqual([2, 5, 9]);
  });

  it('reset() does not allocate a new pointer list', () => {
    // The manager resets the scratch buffer once per enabled backend per frame.
    // Backends that have pointers ASSIGN a fresh array; the empty case must
    // reuse the shared frozen one rather than littering the poll path.
    const c = new InputContribution();
    const first = c.pointers;
    c.reset();
    expect(c.pointers).toBe(first);
    expect(c.pointers).toHaveLength(0);
  });
});
