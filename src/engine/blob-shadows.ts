/**
 * INSTANCED BLOB-SHADOW DECALS — one draw call for an entire crowd.
 *
 * Cascaded shadow maps cover 45-200 metres depending on tier. A city street
 * during a monster attack holds far more characters than that, and every one
 * outside the cascade range would either pop its shadow off (reads as floating)
 * or force a fourth cascade nobody can afford.
 *
 * The classic answer, and the one used here: past the cascade range each
 * character gets a soft dark ellipse on the ground. It is not a shadow, it is a
 * CONTACT CUE — it tells the eye the character is touching the floor, which is
 * the only thing a 20-pixel-tall silhouette needs. All of them render as a
 * single `InstancedMesh`: one draw call, one shader program, no shadow-map
 * render pass, no depth pass, no per-character state.
 *
 * ── WHY A CUSTOM SHADER FOR SOMETHING THIS SMALL ───────────────────────────
 * Per-blob opacity is the whole point (a blob fades out with distance and with
 * how far the character is off the ground). `MeshBasicMaterial` cannot vary
 * alpha per instance — `instanceColor` is RGB only — and multiply-blending
 * hacks cannot brighten a blob back towards invisible. Twenty lines of GLSL and
 * one `instanceAlpha` attribute solve it exactly, and cost one program.
 */

import * as THREE from 'three';
import type { IDisposable } from '@/types';
import { createBlobShadowTexture } from './procedural-textures';

export interface IBlobShadowOptions {
  /** Maximum simultaneous blobs. Preallocated; exceeding it drops extras. */
  readonly capacity?: number;
  /** Decal sprite. Alpha channel is the falloff. Generated when omitted. */
  readonly texture?: THREE.Texture;
  /** Darkness of a fully opaque blob, 0..1. */
  readonly strength?: number;
  /** Metres the decal floats above the ground to avoid z-fighting. */
  readonly groundOffset?: number;
}

const VERTEX_SHADER = /* glsl */ `
	attribute float instanceAlpha;
	varying vec2 vBlobUv;
	varying float vBlobAlpha;

	void main() {
		vBlobUv = uv;
		vBlobAlpha = instanceAlpha;
		vec4 worldPosition = instanceMatrix * vec4( position, 1.0 );
		gl_Position = projectionMatrix * modelViewMatrix * worldPosition;
	}
`;

const FRAGMENT_SHADER = /* glsl */ `
	uniform sampler2D uBlobMap;
	uniform float uStrength;
	varying vec2 vBlobUv;
	varying float vBlobAlpha;

	void main() {
		float mask = texture2D( uBlobMap, vBlobUv ).a;
		float alpha = mask * clamp( vBlobAlpha, 0.0, 1.0 ) * uStrength;
		if ( alpha < 0.004 ) discard;
		// Blending toward black with straight alpha darkens the ground in
		// whatever space the target is in — correct in HDR and after tone
		// mapping alike, which matters because LOW tier has no composer.
		gl_FragColor = vec4( 0.0, 0.0, 0.0, alpha );
	}
`;

export class BlobShadowField implements IDisposable {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;

  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly alphaAttribute: THREE.InstancedBufferAttribute;
  private readonly alphas: Float32Array;
  private readonly ownedTexture: THREE.Texture | undefined;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly groundOffset: number;
  private live = 0;
  private disposed = false;

  constructor(options: IBlobShadowOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 192);
    this.groundOffset = options.groundOffset ?? 0.02;

    const texture = options.texture ?? createBlobShadowTexture();
    if (!options.texture) this.ownedTexture = texture;

    // A unit quad lying in the XZ plane. Pre-rotating the GEOMETRY means every
    // per-instance matrix is a plain translate+scale with an identity rotation,
    // which keeps `add()` allocation-free and branchless.
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      name: 'blobShadow',
      uniforms: {
        uBlobMap: { value: texture },
        uStrength: { value: options.strength ?? 0.55 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // The decal sits microscopically above the ground; polygon offset keeps
      // it there on GPUs with low depth precision instead of stippling.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, this.capacity);
    this.mesh.name = 'blobShadowField';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // Draw after opaque geometry but before transparent VFX.
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.alphas = new Float32Array(this.capacity);
    this.alphaAttribute = new THREE.InstancedBufferAttribute(this.alphas, 1);
    this.alphaAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('instanceAlpha', this.alphaAttribute);
  }

  /** Blobs submitted since the last `begin()`. */
  get count(): number {
    return this.live;
  }

  /** Start a frame. Call before any `add()`. */
  begin(): void {
    this.live = 0;
  }

  /**
   * Submit one blob.
   *
   * @param x       World X of the character's feet.
   * @param groundY World Y of the ground under them.
   * @param z       World Z of the character's feet.
   * @param radius  Blob radius in metres. Roughly the character's shoulder width.
   * @param alpha   0..1 opacity. Fade this with height off the ground and with
   *                distance so blobs dissolve rather than pop.
   * @returns false when the field is full and the blob was dropped.
   */
  add(x: number, groundY: number, z: number, radius: number, alpha = 1): boolean {
    if (this.live >= this.capacity) return false;
    if (alpha <= 0.004 || radius <= 0) return true;

    this.position.set(x, groundY + this.groundOffset, z);
    this.quaternion.identity();
    this.scale.set(radius * 2, 1, radius * 2);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.mesh.setMatrixAt(this.live, this.matrix);
    this.alphas[this.live] = alpha;
    this.live++;
    return true;
  }

  /** Finish the frame and upload. Call once, after all `add()` calls. */
  end(): void {
    this.mesh.count = this.live;
    if (this.live === 0) return;
    // Upload only the range actually written — a full 256-instance upload for
    // 12 live blobs is pure waste on a mobile bus.
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, this.live * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphaAttribute.clearUpdateRanges();
    this.alphaAttribute.addUpdateRange(0, this.live);
    this.alphaAttribute.needsUpdate = true;
  }

  /** Darkness of a fully opaque blob, 0..1. */
  setStrength(strength: number): void {
    this.material.uniforms.uStrength!.value = Math.min(1, Math.max(0, strength));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.ownedTexture?.dispose();
  }
}
