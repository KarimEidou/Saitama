/**
 * THE MOOD AND PREFERENCE STAGES OF STEERING
 *
 * `chooseMood` and `preferredVelocity` are the two most heavily-tuned
 * functions in the crowd, and the only coverage they had was
 * `crowd-system.test.ts`'s end-to-end mood histograms — inequalities that stay
 * green under an inverted bravado sign, a broken dwell timer, or a stamina
 * system that never drains.
 *
 * So every constant between `ALARM_GAWK` and `STAMINA_RECOVERY` gets pinned
 * here, directly, one behaviour at a time:
 *
 *   - bravado widening the window in BOTH directions, which is the whole trick
 *     that produces a street where most people run and a knot of them film;
 *   - escalation being immediate while calming waits out the dwell;
 *   - the two-level stamina hysteresis (2 % in, 30 % out) that makes a collapse
 *     last a couple of seconds instead of one frame;
 *   - "cornered" distinguishing "no flee direction HERE" from "no threat
 *     anywhere", which is the difference between a huddle and a calm city full
 *     of people cowering at nothing;
 *   - and the "keep the current heading when the field is empty" branch, so a
 *     stopped agent in a panicking crowd is not a rock in a river.
 *
 * `CrowdSteering.avoid` is deliberately not covered here; it has its own
 * mechanism and its own test.
 */

import { describe, it, expect } from 'vitest';
import { CrowdSteering } from '../steering';
import {
  CrowdAgents,
  MOOD_COMMUTE,
  MOOD_COWER,
  MOOD_DOWN,
  MOOD_FLEE,
  MOOD_GAWK,
  TIER_MID,
} from '../crowd-agents';
import { FlowField } from '../flow-field';
import { ObstacleField } from '../obstacles';
import {
  ALARM_COWER,
  ALARM_FLEE,
  ALARM_GAWK,
  SPEED_FLEE,
  SPEED_WALK,
  STAMINA_RECOVERY,
  STAMINA_SECONDS,
} from '../constants';
import { threatAt } from './fixtures';

const DT = 1 / 60;

/**
 * Seconds a mood must hold before a CALMER one may replace it.
 *
 * Mirrors `MOOD_DWELL` in `steering.ts`, which is module-private — exporting a
 * tuning constant only so a test can read it would widen the unit's surface for
 * nobody's benefit.
 */
const MOOD_DWELL = 0.4;

/** Mirrors `CORNERED_DISTANCE` in `steering.ts`, private for the same reason. */
const CORNERED_DISTANCE = 14;

/**
 * One frame of the mood stage, in the caller's order.
 *
 * `CrowdSteering.update` advances `moodTime` BEFORE calling `chooseMood` and
 * writes the result back through `agents.setMood`, which is what resets the
 * dwell timer on an actual change. A helper that skipped either step would test
 * a sequence the simulation never runs.
 */
function step(
  steering: CrowdSteering,
  agents: CrowdAgents,
  i: number,
  alarm: number,
  threatDistance = 100,
  canFlee = true,
  dt = DT
): number {
  agents.moodTime[i] = agents.moodTime[i]! + dt;
  const next = steering.chooseMood(agents, i, alarm, threatDistance, canFlee, dt);
  agents.setMood(i, next);
  return next;
}

/** One agent in a fresh pool, with its traits pinned rather than seeded. */
function loneAgent(seed: number, bravado: number): { agents: CrowdAgents; i: number } {
  const agents = new CrowdAgents();
  const i = agents.spawn(seed, 0, 0, 0, TIER_MID);
  agents.bravado[i] = bravado;
  agents.stamina[i] = 1;
  return { agents, i };
}

describe('CrowdSteering.chooseMood', () => {
  it('leaves a dead civilian down, whatever the street is doing', () => {
    const steering = new CrowdSteering();
    const { agents, i } = loneAgent(11, 0.5);
    agents.health[i] = 0;
    agents.stamina[i] = 0.5;

    expect(step(steering, agents, i, 0)).toBe(MOOD_DOWN);
    expect(step(steering, agents, i, 0.9)).toBe(MOOD_DOWN);
    // The early return happens before the stamina integration, so a corpse
    // does not quietly get its breath back.
    expect(agents.stamina[i]).toBe(0.5);
  });

  it('lets bravado widen the window in both directions at once', () => {
    const steering = new CrowdSteering();
    const brave = loneAgent(21, 1);
    const timid = loneAgent(22, 0);

    // gawkAt = ALARM_GAWK * (1.45 - bravado * 0.85): 0.072 brave, 0.174 timid.
    expect(step(steering, brave.agents, brave.i, 0.1)).toBe(MOOD_GAWK);
    expect(step(steering, timid.agents, timid.i, 0.1)).toBe(MOOD_COMMUTE);

    // fleeAt = ALARM_FLEE * (0.6 + bravado * 0.8): 0.42 brave, 0.18 timid. The
    // brave one is still filming at an alarm the timid one is running from.
    expect(step(steering, brave.agents, brave.i, 0.25)).toBe(MOOD_GAWK);
    expect(step(steering, timid.agents, timid.i, 0.25)).toBe(MOOD_FLEE);
  });

  it('escalates immediately and calms down only after the dwell', () => {
    const steering = new CrowdSteering();
    const { agents, i } = loneAgent(31, 0);
    agents.setMood(i, MOOD_FLEE);
    agents.moodTime[i] = 0;

    // The threat is gone, but nobody stops dead the instant it does.
    expect(step(steering, agents, i, 0)).toBe(MOOD_FLEE);
    agents.moodTime[i] = MOOD_DWELL + 0.01;
    expect(step(steering, agents, i, 0)).toBe(MOOD_COMMUTE);

    // Going the other way there is no wait at all: nobody finishes their
    // thought when a building starts coming down beside them.
    agents.setMood(i, MOOD_COMMUTE);
    agents.moodTime[i] = 0;
    agents.stamina[i] = 1;
    expect(step(steering, agents, i, 0.9)).toBe(MOOD_FLEE);
  });

  it('collapses an exhausted runner and holds them down for a couple of seconds', () => {
    const steering = new CrowdSteering();
    const { agents, i } = loneAgent(41, 0);

    // Frame one promotes them; from frame two the legs start going.
    expect(step(steering, agents, i, 0.5)).toBe(MOOD_FLEE);
    let elapsed = DT;
    let previous = agents.stamina[i]!;
    let collapseAt = -1;
    let staminaAtCollapse = -1;
    let mood = MOOD_FLEE;

    for (let f = 0; f < 60 * 20 && collapseAt < 0; f++) {
      mood = step(steering, agents, i, 0.5);
      elapsed += DT;
      if (mood === MOOD_FLEE) {
        // Drains at 1/STAMINA_SECONDS per second while running. `stamina` is a
        // Float32Array, so the tolerance is a float32 ULP rather than a
        // float64 one — still three orders of magnitude under the step itself.
        expect(previous - agents.stamina[i]!).toBeCloseTo(DT / STAMINA_SECONDS, 6);
      } else {
        collapseAt = elapsed;
        staminaAtCollapse = agents.stamina[i]!;
      }
      previous = agents.stamina[i]!;
    }

    expect(mood).toBe(MOOD_COWER);
    expect(collapseAt).toBeGreaterThan(STAMINA_SECONDS * 0.9);
    expect(collapseAt).toBeLessThan(STAMINA_SECONDS * 1.05);
    // Exhaustion sets in at 2 %, not at the 30 % it lifts at.
    expect(staminaAtCollapse).toBeLessThanOrEqual(0.02);

    // And it LIFTS at 30 %, which is what makes the collapse last long enough
    // to read as somebody who could not get away.
    let recovery = 0;
    let recoveredAt = -1;
    for (let f = 0; f < 60 * 20 && recoveredAt < 0; f++) {
      mood = step(steering, agents, i, 0.5);
      recovery += DT;
      if (mood === MOOD_COWER) {
        expect(agents.stamina[i]!).toBeLessThanOrEqual(0.3);
      } else {
        recoveredAt = recovery;
      }
    }
    expect(mood).toBe(MOOD_FLEE);
    expect(agents.stamina[i]!).toBeGreaterThan(0.3);
    // (0.3 - 0.02) * STAMINA_RECOVERY, give or take a frame.
    expect(recoveredAt).toBeCloseTo(0.28 * STAMINA_RECOVERY, 1);
  });

  it('tells a cornered civilian apart from one with nowhere in particular to be', () => {
    const steering = new CrowdSteering();
    const alarm = ALARM_COWER + 0.08;

    // No flee direction anywhere: give up.
    const trapped = loneAgent(51, 0);
    expect(step(steering, trapped.agents, trapped.i, alarm, 100, false)).toBe(MOOD_COWER);

    // A direction exists, but the monster is on top of them.
    const close = loneAgent(52, 0);
    expect(step(steering, close.agents, close.i, alarm, CORNERED_DISTANCE - 9, true)).toBe(
      MOOD_COWER
    );

    // Room to run, and the legs to do it with.
    const clear = loneAgent(53, 0);
    expect(step(steering, clear.agents, clear.i, alarm, 100, true)).toBe(MOOD_FLEE);
  });

  it('keeps stamina inside [0, 1] however long the call runs', () => {
    const steering = new CrowdSteering();
    const calm = loneAgent(61, 0.5);
    for (let f = 0; f < 2000; f++) {
      step(steering, calm.agents, calm.i, 0);
      expect(calm.agents.stamina[calm.i]!).toBeLessThanOrEqual(1);
      expect(calm.agents.stamina[calm.i]!).toBeGreaterThanOrEqual(0);
    }
    // Recovery ran for thirty-three seconds and stopped at full.
    expect(calm.agents.stamina[calm.i]).toBe(1);

    const running = loneAgent(62, 0);
    for (let f = 0; f < 2000; f++) {
      // Pin the mood so the drain branch stays selected for the whole run;
      // left alone, exhaustion would flip them to cowering and stop it.
      running.agents.mood[running.i] = MOOD_FLEE;
      step(steering, running.agents, running.i, 0.5);
      expect(running.agents.stamina[running.i]!).toBeLessThanOrEqual(1);
      expect(running.agents.stamina[running.i]!).toBeGreaterThanOrEqual(0);
    }
    expect(running.agents.stamina[running.i]).toBe(0);
  });
});

describe('CrowdSteering.preferredVelocity', () => {
  /**
   * An agent 60 m east of a single threat at the origin, on open ground.
   *
   * `fields.test.ts` already establishes that the flee direction there is +X,
   * so every assertion below can talk about a direction as well as a speed.
   */
  function scene(threats = true): {
    steering: CrowdSteering;
    agents: CrowdAgents;
    i: number;
    flow: FlowField;
    flee: [number, number];
  } {
    const obstacles = new ObstacleField();
    obstacles.rebuild([]);
    const flow = new FlowField();
    flow.rebuild(obstacles, threats ? [threatAt(0, 0)] : []);
    const agents = new CrowdAgents();
    const i = agents.spawn(71, 60, 0, 0, TIER_MID);
    agents.posX[i] = 60;
    agents.posZ[i] = 0;
    agents.stamina[i] = 1;
    const flee: [number, number] = [0, 0];
    flow.sampleDirection(flow.flee, 60, 0, flee);
    return { steering: new CrowdSteering(), agents, i, flow, flee };
  }

  it('stops a cowering or downed civilian dead', () => {
    const { steering, agents, i, flow } = scene();
    const out: [number, number] = [9, 9];
    agents.mood[i] = MOOD_COWER;
    steering.preferredVelocity(agents, i, flow, 0.9, out);
    expect(out).toEqual([0, 0]);
    agents.mood[i] = MOOD_DOWN;
    out[0] = 9;
    out[1] = 9;
    steering.preferredVelocity(agents, i, flow, 0.9, out);
    expect(out).toEqual([0, 0]);
  });

  it('runs a fleeing civilian away at flee speed, scaled by what is left in the tank', () => {
    const { steering, agents, i, flow } = scene();
    const out: [number, number] = [0, 0];
    agents.mood[i] = MOOD_FLEE;

    steering.preferredVelocity(agents, i, flow, 0.9, out);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(SPEED_FLEE, 5);
    expect(out[0]).toBeGreaterThan(0);

    // Empty legs still move, at 85 %: a crawl is not a stop.
    agents.stamina[i] = 0;
    steering.preferredVelocity(agents, i, flow, 0.9, out);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(SPEED_FLEE * 0.85, 5);
  });

  it('lets a gawker edge backwards without ever actually leaving', () => {
    const { steering, agents, i, flow } = scene();
    const out: [number, number] = [9, 9];
    agents.mood[i] = MOOD_GAWK;

    // The creep is zero at the threshold: they have stopped, not started.
    steering.preferredVelocity(agents, i, flow, ALARM_GAWK, out);
    expect(out).toEqual([0, 0]);

    steering.preferredVelocity(agents, i, flow, 0.5, out);
    const creep = SPEED_WALK * 0.22 * ((0.5 - ALARM_GAWK) * 1.6);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(creep, 5);
    // A fifth of a walking pace, and away from the threat.
    expect(creep).toBeLessThan(SPEED_WALK * 0.25);
    expect(out[0]).toBeGreaterThan(0);
  });

  it('blends a commuter off their errand and onto the flee field as panic rises', () => {
    const { steering, agents, i, flow, flee } = scene();
    const out: [number, number] = [0, 0];
    agents.mood[i] = MOOD_COMMUTE;

    // panic = 0: still walking where they were going, at walking pace.
    steering.preferredVelocity(agents, i, flow, ALARM_GAWK, out);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(SPEED_WALK * 0.85, 5);

    // panic = 1 collapses the lerp onto flee entirely, at half again the pace.
    steering.preferredVelocity(agents, i, flow, ALARM_FLEE, out);
    const speed = Math.hypot(out[0], out[1]);
    expect(speed).toBeCloseTo(SPEED_WALK * 1.35, 5);
    expect(out[0] / speed).toBeCloseTo(flee[0], 5);
    expect(out[1] / speed).toBeCloseTo(flee[1], 5);
  });

  it('keeps the heading when the field has nothing to say', () => {
    // No threats at all, so the flee field is zero everywhere and a committed
    // fleer has no gradient to read. Stopping dead here is what makes an agent
    // a rock in a river; they keep going the way they were already going.
    const { steering, agents, i, flow } = scene(false);
    const out: [number, number] = [0, 0];
    agents.mood[i] = MOOD_FLEE;
    agents.velX[i] = 3;
    agents.velZ[i] = 0;
    steering.preferredVelocity(agents, i, flow, 0.9, out);
    expect(out[0]).toBeCloseTo(SPEED_FLEE, 5);
    expect(out[1]).toBeCloseTo(0, 5);

    // With no heading either, there is nothing to preserve.
    agents.velX[i] = 0;
    agents.velZ[i] = 0;
    steering.preferredVelocity(agents, i, flow, 0.9, out);
    expect(out).toEqual([0, 0]);
  });
});
