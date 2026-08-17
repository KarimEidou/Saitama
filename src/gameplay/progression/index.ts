/**
 * PROGRESSION BARREL
 *
 *   import { ProgressionCoordinator } from '@/gameplay/progression';
 *
 * The one-line wiring:
 *
 *   const progression = new ProgressionCoordinator({ bus, time: dayNight });
 *   progression.witnesses.register('civ.14', 'civilian', position);
 *   progression.quests.accept('quest.rescue.tunnel');
 *   progression.update(dt);
 *
 * ── THE ONE THING TO KNOW BEFORE CHANGING ANYTHING HERE ────────────────────
 * Rank does not move on kills. `POINTS_PER_KILL` is 0 and it is load-bearing:
 * the protagonist wins every fight instantly, so a kill counter measures
 * nothing. Rank moves on WITNESSED saves and REPORTED collateral, and the
 * asymmetry between those two — credit needs an audience, blame does not — is
 * the entire design. Genos, at the same fight, banks 2.4x and climbs past you.
 */

export {
  CLASS_SIZES,
  CLASS_ORDER,
  CLASS_STEP_COST,
  CLASS_PROMOTION_COST,
  START_HERO_CLASS,
  START_HERO_RANK,
  START_HERO_NAME,
  POINTS_PER_KILL,
  POINTS_PER_WITNESSED_SAVE,
  POINTS_PER_UNWITNESSED_SAVE,
  POINTS_PER_COLLATERAL_UNIT,
  COLLATERAL_REPORT_BASE,
  COLLATERAL_REPORT_WITNESSED,
  INCIDENT_POINTS_BY_TIER,
  WITNESS_RADIUS,
  WITNESS_CREDIBILITY,
  WITNESS_SATURATION,
  RIVAL_CREDIT_MULTIPLIER,
  RIVAL_OFFSCREEN_POINTS_PER_DAY,
  BOREDOM_RANK_FLOOR,
  BOREDOM_FUN_FIGHT_LOCK,
  HEROISM_BOREDOM_RELIEF,
  BOREDOM_ON_MISSED_SALE,
  START_REPUTATION,
  SAVE_VERSION,
  SAVE_KEY,
  type WitnessKind,
  type RivalId,
  type HeroicDeed,
} from './constants';

export {
  LADDER_SIZE,
  START_POINTS,
  classForIndex,
  rankForIndex,
  indexForRank,
  indexForPoints,
  pointsForIndex,
  rankFromPoints,
  compareRank,
  rankGap,
  formatRank,
} from './rank-ladder';

export {
  WitnessField,
  mergeReports,
  NO_WITNESSES,
  type IWitness,
  type IWitnessReport,
} from './witness';

export { BoredomModel, type IBoredomOptions, type IHeroicRecord } from './boredom';

export {
  RivalTracker,
  type IRivalState,
  type IRivalSnapshot,
  type IRivalTrackerOptions,
} from './rivals';

export {
  QUEST_DEFS,
  RuntimeQuest,
  RuntimeObjective,
  type IQuestDef,
  type IQuestObjectiveDef,
  type IQuestRules,
} from './quest-defs';

export { QuestSystem, type IQuestSystemOptions } from './quest-system';

export {
  ProgressionSystem,
  type IProgressionOptions,
  type IIncidentRecord,
  type IIncidentReport,
} from './progression-system';

export {
  SaveManager,
  MemorySaveBackend,
  LocalStorageSaveBackend,
  CapacitorSaveBackend,
  selectSaveBackend,
  validateSave,
  migrate,
  buildSave,
  type ISaveBackend,
  type ISaveExtras,
  type IStoredSave,
  type ISaveManagerOptions,
  type ISaveValidationIssue,
} from './save-game';

export {
  ProgressionCoordinator,
  type IProgressionCoordinatorOptions,
  type ITimeController,
} from './coordinator';
