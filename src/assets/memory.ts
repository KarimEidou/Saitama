/**
 * TEXTURE MEMORY: MEASUREMENT AND LRU EVICTION
 *
 * Two jobs, kept separate from the registry so both can be tested without a
 * GPU or a network:
 *
 *   `estimateGpuBytes` — what a texture actually costs once resident. Exact
 *     when the loader preserved the mip chain (sum of the uploaded level
 *     payloads); otherwise derived from format, type and dimensions.
 *
 *   `TextureMemory`    — a reference-counted LRU over those measurements.
 *
 * ── THE RULE THAT MATTERS ──────────────────────────────────────────────────
 * A handle with `refCount > 0` is NEVER evicted. Streaming hands the same
 * texture to dozens of materials; freeing one out from under them yields a
 * black surface at best and a GL error at worst. When the budget cannot be met
 * without touching referenced handles, the budget loses and the overage is
 * logged. A high-water mark you can see beats a texture that vanishes.
 *
 * ── WHY release() DOES NOT FREE IMMEDIATELY ────────────────────────────────
 * `TextureHandle.release()` drops the count to zero and makes the handle
 * EVICTABLE; the bytes are reclaimed by the next eviction pass, or at once if
 * the budget is already exceeded. Freeing at exactly zero would thrash: during
 * streaming a texture is routinely released as one chunk unloads and retained
 * again a frame later as the next chunk loads, and re-transcoding a 4 MB KTX2
 * to save 350 KB for 16 ms is a bad trade. `setEagerRelease(true)` restores
 * literal free-at-zero for callers that want it, and `unload()` always frees
 * an unreferenced handle immediately.
 */

import * as THREE from 'three';
import { createLogger } from '@/util';
import { EVICTION_TARGET_FRACTION } from './constants';

const log = createLogger('assets:memory');

/* -------------------------------------------------------------------------- */
/* Measurement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Bytes per pixel for each block-compressed GPU format three can hold.
 *
 * Quoted as the amortised per-pixel cost: BC7/ASTC 4x4 and ETC2 EAC RGBA are
 * 16 bytes per 4x4 block = 1 B/px; BC1/ETC1/ETC2 RGB are 8 bytes per block =
 * 0.5 B/px; ASTC 6x6 is 16 bytes per 36 pixels.
 */
function compressedBytesPerPixel(format: number): number {
  switch (format) {
    case THREE.RGBA_ASTC_4x4_Format:
    case THREE.RGBA_BPTC_Format:
    case THREE.RGB_BPTC_UNSIGNED_Format:
    case THREE.RGBA_S3TC_DXT5_Format:
    case THREE.RGBA_ETC2_EAC_Format:
    case THREE.RED_GREEN_RGTC2_Format:
      return 1;
    case THREE.RGBA_ASTC_6x6_Format:
      return 16 / 36;
    case THREE.RGBA_S3TC_DXT1_Format:
    case THREE.RGB_S3TC_DXT1_Format:
    case THREE.RGB_ETC2_Format:
    case THREE.RGB_ETC1_Format:
    case THREE.RED_RGTC1_Format:
    case THREE.RGBA_PVRTC_4BPPV1_Format:
    case THREE.RGB_PVRTC_4BPPV1_Format:
      return 0.5;
    default:
      return 1;
  }
}

/** Channel count implied by an uncompressed format. */
function channelsOf(format: number): number {
  if (format === THREE.RedFormat) return 1;
  if (format === THREE.RGFormat) return 2;
  if (format === THREE.RGBFormat) return 3;
  return 4;
}

/** Bytes per channel implied by a texture type. */
function bytesPerChannel(type: number): number {
  if (type === THREE.FloatType || type === THREE.UnsignedIntType) return 4;
  if (type === THREE.HalfFloatType || type === THREE.UnsignedShortType) return 2;
  return 1;
}

/** Approximate resident GPU bytes for one texture, mip chain included. */
export function estimateGpuBytes(texture: THREE.Texture): number {
  // Exact path: the KTX2/Basis loaders keep every uploaded level.
  const mipmaps = texture.mipmaps as ReadonlyArray<{ data?: ArrayBufferView }> | undefined;
  if (mipmaps !== undefined && mipmaps.length > 0) {
    let total = 0;
    let complete = true;
    for (const level of mipmaps) {
      const bytes = level?.data?.byteLength;
      if (typeof bytes === 'number') total += bytes;
      else complete = false;
    }
    if (complete && total > 0) return total;
  }

  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (width <= 0 || height <= 0) return 0;

  const compressed = (texture as { isCompressedTexture?: boolean }).isCompressedTexture === true;
  const perPixel = compressed
    ? compressedBytesPerPixel(texture.format)
    : channelsOf(texture.format) * bytesPerChannel(texture.type);

  let bytes = width * height * perPixel;
  // A full mip chain adds a third again (1 + 1/4 + 1/16 + ... -> 4/3).
  const hasMips =
    texture.generateMipmaps === true || (mipmaps !== undefined && mipmaps.length > 1);
  if (hasMips) bytes *= 4 / 3;
  return Math.round(bytes);
}

/* -------------------------------------------------------------------------- */
/* LRU                                                                        */
/* -------------------------------------------------------------------------- */

/** What the LRU needs to know about one resident item. */
export interface IEvictable {
  readonly key: string;
  readonly gpuBytes: number;
  readonly refCount: number;
  /** Free the GPU resource. Called only when `refCount === 0`. */
  dispose(): void;
}

/** Outcome of one eviction pass, for logging and for the harness to assert. */
export interface IEvictionReport {
  readonly evicted: readonly string[];
  readonly bytesFreed: number;
  readonly bytesResident: number;
  readonly budgetBytes: number;
  /** True when referenced items kept the total above budget. */
  readonly overBudget: boolean;
  /** Keys that would have been evicted but are still referenced. */
  readonly pinned: readonly string[];
}

/**
 * Reference-counted LRU over resident textures.
 *
 * Recency is a monotonically increasing counter rather than a clock: two
 * touches inside the same millisecond must still order deterministically, or
 * eviction becomes timing-dependent and the tests become flaky.
 */
export class TextureMemory {
  private readonly items = new Map<string, IEvictable>();
  private readonly touched = new Map<string, number>();
  private readonly inserted = new Map<string, number>();
  private clock = 0;
  private insertCount = 0;
  private residentBytes = 0;
  private budget: number;
  private eager = false;
  private overBudgetWarned = false;

  constructor(
    budgetBytes: number,
    /**
     * How many of the most recently INSERTED textures are exempt from
     * eviction.
     *
     * Closes a real race: a material awaits three maps in parallel, and
     * between the moment the albedo is inserted and the moment the material
     * retains it there is a microtask in which the albedo has refCount 0 and
     * is a perfectly good eviction candidate. Evicting it there means the
     * material permanently binds a stand-in for a texture that loaded
     * successfully. Eight is the default fetch concurrency plus headroom;
     * exemption is by INSERT order, so it self-clears and does not distort
     * the LRU for anything already resident.
     */
    private readonly protectRecentInserts = 8
  ) {
    this.budget = Math.max(0, budgetBytes);
  }

  get budgetBytes(): number {
    return this.budget;
  }

  get bytes(): number {
    return this.residentBytes;
  }

  get count(): number {
    return this.items.size;
  }

  /** Keys resident right now, least recently used first. */
  get lruOrder(): readonly string[] {
    return [...this.items.keys()].sort(
      (a, b) => (this.touched.get(a) ?? 0) - (this.touched.get(b) ?? 0)
    );
  }

  setBudget(bytes: number): void {
    this.budget = Math.max(0, bytes);
    this.overBudgetWarned = false;
  }

  /** Free unreferenced handles the moment their count hits zero. */
  setEagerRelease(enabled: boolean): void {
    this.eager = enabled;
  }

  get eagerRelease(): boolean {
    return this.eager;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  get(key: string): IEvictable | undefined {
    const item = this.items.get(key);
    if (item) this.touch(key);
    return item;
  }

  /** Look up without affecting recency. Used by diagnostics. */
  peek(key: string): IEvictable | undefined {
    return this.items.get(key);
  }

  touch(key: string): void {
    if (this.items.has(key)) this.touched.set(key, ++this.clock);
  }

  /** Insert a resident item and trim back to budget. */
  insert(item: IEvictable): IEvictionReport {
    const existing = this.items.get(item.key);
    if (existing) this.residentBytes -= existing.gpuBytes;
    this.items.set(item.key, item);
    this.touched.set(item.key, ++this.clock);
    this.inserted.set(item.key, ++this.insertCount);
    this.residentBytes += item.gpuBytes;
    return this.trim();
  }

  /** True while an item is inside the just-inserted exemption window. */
  private isProtected(key: string): boolean {
    const order = this.inserted.get(key);
    if (order === undefined) return false;
    return order > this.insertCount - this.protectRecentInserts;
  }

  /**
   * Drop an item outright. Refuses while it is still referenced, because the
   * caller cannot know who else is drawing with it.
   */
  remove(key: string, force = false): boolean {
    const item = this.items.get(key);
    if (!item) return false;
    if (item.refCount > 0 && !force) {
      log.warn(
        `refusing to unload "${key}": still referenced ${item.refCount}x. ` +
          `Release every handle first.`
      );
      return false;
    }
    this.items.delete(key);
    this.touched.delete(key);
    this.inserted.delete(key);
    this.residentBytes -= item.gpuBytes;
    item.dispose();
    return true;
  }

  /**
   * Called when a handle's count reaches zero. Frees immediately in eager mode
   * or when already over budget; otherwise leaves it cached and evictable.
   */
  notifyUnreferenced(key: string): void {
    if (this.eager) {
      this.remove(key);
      return;
    }
    if (this.residentBytes > this.budget) this.trim();
  }

  /** Evict least-recently-used unreferenced items until back inside budget. */
  trim(): IEvictionReport {
    const evicted: string[] = [];
    const pinned: string[] = [];
    let freed = 0;

    if (this.residentBytes <= this.budget) {
      return {
        evicted,
        bytesFreed: 0,
        bytesResident: this.residentBytes,
        budgetBytes: this.budget,
        overBudget: false,
        pinned,
      };
    }

    const target = this.budget * EVICTION_TARGET_FRACTION;
    for (const key of this.lruOrder) {
      if (this.residentBytes <= target) break;
      const item = this.items.get(key);
      if (!item) continue;
      if (item.refCount > 0) {
        pinned.push(key);
        continue;
      }
      // Just-arrived textures are exempt: their owner has not had a chance to
      // retain them yet. See `protectRecentInserts`.
      if (this.isProtected(key)) {
        pinned.push(key);
        continue;
      }
      const bytes = item.gpuBytes;
      this.items.delete(key);
      this.touched.delete(key);
      this.inserted.delete(key);
      this.residentBytes -= bytes;
      item.dispose();
      evicted.push(key);
      freed += bytes;
    }

    const overBudget = this.residentBytes > this.budget;
    if (evicted.length > 0) {
      log.debug(
        `evicted ${evicted.length} texture(s), freed ${(freed / 1048576).toFixed(1)} MB; ` +
          `resident ${(this.residentBytes / 1048576).toFixed(1)} MB / ` +
          `${(this.budget / 1048576).toFixed(0)} MB`
      );
    }
    if (overBudget && !this.overBudgetWarned) {
      this.overBudgetWarned = true;
      log.warn(
        `texture memory over budget: ${(this.residentBytes / 1048576).toFixed(1)} MB resident ` +
          `against a ${(this.budget / 1048576).toFixed(0)} MB ceiling, and ${pinned.length} ` +
          `candidate(s) are still referenced so they cannot be evicted. ` +
          `Release handles or lower the asset tier.`
      );
    }
    return {
      evicted,
      bytesFreed: freed,
      bytesResident: this.residentBytes,
      budgetBytes: this.budget,
      overBudget,
      pinned,
    };
  }

  /** Free everything, referenced or not. Shutdown path only. */
  clear(): void {
    for (const item of this.items.values()) item.dispose();
    this.items.clear();
    this.touched.clear();
    this.inserted.clear();
    this.residentBytes = 0;
  }
}
