/**
 * Speedlines: the two intensity channels, the phase rule, and the visibility
 * gate.
 *
 * This is the only VFX object whose entire per-frame cost is a function of
 * `mesh.visible`, so a regression in the gate is a permanent full-screen
 * fragment pass that no unit run would otherwise notice. The focus point is
 * equally unforgiving in the other direction: `update` copies it into `uFocus`
 * every frame, so one NaN written by `setFocusWorld` poisons the overlay for
 * the rest of the session with nothing in `diagnostics()` showing it.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vfxProfileFor } from '../constants';
import { Speedlines } from '../speedlines';

function makeLines(): Speedlines {
  return new Speedlines(vfxProfileFor('medium'));
}

function makeCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  camera.position.set(4, 3, 2);
  camera.updateMatrixWorld(true);
  return camera;
}

function focusOf(lines: Speedlines): THREE.Vector2 {
  return lines.material.uniforms.uFocus!.value as THREE.Vector2;
}

function phaseOf(lines: Speedlines): number {
  return lines.material.uniforms.uPhase!.value as number;
}

describe('Speedlines', () => {
  it('takes the maximum of the sustained and pulse channels', () => {
    const lines = makeLines();
    lines.setSustained(0.5);
    for (let i = 0; i < 60; i++) lines.update(1 / 60);
    expect(lines.intensity).toBeCloseTo(0.5, 3);

    // A punch landing mid-dash spikes rather than merely continuing.
    lines.burst(0.9);
    expect(lines.intensity).toBeCloseTo(0.9, 6);

    // Once the pulse has decayed under it, the dash is still running.
    for (let i = 0; i < 30; i++) lines.update(1 / 60);
    expect(lines.intensity).toBeCloseTo(0.5, 3);
  });

  it('does not let a weaker burst cut a stronger live one', () => {
    const lines = makeLines();
    lines.burst(0.8);
    const phase = phaseOf(lines);

    lines.burst(0.2);
    expect(lines.intensity).toBeCloseTo(0.8, 6);
    // An ignored burst must not re-roll the line pattern either.
    expect(phaseOf(lines)).toBe(phase);
  });

  it('re-rolls the pattern on every accepted burst', () => {
    const lines = makeLines();
    lines.burst(0.4);
    const first = phaseOf(lines);
    lines.burst(0.9);
    const second = phaseOf(lines);
    expect(second).not.toBe(first);
    // Advancing the phase every FRAME instead would make the lines crawl.
    lines.update(1 / 60);
    expect(phaseOf(lines)).toBe(second);
  });

  it('decays on the supplied delta, so the lines hold through the freeze', () => {
    const real = makeLines();
    real.burst(1, 4);
    real.update(0.1);
    expect(real.intensity).toBeCloseTo(0.6, 6);

    // The same wall-clock slice at the impact freeze's 4% time scale.
    const frozen = makeLines();
    frozen.burst(1, 4);
    frozen.update(0.1 * 0.04);
    expect(frozen.intensity).toBeGreaterThan(0.98);
  });

  it('submits no draw call while it is silent', () => {
    const lines = makeLines();
    expect(lines.mesh.visible).toBe(false);

    lines.burst(0.5);
    lines.update(0);
    expect(lines.mesh.visible).toBe(true);

    lines.update(0.2);
    expect(lines.intensity).toBe(0);
    expect(lines.mesh.visible).toBe(false);
  });

  it('writes an aspect that never blows up', () => {
    const lines = makeLines();
    const aspect = lines.material.uniforms.uAspect!.value as THREE.Vector2;
    lines.setViewport(1920, 1080);
    expect(aspect.toArray()).toEqual([16 / 9, 1]);

    lines.setViewport(800, 0);
    expect(Number.isFinite(aspect.x)).toBe(true);
    expect(aspect.toArray()).toEqual([800, 1]);
  });

  it('projects a world focus into the clamped NDC range', () => {
    const lines = makeLines();
    const camera = makeCamera();
    // In front of the camera and off to one side.
    lines.setFocusWorld(10, 3, -20, camera);
    lines.update(1 / 60);
    const focus = focusOf(lines);
    expect(Number.isFinite(focus.x) && Number.isFinite(focus.y)).toBe(true);
    expect(focus.x).toBeGreaterThan(0);
    expect(focus.x).toBeLessThanOrEqual(1.4);
    expect(Math.abs(focus.y)).toBeLessThanOrEqual(1.4);
  });

  it('never writes a non-finite focus into the uniform', () => {
    const lines = makeLines();
    const camera = makeCamera();
    // A point exactly at the camera: `project` divides by zero, so x and y come
    // back NaN and z comes back -Infinity — which the `z > 1` test passes.
    lines.setFocusWorld(4, 3, 2, camera);
    lines.update(1 / 60);
    const focus = focusOf(lines);
    expect(Number.isFinite(focus.x) && Number.isFinite(focus.y)).toBe(true);
    expect(focus.toArray()).toEqual([0, 0]);
  });

  it('falls back to the centre for a point behind the camera', () => {
    const lines = makeLines();
    const camera = makeCamera();
    // Behind the camera `project` mirrors the point, which would aim the lines
    // at the opposite side of the screen from the impact.
    lines.setFocusWorld(6, 3, 10, camera);
    lines.update(1 / 60);
    expect(focusOf(lines).toArray()).toEqual([0, 0]);
  });

  it('silences everything on a clear', () => {
    const lines = makeLines();
    const camera = makeCamera();
    lines.setSustained(1);
    lines.burst(1);
    lines.setFocusWorld(10, 3, -20, camera);
    lines.update(1 / 60);
    expect(lines.mesh.visible).toBe(true);

    lines.clear();
    expect(lines.intensity).toBe(0);
    expect(lines.material.uniforms.uIntensity!.value).toBe(0);
    expect(lines.mesh.visible).toBe(false);
    // A wipe must not leave the previous encounter's focus behind.
    expect(focusOf(lines).toArray()).toEqual([0, 0]);
    lines.update(1 / 60);
    expect(focusOf(lines).toArray()).toEqual([0, 0]);
  });

  it('is indistinguishable from a fresh overlay after a clear', () => {
    const fresh = makeLines();
    const reused = makeLines();
    reused.burst(0.7);
    reused.update(1 / 60);
    reused.burst(1);
    reused.update(1 / 60);
    reused.clear();

    fresh.burst(0.5);
    reused.burst(0.5);
    expect(phaseOf(reused)).toBe(phaseOf(fresh));
    expect(reused.intensity).toBe(fresh.intensity);
  });
});
