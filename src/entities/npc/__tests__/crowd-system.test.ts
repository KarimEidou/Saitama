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

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '@/util';
import { CrowdSystem } from '../crowd-system';
import { CrowdSteering } from '../steering';
import { AlarmField } from '../alarm-field';
import { FlowField } from '../flow-field';
import { CrowdAgents, MOOD_COMMUTE, MOOD_FLEE, MOOD_GAWK, TIER_NEAR } from '../crowd-agents';
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

// These simulate hundreds of frames of a 250-agent crowd. Vitest's default
// five-second budget is comfortable on an idle machine and not comfortable at
// all when a dozen other workstreams are compiling on the same box, and a test
// that fails on CPU contention is worse than no test.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

  it('does not let one streamed chunk slot replace the open-ground spawn list', () => {
    const system = makeSystem();
    const findSlot = (): { x: number; z: number } | undefined => {
      for (let x = 14; x <= 40; x += 2) {
        for (let z = 14; z <= 40; z += 2) {
          if (system.obstacles.isWalkable(x, z, 0.4)) return { x, z };
        }
      }
      return undefined;
    };
    const slot = findSlot();
    expect(slot).toBeDefined();

    // Streaming publishes a handful of slots per chunk for the two innermost
    // rings — a few dozen points against a 250-agent cap. Treating that as
    // "the streamer is providing spawn points now" walks the cursor round the
    // same points over and over and erupts a pile of civilians out of one.
    system.setChunkCrowd(42, 'instanced', [{ x: slot!.x, y: 0, z: slot!.z, rotationY: 0 }]);
    run(system, 6);
    expect(system.lastStats.total).toBe(MID_CAP);

    let nearSlot = 0;
    for (let i = 0; i < system.agents.extent; i++) {
      if (system.agents.active[i] === 0) continue;
      const dx = system.agents.posX[i]! - slot!.x;
      const dz = system.agents.posZ[i]! - slot!.z;
      if (dx * dx + dz * dz < 100) nearSlot++;
    }
    expect(nearSlot).toBeLessThan(MID_CAP / 4);
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

  it('re-bodies the near tier from the pool without a one-per-frame stall', () => {
    // The one-body-per-frame throttle exists for the ~10 ms `buildHumanoid`
    // costs. A POOLED body is a map insert and `visible = true`, so throttling
    // it buys nothing and leaves civilians inside forty metres instanced for up
    // to `caps.near` frames every time the player rounds a corner — which is
    // exactly when the near tier is supposed to be there.
    const system = new CrowdSystem({ seed: SEED, headless: false, quality: 'low' });
    system.setObstacles(cityRects(SEED, 2));
    system.setPlayer(0, 0);
    run(system, 8);
    const bodies = system['nearBodies'] as Map<number, unknown>;
    expect(bodies.size).toBeGreaterThanOrEqual(4);

    // Cross a street: everybody who was near is now past the hysteresis band
    // and hands their body back, and everybody who was mid at the far end is
    // now inside it — so every attach from here is a pure recycle.
    system.setPlayer(0, 80);

    let worstDeficit = 0;
    let peakNear = 0;
    for (let f = 0; f < 240; f++) {
      system.update(1 / 60);
      let near = 0;
      for (let i = 0; i < system.agents.extent; i++) {
        if (system.agents.active[i] === 1 && system.agents.tier[i] === TIER_NEAR) near++;
      }
      peakNear = Math.max(peakNear, near);
      worstDeficit = Math.max(worstDeficit, near - bodies.size);
    }
    // The band really did refill, so the bound below is a claim about something.
    expect(peakNear).toBeGreaterThanOrEqual(4);
    // Every promoted agent is bodied in the frame it is promoted, because the
    // pool already holds the bodies. Throttled, this climbs to `caps.near - 1`.
    expect(worstDeficit).toBeLessThanOrEqual(1);
    system.dispose();
  });

  it('reuses its avoidance body records instead of allocating them every frame', () => {
    // `heroWorld` explains the house rule three dozen lines from the code this
    // covers: arrays are handed over by reference and mutated in place, because
    // rebuilding these lists each frame would allocate on every tick of a
    // system that is meant to be allocation-free once warm. These records are
    // write-only scratch consumed synchronously by `steering.update` in the
    // same frame, so nothing observes their identity.
    const system = makeSystem();
    system.addHero('genos', 5, 0);
    system.setThreats([
      { id: 'm', position: new THREE.Vector3(20, 0, 0), intensity: 1, tier: 'tiger' },
    ]);
    system.update(1 / 60);
    const bodies = system['avoidBodies'] as readonly { x: number }[];
    expect(bodies.length).toBe(3); // hero + threat + player
    const snapshot = bodies.slice();
    system.update(1 / 60);
    expect(bodies.length).toBe(3);
    for (let i = 0; i < snapshot.length; i++) expect(bodies[i]).toBe(snapshot[i]);
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
    let pairs = 0;
    for (let f = 0; f < 600; f++) {
      system.update(1 / 60);
      const separation = system.steering.lastReport.minSeparation;
      pairs += system.steering.lastReport.measuredPairs;
      if (separation < worst) worst = separation;
    }
    // The bound is only worth anything if pairs were actually compared: the
    // measurement only looks within `2 * MIN_SEPARATION`, so a crowd nobody
    // shares a street with satisfies it vacuously.
    expect(pairs).toBeGreaterThan(0);
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
        expect(system.obstacles.isWalkable(system.agents.posX[i]!, system.agents.posZ[i]!)).toBe(
          true
        );
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

  it('penalises a candidate that closes on a neighbour, not one that leaves', () => {
    // Two agents and one grid. `avoid` reads the grid `update` built, so the
    // pair is placed, stepped once to build it, and put back exactly where it
    // was — the grid and the agent arrays then agree to the metre.
    const pair = (bx: number, bz: number): { steering: CrowdSteering; agents: CrowdAgents } => {
      const agents = new CrowdAgents();
      const obstacles = new ObstacleField();
      obstacles.rebuild([]);
      const flow = new FlowField();
      flow.rebuild(obstacles, []);
      const alarm = new AlarmField();
      const steering = new CrowdSteering();
      const a = agents.spawn(11, 0, 0, 0, TIER_NEAR);
      const b = agents.spawn(22, bx, bz, 0, TIER_NEAR);
      const place = (): void => {
        agents.posX[a] = 0;
        agents.posZ[a] = 0;
        agents.posX[b] = bx;
        agents.posZ[b] = bz;
        agents.velX[a] = 0;
        agents.velZ[a] = 0;
        agents.velX[b] = 0;
        agents.velZ[b] = 0;
      };
      place();
      steering.update(agents, 1 / 60, alarm, flow, obstacles, []);
      place();
      return { steering, agents };
    };

    const out: [number, number] = [0, 0];
    // Walking straight at somebody standing 1.5 m ahead: the preferred
    // velocity has to be rejected.
    const ahead = pair(1.5, 0);
    expect(ahead.steering.avoid(ahead.agents, 0, [1.35, 0], out)).toBe(true);

    // Walking AWAY from somebody standing a metre behind: nothing to avoid,
    // and swerving off the pavement to dodge them is the bug.
    const behind = pair(-1, 0);
    expect(behind.steering.avoid(behind.agents, 0, [1.35, 0], out)).toBe(false);
    expect(out).toEqual([1.35, 0]);
  });

  it('scores the nearest neighbours, not the first ones the grid happened to list', () => {
    // Sixteen people loosely queued BEHIND this agent, and one standing right
    // in front of them. The grid appends in cell-scan order, which is agent
    // slot order — so slicing the head of the list keeps the sixteen who are
    // no threat to anybody and drops the only one on a collision course.
    const agents = new CrowdAgents();
    const obstacles = new ObstacleField();
    obstacles.rebuild([]);
    const flow = new FlowField();
    flow.rebuild(obstacles, []);
    const alarm = new AlarmField();
    const steering = new CrowdSteering();

    const spots: { x: number; z: number }[] = [{ x: 0, z: 0 }];
    for (const x of [-1, -1.6, -2.2, -2.8]) {
      for (const z of [-1.2, -0.4, 0.4, 1.2]) spots.push({ x, z });
    }
    spots.push({ x: 1.2, z: 0 });
    for (const spot of spots) agents.spawn(1, spot.x, spot.z, 0, TIER_NEAR);

    const place = (): void => {
      for (let i = 0; i < spots.length; i++) {
        agents.posX[i] = spots[i]!.x;
        agents.posZ[i] = spots[i]!.z;
        agents.velX[i] = 0;
        agents.velZ[i] = 0;
      }
    };
    place();
    steering.update(agents, 1 / 60, alarm, flow, obstacles, []);
    place();

    const out: [number, number] = [0, 0];
    expect(steering.avoid(agents, 0, [1.35, 0], out)).toBe(true);
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
    bus.on('CivilianLost', (e) =>
      lost.push({ byPlayer: e.causedByPlayer, delta: e.reputationDelta })
    );
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

  it('stops billing the player for deaths once the collateral window has passed', () => {
    const bus = new EventBus();
    const lost: { byPlayer: boolean; delta: number }[] = [];
    bus.on('CivilianLost', (e) =>
      lost.push({ byPlayer: e.causedByPlayer, delta: e.reputationDelta })
    );
    const system = makeSystem(bus);
    run(system, 5);

    // Restrained intent: everybody in the cone is scratched and nobody dies.
    // That is the mode's whole purpose, so it must not silently mark the
    // street as the player's for the rest of the session.
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
    expect(lost.length).toBe(0);

    const scratched: number[] = [];
    for (let i = 0; i < system.agents.extent; i++) {
      if (system.agents.active[i] === 0 || system.agents.health[i]! <= 0) continue;
      if (system.agents.health[i]! < system.agents.maxHealth[i]!) scratched.push(i);
    }
    expect(scratched.length).toBeGreaterThan(1);

    // Inside the window, a monster finishing off somebody the player softened
    // up is still on the player.
    system.damageAgent(scratched[0]!, 100, false);
    expect(lost.length).toBe(1);
    expect(lost[0]!.byPlayer).toBe(true);

    // Well outside it, it is not.
    run(system, 8);
    const survivor = scratched.find(
      (i) => system.agents.active[i] === 1 && system.agents.health[i]! > 0
    );
    expect(survivor).toBeDefined();
    system.damageAgent(survivor!, 100, false);
    expect(lost.length).toBe(2);
    expect(lost[1]!.byPlayer).toBe(false);
    expect(lost[1]!.delta).toBeGreaterThan(lost[0]!.delta);
    system.dispose();
  });

  it('credits saves once the danger has passed, and marks the witnessed ones', () => {
    const bus = new EventBus();
    const saves: { byPlayer: boolean; delta: number }[] = [];
    bus.on('CivilianSaved', (e) => saves.push({ byPlayer: e.byPlayer, delta: e.reputationDelta }));
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
    // straightforward exploit. Both witness multipliers are ABOVE one, so
    // scaling a loss makes the unwitnessed one the cheap one; losses are
    // therefore not scaled at all, seen or unseen.
    expect(scoreOutcome('lost', true, unseen)).toBe(REP_LOST_BY_PLAYER);
    expect(scoreOutcome('lost', true, seen)).toBe(REP_LOST_BY_PLAYER);
    expect(scoreOutcome('lost', false, seen)).toBe(scoreOutcome('lost', false, unseen));
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

  it('lets a hostile shockwave hurt the allies, and eventually kill one', () => {
    const bus = new EventBus();
    const downed: string[] = [];
    bus.on('AllyDowned', (e) => downed.push(e.displayName));
    const system = makeSystem(bus);
    const mumen = system.addHero('mumenRider', 3, 0);
    const genos = system.addHero('genos', -3, 0);
    run(system, 2);

    const wave = {
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      range: 60,
      angle: Math.PI,
      intent: 'serious' as const,
      punchKind: 'heavy' as const,
      sourceId: 'monster',
    };
    bus.emit('ShockwaveFired', { ...wave, power: 200000 });
    run(system, 0.2);
    expect(genos.health).toBeLessThan(genos.maxHealth);
    expect(mumen.health).toBeLessThan(mumen.maxHealth);
    // Mumen is knocked flat by almost anything, and gets up.
    expect(mumen.isDown || mumen.isDead).toBe(true);

    // Keep hitting him. He does not retreat, so he runs out of hit points.
    for (let i = 0; i < 6 && !mumen.isDead; i++) {
      bus.emit('ShockwaveFired', { ...wave, power: 200000 });
      run(system, 2);
    }
    expect(mumen.isDead).toBe(true);
    expect(downed).toContain('Mumen Rider');
    system.dispose();
  });

  it("does not let the player's own shockwave hurt an ally", () => {
    const bus = new EventBus();
    const system = makeSystem(bus);
    const genos = system.addHero('genos', 3, 0);
    run(system, 1);
    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 900000,
      range: 80,
      angle: Math.PI,
      intent: 'full',
      punchKind: 'serious',
      sourceId: 'player',
    });
    run(system, 0.2);
    expect(genos.health).toBe(genos.maxHealth);
    system.dispose();
  });

  it("scares civilians with an ally's attack", () => {
    const bus = new EventBus();
    const system = makeSystem(bus);
    run(system, 3);
    // No threat registered, so the alarm field has no source of its own and
    // everything below is attributable to the ally alone. Without that the
    // assertions hold whether or not `fireAttack` ever seeds anything.
    const genos = system.addHero('genos', 90, 0);
    expect(system.alarm.sample(90, 0)).toBe(0);

    const seeds = system.alarm.impulseCount;
    genos.fireAttack({ id: 'm', position: new THREE.Vector3(96, 0, 0), intensity: 1 });
    expect(system.alarm.impulseCount).toBeGreaterThan(seeds);
    expect(genos.attackCooldownRemaining).toBeGreaterThan(0);

    run(system, 1);
    expect(system.alarm.sample(90, 0)).toBeGreaterThan(0.1);
    system.dispose();
  });

  it('does not let one ally shockwave another', () => {
    const bus = new EventBus();
    const downed: string[] = [];
    bus.on('AllyDowned', (e) => downed.push(e.displayName));
    const system = makeSystem(bus);
    // Mumen parks himself on the monster, which is dead centre of Genos's cone.
    const mumen = system.addHero('mumenRider', 3, 0);
    const genos = system.addHero('genos', -3, 0);
    run(system, 1);

    for (let i = 0; i < 8; i++) {
      bus.emit('ShockwaveFired', {
        origin: { x: -3, y: 2, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        power: 9000,
        range: 60,
        angle: Math.PI,
        intent: 'serious',
        punchKind: 'heavy',
        sourceId: 'hero-genos',
      });
      run(system, 0.2);
    }
    expect(mumen.health).toBe(mumen.maxHealth);
    expect(mumen.isDown).toBe(false);
    expect(genos.health).toBe(genos.maxHealth);
    expect(downed).toEqual([]);
    system.dispose();
  });

  /**
   * POINT BLANK IS THE MOST LETHAL RANGE, NOT A DEAD ZONE.
   *
   * `MonsterBrain.release` puts the wave's apex a body radius in front of the
   * monster, and a melee archetype closes to inside that radius — so the apex
   * lands just PAST whoever it is swinging at. Measured as a point against a
   * point, the offset from apex to victim then points BACKWARDS: `dot` is -1
   * and a forward cone rejects the one target it was aimed at, on every swing.
   * That is what a god-tier monster standing on Genos used to do to him:
   * nothing at all, for as long as the fight lasted.
   *
   * Combat's own `sphereInCone` already answers this — the apex inside the
   * body accepts — and this is the crowd's half of the same rule.
   */
  it('lands a wave whose apex has already passed the ally', () => {
    const bus = new EventBus();
    const system = makeSystem(bus);
    const genos = system.addHero('genos', 0, 0);
    run(system, 1);

    // Apex 4 cm BEYOND Genos, pointing away from him: the exact geometry a
    // monster standing on him produces.
    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 2, z: 0.04 },
      direction: { x: 0, y: 0, z: 1 },
      power: 120000,
      range: 18,
      angle: Math.PI / 3,
      intent: 'full',
      punchKind: 'heavy',
      sourceId: 'monster',
    });
    run(system, 0.2);

    expect(genos.health).toBeLessThan(genos.maxHealth);
    system.dispose();
  });

  /** The cone still has a back: somebody a cone-length behind it is spared. */
  it('still spares an ally standing well behind the cone', () => {
    const bus = new EventBus();
    const system = makeSystem(bus);
    const genos = system.addHero('genos', 0, -10);
    run(system, 1);

    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      power: 120000,
      range: 18,
      angle: Math.PI / 3,
      intent: 'full',
      punchKind: 'heavy',
      sourceId: 'monster',
    });
    run(system, 0.2);

    expect(genos.health).toBe(genos.maxHealth);
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
