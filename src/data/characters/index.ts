// Character kits by CharacterId, one file per character (design "캐릭터 키트", Req 22.1, 22.4).
import type { CharacterDef } from '../combatTypes';
import type { CharacterId } from '../ids';
import { withEnergyOnHit } from './energy';
import { ISLA } from './isla';
import { KAIREN } from './kairen';
import { TALUS } from './talus';
import { WREN } from './wren';

export type { CharacterDef } from '../combatTypes';
export { ABILITY_NAMES, abilityAtTier, MAX_ABILITY_TIER } from './tiers';
export type { AbilityAtTier, AbilityTierLevel, UpgradableAbility } from './tiers';
export { energyOnHitFor } from './energy';

/** The kits with every HitEvent's `energyOnHit` filled at load (Req 24.7). */
export const CHARACTERS: Record<CharacterId, CharacterDef> = {
  kairen: withEnergyOnHit(KAIREN),
  isla: withEnergyOnHit(ISLA),
  wren: withEnergyOnHit(WREN),
  talus: withEnergyOnHit(TALUS),
};
