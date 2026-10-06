/*
 * FocusNav (design "포커스 탐색과 전환", Req 31.7; task 14.1): the rules the ScreenManager uses to move the focus.
 * Pure, so they run in Node tests:
 * - Geometry: for a direction, the candidates are the focusables whose centre lies on that side of the current
 *   element's centre; the one with the smallest "main-axis distance + 2 × cross-axis offset" wins, where the
 *   offset is the gap between the two rects on the cross axis (0 when they overlap). Tab rows, grids and vertical
 *   lists need no special casing; with no candidate the focus stays.
 * - Fallback: without layout (Node stand-ins, elements not laid out yet) up / left and down / right step through
 *   `focusables()` in list order, without wrapping.
 * - Repeat: a held direction (arrow key, D-pad) repeats after 0.4 s, then every 0.1 s, in real time.
 * - Control handlers: a focused custom control (slider, stepper) can consume directions before the focus moves.
 */
import type { NavInput } from './navInput';

export type NavDirection = Extract<NavInput, 'up' | 'down' | 'left' | 'right'>;

/** What FocusNav reads from `getBoundingClientRect()`. */
export interface FocusRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Weight of the cross-axis offset against the main-axis distance. */
export const CROSS_AXIS_WEIGHT = 2;
/** Hold before a direction repeats, then the repeat interval (s, real time). */
export const NAV_REPEAT_DELAY = 0.4;
export const NAV_REPEAT_INTERVAL = 0.1;
/** At most this many repeats per frame (a long frame does not fire a burst). */
const MAX_REPEATS_PER_UPDATE = 3;
/** Centres closer than this on the main axis are not "on that side" (px). */
const SIDE_EPSILON = 0.5;
const TIME_EPSILON = 1e-9;

export function isDirection(nav: NavInput): nav is NavDirection {
  return nav === 'up' || nav === 'down' || nav === 'left' || nav === 'right';
}

/** A rect with an area: the element is laid out and visible. */
export function hasLayout(rect: FocusRect | null | undefined): rect is FocusRect {
  return rect != null && Number.isFinite(rect.left) && Number.isFinite(rect.top) && rect.width > 0 && rect.height > 0;
}

/** Gap between the intervals [a0, a1] and [b0, b1]; 0 when they overlap. */
function intervalGap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, b0 - a1, a0 - b1);
}

/** "main-axis distance + 2 × cross-axis offset" of `to` seen from `from` in `dir`, or null when `to` is not on that side. */
export function focusScore(from: FocusRect, to: FocusRect, dir: NavDirection): number | null {
  const horizontal = dir === 'left' || dir === 'right';
  const main = horizontal
    ? to.left + to.width / 2 - (from.left + from.width / 2)
    : to.top + to.height / 2 - (from.top + from.height / 2);
  const forward = dir === 'right' || dir === 'down' ? main : -main;
  if (forward <= SIDE_EPSILON) return null;
  const offset = horizontal
    ? intervalGap(from.top, from.top + from.height, to.top, to.top + to.height)
    : intervalGap(from.left, from.left + from.width, to.left, to.left + to.width);
  return forward + CROSS_AXIS_WEIGHT * offset;
}

/**
 * Index of the element the focus moves to from `from` in `dir`, or -1 when nothing lies that way. Elements without
 * layout are skipped. Ties go to the smaller centre offset on the cross axis, then to the earlier element.
 */
export function pickGeometric(rects: readonly (FocusRect | null)[], from: number, dir: NavDirection): number {
  const current = rects[from];
  if (!hasLayout(current)) return -1;
  const horizontal = dir === 'left' || dir === 'right';
  const centre = (r: FocusRect): number => (horizontal ? r.top + r.height / 2 : r.left + r.width / 2);
  let best = -1;
  let bestScore = Infinity;
  let bestCross = Infinity;
  rects.forEach((rect, i) => {
    if (i === from || !hasLayout(rect)) return;
    const score = focusScore(current, rect, dir);
    if (score === null) return;
    const cross = Math.abs(centre(rect) - centre(current));
    if (score < bestScore - 1e-6 || (Math.abs(score - bestScore) <= 1e-6 && cross < bestCross)) {
      best = i;
      bestScore = score;
      bestCross = cross;
    }
  });
  return best;
}

/**
 * The focus index after `dir` among `count` focusables: geometric when `rects` are given and the current element
 * is laid out, otherwise list order (up / left −1, down / right +1, clamped). Returns `from` when it stays.
 */
export function nextFocusIndex(count: number, from: number, dir: NavDirection, rects: readonly (FocusRect | null)[] | null): number {
  if (count <= 0) return -1;
  const start = Math.min(count - 1, Math.max(0, from));
  if (rects !== null && rects.length === count && hasLayout(rects[start])) {
    const picked = pickGeometric(rects, start, dir);
    return picked < 0 ? start : picked;
  }
  const step = dir === 'up' || dir === 'left' ? -1 : 1;
  return Math.min(count - 1, Math.max(0, start + step));
}

/** Reads the element's rect when it can (a browser element); null for stand-ins without layout. */
export function readRect(element: unknown): FocusRect | null {
  const el = element as { getBoundingClientRect?: () => FocusRect } | null;
  if (el === null || typeof el?.getBoundingClientRect !== 'function') return null;
  try {
    return el.getBoundingClientRect();
  } catch {
    return null;
  }
}

/**
 * Hold-to-repeat of one direction: `press` starts it, `release` of the same code ends it, `update(realDt)` returns
 * the repeats that fell due (the first 0.4 s after the press, then every 0.1 s). A newer direction replaces the
 * held one.
 */
export class NavRepeater {
  private held: { code: string; nav: NavDirection; time: number; next: number } | null = null;

  /** The direction repeating while held, or null. */
  get direction(): NavDirection | null {
    return this.held?.nav ?? null;
  }

  press(code: string, nav: NavDirection): void {
    this.held = { code, nav, time: 0, next: NAV_REPEAT_DELAY };
  }

  release(code: string): void {
    if (this.held?.code === code) this.held = null;
  }

  clear(): void {
    this.held = null;
  }

  update(realDt: number): NavDirection[] {
    const held = this.held;
    if (held === null || !(realDt > 0)) return [];
    held.time += realDt;
    const out: NavDirection[] = [];
    while (held.time + TIME_EPSILON >= held.next) {
      held.next += NAV_REPEAT_INTERVAL;
      if (out.length < MAX_REPEATS_PER_UPDATE) out.push(held.nav);
    }
    return out;
  }
}

/**
 * Directions a focused custom control consumes before the focus moves (a slider's left / right). Kept per element
 * so the ScreenManager applies them on every screen without knowing the controls.
 */
export type NavHandler = (nav: NavInput) => boolean;

const navHandlers = new WeakMap<object, NavHandler>();

export function setNavHandler(element: object, handler: NavHandler | null): void {
  if (handler === null) navHandlers.delete(element);
  else navHandlers.set(element, handler);
}

export function navHandlerOf(element: object | null | undefined): NavHandler | null {
  return element == null ? null : (navHandlers.get(element) ?? null);
}
