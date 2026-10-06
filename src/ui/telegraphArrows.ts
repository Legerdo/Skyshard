import './telegraphArrows.css';

/*
 * Off-screen Telegraph arrows (design "전투 프레이밍", Req 21.5): the Camera_System's edge indicators for attack
 * wind-ups outside the view, drawn as arrows at the screen edge pointing toward the attacker. A small pool of
 * elements is reused frame to frame; only `left` / `top` / `transform` and classes are written. Decorative for
 * assistive technology (the danger is also shown in the world), so the arrows are aria-hidden.
 */

/** One arrow: screen fractions (0..1, y down), direction angle (rad, atan2(dy, dx)) and heavy attack flag. */
export interface TelegraphArrow {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly strong: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** At most this many arrows are shown at once. */
const MAX_ARROWS = 8;

interface Slot {
  root: HTMLDivElement;
  shown: boolean;
  strong: boolean;
  left: string;
  top: string;
  transform: string;
}

export class TelegraphArrows {
  private readonly parent: HTMLElement;
  private readonly slots: Slot[] = [];

  constructor(parent: HTMLElement) {
    this.parent = parent;
  }

  /** One render frame's arrows (the first MAX_ARROWS are drawn). */
  update(arrows: readonly TelegraphArrow[]): void {
    const count = Math.min(arrows.length, MAX_ARROWS);
    while (this.slots.length < count) this.slots.push(this.createSlot());
    this.slots.forEach((slot, i) => {
      const arrow = i < count ? arrows[i] : undefined;
      const shown = arrow !== undefined;
      if (shown !== slot.shown) slot.root.classList.toggle('is-shown', (slot.shown = shown));
      if (arrow === undefined) return;
      if (arrow.strong !== slot.strong) slot.root.classList.toggle('is-strong', (slot.strong = arrow.strong));
      const left = `${(arrow.x * 100).toFixed(2)}%`;
      const top = `${(arrow.y * 100).toFixed(2)}%`;
      const transform = `rotate(${arrow.angle.toFixed(3)}rad)`;
      if (left !== slot.left) slot.root.style.left = slot.left = left;
      if (top !== slot.top) slot.root.style.top = slot.top = top;
      if (transform !== slot.transform) slot.root.style.transform = slot.transform = transform;
    });
  }

  private createSlot(): Slot {
    const root = document.createElement('div');
    root.className = 'hud-telegraph';
    root.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    const shape = document.createElementNS(SVG_NS, 'path');
    shape.setAttribute('class', 'hud-telegraph__shape');
    shape.setAttribute('d', 'M33 18 L8 5 L14 18 L8 31 Z'); // points along +x, rotated toward the attacker
    svg.append(shape);
    root.append(svg);
    this.parent.append(root);
    return { root, shown: false, strong: false, left: '', top: '', transform: '' };
  }
}
