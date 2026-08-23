/**
 * MODEL LOD EXTRACTION AND GRAPH TEARDOWN
 *
 * The bug the LOD layout exists to prevent is a model that draws all three of
 * its decimated variants at once — 1.47x the triangles, 3x the draw
 * submissions and z-fighting across every surface, while looking identical.
 * `GLTFLoader` uniquifies duplicate node names, and the pipeline emits the SAME
 * three child names in every part of a model, so the matcher has to survive
 * `LOD0_191` as well as `LOD0`.
 *
 * The scenes here are built by hand and handed to `parseModel`/`parseCharacter`
 * through a stub loader: the real path needs meshopt, Draco and Basis, none of
 * which belong in a unit test, and none of which this file is about.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { IAssetLOD, IModelAsset } from '@/types';
import { disposeSceneGraph, extractLodGroups, parseCharacter, parseModel } from '../models';
import { missingTexture } from '../fallback';

/**
 * A `GLTFLoader` that hands back a scene the test built itself.
 *
 * `parseModel` and `parseCharacter` only ever touch `loader.parseAsync`, so a
 * five-line fake covers both of them in the default node environment — there is
 * no GPU, meshopt or Basis obstacle to testing either.
 */
function loaderFor(scene: THREE.Object3D, animations: THREE.AnimationClip[] = []): GLTFLoader {
  return {
    parseAsync: async (): Promise<{
      scene: THREE.Object3D;
      animations: THREE.AnimationClip[];
    }> => ({
      scene,
      animations,
    }),
  } as unknown as GLTFLoader;
}

/** A cube: 36 indices, i.e. 12 triangles once `countTriangles` divides. */
function boxMesh(name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.name = name;
  return mesh;
}

/** The declared triangle ladder the pipeline emits: full, ~35%, ~12%. */
const TRIANGLE_LADDER = [100, 35, 12] as const;

/**
 * One part of a model, exactly as it arrives from `GLTFLoader`.
 *
 * `suffix` is what `createUniqueName` appends to every repeat of a name it has
 * already seen — every part after the first, since the pipeline names all of
 * them `LOD0`/`LOD1`/`LOD2`. `levelCount` goes below three for the parts a
 * decimator stopped early on, which is what `setLodLevel`'s per-group clamp is
 * for.
 */
function part(name: string, suffix = '', levelCount = 3): THREE.Object3D {
  const group = new THREE.Group();
  group.name = `${name}__LOD${suffix}`;
  group.userData = {
    lod: {
      levels: TRIANGLE_LADDER.slice(0, levelCount).map((triangles, level) => ({
        level,
        triangles,
      })),
    },
  };
  for (let level = 0; level < levelCount; level++) {
    group.add(boxMesh(`LOD${level}${suffix}`));
  }
  return group;
}

/** Manifest LOD rows carrying the switch distances the pipeline baked. */
function manifestLods(distances: readonly number[]): IAssetLOD[] {
  return distances.map((screenDistance, level) => ({
    level,
    file: `mdl/x/lod${level}.glb`,
    triangles: TRIANGLE_LADDER[level] ?? 1,
    bytes: 1000,
    screenDistance,
  }));
}

function sceneOf(...parts: readonly THREE.Object3D[]): THREE.Object3D {
  const scene = new THREE.Group();
  for (const child of parts) scene.add(child);
  return scene;
}

describe('extractLodGroups', () => {
  it('finds the levels of EVERY part, not just the first', () => {
    // 23 of the 39 shipped models have more than one `__LOD` group; the worst
    // has 192. Matching only the bare `LOD0` name found the first part's
    // levels and dropped the other 191 groups, so those parts rendered LOD0
    // AND LOD1 AND LOD2 simultaneously at every distance.
    const groups = extractLodGroups(sceneOf(part('wall'), part('roof', '_1'), part('door', '_2')));
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.levels.length)).toEqual([3, 3, 3]);
    expect(groups[1]!.levels.map((level) => level.level)).toEqual([0, 1, 2]);
  });

  it('reads the declared triangle counts and the manifest switch distances', () => {
    const groups = extractLodGroups(sceneOf(part('wall')), [
      { level: 0, screenDistance: 0, triangles: 100, file: 'a', bytes: 1 },
      { level: 1, screenDistance: 40, triangles: 35, file: 'b', bytes: 1 },
      { level: 2, screenDistance: 90, triangles: 12, file: 'c', bytes: 1 },
    ]);
    expect(groups[0]!.levels.map((level) => level.triangles)).toEqual([100, 35, 12]);
    expect(groups[0]!.levels.map((level) => level.screenDistance)).toEqual([0, 40, 90]);
  });

  it('ignores a node that ends in __LOD but has no level children', () => {
    const bare = new THREE.Group();
    bare.name = 'artist_named__LOD';
    bare.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    expect(extractLodGroups(sceneOf(bare))).toEqual([]);
  });

  it('sorts the levels even when the graph lists them out of order', () => {
    // Node order in a GLB is whatever the exporter wrote; `setLodLevel` indexes
    // `levels` positionally, so an unsorted group would show LOD2 for level 0.
    const group = new THREE.Group();
    group.name = 'wall__LOD';
    group.add(boxMesh('LOD2'), boxMesh('LOD0'), boxMesh('LOD1'));
    const groups = extractLodGroups(sceneOf(group));
    expect(groups[0]!.levels.map((level) => level.level)).toEqual([0, 1, 2]);
  });

  it('counts the geometry when the node declares no triangle counts', () => {
    const declared = part('wall');
    expect(extractLodGroups(sceneOf(declared))[0]!.levels[0]!.triangles).toBe(100);

    const undeclared = part('wall');
    undeclared.userData = {};
    // A `BoxGeometry(1,1,1)` is 36 indices, i.e. 12 triangles.
    expect(extractLodGroups(sceneOf(undeclared))[0]!.levels[0]!.triangles).toBe(12);
  });

  it('falls back to a 0/25/50 ladder when the manifest declares no distances', () => {
    // `screenDistance` is optional on `IAssetLOD`. Storing `?? 0` for an absent
    // one made the ladder below unreachable, every level switched at 0, and
    // `THREE.LOD` then picked level 0 at every distance — distance-based LOD
    // silently became a no-op.
    const lods = [0, 1, 2].map(
      (level) =>
        ({
          level,
          file: `mdl/x/lod${level}.glb`,
          triangles: 100,
          bytes: 10,
        }) as unknown as IAssetLOD
    );
    const groups = extractLodGroups(sceneOf(part('wall')), lods);
    expect(groups[0]!.levels.map((level) => level.screenDistance)).toEqual([0, 25, 50]);
  });

  it('keeps an explicit screenDistance of 0', () => {
    // The shipped shape: `model.prop.barrel_stove` really is 0 / 6 / 17.1. A
    // declared 0 is a real distance, not an absent one.
    const groups = extractLodGroups(sceneOf(part('wall')), manifestLods([0, 6, 17.1]));
    expect(groups[0]!.levels.map((level) => level.screenDistance)).toEqual([0, 6, 17.1]);
  });
});

describe('parseModel', () => {
  const bytes = new ArrayBuffer(8);

  it('shows exactly one level per part, in every part', async () => {
    const scene = sceneOf(part('wall'), part('roof', '_1'));
    const model = await parseModel(loaderFor(scene), 'model.test', bytes, undefined, 1);

    expect(model.lodGroups).toHaveLength(2);
    for (const group of model.lodGroups) {
      expect(group.levels.filter((level) => level.object.visible)).toHaveLength(1);
      expect(group.levels[0]!.object.visible).toBe(true);
    }
    // Both parts counted, i.e. the reported triangle budget is the real one.
    expect(model.triangles).toBe(200);

    model.setLodLevel(2);
    for (const group of model.lodGroups) {
      expect(group.levels.map((level) => level.object.visible)).toEqual([false, false, true]);
    }
    expect(model.triangles).toBe(24);
  });

  it('gives a model with no LOD groups a visible single level', async () => {
    // A GLB the pipeline never decimated parses fine and has no groups.
    // Returning an empty `THREE.LOD` for it makes the prop invisible at every
    // distance, with no warning and nothing in `missing`.
    const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const model = await parseModel(loaderFor(sceneOf(plain)), 'model.plain', bytes, undefined, 1);
    expect(model.lodGroups).toHaveLength(0);

    const lod = model.toThreeLOD();
    expect(lod.levels).toHaveLength(1);
    expect(lod.levels[0]!.distance).toBe(0);
    expect(lod.children).toHaveLength(1);
  });

  it('builds one THREE.LOD level per extracted level', async () => {
    const scene = sceneOf(part('wall'), part('roof', '_1'));
    const model = await parseModel(loaderFor(scene), 'model.test', bytes, undefined, 1);
    const lod = model.toThreeLOD();
    expect(lod.levels).toHaveLength(3);
    // Each level carries both parts.
    expect(lod.levels.map((level) => level.object.children.length)).toEqual([2, 2, 2]);
  });

  it('gives THREE.LOD the manifest switch distances', async () => {
    const scene = sceneOf(part('wall'), part('roof', '_1'));
    const entry = {
      outputs: [{ tier: 'mobile', lods: manifestLods([0, 25, 60]) }],
    } as unknown as IModelAsset;
    const model = await parseModel(loaderFor(scene), 'model.x', bytes, entry, 1);
    const lod = model.toThreeLOD();
    expect(lod.name).toBe('model.x:LOD');
    expect(lod.levels.map((level) => level.distance)).toEqual([0, 25, 60]);
  });

  it('clamps the requested level per group instead of hiding a short part', async () => {
    // A part the decimator stopped early on has fewer levels than its
    // neighbours. Indexing past its end would leave it invisible at range.
    const scene = sceneOf(part('wall'), part('roof', '_1', 2));
    const model = await parseModel(loaderFor(scene), 'model.mixed', bytes, undefined, 1);
    model.setLodLevel(2);
    expect(model.lodGroups[0]!.levels.map((level) => level.object.visible)).toEqual([
      false,
      false,
      true,
    ]);
    expect(model.lodGroups[1]!.levels.map((level) => level.object.visible)).toEqual([false, true]);
  });

  it('floors and clamps a nonsensical level rather than showing nothing', async () => {
    const model = await parseModel(
      loaderFor(sceneOf(part('wall'))),
      'model.x',
      bytes,
      undefined,
      1
    );
    model.setLodLevel(-3);
    expect(model.activeLevel).toBe(0);
    model.setLodLevel(1.7);
    expect(model.activeLevel).toBe(1);
    expect(model.lodGroups[0]!.levels.map((level) => level.object.visible)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('reports lodCount as the deepest group and triangles as the chosen level', async () => {
    const scene = sceneOf(part('wall'), part('roof', '_1', 2));
    const model = await parseModel(loaderFor(scene), 'model.mixed', bytes, undefined, 1);
    expect(model.lodCount).toBe(3);
    expect(model.triangles).toBe(200);
    model.setLodLevel(1);
    expect(model.triangles).toBe(70);
    // The two-level group clamps, so it contributes its LAST level, not zero.
    model.setLodLevel(2);
    expect(model.triangles).toBe(47);
  });

  it('counts the scene itself when there is no LOD group to read', async () => {
    const scene = sceneOf(boxMesh('a'), boxMesh('b'));
    const model = await parseModel(loaderFor(scene), 'model.plain', bytes, undefined, 1);
    expect(model.lodGroups).toHaveLength(0);
    expect(model.triangles).toBe(24);
  });

  it('frees the graph through disposeSceneGraph on dispose()', async () => {
    const scene = sceneOf(part('wall'));
    const model = await parseModel(loaderFor(scene), 'model.x', bytes, undefined, 1);
    const geometry = (model.lodGroups[0]!.levels[0]!.object as THREE.Mesh).geometry;
    const dispose = vi.spyOn(geometry, 'dispose');
    model.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('mesh preparation', () => {
  const bytes = new ArrayBuffer(8);
  const SLOTS = [
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'aoMap',
    'emissiveMap',
  ] as const;

  /** A mesh with every sampled slot bound, and aoMap on glTF's UV1 convention. */
  function texturedMaterial(): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial();
    for (const slot of SLOTS) material[slot] = new THREE.Texture();
    material.aoMap!.channel = 1;
    return material;
  }

  function expectPrepared(material: THREE.MeshStandardMaterial, anisotropy: number): void {
    for (const slot of SLOTS) expect(material[slot]?.anisotropy).toBe(anisotropy);
    // These meshes have UV0 only; glTF puts occlusion on its own texCoord.
    expect(material.aoMap?.channel).toBe(0);
  }

  it('prepares every sampled slot of a model mesh', async () => {
    const material = texturedMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    const scene = await parseModel(loaderFor(sceneOf(mesh)), 'model.x', bytes, undefined, 8);
    expectPrepared(material, 8);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(scene.scene.name).toBe('model.x');
  });

  it('prepares a character mesh the same way a model mesh is prepared', async () => {
    // Characters are the closest thing on screen: their normal and ORM atlases
    // shimmer at grazing angles exactly where anisotropy matters, and the
    // character path used to apply it to `map` alone.
    const material = texturedMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    const clips = [new THREE.AnimationClip('idle', 1, [])];
    const parsed = await parseCharacter(loaderFor(sceneOf(mesh), clips), 'chr.saitama', bytes, 8);
    expectPrepared(material, 8);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
    expect(parsed.scene.name).toBe('chr.saitama');
    expect(parsed.clips).toBe(clips);
  });

  it('prepares every material of a multi-material mesh', async () => {
    const first = texturedMaterial();
    const second = texturedMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [first, second]);
    await parseModel(loaderFor(sceneOf(mesh)), 'model.x', bytes, undefined, 4);
    expectPrepared(first, 4);
    expectPrepared(second, 4);
  });
});

describe('disposeSceneGraph', () => {
  function graphWith(texture: THREE.Texture): THREE.Object3D {
    const material = new THREE.MeshStandardMaterial();
    material.map = texture;
    material.normalMap = texture;
    return sceneOf(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  }

  it('frees the textures of a graph that owns them, once each', () => {
    // A model GLB carries its textures inside the container, so no
    // `TextureHandle` covers them and `Material.dispose()` does not touch
    // them: without this, `unload()` reported the bytes freed and left every
    // embedded KTX2 resident for the life of the GL context.
    const texture = new THREE.Texture();
    const dispose = vi.spyOn(texture, 'dispose');
    disposeSceneGraph(graphWith(texture), { textures: true });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('leaves registry-owned textures alone by default', () => {
    const texture = new THREE.Texture();
    const dispose = vi.spyOn(texture, 'dispose');
    disposeSceneGraph(graphWith(texture));
    expect(dispose).not.toHaveBeenCalled();
  });

  it('never frees the shared missing-asset pattern', () => {
    // One instance serves every stand-in in the process; disposing it here
    // would blank all the others.
    const checker = missingTexture();
    const dispose = vi.spyOn(checker, 'dispose');
    disposeSceneGraph(graphWith(checker), { textures: true });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('frees geometry and material either way', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial();
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const materialDispose = vi.spyOn(material, 'dispose');
    disposeSceneGraph(sceneOf(new THREE.Mesh(geometry, material)));
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it('frees every material of a multi-material mesh', () => {
    const first = new THREE.MeshStandardMaterial();
    const second = new THREE.MeshStandardMaterial();
    const firstDispose = vi.spyOn(first, 'dispose');
    const secondDispose = vi.spyOn(second, 'dispose');
    disposeSceneGraph(sceneOf(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [first, second])));
    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(secondDispose).toHaveBeenCalledTimes(1);
  });

  it('walks past a node that is not a mesh without throwing', () => {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const dispose = vi.spyOn(geometry, 'dispose');
    const scene = sceneOf(new THREE.Group(), new THREE.Mesh(geometry));
    expect(() => disposeSceneGraph(scene, { textures: true })).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
