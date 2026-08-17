/**
 * THE DECAL LAYER — the city stays broken.
 *
 * Ground cracks are the only VFX in this system that OUTLIVE the moment. A
 * shockwave is over in a second; the fracture it leaves in the road is the
 * evidence the player walks back past ten minutes later, and it is most of
 * what makes an open world feel affected by the protagonist rather than reset
 * between encounters.
 *
 * ── WHY A RING BUFFER AND NOT A LIFETIME ───────────────────────────────────
 * Decals default to PERMANENT. The budget is enforced by recycling the oldest
 * slot when the buffer is full, not by fading things out on a timer — a timer
 * would mean the damage disappears while the player is still standing next to
 * it, which is exactly the failure this system exists to avoid. Decals do
 * support an optional lifetime, for scorch and settled dust that should
 * genuinely clear.
 *
 * ── WHY THIS IS NOT THE SPRITE LAYER ───────────────────────────────────────
 * It shares the sprite layer's shader program and geometry, and pays one extra
 * draw call. It does not share its buffer because persistent decals must not
 * be uploaded every frame: this layer re-uploads only when something changed,
 * so two hundred permanent cracks cost nothing per frame at all.
 */

import * as THREE from 'three';
import { SpriteMode, type IVFXTierProfile } from './constants';

/** Parameters for one decal. Reused by callers; never retained. */
export interface IDecalParams {
  x: number;
  y: number;
  z: number;
  /** Surface normal to lie against. */
  nx: number;
  ny: number;
  nz: number;
  /** Width in metres. */
  size: number;
  /** Height as a multiple of `size`. >1 makes a crack running outward. */
  aspect: number;
  /** Rotation about the normal, radians. */
  rotation: number;
  /** Index into the crack atlas. */
  tile: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  /** Seconds before disappearing. 0 or less = permanent. */
  lifetime: number;
}

export function createDecalParams(): IDecalParams {
  return {
    x: 0,
    y: 0,
    z: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    size: 3,
    aspect: 1,
    rotation: 0,
    tile: 0,
    r: 0.16,
    g: 0.15,
    b: 0.14,
    alpha: 1,
    lifetime: 0,
  };
}

const FLOATS_PER_INSTANCE = 4;

export class DecalLayer {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;

  private count = 0;
  /** Next slot to overwrite once the buffer is full. */
  private head = 0;
  private dirty = true;
  private timedCount = 0;

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly nx: Float32Array;
  private readonly ny: Float32Array;
  private readonly nz: Float32Array;
  private readonly size: Float32Array;
  private readonly aspect: Float32Array;
  private readonly rotation: Float32Array;
  private readonly tile: Float32Array;
  private readonly colR: Float32Array;
  private readonly colG: Float32Array;
  private readonly colB: Float32Array;
  private readonly alpha: Float32Array;
  private readonly age: Float32Array;
  private readonly lifetime: Float32Array;

  private readonly iPosSize: THREE.InstancedBufferAttribute;
  private readonly iColor: THREE.InstancedBufferAttribute;
  private readonly iParams: THREE.InstancedBufferAttribute;
  private readonly iMotion: THREE.InstancedBufferAttribute;
  private readonly iShade: THREE.InstancedBufferAttribute;
  private readonly attributes: readonly THREE.InstancedBufferAttribute[];
  private readonly ranges: { start: number; count: number }[];
  private readonly geometry: THREE.InstancedBufferGeometry;

  constructor(
    geometry: THREE.InstancedBufferGeometry,
    material: THREE.Material,
    profile: IVFXTierProfile
  ) {
    this.capacity = profile.decalCapacity;
    this.geometry = geometry;

    const f = (): Float32Array => new Float32Array(this.capacity);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.nx = f();
    this.ny = f();
    this.nz = f();
    this.size = f();
    this.aspect = f();
    this.rotation = f();
    this.tile = f();
    this.colR = f();
    this.colG = f();
    this.colB = f();
    this.alpha = f();
    this.age = f();
    this.lifetime = f();

    const attribute = (): THREE.InstancedBufferAttribute =>
      new THREE.InstancedBufferAttribute(
        new Float32Array(this.capacity * FLOATS_PER_INSTANCE),
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
    this.mesh.name = 'vfx.decals';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    // Under everything else: dust and shockwaves are drawn over the ground
    // damage, never behind it.
    this.mesh.renderOrder = 2800;
  }

  get activeCount(): number {
    return this.count;
  }

  /**
   * Place a decal.
   *
   * @returns false only when the layer has zero capacity. A full buffer
   *          RECYCLES its oldest entry and still returns true — losing the
   *          oldest crack is the correct behaviour, refusing to draw the
   *          newest one is not.
   */
  emit(p: IDecalParams): boolean {
    if (this.capacity === 0) return false;
    let i: number;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      i = this.head;
      this.head = (this.head + 1) % this.capacity;
      if (this.lifetime[i]! > 0) this.timedCount--;
    }

    const length = Math.hypot(p.nx, p.ny, p.nz) || 1;
    this.px[i] = p.x;
    this.py[i] = p.y;
    this.pz[i] = p.z;
    this.nx[i] = p.nx / length;
    this.ny[i] = p.ny / length;
    this.nz[i] = p.nz / length;
    this.size[i] = p.size;
    this.aspect[i] = p.aspect;
    this.rotation[i] = p.rotation;
    this.tile[i] = p.tile;
    this.colR[i] = p.r;
    this.colG[i] = p.g;
    this.colB[i] = p.b;
    this.alpha[i] = p.alpha;
    this.age[i] = 0;
    this.lifetime[i] = p.lifetime;
    if (p.lifetime > 0) this.timedCount++;

    this.dirty = true;
    return true;
  }

  /**
   * Age the decals that expire.
   *
   * Returns immediately when nothing has a lifetime, which is the common case:
   * a city full of permanent cracks costs zero per-frame work.
   */
  update(dt: number): void {
    if (dt <= 0 || this.timedCount === 0) return;
    for (let i = 0; i < this.count; i++) {
      const total = this.lifetime[i]!;
      if (total <= 0) continue;
      this.age[i] = this.age[i]! + dt;
      if (this.age[i]! >= total) {
        this.alpha[i] = 0;
        this.lifetime[i] = 0;
        this.timedCount--;
      }
      this.dirty = true;
    }
  }

  /** Upload, but only when something actually changed. */
  prepare(): void {
    if (!this.dirty) return;
    this.dirty = false;

    const n = this.count;
    this.geometry.instanceCount = n;

    const posSize = this.iPosSize.array as Float32Array;
    const color = this.iColor.array as Float32Array;
    const params = this.iParams.array as Float32Array;
    const motion = this.iMotion.array as Float32Array;
    const shade = this.iShade.array as Float32Array;

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      posSize[o] = this.px[i]!;
      posSize[o + 1] = this.py[i]!;
      posSize[o + 2] = this.pz[i]!;
      posSize[o + 3] = this.size[i]!;

      const total = this.lifetime[i]!;
      const fade = total > 0 ? Math.max(0, 1 - this.age[i]! / total) : 1;
      color[o] = this.colR[i]!;
      color[o + 1] = this.colG[i]!;
      color[o + 2] = this.colB[i]!;
      color[o + 3] = this.alpha[i]! * fade;

      params[o] = this.rotation[i]!;
      params[o + 1] = this.tile[i]!;
      // Cracks are darkening, never additive, and never eroded — the erosion
      // channel is what would make them dissolve, and they must not.
      params[o + 2] = 0;
      params[o + 3] = 0;

      motion[o] = this.nx[i]!;
      motion[o + 1] = this.ny[i]!;
      motion[o + 2] = this.nz[i]!;
      motion[o + 3] = this.aspect[i]!;

      shade[o] = 0;
      shade[o + 1] = 0;
      shade[o + 2] = SpriteMode.Surface;
      shade[o + 3] = 1;
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
    this.head = 0;
    this.timedCount = 0;
    this.dirty = true;
    this.geometry.instanceCount = 0;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
