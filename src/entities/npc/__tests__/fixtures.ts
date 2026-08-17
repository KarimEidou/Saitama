/**
 * SHARED TEST FIXTURES
 *
 * A real city block layout rather than a made-up one. `layoutChunk` is the
 * streaming workstream's deterministic generator, so these tests run against
 * the geometry the crowd will actually have to walk around — alleys two metres
 * wide, blocks that do not line up, and the occasional building that touches
 * its neighbour at a corner. A hand-written grid of tidy squares hides exactly
 * the cases that break a flow field.
 */

import * as THREE from 'three';
import { layoutChunk } from '@/world/streaming/chunk-layout';
import type { IObstacleRect, IThreatSource } from '../types';

/** Building footprints from the real layout generator, over a chunk range. */
export function cityRects(seed: number, radius = 2): IObstacleRect[] {
  const rects: IObstacleRect[] = [];
  for (let cz = -radius; cz <= radius; cz++) {
    for (let cx = -radius; cx <= radius; cx++) {
      for (const b of layoutChunk(seed, cx, cz).buildings) {
        rects.push({ minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ, height: b.height });
      }
    }
  }
  return rects;
}

/** One square building, for tests that need an obstacle they can reason about. */
export function singleBlock(
  cx: number,
  cz: number,
  half: number,
  height = 20
): IObstacleRect[] {
  return [{ minX: cx - half, minZ: cz - half, maxX: cx + half, maxZ: cz + half, height }];
}

/** A stationary threat at a fixed position. */
export function threatAt(x: number, z: number, intensity = 1): IThreatSource {
  return { id: `threat-${x}-${z}`, position: new THREE.Vector3(x, 0, z), intensity, tier: 'demon' };
}

/** Step a function `frames` times at a fixed timestep. */
export function stepFor(frames: number, dt: number, fn: (dt: number) => void): void {
  for (let i = 0; i < frames; i++) fn(dt);
}
