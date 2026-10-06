/*
 * A small fake Web Audio context for the Audio_System unit tests (Node has no AudioContext): nodes record their
 * connections, params record their automation and can be evaluated at a time (setValueAtTime and linear ramps
 * exactly; exponential ramps, targets and curves by their end values), sources record start / stop. The clock
 * only moves through `advance`. Cast to AudioContext with `asContext`.
 */

type Clock = { currentTime: number };

export type ParamEvent =
  | { readonly type: 'set' | 'linear' | 'exp'; readonly value: number; readonly time: number }
  | { readonly type: 'target'; readonly value: number; readonly time: number; readonly tc: number }
  | { readonly type: 'curve'; readonly values: Float32Array; readonly time: number; readonly duration: number };

export class FakeParam {
  events: ParamEvent[] = [];
  /** Every call made, cancels included (for "untouched" checks). */
  readonly calls: string[] = [];
  private base: number;

  constructor(private readonly clock: Clock, initial: number) {
    this.base = initial;
  }

  get value(): number {
    return this.valueAt(this.clock.currentTime);
  }

  set value(v: number) {
    this.base = v;
    this.calls.push('value');
  }

  setValueAtTime(value: number, time: number): this {
    this.calls.push('setValueAtTime');
    this.events.push({ type: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.calls.push('linearRampToValueAtTime');
    this.events.push({ type: 'linear', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.calls.push('exponentialRampToValueAtTime');
    this.events.push({ type: 'exp', value, time });
    return this;
  }

  setTargetAtTime(value: number, time: number, tc: number): this {
    this.calls.push('setTargetAtTime');
    this.events.push({ type: 'target', value, time, tc });
    return this;
  }

  setValueCurveAtTime(values: Float32Array, time: number, duration: number): this {
    this.calls.push('setValueCurveAtTime');
    this.events.push({ type: 'curve', values: Float32Array.from(values), time, duration });
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.calls.push('cancelScheduledValues');
    this.events = this.events.filter((e) => e.time < time);
    return this;
  }

  /** The param's value at audio time `t`. */
  valueAt(t: number): number {
    let v = this.base;
    let prevT = -Infinity;
    for (const e of [...this.events].sort((a, b) => a.time - b.time)) {
      if (e.type === 'curve') {
        if (t < e.time) return v;
        if (t >= e.time + e.duration) {
          v = e.values[e.values.length - 1] ?? v;
          prevT = e.time + e.duration;
          continue;
        }
        const x = ((t - e.time) / e.duration) * (e.values.length - 1);
        const i = Math.floor(x);
        const a = e.values[i] ?? v;
        const b = e.values[i + 1] ?? a;
        return a + (b - a) * (x - i);
      }
      if (e.time > t) {
        if (e.type === 'linear' && Number.isFinite(prevT) && e.time > prevT) return v + ((e.value - v) * (t - prevT)) / (e.time - prevT);
        return v;
      }
      if (e.type === 'target') {
        // Approximation: the target is taken as reached after 5 time constants.
        v = t - e.time >= 5 * e.tc ? e.value : v + (e.value - v) * (1 - Math.exp(-(t - e.time) / e.tc));
      } else {
        v = e.value;
      }
      prevT = e.time;
    }
    return v;
  }

  /** Audio time the last automation event ends. */
  lastEventEnd(): number {
    let end = -Infinity;
    for (const e of this.events) end = Math.max(end, e.type === 'curve' ? e.time + e.duration : e.time);
    return end;
  }
}

export class FakeNode {
  readonly outputs: (FakeNode | FakeParam)[] = [];
  disconnected = false;

  constructor(readonly ctx: FakeAudioContext, readonly kind: string) {
    ctx.created.push(this);
  }

  connect<T extends FakeNode | FakeParam>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }

  disconnect(): void {
    this.outputs.length = 0;
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  readonly gain: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'gain');
    this.gain = new FakeParam(ctx, 1);
  }
}

export class FakeCompressor extends FakeNode {
  readonly threshold: FakeParam;
  readonly knee: FakeParam;
  readonly ratio: FakeParam;
  readonly attack: FakeParam;
  readonly release: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'compressor');
    this.threshold = new FakeParam(ctx, -24);
    this.knee = new FakeParam(ctx, 30);
    this.ratio = new FakeParam(ctx, 12);
    this.attack = new FakeParam(ctx, 0.003);
    this.release = new FakeParam(ctx, 0.25);
  }
}

export class FakeConvolver extends FakeNode {
  buffer: FakeBuffer | null = null;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'convolver');
  }
}

export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  readonly frequency: FakeParam;
  readonly Q: FakeParam;
  readonly gain: FakeParam;
  readonly detune: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'biquad');
    this.frequency = new FakeParam(ctx, 350);
    this.Q = new FakeParam(ctx, 1);
    this.gain = new FakeParam(ctx, 0);
    this.detune = new FakeParam(ctx, 0);
  }
}

export class FakePanner extends FakeNode {
  readonly pan: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'panner');
    this.pan = new FakeParam(ctx, 0);
  }
}

export class FakeSource extends FakeNode {
  startTime: number | null = null;
  stopTime: number | null = null;
  onended: (() => void) | null = null;
  constructor(ctx: FakeAudioContext, kind: string) {
    super(ctx, kind);
  }

  start(time = 0): void {
    if (this.startTime !== null) throw new Error('InvalidStateError: started twice');
    this.startTime = time;
  }

  stop(time = 0): void {
    if (this.startTime === null) throw new Error('InvalidStateError: stop before start');
    this.stopTime = time;
  }
}

export class FakeOscillator extends FakeSource {
  type = 'sine';
  readonly frequency: FakeParam;
  readonly detune: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'oscillator');
    this.frequency = new FakeParam(ctx, 440);
    this.detune = new FakeParam(ctx, 0);
  }
}

export class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate: FakeParam;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'bufferSource');
    this.playbackRate = new FakeParam(ctx, 1);
  }
}

export class FakeBuffer {
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    const d = this.data[channel];
    if (d === undefined) throw new Error('IndexSizeError');
    return d;
  }
}

type Listener = (event: unknown) => void;

/** An EventTarget stand-in (window / document) recording listeners and their capture flag. */
export class FakeTarget {
  hidden = false;
  readonly listeners: { type: string; fn: Listener; capture: boolean }[] = [];

  addEventListener(type: string, fn: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : options?.capture === true;
    if (!this.listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) this.listeners.push({ type, fn, capture });
  }

  removeEventListener(type: string, fn: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : options?.capture === true;
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  dispatch(type: string): void {
    for (const l of [...this.listeners]) if (l.type === type) l.fn({ type });
  }

  has(type: string, capture = true): boolean {
    return this.listeners.some((l) => l.type === type && l.capture === capture);
  }
}

export class FakeAudioContext {
  currentTime = 0;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly sampleRate = 8000;
  readonly created: FakeNode[] = [];
  readonly destination: FakeNode;
  /** What resume() does: run, reject (not allowed) or resolve but stay suspended (no user activation). */
  resumeBehavior: 'run' | 'reject' | 'stay' = 'run';
  resumeCalls = 0;
  suspendCalls = 0;

  constructor() {
    this.destination = new FakeNode(this, 'destination');
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.resumeBehavior === 'reject') return Promise.reject(new Error('NotAllowedError'));
    if (this.resumeBehavior === 'run') this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls++;
    this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }

  decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer> {
    if (data.byteLength === 0) return Promise.reject(new Error('EncodingError'));
    return Promise.resolve(new FakeBuffer(2, this.sampleRate, this.sampleRate));
  }

  createGain(): FakeGain {
    return new FakeGain(this);
  }

  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this);
  }

  createConvolver(): FakeConvolver {
    return new FakeConvolver(this);
  }

  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    return new FakeBuffer(channels, length, rate);
  }

  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this);
  }

  createOscillator(): FakeOscillator {
    return new FakeOscillator(this);
  }

  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad(this);
  }

  createStereoPanner(): FakePanner {
    return new FakePanner(this);
  }

  /** Nodes of `kind` created so far. */
  count(kind: string): number {
    return this.created.filter((n) => n.kind === kind).length;
  }

  /** Sources (oscillators and buffer sources) created so far. */
  sources(): FakeSource[] {
    return this.created.filter((n): n is FakeSource => n instanceof FakeSource);
  }
}

export const asContext = (ctx: FakeAudioContext): AudioContext => ctx as unknown as AudioContext;
export const asParam = (p: AudioParam): FakeParam => p as unknown as FakeParam;
export const asNode = <T extends FakeNode = FakeNode>(n: AudioNode): T => n as unknown as T;

/** Lets pending promise callbacks run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
