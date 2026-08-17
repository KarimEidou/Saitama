/**
 * ══════════════════════════════════════════════════════════════════════════
 *  HUD — public surface
 *
 *    import { HudManager } from '@/ui/hud';
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THE HUD IS DOM AND NOT DRAWN IN THE CANVAS ─────────────────────────
 * Text stays crisp at any device pixel ratio with no SDF atlas and no glyph
 * shader. CSS handles `env(safe-area-inset-*)` for the notch and the gesture
 * bar for free, which a Capacitor build absolutely needs and which an in-canvas
 * HUD would have to re-implement from a platform plugin. It costs ZERO draw
 * calls and ZERO shader programs — and the renderer's MEDIUM tier has five
 * spare programs, which VFX is already spending. And Playwright can assert on
 * real nodes instead of on pixels.
 *
 * ── WIRING IT UP ───────────────────────────────────────────────────────────
 *
 *   import '@/ui/hud/fonts';                    // optional; bundles the faces
 *   const hud = new HudManager({
 *     mount: document.getElementById('ui-root')!,
 *     bus,
 *     safeArea: platform.safeArea,
 *     onModalChange: (modal) => { loop.clock.timeScale = modal ? 0 : 1; },
 *     onSettingsChange: (s) => applySettingsAcrossSystems(s),
 *   });
 *
 *   function frame(dtUnscaled: number) {
 *     hud.store.setCharge(input.chargeRatio, input.charging, intent, forecastYen);
 *     hud.update(dtUnscaled);      // UNSCALED: the HUD keeps running when paused
 *   }
 *
 *   platform.onBackButton(() => hud.handleBack());
 *
 * ── WHAT IT SUBSCRIBES TO, AND WHAT MUST BE PUSHED ─────────────────────────
 * Everything the bus carries is subscribed to: `BoredomChanged`, `RankChanged`,
 * `EncounterStarted`/`Ended`, `CivilianSaved`/`Lost`, `ChunkDetached`,
 * `BossPhaseChanged`, `QuestStateChanged`, `TimeOfDayChanged`.
 *
 * Three things are NOT on the bus and are explicit setters on `hud.store`:
 *
 *   setRivals(rows)        `RankChangedEvent` HAS NO HERO ID — it is the
 *                          player's rank event by construction. Rival movement
 *                          comes from `RivalTracker.onRivalRankChanged`. Wire
 *                          it, or the ladder renders empty and says so.
 *   setCollateral(yen,s)   `ChunkDetached.collateralCost` is in destruction's
 *                          unit, not yen. Converting it here would need
 *                          combat's zoning table, which the HUD may not import.
 *   setCharge(...)         A value that changes every frame has no business
 *                          being an event.
 *
 * ── THE PERFORMANCE CONTRACT ───────────────────────────────────────────────
 * Every screen has two entry points. `render(model)` may build DOM and runs
 * when the model changes. `frame(model, writer)` runs at 60 Hz and may write
 * ONLY custom properties, through `FrameWriter`, which throws on anything else.
 * Numbers that change during a fight are CSS counters driven from those
 * properties, so a ticking timer never touches a text node. `harness/hud.ts`
 * asserts zero forced reflows, zero layout shift, and that the set of
 * properties written during a scripted 60 Hz animation contains nothing but
 * `--*`.
 */

/* -- composition ----------------------------------------------------------- */
export { HudManager, type IHudManagerOptions } from './manager';
export { HudStore, displayRankGainMultiplier, seatDelta, prettyEncounterName, type IHudStoreOptions } from './store';

/* -- model ----------------------------------------------------------------- */
export {
  ALERT_LIMIT,
  RANK_FEED_LIMIT,
  compareQuests,
  createHudModel,
  questUrgency,
  type AlertKind,
  type IEncounterInvoice,
  type IEncounterState,
  type IHudAlert,
  type IHudModel,
  type IQuestObjectiveRow,
  type IQuestRow,
  type IRankMovement,
  type IRankState,
  type IRivalRow,
  type IWorldMarker,
  type MarkerKind,
  type QuestUrgency,
} from './model';

/* -- settings -------------------------------------------------------------- */
export {
  DEFAULT_HUD_SETTINGS,
  HUD_SCALE_STEPS,
  QUALITY_BLURB,
  QUALITY_TIERS,
  RESOLUTION_STEPS,
  SENSITIVITY_STEPS,
  normaliseSettings,
  snapToStep,
  stepIndex,
  type IHudSettings,
  type StickHand,
  type StickLayout,
} from './settings-model';

/* -- tokens ---------------------------------------------------------------- */
export {
  BOREDOM_BANDS,
  CLASS_COLOR,
  INTENT_COLOR,
  INTENT_LABEL,
  INTENT_THRESHOLDS,
  MIN_TAP_PX,
  PALETTES,
  PALETTE_LABELS,
  PALETTE_NAMES,
  STICK_RESERVE_PX,
  THUMB_RESERVE_PX,
  TIER_ADVISORY,
  TIER_COLOR,
  TIER_LABEL,
  TIER_ORDER,
  boredomBand,
  intentForCharge,
  type IBoredomBand,
  type IHudPalette,
  type PaletteName,
} from './tokens';

/* -- formatting (pure, unit-tested) --------------------------------------- */
export {
  clockParts,
  formatClock,
  formatCount,
  formatDistance,
  formatDuration,
  formatMultiplier,
  formatPercent,
  formatPoints,
  formatRank,
  formatSeatDelta,
  formatTier,
  formatYenCompact,
  formatYenFull,
  formatYenOku,
  groupDigits,
  type IClockParts,
} from './format';

/* -- the write discipline -------------------------------------------------- */
export { FrameWriter, roundTo, type CssVarName, type IFrameWriterStats } from './frame-writer';
export { CssNumber, CSS_NUMBER_STYLES, escapeCssString, type ICssNumberSpec } from './css-number';

/* -- safe area ------------------------------------------------------------- */
export {
  EDGE_FLOOR_PX,
  NOTCHED_PORTRAIT_INSETS,
  SAFE_AREA_VARS,
  ZERO_INSETS,
  applySafeArea,
  normaliseInsets,
  rotateInsets,
  safeRect,
  type RotationDirection,
} from './safe-area';

/* -- layers ---------------------------------------------------------------- */
export { AlertLayer } from './alerts';
export { MarkerLayer, type IMarkerLayerOptions } from './markers';

/* -- screens --------------------------------------------------------------- */
export { HudScreen, type HudScreenName, type IHudScreen } from './screen';
export { CombatHudScreen, ARC_LENGTH, pickTrackedQuest, type ICombatHudOptions } from './screens/combat-hud';
export { LoadingScreen, LOADING_LINES, type ILoadingOptions } from './screens/loading';
export { PauseScreen, type IPauseOptions } from './screens/pause';
export { QuestLogScreen, type IQuestLogOptions } from './screens/quest-log';
export { RankBoardScreen, type IRankBoardOptions } from './screens/rank-board';
export { ResultsScreen, type IResultsOptions } from './screens/results';
export { SettingsScreen, type ISettingsOptions } from './screens/settings';

/* -- styles ---------------------------------------------------------------- */
export { HUD_STYLE_ID, ensureHudStyles, hudStyles } from './styles';
