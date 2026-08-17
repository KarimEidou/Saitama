/**
 * SHADER WARMUP — compile every program during loading, not during the fight.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * WebGL compiles and links a shader program the first time it is used to draw.
 * The call is synchronous and blocks the main thread. On mid-range Android a
 * `MeshStandardMaterial` with maps, shadows, cascades and IBL takes 30-120ms to
 * link. The first serious punch spawns instanced, vertex-coloured debris that
 * has never been drawn before, so the game links that program in the middle of
 * the frame the player was waiting for — a ~400ms freeze at exactly the worst
 * moment.
 *
 * `KHR_parallel_shader_compile` would let the driver do this on a worker
 * thread. It is NOT available in this project's verified target environment, so
 * there is no asynchronous option and no way to hide the cost. The only
 * remaining move is to pay it while a loading bar is on screen.
 *
 * ── WHY 4x4 IS ENOUGH ──────────────────────────────────────────────────────
 * Linking depends on the program, not the pixel count. Drawing into a 4x4
 * target compiles, links and validates exactly the same program object that
 * gameplay will use, at essentially zero fragment cost.
 *
 * ── THE THREE TRAPS ────────────────────────────────────────────────────────
 * 1. THE DESTINATION IS PART OF THE PROGRAM. three compiles a material
 *    differently depending on where it is drawing: rendering to the default
 *    framebuffer gives `outputColorSpace: srgb` and the active tone mapping,
 *    while rendering to any render target gives `srgb-linear` and
 *    `NoToneMapping`. Those are two distinct programs for the same material.
 *
 *    So the destination must MATCH the tier. A composer-less LOW tier only
 *    ever draws direct; MID/HIGH only ever draw into the composer's HDR target.
 *    Warming both would double the program count with variants that can never
 *    be used — which is exactly what happens by accident, because
 *    `renderer.compile()` compiles for whatever render target happens to be
 *    bound when it is called. This class binds the destination first.
 *
 * 2. LIGHTS AND FOG ARE PART OF THE PROGRAM. Directional light count, shadow
 *    count, fog mode and `scene.environment` all key the program cache. A
 *    warmup scene with different lighting compiles DIFFERENT programs and
 *    warms nothing. That is why this class renders the REAL scene with the
 *    probe meshes temporarily added, rather than building its own.
 *
 * 3. GEOMETRY LAYOUT IS PART OF THE PROGRAM. `USE_INSTANCING`, `USE_SKINNING`
 *    and `USE_COLOR` come from the OBJECT, not the material, so one material
 *    drawn on an `InstancedMesh` and on a `SkinnedMesh` is two programs.
 *    Callers declare the layouts each material will really be used with.
 */

import * as THREE from 'three';
import type { IDisposable } from '@/types';
import { createLogger } from '@/util';
import { INSTANCE_TINT_ATTRIBUTE, INSTANCE_WEAR_ATTRIBUTE } from './shader-chunks';

const log = createLogger('engine.warmup');

/**
 * Vertex-attribute layouts a material may be drawn with. Each one is a
 * SEPARATE program for the same material, because three adds `USE_INSTANCING`,
 * `USE_SKINNING` and `USE_COLOR` from the OBJECT, not the material.
 */
export type WarmupGeometryKind =
  /** position / normal / uv — buildings, props, terrain. */
  | 'static'
  /** InstancedMesh with the engine's per-instance tint and wear attributes. */
  | 'instanced'
  /** SkinnedMesh — characters. */
  | 'skinned'
  /** Per-vertex colours — fracture debris tints itself this way. */
  | 'vertexColors'
  /** Instanced AND vertex-coloured — the debris burst from a serious punch. */
  | 'instancedVertexColors';

export interface IWarmupEntry {
  readonly material: THREE.Material;
  /** Layouts this material will actually be drawn with. */
  readonly kinds: readonly WarmupGeometryKind[];
  /** Warm the shadow-depth variant too. */
  readonly castShadow?: boolean;
}

export interface IShaderWarmupOptions {
  /** Edge of the offscreen probe target. */
  readonly size?: number;
  /**
   * Warm the RENDER-TARGET variants (`srgb-linear`, `NoToneMapping`). Required
   * whenever an EffectComposer is in use — i.e. the MID and HIGH tiers.
   */
  readonly includeOffscreen?: boolean;
  /**
   * Warm the DEFAULT-FRAMEBUFFER variants (`srgb`, tone mapped). Required
   * whenever the game renders without an EffectComposer — i.e. the LOW tier.
   *
   * Turn this OFF on composer tiers: those variants can never be used there,
   * and warming them doubles the material program count.
   */
  readonly includeDirectFramebuffer?: boolean;
  /** Force a shadow-map render so depth materials link. */
  readonly warmShadows?: boolean;
}

export interface IWarmupReport {
  readonly materials: number;
  readonly meshes: number;
  readonly programsBefore: number;
  readonly programsAfter: number;
  /** Programs linked by the warmup. This number is the hitch that did not happen. */
  readonly compiled: number;
  readonly durationMs: number;
  /** Destinations warmed, e.g. `['offscreen']` or `['direct']`. */
  readonly destinations: readonly ('offscreen' | 'direct')[];
  readonly renderedShadows: boolean;
}

export class ShaderWarmup implements IDisposable {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly entries: IWarmupEntry[] = [];
  private readonly options: Required<IShaderWarmupOptions>;

  private readonly group = new THREE.Group();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly disposables: (THREE.BufferGeometry | THREE.Skeleton)[] = [];
  private disposed = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    options: IShaderWarmupOptions = {}
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.options = {
      size: options.size ?? 4,
      includeOffscreen: options.includeOffscreen ?? true,
      includeDirectFramebuffer: options.includeDirectFramebuffer ?? true,
      warmShadows: options.warmShadows ?? true,
    };

    this.group.name = 'shaderWarmup';
    // Parked far from the play area so a stray frame cannot show the probes,
    // and so they never intersect real geometry or the shadow cascades.
    this.group.position.set(0, -10000, 0);
    this.group.visible = true;

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this.camera.position.set(0, -10000, 6);
    this.camera.lookAt(0, -10000, 0);

    this.target = new THREE.WebGLRenderTarget(this.options.size, this.options.size, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    this.target.texture.name = 'warmup.probe';
  }

  /** Queue one material with the layouts it will be drawn with. */
  add(
    material: THREE.Material,
    kinds: readonly WarmupGeometryKind[] = ['static'],
    castShadow = true
  ): this {
    this.entries.push({ material, kinds, castShadow });
    return this;
  }

  /** Queue many materials sharing the same layouts. */
  addAll(
    materials: Iterable<THREE.Material>,
    kinds: readonly WarmupGeometryKind[] = ['static'],
    castShadow = true
  ): this {
    for (const material of materials) this.add(material, kinds, castShadow);
    return this;
  }

  get queued(): number {
    return this.entries.length;
  }

  /**
   * Compile everything. Blocking and slow BY DESIGN — call it behind a loading
   * screen, never during play.
   */
  run(): IWarmupReport {
    const started = performance.now();
    const renderer = this.renderer;
    const info = renderer.info;
    const programsBefore = info.programs?.length ?? 0;

    let meshes = 0;
    for (const entry of this.entries) {
      for (const kind of entry.kinds) {
        const mesh = this.buildProbe(entry.material, kind);
        if (!mesh) continue;
        mesh.castShadow = entry.castShadow ?? true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        this.group.add(mesh);
        meshes++;
      }
    }

    this.scene.add(this.group);

    // Preserve everything the probe render touches.
    const previousTarget = renderer.getRenderTarget();
    const previousShadowAuto = renderer.shadowMap.autoUpdate;
    const previousViewport = new THREE.Vector4();
    const previousScissor = new THREE.Vector4();
    renderer.getViewport(previousViewport);
    renderer.getScissor(previousScissor);
    const previousScissorTest = renderer.getScissorTest();

    let renderedShadows = false;
    if (this.options.warmShadows && renderer.shadowMap.enabled) {
      renderer.shadowMap.needsUpdate = true;
      renderedShadows = true;
    }

    const destinations: ('offscreen' | 'direct')[] = [];
    const size = this.options.size;

    if (this.options.includeOffscreen) {
      destinations.push('offscreen');
      renderer.setRenderTarget(this.target);
      // `compile()` must run with the destination ALREADY bound: it builds
      // programs for whatever render target is current, so compiling against
      // the wrong one produces a set of programs that will never be used.
      renderer.compile(this.scene, this.camera);
      renderer.clear();
      renderer.render(this.scene, this.camera);
    }

    if (this.options.includeDirectFramebuffer) {
      destinations.push('direct');
      // Same materials, tone-mapping and sRGB encode compiled in. Confined to a
      // 4x4 corner by the scissor so nothing visible is disturbed.
      renderer.setRenderTarget(null);
      renderer.setScissorTest(true);
      renderer.setScissor(0, 0, size, size);
      renderer.setViewport(0, 0, size, size);
      renderer.compile(this.scene, this.camera);
      renderer.render(this.scene, this.camera);
    }

    // Restore.
    renderer.setScissorTest(previousScissorTest);
    renderer.setScissor(previousScissor);
    renderer.setViewport(previousViewport);
    renderer.setRenderTarget(previousTarget);
    renderer.shadowMap.autoUpdate = previousShadowAuto;

    this.scene.remove(this.group);

    const programsAfter = info.programs?.length ?? 0;
    const report: IWarmupReport = {
      materials: this.entries.length,
      meshes,
      programsBefore,
      programsAfter,
      compiled: Math.max(0, programsAfter - programsBefore),
      durationMs: performance.now() - started,
      destinations,
      renderedShadows,
    };

    log.info(
      `warmed ${report.meshes} probes across ${report.materials} materials for ` +
        `[${destinations.join(', ')}] in ${report.durationMs.toFixed(1)}ms — ` +
        `${report.programsAfter} live programs (+${report.compiled})`
    );
    return report;
  }

  /* ---------------------------------------------------------------------- */

  private buildProbe(material: THREE.Material, kind: WarmupGeometryKind): THREE.Object3D | null {
    switch (kind) {
      case 'static':
        return new THREE.Mesh(this.trackGeometry(makeBox()), material);

      case 'vertexColors':
        return new THREE.Mesh(this.trackGeometry(makeBox(true)), material);

      case 'instanced':
      case 'instancedVertexColors': {
        const geometry = this.trackGeometry(makeBox(kind === 'instancedVertexColors'));
        const mesh = new THREE.InstancedMesh(geometry, material, 2);
        // The engine's per-instance attributes are read unconditionally by any
        // material with the instanceVariation injection. Missing them would
        // compile a program that never gets used with real content.
        geometry.setAttribute(
          INSTANCE_TINT_ATTRIBUTE,
          new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1, 1, 1, 1]), 3)
        );
        geometry.setAttribute(
          INSTANCE_WEAR_ATTRIBUTE,
          new THREE.InstancedBufferAttribute(new Float32Array([0, 0.5]), 1)
        );
        const matrix = new THREE.Matrix4();
        mesh.setMatrixAt(0, matrix);
        matrix.setPosition(2, 0, 0);
        mesh.setMatrixAt(1, matrix);
        mesh.instanceMatrix.needsUpdate = true;
        return mesh;
      }

      case 'skinned': {
        const geometry = this.trackGeometry(makeBox());
        const vertexCount = geometry.attributes.position!.count;
        const skinIndices = new Uint16Array(vertexCount * 4);
        const skinWeights = new Float32Array(vertexCount * 4);
        for (let i = 0; i < vertexCount; i++) skinWeights[i * 4] = 1;
        geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
        geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));

        const root = new THREE.Bone();
        const child = new THREE.Bone();
        child.position.y = 1;
        root.add(child);
        const skeleton = new THREE.Skeleton([root, child]);
        this.disposables.push(skeleton);

        const mesh = new THREE.SkinnedMesh(geometry, material);
        mesh.add(root);
        mesh.bind(skeleton);
        return mesh;
      }
    }
  }

  private trackGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    this.disposables.push(geometry);
    return geometry;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.entries.length = 0;
    this.target.dispose();
  }
}

/** Unit box with normals and UVs, optionally with per-vertex colours. */
function makeBox(vertexColors = false): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  if (vertexColors) {
    const count = geometry.attributes.position!.count;
    const colors = new Float32Array(count * 3).fill(1);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  return geometry;
}
