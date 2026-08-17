/**
 * THE QUEST CATALOGUE
 *
 * Ten Hero Association requests and errands. Data only — the state machine
 * lives in `quest-system.ts`, so the catalogue can be reviewed, reordered and
 * balanced without touching any logic.
 *
 * ── WHY THE SHOPPING QUEST IS NOT A JOKE ENTRY ─────────────────────────────
 * `quest.errand.bargain` is the design centrepiece and it is deliberately
 * built to CONFLICT with a monster subjugation running in the same window.
 * The sale is the one thing in the character's day with an outcome he cannot
 * guarantee: the monster was never going to be interesting, and the discount
 * ends at six whether he is there or not. Missing it costs more boredom than
 * failing a subjugation does, which is the correct relative weight and is the
 * clearest statement this system can make about who he is.
 *
 * `quest.boss.asteroid` is its counterpart. The player saves the entire city
 * from a meteor, and because the fragments wreck half of it, the reported
 * collateral drives their reputation DOWN. They are booed for it. This is the
 * single most faithful beat in the source material and the ranking system is
 * built the way it is specifically so it can happen mechanically rather than
 * in a cutscene.
 *
 * ── OBJECTIVE KINDS ────────────────────────────────────────────────────────
 * Only the kinds in `QuestObjectiveKind` are used: 'defeat', 'defeatTier',
 * 'reach', 'rescue', 'survive', 'protect', 'destroy', 'talk'. Anything a quest
 * wants to track has to be expressible as one of those and as an event on the
 * bus, or it does not go in.
 */

import * as THREE from 'three';
import type { HeroClass, IQuest, IQuestObjective, QuestObjectiveKind, ThreatTier } from '@/types';
import type { HeroicDeed, RivalId } from './constants';

/** Authoring shape for one objective. `current` and `complete` are derived. */
export interface IQuestObjectiveDef {
  readonly id: string;
  readonly kind: QuestObjectiveKind;
  readonly description: string;
  readonly required: number;
  readonly targetId?: string;
  readonly location?: readonly [number, number, number];
  readonly radius?: number;
  readonly hidden?: boolean;
}

/** Extra rules the shared `IQuest` contract has no field for. */
export interface IQuestRules {
  /**
   * Fail the quest if this many civilians are lost. Undefined means civilian
   * losses are only a reputation matter.
   */
  readonly failOnCiviliansLost?: number;
  /** Fail the quest if a named ally goes down. */
  readonly failOnAllyDowned?: readonly string[];
  /** Fail if reported collateral exceeds this. The asteroid quest ignores it. */
  readonly failOnCollateral?: number;
  /** Encounter id this quest arms; reaching its location starts it. */
  readonly encounterId?: string;
  /** True when the encounter is a boss fight. */
  readonly isBoss?: boolean;
  /** Rivals who show up and bank credit at the same incident. */
  readonly rivals?: readonly RivalId[];
  /** Heroic deed automatically credited on a clean completion. */
  readonly cleanCompletionDeed?: HeroicDeed;
  /**
   * A "genuinely fun fight". Locked out entirely above the boredom threshold —
   * nothing feels fun when you are numb.
   */
  readonly funFight?: boolean;
  /** Normalised time of day this quest pins the clock to while active. */
  readonly forceTimeOfDay?: number;
  /** Quests that FAIL when this one is completed. Mutually exclusive windows. */
  readonly conflictsWith?: readonly string[];
  /** Boredom applied on failure, overriding the default. */
  readonly boredomOnFailure?: number;
  /** Boredom applied on completion. Negative is relief. */
  readonly boredomOnComplete?: number;
  /** Marks an errand — ordinary life, not hero work. */
  readonly errand?: boolean;
}

/** A quest as authored, before the runtime wraps it in mutable state. */
export interface IQuestDef {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly threatTier: ThreatTier;
  readonly requiredClass?: HeroClass;
  readonly prerequisites?: readonly string[];
  readonly rewardPoints: number;
  readonly rewardReputation: number;
  readonly timeLimitSeconds?: number;
  readonly location?: readonly [number, number, number];
  readonly objectives: readonly IQuestObjectiveDef[];
  readonly rules?: IQuestRules;
}

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

export const QUEST_DEFS: readonly IQuestDef[] = [
  /* ---------------------------------------------------------------- duty -- */
  {
    id: 'quest.duty.quota',
    title: 'C-Class Duty Quota',
    description:
      'C-class heroes are removed from the register after one week without a ' +
      'reported result. Resolve three incidents. It does not matter how well.',
    threatTier: 'wolf',
    rewardPoints: 45,
    rewardReputation: 3,
    // One in-game week at the 24-minute day, in real seconds.
    timeLimitSeconds: 24 * 60 * 7,
    objectives: [
      {
        id: 'quota.incidents',
        kind: 'defeat',
        description: 'Resolve reported incidents',
        required: 3,
        // Advanced by RESOLVED INCIDENTS, not by kills. `progression-system`
        // reports this synthetic target exactly once per filed report, which
        // is why grinding monsters in an empty alley does not satisfy the
        // Association's quota either.
        targetId: 'incident',
      },
    ],
    rules: { boredomOnFailure: 0.06 },
  },

  /* --------------------------------------------------------- subjugation -- */
  {
    id: 'quest.subjugation.crablante',
    title: 'Subjugation Request: Crablante',
    description:
      'A mutated crab is working through the market district asking passers-by ' +
      'whether they have seen a man with a bald head. Threat level: Tiger.',
    threatTier: 'tiger',
    rewardPoints: 60,
    rewardReputation: 6,
    location: [120, 0, -80],
    objectives: [
      {
        id: 'crablante.defeat',
        kind: 'defeat',
        description: 'Defeat Crablante',
        required: 1,
        targetId: 'monster.crablante',
        location: [120, 0, -80],
        radius: 25,
      },
    ],
    rules: {
      encounterId: 'encounter.crablante',
      failOnCiviliansLost: 3,
    },
  },

  /* -------------------------------------------------------------- rescue -- */
  {
    id: 'quest.rescue.tunnel',
    title: 'Civilian Rescue: Route 7 Tunnel Collapse',
    description:
      'The Route 7 tunnel has come down on a commuter queue. Nine people are ' +
      'inside. The far section will not hold for long.',
    threatTier: 'wolf',
    rewardPoints: 90,
    rewardReputation: 14,
    // The evacuation timer. Short on purpose: this is the quest that teaches
    // the player that arriving in time is worth more than winning.
    timeLimitSeconds: 150,
    location: [-260, 0, 140],
    objectives: [
      {
        id: 'tunnel.reach',
        kind: 'reach',
        description: 'Reach the tunnel mouth',
        required: 1,
        location: [-260, 0, 140],
        radius: 20,
      },
      {
        id: 'tunnel.rescue',
        kind: 'rescue',
        description: 'Carry the trapped commuters out',
        required: 9,
      },
    ],
    rules: {
      failOnCiviliansLost: 3,
      cleanCompletionDeed: 'arrivedInTime',
      boredomOnFailure: 0.08,
    },
  },

  /* -------------------------------------------------------------- errand -- */
  {
    id: 'quest.errand.bargain',
    title: 'Bargain Sale — Shopping District J',
    description:
      'Thursday. Ground beef is thirty percent off until six, and the good ' +
      'cabbages go first. This is not Hero Association business.',
    threatTier: 'wolf',
    rewardPoints: 0,
    rewardReputation: 0,
    // Real seconds. The sale window is ~11 in-game hours at the 24-minute day,
    // and it does not care what else is happening.
    timeLimitSeconds: 660,
    location: [40, 0, 210],
    objectives: [
      {
        id: 'bargain.reach',
        kind: 'reach',
        description: 'Get to the supermarket in Shopping District J',
        required: 1,
        location: [40, 0, 210],
        radius: 14,
      },
      {
        id: 'bargain.buy',
        kind: 'talk',
        description: 'Buy: ground beef, cabbage, eggs, a punnet of strawberries',
        required: 4,
        targetId: 'npc.shopkeeper',
      },
    ],
    rules: {
      errand: true,
      // The whole point: a subjugation running in the same window ends the
      // sale. He can do one of them.
      conflictsWith: ['quest.subjugation.mosquito'],
      boredomOnComplete: -0.08,
      boredomOnFailure: 0.12,
    },
  },

  /* -------------------------------------------------------------- escort -- */
  {
    id: 'quest.escort.mumen',
    title: 'Assist Request: Mumen Rider',
    description:
      'C-class rank 1 has gone in on a bicycle, again. He will not withdraw. ' +
      'Keep him alive and get him to the evacuation point.',
    threatTier: 'tiger',
    requiredClass: 'C',
    rewardPoints: 110,
    rewardReputation: 18,
    timeLimitSeconds: 300,
    location: [-90, 0, -180],
    objectives: [
      {
        id: 'mumen.protect',
        kind: 'protect',
        description: 'Keep Mumen Rider standing',
        required: 1,
        targetId: 'ally.mumen',
      },
      {
        id: 'mumen.escort',
        kind: 'reach',
        description: 'Escort him to the evacuation point',
        required: 1,
        location: [-40, 0, -120],
        radius: 18,
      },
    ],
    rules: {
      failOnAllyDowned: ['ally.mumen'],
      rivals: ['mumen'],
      cleanCompletionDeed: 'alliesStanding',
    },
  },

  /* --------------------------------------------------- subjugation, demon -- */
  {
    id: 'quest.subjugation.mosquito',
    title: 'Subjugation Request: Mosquito Girl',
    description:
      'Every animal in C-City has been drained. The swarm is being directed. ' +
      'Threat level: Demon.',
    threatTier: 'demon',
    prerequisites: ['quest.subjugation.crablante'],
    rewardPoints: 240,
    rewardReputation: 22,
    location: [310, 0, 60],
    objectives: [
      {
        id: 'mosquito.swarm',
        kind: 'defeatTier',
        description: 'Thin the swarm',
        required: 40,
        targetId: 'wolf',
      },
      {
        id: 'mosquito.boss',
        kind: 'defeat',
        description: 'Defeat Mosquito Girl',
        required: 1,
        targetId: 'monster.mosquitoGirl',
      },
    ],
    rules: {
      encounterId: 'encounter.mosquito',
      rivals: ['genos'],
      conflictsWith: ['quest.errand.bargain'],
    },
  },

  /* ---------------------------------------------------------- joint op --- */
  {
    id: 'quest.assist.genos',
    title: 'Joint Operation: Demon Cyborg',
    description:
      'S-class rank 17 has requested you specifically. The Association has ' +
      'logged him as lead on the operation.',
    threatTier: 'demon',
    prerequisites: ['quest.subjugation.mosquito'],
    rewardPoints: 200,
    rewardReputation: 10,
    location: [-320, 0, -260],
    objectives: [
      {
        id: 'genos.rendezvous',
        kind: 'talk',
        description: 'Meet Genos at the staging point',
        required: 1,
        targetId: 'ally.genos',
        location: [-320, 0, -260],
        radius: 15,
      },
      {
        id: 'genos.clear',
        kind: 'defeatTier',
        description: 'Clear the site',
        required: 6,
        targetId: 'tiger',
      },
    ],
    rules: {
      encounterId: 'encounter.jointOp',
      // He is at the same fight, credited at 2.4x, and the report names him.
      rivals: ['genos'],
      funFight: true,
    },
  },

  /* ---------------------------------------------------------------- boss -- */
  {
    id: 'quest.boss.deepsea',
    title: 'Emergency: The Deep Sea King',
    description:
      'The shelter at J-City is surrounded. A-class and below are already down. ' +
      'Mumen Rider went in ten minutes ago.',
    threatTier: 'dragon',
    requiredClass: 'B',
    prerequisites: ['quest.escort.mumen'],
    rewardPoints: 900,
    rewardReputation: 26,
    location: [0, 0, 420],
    objectives: [
      {
        id: 'deepsea.reach',
        kind: 'reach',
        description: 'Reach the shelter',
        required: 1,
        location: [0, 0, 420],
        radius: 30,
      },
      {
        id: 'deepsea.survive',
        kind: 'survive',
        description: 'Hold the entrance until the civilians are clear',
        required: 45,
      },
      {
        id: 'deepsea.defeat',
        kind: 'defeat',
        description: 'Defeat the Deep Sea King',
        required: 1,
        targetId: 'monster.deepSeaKing',
      },
    ],
    rules: {
      encounterId: 'encounter.deepSeaKing',
      isBoss: true,
      rivals: ['mumen', 'genos'],
      // The beat this quest exists for: standing in front of someone who
      // cannot survive the hit.
      cleanCompletionDeed: 'bodyBlock',
      funFight: true,
      forceTimeOfDay: 0.79, // it arrives in the rain, at sunset
    },
  },

  /* ------------------------------------------------ boss, and the irony --- */
  {
    id: 'quest.boss.asteroid',
    title: 'Absolute Emergency: Meteor over Z-City',
    description:
      'A class-god object will strike Z-City in four minutes. Evacuation is ' +
      'not possible. There is no plan.',
    threatTier: 'god',
    requiredClass: 'B',
    rewardPoints: 2200,
    rewardReputation: 40,
    timeLimitSeconds: 240,
    location: [0, 0, 0],
    objectives: [
      {
        id: 'asteroid.reach',
        kind: 'reach',
        description: 'Get above the city',
        required: 1,
        location: [0, 180, 0],
        radius: 60,
      },
      {
        id: 'asteroid.destroy',
        kind: 'destroy',
        description: 'Destroy the meteor',
        required: 1,
        targetId: 'hazard.meteor',
      },
    ],
    rules: {
      encounterId: 'encounter.meteor',
      isBoss: true,
      // NO collateral fail condition, on purpose. The fragments level half the
      // city and the player is blamed for it in the report — that outcome is
      // the content, not a failure state.
      funFight: true,
      forceTimeOfDay: 0.62,
    },
  },

  /* -------------------------------------------------- subjugation, dragon -- */
  {
    id: 'quest.subjugation.subterranean',
    title: 'Subjugation Request: Subterranean King',
    description:
      'The tunnels under Z-City have opened. Whatever is coming up has already ' +
      'taken two A-class teams. Threat level: Dragon.',
    threatTier: 'dragon',
    requiredClass: 'A',
    prerequisites: ['quest.boss.deepsea'],
    rewardPoints: 1400,
    rewardReputation: 30,
    location: [180, -40, 320],
    objectives: [
      {
        id: 'subterranean.descend',
        kind: 'reach',
        description: 'Descend into the fissure',
        required: 1,
        location: [180, -40, 320],
        radius: 25,
      },
      {
        id: 'subterranean.horde',
        kind: 'defeatTier',
        description: 'Clear the horde',
        required: 25,
        targetId: 'demon',
      },
      {
        id: 'subterranean.king',
        kind: 'defeat',
        description: 'Defeat the Subterranean King',
        required: 1,
        targetId: 'monster.subterraneanKing',
        hidden: true,
      },
    ],
    rules: {
      encounterId: 'encounter.subterranean',
      isBoss: true,
      funFight: true,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Runtime shapes                                                             */
/* -------------------------------------------------------------------------- */

/** A live objective: the authored data plus mutable progress. */
export class RuntimeObjective implements IQuestObjective {
  readonly id: string;
  readonly kind: QuestObjectiveKind;
  readonly description: string;
  readonly required: number;
  readonly targetId: string | undefined;
  readonly location: THREE.Vector3 | undefined;
  readonly radius: number | undefined;
  readonly hidden: boolean;
  current = 0;

  constructor(def: IQuestObjectiveDef) {
    this.id = def.id;
    this.kind = def.kind;
    this.description = def.description;
    this.required = def.required;
    this.targetId = def.targetId;
    this.location = def.location ? new THREE.Vector3(...def.location) : undefined;
    this.radius = def.radius;
    this.hidden = def.hidden ?? false;
  }

  get complete(): boolean {
    return this.current >= this.required;
  }
}

/** A live quest. `state` is the only mutable field on the contract. */
export class RuntimeQuest implements IQuest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly objectives: readonly RuntimeObjective[];
  readonly threatTier: ThreatTier;
  readonly requiredClass: HeroClass | undefined;
  readonly prerequisites: readonly string[] | undefined;
  readonly rewardPoints: number;
  readonly rewardReputation: number;
  readonly timeLimitSeconds: number | undefined;
  readonly location: THREE.Vector3 | undefined;
  readonly rules: IQuestRules;

  state: IQuest['state'] = 'locked';
  /** Seconds remaining while active; undefined when the quest is untimed. */
  timeRemaining: number | undefined;
  /** Civilians lost and collateral accrued while this quest was active. */
  civiliansLost = 0;
  collateral = 0;

  constructor(def: IQuestDef) {
    this.id = def.id;
    this.title = def.title;
    this.description = def.description;
    this.objectives = def.objectives.map((o) => new RuntimeObjective(o));
    this.threatTier = def.threatTier;
    this.requiredClass = def.requiredClass;
    this.prerequisites = def.prerequisites;
    this.rewardPoints = def.rewardPoints;
    this.rewardReputation = def.rewardReputation;
    this.timeLimitSeconds = def.timeLimitSeconds;
    this.location = def.location ? new THREE.Vector3(...def.location) : undefined;
    this.rules = def.rules ?? {};
  }

  /** True when every NON-HIDDEN objective is complete. */
  get isComplete(): boolean {
    return this.objectives.every((o) => o.hidden || o.complete);
  }

  /** Including hidden ones. What actually gates the reward. */
  get allObjectivesComplete(): boolean {
    return this.objectives.every((o) => o.complete);
  }

  reset(): void {
    this.state = 'locked';
    this.timeRemaining = undefined;
    this.civiliansLost = 0;
    this.collateral = 0;
    for (const objective of this.objectives) objective.current = 0;
  }
}
