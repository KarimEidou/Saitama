/**
 * THE SPRITE LAYER — every particle in the game, in one draw call.
 *
 * Dust plumes, cloud parting, hit sparks, impact flashes, embers, debris
 * streaks and the shockwave's dust front are all entries in the arrays below.
 * They differ by tile, tint, orientation mode and blend weighting, never by
 * material — because a second material would be a second draw call and,
 * potentially, a second shader program the budget cannot pay for.
 *
 * ── STRUCTURE OF ARRAYS, NOT ARRAY OF STRUCTURES ───────────────────────────
 * Particles live in parallel typed arrays with a live prefix `[0, count)`.
 * Death is a swap-remove. Nothing is ever allocated after construction: no
 * particle objects, no vectors, no closures, no `{ start, count }` update
 * ranges — those are pre-built and mutated in place. A garbage collection
 * during a punch is a visible hitch, and the punch is the entire game.
 *
 * ── WHY THE DEPTH SORT IS A COUNTING SORT ──────────────────────────────────
 * Instanced draws render in buffer order, so back-to-front ordering has to be
 * baked into the buffer itself. A comparator sort would allocate (and cost
 * O(n log n) on up to 1800 particles every frame); a counting sort into a
 * fixed number of depth buckets is O(n), allocation-free, and produces
 * ordering errors only between particles within one bucket — which, for
 * soft dust that does not write depth, is invisible.
 */

import * as THREE from 'three';
import { SpriteMode, type IVFXTierProfile } from './constants';

/** One particle's spawn parameters. Reused by callers; never retained here. */
export interface ISpriteParams {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Diameter in metres at birth. */
  size0: number;
  /** Diameter in metres at death. Dust grows; sparks shrink. */
  size1: number;
  /** Seconds. */
  life: number;
  /** Index into the bound atlas. */
  tile: number;
  /** One of `SpriteMode`. */
  mode: number;
  r: number;
  g: number;
  b: number;
  /** Peak alpha, 0..1. */
  alpha: number;
  /** 0 = alpha composited, 1 = purely additive. Anything between is valid. */
  additive: number;
  /** 0..1 blend into the fake volumetric shading. Dust wants 1, sparks 0. */
  lit: number;
  /** Velocity damping per second. 0 = ballistic. */
  drag: number;
  /** Metres per second squared on Y. Negative falls, positive is buoyant. */
  gravity: number;
  /** Radians. */
  rot: number;
  /** Radians per second. */
  rotVel: number;
  /** Metres of streak per m/s of speed. Only used by `SpriteMode.Streak`. */
  stretch: number;
  /** Fraction of life spent ramping alpha in. Keep small for impacts. */
  fadeIn: number;
  /** Wander acceleration amplitude, m/s². Gives plumes their roll. */
  turbulence: number;
  /** Erosion reached at death. Above 1 guarantees a clean dissolve. */
  erode: number;
  /** 0 = particle shading, 1 = decal shading. */
  style: number;
  /** Y-axis multiplier for `SpriteMode.Surface` quads. */
  aspect: number;
  /** 0..1 phase offset, so identical particles do not wander in lockstep. */
  seed: number;
}

/** A zeroed parameter block, for callers to fill and reuse. */
export function createSpriteParams(): ISpriteParams {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    size0: 1,
    size1: 1,
    life: 1,
    tile: 0,
    mode: SpriteMode.Billboard,
    r: 1,
    g: 1,
    b: 1,
    alpha: 1,
    additive: 0,
    lit: 0,
    drag: 0,
    gravity: 0,
    rot: 0,
    rotVel: 0,
    stretch: 0,
    fadeIn: 0.06,
    turbulence: 0,
    erode: 1.05,
    style: 0,
    aspect: 1,
    seed: 0,
  };
}

const FLOATS_PER_INSTANCE = 4;

export class SpriteLayer {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;

  /** Particles rejected because the buffer was full, since construction. */
  private droppedCount = 0;

  private count = 0;

  /* Simulation state — parallel arrays, live prefix [0, count). */
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly rot: Float32Array;
  private readonly rotVel: Float32Array;
  private readonly colR: Float32Array;
  private readonly colG: Float32Array;
  private readonly colB: Float32Array;
  private readonly alpha: Float32Array;
  private readonly additive: Float32Array;
  private readonly lit: Float32Array;
  private readonly drag: Float32Array;
  private readonly gravity: Float32Array;
  private readonly stretch: Float32Array;
  private readonly fadeIn: Float32Array;
  private readonly turbulence: Float32Array;
  private readonly erode: Float32Array;
  private readonly aspect: Float32Array;
  private readonly seed: Float32Array;
  private readonly tile: Float32Array;
  private readonly mode: Float32Array;
  private readonly style: Float32Array;

  /* Sorting scratch. */
  private readonly depth: Float32Array;
  private readonly bucketOf: Int32Array;
  private readonly bucketCount: Int32Array;
  private readonly order: Int32Array;
  private readonly buckets: number;

  /* GPU-facing instance data. */
  private readonly iPosSize: THREE.InstancedBufferAttribute;
  private readonly iColor: THREE.InstancedBufferAttribute;
  private readonly iParams: THREE.InstancedBufferAttribute;
  private readonly iMotion: THREE.InstancedBufferAttribute;
  private readonly iShade: THREE.InstancedBufferAttribute;
  private readonly attributes: readonly THREE.InstancedBufferAttribute[];
  /**
   * One persistent `{ start, count }` per attribute. three's `addUpdateRange`
   * allocates an object per call; these are pushed back and mutated instead,
   * which keeps the per-frame allocation at literally zero.
   */
  private readonly ranges: { start: number; count: number }[];

  private readonly geometry: THREE.InstancedBufferGeometry;

  constructor(
    geometry: THREE.InstancedBufferGeometry,
    material: THREE.Material,
    profile: IVFXTierProfile,
    capacity = profile.spriteCapacity,
    name = 'vfx.sprites'
  ) {
    this.capacity = capacity;
    this.buckets = profile.sortBuckets;
    this.geometry = geometry;

    const f = (): Float32Array => new Float32Array(capacity);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.size0 = f();
    this.size1 = f();
    this.age = f();
    this.life = f();
    this.rot = f();
    this.rotVel = f();
    this.colR = f();
    this.colG = f();
    this.colB = f();
    this.alpha = f();
    this.additive = f();
    this.lit = f();
    this.drag = f();
    this.gravity = f();
    this.stretch = f();
    this.fadeIn = f();
    this.turbulence = f();
    this.erode = f();
    this.aspect = f();
    this.seed = f();
    this.tile = f();
    this.mode = f();
    this.style = f();

    this.depth = f();
    this.bucketOf = new Int32Array(capacity);
    this.bucketCount = new Int32Array(this.buckets);
    this.order = new Int32Array(capacity);

    const attribute = (): THREE.InstancedBufferAttribute =>
      new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * FLOATS_PER_INSTANCE),
        FLOATS_PER_INSTANCE
      );
    this.iPosSize = attribute();
    this.iColor = attribute();
    this.iParams = attribute();
    this.iMotion = attribute();
    this.iShade = attribute();
    this.attributes = [this.iPosSize, this.iColor, this.iParams, this.iMotion, this.iShade];
    this.ranges = this.attributes.map(() => ({ start: 0, count: 0 }));

    for (const buffer of this.attributes) buffer.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iPosSize', this.iPosSize);
    geometry.setAttribute('iColor', this.iColor);
    geometry.setAttribute('iParams', this.iParams);
    geometry.setAttribute('iMotion', this.iMotion);
    geometry.setAttribute('iShade', this.iShade);
    geometry.instanceCount = 0;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = name;
    // Every position lives in instance data, so three's culling — which reads
    // the geometry's bounds — would cull the whole layer the moment the origin
    // left the frustum.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 3000;
  }

  get activeCount(): number {
    return this.count;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get free(): number {
    return this.capacity - this.count;
  }

  /**
   * Add a particle.
   *
   * @returns false when the buffer is full. A FULL buffer is a normal
   *          condition during a collapse, not an error — the caller should
   *          stop emitting rather than grow anything.
   */
  emit(p: ISpriteParams): boolean {
    const i = this.count;
    if (i >= this.capacity) {
      this.droppedCount++;
      return false;
    }
    this.count++;

    this.px[i] = p.x;
    this.py[i] = p.y;
    this.pz[i] = p.z;
    this.vx[i] = p.vx;
    this.vy[i] = p.vy;
    this.vz[i] = p.vz;
    this.size0[i] = p.size0;
    this.size1[i] = p.size1;
    this.age[i] = 0;
    this.life[i] = Math.max(1e-3, p.life);
    this.rot[i] = p.rot;
    this.rotVel[i] = p.rotVel;
    this.colR[i] = p.r;
    this.colG[i] = p.g;
    this.colB[i] = p.b;
    this.alpha[i] = p.alpha;
    this.additive[i] = p.additive;
    this.lit[i] = p.lit;
    this.drag[i] = p.drag;
    this.gravity[i] = p.gravity;
    this.stretch[i] = p.stretch;
    this.fadeIn[i] = Math.max(1e-4, p.fadeIn);
    this.turbulence[i] = p.turbulence;
    this.erode[i] = p.erode;
    this.aspect[i] = p.aspect;
    this.seed[i] = p.seed;
    this.tile[i] = p.tile;
    this.mode[i] = p.mode;
    this.style[i] = p.style;
    return true;
  }

  /**
   * Integrate one step and retire dead particles.
   *
   * @param dt SCALED seconds. Effects must slow with the world during the
   *           renderer's impact freeze — that hang is the moment the player
   *           actually looks at the frame, and a plume that kept moving at
   *           full speed through it would read as a bug.
   */
  update(dt: number): void {
    if (dt <= 0) return;
    let i = 0;
    while (i < this.count) {
      const age = this.age[i]! + dt;
      if (age >= this.life[i]!) {
        this.swapRemove(i);
        continue;
      }
      this.age[i] = age;

      // Implicit-ish damping: stable at any dt, one divide, no `exp`.
      const damping = 1 / (1 + this.drag[i]! * dt);
      let vx = this.vx[i]! * damping;
      let vy = this.vy[i]! * damping;
      let vz = this.vz[i]! * damping;

      vy += this.gravity[i]! * dt;

      const turbulence = this.turbulence[i]!;
      if (turbulence !== 0) {
        // Cheap deterministic wander. Three incommensurate frequencies read as
        // curl without a noise texture or a lookup.
        const phase = this.seed[i]! * 6.2831853;
        vx += Math.sin(age * 1.7 + phase) * turbulence * dt;
        vy += Math.sin(age * 1.3 + phase * 1.7 + 2.1) * turbulence * 0.55 * dt;
        vz += Math.cos(age * 1.9 + phase * 2.3 + 4.2) * turbulence * dt;
      }

      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.px[i] = this.px[i]! + vx * dt;
      this.py[i] = this.py[i]! + vy * dt;
      this.pz[i] = this.pz[i]! + vz * dt;
      this.rot[i] = this.rot[i]! + this.rotVel[i]! * dt;
      i++;
    }
  }

  /**
   * Depth-sort and upload.
   *
   * Split from `update` on purpose: simulation is a game-state concern that
   * runs whether or not anything is on screen, while this is a render concern
   * that needs the camera and must run after everything has finished emitting
   * for the frame.
   */
  prepare(cameraPosition: THREE.Vector3, cameraForward: THREE.Vector3): void {
    const n = this.count;
    this.geometry.instanceCount = n;
    if (n === 0) {
      for (let a = 0; a < this.attributes.length; a++) {
        const attribute = this.attributes[a]!;
        const range = this.ranges[a]!;
        range.start = 0;
        range.count = 0;
        attribute.clearUpdateRanges();
        attribute.updateRanges.push(range);
        attribute.needsUpdate = true;
      }
      return;
    }

    /* --- 1. view depth ------------------------------------------------- */
    let minDepth = Number.POSITIVE_INFINITY;
    let maxDepth = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const d =
        (this.px[i]! - cameraPosition.x) * cameraForward.x +
        (this.py[i]! - cameraPosition.y) * cameraForward.y +
        (this.pz[i]! - cameraPosition.z) * cameraForward.z;
      this.depth[i] = d;
      if (d < minDepth) minDepth = d;
      if (d > maxDepth) maxDepth = d;
    }

    /* --- 2. counting sort, far bucket first ---------------------------- */
    const buckets = this.buckets;
    this.bucketCount.fill(0);
    const span = maxDepth - minDepth;
    const scale = span > 1e-4 ? (buckets - 1) / span : 0;
    for (let i = 0; i < n; i++) {
      // Invert so bucket 0 holds the FARTHEST particles: painter's order.
      const normalized = (this.depth[i]! - minDepth) * scale;
      let bucket = Math.floor(buckets - 1 - normalized);
      if (bucket < 0) bucket = 0;
      else if (bucket >= buckets) bucket = buckets - 1;
      this.bucketOf[i] = bucket;
      this.bucketCount[bucket] = this.bucketCount[bucket]! + 1;
    }
    let running = 0;
    for (let b = 0; b < buckets; b++) {
      const c = this.bucketCount[b]!;
      this.bucketCount[b] = running;
      running += c;
    }
    for (let i = 0; i < n; i++) {
      const bucket = this.bucketOf[i]!;
      this.order[this.bucketCount[bucket]!] = i;
      this.bucketCount[bucket] = this.bucketCount[bucket]! + 1;
    }

    /* --- 3. gather into instance buffers -------------------------------- */
    const posSize = this.iPosSize.array as Float32Array;
    const color = this.iColor.array as Float32Array;
    const params = this.iParams.array as Float32Array;
    const motion = this.iMotion.array as Float32Array;
    const shade = this.iShade.array as Float32Array;

    for (let slot = 0; slot < n; slot++) {
      const i = this.order[slot]!;
      const t = this.age[i]! / this.life[i]!;
      const o = slot * 4;

      // Puffs expand fast then settle; a linear ramp reads as a balloon.
      const grow = Math.pow(t, 0.6);
      posSize[o] = this.px[i]!;
      posSize[o + 1] = this.py[i]!;
      posSize[o + 2] = this.pz[i]!;
      posSize[o + 3] = this.size0[i]! + (this.size1[i]! - this.size0[i]!) * grow;

      const ramp = t < this.fadeIn[i]! ? t / this.fadeIn[i]! : 1;
      color[o] = this.colR[i]!;
      color[o + 1] = this.colG[i]!;
      color[o + 2] = this.colB[i]!;
      color[o + 3] = this.alpha[i]! * ramp * (1 - t * t * 0.5);

      params[o] = this.rot[i]!;
      params[o + 1] = this.tile[i]!;
      params[o + 2] = this.additive[i]!;
      // Erosion is what dissolves the particle. Slightly super-unit at death
      // so the last frame is empty rather than a visible pop.
      params[o + 3] = Math.pow(t, 0.85) * this.erode[i]!;

      const isSurface = this.mode[i]! === SpriteMode.Surface;
      motion[o] = this.vx[i]!;
      motion[o + 1] = this.vy[i]!;
      motion[o + 2] = this.vz[i]!;
      motion[o + 3] = isSurface ? this.aspect[i]! : this.stretch[i]!;

      shade[o] = this.lit[i]!;
      shade[o + 1] = this.seed[i]!;
      shade[o + 2] = this.mode[i]!;
      shade[o + 3] = this.style[i]!;
    }

    const floats = n * FLOATS_PER_INSTANCE;
    for (let a = 0; a < this.attributes.length; a++) {
      const attribute = this.attributes[a]!;
      const range = this.ranges[a]!;
      range.start = 0;
      range.count = floats;
      attribute.clearUpdateRanges();
      attribute.updateRanges.push(range);
      attribute.needsUpdate = true;
    }
  }

  /** Retire every particle. */
  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
  }

  /**
   * Sum of the whole live state, for determinism tests.
   *
   * Deliberately order-sensitive and position-sensitive: two runs that spawned
   * the same particles in a different order must NOT match, because that is a
   * real determinism failure.
   */
  checksum(): number {
    let h = 2166136261;
    // Quantise before hashing: identical maths on two devices can still differ
    // in the last mantissa bit, and this is a determinism check for the
    // SIMULATION, not for IEEE-754.
    const mix = (value: number): void => {
      h ^= Math.round(value * 1024) | 0;
      h = Math.imul(h, 16777619);
    };
    for (let i = 0; i < this.count; i++) {
      mix(this.px[i]!);
      mix(this.py[i]!);
      mix(this.pz[i]!);
      mix(this.vx[i]!);
      mix(this.vy[i]!);
      mix(this.vz[i]!);
      mix(this.age[i]!);
      mix(this.tile[i]!);
    }
    return h >>> 0;
  }

  dispose(): void {
    this.geometry.dispose();
  }

  private swapRemove(index: number): void {
    const last = this.count - 1;
    if (index !== last) {
      this.px[index] = this.px[last]!;
      this.py[index] = this.py[last]!;
      this.pz[index] = this.pz[last]!;
      this.vx[index] = this.vx[last]!;
      this.vy[index] = this.vy[last]!;
      this.vz[index] = this.vz[last]!;
      this.size0[index] = this.size0[last]!;
      this.size1[index] = this.size1[last]!;
      this.age[index] = this.age[last]!;
      this.life[index] = this.life[last]!;
      this.rot[index] = this.rot[last]!;
      this.rotVel[index] = this.rotVel[last]!;
      this.colR[index] = this.colR[last]!;
      this.colG[index] = this.colG[last]!;
      this.colB[index] = this.colB[last]!;
      this.alpha[index] = this.alpha[last]!;
      this.additive[index] = this.additive[last]!;
      this.lit[index] = this.lit[last]!;
      this.drag[index] = this.drag[last]!;
      this.gravity[index] = this.gravity[last]!;
      this.stretch[index] = this.stretch[last]!;
      this.fadeIn[index] = this.fadeIn[last]!;
      this.turbulence[index] = this.turbulence[last]!;
      this.erode[index] = this.erode[last]!;
      this.aspect[index] = this.aspect[last]!;
      this.seed[index] = this.seed[last]!;
      this.tile[index] = this.tile[last]!;
      this.mode[index] = this.mode[last]!;
      this.style[index] = this.style[last]!;
    }
    this.count = last;
  }
}
