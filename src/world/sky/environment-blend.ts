/**
 * EXPOSURE-NORMALISED ENVIRONMENT BLENDING
 *
 * This module is the fix for the measurement quoted at the top of
 * `constants.ts`: four baked skies whose PEAK luminances span five orders of
 * magnitude but whose MEAN luminances are all within 1.5x of each other.
 *
 * The rule, applied everywhere without exception:
 *
 *     normalised = source / source.meanLuminance          (unit mean)
 *     radiance   = normalised * targetLuminance(time)     (absolute scale)
 *
 * The first line is what stops midnight being as bright as noon. The second is
 * what makes the time of day mean anything. Both halves are needed: dividing
 * without re-scaling gives a flat, timeless world; re-scaling without dividing
 * gives the original bug back, because the four sources do not start on a
 * common scale.
 *
 * Blending two skies is then trivially safe: BOTH are normalised to the SAME
 * target before mixing, so the mean of the blend is that target for every
 * value of alpha. No luminance dip or bump can appear mid-cross-fade, which is
 * the failure mode of the naive `mix(skyA, skyB, a)`.
 *
 * Everything here is pure and allocation-light. `blendSH9` writes into a
 * caller-owned `SphericalHarmonics3` so the per-frame path allocates nothing.
 */

import * as THREE from 'three';
import { clamp01, lerp } from '@/util';
import { SKY_ASSET_IDS, TIME_KEYFRAMES, type ISkyKeyframe, type SkyKey } from './constants';

/* -------------------------------------------------------------------------- */
/* Measurements                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the asset pipeline measured for one environment.
 *
 * `meanLuminance` is the number this whole module turns on. It is exported by
 * the pipeline into the manifest's `environments` block precisely so consumers
 * can normalise against it; treating it as decoration is the bug.
 */
export interface IEnvironmentMeasurement {
  /** Manifest asset id, e.g. `hdri.sky.night`. */
  readonly id: string;
  /** Area-weighted mean luminance of the source HDRI. */
  readonly meanLuminance: number;
  /** Peak luminance of the source, BEFORE half-float conversion. */
  readonly maxLuminance: number;
  /**
   * 27 floats: 9 SH coefficients x RGB, interleaved. Projected from the
   * FULL-PRECISION source, so it is correct even where the stored map clamps.
   */
  readonly sh9: readonly number[] | undefined;
}

/** Measurements for all four skies, keyed by short name. */
export type EnvironmentMeasurements = Readonly<Record<SkyKey, IEnvironmentMeasurement>>;

/** Shape of the manifest's extra `environments` block. Not in `IAssetManifest`. */
interface IRawEnvironmentBlock {
  readonly environments?: Readonly<
    Record<
      string,
      {
        readonly sh9?: readonly number[];
        readonly meanLuminance?: number;
        readonly maxLuminance?: number;
      }
    >
  >;
}

/**
 * A conservative fallback mean luminance.
 *
 * Used only when the manifest carries no measurement for a sky. 1.0 is a
 * no-op normalisation, which reproduces the naive behaviour — so a missing
 * measurement degrades to the known-bad look rather than to a black screen,
 * and `describeNormalisation()` reports it as unmeasured so it cannot pass
 * silently.
 */
const FALLBACK_MEAN_LUMINANCE = 1.0;

/**
 * Pull the four sky measurements out of a loaded manifest.
 *
 * Accepts the manifest object returned by `IAssetProvider.loadManifest()`. The
 * `environments` block is an extension the texture pipeline writes alongside
 * the typed `IAssetManifest` fields, so it is read structurally and defensively.
 */
export function parseEnvironmentMeasurements(manifest: unknown): EnvironmentMeasurements {
  const block = (manifest as IRawEnvironmentBlock | null | undefined)?.environments ?? {};
  const out = {} as Record<SkyKey, IEnvironmentMeasurement>;

  for (const key of Object.keys(SKY_ASSET_IDS) as SkyKey[]) {
    const id = SKY_ASSET_IDS[key];
    const raw = block[id];
    const mean = typeof raw?.meanLuminance === 'number' && raw.meanLuminance > 0
      ? raw.meanLuminance
      : FALLBACK_MEAN_LUMINANCE;
    out[key] = {
      id,
      meanLuminance: mean,
      maxLuminance: typeof raw?.maxLuminance === 'number' ? raw.maxLuminance : 0,
      sh9: Array.isArray(raw?.sh9) && raw.sh9.length === 27 ? raw.sh9 : undefined,
    };
  }
  return out as EnvironmentMeasurements;
}

/** True when a sky's measurement came from the manifest rather than the fallback. */
export function isMeasured(measurement: IEnvironmentMeasurement): boolean {
  return measurement.meanLuminance !== FALLBACK_MEAN_LUMINANCE || measurement.sh9 !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Keyframe lookup                                                            */
/* -------------------------------------------------------------------------- */

/** Which two skies are active at a given time, and how they mix. */
export interface ISkyBlend {
  readonly from: SkyKey;
  readonly to: SkyKey;
  /** 0 = entirely `from`, 1 = entirely `to`. */
  readonly alpha: number;
  /** Target mean radiance of the RESULT. Both sources normalise to this. */
  readonly luminance: number;
}

/**
 * Sample the environment curve.
 *
 * The `luminance` interpolation is done in LOG space. Brightness perception is
 * roughly logarithmic and the curve spans a 70x range, so a linear ramp between
 * 0.085 (sunset) and 0.02 (nightfall) would spend most of its wall-clock time
 * in the bright half and then fall off a cliff. In log space the darkening is
 * even, which is what dusk actually looks like.
 */
export function sampleSkyBlend(timeOfDay: number): ISkyBlend {
  const t = wrap01(timeOfDay);
  const keys = TIME_KEYFRAMES;

  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1]!.t) i++;

  const a: ISkyKeyframe = keys[i]!;
  const b: ISkyKeyframe = keys[i + 1]!;
  const span = b.t - a.t;
  const local = span <= 0 ? 0 : clamp01((t - a.t) / span);

  // Smootherstep the cross-fade so the sky does not visibly start and stop
  // moving at every keyframe. Brightness stays on the raw parameter: easing it
  // too would double-ease and make the transitions feel sluggish.
  const eased = local * local * local * (local * (local * 6 - 15) + 10);

  return {
    from: a.sky,
    to: b.sky,
    alpha: a.sky === b.sky ? 1 : eased,
    luminance: Math.exp(lerp(Math.log(a.luminance), Math.log(b.luminance), local)),
  };
}

function wrap01(t: number): number {
  const w = t % 1;
  return w < 0 ? w + 1 : w;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Per-source multiplier that flattens a sky onto a UNIT mean.
 *
 * Note it does NOT include the target luminance. The absolute scale travels
 * separately as `ILightingState.envMapIntensity` / `scene.environmentIntensity`
 * so the expensive pre-filtered radiance map does not have to be rebuilt every
 * time the brightness moves — only when the pair or the mix changes.
 */
export function normalisationScale(measurement: IEnvironmentMeasurement): number {
  return 1 / Math.max(1e-6, measurement.meanLuminance);
}

/** Human-readable audit of what normalisation is doing. For the harness readout. */
export function describeNormalisation(
  measurements: EnvironmentMeasurements
): readonly {
  sky: SkyKey;
  meanLuminance: number;
  maxLuminance: number;
  scale: number;
  measured: boolean;
  hasBakedSH: boolean;
}[] {
  return (Object.keys(measurements) as SkyKey[]).map((sky) => {
    const m = measurements[sky];
    return {
      sky,
      meanLuminance: m.meanLuminance,
      maxLuminance: m.maxLuminance,
      scale: normalisationScale(m),
      measured: isMeasured(m),
      hasBakedSH: m.sh9 !== undefined,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Spherical harmonics                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Deserialise a 27-float coefficient array into a `SphericalHarmonics3`,
 * scaled by `scale`.
 */
export function sh9FromArray(
  values: readonly number[],
  scale: number,
  target = new THREE.SphericalHarmonics3()
): THREE.SphericalHarmonics3 {
  for (let i = 0; i < 9; i++) {
    target.coefficients[i]!.set(
      (values[i * 3] ?? 0) * scale,
      (values[i * 3 + 1] ?? 0) * scale,
      (values[i * 3 + 2] ?? 0) * scale
    );
  }
  return target;
}

/**
 * Blend two skies' baked SH into `target`, normalised to a unit mean.
 *
 * THE mobile path. 27 floats per sky, a lerp, no GPU work at all, and it is
 * the ONLY place a correct night ambient can come from on a device that cannot
 * afford a PMREM: the coefficients were projected from the full-precision
 * source, so the day sky's sun energy is intact even though the stored
 * half-float map clamps it.
 *
 * Returns false when either sky has no baked coefficients, so the caller can
 * fall back to CPU projection rather than light the scene with zeros.
 */
export function blendSH9(
  measurements: EnvironmentMeasurements,
  blend: ISkyBlend,
  target: THREE.SphericalHarmonics3,
  scratch = new THREE.SphericalHarmonics3()
): boolean {
  const from = measurements[blend.from];
  const to = measurements[blend.to];
  if (!from.sh9 || !to.sh9) return false;

  sh9FromArray(from.sh9, normalisationScale(from), target);
  if (blend.alpha > 0 && blend.from !== blend.to) {
    sh9FromArray(to.sh9, normalisationScale(to), scratch);
    target.lerp(scratch, blend.alpha);
  }
  return true;
}

/**
 * Irradiance the SH set produces from a given direction, as a linear colour.
 * Used to derive ambient, ground-bounce and fog colours from the actual sky
 * rather than from hand-picked hex values that drift out of sync with it.
 */
export function irradianceTowards(
  sh: THREE.SphericalHarmonics3,
  direction: THREE.Vector3,
  target: THREE.Color
): THREE.Color {
  const v = SCRATCH_IRRADIANCE;
  sh.getIrradianceAt(direction, v);
  return target.setRGB(Math.max(0, v.x), Math.max(0, v.y), Math.max(0, v.z));
}

const SCRATCH_IRRADIANCE = new THREE.Vector3();

/**
 * Rescale a colour to unit peak, preserving hue.
 *
 * Colours and magnitudes are kept SEPARATE throughout this system: hue comes
 * from the measured sky, magnitude comes from the authored luminance curve.
 * Multiplying the two together at the source would make every tuning change to
 * brightness also change the colour, which is how palettes rot.
 */
export function normaliseHue(color: THREE.Color): THREE.Color {
  const peak = Math.max(color.r, color.g, color.b);
  if (peak > 1e-6) color.multiplyScalar(1 / peak);
  else color.setRGB(1, 1, 1);
  return color;
}

/**
 * Expand chroma about the luminance axis, preserving hue and overall
 * brightness.
 *
 * Hemispherical irradiance is nearly achromatic even under a vividly coloured
 * sky, because integrating over the whole dome averages the colour out — the
 * night sky's SH DC term sits 9% off neutral. Rendering that literally means
 * ambient light carries no time of day. The gain is applied where the colour
 * is DERIVED, never to the radiance itself, so the exposure normalisation this
 * module exists for is untouched.
 */
export function boostChroma(color: THREE.Color, gain: number): THREE.Color {
  const luma = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  if (luma <= 1e-6) return color;
  // MULTIPLICATIVE, not additive. The obvious `luma + (c - luma) * gain` drives
  // the weakest channel negative for any gain above ~1/(1-ratio) and clips it
  // to zero, which turns a faintly blue sky into saturated cyan the moment the
  // gain is raised far enough to be useful. Raising the RATIO to a power can
  // never leave the positive orthant, so hue survives any gain.
  return color.setRGB(
    luma * Math.pow(color.r / luma, gain),
    luma * Math.pow(color.g / luma, gain),
    luma * Math.pow(color.b / luma, gain)
  );
}
