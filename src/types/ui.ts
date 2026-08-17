/**
 * UI / HUD CONTRACT
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * The UI layer is DOM-based, mounted into `#ui-root`, and sits above the
 * canvas. It reads state and emits intents; it must never mutate gameplay
 * state directly.
 */

import type { IDisposable, IUpdatable } from './engine';
import type { ThreatTier, LethalIntent } from './combat';
import type { HeroClass } from './gameplay';

/* -------------------------------------------------------------------------- */
/* Screens                                                                    */
/* -------------------------------------------------------------------------- */

/** Full-screen UI views. Only one is active at a time. */
export type ScreenName =
  | 'boot'
  | 'title'
  | 'hud'
  | 'pause'
  | 'settings'
  | 'map'
  | 'quests'
  | 'rank'
  | 'credits'
  | 'gameOver';

/** A mountable UI view. */
export interface IUIScreen extends IDisposable {
  readonly name: ScreenName;
  /** Root element; the manager attaches it to `#ui-root`. */
  readonly element: HTMLElement;
  readonly visible: boolean;

  /** Called when the screen becomes active. */
  show(): void;
  /** Called when the screen is dismissed. */
  hide(): void;
  /** Per-frame refresh. Keep it cheap — this runs inside the render loop. */
  update(dt: number): void;
  /**
   * Android hardware back / Escape. Return true to consume the event and
   * prevent the manager from falling back to the previous screen.
   */
  onBack?(): boolean;
}

/* -------------------------------------------------------------------------- */
/* HUD state                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Everything the HUD renders, as a plain snapshot.
 *
 * Deliberately a DATA STRUCT, not a set of live references: the HUD diffs this
 * against the previous frame and only touches the DOM when something actually
 * changed. Writing to the DOM every frame is the fastest way to lose 60fps on
 * a mid-tier phone.
 */
export interface IHUDState {
  /** 0..1. */
  readonly health: number;
  /** 0..1; drives the boredom/tone treatment. */
  readonly boredom: number;
  readonly heroClass: HeroClass;
  /** Lower is better. */
  readonly heroRank: number;
  readonly heroPoints: number;
  /** Current force commitment; shown so restraint is legible to the player. */
  readonly intent: LethalIntent;

  /** Objective text for the tracked quest, if any. */
  readonly objective?: string;
  /** 0..1 progress on the tracked objective. */
  readonly objectiveProgress?: number;
  /** Compass bearing to the objective in radians, camera-relative. */
  readonly objectiveBearing?: number;
  /** Metres to the objective. */
  readonly objectiveDistance?: number;

  /** Boss bar, present only during a boss encounter. */
  readonly boss?: {
    readonly name: string;
    readonly threatTier: ThreatTier;
    /** 0..1. */
    readonly health: number;
    readonly phase: number;
  };

  /** Transient notifications to display. */
  readonly notifications: readonly INotification[];
  /** Frames per second; shown only when the debug overlay is enabled. */
  readonly fps?: number;
  /** Whether on-screen touch controls should be drawn. */
  readonly showTouchControls: boolean;
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

/** Visual treatment of a toast. */
export type NotificationKind = 'info' | 'success' | 'warning' | 'danger' | 'rank' | 'quest';

/** A transient on-screen message. */
export interface INotification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body?: string;
  /** Seconds to remain on screen. */
  readonly duration: number;
  /** Seconds since it was raised. */
  readonly age: number;
  /** Optional emoji-free icon key resolved by the HUD. */
  readonly icon?: string;
}

/* -------------------------------------------------------------------------- */
/* Manager                                                                    */
/* -------------------------------------------------------------------------- */

/** Owns screen stacking, notifications and the HUD snapshot. */
export interface IUIManager extends IUpdatable, IDisposable {
  readonly activeScreen: ScreenName;
  /** Screen stack; the last entry is active. */
  readonly stack: readonly ScreenName[];
  readonly hud: IHUDState;

  /** Register a screen implementation. */
  register(screen: IUIScreen): void;
  /** Replace the active screen. */
  show(name: ScreenName): void;
  /** Push a screen over the current one, e.g. pause over HUD. */
  push(name: ScreenName): void;
  /** Pop back to the previous screen. */
  pop(): void;
  /** Merge a partial update into the HUD snapshot. */
  setHUD(patch: Partial<IHUDState>): void;
  /** Raise a toast. Returns its generated id. */
  notify(notification: Omit<INotification, 'id' | 'age'>): string;
  /** Dismiss a toast early. */
  dismiss(id: string): void;
  /** Update safe-area padding after an orientation change. */
  refreshSafeArea(): void;
  /** Route a hardware back press. Returns true when the UI consumed it. */
  handleBack(): boolean;
}
