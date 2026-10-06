import './combatHud.css';
import type { ElementId, ReactionId } from '../data/ids';
import { REACTION_DEFS, REACTION_PRESENTATION } from '../data/reactions';
import { h } from './dom';
import type { HudAbilitiesModel, HudModel, HudSlotModel, HudVitalsModel } from './hudModel';
import { ICON_LABELS, icon } from './icons';

/** Which ability icon a refusal highlights. */
export type HudAbility = 'skill' | 'burst';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Circle sweeps use pathLength 100, so the dash offset is the hidden share × 100. */
const SWEEP = 100;

const round3 = (v: number): number => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;

/** A round SVG gauge: a faint track and an arc whose `stroke-dashoffset` is written (no layout). */
function sweepSvg(className: string, radius: number, width: number): { svg: SVGSVGElement; arc: SVGCircleElement } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const circle = (cls: string): SVGCircleElement => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '20');
    c.setAttribute('cy', '20');
    c.setAttribute('r', String(radius));
    c.setAttribute('stroke-width', String(width));
    c.setAttribute('pathLength', String(SWEEP));
    return c;
  };
  const arc = circle('hud-sweep__arc');
  arc.setAttribute('stroke-dasharray', String(SWEEP));
  arc.setAttribute('stroke-dashoffset', String(SWEEP));
  svg.append(circle('hud-sweep__track'), arc);
  return { svg, arc };
}

interface SlotElements {
  root: HTMLElement;
  frame: HTMLElement;
  initial: HTMLElement;
  element: HTMLElement;
  hpFill: HTMLElement;
  skillArc: SVGCircleElement;
  star: HTMLElement;
  lockArc: SVGCircleElement;
  lock: SVGSVGElement;
  preview: HTMLElement;
  shown: {
    state: string; label: string; element: ElementId | null; hp: number; low: boolean; skill: number; burstFull: boolean;
    lock: number; preview: ReactionId | null; shakeSeq: number; shakeOdd: boolean; initial: string;
  };
}

interface AbilityElements {
  root: HTMLElement;
  arc: SVGCircleElement;
  value: HTMLElement;
  key: HTMLElement;
  shown: { fill: number; value: string; key: string; ready: boolean; label: string; refusedOdd: boolean };
}

/*
 * Combat HUD (design "HUD 레이아웃" / "표시 규칙", task 14.3), drawn from the frame's HudModel (./hudModel):
 * - Bottom centre (480 × 40): the Active_Character's name, "Lv N" and HP bar (red below 30 %).
 * - Bottom left, one row of four 72 × 92 party slots: the 64 × 64 portrait with the switch key and the Element icon
 *   on its top corners, the HP bar, and a status line with the Skill cooldown sweep and the Burst four-point star
 *   (lit at full Energy). Downed: grey portrait, a broken star and "쓰러짐". The Active_Character's slot has the gold
 *   frame, unjoined slots are dim empty frames. Standby slots show the 0.8 s switch-lock radial sweep (Req 23.3), a
 *   0.25 s shake on a refused switch (Req 23.2) and the reaction preview badge (Req 23.9).
 * - Bottom right: Skill ⌀76 (dark sweep for the cooldown left and its seconds) and Burst ⌀92 (Energy ring, gold
 *   glow while full, a flare on the tick it fills, Req 32.7), with a 0.3 s red flash on a refused press (Req 24.5).
 * - Out of combat the slots and icons follow `combatAlpha` (50 % from 5 s, Req 32.3).
 * Sizes come from the layout table's CSS variables (./hudLayout). Only changed classes, text, `transform`,
 * `opacity` and `stroke-dashoffset` are written; nothing is read from layout. The Caelith bar is ./bossBar.
 */
export class CombatHud {
  private readonly vitalsName: HTMLElement;
  private readonly vitalsLevel: HTMLElement;
  private readonly vitalsValue: HTMLElement;
  private readonly vitalsFill: HTMLElement;
  private readonly partyRoot: HTMLElement;
  private readonly abilitiesRoot: HTMLElement;
  private readonly slotEls: SlotElements[] = [];
  private readonly abilityEls: Record<HudAbility, AbilityElements>;
  private readonly portraits: (string | null)[] = [null, null, null, null];
  private shown = { name: '', level: '', value: '', fill: -1, low: false, alpha: -1, flareSeq: 0, flareOdd: false };

  constructor(parent: HTMLElement) {
    this.vitalsName = h('span', { class: 'hud-vitals__name' });
    this.vitalsLevel = h('span', { class: 'hud-vitals__level' });
    this.vitalsValue = h('span', { class: 'hud-vitals__value' });
    this.vitalsFill = h('div', { class: 'hud-vitals__fill' });
    const vitals = h('div', { class: 'hud-vitals' }, [
      h('div', { class: 'hud-vitals__label' }, [h('span', { class: 'hud-vitals__who' }, [this.vitalsName, this.vitalsLevel]), this.vitalsValue]),
      h('div', { class: 'hud-vitals__track' }, [this.vitalsFill]),
    ]);

    this.partyRoot = h('div', { class: 'hud-party' });
    for (let i = 0; i < 4; i++) this.slotEls.push(this.buildSlot(i));

    this.abilitiesRoot = h('div', { class: 'hud-abilities' });
    this.abilityEls = { skill: this.buildAbility('skill', 'Skill', 17, 6), burst: this.buildAbility('burst', 'Burst', 18, 3) };
    parent.append(vitals, this.partyRoot, this.abilitiesRoot);
  }

  private buildSlot(i: number): SlotElements {
    const initial = h('span', { class: 'hud-slot__initial', 'aria-hidden': 'true' });
    const element = h('span', { class: 'hud-slot__element', 'aria-hidden': 'true' });
    const lock = sweepSvg('hud-slot__lock', 17, 4);
    const frame = h('div', { class: 'hud-slot__portrait' }, [
      initial,
      lock.svg,
      h('span', { class: 'hud-slot__key', 'aria-hidden': 'true' }, [String(i + 1)]),
      element,
      h('span', { class: 'hud-slot__downed', 'aria-hidden': 'true' }, [h('span', { class: 'hud-slot__broken-star' }), '쓰러짐']),
    ]);
    const hpFill = h('div', { class: 'hud-slot__fill' });
    const skill = sweepSvg('hud-slot__skill', 15, 8);
    const star = h('span', { class: 'hud-slot__star', 'aria-hidden': 'true' });
    const preview = h('span', { class: 'hud-slot__preview', role: 'img', hidden: true });
    const root = h('div', { class: 'hud-slot is-empty', role: 'img', 'aria-label': `${i + 1}번 슬롯: 비어 있음` }, [
      frame,
      h('div', { class: 'hud-slot__track' }, [hpFill]),
      h('div', { class: 'hud-slot__status' }, [skill.svg, star]),
      preview,
    ]);
    this.partyRoot.append(root);
    return {
      root, frame, initial, element, hpFill, skillArc: skill.arc, star, lockArc: lock.arc, lock: lock.svg, preview,
      shown: {
        state: 'is-empty', label: '', element: null, hp: -1, low: false, skill: -1, burstFull: false, lock: -1, preview: null,
        shakeSeq: 0, shakeOdd: false, initial: '',
      },
    };
  }

  private buildAbility(kind: HudAbility, title: string, radius: number, width: number): AbilityElements {
    const sweep = sweepSvg('hud-ability__ring', radius, width);
    const value = h('span', { class: 'hud-ability__value' });
    const key = h('span', { class: 'hud-ability__key' });
    const root = h('div', { class: `hud-ability hud-ability--${kind}`, role: 'img', 'aria-label': title }, [
      sweep.svg,
      h('span', { class: 'hud-ability__name', 'aria-hidden': 'true' }, [title]),
      value,
      key,
    ]);
    this.abilitiesRoot.append(root);
    return { root, arc: sweep.arc, value, key, shown: { fill: -1, value: '', key: '', ready: false, label: '', refusedOdd: false } };
  }

  /**
   * Tasks 19.2 / 19.7: the portrait image (a 64 × 64 data URL rendered from the hero's model) of party slot `slot`
   * (0–3, PARTY_SLOTS order); null removes it and the name's initial shows instead. Decorative: the slot's label
   * carries the meaning.
   */
  setPortrait(slot: number, src: string | null): void {
    const e = this.slotEls[slot];
    if (e === undefined) return;
    this.portraits[slot] = src;
    let img = e.frame.querySelector<HTMLImageElement>('img.hud-slot__img');
    if (src === null) {
      img?.remove();
      e.initial.hidden = false;
      return;
    }
    if (img === null) {
      img = document.createElement('img');
      img.className = 'hud-slot__img';
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      img.width = 64;
      img.height = 64;
      e.frame.prepend(img);
    }
    img.src = src;
    e.initial.hidden = true;
  }

  /** A refused Skill or Burst press: the icon flashes red for 0.3 s (Req 24.5). */
  refused(kind: HudAbility): void {
    const s = this.abilityEls[kind].shown;
    // Alternating between two identical keyframe classes restarts the animation without a layout read.
    s.refusedOdd = !s.refusedOdd;
    this.abilityEls[kind].root.classList.toggle('is-refused-a', s.refusedOdd);
    this.abilityEls[kind].root.classList.toggle('is-refused-b', !s.refusedOdd);
  }

  update(model: HudModel): void {
    this.updateVitals(model.vitals);
    model.party.forEach((slot, i) => this.updateSlot(i, slot));
    this.updateAbilities(model.abilities, model.burstFlareSeq);
    const alpha = Math.round(model.combatAlpha * 100) / 100;
    if (alpha !== this.shown.alpha) {
      this.shown.alpha = alpha;
      this.partyRoot.style.opacity = String(alpha);
      this.abilitiesRoot.style.opacity = String(alpha);
    }
  }

  private updateVitals(v: HudVitalsModel): void {
    const s = this.shown;
    if (v.name !== s.name) this.vitalsName.textContent = s.name = v.name;
    const level = `Lv ${v.level}`;
    if (level !== s.level) this.vitalsLevel.textContent = s.level = level;
    const value = `HP ${v.hp} / ${v.maxHp}`;
    if (value !== s.value) this.vitalsValue.textContent = s.value = value;
    const fill = round3(v.fraction);
    if (fill !== s.fill) this.vitalsFill.style.transform = `scaleX(${(s.fill = fill)})`;
    if (v.low !== s.low) this.vitalsFill.classList.toggle('is-low', (s.low = v.low));
  }

  private updateSlot(i: number, slot: HudSlotModel): void {
    const e = this.slotEls[i];
    if (e === undefined) return;
    const s = e.shown;
    const state = `is-${slot.state}`;
    if (state !== s.state) {
      e.root.classList.remove(s.state);
      e.root.classList.add(state);
      s.state = state;
    }
    const label = slot.state === 'empty'
      ? `${slot.slot}번 슬롯: 비어 있음`
      : `${slot.slot}번 ${slot.name}${slot.state === 'downed' ? ' 쓰러짐' : slot.state === 'active' ? ' 조작 중' : ''}`;
    if (label !== s.label) e.root.setAttribute('aria-label', (s.label = label));
    const initial = slot.state === 'empty' ? '' : slot.name.slice(0, 1);
    if (initial !== s.initial) e.initial.textContent = s.initial = initial;
    const element = slot.state === 'empty' ? null : slot.element;
    if (element !== s.element) {
      s.element = element;
      e.element.replaceChildren(...(element === null ? [] : [icon(element, { label: ICON_LABELS[element] })]));
    }
    const hp = round3(slot.hp);
    if (hp !== s.hp) e.hpFill.style.transform = `scaleX(${(s.hp = hp)})`;
    if (slot.low !== s.low) e.hpFill.classList.toggle('is-low', (s.low = slot.low));
    const skill = round3(slot.skill);
    if (skill !== s.skill) e.skillArc.setAttribute('stroke-dashoffset', String(SWEEP * (1 - (s.skill = skill))));
    if (slot.burstFull !== s.burstFull) e.star.classList.toggle('is-lit', (s.burstFull = slot.burstFull));
    const lock = round3(slot.lock);
    if (lock !== s.lock) {
      s.lock = lock;
      e.lockArc.setAttribute('stroke-dashoffset', String(SWEEP * (1 - lock)));
      e.lock.classList.toggle('is-shown', lock > 0);
    }
    this.updatePreview(e, slot.preview);
    if (slot.shakeSeq !== s.shakeSeq) {
      s.shakeSeq = slot.shakeSeq;
      s.shakeOdd = !s.shakeOdd;
      e.root.classList.toggle('is-shake-a', s.shakeOdd);
      e.root.classList.toggle('is-shake-b', !s.shakeOdd);
    }
  }

  /** The slot's reaction preview badge: the reaction's name in its colour, hidden for null (Req 23.9). */
  private updatePreview(e: SlotElements, reaction: ReactionId | null): void {
    if (reaction === e.shown.preview) return;
    e.shown.preview = reaction;
    e.preview.hidden = reaction === null;
    if (reaction === null) return;
    const name = REACTION_DEFS[reaction].name;
    e.preview.textContent = name;
    e.preview.setAttribute('aria-label', `반응 예고: ${name}`);
    e.preview.style.setProperty('--reaction-color', `#${REACTION_PRESENTATION[reaction].color.toString(16).padStart(6, '0')}`);
  }

  private updateAbilities(a: HudAbilitiesModel, flareSeq: number): void {
    const { skill, burst } = a;
    // Skill: the dark sweep covers the share of the cooldown still to run.
    this.updateAbility(this.abilityEls.skill, {
      fill: skill.ready ? 0 : skill.fraction,
      value: skill.ready ? '' : `${skill.seconds}s`,
      key: skill.key,
      ready: skill.ready,
      label: skill.ready ? 'Skill 사용 가능' : `Skill 재사용 대기 ${skill.seconds}초`,
    });
    // Burst: the ring fills with Energy.
    this.updateAbility(this.abilityEls.burst, {
      fill: burst.fraction,
      value: `${burst.energy}/${burst.cost}`,
      key: burst.key,
      ready: burst.ready,
      label: burst.ready ? 'Burst 사용 가능' : `Burst Energy ${burst.energy}/${burst.cost}`,
    });
    const s = this.shown;
    if (flareSeq !== s.flareSeq) {
      // The tick Energy reached max (Req 32.7): restart the flare by alternating two identical keyframe classes.
      s.flareSeq = flareSeq;
      s.flareOdd = !s.flareOdd;
      const root = this.abilityEls.burst.root;
      root.classList.toggle('is-flare-a', s.flareOdd);
      root.classList.toggle('is-flare-b', !s.flareOdd);
    }
  }

  private updateAbility(e: AbilityElements, next: { fill: number; value: string; key: string; ready: boolean; label: string }): void {
    const s = e.shown;
    const fill = round3(next.fill);
    if (fill !== s.fill) e.arc.setAttribute('stroke-dashoffset', String(SWEEP * (1 - (s.fill = fill))));
    if (next.value !== s.value) e.value.textContent = s.value = next.value;
    if (next.key !== s.key) e.key.textContent = s.key = next.key;
    if (next.ready !== s.ready) e.root.classList.toggle('is-ready', (s.ready = next.ready));
    if (next.label !== s.label) e.root.setAttribute('aria-label', (s.label = next.label));
  }
}
