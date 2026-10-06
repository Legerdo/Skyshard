import './screenFade.css';

/*
 * Full-screen black fade over the game view, driven by a 0..1 opacity each render frame (Safe_Position
 * recovery, Req 20.5; later fast travel and cinematics). Decorative only: hidden from assistive technology
 * and transparent to pointer input. It sits under the rest of the DOM UI.
 */
export class ScreenFade {
  private readonly element: HTMLDivElement;
  private opacity = 0;

  constructor(root: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'screen-fade';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.hidden = true;
    root.prepend(this.element);
  }

  /** 0 is clear, 1 black; a non-finite value counts as 0. Writes the DOM only when the rounded value changes. */
  set(opacity: number): void {
    const next = Number.isFinite(opacity) ? Math.round(Math.min(1, Math.max(0, opacity)) * 100) / 100 : 0;
    if (next === this.opacity) return;
    this.opacity = next;
    this.element.style.opacity = String(next);
    this.element.hidden = next === 0;
  }
}
