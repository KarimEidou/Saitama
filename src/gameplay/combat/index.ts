/**
 * ══════════════════════════════════════════════════════════════════════════
 *  ONE-PUNCH COMBAT — public surface
 *
 *    import { createCombatSystem } from '@/gameplay/combat';
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THE MECHANIC ───────────────────────────────────────────────────────────
 * Saitama's attacks carry no damage number; they carry a `LethalIntent` flag,
 * and any lethal hit on any non-boss is an instant kill. Bosses die in one hit
 * too, but only after their scripted phase resolves — a narrative gate, never
 * an HP gate. Everyone else in City Z has real hit points and really loses.
 *
 * Three verbs: TAP (normal punch, 1.2 m, chains), HOLD (serious punch, a 22°
 * cone from 40 m to 180 m), and a HARD LANDING (the radial version of the
 * same). The choice between the first two — reach the monster, or delete the
 * district — is the whole game loop, and `EncounterResult` is the bill.
 *
 * Tap and hold share one button and are told apart on RELEASE, at 140 ms, so
 * that beginning a charge never spends a free kill the player did not choose.
 *
 * ── TWO FIELDS ON `EncounterResult` THAT ARE EASY TO MISUSE ────────────────
 * `propertyDamageYen` is an invoice and is unbounded (~1.5e10 for one serious
 * punch downtown) — read `propertyDamageScore`, which is bounded 0..1, if you
 * are feeding a score. `EncounterEnded.collateralCost` carries the
 * destruction system's own unit, matching `ChunkDetached.collateralCost`, not
 * yen.
 *
 * ── WIRING IT UP ───────────────────────────────────────────────────────────
 *
 *   const combat = createCombatSystem({
 *     bus,
 *     attacker: playerAttackerSource,     // origin + facing, injected
 *     broadPhase: gridBroadPhase,         // src/spatial's cone query, adapted
 *     districtAt: (p) => city.districtAt(p),
 *     lineOfSight: (a, b) => spatial.raycast(a, b) === null,
 *     seed: worldSeed,
 *   });
 *
 *   function frame(frameIndex: number, time: number, dt: number) {
 *     const input = inputManager.poll(frameIndex, time);
 *     combat.update(input, dt, time);
 *   }
 *
 * ── WHAT IT TALKS TO ───────────────────────────────────────────────────────
 * The event bus, and nothing else. It emits `ShockwaveFired`, `EntityKilled`,
 * `EntityDamaged`, `ImpulseApplied`, `CivilianLost`, `AllyDowned`,
 * `CivilianSaved`, `BoredomChanged` and `EncounterEnded`; it listens to
 * `PlayerLanded`, `BossPhaseChanged`, `EncounterStarted`, `ChunkDetached`,
 * `CivilianSaved` and `EntityKilled`. It imports `@/types` and `@/util` and
 * nothing else — `__tests__/imports.test.ts` fails the build if that changes.
 *
 * Everything downstream is a subscriber: VFX draws the cone, destruction
 * detaches the chunks, physics propagates the pressure, the renderer freezes
 * the clock, audio raises the pitch. None of them are referenced here and none
 * of them need to exist for this module to work.
 */

/* -- composition ----------------------------------------------------------- */
export {
  CombatSystem,
  createCombatSystem,
  type ICombatSystemOptions,
  type ICombatDiagnostics,
} from './combat-system';

/* -- tuning ---------------------------------------------------------------- */
export {
  DEFAULT_COMBAT_TUNING,
  LETHAL_INTENTS,
  THREAT_ORDER,
  ZONING_YEN_PER_KG,
  DEFAULT_ZONING_YEN_PER_KG,
  PROPERTY_DAMAGE_HALF_YEN,
  isLethalIntent,
  resolveCombatTuning,
  tierScalar,
  type ICombatTuning,
  type ICombatTuningPatch,
} from './tuning';

/* -- the resolver ---------------------------------------------------------- */
export {
  HitResolver,
  createHitResolver,
  cameraShakeFor,
  trivialityOf,
  type IHitResolverOptions,
} from './resolver';

/* -- targets and structures ------------------------------------------------ */
export { TargetRegistry, LinearScan, type ICombatTargetSpec } from './targets';
export {
  StructureIndex,
  forecastYen,
  type ICombatStructure,
  type ICombatStructureSpec,
} from './structures';

/* -- chain ----------------------------------------------------------------- */
export { PunchChain, chainKind, chainPower, type IChainState } from './chain';

/* -- boredom --------------------------------------------------------------- */
export {
  BoredomMeter,
  type BoredomReason,
  type IBoredomEntry,
  type IBoredomOptions,
} from './boredom';

/* -- encounter scoring ----------------------------------------------------- */
export {
  EncounterTracker,
  type IEncounterStart,
  type IEncounterTrackerOptions,
} from './encounter';

/* -- geometry (exported so the harness can check it against `src/spatial`) -- */
export {
  CONE_EPSILON,
  aabbFromCentre,
  aabbInCone,
  aabbInConeBrute,
  aabbInSphere,
  aabbOverlap,
  coneBounds,
  normalise,
  pointAabbDistanceSq,
  pointAabbFarthestSq,
  pointInAabb,
  pointInCone,
  segmentIntersectsAabb,
  sphereInCone,
  sphereInConeBrute,
  sphereInSphere,
  type ICombatAabb,
  type INormalised,
} from './cone';

/* -- contracts ------------------------------------------------------------- */
export type {
  HeroismKind,
  IAttackerSource,
  ICombatBroadPhase,
  ICombatHit,
  ICombatTarget,
  IEncounterResult,
  IEncounterStartLike,
  IHeroismReport,
  IMutableVec3,
  IPunchOutcome,
  IPunchRequest,
  TargetCoversDamageableData,
} from './types';
export { isTargetAlive } from './types';
