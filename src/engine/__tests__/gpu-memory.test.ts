/**
 * THE MEMORY REPORT HAS TO BE RIGHT IN BOTH DIRECTIONS
 *
 * `estimateSceneMemory` exists to catch a budget being blown. A number that
 * over-reports interleaved geometry threefold while ignoring instance matrices
 * entirely is not conservative — it is wrong twice, and it is wrong exactly
 * where a real city scene lives: glTF-loaded props use interleaved buffers, and
 * a crowd's `instanceMatrix` is 64 bytes per copy of pure GPU memory that hangs
 * off the mesh rather than the geometry.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { estimateSceneMemory, estimateTextureBytes, formatBytes } from '../gpu-memory';

describe('estimateSceneMemory geometry accounting', () => {
  it('counts an interleaved vertex buffer once, not once per attribute view', () => {
    // position(3) + normal(3) + uv(2) = 8 floats per vertex, over 3 vertices —
    // the standard packed-prop layout, and ONE upload as far as three is
    // concerned because it keys its GPU buffer on the InterleavedBuffer.
    const data = new Float32Array(8 * 3);
    const interleaved = new THREE.InterleavedBuffer(data, 8);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
    geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(interleaved, 3, 3));
    geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(interleaved, 2, 6));

    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    expect(estimateSceneMemory(scene).geometryBytes).toBe(data.byteLength);
  });

  it('still counts separate attributes separately', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));

    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    expect(estimateSceneMemory(scene).geometryBytes).toBe(9 * 4 * 2);
  });

  it('counts the instance matrix, which lives on the mesh and not the geometry', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const scene = new THREE.Scene();
    scene.add(new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 100));

    const report = estimateSceneMemory(scene);
    expect(report.instanceCount).toBe(100);
    // 9 position floats plus a 16-float matrix per instance.
    expect(report.geometryBytes).toBe(9 * 4 + 100 * 16 * 4);
  });
});

/** A compressed mip level as the KTX2/Basis loaders produce one. */
function mipLevel(
  bytes: number,
  size: number
): { data: Uint8Array; width: number; height: number } {
  return { data: new Uint8Array(bytes), width: size, height: size };
}

describe('formatBytes', () => {
  it('switches unit at the right thresholds', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.50 MB');
  });
});

describe('estimateTextureBytes uncompressed formats', () => {
  it('charges an RGBA8 texture its base level alone when it has no mips', () => {
    const texture = new THREE.DataTexture(new Uint8Array(512 * 512 * 4), 512, 512);
    texture.generateMipmaps = false;
    expect(estimateTextureBytes(texture)).toBe(1_048_576);
  });

  it('adds a third again for a full mip chain', () => {
    const texture = new THREE.DataTexture(new Uint8Array(512 * 512 * 4), 512, 512);
    texture.generateMipmaps = true;
    expect(estimateTextureBytes(texture)).toBeCloseTo((512 * 512 * 4 * 4) / 3, 1);
  });

  it('follows the texture type', () => {
    const half = new THREE.DataTexture(
      new Uint16Array(256 * 128 * 4),
      256,
      128,
      THREE.RGBAFormat,
      THREE.HalfFloatType
    );
    expect(estimateTextureBytes(half)).toBe(262_144);
  });

  it('follows the pixel format', () => {
    const red = new THREE.DataTexture(new Uint8Array(64 * 64), 64, 64, THREE.RedFormat);
    expect(estimateTextureBytes(red)).toBe(4096);

    const rg = new THREE.DataTexture(
      new Uint16Array(64 * 64 * 2),
      64,
      64,
      THREE.RGFormat,
      THREE.HalfFloatType
    );
    expect(estimateTextureBytes(rg)).toBe(16_384);
  });

  it('charges nothing for a texture with no resident image', () => {
    expect(estimateTextureBytes(new THREE.Texture())).toBe(0);

    const empty = new THREE.Texture();
    empty.image = { width: 0, height: 128 };
    expect(estimateTextureBytes(empty)).toBe(0);
  });
});

/*
 * ── COMPRESSED PAGES ARE NOT 4 BYTES PER PIXEL ────────────────────────────
 *
 * `bytesPerTexel` maps every unrecognised format to 4 channels x 1 byte, and
 * every block-compressed format lands in that default. `IQualitySettings.
 * textureCodec` is etc1s/astc/bc7 on all three tiers, so that was the NORMAL
 * case: a BC7 page was charged 4x its real cost and an ETC2 RGB page 8x — in
 * the direction that makes a healthy budget look blown, which is precisely the
 * decision this module exists to support.
 */
describe('estimateTextureBytes compressed formats', () => {
  it('charges BC7 one byte per pixel, not four', () => {
    const bc7 = new THREE.CompressedTexture([], 1024, 1024, THREE.RGBA_BPTC_Format);
    expect(estimateTextureBytes(bc7)).toBe(1_048_576);

    bc7.generateMipmaps = true;
    expect(estimateTextureBytes(bc7)).toBeCloseTo((1024 * 1024 * 4) / 3, 1);
  });

  it('charges ETC2 RGB half a byte per pixel', () => {
    const etc2 = new THREE.CompressedTexture([], 1024, 1024, THREE.RGB_ETC2_Format);
    expect(estimateTextureBytes(etc2)).toBe(524_288);
  });

  it('charges ASTC 6x6 sixteen bytes per thirty-six pixels', () => {
    const astc = new THREE.CompressedTexture([], 512, 512, THREE.RGBA_ASTC_6x6_Format);
    expect(estimateTextureBytes(astc)).toBeCloseTo((512 * 512 * 16) / 36, 1);
  });

  it('prefers the exact mip payload when the loader kept every level', () => {
    const texture = new THREE.CompressedTexture(
      [mipLevel(1000, 32), mipLevel(250, 16)],
      // Deliberately absurd dimensions: the exact path must ignore them.
      4096,
      4096,
      THREE.RGBA_BPTC_Format
    );
    expect(estimateTextureBytes(texture)).toBe(1250);
  });

  it('falls back to the block rate when the mip payload is only partly there', () => {
    const texture = new THREE.CompressedTexture(
      [mipLevel(1000, 64), { width: 32, height: 32 }] as unknown as ImageData[],
      64,
      64,
      THREE.RGBA_BPTC_Format
    );
    // Summing what happens to be present would report 1000 bytes for a page
    // that really costs 64*64 at 1 B/px, plus the chain the mip list implies.
    expect(estimateTextureBytes(texture)).not.toBe(1000);
    expect(estimateTextureBytes(texture)).toBeCloseTo((64 * 64 * 4) / 3, 1);
  });

  it('charges an RGB texture three channels, not four', () => {
    const rgb = new THREE.DataTexture(new Uint8Array(64 * 64 * 3), 64, 64, THREE.RGBFormat);
    expect(estimateTextureBytes(rgb)).toBe(12_288);
  });
});

describe('estimateSceneMemory', () => {
  it('de-duplicates by object identity — the whole point of MaterialLib', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const map = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const material = new THREE.MeshStandardMaterial({ map });
    const scene = new THREE.Scene();
    for (let i = 0; i < 100; i++) scene.add(new THREE.Mesh(geometry, material));

    const report = estimateSceneMemory(scene);
    expect(report.textureCount).toBe(1);
    expect(report.geometryCount).toBe(1);
    expect(report.materialCount).toBe(1);
    expect(report.meshCount).toBe(100);
  });

  it('counts every entry of a multi-material mesh', () => {
    const scene = new THREE.Scene();
    scene.add(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
        new THREE.MeshStandardMaterial(),
        new THREE.MeshBasicMaterial(),
      ])
    );
    expect(estimateSceneMemory(scene).materialCount).toBe(2);
  });

  it('counts instances across every InstancedMesh', () => {
    const material = new THREE.MeshStandardMaterial();
    const scene = new THREE.Scene();
    scene.add(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, 400));
    scene.add(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, 120));

    const report = estimateSceneMemory(scene);
    expect(report.meshCount).toBe(2);
    expect(report.instanceCount).toBe(520);
  });

  it('counts triangles from the index when there is one and from positions otherwise', () => {
    const indexed = new THREE.BufferGeometry();
    indexed.setAttribute('position', new THREE.BufferAttribute(new Float32Array(36 * 3), 3));
    indexed.setIndex(new THREE.BufferAttribute(new Uint16Array(36), 1));

    const soup = new THREE.BufferGeometry();
    soup.setAttribute('position', new THREE.BufferAttribute(new Float32Array(36 * 3), 3));

    const material = new THREE.MeshStandardMaterial();
    const one = new THREE.Scene();
    one.add(new THREE.Mesh(indexed, material));
    expect(estimateSceneMemory(one).triangles).toBe(12);

    const two = new THREE.Scene();
    two.add(new THREE.Mesh(soup, material));
    expect(estimateSceneMemory(two).triangles).toBe(12);

    const both = new THREE.Scene();
    both.add(new THREE.Mesh(indexed, material));
    both.add(new THREE.Mesh(soup, material));
    expect(estimateSceneMemory(both).triangles).toBe(24);
  });

  it('finds textures hiding in ShaderMaterial uniforms', () => {
    // No TEXTURE_SLOTS walk would ever reach this one.
    const material = new THREE.ShaderMaterial({
      uniforms: { tCustom: { value: new THREE.DataTexture(new Uint8Array(4), 1, 1) } },
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));

    expect(estimateSceneMemory(scene).textureCount).toBe(1);
  });

  it('counts scene-level maps, which no mesh can reach', () => {
    const scene = new THREE.Scene();
    scene.environment = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    scene.background = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    expect(estimateSceneMemory(scene).textureCount).toBe(2);

    const flat = new THREE.Scene();
    flat.background = new THREE.Color(0x112233);
    expect(estimateSceneMemory(flat).textureCount).toBe(0);
  });

  it('sums vertex and index buffers for a plain non-interleaved geometry', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    const expected =
      geometry.attributes.position!.array.byteLength +
      geometry.attributes.normal!.array.byteLength +
      geometry.attributes.uv!.array.byteLength +
      geometry.index!.array.byteLength;

    expect(estimateSceneMemory(scene).geometryBytes).toBe(expected);
  });
});
