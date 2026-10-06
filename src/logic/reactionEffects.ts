// Reaction effect numbers, the chain label and the HUD reaction preview (design "Reaction 효과", "확산과 연쇄",
// "반응 예고와 도감"; Req 25.7, 25.9, 23.9). Pure: `now` and every state are passed in.

import { distance, type Vec3 } from '../core/math';
import type { CharacterId, ElementId, ReactionId } from '../data/ids';
import { CHAIN_DISPLAY } from '../data/reactions';
import { computeDamage, type DamageInput } from './damage';
import { activeMark, previewReaction, type ElementTarget } from './element';

/** Stats of the character whose Element started the reaction (its ATK scales ATK-based reaction damage). */
export type ReactorStats = Pick<DamageInput, 'baseAtk' | 'level' | 'equipAtkPct' | 'abilityUpgradePct' | 'equipDmgPct'> &
  Pick<Partial<DamageInput>, 'reactionDamagePct'>;

/**
 * Damage scaled from the trigger hit's final damage (steamBurst: ×1.5 on the target, ×0.6 around it): rounded,
 * at least 1 whenever the trigger dealt damage, 0 without a trigger.
 */
export function triggerScaledDamage(triggerDamage: number, mul: number): number {
  if (!(triggerDamage > 0) || !(mul > 0)) return 0;
  return Math.max(1, Math.round(triggerDamage * mul));
}

/**
 * ATK-based reaction damage against DEF `def`: computeDamage with the reactor's stats and `atkMul` as dmgMul.
 * Kind 'reaction' (flameSpread / sandGust 80%) or 'dot' (lavaRift ticks 25%); no crit roll either way.
 */
export function reactionAtkDamage(reactor: ReactorStats, atkMul: number, def: number, kind: 'reaction' | 'dot'): number {
  return computeDamage({
    baseAtk: reactor.baseAtk,
    level: reactor.level,
    equipAtkPct: reactor.equipAtkPct,
    abilityUpgradePct: reactor.abilityUpgradePct,
    equipDmgPct: reactor.equipDmgPct,
    reactionDamagePct: reactor.reactionDamagePct,
    dmgMul: atkMul,
    def,
    critChance: 0,
    rng01: 0,
    kind,
  }).amount;
}

/** "연쇄 x{n}" for n ≥ CHAIN_DISPLAY.minCount reactions from one application, else null (Req 25.7). */
export function chainLabel(count: number): string | null {
  return Number.isInteger(count) && count >= CHAIN_DISPLAY.minCount ? `연쇄 x${count}` : null;
}

// ── Reaction preview (Req 23.9) ─────────────────────────────────────────────

export interface PreviewCandidate {
  id: string;
  pos: Readonly<Vec3>;
  alive: boolean;
  element: ElementTarget;
}

/** Holds an active Element_Mark or an Element_Shield (which counts as a permanent mark). */
export function hasMark(t: ElementTarget, now: number): boolean {
  return t.shield !== null || activeMark(t, now) !== null;
}

/**
 * The target the HUD previews against: the living Lock-on target when it is a candidate, otherwise the nearest
 * living candidate holding a mark (ties by id). Null when there is none.
 */
export function previewTarget(
  candidates: readonly PreviewCandidate[],
  lockId: string | null,
  from: Readonly<Vec3>,
  now: number,
): PreviewCandidate | null {
  if (lockId !== null) {
    const locked = candidates.find((c) => c.id === lockId && c.alive);
    if (locked !== undefined) return locked;
  }
  let best: PreviewCandidate | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (!c.alive || !hasMark(c.element, now)) continue;
    const d = distance(from, c.pos);
    if (d < bestD || (d === bestD && best !== null && c.id < best.id)) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export interface PreviewSlotInput {
  characterId: CharacterId;
  element: ElementId;
  /** Joined, not the Active_Character and not Downed. */
  standby: boolean;
}

export interface ReactionPreviewSlot {
  characterId: CharacterId;
  /** The reaction switching in and applying this character's Element would cause now, else null (icon hidden). */
  reaction: ReactionId | null;
}

/** previewReaction for every standby slot against `target` (null target or non-standby slot: null). */
export function reactionPreviews(
  target: ElementTarget | null,
  slots: readonly PreviewSlotInput[],
  now: number,
): ReactionPreviewSlot[] {
  return slots.map((s) => ({
    characterId: s.characterId,
    reaction: target !== null && s.standby ? previewReaction(target, s.element, now) : null,
  }));
}
