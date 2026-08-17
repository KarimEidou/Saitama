/**
 * THE RECIPES — where the art direction lives.
 *
 * Everything above this file is plumbing: buffers, sorting, uploads. This is
 * the file that decides what a punch LOOKS like, and it is deliberately the
 * only place holding those numbers.
 *
 * ── THE ONE COMPOSITION RULE ───────────────────────────────────────────────
 * Contrast, not brightness. The shockwave's pressure edge only reads as
 * white-hot because the dust around it is a dark, desaturated concrete grey —
 * so the dust is authored two stops darker than instinct suggests and the edge
 * is authored above 1.0 so the bloom finds it. Making everything bright makes
 * a grey puff. That failure mode is the whole risk of this system and every
 * default below is chosen against it.
 *
 * ── EVERY EMITTER IS ALLOCATION-FREE ───────────────────────────────────────
 * One shared parameter block per layer, filled and submitted. No object
 * literals, no arrays, no closures. A serious punch emits a few hundred
 * particles in one frame and must not hand the collector a single byte.
 */

import * as THREE from 'three';
import type { IRandom } from '@/util';
import {
  CLOUD_COLOR,
  CrackTile,
  DUST_COLOR,
  DUST_COLOR_DARK,
  DUST_TILES,
  SHOCK_COLOR,
  SPARK_COLOR,
  SpriteMode,
  SpriteTile,
  type IVFXTierProfile,
} from './constants';
import { DecalLayer, createDecalParams, type IDecalParams } from './decal-layer';
import { ShockwaveLayer } from './shockwave-layer';
import { SpriteLayer, createSpriteParams, type ISpriteParams } from './sprite-layer';

/** Linear-space RGB triples, converted once from the authored sRGB hexes. */
interface LinearColor {
  r: number;
  g: number;
  b: number;
}

function toLinear(hex: number, out: LinearColor, scratch: THREE.Color): LinearColor {
  scratch.setHex(hex);
  out.r = scratch.r;
  out.g = scratch.g;
  out.b = scratch.b;
  return out;
}

export class EffectEmitters {
  private readonly sprite: ISpriteParams = createSpriteParams();
  private readonly decal: IDecalParams = createDecalParams();
  private readonly scratchColor = new THREE.Color();
  private readonly scratchVector = new THREE.Vector3();

  private readonly dustColor: LinearColor = { r: 0, g: 0, b: 0 };
  private readonly dustDark: LinearColor = { r: 0, g: 0, b: 0 };
  private readonly shockColor: LinearColor = { r: 0, g: 0, b: 0 };
  private readonly sparkColor: LinearColor = { r: 0, g: 0, b: 0 };
  private readonly cloudColor: LinearColor = { r: 0, g: 0, b: 0 };

  constructor(
    private readonly sprites: SpriteLayer,
    private readonly decals: DecalLayer,
    private readonly shockwaves: ShockwaveLayer,
    private readonly profile: IVFXTierProfile
  ) {
    toLinear(DUST_COLOR, this.dustColor, this.scratchColor);
    toLinear(DUST_COLOR_DARK, this.dustDark, this.scratchColor);
    toLinear(SHOCK_COLOR, this.shockColor, this.scratchColor);
    toLinear(SPARK_COLOR, this.sparkColor, this.scratchColor);
    toLinear(CLOUD_COLOR, this.cloudColor, this.scratchColor);
  }

  /** Tier-scaled particle count, never below 1 when the caller asked for any. */
  count(base: number): number {
    if (base <= 0) return 0;
    return Math.max(1, Math.round(base * this.profile.particleScale));
  }

  /* ------------------------------------------------------------------ */
  /* Dust                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * A plume of dust: the workhorse.
   *
   * Two populations rather than one, because a single size distribution is
   * what makes CG smoke look like CG smoke. The heavy fraction is large,
   * upright, slow and hangs; the fine fraction is small, fast, buoyant and
   * catches the light. Together they read as a body of dust with detail
   * inside it.
   *
   * @param upward Extra vertical launch speed. A landing wants little; a
   *               building collapse wants a lot.
   */
  dustPlume(
    rng: IRandom,
    x: number,
    y: number,
    z: number,
    radius: number,
    power: number,
    total: number,
    upward = 1
  ): number {
    const p = this.sprite;
    const n = this.count(total);
    let emitted = 0;

    for (let i = 0; i < n; i++) {
      const heavy = i % 3 !== 0;
      const [ox, oz] = rng.insideCircle(radius);
      const oy = rng.range(0, radius * 0.4);
      const outward = Math.hypot(ox, oz) || 1;
      const speed = (2.5 + 16 * power) * rng.range(0.35, 1);

      p.x = x + ox;
      p.y = y + oy + 0.4;
      p.z = z + oz;
      p.vx = (ox / outward) * speed;
      p.vz = (oz / outward) * speed;
      p.vy = rng.range(0.4, 2.2) * upward * (1 + power * 2.2);

      if (heavy) {
        p.size0 = radius * rng.range(0.35, 0.7) + 1.6 + power * 3;
        p.size1 = p.size0 * rng.range(2.2, 3.6);
        p.life = rng.range(2.4, 5.2) * (0.55 + power * 0.75);
        p.gravity = -0.55;
        p.drag = 1.15;
        p.mode = SpriteMode.Upright;
        p.alpha = rng.range(0.42, 0.68);
        // The heavy fraction is the DARK mass the bright edge reads against.
        this.tintBetween(p, this.dustDark, this.dustColor, rng.range(0.2, 0.9));
      } else {
        p.size0 = radius * rng.range(0.14, 0.3) + 0.8 + power * 1.2;
        p.size1 = p.size0 * rng.range(2.6, 4.4);
        p.life = rng.range(1.4, 3.4) * (0.5 + power * 0.7);
        // Fine dust is buoyant: it rises after the blast passes, which is what
        // makes a plume keep growing for seconds afterwards.
        p.gravity = 0.35;
        p.drag = 1.9;
        p.mode = SpriteMode.Billboard;
        p.alpha = rng.range(0.22, 0.45);
        this.tintBetween(p, this.dustColor, this.dustDark, rng.range(0, 0.45));
      }

      p.tile = rng.pick(DUST_TILES);
      p.rot = rng.range(0, Math.PI * 2);
      p.rotVel = rng.range(-0.5, 0.5);
      p.turbulence = 0.9 + power * 3.4;
      p.additive = 0;
      p.lit = 1;
      p.stretch = 0;
      p.fadeIn = 0.05;
      p.erode = 1.05;
      p.style = 0;
      p.aspect = 1;
      p.seed = rng.next();
      if (this.sprites.emit(p)) emitted++;
      else break;
    }
    return emitted;
  }

  /**
   * Dust riding a shockwave's leading edge.
   *
   * Called every frame while the shell lives, which is what turns a thin
   * expanding ring into a WALL travelling across the city. The puffs inherit a
   * fraction of the front's speed so they trail behind it instead of pacing it
   * — a dust front that keeps up with the pressure edge looks glued on.
   */
  dustFront(
    rng: IRandom,
    shellIndex: number,
    edgeSpeed: number,
    power: number,
    total: number,
    lofted: boolean
  ): number {
    const p = this.sprite;
    const n = this.count(total);
    let emitted = 0;
    const radius = this.shockwaves.radiusOf(shellIndex);

    for (let i = 0; i < n; i++) {
      const u = rng.next();
      this.shockwaves.sampleFront(shellIndex, u, this.scratchVector);
      const outX = this.scratchVector.x;
      const outY = this.scratchVector.y;
      const outZ = this.scratchVector.z;

      p.x = outX + rng.range(-radius * 0.05, radius * 0.05);
      p.y = outY + rng.range(0.2, 2.4 + radius * 0.05);
      p.z = outZ + rng.range(-radius * 0.05, radius * 0.05);

      // Radially outward, at a fraction of the front's own speed.
      const dx = p.x - this.shockwaves.originX(shellIndex);
      const dz = p.z - this.shockwaves.originZ(shellIndex);
      const length = Math.hypot(dx, dz) || 1;
      const carried = edgeSpeed * rng.range(0.18, 0.42);
      p.vx = (dx / length) * carried;
      p.vz = (dz / length) * carried;
      p.vy = rng.range(1.5, 5.5) * (lofted ? 2.4 : 1) * (0.5 + power);

      p.size0 = 2.4 + radius * rng.range(0.03, 0.075) + power * 4;
      p.size1 = p.size0 * rng.range(2.1, 3.4);
      p.life = rng.range(2.6, 5.4) * (0.6 + power * 0.6);
      p.tile = rng.pick(DUST_TILES);
      p.rot = rng.range(0, Math.PI * 2);
      p.rotVel = rng.range(-0.35, 0.35);
      p.gravity = -0.4;
      p.drag = 1.25;
      p.turbulence = 1.4 + power * 3.6;
      p.mode = SpriteMode.Upright;
      p.additive = 0;
      p.lit = 1;
      p.alpha = rng.range(0.34, 0.62);
      p.stretch = 0;
      p.fadeIn = 0.04;
      p.erode = 1.05;
      p.style = 0;
      p.aspect = 1;
      p.seed = rng.next();
      this.tintBetween(p, this.dustDark, this.dustColor, rng.range(0.15, 1.0));
      if (this.sprites.emit(p)) emitted++;
      else break;
    }
    return emitted;
  }

  /* ------------------------------------------------------------------ */
  /* Impact                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The impact flash.
   *
   * Timed to be READ DURING THE FREEZE. The renderer drops the clock to 4% for
   * 90 ms on a lethal hit, so about 4 ms of game time elapses while the frame
   * is held. Everything here therefore peaks at age zero and decays slowly:
   * `fadeIn` is a couple of per cent and the life is a fifth of a second, so
   * the held frame catches the flash at full strength rather than catching its
   * tail.
   */
  impactFlash(rng: IRandom, x: number, y: number, z: number, power: number): void {
    const p = this.sprite;
    // METRES. This is a contact flash on a fist, not a nuclear fireball: at 20+
    // metres across it stops being a flash and becomes a light bulb parked in
    // front of the camera, and everything behind it — the wave, the dust, the
    // city — disappears into the middle of it.
    const scale = 1.1 + 5.4 * power;

    // Core star.
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.size0 = scale;
    p.size1 = scale * 2.3;
    p.life = 0.20 + power * 0.12;
    p.tile = SpriteTile.FlashStar;
    p.mode = SpriteMode.Billboard;
    p.rot = rng.range(0, Math.PI * 2);
    p.rotVel = 0.7;
    p.gravity = 0;
    p.drag = 0;
    p.turbulence = 0;
    p.additive = 1;
    p.lit = 0;
    p.alpha = 1;
    p.stretch = 0;
    p.fadeIn = 0.02;
    p.erode = 0.55;
    p.style = 0;
    p.aspect = 1;
    p.seed = rng.next();
    this.tint(p, this.shockColor, 1.5 + power * 1.5);
    this.sprites.emit(p);

    // Soft bloom halo behind it.
    p.size0 = scale * 1.4;
    p.size1 = scale * 2.8;
    p.life = 0.34 + power * 0.2;
    p.tile = SpriteTile.Glow;
    p.rotVel = 0;
    p.alpha = 0.85;
    p.erode = 0.3;
    p.seed = rng.next();
    this.tint(p, this.shockColor, 0.55 + power * 0.7);
    this.sprites.emit(p);

    // Expanding ring pop — the small, fast read that says "contact".
    p.size0 = scale * 0.55;
    p.size1 = scale * 5.5;
    p.life = 0.32 + power * 0.22;
    p.tile = SpriteTile.Ring;
    p.alpha = 0.95;
    p.erode = 0.7;
    p.rot = rng.range(0, Math.PI * 2);
    p.seed = rng.next();
    this.tint(p, this.shockColor, 0.9 + power * 1.1);
    this.sprites.emit(p);
  }

  /**
   * Hit sparks — velocity-stretched streaks in a cone about the hit normal.
   *
   * Gravity and drag are both high on purpose. Sparks that fly straight and
   * evenly read as a firework; sparks that arc, decelerate and die at
   * different times read as material being torn off something.
   */
  hitSparks(
    rng: IRandom,
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    power: number,
    total: number
  ): void {
    const p = this.sprite;
    const n = this.count(total);
    const length = Math.hypot(dirX, dirY, dirZ) || 1;
    const nx = dirX / length;
    const ny = dirY / length;
    const nz = dirZ / length;

    for (let i = 0; i < n; i++) {
      // Spread about the normal by perturbing it, then renormalising: cheap,
      // and biased toward the axis the way a real spall pattern is.
      const spread = 0.85;
      let sx = nx + rng.gaussian(0, spread);
      let sy = ny + rng.gaussian(0, spread) + 0.25;
      let sz = nz + rng.gaussian(0, spread);
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;

      const speed = (9 + 46 * power) * rng.range(0.35, 1);
      p.x = x + sx * 0.4;
      p.y = y + sy * 0.4;
      p.z = z + sz * 0.4;
      p.vx = sx * speed;
      p.vy = sy * speed;
      p.vz = sz * speed;
      p.size0 = 0.24 + power * 0.4;
      p.size1 = 0.06;
      p.life = rng.range(0.28, 0.85) * (0.6 + power * 0.7);
      p.tile = SpriteTile.Streak;
      p.mode = SpriteMode.Streak;
      p.rot = 0;
      p.rotVel = 0;
      p.gravity = -16;
      p.drag = 1.1;
      p.turbulence = 0;
      p.additive = 1;
      p.lit = 0;
      p.alpha = 1;
      p.stretch = 0.05;
      p.fadeIn = 0.01;
      p.erode = 0.4;
      p.style = 0;
      p.aspect = 1;
      p.seed = rng.next();
      this.tint(p, this.sparkColor, rng.range(1.4, 3.2));
      if (!this.sprites.emit(p)) break;
    }
  }

  /**
   * Chips of concrete thrown out of an impact, each dragging a streak.
   *
   * Two sprites per chip: a dark shard silhouette that reads against the dust,
   * and a faint additive streak behind it. The silhouette is what makes the
   * dust look like it has depth — there is something solid inside it.
   */
  debrisChips(
    rng: IRandom,
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    power: number,
    total: number
  ): void {
    const p = this.sprite;
    const n = this.count(total);
    const length = Math.hypot(dirX, dirY, dirZ) || 1;

    for (let i = 0; i < n; i++) {
      let sx = dirX / length + rng.gaussian(0, 0.75);
      let sy = dirY / length + rng.range(0.35, 1.5);
      let sz = dirZ / length + rng.gaussian(0, 0.75);
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const speed = (6 + 34 * power) * rng.range(0.4, 1);

      p.x = x + sx * 0.8;
      p.y = y + sy * 0.8 + 0.3;
      p.z = z + sz * 0.8;
      p.vx = sx * speed;
      p.vy = sy * speed;
      p.vz = sz * speed;
      p.size0 = rng.range(0.35, 1.4) * (0.6 + power);
      p.size1 = p.size0;
      p.life = rng.range(1.1, 2.6);
      p.tile = SpriteTile.Shard;
      p.mode = SpriteMode.Billboard;
      p.rot = rng.range(0, Math.PI * 2);
      p.rotVel = rng.range(-7, 7);
      p.gravity = -19;
      p.drag = 0.12;
      p.turbulence = 0;
      p.additive = 0;
      p.lit = 1;
      p.alpha = 1;
      p.stretch = 0;
      p.fadeIn = 0.01;
      p.erode = 0.2;
      p.style = 0;
      p.aspect = 1;
      p.seed = rng.next();
      this.tintBetween(p, this.dustDark, this.dustColor, rng.range(0, 0.4));
      if (!this.sprites.emit(p)) break;
    }
  }

  /**
   * One step of a motion trail: a stretched dust streak behind a flying body.
   *
   * Called per frame per tracked chunk. The streak is dust, not fire — a
   * concrete block tearing through air drags a pale smear, and making it glow
   * would turn a collapsing building into a fireworks display.
   */
  trailStep(
    rng: IRandom,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    power: number
  ): boolean {
    const p = this.sprite;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx * 0.25;
    p.vy = vy * 0.25;
    p.vz = vz * 0.25;
    p.size0 = size;
    p.size1 = size * 2.4;
    p.life = rng.range(0.45, 0.95);
    p.tile = SpriteTile.DustWisp;
    p.mode = SpriteMode.Streak;
    p.rot = 0;
    p.rotVel = 0;
    p.gravity = 0.4;
    p.drag = 2.6;
    p.turbulence = 0.6;
    p.additive = 0;
    p.lit = 1;
    p.alpha = rng.range(0.18, 0.38) * (0.5 + power * 0.6);
    p.stretch = 0.026;
    p.fadeIn = 0.06;
    p.erode = 1.05;
    p.style = 0;
    p.aspect = 1;
    p.seed = rng.next();
    this.tintBetween(p, this.dustDark, this.dustColor, rng.range(0.2, 0.8));
    return this.sprites.emit(p);
  }

  /* ------------------------------------------------------------------ */
  /* Ground damage                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Fracture the ground.
   *
   * A star at the impact and a fan of branches racing away from it, each
   * oriented so the crack tile's own direction agrees with the direction it is
   * placed in. Permanent by default: this is the record the player walks back
   * past.
   *
   * @returns decals actually placed.
   */
  groundCracks(
    rng: IRandom,
    x: number,
    y: number,
    z: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    radius: number,
    power: number,
    branches: number
  ): number {
    const d = this.decal;
    let placed = 0;

    d.nx = normalX;
    d.ny = normalY;
    d.nz = normalZ;
    d.lifetime = 0;

    // The scorch/dust blot under everything, so the fracture sits in a
    // disturbed patch instead of on clean tarmac.
    d.x = x;
    d.y = y;
    d.z = z;
    d.size = radius * 2.4;
    d.aspect = 1;
    d.rotation = rng.range(0, Math.PI * 2);
    d.tile = CrackTile.Smear;
    d.r = 0.09;
    d.g = 0.085;
    d.b = 0.08;
    d.alpha = 0.5 + power * 0.35;
    if (this.decals.emit(d)) placed++;

    // The impact star.
    d.size = radius * 2;
    d.aspect = 1;
    d.rotation = rng.range(0, Math.PI * 2);
    d.tile = CrackTile.Star;
    d.r = 0.05;
    d.g = 0.048;
    d.b = 0.046;
    d.alpha = 0.85 + power * 0.15;
    if (this.decals.emit(d)) placed++;

    // Branches racing outward.
    const n = Math.max(0, Math.round(branches));
    for (let i = 0; i < n; i++) {
      const angle = (i / Math.max(1, n)) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const dirX = Math.cos(angle);
      const dirZ = Math.sin(angle);
      const size = radius * rng.range(0.55, 1.15);
      const aspect = rng.range(2.1, 3.8);
      const half = size * aspect * 0.5;

      d.x = x + dirX * (half + radius * 0.35);
      d.y = y;
      d.z = z + dirZ * (half + radius * 0.35);
      d.size = size;
      d.aspect = aspect;
      // See the surface-quad frame in SPRITE_VERTEX: at rotation 0 the tile's
      // +v axis points along world +X, so this is the rotation that makes the
      // crack run in the direction it was placed.
      d.rotation = Math.atan2(-dirZ, dirX);
      d.tile = rng.bool() ? CrackTile.BranchA : CrackTile.BranchB;
      d.r = 0.055;
      d.g = 0.052;
      d.b = 0.05;
      d.alpha = rng.range(0.65, 1);
      if (this.decals.emit(d)) placed++;
    }
    return placed;
  }

  /* ------------------------------------------------------------------ */
  /* Sky                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * CLOUD PARTING — the serious-punch beat.
   *
   * A ring of cloud billboards blown outward at altitude, opening a hole in
   * the overcast. There is no sky shader involved and no second draw call:
   * they are ordinary sprites that happen to be 60 metres wide and 180 metres
   * up. The column of rising haze at the centre is what makes the eye read the
   * gap as a hole rather than as a gap.
   *
   * Disabled on the LOW tier — it is pure spectacle with no gameplay reading,
   * which makes it the correct first thing to cut.
   */
  cloudParting(
    rng: IRandom,
    x: number,
    y: number,
    z: number,
    altitude: number,
    finalRadius: number,
    power: number
  ): number {
    if (!this.profile.cloudParting) return 0;
    const p = this.sprite;
    const ringCount = this.count(26 + Math.round(power * 14));
    const startRadius = finalRadius * 0.14;
    const life = 3.6 + power * 2.2;
    let emitted = 0;

    for (let i = 0; i < ringCount; i++) {
      const angle = (i / ringCount) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const r0 = startRadius * rng.range(0.7, 1.3);
      const height = altitude + rng.range(-18, 22);
      const speed = ((finalRadius - startRadius) / life) * rng.range(0.75, 1.35);

      p.x = x + Math.cos(angle) * r0;
      p.y = y + height;
      p.z = z + Math.sin(angle) * r0;
      p.vx = Math.cos(angle) * speed;
      p.vz = Math.sin(angle) * speed;
      p.vy = rng.range(-1.5, 3.5);
      p.size0 = finalRadius * rng.range(0.16, 0.3);
      p.size1 = p.size0 * rng.range(1.5, 2.4);
      p.life = life * rng.range(0.75, 1.15);
      p.tile = SpriteTile.Cloud;
      p.mode = SpriteMode.Billboard;
      p.rot = rng.range(0, Math.PI * 2);
      p.rotVel = rng.range(-0.09, 0.09);
      p.gravity = 0;
      p.drag = 0.55;
      p.turbulence = 1.1;
      p.additive = 0;
      p.lit = 1;
      p.alpha = rng.range(0.35, 0.62);
      p.stretch = 0;
      p.fadeIn = 0.08;
      p.erode = 1.05;
      p.style = 0;
      p.aspect = 1;
      p.seed = rng.next();
      this.tint(p, this.cloudColor, rng.range(0.75, 1.15));
      if (this.sprites.emit(p)) emitted++;
      else break;
    }

    // The column: tall, faint, rising. Upright mode so it stays vertical no
    // matter where the camera is when the player looks up.
    const columnCount = this.count(7);
    for (let i = 0; i < columnCount; i++) {
      const t = i / Math.max(1, columnCount - 1);
      p.x = x + rng.range(-finalRadius * 0.05, finalRadius * 0.05);
      p.y = y + altitude * (0.28 + 0.85 * t);
      p.z = z + rng.range(-finalRadius * 0.05, finalRadius * 0.05);
      p.vx = 0;
      p.vz = 0;
      p.vy = 12 + power * 26;
      p.size0 = finalRadius * rng.range(0.1, 0.19);
      p.size1 = p.size0 * 2.1;
      p.life = life * rng.range(0.55, 0.85);
      p.tile = SpriteTile.DustWisp;
      p.mode = SpriteMode.Upright;
      p.rot = 0;
      p.rotVel = 0;
      p.gravity = 0;
      p.drag = 0.8;
      p.turbulence = 2.2;
      p.additive = 0.35;
      p.lit = 1;
      p.alpha = rng.range(0.18, 0.34);
      p.stretch = 0;
      p.fadeIn = 0.1;
      p.erode = 1.05;
      p.style = 0;
      p.aspect = 1;
      p.seed = rng.next();
      this.tint(p, this.cloudColor, 1.05);
      if (this.sprites.emit(p)) emitted++;
      else break;
    }
    return emitted;
  }

  /* ------------------------------------------------------------------ */
  /* Tint helpers                                                       */
  /* ------------------------------------------------------------------ */

  private tint(p: ISpriteParams, color: LinearColor, gain: number): void {
    p.r = color.r * gain;
    p.g = color.g * gain;
    p.b = color.b * gain;
  }

  private tintBetween(p: ISpriteParams, a: LinearColor, b: LinearColor, t: number): void {
    p.r = a.r + (b.r - a.r) * t;
    p.g = a.g + (b.g - a.g) * t;
    p.b = a.b + (b.b - a.b) * t;
  }
}
