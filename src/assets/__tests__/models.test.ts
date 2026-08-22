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
 * The scenes here are built by hand and handed to `parseModel` through a stub
 * loader: the real path needs meshopt, Draco and Basis, none of which belong in
 * a unit test, and none of which this file is about.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { disposeSceneGraph, extractLodGroups, parseModel } from '../models';
import { missingTexture } from '../fallback';

/** A `GLTFLoader` that hands back a scene the test built itself. */
function loaderFor(scene: THREE.Object3D): GLTFLoader {
  return {
    parseAsync: async (): Promise<{
      scene: THREE.Object3D;
      animations: THREE.AnimationClip[];
    }> => ({
      scene,
      animations: [],
    }),
  } as unknown as GLTFLoader;
}

/**
 * One part of a model, exactly as it arrives from `GLTFLoader`.
 *
 * `suffix` is what `createUniqueName` appends to every repeat of a name it has
 * already seen — every part after the first, since the pipeline names all of
 * them `LOD0`/`LOD1`/`LOD2`.
 */
function part(name: string, suffix = ''): THREE.Object3D {
  const group = new THREE.Group();
  group.name = `${name}__LOD${suffix}`;
  group.userData = {
    lod: {
      levels: [
        { level: 0, triangles: 100 },
        { level: 1, triangles: 35 },
        { level: 2, triangles: 12 },
      ],
    },
  };
  for (let level = 0; level < 3; level++) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.name = `LOD${level}${suffix}`;
    group.add(mesh);
  }
  return group;
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
});
