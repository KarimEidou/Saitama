/**
 * REFERENCE-COUNTED TEXTURE HANDLES
 *
 * `TextureHandle` (types/assets.ts) is the only way a consumer is allowed to
 * hold a GPU texture: textures are shared aggressively — one 1024² ORM map
 * serves the ao, roughness AND metalness slots of every material built from
 * that PBR set — so ownership has to be counted rather than assumed.
 *
 * The contract:
 *   `registry.getTexture(key)` hands back a handle at whatever count it is on.
 *   A consumer that intends to KEEP it calls `retain()`, and calls `release()`
 *   exactly once when done. `release()` at zero makes the handle evictable;
 *   `TextureMemory` decides when the bytes actually go back (see memory.ts).
 *
 * Double-release is a real bug that is otherwise invisible until some
 * unrelated system's texture disappears, so it is caught and logged here
 * rather than silently driving the count negative.
 */

import * as THREE from 'three';
import type { ColorSpace, TextureCodec, TextureHandle } from '@/types';
import { createLogger } from '@/util';
import { codecOf, gpuFormatName, isCompressedTexture } from './ktx2';
import { estimateGpuBytes } from './memory';

const log = createLogger('assets:textures');

/** A handle plus the facts the contract's closed unions cannot express. */
export interface IManagedTextureHandle extends TextureHandle {
  /** Exact three.js GPU format, e.g. 'RGBA_BPTC_Format'. */
  readonly gpuFormat: string;
  /** True when the GPU holds this block-compressed rather than as RGBA bytes. */
  readonly compressed: boolean;
  /** Tier the bytes actually came from, after any downgrade. */
  readonly tier: string;
  /** True when this is a marked stand-in for a missing asset. */
  readonly fallback: boolean;
  /** Free the GPU texture regardless of count. Registry/shutdown only. */
  dispose(): void;
}

export interface ITextureHandleInit {
  readonly key: string;
  readonly texture: THREE.Texture;
  readonly colorSpace: ColorSpace;
  readonly tier: string;
  readonly sourceCodec?: TextureCodec;
  readonly fallback?: boolean;
  /** Called when the count reaches zero, so the LRU can consider eviction. */
  readonly onUnreferenced?: (key: string) => void;
  /** Called on every retain/release, so the LRU can update recency. */
  readonly onTouch?: (key: string) => void;
}

export class ManagedTextureHandle implements IManagedTextureHandle {
  readonly key: string;
  readonly texture: THREE.Texture;
  readonly colorSpace: ColorSpace;
  readonly width: number;
  readonly height: number;
  readonly codec: TextureCodec;
  readonly gpuBytes: number;
  readonly gpuFormat: string;
  readonly compressed: boolean;
  readonly tier: string;
  readonly fallback: boolean;

  private count = 0;
  private disposed = false;
  private readonly onUnreferenced: ((key: string) => void) | undefined;
  private readonly onTouch: ((key: string) => void) | undefined;

  constructor(init: ITextureHandleInit) {
    this.key = init.key;
    this.texture = init.texture;
    this.colorSpace = init.colorSpace;
    this.tier = init.tier;
    this.fallback = init.fallback ?? false;
    this.onUnreferenced = init.onUnreferenced;
    this.onTouch = init.onTouch;

    const image = init.texture.image as { width?: number; height?: number } | undefined;
    this.width = image?.width ?? 0;
    this.height = image?.height ?? 0;
    this.compressed = isCompressedTexture(init.texture);
    this.gpuFormat = gpuFormatName(init.texture);
    this.codec = codecOf(init.texture, init.sourceCodec);
    this.gpuBytes = estimateGpuBytes(init.texture);
  }

  get refCount(): number {
    return this.count;
  }

  retain(): TextureHandle {
    if (this.disposed) {
      log.warn(`retain() on disposed texture "${this.key}"; returning a dead handle`);
      return this;
    }
    this.count++;
    this.onTouch?.(this.key);
    return this;
  }

  release(): void {
    if (this.count === 0) {
      log.warnOnce(
        `double-release:${this.key}`,
        `release() on texture "${this.key}" at refCount 0. Every retain() needs ` +
          `exactly one release(); an extra one would free a texture another ` +
          `system is still drawing with.`
      );
      return;
    }
    this.count--;
    this.onTouch?.(this.key);
    if (this.count === 0) this.onUnreferenced?.(this.key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Fallbacks are process-wide singletons; disposing one would blank every
    // other missing asset's stand-in too.
    if (!this.fallback) this.texture.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* Texture-slot binding                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Bind a packed ORM map to all three slots it serves.
 *
 * ORM is occlusion in `.r`, roughness in `.g`, metalness in `.b`. three samples
 * exactly those channels for `aoMap`, `roughnessMap` and `metalnessMap`, so
 * ONE texture and ONE upload covers all three — a 3x saving in both VRAM and
 * texture units against binding three greyscale maps.
 *
 * `aoMap.channel = 0` is not optional. `Texture.channel` selects which UV set
 * the AO term reads, glTF's occlusion convention is frequently UV1, and these
 * meshes have no UV1 at all: with `channel = 1` the AO term samples an
 * attribute that does not exist and the surface goes uniformly dark or
 * uniformly unoccluded depending on the driver. It is set explicitly — and
 * asserted in the harness — rather than left to a default that has moved
 * between three.js versions.
 */
export function bindPackedOrm(material: THREE.MeshStandardMaterial, orm: THREE.Texture): void {
  material.aoMap = orm;
  material.roughnessMap = orm;
  material.metalnessMap = orm;
  orm.channel = 0;
  material.aoMapIntensity = 1;
}

/**
 * Clone a shared texture so per-material UV repeat can be applied safely.
 *
 * `Texture.clone()` shares the underlying `source`, so three still uploads
 * exactly one GPU texture — the clone costs a few dozen bytes of JS. Mutating
 * `repeat` on the shared instance instead would silently retile every other
 * material bound to it.
 */
export function withRepeat(
  texture: THREE.Texture,
  repeat: readonly [number, number] | undefined
): THREE.Texture {
  if (!repeat || (repeat[0] === 1 && repeat[1] === 1)) return texture;
  const clone = texture.clone();
  clone.repeat.set(repeat[0], repeat[1]);
  clone.wrapS = THREE.RepeatWrapping;
  clone.wrapT = THREE.RepeatWrapping;
  clone.channel = texture.channel;
  clone.needsUpdate = true;
  return clone;
}
