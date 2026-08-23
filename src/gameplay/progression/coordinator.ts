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

import type { IDayNightSystem, IEventBus, QuestState, Vec3 } from '@/types';
import { createLogger } from '@/util';
import { BoredomModel } from './boredom';
import { ProgressionSystem, type IIncidentReport } from './progression-system';
import { QuestSystem } from './quest-system';
import { RivalTracker } from './rivals';
import { WitnessField } from './witness';
import { QUEST_DEFS, type IQuestDef, type RuntimeQuest } from './quest-defs';
import {
  BOREDOM_FUN_FIGHT_LOCK,
  BOREDOM_ON_MISSED_SALE,
  BOREDOM_ON_QUEST_FAILED,
  type HeroicDeed,
} from './constants';
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
  /** Quest currently holding the clock, so only its owner can release it. */
  private pinnedBy: string | undefined;

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
      onForceTimeOfDay: (t, questId) => this.onForceTimeOfDay(t, questId),
      onResolved: (quest, outcome) => this.onQuestResolved(quest, outcome),
    });

    for (const quest of this.quests.runtimeQuests) this.questById.set(quest.id, quest);

    // Accepting a request is what makes an incident officially dispatched, and
    // a dispatched incident scores even with nobody watching. Letting the
    // request go takes that away again: walking into the same fight unbidden
    // is worth 0.06x, not 0.75x, and that distinction is the whole system.
    this.unsubscribers.push(
      this.bus.on('QuestStateChanged', (event) => {
        const encounterId = this.questById.get(event.questId)?.rules.encounterId;
        if (!encounterId) return;
        if (event.state === 'active') this.progression.markDispatched(encounterId);
        else this.progression.clearDispatched(encounterId);
      })
    );
  }

  /**
   * @param playerPosition Where the player is, this frame. 'reach' objectives
   *        have no other source: without it every one of them is evaluated at
   *        the world origin and none of the six quests that lead with one can
   *        ever be completed.
   */
  update(dt: number, playerPosition?: Vec3): void {
    if (playerPosition) this.quests.setPlayerPosition(playerPosition);
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

  buildSaveGame(
    playerPosition = { x: 0, y: 0, z: 0 },
    playerYaw = 0,
    savedAt?: string
  ): IStoredSave {
    // Optional fields are OMITTED rather than written as `undefined`: the save
    // validator rejects `undefined` outright, because a key that JSON silently
    // drops is indistinguishable from one the game forgot to write.
    const lunarAgeDays = this.time?.lunarAgeDays;
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
        ...(lunarAgeDays === undefined ? {} : { lunarAgeDays }),
      },
      savedAt,
    });
  }

  applySaveGame(save: IStoredSave): void {
    // Every field is read defensively. `migrate()` shape-checks the payload,
    // but this method is public API and a half-applied restore — rank and
    // rivals from the save, quests untouched — is worse than no restore at all.
    this.progression.restore(save.progression);
    this.rivals.restore(save.extras?.rivals);
    this.boredom.restoreHistory((save.extras?.heroicDeeds ?? []) as readonly HeroicDeed[]);
    for (const [questId, state] of Object.entries(save.questStates ?? {})) {
      this.quests.restoreState(questId, state as QuestState, save.questProgress?.[questId]);
    }
    // A quest restored as active is still an accepted request. `restoreState`
    // does not publish a state change, so the subscription above never sees it.
    for (const quest of this.quests.runtimeQuests) {
      const encounterId = quest.rules.encounterId;
      if (encounterId && quest.state === 'active') this.progression.markDispatched(encounterId);
    }
    // The calendar comes back too: the rival ledger keys off the day count, and
    // starting it at 0 against a save taken on day 10 pays every rival ten days
    // of off-screen work they already banked.
    if (typeof save.dayCount === 'number' && Number.isFinite(save.dayCount)) {
      this.progression.syncDayCount(save.dayCount);
      this.time?.setDayCount?.(save.dayCount);
    }
    if (this.time && typeof save.timeOfDay === 'number') {
      this.time.setTimeOfDay?.(save.timeOfDay);
    }
    const lunarAgeDays = save.extras?.lunarAgeDays;
    if (this.time && typeof lunarAgeDays === 'number' && Number.isFinite(lunarAgeDays)) {
      this.time.setLunarAgeDays?.(lunarAgeDays);
    }
    log.info(`loaded save from ${save.savedAt}`);
  }

  async save(
    playerPosition?: { x: number; y: number; z: number },
    playerYaw?: number
  ): Promise<IStoredSave> {
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
    if (outcome === 'failed') {
      // The AUTHORED cost, handed to the progression system before it sees the
      // state change. Its own fallback picks the tier off a substring of the
      // quest id, which is right only by coincidence.
      this.progression.setQuestFailureBoredom(
        quest.id,
        quest.rules.boredomOnFailure ??
          (quest.rules.errand === true ? BOREDOM_ON_MISSED_SALE : BOREDOM_ON_QUEST_FAILED)
      );
      return;
    }

    // ONE boredom channel per completion. `errand: true` and an authored
    // `boredomOnComplete` both mean "this is what finishing it feels like", and
    // applying both paid the bargain sale its relief twice.
    const authoredBoredom = quest.rules.boredomOnComplete;
    this.progression.awardQuest(
      quest.id,
      quest.rewardPoints,
      quest.rewardReputation,
      quest.rules.errand === true && authoredBoredom === undefined
    );
    // A clean completion — nobody lost, nothing wrecked — is heroism, and
    // heroism is the only thing that drains boredom.
    const deed = quest.rules.cleanCompletionDeed;
    if (deed && quest.civiliansLost === 0) this.progression.recordHeroicDeed(deed, quest.id);
    if (authoredBoredom !== undefined) {
      this.progression.addBoredom(authoredBoredom, `quest:${quest.id}`);
    }
  }

  /**
   * Pin or release the clock, with ONE owner at a time.
   *
   * Two quests declare `forceTimeOfDay`, both acceptable at once. Without an
   * owner check, resolving either hands the clock back while the other is still
   * running its scripted lighting beat.
   */
  private onForceTimeOfDay(timeOfDay: number | undefined, questId: string): void {
    if (!this.time) return;
    if (timeOfDay !== undefined) {
      this.pinnedBy = questId;
      this.time.forceTimeOfDay(timeOfDay);
      return;
    }
    if (this.pinnedBy !== questId) return;

    // Hand it to the next active quest that still wants it. The releasing quest
    // is still `active` here — `onResolved` runs before the state change — so
    // it has to be excluded by id.
    const next = this.quests.runtimeQuests.find(
      (q) => q.id !== questId && q.state === 'active' && q.rules.forceTimeOfDay !== undefined
    );
    if (next?.rules.forceTimeOfDay !== undefined) {
      this.pinnedBy = next.id;
      this.time.forceTimeOfDay(next.rules.forceTimeOfDay);
      return;
    }
    this.pinnedBy = undefined;
    this.time.releaseTime(6);
  }
}
