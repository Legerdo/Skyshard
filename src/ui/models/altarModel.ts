// Echo Altar screen rows (design "능력 강화 (Echo Altar)", Req 29.4–29.6). Pure view model, no DOM: for one character,
// its Skill and Burst with the current and next tier side by side, the next tier's cost, and the button state from
// the same canUpgradeAbility the Progression_System re-checks on the next tick: short of Starmote / Glim the button is
// disabled with "Starmote 2 · Glim 150 부족"; at tier 3 it reads "최대".
import type { UiCommand } from '../../core/uiCommands';
import { ABILITY_NAMES, CHARACTERS } from '../../data/characters';
import type { CharacterId } from '../../data/ids';
import { upgradeCost, type UpgradeCheck, type UpgradeTier } from '../../logic/progression';
import type { DeepReadonly, GameState } from '../../logic/save/gameState';
import { abilityTierOf, canUpgradeAbility, type UpgradeAbility } from '../../logic/upgrades';

/** Button text at tier 3. */
export const MAX_TIER_TEXT = '최대';

export interface AltarRow {
  ability: UpgradeAbility;
  /** "Skill" / "Burst". */
  kind: string;
  /** Korean ability name (화염 돌진, ...). */
  name: string;
  tier: UpgradeTier;
  /** "2/3단계". */
  tierText: string;
  /** Current tier: the applied tiers' change texts, "강화 전" at tier 0. */
  current: string;
  /** Next tier's change text, or "최대" at tier 3. */
  next: string;
  /** Cost of the next tier, null at tier 3. */
  cost: { starmote: number; glim: number } | null;
  /** "Starmote 3 · Glim 100", "" at tier 3. */
  costText: string;
  /** The upgrade button is enabled. */
  enabled: boolean;
  /** Tier 3 reached. */
  maxed: boolean;
  missingStarmote: number;
  missingGlim: number;
  /** "Starmote 2 · Glim 150 부족" (only the short ones), "" when nothing is missing. */
  missingText: string;
  /** "강화" or "최대". */
  buttonText: string;
  /** The UiCommand the button queues; null while disabled. */
  command: UiCommand | null;
}

/** "Starmote 2 · Glim 150 부족" for the short amounts; "" when nothing is missing (Req 29.6). */
export function missingText(check: Pick<UpgradeCheck, 'missingStarmote' | 'missingGlim'>): string {
  const parts: string[] = [];
  if (check.missingStarmote > 0) parts.push(`Starmote ${check.missingStarmote}`);
  if (check.missingGlim > 0) parts.push(`Glim ${check.missingGlim}`);
  return parts.length === 0 ? '' : `${parts.join(' · ')} 부족`;
}

/** One ability row. */
export function altarRow(
  gs: DeepReadonly<Pick<GameState, 'party' | 'inventory'>>, characterId: CharacterId, ability: UpgradeAbility,
): AltarRow {
  const kit = CHARACTERS[characterId][ability];
  const tier = abilityTierOf(gs, characterId, ability);
  const check = canUpgradeAbility(gs, characterId, ability);
  const applied = kit.upgrades.slice(0, tier).map((t) => t.label);
  const maxed = check.nextTier === null;
  const cost = check.nextTier === null ? null : upgradeCost(check.nextTier);
  return {
    ability,
    kind: ability === 'skill' ? 'Skill' : 'Burst',
    name: ABILITY_NAMES[characterId][ability],
    tier,
    tierText: `${tier}/3단계`,
    current: applied.length === 0 ? '강화 전' : applied.join(' · '),
    next: check.nextTier === null ? MAX_TIER_TEXT : kit.upgrades[check.nextTier - 1].label,
    cost,
    costText: cost === null ? '' : `Starmote ${cost.starmote} · Glim ${cost.glim}`,
    enabled: check.ok,
    maxed,
    missingStarmote: check.missingStarmote,
    missingGlim: check.missingGlim,
    missingText: missingText(check),
    buttonText: maxed ? MAX_TIER_TEXT : '강화',
    command: check.ok ? { kind: 'upgradeAbility', characterId, ability } : null,
  };
}

/** The Skill and Burst rows of `characterId`. */
export function altarRows(gs: DeepReadonly<Pick<GameState, 'party' | 'inventory'>>, characterId: CharacterId): AltarRow[] {
  return [altarRow(gs, characterId, 'skill'), altarRow(gs, characterId, 'burst')];
}
