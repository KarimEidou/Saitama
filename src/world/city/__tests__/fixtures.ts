/**
 * Shared test fixtures for the city generator.
 *
 * The committed plan is loaded once and reused: it is the real artifact the
 * game ships with, so testing against anything else would test a city that
 * does not exist.
 */

import rawPlan from '../../../../assets/district/cityz.plan.json';
import { CityGenerator } from '../city';
import type { ICityPlan } from '../plan-types';
import type { IFractureLayout } from '../fracture';

/** The committed City Z plan. */
export const CITY_Z_PLAN = rawPlan as unknown as ICityPlan;

/** A generator over the committed plan. */
export function makeGenerator(detail: 'full' | 'reduced' | 'box' = 'full'): CityGenerator {
  return new CityGenerator(CITY_Z_PLAN, { defaultDetail: detail, includeProps: true });
}

/**
 * Chunks that between them exercise every zone in the plan: downtown, the
 * shotengai, the civic quarter, industry, the housing ring, the park, the
 * ghost town and the crater.
 */
export const SAMPLE_CHUNKS: readonly (readonly [number, number])[] = [
  [0, 0], // Central Crossing — downtown, tallest
  [0, -4], // Route Z through the shotengai
  [4, -4], // Hero Association quarter
  [4, 2], // industrial south-east
  [-5, -5], // Z-City Park
  [-7, 3], // ghost town, Saitama's block
  [5, 1], // the crater
  [-2, 2], // housing ring
];

/** Flatten every building's fracture chunks in a block into one layout. */
export function combineLayouts(layouts: Readonly<Record<string, IFractureLayout>>): IFractureLayout {
  const all = Object.keys(layouts).sort();
  const chunks = all.flatMap((k) => layouts[k].chunks);
  const first = layouts[all[0]];
  return {
    chunks,
    floors: [],
    structureMaterial: first ? first.structureMaterial : 'concrete',
    totalMass: all.reduce((n, k) => n + layouts[k].totalMass, 0),
    collapseSupportRatio: 0.4,
    slotBase: first ? first.slotBase : [0, 0, 0],
  };
}
