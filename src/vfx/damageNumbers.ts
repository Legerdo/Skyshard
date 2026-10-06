// Floating damage numbers and Reaction names (design "타격 피드백"; Req 26.1, 26.2, 26.8, 25.9, 35.7). A pool of 24
// aria-hidden DOM elements is made once; the 25th request takes back the oldest. A number shows in its Element's
// colour next to the Element icon (never colour alone), rises and fades over 0.8 s; a crit is 1.5× larger with a gold
// outline and a short pop. A Reaction's Korean name takes an element from the same pool for 1.0 s. Each frame only
// the elements' `transform` and `opacity` change (screen position projected by the caller).
//
// `DamageNumberPool` is the DOM-free model (tests); `DamageNumbers` renders it.

import type { Vec3 } from '../core/types';
import type { ElementId, ReactionId } from '../data/ids';
import { ELEMENT_DEFS } from '../data/elements';
import {
  CRIT_NUMBER_SCALE, DAMAGE_NUMBER_POOL_SIZE, DAMAGE_NUMBER_SECONDS, REACTION_FX, REACTION_LABEL_SECONDS,
} from './catalog';

export type FloatKind = 'damage' | 'reaction';

export interface FloatSlot {
  active: boolean;
  serial: number;
  kind: FloatKind;
  text: string;
  /** 0xRRGGBB. */
  color: number;
  element: ElementId | null;
  crit: boolean;
  /** World anchor (m). */
  pos: Vec3;
  /** Seconds shown. */
  t: number;
  life: number;
  /** Sideways drift (px at the end) so stacked numbers separate. */
  drift: number;
  /** The DOM text / look must be rewritten. */
  dirty: boolean;
}

/** Numbers without an Element (physical hits) show in white. */
const NEUTRAL = 0xffffff;
const DRIFT = [-18, 14, -8, 20, 4, -22, 10, -14];

/** Scale of a number at `k` = t / life: a crit pops to 1.25× its size over the first 15 %. */
export function floatScale(slot: Readonly<Pick<FloatSlot, 'crit' | 'kind'>>, k: number): number {
  if (slot.kind === 'reaction') return 1;
  if (!slot.crit) return 1;
  const pop = k < 0.15 ? 1 + 0.25 * Math.sin((k / 0.15) * Math.PI) : 1;
  return CRIT_NUMBER_SCALE * pop;
}

/** Opacity at `k`: full until 60 %, then fading out. */
export function floatOpacity(k: number): number {
  return k < 0.6 ? 1 : Math.max(0, (1 - k) / 0.4);
}

export class DamageNumberPool {
  readonly slots: FloatSlot[] = [];
  private serial = 0;

  constructor(size = DAMAGE_NUMBER_POOL_SIZE) {
    for (let i = 0; i < size; i++) {
      this.slots.push({
        active: false, serial: 0, kind: 'damage', text: '', color: NEUTRAL, element: null, crit: false,
        pos: { x: 0, y: 0, z: 0 }, t: 0, life: 0, drift: 0, dirty: false,
      });
    }
  }

  get activeCount(): number {
    return this.slots.filter((s) => s.active).length;
  }

  /** A damage number of `amount` over `pos`. Returns its slot index. */
  damage(amount: number, element: ElementId | null, crit: boolean, pos: Readonly<Vec3>): number {
    const text = String(Math.max(0, Math.round(amount)));
    return this.take('damage', text, element === null ? NEUTRAL : ELEMENT_DEFS[element].color, element, crit, pos, DAMAGE_NUMBER_SECONDS);
  }

  /** The Reaction's Korean name over `pos` for 1.0 s. */
  reaction(reaction: ReactionId, pos: Readonly<Vec3>): number {
    const fx = REACTION_FX[reaction];
    return this.take('reaction', fx.label, fx.color, null, false, pos, REACTION_LABEL_SECONDS);
  }

  /** Ages every slot by `dt` s; finished ones are freed. */
  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue;
      s.t += dt;
      if (s.t >= s.life) s.active = false;
    }
  }

  clear(): void {
    for (const s of this.slots) s.active = false;
  }

  private take(
    kind: FloatKind, text: string, color: number, element: ElementId | null, crit: boolean, pos: Readonly<Vec3>, life: number,
  ): number {
    let index = this.slots.findIndex((s) => !s.active);
    if (index < 0) {
      index = 0;
      for (let i = 1; i < this.slots.length; i++) {
        if ((this.slots[i] as FloatSlot).serial < (this.slots[index] as FloatSlot).serial) index = i;
      }
    }
    const s = this.slots[index] as FloatSlot;
    this.serial++;
    s.active = true;
    s.serial = this.serial;
    s.kind = kind;
    s.text = text;
    s.color = color;
    s.element = element;
    s.crit = crit;
    s.pos = { x: pos.x, y: pos.y, z: pos.z };
    s.t = 0;
    s.life = life;
    s.drift = DRIFT[this.serial % DRIFT.length] as number;
    s.dirty = true;
    return index;
  }
}

/** A screen point in CSS pixels, or null off screen. */
export type ProjectPx = (pos: Readonly<Vec3>) => { x: number; y: number } | null;

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/** Rises this many px over its life. */
const RISE_PX = { damage: 56, reaction: 40 } as const;

/** Element icon glyph paths (24 × 24; the HUD's icon sprite may not be in this document). */
const ICON_PATHS: Readonly<Record<ElementId, string>> = {
  ember: 'M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-3 2-4 2-7 1 1 2 2 2 4 1-2 1-5 1-8z',
  tide: 'M3 9c3-3 6 3 9 0s6 3 9 0M3 14c3-3 6 3 9 0s6 3 9 0M3 19c3-3 6 3 9 0s6 3 9 0',
  gale: 'M12 12m-2 0a2 2 0 1 0 4 0a4 4 0 1 0-8 0a6 6 0 1 0 12 0a8 8 0 1 0-16 0',
  terra: 'M12 2l8.7 5v10L12 22l-8.7-5V7z',
};

export class DamageNumbers {
  readonly pool: DamageNumberPool;
  private readonly root: HTMLDivElement;
  private readonly els: { el: HTMLDivElement; text: HTMLSpanElement; icon: SVGSVGElement; path: SVGPathElement; shown: boolean }[] = [];

  constructor(parent: HTMLElement, pool = new DamageNumberPool()) {
    this.pool = pool;
    const doc = parent.ownerDocument;
    this.root = doc.createElement('div');
    this.root.className = 'vfx-floats';
    this.root.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < pool.slots.length; i++) {
      const el = doc.createElement('div');
      el.className = 'vfx-float';
      el.setAttribute('aria-hidden', 'true');
      el.style.opacity = '0';
      const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('class', 'vfx-float__icon');
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      icon.append(path);
      const text = doc.createElement('span');
      text.className = 'vfx-float__text';
      el.append(icon, text);
      this.root.append(el);
      this.els.push({ el, text, icon, path, shown: false });
    }
    parent.append(this.root);
  }

  /** Advances the pool by `dt` and places every live element through `project`. */
  update(dt: number, project: ProjectPx): void {
    this.pool.update(dt);
    this.pool.slots.forEach((s, i) => {
      const view = this.els[i];
      if (view === undefined) return;
      const at = s.active ? project(s.pos) : null;
      if (at === null) {
        if (view.shown) {
          view.el.style.opacity = '0';
          view.shown = false;
        }
        return;
      }
      if (s.dirty) {
        s.dirty = false;
        view.text.textContent = s.text;
        view.el.style.color = hex(s.color);
        view.el.classList.toggle('is-crit', s.crit);
        view.el.classList.toggle('is-reaction', s.kind === 'reaction');
        const icon = s.kind === 'damage' ? s.element : null;
        view.icon.style.display = icon === null ? 'none' : '';
        if (icon !== null) {
          view.path.setAttribute('d', ICON_PATHS[icon]);
          view.path.setAttribute('fill', icon === 'tide' || icon === 'gale' ? 'none' : 'currentColor');
          view.path.setAttribute('stroke', 'currentColor');
          view.path.setAttribute('stroke-width', icon === 'tide' || icon === 'gale' ? '2.4' : '1');
        }
      }
      const k = s.life > 0 ? s.t / s.life : 1;
      const rise = RISE_PX[s.kind] * (1 - (1 - k) * (1 - k));
      const x = at.x + s.drift * k;
      const y = at.y - rise;
      view.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%) scale(${floatScale(s, k).toFixed(3)})`;
      view.el.style.opacity = floatOpacity(k).toFixed(2);
      view.shown = true;
    });
  }

  dispose(): void {
    this.root.remove();
  }
}
