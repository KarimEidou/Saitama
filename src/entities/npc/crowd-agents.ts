/**
 * CROWD STORAGE — 250 civilians as fourteen typed arrays
 *
 * Structure of arrays, not an array of objects, and not because "SoA is
 * faster" in the abstract. The steering pass touches `posX/posZ/velX/velZ` for
 * every agent and nothing else; the mood pass touches `alarm/mood/bravado`;
 * the render pass touches `posX/posZ/yaw/archetype/palette/timeOffset`. With
 * objects, each of those walks the whole 250-object heap and drags in every
 * field it does not want. With arrays, each pass streams exactly the bytes it
 * reads.
 *
 * The second reason matters more: an `InstancedMesh` wants its per-instance
 * data as contiguous floats anyway, so the render pass is a copy out of these
 * arrays rather than a gather across 250 objects.
 *
 * ── EVERY TRAIT IS DERIVED FROM ONE SEED ──────────────────────────────────
 * Body archetype, wardrobe, walking pace, animation phase and — the important
 * one — BRAVADO all come out of `createRng(seed).derive(label)`. Two runs with
 * the same world seed therefore populate the same street with the same people
 * making the same decisions, which is what makes the determinism test possible
 * at all. `Math.random` appears nowhere in this system.
 */

import { clamp01, createRng, type IRandom } from '@/util';
import type { EntityId } from '@/types';
import {
  AGENT_RADIUS,
  CIVILIAN_HEALTH,
  CROWD_ARCHETYPES,
  CROWD_PALETTES,
  MID_CAP,
  NEAR_CAP,
} from './constants';
import type { CivilianMood, CrowdTier } from './types';

/** Mood as stored. Order matches `MOOD_NAMES`. */
export const MOOD_COMMUTE = 0;
export const MOOD_GAWK = 1;
export const MOOD_FLEE = 2;
export const MOOD_COWER = 3;
export const MOOD_DOWN = 4;

/** Index-to-name, for stats and debugging. */
export const MOOD_NAMES: readonly CivilianMood[] = ['commute', 'gawk', 'flee', 'cower', 'down'];

/** Tier as stored. */
export const TIER_MID = 0;
export const TIER_NEAR = 1;

/** Capacity: every mid agent plus every near agent may exist at once. */
const CAPACITY = MID_CAP + NEAR_CAP;

export class CrowdAgents {
  readonly capacity = CAPACITY;

  /* ---- kinematics ---- */
  readonly posX = new Float32Array(CAPACITY);
  readonly posZ = new Float32Array(CAPACITY);
  readonly velX = new Float32Array(CAPACITY);
  readonly velZ = new Float32Array(CAPACITY);
  /** Facing, radians. Y-up, 0 looks down -Z like every other entity. */
  readonly yaw = new Float32Array(CAPACITY);
  readonly radius = new Float32Array(CAPACITY);

  /* ---- identity ---- */
  readonly seed = new Uint32Array(CAPACITY);
  readonly archetype = new Uint8Array(CAPACITY);
  readonly palette = new Uint8Array(CAPACITY);
  /** Metres. Read from the archetype's build; scales gait and eye height. */
  readonly height = new Float32Array(CAPACITY);

  /* ---- behaviour ---- */
  readonly mood = new Uint8Array(CAPACITY);
  readonly tier = new Uint8Array(CAPACITY);
  /**
   * 0 = bolts at the first sign of trouble, 1 = keeps filming while the
   * building comes down. This one scalar is most of the crowd's personality.
   */
  readonly bravado = new Float32Array(CAPACITY);
  /** Seconds of sprint left before the legs give out. */
  readonly stamina = new Float32Array(CAPACITY);
  /** Alarm sampled this frame. */
  readonly alarm = new Float32Array(CAPACITY);
  /** Highest alarm this agent has ever stood in. Gates the SAVED credit. */
  readonly peakAlarm = new Float32Array(CAPACITY);
  /** Which commute goal set this agent is heading for: 0 = A, 1 = B. */
  readonly goalPhase = new Uint8Array(CAPACITY);
  /** Seconds in the current mood. Stops single-frame mood flicker. */
  readonly moodTime = new Float32Array(CAPACITY);

  /* ---- health ---- */
  readonly health = new Float32Array(CAPACITY);
  readonly maxHealth = new Float32Array(CAPACITY);

  /* ---- presentation ---- */
  /** Seconds added to the shared VAT clock. What de-synchronises the crowd. */
  readonly timeOffset = new Float32Array(CAPACITY);
  /** Per-agent playback rate. Nobody walks at exactly the reference cadence. */
  readonly rate = new Float32Array(CAPACITY);

  readonly active = new Uint8Array(CAPACITY);
  private readonly ids: EntityId[] = new Array<EntityId>(CAPACITY).fill('');

  /** Free slots, most-recently-freed first. */
  private readonly free: number[] = [];
  private used = 0;
  private highWater = 0;
  private spawnCounter = 0;

  constructor() {
    for (let i = CAPACITY - 1; i >= 0; i--) this.free.push(i);
  }

  /** Live agents. */
  get count(): number {
    return this.used;
  }

  /** Highest slot ever occupied. Iterate `[0, extent)` and skip inactive. */
  get extent(): number {
    return this.highWater;
  }

  /** Stable id of a slot. */
  idOf(index: number): EntityId {
    return this.ids[index]!;
  }

  /** Named mood of a slot. */
  moodOf(index: number): CivilianMood {
    return MOOD_NAMES[this.mood[index]!]!;
  }

  /** Named tier of a slot. */
  tierOf(index: number): CrowdTier {
    return this.tier[index] === TIER_NEAR ? 'near' : 'mid';
  }

  /**
   * Take a slot and populate it deterministically from a seed.
   *
   * @returns The slot index, or -1 when the crowd is full. Callers must handle
   *   -1: the cap is a budget, and silently growing past it is how a crowd
   *   system becomes the reason a phone drops to 20 fps in a boss fight.
   */
  spawn(seed: number, x: number, z: number, yaw: number, tier: number): number {
    const index = this.free.pop();
    if (index === undefined) return -1;
    this.used++;
    if (index >= this.highWater) this.highWater = index + 1;

    const rng = createRng(seed >>> 0).derive('civilian-traits');
    this.seed[index] = seed >>> 0;
    this.ids[index] = `civ-${(this.spawnCounter++).toString(36)}-${(seed >>> 0).toString(36)}`;
    this.active[index] = 1;
    this.tier[index] = tier;

    this.posX[index] = x;
    this.posZ[index] = z;
    this.velX[index] = 0;
    this.velZ[index] = 0;
    this.yaw[index] = yaw;
    this.radius[index] = AGENT_RADIUS;

    this.archetype[index] = rng.int(0, CROWD_ARCHETYPES - 1);
    this.palette[index] = rng.int(0, CROWD_PALETTES - 1);
    this.height[index] = 1.7;

    this.mood[index] = MOOD_COMMUTE;
    this.moodTime[index] = 0;
    // Beta-ish shape from two uniforms: most people are somewhere in the
    // middle, a few are cowards and a few will absolutely stand in the street
    // filming a demon-level monster. A flat uniform gives an implausible
    // number of extremists at both ends.
    this.bravado[index] = clamp01((rng.next() + rng.next()) * 0.5 + rng.range(-0.12, 0.12));
    this.stamina[index] = 1;
    this.alarm[index] = 0;
    this.peakAlarm[index] = 0;
    this.goalPhase[index] = rng.bool() ? 1 : 0;

    this.health[index] = CIVILIAN_HEALTH;
    this.maxHealth[index] = CIVILIAN_HEALTH;

    this.timeOffset[index] = rng.next() * 8;
    this.rate[index] = rng.range(0.88, 1.14);
    return index;
  }

  /** Release a slot back to the pool. */
  despawn(index: number): void {
    if (this.active[index] === 0) return;
    this.active[index] = 0;
    this.ids[index] = '';
    this.used--;
    this.free.push(index);
  }

  /** Release everything. */
  clear(): void {
    for (let i = 0; i < this.highWater; i++) if (this.active[i] === 1) this.despawn(i);
    this.highWater = 0;
    this.spawnCounter = 0;
  }

  /** Set a mood, resetting the dwell timer only on an actual change. */
  setMood(index: number, mood: number): void {
    if (this.mood[index] === mood) return;
    this.mood[index] = mood;
    this.moodTime[index] = 0;
  }

  /**
   * Order-independent hash of the whole crowd, for determinism assertions.
   *
   * Positions are quantised to a millimetre and velocities to a millimetre per
   * second before hashing. Two runs that agree to a millimetre are the same
   * run; demanding bit-equal floats after thousands of accumulated adds tests
   * the FPU's rounding mode, not the simulation.
   */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number): void => {
      h = Math.imul(h ^ (v | 0), 0x01000193) >>> 0;
    };
    for (let i = 0; i < this.highWater; i++) {
      if (this.active[i] === 0) continue;
      mix(i);
      mix(Math.round(this.posX[i]! * 1000));
      mix(Math.round(this.posZ[i]! * 1000));
      mix(Math.round(this.velX[i]! * 1000));
      mix(Math.round(this.velZ[i]! * 1000));
      mix(Math.round(this.yaw[i]! * 1000));
      mix(this.mood[i]!);
      mix(this.tier[i]!);
      mix(Math.round(this.health[i]! * 100));
    }
    return h >>> 0;
  }
}

/**
 * Deterministic stream for one civilian's per-frame decisions.
 *
 * Derived from the agent's own seed and a label, never from a shared
 * generator: the crowd is iterated in slot order, agents spawn and despawn as
 * the player moves, and a shared stream would make agent 7's coin flip depend
 * on whether agent 3 happened to be alive that frame.
 */
export function agentRng(seed: number, label: string): IRandom {
  return createRng(seed >>> 0).derive(label);
}
