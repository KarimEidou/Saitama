/**
 * STEERING — from a scalar of fear to a metre of movement
 *
 * Four stages, run over every simulated civilian every frame:
 *
 *   1. MOOD          sample the alarm field, decide commute / gawk / flee /
 *                    cower against this individual's nerve;
 *   2. PREFERENCE    read the matching flow field, get a desired velocity;
 *   3. AVOIDANCE     near agents run RVO-lite against their neighbours; mid
 *                    agents skip straight to (4);
 *   4. INTEGRATION   accelerate, move, then HARD-CONSTRAIN: no agent ends the
 *                    frame inside another agent or inside a building.
 *
 * ── WHY THE HARD CONSTRAINT EXISTS ON TOP OF AVOIDANCE ────────────────────
 * Velocity-space avoidance is a prediction. It is a good prediction, and it is
 * wrong whenever the assumptions break: three agents in a doorway, a crowd
 * compressed against a wall by a flee field, a civilian shoved by a shockwave.
 * When it is wrong, bodies interpenetrate, and two civilians occupying the
 * same cubic metre is one of the few failures a player reads instantly as
 * "this is a video game" rather than "this is a city".
 *
 * So avoidance handles the LOOK — people flowing round each other, choosing
 * gaps, slowing rather than colliding — and a positional relaxation pass
 * afterwards handles the GUARANTEE. The relaxation is symmetric (each of a
 * pair moves half the overlap), so it conserves the crowd's centre of mass and
 * cannot pump energy into a jam.
 *
 * ── AND WHY IT RUNS AFTER CONTAINMENT, TWICE ──────────────────────────────
 * Pushing two agents apart can push one into a wall; pushing an agent out of a
 * wall can push it into another agent. Neither ordering is correct on its own,
 * so the pair alternates and the last word goes to CONTAINMENT: an agent
 * standing 20 cm inside a colleague is a bad frame, an agent standing inside a
 * building is a bug report.
 */

import { clamp, clamp01 } from '@/util';
import { DynamicEntityGrid } from '@/spatial/entity-grid';
import { IndexList } from '@/spatial/index-list';
import {
  ACCELERATION,
  ALARM_COWER,
  ALARM_FLEE,
  ALARM_GAWK,
  AVOID_NEIGHBOURS,
  AVOID_RADIUS,
  MIN_SEPARATION,
  RVO_HORIZON,
  RVO_SAMPLES,
  SEPARATION_PASSES,
  SPEED_FLEE,
  SPEED_WALK,
  STAMINA_RECOVERY,
  STAMINA_SECONDS,
  TURN_RATE,
} from './constants';
import {
  CrowdAgents,
  MOOD_COMMUTE,
  MOOD_COWER,
  MOOD_DOWN,
  MOOD_FLEE,
  MOOD_GAWK,
  TIER_NEAR,
} from './crowd-agents';
import type { AlarmField } from './alarm-field';
import type { FlowField } from './flow-field';
import type { ObstacleField } from './obstacles';

/** Grid layer bits. Opaque to the grid; meaningful only here. */
export const LAYER_CIVILIAN = 1 << 0;
export const LAYER_HERO = 1 << 1;
export const LAYER_THREAT = 1 << 2;
export const LAYER_PLAYER = 1 << 3;

/** Everything a civilian must not walk into. */
const AVOID_MASK = LAYER_CIVILIAN | LAYER_HERO | LAYER_THREAT | LAYER_PLAYER;

/**
 * Seconds a mood must hold before another may replace it.
 *
 * Alarm at a threshold jitters by a few thousandths tick to tick, and without
 * a dwell time a civilian standing exactly on the flee boundary alternates
 * between running and filming at 60 Hz. It reads as a seizure.
 */
const MOOD_DWELL = 0.4;

/** Metres from a threat at which running is no longer an option. */
const CORNERED_DISTANCE = 14;

/** A non-civilian body registered in the grid for avoidance purposes. */
export interface IAvoidBody {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly layer: number;
}

/** Per-frame steering measurements, for the harness. */
export interface ISteeringReport {
  /** Smallest centre-to-centre distance between any two agents this frame. */
  minSeparation: number;
  /** Agents that ended the frame inside a building before containment. */
  containmentFixes: number;
  /** Total metres containment had to move agents. */
  containmentMetres: number;
  /** Agents whose RVO solve changed their velocity. */
  avoidanceAdjustments: number;
}

export class CrowdSteering {
  /**
   * The shared 24 m dynamic grid, rebuilt once per frame by counting sort.
   *
   * Deliberately the spatial workstream's grid rather than a crowd-local one:
   * a civilian must avoid monsters and heroes as well as other civilians, and
   * those live in the same grid. A second broad phase here would have to be
   * kept in sync with the first, which is the standard way two systems end up
   * disagreeing about where an entity is.
   */
  readonly grid = new DynamicEntityGrid(512);

  private readonly neighbours = new IndexList(64);
  /** Reverse map: grid slot to agent index, or -1 for a non-civilian body. */
  private slotAgent = new Int32Array(1024).fill(-1);

  private readonly report: ISteeringReport = {
    minSeparation: Infinity,
    containmentFixes: 0,
    containmentMetres: 0,
    avoidanceAdjustments: 0,
  };

  private readonly scratch = { x: 0, z: 0 };
  private readonly dirScratch: [number, number] = [0, 0];

  /** Measurements from the last `update`. */
  get lastReport(): ISteeringReport {
    return this.report;
  }

  /* ------------------------------------------------------------------ */
  /* Mood                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Decide what one civilian is doing.
   *
   * `bravado` shifts BOTH thresholds and in opposite directions, which is the
   * whole trick: a brave civilian starts gawking sooner and starts running
   * later, so the same alarm value produces a street where most people are
   * running, a knot of them are filming, and the person filming is not
   * randomly chosen each frame — it is the same person, because bravado is a
   * fixed trait derived from their seed.
   */
  chooseMood(
    agents: CrowdAgents,
    i: number,
    alarm: number,
    threatDistance: number,
    canFlee: boolean,
    dt: number
  ): number {
    if (agents.health[i]! <= 0) return MOOD_DOWN;

    const bravado = agents.bravado[i]!;
    const gawkAt = ALARM_GAWK * (1.45 - bravado * 0.85);
    const fleeAt = ALARM_FLEE * (0.6 + bravado * 0.8);

    // Stamina: sprinting is a resource, and running out of it is what turns a
    // flight into a huddle. Without it a panicking crowd sprints forever and
    // the streets simply empty, which loses the image the whole system exists
    // to produce — people who could not get away.
    const fleeing = agents.mood[i] === MOOD_FLEE;
    const stamina = clamp01(
      agents.stamina[i]! + (fleeing ? -dt / STAMINA_SECONDS : dt / STAMINA_RECOVERY)
    );
    agents.stamina[i] = stamina;

    // Hysteresis, and it is not optional: a flat threshold means an exhausted
    // civilian recovers past it within a tenth of a second of stopping, flips
    // back to fleeing, and flips again immediately. Exhaustion sets in at 2%
    // and only lifts at 30%, so a collapse lasts a couple of seconds.
    const spent = agents.mood[i] === MOOD_COWER ? stamina <= 0.3 : stamina <= 0.02;
    const cornered = !canFlee || threatDistance < CORNERED_DISTANCE;

    let next: number;
    if (alarm >= ALARM_COWER && (cornered || spent)) next = MOOD_COWER;
    else if (alarm >= fleeAt) next = spent ? MOOD_COWER : MOOD_FLEE;
    else if (alarm >= gawkAt) next = MOOD_GAWK;
    else next = MOOD_COMMUTE;

    const current = agents.mood[i]!;
    if (next === current) return current;
    // The mood constants are ordered by severity, so `next > current` is an
    // escalation. Escalation is IMMEDIATE — nobody finishes their thought when
    // a building starts coming down beside them. Calming back down waits out
    // the dwell time, which is what stops a civilian sitting exactly on a
    // threshold from flickering between filming and running at 60 Hz.
    if (next > current) return next;
    if (agents.moodTime[i]! < MOOD_DWELL) return current;
    return next;
  }

  /* ------------------------------------------------------------------ */
  /* Preference                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Desired velocity for one civilian, written into `out`.
   *
   * Commute and flee are BLENDED by alarm rather than switched: a civilian
   * whose alarm is halfway between the thresholds drifts away from the noise
   * while still heading roughly where they were going, which is what people
   * do before they commit to running.
   */
  preferredVelocity(
    agents: CrowdAgents,
    i: number,
    flow: FlowField,
    alarm: number,
    out: [number, number]
  ): void {
    const mood = agents.mood[i]!;
    if (mood === MOOD_DOWN || mood === MOOD_COWER) {
      out[0] = 0;
      out[1] = 0;
      return;
    }

    const x = agents.posX[i]!;
    const z = agents.posZ[i]!;
    const commute = agents.goalPhase[i] === 0 ? flow.commuteA : flow.commuteB;
    flow.sampleDirection(commute, x, z, out);
    let cx = out[0];
    let cz = out[1];
    flow.sampleDirection(flow.flee, x, z, out);
    const fx = out[0];
    const fz = out[1];

    if (mood === MOOD_GAWK) {
      // Gawkers do not walk. They edge backwards a little when it gets loud —
      // never enough to actually leave.
      const creep = clamp01((alarm - ALARM_GAWK) * 1.6) * 0.22;
      out[0] = fx * SPEED_WALK * creep;
      out[1] = fz * SPEED_WALK * creep;
      return;
    }

    const panic = clamp01((alarm - ALARM_GAWK) / Math.max(1e-3, ALARM_FLEE - ALARM_GAWK));
    if (mood === MOOD_FLEE) {
      // Committed: flee direction only. Blending in the commute here is what
      // makes a fleeing crowd look like it is running errands.
      cx = fx;
      cz = fz;
    } else {
      cx = cx * (1 - panic) + fx * panic;
      cz = cz * (1 - panic) + fz * panic;
    }

    const len = Math.sqrt(cx * cx + cz * cz);
    if (len < 1e-5) {
      // No field here (unreachable cell, or standing on the threat). Keep the
      // current heading rather than stopping dead — a stopped agent in a
      // panicking crowd is a rock in a river and reads as broken.
      const vx = agents.velX[i]!;
      const vz = agents.velZ[i]!;
      const vlen = Math.sqrt(vx * vx + vz * vz);
      if (vlen < 1e-5) {
        out[0] = 0;
        out[1] = 0;
      } else {
        const speed = mood === MOOD_FLEE ? SPEED_FLEE : SPEED_WALK;
        out[0] = (vx / vlen) * speed;
        out[1] = (vz / vlen) * speed;
      }
      return;
    }

    const speed =
      mood === MOOD_FLEE
        ? SPEED_FLEE * (0.85 + agents.stamina[i]! * 0.15)
        : SPEED_WALK * (0.85 + panic * 0.5);
    out[0] = (cx / len) * speed;
    out[1] = (cz / len) * speed;
  }

  /* ------------------------------------------------------------------ */
  /* Grid                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuild the broad phase for this frame.
   *
   * Civilians first so `slotAgent` can map a query hit straight back to an
   * agent index; other bodies (heroes, monsters, the player) follow with a -1
   * marker, which is all avoidance needs to know about them.
   */
  buildGrid(agents: CrowdAgents, bodies: readonly IAvoidBody[]): void {
    this.grid.beginFrame();
    for (let i = 0; i < agents.extent; i++) {
      if (agents.active[i] === 0) continue;
      const slot = this.grid.add(
        i,
        agents.posX[i]!,
        0,
        agents.posZ[i]!,
        agents.radius[i]!,
        LAYER_CIVILIAN
      );
      this.ensureSlotCapacity(slot);
      this.slotAgent[slot] = i;
    }
    for (const body of bodies) {
      const slot = this.grid.add(null, body.x, 0, body.z, body.radius, body.layer);
      this.ensureSlotCapacity(slot);
      this.slotAgent[slot] = -1;
    }
    this.grid.build();
  }

  private ensureSlotCapacity(slot: number): void {
    if (slot < this.slotAgent.length) return;
    // The grid grows geometrically; mirror it so the reverse map keeps pace.
    const bigger = new Int32Array(Math.max(slot + 1, this.slotAgent.length * 2)).fill(-1);
    bigger.set(this.slotAgent);
    this.slotAgent = bigger;
  }

  /* ------------------------------------------------------------------ */
  /* Avoidance                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * RVO-lite: sample candidate velocities, keep the one that is closest to
   * what we wanted and least likely to hit anybody.
   *
   * ORCA proper solves a linear program per agent per frame. That is the right
   * answer for a robot and the wrong one for sixteen background pedestrians on
   * a phone — it needs a half-plane per neighbour, an exact LP solver, and a
   * fallback for the infeasible case, all to produce a result that differs
   * from a twelve-sample search by centimetres nobody will ever see.
   *
   * The RECIPROCAL part is what stops the dance: each agent assumes the other
   * will take half the responsibility for avoiding, so the candidate is tested
   * against `2·v - vSelf - vOther` rather than `v - vOther`. Without it, two
   * agents approaching head-on each dodge fully, meet again, dodge back, and
   * oscillate down the street.
   */
  avoid(
    agents: CrowdAgents,
    i: number,
    preferred: [number, number],
    out: [number, number]
  ): boolean {
    const px = agents.posX[i]!;
    const pz = agents.posZ[i]!;
    const vx = agents.velX[i]!;
    const vz = agents.velZ[i]!;
    const radius = agents.radius[i]!;

    this.grid.queryRadius(px, 0, pz, AVOID_RADIUS, this.neighbours, AVOID_MASK);
    if (this.neighbours.length <= 1) {
      out[0] = preferred[0];
      out[1] = preferred[1];
      return false;
    }

    // Nearest few only. Beyond about eight neighbours the extra half-planes
    // are behind the ones already considered and change nothing.
    const count = Math.min(this.neighbours.length, AVOID_NEIGHBOURS + 1);
    const bestScore = this.scoreCandidate(
      preferred[0],
      preferred[1],
      preferred,
      px,
      pz,
      vx,
      vz,
      radius,
      count,
      i
    );
    let chosenX = preferred[0];
    let chosenZ = preferred[1];
    let chosen = bestScore;

    const prefLen = Math.sqrt(preferred[0] * preferred[0] + preferred[1] * preferred[1]);
    if (prefLen < 1e-4) {
      out[0] = preferred[0];
      out[1] = preferred[1];
      return false;
    }
    const baseAngle = Math.atan2(preferred[1], preferred[0]);

    for (let s = 0; s < RVO_SAMPLES; s++) {
      // Deterministic fan: alternating sides, widening, with two speed
      // multipliers. A random sample set would be marginally better spread and
      // would make the whole crowd non-reproducible.
      const step = (s >> 1) + 1;
      const side = (s & 1) === 0 ? 1 : -1;
      const angle = baseAngle + side * step * 0.26;
      const scale = step > 4 ? 0.55 : 1;
      const cx = Math.cos(angle) * prefLen * scale;
      const cz = Math.sin(angle) * prefLen * scale;
      const score = this.scoreCandidate(cx, cz, preferred, px, pz, vx, vz, radius, count, i);
      if (score < chosen) {
        chosen = score;
        chosenX = cx;
        chosenZ = cz;
      }
    }

    out[0] = chosenX;
    out[1] = chosenZ;
    return chosenX !== preferred[0] || chosenZ !== preferred[1];
  }

  /** Lower is better: deviation from the preference plus collision risk. */
  private scoreCandidate(
    cx: number,
    cz: number,
    preferred: [number, number],
    px: number,
    pz: number,
    vx: number,
    vz: number,
    radius: number,
    count: number,
    self: number
  ): number {
    const dx = cx - preferred[0];
    const dz = cz - preferred[1];
    let score = Math.sqrt(dx * dx + dz * dz);

    for (let n = 0; n < count; n++) {
      const slot = this.neighbours.at(n);
      const other = this.slotAgent[slot]!;
      if (other === self) continue;
      const ox = this.grid.getX(slot);
      const oz = this.grid.getZ(slot);
      const orad = this.grid.getRadius(slot);
      let ovx = 0;
      let ovz = 0;
      if (other >= 0) {
        ovx = this.agentsVelX(other);
        ovz = this.agentsVelZ(other);
      }
      // Reciprocal: we each take half the avoidance.
      const rvx = 2 * cx - vx - ovx;
      const rvz = 2 * cz - vz - ovz;
      const ttc = timeToCollision(ox - px, oz - pz, rvx, rvz, radius + orad);
      if (ttc < 0 || ttc > RVO_HORIZON) continue;
      // 1/ttc rather than (horizon - ttc): the penalty has to go to infinity
      // as contact approaches or a candidate that collides in 50 ms scores
      // barely worse than one that collides in 500.
      score += 1.6 / Math.max(ttc, 0.05);
    }
    return score;
  }

  /* ------------------------------------------------------------------ */
  /* Integration and constraints                                        */
  /* ------------------------------------------------------------------ */

  private velSource: CrowdAgents | undefined;

  private agentsVelX(index: number): number {
    return this.velSource?.velX[index] ?? 0;
  }

  private agentsVelZ(index: number): number {
    return this.velSource?.velZ[index] ?? 0;
  }

  /**
   * The whole per-frame movement pass.
   *
   * @param bodies Non-civilian colliders (heroes, monsters, the player).
   */
  update(
    agents: CrowdAgents,
    dt: number,
    alarmField: AlarmField,
    flow: FlowField,
    obstacles: ObstacleField,
    bodies: readonly IAvoidBody[]
  ): void {
    this.velSource = agents;
    this.report.containmentFixes = 0;
    this.report.containmentMetres = 0;
    this.report.avoidanceAdjustments = 0;
    this.report.minSeparation = Infinity;

    this.buildGrid(agents, bodies);

    const preferred: [number, number] = [0, 0];
    const chosen: [number, number] = [0, 0];
    const maxDelta = ACCELERATION * dt;

    for (let i = 0; i < agents.extent; i++) {
      if (agents.active[i] === 0) continue;
      const x = agents.posX[i]!;
      const z = agents.posZ[i]!;

      const alarm = alarmField.sample(x, z);
      agents.alarm[i] = alarm;
      if (alarm > agents.peakAlarm[i]!) agents.peakAlarm[i] = alarm;
      agents.moodTime[i] = agents.moodTime[i]! + dt;

      const threatDistance = flow.threatDistance(x, z);
      flow.sampleDirection(flow.flee, x, z, this.dirScratch);
      // No flee direction here means either a dead end or no threat at all.
      // The second case must not be read as "cornered", or a calm city would
      // fill up with people cowering at nothing.
      const canFlee =
        this.dirScratch[0] !== 0 || this.dirScratch[1] !== 0 || !flow.hasThreats;

      agents.setMood(i, this.chooseMood(agents, i, alarm, threatDistance, canFlee, dt));
      this.preferredVelocity(agents, i, flow, alarm, preferred);

      if (agents.tier[i] === TIER_NEAR) {
        if (this.avoid(agents, i, preferred, chosen)) this.report.avoidanceAdjustments++;
      } else {
        chosen[0] = preferred[0];
        chosen[1] = preferred[1];
      }

      // Bounded acceleration. A civilian who reverses direction instantly is
      // the single loudest tell that a crowd is a particle system.
      let vx = agents.velX[i]!;
      let vz = agents.velZ[i]!;
      let ddx = chosen[0] - vx;
      let ddz = chosen[1] - vz;
      const dlen = Math.sqrt(ddx * ddx + ddz * ddz);
      if (dlen > maxDelta) {
        const s = maxDelta / dlen;
        ddx *= s;
        ddz *= s;
      }
      vx += ddx;
      vz += ddz;
      agents.velX[i] = vx;
      agents.velZ[i] = vz;

      agents.posX[i] = x + vx * dt;
      agents.posZ[i] = z + vz * dt;
    }

    this.constrain(agents, obstacles);
    this.updateFacing(agents, flow, dt);
  }

  /**
   * Separation relaxation, then containment, alternating.
   *
   * Runs on the grid built at the start of the frame rather than rebuilding
   * between passes: displacements here are centimetres and the cells are 24 m,
   * so no agent can have left the cell its neighbours were gathered from.
   */
  private constrain(agents: CrowdAgents, obstacles: ObstacleField): void {
    for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
      for (let i = 0; i < agents.extent; i++) {
        if (agents.active[i] === 0) continue;
        const px = agents.posX[i]!;
        const pz = agents.posZ[i]!;
        const ri = agents.radius[i]!;
        this.grid.queryRadius(px, 0, pz, MIN_SEPARATION, this.neighbours, LAYER_CIVILIAN);
        for (let n = 0; n < this.neighbours.length; n++) {
          const other = this.slotAgent[this.neighbours.at(n)]!;
          // Each unordered pair is resolved once, by the lower index. Resolving
          // it twice doubles the correction and makes dense crowds explode.
          if (other <= i || other < 0 || agents.active[other] === 0) continue;
          let dx = agents.posX[other]! - agents.posX[i]!;
          let dz = agents.posZ[other]! - agents.posZ[i]!;
          const want = ri + agents.radius[other]!;
          let d = Math.sqrt(dx * dx + dz * dz);
          if (d >= want) continue;
          if (d < 1e-5) {
            // Exactly coincident (two agents spawned on the same slot). Split
            // them along a deterministic axis derived from their indices, not
            // a random one, or the crowd stops being reproducible.
            const angle = ((i * 37 + other * 17) % 628) / 100;
            dx = Math.cos(angle);
            dz = Math.sin(angle);
            d = 1;
          }
          const push = (want - d) * 0.5;
          const nx = (dx / d) * push;
          const nz = (dz / d) * push;
          agents.posX[i] = agents.posX[i]! - nx;
          agents.posZ[i] = agents.posZ[i]! - nz;
          agents.posX[other] = agents.posX[other]! + nx;
          agents.posZ[other] = agents.posZ[other]! + nz;
        }
      }

      for (let i = 0; i < agents.extent; i++) {
        if (agents.active[i] === 0) continue;
        this.scratch.x = agents.posX[i]!;
        this.scratch.z = agents.posZ[i]!;
        const moved = obstacles.resolve(this.scratch, agents.radius[i]!);
        if (moved > 0) {
          this.report.containmentFixes++;
          this.report.containmentMetres += moved;
          agents.posX[i] = this.scratch.x;
          agents.posZ[i] = this.scratch.z;
          // Kill the component of velocity that drove them into the wall, or
          // they grind along it accelerating into geometry all frame.
          agents.velX[i] = agents.velX[i]! * 0.2;
          agents.velZ[i] = agents.velZ[i]! * 0.2;
        }
      }
    }

    this.report.minSeparation = this.measureMinSeparation(agents);
  }

  /** Smallest centre distance between any live pair. O(n) via the grid. */
  measureMinSeparation(agents: CrowdAgents): number {
    let min = Infinity;
    for (let i = 0; i < agents.extent; i++) {
      if (agents.active[i] === 0) continue;
      this.grid.queryRadius(
        agents.posX[i]!,
        0,
        agents.posZ[i]!,
        MIN_SEPARATION * 2,
        this.neighbours,
        LAYER_CIVILIAN
      );
      for (let n = 0; n < this.neighbours.length; n++) {
        const other = this.slotAgent[this.neighbours.at(n)]!;
        if (other <= i || other < 0 || agents.active[other] === 0) continue;
        const dx = agents.posX[other]! - agents.posX[i]!;
        const dz = agents.posZ[other]! - agents.posZ[i]!;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < min) min = d;
      }
    }
    return min;
  }

  /**
   * Turn towards where they are going — or, when gawking, towards what they
   * are looking at.
   *
   * The gawk case is the one that matters visually. A crowd whose heads are
   * all turned the same way tells the player where the monster is from behind,
   * through a building, at any distance. It is the cheapest piece of world
   * communication in the whole system.
   */
  private updateFacing(agents: CrowdAgents, flow: FlowField, dt: number): void {
    const dir: [number, number] = [0, 0];
    const maxTurn = TURN_RATE * dt;
    for (let i = 0; i < agents.extent; i++) {
      if (agents.active[i] === 0) continue;
      const mood = agents.mood[i]!;
      let tx: number;
      let tz: number;
      if (mood === MOOD_GAWK || mood === MOOD_COWER) {
        // The flee field points away from the threat; face back down it.
        flow.sampleDirection(flow.flee, agents.posX[i]!, agents.posZ[i]!, dir);
        tx = -dir[0];
        tz = -dir[1];
        if (mood === MOOD_COWER) {
          // Cowering turns away, shoulder first.
          tx = -tx;
          tz = -tz;
        }
      } else {
        tx = agents.velX[i]!;
        tz = agents.velZ[i]!;
      }
      const len = Math.sqrt(tx * tx + tz * tz);
      if (len < 1e-4) continue;
      // Characters face -Z, so the yaw that looks along (tx, tz) is
      // atan2(tx, -tz) — not atan2(tz, tx).
      const want = Math.atan2(tx, -tz);
      const current = agents.yaw[i]!;
      let delta = want - current;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      agents.yaw[i] = current + clamp(delta, -maxTurn, maxTurn);
    }
  }
}

/**
 * Time until two moving discs touch, or -1 when they never do.
 *
 * `relPos` is other-minus-self and `relVel` is the RECIPROCAL relative
 * velocity (see `avoid`). Already-overlapping pairs return 0, which makes the
 * penalty infinite and any candidate that maintains the overlap unattractive.
 */
export function timeToCollision(
  rx: number,
  rz: number,
  vx: number,
  vz: number,
  radius: number
): number {
  const c = rx * rx + rz * rz - radius * radius;
  if (c <= 0) return 0;
  const a = vx * vx + vz * vz;
  if (a < 1e-8) return -1;
  // `relPos . relVel` is negative exactly when the gap is closing. `relPos`
  // points at the other disc and `relVel` is the other's motion relative to
  // ours, so a positive dot product means it is moving away.
  const b = rx * vx + rz * vz;
  if (b >= 0) return -1;
  const discriminant = b * b - a * c;
  if (discriminant <= 0) return -1;
  return (-b - Math.sqrt(discriminant)) / a;
}
