/**
 * The feel layer: acceleration curves, air control, coyote time, jump
 * buffering, variable jump height, landing recovery and determinism.
 *
 * Everything runs against `StubCharacterController`, which reproduces the
 * observable semantics of the real kinematic controller (asymmetric gravity,
 * `jump()` that only raises, solved-velocity read-back) without a wasm boot.
 * The real integration is measured in `harness/player.*`.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '@/util';
import type { IAnimator, ClipName } from '@/types';
import { PlayerController } from '../player-controller';
import { DEFAULT_LOCOMOTION_TUNING, apexForLaunchSpeed, heldJumpApex } from '../tuning';
import { InputScript, StubCharacterController, type IStubControllerOptions } from './stubs';

const DT = 1 / 60;
const L = DEFAULT_LOCOMOTION_TUNING;

interface Harness {
  readonly stub: StubCharacterController;
  readonly player: PlayerController;
  readonly input: InputScript;
  /** Advance `frames` frames, optionally observing each one. */
  run(frames: number, observe?: (frame: number) => void): void;
}

function setup(
  options: IStubControllerOptions = {},
  playerOptions: { animator?: IAnimator | null; bus?: EventBus } = {}
): Harness {
  const stub = new StubCharacterController(options);
  const input = new InputScript();
  const player = new PlayerController({
    controller: stub,
    animator: playerOptions.animator ?? null,
    bus: playerOptions.bus,
  });
  return {
    stub,
    player,
    input,
    run(frames: number, observe?: (frame: number) => void): void {
      for (let i = 0; i < frames; i++) {
        player.update(input.poll(DT), DT);
        // The stub applies the move synchronously, so "stepping the world" is
        // a no-op here; postStep() is still the contract-correct call site.
        player.postStep();
        observe?.(i);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Ground speed                                                               */
/* -------------------------------------------------------------------------- */

describe('ground speed', () => {
  it('reaches run speed and stops there', () => {
    const h = setup();
    h.input.setMove(0, 1);
    h.run(180);
    expect(h.player.speed).toBeCloseTo(L.runSpeed, 3);
    expect(h.player.state).toBe('run');
  });

  it('reaches dash speed while the dash action is held', () => {
    const h = setup();
    h.input.setMove(0, 1).press('sprint');
    h.run(180);
    expect(h.player.speed).toBeCloseTo(L.dashSpeed, 3);
    expect(h.player.state).toBe('dash');
  });

  it('walks on a partially deflected stick', () => {
    const h = setup();
    h.input.setMove(0, 0.3);
    h.run(120);
    expect(h.player.speed).toBeLessThan(L.runSpeedThreshold);
    expect(h.player.speed).toBeGreaterThan(L.idleSpeedThreshold);
    expect(h.player.state).toBe('walk');
  });

  it('reaches 90% of run speed inside a fifth of a second', () => {
    const h = setup();
    h.input.setMove(0, 1);
    let frames = -1;
    h.run(120, (i) => {
      if (frames < 0 && h.player.speed >= L.runSpeed * 0.9) frames = i + 1;
    });
    expect(frames).toBeGreaterThan(0);
    expect(frames * DT).toBeLessThan(0.2);
  });

  it('comes to a stop faster than it accelerated', () => {
    const h = setup();
    h.input.setMove(0, 1);
    h.run(120);
    h.input.setMove(0, 0);
    let stopFrames = -1;
    h.run(120, (i) => {
      if (stopFrames < 0 && h.player.speed <= L.idleSpeedThreshold) stopFrames = i + 1;
    });
    expect(stopFrames).toBeGreaterThan(0);
    expect(stopFrames * DT).toBeLessThan(0.2);
    expect(h.player.state).toBe('idle');
  });

  it('pivots on a reversal instead of arcing — the turn-brake term', () => {
    const h = setup();
    h.input.setMove(0, 1);
    h.run(120);
    const before = h.player.velocity.clone();
    h.input.setMove(0, -1);
    let flipFrames = -1;
    h.run(120, (i) => {
      if (flipFrames < 0 && h.player.velocity.dot(before) < 0) flipFrames = i + 1;
    });
    // Without the turn brake this takes runSpeed / groundDecel = 145 ms.
    expect(flipFrames).toBeGreaterThan(0);
    expect(flipFrames * DT).toBeLessThan(0.13);
  });

  it('faces the direction it is moving, not the opposite one', () => {
    const h = setup();
    h.input.setMove(0, 1);
    h.run(60);
    // three.js forward is local -Z; the character travels -Z with yaw 0.
    const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      h.player.yaw
    );
    const velocity = h.player.velocity.clone().normalize();
    expect(forward.dot(velocity)).toBeGreaterThan(0.99);
  });
});

/* -------------------------------------------------------------------------- */
/* Walls                                                                      */
/* -------------------------------------------------------------------------- */

describe('blocked movement', () => {
  it('adopts the solved velocity when a wall stops the character', () => {
    const h = setup({ wallX: 3 });
    h.input.setMove(1, 0);
    h.run(120);
    expect(h.stub.position.x).toBeLessThanOrEqual(3 + 1e-9);
    expect(h.player.speed).toBeLessThan(0.5);
    expect(h.player.state).toBe('idle');
  });

  it('ignores a single frame of solver shortfall', () => {
    // Rapier really does return a shortened sweep for one step on flat ground
    // (measured: ratios of 0.71 and 0.45). Reacting to it costs a standing
    // start most of its acceleration, so one bad frame must change nothing.
    const clean = setup();
    clean.input.setMove(0, 1);
    clean.run(11);
    const cleanSpeed = clean.player.speed;

    const noisy = setup();
    noisy.input.setMove(0, 1);
    noisy.run(5);
    // Forge one frame in which the controller reports half the movement.
    const controller = noisy.stub;
    const realVelocity = controller.velocity;
    noisy.player.update(noisy.input.poll(DT), DT);
    realVelocity.set(realVelocity.x * 0.45, realVelocity.y, realVelocity.z * 0.45);
    noisy.player.postStep();
    noisy.run(5);

    expect(noisy.player.speed).toBeCloseTo(cleanSpeed, 6);
  });

  it('still gives way after two consecutive blocked frames', () => {
    const h = setup();
    h.input.setMove(0, 1);
    h.run(60);
    const before = h.player.speed;
    for (let i = 0; i < 2; i++) {
      h.player.update(h.input.poll(DT), DT);
      h.stub.velocity.set(0, h.stub.velocity.y, 0);
      h.player.postStep();
    }
    expect(h.player.speed).toBeLessThan(before * 0.2);
  });
});

describe('ground contact grace', () => {
  it('does not treat a one-frame loss of contact as a landing', () => {
    const h = setup();
    h.input.setMove(0, 1);
    h.run(60);
    expect(h.player.state).toBe('run');
    const landingBefore = h.player.landing;

    h.stub.simulateContactLoss(1);
    h.run(1);
    expect(h.player.isGrounded).toBe(false);
    h.run(4);

    expect(h.player.state).toBe('run');
    expect(h.player.landing).toBe(landingBefore);
    expect(h.player.diagnostics().recoveryRemaining).toBe(0);
  });

  it('still treats a real ledge exit as a fall', () => {
    const h = setup();
    h.input.setMove(0, 1);
    h.run(60);
    h.stub.simulateContactLoss(30);
    h.run(20);
    expect(h.player.state).toBe('fall');
  });
});

/* -------------------------------------------------------------------------- */
/* Jump                                                                       */
/* -------------------------------------------------------------------------- */

describe('jump', () => {
  it('a tap reaches the hop apex and does not crater', () => {
    const h = setup();
    let apex = 0;
    h.input.press('jump');
    h.run(1);
    h.input.release('jump');
    h.run(300, () => {
      apex = Math.max(apex, h.player.heightAboveGround);
    });
    expect(apex).toBeCloseTo(apexForLaunchSpeed(L.hopSpeed), 0);
    expect(h.player.landing?.hard).toBe(false);
  });

  it('a held jump reaches the leap apex and craters', () => {
    const h = setup();
    let apex = 0;
    h.input.press('jump');
    h.run(400, () => {
      apex = Math.max(apex, h.player.heightAboveGround);
    });
    expect(apex).toBeGreaterThan(L.hardLandFallHeightM);
    expect(apex).toBeCloseTo(heldJumpApex(L), 0);
    expect(h.player.landing?.hard).toBe(true);
  });

  it('scales the apex with how long the button was held', () => {
    const apexFor = (holdFrames: number): number => {
      const h = setup();
      let apex = 0;
      h.input.press('jump');
      h.run(holdFrames, () => {
        apex = Math.max(apex, h.player.heightAboveGround);
      });
      h.input.release('jump');
      h.run(300, () => {
        apex = Math.max(apex, h.player.heightAboveGround);
      });
      return apex;
    };
    const tap = apexFor(1);
    const half = apexFor(4);
    const full = apexFor(20);
    expect(half).toBeGreaterThan(tap + 1);
    expect(full).toBeGreaterThan(half + 1);
  });

  it('never double-jumps from one press', () => {
    const h = setup();
    let launches = 0;
    h.player.stateMachine.onEnter('jumpLaunch', () => launches++);
    h.input.press('jump');
    h.run(400);
    // The button is still held on landing, but `pressed` is an EDGE: a held
    // button must not re-arm the buffer.
    expect(launches).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Coyote time                                                                */
/* -------------------------------------------------------------------------- */

describe('coyote time', () => {
  /** Walk off a ledge, wait `delayFrames`, then tap jump. */
  function ledgeJump(delayFrames: number): { jumped: boolean; leftGroundAt: number } {
    const h = setup({ ledgeZ: 3 });
    h.input.setMove(0, -1);
    let leftGroundAt = -1;
    let frame = 0;
    // Run up to the edge.
    for (; frame < 300 && leftGroundAt < 0; frame++) {
      h.run(1);
      if (!h.player.isGrounded) leftGroundAt = frame;
    }
    let jumped = false;
    h.player.stateMachine.onEnter('jumpLaunch', () => {
      jumped = true;
    });
    // Wait, then tap.
    h.run(delayFrames);
    h.input.press('jump');
    h.run(1);
    h.input.release('jump');
    h.run(3);
    return { jumped, leftGroundAt };
  }

  it('accepts a jump inside the window and refuses one outside it', () => {
    // `leftGroundAt` is the frame the ledge exit was OBSERVED; the delay is
    // counted from there, so the accepted count is the window in frames.
    const windowFrames = Math.floor(L.coyoteSeconds / DT);
    expect(ledgeJump(0).jumped).toBe(true);
    expect(ledgeJump(windowFrames - 2).jumped).toBe(true);
    expect(ledgeJump(windowFrames + 4).jumped).toBe(false);
  });

  it('reports the remaining window as it drains', () => {
    const h = setup({ ledgeZ: 3 });
    h.input.setMove(0, -1);
    h.run(1);
    expect(h.player.isGrounded).toBe(true);
    for (let i = 0; i < 300 && h.player.isGrounded; i++) h.run(1);
    expect(h.player.isGrounded).toBe(false);
    const first = h.player.coyoteRemaining;
    h.run(3);
    expect(h.player.coyoteRemaining).toBeLessThan(first);
    h.run(30);
    expect(h.player.coyoteRemaining).toBe(0);
  });

  it('spends the window on the jump so it cannot fire twice', () => {
    const h = setup({ ledgeZ: 3 });
    h.input.setMove(0, -1);
    h.run(1);
    for (let i = 0; i < 300 && h.player.isGrounded; i++) h.run(1);
    let launches = 0;
    h.player.stateMachine.onEnter('jumpLaunch', () => launches++);
    for (let i = 0; i < 6; i++) {
      h.input.press('jump');
      h.run(1);
      h.input.release('jump');
      h.run(1);
    }
    expect(launches).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Jump buffering                                                             */
/* -------------------------------------------------------------------------- */

describe('jump buffering', () => {
  /** Hop, tap jump `beforeFrames` before touchdown, report the delay. */
  function bufferedHop(beforeFrames: number): number {
    // Pass 1: find the landing frame with no second input.
    const probe = setup();
    probe.input.press('jump');
    probe.run(1);
    probe.input.release('jump');
    let landFrame = -1;
    probe.run(300, (i) => {
      if (landFrame < 0 && probe.player.isGrounded && i > 4) landFrame = i;
    });
    expect(landFrame).toBeGreaterThan(0);

    // Pass 2: replay, pressing jump `beforeFrames` before that.
    const h = setup();
    const pressAt = landFrame - beforeFrames;
    let relaunchFrame = -1;
    h.player.stateMachine.onEnter('jumpLaunch', () => {
      /* first launch counted below */
    });
    h.input.press('jump');
    h.run(1);
    h.input.release('jump');
    let launches = 0;
    h.player.stateMachine.onEnter('jumpLaunch', () => {
      launches++;
      if (relaunchFrame < 0) relaunchFrame = currentFrame;
    });
    let currentFrame = 1;
    for (; currentFrame < landFrame + 20; currentFrame++) {
      if (currentFrame === pressAt) h.input.press('jump');
      if (currentFrame === pressAt + 1) h.input.release('jump');
      h.run(1);
    }
    void launches;
    return relaunchFrame < 0 ? -1 : relaunchFrame - landFrame;
  }

  it('fires a jump pressed shortly before touchdown, on touchdown', () => {
    const delay = bufferedHop(6);
    expect(delay).toBeGreaterThanOrEqual(0);
    // One frame of latency: the buffer is tested at the top of the frame after
    // the one that resolved the contact.
    expect(delay).toBeLessThanOrEqual(2);
  });

  it('drops a press that is far too early', () => {
    expect(bufferedHop(40)).toBe(-1);
  });

  it('exposes the remaining buffer, and a teleport grants no free jump', () => {
    const h = setup();
    h.input.setMove(0, 0);
    h.player.setPosition(new THREE.Vector3(0, 30, 0));
    let launches = 0;
    h.player.stateMachine.onEnter('jumpLaunch', () => launches++);
    h.input.press('jump');
    h.run(1);
    h.input.release('jump');
    // Dropped into the air by a teleport: the press is remembered, not spent.
    expect(launches).toBe(0);
    expect(h.player.jumpBufferRemaining).toBeGreaterThan(0);
    h.run(20);
    expect(h.player.jumpBufferRemaining).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Air control                                                                */
/* -------------------------------------------------------------------------- */

describe('air control', () => {
  it('has far less authority in the air than on the ground', () => {
    const measure = (airborne: boolean): number => {
      const h = setup();
      h.input.setMove(0, 1);
      h.run(120);
      if (airborne) {
        h.input.press('jump');
        h.run(20);
        h.input.release('jump');
      }
      const before = h.player.velocity.clone();
      h.input.setMove(0, -1);
      h.run(12);
      return before.distanceTo(h.player.velocity);
    };
    const ground = measure(false);
    const air = measure(true);
    expect(air).toBeGreaterThan(0.5); // it is reduced, not removed
    expect(air).toBeLessThan(ground * 0.5);
  });

  it('preserves a dash-jump’s momentum across the whole arc', () => {
    const h = setup();
    h.input.setMove(0, 1).press('sprint');
    h.run(180);
    const launchSpeed = h.player.speed;
    expect(launchSpeed).toBeCloseTo(L.dashSpeed, 2);

    h.input.press('jump');
    h.run(20);
    h.input.release('jump').release('sprint').setMove(0, 0);

    let minSpeed = Number.POSITIVE_INFINITY;
    let frames = 0;
    while (!h.player.isGrounded && frames < 600) {
      h.run(1);
      frames++;
      if (!h.player.isGrounded) minSpeed = Math.min(minSpeed, h.player.speed);
    }
    expect(frames).toBeGreaterThan(60);
    // Hands entirely off the stick for a ~2 s flight and it still keeps most
    // of what it launched with.
    expect(minSpeed).toBeGreaterThan(launchSpeed * 0.8);
  });
});

/* -------------------------------------------------------------------------- */
/* Landings                                                                   */
/* -------------------------------------------------------------------------- */

describe('landings', () => {
  it('craters above the threshold and reports the fall', () => {
    const h = setup();
    h.player.setPosition(new THREE.Vector3(0, 40, 0));
    h.run(300);
    const landing = h.player.landing;
    expect(landing).toBeDefined();
    expect(landing!.hard).toBe(true);
    expect(landing!.fallHeight).toBeGreaterThan(38);
    expect(landing!.impactSpeed).toBeGreaterThan(30);
    expect(landing!.recoverySeconds).toBeGreaterThan(L.hardLandRecoveryBaseSeconds);
  });

  it('holds the hard-landing state for the whole recovery', () => {
    const h = setup();
    h.player.setPosition(new THREE.Vector3(0, 40, 0));
    let hardFrames = 0;
    h.run(300, () => {
      if (h.player.state === 'hardLand') hardFrames++;
    });
    const expected = h.player.landing!.recoverySeconds;
    expect(hardFrames * DT).toBeGreaterThan(expected - 2 * DT);
    expect(hardFrames * DT).toBeLessThan(expected + 3 * DT);
  });

  it('refuses to cancel a crater into a jump', () => {
    const h = setup();
    h.player.setPosition(new THREE.Vector3(0, 40, 0));
    // Fall until the crater lands.
    for (let i = 0; i < 300 && h.player.state !== 'hardLand'; i++) h.run(1);
    expect(h.player.state).toBe('hardLand');
    let launches = 0;
    h.player.stateMachine.onEnter('jumpLaunch', () => launches++);
    h.input.press('jump');
    h.run(2);
    h.input.release('jump');
    h.run(2);
    expect(launches).toBe(0);
    expect(h.player.state).toBe('hardLand');
  });

  it('plants the feet on a crater but keeps speed through a hop', () => {
    /** Dash, leap (held or tapped), and report speed-after / speed-before. */
    const retention = (holdFrames: number): { ratio: number; hard: boolean } => {
      const h = setup();
      h.input.setMove(0, 1).press('sprint');
      h.run(180);
      h.input.press('jump');
      h.run(holdFrames);
      h.input.release('jump');

      let before = h.player.speed;
      for (let i = 0; i < 600; i++) {
        if (h.player.isGrounded && i > 4) break;
        before = h.player.speed;
        h.run(1);
      }
      return { ratio: h.player.speed / before, hard: h.player.landing?.hard ?? false };
    };

    const crater = retention(30);
    expect(crater.hard).toBe(true);
    expect(crater.ratio).toBeLessThan(0.5);

    const hop = retention(1);
    expect(hop.hard).toBe(false);
    expect(hop.ratio).toBeGreaterThan(0.7);
  });

  it('prefers the physics landing event when a bus is wired in', () => {
    const bus = new EventBus();
    const h = setup({}, { bus });
    h.player.setPosition(new THREE.Vector3(0, 40, 0));
    // The stub does not emit, so stand in for physics: publish just before the
    // controller observes the contact.
    let emitted = false;
    for (let i = 0; i < 400 && h.player.landing === undefined; i++) {
      if (!emitted && h.stub.position.y < 2) {
        emitted = true;
        bus.emit('PlayerLanded', {
          position: { x: 0, y: 0.875, z: 0 },
          impactSpeed: 42,
          fallHeight: 39,
          createsCrater: true,
          intent: 'normal',
        });
      }
      h.run(1);
    }
    expect(h.player.landing?.fromBus).toBe(true);
    expect(h.player.landing?.impactSpeed).toBe(42);
  });
});

/* -------------------------------------------------------------------------- */
/* Animator tolerance                                                         */
/* -------------------------------------------------------------------------- */

describe('animator', () => {
  it('runs with no animator at all', () => {
    const h = setup({}, { animator: null });
    h.input.setMove(0, 1);
    expect(() => h.run(120)).not.toThrow();
  });

  it('drives clips on state changes when one is present', () => {
    const played: ClipName[] = [];
    const animator = {
      mixer: undefined,
      current: undefined,
      available: [],
      play(clip: ClipName): void {
        played.push(clip);
      },
      playAdditive(): void {},
      stopAdditive(): void {},
      has(): boolean {
        return true;
      },
      update(): void {},
      onFinished(): () => void {
        return () => {};
      },
      timeScale: 1,
      dispose(): void {},
    } as unknown as IAnimator;

    const h = setup({}, { animator });
    h.input.setMove(0, 1);
    h.run(120);
    h.input.press('jump');
    h.run(200);
    expect(played[0]).toBe('idle');
    expect(played).toContain('run');
    expect(played).toContain('jump');
    expect(played).toContain('fall');
    expect(played).toContain('land');
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  function scripted(): { position: THREE.Vector3; velocity: THREE.Vector3; yaw: number } {
    const h = setup({ ledgeZ: 40, wallX: 25 });
    const steps: [number, () => void][] = [
      [40, () => h.input.setMove(0, 1)],
      [30, () => h.input.press('sprint')],
      [1, () => h.input.press('jump')],
      [30, () => h.input.setMove(0.7, 0.7)],
      [1, () => h.input.release('jump')],
      [60, () => h.input.setMove(-1, 0.2)],
      [40, () => h.input.release('sprint')],
      [90, () => h.input.setMove(0, -1)],
      [60, () => h.input.setMove(0, 0)],
    ];
    for (const [frames, apply] of steps) {
      apply();
      h.run(frames);
    }
    return {
      position: h.player.position.clone(),
      velocity: h.player.velocity.clone(),
      yaw: h.player.yaw,
    };
  }

  it('produces a bit-identical transform from the same script', () => {
    const a = scripted();
    const b = scripted();
    expect(b.position.x).toBe(a.position.x);
    expect(b.position.y).toBe(a.position.y);
    expect(b.position.z).toBe(a.position.z);
    expect(b.velocity.x).toBe(a.velocity.x);
    expect(b.velocity.z).toBe(a.velocity.z);
    expect(b.yaw).toBe(a.yaw);
  });
});
