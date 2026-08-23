/**
 * THE TIER TABLE IS A CONTRACT, NOT A PILE OF CONSTANTS
 *
 * `quality.ts` is read by four other files, and two of its entries are
 * load-bearing traps documented at length in the source:
 *
 *   • `PCFSoftShadowMap` is deprecated in three r185. `WebGLShadowMap` warns and
 *     silently rewrites it to `PCFShadowMap` on the FIRST shadow render — after
 *     materials have already compiled against type 2 — so every one of them
 *     recompiles. Measured: 38 live programs against 31 for identical output.
 *   • Context MSAA can only be chosen when the WebGL context is created, so it
 *     is fixed for the life of the renderer and only the composer-less tier
 *     benefits from it.
 *
 * A one-line edit to the table can reintroduce either, plus a whole class of
 * silent drift between the public `IQualitySettings` contract and the
 * renderer-private profile that wraps it. These are pure data assertions.
 *
 * NOTE: `post.antialias` and `post.msaaSamples` are deliberately NOT asserted
 * per tier — the in-chain AA choice is still moving, and this file must stay
 * green either way.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { DeviceTier, IQualityTier } from '@/types';
import {
  isCheaperTier,
  qualitySettingsFor,
  RENDER_TIER_PROFILES,
  renderProfileFor,
  renderTierForDevice,
} from '../quality';

const TIERS = ['low', 'medium', 'high'] as const satisfies readonly IQualityTier[];

/** Assert `low <= medium <= high` for one numeric field. */
function monotonic(label: string, pick: (tier: IQualityTier) => number): void {
  const [low, medium, high] = [pick('low'), pick('medium'), pick('high')];
  expect(low, `${label}: low <= medium`).toBeLessThanOrEqual(medium);
  expect(medium, `${label}: medium <= high`).toBeLessThanOrEqual(high);
}

describe('render tier profiles', () => {
  it('covers exactly the three render tiers', () => {
    expect(Object.keys(RENDER_TIER_PROFILES).sort()).toEqual(['high', 'low', 'medium']);
  });

  it('agrees with itself about which tier it is', () => {
    for (const tier of TIERS) {
      const profile = renderProfileFor(tier);
      expect(profile.tier).toBe(tier);
      expect(profile.settings.tier).toBe(tier);
      // The same object, not a copy: systems hold on to it.
      expect(qualitySettingsFor(tier)).toBe(RENDER_TIER_PROFILES[tier].settings);
    }
  });

  it('maps every DeviceTier to a render tier', () => {
    const cases: ReadonlyArray<readonly [DeviceTier, IQualityTier]> = [
      ['desktop', 'high'],
      ['high', 'high'],
      ['mid', 'medium'],
      ['low', 'low'],
    ];
    for (const [device, expected] of cases) expect(renderTierForDevice(device)).toBe(expected);
  });

  it('orders tiers strictly', () => {
    expect(isCheaperTier('low', 'medium')).toBe(true);
    expect(isCheaperTier('low', 'high')).toBe(true);
    expect(isCheaperTier('medium', 'high')).toBe(true);
    for (const tier of TIERS) expect(isCheaperTier(tier, tier)).toBe(false);
    expect(isCheaperTier('medium', 'low')).toBe(false);
    expect(isCheaperTier('high', 'low')).toBe(false);
    expect(isCheaperTier('high', 'medium')).toBe(false);
  });

  it('never asks for PCFSoftShadowMap', () => {
    // 38 live programs with PCFSoft against 31 with PCF, for identical output:
    // three rewrites the type on first shadow render and every material that
    // already compiled against type 2 recompiles against type 1.
    for (const tier of TIERS) {
      expect(renderProfileFor(tier).shadows.type).not.toBe(THREE.PCFSoftShadowMap);
    }
  });

  it('keeps every budget monotonic across tiers', () => {
    monotonic('maxPixelRatio', (t) => qualitySettingsFor(t).maxPixelRatio);
    monotonic('drawDistance', (t) => qualitySettingsFor(t).drawDistance);
    monotonic('streamingRadius', (t) => qualitySettingsFor(t).streamingRadius);
    monotonic('maxVisibleCharacters', (t) => qualitySettingsFor(t).maxVisibleCharacters);
    monotonic('maxParticleSystems', (t) => qualitySettingsFor(t).maxParticleSystems);
    monotonic('maxRigidBodies', (t) => qualitySettingsFor(t).maxRigidBodies);
    monotonic('anisotropy', (t) => qualitySettingsFor(t).anisotropy);
    monotonic('envMapResolution', (t) => renderProfileFor(t).envMapResolution);
    monotonic('shadows.cascades', (t) => renderProfileFor(t).shadows.cascades);
    monotonic('shadows.maxDistance', (t) => renderProfileFor(t).shadows.maxDistance);
    monotonic('shadows.blobShadowCapacity', (t) => renderProfileFor(t).shadows.blobShadowCapacity);
  });

  it('states each shadow fact once, consistently', () => {
    for (const tier of TIERS) {
      const profile = renderProfileFor(tier);
      expect(profile.settings.shadowMapSize).toBe(profile.shadows.mapSize);
      expect(profile.settings.shadowsEnabled).toBe(profile.shadows.enabled);
    }
  });

  it('turns context MSAA on for exactly the composer-less tier', () => {
    // Only the 'off' post mode renders to the default framebuffer, so only it
    // can benefit; and the choice is frozen at context creation.
    for (const tier of TIERS) {
      const profile = renderProfileFor(tier);
      expect(profile.contextAntialias).toBe(profile.post.mode === 'off');
    }
  });

  it('keeps the post mode and the public postProcessingEnabled flag in step', () => {
    for (const tier of TIERS) {
      const profile = renderProfileFor(tier);
      expect(profile.post.mode === 'off').toBe(profile.settings.postProcessingEnabled === false);
    }
  });

  it('stays inside the ranges the passes silently clamp to', () => {
    for (const tier of TIERS) {
      const profile = renderProfileFor(tier);

      expect(profile.minResolutionScale).toBeGreaterThan(0);
      expect(profile.minResolutionScale).toBeLessThanOrEqual(1);

      expect(profile.post.bloomScale).toBeGreaterThan(0);
      expect(profile.post.bloomScale).toBeLessThanOrEqual(1);
      expect(profile.post.ssaoScale).toBeGreaterThan(0);
      expect(profile.post.ssaoScale).toBeLessThanOrEqual(1);

      // DualFilterBloomPass clamps to [1,8]; a profile asking for 12 would
      // quietly get 8 and nothing would say so.
      expect(profile.post.bloomIterations).toBeGreaterThanOrEqual(1);
      expect(profile.post.bloomIterations).toBeLessThanOrEqual(8);
      // Same clamp in HalfResSSAOPass.
      expect(profile.post.ssaoSamples).toBeGreaterThanOrEqual(4);
      expect(profile.post.ssaoSamples).toBeLessThanOrEqual(32);

      expect([30, 60]).toContain(profile.settings.targetFps);
    }
  });

  it('pairs the cheap IBL path with the composer-less path', () => {
    // MaterialLib's specular-only cancel assumes they are the same tier.
    for (const tier of TIERS) {
      const profile = renderProfileFor(tier);
      if (profile.ibl === 'sh9') expect(profile.post.mode).toBe('off');
    }
  });
});
