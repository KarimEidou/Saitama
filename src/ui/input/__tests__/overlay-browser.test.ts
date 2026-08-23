/**
 * THE OVERLAY, IN A REAL LAYOUT ENGINE
 *
 * `touch-overlay.ts` and `touch-source.ts` had ZERO automated coverage before
 * this file, which is how a control shipped that painted nothing at rest and
 * anchored nothing at all. Everything asserted here is something only a browser
 * can answer: where `calc(env(safe-area-inset-left) + 96px)` actually put the
 * ring, what `opacity` computed to with no finger down, and whether flipping
 * one attribute really moved four buttons to the other corner.
 *
 * The Node-side arithmetic these compare against is tested on its own in
 * `../stick-geometry.test.ts`. The point of THIS file is the join: that the
 * number `TouchCore` anchors its origin on and the pixel the browser paints the
 * ring at are the same number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_TUNING } from '../config';
import { openOverlaySession, type IOverlaySession } from './browser-harness';

const T = DEFAULT_INPUT_TUNING;
/** Sub-pixel: rects come back fractional on a dpr-3 viewport. */
const TOL = 0.6;

/** A left-notch landscape phone — the shipping case, and asymmetric on purpose. */
const NOTCH = { top: 0, right: 34, bottom: 21, left: 59 };
const NONE = { top: 0, right: 0, bottom: 0, left: 0 };

let session: IOverlaySession;

beforeAll(async () => {
  session = await openOverlaySession();
}, 120_000);

afterAll(async () => {
  await session?.close();
});

describe('the anchored stick is where the geometry says it is', () => {
  for (const hand of ['left', 'right'] as const) {
    for (const [label, insets] of [
      ['no insets', NONE],
      ['a left notch and a home indicator', NOTCH],
    ] as const) {
      it(`${hand}-handed, ${label}`, async () => {
        const m = await session.page.evaluate(
          ([h, i]) => {
            window.__OVERLAY_PROBE__.mount({ floatingStick: false, stickHand: h });
            window.__OVERLAY_PROBE__.setSafeArea(i);
            return window.__OVERLAY_PROBE__.measure();
          },
          [hand, insets] as [typeof hand, typeof insets]
        );

        expect(m.layout).toBe('fixed');
        expect(m.hand).toBe(hand);
        // The overlay read the insets back out of its own CSS, rather than
        // trusting the argument — that is the value TouchCore anchors on.
        expect(m.resolvedInsets).toEqual(insets);

        // What the browser painted, against what the pure function computed.
        expect(m.stick).not.toBeNull();
        expect(m.stick!.centreX).toBeCloseTo(m.anchor.x, 0);
        expect(m.stick!.centreY).toBeCloseTo(m.anchor.y, 0);
        expect(Math.abs(m.stick!.centreX - m.anchor.x)).toBeLessThan(TOL);
        expect(Math.abs(m.stick!.centreY - m.anchor.y)).toBeLessThan(TOL);

        // ...and independently, against the corner arithmetic itself, so a bug
        // shared by both sides cannot pass by agreeing with itself.
        const expectedX =
          hand === 'left'
            ? insets.left + T.stickFixedInsetPx
            : m.viewport.width - insets.right - T.stickFixedInsetPx;
        expect(m.stick!.centreX).toBeCloseTo(expectedX, 0);
        expect(m.stick!.centreY).toBeCloseTo(
          m.viewport.height - insets.bottom - T.stickFixedInsetPx,
          0
        );

        // Drawn at the VISUAL radius, not the input radius. It was 240px across.
        expect(m.stick!.width).toBeCloseTo(T.stickBaseRadiusPx * 2, 0);
        expect(m.stick!.width).toBeLessThan(T.stickFullDeflectionPx * 2);

        // The whole ring is on the screen.
        expect(m.stick!.x).toBeGreaterThanOrEqual(-TOL);
        expect(m.stick!.x + m.stick!.width).toBeLessThanOrEqual(m.viewport.width + TOL);
        expect(m.stick!.y + m.stick!.height).toBeLessThanOrEqual(m.viewport.height + TOL);
      });
    }
  }
});

describe('THE JOYSTICK RENDERS', () => {
  it('is painted with nothing touching the screen', async () => {
    // The literal bug report: "the joystick is not even rendering". It was
    // `opacity:0` until a finger was down, so a player who did not already know
    // the control existed never saw one.
    const m = await session.page.evaluate(() => {
      window.__OVERLAY_PROBE__.mount({ floatingStick: false });
      window.__OVERLAY_PROBE__.setSafeArea({ top: 0, right: 0, bottom: 0, left: 0 });
      return window.__OVERLAY_PROBE__.measure();
    });
    expect(m.stickActive).toBe('false');
    expect(m.stickOpacity).toBeGreaterThan(0);
    expect(m.stickOpacity).toBeCloseTo(T.stickIdleOpacity, 2);
    expect(m.stick!.width).toBeGreaterThan(0);
    expect(m.stick!.height).toBeGreaterThan(0);
  });

  it('is painted at rest in the FLOATING layout too, not parked at (0,0)', async () => {
    // `sync()` only ever wrote the origin transform while a finger was down, so
    // an idle floating ring would have been drawn in the top-left corner —
    // under the HUD, which paints above the input overlay.
    const m = await session.page.evaluate(() => {
      window.__OVERLAY_PROBE__.mount({ floatingStick: true });
      window.__OVERLAY_PROBE__.setSafeArea({ top: 0, right: 0, bottom: 0, left: 0 });
      return window.__OVERLAY_PROBE__.measure();
    });
    expect(m.layout).toBe('floating');
    expect(m.stickOpacity).toBeGreaterThan(0);
    expect(m.stick!.centreX).toBeCloseTo(m.anchor.x, 0);
    expect(m.stick!.centreY).toBeCloseTo(m.anchor.y, 0);
  });

  it('goes full opacity while a thumb is on it, and back after', async () => {
    // Measured across the 120ms fade rather than on the same tick as the press:
    // `getComputedStyle` during a transition returns the INTERPOLATED value, so
    // reading it immediately would assert the frame before the change and pass
    // for the wrong reason.
    const idle = await session.page.evaluate(() => {
      const probe = window.__OVERLAY_PROBE__;
      probe.mount({ floatingStick: false });
      probe.setSafeArea({ top: 0, right: 0, bottom: 0, left: 0 });
      return probe.measure();
    });
    expect(idle.stickOpacity).toBeLessThan(1);
    expect(idle.stickOpacity).toBeGreaterThan(0);

    await session.page.evaluate((a) => {
      window.__OVERLAY_PROBE__.press(1, a.x, a.y);
    }, idle.anchor);
    await session.page.waitForTimeout(250);
    const down = await session.page.evaluate(() => window.__OVERLAY_PROBE__.measure());
    expect(down.stickActive).toBe('true');
    expect(down.stickOpacity).toBe(1);

    await session.page.evaluate((a) => {
      window.__OVERLAY_PROBE__.release(1, a.x, a.y);
    }, idle.anchor);
    await session.page.waitForTimeout(250);
    const up = await session.page.evaluate(() => window.__OVERLAY_PROBE__.measure());
    expect(up.stickActive).toBe('false');
    expect(up.stickOpacity).toBeCloseTo(T.stickIdleOpacity, 2);
  });
});

describe('the knob stays inside its own base', () => {
  it('at full deflection, and re-centres on release', async () => {
    const frames = await session.page.evaluate(() => {
      const probe = window.__OVERLAY_PROBE__;
      probe.mount({ floatingStick: false });
      probe.setSafeArea({ top: 0, right: 0, bottom: 0, left: 0 });
      const start = probe.measure();
      const a = start.anchor;
      probe.press(1, a.x, a.y);
      // Far past full deflection, straight up.
      probe.moveTo(1, a.x, a.y - 400);
      const pushed = probe.measure();
      probe.release(1, a.x, a.y - 400);
      const released = probe.measure();
      return { start, pushed, released };
    });

    const ring = frames.pushed.stick!;
    const knob = frames.pushed.knob!;
    // Fully deflected: the knob moved, and its edge sits ON the ring's edge
    // rather than hanging outside it. The old code clamped the RAW pixel offset
    // to `stickFullDeflectionPx`, which is 16px more than the ring's radius.
    expect(ring.centreY - knob.centreY).toBeCloseTo(T.stickBaseRadiusPx - knob.height / 2, 0);
    expect(knob.y).toBeGreaterThanOrEqual(ring.y - 0.6);
    expect(knob.x).toBeGreaterThanOrEqual(ring.x - 0.6);
    expect(knob.x + knob.width).toBeLessThanOrEqual(ring.x + ring.width + 0.6);
    expect(knob.y + knob.height).toBeLessThanOrEqual(ring.y + ring.height + 0.6);
    // Had the knob kept clamping the raw offset to the INPUT radius it would be
    // 92px out of a 76px ring, i.e. 16px of it hanging over the edge.
    expect(ring.centreY - knob.centreY).toBeLessThan(T.stickFullDeflectionPx);

    // Released: back to centre. It never was before, because the whole control
    // faded out and nobody could see the stale transform.
    expect(frames.released.knob!.centreX).toBeCloseTo(frames.released.stick!.centreX, 0);
    expect(frames.released.knob!.centreY).toBeCloseTo(frames.released.stick!.centreY, 0);
  });
});

describe('the thumb arc mirrors with the stick hand', () => {
  it('swaps corners without moving the arc relative to its own corner', async () => {
    const both = await session.page.evaluate(() => {
      const probe = window.__OVERLAY_PROBE__;
      probe.mount({ stickHand: 'left' });
      probe.setSafeArea({ top: 0, right: 34, bottom: 21, left: 59 });
      const left = probe.measure();
      probe.mount({ stickHand: 'right' });
      probe.setSafeArea({ top: 0, right: 34, bottom: 21, left: 59 });
      const right = probe.measure();
      return { left, right };
    });

    for (const id of ['punch', 'jump', 'dash'] as const) {
      const l = both.left.buttons[id]!;
      const r = both.right.buttons[id]!;
      expect(l, id).not.toBeNull();
      // Same size, same height off the bottom.
      expect(r.width, id).toBeCloseTo(l.width, 1);
      expect(r.centreY, id).toBeCloseTo(l.centreY, 1);
      // Left-handed stick puts the arc on the RIGHT and vice versa.
      expect(l.centreX, id).toBeGreaterThan(both.left.viewport.width / 2);
      expect(r.centreX, id).toBeLessThan(both.right.viewport.width / 2);
      // Distance from its OWN safe-area corner is identical, which is what
      // "mirrored" has to mean when the two insets differ (59 vs 34).
      const fromRight = both.left.viewport.width - NOTCH.right - l.centreX;
      const fromLeft = r.centreX - NOTCH.left;
      expect(fromLeft, id).toBeCloseTo(fromRight, 1);
    }

    // The stick took the other corner in the same move.
    expect(both.left.stick!.centreX).toBeLessThan(both.left.viewport.width / 2);
    expect(both.right.stick!.centreX).toBeGreaterThan(both.right.viewport.width / 2);
  });

  it('keeps every button label legible, whatever its button’s size', async () => {
    // The labels used to be `calc(var(--opm-bs) * .15)`, so DASH rendered at
    // 9px: a 6.3px cap height, which at arm's length is a smudge.
    const m = await session.page.evaluate(() => {
      window.__OVERLAY_PROBE__.mount();
      return window.__OVERLAY_PROBE__.measure();
    });
    for (const id of ['punch', 'jump', 'dash'] as const) {
      expect(m.labelFontPx[id], id).toBeGreaterThanOrEqual(10);
      expect(m.labelFontPx[id], id).toBeLessThanOrEqual(13);
    }
  });
});

describe('pointer capture does not release a button the player is holding', () => {
  it('ignores a lostpointercapture that bubbled up from a button', async () => {
    // The bug: `pointerdown` transferred capture to the input root, which fired
    // `lostpointercapture` AT the button that held the implicit touch capture.
    // That event BUBBLES, and the root's handler cancelled the pointer — so the
    // press ended while the finger was still on the glass. `touch-source.ts`
    // now skips the transfer for touch pointers AND ignores a loss reported
    // against anything but the root itself.
    const result = await session.page.evaluate(() => {
      const probe = window.__OVERLAY_PROBE__;
      probe.mount();
      const punch = probe.measure().buttons.punch!;
      probe.press(1, punch.centreX, punch.centreY);
      const afterPress = probe.isButtonDown('punch');
      probe.loseCaptureAtButton(1, 'punch');
      const afterLoss = probe.isButtonDown('punch');
      probe.release(1, punch.centreX, punch.centreY);
      const afterRelease = probe.isButtonDown('punch');
      return { afterPress, afterLoss, afterRelease };
    });
    expect(result.afterPress).toBe(true);
    expect(result.afterLoss).toBe(true);
    expect(result.afterRelease).toBe(false);
  });
});
