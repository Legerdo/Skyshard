import './enemyBars.css';
import type { Vec3 } from '../core/types';
import type { ElementId } from '../data/ids';
import { h } from './dom';
import type { EnemyBarModel } from './hudModel';
import { ICON_LABELS, icon } from './icons';

/** Normalised device coordinates of a world point, or null behind the camera / off screen. */
export type ProjectPoint = (world: Readonly<Vec3>) => { readonly x: number; readonly y: number } | null;

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING = 100;
const round3 = (v: number): number => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;

interface BarElements {
  root: HTMLElement;
  name: HTMLElement;
  shield: HTMLElement;
  shieldFill: HTMLElement;
  hpFill: HTMLElement;
  mark: HTMLElement;
  markIcon: HTMLElement;
  ring: SVGCircleElement;
  ringSvg: SVGSVGElement;
  shown: {
    id: string | null; visible: boolean; elite: boolean; name: string; hp: number; low: boolean; locked: boolean;
    shieldElement: ElementId | null; shield: number; markElement: ElementId | null; ring: number | null; x: string; y: string;
  };
}

/*
 * Enemy HP bars (design "적·보스 표시", task 14.3, Req 32.5, 25.2): a DOM pool of HUD_WORLD_BARS.pool (12) bars fed
 * by the HudModel's `enemyBars` (which enemy holds which slot, and what it shows). Each bar floats over its enemy's
 * head (projected every render frame, moved with `transform` only; hidden behind the camera): 96 × 8 HP bar, or
 * 128 × 10 with the name above it for Elites; an Element_Shield adds its durability bar in the shield's colour above
 * the HP bar; the Element_Mark icon sits at the bar's left with its 8 s ring (fixed to the shield's Element, no ring,
 * while a shield stands). The Lock-on target's bar has a gold edge. Nothing reads layout.
 */
export class EnemyBars {
  private readonly root: HTMLElement;
  private readonly bars: BarElements[] = [];

  constructor(parent: HTMLElement, pool: number) {
    this.root = h('div', { class: 'hud-enemy-bars', 'aria-hidden': 'true' });
    for (let i = 0; i < pool; i++) this.bars.push(this.build());
    parent.append(this.root);
  }

  private build(): BarElements {
    const name = h('span', { class: 'hud-enemy-bar__name' });
    const shieldFill = h('div', { class: 'hud-enemy-bar__shield-fill' });
    const shield = h('div', { class: 'hud-enemy-bar__shield', hidden: true }, [shieldFill]);
    const hpFill = h('div', { class: 'hud-enemy-bar__fill' });
    const ringSvg = document.createElementNS(SVG_NS, 'svg');
    ringSvg.setAttribute('class', 'hud-enemy-bar__ring');
    ringSvg.setAttribute('viewBox', '0 0 20 20');
    const ring = document.createElementNS(SVG_NS, 'circle');
    for (const [k, v] of Object.entries({ cx: '10', cy: '10', r: '8.5', pathLength: String(RING), 'stroke-dasharray': String(RING), 'stroke-dashoffset': '0' })) ring.setAttribute(k, v);
    ringSvg.append(ring);
    const markIcon = h('span', { class: 'hud-enemy-bar__mark-icon' });
    const mark = h('span', { class: 'hud-enemy-bar__mark', hidden: true }, [ringSvg, markIcon]);
    const root = h('div', { class: 'hud-enemy-bar' }, [
      h('div', { class: 'hud-enemy-bar__body' }, [
        name,
        shield,
        h('div', { class: 'hud-enemy-bar__row' }, [mark, h('div', { class: 'hud-enemy-bar__track' }, [hpFill])]),
      ]),
    ]);
    this.root.append(root);
    return {
      root, name, shield, shieldFill, hpFill, mark, markIcon, ring, ringSvg,
      shown: {
        id: null, visible: true, elite: false, name: '', hp: -1, low: false, locked: false, shieldElement: null, shield: -1,
        markElement: null, ring: null, x: '', y: '',
      },
    };
  }

  /** One render frame: the pool's models (null = hidden) and the camera projection. */
  update(models: readonly (EnemyBarModel | null)[], project: ProjectPoint): void {
    this.bars.forEach((e, i) => this.updateBar(e, models[i] ?? null, project));
  }

  private updateBar(e: BarElements, m: EnemyBarModel | null, project: ProjectPoint): void {
    const s = e.shown;
    const at = m === null ? null : project(m.head);
    const visible = m !== null && at !== null;
    if (visible !== s.visible) {
      s.visible = visible;
      e.root.style.visibility = visible ? 'visible' : 'hidden';
    }
    if (m === null || at === null) {
      s.id = m?.id ?? null;
      return;
    }
    s.id = m.id;
    if (m.elite !== s.elite) e.root.classList.toggle('is-elite', (s.elite = m.elite));
    if (m.name !== s.name) e.name.textContent = s.name = m.name;
    if (m.locked !== s.locked) e.root.classList.toggle('is-locked', (s.locked = m.locked));
    const hp = round3(m.hp);
    if (hp !== s.hp) e.hpFill.style.transform = `scaleX(${(s.hp = hp)})`;
    if (m.low !== s.low) e.hpFill.classList.toggle('is-low', (s.low = m.low));

    const shieldElement = m.shield?.element ?? null;
    if (shieldElement !== s.shieldElement) {
      s.shieldElement = shieldElement;
      e.shield.hidden = shieldElement === null;
      if (shieldElement !== null) e.shield.dataset.element = shieldElement;
    }
    const shield = round3(m.shield?.fraction ?? 0);
    if (shield !== s.shield) e.shieldFill.style.transform = `scaleX(${(s.shield = shield)})`;

    const markElement = m.mark?.element ?? null;
    if (markElement !== s.markElement) {
      s.markElement = markElement;
      e.mark.hidden = markElement === null;
      if (markElement !== null) {
        e.mark.dataset.element = markElement;
        e.markIcon.replaceChildren(icon(markElement, { label: `${ICON_LABELS[markElement]} 표식` }));
      }
    }
    const ring = m.mark?.ring ?? null;
    const ringRounded = ring === null ? null : round3(ring);
    if (ringRounded !== s.ring) {
      s.ring = ringRounded;
      e.ringSvg.style.visibility = ringRounded === null ? 'hidden' : 'visible';
      if (ringRounded !== null) e.ring.setAttribute('stroke-dashoffset', String(RING * (1 - ringRounded)));
    }

    const x = `${((at.x + 1) * 50).toFixed(2)}vw`;
    const y = `${((1 - at.y) * 50).toFixed(2)}vh`;
    if (x !== s.x || y !== s.y) {
      s.x = x;
      s.y = y;
      e.root.style.transform = `translate3d(${x}, ${y}, 0)`;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
