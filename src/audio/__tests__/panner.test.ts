/**
 * SPATIAL PANNER — defaults, clamps, and the branches Chromium cannot reach.
 *
 * `panner.ts` states as a design note that "both the AudioParam form
 * (`positionX`) and the legacy setter form (`setPosition`) are supported.
 * Chromium exposes the former; some WebViews still only expose the latter."
 * The entire verification apparatus for this unit is headless CHROMIUM, so the
 * legacy branches in `setSpatialPosition` and `setListenerOrientation` are by
 * construction unreachable by every existing test — and they are the code that
 * runs on the older Android WebViews this game ships to.
 *
 * `configurePanner`'s clamps are in the same position: they are what keeps
 * `maxDistance` strictly above `refDistance` (an inverted pair makes the
 * distance model behave arbitrarily), and they run on every 3D trigger. Both
 * functions take plain structural objects, so no context is needed.
 */

import { describe, expect, it } from 'vitest';
import {
  configurePanner,
  createSpatialPanner,
  setListenerOrientation,
  setSpatialPosition,
  SPATIAL_DEFAULTS,
  type ISpatialSettings,
} from '../panner';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

interface IWrite {
  readonly value: number;
  readonly time: number;
}

interface IFakeParam {
  readonly writes: IWrite[];
  setValueAtTime(value: number, time: number): void;
}

function fakeAudioParam(): IFakeParam {
  const writes: IWrite[] = [];
  return {
    writes,
    setValueAtTime(value: number, time: number) {
      writes.push({ value, time });
    },
  };
}

interface ISpy {
  readonly calls: number[][];
  (...args: number[]): void;
}

function spy(): ISpy {
  const calls: number[][] = [];
  const fn = ((...args: number[]) => {
    calls.push(args);
  }) as ISpy;
  Object.defineProperty(fn, 'calls', { value: calls });
  return fn;
}

/** A panner exposing the modern AudioParam position interface. */
function modernPanner(): {
  x: IFakeParam;
  y: IFakeParam;
  z: IFakeParam;
  legacy: ISpy;
  node: PannerNode;
} {
  const x = fakeAudioParam();
  const y = fakeAudioParam();
  const z = fakeAudioParam();
  const legacy = spy();
  const node = { positionX: x, positionY: y, positionZ: z, setPosition: legacy };
  return { x, y, z, legacy, node: node as unknown as PannerNode };
}

/** A panner as a legacy WebView exposes it: setter only. */
function legacyPanner(): { legacy: ISpy; node: PannerNode } {
  const legacy = spy();
  return { legacy, node: { setPosition: legacy } as unknown as PannerNode };
}

const AT = { x: 1, y: 2, z: 3 };
const FORWARD = { x: 0, y: 0, z: -1 };
const UP = { x: 0, y: 1, z: 0 };

/* -------------------------------------------------------------------------- */

describe('createSpatialPanner', () => {
  it('applies the documented mobile-cost defaults', () => {
    const ctx = {
      createPanner: () => ({}) as Record<string, unknown>,
    } as unknown as BaseAudioContext;
    const panner = createSpatialPanner(ctx);
    // 'equalpower', NOT 'HRTF': HRTF convolution is roughly an order of
    // magnitude more expensive per voice and inaudible through a phone.
    expect(panner.panningModel).toBe('equalpower');
    expect(panner.distanceModel).toBe('inverse');
    expect(panner.refDistance).toBe(6);
    expect(panner.maxDistance).toBe(500);
    expect(panner.rolloffFactor).toBe(1);
    // Omnidirectional: game sound sources are not cones.
    expect(panner.coneInnerAngle).toBe(360);
    expect(panner.coneOuterAngle).toBe(360);
    expect(panner.coneOuterGain).toBe(1);
  });

  it('matches SPATIAL_DEFAULTS', () => {
    const ctx = {
      createPanner: () => ({}) as Record<string, unknown>,
    } as unknown as BaseAudioContext;
    const panner = createSpatialPanner(ctx);
    expect(panner.refDistance).toBe(SPATIAL_DEFAULTS.refDistance);
    expect(panner.maxDistance).toBe(SPATIAL_DEFAULTS.maxDistance);
    expect(panner.rolloffFactor).toBe(SPATIAL_DEFAULTS.rolloffFactor);
  });
});

describe('configurePanner', () => {
  const blank = (): PannerNode =>
    ({ refDistance: 1, maxDistance: 10000, rolloffFactor: 1 }) as unknown as PannerNode;

  it('lifts a zero refDistance and a negative rolloff off their bad values', () => {
    // A zero `refDistance` divides by zero in the inverse distance model; a
    // negative rolloff AMPLIFIES with distance.
    const panner = blank();
    configurePanner(panner, { refDistance: 0, maxDistance: 0, rolloffFactor: -3 });
    expect(panner.refDistance).toBe(0.01);
    expect(panner.maxDistance).toBeCloseTo(0.02, 12);
    expect(panner.rolloffFactor).toBe(0);
  });

  it('pushes an inverted maxDistance above refDistance', () => {
    const panner = blank();
    configurePanner(panner, { refDistance: 60, maxDistance: 10, rolloffFactor: 1 });
    expect(panner.refDistance).toBe(60);
    expect(panner.maxDistance).toBeCloseTo(60.01, 9);
  });

  it('INVARIANT: maxDistance is strictly greater than refDistance, for any input', () => {
    const table: readonly ISpatialSettings[] = [
      { refDistance: 0, maxDistance: 0, rolloffFactor: -3 },
      { refDistance: 60, maxDistance: 10, rolloffFactor: 1 },
      { refDistance: -5, maxDistance: -100, rolloffFactor: 0 },
      { refDistance: 6, maxDistance: 500, rolloffFactor: 1 },
      // The registry's own `collapse.*` profile: must pass through untouched.
      { refDistance: 60, maxDistance: 3000, rolloffFactor: 0.55 },
    ];
    for (const settings of table) {
      const panner = blank();
      configurePanner(panner, settings);
      expect(panner.maxDistance).toBeGreaterThan(panner.refDistance);
      expect(panner.rolloffFactor).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves a well-formed profile alone', () => {
    const panner = blank();
    configurePanner(panner, { refDistance: 60, maxDistance: 3000, rolloffFactor: 0.55 });
    expect(panner.refDistance).toBe(60);
    expect(panner.maxDistance).toBe(3000);
    expect(panner.rolloffFactor).toBe(0.55);
  });
});

describe('setSpatialPosition', () => {
  it('writes one scheduled value per axis on a modern node', () => {
    const p = modernPanner();
    setSpatialPosition(p.node, AT, 4.5);
    expect(p.x.writes).toEqual([{ value: 1, time: 4.5 }]);
    expect(p.y.writes).toEqual([{ value: 2, time: 4.5 }]);
    expect(p.z.writes).toEqual([{ value: 3, time: 4.5 }]);
    expect(p.legacy.calls).toEqual([]);
  });

  it('uses the legacy setter when no AudioParams exist', () => {
    const p = legacyPanner();
    setSpatialPosition(p.node, AT, 4.5);
    expect(p.legacy.calls).toEqual([[1, 2, 3]]);
  });

  it('falls back when modern support is only PARTIAL', () => {
    // A half-migrated WebView is the realistic failure: the guard requires all
    // three params, and writing two of three would silently drop an axis.
    const x = fakeAudioParam();
    const y = fakeAudioParam();
    const legacy = spy();
    const node = { positionX: x, positionY: y, setPosition: legacy } as unknown as PannerNode;
    setSpatialPosition(node, AT, 4.5);
    expect(legacy.calls).toEqual([[1, 2, 3]]);
    expect(x.writes).toEqual([]);
    expect(y.writes).toEqual([]);
  });

  it('does not throw on a node with neither form', () => {
    expect(() => setSpatialPosition({} as unknown as PannerNode, AT, 0)).not.toThrow();
  });
});

describe('setListenerOrientation', () => {
  it('writes forward and up on the right params', () => {
    const params = {
      forwardX: fakeAudioParam(),
      forwardY: fakeAudioParam(),
      forwardZ: fakeAudioParam(),
      upX: fakeAudioParam(),
      upY: fakeAudioParam(),
      upZ: fakeAudioParam(),
    };
    const legacy = spy();
    const listener = { ...params, setOrientation: legacy } as unknown as AudioListener;
    setListenerOrientation(listener, FORWARD, UP, 2);
    expect(params.forwardX.writes).toEqual([{ value: 0, time: 2 }]);
    expect(params.forwardY.writes).toEqual([{ value: 0, time: 2 }]);
    expect(params.forwardZ.writes).toEqual([{ value: -1, time: 2 }]);
    expect(params.upX.writes).toEqual([{ value: 0, time: 2 }]);
    expect(params.upY.writes).toEqual([{ value: 1, time: 2 }]);
    expect(params.upZ.writes).toEqual([{ value: 0, time: 2 }]);
    expect(legacy.calls).toEqual([]);
  });

  it('uses the legacy setter when no AudioParams exist', () => {
    const legacy = spy();
    const listener = { setOrientation: legacy } as unknown as AudioListener;
    setListenerOrientation(listener, FORWARD, UP, 2);
    expect(legacy.calls).toEqual([[0, 0, -1, 0, 1, 0]]);
  });

  it('falls back when modern support is only PARTIAL', () => {
    const forwardX = fakeAudioParam();
    const legacy = spy();
    const listener = { forwardX, setOrientation: legacy } as unknown as AudioListener;
    setListenerOrientation(listener, FORWARD, UP, 2);
    expect(legacy.calls).toEqual([[0, 0, -1, 0, 1, 0]]);
    expect(forwardX.writes).toEqual([]);
  });

  it('does not throw on a listener with neither form', () => {
    expect(() =>
      setListenerOrientation({} as unknown as AudioListener, FORWARD, UP, 0)
    ).not.toThrow();
  });
});
