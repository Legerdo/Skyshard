// Fixed-step game loop: SIM_DT simulation steps fed by a real-time accumulator, interpolated
// rendering (alpha), real-time-limited time-scale requests (hit-stop, perfect-dodge slow-mo)
// and pause modes. Browser timing APIs are read from globalThis only when the matching option
// is omitted, so the module imports and runs under Node.

export const SIM_DT = 1 / 60;
export const MAX_STEPS_PER_FRAME = 5;
export const MAX_REAL_DT = 0.25;

/** Slack (s) so float noise in frame deltas can't make a steady 30/60 fps alternate 1-3 / 0-2 steps. */
const STEP_EPSILON = 1e-9;

export type PauseMode = 'none' | 'menu' | 'cinematic' | 'dialogue';
export type TimeScaleSource = 'hitStop' | 'perfectDodge';

export interface TickContext {
  readonly dt: number;
  readonly simTime: number;
  readonly tick: number;
  readonly pauseMode: PauseMode;
}

export interface GameLoopOptions {
  step(ctx: TickContext): void;
  render(alpha: number, realDt: number): void;
  now?: () => number; // ms
  requestFrame?: (cb: (timeMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  onError?: (error: unknown, phase: 'step' | 'render') => void;
}

interface TimeScaleRequest {
  readonly scale: number;
  /** Loop real time (s) at which the request lapses. */
  readonly expiresAt: number;
}

const defaultOnError = (error: unknown, phase: 'step' | 'render'): void => {
  console.error(`[GameLoop] ${phase} threw:`, error);
};

export class GameLoop {
  private readonly options: GameLoopOptions;
  private readonly requests = new Map<TimeScaleSource, TimeScaleRequest>();
  private mode: PauseMode = 'none';
  private accumulator = 0;
  private lastMs: number | undefined;
  /** Sum of clamped realDt (s); time-scale expiry is measured on this clock. */
  private realTime = 0;
  private sim = 0;
  private ticks = 0;
  private playTime = 0;
  private lastAlpha = 0;
  private isRunning = false;
  private handle: number | undefined;
  /** Bumped by start() so a callback from an earlier run cannot fork a second frame chain. */
  private generation = 0;

  constructor(options: GameLoopOptions) {
    this.options = options;
  }

  /** Lowest scale among active requests; 1 when there are none. */
  get timeScale(): number {
    let scale = 1;
    for (const request of this.requests.values()) scale = Math.min(scale, request.scale);
    return scale;
  }

  get simTime(): number {
    return this.sim;
  }

  get tickCount(): number {
    return this.ticks;
  }

  get playTimeSec(): number {
    return this.playTime;
  }

  /** Interpolation factor passed to the last render, in [0, 1). */
  get alpha(): number {
    return this.lastAlpha;
  }

  get running(): boolean {
    return this.isRunning;
  }

  get pauseMode(): PauseMode {
    return this.mode;
  }

  set pauseMode(mode: PauseMode) {
    this.mode = mode;
  }

  /** Idempotent. Every scheduled frame calls frame(now()). */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastMs = undefined; // time spent stopped is not simulated
    const generation = ++this.generation;
    const onFrame = (): void => {
      if (!this.isRunning || generation !== this.generation) return;
      this.handle = this.requestFrame(onFrame); // schedule first so nothing below can end the loop
      this.frame(this.now());
    };
    this.handle = this.requestFrame(onFrame);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.handle !== undefined) this.cancelFrame(this.handle);
    this.handle = undefined;
  }

  /** Runs one display frame at `nowMs` (same clock as `now`). */
  frame(nowMs: number): void {
    const elapsed = this.lastMs === undefined ? 0 : (nowMs - this.lastMs) / 1000;
    const realDt = elapsed > 0 ? Math.min(elapsed, MAX_REAL_DT) : 0; // negative or NaN -> 0
    this.lastMs = nowMs;

    this.realTime += realDt;
    for (const [source, request] of this.requests) {
      if (this.realTime >= request.expiresAt) this.requests.delete(source);
    }

    if (this.mode !== 'menu') {
      this.accumulator += realDt * this.timeScale;
      let steps = 0;
      // A step that opens a menu (e.g. the Defeat Screen) stops the frame's remaining steps; the getter
      // re-reads the mode after each step.
      while (this.pauseMode !== 'menu' && this.accumulator >= SIM_DT - STEP_EPSILON && steps < MAX_STEPS_PER_FRAME) {
        steps++;
        this.accumulator -= SIM_DT;
        try {
          this.options.step({ dt: SIM_DT, simTime: this.sim, tick: this.ticks, pauseMode: this.mode });
        } catch (error) {
          this.report(error, 'step');
        }
        this.sim += SIM_DT;
        this.ticks++;
      }
      if (this.accumulator >= SIM_DT) this.accumulator %= SIM_DT; // drop backlog past the step cap
    }
    if (this.mode !== 'menu') this.playTime += realDt;

    // STEP_EPSILON can leave the accumulator a hair below zero.
    this.lastAlpha = this.accumulator > 0 ? this.accumulator / SIM_DT : 0;
    try {
      this.options.render(this.lastAlpha, realDt);
    } catch (error) {
      this.report(error, 'render');
    }
  }

  /** Replaces `source`'s request: `scale` (clamped to 0..1) for `realSeconds` of real time. */
  setTimeScale(source: TimeScaleSource, scale: number, realSeconds: number): void {
    if (!(realSeconds > 0)) {
      this.requests.delete(source); // a zero, negative or NaN duration leaves nothing to apply
      return;
    }
    const clamped = Number.isNaN(scale) ? 1 : Math.min(Math.max(scale, 0), 1);
    this.requests.set(source, { scale: clamped, expiresAt: this.realTime + realSeconds });
  }

  clearTimeScale(source: TimeScaleSource): void {
    this.requests.delete(source);
  }

  setPlayTime(sec: number): void {
    this.playTime = Number.isFinite(sec) && sec > 0 ? sec : 0;
  }

  /** Discards pending simulation time (e.g. after a load or teleport). */
  resetAccumulator(): void {
    this.accumulator = 0;
    this.lastAlpha = 0;
  }

  // Options are called as plain functions; browser globals are only touched when one is omitted.
  private now(): number {
    const now = this.options.now;
    return now ? now() : globalThis.performance.now();
  }

  private requestFrame(cb: (timeMs: number) => void): number {
    const request = this.options.requestFrame;
    return request ? request(cb) : globalThis.requestAnimationFrame(cb);
  }

  private cancelFrame(handle: number): void {
    const { requestFrame, cancelFrame } = this.options;
    if (cancelFrame) cancelFrame(handle);
    // Custom requestFrame without cancelFrame: the stale callback exits via the running check.
    else if (!requestFrame) globalThis.cancelAnimationFrame(handle);
  }

  private report(error: unknown, phase: 'step' | 'render'): void {
    try {
      (this.options.onError ?? defaultOnError)(error, phase);
    } catch {
      // A throwing onError must not stop the loop either.
    }
  }
}
