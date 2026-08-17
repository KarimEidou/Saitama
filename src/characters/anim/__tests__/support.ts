/**
 * TEST SUPPORT
 *
 * Builds real rigs from the mesh generator. Tests deliberately go through the
 * shipping mesh path rather than a hand-made skeleton: the animation's whole
 * claim is that it fits whatever bodies the generator produces, and a fixture
 * skeleton would let the two drift apart without a single test failing.
 */

import * as THREE from 'three';
import type { BodyProfile } from '@/types';
import {
  buildCharacter,
  buildCivilian,
  buildHumanoid,
  createCharacterParts,
  showcaseBodies,
  type CharacterId,
  type HumanoidBuild,
} from '@/characters/mesh';
import { resolveRig } from '../rig';
import type { AnimRig } from '../types';

const material = (): THREE.Material => new THREE.MeshBasicMaterial();

/** A resolved rig plus the build it came from. */
export interface Fixture {
  readonly name: string;
  readonly rig: AnimRig;
  readonly build: HumanoidBuild;
  readonly profile: BodyProfile;
}

export function fixtureFromBuild(name: string, build: HumanoidBuild): Fixture {
  const parts = createCharacterParts(build, material());
  return { name, rig: resolveRig(parts), build, profile: build.profile };
}

/** A named hero at a given LOD. */
export function heroFixture(id: CharacterId = 'saitama', lod: 0 | 1 | 2 = 0): Fixture {
  return fixtureFromBuild(id, buildCharacter(id, lod));
}

/** A procedural civilian. */
export function civilianFixture(seed: number, lod: 0 | 1 | 2 = 0): Fixture {
  return fixtureFromBuild(`civilian-${seed}`, buildCivilian(seed, lod));
}

/**
 * The seven showcase bodies — including the 1.22 m child and the 2.45 m
 * monster that bracket the proportion range the locomotion has to survive.
 */
export function showcaseFixtures(lod: 0 | 1 | 2 = 0): Fixture[] {
  return showcaseBodies().map((recipe) =>
    fixtureFromBuild(recipe.name, buildHumanoid(recipe.profile, { ...recipe.options, lod }))
  );
}

/**
 * Speed in m/s that means the same GAIT for any body.
 *
 * Froude-normalised: two bodies are doing the same thing when
 * `v / sqrt(g · L)` matches, not when their metres-per-second match and not
 * when their leg-lengths-per-second match.
 */
export function scaledSpeed(rig: AnimRig, normalisedSpeed: number): number {
  return normalisedSpeed * Math.sqrt(9.81 * rig.metrics.legLength);
}

/** Attribute arrays a skinning round-trip needs. */
export function geometryData(build: HumanoidBuild): {
  position: Float32Array;
  skinIndex: ArrayLike<number>;
  skinWeight: ArrayLike<number>;
} {
  const geometry = build.geometry;
  return {
    position: geometry.getAttribute('position').array as Float32Array,
    skinIndex: geometry.getAttribute('skinIndex').array as ArrayLike<number>,
    skinWeight: geometry.getAttribute('skinWeight').array as ArrayLike<number>,
  };
}
