/**
 * QUEST STATE MACHINE
 *
 * Every transition, every failure branch, and the two conflicts that make the
 * catalogue mean something: the bargain sale versus the subjugation, and the
 * meteor whose success is a reputational disaster.
 */

import { describe, expect, it } from 'vitest';
import { EventBus } from '@/util';
import type { GameEventOf, QuestState } from '@/types';
import { MONSTER_ARCHETYPES } from '@/entities/monster/archetypes';
import { QuestSystem } from '../quest-system';
import { QUEST_DEFS, type IQuestDef } from '../quest-defs';
import { ProgressionCoordinator } from '../coordinator';
import { INCIDENT_POINTS_BY_TIER, INCIDENT_UNWITNESSED_MULTIPLIER } from '../constants';
import { makeHarness, ORIGIN, at } from './support';

function questSystem(
  defs: readonly IQuestDef[],
  overrides: Partial<{ heroClass: () => 'C' | 'B' | 'A' | 'S'; boredom: () => number }> = {}
) {
  const bus = new EventBus();
  const system = new QuestSystem({
    bus,
    defs,
    heroClass: overrides.heroClass ?? (() => 'C'),
    boredom: overrides.boredom ?? (() => 0),
  });
  return { bus, system };
}

const SIMPLE: IQuestDef = {
  id: 'test.simple',
  title: 'Simple',
  description: '',
  threatTier: 'wolf',
  rewardPoints: 10,
  rewardReputation: 1,
  objectives: [
    { id: 'kill', kind: 'defeat', description: 'Defeat it', required: 2, targetId: 'monster.x' },
  ],
};

describe('catalogue', () => {
  it('has at least eight quests covering every required shape', () => {
    expect(QUEST_DEFS.length).toBeGreaterThanOrEqual(8);

    const kinds = new Set(QUEST_DEFS.flatMap((d) => d.objectives.map((o) => o.kind)));
    for (const required of [
      'defeat',
      'defeatTier',
      'reach',
      'rescue',
      'survive',
      'protect',
      'destroy',
      'talk',
    ]) {
      expect(kinds).toContain(required);
    }

    // Monster subjugation.
    expect(QUEST_DEFS.some((d) => d.id.includes('subjugation'))).toBe(true);
    // Civilian rescue WITH an evacuation timer.
    const rescue = QUEST_DEFS.find((d) => d.objectives.some((o) => o.kind === 'rescue'))!;
    expect(rescue.timeLimitSeconds).toBeGreaterThan(0);
    // Escort / assist a hero NPC.
    expect(QUEST_DEFS.some((d) => d.objectives.some((o) => o.kind === 'protect'))).toBe(true);
    // The shopping errand.
    const errand = QUEST_DEFS.find((d) => d.rules?.errand)!;
    expect(errand.id).toBe('quest.errand.bargain');
    expect(errand.timeLimitSeconds).toBeGreaterThan(0);
    // A boss encounter trigger.
    expect(QUEST_DEFS.some((d) => d.rules?.isBoss && d.rules.encounterId)).toBe(true);
  });

  it('has unique ids, unique objective ids, and no dangling prerequisites', () => {
    const ids = new Set<string>();
    const objectiveIds = new Set<string>();
    for (const def of QUEST_DEFS) {
      expect(ids.has(def.id)).toBe(false);
      ids.add(def.id);
      for (const objective of def.objectives) {
        expect(objectiveIds.has(objective.id)).toBe(false);
        objectiveIds.add(objective.id);
        expect(objective.required).toBeGreaterThan(0);
      }
    }
    for (const def of QUEST_DEFS) {
      for (const prerequisite of def.prerequisites ?? []) expect(ids.has(prerequisite)).toBe(true);
      for (const conflict of def.rules?.conflictsWith ?? []) expect(ids.has(conflict)).toBe(true);
    }
  });

  it('makes the errand and the subjugation mutually exclusive, in both directions', () => {
    const errand = QUEST_DEFS.find((d) => d.id === 'quest.errand.bargain')!;
    const mosquito = QUEST_DEFS.find((d) => d.id === 'quest.subjugation.mosquito')!;
    expect(errand.rules?.conflictsWith).toContain(mosquito.id);
    expect(mosquito.rules?.conflictsWith).toContain(errand.id);
  });

  it('lets the meteor quest succeed with unlimited collateral, on purpose', () => {
    const meteor = QUEST_DEFS.find((d) => d.id === 'quest.boss.asteroid')!;
    expect(meteor.rules?.failOnCollateral).toBeUndefined();
    expect(meteor.rules?.isBoss).toBe(true);
  });

  it('names its kill targets in the namespace EntityKilled.specId actually uses', () => {
    // `specId` is the monster ARCHETYPE id. A target outside that namespace can
    // never match, so the quest is dead content nobody notices.
    const ids = new Set(MONSTER_ARCHETYPES.map((a) => a.id));
    expect(ids.has('boss.mosquitoGirl')).toBe(true);
    expect(ids.has('boss.deepSeaKing')).toBe(true);

    const targets = QUEST_DEFS.flatMap((d) =>
      d.objectives
        .filter((o) => o.kind === 'defeat' || o.kind === 'destroy')
        .map((o) => o.targetId)
        .filter((id): id is string => id !== undefined)
    );
    for (const target of targets) {
      // 'incident' is the synthetic target the coordinator reports per filed
      // report; everything else names a spec id, resolved or still pending.
      if (target === 'incident') continue;
      expect(target).toMatch(/^(mob|boss|hazard)\./);
    }
    // The two whose archetypes exist must resolve today.
    expect(targets.filter((t) => ids.has(t)).sort()).toEqual([
      'boss.deepSeaKing',
      'boss.mosquitoGirl',
    ]);
  });
});

describe('state machine', () => {
  it('walks locked -> available -> active -> completed', () => {
    const { bus, system } = questSystem([SIMPLE]);
    const changes: QuestState[] = [];
    bus.on('QuestStateChanged', (event) => changes.push(event.state));

    expect(system.quests.get('test.simple')!.state).toBe('available');
    expect(system.accept('test.simple')).toBe(true);
    expect(system.quests.get('test.simple')!.state).toBe('active');

    system.reportProgress('defeat', 'monster.x', 1);
    expect(system.quests.get('test.simple')!.state).toBe('active');
    system.reportProgress('defeat', 'monster.x', 1);
    expect(system.quests.get('test.simple')!.state).toBe('completed');
    // 'available' was published during construction, before this subscription.
    expect(changes).toEqual(['active', 'completed']);
    system.dispose();
  });

  it('refuses to accept a quest that is not available', () => {
    const { system } = questSystem([SIMPLE]);
    expect(system.accept('test.simple')).toBe(true);
    expect(system.accept('test.simple')).toBe(false);
    expect(system.accept('nope')).toBe(false);
    system.dispose();
  });

  it('abandons back to available and clears progress', () => {
    const { system } = questSystem([SIMPLE]);
    system.accept('test.simple');
    system.reportProgress('defeat', 'monster.x', 1);
    system.abandon('test.simple');

    const quest = system.quests.get('test.simple')!;
    expect(quest.state).toBe('available');
    expect(quest.objectives[0]!.current).toBe(0);
    system.dispose();
  });

  it('ignores progress for a quest that is not active', () => {
    const { system } = questSystem([SIMPLE]);
    system.reportProgress('defeat', 'monster.x', 5);
    expect(system.quests.get('test.simple')!.objectives[0]!.current).toBe(0);
    system.dispose();
  });

  it('matches targeted objectives strictly and untargeted ones loosely', () => {
    const def: IQuestDef = {
      ...SIMPLE,
      objectives: [
        { id: 'targeted', kind: 'defeat', description: '', required: 3, targetId: 'monster.x' },
        { id: 'any', kind: 'defeat', description: '', required: 3 },
      ],
    };
    const { system } = questSystem([def]);
    system.accept('test.simple');
    system.reportProgress('defeat', 'monster.other', 1);

    const quest = system.quests.get('test.simple')!;
    expect(quest.objectives[0]!.current).toBe(0);
    expect(quest.objectives[1]!.current).toBe(1);
    system.dispose();
  });

  it('gates on prerequisites', () => {
    const defs: IQuestDef[] = [
      SIMPLE,
      { ...SIMPLE, id: 'test.second', prerequisites: ['test.simple'] },
    ];
    const { system } = questSystem(defs);
    expect(system.quests.get('test.second')!.state).toBe('locked');

    system.accept('test.simple');
    system.reportProgress('defeat', 'monster.x', 2);
    system.update(0);
    expect(system.quests.get('test.second')!.state).toBe('available');
    system.dispose();
  });

  it('gates on hero class', () => {
    let heroClass: 'C' | 'B' | 'A' | 'S' = 'C';
    const { system } = questSystem([{ ...SIMPLE, requiredClass: 'A' }], {
      heroClass: () => heroClass,
    });
    expect(system.quests.get('test.simple')!.state).toBe('locked');

    heroClass = 'A';
    system.update(0);
    expect(system.quests.get('test.simple')!.state).toBe('available');
    system.dispose();
  });

  it('never counts a hidden objective towards isComplete but still requires it', () => {
    const def: IQuestDef = {
      ...SIMPLE,
      objectives: [
        { id: 'visible', kind: 'defeat', description: '', required: 1, targetId: 'monster.x' },
        {
          id: 'secret',
          kind: 'defeat',
          description: '',
          required: 1,
          targetId: 'monster.secret',
          hidden: true,
        },
      ],
    };
    const { system } = questSystem([def]);
    system.accept('test.simple');
    system.reportProgress('defeat', 'monster.x', 1);

    const quest = system.runtimeQuests[0]!;
    expect(quest.isComplete).toBe(true);
    expect(quest.allObjectivesComplete).toBe(false);
    expect(quest.state).toBe('active');

    system.reportProgress('defeat', 'monster.secret', 1);
    expect(quest.state).toBe('completed');
    system.dispose();
  });
});

describe('timers', () => {
  it('fails on expiry and reports the reason', () => {
    const reasons: string[] = [];
    const bus = new EventBus();
    const system = new QuestSystem({
      bus,
      defs: [{ ...SIMPLE, timeLimitSeconds: 10 }],
      onResolved: (_quest, outcome, reason) => reasons.push(`${outcome}:${reason}`),
    });

    system.accept('test.simple');
    system.update(5);
    expect(system.quests.get('test.simple')!.state).toBe('active');
    expect(system.timeRemaining('test.simple')).toBeCloseTo(5, 6);

    system.update(6);
    expect(system.quests.get('test.simple')!.state).toBe('failed');
    expect(reasons).toEqual(['failed:timeLimit']);
    system.dispose();
  });

  it('completes on the last tick before expiry', () => {
    const { system } = questSystem([{ ...SIMPLE, timeLimitSeconds: 10 }]);
    system.accept('test.simple');
    system.update(9.9);
    system.reportProgress('defeat', 'monster.x', 2);
    expect(system.quests.get('test.simple')!.state).toBe('completed');
    system.update(5);
    expect(system.quests.get('test.simple')!.state).toBe('completed');
    system.dispose();
  });

  it('completes a quest whose last objective lands on the frame the timer dies', () => {
    // The player did everything required, inside the window. Losing that frame
    // to the expiry fails a finished quest, and `failed` is terminal.
    const def: IQuestDef = {
      ...SIMPLE,
      timeLimitSeconds: 10,
      objectives: [
        { id: 'arrive', kind: 'reach', description: '', required: 1, location: [100, 0, 0] },
      ],
    };
    const { system } = questSystem([def]);
    system.accept('test.simple');
    system.setPlayerPosition(at(500, 0, 0));
    system.update(9.99);
    expect(system.quests.get('test.simple')!.state).toBe('active');

    system.setPlayerPosition(at(100, 0, 0));
    system.update(0.02);
    expect(system.quests.get('test.simple')!.state).toBe('completed');
    system.dispose();
  });

  it('restores a timed quest with the clock it was saved on, not a full one', () => {
    const defs = [{ ...SIMPLE, timeLimitSeconds: 150 }];
    const first = questSystem(defs);
    first.system.accept('test.simple');
    first.system.update(60);
    const progress = first.system.serialiseProgress();
    const states = first.system.serialiseStates();

    const second = questSystem(defs);
    for (const [id, state] of Object.entries(states)) {
      second.system.restoreState(id, state, progress[id]);
    }
    expect(second.system.timeRemaining('test.simple')).toBeCloseTo(90, 6);
    first.system.dispose();
    second.system.dispose();
  });

  it('counts survive objectives in seconds, and only after the ones before them', () => {
    const def: IQuestDef = {
      ...SIMPLE,
      objectives: [
        {
          id: 'arrive',
          kind: 'reach',
          description: '',
          required: 1,
          location: [100, 0, 0],
          radius: 10,
        },
        { id: 'hold', kind: 'survive', description: '', required: 5 },
      ],
    };
    const { system } = questSystem([def]);
    system.accept('test.simple');

    system.setPlayerPosition(at(0, 0, 0));
    system.update(10);
    expect(system.runtimeQuests[0]!.objectives[1]!.current).toBe(0);

    system.setPlayerPosition(at(100, 0, 0));
    system.update(1);
    expect(system.runtimeQuests[0]!.objectives[0]!.complete).toBe(true);
    system.update(6);
    expect(system.quests.get('test.simple')!.state).toBe('completed');
    system.dispose();
  });
});

describe('protect objectives', () => {
  const ESCORT: IQuestDef = {
    ...SIMPLE,
    objectives: [
      { id: 'guard', kind: 'protect', description: '', required: 1, targetId: 'ally.mumen' },
      { id: 'arrive', kind: 'reach', description: '', required: 1, location: [50, 0, 0] },
    ],
  };

  it('holds while the guarded ally is standing, so the escort can complete', () => {
    const { system } = questSystem([ESCORT]);
    system.accept('test.simple');
    system.setPlayerPosition(at(50, 0, 0));
    system.update(0.1);
    expect(system.quests.get('test.simple')!.state).toBe('completed');
    system.dispose();
  });

  it('empties the moment the ally goes down', () => {
    const { bus, system } = questSystem([ESCORT]);
    system.accept('test.simple');
    bus.emit('AllyDowned', {
      entityId: 'ally.mumen',
      displayName: 'Mumen Rider',
      position: ORIGIN,
    });
    system.setPlayerPosition(at(50, 0, 0));
    system.update(0.1);

    const quest = system.runtimeQuests[0]!;
    expect(quest.objectives[0]!.complete).toBe(false);
    expect(quest.objectives[1]!.complete).toBe(true);
    expect(quest.state).toBe('active');
    system.dispose();
  });
});

describe("the player's position", () => {
  const ARRIVE: IQuestDef = {
    ...SIMPLE,
    objectives: [
      {
        id: 'arrive',
        kind: 'reach',
        description: '',
        required: 1,
        location: [0, 0, 0],
        radius: 10,
      },
    ],
  };

  it('treats "never pushed" as unknown rather than as standing at the origin', () => {
    const { system } = questSystem([ARRIVE]);
    system.accept('test.simple');
    system.update(0.1);
    expect(system.runtimeQuests[0]!.objectives[0]!.complete).toBe(false);

    system.setPlayerPosition(ORIGIN);
    system.update(0.1);
    expect(system.runtimeQuests[0]!.objectives[0]!.complete).toBe(true);
    system.dispose();
  });

  it('is forwarded by the coordinator, which is the only production caller', () => {
    const harness = makeHarness();
    harness.coordinator.quests.accept('quest.rescue.tunnel');
    harness.coordinator.update(0.1, { x: -260, y: 0, z: 140 });

    const tunnel = harness.coordinator.quests.runtimeQuests.find(
      (q) => q.id === 'quest.rescue.tunnel'
    )!;
    expect(tunnel.objectives[0]!.complete).toBe(true);
    harness.dispose();
  });
});

describe('failure branches', () => {
  it('fails when too many civilians are lost', () => {
    const bus = new EventBus();
    const system = new QuestSystem({
      bus,
      defs: [{ ...SIMPLE, rules: { failOnCiviliansLost: 2 } }],
    });
    system.accept('test.simple');

    bus.emit('CivilianLost', {
      entityId: 'a',
      position: ORIGIN,
      causedByPlayer: false,
      reputationDelta: -2,
    });
    expect(system.quests.get('test.simple')!.state).toBe('active');
    bus.emit('CivilianLost', {
      entityId: 'b',
      position: ORIGIN,
      causedByPlayer: false,
      reputationDelta: -2,
    });
    expect(system.quests.get('test.simple')!.state).toBe('failed');
    system.dispose();
  });

  it('only counts losses near a located quest, not a wave in another district', () => {
    const bus = new EventBus();
    const system = new QuestSystem({
      bus,
      defs: [{ ...SIMPLE, location: [-260, 0, 140], rules: { failOnCiviliansLost: 1 } }],
    });
    system.accept('test.simple');

    const lose = (position: { x: number; y: number; z: number }): void =>
      bus.emit('CivilianLost', {
        entityId: 'a',
        position,
        causedByPlayer: false,
        reputationDelta: -2,
      });

    lose(at(900, 0, 900));
    expect(system.quests.get('test.simple')!.state).toBe('active');
    lose(at(-260, 0, 140));
    expect(system.quests.get('test.simple')!.state).toBe('failed');
    system.dispose();
  });

  it('fails when the escorted ally goes down', () => {
    const bus = new EventBus();
    const system = new QuestSystem({
      bus,
      defs: [{ ...SIMPLE, rules: { failOnAllyDowned: ['ally.mumen'] } }],
    });
    system.accept('test.simple');

    bus.emit('AllyDowned', { entityId: 'ally.someone', displayName: 'Someone', position: ORIGIN });
    expect(system.quests.get('test.simple')!.state).toBe('active');
    bus.emit('AllyDowned', {
      entityId: 'ally.mumen',
      displayName: 'Mumen Rider',
      position: ORIGIN,
    });
    expect(system.quests.get('test.simple')!.state).toBe('failed');
    system.dispose();
  });

  it('fails when collateral crosses the limit', () => {
    const bus = new EventBus();
    const system = new QuestSystem({
      bus,
      defs: [{ ...SIMPLE, rules: { failOnCollateral: 1000 } }],
    });
    system.accept('test.simple');

    const wreck = (cost: number): void =>
      bus.emit('ChunkDetached', {
        structureId: 's',
        chunkIndex: 0,
        position: ORIGIN,
        mass: 100,
        impulse: ORIGIN,
        material: 'concrete',
        collateralCost: cost,
      });
    wreck(600);
    expect(system.quests.get('test.simple')!.state).toBe('active');
    wreck(600);
    expect(system.quests.get('test.simple')!.state).toBe('failed');
    system.dispose();
  });

  it('fails a conflicting quest when the other one completes', () => {
    const defs: IQuestDef[] = [
      { ...SIMPLE, id: 'test.sale', rules: { conflictsWith: ['test.monster'] } },
      {
        ...SIMPLE,
        id: 'test.monster',
        objectives: [
          { id: 'm', kind: 'defeat', description: '', required: 1, targetId: 'monster.m' },
        ],
        rules: { conflictsWith: ['test.sale'] },
      },
    ];
    const { system } = questSystem(defs);
    system.accept('test.sale');
    system.accept('test.monster');

    system.reportProgress('defeat', 'monster.m', 1);
    expect(system.quests.get('test.monster')!.state).toBe('completed');
    expect(system.quests.get('test.sale')!.state).toBe('failed');
    system.dispose();
  });

  it('cannot fail a quest twice or resurrect a completed one', () => {
    const resolutions: string[] = [];
    const bus = new EventBus();
    const system = new QuestSystem({
      bus,
      defs: [{ ...SIMPLE, timeLimitSeconds: 1, rules: { failOnCiviliansLost: 1 } }],
      onResolved: (_q, outcome) => resolutions.push(outcome),
    });
    system.accept('test.simple');
    bus.emit('CivilianLost', {
      entityId: 'a',
      position: ORIGIN,
      causedByPlayer: false,
      reputationDelta: -2,
    });
    system.update(5);
    bus.emit('CivilianLost', {
      entityId: 'b',
      position: ORIGIN,
      causedByPlayer: false,
      reputationDelta: -2,
    });
    expect(resolutions).toEqual(['failed']);
    system.dispose();
  });
});

describe('encounter triggers', () => {
  it('fires EncounterStarted once, when the player reaches the location', () => {
    const bus = new EventBus();
    const events: GameEventOf<'EncounterStarted'>[] = [];
    bus.on('EncounterStarted', (event) => events.push(event));

    const system = new QuestSystem({
      bus,
      defs: [
        {
          ...SIMPLE,
          location: [50, 0, 0],
          objectives: [
            {
              id: 'arrive',
              kind: 'reach',
              description: '',
              required: 1,
              location: [50, 0, 0],
              radius: 12,
            },
            { id: 'kill', kind: 'defeat', description: '', required: 1, targetId: 'monster.x' },
          ],
          rules: { encounterId: 'encounter.test', isBoss: true, rivals: ['genos'] },
        },
      ],
    });
    system.accept('test.simple');

    system.setPlayerPosition(at(200, 0, 0));
    system.update(0.1);
    expect(events).toHaveLength(0);

    system.setPlayerPosition(at(50, 0, 0));
    system.update(0.1);
    system.update(0.1);
    expect(events).toHaveLength(1);
    expect(events[0]!.isBoss).toBe(true);
    expect(events[0]!.encounterId).toBe('encounter.test');
    expect(events[0]!.participantIds).toEqual(['ally.genos']);
    system.dispose();
  });

  it('does not announce an ordinary subjugation as a boss fight', () => {
    const bus = new EventBus();
    const events: GameEventOf<'EncounterStarted'>[] = [];
    bus.on('EncounterStarted', (event) => events.push(event));
    const system = new QuestSystem({
      bus,
      defs: [{ ...SIMPLE, rules: { encounterId: 'encounter.routine' } }],
    });

    system.accept('test.simple');
    system.reportProgress('defeat', 'monster.x', 1);
    expect(events).toHaveLength(1);
    // The radius on the same line already said "not a boss".
    expect(events[0]!.isBoss).toBe(false);
    expect(events[0]!.radius).toBe(45);
    system.dispose();
  });

  it('re-arms the encounter for a quest abandoned and accepted again', () => {
    const bus = new EventBus();
    const events: GameEventOf<'EncounterStarted'>[] = [];
    bus.on('EncounterStarted', (event) => events.push(event));
    const system = new QuestSystem({
      bus,
      defs: [{ ...SIMPLE, rules: { encounterId: 'encounter.routine' } }],
    });

    system.accept('test.simple');
    system.reportProgress('defeat', 'monster.x', 1);
    system.abandon('test.simple');
    expect(events).toHaveLength(1);

    // Walking back into the same fight has to open it again, or the player
    // fights a monster nobody is scoring.
    system.accept('test.simple');
    system.reportProgress('defeat', 'monster.x', 1);
    expect(events).toHaveLength(2);
    system.dispose();
  });

  it('re-arms the encounter for a quest restored mid-fight', () => {
    const bus = new EventBus();
    const events: GameEventOf<'EncounterStarted'>[] = [];
    bus.on('EncounterStarted', (event) => events.push(event));
    const system = new QuestSystem({
      bus,
      defs: [
        {
          ...SIMPLE,
          objectives: [
            { id: 'arrive', kind: 'reach', description: '', required: 1, location: [50, 0, 0] },
          ],
          rules: { encounterId: 'encounter.routine' },
        },
      ],
    });

    // The reach objective is already complete in the save, so nothing would
    // ever call the arming path again.
    system.restoreState('test.simple', 'active', { arrive: 1 });
    expect(events).toHaveLength(1);
    system.dispose();
  });
});

describe('the dispatched flag', () => {
  it('is dropped when the request is abandoned, so the fight scores unwitnessed', () => {
    const harness = makeHarness();
    harness.coordinator.quests.accept('quest.subjugation.crablante');
    harness.coordinator.quests.abandon('quest.subjugation.crablante');

    harness.startEncounter('encounter.crablante', {
      threatTier: 'tiger',
      position: at(120, 0, -80),
    });
    harness.endEncounter('encounter.crablante');
    harness.tick(0.2);

    const report = harness.coordinator.progression.incidentReports[0]!;
    expect(report.basePoints).toBeCloseTo(
      INCIDENT_POINTS_BY_TIER.tiger * INCIDENT_UNWITNESSED_MULTIPLIER,
      6
    );
    harness.dispose();
  });
});

describe('the pinned clock', () => {
  it('keeps one owner: resolving one quest does not release another quest pin', () => {
    const forced: (number | undefined)[] = [];
    const time = {
      forceTimeOfDay: (t: number) => forced.push(t),
      releaseTime: () => forced.push(undefined),
    };
    const dusk: IQuestDef = { ...SIMPLE, id: 'test.dusk', rules: { forceTimeOfDay: 0.79 } };
    const noon: IQuestDef = {
      ...SIMPLE,
      id: 'test.noon',
      objectives: [
        { id: 'kill.noon', kind: 'defeat', description: '', required: 1, targetId: 'monster.n' },
      ],
      rules: { forceTimeOfDay: 0.62 },
    };
    const coordinator = new ProgressionCoordinator({
      bus: new EventBus(),
      defs: [dusk, noon],
      time,
    });

    coordinator.quests.accept('test.dusk');
    coordinator.quests.accept('test.noon');
    expect(forced).toEqual([0.79, 0.62]);

    // The second quest lets go; the first is still running its scripted beat.
    coordinator.quests.reportProgress('defeat', 'monster.n', 1);
    expect(coordinator.quests.quests.get('test.noon')!.state).toBe('completed');
    expect(forced).toEqual([0.79, 0.62, 0.79]);
    expect(forced).not.toContain(undefined);
    coordinator.dispose();
  });
});

describe('integration with progression', () => {
  it('pays out the quest reward on completion', () => {
    const harness = makeHarness({ defs: [SIMPLE] });
    const before = harness.coordinator.progression.points;
    harness.coordinator.quests.accept('test.simple');
    harness.coordinator.quests.reportProgress('defeat', 'monster.x', 2);
    harness.tick(0.1);
    expect(harness.coordinator.progression.points).toBeGreaterThan(before);
    expect(harness.coordinator.progression.state.completedQuests).toContain('test.simple');
    harness.dispose();
  });

  it('counts RESOLVED INCIDENTS towards the duty quota, not kills', () => {
    const harness = makeHarness();
    expect(harness.coordinator.quests.accept('quest.duty.quota')).toBe(true);
    const quota = harness.coordinator.quests.runtimeQuests.find(
      (q) => q.id === 'quest.duty.quota'
    )!;

    // A hundred kills in an alley: no incidents filed, no quota progress.
    for (let i = 0; i < 100; i++) harness.killMonster({ position: at(i * 10, 0, 0) });
    harness.tick(0.2);
    expect(quota.objectives[0]!.current).toBe(0);

    // Three resolved encounters: three incidents.
    for (let i = 0; i < 3; i++) {
      harness.startEncounter(`e${i}`, { position: at(i * 500, 0, 0) });
      harness.killMonster({ position: at(i * 500, 0, 0) });
      harness.endEncounter(`e${i}`);
    }
    harness.tick(0.2);
    expect(quota.objectives[0]!.current).toBe(3);
    expect(quota.state).toBe('completed');
    harness.dispose();
  });

  it('marks an accepted request as dispatched, so it scores unwitnessed', () => {
    const walkIn = makeHarness();
    const dispatched = makeHarness();
    dispatched.coordinator.quests.accept('quest.subjugation.crablante');

    for (const harness of [walkIn, dispatched]) {
      harness.startEncounter('encounter.crablante', {
        threatTier: 'tiger',
        position: at(120, 0, -80),
      });
      harness.killMonster({
        threatTier: 'tiger',
        specId: 'monster.crablante',
        position: at(120, 0, -80),
      });
      harness.endEncounter('encounter.crablante');
      harness.tick(0.2);
    }

    const walkInReport = walkIn.coordinator.progression.incidentReports[0]!;
    const dispatchedReport = dispatched.coordinator.progression.incidentReports[0]!;
    expect(dispatchedReport.basePoints).toBeGreaterThan(walkInReport.basePoints * 5);
    walkIn.dispose();
    dispatched.dispose();
  });
});
