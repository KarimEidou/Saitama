/**
 * DAY / NIGHT AND SKY BARREL
 *
 *   import { DayNightSystem, SkyEnvironment, NightUniforms } from '@/world/sky';
 *
 * Wiring, in the order the bootstrap does it:
 *
 *   1. `HttpAssetProvider` loads the manifest.
 *   2. `parseEnvironmentMeasurements(provider.rawManifest)` reads the measured
 *      mean luminances — the numbers the whole system normalises against.
 *   3. `SkyEnvironmentRegistry.open()` gives an `IAssetRegistry` for the HDRIs.
 *   4. `DayNightSystem` owns the clock and publishes `lighting`.
 *   5. `SkyEnvironment` blends the maps and installs the IBL.
 *   6. `NightUniforms` carries nightfall to every lit surface in one write.
 *
 * This module NEVER imports another system. It publishes an `ILightingState`
 * and emits `TimeOfDayChanged`; the renderer, shadows, audio and gameplay pick
 * those up through the contracts.
 */

export {
  DAY_LENGTH_SECONDS,
  CITY_LATITUDE_DEGREES,
  CITY_LONGITUDE_DEGREES,
  CITY_TIMEZONE_HOURS,
  WORLD_DAY_OF_YEAR,
  INITIAL_LUNAR_AGE_DAYS,
  SYNODIC_MONTH_DAYS,
  PHASE_BOUNDARIES,
  SKY_ASSET_IDS,
  TIME_KEYFRAMES,
  EXPOSURE_ADAPTATION,
  EXPOSURE_REFERENCE,
  EXPOSURE_MIN,
  EXPOSURE_MAX,
  SUN_PEAK_INTENSITY,
  MOON_PEAK_INTENSITY,
  FOG_DENSITY_DAY,
  FOG_DENSITY_NIGHT,
  SHADOW_RADIUS_DAY,
  SHADOW_RADIUS_NIGHT,
  MAX_BLEND_RADIANCE,
  ENVIRONMENT_REBUILD_THRESHOLD,
  type ISkyKeyframe,
  type SkyKey,
} from './constants';

export {
  solarDeclination,
  sunPosition,
  moonPosition,
  moonIllumination,
  type ICelestialPosition,
  type ISolarOptions,
} from './solar';

export {
  parseEnvironmentMeasurements,
  describeNormalisation,
  normalisationScale,
  isMeasured,
  sampleSkyBlend,
  blendSH9,
  sh9FromArray,
  irradianceTowards,
  normaliseHue,
  boostChroma,
  type IEnvironmentMeasurement,
  type EnvironmentMeasurements,
  type ISkyBlend,
} from './environment-blend';

export {
  MutableSkyLightingState,
  MutableDayNightState,
  deriveLighting,
  fillDayNightState,
  phaseForTime,
  type ISkyDerived,
  type IDeriveLightingInput,
} from './sky-lighting';

export {
  DayNightSystem,
  type IDayNightOptions,
  type TimeOverrideMode,
} from './day-night-system';

export {
  NightUniforms,
  type INightUniformOptions,
  type NightEmissiveMode,
} from './night-uniforms';

export {
  HttpAssetProvider,
  SkyEnvironmentRegistry,
  prepareEnvironment,
  type IHttpAssetProviderOptions,
  type ISkyRegistryOptions,
} from './sky-assets';

export {
  SkyEnvironment,
  type SkyIBLMode,
  type ISkyEnvironmentOptions,
  type ISkyEnvironmentStats,
} from './sky-environment';
