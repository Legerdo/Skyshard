import './bossBar.css';
import type { ElementIconShape } from '../data/elements';
import type { BossBarModel } from './bossBarModel';
import { h } from './dom';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Element icon outlines (24 × 24), one silhouette per Element so the Starshell never relies on colour alone. */
const ICON_PATHS: Readonly<Record<ElementIconShape, string>> = {
  triFlame: 'M12 3 L15 10 L18 6 L18 15 A6 6 0 0 1 6 15 L6 6 L9 10 Z',
  ringWaves: 'M12 3 a9 9 0 1 0 0.01 0 M12 8 a4 4 0 1 0 0.01 0',
  spiral: 'M12 12 m0 -1 a1 1 0 1 1 -1 1 a3 3 0 1 1 3 3 a5 5 0 1 1 -5 -5 a7 7 0 1 1 7 7',
  hexCrystal: 'M12 2 L20.5 7 L20.5 17 L12 22 L3.5 17 L3.5 7 Z',
};

/*
 * Caelith's boss bar (design "적·보스 표시", Req 6.11, 32.6): top centre just below the Compass, 720 × 20 px at UI scale
 * 100 %. Above the bar `CAELITH` with its subtitle and the Phase; the HP fill with notches at the 65 % / 30 % Phase
 * thresholds; while a Starshell stands, a thinner durability bar below with its Element icon and colour. It draws a
 * BossBarModel (./bossBarModel) and hides for null. Only `transform`, `hidden`, classes and changed text are written.
 */
export class BossBar {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly phase: HTMLElement;
  private readonly track: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly notchRoot: HTMLElement;
  private readonly shell: HTMLElement;
  private readonly shellIcon: SVGPathElement;
  private readonly shellFill: HTMLElement;
  private readonly shellText: HTMLElement;
  private shown = {
    visible: false, title: '', subtitle: '', phase: '', fill: -1, percent: -1, notches: '', vulnerable: false,
    shellVisible: false, shellElement: '', shellFill: -1, shellText: '',
  };

  constructor(parent: HTMLElement) {
    this.title = h('span', { class: 'hud-bossbar__name' });
    this.subtitle = h('span', { class: 'hud-bossbar__subtitle' });
    this.phase = h('span', { class: 'hud-bossbar__phase' });
    this.fill = h('div', { class: 'hud-bossbar__fill' });
    this.notchRoot = h('div', { class: 'hud-bossbar__notches', 'aria-hidden': 'true' });
    this.track = h('div', {
      class: 'hud-bossbar__track', role: 'progressbar', 'aria-label': '보스 HP', 'aria-valuemin': '0', 'aria-valuemax': '100',
    }, [this.fill, this.notchRoot]);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'hud-bossbar__icon');
    svg.setAttribute('aria-hidden', 'true');
    this.shellIcon = document.createElementNS(SVG_NS, 'path');
    svg.append(this.shellIcon);
    this.shellFill = h('div', { class: 'hud-bossbar__shell-fill' });
    this.shellText = h('span', { class: 'hud-bossbar__shell-text' });
    this.shell = h('div', { class: 'hud-bossbar__shell', role: 'group', hidden: true }, [
      svg,
      h('div', { class: 'hud-bossbar__shell-track' }, [this.shellFill]),
      this.shellText,
    ]);

    this.root = h('section', { class: 'hud-bossbar', 'aria-label': '보스', hidden: true }, [
      h('div', { class: 'hud-bossbar__label' }, [h('span', { class: 'hud-bossbar__names' }, [this.title, this.subtitle]), this.phase]),
      this.track,
      this.shell,
    ]);
    parent.append(this.root);
  }

  /** Whether the bar is shown now (tests, layout). */
  get visible(): boolean {
    return this.shown.visible;
  }

  update(model: BossBarModel | null): void {
    const s = this.shown;
    const visible = model !== null;
    if (visible !== s.visible) this.root.hidden = !(s.visible = visible);
    if (model === null) return;
    if (model.title !== s.title) this.title.textContent = s.title = model.title;
    if (model.subtitle !== s.subtitle) this.subtitle.textContent = s.subtitle = model.subtitle;
    if (model.phaseLabel !== s.phase) this.phase.textContent = s.phase = model.phaseLabel;
    const fill = Math.round(model.hpFraction * 1000) / 1000;
    if (fill !== s.fill) this.fill.style.transform = `scaleX(${(s.fill = fill)})`;
    const percent = Math.round(model.hpFraction * 100);
    if (percent !== s.percent) this.track.setAttribute('aria-valuenow', String((s.percent = percent)));
    const notches = model.notches.join(',');
    if (notches !== s.notches) {
      s.notches = notches;
      this.notchRoot.replaceChildren(...model.notches.map((t) => h('span', { class: 'hud-bossbar__notch', style: { left: `${t * 100}%` } })));
    }
    if (model.vulnerable !== s.vulnerable) this.root.classList.toggle('is-vulnerable', (s.vulnerable = model.vulnerable));

    const shell = model.starshell;
    const shellVisible = shell !== null;
    if (shellVisible !== s.shellVisible) this.shell.hidden = !(s.shellVisible = shellVisible);
    if (shell === null) return;
    if (shell.element !== s.shellElement) {
      s.shellElement = shell.element;
      this.shellIcon.setAttribute('d', ICON_PATHS[shell.icon]);
      this.shell.style.setProperty('--shell-color', shell.color);
      this.shell.setAttribute('aria-label', `Starshell · ${shell.elementName}`);
    }
    const shellFill = Math.round(shell.fraction * 1000) / 1000;
    if (shellFill !== s.shellFill) this.shellFill.style.transform = `scaleX(${(s.shellFill = shellFill)})`;
    if (shell.text !== s.shellText) this.shellText.textContent = s.shellText = shell.text;
  }
}
