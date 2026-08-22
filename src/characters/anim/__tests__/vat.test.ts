/**
 * VERTEX ANIMATION TEXTURE
 *
 * The claim is that skinning a crowd from a texture produces the same
 * character as skinning it on the CPU. That has to be measured per vertex, in
 * metres, and split into the two error sources — storage precision and frame
 * discretisation — because they are fixed by different things.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyVatSkinning,
  bakeVat,
  readVatMatrix,
  sampleVatMatrix,
  vatClipFps,
  vatInstanceAttribute,
  TEXELS_PER_BONE,
} from '../vat';
import { findClip } from '../clips';
import { measureVatRoundTrip } from '../analysis';
import { sampleClip } from '../bake';
import { poseToModelMatrices, skinningMatrices } from '../pose';
import { ProceduralAnimator } from '../animator';
import { resolveRig } from '../rig';
import { buildCivilian, createCharacterParts } from '@/characters/mesh';
import { geometryData, heroFixture, showcaseFixtures } from './support';

describe('vat layout', () => {
  const fixture = heroFixture('saitama', 2);

  it('packs three RGBA texels per bone and stacks clips into rows', () => {
    const clips = [findClip('idle', 'civilian'), findClip('walk'), findClip('run')];
    const bake = bakeVat(fixture.rig, clips, { frames: 24 });
    expect(bake.width).toBe(fixture.rig.boneCount * TEXELS_PER_BONE);
    expect(bake.height).toBe(24 * clips.length);
    expect(bake.clips).toHaveLength(3);
    expect(bake.clips[1]!.row).toBe(24);
    expect(bake.index.get('walk:default')).toBe(1);
    expect(bake.texture.image.width).toBe(bake.width);
    // NEAREST, because hardware filtering would blend across BONE boundaries
    // at the row edges — bone 4's translation mixed with bone 5's rotation.
    expect(bake.texture.magFilter).toBe(THREE.NearestFilter);
    bake.dispose();
  });

  it('stays small enough to be free on a phone', () => {
    // 27 bones is the whole reason to store matrices rather than vertices.
    const clips = [findClip('idle', 'civilian'), findClip('walk'), findClip('run')];
    const bake = bakeVat(fixture.rig, clips, { frames: 32, halfFloat: true });
    expect(bake.bytes).toBeLessThan(80 * 1024);
    bake.dispose();
  });

  it('round-trips a matrix through the texels unchanged in float32', () => {
    const bake = bakeVat(fixture.rig, [findClip('walk')], { frames: 8, halfFloat: false });
    const poses = sampleClip(fixture.rig, findClip('walk'), { frames: 8 });
    const model: THREE.Matrix4[] = [];
    const skin: THREE.Matrix4[] = [];
    poseToModelMatrices(poses[3]!, fixture.rig, model);
    skinningMatrices(model, fixture.rig.boneInverses, skin);
    const read = new THREE.Matrix4();
    for (let b = 0; b < fixture.rig.boneCount; b++) {
      readVatMatrix(bake, 3, b, read);
      // Only the top three rows are stored; the fourth is implicit.
      for (let i = 0; i < 15; i++) {
        if (i % 4 === 3) continue;
        expect(read.elements[i]!).toBeCloseTo(skin[b]!.elements[i]!, 6);
      }
    }
    bake.dispose();
  });
});

describe('vat fidelity', () => {
  const fixture = heroFixture('saitama', 2);
  const geometry = geometryData(fixture.build);
  const walk = findClip('walk');

  it('adds under 1.5 mm of error from half-float storage', () => {
    const bake = bakeVat(fixture.rig, [walk], { frames: 32, halfFloat: true });
    const report = measureVatRoundTrip(fixture.rig, bake, walk, 0, geometry, { stride: 5 });
    expect(report.quantisationMax).toBeLessThan(0.0015);
    expect(report.quantisationRms).toBeLessThan(0.0006);
    bake.dispose();
  });

  it('adds essentially nothing from float32 storage', () => {
    const bake = bakeVat(fixture.rig, [walk], { frames: 32, halfFloat: false });
    const report = measureVatRoundTrip(fixture.rig, bake, walk, 0, geometry, { stride: 7 });
    expect(report.quantisationMax).toBeLessThan(1e-5);
    bake.dispose();
  });

  it('reduces temporal error monotonically with frame count', () => {
    // The number that decides how many frames a clip is worth. If it did not
    // fall with frames, something upstream would be inconsistent — which is
    // exactly how a frame-rate-dependent gait was caught during development.
    const errors = [16, 32, 64].map((frames) => {
      const bake = bakeVat(fixture.rig, [walk], { frames, halfFloat: false });
      const report = measureVatRoundTrip(fixture.rig, bake, walk, 0, geometry, {
        stride: 11,
        subSamples: 4,
      });
      bake.dispose();
      return report.temporalRms;
    });
    expect(errors[1]!).toBeLessThan(errors[0]!);
    expect(errors[2]!).toBeLessThan(errors[1]!);
    // At 32 frames the RMS disagreement is a couple of millimetres on a 1.75 m
    // character, at a distance where LOD2 crowds are drawn.
    expect(errors[1]!).toBeLessThan(0.004);
  });

  it('measures a one-shot clip on its own sampling grid', () => {
    // `sampleClip` places sample i of an n-frame ONE-SHOT at i/(n-1), not i/n,
    // so the dense sweep has to be mapped onto that grid too. Reading it as
    // `i/subSamples` slides the comparison by three quarters of a frame at the
    // end of the range and compares the tail against a clamped last frame — a
    // fixed indexing offset masquerading as interpolation error, for exactly
    // the clips whose poses move fastest.
    //
    // The tell is the RATE: a genuine interpolation error QUARTERS when the
    // frame count doubles, while a fixed frame offset only halves. The suite
    // only ever exercised `walk`, which loops, so the mismatch was invisible.
    const attack = findClip('attack');
    const errors = [16, 32, 64].map((frames) => {
      const bake = bakeVat(fixture.rig, [attack], { frames, halfFloat: false });
      const report = measureVatRoundTrip(fixture.rig, bake, attack, 0, geometry, {
        stride: 11,
        subSamples: 4,
      });
      bake.dispose();
      return report.temporalRms;
    });
    expect(errors[1]!).toBeLessThan(errors[0]! * 0.4);
    expect(errors[2]!).toBeLessThan(errors[1]! * 0.35);
  });

  it('holds for every body in the showcase', () => {
    for (const fixtureN of showcaseFixtures(2)) {
      const bake = bakeVat(fixtureN.rig, [walk], { frames: 32, halfFloat: true });
      const report = measureVatRoundTrip(
        fixtureN.rig,
        bake,
        walk,
        0,
        geometryData(fixtureN.build),
        { stride: 13 }
      );
      // Half-float error scales with model coordinates, so the 2.45 m monster
      // is the worst case and it is the one this bound is set by.
      expect(report.quantisationMax, fixtureN.name).toBeLessThan(0.002);
      bake.dispose();
    }
  });
});

describe('the runtime and the bake agree', () => {
  it('puts a GPU-skinned crowd member in the same pose as a CPU-skinned hero', () => {
    // The end-to-end check the other tests cannot make: `measureVatRoundTrip`
    // compares the bake against the sampler that produced it, which proves
    // storage fidelity but not that the LIVE animator lands on the same pose.
    // A crowd whose members drift out of step with the hero standing next to
    // them is the failure this catches, and it would be invisible in every
    // other assertion here.
    const parts = createCharacterParts(buildCivilian(4242, 2), new THREE.MeshBasicMaterial());
    const rig = resolveRig(parts);
    const bake = bakeVat(rig, [findClip('walk')], { frames: 32, halfFloat: true });
    const clip = bake.clips[0]!;

    const animator = new ProceduralAnimator(
      createCharacterParts(buildCivilian(4242, 2), new THREE.MeshBasicMaterial()),
      new THREE.Group()
    );
    animator.play('walk', { fade: 0 });
    const time = 1.37;
    // Settle for the same four cycles the baker warms up for, so this compares
    // two points of the same steady loop.
    const steps = Math.round((4 * clip.duration + time) * 240);
    for (let i = 0; i < steps; i++) animator.update(1 / 240);

    const model: THREE.Matrix4[] = [];
    const skin: THREE.Matrix4[] = [];
    poseToModelMatrices(animator.pose, animator.rig, model);
    skinningMatrices(model, animator.rig.boneInverses, skin);

    const build = buildCivilian(4242, 2);
    const data = geometryData(build);
    const frameTime = (time / clip.duration) * clip.frames;
    const matrix = new THREE.Matrix4();
    const source = new THREE.Vector3();
    const cpu = new THREE.Vector3();
    const gpu = new THREE.Vector3();
    const scratch = new THREE.Vector3();
    let worst = 0;
    const count = data.position.length / 3;
    for (let v = 0; v < count; v++) {
      cpu.set(0, 0, 0);
      gpu.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const weight = data.skinWeight[v * 4 + k]!;
        if (weight === 0) continue;
        const bone = data.skinIndex[v * 4 + k]!;
        source.set(data.position[v * 3]!, data.position[v * 3 + 1]!, data.position[v * 3 + 2]!);
        cpu.addScaledVector(scratch.copy(source).applyMatrix4(skin[bone]!), weight);
        sampleVatMatrix(bake, 0, frameTime, bone, matrix);
        gpu.addScaledVector(scratch.copy(source).applyMatrix4(matrix), weight);
      }
      worst = Math.max(worst, cpu.distanceTo(gpu));
    }
    // Millimetres on a 1.7 m character: the two paths are the same animation.
    expect(worst).toBeLessThan(0.01);
    animator.dispose();
    bake.dispose();
  });
});

describe('crowd instancing', () => {
  const fixture = heroFixture('saitama', 2);

  it('packs a per-instance clip, offset and rate', () => {
    const clips = [findClip('idle', 'civilian'), findClip('walk')];
    const bake = bakeVat(fixture.rig, clips, { frames: 16 });
    const attribute = vatInstanceAttribute(bake, [
      { clip: 0, offset: 0 },
      { clip: 1, offset: 0.37, rate: 1.1 },
    ]);
    expect(attribute.itemSize).toBe(4);
    expect(attribute.count).toBe(2);
    expect(attribute.getX(1)).toBe(16); // walk's atlas row
    expect(attribute.getY(1)).toBe(16); // its frame count, positive = looping
    expect(attribute.getZ(1)).toBeCloseTo(0.37, 6);
    // The material carries ONE `vatFps`, taken from the atlas's first clip, so
    // the rate has to carry each clip's own speed relative to that reference.
    // Writing the caller's 1.1 straight through would play a 1 s walk at the
    // 6.3 s civilian idle's rate — six times too slow.
    const reference = vatClipFps(bake.clips[0]!);
    expect(attribute.getW(0)).toBeCloseTo(1, 6);
    expect(attribute.getW(1)).toBeCloseTo((1.1 * vatClipFps(bake.clips[1]!)) / reference, 6);
    expect(attribute.getW(1)).toBeGreaterThan(1.1);
    bake.dispose();
  });

  it('spans each clip its own duration once the uniform is applied', () => {
    // The end-to-end statement of the same thing: `vatFps × rate` is the frame
    // rate an instance actually advances at, and it has to span that clip's
    // duration in exactly its frame count for EVERY clip in the atlas, not
    // just the one the uniform was taken from.
    const clips = [findClip('idle', 'civilian'), findClip('walk'), findClip('run')];
    const bake = bakeVat(fixture.rig, clips, { frames: 16 });
    const material = new THREE.MeshBasicMaterial();
    const uniforms = applyVatSkinning(material, bake);
    const attribute = vatInstanceAttribute(
      bake,
      clips.map((_, clip) => ({ clip, offset: 0 }))
    );
    for (let i = 0; i < clips.length; i++) {
      const range = bake.clips[i]!;
      const fps = uniforms.vatFps.value * attribute.getW(i);
      expect(fps * range.duration, range.key).toBeCloseTo(range.frames, 5);
    }
    material.dispose();
    bake.dispose();
  });

  it('marks a one-shot clip so the shader clamps instead of wrapping', () => {
    // A baked `death` that wraps has the civilian die, snap upright and die
    // again once per cycle. The loop flag rides in the SIGN of the frame count,
    // and the CPU reference already clamps — so the two must agree.
    const bake = bakeVat(fixture.rig, [findClip('death')], { frames: 16, halfFloat: false });
    const attribute = vatInstanceAttribute(bake, [{ clip: 0, offset: 0 }]);
    expect(attribute.getY(0)).toBe(-16);

    const last = new THREE.Matrix4();
    const past = new THREE.Matrix4();
    sampleVatMatrix(bake, 0, 15, 3, last);
    sampleVatMatrix(bake, 0, 40, 3, past);
    for (let i = 0; i < 16; i++) expect(past.elements[i]!).toBeCloseTo(last.elements[i]!, 9);
    bake.dispose();
  });

  it('rates a one-shot so its last frame lands on the stated duration', () => {
    // A one-shot is sampled on the CLOSED grid — frame n-1 sits at `duration`,
    // not one frame short of it — so only n-1 frame steps fit inside it.
    const bake = bakeVat(fixture.rig, [findClip('attack')], { frames: 24 });
    const clip = bake.clips[0]!;
    expect(clip.loop).toBe(false);
    expect(vatClipFps(clip) * clip.duration).toBeCloseTo(23, 6);
    bake.dispose();
  });

  it('de-synchronises a crowd with distinct time offsets', () => {
    // Without this a street of civilians steps in unison, which is the single
    // most obvious tell that a crowd is instanced.
    const clips = [findClip('walk')];
    const bake = bakeVat(fixture.rig, clips, { frames: 16 });
    const instances = Array.from({ length: 64 }, (_, i) => ({
      clip: 0,
      offset: (i * 0.6180339887) % 1,
    }));
    const attribute = vatInstanceAttribute(bake, instances);
    const offsets = new Set<number>();
    for (let i = 0; i < 64; i++) offsets.add(Math.round(attribute.getZ(i) * 1000));
    expect(offsets.size).toBeGreaterThan(60);
    bake.dispose();
  });

  it('samples between frames the way the shader does', () => {
    const bake = bakeVat(fixture.rig, [findClip('walk')], { frames: 16, halfFloat: false });
    const a = new THREE.Matrix4();
    const b = new THREE.Matrix4();
    const mid = new THREE.Matrix4();
    readVatMatrix(bake, 4, 5, a);
    readVatMatrix(bake, 5, 5, b);
    sampleVatMatrix(bake, 0, 4.5, 5, mid);
    for (let i = 0; i < 16; i++) {
      expect(mid.elements[i]!).toBeCloseTo((a.elements[i]! + b.elements[i]!) * 0.5, 6);
    }
    bake.dispose();
  });

  it('wraps a looping clip rather than running off the end of the atlas', () => {
    const bake = bakeVat(fixture.rig, [findClip('walk')], { frames: 16, halfFloat: false });
    const first = new THREE.Matrix4();
    const wrapped = new THREE.Matrix4();
    sampleVatMatrix(bake, 0, 0, 3, first);
    sampleVatMatrix(bake, 0, 16, 3, wrapped);
    for (let i = 0; i < 16; i++) {
      expect(wrapped.elements[i]!).toBeCloseTo(first.elements[i]!, 9);
    }
    bake.dispose();
  });

  it('derives a frame rate that spans the clip duration', () => {
    const bake = bakeVat(fixture.rig, [findClip('walk')], { frames: 24 });
    const fps = vatClipFps(bake.clips[0]!);
    expect(fps * bake.clips[0]!.duration).toBeCloseTo(24, 6);
    bake.dispose();
  });
});

describe('vat material', () => {
  it('patches a stock material without replacing its shading', () => {
    const fixture = heroFixture('saitama', 2);
    const bake = bakeVat(fixture.rig, [findClip('walk')], { frames: 8 });
    const material = new THREE.MeshLambertMaterial();
    const uniforms = applyVatSkinning(material, bake);
    expect(uniforms.vatTexture.value).toBe(bake.texture);
    expect(uniforms.vatTexelSize.value.x).toBeCloseTo(1 / bake.width, 9);

    // Run the compile hook the way three.js would and check the injection
    // landed in both the position and the normal paths.
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <beginnormal_vertex>\n#include <begin_vertex>\n',
      fragmentShader: '',
    };
    material.onBeforeCompile(shader as never, null as never);
    expect(shader.vertexShader).toContain('attribute vec4 vatParams');
    expect(shader.vertexShader).toContain('vatSkinMatrix()');
    expect(shader.vertexShader).toContain('objectNormal = mat3(vatMatrix) * objectNormal');
    expect(shader.vertexShader).toContain('transformed = (vatMatrix * vec4(transformed, 1.0)).xyz');
    expect(shader.uniforms.vatTime).toBe(uniforms.vatTime);
    // Materials with different bakes must not share a compiled program.
    expect(material.customProgramCacheKey()).toContain('vat-');
    bake.dispose();
  });
});
