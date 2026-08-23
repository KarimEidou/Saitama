/**
 * THE AUTHORED PLAN AND THE COMMITTED ARTIFACT
 *
 * `authoring/author-plan.ts` is the layout document; `assets/district/cityz.plan.json`
 * is what the game loads. Nothing regenerates the JSON automatically, so the only
 * thing keeping the two in step is this test. Structures are compared, not text:
 * whitespace in the committed file is not this test's business.
 */
import { describe, expect, it } from 'vitest';
import { authorCityZPlan, serialisePlan } from '../authoring/author-plan';
import { CITY_Z_PLAN } from './fixtures';

describe('authored plan', () => {
  it('reproduces the committed cityz.plan.json exactly', () => {
    // Round-trip through JSON so `undefined` optionals (IPlanBlock.tags) are
    // dropped exactly as the serialiser drops them.
    const authored = JSON.parse(JSON.stringify(authorCityZPlan())) as unknown;
    expect(authored).toEqual(CITY_Z_PLAN);
  });

  it('serialises coordinate pairs on one line and still parses', () => {
    const text = serialisePlan(authorCityZPlan());
    expect(text).toContain('[0, -768]');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(CITY_Z_PLAN);
  });
});
