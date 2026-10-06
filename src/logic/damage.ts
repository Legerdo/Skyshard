// Damage formula (design: 피해 공식; Req 24.10, 25.4, 25.10, 28.10, 28.11, 6.5).
// Pure: the crit roll arrives pre-drawn in `rng01`, so the same input always gives the same result.
// Enemy→player hits use the same function with kind 'enemy', the character's DEF and critChance 0.

import { clamp } from '../core/math';

/** 'dot' = damage-over-time ticks (e.g. lava zones), 'hazard' = environmental damage. */
export type DamageKind = 'normal' | 'charged' | 'skill' | 'burst' | 'reaction' | 'dot' | 'enemy' | 'hazard';

/** One hit, with target state sampled at impact. Percentages are fractions (0.2 = +20%). */
export interface DamageInput {
  baseAtk: number;
  /** Clamped to 1..10; effective ATK compounds ×1.06 per level. */
  level: number;
  equipAtkPct: number;
  /** Ability multiplier of the HitEvent. */
  dmgMul: number;
  abilityUpgradePct: number;
  equipDmgPct: number;
  /** Target DEF including equipment; clamped to ≥ 0. */
  def: number;
  /** Clamped to [0, 1]; 'dot' / 'enemy' / 'hazard' pass 0, so they never crit. */
  critChance: number;
  /** A pre-drawn uniform in [0, 1), e.g. the combat Rng stream's next(). */
  rng01: number;
  kind: DamageKind;
  /** Mossback Brute front guard: ×0.3 against 'normal' hits. */
  frontGuard?: boolean;
  /** Element_Shield: same Element ×0.25, Reaction damage ×3; 'other' / null ×1. */
  shield?: 'same' | 'reaction' | 'other' | null;
  /** Caelith after the Starshell breaks: ×1.5. */
  vulnerable?: boolean;
  /** Extra damage bonus, added for kind 'reaction' only. */
  reactionDamagePct?: number;
}

export interface DamageResult {
  /** Final damage: an integer ≥ 1. */
  amount: number;
  crit: boolean;
  /** Base damage before DEF, crit and situational multipliers: atkEff × dmgMul × (1 + bonuses). */
  raw: number;
}

/** Base crit chance of the Player_Characters before equipment bonuses (Req 24.10). */
export const BASE_CRIT_CHANCE = 0.05;
export const CRIT_MULTIPLIER = 1.5;
export const LEVEL_ATK_GROWTH = 1.06;
export const FRONT_GUARD_MUL = 0.3;
export const SHIELD_SAME_MUL = 0.25;
export const SHIELD_REACTION_MUL = 3;
export const VULNERABLE_MUL = 1.5;
export const TERRA_STAGGER_MUL = 1.5;

const MIN_LEVEL = 1;
const MAX_LEVEL = 10;
const DEF_SCALE = 100;
/** Largest double below 1: rolls are clamped into [0, 1) so critChance 1 always crits. */
const MAX_ROLL = 1 - Number.EPSILON / 2;

/** Non-finite (or non-number) → 0. */
function finite(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

/** Non-finite or negative → 0. */
function nonNeg(x: number): number {
  return Math.max(0, finite(x));
}

/** Product of the situational multipliers (front guard, Element_Shield, vulnerable). */
function situationalMul(i: DamageInput): number {
  let mul = 1;
  if (i.frontGuard === true && i.kind === 'normal') mul *= FRONT_GUARD_MUL;
  if (i.shield === 'same') mul *= SHIELD_SAME_MUL;
  else if (i.shield === 'reaction') mul *= SHIELD_REACTION_MUL;
  if (i.vulnerable === true) mul *= VULNERABLE_MUL;
  return mul;
}

/**
 * final = max(1, round(raw × defFactor × critMul × mods)), where
 * atkEff = baseAtk × 1.06^(level − 1) × (1 + equipAtkPct),
 * raw = atkEff × dmgMul × (1 + abilityUpgradePct + equipDmgPct [+ reactionDamagePct for 'reaction']),
 * defFactor = 100 / (100 + def), critMul = 1.5 iff rng01 < critChance.
 */
export function computeDamage(i: DamageInput): DamageResult {
  const level = clamp(finite(i.level), MIN_LEVEL, MAX_LEVEL);
  const atkEff = nonNeg(i.baseAtk) * LEVEL_ATK_GROWTH ** (level - 1) * nonNeg(1 + finite(i.equipAtkPct));
  const reactionPct = i.kind === 'reaction' ? finite(i.reactionDamagePct ?? 0) : 0;
  const bonus = nonNeg(1 + finite(i.abilityUpgradePct) + finite(i.equipDmgPct) + reactionPct);
  const raw = atkEff * nonNeg(i.dmgMul) * bonus;

  const defFactor = DEF_SCALE / (DEF_SCALE + nonNeg(i.def));
  const crit = clamp(finite(i.rng01), 0, MAX_ROLL) < clamp(finite(i.critChance), 0, 1);
  const scaled = raw * defFactor * (crit ? CRIT_MULTIPLIER : 1) * situationalMul(i);
  // Overflowing inputs (Infinity, or Infinity × 0 = NaN) still yield a finite integer ≥ 1.
  const amount = Number.isNaN(scaled) ? 1 : Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.round(scaled)));
  return { amount, crit, raw };
}

/** Stagger-meter gain of one hit: poise, ×1.5 on a Terra-marked target (Req 25.4). */
export function staggerGain(poise: number, terraMarked: boolean): number {
  const gain = nonNeg(poise);
  return terraMarked ? gain * TERRA_STAGGER_MUL : gain;
}
