// Browser adapter for the input module (design.md "입력 아키텍처", "재지정과 브라우저 정책"): records DOM and
// gamepad input as RawInput events in arrival order, applies the page's default-action policy and owns pointer
// lock. The pure InputState turns the drained events into per-tick action state.

import type { InputContext } from './actions';
import { DEFAULT_BINDINGS, RESERVED_CODES, buildCodeMap, type Bindings, type InputCode } from './bindings';
import { padToRawInputs } from './gamepad';
import type { RawInput } from './inputState';

export interface BrowserInputOptions {
  canvas: HTMLCanvasElement;
  getContext: () => InputContext;
  onPauseRequest: () => void;
  onFirstGesture?: () => void;
  onPointerLockChange?: (locked: boolean) => void;
}

/** Keys whose default action is blocked even when unbound: page scroll (Space, arrows) and find (F3). */
const ALWAYS_PREVENTED: ReadonlySet<InputCode> = new Set([
  'F3',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/** Wheel `deltaMode` line / page units in px. */
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 800;

/** Text entry keeps its keys: no recording, no preventDefault. */
function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** A connected gamepad the fixed layout applies to. */
function isStandardPad(pad: Gamepad | null | undefined): pad is Gamepad {
  return pad != null && pad.connected && pad.mapping === 'standard';
}

/** `navigator.getGamepads()`, or none where the API is missing (insecure context) or blocked by policy. */
function readGamepads(): readonly (Gamepad | null)[] {
  try {
    return typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  } catch {
    return [];
  }
}

export class BrowserInput {
  private readonly opts: BrowserInputOptions;
  /** Codes the current bindings (plus fixed inputs) use; their keydowns are preventDefault-ed. */
  private codeMap = buildCodeMap(DEFAULT_BINDINGS);
  private queue: RawInput[] = [];
  private locked = false;
  /** Set by releasePointerLock so the resulting unlock does not request pause. */
  private releaseRequested = false;
  /** performance.now() of the last user unlock during gameplay. */
  private unlockedAt = -Infinity;
  private lockErrorLogged = false;
  /** Tracked gamepad (`Gamepad.index`) and its pressed buttons from the last poll. */
  private padIndex: number | null = null;
  private padPressed: boolean[] | null = null;
  private readonly listeners = new AbortController();
  private readonly gestureListeners = new AbortController();

  constructor(opts: BrowserInputOptions) {
    this.opts = opts;
    const { canvas } = opts;
    const signal = this.listeners.signal;
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });
    window.addEventListener('mouseup', this.onMouseUp, { signal });
    window.addEventListener('mousemove', this.onMouseMove, { signal });
    window.addEventListener('blur', this.onBlur, { signal });
    canvas.addEventListener('mousedown', this.onMouseDown, { signal });
    canvas.addEventListener('click', this.onClick, { signal });
    canvas.addEventListener('contextmenu', this.onContextMenu, { signal });
    canvas.addEventListener('wheel', this.onWheel, { signal, passive: false });
    document.addEventListener('pointerlockchange', this.onLockChange, { signal });
    document.addEventListener('pointerlockerror', this.onLockError, { signal });
    document.addEventListener('visibilitychange', this.onVisibilityChange, { signal });
    const gesture = { signal: this.gestureListeners.signal, capture: true };
    window.addEventListener('pointerdown', this.onGesture, gesture);
    window.addEventListener('keydown', this.onGesture, gesture);
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  /** True within `ms` of a user unlock during gameplay, so the pause screen ignores the Esc that caused it. */
  justUnlocked(ms = 200): boolean {
    return performance.now() - this.unlockedAt <= ms;
  }

  /** Programmatic release (cinematics, menus, map): does not request pause. */
  releasePointerLock(): void {
    if (document.pointerLockElement !== this.opts.canvas) return;
    this.releaseRequested = true;
    document.exitPointerLock();
  }

  /** Updates the preventDefault policy; InputState.setBindings remaps the actions. */
  setBindings(b: Readonly<Bindings>): void {
    this.codeMap = buildCodeMap(b);
  }

  /** Queued events in arrival order; clears the queue. */
  drain(): RawInput[] {
    const events = this.queue;
    this.queue = [];
    return events;
  }

  /** Polls the first connected standard-mapping gamepad; call once per render frame. */
  pollGamepads(): void {
    const pads = readGamepads();
    if (this.padIndex !== null && !isStandardPad(pads.find((pad) => pad?.index === this.padIndex))) {
      // Disconnected: an empty snapshot releases its held buttons and zeroes the sticks (Req 31.8).
      this.queue.push(...padToRawInputs(this.padPressed, { buttons: [], axes: [] }).events);
      this.padIndex = null;
      this.padPressed = null;
      this.opts.onPauseRequest();
    }
    const pad = pads.find((p) => isStandardPad(p) && (this.padIndex === null || p.index === this.padIndex));
    if (!isStandardPad(pad)) return;
    this.padIndex = pad.index;
    const { pressed, events } = padToRawInputs(this.padPressed, {
      buttons: pad.buttons.map((button) => button.value),
      axes: pad.axes,
    });
    this.padPressed = pressed;
    this.queue.push(...events);
  }

  /** Removes every listener. */
  dispose(): void {
    this.listeners.abort();
    this.gestureListeners.abort();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isEditable(event.target)) return;
    if (this.shouldPrevent(event)) event.preventDefault(); // repeats too, or held Space / arrows scroll
    if (event.repeat) return;
    // While locked the browser spends Esc on the unlock, and onLockChange requests pause instead.
    if (event.code === 'Escape' && this.locked) return;
    this.queue.push({ kind: 'down', code: event.code, time: event.timeStamp });
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    // Also recorded from text fields: an 'up' for a code that is not held is a no-op, and a key released after
    // focus moved into a field must not stay down.
    this.queue.push({ kind: 'up', code: event.code, time: event.timeStamp });
  };

  /** Game keys lose their default action; shortcuts and reserved keys stay with the browser. */
  private shouldPrevent(event: KeyboardEvent): boolean {
    if (event.altKey || event.ctrlKey || event.metaKey) return false; // Ctrl+W, Alt+F4, …
    if (ALWAYS_PREVENTED.has(event.code)) return true;
    // Esc, F5, F11, Tab, Alt, Ctrl and Meta keep their browser behaviour (design "예약 키와 기본 동작").
    return this.codeMap.has(event.code) && !RESERVED_CODES.has(event.code);
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault(); // middle-click autoscroll
    this.queue.push({ kind: 'down', code: `Mouse${event.button}`, time: event.timeStamp });
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    this.queue.push({ kind: 'up', code: `Mouse${event.button}`, time: event.timeStamp });
  };

  /** Mouse look only while pointer-locked. */
  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.locked) this.queue.push({ kind: 'mouseMove', dx: event.movementX, dy: event.movementY });
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault(); // page scroll and zoom
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? WHEEL_PAGE_PX
          : 1;
    this.queue.push({ kind: 'wheel', delta: event.deltaY * unit });
  };

  /** The click also reaches the queue as Mouse0, so attack works even where the lock is refused. */
  private readonly onClick = (): void => {
    if (this.locked || this.opts.getContext() !== 'gameplay') return;
    try {
      // Promise in current browsers, void in older ones; refusals are reported through pointerlockerror.
      void Promise.resolve(this.opts.canvas.requestPointerLock()).catch(() => undefined);
    } catch {
      // Older implementations may throw; the camera keys and gamepad still turn the camera.
    }
  };

  private readonly onLockChange = (): void => {
    const locked = document.pointerLockElement === this.opts.canvas;
    if (locked === this.locked) return;
    this.locked = locked;
    const byGame = this.releaseRequested;
    this.releaseRequested = false;
    this.opts.onPointerLockChange?.(locked);
    // A user unlock during gameplay (usually Esc) opens Pause (Req 31.5, 31.9).
    if (!locked && !byGame && this.opts.getContext() === 'gameplay') {
      this.unlockedAt = performance.now();
      this.opts.onPauseRequest();
    }
  };

  private readonly onLockError = (): void => {
    if (this.lockErrorLogged) return;
    this.lockErrorLogged = true;
    console.warn('Pointer lock was refused; the camera keys and gamepad still turn the camera.');
  };

  private readonly onVisibilityChange = (): void => {
    if (!document.hidden) return;
    this.queue.push({ kind: 'releaseAll' });
    this.opts.onPauseRequest(); // Req 31.8
  };

  /** Keyups can be lost while the window is unfocused. */
  private readonly onBlur = (): void => {
    this.queue.push({ kind: 'releaseAll' });
  };

  private readonly onGesture = (event: Event): void => {
    // Esc grants no user activation (AudioContext.resume() would still fail), so wait for the next input.
    if (event instanceof KeyboardEvent && event.code === 'Escape') return;
    this.gestureListeners.abort();
    this.opts.onFirstGesture?.();
  };
}
