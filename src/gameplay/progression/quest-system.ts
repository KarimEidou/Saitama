/**
 * QUEST STATE MACHINE
 *
 *   locked ──(prerequisites + class gate + boredom gate)──▶ available
 *   available ──accept()──▶ active
 *   active ──every objective complete──▶ completed
 *   active ──timer expiry / ally down / civilian threshold / conflict──▶ failed
 *   active ──abandon()──▶ available
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
import { CLASS_ORDER } from './constants';

const log = createLogger('gameplay.quests');

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
  readonly onResolved?: (quest: RuntimeQuest, outcome: 'completed' | 'failed', reason: string) => void;
}

/** Ordinal for class comparison. C < B < A < S. */
function classRank(heroClass: HeroClass): number {
  return CLASS_ORDER.indexOf(heroClass);
}

export class QuestSystem implements IQuestSystem {
  trackedQuestId: string | undefined;

  private readonly bus: IEventBus;
  private readonly byId = new Map<string, RuntimeQuest>();
  private readonly listeners = new Set<(quest: IQuest, previous: QuestState) => void>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly options: IQuestSystemOptions;
  private readonly playerPosition = new THREE.Vector3();
  /** Quests that armed an encounter this session, so it fires exactly once. */
  private readonly armedEncounters = new Set<string>();

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

    this.setState(quest, 'active');
    quest.timeRemaining = quest.timeLimitSeconds;
    this.trackedQuestId ??= questId;

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
  }

  update(dt: number): void {
    for (const quest of this.byId.values()) {
      if (quest.state !== 'active') continue;

      this.tickReach(quest);
      this.tickSurvive(quest, dt);

      if (quest.timeRemaining !== undefined) {
        quest.timeRemaining -= dt;
        if (quest.timeRemaining <= 0) {
          quest.timeRemaining = 0;
          this.fail(quest, 'timeLimit');
          continue;
        }
      }

      if (quest.allObjectivesComplete) this.complete(quest);
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
  restoreState(questId: string, state: QuestState, progress?: Readonly<Record<string, number>>): void {
    const quest = this.byId.get(questId);
    if (!quest) return;
    quest.state = state;
    if (state === 'active' && quest.timeLimitSeconds !== undefined && quest.timeRemaining === undefined) {
      quest.timeRemaining = quest.timeLimitSeconds;
    }
    if (!progress) return;
    for (const objective of quest.objectives) {
      const value = progress[objective.id];
      if (typeof value === 'number') objective.current = value;
    }
  }

  /** Remaining seconds on a quest's timer, or undefined when it is untimed. */
  timeRemaining(questId: string): number | undefined {
    return this.byId.get(questId)?.timeRemaining;
  }

  /** Serialise objective progress for the save file. */
  serialiseProgress(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const quest of this.byId.values()) {
      const entry: Record<string, number> = {};
      for (const objective of quest.objectives) entry[objective.id] = objective.current;
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
          quest.civiliansLost++;
          const limit = quest.rules.failOnCiviliansLost;
          if (limit !== undefined && quest.civiliansLost >= limit) {
            this.fail(quest, 'civiliansLost');
          }
        }
        void event;
      }),

      this.bus.on('AllyDowned', (event) => {
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
          quest.collateral += event.collateralCost;
          const limit = quest.rules.failOnCollateral;
          if (limit !== undefined && quest.collateral > limit) {
            this.fail(quest, 'collateral');
          }
        }
      })
    );
  }

  /** 'reach' objectives: distance to the objective's own location. */
  private tickReach(quest: RuntimeQuest): void {
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
    for (let i = 0; i < quest.objectives.length; i++) {
      const objective = quest.objectives[i]!;
      if (objective.kind !== 'survive' || objective.complete) continue;
      const priorDone = quest.objectives.slice(0, i).every((o) => o.complete);
      if (!priorDone) continue;
      objective.current = Math.min(objective.required, objective.current + dt);
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
      isBoss: quest.rules.isBoss ?? true,
    });
    log.info(`encounter "${encounterId}" armed by "${quest.title}"`);
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
      if (boredom >= (this.options.funFightLock ?? 0.72)) return false;
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
    this.setState(quest, 'completed');
    quest.timeRemaining = undefined;
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
    this.releaseTimeOverride(quest);
    this.options.onResolved?.(quest, 'failed', reason);
    this.setState(quest, 'failed');
    quest.timeRemaining = undefined;
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
