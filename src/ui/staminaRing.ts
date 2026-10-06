import './staminaRing.css';

/*
 * Stamina ring (design "HUD 레이아웃" / "표시 규칙", Req 17.3, 17.5): a ⌀48 circular gauge beside the
 * Active_Character (world projected). It shows while Stamina is below max and hides with a 0.2 s fade once max
 * has lasted 2 s. The controller's `exhausted` event turns it red, blinking every 0.25 s with a "!" in the
 * middle, until Exhausted clears at 30 %. Minimal until the HUD layout of task 14.3; only `transform`,
 * `stroke-dashoffset`, `left` / `top` and classes are written, and nothing reads layout.
 */

/** Seconds at max Stamina before the ring hides (Req 17.5). */
export const STAMINA_RING_HIDE_DELAY = 2;

/** Stamina fields the ring reads. */
export interface StaminaReading {
  readonly value: number;
  readonly max: number;
  readonly exhausted: boolean;
}

/** Display state carried between frames. */
export interface StaminaRingState {
  /** Seconds Stamina has been at max; Infinity when it has never been below max. */
  readonly fullTime: number;
  /** The red Exhausted display: set by the `exhausted` event, cleared when Exhausted ends. */
  readonly alarm: boolean;
}

export interface StaminaRingView {
  readonly visible: boolean;
  /** value / max in [0, 1]. */
  readonly fill: number;
  readonly alarm: boolean;
}

/** Hidden: a full pool at session start does not show the ring. */
export const STAMINA_RING_START: StaminaRingState = { fullTime: Infinity, alarm: false };

const fillOf = (s: StaminaReading): number =>
  s.max > 0 && Number.isFinite(s.value) ? Math.min(1, Math.max(0, s.value / s.max)) : 0;

/**
 * Advances the ring by `dt` s with this frame's Stamina. `exhaustedEvent` is whether an `exhausted` event
 * arrived since the last frame. Pure; `prev` is not changed.
 */
export function stepStaminaRing(
  prev: Readonly<StaminaRingState>,
  stamina: StaminaReading,
  dt: number,
  exhaustedEvent = false,
): StaminaRingState {
  const t = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const full = fillOf(stamina) >= 1;
  return {
    fullTime: full ? prev.fullTime + t : 0,
    alarm: (prev.alarm || exhaustedEvent) && stamina.exhausted,
  };
}

/** What the ring shows for `state` and this frame's Stamina. */
export function staminaRingView(state: Readonly<StaminaRingState>, stamina: StaminaReading): StaminaRingView {
  return { visible: state.fullTime < STAMINA_RING_HIDE_DELAY, fill: fillOf(stamina), alarm: state.alarm };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Ring radius in the 48×48 viewBox, and its circumference. */
const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Screen anchor: normalised device coordinates of the point beside the character, or null off screen. */
export interface ScreenAnchor {
  readonly x: number;
  readonly y: number;
}

export class StaminaRing {
  private readonly root: HTMLDivElement;
  private readonly arc: SVGCircleElement;
  private state: StaminaRingState = STAMINA_RING_START;
  private pendingAlarm = false;
  private shown = { visible: false, fill: -1, alarm: false, left: '', top: '' };

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud-stamina';
    this.root.setAttribute('role', 'meter');
    this.root.setAttribute('aria-label', 'Stamina');
    this.root.setAttribute('aria-valuemin', '0');
    this.root.setAttribute('aria-valuemax', '100');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(SVG_NS, 'circle');
    const arc = document.createElementNS(SVG_NS, 'circle');
    for (const [c, cls] of [
      [track, 'hud-stamina__track'],
      [arc, 'hud-stamina__arc'],
    ] as const) {
      c.setAttribute('class', cls);
      c.setAttribute('cx', '24');
      c.setAttribute('cy', '24');
      c.setAttribute('r', String(RADIUS));
    }
    arc.setAttribute('stroke-dasharray', CIRCUMFERENCE.toFixed(3));
    svg.append(track, arc);
    const mark = document.createElement('span');
    mark.className = 'hud-stamina__mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '!';
    this.root.append(svg, mark);
    this.arc = arc;
    parent.append(this.root);
  }

  /** The controller's `exhausted` event (Req 17.3); applied on the next update. */
  exhausted(): void {
    this.pendingAlarm = true;
  }

  /** One render frame: Stamina now, real `dt` s, and where the character is on screen. */
  update(stamina: StaminaReading, dt: number, anchor: ScreenAnchor | null): void {
    this.state = stepStaminaRing(this.state, stamina, dt, this.pendingAlarm);
    this.pendingAlarm = false;
    const view = staminaRingView(this.state, stamina);
    const s = this.shown;
    const visible = view.visible && anchor !== null;
    if (visible !== s.visible) this.root.classList.toggle('is-shown', (s.visible = visible));
    if (view.alarm !== s.alarm) this.root.classList.toggle('is-exhausted', (s.alarm = view.alarm));
    const fill = Math.round(view.fill * 1000) / 1000;
    if (fill !== s.fill) {
      s.fill = fill;
      this.arc.setAttribute('stroke-dashoffset', (CIRCUMFERENCE * (1 - fill)).toFixed(3));
      this.root.setAttribute('aria-valuenow', String(Math.round(fill * 100)));
    }
    if (anchor === null) return;
    const left = `${((anchor.x + 1) * 50).toFixed(2)}%`;
    const top = `${((1 - anchor.y) * 50).toFixed(2)}%`;
    if (left !== s.left) this.root.style.left = s.left = left;
    if (top !== s.top) this.root.style.top = s.top = top;
  }
}
