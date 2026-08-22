/**
 * A tier change tears the whole chain down and rebuilds it from the profile.
 * Everything a caller tuned at runtime lives on the passes, not in the profile,
 * so without an explicit hand-off the most ordinary possible user action —
 * nudging the quality slider — silently reverts the composition root's bloom
 * tuning (threshold 2.2 back to the profile's 1.0, i.e. every sunlit white
 * surface blooms again) and every effect toggle the player set, permanently.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PostProcessing } from '../post/post-processing';
import type { AnimeCompositePass } from '../post/anime-composite-pass';
import type { OutputLutPass } from '../post/output-lut-pass';
import type { HalfResSSAOPass } from '../post/ssao-pass';
import { renderProfileFor, type PostTierProfile } from '../quality';

/** `PostProcessing` only ever asks the renderer for its size and pixel ratio. */
function fakeRenderer(width = 1280, height = 720): THREE.WebGLRenderer {
  return {
    getDrawingBufferSize: (target: THREE.Vector2) => target.set(width, height),
    getPixelRatio: () => 1,
  } as unknown as THREE.WebGLRenderer;
}

function makePost(profile: PostTierProfile): PostProcessing {
  return new PostProcessing({
    renderer: fakeRenderer(),
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2400),
    profile,
  });
}

/**
 * The bloom threshold as the composition root sees it: through the documented
 * `effectComposer` escape hatch, which never passes through `PostProcessing`.
 */
function bloomNumber(post: PostProcessing, key: 'threshold' | 'strength'): number | undefined {
  for (const pass of post.effectComposer?.passes ?? []) {
    const candidate = pass as unknown as Record<string, unknown>;
    if (typeof candidate[key] === 'number') return candidate[key];
  }
  return undefined;
}

function tuneBloomThreshold(post: PostProcessing, threshold: number): void {
  for (const pass of post.effectComposer?.passes ?? []) {
    const candidate = pass as unknown as { threshold?: number };
    if (typeof candidate.threshold === 'number') candidate.threshold = threshold;
  }
}

function privatePass<T>(post: PostProcessing, field: string): T {
  return (post as unknown as Record<string, T>)[field]!;
}

const HIGH = renderProfileFor('high').post;
const MEDIUM = renderProfileFor('medium').post;
const LOW = renderProfileFor('low').post;

describe('PostProcessing.applyProfile state hand-off', () => {
  it('keeps the tuned bloom threshold and strength across a tier change', () => {
    const post = makePost(HIGH);
    expect(bloomNumber(post, 'threshold')).toBe(HIGH.bloomThreshold);

    tuneBloomThreshold(post, 2.2);
    post.setEffectIntensity('bloom', 0.3);

    post.applyProfile(MEDIUM);

    expect(bloomNumber(post, 'threshold')).toBeCloseTo(2.2, 6);
    expect(bloomNumber(post, 'strength')).toBeCloseTo(0.3, 6);
    post.dispose();
  });

  it('keeps the vignette and grading blends', () => {
    const post = makePost(HIGH);
    post.setEffectIntensity('vignette', 0.12);
    post.setEffectIntensity('colorGrading', 0.4);

    post.applyProfile(MEDIUM);

    const output = privatePass<OutputLutPass>(post, 'outputPass');
    expect(output.vignette).toBeCloseTo(0.12, 6);
    expect(output.lutIntensity).toBeCloseTo(0.4, 6);
    post.dispose();
  });

  it('keeps per-effect enable flags', () => {
    const post = makePost(HIGH);
    post.setEffectEnabled('ssao', false);
    post.setEffectEnabled('motionBlur', false);
    post.setEffectIntensity('speedLines', 0.45);
    post.setEffectIntensity('ssao', 0.6);

    // A same-tier rebuild: `applyProfile` compares by identity, so a fresh
    // object with identical values is exactly what a slider round trip does.
    post.applyProfile({ ...HIGH });

    expect(privatePass<HalfResSSAOPass>(post, 'ssaoPass').enabled).toBe(false);
    expect(privatePass<HalfResSSAOPass>(post, 'ssaoPass').intensity).toBeCloseTo(0.6, 6);
    const anime = privatePass<AnimeCompositePass>(post, 'animePass');
    expect(anime.isEffectEnabled('motionBlur')).toBe(false);
    expect(anime.getIntensity('speedLines')).toBeCloseTo(0.45, 6);
    post.dispose();
  });

  it('does not force an untuned tier default onto the tier being moved to', () => {
    // LOW ships no vignette and no LUT, so nothing about them may be carried
    // forward when the player moves up to MEDIUM.
    const post = makePost(LOW);
    expect(post.isDirect).toBe(true);

    post.applyProfile(MEDIUM);

    const output = privatePass<OutputLutPass>(post, 'outputPass');
    expect(output.vignette).toBeGreaterThan(0);
    expect(output.lutIntensity).toBeGreaterThan(0);
    post.dispose();
  });

  it('is a no-op for the profile already in force', () => {
    const post = makePost(MEDIUM);
    tuneBloomThreshold(post, 2.2);
    post.applyProfile(MEDIUM);
    expect(bloomNumber(post, 'threshold')).toBeCloseTo(2.2, 6);
    post.dispose();
  });
});

describe('PostProcessing effect routing', () => {
  it('reports the chain it actually built', () => {
    const post = makePost(MEDIUM);
    const stats = post.getStats();
    expect(stats.direct).toBe(false);
    expect(stats.bloomKind).toBe('dual');
    expect(stats.passNames.length).toBe(stats.passCount);
    post.dispose();
  });

  it('tolerates effects the current tier never built', () => {
    const post = makePost(MEDIUM);
    // MEDIUM has no SSAO, no anime pass and no AA; none of these may throw.
    expect(() => {
      post.setEffectEnabled('ssao', true);
      post.setEffectEnabled('motionBlur', true);
      post.setEffectEnabled('fxaa', true);
      post.setEffectIntensity('ssao', 0.5);
      post.setEffectIntensity('speedLines', 0.5);
      post.setEffectIntensity('fxaa', 0.5);
      post.setEffectIntensity('filmGrain', 0.5);
      post.setEffectEnabled('depthOfField', true);
    }).not.toThrow();
    post.dispose();
  });
});
