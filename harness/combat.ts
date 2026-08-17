/**
 * COMBAT HARNESS — WHAT A PUNCH ACTUALLY RESOLVES AGAINST
 *
 * Draws, over one slice of City Z:
 *
 *   - the spherical sector the serious punch swept, from the same origin,
 *     direction, range and half-angle the resolver was handed;
 *   - every entity, coloured by faction, and struck through when the punch
 *     killed it;
 *   - the buildings the wave engulfed, from the cone-vs-AABB sweep;
 *   - the 1.2 m normal-punch reach, at the same scale, for contrast — the
 *     picture IS the design argument.
 *
 * ── THE TWO CROSS-CHECKS THAT ONLY LIVE HERE ───────────────────────────────
 * `src/gameplay/combat` may not import `src/spatial`, so it cannot check
 * itself against the two things it most needs to agree with. The harness can,
 * and does, at load:
 *
 *   MIRROR PARITY   `combat.sphereInCone` vs `spatial.sphereInCone` over
 *                   200 000 random configurations. They are the same function
 *                   duplicated across a module boundary the architecture
 *                   forbids crossing; if they ever drift, the grid's candidate
 *                   set and the kill test stop agreeing and a monster survives
 *                   a punch that engulfed it.
 *
 *   BROAD-PHASE     the real `DynamicEntityGrid` cone query, adapted to
 *   PARITY          `ICombatBroadPhase`, against combat's brute-force linear
 *                   scan, over a full city population. This is also the
 *                   REFERENCE WIRING for the shipped game: the adapter below
 *                   is exactly what the integration layer should use.
 *
 * Playwright control surface: `window.__COMBAT_HARNESS__`.
 */

import {
  CombatSystem,
  DEFAULT_COMBAT_TUNING,
  LinearScan,
  aabbFromCentre,
  sphereInCone as combatSphereInCone,
  type ICombatBroadPhase,
  type ICombatTarget,
  type IEncounterResult,
  type IMutableVec3,
  type IPunchOutcome,
} from '@/gameplay/combat';
import { DynamicEntityGrid, IndexList, sphereInCone as spatialSphereInCone } from '@/spatial';
import { createInputManager } from '@/ui/input';
import type { EntityId, GameEvent, Vec3 } from '@/types';
import { EventBus, clamp01, createRng } from '@/util';

/* -------------------------------------------------------------------------- */
/* Reference broad-phase adapter — how the game should wire this              */
/* -------------------------------------------------------------------------- */

/**
 * `DynamicEntityGrid` behind the `ICombatBroadPhase` interface.
 *
 * This is the whole of the integration between combat and the spatial index:
 * combat states what it needs, spatial provides the acceleration, and neither
 * one imports the other. Rebuild the grid once per frame from the live entity
 * set, exactly as `entity-grid.ts` documents.
 */
class GridBroadPhase implements ICombatBroadPhase {
  readonly grid = new DynamicEntityGrid(1024);
  private readonly ids: EntityId[] = [];
  private readonly out = new IndexList(1024);

  /** Rebuild from the registry. Once per frame, before any query. */
  rebuild(targets: Iterable<ICombatTarget>): void {
    this.grid.beginFrame();
    this.ids.length = 0;
    for (const target of targets) {
      const slot = this.grid.add(
        target.id,
        target.position.x,
        target.position.y,
        target.position.z,
        target.radius,
        1
      );
      this.ids[slot] = target.id;
    }
    this.grid.build();
  }

  queryCone(
    origin: Vec3,
    direction: Vec3,
    range: number,
    halfAngle: number,
    out: EntityId[]
  ): number {
    out.length = 0;
    this.grid.queryCone(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      range,
      halfAngle,
      this.out
    );
    for (let i = 0; i < this.out.length; i++) out.push(this.ids[this.out.at(i)]!);
    return out.length;
  }

  queryRadius(origin: Vec3, range: number, out: EntityId[]): number {
    out.length = 0;
    this.grid.queryRadius(origin.x, origin.y, origin.z, range, this.out);
    for (let i = 0; i < this.out.length; i++) out.push(this.ids[this.out.at(i)]!);
    return out.length;
  }
}

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

const VIEW_METRES = 240;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const scale = canvas.width / VIEW_METRES;

/** World origin sits a third of the way up the canvas; the punch fires north. */
const ORIGIN_PX = { x: canvas.width * 0.5, y: canvas.height * 0.82 };
const toPx = (x: number, z: number): [number, number] => [
  ORIGIN_PX.x + x * scale,
  ORIGIN_PX.y + z * scale,
];

const bus = new EventBus();
const events: GameEvent[] = [];
bus.onAny((event) => events.push(event));

const attackerPosition = { x: 0, y: 1.4, z: 0 };
const attackerFacing = { x: 0, y: 0.02, z: -1 };

const broadPhase = new GridBroadPhase();

const combat = new CombatSystem({
  bus,
  attacker: {
    id: 'saitama',
    getOrigin: (out: IMutableVec3) => {
      out.x = attackerPosition.x;
      out.y = attackerPosition.y;
      out.z = attackerPosition.z;
    },
    getFacing: (out: IMutableVec3) => {
      out.x = attackerFacing.x;
      out.y = attackerFacing.y;
      out.z = attackerFacing.z;
    },
  },
  broadPhase,
  districtAt: () => 'downtown',
  seed: 'harness',
  boredom: 0.55,
});

const rng = createRng('city-z');

/** Populate a believable street: a boss, monsters, a crowd, allies, frontage. */
function buildScene(): void {
  combat.addTarget({
    id: 'boss-01',
    type: 'monster',
    faction: 'monster',
    position: { x: 4, y: 2, z: -96 },
    radius: 3.2,
    massKg: 4200,
    maxHealth: 250_000,
    threatTier: 'dragon',
    specId: 'deep-sea-king',
    isBoss: true,
    phaseResolved: true,
    rewardPoints: 4000,
    displayName: 'Deep Sea King',
  });

  // A monster wave advancing down the avenue. One of them is already at arm's
  // length, which is what makes the tap screenshot mean anything: the same
  // instant kill, without any of the consequences below.
  combat.addTarget({
    id: 'monster-0',
    type: 'monster',
    faction: 'monster',
    position: { x: 0.2, y: 1, z: -2.2 },
    radius: 1.2,
    massKg: 380,
    maxHealth: 5000,
    threatTier: 'demon',
    specId: 'mosquito-girl',
    rewardPoints: 120,
    displayName: 'Mosquito Girl',
  });
  for (let i = 1; i < 9; i++) {
    combat.addTarget({
      id: `monster-${i}`,
      type: 'monster',
      faction: 'monster',
      position: { x: (i % 2 === 0 ? 1 : -1) * (2 + (i % 3) * 2), y: 1, z: -20 - i * 9 },
      radius: 1.2,
      massKg: 380,
      maxHealth: 5000,
      threatTier: rng.pick(['wolf', 'tiger', 'demon'] as const),
      specId: `mob-${i}`,
      rewardPoints: 40,
      displayName: `Mob ${i}`,
    });
  }

  for (let i = 0; i < 120; i++) {
    const [cx, cz] = rng.insideCircle(105);
    combat.addTarget({
      id: `civ-${i}`,
      type: 'npc',
      faction: 'civilian',
      position: { x: cx, y: 1, z: -Math.abs(cz) - 4 },
      radius: 0.42,
      massKg: 68,
      maxHealth: 30,
      displayName: `Citizen ${i}`,
    });
  }

  const allies: [string, number, number][] = [
    ['mumen-rider', -14, -12],
    ['genos', 9, -20],
    ['tatsumaki', -6, -60],
  ];
  for (const [id, x, z] of allies) {
    combat.addTarget({
      id,
      type: 'hero',
      faction: 'hero',
      position: { x, y: 1, z },
      radius: 0.55,
      massKg: 74,
      maxHealth: 400,
      displayName: id,
    });
  }

  // Two rows of frontage down the street, plus a block behind the shoulder so
  // the picture shows what the cone does NOT take.
  for (let row = 0; row < 6; row++) {
    for (const side of [-1, 1]) {
      combat.addStructure({
        id: `block-${row}-${side > 0 ? 'e' : 'w'}`,
        bounds: aabbFromCentre(side * 30, 14, -18 - row * 32, 15, 14, 12),
        massKg: 780_000,
        district: 'downtown',
      });
    }
  }
  for (let row = 0; row < 5; row++) {
    combat.addStructure({
      id: `tower-${row}`,
      bounds: aabbFromCentre(rng.range(-7, 7), 20, -34 - row * 34, 7, 20, 8),
      massKg: 1_150_000,
      district: 'downtown',
    });
  }
  combat.addStructure({
    id: 'behind-shoulder',
    bounds: aabbFromCentre(0, 10, 26, 22, 10, 12),
    massKg: 500_000,
    district: 'residential',
  });
}

buildScene();
broadPhase.rebuild(combat.targets.values());

/* -------------------------------------------------------------------------- */
/* Cross-checks                                                               */
/* -------------------------------------------------------------------------- */

export interface IMirrorReport {
  readonly samples: number;
  readonly disagreements: number;
  readonly accepted: number;
}

/**
 * `combat.sphereInCone` against `spatial.sphereInCone`.
 *
 * They must agree on EVERY input, because one is a deliberate copy of the
 * other across a module boundary the architecture forbids crossing.
 */
function checkMirror(samples = 200_000): IMirrorReport {
  const stream = createRng('mirror');
  let disagreements = 0;
  let accepted = 0;
  for (let i = 0; i < samples; i++) {
    const range = stream.range(1, 180);
    const halfAngle = stream.range(0.01, Math.PI);
    let dx = stream.range(-1, 1);
    let dy = stream.range(-1, 1);
    let dz = stream.range(-1, 1);
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    const cx = stream.range(-range * 1.3, range * 1.3);
    const cy = stream.range(-range * 1.3, range * 1.3);
    const cz = stream.range(-range * 1.3, range * 1.3);
    const r = stream.range(0, 4);

    const mine = combatSphereInCone(cx, cy, cz, r, dx, dy, dz, range, halfAngle);
    const theirs = spatialSphereInCone(cx, cy, cz, r, dx, dy, dz, range, halfAngle);
    if (mine !== theirs) disagreements++;
    if (mine) accepted++;
  }
  return { samples, disagreements, accepted };
}

export interface IBroadPhaseReport {
  readonly queries: number;
  readonly missedByGrid: number;
  readonly extraFromGrid: number;
  readonly totalHits: number;
}

/**
 * The grid's cone query against combat's linear scan.
 *
 * A broad phase is allowed to OVER-report — the resolver runs the exact narrow
 * phase on everything it is handed. It may never UNDER-report, so
 * `missedByGrid` is the number that has to be zero.
 */
function checkBroadPhase(queries = 3000): IBroadPhaseReport {
  const stream = createRng('broad-phase');
  const reference = new LinearScan(combat.targets);
  const gridOut: EntityId[] = [];
  const bruteOut: EntityId[] = [];
  let missed = 0;
  let extra = 0;
  let total = 0;

  broadPhase.rebuild(combat.targets.values());
  for (let i = 0; i < queries; i++) {
    const origin = {
      x: stream.range(-100, 100),
      y: stream.range(0, 6),
      z: stream.range(-140, 40),
    };
    let dx = stream.range(-1, 1);
    let dy = stream.range(-0.4, 0.4);
    let dz = stream.range(-1, 1);
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    const range = stream.range(1.2, 180);
    const halfAngle = stream.range(0.05, Math.PI);

    broadPhase.queryCone(origin, { x: dx, y: dy, z: dz }, range, halfAngle, gridOut);
    reference.queryCone(origin, { x: dx, y: dy, z: dz }, range, halfAngle, bruteOut);

    const fromGrid = new Set(gridOut);
    total += bruteOut.length;
    for (const id of bruteOut) if (!fromGrid.has(id)) missed++;
    extra += Math.max(0, gridOut.length - bruteOut.length);
  }
  return { queries, missedByGrid: missed, extraFromGrid: extra, totalHits: total };
}

const mirror = checkMirror();
const broadPhaseReport = checkBroadPhase();

/* -------------------------------------------------------------------------- */
/* A stand-in for the destruction workstream                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the destruction system does when it hears `ShockwaveFired`, reduced to
 * the part combat's scoring depends on: sweep the structures the wave reached
 * and release their chunks OVER SEVERAL FRAMES, because a real collapse is
 * staggered to stay inside the debris budget.
 *
 * Combat never calls this, never imports it, and does not know it exists. It
 * only hears `ChunkDetached` — which is the entire point.
 */
class HarnessDestruction {
  private pending: { id: string; mass: number; z: number }[] = [];

  constructor() {
    bus.on('ShockwaveFired', (event) => {
      if (event.punchKind !== 'serious' && event.punchKind !== 'slam') return;
      const swept =
        event.angle >= Math.PI - 1e-6
          ? combat.structures.sweepRadius(event.origin, event.range)
          : combat.structures.sweepCone(event.origin, event.direction, event.range, event.angle);
      for (const structure of swept) {
        for (let i = 0; i < 40; i++) {
          this.pending.push({
            id: structure.id,
            mass: (structure.massKg * 0.22) / 40,
            z: (structure.bounds.minZ + structure.bounds.maxZ) * 0.5,
          });
        }
      }
    });
  }

  /** Release up to twelve pieces. Once per frame. */
  step(): void {
    for (let i = 0; i < 12 && this.pending.length > 0; i++) {
      const piece = this.pending.shift()!;
      bus.emit('ChunkDetached', {
        structureId: piece.id,
        chunkIndex: i,
        position: { x: 0, y: 5, z: piece.z },
        mass: piece.mass,
        impulse: { x: 0, y: 0, z: 0 },
        material: 'concrete',
        collateralCost: piece.mass * 3,
      });
    }
  }

  clear(): void {
    this.pending.length = 0;
  }
}

const destruction = new HarnessDestruction();

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

interface IShotState {
  outcome: IPunchOutcome | undefined;
  charge: number;
  label: string;
}

const shot: IShotState = { outcome: undefined, charge: 1, label: 'idle' };

function drawGround(): void {
  ctx.fillStyle = '#0b0d14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Street grid, so scale is readable and the image has structure even before
  // anything is drawn on top of it.
  ctx.strokeStyle = 'rgba(90, 108, 148, 0.16)';
  ctx.lineWidth = 1;
  for (let m = -VIEW_METRES; m <= VIEW_METRES; m += 20) {
    const [gx] = toPx(m, 0);
    const [, gy] = toPx(0, m);
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, canvas.height);
    ctx.moveTo(0, gy);
    ctx.lineTo(canvas.width, gy);
    ctx.stroke();
  }
}

function drawStructures(hit: ReadonlySet<string>): void {
  for (const structure of combat.structures.values()) {
    const [x0, y0] = toPx(structure.bounds.minX, structure.bounds.minZ);
    const [x1, y1] = toPx(structure.bounds.maxX, structure.bounds.maxZ);
    const taken = hit.has(structure.id);
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
    if (taken) {
      gradient.addColorStop(0, 'rgba(255, 45, 111, 0.85)');
      gradient.addColorStop(1, 'rgba(120, 12, 48, 0.85)');
    } else {
      gradient.addColorStop(0, '#333e5c');
      gradient.addColorStop(1, '#232b42');
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = taken ? 'rgba(255, 130, 170, 0.9)' : 'rgba(120, 140, 185, 0.35)';
    ctx.lineWidth = taken ? 2 : 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
}

/** The spherical sector, drawn from the punch's own numbers. */
function drawCone(
  origin: Vec3,
  direction: Vec3,
  range: number,
  halfAngle: number,
  warm: boolean
): void {
  const heading = Math.atan2(direction.z, direction.x);
  const [ox, oy] = toPx(origin.x, origin.z);
  const radius = range * scale;

  const gradient = ctx.createRadialGradient(ox, oy, 0, ox, oy, radius);
  if (warm) {
    gradient.addColorStop(0, 'rgba(255, 253, 224, 0.95)');
    gradient.addColorStop(0.08, 'rgba(255, 226, 120, 0.72)');
    gradient.addColorStop(0.34, 'rgba(255, 138, 44, 0.42)');
    gradient.addColorStop(0.7, 'rgba(226, 60, 40, 0.22)');
    gradient.addColorStop(1, 'rgba(120, 20, 40, 0.05)');
  } else {
    gradient.addColorStop(0, 'rgba(190, 235, 255, 0.7)');
    gradient.addColorStop(1, 'rgba(40, 90, 140, 0.05)');
  }

  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.arc(ox, oy, radius, heading - halfAngle, heading + halfAngle);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.strokeStyle = warm ? 'rgba(255, 214, 120, 0.85)' : 'rgba(150, 220, 255, 0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // The far cap is SPHERICAL, not flat — draw it as the arc it is.
  ctx.beginPath();
  ctx.arc(ox, oy, radius, heading - halfAngle, heading + halfAngle);
  ctx.strokeStyle = warm ? 'rgba(255, 245, 200, 0.95)' : 'rgba(200, 240, 255, 0.8)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

const FACTION_COLOUR: Record<string, string> = {
  monster: '#ff4fd8',
  civilian: '#56b8ff',
  hero: '#4ade80',
  neutral: '#9aa4bb',
};

function drawEntities(): void {
  for (const target of combat.targets.values()) {
    const [x, y] = toPx(target.position.x, target.position.z);
    const radius = Math.max(3, target.radius * scale);
    const boss = target.isBoss;
    // The dead keep their faction colour, dimmed. Who died matters more than
    // that someone did — thirty dimmed blue dots inside the cone is the whole
    // argument against using it.
    const colour = boss ? '#ff9f43' : FACTION_COLOUR[target.faction]!;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.globalAlpha = target.dead ? 0.4 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (target.dead) {
      ctx.strokeStyle = '#ff5f6d';
      ctx.lineWidth = 2;
      const k = radius + 2.5;
      ctx.beginPath();
      ctx.moveTo(x - k, y - k);
      ctx.lineTo(x + k, y + k);
      ctx.moveTo(x + k, y - k);
      ctx.lineTo(x - k, y + k);
      ctx.stroke();
    } else if (boss) {
      ctx.strokeStyle = '#ffe6b0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawAttacker(): void {
  const [x, y] = toPx(attackerPosition.x, attackerPosition.z);
  // The normal punch's reach, at the same scale as the cone above it. This
  // contrast is the entire design argument, in one picture.
  const heading = Math.atan2(attackerFacing.z, attackerFacing.x);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(
    x,
    y,
    DEFAULT_COMBAT_TUNING.normalReachMetres * scale,
    heading - DEFAULT_COMBAT_TUNING.normalHalfAngleRad,
    heading + DEFAULT_COMBAT_TUNING.normalHalfAngleRad
  );
  ctx.closePath();
  ctx.fillStyle = 'rgba(140, 255, 220, 0.55)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#fdfd96';
  ctx.fill();
  ctx.strokeStyle = '#1a1a10';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawScaleBar(): void {
  const metres = 50;
  const x = 34;
  const y = canvas.height - 34;
  ctx.strokeStyle = '#cfd8e8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + metres * scale, y);
  ctx.moveTo(x, y - 6);
  ctx.lineTo(x, y + 6);
  ctx.moveTo(x + metres * scale, y - 6);
  ctx.lineTo(x + metres * scale, y + 6);
  ctx.stroke();
  ctx.fillStyle = '#cfd8e8';
  ctx.font = '13px ui-monospace, monospace';
  ctx.fillText(`${metres} m`, x + metres * scale * 0.5 - 16, y - 12);
}

function draw(): void {
  drawGround();

  const outcome = shot.outcome;
  const structuresHit = new Set(outcome?.destructiblesHit.map((d) => d.id) ?? []);
  drawStructures(structuresHit);

  if (outcome !== undefined) {
    const punch = outcome.punch;
    const range = punch.shockwave?.range ?? punch.radius;
    const angle = punch.shockwave?.angle ?? punch.halfAngle;
    drawCone(punch.origin, punch.direction, range, angle, punch.kind !== 'normal');
  }

  drawEntities();
  drawAttacker();
  drawScaleBar();

  ctx.fillStyle = '#ffd230';
  ctx.font = 'bold 17px ui-monospace, monospace';
  ctx.fillText(shot.label, 22, 34);
  ctx.fillStyle = '#7f8ca6';
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillText('top-down, north is up, apex at the fist', 22, 54);

  paintPanel();
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

function rows(pairs: [string, string | number, string?][]): string {
  const body = pairs
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="v ${cls ?? ''}">${v}</td></tr>`)
    .join('');
  return `<table>${body}</table>`;
}

const yen = (value: number): string =>
  value >= 1e9
    ? `${(value / 1e9).toFixed(2)}bn`
    : value >= 1e6
      ? `${(value / 1e6).toFixed(1)}m`
      : Math.round(value).toLocaleString('en-GB');

let lastResult: IEncounterResult | undefined;

function paintPanel(): void {
  document.getElementById('verify')!.innerHTML = rows([
    [
      'mirror parity',
      `${mirror.disagreements === 0 ? 'exact' : `${mirror.disagreements} DIFF`} / ${(
        mirror.samples / 1000
      ).toFixed(0)}k`,
      mirror.disagreements === 0 ? 'ok' : 'bad',
    ],
    ['  accepted', mirror.accepted.toLocaleString('en-GB')],
    [
      'grid vs brute',
      broadPhaseReport.missedByGrid === 0
        ? `no misses / ${broadPhaseReport.queries}`
        : `${broadPhaseReport.missedByGrid} MISSED`,
      broadPhaseReport.missedByGrid === 0 ? 'ok' : 'bad',
    ],
    ['  hits compared', broadPhaseReport.totalHits.toLocaleString('en-GB')],
    ['  grid over-report', broadPhaseReport.extraFromGrid],
  ]);

  const outcome = shot.outcome;
  const diagnostics = combat.diagnostics();
  document.getElementById('punch')!.innerHTML = rows([
    ['verb', outcome?.punch.kind ?? '—'],
    ['intent', outcome?.punch.intent ?? '—'],
    ['charge', shot.charge.toFixed(2)],
    [
      'cone length',
      `${(outcome?.punch.shockwave?.range ?? outcome?.punch.radius ?? 0).toFixed(1)} m`,
    ],
    [
      'half angle',
      `${(((outcome?.punch.halfAngle ?? 0) * 180) / Math.PI).toFixed(1)} deg`,
    ],
    ['power', (outcome?.punch.power ?? 0).toExponential(2)],
    ['killed', outcome?.kills ?? 0, (outcome?.kills ?? 0) > 0 ? 'warn' : ''],
    [
      'civilians killed',
      outcome?.civiliansKilled ?? 0,
      (outcome?.civiliansKilled ?? 0) > 0 ? 'bad' : 'ok',
    ],
    ['buildings taken', outcome?.destructiblesHit.length ?? 0],
    ['forecast', `${yen(diagnostics.chargeForecastYen)} yen`],
    ['camera shake', (outcome?.cameraShake ?? 0).toFixed(3)],
  ]);

  const boredom = combat.boredom;
  (document.getElementById('boredom-bar') as HTMLElement).style.width = `${(
    boredom * 100
  ).toFixed(1)}%`;
  const recent = combat.boredomMeter.log.slice(-4);
  document.getElementById('boredom')!.innerHTML =
    rows([
      ['value', boredom.toFixed(3), boredom > 0.8 ? 'bad' : boredom < 0.4 ? 'ok' : 'warn'],
      ['chain', diagnostics.chainLength],
    ]) +
    `<pre>${
      recent.length === 0
        ? 'no movement yet'
        : recent
            .map((e) => `${e.delta >= 0 ? '+' : ''}${e.delta.toFixed(3)}  ${e.reason}`)
            .join('\n')
    }</pre>`;

  document.getElementById('encounter')!.innerHTML = rows(
    lastResult === undefined
      ? [['status', combat.encounters.active ? 'in progress' : 'none']]
      : [
          ['time to kill', `${lastResult.timeToKill.toFixed(2)} s`],
          ['kills', lastResult.kills],
          ['civilians lost', lastResult.civiliansLost, lastResult.civiliansLost > 0 ? 'bad' : 'ok'],
          ['civilians saved', lastResult.civiliansSaved],
          ['allies saved', lastResult.alliesSaved],
          ['debris', `${Math.round(lastResult.debrisMassKg).toLocaleString('en-GB')} kg`],
          ['property damage', `${yen(lastResult.propertyDamageYen)} yen`, 'bad'],
          ['witnessed', lastResult.witnessed],
          ['normal punches', lastResult.normalPunches],
          ['serious punches', lastResult.seriousPunches],
          ['boredom', `${lastResult.boredomBefore.toFixed(2)} to ${lastResult.boredomAfter.toFixed(2)}`],
        ]
  );
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/** Restore the scene without rebuilding it, so shots are comparable. */
function reset(): void {
  for (const target of combat.targets.values()) {
    target.dead = false;
    target.health = target.maxHealth;
  }
  broadPhase.rebuild(combat.targets.values());
  destruction.clear();
  events.length = 0;
  shot.outcome = undefined;
  shot.label = 'idle';
  lastResult = undefined;
  draw();
}

function fireSerious(charge: number): IPunchOutcome {
  broadPhase.rebuild(combat.targets.values());
  shot.charge = clamp01(charge);
  shot.outcome = combat.seriousPunch(shot.charge);
  shot.label = `SERIOUS PUNCH — charge ${shot.charge.toFixed(2)}`;
  draw();
  return shot.outcome;
}

function fireNormal(): IPunchOutcome {
  broadPhase.rebuild(combat.targets.values());
  shot.outcome = combat.normalPunch();
  shot.charge = 0;
  shot.label = 'NORMAL PUNCH — 1.2 m';
  draw();
  return shot.outcome;
}

function fireSlam(fallHeight: number): IPunchOutcome {
  broadPhase.rebuild(combat.targets.values());
  shot.outcome = combat.groundSlam(attackerPosition, Math.sqrt(2 * 22 * fallHeight), fallHeight);
  shot.charge = 0;
  shot.label = `GROUND SLAM — ${fallHeight} m fall`;
  draw();
  return shot.outcome;
}

/**
 * A whole fight, driven through the synthetic input API rather than by calling
 * the verbs — the same door Playwright and the unit tests use.
 */
function runScriptedEncounter(): IEncounterResult | undefined {
  reset();
  const input = createInputManager({ headless: true, exposeTestBridge: false });
  input.syntheticEnabled = true;

  const hostiles = combat.targets
    .all()
    .filter((t) => t.faction === 'monster')
    .map((t) => t.id);
  const allies = combat.targets
    .all()
    .filter((t) => t.faction === 'hero')
    .map((t) => t.id);
  combat.beginEncounter({ encounterId: 'harness', hostileIds: hostiles, allyIds: allies, time: 0 });

  input.synthetic.queue([
    { frames: 24, label: 'close in' },
    { frames: 1, taps: ['punch'], label: 'tap' },
    { frames: 20, label: 'wait' },
    { frames: 78, patch: { buttons: { punch: true } }, label: 'charge' },
    { frames: 1, patch: { buttons: { punch: false } }, label: 'release' },
    { frames: 240, label: 'settle' },
  ]);

  const dt = 1 / 60;
  for (let frame = 0; frame <= 380; frame++) {
    const time = frame * dt;
    bus.setFrame(frame, time);
    broadPhase.rebuild(combat.targets.values());
    combat.update(input.poll(frame, time), dt, time);
    destruction.step();
    // Keep the drawing showing whatever the input last produced.
    const latest = combat.lastPunch;
    if (latest !== undefined && latest !== shot.outcome) {
      shot.outcome = latest;
      shot.charge = latest.punch.charge ?? 0;
    }
  }

  input.dispose();
  lastResult = combat.lastResult;
  shot.label = 'SCRIPTED ENCOUNTER';
  draw();
  return lastResult;
}

/* -------------------------------------------------------------------------- */
/* Control surface                                                            */
/* -------------------------------------------------------------------------- */

export interface ICombatHarnessSnapshot {
  readonly mirror: IMirrorReport;
  readonly broadPhase: IBroadPhaseReport;
  readonly targets: number;
  readonly structures: number;
  readonly punch:
    | {
        readonly kind: string;
        readonly intent: string;
        readonly power: number;
        readonly rangeMetres: number;
        readonly halfAngleDeg: number;
        readonly kills: number;
        readonly civiliansKilled: number;
        readonly structuresHit: number;
        readonly forecastYen: number;
      }
    | undefined;
  readonly eventTypes: string[];
  readonly punchKinds: string[];
  readonly encounterEndedCollateral: number | undefined;
  readonly boredom: number;
  readonly result: IEncounterResult | undefined;
}

export interface ICombatHarness {
  reset(): void;
  fireNormal(): void;
  fireSerious(charge: number): void;
  fireSlam(fallHeight: number): void;
  runScriptedEncounter(): IEncounterResult | undefined;
  snapshot(): ICombatHarnessSnapshot;
}

declare global {
  interface Window {
    __COMBAT_HARNESS__?: ICombatHarness;
    __COMBAT_READY__?: boolean;
  }
}

const harness: ICombatHarness = {
  reset,
  fireNormal: () => void fireNormal(),
  fireSerious: (charge: number) => void fireSerious(charge),
  fireSlam: (fallHeight: number) => void fireSlam(fallHeight),
  runScriptedEncounter,
  snapshot(): ICombatHarnessSnapshot {
    const outcome = shot.outcome;
    return {
      mirror,
      broadPhase: broadPhaseReport,
      targets: combat.targets.size,
      structures: combat.structures.size,
      punch:
        outcome === undefined
          ? undefined
          : {
              kind: outcome.punch.kind,
              intent: outcome.punch.intent,
              power: outcome.punch.power,
              rangeMetres: outcome.punch.shockwave?.range ?? outcome.punch.radius,
              halfAngleDeg: (outcome.punch.halfAngle * 180) / Math.PI,
              kills: outcome.kills,
              civiliansKilled: outcome.civiliansKilled,
              structuresHit: outcome.destructiblesHit.length,
              forecastYen: outcome.collateralCost,
            },
      eventTypes: events.map((event) => event.type),
      punchKinds: events
        .filter((event) => event.type === 'ShockwaveFired')
        .map((event) => (event as { punchKind: string }).punchKind),
      encounterEndedCollateral: events
        .filter((event) => event.type === 'EncounterEnded')
        .map((event) => (event as { collateralCost: number }).collateralCost)[0],
      boredom: combat.boredom,
      result: lastResult,
    };
  },
};

window.__COMBAT_HARNESS__ = harness;
draw();
window.__COMBAT_READY__ = true;
