// Element runtime state of a combat target (design "Element·Reactions", Req 25.4, 25.10–25.12).
// Wraps the pure rules of src/logic/element with the per-target bookkeeping they leave out:
// - Ember mark damage over time: the ATK of whoever left the mark, 5% per second (a tick every 1 s).
// - Tide / Gale / Terra mark modifiers: move speed ×0.8, knockback ×1.5, stagger gain ×1.5.
// - Element_Shield hits (damage already scaled ×0.25 / ×3.0 by computeDamage's shield mode, which matches
//   the outcome's shieldMul) and the 3 s Stagger when durability reaches 0.
// - The Terra reaction shield on the Active_Character: 8% max HP for 5 s, refreshed instead of stacked.
// Mark effects follow the ordinary Element_Mark only; an Element_Shield counts as a mark for reactions
// (logic/element rule 1) but has no applier, so it carries no Ember damage or modifiers.
// All times are sim seconds passed in by the caller; no three.js or DOM.

import type { ElementId, ReactionId } from '../data/ids';
import { MARK_EFFECTS, TERRA_REACTION_SHIELD, terraInvolved } from '../data/reactions';
import { computeDamage, type DamageInput } from '../logic/damage';
import {
  activeMark, applyElement, damageShield, emptyTarget, type ElementOutcome, type ElementTarget,
} from '../logic/element';

/** Stagger after an Element_Shield breaks (Req 25.11); Caelith's Starshell passes its own 6 s (Req 6.5). */
export const SHIELD_BREAK_STAGGER = 3;
/** Ember mark damage is dealt once per this many seconds. */
export const EMBER_DOT_INTERVAL = 1;

/** Attacker stats behind a mark; its ATK sets the Ember damage over time. */
export type MarkSource = Pick<DamageInput, 'baseAtk' | 'level' | 'equipAtkPct'>;

export interface EmberDot {
  source: MarkSource;
  /** Sim time of the next damage tick. */
  nextTickAt: number;
}

/** Mutable per-target record; `element` holds the immutable logic/element value and is replaced on change. */
export interface ElementStatus {
  element: ElementTarget;
  /** Present while an Ember mark left by a character is active. */
  emberDot: EmberDot | null;
  /** Shield-break Stagger lasts while now < breakStaggerUntil. */
  breakStaggerUntil: number;
}

export interface MarkModifiers {
  /** Move speed multiplier (Tide 0.8). */
  moveSpeedMul: number;
  /** Knockback distance multiplier (Gale 1.5). */
  knockbackMul: number;
  /** Stagger gain multiplier (Terra 1.5). */
  staggerMul: number;
}

export function createElementStatus(shield?: { element: ElementId; max: number }): ElementStatus {
  const element = emptyTarget();
  if (shield !== undefined) element.shield = { element: shield.element, durability: shield.max, max: shield.max };
  return { element, emberDot: null, breakStaggerUntil: Number.NEGATIVE_INFINITY };
}

/**
 * Stores `next` (from applyElement or resolveSpread) and keeps the Ember damage source in step with the mark:
 * a new or refreshed Ember mark takes `source` (keeping the running 1 s cadence when one was already ticking),
 * any other mark or none stops the damage. `source` null (environment) leaves an Ember mark without damage.
 */
export function adoptTarget(s: ElementStatus, next: ElementTarget, source: MarkSource | null, now: number): void {
  const before = activeMark(s.element, now);
  const after = activeMark(next, now);
  s.element = next;
  if (after?.element !== 'ember') {
    s.emberDot = null;
    return;
  }
  const changed = before === null || before.element !== 'ember' || before.expiresAt !== after.expiresAt;
  if (!changed) return;
  if (source === null) {
    s.emberDot = null;
    return;
  }
  const running = before?.element === 'ember' ? s.emberDot?.nextTickAt : undefined;
  s.emberDot = { source: { ...source }, nextTickAt: running ?? now + EMBER_DOT_INTERVAL };
}

/** applyElement on the status, storing the result (see adoptTarget for `source`). */
export function applyElementTo(
  s: ElementStatus,
  el: ElementId,
  source: MarkSource | null,
  now: number,
): ElementOutcome {
  const out = applyElement(s.element, el, now);
  adoptTarget(s, out.next, source, now);
  return out;
}

/**
 * Ember mark damage due by `now` against DEF `def`: one computeDamage 'dot' tick (5% ATK, no crit) per full
 * second the Ember mark was active. Returns the total (0 when none); the damage stops with the mark.
 */
export function tickEmberDot(s: ElementStatus, def: number, now: number): number {
  const dot = s.emberDot;
  if (dot === null) return 0;
  const tick = computeDamage({
    ...dot.source,
    dmgMul: MARK_EFFECTS.ember.pct * EMBER_DOT_INTERVAL,
    abilityUpgradePct: 0,
    equipDmgPct: 0,
    def,
    critChance: 0,
    rng01: 0,
    kind: 'dot',
  }).amount;
  let total = 0;
  while (dot.nextTickAt <= now) {
    if (activeMark(s.element, dot.nextTickAt)?.element !== 'ember') {
      s.emberDot = null;
      return total;
    }
    total += tick;
    dot.nextTickAt += EMBER_DOT_INTERVAL;
  }
  if (activeMark(s.element, now)?.element !== 'ember') s.emberDot = null;
  return total;
}

/** Modifiers from the active Element_Mark at `now` (Req 25.4); 1 for everything without one. */
export function markModifiers(t: ElementTarget, now: number): MarkModifiers {
  const mark = activeMark(t, now);
  const mods: MarkModifiers = { moveSpeedMul: 1, knockbackMul: 1, staggerMul: 1 };
  if (mark === null) return mods;
  const effect = MARK_EFFECTS[mark.element];
  if (effect.kind === 'slow') mods.moveSpeedMul = 1 - effect.pct;
  else if (effect.kind === 'knockbackUp') mods.knockbackMul = 1 + effect.pct;
  else if (effect.kind === 'staggerUp') mods.staggerMul = 1 + effect.pct;
  return mods;
}

export interface ShieldStrike {
  /** Damage the shield took (≤ its durability); the rest is `amount − absorbed`. */
  absorbed: number;
  /** Durability reached 0 on this strike: the shield is gone and the break Stagger started. */
  broken: boolean;
}

/**
 * Deals `amount` (final damage, already ×0.25 for the shield's own element or ×3.0 for reaction damage) to the
 * Element_Shield. When it breaks the target is staggered from `now` for `staggerSeconds` (Req 25.11).
 */
export function strikeShield(
  s: ElementStatus,
  amount: number,
  now: number,
  staggerSeconds = SHIELD_BREAK_STAGGER,
): ShieldStrike {
  const shield = s.element.shield;
  if (shield === null) return { absorbed: 0, broken: false };
  const absorbed = Math.min(shield.durability, Math.max(0, amount));
  const { next, broken } = damageShield(s.element, absorbed);
  s.element = next;
  if (broken) s.breakStaggerUntil = now + staggerSeconds;
  return { absorbed, broken };
}

/** Staggered by a shield break at `now`; released exactly at breakStaggerUntil. */
export function isBreakStaggered(s: ElementStatus, now: number): boolean {
  return now < s.breakStaggerUntil;
}

// ── Terra reaction shield (Active_Character) ────────────────────────────────

/** Same shape as RuntimeState.party.shield. */
export interface TimedShield {
  amount: number;
  /** Active while now < until. */
  until: number;
}

export function shieldActive(shield: TimedShield | null, now: number): shield is TimedShield {
  return shield !== null && shield.amount > 0 && now < shield.until;
}

/**
 * After `reaction`: a Terra reaction (lavaRift, mudBind, sandGust) gives 8% of `maxHp` for 5 s (Req 25.12).
 * Repeats never stack: an active shield is topped back up to that amount and its 5 s restart. Other reactions
 * return the current shield (null once expired).
 */
export function grantReactionShield(
  current: TimedShield | null,
  reaction: ReactionId,
  maxHp: number,
  now: number,
): TimedShield | null {
  const active = shieldActive(current, now) ? current : null;
  if (!terraInvolved(reaction)) return active === null ? null : { ...active };
  const amount = Math.max(active?.amount ?? 0, TERRA_REACTION_SHIELD.pctMaxHp * Math.max(0, maxHp));
  return { amount, until: now + TERRA_REACTION_SHIELD.seconds };
}

/** Takes incoming `damage` on the shield first; returns what is left of both. */
export function absorbWithShield(
  current: TimedShield | null,
  damage: number,
  now: number,
): { shield: TimedShield | null; damage: number } {
  const hit = Math.max(0, damage);
  if (!shieldActive(current, now)) return { shield: null, damage: hit };
  const absorbed = Math.min(current.amount, hit);
  const left = current.amount - absorbed;
  return { shield: left > 0 ? { amount: left, until: current.until } : null, damage: hit - absorbed };
}
