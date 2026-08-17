/**
 * THE SHOCKWAVE LAYER — the signature effect.
 *
 * Every live shell in the game, in one draw call and one shader program. A
 * shell is a handful of numbers; its geometry is computed per vertex, so a
 * 22-degree punch cone reaching 40 metres and a 360-degree ring reaching 180
 * are the same buffer with different instance data.
 *
 * ── THE EXPANSION CURVE IS THE EFFECT ──────────────────────────────────────
 * `radius = range * (START + (1 - START) * t^0.42)`.
 *
 * Two decisions are baked into that line and both matter more than any shader
 * detail:
 *
 *   START = 0.10   The wave is born already ten per cent of the way out. A
 *                  ring that starts at zero radius spends its first frames as
 *                  a dot — and those are exactly the frames the renderer's
 *                  90 ms impact freeze holds on screen. The punch has to look
 *                  like it has already happened at the instant it lands.
 *   t^0.42         Front-loaded. Over half the distance is covered in the
 *                  first fifth of the life, then it decelerates. Linear
 *                  expansion reads as an inflating balloon; this reads as a
 *                  release of pressure.
 */

import * as THREE from 'three';
import type { IVFXTierProfile } from './constants';
import { excludeFromOverridePasses } from './geometry';

/** Parameters for one shell. Reused by callers; never retained. */
export interface IShockwaveParams {
  x: number;
  y: number;
  z: number;
  /** Unit propagation direction. */
  dx: number;
  dy: number;
  dz: number;
  /** Cone half-angle in radians. `Math.PI` is omnidirectional. */
  halfAngle: number;
  /** Final radius in metres. */
  range: number;
  /** Seconds to reach `range`. */
  life: number;
  /** 0..1 brightness and opacity multiplier. */
  intensity: number;
  /** 0 = ground skirt, 1 = axial air cone. */
  kind: number;
  r: number;
  g: number;
  b: number;
  /** Higher = a narrower, harder pressure edge. */
  sharpness: number;
  /** Radial offset between the red and blue edge samples: the refraction fringe. */
  chroma: number;
  /** Height the trailing dust wall lifts to, as a fraction of the radius. */
  loft: number;
  /** Fraction of `range` the shell is born at. */
  start: number;
  /** 0..1, decorrelates the force-line hashing between shells. */
  seed: number;
}

export function createShockwaveParams(): IShockwaveParams {
  return {
    x: 0,
    y: 0,
    z: 0,
    dx: 0,
    dy: 0,
    dz: 1,
    halfAngle: Math.PI,
    range: 40,
    life: 0.8,
    intensity: 1,
    kind: 0,
    r: 0.87,
    g: 0.92,
    b: 1,
    sharpness: 1,
    chroma: 0.02,
    loft: 0.16,
    start: 0.1,
    seed: 0,
  };
}

const FLOATS_PER_INSTANCE = 4;

export class ShockwaveLayer {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;

  private count = 0;

  private readonly ox: Float32Array;
  private readonly oy: Float32Array;
  private readonly oz: Float32Array;
  private readonly dx: Float32Array;
  private readonly dy: Float32Array;
  private readonly dz: Float32Array;
  private readonly halfAngle: Float32Array;
  private readonly range: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly intensity: Float32Array;
  private readonly kind: Float32Array;
  private readonly colR: Float32Array;
  private readonly colG: Float32Array;
  private readonly colB: Float32Array;
  private readonly sharpness: Float32Array;
  private readonly chroma: Float32Array;
  private readonly loft: Float32Array;
  private readonly start: Float32Array;
  private readonly seed: Float32Array;
  /** Monotonic id per slot, so a stale handle can be detected after reuse. */
  private readonly generation: Int32Array;

  private readonly iOrigin: THREE.InstancedBufferAttribute;
  private readonly iAxis: THREE.InstancedBufferAttribute;
  private readonly iShape: THREE.InstancedBufferAttribute;
  private readonly iStyle: THREE.InstancedBufferAttribute;
  private readonly iMode: THREE.InstancedBufferAttribute;
  private readonly attributes: readonly THREE.InstancedBufferAttribute[];
  private readonly ranges: { start: number; count: number }[];
  private readonly geometry: THREE.InstancedBufferGeometry;

  constructor(
    geometry: THREE.InstancedBufferGeometry,
    material: THREE.Material,
    profile: IVFXTierProfile
  ) {
    this.capacity = profile.shockwaveCapacity;
    this.geometry = geometry;

    const f = (): Float32Array => new Float32Array(this.capacity);
    this.ox = f();
    this.oy = f();
    this.oz = f();
    this.dx = f();
    this.dy = f();
    this.dz = f();
    this.halfAngle = f();
    this.range = f();
    this.age = f();
    this.life = f();
    this.intensity = f();
    this.kind = f();
    this.colR = f();
    this.colG = f();
    this.colB = f();
    this.sharpness = f();
    this.chroma = f();
    this.loft = f();
    this.start = f();
    this.seed = f();
    this.generation = new Int32Array(this.capacity);

    const attribute = (): THREE.InstancedBufferAttribute =>
      new THREE.InstancedBufferAttribute(
        new Float32Array(this.capacity * FLOATS_PER_INSTANCE),
        FLOATS_PER_INSTANCE
      );
    this.iOrigin = attribute();
    this.iAxis = attribute();
    this.iShape = attribute();
    this.iStyle = attribute();
    this.iMode = attribute();
    this.attributes = [this.iOrigin, this.iAxis, this.iShape, this.iStyle, this.iMode];
    this.ranges = this.attributes.map(() => ({ start: 0, count: 0 }));
    for (const buffer of this.attributes) buffer.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('iOrigin', this.iOrigin);
    geometry.setAttribute('iAxis', this.iAxis);
    geometry.setAttribute('iShape', this.iShape);
    geometry.setAttribute('iStyle', this.iStyle);
    geometry.setAttribute('iMode', this.iMode);
    geometry.instanceCount = 0;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'vfx.shockwaves';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    // Behind the sprites: the dust front rides on top of the pressure edge.
    this.mesh.renderOrder = 2900;
    excludeFromOverridePasses(this.mesh);
  }

  get activeCount(): number {
    return this.count;
  }

  /**
   * Add a shell.
   *
   * @returns the slot index, or -1 when full. The caller keeps the index to
   *          ask where the leading edge is while emitting the dust front.
   */
  emit(p: IShockwaveParams): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    const length = Math.hypot(p.dx, p.dy, p.dz) || 1;
    this.ox[i] = p.x;
    this.oy[i] = p.y;
    this.oz[i] = p.z;
    this.dx[i] = p.dx / length;
    this.dy[i] = p.dy / length;
    this.dz[i] = p.dz / length;
    this.halfAngle[i] = p.halfAngle;
    this.range[i] = p.range;
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, p.life);
    this.intensity[i] = p.intensity;
    this.kind[i] = p.kind;
    this.colR[i] = p.r;
    this.colG[i] = p.g;
    this.colB[i] = p.b;
    this.sharpness[i] = p.sharpness;
    this.chroma[i] = p.chroma;
    this.loft[i] = p.loft;
    this.start[i] = p.start;
    this.seed[i] = p.seed;
    this.generation[i] = (this.generation[i]! + 1) & 0x3fff;
    return i;
  }

  /** Generation stamp of a slot, for stale-handle detection. */
  generationOf(index: number): number {
    return index >= 0 && index < this.capacity ? this.generation[index]! : -1;
  }

  isAlive(index: number, generation: number): boolean {
    return index >= 0 && index < this.count && this.generation[index] === generation;
  }

  /** Life fraction 0..1 of a slot. */
  progressOf(index: number): number {
    if (index < 0 || index >= this.count) return 1;
    return Math.min(1, this.age[index]! / this.life[index]!);
  }

  /** Origin components of a slot. Read by the dust front to push outward. */
  originX(index: number): number {
    return index >= 0 && index < this.count ? this.ox[index]! : 0;
  }

  originY(index: number): number {
    return index >= 0 && index < this.count ? this.oy[index]! : 0;
  }

  originZ(index: number): number {
    return index >= 0 && index < this.count ? this.oz[index]! : 0;
  }

  /** Current leading-edge radius of a slot, in metres. */
  radiusOf(index: number): number {
    if (index < 0 || index >= this.count) return 0;
    return this.radiusAt(index, this.progressOf(index));
  }

  /**
   * Point on the leading edge at arc parameter `u` in [0, 1].
   *
   * This is how the dust front knows where to be. Duplicating the vertex
   * shader's placement maths on the CPU would guarantee they drift apart, so
   * the two derive from the same formula written once here.
   */
  sampleFront(index: number, u: number, out: THREE.Vector3): THREE.Vector3 {
    if (index < 0 || index >= this.count) return out.set(0, 0, 0);
    const radius = this.radiusOf(index);
    const half = this.halfAngle[index]!;
    if (this.kind[index]! < 0.5) {
      const flatLength = Math.hypot(this.dx[index]!, this.dz[index]!) || 1;
      const baseAngle = Math.atan2(this.dx[index]! / flatLength, this.dz[index]! / flatLength);
      const azimuth = baseAngle + (u - 0.5) * 2 * half;
      out.set(
        this.ox[index]! + Math.sin(azimuth) * radius,
        this.oy[index]!,
        this.oz[index]! + Math.cos(azimuth) * radius
      );
    } else {
      const dirX = this.dx[index]!;
      const dirY = this.dy[index]!;
      const dirZ = this.dz[index]!;
      // Any stable perpendicular pair will do; the arc parameter sweeps them.
      // Matches the reference-vector choice in SHOCKWAVE_VERTEX exactly.
      const refX = Math.abs(dirY) < 0.9 ? 0 : 1;
      const refY = Math.abs(dirY) < 0.9 ? 1 : 0;
      let rx = refY * dirZ;
      let ry = -refX * dirZ;
      let rz = refX * dirY - refY * dirX;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl;
      ry /= rl;
      rz /= rl;
      const ux = dirY * rz - dirZ * ry;
      const uy = dirZ * rx - dirX * rz;
      const uz = dirX * ry - dirY * rx;
      const phi = u * Math.PI * 2;
      const rho = radius * Math.tan(Math.min(half, 1.35));
      out.set(
        this.ox[index]! + dirX * radius + (rx * Math.cos(phi) + ux * Math.sin(phi)) * rho,
        this.oy[index]! + dirY * radius + (ry * Math.cos(phi) + uy * Math.sin(phi)) * rho,
        this.oz[index]! + dirZ * radius + (rz * Math.cos(phi) + uz * Math.sin(phi)) * rho
      );
    }
    return out;
  }

  /** Advance every shell by SCALED seconds. */
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
      i++;
    }
  }

  /** Write the instance buffers. */
  prepare(): void {
    const n = this.count;
    this.geometry.instanceCount = n;

    const origin = this.iOrigin.array as Float32Array;
    const axis = this.iAxis.array as Float32Array;
    const shape = this.iShape.array as Float32Array;
    const style = this.iStyle.array as Float32Array;
    const mode = this.iMode.array as Float32Array;

    for (let i = 0; i < n; i++) {
      const t = Math.min(1, this.age[i]! / this.life[i]!);
      const radius = this.radiusAt(i, t);
      const o = i * 4;

      origin[o] = this.ox[i]!;
      origin[o + 1] = this.oy[i]!;
      origin[o + 2] = this.oz[i]!;
      origin[o + 3] = this.halfAngle[i]!;

      axis[o] = this.dx[i]!;
      axis[o + 1] = this.dy[i]!;
      axis[o + 2] = this.dz[i]!;
      axis[o + 3] = radius;

      // The band starts fat and thins as it runs out of energy, so the edge
      // sharpens with distance instead of smearing.
      shape[o] = 1.5 + radius * (0.28 - 0.16 * t);
      shape[o + 1] = t;
      shape[o + 2] = this.intensity[i]!;
      shape[o + 3] = radius * this.loft[i]! * (0.35 + 0.65 * t);

      style[o] = this.colR[i]!;
      style[o + 1] = this.colG[i]!;
      style[o + 2] = this.colB[i]!;
      style[o + 3] = this.seed[i]!;

      mode[o] = this.kind[i]!;
      // The edge hardens over the wave's life: a young wave is a wall of
      // compressed air, an old one is a diffuse front.
      mode[o + 1] = this.sharpness[i]! * (1.35 - 0.5 * t);
      mode[o + 2] = this.chroma[i]!;
      mode[o + 3] = 0;
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

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.geometry.dispose();
  }

  /** See the class header: front-loaded expansion from a non-zero start. */
  private radiusAt(index: number, t: number): number {
    const start = this.start[index]!;
    return this.range[index]! * (start + (1 - start) * Math.pow(t, 0.42));
  }

  private swapRemove(index: number): void {
    const last = this.count - 1;
    if (index !== last) {
      this.ox[index] = this.ox[last]!;
      this.oy[index] = this.oy[last]!;
      this.oz[index] = this.oz[last]!;
      this.dx[index] = this.dx[last]!;
      this.dy[index] = this.dy[last]!;
      this.dz[index] = this.dz[last]!;
      this.halfAngle[index] = this.halfAngle[last]!;
      this.range[index] = this.range[last]!;
      this.age[index] = this.age[last]!;
      this.life[index] = this.life[last]!;
      this.intensity[index] = this.intensity[last]!;
      this.kind[index] = this.kind[last]!;
      this.colR[index] = this.colR[last]!;
      this.colG[index] = this.colG[last]!;
      this.colB[index] = this.colB[last]!;
      this.sharpness[index] = this.sharpness[last]!;
      this.chroma[index] = this.chroma[last]!;
      this.loft[index] = this.loft[last]!;
      this.start[index] = this.start[last]!;
      this.seed[index] = this.seed[last]!;
      this.generation[index] = this.generation[last]!;
    }
    this.count = last;
  }
}
