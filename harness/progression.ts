/**
 * PROGRESSION + DAY/NIGHT VERIFICATION HARNESS
 *
 * ── WHAT IS UNDER TEST, AND HOW ────────────────────────────────────────────
 * THE SKY is verified visually because the claim is visual. A synthetic block
 * — ground, buildings, window emissives, street lamps, a few metal spheres —
 * lit ENTIRELY by `src/world/sky/**`, screenshotted from ONE fixed camera at
 * six times of day. If the exposure normalisation described in
 * `src/world/sky/constants.ts` is wrong, midnight and noon come back with the
 * same mean luminance, and no amount of unit testing would have caught it.
 *
 * THE RULES are verified numerically, headlessly, over the event bus: rank,
 * witnesses, boredom, quests and saves. Those have no pixels.
 *
 * ── WHAT THIS HARNESS DELIBERATELY DOES NOT DO ─────────────────────────────
 * It does not import the city, combat, VFX, crowd or monster workstreams. The
 * block below is synthesised here precisely so that a failure in this harness
 * is a failure in the sky or in progression and nowhere else.
 *
 * It never reports frame rate. This runs under SwiftShader, a CPU software
 * rasteriser; any number it produced would be a measurement of the CI machine.
 *
 * Playwright drives `window.__PROGRESSION_HARNESS__`.
 */

import * as THREE from 'three';
import type { IEventBus, ThreatTier, Vec3 } from '@/types';
import { createEventBus, createRng } from '@/util';
import { Renderer, ShadowSystem, renderProfileFor } from '@/engine';
import {
  DayNightSystem,
  HttpAssetProvider,
  NightUniforms,
  SkyEnvironment,
  SkyEnvironmentRegistry,
  describeNormalisation,
  parseEnvironmentMeasurements,
  type EnvironmentMeasurements,
  type SkyIBLMode,
} from '@/world/sky';
import {
  BOREDOM_FUN_FIGHT_LOCK,
  BOREDOM_RANK_FLOOR,
  ProgressionCoordinator,
  QUEST_DEFS,
  formatRank,
  rankGap,
} from '@/gameplay/progression';

/* -------------------------------------------------------------------------- */
/* Fixed configuration                                                        */
/* -------------------------------------------------------------------------- */

/** The six times screenshotted. One camera, six clocks, nothing else varies. */
export const SHOT_TIMES: readonly { readonly id: string; readonly t: number; readonly label: string }[] = [
  { id: 'midnight', t: 0.0, label: '00:00 midnight' },
  { id: 'dawn', t: 0.198, label: '04:45 dawn' },
  { id: 'morning', t: 0.3333, label: '08:00 morning' },
  { id: 'noon', t: 0.5, label: '12:00 noon' },
  { id: 'dusk', t: 0.75, label: '18:00 golden hour' },
  { id: 'night', t: 0.8229, label: '19:45 nightfall' },
];

/** Fixed camera. Street level, looking down the avenue at the tower row. */
const CAMERA_POSITION = new THREE.Vector3(-3.5, 6.5, 62);
const CAMERA_TARGET = new THREE.Vector3(2, 9, -40);

const WORLD_SEED = 0x5a17a4a;

/**
 * Cascade profile used by the harness: 2 x 1024 over the FULL 200 m range.
 *
 * The shipping high tier is 3 x 2048 / 200 m. Three 2048-square depth passes
 * is twelve million pixels of software rasterisation per frame on top of the
 * main view, which under SwiftShader turns a six-shot run into a twenty-minute
 * one and measures the CI machine rather than the cycle.
 *
 * The map SIZE and cascade COUNT are what cost; the RANGE is what decides
 * whether a building 80 m down the street casts a shadow at all. So the range
 * is kept at the shipping 200 m and only the resolution is dropped — the
 * screenshots still show real cascaded shadows moving with the sun, which is
 * the part under test.
 */
const HARNESS_SHADOW_PROFILE = {
  ...renderProfileFor('high').shadows,
  cascades: 2,
  mapSize: 1024,
};

/**
 * Equirect width of the sky blend target here.
 *
 * The shipping default is 1024 (PMREM cube 256). 512 halves the convolution
 * cost, and at a 600 px stage the difference is not visible — the thing being
 * measured is mean luminance and colour balance, not reflection sharpness.
 */
const HARNESS_BLEND_WIDTH = 512;

/**
 * Asset tier the harness pulls the skies at.
 *
 * `mobile` is the 1024x512 build: 2.5 MB per sky rather than 7.4 MB, four
 * times less zstd to decode, and identical once normalised — the mean
 * luminance of a box-filtered image is the mean luminance of the original.
 */
const HARNESS_ASSET_TIER = 'mobile' as const;

/* -------------------------------------------------------------------------- */
/* Snapshot shape (mirrored in progression.verify.ts)                         */
/* -------------------------------------------------------------------------- */

export interface ISkySnapshot {
  readonly timeOfDay: number;
  readonly phase: string;
  readonly dayCount: number;
  readonly blendFrom: string;
  readonly blendTo: string;
  readonly blendAlpha: number;
  /** Target mean sky radiance for this instant. Also `envMapIntensity`. */
  readonly skyLuminance: number;
  readonly exposure: number;
  /** `skyLuminance * exposure` — what actually reaches the tone mapper. */
  readonly netLuminance: number;
  readonly sunElevationDegrees: number;
  readonly sunAzimuthDegrees: number;
  readonly sunIntensity: number;
  readonly moonIntensity: number;
  readonly moonIsKeyLight: boolean;
  readonly nightFactor: number;
  readonly windowLitFraction: number;
  readonly streetLightsOn: boolean;
  readonly shadowRadius: number;
  readonly fogDensity: number;
  readonly fogColor: string;
  readonly ambientColor: string;
  readonly groundColor: string;
  readonly sunColor: string;
  readonly hasMeasuredEnvironment: boolean;
}

export interface IProgressionSnapshot {
  readonly rank: string;
  readonly heroClass: string;
  readonly rankNumber: number;
  readonly points: number;
  readonly reputation: number;
  readonly boredom: number;
  readonly rankGainMultiplier: number;
  readonly funFightsAvailable: boolean;
  readonly killsTotal: number;
  readonly civiliansSaved: number;
  readonly civiliansLost: number;
  readonly propertyDamage: number;
  readonly witnesses: number;
  readonly genosRank: string;
  readonly genosSeatsAbove: number;
  readonly questCounts: Readonly<Record<string, number>>;
}

export interface IHarnessSnapshot {
  readonly ready: boolean;
  readonly assetsLoaded: boolean;
  readonly iblMode: SkyIBLMode;
  readonly skiesLoaded: readonly string[];
  readonly skiesMissing: readonly string[];
  readonly normalisation: readonly {
    sky: string;
    meanLuminance: number;
    maxLuminance: number;
    scale: number;
    measured: boolean;
    hasBakedSH: boolean;
  }[];
  readonly radianceRebuilds: number;
  readonly radianceResolution: number;
  readonly environmentGpuBytes: number;
  /** Materials wired to the shared night uniforms. Two: one lamp, one window. */
  readonly litMaterials: number;
  /** Meshes those two materials cover. THE ratio the design claim rests on. */
  readonly litMeshes: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly programs: number;
  readonly sky: ISkySnapshot;
  readonly progression: IProgressionSnapshot;
  readonly problems: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

interface ISceneBuild {
  readonly root: THREE.Group;
  readonly materials: readonly THREE.Material[];
  readonly lampMaterials: readonly THREE.Material[];
  readonly windowMaterials: readonly THREE.Material[];
  readonly triangles: number;
}

/**
 * A synthetic city block.
 *
 * Every element earns its place in a screenshot comparison:
 *   ground        a large lit surface whose brightness IS the exposure test
 *   towers        big shadow casters spanning several cascades, so the sun
 *                 direction is visible as a moving shadow rather than asserted
 *   window bands  emissive surfaces switched by the SHARED night uniform
 *   lamp heads    the other consumer of that same uniform
 *   metal spheres specular response, which is the only thing that shows
 *                 whether the pre-filtered radiance map actually rebuilt
 */
function buildScene(nightUniforms: NightUniforms): ISceneBuild {
  const rng = createRng(WORLD_SEED);
  const root = new THREE.Group();
  root.name = 'harness.block';

  const materials: THREE.Material[] = [];
  const lampMaterials: THREE.Material[] = [];
  const windowMaterials: THREE.Material[] = [];
  let triangles = 0;

  const track = (material: THREE.Material): THREE.Material => {
    materials.push(material);
    return material;
  };

  /* Ground ---------------------------------------------------------------- */
  const groundMaterial = track(
    new THREE.MeshStandardMaterial({
      name: 'harness.asphalt',
      color: 0x3a3d42,
      roughness: 0.92,
      metalness: 0.02,
    })
  );
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 1, 1), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);
  triangles += 2;

  /* Pavement strips ------------------------------------------------------- */
  const kerbMaterial = track(
    new THREE.MeshStandardMaterial({
      name: 'harness.kerb',
      color: 0x8e8b84,
      roughness: 0.8,
      metalness: 0.0,
    })
  );
  for (const side of [-1, 1]) {
    const kerb = new THREE.Mesh(new THREE.BoxGeometry(9, 0.35, 260), kerbMaterial);
    kerb.position.set(side * 15, 0.17, -50);
    kerb.receiveShadow = true;
    kerb.castShadow = true;
    root.add(kerb);
    triangles += 12;
  }

  /* Buildings ------------------------------------------------------------- */
  const wallColors = [0xb8b2a6, 0x9aa3ad, 0xc0a894, 0x8d8f96, 0xa8a196];
  const windowMaterial = track(
    new THREE.MeshStandardMaterial({
      name: 'harness.window',
      color: 0x1b2430,
      roughness: 0.12,
      metalness: 0.55,
      emissive: 0x000000,
    })
  );
  windowMaterials.push(windowMaterial);

  // The near pair starts almost level with the camera so their shadows fall
  // ACROSS the visible road at low sun. Buildings pushed far down the street
  // cast just as correctly and none of it lands in frame.
  for (let i = 0; i < 16; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const depth = 14 - Math.floor(i / 2) * 30 - rng.range(0, 6);
    const width = rng.range(14, 22);
    const height = rng.range(14, 46);
    const bodyDepth = rng.range(16, 26);
    const wall = track(
      new THREE.MeshStandardMaterial({
        name: `harness.wall.${i}`,
        color: rng.pick(wallColors),
        roughness: rng.range(0.6, 0.9),
        metalness: 0.02,
      })
    );

    const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, bodyDepth), wall);
    body.position.set(side * (22 + rng.range(0, 6)) + width * 0.5 * side, height * 0.5, depth);
    body.castShadow = true;
    body.receiveShadow = true;
    root.add(body);
    triangles += 12;

    // Window bands: separate meshes sharing ONE material, which is the whole
    // point — nightfall is a single uniform write, not a traversal. Sat just
    // proud of the facade the camera can see, not at a random depth, or they
    // float in front of the building like billboards.
    const bands = Math.max(2, Math.floor(height / 4.5));
    for (let b = 1; b < bands; b++) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(width * 0.86, 1.7, 0.3), windowMaterial);
      band.position.set(body.position.x, b * (height / bands), depth + bodyDepth * 0.5 + 0.12);
      band.castShadow = false;
      band.receiveShadow = false;
      root.add(band);
      triangles += 12;

      // ...and one on the street-facing side, so the lit windows read from
      // this camera even for the buildings edge-on to it.
      const sideBand = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 1.7, bodyDepth * 0.82),
        windowMaterial
      );
      sideBand.position.set(
        body.position.x - side * (width * 0.5 + 0.12),
        b * (height / bands),
        depth
      );
      root.add(sideBand);
      triangles += 12;
    }
  }

  /* Street lamps ---------------------------------------------------------- */
  const poleMaterial = track(
    new THREE.MeshStandardMaterial({
      name: 'harness.pole',
      color: 0x2d3238,
      roughness: 0.45,
      metalness: 0.85,
    })
  );
  const lampMaterial = track(
    new THREE.MeshStandardMaterial({
      name: 'harness.lamp',
      color: 0x14171c,
      roughness: 0.35,
      metalness: 0.2,
      emissive: 0x000000,
    })
  );
  lampMaterials.push(lampMaterial);

  for (let i = 0; i < 12; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const z = 36 - Math.floor(i / 2) * 34;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 8, 6), poleMaterial);
    pole.position.set(side * 13, 4, z);
    pole.castShadow = true;
    root.add(pole);
    triangles += 24;

    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.22, 0.22), poleMaterial);
    arm.position.set(side * 11.8, 7.9, z);
    root.add(arm);
    triangles += 12;

    const head = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.55, 1.0), lampMaterial);
    head.position.set(side * 10.7, 7.55, z);
    root.add(head);
    triangles += 12;
  }

  /* Metal spheres — the only witness to whether the radiance map rebuilt --- */
  for (let i = 0; i < 5; i++) {
    const metal = track(
      new THREE.MeshStandardMaterial({
        name: `harness.metal.${i}`,
        color: 0xd8d8dc,
        roughness: 0.04 + i * 0.11,
        metalness: 1,
      })
    );
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.5, 24, 16), metal);
    sphere.position.set(-8 + i * 4, 1.6, 34);
    sphere.castShadow = true;
    root.add(sphere);
    triangles += 24 * 16 * 2;
  }

  /* Attach the shared night uniforms -------------------------------------- */
  for (const material of lampMaterials) nightUniforms.attach(material, 'lamp');
  for (const material of windowMaterials) nightUniforms.attach(material, 'window');

  return { root, materials, lampMaterials, windowMaterials, triangles };
}

/* -------------------------------------------------------------------------- */
/* Headless progression scenarios                                             */
/* -------------------------------------------------------------------------- */

export interface IScenarioResult {
  readonly name: string;
  readonly detail: Readonly<Record<string, number | string | boolean>>;
}

/**
 * Scripted, deterministic runs of the ranking rules.
 *
 * Every one of these could be a unit test, and most of them also are. They run
 * HERE as well so the harness report — the thing a human actually reads —
 * contains the measured numbers rather than a green tick.
 *
 * `createRng` throughout. `Math.random()` would make the report unreproducible
 * and therefore useless as evidence.
 */
export function runScenarios(): readonly IScenarioResult[] {
  const results: IScenarioResult[] = [];
  const stream = createRng('progression-harness');

  /* 1. Many unwitnessed kills ------------------------------------------- */
  {
    const bus = createEventBus();
    const coordinator = new ProgressionCoordinator({ bus, worldSeed: WORLD_SEED });
    const before = coordinator.progression.points;

    for (let i = 0; i < 200; i++) {
      const position = { x: stream.range(-900, 900), y: 0, z: stream.range(-900, 900) };
      bus.emit('EntityKilled', {
        entityId: `m${i}`,
        entityType: 'monster',
        faction: 'monster',
        position,
        threatTier: stream.pick<ThreatTier>(['wolf', 'tiger', 'demon']),
        specId: 'monster.generic',
        intent: 'normal',
        rewardPoints: 80,
      });
    }
    coordinator.update(1);

    results.push({
      name: 'unwitnessedKills',
      detail: {
        kills: 200,
        pointsBefore: round(before),
        pointsAfter: round(coordinator.progression.points),
        pointsGained: round(coordinator.progression.points - before),
        rank: formatRank(coordinator.progression.state.rank),
      },
    });
    coordinator.dispose();
  }

  /* 2. Witnessed rescues -------------------------------------------------- */
  {
    const bus = createEventBus();
    const coordinator = new ProgressionCoordinator({ bus, worldSeed: WORLD_SEED });
    const before = coordinator.progression.points;
    const scene: Vec3 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 14; i++) {
      const [dx, dz] = stream.insideCircle(14);
      coordinator.witnesses.register(`civ${i}`, 'civilian', { x: dx, y: 0, z: dz });
    }
    for (let i = 0; i < 20; i++) {
      bus.emit('CivilianSaved', {
        entityId: `saved${i}`,
        position: scene,
        byPlayer: true,
        reputationDelta: 1,
      });
    }
    coordinator.update(1);

    results.push({
      name: 'witnessedRescues',
      detail: {
        rescues: 20,
        witnesses: coordinator.witnesses.size,
        pointsGained: round(coordinator.progression.points - before),
        rank: formatRank(coordinator.progression.state.rank),
      },
    });
    coordinator.dispose();
  }

  /* 3. Reported collateral with nobody watching -------------------------- */
  {
    const bus = createEventBus();
    const coordinator = new ProgressionCoordinator({ bus, worldSeed: WORLD_SEED });
    // Bank some standing first so the fall is visible.
    for (let i = 0; i < 12; i++) {
      coordinator.witnesses.register(`civ${i}`, 'civilian', { x: i, y: 0, z: 0 });
    }
    for (let i = 0; i < 40; i++) {
      bus.emit('CivilianSaved', { entityId: `s${i}`, position: { x: 0, y: 0, z: 0 }, byPlayer: true, reputationDelta: 1 });
    }
    const peak = coordinator.progression.points;
    const peakRank = formatRank(coordinator.progression.state.rank);

    coordinator.witnesses.clear();
    bus.emit('EncounterStarted', {
      encounterId: 'e.quiet',
      threatTier: 'wolf',
      position: { x: 0, y: 0, z: 0 },
      radius: 45,
      participantIds: [],
      isBoss: false,
    });
    bus.emit('EncounterEnded', {
      encounterId: 'e.quiet',
      outcome: 'victory',
      duration: 4,
      civiliansLost: 0,
      // Deliberately NOT enough to bottom out the ladder: a total that clamps
      // at zero proves only that the clamp works. This is sized so the fall is
      // a MEASURED fall of some fifty ranks.
      collateralCost: 250000,
    });
    coordinator.update(1);
    const report = coordinator.progression.incidentReports.at(-1)!;

    results.push({
      name: 'unwitnessedCollateral',
      detail: {
        peakPoints: round(peak),
        peakRank,
        collateralGross: report.collateralGross,
        collateralReported: round(report.collateralReported),
        reportRate: round(report.collateralReported / report.collateralGross, 4),
        pointsAfter: round(coordinator.progression.points),
        rankAfter: formatRank(coordinator.progression.state.rank),
      },
    });
    coordinator.dispose();
  }

  /* 4. Genos at the same fight -------------------------------------------- */
  {
    const bus = createEventBus();
    const coordinator = new ProgressionCoordinator({ bus, worldSeed: WORLD_SEED });
    for (let i = 0; i < 14; i++) {
      coordinator.witnesses.register(`civ${i}`, 'civilian', { x: i * 0.5, y: 0, z: 0 });
    }
    const startGap = rankGap(coordinator.rivals.rank('genos'), coordinator.progression.state.rank);

    for (let i = 0; i < 10; i++) {
      bus.emit('EncounterStarted', {
        encounterId: `e.joint.${i}`,
        threatTier: 'demon',
        position: { x: 0, y: 0, z: 0 },
        radius: 60,
        participantIds: ['ally.genos'],
        isBoss: false,
      });
      bus.emit('EntityKilled', {
        entityId: `boss${i}`,
        entityType: 'monster',
        faction: 'monster',
        position: { x: 0, y: 0, z: 0 },
        threatTier: 'demon',
        specId: 'monster.generic',
        intent: 'normal',
        rewardPoints: 200,
      });
      bus.emit('EncounterEnded', {
        encounterId: `e.joint.${i}`,
        outcome: 'victory',
        duration: 30,
        civiliansLost: 0,
        collateralCost: 0,
      });
    }
    coordinator.update(1);

    const playerCredit = coordinator.progression.incidentReports.reduce((sum, r) => sum + r.awardedPoints, 0);
    const genosCredit = coordinator.progression.incidentReports.reduce((sum, r) => sum + (r.rivalCredit.genos ?? 0), 0);

    results.push({
      name: 'genosIrony',
      detail: {
        jointIncidents: 10,
        playerCredit: round(playerCredit),
        genosCredit: round(genosCredit),
        ratio: round(genosCredit / Math.max(1e-6, playerCredit), 3),
        playerRank: formatRank(coordinator.progression.state.rank),
        genosRank: formatRank(coordinator.rivals.rank('genos')),
        startGap,
        endGap: rankGap(coordinator.rivals.rank('genos'), coordinator.progression.state.rank),
      },
    });
    coordinator.dispose();
  }

  /* 5. Boredom throttle ---------------------------------------------------- */
  {
    const fresh = new ProgressionCoordinator({ bus: createEventBus(), worldSeed: WORLD_SEED });
    const jadedBus = createEventBus();
    const jaded = new ProgressionCoordinator({ bus: jadedBus, worldSeed: WORLD_SEED });
    jadedBus.emit('BoredomChanged', { value: 1, previous: 0, reason: 'trivialVictory' });

    const before = fresh.progression.points;
    fresh.progression.addPoints(1000, 'harness');
    jaded.progression.addPoints(1000, 'harness');

    results.push({
      name: 'boredomThrottle',
      detail: {
        freshGain: round(fresh.progression.points - before),
        jadedGain: round(jaded.progression.points - before),
        ratio: round((jaded.progression.points - before) / (fresh.progression.points - before), 4),
        expectedFloor: BOREDOM_RANK_FLOOR,
        funFightsAtMaxBoredom: jaded.boredom.funFightsAvailable,
        funFightLock: BOREDOM_FUN_FIGHT_LOCK,
      },
    });
    fresh.dispose();
    jaded.dispose();
  }

  /* 6. Quest state machine ------------------------------------------------ */
  {
    const bus = createEventBus();
    const coordinator = new ProgressionCoordinator({ bus, worldSeed: WORLD_SEED });

    // The bargain sale versus the Mosquito Girl. He can do one of them.
    coordinator.quests.accept('quest.errand.bargain');
    coordinator.quests.accept('quest.subjugation.crablante');
    bus.emit('EntityKilled', {
      entityId: 'crab',
      entityType: 'monster',
      faction: 'monster',
      position: { x: 120, y: 0, z: -80 },
      threatTier: 'tiger',
      specId: 'monster.crablante',
      intent: 'normal',
      rewardPoints: 90,
    });
    coordinator.update(0.5);
    const crablanteState = coordinator.quests.quests.get('quest.subjugation.crablante')!.state;

    coordinator.quests.accept('quest.subjugation.mosquito');
    coordinator.quests.reportProgress('defeatTier', 'wolf', 40);
    bus.emit('EntityKilled', {
      entityId: 'mg',
      entityType: 'monster',
      faction: 'monster',
      position: { x: 310, y: 0, z: 60 },
      threatTier: 'demon',
      specId: 'monster.mosquitoGirl',
      intent: 'normal',
      rewardPoints: 400,
    });
    coordinator.update(0.5);

    results.push({
      name: 'questConflict',
      detail: {
        crablante: crablanteState,
        mosquito: coordinator.quests.quests.get('quest.subjugation.mosquito')!.state,
        bargainSale: coordinator.quests.quests.get('quest.errand.bargain')!.state,
        boredomAfterMissingTheSale: round(coordinator.boredom.boredom, 4),
      },
    });
    coordinator.dispose();
  }

  /* 7. Evacuation timer expiry -------------------------------------------- */
  {
    const bus = createEventBus();
    const coordinator = new ProgressionCoordinator({ bus, worldSeed: WORLD_SEED });
    coordinator.quests.accept('quest.rescue.tunnel');
    coordinator.quests.setPlayerPosition({ x: -260, y: 0, z: 140 });
    coordinator.update(20);
    const midway = coordinator.quests.quests.get('quest.rescue.tunnel')!.state;
    for (let i = 0; i < 300; i++) coordinator.update(1);

    results.push({
      name: 'evacuationTimer',
      detail: {
        atTwentySeconds: midway,
        afterExpiry: coordinator.quests.quests.get('quest.rescue.tunnel')!.state,
        boredom: round(coordinator.boredom.boredom, 4),
      },
    });
    coordinator.dispose();
  }

  return results;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export interface ISaveRoundTripResult {
  readonly backend: string;
  readonly exact: boolean;
  readonly bytes: number;
  readonly mismatches: readonly string[];
  readonly rank: string;
  readonly boredom: number;
  readonly questStates: number;
}

/**
 * Play a short session, write it, read it back, and compare byte for byte.
 *
 * Runs in the BROWSER rather than in Node so the real backend selection is
 * exercised: `selectSaveBackend()` probes `localStorage` with an actual write
 * here, which is the path the shipping web build takes. The Capacitor path
 * needs a device and is covered by the backend unit tests.
 */
export async function runSaveRoundTrip(): Promise<ISaveRoundTripResult> {
  const bus = createEventBus();
  const coordinator = new ProgressionCoordinator({ bus, worldSeed: WORLD_SEED });
  const stream = createRng('save-round-trip');

  for (let i = 0; i < 16; i++) {
    coordinator.witnesses.register(`civ${i}`, 'civilian', {
      x: stream.range(-20, 20),
      y: 0,
      z: stream.range(-20, 20),
    });
  }
  coordinator.quests.accept('quest.duty.quota');
  for (let i = 0; i < 4; i++) {
    const position = { x: i * 300, y: 0, z: 0 };
    bus.emit('EncounterStarted', {
      encounterId: `e${i}`,
      threatTier: 'demon',
      position,
      radius: 50,
      participantIds: ['ally.genos'],
      isBoss: false,
    });
    bus.emit('EntityKilled', {
      entityId: `m${i}`,
      entityType: 'monster',
      faction: 'monster',
      position,
      threatTier: 'demon',
      specId: 'monster.generic',
      intent: 'normal',
      rewardPoints: 150,
    });
    bus.emit('EncounterEnded', {
      encounterId: `e${i}`,
      outcome: 'victory',
      duration: 21,
      civiliansLost: 0,
      collateralCost: stream.range(0, 40000),
    });
  }
  for (let i = 0; i < 7; i++) {
    bus.emit('CivilianSaved', {
      entityId: `s${i}`,
      position: { x: 0, y: 0, z: 0 },
      byPlayer: true,
      reputationDelta: 1,
    });
  }
  coordinator.update(3.25);

  const position = { x: stream.range(-100, 100), y: 1.5, z: stream.range(-100, 100) };
  const yaw = stream.range(-Math.PI, Math.PI);
  const written = await coordinator.save(position, yaw);
  const loaded = await coordinator.saves.load();

  const before = JSON.stringify(written);
  const after = JSON.stringify(loaded);
  const mismatches: string[] = [];
  if (before !== after) {
    mismatches.push('serialised payloads differ');
    // Narrow it down to the first differing key, which is what a human needs.
    const a = JSON.parse(before) as Record<string, unknown>;
    const b = (loaded ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(a)) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) mismatches.push(`key "${key}"`);
    }
  }

  const result: ISaveRoundTripResult = {
    backend: coordinator.saves.backendName ?? 'unknown',
    exact: before === after,
    bytes: before.length,
    mismatches,
    rank: formatRank(coordinator.progression.state.rank),
    boredom: coordinator.boredom.boredom,
    questStates: Object.keys(written.questStates).length,
  };
  coordinator.dispose();
  return result;
}

/* -------------------------------------------------------------------------- */
/* The harness                                                                */
/* -------------------------------------------------------------------------- */

class ProgressionHarness {
  readonly bus: IEventBus = createEventBus();

  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: Renderer;
  private readonly shadows: ShadowSystem;
  private readonly nightUniforms = new NightUniforms();
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly fog: THREE.FogExp2;
  private readonly build: ISceneBuild;
  private readonly coordinator: ProgressionCoordinator;
  private readonly problems: string[] = [];

  private dayNight: DayNightSystem;
  private measurements: EnvironmentMeasurements;
  private skyEnvironment: SkyEnvironment | undefined;
  private registry: SkyEnvironmentRegistry | undefined;
  private iblMode: SkyIBLMode = 'pmrem';
  private assetsLoaded = false;
  private elapsed = 0;
  private frame = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const width = canvas.clientWidth || 960;
    const height = canvas.clientHeight || 540;
    this.camera = new THREE.PerspectiveCamera(52, width / height, 0.3, 900);
    this.camera.position.copy(CAMERA_POSITION);
    this.camera.lookAt(CAMERA_TARGET);

    this.renderer = new Renderer({
      canvas,
      tier: 'high',
      preserveDrawingBuffer: true,
      adaptiveResolution: false,
      devicePixelRatio: 1,
      width,
      height,
    });

    // No measurements yet: the world must be lit before the HDRIs land.
    this.measurements = parseEnvironmentMeasurements({});
    this.dayNight = new DayNightSystem({ bus: this.bus, startTimeOfDay: 0.5 });
    this.renderer.setLightingState(this.dayNight.lighting);

    this.shadows = new ShadowSystem(this.scene, this.camera, {
      profile: HARNESS_SHADOW_PROFILE,
      lighting: this.dayNight.lighting,
    });

    this.fog = new THREE.FogExp2(0x9fb2c8, this.dayNight.lighting.fogDensity);
    this.scene.fog = this.fog;

    // A weak hemisphere term standing in for bounce the SH cannot carry.
    // Its colours track the lighting state, so it darkens with everything else.
    this.hemisphere = new THREE.HemisphereLight(0xffffff, 0x404040, 0);
    this.scene.add(this.hemisphere);

    this.build = buildScene(this.nightUniforms);
    this.scene.add(this.build.root);
    this.shadows.registerSceneMaterials(this.build.root);

    this.coordinator = new ProgressionCoordinator({
      bus: this.bus,
      worldSeed: WORLD_SEED,
      time: this.dayNight,
    });
    this.seedWitnesses();
  }

  /* ---------------------------------------------------------------------- */

  /** Load the four skies through `IAssetProvider` / `IAssetRegistry`. */
  async loadAssets(baseUrl = '/assets', mode: SkyIBLMode = 'pmrem'): Promise<boolean> {
    this.iblMode = mode;
    try {
      const provider = new HttpAssetProvider({ baseUrl, tier: HARNESS_ASSET_TIER });
      await provider.loadManifest();

      // The measured mean luminances live in the manifest's `environments`
      // block. Everything downstream normalises against them.
      this.measurements = parseEnvironmentMeasurements(provider.rawManifest);
      this.dayNight.setMeasurements(this.measurements);

      this.registry = await SkyEnvironmentRegistry.open({
        provider,
        renderer: this.renderer.raw,
        tier: HARNESS_ASSET_TIER,
        transcoderPath: '/basis/',
      });

      this.skyEnvironment = new SkyEnvironment({
        renderer: this.renderer.raw,
        scene: this.scene,
        registry: this.registry,
        measurements: this.measurements,
        mode,
        blendWidth: HARNESS_BLEND_WIDTH,
        specularCubeSize: 32,
        showBackground: true,
      });

      const loaded = await this.skyEnvironment.load();
      if (loaded.length < 4) {
        this.problems.push(`only ${loaded.length}/4 skies loaded`);
      }
      this.assetsLoaded = loaded.length > 0;
      this.applySky(true);
      return this.assetsLoaded;
    } catch (error) {
      this.problems.push(`asset load failed: ${String(error)}`);
      return false;
    }
  }

  /** Jump the clock and rebuild everything that depends on it. */
  setTimeOfDay(t: number): void {
    this.dayNight.setTimeOfDay(t);
    this.applySky(true);
  }

  /** Advance one frame. */
  step(dt = 1 / 60): void {
    this.elapsed += dt;
    this.bus.setFrame(++this.frame, this.elapsed);
    this.dayNight.update(dt);
    this.coordinator.update(dt);
    this.applySky(false);
    this.drawFrame();
  }

  /** Render without advancing the clock. Used between screenshots. */
  renderOnce(): void {
    this.bus.setFrame(++this.frame, this.elapsed);
    this.applySky(false);
    this.drawFrame();
  }

  private drawFrame(): void {
    // `CSM.update()` fits the cascades to the camera FRUSTUM, which it reads
    // off `camera.matrixWorld`. Three only refreshes that inside `render()`,
    // so a camera that was positioned but never rendered gives the first frame
    // an identity matrix and cascades fitted around the origin. Harmless in a
    // running game, very visible in a screenshot harness that renders four
    // frames and captures.
    this.camera.updateMatrixWorld();
    this.shadows.update();
    this.renderer.render(this.scene, this.camera);
  }

  private applySky(forceRebuild: boolean): void {
    const lighting = this.dayNight.lighting;
    const derived = this.dayNight.derived;

    this.shadows.applyLightingState(lighting);
    this.renderer.setLightingState(lighting);

    this.fog.color.copy(lighting.fogColor);
    this.fog.density = lighting.fogDensity;

    this.hemisphere.color.copy(lighting.ambientColor);
    this.hemisphere.groundColor.copy(lighting.groundColor);
    // Only a bounce top-up: the real ambient is the IBL. Without an
    // environment at all this is the ONLY ambient, so it carries the whole
    // curve in that case.
    this.hemisphere.intensity = this.assetsLoaded
      ? lighting.ambientIntensity * 0.25
      : lighting.ambientIntensity;

    this.nightUniforms.update(derived.nightFactor, derived.windowLitFraction, this.elapsed);

    if (this.skyEnvironment) {
      this.skyEnvironment.update(this.dayNight.blend, forceRebuild);
      if (this.iblMode === 'sh9' && this.dayNight.hasMeasuredEnvironment) {
        this.skyEnvironment.setSphericalHarmonics(
          this.dayNight.sphericalHarmonics,
          this.dayNight.blend.luminance
        );
      }
    }
  }

  /**
   * Register the crowd that decides whether anything the player does counts.
   * Deterministic: the same seed places the same bystanders every run.
   */
  private seedWitnesses(): void {
    const rng = createRng('harness-crowd');
    for (let i = 0; i < 18; i++) {
      const [dx, dz] = rng.insideCircle(30);
      this.coordinator.witnesses.register(`civ.${i}`, 'civilian', { x: dx, y: 0, z: dz });
    }
    this.coordinator.witnesses.register('press.1', 'press', { x: 4, y: 0, z: 12 });
    this.coordinator.witnesses.register('ally.genos', 'hero', { x: -6, y: 0, z: 10 });
  }

  /* ---------------------------------------------------------------------- */

  snapshot(): IHarnessSnapshot {
    const lighting = this.dayNight.lighting;
    const derived = this.dayNight.derived;
    const state = this.dayNight.state;
    const blend = this.dayNight.blend;
    const stats = this.renderer.getStats();
    const envStats = this.skyEnvironment?.getStats();
    const progression = this.coordinator.progression;
    const rank = progression.state.rank;

    const questCounts: Record<string, number> = {
      locked: 0,
      available: 0,
      active: 0,
      completed: 0,
      failed: 0,
    };
    for (const quest of this.coordinator.quests.quests.values()) {
      questCounts[quest.state] = (questCounts[quest.state] ?? 0) + 1;
    }

    const kills = progression.state.killsByTier;
    const genos = this.coordinator.rivals.rank('genos');

    return {
      ready: true,
      assetsLoaded: this.assetsLoaded,
      iblMode: this.iblMode,
      skiesLoaded: envStats?.loaded ?? [],
      skiesMissing: envStats?.missing ?? ['dawn', 'day', 'dusk', 'night'],
      normalisation: describeNormalisation(this.measurements).map((row) => ({ ...row })),
      radianceRebuilds: envStats?.radianceRebuilds ?? 0,
      radianceResolution: envStats?.radianceResolution ?? 0,
      environmentGpuBytes: envStats?.gpuBytes ?? 0,
      litMaterials: this.nightUniforms.materialCount,
      litMeshes: this.countLitMeshes(),
      drawCalls: stats.drawCalls,
      triangles: stats.triangles,
      programs: this.renderer.programCount,
      sky: {
        timeOfDay: state.timeOfDay,
        phase: state.phase,
        dayCount: state.dayCount,
        blendFrom: blend.from,
        blendTo: blend.to,
        blendAlpha: blend.alpha,
        skyLuminance: blend.luminance,
        exposure: lighting.exposure,
        netLuminance: blend.luminance * lighting.exposure,
        sunElevationDegrees: (state.sunElevation * 180) / Math.PI,
        sunAzimuthDegrees: azimuthOf(state.sunDirection),
        sunIntensity: lighting.sunIntensity,
        moonIntensity: state.moonIntensity,
        moonIsKeyLight: derived.moonIsKeyLight,
        nightFactor: derived.nightFactor,
        windowLitFraction: derived.windowLitFraction,
        streetLightsOn: lighting.streetLightsOn,
        shadowRadius: lighting.shadowRadius,
        fogDensity: lighting.fogDensity,
        fogColor: `#${lighting.fogColor.getHexString()}`,
        ambientColor: `#${lighting.ambientColor.getHexString()}`,
        groundColor: `#${lighting.groundColor.getHexString()}`,
        sunColor: `#${lighting.sunColor.getHexString()}`,
        hasMeasuredEnvironment: this.dayNight.hasMeasuredEnvironment,
      },
      progression: {
        rank: formatRank(rank),
        heroClass: rank.heroClass,
        rankNumber: rank.rank,
        points: rank.points,
        reputation: progression.state.reputation,
        boredom: this.coordinator.boredom.boredom,
        rankGainMultiplier: this.coordinator.boredom.rankGainMultiplier,
        funFightsAvailable: this.coordinator.boredom.funFightsAvailable,
        killsTotal: Object.values(kills).reduce((a, b) => a + b, 0),
        civiliansSaved: progression.state.civiliansSaved,
        civiliansLost: progression.state.civiliansLost,
        propertyDamage: progression.state.propertyDamage,
        witnesses: this.coordinator.witnesses.size,
        genosRank: formatRank(genos),
        genosSeatsAbove: rankGap(genos, rank),
        questCounts,
      },
      problems: this.problems,
    };
  }

  /**
   * How many meshes the two lit materials actually cover.
   *
   * The design claim is "one uniform write lights every lamp and window in the
   * city, with no traversal and no per-object state". Two materials over a few
   * hundred meshes is that claim as a number.
   */
  private countLitMeshes(): number {
    const lit = new Set<THREE.Material>([
      ...this.build.lampMaterials,
      ...this.build.windowMaterials,
    ]);
    let count = 0;
    this.build.root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (materials.some((material) => material && lit.has(material))) count++;
    });
    return count;
  }

  /** Everything the report wants that is not per-frame. */
  meta(): Record<string, unknown> {
    return {
      questCatalogue: QUEST_DEFS.map((def) => ({
        id: def.id,
        title: def.title,
        threatTier: def.threatTier,
        requiredClass: def.requiredClass ?? null,
        rewardPoints: def.rewardPoints,
        timeLimitSeconds: def.timeLimitSeconds ?? null,
        objectives: def.objectives.map((o) => `${o.kind}:${o.required}`),
        isBoss: def.rules?.isBoss ?? false,
        errand: def.rules?.errand ?? false,
        conflictsWith: def.rules?.conflictsWith ?? [],
      })),
      shotTimes: SHOT_TIMES,
      canvas: { width: this.canvas.width, height: this.canvas.height },
    };
  }

  renderPanel(): void {
    const snapshot = this.snapshot();
    const banner = document.getElementById('banner');
    if (banner) {
      const label = SHOT_TIMES.find((s) => Math.abs(s.t - snapshot.sky.timeOfDay) < 1e-4)?.label;
      banner.textContent = `${label ?? clockString(snapshot.sky.timeOfDay)} — ${snapshot.sky.phase}`;
    }

    const stats = document.getElementById('stats');
    if (!stats) return;
    const sky = snapshot.sky;
    const p = snapshot.progression;
    stats.innerHTML = [
      section('Clock', [
        ['time', clockString(sky.timeOfDay)],
        ['phase', sky.phase],
        ['sky blend', `${sky.blendFrom} -> ${sky.blendTo} ${sky.blendAlpha.toFixed(2)}`],
      ]),
      section('Exposure normalisation', [
        ['sky luminance', sky.skyLuminance.toFixed(4)],
        ['exposure', sky.exposure.toFixed(3)],
        ['net (lum x exp)', sky.netLuminance.toFixed(4)],
        ['measured SH', sky.hasMeasuredEnvironment ? 'yes' : 'NO — neutral fallback'],
        ...snapshot.normalisation.map(
          (row) => [`  ${row.sky} mean`, `${row.meanLuminance.toFixed(3)} -> x${row.scale.toFixed(3)}`] as [string, string]
        ),
      ]),
      section('Sun / moon', [
        ['sun elevation', `${sky.sunElevationDegrees.toFixed(1)} deg`],
        ['sun azimuth', `${sky.sunAzimuthDegrees.toFixed(1)} deg`],
        ['sun intensity', sky.sunIntensity.toFixed(3)],
        ['moon intensity', sky.moonIntensity.toFixed(3)],
        ['key light', sky.moonIsKeyLight ? 'moon' : 'sun'],
        ['shadow radius', `${sky.shadowRadius.toFixed(0)} m`],
      ]),
      section('Night', [
        ['night factor', sky.nightFactor.toFixed(2)],
        ['street lights', sky.streetLightsOn ? 'on' : 'off'],
        ['windows lit', `${(sky.windowLitFraction * 100).toFixed(0)}%`],
        ['fog', `${sky.fogColor} @ ${sky.fogDensity.toFixed(4)}`],
        ['ambient', sky.ambientColor],
      ]),
      section('Environment', [
        ['IBL mode', snapshot.iblMode],
        ['skies loaded', snapshot.skiesLoaded.join(', ') || 'none'],
        ['radiance', `${snapshot.radianceResolution}px, ${snapshot.radianceRebuilds} rebuilds`],
        ['env VRAM', `${(snapshot.environmentGpuBytes / 1048576).toFixed(2)} MB`],
        ['lit materials', `${snapshot.litMaterials} over ${snapshot.litMeshes} meshes`],
      ]),
      section('Hero Association', [
        ['rank', p.rank],
        ['points', p.points.toFixed(1)],
        ['reputation', p.reputation.toFixed(1)],
        ['witnesses', String(p.witnesses)],
        ['kills (no rank value)', String(p.killsTotal)],
        ['civilians saved', String(p.civiliansSaved)],
        ['Genos', `${p.genosRank} (+${p.genosSeatsAbove})`],
      ]),
      section('Boredom', [
        ['value', p.boredom.toFixed(3)],
        ['rank gain', `x${p.rankGainMultiplier.toFixed(3)}`],
        ['fun fights', p.funFightsAvailable ? 'available' : 'LOCKED'],
      ]),
      section(
        'Quests',
        Object.entries(p.questCounts).map(([key, value]) => [key, String(value)] as [string, string])
      ),
      snapshot.problems.length > 0
        ? `<h2>Problems</h2><div class="bad">${snapshot.problems.join('<br>')}</div>`
        : '',
    ].join('');
  }
}

function section(title: string, rows: readonly (readonly [string, string])[]): string {
  const body = rows
    .map(([key, value]) => `<tr><td class="k">${key}</td><td class="v">${value}</td></tr>`)
    .join('');
  return `<h2>${title}</h2><table>${body}</table>`;
}

function clockString(t: number): string {
  const total = ((t % 1) + 1) % 1;
  const hours = Math.floor(total * 24);
  const minutes = Math.floor((total * 24 - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Compass azimuth of a LIGHT DIRECTION (which points away from the body). */
function azimuthOf(direction: THREE.Vector3): number {
  const degrees = (Math.atan2(-direction.x, direction.z) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

declare global {
  interface Window {
    __PROGRESSION_HARNESS__?: {
      ready: boolean;
      snapshot(): IHarnessSnapshot;
      meta(): Record<string, unknown>;
      setTimeOfDay(t: number): void;
      step(dt?: number): void;
      settle(frames: number): void;
      runScenarios(): readonly IScenarioResult[];
      runSaveRoundTrip(): Promise<ISaveRoundTripResult>;
      shotTimes(): typeof SHOT_TIMES;
    };
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement | null;
if (canvas) {
  const harness = new ProgressionHarness(canvas);

  const api = {
    ready: false,
    snapshot: () => harness.snapshot(),
    meta: () => harness.meta(),
    setTimeOfDay: (t: number) => {
      harness.setTimeOfDay(t);
      harness.renderOnce();
      harness.renderPanel();
    },
    step: (dt = 1 / 60) => {
      harness.step(dt);
      harness.renderPanel();
    },
    settle: (frames: number) => {
      for (let i = 0; i < frames; i++) harness.renderOnce();
      harness.renderPanel();
    },
    runScenarios: () => runScenarios(),
    runSaveRoundTrip: () => runSaveRoundTrip(),
    shotTimes: () => SHOT_TIMES,
  };
  window.__PROGRESSION_HARNESS__ = api;

  // `?ibl=sh9` selects the MOBILE path: baked SH blended analytically into a
  // LightProbe plus a 32 px specular-only probe. Verified separately, because
  // it is the path that ships on phones and it reaches the same normalisation
  // by a completely different route — a bug in one would not show in the other.
  const requestedMode =
    new URLSearchParams(window.location.search).get('ibl') === 'sh9' ? 'sh9' : 'pmrem';

  void harness.loadAssets('/assets', requestedMode).then(() => {
    harness.setTimeOfDay(0.5);
    harness.renderOnce();
    harness.renderPanel();
    api.ready = true;
  });

  const loop = (): void => {
    requestAnimationFrame(loop);
  };
  loop();
}
