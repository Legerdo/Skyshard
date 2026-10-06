/*
 * ScreenManager (design "UI 구조", "포커스 탐색과 전환"; tasks 4.8, 14.1): the stack of Screens drawn in the DOM
 * overlay above the game view. The bottom is the Title Screen or the Gameplay HUD; Pause, Settings, Inventory, Map,
 * Dialogue, Shop, Defeat, Victory, ... go on top. Only the top screen gets input, and its `context` is the input
 * context: `menu` and `map` stop game time (PauseMode 'menu'), `dialogue` freezes enemies, `gameplay` runs the game
 * (see pauseModeFor).
 *
 * Every push and pop reports `'ui:screen'` (`onScreen`) and, when the top context changes, `onContext`. A
 * screen's `onInput(nav)` returning false leaves the default handling here:
 * - a direction goes first to the focused custom control (a slider takes left / right, see `setNavHandler`), then
 *   moves the focus with FocusNav: geometrically over the focusables' rects ("main-axis distance + 2 × cross-axis
 *   offset"), or in list order where there is no layout (Node stand-ins). A held arrow key or D-pad direction
 *   repeats after 0.4 s every 0.1 s (real time, `update`);
 * - `confirm` clicks the focused element, so Enter / A and the mouse run the same handler;
 * - `cancel` pops (never the bottom screen).
 * The focus is shown with `.is-focused` (the `--focus` gold ring) and the real DOM focus. Covered screens keep their
 * focus index and get it back when they are uncovered.
 *
 * Motion (Req 31.6): the DOM a screen adds on `mount` opens with the Web Animations motion of src/ui/motion.ts
 * (panel 0.2 s, full-screen 0.3 s, reduced motion: opacity 0.1 s). A popped screen leaves the stack at once (input
 * goes to the new top), its DOM turns `inert` and stays until the closing motion has `finished`, then `unmount()`
 * runs. Without `animate` (Node) closing screens unmount at once. UI sounds follow `'ui:screen'` and the immediate
 * `onFeedback` stream (open / close / focus move / confirm / refuse), which also works while game time stands still.
 *
 * DOM use is limited to what screens hand over (their mount root and focusable elements), so the stack rules
 * run in Node tests with stand-in screens.
 */
import type { UiScreenId } from '../core/gameEvents';
import type { PauseMode } from '../core/loop';
import type { InputContext } from '../input/actions';
import { isDirection, navHandlerOf, nextFocusIndex, NavRepeater, readRect, type NavDirection } from './focusNav';
import { motionSpec, playMotion, prefersReducedMotion, type MotionHandle, type ScreenMotion } from './motion';
import { navFromCode, type NavInput } from './navInput';

/** Input context of a screen on top of the stack. `cinematic` is not a screen (the Cinematic_System sets it). */
export type ScreenContext = Extract<InputContext, 'gameplay' | 'menu' | 'dialogue' | 'map'>;

/** What the manager needs from a focusable element (an HTMLElement in the game). */
export type Focusable = Pick<HTMLElement, 'focus' | 'click' | 'classList'>;

export interface Screen {
  /** The `'ui:screen'` screen value. */
  readonly id: UiScreenId;
  /** Input context while this screen is on top. */
  readonly context: ScreenContext;
  /**
   * Open / close motion. Default: 'fullscreen' for the Map, 'fade' for the Gameplay HUD, 'panel' for the rest
   * (task 14.1).
   */
  readonly motion?: ScreenMotion;
  /** Builds or attaches the screen's DOM under `root`. */
  mount(root: HTMLElement): void;
  /** Removes the screen's DOM (after the closing motion). */
  unmount(): void;
  /** true: consumed; false: the manager applies the default handling. */
  onInput(nav: NavInput): boolean;
  /** Elements that can take the focus now, in navigation order; the first is the default. */
  focusables(): readonly Focusable[];
  /** Every render frame, in real time (game time may be stopped). */
  update?(realDt: number): void;
  /**
   * Any key, button or pointer press while this screen is on top, before navigation. true consumes it (it is not
   * also handled as navigation) and resets the focus to the first focusable; the Title Screen uses this for its
   * first input, which opens the menu without selecting anything.
   */
  onAnyInput?(): boolean;
  /**
   * Every raw key / gamepad button code (`InputCode`) going down or up while this screen is on top, before
   * `onAnyInput` and navigation (task 14.4: the Settings key remap listens here). true on a 'down' consumes it.
   */
  onRawInput?(code: string, phase: 'down' | 'up'): boolean;
}

export interface ScreenEvent {
  readonly screen: UiScreenId;
  readonly open: boolean;
}

/**
 * Immediate UI feedback for sounds (task 14.1): screens opening and closing, the focus moving, a confirm on an
 * enabled item, and a refusal (a disabled item, a refused key in the remap). Delivered at once, in real time.
 */
export type UiFeedback =
  | { readonly kind: 'open' | 'close'; readonly screen: UiScreenId }
  | { readonly kind: 'move' | 'confirm' | 'refuse' };

export interface ScreenManagerOptions {
  /** Parent element the screens mount into. */
  root: HTMLElement;
  /** Every push and pop, in order (published as `'ui:screen'`). */
  onScreen?: (event: ScreenEvent) => void;
  /** The top screen's context changed; null once the stack is empty. */
  onContext?: (context: ScreenContext | null) => void;
  /** Play open / close motion (default true; it also needs the Web Animations API). */
  motion?: boolean;
  /** Whether to use the reduced (opacity only) motion; default `prefers-reduced-motion`. */
  reducedMotion?: () => boolean;
}

/** Game time runs only under `gameplay` and `dialogue` screens; menus, maps and an empty stack stop it. */
export function pauseModeFor(context: ScreenContext | null): PauseMode {
  switch (context) {
    case 'gameplay':
      return 'none';
    case 'dialogue':
      return 'dialogue';
    default:
      return 'menu';
  }
}

/** CSS class of the focused element (drawn with the `--focus` ring). */
export const FOCUSED_CLASS = 'is-focused';

/** Default motion of a screen. */
export function screenMotion(screen: Pick<Screen, 'id' | 'motion'>): ScreenMotion {
  if (screen.motion !== undefined) return screen.motion;
  if (screen.id === 'map') return 'fullscreen';
  if (screen.id === 'gameplay') return 'fade';
  return 'panel';
}

interface Entry {
  readonly screen: Screen;
  /** Index into `focusables()`; kept while the screen is covered. */
  focus: number;
  /** Elements `mount` added to the root (the motion targets). */
  elements: Element[];
  /** Running open motion. */
  opening: MotionHandle[];
}

interface Closing {
  readonly elements: readonly Element[];
  readonly motion: readonly MotionHandle[];
}

/** Extra wait past the motion before a closing screen is unmounted anyway (a throttled or stalled timeline). */
const CLOSE_GRACE_MS = 150;

type InertElement = Element & { inert?: boolean };

function childrenOf(root: unknown): Element[] {
  const children = (root as { children?: ArrayLike<Element> } | null)?.children;
  return children === undefined ? [] : Array.from(children);
}

function setInert(el: Element, on: boolean): void {
  const target = el as InertElement;
  if ('inert' in target) target.inert = on;
  if (typeof target.setAttribute !== 'function') return;
  if (on) target.setAttribute('inert', '');
  else target.removeAttribute('inert');
}

function isDisabled(el: unknown): boolean {
  const target = el as { getAttribute?: (name: string) => string | null } | null;
  return typeof target?.getAttribute === 'function' && target.getAttribute('aria-disabled') === 'true';
}

export class ScreenManager {
  private readonly root: HTMLElement;
  private readonly onScreen: (event: ScreenEvent) => void;
  private readonly onContext: (context: ScreenContext | null) => void;
  private readonly motionOn: boolean;
  private readonly reduced: () => boolean;
  private readonly stack: Entry[] = [];
  private readonly closing = new Map<Screen, Closing>();
  private readonly repeater = new NavRepeater();
  private readonly feedbackListeners = new Set<(feedback: UiFeedback) => void>();
  private notifiedContext: ScreenContext | null = null;
  /** Nesting of replaceAll: context changes are reported once it finishes. */
  private batch = 0;

  constructor(options: ScreenManagerOptions) {
    this.root = options.root;
    this.onScreen = options.onScreen ?? (() => undefined);
    this.onContext = options.onContext ?? (() => undefined);
    this.motionOn = options.motion ?? true;
    this.reduced = options.reducedMotion ?? prefersReducedMotion;
    // A click on a stack element (mouse or the `confirm` default) is a confirm or, on a disabled item, a refusal.
    const target = this.root as Partial<Pick<HTMLElement, 'addEventListener'>>;
    target.addEventListener?.('click', (event: Event) => {
      const el = (event.target as Element | null)?.closest?.('button, [role="tab"], [role="switch"], [role="radio"]');
      if (el) this.feedback({ kind: isDisabled(el) ? 'refuse' : 'confirm' });
    });
  }

  /** The top screen, or null when the stack is empty. */
  get top(): Screen | null {
    return this.topEntry?.screen ?? null;
  }

  /** The top screen's input context, or null when the stack is empty. */
  get context(): ScreenContext | null {
    return this.top?.context ?? null;
  }

  /** Stack ids from the bottom up (closing screens are no longer in the stack). */
  get ids(): UiScreenId[] {
    return this.stack.map((entry) => entry.screen.id);
  }

  /** Index of the top screen's focused element; -1 when it has none. */
  get focusIndex(): number {
    const entry = this.topEntry;
    if (entry === null) return -1;
    return entry.screen.focusables().length === 0 ? -1 : entry.focus;
  }

  /** Screens whose closing motion still runs (their DOM is inert). */
  get closingCount(): number {
    return this.closing.size;
  }

  /** Whether `id` is anywhere in the stack. */
  has(id: UiScreenId): boolean {
    return this.stack.some((entry) => entry.screen.id === id);
  }

  /** Immediate feedback stream for UI sounds; returns the unsubscribe function. */
  onFeedback(listener: (feedback: UiFeedback) => void): () => void {
    this.feedbackListeners.add(listener);
    return () => this.feedbackListeners.delete(listener);
  }

  /** Reports a refusal (e.g. a key the remap rejects) or another feedback to the listeners. */
  feedback(feedback: UiFeedback): void {
    for (const listener of [...this.feedbackListeners]) listener(feedback);
  }

  push(screen: Screen): void {
    this.finishClose(screen); // a screen still closing is unmounted before it mounts again
    const covered = this.topEntry;
    if (covered !== null) this.markFocus(covered, false);
    this.repeater.clear();
    const before = childrenOf(this.root);
    const entry: Entry = { screen, focus: 0, elements: [], opening: [] };
    this.stack.push(entry);
    screen.mount(this.root);
    entry.elements = childrenOf(this.root).filter((el) => !before.includes(el));
    entry.opening = this.play(entry, 'open');
    this.onScreen({ screen: screen.id, open: true });
    this.feedback({ kind: 'open', screen: screen.id });
    this.reportContext();
    if (this.topEntry === entry) this.applyFocus(entry);
  }

  /** Removes the top screen; the one below gets its focus back. Does nothing on an empty stack. */
  pop(): void {
    const entry = this.stack.pop();
    if (entry === undefined) return;
    this.markFocus(entry, false);
    this.repeater.clear();
    this.close(entry);
    this.onScreen({ screen: entry.screen.id, open: false });
    this.feedback({ kind: 'close', screen: entry.screen.id });
    this.reportContext();
    const uncovered = this.topEntry;
    if (uncovered !== null) this.applyFocus(uncovered);
  }

  /**
   * Empties the stack (top first) and pushes `screen` as the new bottom: starting a game puts the Gameplay HUD
   * there, returning to the menu puts the Title Screen back. The context is reported once, for the result.
   */
  replaceAll(screen: Screen): void {
    this.batch++;
    try {
      while (this.stack.length > 0) this.pop();
      this.push(screen);
    } finally {
      this.batch--;
    }
    this.reportContext();
  }

  /**
   * A key, mouse or gamepad button (`InputCode`) went down, or up with `phase` 'up'. Ignored while a `gameplay`
   * screen is on top (the game reads those inputs); otherwise offered to the top screen raw, then as a first
   * input, then as navigation. A held direction repeats until its 'up'.
   */
  input(code: string, phase: 'down' | 'up' = 'down'): void {
    const entry = this.topEntry;
    if (phase === 'up') {
      this.repeater.release(code);
      if (entry !== null && entry.screen.context !== 'gameplay') entry.screen.onRawInput?.(code, 'up');
      return;
    }
    if (entry === null || entry.screen.context === 'gameplay') return;
    if (entry.screen.onRawInput?.(code, 'down') === true) return;
    if (this.anyInput()) return;
    const nav = navFromCode(code);
    if (nav === null) return;
    if (isDirection(nav)) this.repeater.press(code, nav);
    if (this.topEntry === entry) this.nav(nav);
  }

  /** Every held input was released (window blur): ends the direction repeat. */
  releaseInputs(): void {
    this.repeater.clear();
  }

  /** A press of any kind (keyboard, gamepad, pointer) on the top screen; true when the screen consumed it. */
  anyInput(): boolean {
    const entry = this.topEntry;
    if (entry === null || entry.screen.onAnyInput?.() !== true) return false;
    if (this.topEntry === entry) {
      entry.focus = 0;
      this.applyFocus(entry);
    }
    return true;
  }

  /** One navigation input for the top screen. */
  nav(nav: NavInput): void {
    const entry = this.topEntry;
    if (entry === null || entry.screen.onInput(nav)) return;
    const focused = entry.screen.focusables()[entry.focus];
    if (focused !== undefined && navHandlerOf(focused)?.(nav) === true) return;
    switch (nav) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        this.moveFocus(entry, nav);
        break;
      case 'confirm':
        focused?.click();
        break;
      case 'cancel':
        if (this.stack.length > 1) this.pop();
        break;
    }
  }

  /**
   * Follows a focus change made outside navigation (mouse hover, Tab): when `element` is one of the top screen's
   * focusables it becomes the focused item.
   */
  focusElement(element: unknown): void {
    const entry = this.topEntry;
    if (entry === null) return;
    const index = entry.screen.focusables().findIndex((item) => item === element);
    if (index < 0 || index === entry.focus) return;
    entry.focus = index;
    this.markFocus(entry, true);
    this.feedback({ kind: 'move' });
  }

  /**
   * Moves the focus to `element` when it is one of the top screen's focusables (a screen choosing its own focus,
   * e.g. the first item of a newly opened tab). Returns whether it did.
   */
  setFocus(element: unknown): boolean {
    const entry = this.topEntry;
    if (entry === null) return false;
    const index = entry.screen.focusables().findIndex((item) => item === element);
    if (index < 0) return false;
    entry.focus = index;
    this.applyFocus(entry);
    return true;
  }

  /** Every render frame: repeats a held direction, then updates every screen in the stack, bottom first, in real time. */
  update(realDt: number): void {
    const entry = this.topEntry;
    if (entry !== null && entry.screen.context !== 'gameplay') {
      for (const nav of this.repeater.update(realDt)) {
        if (this.topEntry !== entry) break;
        this.nav(nav);
      }
    } else {
      this.repeater.clear();
    }
    for (const item of [...this.stack]) item.screen.update?.(realDt);
  }

  private get topEntry(): Entry | null {
    return this.stack[this.stack.length - 1] ?? null;
  }

  private moveFocus(entry: Entry, dir: NavDirection): void {
    const items = entry.screen.focusables();
    if (items.length === 0) return;
    const rects = items.map(readRect);
    const next = nextFocusIndex(items.length, entry.focus, dir, rects.every((r) => r !== null) ? rects : null);
    if (next < 0 || next === entry.focus) return;
    entry.focus = next;
    this.applyFocus(entry);
    const el = items[next] as Partial<Pick<HTMLElement, 'scrollIntoView'>>;
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this.feedback({ kind: 'move' });
  }

  /** Moves the DOM focus and the focus mark to the entry's focused element. */
  private applyFocus(entry: Entry): void {
    const items = entry.screen.focusables();
    if (items.length === 0) return;
    entry.focus = Math.min(items.length - 1, Math.max(0, entry.focus));
    this.markFocus(entry, true);
    items[entry.focus].focus({ preventScroll: true });
  }

  /** Sets the focus mark on the focused element only (`on`), or clears every mark of the entry. */
  private markFocus(entry: Entry, on: boolean): void {
    entry.screen.focusables().forEach((item, i) => item.classList.toggle(FOCUSED_CLASS, on && i === entry.focus));
  }

  private play(entry: Entry, phase: 'open' | 'close'): MotionHandle[] {
    if (!this.motionOn || entry.elements.length === 0) return [];
    const spec = motionSpec(screenMotion(entry.screen), phase, this.reduced());
    const out: MotionHandle[] = [];
    for (const el of entry.elements) {
      const handle = playMotion(el, spec, phase);
      if (handle !== null) out.push(handle);
    }
    return out;
  }

  /** Closing: inert DOM until the motion finishes, then unmount; at once when nothing animates. */
  private close(entry: Entry): void {
    for (const handle of entry.opening) handle.cancel();
    entry.opening = [];
    const elements = entry.elements.filter((el) => (el as { isConnected?: boolean }).isConnected !== false);
    entry.elements = elements;
    const motion = this.play(entry, 'close');
    if (motion.length === 0) {
      entry.screen.unmount();
      return;
    }
    for (const el of elements) setInert(el, true);
    blurInside(elements);
    const record: Closing = { elements, motion };
    this.closing.set(entry.screen, record);
    const done = (): void => this.finishClose(entry.screen, record);
    void Promise.all(motion.map((m) => m.finished.catch(() => undefined))).then(done);
    const spec = motionSpec(screenMotion(entry.screen), 'close', this.reduced());
    if (typeof setTimeout === 'function') setTimeout(done, (spec?.duration ?? 0) + CLOSE_GRACE_MS);
  }

  /** Ends a pending close of `screen` (only `record`, when given): unmount, cancel the held frame, clear inert. */
  private finishClose(screen: Screen, record?: Closing): void {
    const pending = this.closing.get(screen);
    if (pending === undefined || (record !== undefined && pending !== record)) return;
    this.closing.delete(screen);
    screen.unmount();
    for (const handle of pending.motion) handle.cancel();
    for (const el of pending.elements) setInert(el, false);
  }

  private reportContext(): void {
    if (this.batch > 0) return;
    const context = this.context;
    if (context === this.notifiedContext) return;
    this.notifiedContext = context;
    this.onContext(context);
  }
}

/** Takes the DOM focus off closing (inert) elements so keys do not stay aimed at them. */
function blurInside(elements: readonly Element[]): void {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (active === null || !(active instanceof HTMLElement)) return;
  if (elements.some((el) => el === active || el.contains(active))) active.blur();
}
