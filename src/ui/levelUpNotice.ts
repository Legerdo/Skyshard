import './levelUpNotice.css';

/** How long the level-up notice stays up (s), fades included. */
export const LEVEL_UP_SECONDS = 2.5;
const FADE_SECONDS = 0.3;

/** Notice text for `level`: "레벨 업 · Lv 7". */
export function levelUpText(level: number): string {
  return `레벨 업 · Lv ${level}`;
}

/*
 * Level-up notice (task 12.1, Req 29.2): on 'levelUp' a gold "레벨 업 · Lv N" line with "HP 전부 회복" rises above the
 * party slots for 2.5 s. A second level-up while one shows restarts it with the new level (the event already carries
 * the final level). It does not take input. The pillar of light and the sound are the Render / Audio tasks' (they
 * listen to the same event). Driven by real time from the render loop.
 */
export class LevelUpNotice {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private elapsed = LEVEL_UP_SECONDS;
  private opacity = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'level-up-notice';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    this.title = document.createElement('div');
    this.title.className = 'level-up-notice__title';
    const sub = document.createElement('div');
    sub.className = 'level-up-notice__sub';
    sub.textContent = 'HP 전부 회복';
    this.root.append(this.title, sub);
    parent.append(this.root);
  }

  /** Shows the notice for `level`. */
  show(level: number): void {
    this.title.textContent = levelUpText(level);
    this.elapsed = 0;
  }

  /** Advances by `dt` real seconds. */
  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.elapsed = Math.min(LEVEL_UP_SECONDS, this.elapsed + step);
    const t = this.elapsed;
    const showing = t < LEVEL_UP_SECONDS;
    if (this.root.hidden === showing) this.root.hidden = !showing;
    const opacity = showing ? Math.max(0, Math.min(1, t / FADE_SECONDS, (LEVEL_UP_SECONDS - t) / FADE_SECONDS)) : 0;
    const rounded = Math.round(opacity * 100) / 100;
    if (rounded === this.opacity) return;
    this.opacity = rounded;
    this.root.style.opacity = String(rounded);
  }
}
