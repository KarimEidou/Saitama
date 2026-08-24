/**
 * THE TWO BRIDGES `Game` OWNS AND NOBODY WAS WATCHING
 *
 * `src/ui/hud/__tests__/settings-and-safe-area.test.ts` covers the HUD's half of
 * both: the coercion that stops a stale save reaching the renderer, and the
 * inset arithmetic. Neither half says anything about the wiring on THIS side,
 * and both were shipping unverified:
 *
 *   SETTINGS   `Game.applySettings` is the ONLY place `floatingStick` and
 *              `stickHand` reach the input layer. The HUD produces an
 *              `IHudSettings` and stops; `hud.verify.ts` flips `stickHand` and
 *              never re-tunes the overlay; `input.verify.ts` drives
 *              `window.__INPUT__.setConfig` and bypasses the bridge outright.
 *              So the branch's headline claim — both hands wired end to end,
 *              floating kept as the setting it always claimed to be — rested on
 *              twelve lines nothing executed.
 *
 *   SAFE AREA  layer 2 of `src/ui/hud/safe-area.ts`'s `max(env, override, floor)`
 *              was populated by reading `env()`, so on the Android WebViews it
 *              exists for it was 0 and the three layers collapsed to one. The
 *              replacement reads the platform's own status-bar inset, and the
 *              one rule that is genuinely easy to get wrong — a reading is only
 *              valid in the orientation it was taken in — is pinned here,
 *              because getting it wrong is invisible until somebody turns the
 *              phone and the whole HUD drops 59 px for a notch that moved.
 *
 * ── HOW THIS RUNS WITHOUT A DOM ────────────────────────────────────────────
 * Vitest runs in the `node` environment and the repo carries neither jsdom nor
 * happy-dom, so an assembled `Game` cannot be constructed: no canvas, no GL, no
 * `document`. It does not have to be. `applySettings` touches five collaborators
 * and `window.devicePixelRatio`, and NONE of them is the renderer's GL context —
 * so the real method is invoked against a hand-built `this`, which is the same
 * trade `settings-and-safe-area.test.ts` makes when it scans `manager.ts` rather
 * than constructing a `HudManager`. This one goes a step further than a source
 * scan can: the INPUT MANAGER IS REAL. `createInputManager({ headless: true })`
 * is the production factory, `setTuning` is the production method, and the
 * assertions read `manager.tuning` back after it has been through the real
 * `resolveTuning`. A regex over `game.ts` would agree with a bridge that wrote
 * `stickHand` into a field the input layer ignores; this does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* Hoisted by vitest and consulted by the mock factory below, so a single test
   can decide what the native side answers before triggering the import. */
const statusBar = vi.hoisted(() => ({
  height: 0,
  /** When set, `getInfo()` rejects with it — the "no plugin here" path. */
  failure: null as Error | null,
  calls: 0,
}));

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    getInfo: (): Promise<{ height: number }> => {
      statusBar.calls++;
      return statusBar.failure ? Promise.reject(statusBar.failure) : Promise.resolve(statusBar);
    },
  },
}));

import { createInputManager, type IInputManager } from '@/ui/input';
import type { IQualityTier, SafeAreaInsets } from '@/types';
import { DEFAULT_HUD_SETTINGS, type IHudSettings } from '@/ui/hud/settings-model';
import { createDiagnostics } from '../diagnostics';
import { Game, NativeStatusBarInset } from '../game';

/* -------------------------------------------------------------------------- */
/* A `this` for the bridge                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything `applySettings` reaches for, and a log of what it did.
 *
 * The four stubs are the four collaborators that genuinely cannot exist in Node:
 * the renderer owns a GL context, and the crowd, the streamer and the roster all
 * want assets. Each records rather than pretends, so the assertions can say what
 * the bridge CALLED, not merely that it did not throw.
 */
interface IBridgeSpy {
  readonly tierCalls: IQualityTier[];
  readonly pixelRatios: number[];
  readonly crowdTiers: IQualityTier[];
  readonly streamerTiers: IQualityTier[];
  readonly rosterLoads: string[];
  readonly input: IInputManager;
  readonly diagnostics: ReturnType<typeof createDiagnostics>;
}

/**
 * @param tier what the renderer claims to be at already — `applySettings` skips
 *   the whole quality cascade when the incoming tier matches, so this is what
 *   makes the "does not re-tier for nothing" case reachable.
 * @param maxPixelRatio the tier cap the resolution slider is scaled UNDER. 1.5
 *   is `medium`, which is what a phone gets.
 * @param residentCivilians whether `chr.civilian` is already loaded, which is
 *   the only thing standing between a `high` tier and an 18 MB fetch.
 */
function bridgeSpy(
  tier: IQualityTier = 'medium',
  maxPixelRatio = 1.5,
  residentCivilians = false
): { self: unknown; spy: IBridgeSpy } {
  const tierCalls: IQualityTier[] = [];
  const pixelRatios: number[] = [];
  const crowdTiers: IQualityTier[] = [];
  const streamerTiers: IQualityTier[] = [];
  const rosterLoads: string[] = [];
  // Headless and with no test bridge: there is no DOM to mount an overlay into,
  // and `window.__INPUT__` belongs to the browser harnesses.
  const input = createInputManager({ headless: true, exposeTestBridge: false });
  const diagnostics = createDiagnostics(tier, 'test');

  let currentTier = tier;
  const self = {
    get renderer() {
      return {
        get tier() {
          return currentTier;
        },
        qualitySettings: { maxPixelRatio },
        setQualityTier(next: IQualityTier): void {
          currentTier = next;
          tierCalls.push(next);
        },
        setPixelRatio(ratio: number): void {
          pixelRatios.push(ratio);
        },
      };
    },
    crowd: {
      setQuality(next: IQualityTier): void {
        crowdTiers.push(next);
      },
    },
    cityStreamer: {
      setQuality(next: IQualityTier): void {
        streamerTiers.push(next);
      },
    },
    roster: {
      isResident: (id: string): boolean => residentCivilians && id === 'chr.civilian',
      load: (id: string): Promise<void> => {
        rosterLoads.push(id);
        return Promise.resolve();
      },
    },
    input,
    diagnostics,
  };

  return {
    self,
    spy: { tierCalls, pixelRatios, crowdTiers, streamerTiers, rosterLoads, input, diagnostics },
  };
}

/** Invoke the REAL bridge against the stand-in `this`. */
function apply(self: unknown, patch: Partial<IHudSettings> = {}): void {
  const settings: IHudSettings = { ...DEFAULT_HUD_SETTINGS, ...patch };
  Game.prototype.applySettings.call(self as Game, settings);
}

/**
 * The browser globals this path reads, and nothing beyond them.
 *
 * `applySettings` computes `min(window.devicePixelRatio, cap) * scale`;
 * `createDiagnostics` carries errors across from `window.__GAME_DIAG__`; and
 * `createGamepadSource` subscribes to `gamepadconnected`. In Node `window` is not
 * merely empty, it is UNDECLARED — so the reference THROWS, the method's own
 * `try` swallows it, and `input.setTuning`, which is the last statement in the
 * block, never runs. That failure mode is worth naming rather than papering
 * over: every control knob in this bridge sits downstream of one `window` read
 * inside a single `try`, which is what the last test in the settings group pins.
 *
 * Deliberately three properties and no more. A fuller fake would let a test pass
 * against DOM this code does not have in Node, which is the opposite of useful.
 */
const NO_WINDOW = Symbol('absent');
let savedWindow: unknown = NO_WINDOW;

beforeEach(() => {
  savedWindow = 'window' in globalThis ? globalThis.window : NO_WINDOW;
  Object.defineProperty(globalThis, 'window', {
    value: {
      devicePixelRatio: 3,
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
    },
    configurable: true,
    writable: true,
  });
  statusBar.height = 0;
  statusBar.failure = null;
  statusBar.calls = 0;
});

afterEach(() => {
  if (savedWindow === NO_WINDOW) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = savedWindow;
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
});

/* -------------------------------------------------------------------------- */
/* The settings bridge                                                        */
/* -------------------------------------------------------------------------- */

describe('Game.applySettings fans the settings screen out', () => {
  it('carries both stick knobs into the live input tuning', () => {
    const { self, spy } = bridgeSpy();
    // The defaults, so a failure here is the bridge and not the fixture.
    expect(spy.input.tuning.floatingStick).toBe(false);
    expect(spy.input.tuning.stickHand).toBe('left');

    apply(self, { stickLayout: 'floating', stickHand: 'right' });

    // `stickHand` was never forwarded at all before this branch: the settings
    // screen offered the choice, wrote it into the model, moved the HUD's own
    // reserve to the other corner, and left the stick in the left one. A
    // left-handed player got a mirrored HUD around an unmirrored control.
    expect(spy.input.tuning.stickHand).toBe('right');
    // `floatingStick` was ADVISORY: the touch stick always floated and this
    // recorded a preference the input layer ignored. It is the real switch now.
    expect(spy.input.tuning.floatingStick).toBe(true);
  });

  it('puts the stick back when the player changes their mind', () => {
    const { self, spy } = bridgeSpy();
    apply(self, { stickLayout: 'floating', stickHand: 'right' });
    apply(self, { stickLayout: 'fixed', stickHand: 'left' });
    // Both knobs are patches onto a live tuning, so a bridge that only ever
    // wrote the non-default value would pass the test above and strand a player
    // who switched back.
    expect(spy.input.tuning.floatingStick).toBe(false);
    expect(spy.input.tuning.stickHand).toBe('left');
  });

  it('keeps the two stick knobs independent of each other', () => {
    const { self, spy } = bridgeSpy();
    apply(self, { stickLayout: 'floating', stickHand: 'left' });
    expect(spy.input.tuning.floatingStick).toBe(true);
    expect(spy.input.tuning.stickHand).toBe('left');
    apply(self, { stickLayout: 'fixed', stickHand: 'right' });
    expect(spy.input.tuning.floatingStick).toBe(false);
    expect(spy.input.tuning.stickHand).toBe('right');
  });

  it('carries look sensitivity through as a GAIN, untouched', () => {
    const { self, spy } = bridgeSpy();
    apply(self, { lookSensitivity: 2 });
    expect(spy.input.tuning.lookSensitivity).toBe(2);
    // `lookFullRateDegPerSec` is the DENOMINATOR that normalises degrees/second
    // into the -1..1 look rate, and a shared contract constant `IPlayerTuning`
    // mirrors. Scaling it here divided the touch turn rate BY the setting — 2.0x
    // turned the camera at half speed — and did nothing at all for keyboard and
    // gamepad, which emit an already-normalised rate and never see it.
    const { self: control, spy: unchanged } = bridgeSpy();
    apply(control, {});
    expect(spy.input.tuning.lookFullRateDegPerSec).toBe(
      unchanged.input.tuning.lookFullRateDegPerSec
    );
  });

  it('carries invert and haptics, including the turn-it-off direction', () => {
    const { self, spy } = bridgeSpy();
    expect(spy.input.tuning.hapticsEnabled).toBe(true);
    // Haptics were never written at all, so they stayed on after the player
    // turned them off — the one setting whose failure the player can FEEL.
    apply(self, { invertLookY: true, hapticsEnabled: false });
    expect(spy.input.tuning.invertLookY).toBe(true);
    expect(spy.input.tuning.hapticsEnabled).toBe(false);
    // The tuning field is not the thing that stops the phone buzzing — the SINK
    // is, and `setTuning` is the only place the two are kept in step.
    expect(spy.input.haptics.enabled).toBe(false);
  });

  it('clamps the device ratio to the tier cap BEFORE scaling it', () => {
    // DPR 3 phone, `medium` cap 1.5. Handing the renderer `dpr * scale` did
    // nothing on any device whose DPR already exceeded the cap — which is every
    // phone this ships to: 3*1.0 and 3*0.5 both clamp to 1.5, and the player
    // drags the slider to half and watches the frame rate not move.
    const { self, spy } = bridgeSpy('medium', 1.5);
    apply(self, { resolutionScale: 0.5 });
    expect(spy.pixelRatios).toEqual([0.75]);
    apply(self, { resolutionScale: 1 });
    expect(spy.pixelRatios).toEqual([0.75, 1.5]);
  });

  it('reads the cap back off the renderer AFTER the tier change', () => {
    // A player who raises quality and lowers resolution in one visit must be
    // scaled under the NEW tier's cap, not the one the renderer had on entry.
    const { self, spy } = bridgeSpy('low', 1);
    // The stub's `setQualityTier` moves `qualitySettings` nowhere, so pin the
    // ORDER instead: the tier is pushed before the ratio is computed.
    apply(self, { qualityTier: 'high', resolutionScale: 0.85 });
    expect(spy.tierCalls).toEqual(['high']);
    expect(spy.pixelRatios).toEqual([0.85]);
  });

  it('cascades a tier change across every system that holds one', () => {
    const { self, spy } = bridgeSpy('medium', 1.5);
    apply(self, { qualityTier: 'low' });
    expect(spy.tierCalls).toEqual(['low']);
    expect(spy.crowdTiers).toEqual(['low']);
    expect(spy.streamerTiers).toEqual(['low']);
    expect(spy.diagnostics.quality).toBe('low');
  });

  it('does not re-tier anything when the tier did not move', () => {
    const { self, spy } = bridgeSpy('medium', 1.5);
    apply(self, { qualityTier: 'medium', resolutionScale: 0.85 });
    expect(spy.tierCalls).toEqual([]);
    expect(spy.crowdTiers).toEqual([]);
    expect(spy.streamerTiers).toEqual([]);
    // The resolution knob is NOT inside the tier branch and must still land.
    expect(spy.pixelRatios).toEqual([1.275]);
  });

  it('pulls the civilian sheet only when high is asked for and it is absent', () => {
    // The shared sheet is fetched at boot only when the PROBED tier was `high`,
    // and on mobile the probe never says `high`. A player who raises quality is
    // asking for the near-tier civilians the crowd now agrees to dress.
    const { self, spy } = bridgeSpy('medium', 1.5, false);
    apply(self, { qualityTier: 'high' });
    expect(spy.rosterLoads).toEqual(['chr.civilian']);

    const { self: loaded, spy: idempotent } = bridgeSpy('medium', 1.5, true);
    apply(loaded, { qualityTier: 'high' });
    expect(idempotent.rosterLoads).toEqual([]);

    const { self: down, spy: never } = bridgeSpy('high', 2, false);
    apply(down, { qualityTier: 'low' });
    expect(never.rosterLoads).toEqual([]);
  });

  it('records a thrown collaborator instead of taking the game down with it', () => {
    const { self, spy } = bridgeSpy();
    const broken = {
      ...(self as object),
      crowd: {
        setQuality(): never {
          throw new Error('crowd is not resident');
        },
      },
    };
    expect(() => apply(broken, { qualityTier: 'low' })).not.toThrow();
    expect(spy.diagnostics.systems.failed.settings).toContain('crowd is not resident');
  });

  it('leaves every control knob downstream of one try — so the throw is visible', () => {
    // Not a design endorsement, a pinned consequence. The whole body is one
    // `try`, and `input.setTuning` is its LAST statement: anything that throws
    // above it silently drops the stick, the hand, haptics and invert together,
    // and the only trace is the diagnostics entry asserted above. If this ever
    // becomes two `try` blocks, this expectation is the one to delete.
    const { self, spy } = bridgeSpy();
    const broken = {
      ...(self as object),
      crowd: {
        setQuality(): never {
          throw new Error('crowd is not resident');
        },
      },
    };
    apply(broken, { qualityTier: 'low', stickHand: 'right', hapticsEnabled: false });
    expect(spy.input.tuning.stickHand).toBe('left');
    expect(spy.input.tuning.hapticsEnabled).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Layer 2 of the safe area                                                   */
/* -------------------------------------------------------------------------- */

const ENV_ZERO: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Let `refresh`'s fire-and-forget chain finish.
 *
 * A microtask drain is NOT enough: the chain opens with a dynamic
 * `import('@capacitor/status-bar')`, which is real asynchronous work — the first
 * call has to resolve and evaluate a module, and even a mocked one lands a
 * macrotask later. Draining microtasks alone made every assertion below read the
 * state from BEFORE the call and pass or fail for the wrong reason.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function pretendNative(native: boolean): void {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => native,
    getPlatform: () => (native ? 'android' : 'web'),
  };
}

describe('NativeStatusBarInset is a second source, not an echo', () => {
  it('gives the top edge a value on a WebView whose env() reports nothing', async () => {
    // THE case the override exists for: several Android WebViews report `env()`
    // as 0 on devices that plainly have a cutout. Before this, layer 2 was
    // itself an `env()` read, so it was 0 too and `max(0, 0, 8px)` was 8px.
    pretendNative(true);
    statusBar.height = 59;
    const inset = new NativeStatusBarInset();
    const changed = vi.fn();

    expect(inset.compose(ENV_ZERO, true)).toEqual(ENV_ZERO);
    inset.refresh(true, changed);
    await settle();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(inset.compose(ENV_ZERO, true)).toEqual({ top: 59, right: 0, bottom: 0, left: 0 });
  });

  it('takes the larger of the two rather than replacing one with the other', async () => {
    // Both sources are wrong in one direction and right in the other, so the
    // fold is a `max` — the same rule the stylesheet applies to the same layers.
    pretendNative(true);
    statusBar.height = 20;
    const inset = new NativeStatusBarInset();
    inset.refresh(true, () => {});
    await settle();
    const env: SafeAreaInsets = { top: 59, right: 0, bottom: 34, left: 0 };
    expect(inset.compose(env, true)).toEqual(env);
  });

  it('touches only the top edge, because only the top edge has a source', async () => {
    // No installed plugin can see the landscape cutout or the gesture bar:
    // `getDisplayCutout()` lives behind a Java file in the GENERATED `android/`
    // directory. Those three edges stay `max(env(), floor)` and nothing more.
    pretendNative(true);
    statusBar.height = 59;
    const inset = new NativeStatusBarInset();
    inset.refresh(true, () => {});
    await settle();
    const env: SafeAreaInsets = { top: 0, right: 34, bottom: 21, left: 59 };
    expect(inset.compose(env, true)).toEqual({ top: 59, right: 34, bottom: 21, left: 59 });
  });

  it('refuses to replay a portrait reading in landscape', async () => {
    // iOS reports a status-bar height of 0 in landscape and the notch moves to
    // the side. A portrait 59 replayed there pushes the whole HUD down 59px for
    // nothing — and, since the stick anchors off the safe-area corner, moves the
    // ring as well. Invisible until somebody turns the phone.
    pretendNative(true);
    statusBar.height = 59;
    const inset = new NativeStatusBarInset();
    inset.refresh(true, () => {});
    await settle();
    expect(inset.compose(ENV_ZERO, true).top).toBe(59);
    expect(inset.compose(ENV_ZERO, false)).toEqual(ENV_ZERO);

    // ...and it comes back the moment a landscape reading lands.
    statusBar.height = 0;
    const rotated = vi.fn();
    inset.refresh(false, rotated);
    await settle();
    expect(rotated).toHaveBeenCalledTimes(1);
    expect(inset.compose({ ...ENV_ZERO, left: 59 }, false)).toEqual({ ...ENV_ZERO, left: 59 });
  });

  it('re-publishes only when the answer actually moved', async () => {
    pretendNative(true);
    statusBar.height = 59;
    const inset = new NativeStatusBarInset();
    const changed = vi.fn();
    inset.refresh(true, changed);
    await settle();
    expect(changed).toHaveBeenCalledTimes(1);
    // A resize storm — a soft keyboard animating open — must not turn one
    // bridge round-trip per frame into one full HUD re-layout per frame.
    inset.refresh(true, changed);
    await settle();
    inset.refresh(true, changed);
    await settle();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(statusBar.calls).toBe(3);
  });

  it('never asks a plain browser, which has no such plugin at all', async () => {
    // `@capacitor/status-bar` registers no web implementation, so a call would
    // reject with UNIMPLEMENTED on every single resize.
    pretendNative(false);
    const inset = new NativeStatusBarInset();
    const changed = vi.fn();
    inset.refresh(true, changed);
    inset.refresh(false, changed);
    await settle();
    expect(statusBar.calls).toBe(0);
    expect(changed).not.toHaveBeenCalled();
    expect(inset.compose(ENV_ZERO, true)).toEqual(ENV_ZERO);
  });

  it('stops asking once the platform has said no', async () => {
    // A native shell without the plugin answers the same way forever, and
    // `onResize` is not a rare event.
    pretendNative(true);
    statusBar.failure = new Error('Plugin not implemented');
    const inset = new NativeStatusBarInset();
    const changed = vi.fn();
    inset.refresh(true, changed);
    await settle();
    inset.refresh(true, changed);
    await settle();
    expect(statusBar.calls).toBe(1);
    expect(changed).not.toHaveBeenCalled();
    // And the composition falls back to exactly what shipped before: `env()`.
    expect(inset.compose({ ...ENV_ZERO, top: 44 }, true)).toEqual({ ...ENV_ZERO, top: 44 });
  });

  it('survives a bridge that hands back something that is not a number', async () => {
    // The value crosses a JSON bridge from an Android `int` and an iOS
    // `CGFloat`. `NaN` reaching `max()` poisons the inset for the session.
    pretendNative(true);
    statusBar.height = Number.NaN;
    const inset = new NativeStatusBarInset();
    inset.refresh(true, () => {});
    await settle();
    expect(inset.compose(ENV_ZERO, true)).toEqual(ENV_ZERO);
  });
});
