// Cumulative Echo Altar tier effects for one Skill or Burst (design "능력 강화 단계"; Req 29.4, 29.5).
// Pure: tiers 1..n apply in order; dmgPct values add up, radiusAdd / durationAdd add to params.radius /
// params.seconds, cooldownSet and `key=value` extras replace.
import type { AbilityTier } from '../combatTypes';
import type { CharacterId } from '../ids';

export type AbilityTierLevel = 0 | 1 | 2 | 3;
export const MAX_ABILITY_TIER = 3;

/** Korean Skill / Burst names for the Echo Altar screen (design "캐릭터 키트"). */
export const ABILITY_NAMES: Readonly<Record<CharacterId, Readonly<Record<'skill' | 'burst', string>>>> = {
  kairen: { skill: '화염 돌진', burst: '태양 낙하' },
  isla: { skill: '물결 화살비', burst: '해일 포화' },
  wren: { skill: '소용돌이', burst: '폭풍의 눈' },
  talus: { skill: '암석 방벽', burst: '대지의 요새' },
};

/** The parts of a CharacterDef skill / burst that tiers change. */
export interface UpgradableAbility {
  params: Readonly<Record<string, number>>;
  upgrades: readonly [AbilityTier, AbilityTier, AbilityTier];
  cooldown?: number;
}

export interface AbilityAtTier {
  tier: AbilityTierLevel;
  /** Summed tier dmgPct: computeDamage's abilityUpgradePct. */
  dmgPct: number;
  /** A new params object with every applied tier's changes. */
  params: Record<string, number>;
  /** Skill cooldown after cooldownSet; undefined for a Burst. */
  cooldown: number | undefined;
  /** Change texts of the applied tiers, in order (current tier description). */
  applied: string[];
  /** The next tier for the upgrade screen; null at tier 3 ("최대"). */
  next: AbilityTier | null;
}

/** Clamps `tier` to an integer in [0, 3]; NaN gives 0. */
function clampTier(tier: number): AbilityTierLevel {
  if (!(tier > 0)) return 0;
  return Math.min(MAX_ABILITY_TIER, Math.floor(tier)) as AbilityTierLevel;
}

/** Effective values of `ability` with tiers 1..`tier` applied; the input is not changed. */
export function abilityAtTier(ability: UpgradableAbility, tier: number): AbilityAtTier {
  const level = clampTier(tier);
  const params: Record<string, number> = { ...ability.params };
  let { cooldown } = ability;
  let dmgPct = 0;
  const applied: string[] = [];
  for (const t of ability.upgrades.slice(0, level)) {
    dmgPct += t.dmgPct;
    if (t.radiusAdd !== undefined) params.radius = (params.radius ?? 0) + t.radiusAdd;
    if (t.durationAdd !== undefined) params.seconds = (params.seconds ?? 0) + t.durationAdd;
    if (t.cooldownSet !== undefined) cooldown = t.cooldownSet;
    if (t.extra !== undefined) {
      const [key = '', value = ''] = t.extra.split('=');
      params[key] = Number(value);
    }
    applied.push(t.label);
  }
  return { tier: level, dmgPct, params, cooldown, applied, next: (ability.upgrades as readonly AbilityTier[])[level] ?? null };
}
