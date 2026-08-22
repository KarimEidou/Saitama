/**
 * `AnimeCompositePass` carries two independent envelopes: the combat burst that
 * `trigger()` fires and decays, and the sustained level a settings slider sets
 * through `IPostProcessing.setEffectIntensity`. They used to share one field,
 * so anything set directly was decayed to zero within about 0.8 s at 60 fps —
 * a "Motion blur" slider that silently undid itself while the player watched.
 */

import { describe, expect, it } from 'vitest';
import { AnimeCompositePass } from '../post/anime-composite-pass';

/** Resting chromatic aberration, mirrored from the pass's own constant. */
const REST_CHROMATIC = 0.16;

function uniform(pass: AnimeCompositePass, name: string): number {
  return pass.material.uniforms[name]!.value as number;
}

/** Drive `seconds` of 60 fps updates through the pass. */
function advance(pass: AnimeCompositePass, seconds: number): void {
  const step = 1 / 60;
  for (let i = 0; i < Math.round(seconds / step); i++) pass.update(step);
}

describe('AnimeCompositePass.setIntensity', () => {
  it('holds a directly set motion blur through a second of decay', () => {
    const pass = new AnimeCompositePass();
    pass.setIntensity('motionBlur', 0.5);
    advance(pass, 1);
    expect(uniform(pass, 'uMotionBlur')).toBeCloseTo(0.5, 6);
    pass.dispose();
  });

  it('holds a directly set speed-line level', () => {
    const pass = new AnimeCompositePass();
    pass.setIntensity('speedLines', 0.25);
    advance(pass, 2);
    expect(uniform(pass, 'uSpeedLines')).toBeCloseTo(0.25, 6);
    pass.dispose();
  });

  it('relaxes a burst back to the sustained floor, not to zero', () => {
    const pass = new AnimeCompositePass();
    pass.setIntensity('speedLines', 0.3);
    pass.trigger(1);
    expect(uniform(pass, 'uSpeedLines')).toBeCloseTo(1, 6);
    advance(pass, 2);
    expect(uniform(pass, 'uSpeedLines')).toBeCloseTo(0.3, 6);
    pass.dispose();
  });

  it('still decays an untuned burst all the way to zero', () => {
    const pass = new AnimeCompositePass();
    pass.trigger(1);
    advance(pass, 2);
    expect(uniform(pass, 'uMotionBlur')).toBe(0);
    expect(uniform(pass, 'uSpeedLines')).toBe(0);
    // Chromatic aberration has always had a resting floor; it keeps it.
    expect(uniform(pass, 'uChromatic')).toBeCloseTo(REST_CHROMATIC, 4);
    pass.dispose();
  });

  it('drops the sustained level when the effect is disabled', () => {
    const pass = new AnimeCompositePass();
    pass.setIntensity('motionBlur', 0.6);
    pass.setEffectEnabled('motionBlur', false);
    advance(pass, 0.5);
    expect(uniform(pass, 'uMotionBlur')).toBe(0);
    expect(pass.getIntensity('motionBlur')).toBe(0);
    pass.dispose();
  });

  it('refuses to sustain an effect the pass was built without', () => {
    const pass = new AnimeCompositePass({ speedLines: false });
    pass.setIntensity('speedLines', 0.8);
    expect(uniform(pass, 'uSpeedLines')).toBe(0);
    expect(pass.isEffectEnabled('speedLines')).toBe(false);
    pass.dispose();
  });
});

describe('AnimeCompositePass speed-line spokes', () => {
  const source = new AnimeCompositePass().material.fragmentShader;

  it('advances both ends of the spoke together', () => {
    // The inner edge must move with `travel`; ramping only the outer end made
    // every spoke snap back to half length once per fract() wrap (0.625 s),
    // which is roughly one wrap per cell inside a typical burst.
    expect(source).toMatch(/float\s+start\s*=\s*inner\s*\+\s*travel/);
    expect(source).toMatch(/float\s+reach\s*=\s*start\s*\+/);
  });

  it('fades the spoke out across the wrap', () => {
    expect(source).toMatch(/sin\(\s*travel\s*\*/);
  });
});
