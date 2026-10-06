// Echo Altar ability tiers applied to a character kit (design "능력 강화 (Echo Altar)", Req 29.4, 29.5).
// Pure: the kit data is never changed; every call builds new objects.
// - upgradedAbility: a Skill / Burst with tiers 1..n applied (data/characters/tiers abilityAtTier): the summed damage
//   bonus (computeDamage's abilityUpgradePct), params with radius / duration / `key=value` changes, the cooldown, and
//   the AttackDef whose hit shapes follow the params: every non-projectile shape's radius grows by the tiers' total
//   radiusAdd, and a `dash` param sets the path capsule's length (Kairen's 화염 돌진 6 → 8 m).
// - canUpgradeAbility: canUpgrade on a GameState (held Starmote and Glim, the ability's current tier).
import { abilityAtTier, type UpgradableAbility } from '../data/characters/tiers';
import type { AttackDef, HitShape } from '../data/combatTypes';
import type { CharacterId } from '../data/ids';
import { canUpgrade, type UpgradeCheck, type UpgradeTier } from './progression';
import type { DeepReadonly, GameState } from './save/gameState';

export type UpgradeAbility = 'skill' | 'burst';

/** Starmote's item id (a material, counted in `inventory.items`). */
export const STARMOTE_ID = 'mat_starmote';

/** A Skill or Burst as upgradedAbility reads it (CharacterDef.skill / .burst). */
export interface KitAbility extends UpgradableAbility {
  attack: AttackDef;
}

export interface UpgradedAbility {
  tier: UpgradeTier;
  /** computeDamage's abilityUpgradePct: the applied tiers' dmgPct summed. */
  dmgPct: number;
  params: Record<string, number>;
  /** Skill cooldown after cooldownSet; undefined for a Burst. */
  cooldown: number | undefined;
  /** The ability's attack with the upgraded hit shapes (the kit's own object at tier 0 or when nothing changes). */
  attack: AttackDef;
  /** Change texts of the applied tiers. */
  applied: string[];
}

/** `shape` grown by `radiusAdd` (projectiles keep their size) and, for a capsule, reaching `length`. */
function upgradedShape(shape: HitShape, radiusAdd: number, length: number | undefined): HitShape {
  switch (shape.kind) {
    case 'projectile':
    case 'line':
      return shape;
    case 'capsule':
      return { ...shape, radius: shape.radius + radiusAdd, length: length ?? shape.length };
    case 'arc':
    case 'sphere':
    case 'groundCircle':
      return { ...shape, radius: shape.radius + radiusAdd };
  }
}

/** `ability` at Echo Altar `tier` (clamped to 0–3). */
export function upgradedAbility(ability: KitAbility, tier: number): UpgradedAbility {
  const at = abilityAtTier(ability, tier);
  const radiusAdd = (at.params.radius ?? 0) - (ability.params.radius ?? 0);
  const dash = at.params.dash;
  const dashChanged = dash !== undefined && dash !== ability.params.dash;
  const attack: AttackDef = radiusAdd === 0 && !dashChanged
    ? ability.attack
    : { ...ability.attack, hits: ability.attack.hits.map((h) => ({ ...h, shape: upgradedShape(h.shape, radiusAdd, dashChanged ? dash : undefined) })) };
  return { tier: at.tier, dmgPct: at.dmgPct, params: at.params, cooldown: at.cooldown, attack, applied: at.applied };
}

/** Starmote held (0 when none). */
export function starmoteOf(gs: DeepReadonly<Pick<GameState, 'inventory'>>): number {
  return gs.inventory.items[STARMOTE_ID] ?? 0;
}

/** Current Echo Altar tier of `characterId`'s `ability`. */
export function abilityTierOf(gs: DeepReadonly<Pick<GameState, 'party'>>, characterId: CharacterId, ability: UpgradeAbility): UpgradeTier {
  return gs.party.upgrades[characterId][ability];
}

/**
 * canUpgrade for `characterId`'s `ability` with the party's Starmote and Glim (design `canUpgrade(gs, ch, ability)`):
 * ok with nothing missing when the next tier is affordable; at tier 3 `ok: false`, nothing missing, nextTier null.
 */
export function canUpgradeAbility(
  gs: DeepReadonly<Pick<GameState, 'party' | 'inventory'>>, characterId: CharacterId, ability: UpgradeAbility,
): UpgradeCheck {
  return canUpgrade({ starmote: starmoteOf(gs), glim: gs.inventory.glim, tier: abilityTierOf(gs, characterId, ability) });
}
