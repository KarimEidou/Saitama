/**
 * THE ANIMATOR
 *
 * `IAnimator` over a procedural evaluator: clip playback, crossfades, a
 * layered upper body, frame events, and a ragdoll handoff.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT DRIVES THE BONES, AND WHAT THE MIXER IS FOR
 *
 *  `IAnimator` exposes a `THREE.AnimationMixer`, and this one is real: every
 *  slot can be baked into a genuine `THREE.AnimationClip` on demand
 *  (`animationClip()`), registered on the mixer, and used by any three.js tool
 *  that expects ordinary animation data. It is advanced every frame, so an
 *  action a caller creates on it plays normally.
 *
 *  But the bones are driven by the PROCEDURAL evaluator, not the mixer, and
 *  the reason is foot planting. A baked clip is a fixed stride at a fixed
 *  cadence; matching it to a changing ground speed means time-warping it, and
 *  time-warping a clip cannot fix a stride that is the wrong LENGTH. The
 *  generator produces the right stride directly, so the mixer path would be
 *  strictly worse for the thing this system is judged on. Baking exists for
 *  interop; generation exists for correctness. Both are honest about which.
 *
 *  LOCOMOTION IS NOT A CLIP. `play('walk')` and `play('run')` select a STYLE;
 *  the gait itself comes from `setLocomotion({ speed })`. Once a caller drives
 *  speed, the base slot is chosen from the solved gait, so walk → jog → run is
 *  a continuous parameter sweep rather than a crossfade between three clips
 *  that disagree about where the feet are. `current` reports the slot the
 *  gait actually resolved to, which is what a state machine wants to read.
 *
 *  LAYERING. The upper body is a masked overlay with a feathered spine, so
 *  Saitama can punch at a dead run: the legs stay on the locomotion solver and
 *  keep their world-locked plants, while the arms and chest take the strike.
 * ══════════════════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';
import type { BoneName, ClipName, IAnimator, IClipOptions, SocketBone } from '@/types';
import { clamp01, createLogger, createRng } from '@/util';
import {
  clipDuration,
  clipSpeed,
  defaultClipParams,
  findClip,
  hasClip,
  CLIP_LIBRARY,
  type ClipEntry,
} from './clips';
import { sampleClip, toAnimationClip } from './bake';
import { LocomotionSolver } from './locomotion';
import {
  applyPose,
  blendPose,
  blendPoseMasked,
  copyPose,
  createPose,
  lowerBodyMask,
  poseToModelMatrices,
  upperBodyMask,
} from './pose';
import { resolveRig } from './rig';
import type {
  AnimEvent,
  AnimEventListener,
  AnimRig,
  BoneMask,
  ClipParams,
  ClipVariant,
  GaitSolution,
  LocomotionInput,
  LocomotionReport,
  Pose,
  RagdollHandoff,
  RigLike,
} from './types';

const log = createLogger('anim');

/** Every slot the library covers. All seventeen; nothing degrades to idle. */
const ALL_SLOTS: readonly ClipName[] = [
  'idle',
  'walk',
  'run',
  'sprint',
  'jump',
  'fall',
  'land',
  'attack',
  'heavyAttack',
  'block',
  'dodge',
  'hit',
  'stagger',
  'death',
  'flee',
  'taunt',
  'special',
];

/** Slots the locomotion solver owns. */
const LOCOMOTIVE: ReadonlySet<ClipName> = new Set<ClipName>([
  'idle',
  'walk',
  'run',
  'sprint',
  'flee',
]);

/** Construction options. */
export interface AnimatorOptions {
  /** Per-slot clip flavour. `{ idle: 'bored' }` gives Saitama his slouch. */
  readonly variants?: Partial<Record<ClipName, ClipVariant>>;
  /** Deterministic seed for per-instance phase and vigour jitter. */
  readonly seed?: number;
  /** Starting gait phase, 0..1. Spread these across a crowd. */
  readonly phase?: number;
  /** Initial slot. Defaults to `idle`. */
  readonly initial?: ClipName;
}

interface LayerState {
  slot: ClipName;
  variant: ClipVariant;
  entry: ClipEntry;
  /** Elapsed seconds in the clip. */
  time: number;
  timeScale: number;
  loop: boolean;
  pingpong: boolean;
  clampWhenFinished: boolean;
  weight: number;
  finished: boolean;
  /** Normalised time last frame, for marker crossing detection. */
  lastPhase: number;
  /** Wall-clock seconds this state has existed, for one-shot bookkeeping. */
  age: number;
}

interface Overlay {
  state: LayerState;
  mask: BoneMask;
  /** Current blended-in weight. */
  level: number;
  /** Target weight; 0 means fading out and then removal. */
  target: number;
  fadeRate: number;
}

/* -------------------------------------------------------------------------- */
/* Animator                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The concrete animator. Satisfies `IAnimator` and adds the procedural
 * controls (`setLocomotion`, `params`, `handoffToRagdoll`) that gameplay needs
 * but that the shared contract cannot name.
 */
export class ProceduralAnimator implements IAnimator {
  readonly mixer: THREE.AnimationMixer;
  readonly rig: AnimRig;
  readonly solver: LocomotionSolver;
  /** Live tuning: boredom, alertness, per-instance jitter. */
  readonly params: ClipParams;

  timeScale = 1;

  private readonly variants: Partial<Record<ClipName, ClipVariant>>;
  private readonly upperMask: BoneMask;
  private readonly lowerMask: BoneMask;
  private readonly output: Pose;
  private readonly scratchA: Pose;
  private readonly scratchB: Pose;
  /** Dedicated mask temporary. Never aliases A or B; see `evaluate`. */
  private readonly scratchMask: Pose;
  private readonly locoPose: Pose;
  private readonly overlays = new Map<ClipName, Overlay>();
  private readonly finishListeners = new Set<(clip: ClipName) => void>();
  private readonly eventListeners = new Set<AnimEventListener>();
  private readonly bakedClips = new Map<string, THREE.AnimationClip>();
  private readonly modelMatrices: THREE.Matrix4[] = [];
  private readonly prevBonePositions: Float32Array;

  private base: LayerState;
  private previous: LayerState | undefined;
  private fade = 1;
  private fadeRate = 0;
  /** What the caller last asked for on the base layer. */
  private request: ClipName;
  private locomotion: LocomotionInput = { speed: 0 };
  private speedDriven = false;
  private lastReport: LocomotionReport | undefined;
  private rootExternal = false;
  private ragdoll: { data: RagdollHandoff; elapsed: number } | undefined;
  private disposed = false;

  constructor(source: RigLike, root: THREE.Object3D, options: AnimatorOptions = {}) {
    this.rig = resolveRig(source);
    this.mixer = new THREE.AnimationMixer(root);
    this.variants = { ...options.variants };
    this.params = defaultClipParams();

    const rng = createRng(options.seed ?? 0).derive('anim');
    // Crowd de-synchronisation happens here, not in the shader: two civilians
    // built from the same seed must animate identically, and two built from
    // different seeds must not breathe in unison.
    this.params.phaseOffset = options.seed === undefined ? 0 : rng.next();
    this.params.vigour = options.seed === undefined ? 1 : rng.range(0.9, 1.12);

    this.upperMask = upperBodyMask(this.rig);
    this.lowerMask = lowerBodyMask(this.rig);
    this.output = createPose(this.rig.boneCount);
    this.scratchA = createPose(this.rig.boneCount);
    this.scratchB = createPose(this.rig.boneCount);
    this.scratchMask = createPose(this.rig.boneCount);
    this.locoPose = createPose(this.rig.boneCount);
    this.prevBonePositions = new Float32Array(this.rig.boneCount * 3);
    for (let i = 0; i < this.rig.boneCount; i++) this.modelMatrices.push(new THREE.Matrix4());

    this.solver = new LocomotionSolver(this.rig, {
      phase: options.phase ?? (options.seed === undefined ? 0 : rng.next()),
      vigour: this.params.vigour,
    });

    this.request = options.initial ?? 'idle';
    this.base = this.makeState(this.request, {});
  }

  /* ------------------------------------------------------------------ */
  /* IAnimator                                                          */
  /* ------------------------------------------------------------------ */

  get current(): ClipName | undefined {
    return this.base.slot;
  }

  get available(): readonly ClipName[] {
    return ALL_SLOTS;
  }

  has(clip: ClipName): boolean {
    return hasClip(clip, this.variants[clip]);
  }

  /**
   * Play a slot on the base layer.
   *
   * Re-playing a looping slot that is already current is a no-op, per the
   * contract — otherwise every frame of a state machine that calls
   * `play('walk')` unconditionally would restart the walk cycle and the feet
   * would never leave the first frame of stance.
   */
  play(clip: ClipName, options: IClipOptions = {}): void {
    const entry = this.resolve(clip);
    const looping = (options.loop ?? (entry.def.loop ? 'repeat' : 'once')) !== 'once';
    if (this.request === clip && looping && this.previous === undefined) {
      if (options.timeScale !== undefined) this.base.timeScale = options.timeScale;
      return;
    }
    this.request = clip;
    const next = this.makeState(clip, options);
    const fade = options.fade ?? 0.18;
    if (fade > 0) {
      this.previous = this.base;
      this.fade = 0;
      this.fadeRate = 1 / fade;
    } else {
      this.previous = undefined;
      this.fade = 1;
      this.fadeRate = 0;
    }
    this.base = next;
  }

  /** Start (or restart) a masked overlay. Does not disturb the base layer. */
  playAdditive(clip: ClipName, options: IClipOptions = {}): void {
    const state = this.makeState(clip, options);
    const region = state.entry.def.region;
    const mask = region === 'lower' ? this.lowerMask : region === 'full' ? undefined : this.upperMask;
    const fade = options.fade ?? 0.08;
    const existing = this.overlays.get(clip);
    const level = existing?.level ?? 0;
    this.overlays.set(clip, {
      state,
      mask: mask ?? fullMask(this.rig),
      level,
      target: options.weight ?? 1,
      fadeRate: fade > 0 ? 1 / fade : Infinity,
    });
  }

  stopAdditive(clip: ClipName, fade = 0.12): void {
    const overlay = this.overlays.get(clip);
    if (overlay === undefined) return;
    overlay.target = 0;
    overlay.fadeRate = fade > 0 ? 1 / fade : Infinity;
  }

  onFinished(cb: (clip: ClipName) => void): () => void {
    this.finishListeners.add(cb);
    return () => this.finishListeners.delete(cb);
  }

  /** Frame events: footfalls, punch impacts, the ragdoll cue. */
  onEvent(cb: AnimEventListener): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
    this.finishListeners.clear();
    this.eventListeners.clear();
    this.overlays.clear();
    this.bakedClips.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Procedural controls                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Drive the gait from the entity's actual motion.
   *
   * Once called, the base slot is chosen from the solved gait rather than from
   * whatever `play` last requested — the character walks because it is moving
   * at walking speed, not because something decided to play a walk.
   */
  setLocomotion(input: LocomotionInput): void {
    this.locomotion = input;
    this.speedDriven = true;
  }

  /**
   * Place the character's root, so world-space foot locks are correct.
   *
   * Call this every frame from the entity transform when the game owns the
   * movement. When it is never called, the solver integrates its own virtual
   * root from the commanded speed — which is what makes an in-place display,
   * an offline bake and a unit test all work without a world around them.
   */
  setRoot(position: THREE.Vector3, yaw: number): void {
    this.solver.setRoot(position, yaw);
    this.rootExternal = true;
  }

  /** The gait the solver settled on last frame. */
  get gait(): GaitSolution {
    return this.solver.gait;
  }

  /** Last locomotion report: foot phases, plant positions, slip. */
  get locomotionReport(): LocomotionReport | undefined {
    return this.lastReport;
  }

  /** The pose written to the bones last frame. Read-only to callers. */
  get pose(): Pose {
    return this.output;
  }

  /** Model-space matrices for the current pose. Recomputed on demand. */
  computeModelMatrices(): readonly THREE.Matrix4[] {
    return poseToModelMatrices(this.output, this.rig, this.modelMatrices);
  }

  /** World position of a combat socket, from the live bones. */
  socketPosition(bone: SocketBone, out: THREE.Vector3): THREE.Vector3 {
    const index = this.rig.index[bone as BoneName];
    if (index === undefined) return out.set(0, 0, 0);
    return this.rig.bones[index]!.getWorldPosition(out);
  }

  /**
   * A real `THREE.AnimationClip` for a slot, baked on first request.
   *
   * Lazy because baking a locomotive clip simulates several gait cycles, and a
   * crowd of 250 civilians must not pay that at spawn for clips nothing will
   * ever ask for.
   */
  animationClip(slot: ClipName, frames = 24): THREE.AnimationClip {
    const entry = this.resolve(slot);
    const key = `${entry.def.slot}:${entry.def.variant}`;
    const cached = this.bakedClips.get(key);
    if (cached !== undefined) return cached;
    const poses = sampleClip(this.rig, entry, { frames, params: this.params });
    const clip = toAnimationClip(this.rig, key, poses, clipDuration(entry, this.rig));
    this.bakedClips.set(key, clip);
    return clip;
  }

  /* ------------------------------------------------------------------ */
  /* Ragdoll handoff                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Freeze the animated pose and hand it to physics.
   *
   * The physics system blends from `modelMatrices` to its simulated pose over
   * `duration`. Two things make that blend clean, and both are done here: the
   * pose is captured ONCE at the instant of handoff (so it cannot drift under
   * the solver while physics is interpolating toward it), and per-bone
   * velocities are captured with it — a ragdoll started from a pose but zero
   * velocity visibly stalls in mid-air before falling, because it has thrown
   * away everything the character was doing a frame ago.
   */
  handoffToRagdoll(duration = 0.12): RagdollHandoff {
    poseToModelMatrices(this.output, this.rig, this.modelMatrices);
    const matrices = this.modelMatrices.map((m) => m.clone());
    const pose = copyPose(createPose(this.rig.boneCount), this.output);
    const velocities = new Float32Array(this.rig.boneCount * 3);
    const dt = Math.max(1e-4, this.lastDt);
    for (let i = 0; i < this.rig.boneCount; i++) {
      _v0.setFromMatrixPosition(matrices[i]!);
      velocities[i * 3] = (_v0.x - this.prevBonePositions[i * 3]!) / dt;
      velocities[i * 3 + 1] = (_v0.y - this.prevBonePositions[i * 3 + 1]!) / dt;
      velocities[i * 3 + 2] = (_v0.z - this.prevBonePositions[i * 3 + 2]!) / dt;
    }
    const data: RagdollHandoff = {
      modelMatrices: matrices,
      pose,
      blend: 0,
      duration,
      velocities,
    };
    this.ragdoll = { data, elapsed: 0 };
    this.emit({ name: 'ragdoll', clip: this.base.slot, phase: 0, strength: 1, bone: 'Hips' });
    return data;
  }

  /** Current handoff, if one is in progress or complete. */
  get ragdollHandoff(): RagdollHandoff | undefined {
    return this.ragdoll?.data;
  }

  /** True once physics owns the skeleton outright and the animator has let go. */
  get ragdollComplete(): boolean {
    return this.ragdoll !== undefined && this.ragdoll.data.blend >= 1;
  }

  /** Take the skeleton back, e.g. for a get-up. */
  clearRagdoll(): void {
    this.ragdoll = undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Update                                                             */
  /* ------------------------------------------------------------------ */

  private lastDt = 1 / 60;
  private retargetCooldown = 0;

  update(dt: number): void {
    if (this.disposed) return;
    const step = Math.max(0, dt) * this.timeScale;
    this.lastDt = Math.max(1e-4, step);
    // Snapshot LAST frame's bone positions before anything overwrites the
    // output pose. Recording them afterwards would make every velocity zero,
    // and a ragdoll handed a zero-velocity pose visibly stalls in the air
    // before it starts to fall.
    this.recordBonePositions();

    if (this.ragdoll !== undefined) {
      // Hand over and stop writing bones: the physics solver owns them from
      // here, and two writers fighting over a skeleton is a visible jitter.
      this.ragdoll.elapsed += step;
      const blend = clamp01(this.ragdoll.elapsed / Math.max(1e-4, this.ragdoll.data.duration));
      (this.ragdoll.data as { blend: number }).blend = blend;
      this.mixer.update(step);
      return;
    }

    this.retargetCooldown = Math.max(0, this.retargetCooldown - step);
    this.advance(this.base, step);
    if (this.previous !== undefined) {
      this.advance(this.previous, step);
      this.fade = clamp01(this.fade + this.fadeRate * step);
      if (this.fade >= 1) this.previous = undefined;
    }

    // The locomotion solver is stateful and runs EXACTLY once per frame,
    // whatever the layers are doing. Running it per layer would double-advance
    // the gait phase during a crossfade and pop the feet.
    const input = this.resolveLocomotionInput();
    copyPose(this.locoPose, this.rig.rest);
    this.lastReport = this.solver.update(step, input, this.locoPose, !this.rootExternal);
    if (this.speedDriven) this.retargetBaseSlot();

    this.evaluate(this.base, this.scratchA);
    if (this.previous !== undefined) {
      this.evaluate(this.previous, this.scratchB);
      blendPose(this.output, this.scratchB, this.scratchA, this.fade);
    } else {
      copyPose(this.output, this.scratchA);
    }

    for (const [slot, overlay] of this.overlays) {
      this.advance(overlay.state, step);
      const rate = overlay.fadeRate;
      overlay.level =
        rate === Infinity
          ? overlay.target
          : overlay.level + Math.sign(overlay.target - overlay.level) * Math.min(
              Math.abs(overlay.target - overlay.level),
              rate * step
            );
      if (overlay.level <= 0 && overlay.target <= 0) {
        this.overlays.delete(slot);
        continue;
      }
      // A one-shot overlay that has finished releases itself, so gameplay
      // never has to remember to stop a punch.
      if (overlay.state.finished && !overlay.state.loop && overlay.target > 0) {
        overlay.target = 0;
        overlay.fadeRate = 1 / 0.12;
      }
      this.evaluate(overlay.state, this.scratchB);
      blendPoseMasked(this.output, this.scratchB, overlay.level, overlay.mask);
    }

    applyPose(this.output, this.rig);
    this.emitFootfalls();
    this.mixer.update(step);
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private resolve(slot: ClipName): ClipEntry {
    return findClip(slot, this.variants[slot]);
  }

  private makeState(slot: ClipName, options: IClipOptions): LayerState {
    const entry = this.resolve(slot);
    const loopMode = options.loop ?? (entry.def.loop ? 'repeat' : 'once');
    return {
      slot,
      variant: entry.def.variant,
      entry,
      time: options.startAt ?? 0,
      timeScale: options.timeScale ?? 1,
      loop: loopMode !== 'once',
      pingpong: loopMode === 'pingpong',
      clampWhenFinished: options.clampWhenFinished ?? slot === 'death',
      weight: options.weight ?? 1,
      finished: false,
      lastPhase: 0,
      age: 0,
    };
  }

  private advance(state: LayerState, dt: number): void {
    const duration = Math.max(1e-4, clipDuration(state.entry, this.rig));
    const before = state.time / duration;
    state.time += dt * state.timeScale;
    state.age += dt;
    const after = state.time / duration;

    if (!state.loop && after >= 1) {
      state.time = state.clampWhenFinished ? duration : duration;
      state.lastPhase = 1;
      if (!state.finished) {
        state.finished = true;
        // Markers between the last frame and the end still have to fire; a
        // punch whose impact sits at 0.97 must not be swallowed by the frame
        // that finished the clip.
        this.fireMarkers(state, before, 1, false);
        for (const cb of this.finishListeners) {
          try {
            cb(state.slot);
          } catch (error) {
            log.warn('onFinished handler threw', error);
          }
        }
      }
      return;
    }
    this.fireMarkers(state, before, after, state.loop);
    state.lastPhase = after;
  }

  /**
   * Fire every marker crossed between two normalised times.
   *
   * Handles wrap-around AND multiple wraps in one step, because a 4 Hz gait on
   * a frame that hitched to 300 ms crosses a marker more than once and a
   * footstep that silently vanishes on a bad frame is exactly the sort of bug
   * that only shows up on the slowest device you ship to.
   */
  private fireMarkers(state: LayerState, from: number, to: number, loop: boolean): void {
    const markers = state.entry.def.markers;
    if (markers.length === 0) return;
    if (!loop) {
      for (const marker of markers) {
        if (from < marker.at && to >= marker.at) this.emitMarker(state, marker.at, marker);
      }
      return;
    }
    const span = to - from;
    if (span <= 0) return;
    const wraps = Math.floor(to) - Math.floor(from);
    for (const marker of markers) {
      for (let k = 0; k <= wraps; k++) {
        const at = Math.floor(from) + k + marker.at;
        if (at > from && at <= to) this.emitMarker(state, marker.at, marker);
      }
    }
  }

  private emitMarker(
    state: LayerState,
    phase: number,
    marker: { name: AnimEvent['name']; strength?: number; bone?: BoneName }
  ): void {
    const position = marker.bone === undefined ? undefined : _v0.clone();
    if (marker.bone !== undefined) {
      const index = this.rig.index[marker.bone];
      if (index !== undefined) this.rig.bones[index]!.getWorldPosition(position!);
    }
    this.emit({
      name: marker.name,
      clip: state.slot,
      phase,
      strength: marker.strength ?? 1,
      bone: marker.bone,
      position,
    });
  }

  /**
   * Footfalls come from the SOLVER, not from a clip marker.
   *
   * A marker fires at a fixed fraction of a clip; a real footfall happens when
   * the foot touches, which under a changing speed is not the same instant.
   * Taking them from the solver's own touchdown detection is what keeps the
   * footstep audio locked to the visible foot.
   */
  private emitFootfalls(): void {
    const report = this.lastReport;
    if (report === undefined) return;
    const moving = report.solution.activity > 0.05;
    for (const touchdown of this.solver.drainTouchdowns()) {
      // A standing character's feet are "planted" from the first frame, and
      // that initial placement is not a footstep. Draining but not emitting
      // keeps the queue clean without inventing a sound.
      if (!moving) continue;
      const foot = touchdown.side === 'left' ? report.left : report.right;
      this.emit({
        name: 'footfall',
        clip: this.base.slot,
        phase: report.phase,
        foot: touchdown.side,
        strength: touchdown.strength,
        position: foot.plantWorld.clone(),
        bone: touchdown.side === 'left' ? 'LeftFoot' : 'RightFoot',
      });
    }
  }

  private emit(event: AnimEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn(`animation event handler threw on "${event.name}"`, error);
      }
    }
  }

  private resolveLocomotionInput(): LocomotionInput {
    if (this.speedDriven) {
      return this.locomotion.slouch === undefined && this.params.boredom > 0
        ? { ...this.locomotion, slouch: this.params.boredom }
        : this.locomotion;
    }
    // Not speed-driven: `play('run')` means "run at a running pace for this
    // body", expressed in leg lengths per second so a child and a monster both
    // get a run rather than the same metres per second.
    const speed = clipSpeed(this.base.entry, this.rig);
    return { speed, slouch: this.params.boredom };
  }

  /**
   * Re-point the base slot at the gait the solver actually produced.
   *
   * Only when the caller has asked for a locomotive slot — playing `attack` or
   * `death` must not be overridden because the character happens to be moving.
   */
  private retargetBaseSlot(): void {
    if (!LOCOMOTIVE.has(this.request)) return;
    if (this.request === 'flee') return;
    // Hysteresis. Without it, hovering on a gait boundary restarts the style
    // crossfade every frame and the arms never finish moving.
    if (this.retargetCooldown > 0) return;
    const gait = this.solver.gait;
    const slot: ClipName =
      gait.gait === 'stand'
        ? 'idle'
        : gait.gait === 'walk'
          ? 'walk'
          : gait.gait === 'jog'
            ? 'run'
            : gait.normalisedSpeed > 2.4
              ? 'sprint'
              : 'run';
    if (slot === this.base.slot) return;
    this.retargetCooldown = 0.3;
    // Crossfade only matters for the STYLE layer; the gait itself is already
    // continuous, so a short fade is enough and a long one would smear the
    // arm posture across a speed change.
    const next = this.makeState(slot, { fade: 0.15 });
    this.previous = this.base;
    this.fade = 0;
    this.fadeRate = 1 / 0.15;
    this.base = next;
  }

  /** Evaluate one layer state into `out`. */
  private evaluate(state: LayerState, out: Pose): void {
    const entry = state.entry;
    const duration = Math.max(1e-4, clipDuration(entry, this.rig));
    let t = state.time / duration;
    if (state.loop) {
      t = ((t % 1) + 1) % 1;
      if (state.pingpong) {
        const cycle = ((state.time / duration / 2) % 1 + 1) % 1;
        t = cycle < 0.5 ? cycle * 2 : 2 - cycle * 2;
      }
    } else {
      t = clamp01(t);
    }

    // Every layer starts from the solver's output, so a masked clip always has
    // correctly planted legs underneath it even when nothing else is playing.
    copyPose(out, this.locoPose);
    const region = entry.def.region;
    if (entry.def.locomotive || region === 'full') {
      entry.evaluate({ rig: this.rig, params: this.params }, t, out);
      return;
    }
    // Masked clip on a full-body base: evaluate over a copy, then feather in.
    // `scratchMask` is dedicated rather than borrowed, because the crossfade
    // path already holds live poses in both A and B.
    copyPose(this.scratchMask, out);
    entry.evaluate({ rig: this.rig, params: this.params }, t, this.scratchMask);
    blendPoseMasked(out, this.scratchMask, 1, region === 'lower' ? this.lowerMask : this.upperMask);
  }

  private recordBonePositions(): void {
    poseToModelMatrices(this.output, this.rig, this.modelMatrices);
    for (let i = 0; i < this.rig.boneCount; i++) {
      _v0.setFromMatrixPosition(this.modelMatrices[i]!);
      this.prevBonePositions[i * 3] = _v0.x;
      this.prevBonePositions[i * 3 + 1] = _v0.y;
      this.prevBonePositions[i * 3 + 2] = _v0.z;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const _fullMasks = new WeakMap<AnimRig, BoneMask>();

function fullMask(rig: AnimRig): BoneMask {
  let mask = _fullMasks.get(rig);
  if (mask === undefined) {
    mask = new Float32Array(rig.boneCount).fill(1);
    _fullMasks.set(rig, mask);
  }
  return mask;
}

/** Every clip in the library, for bakers that want the lot. */
export function allClips(): readonly ClipEntry[] {
  return CLIP_LIBRARY;
}

const _v0 = new THREE.Vector3();
