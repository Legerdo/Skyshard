import './menuScreens.css';
import { h } from './dom';
import type { LoadingReport } from './loadingProgress';
import { TITLE_TEXT } from './screenModels';

/*
 * Loading screen (design "부팅과 Loading", task 14.2; Req 1.10): the game name, a progress bar in the gold frame and
 * the current stage's text over the night backdrop, shown from boot until the Title has been drawn over the world.
 * It sits above the screen stack (the stack does not exist yet while the world is built) and is removed once the
 * first frame is on screen. Only the bar's `transform`, its aria value and the text are written.
 */
export class LoadingScreen {
  readonly element: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly text: HTMLElement;
  private shown = { fraction: -1, label: '' };

  constructor(parent: HTMLElement) {
    this.fill = h('div', { class: 'loading-screen__fill' });
    this.bar = h('div', {
      class: 'loading-screen__bar', role: 'progressbar', 'aria-label': '불러오는 중', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
    }, [this.fill]);
    this.text = h('p', { class: 'loading-screen__text', role: 'status', 'aria-live': 'polite' }, ['불러오는 중…']);
    this.element = h('div', { id: 'boot-screen', class: 'loading-screen' }, [
      h('div', { class: 'loading-screen__logo' }, [
        h('h1', { class: 'loading-screen__name' }, [TITLE_TEXT.name]),
        h('p', { class: 'loading-screen__tagline' }, [TITLE_TEXT.tagline]),
      ]),
      this.bar,
      this.text,
    ]);
    parent.replaceChildren(this.element);
  }

  set(report: LoadingReport): void {
    const fraction = Math.round(Math.min(1, Math.max(0, report.fraction)) * 1000) / 1000;
    if (fraction !== this.shown.fraction) {
      this.shown.fraction = fraction;
      this.fill.style.transform = `scaleX(${fraction})`;
      this.bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    }
    if (report.label !== this.shown.label) this.text.textContent = this.shown.label = report.label;
  }

  remove(): void {
    this.element.remove();
  }
}
