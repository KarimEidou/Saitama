/**
 * PROGRESSION COORDINATOR
 *
 * The thin layer that lets the quest system and the ranking system cooperate
 * without either importing the other's concerns:
 *
 *   • a filed incident report advances the C-class duty quota,
 *   • a completed quest pays out ITS OWN authored reward,
 *   • a completed errand relieves boredom, a failed one adds to it,
 *   • an accepted quest marks its encounter as officially dispatched,
 *   • a quest that wants the clock pinned gets it pinned.
 *
 * ── WHY IT IS NOT A GOD OBJECT ─────────────────────────────────────────────
 * Everything here is wiring. There is no scoring, no state machine and no
 * state of its own beyond the day counter: each of those lives in exactly one
 * place, and this file makes the connections that would otherwise have to be
 * repeated identically in the bootstrap, in the harness and in every test.
 */

import type { IDayNightSystem, IEventBus, QuestState } from '@/types';
import { createLogger } from '@/util';
import { BoredomModel } from './boredom';
import { ProgressionSystem, type IIncidentReport } from './progression-system';
import { QuestSystem } from './quest-system';
import { RivalTracker } from './rivals';
import { WitnessField } from './witness';
import { QUEST_DEFS, type IQuestDef, type RuntimeQuest } from './quest-defs';
import { BOREDOM_FUN_FIGHT_LOCK } from './constants';
import { SaveManager, buildSave, type ISaveBackend, type IStoredSave } from './save-game';

const log = createLogger('gameplay.progression');

/** A day/night system the coordinator can pin for scripted quest beats. */
export interface ITimeController {
  forceTimeOfDay(t: number): void;
  releaseTime(easeSeconds?: number): void;
}

export interface IProgressionCoordinatorOptions {
  readonly bus: IEventBus;
  readonly defs?: readonly IQuestDef[];
  readonly heroName?: string;
  readonly saveBackend?: ISaveBackend;
  /** Optional clock. Quests with `forceTimeOfDay` drive it. */
  readonly time?: ITimeController & Partial<IDayNightSystem>;
  readonly worldSeed?: number;
}

export class ProgressionCoordinator {
  readonly progression: ProgressionSystem;
  readonly quests: QuestSystem;
  readonly witnesses: WitnessField;
  readonly boredom: BoredomModel;
  readonly rivals: RivalTracker;
  readonly saves: SaveManager;

  private readonly bus: IEventBus;
  private readonly time: IProgressionCoordinatorOptions['time'];
  private readonly worldSeed: number;
  private readonly questById = new Map<string, RuntimeQuest>();
  private readonly unsubscribers: (() => void)[] = [];

  constructor(options: IProgressionCoordinatorOptions) {
    this.bus = options.bus;
    this.time = options.time;
    this.worldSeed = options.worldSeed ?? 0;

    this.witnesses = new WitnessField();
    this.boredom = new BoredomModel({ bus: options.bus });
    this.rivals = new RivalTracker();
    this.saves = new SaveManager({ backend: options.saveBackend });

    this.progression = new ProgressionSystem({
      bus: options.bus,
      heroName: options.heroName,
      boredom: this.boredom,
      rivals: this.rivals,
      witnesses: this.witnesses,
      onIncidentReported: (report) => this.onIncidentReported(report),
    });

    this.quests = new QuestSystem({
      bus: options.bus,
      defs: options.defs ?? QUEST_DEFS,
      heroClass: () => this.progression.state.rank.heroClass,
      boredom: () => this.boredom.boredom,
      funFightLock: BOREDOM_FUN_FIGHT_LOCK,
      onForceTimeOfDay: (t) => this.onForceTimeOfDay(t),
      onResolved: (quest, outcome) => this.onQuestResolved(quest, outcome),
    });

    for (const quest of this.quests.runtimeQuests) this.questById.set(quest.id, quest);

    // Accepting a request is what makes an incident officially dispatched, and
    // a dispatched incident scores even with nobody watching.
    this.unsubscribers.push(
      this.bus.on('QuestStateChanged', (event) => {
        if (event.state !== 'active') return;
        const encounterId = this.questById.get(event.questId)?.rules.encounterId;
        if (encounterId) this.progression.markDispatched(encounterId);
      })
    );
  }

  update(dt: number): void {
    this.progression.update(dt);
    this.quests.update(dt);
    if (this.time?.state) this.progression.onDayElapsed(this.time.state.dayCount);
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.quests.dispose();
    this.progression.dispose();
    this.boredom.dispose();
  }

  /* ---------------------------------------------------------------------- */
  /* Saves                                                                  */
  /* ---------------------------------------------------------------------- */

  buildSaveGame(playerPosition = { x: 0, y: 0, z: 0 }, playerYaw = 0, savedAt?: string): IStoredSave {
    return buildSave({
      worldSeed: this.worldSeed,
      progression: this.progression.snapshot(),
      playerPosition,
      playerYaw,
      timeOfDay: this.time?.state?.timeOfDay ?? 0.5,
      dayCount: this.time?.state?.dayCount ?? 0,
      questStates: this.quests.serialiseStates(),
      questProgress: this.quests.serialiseProgress(),
      extras: {
        rivals: this.rivals.serialise(),
        heroicDeeds: this.boredom.heroicHistory.map((record) => record.deed),
        lunarAgeDays: (this.time as { lunarAgeDays?: number } | undefined)?.lunarAgeDays,
      },
      savedAt,
    });
  }

  applySaveGame(save: IStoredSave): void {
    this.progression.restore(save.progression);
    this.rivals.restore(save.extras?.rivals);
    for (const [questId, state] of Object.entries(save.questStates)) {
      this.quests.restoreState(questId, state as QuestState, save.questProgress[questId]);
    }
    if (this.time && typeof save.timeOfDay === 'number') {
      (this.time as unknown as { setTimeOfDay?: (t: number) => void }).setTimeOfDay?.(save.timeOfDay);
    }
    log.info(`loaded save from ${save.savedAt}`);
  }

  async save(playerPosition?: { x: number; y: number; z: number }, playerYaw?: number): Promise<IStoredSave> {
    const payload = this.buildSaveGame(playerPosition, playerYaw);
    await this.saves.save(payload);
    return payload;
  }

  async load(): Promise<IStoredSave | undefined> {
    const save = await this.saves.load();
    if (save) this.applySaveGame(save);
    return save;
  }

  /* ---------------------------------------------------------------------- */
  /* Wiring                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Every filed report is one resolved incident, and the C-class duty quota
   * counts incidents rather than kills — which is why a hundred unwitnessed
   * kills in an alley does not keep a hero on the register.
   */
  private onIncidentReported(report: IIncidentReport): void {
    if (report.outcome !== 'victory') return;
    this.quests.reportProgress('defeat', 'incident', 1);
  }

  private onQuestResolved(quest: RuntimeQuest, outcome: 'completed' | 'failed'): void {
    if (outcome !== 'completed') return;
    this.progression.awardQuest(
      quest.id,
      quest.rewardPoints,
      quest.rewardReputation,
      quest.rules.errand === true
    );
    // A clean completion — nobody lost, nothing wrecked — is heroism, and
    // heroism is the only thing that drains boredom.
    const deed = quest.rules.cleanCompletionDeed;
    if (deed && quest.civiliansLost === 0) this.progression.recordHeroicDeed(deed, quest.id);
    if (quest.rules.boredomOnComplete !== undefined) {
      this.progression.addBoredom(quest.rules.boredomOnComplete, `quest:${quest.id}`);
    }
  }

  private onForceTimeOfDay(timeOfDay: number | undefined): void {
    if (!this.time) return;
    if (timeOfDay === undefined) this.time.releaseTime(6);
    else this.time.forceTimeOfDay(timeOfDay);
  }
}
