/**
 * A MINIMAL FAKE `BaseAudioContext` FOR NODE.
 *
 * The offline probes render the real graph in headless Chromium and are the
 * authority on how anything SOUNDS. They cannot, however, see anything that
 * depends on the CLOCK: an `OfflineAudioContext` pins `currentTime` at 0 for
 * the whole scheduling pass, and every probe drives the schedulers with a
 * single whole-render call. So the frame-by-frame behaviour — catch-up after a
 * paused frame loop, a lookahead window, a transition that lands at a future
 * time — is invisible to them by construction.
 *
 * This fake exists for exactly that gap. It is NOT a synthesiser: nodes are
 * inert, params only record the writes made to them, and nothing is rendered.
 * What it gives is a movable `currentTime` and a record of when things were
 * scheduled, which is all a scheduler test needs.
 */

/** One automation write, in the order it was made. */
export interface IParamEvent {
  readonly kind: 'setValue' | 'linear' | 'exponential' | 'cancel' | 'hold';
  readonly value: number;
  readonly time: number;
}

class FakeParam {
  value: number;
  readonly events: IParamEvent[] = [];

  constructor(value = 0) {
    this.value = value;
  }

  setValueAtTime(value: number, time: number): FakeParam {
    this.events.push({ kind: 'setValue', value, time });
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): FakeParam {
    this.events.push({ kind: 'linear', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): FakeParam {
    this.events.push({ kind: 'exponential', value, time });
    return this;
  }

  setTargetAtTime(value: number, time: number): FakeParam {
    this.events.push({ kind: 'setValue', value, time });
    return this;
  }

  cancelScheduledValues(time: number): FakeParam {
    this.events.push({ kind: 'cancel', value: 0, time });
    return this;
  }

  cancelAndHoldAtTime(time: number): FakeParam {
    this.events.push({ kind: 'hold', value: this.value, time });
    return this;
  }
}

/** Common node surface: connectable, disconnectable, with named params. */
class FakeNode {
  readonly type: string;
  readonly params = new Map<string, FakeParam>();
  readonly connected: FakeNode[] = [];
  started = 0;
  stopped = 0;
  buffer: unknown = undefined;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  curve: unknown = undefined;
  oversample = 'none';
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  coneInnerAngle = 360;
  coneOuterAngle = 360;
  coneOuterGain = 0;

  constructor(type: string, params: Record<string, number> = {}) {
    this.type = type;
    for (const [name, value] of Object.entries(params)) {
      const param = new FakeParam(value);
      this.params.set(name, param);
      Object.defineProperty(this, name, { value: param, enumerable: true });
    }
  }

  connect<T>(target: T): T {
    this.connected.push(target as unknown as FakeNode);
    return target;
  }

  disconnect(): void {
    this.connected.length = 0;
  }

  start(when = 0): void {
    this.started++;
    void when;
  }

  stop(when = 0): void {
    this.stopped++;
    void when;
  }
}

/**
 * The context. `currentTime` is a plain writable field, which is the whole
 * point: a test advances it the way wall-clock time advances between frames.
 */
export class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate: number;
  readonly destination = new FakeNode('destination');
  readonly listener = new FakeNode('listener', {
    positionX: 0,
    positionY: 0,
    positionZ: 0,
    forwardX: 0,
    forwardY: 0,
    forwardZ: -1,
    upX: 0,
    upY: 1,
    upZ: 0,
  });

  constructor(sampleRate = 8000) {
    this.sampleRate = sampleRate;
  }

  createGain(): FakeNode {
    return new FakeNode('gain', { gain: 1 });
  }

  createOscillator(): FakeNode {
    return new FakeNode('oscillator', { frequency: 440, detune: 0 });
  }

  createBiquadFilter(): FakeNode {
    return new FakeNode('biquad', { frequency: 350, Q: 1, gain: 0, detune: 0 });
  }

  createStereoPanner(): FakeNode {
    return new FakeNode('stereoPanner', { pan: 0 });
  }

  createPanner(): FakeNode {
    return new FakeNode('panner', { positionX: 0, positionY: 0, positionZ: 0 });
  }

  createWaveShaper(): FakeNode {
    return new FakeNode('waveShaper');
  }

  createDynamicsCompressor(): FakeNode {
    return new FakeNode('compressor', {
      threshold: -24,
      knee: 30,
      ratio: 12,
      attack: 0.003,
      release: 0.25,
    });
  }

  createBufferSource(): FakeNode {
    return new FakeNode('bufferSource', { playbackRate: 1, detune: 0 });
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }
}

class FakeBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private readonly channels: Float32Array[] = [];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    for (let i = 0; i < numberOfChannels; i++) this.channels.push(new Float32Array(length));
  }

  getChannelData(index: number): Float32Array {
    return this.channels[index]!;
  }
}

/** The fake, typed as the real thing for the code under test. */
export function fakeContext(sampleRate = 8000): BaseAudioContext & { currentTime: number } {
  return new FakeAudioContext(sampleRate) as unknown as BaseAudioContext & { currentTime: number };
}

/** A bare node to hand a voice or a director as its destination. */
export function fakeDestination(): AudioNode {
  return new FakeNode('destination') as unknown as AudioNode;
}
