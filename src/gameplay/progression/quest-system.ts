/**
 * QUEST STATE MACHINE
 *
 *   locked ──(prerequisites + class gate + boredom gate)──▶ available
 *   available ──accept()──▶ active
 *   active ──every objective complete──▶ completed
 *   active ──timer expiry / ally down / civilian threshold / conflict──▶ failed
 *   active ──abandon()──▶ available
 *
 * `failed` and `completed` are TERMINAL, deliberately: there is no retry edge,
 * so a quest that other quests list as a prerequisite takes its whole chain
 * with it when it fails. Abandoning is the survivable exit; failing is not.
 *
 * ── EVERYTHING ARRIVES ON THE BUS ──────────────────────────────────────────
 * This system imports no other system. Kills, rescues, losses, collateral and
 * ally deaths are all read off `IEventBus` and translated into objective
 * progress. The only things pushed in directly are the player's position (for
 * 'reach' objectives) and explicit `reportProgress` calls for interactions the
 * bus has no event for, such as buying cabbages.
 *
 * ── FAILURE IS CONTENT ─────────────────────────────────────────────────────
 * Four separate failure branches exist because each says something different:
 * a timer running out on the tunnel means people died waiting; a timer running
 * out on the bargain sale means he got back and the beef was gone; Mumen Rider
 * going down means the one thing worth protecting was not protected; and
 * completing a subjugation inside the sale window fails the sale, because he
 * cannot be in two places and the game should say so rather than quietly
 * letting him have both.
 */

import * as THREE from 'three';
import type {
  HeroClass,
  IEventBus,
  IQuest,
  IQuestSystem,
  QuestObjectiveKind,
  QuestState,
  ThreatTier,
  Vec3,
} from '@/types';
import { createLogger } from '@/util';
import { QUEST_DEFS, RuntimeQuest, type IQuestDef } from './quest-defs';
import { BOREDOM_FUN_FIGHT_LOCK, CLASS_ORDER } from './constants';

const log = createLogger('gameplay.quests');

/**
 * Metres from a quest's location within which a civilian loss or a piece of
 * collateral is charged to it. Matches the incident attribution radius in
 * `progression-system.ts`: generous, because a serious punch throws debris a
 * long way, but not so generous that a wave in another district fails a
 * rescue the player is still driving to.
 */
const QUEST_BLAST_RADIUS = 200;

/**
 * Reserved `questProgress` key holding a quest's remaining seconds.
 *
 * `ISaveGame.questProgress` is `questId -> objectiveId -> number` and this
 * workstream does not own that contract, so the timer rides in the same map
 * under a key no objective id can collide with. Without it every timed quest
 * reloads with a full clock and is save-scummable to infinity.
 */
const TIME_REMAINING_KEY = '__timeRemaining';

/** Callbacks the quest system fires that have no home on the shared bus. */
export interface IQuestSystemOptions {
  readonly bus: IEventBus;
  /** Override the catalogue. Tests use this to isolate one state machine. */
  readonly defs?: readonly IQuestDef[];
  /** The player's current standing, read whenever availability is evaluated. */
  readonly heroClass?: () => HeroClass;
  /** Current boredom, for the "genuinely fun fight" lock. */
  readonly boredom?: () => number;
  /** Boredom above which fun fights stop appearing. */
  readonly funFightLock?: number;
  /** Called when an active quest wants the clock pinned, and when it lets go. */
  readonly onForceTimeOfDay?: (timeOfDay: number | undefined, questId: string) => void;
  /** Called when a quest completes or fails, before the state change is published. */
  readonly onResolved?: (
    quest: RuntimeQuest,
    outcome: 'completed' | 'failed',
    reason: string
  ) => void;
}

/** Ordinal for class comparison. C < B < A < S. */
function classRank(heroClass: HeroClass): number {
  return CLASS_ORDER.indexOf(heroClass);
}

/** The five states the machine actually has. Save payloads are strings, not `QuestState`s. */
const QUEST_STATES: ReadonlySet<string> = new Set<QuestState>([
  'locked',
  'available',
  'active',
  'completed',
  'failed',
]);

export class QuestSystem implements IQuestSystem {
  trackedQuestId: string | undefined;

  private readonly bus: IEventBus;
  private readonly byId = new Map<string, RuntimeQuest>();
  private readonly listeners = new Set<(quest: IQuest, previous: QuestState) => void>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly options: IQuestSystemOptions;
  private readonly playerPosition = new THREE.Vector3();
  /** False until someone pushes a position; the origin is not a player location. */
  private hasPlayerPosition = false;
  /** Encounters currently armed, so each fires once per accepted run of its quest. */
  private readonly armedEncounters = new Set<string>();
  /** Allies reported down this session. 'protect' objectives read it. */
  private readonly downedAllies = new Set<string>();

  constructor(options: IQuestSystemOptions) {
    this.options = options;
    this.bus = options.bus;

    for (const def of options.defs ?? QUEST_DEFS) {
      this.byId.set(def.id, new RuntimeQuest(def));
    }
    this.subscribe();
    this.refreshAvailability();
  }

  get quests(): ReadonlyMap<string, IQuest> {
    return this.byId;
  }

  get activeQuests(): readonly IQuest[] {
    return [...this.byId.values()].filter((q) => q.state === 'active');
  }

  /** Quests the player could accept right now. */
  get availableQuests(): readonly IQuest[] {
    return [...this.byId.values()].filter((q) => q.state === 'available');
  }

  /** Runtime view, for the HUD and the harness. */
  get runtimeQuests(): readonly RuntimeQuest[] {
    return [...this.byId.values()];
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  accept(questId: string): boolean {
    const quest = this.byId.get(questId);
    if (!quest) return false;
    if (quest.state !== 'available') return false;
    if (!this.meetsRequirements(quest)) return false;

    // The clock is set BEFORE the announcement: `setState` publishes
    // `QuestStateChanged` and runs every listener synchronously, and
    // `timeRemaining(questId)` is the only way a consumer can read a quest
    // clock. `abandon()` is the precedent.
    quest.timeRemaining = quest.timeLimitSeconds;
    this.trackedQuestId ??= questId;
    this.setState(quest, 'active');

    if (quest.rules.forceTimeOfDay !== undefined) {
      this.options.onForceTimeOfDay?.(quest.rules.forceTimeOfDay, quest.id);
    }
    log.info(`accepted "${quest.title}"`);
    return true;
  }

  abandon(questId: string): void {
    const quest = this.byId.get(questId);
    if (!quest || quest.state !== 'active') return;
    for (const objective of quest.objectives) objective.current = 0;
    quest.timeRemaining = undefined;
    quest.civiliansLost = 0;
    quest.collateral = 0;
    this.disarmEncounter(quest);
    this.releaseTimeOverride(quest);
    this.setState(quest, 'available');
    if (this.trackedQuestId === questId) this.trackedQuestId = undefined;
  }

  onStateChange(cb: (quest: IQuest, previous: QuestState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame                                                              */
  /* ---------------------------------------------------------------------- */

  /** Push the player's position. Drives 'reach' objectives. */
  setPlayerPosition(position: Vec3): void {
    this.playerPosition.set(position.x, position.y, position.z);
    this.hasPlayerPosition = true;
  }

  update(dt: number): void {
    for (const quest of this.byId.values()) {
      if (quest.state !== 'active') continue;

      this.tickProtect(quest);
      this.tickReach(quest);
      this.tickSurvive(quest, dt);

      // Completion is checked BEFORE the timer runs down. A frame in which the
      // last objective was met is a frame the player finished inside the
      // window, and losing it to the same frame's expiry would fail a quest
      // that was done — permanently, since `failed` is terminal.
      if (quest.allObjectivesComplete) {
        this.complete(quest);
        continue;
      }

      if (quest.timeRemaining !== undefined) {
        quest.timeRemaining -= dt;
        if (quest.timeRemaining <= 0) {
          quest.timeRemaining = 0;
          this.fail(quest, 'timeLimit');
          continue;
        }
      }
    }
    this.refreshAvailability();
  }

  /* ---------------------------------------------------------------------- */
  /* Progress                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Report progress towards every matching objective on every ACTIVE quest.
   *
   * Matching rule: the kind must match, and an objective that names a
   * `targetId` only accepts that target. An objective with no `targetId`
   * accepts anything of its kind — which is what lets the duty quota count
   * "incidents" while a subjugation counts one specific monster.
   */
  reportProgress(kind: QuestObjectiveKind, targetId: string | undefined, amount: number): void {
    if (amount === 0) return;
    for (const quest of this.byId.values()) {
      if (quest.state !== 'active') continue;
      let touched = false;
      for (const objective of quest.objectives) {
        if (objective.kind !== kind) continue;
        if (objective.targetId !== undefined && objective.targetId !== targetId) continue;
        if (objective.complete) continue;
        objective.current = Math.min(objective.required, objective.current + amount);
        touched = true;
      }
      if (touched) {
        this.maybeArmEncounter(quest);
        if (quest.allObjectivesComplete) this.complete(quest);
      }
    }
  }

  /** Force a quest into a state. Save loading only. */
  restoreState(
    questId: string,
    state: QuestState,
    progress?: Readonly<Record<string, number>>
  ): void {
    const quest = this.byId.get(questId);
    if (!quest) return;
    // `state` arrives from JSON through an unchecked cast. A string the machine has no edge out of
    // strands the quest forever: `accept()` requires 'available', `abandon()` requires 'active',
    // and `refreshAvailability()` only moves quests between 'locked' and 'available'.
    if (!QUEST_STATES.has(state)) {
      log.warn(`ignoring unknown state "${String(state)}" for quest "${questId}"`);
      return;
    }
    quest.state = state;

    if (state === 'active' && quest.timeLimitSeconds !== undefined) {
      // The stored clock wins. Falling back to the full limit whenever one is
      // missing is what let a timed quest be save-scummed to infinity.
      const stored = progress?.[TIME_REMAINING_KEY];
      quest.timeRemaining =
        stored !== undefined && Number.isFinite(stored)
          ? Math.max(0, Math.min(quest.timeLimitSeconds, stored))
          : quest.timeLimitSeconds;
    }

    if (progress) {
      for (const objective of quest.objectives) {
        const value = progress[objective.id];
        if (typeof value === 'number' && Number.isFinite(value)) {
          objective.current = Math.max(0, Math.min(objective.required, value));
        }
      }
    }

    // A quest restored mid-fight has to re-announce its encounter: nothing else
    // will, because the objective that would have armed it is already complete.
    if (state === 'active') this.maybeArmEncounter(quest);
  }

  /** Remaining seconds on a quest's timer, or undefined when it is untimed. */
  timeRemaining(questId: string): number | undefined {
    return this.byId.get(questId)?.timeRemaining;
  }

  /** Serialise objective progress — and the running clock — for the save file. */
  serialiseProgress(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const quest of this.byId.values()) {
      const entry: Record<string, number> = {};
      for (const objective of quest.objectives) entry[objective.id] = objective.current;
      if (quest.timeRemaining !== undefined) entry[TIME_REMAINING_KEY] = quest.timeRemaining;
      out[quest.id] = entry;
    }
    return out;
  }

  /** Serialise lifecycle state for the save file. */
  serialiseStates(): Record<string, QuestState> {
    const out: Record<string, QuestState> = {};
    for (const quest of this.byId.values()) out[quest.id] = quest.state;
    return out;
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.listeners.clear();
    this.armedEncounters.clear();
    this.downedAllies.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private subscribe(): void {
    this.unsubscribers.push(
      this.bus.on('EntityKilled', (event) => {
        // A kill advances a SUBJUGATION objective. It does not, anywhere,
        // advance rank — see `progression-system.ts`.
        if (event.specId) this.reportProgress('defeat', event.specId, 1);
        this.reportProgress('destroy', event.specId, 1);
        if (event.threatTier) this.reportProgress('defeatTier', event.threatTier as ThreatTier, 1);
      }),

      this.bus.on('CivilianSaved', (event) => {
        if (event.byPlayer) this.reportProgress('rescue', undefined, 1);
      }),

      this.bus.on('CivilianLost', (event) => {
        for (const quest of this.byId.values()) {
          if (quest.state !== 'active') continue;
          // Only losses NEAR the quest count against it. Without the distance
          // test a wave in another district fails a rescue the player is still
          // driving to, and `failed` is terminal.
          if (!this.chargesToQuest(quest, event.position)) continue;
          quest.civiliansLost++;
          const limit = quest.rules.failOnCiviliansLost;
          if (limit !== undefined && quest.civiliansLost >= limit) {
            this.fail(quest, 'civiliansLost');
          }
        }
      }),

      this.bus.on('AllyDowned', (event) => {
        this.downedAllies.add(String(event.entityId));
        for (const quest of this.byId.values()) {
          if (quest.state !== 'active') continue;
          const guarded = quest.rules.failOnAllyDowned;
          if (guarded?.includes(event.entityId as string)) {
            this.fail(quest, `allyDowned:${event.displayName}`);
          }
        }
      }),

      this.bus.on('ChunkDetached', (event) => {
        for (const quest of this.byId.values()) {
          if (quest.state !== 'active') continue;
          if (!this.chargesToQuest(quest, event.position)) continue;
          quest.collateral += event.collateralCost;
          const limit = quest.rules.failOnCollateral;
          if (limit !== undefined && quest.collateral > limit) {
            this.fail(quest, 'collateral');
          }
        }
      })
    );
  }

  /**
   * True when something that happened at `position` is this quest's problem.
   *
   * A quest with no location answers for the whole city, which is what the
   * citywide duty quota means.
   */
  private chargesToQuest(quest: RuntimeQuest, position: Vec3): boolean {
    if (!quest.location) return true;
    const dx = quest.location.x - position.x;
    const dy = quest.location.y - position.y;
    const dz = quest.location.z - position.z;
    return dx * dx + dy * dy + dz * dz <= QUEST_BLAST_RADIUS * QUEST_BLAST_RADIUS;
  }

  /**
   * 'protect' objectives: satisfied for as long as the guarded ally stands.
   *
   * Nothing on the bus reports "still alive", so the objective reads the
   * inverse — it holds until an `AllyDowned` names its target, and empties the
   * moment one does. Without this the kind has no progress source at all and
   * every quest carrying one is uncompletable, taking its dependants with it.
   */
  private tickProtect(quest: RuntimeQuest): void {
    for (const objective of quest.objectives) {
      if (objective.kind !== 'protect') continue;
      const downed = objective.targetId !== undefined && this.downedAllies.has(objective.targetId);
      objective.current = downed ? 0 : objective.required;
    }
  }

  /** 'reach' objectives: distance to the objective's own location. */
  private tickReach(quest: RuntimeQuest): void {
    // "Never pushed" is not "standing at the origin": evaluating reach against
    // (0,0,0) would complete any objective authored near the world centre on
    // frame one, and silently does nothing for every other quest.
    if (!this.hasPlayerPosition) return;
    for (const objective of quest.objectives) {
      if (objective.kind !== 'reach' || objective.complete || !objective.location) continue;
      const radius = objective.radius ?? 15;
      if (this.playerPosition.distanceToSquared(objective.location) <= radius * radius) {
        objective.current = objective.required;
        this.maybeArmEncounter(quest);
      }
    }
  }

  /**
   * 'survive' objectives count SECONDS, and only once everything before them
   * is done. Without the sequencing rule, the Deep Sea King's 45-second hold
   * would tick down while the player was still driving there.
   */
  private tickSurvive(quest: RuntimeQuest, dt: number): void {
    // `priorDone` carries "everything before this objective is complete" forward, so the
    // sequencing rule costs one pass and no allocation instead of a fresh slice per objective.
    // `complete` is read AFTER the credit above it, so two consecutive survive objectives can
    // still both finish on one long frame, exactly as the slice version allowed.
    let priorDone = true;
    for (const objective of quest.objectives) {
      if (priorDone && objective.kind === 'survive' && !objective.complete) {
        objective.current = Math.min(objective.required, objective.current + dt);
      }
      if (!objective.complete) priorDone = false;
    }
  }

  /**
   * Fire `EncounterStarted` the first time a quest's arming condition is met.
   *
   * Arming condition: every 'reach' objective on the quest is complete. That is
   * what "you got to the place, the fight begins" means, and it is why the
   * boss quests all lead with a reach objective.
   */
  private maybeArmEncounter(quest: RuntimeQuest): void {
    const encounterId = quest.rules.encounterId;
    if (!encounterId || this.armedEncounters.has(encounterId)) return;
    const reaches = quest.objectives.filter((o) => o.kind === 'reach');
    if (reaches.length > 0 && !reaches.every((o) => o.complete)) return;

    this.armedEncounters.add(encounterId);
    const position = quest.location ?? new THREE.Vector3();
    this.bus.emit('EncounterStarted', {
      encounterId,
      threatTier: quest.threatTier,
      position: { x: position.x, y: position.y, z: position.z },
      radius: quest.rules.isBoss ? 90 : 45,
      participantIds: (quest.rules.rivals ?? []).map((id) => `ally.${id}`),
      // Matches the radius above and the monster system's producer. Defaulting
      // to true gave a routine subjugation the boss music and the boss HUD.
      isBoss: quest.rules.isBoss ?? false,
    });
    log.info(`encounter "${encounterId}" armed by "${quest.title}"`);
  }

  /**
   * Let a quest's encounter fire again.
   *
   * The guard exists so one accepted run announces its fight exactly once — not
   * so a quest may only ever be fought once per session. A quest abandoned or
   * failed with its encounter still latched can be re-accepted and walked back
   * to, and nothing would ever open the fight again.
   */
  private disarmEncounter(quest: RuntimeQuest): void {
    const encounterId = quest.rules.encounterId;
    if (encounterId) this.armedEncounters.delete(encounterId);
  }

  private meetsRequirements(quest: RuntimeQuest): boolean {
    if (quest.requiredClass) {
      const current = this.options.heroClass?.() ?? 'C';
      if (classRank(current) < classRank(quest.requiredClass)) return false;
    }
    for (const prerequisite of quest.prerequisites ?? []) {
      if (this.byId.get(prerequisite)?.state !== 'completed') return false;
    }
    // The fun-fight lock. Nothing feels fun when you are numb, so those
    // encounters simply do not appear.
    if (quest.rules.funFight) {
      const boredom = this.options.boredom?.() ?? 0;
      if (boredom >= (this.options.funFightLock ?? BOREDOM_FUN_FIGHT_LOCK)) return false;
    }
    return true;
  }

  /** Move locked quests to available (and back) as the world changes. */
  private refreshAvailability(): void {
    for (const quest of this.byId.values()) {
      if (quest.state === 'active' || quest.state === 'completed') continue;
      const eligible = this.meetsRequirements(quest);
      if (eligible && quest.state === 'locked') this.setState(quest, 'available');
      else if (!eligible && quest.state === 'available') this.setState(quest, 'locked');
    }
  }

  private complete(quest: RuntimeQuest): void {
    if (quest.state !== 'active') return;
    this.releaseTimeOverride(quest);
    this.options.onResolved?.(quest, 'completed', 'objectivesComplete');
    quest.timeRemaining = undefined;
    this.setState(quest, 'completed');
    if (this.trackedQuestId === quest.id) this.trackedQuestId = undefined;

    // Mutually exclusive windows. Completing the subjugation IS missing the
    // sale; the player cannot be in two places, and the game says so.
    for (const conflictId of quest.rules.conflictsWith ?? []) {
      const other = this.byId.get(conflictId);
      if (other && other.state === 'active') this.fail(other, `conflict:${quest.id}`);
    }
    this.refreshAvailability();
  }

  private fail(quest: RuntimeQuest, reason: string): void {
    if (quest.state !== 'active') return;
    this.disarmEncounter(quest);
    this.releaseTimeOverride(quest);
    this.options.onResolved?.(quest, 'failed', reason);
    quest.timeRemaining = undefined;
    this.setState(quest, 'failed');
    if (this.trackedQuestId === quest.id) this.trackedQuestId = undefined;
    log.info(`failed "${quest.title}" (${reason})`);
  }

  private releaseTimeOverride(quest: RuntimeQuest): void {
    if (quest.rules.forceTimeOfDay === undefined) return;
    this.options.onForceTimeOfDay?.(undefined, quest.id);
  }

  private setState(quest: RuntimeQuest, next: QuestState): void {
    const previous = quest.state;
    if (previous === next) return;
    quest.state = next;
    this.bus.emit('QuestStateChanged', {
      questId: quest.id,
      previous,
      state: next,
      title: quest.title,
    });
    for (const listener of this.listeners) {
      try {
        listener(quest, previous);
      } catch (error) {
        log.error(`quest state listener threw: ${String(error)}`);
      }
    }
  }
}
