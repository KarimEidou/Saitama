/**
 * HARNESS PROP PROXIES
 *
 * The city places street furniture by model id from the 39-piece Poly Haven
 * `hidden_alley` kit. Those GLBs are produced by the asset pipeline into
 * `public/assets/` (gitignored, built separately), so until they are resident
 * the harness stands in for them.
 *
 * A proxy is not a placeholder box. A lamp post proxy is a pole, an arm and a
 * lantern head; a hydrant is a barrel with a bonnet and two side ports; a
 * covered car is a tapered shell at car proportions. That distinction is the
 * whole point of the screenshot: the thing under test is whether a street with
 * lamps at 22 m centres, bins by the kerb and cars in the yards READS as
 * inhabited, and a field of grey cubes would answer a different question.
 *
 * Built with the city's own `MeshBuilder`, so each proxy is one geometry with
 * one material and instances exactly like the real model will.
 */

import * as THREE from 'three';
import { MeshBuilder, toBufferGeometry } from '@/world/city';

/** One instantiable proxy. */
export interface IProxyModel {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
}

type RGB = readonly [number, number, number];

const STEEL: RGB = [0.36, 0.37, 0.38];
const DARK: RGB = [0.2, 0.21, 0.22];
const RED: RGB = [0.66, 0.16, 0.13];
const GREEN: RGB = [0.2, 0.33, 0.25];
const CONCRETE: RGB = [0.68, 0.66, 0.62];
const TARP: RGB = [0.29, 0.30, 0.32];
const GLASSY: RGB = [0.95, 0.92, 0.78];
const RUST: RGB = [0.45, 0.29, 0.19];

/** Emit the geometry for one asset key, or nothing when it is unknown. */
function emit(key: string, b: MeshBuilder): boolean {
  const u = 0.5; // proxies are untextured; UV scale is irrelevant
  switch (key) {
    case 'model.prop.street_lamp_01':
    case 'model.prop.street_lamp_02': {
      const tall = key.endsWith('01');
      const h = tall ? 5.4 : 4.4;
      b.box(0, 0, 0.16, 0, 0.16, 0.16, 0.16, u, DARK);
      b.cylinder(0, 0, 0.16, 0, 0.075, h, 8, u, STEEL);
      // Arm reaching over the carriageway, then the lantern.
      b.box(0, 0, h, -0.5, 0.05, 0.05, 0.55, u, STEEL);
      b.box(0, 0, h - 0.16, -1.0, 0.22, 0.11, 0.32, u, GLASSY);
      return true;
    }
    case 'model.prop.fire_hydrant': {
      b.cylinder(0, 0, 0, 0, 0.19, 0.62, 10, u, RED);
      b.cylinder(0, 0, 0.62, 0, 0.13, 0.18, 8, u, RED);
      b.box(0, 0.22, 0.34, 0, 0.06, 0.09, 0.09, u, RED);
      b.box(0, -0.22, 0.34, 0, 0.06, 0.09, 0.09, u, RED);
      b.box(0, 0, 0.02, 0, 0.27, 0.03, 0.27, u, DARK);
      return true;
    }
    case 'model.prop.metal_trash_can': {
      b.cylinder(0, 0, 0, 0, 0.29, 0.78, 10, u, [0.28, 0.34, 0.3], false);
      b.cylinder(0, 0, 0.78, 0, 0.31, 0.06, 10, u, GREEN);
      return true;
    }
    case 'model.prop.utility_box_01':
      b.box(0, 0, 0.55, 0, 0.32, 0.55, 0.22, u, [0.52, 0.55, 0.53]);
      b.box(0, 0, 0.03, 0, 0.36, 0.03, 0.26, u, CONCRETE);
      return true;
    case 'model.prop.utility_box_02':
      b.box(0, 0, 0.42, 0, 0.45, 0.42, 0.28, u, [0.46, 0.48, 0.5]);
      return true;
    case 'model.prop.water_manhole_cover':
      b.cylinder(0, 0, 0.01, 0, 0.36, 0.03, 12, u, [0.3, 0.29, 0.28]);
      return true;
    case 'model.prop.concrete_road_barrier':
    case 'model.prop.concrete_road_barrier_02':
      b.box(0, 0, 0.18, 0, 0.9, 0.18, 0.3, u, CONCRETE);
      b.box(0, 0, 0.55, 0, 0.9, 0.2, 0.16, u, CONCRETE);
      return true;
    case 'model.prop.covered_car': {
      // Tapered shell: cabin over a longer, wider body. Reads as a car under a
      // tarpaulin from any angle that matters.
      b.box(0, 0, 0.62, 0, 2.15, 0.38, 0.84, u, TARP);
      b.box(0, 0, 1.18, -0.15, 1.1, 0.3, 0.74, u, TARP);
      b.box(0, 1.35, 0.34, 0, 0.5, 0.26, 0.86, u, [0.24, 0.25, 0.26]);
      // Wheel line: a shadow band at axle height stops it reading as a crate.
      b.box(0, 0, 0.2, 0, 2.16, 0.2, 0.9, u, [0.12, 0.12, 0.13]);
      return true;
    }
    case 'model.prop.exterior_aircon_unit':
      b.box(0, 0, 0.3, 0, 0.42, 0.3, 0.22, u, [0.76, 0.75, 0.72]);
      return true;
    case 'model.prop.security_camera_01':
    case 'model.prop.security_camera_02':
      b.box(0, 0, 0, 0, 0.05, 0.05, 0.2, u, DARK);
      b.box(0, 0, -0.06, -0.3, 0.09, 0.09, 0.16, u, [0.85, 0.84, 0.8]);
      return true;
    case 'model.prop.security_light':
      b.box(0, 0, 0, 0, 0.06, 0.06, 0.16, u, DARK);
      b.box(0, 0, -0.1, -0.24, 0.14, 0.09, 0.1, u, GLASSY);
      return true;
    case 'model.prop.old_tyre':
      b.cylinder(0, 0, 0.02, 0, 0.34, 0.2, 12, u, [0.14, 0.14, 0.15]);
      return true;
    case 'model.prop.rusted_wheel_rim_01':
    case 'model.prop.rusted_wheel_rim_02':
      b.cylinder(0, 0, 0.02, 0, 0.28, 0.12, 10, u, RUST);
      return true;
    case 'model.prop.barrel_stove':
      b.cylinder(0, 0, 0, 0, 0.3, 0.88, 10, u, RUST);
      return true;
    case 'model.prop.spray_paint_bottles_02':
      b.cylinder(0, 0, 0, 0, 0.04, 0.19, 6, u, [0.6, 0.2, 0.2]);
      b.cylinder(0, 0.11, 0, 0, 0.04, 0.19, 6, u, [0.2, 0.35, 0.6]);
      return true;
    case 'model.prop.street_rat':
      b.box(0, 0, 0.05, 0, 0.11, 0.05, 0.05, u, [0.24, 0.22, 0.21]);
      return true;
    case 'model.building.modular_street_seating':
      b.box(0, 0, 0.44, 0, 0.9, 0.05, 0.24, u, [0.55, 0.44, 0.31]);
      b.box(0, -0.75, 0.22, 0, 0.06, 0.22, 0.2, u, STEEL);
      b.box(0, 0.75, 0.22, 0, 0.06, 0.22, 0.2, u, STEEL);
      return true;
    case 'model.building.modular_chainlink_fence':
      for (let i = 0; i <= 4; i++) {
        b.box(0, -2 + i, 0.9, 0, 0.04, 0.9, 0.04, u, STEEL);
      }
      b.box(0, 0, 1.78, 0, 2.1, 0.04, 0.03, u, STEEL);
      b.box(0, 0, 0.06, 0, 2.1, 0.04, 0.03, u, STEEL);
      return true;
    case 'model.building.modular_electricity_poles':
      b.cylinder(0, 0, 0, 0, 0.13, 8.2, 8, u, [0.42, 0.35, 0.28]);
      b.box(0, 0, 7.2, 0, 1.2, 0.06, 0.06, u, [0.42, 0.35, 0.28]);
      b.box(0, 0, 6.5, 0, 0.9, 0.05, 0.05, u, [0.42, 0.35, 0.28]);
      return true;
    case 'model.building.modular_fire_escape':
      b.box(0, 0, 1.2, 0.55, 1.1, 0.04, 0.55, u, RUST);
      b.box(0, 0, 1.75, 1.05, 1.1, 0.55, 0.03, u, RUST);
      return true;
    case 'model.building.rollershutter_door':
      b.box(0, 0, 1.15, 0.06, 0.9, 1.15, 0.06, u, [0.55, 0.57, 0.6]);
      return true;
    case 'model.building.rollershutter_window_01':
    case 'model.building.rollershutter_window_02':
    case 'model.building.rollershutter_window_03':
      b.box(0, 0, 1.1, 0.06, 0.75, 0.6, 0.06, u, [0.55, 0.57, 0.6]);
      return true;
    case 'model.building.modular_metal_gutter':
      b.box(0, 0, 1.5, 0.07, 0.07, 1.5, 0.07, u, STEEL);
      return true;
    case 'model.building.modular_airduct_circular_01':
      b.cylinder(0, 0, 0, 0, 0.3, 1.4, 8, u, STEEL);
      return true;
    default:
      return false;
  }
}

/** Builds and caches an instanceable proxy per asset key. */
export class ProxyModelLibrary {
  private readonly cache = new Map<string, IProxyModel | undefined>();
  private readonly material: THREE.Material;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(decorate: (m: THREE.Material) => THREE.Material) {
    this.material = decorate(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.78,
        metalness: 0.1,
        vertexColors: true,
      })
    );
  }

  /** Asset keys that resolved to a proxy. */
  resolved(): string[] {
    return [...this.cache.entries()].filter(([, v]) => v).map(([k]) => k).sort();
  }

  /** Asset keys with no proxy; they render as nothing. */
  missing(): string[] {
    return [...this.cache.entries()].filter(([, v]) => !v).map(([k]) => k).sort();
  }

  get(key: string): IProxyModel | undefined {
    if (this.cache.has(key)) return this.cache.get(key);
    const builder = new MeshBuilder(1);
    builder.beginChunk();
    const ok = emit(key, builder);
    builder.endChunk();
    if (!ok || builder.isEmpty) {
      this.cache.set(key, undefined);
      return undefined;
    }
    const geometry = toBufferGeometry(builder.build());
    this.geometries.push(geometry);
    const model: IProxyModel = { geometry, material: this.material };
    this.cache.set(key, model);
    return model;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.material.dispose();
    this.cache.clear();
    this.geometries.length = 0;
  }
}
