import './cinematicOverlay.css';
import { h } from '../ui/dom';
import type { CinematicView } from './cinematicPlayer';

/*
 * Cinematic overlay (design "재생 규칙" 시작·건너뛰기; Req 7.2, 21.11): drawn in the HUD layer while the rest of the
 * HUD is hidden. Letterbox bars for cinematics longer than 3 s, the title card of the latest `title` event, and from
 * 1 s into a skippable cinematic a small "길게 눌러 건너뛰기" hint at the bottom right with the current key names and
 * a round gauge that fills while the skip keys are held (and empties when they are let go early). Reads the player's
 * CinematicView every render frame; writes the DOM only when something changed.
 */
export class CinematicOverlay {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly titleMain: HTMLElement;
  private readonly titleSub: HTMLElement;
  private readonly skip: HTMLElement;
  private readonly skipKeys: HTMLElement;
  private readonly gauge: HTMLElement;
  private readonly keys: () => string;
  private shown = { visible: false, letterbox: false, title: '', skip: false, keys: '', progress: -1 };

  /** `keys`: the skip keys as currently bound (e.g. "Esc / Space"). */
  constructor(parent: HTMLElement, keys: () => string) {
    this.keys = keys;
    this.titleMain = h('div', { class: 'cinematic-overlay__title-main' });
    this.titleSub = h('div', { class: 'cinematic-overlay__title-sub' });
    this.title = h('div', { class: 'cinematic-overlay__title', role: 'status', 'aria-live': 'polite', hidden: true }, [
      this.titleMain,
      this.titleSub,
    ]);
    this.gauge = h('span', { class: 'cinematic-overlay__gauge', 'aria-hidden': 'true' });
    this.skipKeys = h('span', { class: 'cinematic-overlay__skip-keys' });
    this.skip = h('div', { class: 'cinematic-overlay__skip', hidden: true }, [
      this.gauge,
      h('span', { class: 'cinematic-overlay__skip-text' }, [this.skipKeys, ' 길게 눌러 건너뛰기']),
    ]);
    this.root = h('div', { class: 'cinematic-overlay', hidden: true }, [
      h('div', { class: 'cinematic-overlay__bar cinematic-overlay__bar--top', 'aria-hidden': 'true' }),
      h('div', { class: 'cinematic-overlay__bar cinematic-overlay__bar--bottom', 'aria-hidden': 'true' }),
      this.title,
      this.skip,
    ]);
    parent.append(this.root);
  }

  update(view: CinematicView | null): void {
    const s = this.shown;
    const visible = view !== null;
    if (visible !== s.visible) {
      s.visible = visible;
      this.root.hidden = !visible;
    }
    if (view === null) return;
    if (view.letterbox !== s.letterbox) {
      s.letterbox = view.letterbox;
      this.root.classList.toggle('is-letterboxed', view.letterbox);
    }
    const titleKey = view.title === null ? '' : `${view.title.title}\n${view.title.subtitle}`;
    if (titleKey !== s.title) {
      s.title = titleKey;
      this.title.hidden = view.title === null;
      if (view.title !== null) {
        this.titleMain.textContent = view.title.title;
        this.titleSub.textContent = view.title.subtitle;
      }
    }
    if (view.skipAvailable !== s.skip) {
      s.skip = view.skipAvailable;
      this.skip.hidden = !view.skipAvailable;
    }
    if (!view.skipAvailable) return;
    const keys = this.keys();
    if (keys !== s.keys) {
      s.keys = keys;
      this.skipKeys.textContent = keys;
    }
    const progress = Math.round(view.skipProgress * 100) / 100;
    if (progress !== s.progress) {
      s.progress = progress;
      this.gauge.style.setProperty('--skip-progress', String(progress));
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
