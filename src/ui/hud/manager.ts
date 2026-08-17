/**
 * THE HUD MANAGER
 *
 * Owns the screen stack, the frame loop, the safe area and the palette. One
 * object; the bootstrap constructs it and calls two methods.
 *
 * ── THE STACK, AND WHY BACK IS A STACK OPERATION ───────────────────────────
 * Android's hardware back button is not a "close" button, it is a POP. A player
 * who opens pause -> settings -> palette and presses back expects to land on
 * settings, then pause, then the game. Modelling that as anything other than a
 * stack produces the classic Android bug where back exits the app from three
 * screens deep, and Capacitor will happily do exactly that if nobody consumes
 * the event.
 *
 * ── THE FRAME LOOP ─────────────────────────────────────────────────────────
 *   update(dt)
 *     1. advance the store's clock
 *     2. if anything changed, call `render` on the visible screens — arbitrary
 *        DOM, a few times a minute
 *     3. call `frame` on the visible screens with the shared FrameWriter —
 *        custom properties only, every frame, deduplicated
 *
 * Step 2 is gated on a dirty flag and step 3 never allocates. That split is the
 * entire performance contract and it is asserted in `harness/hud.verify.ts`.
 *
 * ── PAUSE IS NOT THE HUD'S DECISION ────────────────────────────────────────
 * Opening a modal screen calls `onModalChange(true)`; what that does to the
 * clock is the game loop's business. The HUD does not own `timeScale` and must
 * not — a UI that paused the simulation directly would pause it during a
 * cutscene menu, during a death screen, and during the one case where the
 * designer wanted the world to keep moving.
 */

import type { SafeAreaInsets } from '@/types';
import { el } from './dom';
import { FrameWriter, type IFrameWriterStats } from './frame-writer';
import type { IHudModel } from './model';
import { applySafeArea } from './safe-area';
import { HudStore, type IHudStoreOptions } from './store';
import { ensureHudStyles } from './styles';
import { AlertLayer } from './alerts';
import type { HudScreenName, IHudScreen } from './screen';
import { CombatHudScreen } from './screens/combat-hud';
import { LoadingScreen } from './screens/loading';
import { PauseScreen } from './screens/pause';
import { QuestLogScreen } from './screens/quest-log';
import { RankBoardScreen } from './screens/rank-board';
import { ResultsScreen } from './screens/results';
import { SettingsScreen } from './screens/settings';
import { normaliseSettings, type IHudSettings } from './settings-model';

export interface IHudManagerOptions {
  /** Where the HUD mounts. Normally `#ui-root`. */
  readonly mount: HTMLElement;
  /** Event bus. Optional so the harness can drive the store directly. */
  readonly bus?: IHudStoreOptions['bus'];
  /** Initial settings, e.g. from a save. */
  readonly settings?: Partial<IHudSettings>;
  /** Called whenever the settings screen changes something. */
  readonly onSettingsChange?: (settings: IHudSettings) => void;
  /** Called when a modal screen opens or closes. Drive `timeScale` from this. */
  readonly onModalChange?: (modal: boolean) => void;
  /** Overrides `env(safe-area-inset-*)` where the WebView reports zero. */
  readonly safeArea?: Partial<SafeAreaInsets>;
  /** Loading-screen line, for reproducible screenshots. */
  readonly loadingLineIndex?: number;
}

export class HudManager {
  readonly root: HTMLElement;
  readonly store: HudStore;
  readonly alerts: AlertLayer;

  private readonly doc: Document;
  private readonly writer = new FrameWriter();
  private readonly screens = new Map<HudScreenName, IHudScreen>();
  private readonly stackValue: HudScreenName[] = ['hud'];
  private readonly options: IHudManagerOptions;
  private readonly combat: CombatHudScreen;
  private readonly questLog: QuestLogScreen;
  private renderPending = true;
  private lastModal = false;
  private disposed = false;

  constructor(options: IHudManagerOptions) {
    this.options = options;
    const doc = options.mount.ownerDocument;
    this.doc = doc;
    ensureHudStyles(doc);

    this.store = new HudStore({
      bus: options.bus,
      settings: options.settings,
      onDirty: () => {
        this.renderPending = true;
      },
    });

    this.root = el(doc, 'div', {
      className: 'hud-root',
      attrs: { 'data-hud': 'root' },
      dataset: {
        palette: this.store.model.settings.palette,
        reducedMotion: String(this.store.model.settings.reducedMotion),
      },
    });
    applySafeArea(this.root, options.safeArea);
    this.root.style.setProperty('--hud-scale', String(this.store.model.settings.hudScale));

    /* ---- screens ---- */
    this.combat = new CombatHudScreen(doc, {
      onPause: () => this.push('pause'),
      onOpenQuests: () => this.push('quests'),
    });
    this.questLog = new QuestLogScreen(doc, {
      onClose: () => this.pop(),
      onTrack: (id) => this.store.trackQuest(id),
    });
    const screens: IHudScreen[] = [
      new LoadingScreen(doc, { lineIndex: options.loadingLineIndex }),
      this.combat,
      new PauseScreen(doc, {
        onResume: () => this.show('hud'),
        onQuests: () => this.push('quests'),
        onRank: () => this.push('rank'),
        onSettings: () => this.push('settings'),
      }),
      this.questLog,
      new RankBoardScreen(doc, { onClose: () => this.pop() }),
      new SettingsScreen(doc, {
        onClose: () => this.pop(),
        onChange: (settings) => this.applySettings(settings),
      }),
      new ResultsScreen(doc, {
        onDismiss: () => {
          this.store.setInvoice(null);
          this.show('hud');
        },
      }),
    ];
    for (const screen of screens) {
      this.screens.set(screen.name, screen);
      this.root.appendChild(screen.element);
    }

    this.alerts = new AlertLayer(doc);
    this.root.appendChild(this.alerts.element);

    /* Quest rows are tapped to pin them; routing lives here so the log does
       not have to attach a listener per row. */
    this.root.addEventListener('pointerup', (event) => {
      if (this.active === 'quests') this.questLog.handleTap(event.target);
    });

    options.mount.appendChild(this.root);
    this.applyStack();
  }

  /* ---------------------------------------------------------------------- */
  /* Stack                                                                  */
  /* ---------------------------------------------------------------------- */

  get active(): HudScreenName {
    return this.stackValue[this.stackValue.length - 1]!;
  }

  get stack(): readonly HudScreenName[] {
    return this.stackValue;
  }

  /** Replace the stack with a single screen. */
  show(name: HudScreenName): void {
    this.stackValue.length = 0;
    this.stackValue.push(name);
    this.applyStack();
  }

  /** Push a screen over the current one. Re-pushing the top is a no-op. */
  push(name: HudScreenName): void {
    if (this.active === name) return;
    this.stackValue.push(name);
    this.applyStack();
  }

  /** Pop back one screen. Popping the last entry falls back to the HUD. */
  pop(): void {
    if (this.stackValue.length <= 1) {
      this.show('hud');
      return;
    }
    this.stackValue.pop();
    this.applyStack();
  }

  /**
   * Route a hardware back press.
   *
   * @returns true when the UI consumed it. Returning false lets Capacitor's
   *   default run, which on Android backgrounds the app — correct behaviour
   *   from the HUD, and a bug from any other screen.
   */
  handleBack(): boolean {
    const screen = this.screens.get(this.active);
    if (screen?.onBack?.()) return true;
    if (this.stackValue.length > 1) {
      this.pop();
      return true;
    }
    if (this.active !== 'hud') {
      this.show('hud');
      return true;
    }
    return false;
  }

  private applyStack(): void {
    const active = this.active;
    for (const [name, screen] of this.screens) {
      // The combat HUD stays visible UNDER a modal: a pause menu that blanks
      // the fight behind it makes it impossible to answer the question the
      // player opened it to answer.
      const visible = name === active || (name === 'hud' && this.underlays(active));
      if (visible) screen.show();
      else screen.hide();
    }
    const modal = this.screens.get(active)?.modal ?? false;
    if (modal !== this.lastModal) {
      this.lastModal = modal;
      this.options.onModalChange?.(modal);
    }
    this.renderPending = true;
  }

  /** True when the combat HUD should stay drawn behind `name`. */
  private underlays(name: HudScreenName): boolean {
    return name !== 'boot' && name !== 'title' && name !== 'credits' && name !== 'gameOver';
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the HUD.
   *
   * @param dt Seconds. Pass the UNSCALED delta: the HUD keeps animating while
   *   the game is paused, and a pause screen whose clock has stopped cannot
   *   dismiss its own toasts.
   */
  update(dt: number): void {
    if (this.disposed) return;
    this.store.update(dt);
    const model = this.store.model;

    if (this.store.consumeDirty() || this.renderPending) {
      this.renderPending = false;
      this.alerts.render(model);
      for (const screen of this.screens.values()) {
        if (screen.visible) screen.render(model);
      }
    }

    /* THE 60 Hz PATH. Custom properties only, from here down. */
    for (const screen of this.screens.values()) {
      if (screen.visible) screen.frame(model, this.writer);
    }

    /* The results screen shows itself when an invoice arrives. */
    if (model.invoice && this.active !== 'results') this.push('results');
  }

  /** Statistics from the last frames. Used by the harness assertions. */
  get writerStats(): IFrameWriterStats {
    return this.writer.stats;
  }

  /** Reset the write counters, e.g. before a measured window. */
  resetWriterStats(): void {
    this.writer.resetStats();
  }

  /* ---------------------------------------------------------------------- */
  /* Configuration                                                          */
  /* ---------------------------------------------------------------------- */

  /** Apply settings and notify the bootstrap. */
  applySettings(patch: Partial<IHudSettings>): IHudSettings {
    const settings = normaliseSettings({ ...this.store.model.settings, ...patch });
    this.store.setSettings(settings);
    this.root.dataset.palette = settings.palette;
    this.root.dataset.reducedMotion = String(settings.reducedMotion);
    this.root.style.setProperty('--hud-scale', String(settings.hudScale));
    this.options.onSettingsChange?.(settings);
    this.renderPending = true;
    return settings;
  }

  /** Re-apply safe-area insets after an orientation change. */
  refreshSafeArea(insets?: Partial<SafeAreaInsets>): void {
    applySafeArea(this.root, insets ?? this.options.safeArea);
  }

  /** The live model, for assertions and for the bootstrap's pushes. */
  get model(): IHudModel {
    return this.store.model;
  }

  /** A screen by name, for the harness. */
  screen(name: HudScreenName): IHudScreen | undefined {
    return this.screens.get(name);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.store.dispose();
    for (const screen of this.screens.values()) screen.dispose();
    this.screens.clear();
    this.alerts.dispose();
    this.root.remove();
  }
}
