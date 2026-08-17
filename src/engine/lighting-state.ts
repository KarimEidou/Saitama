/**
 * MUTABLE LIGHTING STATE
 *
 * `ILightingState` (render.ts) is published by the day/night system and read by
 * the renderer, sky and post-processing. That system does not exist yet, and
 * the renderer must not import it when it does — so the renderer owns a
 * concrete, mutable implementation and exposes `setLightingState()` for the
 * eventual owner to swap in its own.
 *
 * Vectors and colours are mutated IN PLACE. `sunDirection` and friends are
 * handed out by reference every frame; reallocating them would produce a
 * Vector3 per frame for no reason and break anything holding a reference.
 */

import * as THREE from 'three';
import type { ILightingState } from '@/types';

/** A writable `ILightingState`. Satisfies the read-only contract structurally. */
export class MutableLightingState implements ILightingState {
  /** Direction the sunlight TRAVELS (from the sun towards the world). */
  readonly sunDirection = new THREE.Vector3(-0.45, -0.78, -0.43).normalize();
  readonly sunColor = new THREE.Color(0xfff2dc);
  sunIntensity = 3.1;
  readonly ambientColor = new THREE.Color(0x9dbdf0);
  ambientIntensity = 0.55;
  readonly groundColor = new THREE.Color(0x3a3128);
  readonly fogColor = new THREE.Color(0xa8bdd4);
  fogDensity = 0.0016;
  envMapIntensity = 1.0;
  exposure = 1.0;
  streetLightsOn = false;
  shadowRadius = 60;

  /** Copy another state's values in without replacing object identities. */
  copy(other: ILightingState): this {
    this.sunDirection.copy(other.sunDirection).normalize();
    this.sunColor.copy(other.sunColor);
    this.sunIntensity = other.sunIntensity;
    this.ambientColor.copy(other.ambientColor);
    this.ambientIntensity = other.ambientIntensity;
    this.groundColor.copy(other.groundColor);
    this.fogColor.copy(other.fogColor);
    this.fogDensity = other.fogDensity;
    this.envMapIntensity = other.envMapIntensity;
    this.exposure = other.exposure;
    this.streetLightsOn = other.streetLightsOn;
    this.shadowRadius = other.shadowRadius;
    return this;
  }
}

/**
 * A clear late-morning preset. Deliberately NOT the "correct" time of day for
 * the game — it is the neutral state the renderer boots into so a scene is
 * lit sensibly before any day/night system has published anything.
 */
export function createDefaultLightingState(): MutableLightingState {
  return new MutableLightingState();
}

/**
 * A dusk preset, used by the harness to prove exposure and the emissive/street
 * light path respond to the lighting state rather than being hardcoded.
 */
export function createDuskLightingState(): MutableLightingState {
  const state = new MutableLightingState();
  state.sunDirection.set(-0.94, -0.2, -0.28).normalize();
  state.sunColor.setHex(0xffb066);
  state.sunIntensity = 1.6;
  state.ambientColor.setHex(0x4b5f8c);
  state.ambientIntensity = 0.42;
  state.groundColor.setHex(0x2a1f1a);
  state.fogColor.setHex(0xd08a5a);
  state.fogDensity = 0.0028;
  state.envMapIntensity = 0.7;
  state.exposure = 1.25;
  state.streetLightsOn = true;
  state.shadowRadius = 45;
  return state;
}
