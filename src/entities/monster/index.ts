/**
 * ══════════════════════════════════════════════════════════════════════════
 *  MONSTERS — public surface
 *
 *    import { MonsterSystem, monsterArchetype, bossScript } from '@/entities/monster';
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THE ONE THING TO UNDERSTAND BEFORE USING THIS MODULE ──────────────────
 * Saitama's attacks carry `LethalIntent`, not damage. Every non-boss monster
 * in this table — a street pest, a god-tier Harbinger, all of them — dies to
 * one lethal hit, immediately, with no health check and no tier check.
 *
 * A BOSS DIES TO THE IDENTICAL PUNCH, but only after its scripted phase
 * resolves. That gate lives here, and it reaches combat exactly one way:
 *
 *     BossEncounter.enterPhase(final)
 *       → bus.emit('BossPhaseChanged', { isFinalPhase: true })
 *       → CombatSystem.onBossPhaseChanged
 *       → ICombatTarget.phaseResolved = true
 *       → HitResolver stops absorbing and starts killing
 *
 * It is a TIMER/NARRATIVE gate. It is not an HP gate, no amount of damage can
 * force it, and `bossPhaseChipDamage` ships at 0 so nothing can even try.
 * `harness/monster` asserts the gate in BOTH directions, because getting it
 * wrong one way makes bosses unkillable and the other way collapses every
 * encounter in the game into its own establishing shot.
 *
 * ── WHAT IT TALKS TO ──────────────────────────────────────────────────────
 * The event bus, and nothing else. It emits `EncounterStarted`,
 * `BossPhaseChanged`, `ShockwaveFired` and `AllyDowned`; it listens to
 * `EntityKilled`, `EntityDamaged`, `ShockwaveFired`, `AllyDowned` and
 * `EncounterEnded`. It imports `@/types`, `@/util` and `three` — never
 * combat, never the crowd, never the roster, never streaming — and
 * `__tests__/imports.test.ts` fails the build if that changes.
 *
 * Geometry is somebody else's job: `IMonsterArchetype.assetKey` is a string
 * the roster owns, and `Monster.attach(instance)` takes the finished
 * `ICharacterInstance`. A monster with no body ticks perfectly well.
 *
 * ── WIRING IT UP ──────────────────────────────────────────────────────────
 *
 *   const monsters = new MonsterSystem({
 *     bus,
 *     seed: worldSeed,
 *     districtAt: (p) => city.districtAt(p),
 *     ringAt: (p) => streaming.ringAt(p),      // R2 is off limits
 *     groundHeight: (x, z) => city.heightAt(x, z),
 *     lineOfSight: (a, b) => spatial.raycast(a, b) === null,
 *     onSpawned: (m) => characters.create(m.archetype.assetKey).then((c) => m.attach(c)),
 *   });
 *
 *   function frame(dt: number, time: number) {
 *     monsters.update(dt, { time, focus: player.position, targets: perceivable });
 *   }
 *
 *   monsters.startBossEncounter('boss.deepSeaKing', pier, { ally: mumenRider });
 */

/* -- composition ----------------------------------------------------------- */
export {
  MonsterSystem,
  type IMonsterCombatDescriptor,
  type IMonsterFrame,
  type IMonsterSystemOptions,
} from './monster-system';

/* -- the entity ------------------------------------------------------------ */
export {
  Monster,
  createMonster,
  ACTOR_TO_MONSTER_STATE,
  MONSTER_TO_ACTOR_STATE,
  type IMonsterOptions,
} from './monster';

/* -- the brain ------------------------------------------------------------- */
export {
  MonsterBrain,
  intentForPower,
  punchKindForAttack,
  MONSTER_VISION_DEFAULT_HALF_ANGLE_RAD,
  type AttackPhase,
  type IMonsterBrainOptions,
} from './brain';

/* -- the state machine ----------------------------------------------------- */
export {
  MonsterFsm,
  MONSTER_TRANSITIONS,
  MONSTER_SELF_TRANSITIONS,
  MONSTER_STATE_TIMEOUT_SECONDS,
  MONSTER_STATE_FALLBACK,
  analyseTransitionTable,
  reachableFrom,
  type ITransitionFlaw,
} from './fsm';

/* -- the table ------------------------------------------------------------- */
export {
  MONSTER_ARCHETYPES,
  archetypesForDistrict,
  archetypesForTier,
  bossArchetypes,
  findMonsterArchetype,
  monsterArchetype,
  spawnableArchetypes,
} from './archetypes';

/* -- spawning -------------------------------------------------------------- */
export {
  SpawnDirector,
  DEFAULT_SPAWN_POLICY,
  DISTRICT_TIER_WEIGHTS,
  MONSTER_CHUNK_SIZE_METRES,
  MONSTER_RING_OUTER_CHUNKS,
  clampToWorld,
  ringBetween,
  type ILiveMonsterRef,
  type ISpawnContext,
  type ISpawnDecision,
  type ISpawnDirectorOptions,
} from './spawn-director';

/* -- boss encounters ------------------------------------------------------- */
export {
  BossEncounter,
  PHASE_STALL_SECONDS,
  type IBossEncounterOptions,
  type IEncounterAlly,
} from './boss-encounter';
export { BOSS_SCRIPTS, bossScript, findBossScript } from './boss-scripts';

/* -- contracts ------------------------------------------------------------- */
export { MONSTER_STATES } from './types';
export type {
  BossPhaseKind,
  DistrictTierWeights,
  IBossPhase,
  IBossPhaseState,
  IBossScript,
  IMonsterArchetype,
  IMonsterAttack,
  IMonsterSnapshot,
  IMonsterTarget,
  IMonsterWorld,
  IMovementProfile,
  ISpawnDirectorStats,
  ISpawnOrder,
  ISpawnPolicy,
  MonsterAttackKind,
  MonsterMotion,
  MonsterState,
  SpawnPacingState,
} from './types';
