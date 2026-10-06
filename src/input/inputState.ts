// Per-tick input sampling (design.md "입력 컨텍스트와 샘플링"). Pure: the DOM / gamepad adapter records
// RawInput events and the fixed-step loop hands them to InputState.beginTick. No DOM access here.

import { DEG2RAD } from '../core/math';
import type { Vec2 } from '../core/types';
import {
  BUFFER_SECONDS,
  BUFFERED_ACTIONS,
  CONTEXT_ACTIONS,
  MOVE_ACTIONS,
  type BufferedAction,
  type InputAction,
  type InputContext,
} from './actions';
import { DEFAULT_BINDINGS, buildCodeMap, type Bindings, type InputCode } from './bindings';

/**
 * Raw events in arrival order. `time` is the event timestamp in ms (informational: holds and the buffer use sim
 * time). Mouse deltas are `movementX/Y` px and wheel is `deltaY`. The gamepad poll emits `axes` (Gamepad API
 * signs: +x right, +y down) plus down/up for `Pad*` buttons; `releaseAll` is sent on window blur.
 */
export type RawInput =
  | { kind: 'down' | 'up'; code: InputCode; time: number }
  | { kind: 'mouseMove'; dx: number; dy: number }
  | { kind: 'wheel'; delta: number }
  | { kind: 'axes'; moveX: number; moveY: number; lookX: number; lookY: number }
  | { kind: 'releaseAll' };

export interface LookOptions {
  /** `Settings.mouseSensitivity`; scales mouse and right-stick look, not the camera keys. */
  sensitivity: number;
  /** Flips the pitch of every look source. */
  invertY: boolean;
}

/** Radial deadzone (stick vector length) for both sticks. */
export const STICK_DEADZONE = 0.15;
/** Mouse look per px at sensitivity 1.0 (0.12°). */
export const MOUSE_RAD_PER_PX = 0.12 * DEG2RAD;
/** Camera-key look rates (rad/s). */
export const KEY_YAW_RATE = 150 * DEG2RAD;
export const KEY_PITCH_RATE = 90 * DEG2RAD;
/** Right-stick look rates at full tilt and sensitivity 1.0 (rad/s). */
export const STICK_YAW_RATE = 180 * DEG2RAD;
export const STICK_PITCH_RATE = 90 * DEG2RAD;

/** Slack for comparing accumulated sim time with BUFFER_SECONDS. */
const TIME_EPSILON = 1e-9;
const MOVES = new Set<InputAction>(MOVE_ACTIONS);
/** Contexts whose screen uses the wheel (camera distance, map zoom). */
const WHEEL_CONTEXTS = new Set<InputContext>(['gameplay', 'map']);
const NO_ACTIONS: readonly InputAction[] = [];
const NO_AXES = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 } as const;

/** Radial deadzone, rescaled so the length rises from 0 at the threshold to 1 at full tilt. */
function deadzone(x: number, y: number): Vec2 {
  const length = Math.hypot(x, y);
  if (length <= STICK_DEADZONE) return { x: 0, y: 0 };
  const k = Math.min(1, (length - STICK_DEADZONE) / (1 - STICK_DEADZONE)) / length;
  return { x: x * k, y: y * k };
}

/**
 * Action state for the current simulation tick. `pressed` / `released` last one tick. Actions outside the
 * current context read as idle: not down, pressed or released, and heldTime 0.
 */
export class InputState {
  private codeMap: Map<InputCode, InputAction[]>;
  private currentBindings: Readonly<Bindings>;
  private look: LookOptions;
  private ctx: InputContext = 'gameplay';
  /** Sim seconds fed through beginTick. */
  private time = 0;
  /** Physically held codes. */
  private readonly held = new Set<InputCode>();
  /** Held codes carried over a context or bindings change; they drive nothing until released. */
  private readonly ignored = new Set<InputCode>();
  /** Per active action, how many held, non-ignored codes drive it. */
  private readonly active = new Map<InputAction, number>();
  private readonly holdTime = new Map<InputAction, number>();
  /** Length of the holds that ended this tick. */
  private readonly finishedHold = new Map<InputAction, number>();
  private readonly pressedNow = new Set<InputAction>();
  private readonly releasedNow = new Set<InputAction>();
  /** Sim time of the latest unconsumed press per buffered action. */
  private readonly buffer = new Map<BufferedAction, number>();
  private axes: { moveX: number; moveY: number; lookX: number; lookY: number } = { ...NO_AXES };
  private lookX = 0;
  private lookY = 0;
  private wheel = 0;
  private walk = false;

  constructor(
    bindings: Readonly<Bindings> = DEFAULT_BINDINGS,
    look: LookOptions = { sensitivity: 1, invertY: false },
  ) {
    this.codeMap = buildCodeMap(bindings);
    this.currentBindings = { ...bindings };
    this.look = { ...look };
  }

  get context(): InputContext {
    return this.ctx;
  }

  /** The bindings in effect (a copy of what was last applied): prompts and hints show these keys (Req 14.3, 34.3). */
  get bindings(): Readonly<Bindings> {
    return this.currentBindings;
  }

  /** Walk mode, flipped by each `walkToggle` press. */
  get walkToggled(): boolean {
    return this.walk;
  }

  down(a: InputAction): boolean {
    return this.allowed(a) && this.active.has(a);
  }

  /** Became down this tick (also true for a press released within the same tick). */
  pressed(a: InputAction): boolean {
    return this.allowed(a) && this.pressedNow.has(a);
  }

  /** Stopped being down this tick. */
  released(a: InputAction): boolean {
    return this.allowed(a) && this.releasedNow.has(a);
  }

  /** Sim seconds the action has been held; on its released tick, the length of the hold that just ended. */
  heldTime(a: InputAction): number {
    if (!this.allowed(a)) return 0;
    if (this.releasedNow.has(a)) return this.finishedHold.get(a) ?? 0;
    return this.active.has(a) ? (this.holdTime.get(a) ?? 0) : 0;
  }

  /** Movement intent, x right and y forward, length 0..1: normalized keys, or the left stick when longer. */
  moveVector(): Vec2 {
    if (!this.allowed('moveForward')) return { x: 0, y: 0 };
    const x = Number(this.down('moveRight')) - Number(this.down('moveLeft'));
    const y = Number(this.down('moveForward')) - Number(this.down('moveBack'));
    const keyLength = Math.hypot(x, y);
    const keys = keyLength > 1 ? { x: x / keyLength, y: y / keyLength } : { x, y };
    const stick = deadzone(this.axes.moveX, 0 - this.axes.moveY); // stick up is -y; `0 -` avoids -0
    return Math.hypot(stick.x, stick.y) > Math.hypot(keys.x, keys.y) ? stick : keys;
  }

  /**
   * Look rotation (rad) accumulated since the last call, then reset. x is yaw (+ turns right); y is pitch
   * (+ looks down, like moving the mouse down), negated when invertY is set.
   */
  lookDelta(): Vec2 {
    const delta = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return delta;
  }

  /** Wheel `deltaY` accumulated since the last call (gameplay and map contexts only), then reset. */
  wheelDelta(): number {
    const delta = this.wheel;
    this.wheel = 0;
    return delta;
  }

  /**
   * Whether a jump / attack / dodge press from the last BUFFER_SECONDS of sim time is waiting, without
   * consuming it (the pure player controller reads this and reports which presses it used).
   */
  isBuffered(a: BufferedAction): boolean {
    const at = this.buffer.get(a);
    return at !== undefined && this.time - at <= BUFFER_SECONDS + TIME_EPSILON;
  }

  /** True once for a jump / attack / dodge press made within the last BUFFER_SECONDS of sim time. */
  consumeBuffered(a: BufferedAction): boolean {
    const at = this.buffer.get(a);
    if (at === undefined) return false;
    this.buffer.delete(a);
    return this.time - at <= BUFFER_SECONDS + TIME_EPSILON;
  }

  /**
   * Switches context: clears edges, hold times, the buffer and pending look / wheel. Held codes are ignored
   * until released, except movement keys, which stay down. Setting the current context again does nothing.
   */
  setContext(ctx: InputContext): void {
    if (ctx === this.ctx) return;
    this.ctx = ctx;
    for (const code of this.held) {
      if (!this.actionsOf(code).some((action) => MOVES.has(action))) this.ignore(code);
    }
    this.resetTransient();
  }

  /** Applies new (already sanitized) bindings. Held codes are ignored until released. */
  setBindings(bindings: Readonly<Bindings>): void {
    for (const code of this.held) this.ignore(code);
    this.codeMap = buildCodeMap(bindings);
    this.currentBindings = { ...bindings };
    this.resetTransient();
  }

  setLookOptions(options: LookOptions): void {
    this.look = { ...options };
  }

  /**
   * Adds a mouse movement (px) to the pending look right away, exactly as a 'mouseMove' RawInput does
   * inside beginTick (sensitivity, invertY, gameplay context only). The frame-level sampler uses it so
   * mouse look reaches the camera in the frame it happened, even when that frame runs no tick.
   */
  addMouseLook(dx: number, dy: number): void {
    if (!this.lookAllowed()) return;
    const k = MOUSE_RAD_PER_PX * this.look.sensitivity;
    this.addLook(dx * k, dy * k);
  }

  /**
   * Advances sim time by `dt`, applies `events` in order and recomputes this tick's edges. When one render frame
   * runs several ticks, pass the frame's events to the first tick only and `[]` to the rest, so edges are true
   * on the first tick alone; a frame with no tick keeps its events queued for the next one. A press and release
   * inside one tick make both `pressed` and `released` true.
   */
  beginTick(events: readonly RawInput[], dt: number): void {
    this.time += dt;
    this.pressedNow.clear();
    this.releasedNow.clear();
    this.finishedHold.clear();
    for (const action of this.active.keys()) this.holdTime.set(action, (this.holdTime.get(action) ?? 0) + dt);
    for (const event of events) this.apply(event);
    if (this.pressed('walkToggle')) this.walk = !this.walk;
    for (const action of BUFFERED_ACTIONS) {
      if (this.pressed(action)) this.buffer.set(action, this.time);
    }
    for (const [action, at] of this.buffer) {
      if (this.time - at > BUFFER_SECONDS + TIME_EPSILON) this.buffer.delete(action);
    }
    if (this.lookAllowed()) {
      // Camera keys turn at fixed rates; the right stick scales with tilt and sensitivity.
      const stick = deadzone(this.axes.lookX, this.axes.lookY);
      const s = this.look.sensitivity;
      const keyX = Number(this.down('camRight')) - Number(this.down('camLeft'));
      const keyY = Number(this.down('camDown')) - Number(this.down('camUp'));
      this.addLook(
        (keyX * KEY_YAW_RATE + stick.x * STICK_YAW_RATE * s) * dt,
        (keyY * KEY_PITCH_RATE + stick.y * STICK_PITCH_RATE * s) * dt,
      );
    }
  }

  private apply(event: RawInput): void {
    switch (event.kind) {
      case 'down':
        this.press(event.code);
        break;
      case 'up':
        this.release(event.code);
        break;
      case 'mouseMove':
        this.addMouseLook(event.dx, event.dy);
        break;
      case 'wheel':
        if (WHEEL_CONTEXTS.has(this.ctx)) this.wheel += event.delta;
        break;
      case 'axes':
        this.axes = { moveX: event.moveX, moveY: event.moveY, lookX: event.lookX, lookY: event.lookY };
        break;
      case 'releaseAll':
        for (const code of [...this.held]) this.release(code);
        this.axes = { ...NO_AXES };
        break;
    }
  }

  private press(code: InputCode): void {
    if (this.held.has(code)) return;
    this.held.add(code);
    for (const action of this.actionsOf(code)) {
      const count = this.active.get(action) ?? 0;
      this.active.set(action, count + 1);
      if (count === 0) {
        this.pressedNow.add(action);
        this.holdTime.set(action, 0);
      }
    }
  }

  private release(code: InputCode): void {
    if (!this.held.delete(code)) return;
    if (this.ignored.delete(code)) return; // ignored codes end silently
    for (const action of this.actionsOf(code)) {
      if (this.decrement(action) > 0) continue;
      this.releasedNow.add(action);
      this.finishedHold.set(action, this.holdTime.get(action) ?? 0);
      this.holdTime.delete(action);
    }
  }

  /** Stops a held code driving its actions until it is released, without edges. */
  private ignore(code: InputCode): void {
    if (this.ignored.has(code)) return;
    this.ignored.add(code);
    for (const action of this.actionsOf(code)) this.decrement(action);
  }

  /** Drops one driving code from `action`; returns how many remain. */
  private decrement(action: InputAction): number {
    const count = (this.active.get(action) ?? 0) - 1;
    if (count > 0) this.active.set(action, count);
    else this.active.delete(action);
    return Math.max(count, 0);
  }

  private resetTransient(): void {
    this.pressedNow.clear();
    this.releasedNow.clear();
    this.finishedHold.clear();
    this.holdTime.clear();
    this.buffer.clear();
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
  }

  private addLook(x: number, y: number): void {
    this.lookX += x;
    this.lookY += this.look.invertY ? -y : y;
  }

  private actionsOf(code: InputCode): readonly InputAction[] {
    return this.codeMap.get(code) ?? NO_ACTIONS;
  }

  private allowed(a: InputAction): boolean {
    return CONTEXT_ACTIONS[this.ctx].has(a);
  }

  /** Look input follows the camera actions' context rule (gameplay only). */
  private lookAllowed(): boolean {
    return this.allowed('camLeft');
  }
}
