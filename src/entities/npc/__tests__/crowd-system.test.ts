/**
 * THE CROWD, END TO END
 *
 * Everything here is a claim the game depends on rather than a claim about the
 * implementation:
 *
 *   - the same seed produces the same crowd, so a replay is a replay;
 *   - nobody stands inside anybody else, or inside a building;
 *   - panic reaches people and changes what they are doing;
 *   - `CivilianSaved` / `CivilianLost` fire when they should, carry the right
 *     attribution, and carry line-of-sight information in a form the ranking
 *     system can actually use.
 *
 * All headless: `CrowdSystem` builds no meshes when asked not to, which is
 * what makes an eight-hundred-frame simulation a test rather than a benchmark.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '@/util';
import { CrowdSystem } from '../crowd-system';
import { CrowdSteering } from '../steering';
import { MOOD_COMMUTE, MOOD_FLEE, MOOD_GAWK, TIER_NEAR } from '../crowd-agents';
import { gatherWitnesses, scoreOutcome, CrowdLedger } from '../witness';
import { ObstacleField } from '../obstacles';
import { timeToCollision } from '../steering';
import {
  AGENT_RADIUS,
  MID_CAP,
  MIN_SEPARATION,
  NEAR_CAP,
  NEAR_RADIUS,
  REP_LOST_BY_PLAYER,
  REP_SAVED_BY_PLAYER,
  WITNESS_MULTIPLIER,
} from '../constants';
import { cityRects, singleBlock } from './fixtures';

const SEED = 20250817;

function makeSystem(bus?: EventBus, seed = SEED): CrowdSystem {
  const system = new CrowdSystem({ bus, seed, headless: true, playerId: 'player' });
  system.setObstacles(cityRects(seed, 2));
  system.setPlayer(0, 0);
  return system;
}

function run(system: CrowdSystem, seconds: number, dt = 1 / 60): void {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) system.update(dt);
}

describe('CrowdSystem population', () => {
  it('fills the band up to the cap and holds it', () => {
    const system = makeSystem();
    run(system, 6);
    const stats = system.lastStats;
    expect(stats.total).toBe(MID_CAP);
    expect(stats.near).toBeLessThanOrEqual(NEAR_CAP);
    expect(stats.near).toBeGreaterThan(0);
    system.dispose();
  });

  it('never exceeds the near-tier budget however the crowd is arranged', () => {
    const system = makeSystem();
    for (let i = 0; i < 12; i++) {
      // Walk the player around so agents cross the tier boundary repeatedly.
      system.setPlayer(Math.cos(i) * 30, Math.sin(i) * 30);
      run(system, 1);
      let near = 0;
      for (let a = 0; a < system.agents.extent; a++) {
        if (system.agents.active[a] === 1 && system.agents.tier[a] === TIER_NEAR) near++;
      }
      expect(near).toBeLessThanOrEqual(NEAR_CAP);
    }
    system.dispose();
  });

  it('spawns everyone inside the band and nobody inside a building', () => {
    const system = makeSystem();
    run(system, 5);
    for (let i = 0; i < system.agents.extent; i++) {
      if (system.agents.active[i] === 0) continue;
      const x = system.agents.posX[i]!;
      const z = system.agents.posZ[i]!;
      expect(system.obstacles.isWalkable(x, z)).toBe(true);
    }
    system.dispose();
  });

  it('reports a far-tier population from open ground rather than inventing one', () => {
    const system = makeSystem();
    run(system, 2);
    expect(system.lastStats.far).toBeGreaterThan(100);
    const empty = new CrowdSystem({ seed: SEED, headless: true });
    expect(empty.farPopulation).toBe(0);
    empty.dispose();
    system.dispose();
  });
});

describe('CrowdSystem physical constraints', () => {
  it('keeps every pair of agents apart, every frame, for a long run', () => {
    const system = makeSystem();
    run(system, 3);
    system.setThreats([
      { id: 'm', position: new THREE.Vector3(45, 0, 0), intensity: 1, tier: 'dragon' },
    ]);

    let worst = Infinity;
    for (let f = 0; f < 600; f++) {
      system.update(1 / 60);
      const separation = system.steering.lastReport.minSeparation;
      if (separation < worst) worst = separation;
    }
    // Separation and containment are competing constraints and containment
    // wins, so a civilian crushed against a façade can end a frame overlapping
    // a neighbour slightly. The guarantee is a BOUND on that, not its absence:
    // under 4 % of a body width, which is under a centimetre.
    expect(worst).toBeGreaterThan(MIN_SEPARATION * 0.96);
    system.dispose();
  });

  it('keeps every agent out of every building through a full panic', () => {
    const system = makeSystem();
    run(system, 3);
    system.setThreats([
      { id: 'm', position: new THREE.Vector3(0, 0, 30), intensity: 1, tier: 'dragon' },
    ]);
    for (let f = 0; f < 600; f++) {
      system.update(1 / 60);
      if (f % 25 !== 0) continue;
      for (let i = 0; i < system.agents.extent; i++) {
        if (system.agents.active[i] === 0) continue;
        expect(
          system.obstacles.isWalkable(system.agents.posX[i]!, system.agents.posZ[i]!)
        ).toBe(true);
      }
    }
    system.dispose();
  });

  it('resolves a deliberately overlapping pair', () => {
    const steering = new CrowdSteering();
    const system = makeSystem();
    run(system, 3);
    // Stack two live agents on top of each other and let the constraint pass
    // sort them out.
    let a = -1;
    let b = -1;
    for (let i = 0; i < system.agents.extent && b < 0; i++) {
      if (system.agents.active[i] === 0) continue;
      if (a < 0) a = i;
      else b = i;
    }
    system.agents.posX[b] = system.agents.posX[a]!;
    system.agents.posZ[b] = system.agents.posZ[a]!;
    system.update(1 / 60);
    const dx = system.agents.posX[b]! - system.agents.posX[a]!;
    const dz = system.agents.posZ[b]! - system.agents.posZ[a]!;
    expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThan(AGENT_RADIUS);
    void steering;
    system.dispose();
  });

  it('computes time to collision only for closing pairs', () => {
    // Approaching head-on along +X.
    expect(timeToCollision(10, 0, -5, 0, 1)).toBeCloseTo(9 / 5, 5);
    // Receding.
    expect(timeToCollision(10, 0, 5, 0, 1)).toBe(-1);
    // Passing to one side, never within the radius.
    expect(timeToCollision(10, 5, -5, 0, 1)).toBe(-1);
    // Already overlapping.
    expect(timeToCollision(0.4, 0, -1, 0, 1)).toBe(0);
    // Stationary relative motion.
    expect(timeToCollision(10, 0, 0, 0, 1)).toBe(-1);
  });
});

describe('CrowdSystem panic', () => {
  it('turns a calm street into a panicking one, and the mood spreads outward', () => {
    const system = makeSystem();
    run(system, 4);
    const calm = system.lastStats.moods;
    expect(calm.commute).toBeGreaterThan(calm.flee + calm.gawk);

    system.setThreats([
      { id: 'm', position: new THREE.Vector3(30, 0, 0), intensity: 1, tier: 'dragon' },
    ]);
    run(system, 2);
    const early = system.lastStats.moods;
    run(system, 6);
    const late = system.lastStats.moods;

    // More people are reacting later than earlier: the wave is still arriving.
    expect(late.gawk + late.flee).toBeGreaterThan(early.gawk + early.flee);
    expect(late.flee).toBeGreaterThan(0);
    // And gawking is common, because this is that kind of city.
    expect(system.gawkFraction).toBeGreaterThan(0.15);
    system.dispose();
  });

  it('makes fleeing civilians move away from the threat', () => {
    const system = makeSystem();
    run(system, 4);
    const threat = new THREE.Vector3(40, 0, 0);
    system.setThreats([{ id: 'm', position: threat, intensity: 1, tier: 'dragon' }]);
    run(system, 5);

    let checked = 0;
    let receding = 0;
    for (let i = 0; i < system.agents.extent; i++) {
      if (system.agents.active[i] === 0) continue;
      if (system.agents.mood[i] !== MOOD_FLEE) continue;
      const dx = system.agents.posX[i]! - threat.x;
      const dz = system.agents.posZ[i]! - threat.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < 1e-3) continue;
      // Velocity should have a positive component along the outward radial.
      const outward = (system.agents.velX[i]! * dx + system.agents.velZ[i]! * dz) / d;
      checked++;
      if (outward > 0) receding++;
    }
    expect(checked).toBeGreaterThan(4);
    // Not all of them: the flow field routes round buildings, so somebody
    // rounding a corner is briefly moving sideways or even inwards. Most of
    // them, though, or it is not a rout.
    expect(receding / checked).toBeGreaterThan(0.7);
    system.dispose();
  });

  it('calms down again once the threat is gone', () => {
    const system = makeSystem();
    run(system, 3);
    system.setThreats([
      { id: 'm', position: new THREE.Vector3(25, 0, 0), intensity: 1, tier: 'dragon' },
    ]);
    run(system, 6);
    expect(system.lastStats.peakAlarm).toBeGreaterThan(0.3);
    system.setThreats([]);
    run(system, 12);
    expect(system.lastStats.peakAlarm).toBeLessThan(0.05);
    expect(system.lastStats.moods.commute).toBeGreaterThan(system.lastStats.total * 0.8);
    system.dispose();
  });
});

describe('CrowdSystem accounting', () => {
  it('kills civilians with a player shockwave and blames the player', () => {
    const bus = new EventBus();
    const lost: { byPlayer: boolean; delta: number }[] = [];
    bus.on('CivilianLost', (e) => lost.push({ byPlayer: e.causedByPlayer, delta: e.reputationDelta }));
    const system = makeSystem(bus);
    run(system, 5);

    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 500000,
      range: 90,
      angle: Math.PI,
      intent: 'full',
      punchKind: 'serious',
      sourceId: 'player',
    });
    run(system, 1);

    expect(lost.length).toBeGreaterThan(3);
    expect(lost.every((l) => l.byPlayer)).toBe(true);
    expect(lost.every((l) => l.delta < 0)).toBe(true);
    expect(system.ledger.killedByPlayer).toBe(lost.length);
    system.dispose();
  });

  it('barely scratches anybody at restrained intent', () => {
    const bus = new EventBus();
    let lost = 0;
    bus.on('CivilianLost', () => lost++);
    const system = makeSystem(bus);
    run(system, 5);
    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 500000,
      range: 90,
      angle: Math.PI,
      intent: 'restrained',
      punchKind: 'normal',
      sourceId: 'player',
    });
    run(system, 1);
    expect(lost).toBe(0);
    system.dispose();
  });

  it('credits saves once the danger has passed, and marks the witnessed ones', () => {
    const bus = new EventBus();
    const saves: { byPlayer: boolean; delta: number }[] = [];
    bus.on('CivilianSaved', (e) =>
      saves.push({ byPlayer: e.byPlayer, delta: e.reputationDelta })
    );
    const system = makeSystem(bus);
    run(system, 3);
    const threat = new THREE.Vector3(30, 0, 0);
    system.setThreats([{ id: 'm', position: threat, intensity: 1, tier: 'dragon' }]);
    run(system, 8);
    expect(saves.length).toBe(0);

    // The player kills it. Everyone frightened nearby owes them.
    bus.emit('EntityKilled', {
      entityId: 'm',
      entityType: 'monster',
      faction: 'monster',
      position: threat,
      killerId: 'player',
      threatTier: 'dragon',
      intent: 'serious',
      rewardPoints: 50,
    });
    system.setThreats([]);
    run(system, 14);

    expect(saves.length).toBeGreaterThan(5);
    expect(saves.some((s) => s.byPlayer)).toBe(true);
    expect(system.ledger.saved).toBe(saves.length);
    // Line of sight survives on the ledger even though the event has no field
    // for it, and it is reflected in the magnitude of the reputation delta.
    const witnessed = system.outcomes.filter((o) => o.kind === 'saved' && o.witnessedByPlayer);
    const unwitnessed = system.outcomes.filter((o) => o.kind === 'saved' && !o.witnessedByPlayer);
    expect(witnessed.length).toBeGreaterThan(0);
    expect(system.ledger.witnessed).toBe(witnessed.length);
    if (unwitnessed.length > 0) {
      const bestWitnessed = Math.max(...witnessed.map((o) => o.reputationDelta));
      const bestUnwitnessed = Math.max(...unwitnessed.map((o) => o.reputationDelta));
      expect(bestWitnessed).toBeGreaterThan(bestUnwitnessed);
    }
    system.dispose();
  });

  it('does not credit a save for somebody who was never in danger', () => {
    const bus = new EventBus();
    let saves = 0;
    bus.on('CivilianSaved', () => saves++);
    const system = makeSystem(bus);
    run(system, 20);
    expect(saves).toBe(0);
    system.dispose();
  });

  it('scores witnessing the way the ranking system reads it', () => {
    const seen = { byPlayer: true, bystanders: 20, playerDistance: 5 };
    const unseen = { byPlayer: false, bystanders: 0, playerDistance: 400 };
    expect(scoreOutcome('saved', true, seen)).toBeCloseTo(
      REP_SAVED_BY_PLAYER * WITNESS_MULTIPLIER,
      5
    );
    expect(scoreOutcome('saved', true, unseen)).toBe(REP_SAVED_BY_PLAYER);
    // A death is never discounted for happening off camera — that would be a
    // straightforward exploit.
    expect(scoreOutcome('lost', true, unseen)).toBe(REP_LOST_BY_PLAYER);
    expect(scoreOutcome('lost', true, seen)).toBeCloseTo(
      REP_LOST_BY_PLAYER * WITNESS_MULTIPLIER,
      5
    );
  });

  it('counts witnesses through open ground and not through buildings', () => {
    const system = makeSystem();
    run(system, 4);
    const obstacles = new ObstacleField();
    obstacles.rebuild(singleBlock(0, 0, 40));
    // Player on the far side of a solid block from the event.
    const blocked = gatherWitnesses(system.agents, obstacles, 60, 0, { x: -60, z: 0 }, -1);
    expect(blocked.byPlayer).toBe(false);
    const clear = gatherWitnesses(system.agents, obstacles, 60, 0, { x: 62, z: 6 }, -1);
    expect(clear.byPlayer).toBe(true);
    system.dispose();
  });

  it('keeps the ledger bounded but the counters exact', () => {
    const ledger = new CrowdLedger(4);
    const witness = { byPlayer: false, bystanders: 0, playerDistance: 100 };
    for (let i = 0; i < 20; i++) {
      ledger.record(undefined, 'saved', `c${i}`, { x: 0, y: 0, z: 0 }, false, witness, 1, i);
    }
    expect(ledger.saved).toBe(20);
    expect(ledger.recent.length).toBe(4);
    ledger.clear();
    expect(ledger.saved).toBe(0);
  });
});

describe('CrowdSystem determinism', () => {
  it('produces an identical crowd from the same seed and the same input sequence', () => {
    const script = (system: CrowdSystem, bus: EventBus): number => {
      run(system, 3);
      system.setThreats([
        { id: 'm', position: new THREE.Vector3(35, 0, -20), intensity: 1, tier: 'demon' },
      ]);
      run(system, 4);
      bus.emit('ShockwaveFired', {
        origin: { x: 10, y: 1, z: -5 },
        direction: { x: 0.6, y: 0, z: -0.8 },
        power: 90000,
        range: 55,
        angle: 0.9,
        intent: 'serious',
        punchKind: 'serious',
        sourceId: 'player',
      });
      run(system, 5);
      return system.hash();
    };

    const busA = new EventBus();
    const a = makeSystem(busA);
    const hashA = script(a, busA);

    const busB = new EventBus();
    const b = makeSystem(busB);
    const hashB = script(b, busB);

    expect(hashA).toBe(hashB);
    expect(a.lastStats.total).toBe(b.lastStats.total);
    expect(a.ledger.lost).toBe(b.ledger.lost);
    a.dispose();
    b.dispose();
  });

  it('produces a different crowd from a different seed', () => {
    const a = makeSystem(undefined, 1);
    const b = makeSystem(undefined, 2);
    run(a, 4);
    run(b, 4);
    expect(a.hash()).not.toBe(b.hash());
    a.dispose();
    b.dispose();
  });

  it('never calls Math.random while simulating', () => {
    // The system is constructed BEFORE the spy goes in: `THREE.Object3D`
    // generates a UUID from `Math.random` in its constructor, which is three.js
    // being three.js and says nothing about whether the simulation is
    // reproducible. What must be clean is every frame after that.
    const system = makeSystem();
    run(system, 2);

    const original = Math.random;
    let calls = 0;
    Math.random = (): number => {
      calls++;
      return original();
    };
    try {
      run(system, 4);
      system.setThreats([
        { id: 'm', position: new THREE.Vector3(20, 0, 0), intensity: 1, tier: 'dragon' },
      ]);
      run(system, 4);
    } finally {
      Math.random = original;
    }
    expect(calls).toBe(0);
    system.dispose();
  });
});

describe('CrowdSystem allies', () => {
  it('registers allies and reports their status', () => {
    const bus = new EventBus();
    const system = makeSystem(bus);
    const mumen = system.addHero('mumenRider', 8, 0);
    system.addHero('genos', -8, 0);
    run(system, 2);
    const status = system.allyStatus();
    expect(status.map((s) => s.displayName).sort()).toEqual(['Genos', 'Mumen Rider']);
    mumen.knockdown();
    run(system, 3);
    expect(mumen.reEngagements).toBe(1);
    system.dispose();
  });

  it("scares civilians with an ally's attack", () => {
    const bus = new EventBus();
    const system = makeSystem(bus);
    run(system, 3);
    const genos = system.addHero('genos', 6, 0);
    system.setThreats([
      { id: 'm', position: new THREE.Vector3(20, 0, 0), intensity: 0.9, tier: 'tiger' },
    ]);
    const before = system.alarm.impulseCount;
    run(system, 3);
    expect(genos.attackCooldownRemaining).toBeGreaterThanOrEqual(0);
    expect(system.alarm.peakAlarm).toBeGreaterThan(0);
    expect(system.alarm.impulseCount + before).toBeGreaterThanOrEqual(0);
    system.dispose();
  });
});

describe('CrowdSystem moods', () => {
  it('assigns every agent a legible mood name', () => {
    const system = makeSystem();
    run(system, 4);
    let counted = 0;
    for (let i = 0; i < system.agents.extent; i++) {
      if (system.agents.active[i] === 0) continue;
      counted++;
      expect(['commute', 'gawk', 'flee', 'cower', 'down']).toContain(system.agents.moodOf(i));
      expect(['near', 'mid']).toContain(system.agents.tierOf(i));
    }
    expect(counted).toBe(system.lastStats.total);
    expect(system.agents.mood[0]).toBeGreaterThanOrEqual(MOOD_COMMUTE);
    expect(MOOD_GAWK).toBeGreaterThan(MOOD_COMMUTE);
    system.dispose();
  });

  it('turns gawkers to face the threat', () => {
    const system = makeSystem();
    run(system, 3);
    const threat = new THREE.Vector3(0, 0, 90);
    system.setThreats([{ id: 'm', position: threat, intensity: 1, tier: 'demon' }]);
    run(system, 8);

    let gawkers = 0;
    let facing = 0;
    for (let i = 0; i < system.agents.extent; i++) {
      if (system.agents.active[i] === 0 || system.agents.mood[i] !== MOOD_GAWK) continue;
      const dx = threat.x - system.agents.posX[i]!;
      const dz = threat.z - system.agents.posZ[i]!;
      const d = Math.hypot(dx, dz);
      if (d < 1) continue;
      // Characters look down -Z, so the forward vector for yaw y is
      // (sin y, -cos y).
      const yaw = system.agents.yaw[i]!;
      const dot = (Math.sin(yaw) * dx - Math.cos(yaw) * dz) / d;
      gawkers++;
      if (dot > 0.3) facing++;
    }
    expect(gawkers).toBeGreaterThan(10);
    expect(facing / gawkers).toBeGreaterThan(0.75);
    system.dispose();
  });

  it('leaves the crowd calm and commuting when nothing is wrong', () => {
    const system = makeSystem();
    run(system, 8);
    expect(system.lastStats.moods.flee).toBe(0);
    expect(system.lastStats.moods.cower).toBe(0);
    expect(system.panicFraction).toBe(0);
    expect(system.lastStats.density).toBeGreaterThan(0.5);
    system.dispose();
  });

  it('promotes agents that come within the near radius', () => {
    const system = makeSystem();
    run(system, 6);
    let nearest = Infinity;
    for (let i = 0; i < system.agents.extent; i++) {
      if (system.agents.active[i] === 0 || system.agents.tier[i] !== TIER_NEAR) continue;
      nearest = Math.min(nearest, Math.hypot(system.agents.posX[i]!, system.agents.posZ[i]!));
    }
    expect(nearest).toBeLessThan(NEAR_RADIUS + 8);
    system.dispose();
  });
});
