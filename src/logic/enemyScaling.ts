// Enemy level scaling (design "적 정의"): stats are given at the kind's base level L₀.
//   maxHp(L)  = round(HP₀ × 1.10^(L − L₀))
//   atkEff(L) = ATK₀ × 1.06^(L − L₀) = computeDamage(baseAtk = ATK₀, level = L − L₀ + 1)'s atkEff
// so enemy ATK is scaled once, inside computeDamage (Req 28.10). DEF, speed, reach and Telegraph ignore level.
// Hidden Elites scale like their base kind (their HP₀ / ATK₀ already carry the ×2.5 / ×1.3); guardian Elites are
// `'fixed'`: absolute HP and ATK at any level, computeDamage level 1 (design "Elite").
// Pure: no three.js / DOM / randomness.

export const ENEMY_HP_GROWTH = 1.1;

/** `'level'`: the formulas above; `'fixed'`: the stats are absolute (guardian Elites). */
export type EnemyScaling = 'level' | 'fixed';

/** The EnemyDef fields level scaling reads. */
export interface ScalableEnemy {
  hp: number;
  baseLevel: number;
  scaling: EnemyScaling;
}

/** Max HP at `level` (≥ 1). Non-finite levels count as `baseLevel`. */
export function enemyMaxHp(hp0: number, baseLevel: number, level: number): number {
  const steps = Number.isFinite(level) && Number.isFinite(baseLevel) ? level - baseLevel : 0;
  return Math.max(1, Math.round(hp0 * ENEMY_HP_GROWTH ** steps));
}

/** The `level` to pass to computeDamage for an enemy at `level`: L − L₀ + 1, at least 1. */
export function enemyDamageLevel(baseLevel: number, level: number): number {
  const steps = Number.isFinite(level) && Number.isFinite(baseLevel) ? level - baseLevel : 0;
  return Math.max(1, steps + 1);
}

/** Max HP of `def` placed at `level`: enemyMaxHp for level-scaled kinds, the absolute HP for fixed ones. */
export function scaledMaxHp(def: Readonly<ScalableEnemy>, level: number): number {
  return def.scaling === 'fixed' ? Math.max(1, Math.round(def.hp)) : enemyMaxHp(def.hp, def.baseLevel, level);
}

/** computeDamage `level` of `def` placed at `level`: enemyDamageLevel, or 1 for fixed kinds. */
export function scaledDamageLevel(def: Readonly<Omit<ScalableEnemy, 'hp'>>, level: number): number {
  return def.scaling === 'fixed' ? 1 : enemyDamageLevel(def.baseLevel, level);
}
