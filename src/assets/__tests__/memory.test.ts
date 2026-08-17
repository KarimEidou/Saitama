/**
 * TEXTURE MEMORY: MEASUREMENT, REFERENCE COUNTS AND LRU EVICTION
 *
 * The invariant worth more than the budget itself: a referenced texture is
 * never evicted. Freeing one out from under a material that is still drawing
 * with it produces a black surface or a GL error somewhere unrelated, and the
 * bug gets filed against the renderer.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { estimateGpuBytes, TextureMemory, type IEvictable } from '../memory';
import { ManagedTextureHandle } from '../textures';

/** A resident item with a settable count, standing in for a real handle. */
function item(key: string, bytes: number, refCount = 0): IEvictable & { refs: number } {
  const disposed = vi.fn();
  return {
    key,
    gpuBytes: bytes,
    refs: refCount,
    get refCount(): number {
      return this.refs;
    },
    dispose: disposed,
  } as IEvictable & { refs: number };
}

const MB = 1024 * 1024;

describe('estimateGpuBytes', () => {
  it('sums the real mip chain when the loader kept one', () => {
    const texture = new THREE.Texture();
    texture.image = { width: 4, height: 4 };
    texture.mipmaps = [
      { data: new Uint8Array(16), width: 4, height: 4 },
      { data: new Uint8Array(8), width: 2, height: 2 },
    ] as unknown as THREE.Texture['mipmaps'];
    expect(estimateGpuBytes(texture)).toBe(24);
  });

  it('charges 1 byte/px for BC7 and adds the mip tail', () => {
    const texture = new THREE.CompressedTexture([], 1024, 1024, THREE.RGBA_BPTC_Format);
    texture.generateMipmaps = true;
    // 1024*1024*1 * 4/3
    expect(estimateGpuBytes(texture)).toBe(Math.round(1024 * 1024 * (4 / 3)));
  });

  it('charges half a byte per pixel for the RGB block formats', () => {
    const texture = new THREE.CompressedTexture([], 512, 512, THREE.RGB_ETC1_Format);
    expect(estimateGpuBytes(texture)).toBe(512 * 512 * 0.5);
  });

  it('charges 8 bytes/px for an RGBA16F environment map', () => {
    const texture = new THREE.DataTexture(
      new Uint16Array(0),
      1024,
      512,
      THREE.RGBAFormat,
      THREE.HalfFloatType
    );
    texture.mipmaps = [];
    expect(estimateGpuBytes(texture)).toBe(1024 * 512 * 8);
  });

  it('charges 4 bytes/px for an uncompressed character atlas', () => {
    const texture = new THREE.DataTexture(new Uint8Array(0), 1024, 1024);
    texture.mipmaps = [];
    expect(estimateGpuBytes(texture)).toBe(1024 * 1024 * 4);
  });

  it('reports zero rather than NaN for a texture with no image', () => {
    expect(estimateGpuBytes(new THREE.Texture())).toBe(0);
  });
});

describe('TextureMemory', () => {
  it('evicts least-recently-used first', () => {
    const memory = new TextureMemory(100 * MB);
    const a = item('a', 40 * MB);
    const b = item('b', 40 * MB);
    memory.insert(a);
    memory.insert(b);
    memory.get('a'); // 'b' is now the least recently used

    const c = item('c', 40 * MB);
    const report = memory.insert(c);
    expect(report.evicted).toEqual(['b']);
    expect(memory.has('b')).toBe(false);
    expect(memory.has('a')).toBe(true);
    expect(b.dispose).toHaveBeenCalledTimes(1);
  });

  it('NEVER evicts a referenced texture, even under pressure', () => {
    const memory = new TextureMemory(100 * MB);
    const pinned = item('pinned', 80 * MB, 3);
    const loose = item('loose', 15 * MB);
    memory.insert(pinned);
    memory.insert(loose);

    const report = memory.insert(item('incoming', 40 * MB));
    expect(report.evicted).not.toContain('pinned');
    expect(report.pinned).toContain('pinned');
    expect(memory.has('pinned')).toBe(true);
    expect(pinned.dispose).not.toHaveBeenCalled();
  });

  it('reports going over budget rather than dropping a live texture', () => {
    const memory = new TextureMemory(50 * MB);
    memory.insert(item('a', 40 * MB, 1));
    const report = memory.insert(item('b', 40 * MB, 1));
    expect(report.overBudget).toBe(true);
    expect(report.evicted).toEqual([]);
    expect(memory.bytes).toBe(80 * MB);
  });

  it('trims to 90% of budget, not to exactly 100%', () => {
    const memory = new TextureMemory(100 * MB);
    for (let i = 0; i < 10; i++) memory.insert(item(`t${i}`, 10 * MB));
    memory.insert(item('extra', 10 * MB));
    expect(memory.bytes).toBeLessThanOrEqual(90 * MB);
  });

  it('refuses to remove a referenced texture unless forced', () => {
    const memory = new TextureMemory(100 * MB);
    const held = item('held', 10 * MB, 1);
    memory.insert(held);
    expect(memory.remove('held')).toBe(false);
    expect(memory.has('held')).toBe(true);
    expect(memory.remove('held', true)).toBe(true);
    expect(memory.has('held')).toBe(false);
  });

  it('frees at refCount 0 in eager mode and caches otherwise', () => {
    const lazy = new TextureMemory(1000 * MB);
    lazy.insert(item('x', MB));
    lazy.notifyUnreferenced('x');
    expect(lazy.has('x')).toBe(true);

    const eager = new TextureMemory(1000 * MB);
    eager.setEagerRelease(true);
    eager.insert(item('x', MB));
    eager.notifyUnreferenced('x');
    expect(eager.has('x')).toBe(false);
  });

  it('orders deterministically when touches happen in the same millisecond', () => {
    const memory = new TextureMemory(30 * MB);
    memory.insert(item('a', 10 * MB));
    memory.insert(item('b', 10 * MB));
    memory.insert(item('c', 10 * MB));
    memory.touch('a');
    memory.touch('b');
    memory.touch('c');
    expect(memory.lruOrder).toEqual(['a', 'b', 'c']);
  });
});

describe('ManagedTextureHandle', () => {
  function makeHandle(onUnreferenced?: (key: string) => void): ManagedTextureHandle {
    const texture = new THREE.CompressedTexture([], 256, 256, THREE.RGBA_BPTC_Format);
    return new ManagedTextureHandle({
      key: 'tex',
      texture,
      colorSpace: 'srgb',
      tier: 'mobile',
      onUnreferenced,
    });
  }

  it('counts retains and releases', () => {
    const handle = makeHandle();
    expect(handle.refCount).toBe(0);
    handle.retain().retain();
    expect(handle.refCount).toBe(2);
    handle.release();
    expect(handle.refCount).toBe(1);
  });

  it('notifies exactly once when the count reaches zero', () => {
    const onUnreferenced = vi.fn();
    const handle = makeHandle(onUnreferenced);
    handle.retain();
    handle.retain();
    handle.release();
    expect(onUnreferenced).not.toHaveBeenCalled();
    handle.release();
    expect(onUnreferenced).toHaveBeenCalledTimes(1);
  });

  it('refuses to drive the count negative on a double release', () => {
    const handle = makeHandle();
    handle.retain();
    handle.release();
    handle.release();
    expect(handle.refCount).toBe(0);
  });

  it('reports the GPU format and compression state', () => {
    const handle = makeHandle();
    expect(handle.compressed).toBe(true);
    expect(handle.gpuFormat).toBe('RGBA_BPTC_Format');
    expect(handle.codec).toBe('bc7');
    expect(handle.gpuBytes).toBeGreaterThan(0);
  });

  it('does not dispose the shared fallback pattern', () => {
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const dispose = vi.spyOn(texture, 'dispose');
    const handle = new ManagedTextureHandle({
      key: 'missing',
      texture,
      colorSpace: 'srgb',
      tier: 'fallback',
      fallback: true,
    });
    handle.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });
});
