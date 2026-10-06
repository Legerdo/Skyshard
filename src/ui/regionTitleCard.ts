import './regionTitleCard.css';
import { REGION_NAMES, type RegionId } from '../data/ids';
import { REGION_SUBTITLES } from '../data/worldLayout';

/** How long a title card stays up (s, Req 8.7), fades included. */
export const TITLE_CARD_SECONDS = 3;
/** Fade in and fade out inside TITLE_CARD_SECONDS (s). */
const FADE_SECONDS = 0.45;

/*
 * Region title card (design "알림과 피드백"; Req 8.7): on a Region's first entry, the Region name in spaced
 * English capitals with its one-line Korean subtitle, at a quarter of the screen height, for 3 s. It does not
 * change the input context, so control continues. Cards arriving while one shows wait in arrival order (the
 * banners of later tasks share this slot). Driven by real time from the render loop.
 */
export class RegionTitleCard {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;
  private readonly queue: RegionId[] = [];
  private showing: RegionId | null = null;
  private elapsed = 0;
  private opacity = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'region-title-card';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    this.title = document.createElement('div');
    this.title.className = 'region-title-card__name';
    this.subtitle = document.createElement('div');
    this.subtitle.className = 'region-title-card__subtitle';
    this.root.append(this.title, this.subtitle);
    parent.append(this.root);
  }

  /** Queues the card for `region`. */
  show(region: RegionId): void {
    this.queue.push(region);
  }

  /** The Region whose card is up, or null. */
  get current(): RegionId | null {
    return this.showing;
  }

  /** Advances by `dt` real seconds (render frame). */
  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this.showing !== null) {
      this.elapsed += step;
      if (this.elapsed >= TITLE_CARD_SECONDS) this.showing = null;
    }
    if (this.showing === null) {
      const next = this.queue.shift();
      if (next === undefined) {
        this.setOpacity(0);
        return;
      }
      this.showing = next;
      this.elapsed = 0;
      this.title.textContent = REGION_NAMES[next].toUpperCase();
      this.subtitle.textContent = REGION_SUBTITLES[next];
    }
    const t = this.elapsed;
    const fade = Math.min(1, t / FADE_SECONDS, (TITLE_CARD_SECONDS - t) / FADE_SECONDS);
    this.setOpacity(Math.max(0, fade));
  }

  private setOpacity(opacity: number): void {
    const hidden = this.showing === null;
    if (this.root.hidden !== hidden) this.root.hidden = hidden;
    const rounded = Math.round(opacity * 100) / 100;
    if (rounded === this.opacity) return;
    this.opacity = rounded;
    this.root.style.opacity = String(rounded);
  }
}
