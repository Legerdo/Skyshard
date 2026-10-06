// Party level, level-up growth and Echo Altar checks (design "Progression·Inventory·Loot", Req 29).
// Pure: same input, same output; nothing is mutated.
import { clamp } from '../core/math';
import { LEVEL_ATK_GROWTH, LEVEL_HP_GROWTH, MAX_LEVEL, UPGRADE_COSTS, XP_TABLE } from '../data/progression';

export interface BaseStats {
  hp: number;
  atk: number;
  def: number;
}

export type UpgradeTier = 0 | 1 | 2 | 3;

export interface UpgradeCheck {
  ok: boolean;
  missingStarmote: number;
  missingGlim: number;
  /** Tier this upgrade would reach; null when already at tier 3 ("최대"). */
  nextTier: 1 | 2 | 3 | null;
}

/** Integer level in 1–10 (NaN → 1). */
function clampLevel(level: number): number {
  return Number.isNaN(level) ? 1 : clamp(Math.floor(level), 1, MAX_LEVEL);
}

/** Held amount; NaN and negatives count as 0. */
const held = (n: number): number => (n > 0 ? n : 0);

/** Highest level L with xpForLevel(L) ≤ xp, in 1–10; negative or NaN XP is level 1. */
export function levelFromXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= XP_TABLE[level]) level++;
  return level;
}

/** Most XP the party can hold: the level-10 threshold (3,000); anything beyond is discarded (Req 29.1). */
export const MAX_XP: number = XP_TABLE[MAX_LEVEL - 1];

/**
 * Party XP after gaining `amount`: capped at MAX_XP. Negative, NaN or infinite amounts add nothing, and a current
 * value outside 0..MAX_XP is brought back into it first.
 */
export function addXp(xp: number, amount: number): number {
  const base = Number.isFinite(xp) ? clamp(xp, 0, MAX_XP) : 0;
  const gain = Number.isFinite(amount) && amount > 0 ? amount : 0;
  return Math.min(MAX_XP, base + gain);
}

/** Cumulative XP at which `level` starts (1 → 0, 10 → 3,000); the level is clamped to 1–10. */
export function xpForLevel(level: number): number {
  return XP_TABLE[clampLevel(level) - 1];
}

/**
 * Stats at party `level`, compounded from the base so rounding never accumulates:
 * hp = round(base.hp × 1.08^(L−1)); atk = base.atk × 1.06^(L−1), unrounded (display only,
 * computeDamage applies the level itself); def unchanged.
 */
export function statsAt(base: BaseStats, level: number): BaseStats {
  const n = clampLevel(level) - 1;
  return { hp: Math.round(base.hp * LEVEL_HP_GROWTH ** n), atk: base.atk * LEVEL_ATK_GROWTH ** n, def: base.def };
}

/** Starmote / Glim needed to reach `tier`. */
export function upgradeCost(tier: 1 | 2 | 3): { starmote: number; glim: number } {
  return { ...UPGRADE_COSTS[tier] };
}

/** Whether an ability at `tier` can go up one step, and how much is missing (Req 29.6). */
export function canUpgrade(state: { starmote: number; glim: number; tier: UpgradeTier }): UpgradeCheck {
  if (state.tier >= 3) return { ok: false, missingStarmote: 0, missingGlim: 0, nextTier: null };
  const nextTier = state.tier === 0 ? 1 : state.tier === 1 ? 2 : 3;
  const cost = UPGRADE_COSTS[nextTier];
  const missingStarmote = Math.max(0, cost.starmote - held(state.starmote));
  const missingGlim = Math.max(0, cost.glim - held(state.glim));
  return { ok: missingStarmote === 0 && missingGlim === 0, missingStarmote, missingGlim, nextTier };
}
