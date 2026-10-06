// Equipment slots and effects (design "장비", "효과 표현"; Req 30.1–30.3). Pure: inputs are never mutated.
// - Slots: every character has a Weapon slot (null = the kit's effectless default weapon, never empty) and a Charm
//   slot; the party shares one Relic slot. A Weapon fits only its own character; a Charm is worn by one character at a
//   time, so equipping it on another character moves it there; unequipping (null) returns the Weapon to the default
//   and empties a Charm / Relic slot.
// - Effects: rule code reads EquipEffect `kind`s through one exhaustive switch (modifiersOf), never item ids. The
//   modifiers are recomputed from the loadout on every read, so an equip applied in a tick takes effect in that tick.
import { CHARACTERS } from '../data/characters';
import type { CharacterId, ElementId, ItemId } from '../data/ids';
import { ITEM_BY_ID, type EquipEffect, type ItemDef } from '../data/items';
import type { DeepReadonly, GameState } from './save/gameState';

export type EquipSlot = 'weapon' | 'charm' | 'relic';

/** Effect text of an empty slot or a default weapon (Req 30.3). */
export const NO_EFFECT_TEXT = '효과 없음';

/** The equipment part of GameState.party. */
export type Loadout = Pick<GameState['party'], 'equipment' | 'relic'>;
export type LoadoutView = DeepReadonly<Loadout>;

export type EquipRefusal =
  /** Not an equipment item of the content data. */
  | 'unknownItem'
  /** The item is not in `inventory.ownedEquipment`. */
  | 'notOwned'
  /** The item does not go in that slot (a Charm in the Relic slot, ...). */
  | 'wrongSlot'
  /** A Weapon of another character. */
  | 'wrongCharacter'
  /** The character has not joined the party (Weapon / Charm slots). */
  | 'notJoined'
  /** The slot already holds exactly that. */
  | 'unchanged';

export type EquipResult =
  | {
      ok: true;
      loadout: Loadout;
      /** What the slot held before and holds now (null: empty / default weapon). */
      before: ItemId | null;
      after: ItemId | null;
      /** The character a Charm was moved away from, else null. */
      movedFrom: CharacterId | null;
    }
  | { ok: false; reason: EquipRefusal };

/** The slot an item goes in, or null for non-equipment. */
export function slotOf(item: Pick<ItemDef, 'kind'>): EquipSlot | null {
  return item.kind === 'weapon' || item.kind === 'charm' || item.kind === 'relic' ? item.kind : null;
}

/** What `characterId`'s `slot` holds (the party Relic for 'relic'); null is empty / the default weapon. */
export function equippedItem(loadout: LoadoutView, characterId: CharacterId, slot: EquipSlot): ItemId | null {
  return slot === 'relic' ? loadout.relic : loadout.equipment[characterId][slot];
}

/** Deep copy of the loadout. */
function copyLoadout(loadout: LoadoutView): Loadout {
  const equipment = Object.fromEntries(
    Object.entries(loadout.equipment).map(([id, e]) => [id, { weapon: e.weapon, charm: e.charm }]),
  ) as Loadout['equipment'];
  return { equipment, relic: loadout.relic };
}

/**
 * Equips `itemId` in `characterId`'s `slot` (the party Relic for 'relic', where `characterId` is ignored), or
 * unequips the slot with null. Refused unless the item is owned equipment of that slot (a Weapon of that character)
 * and, for Weapon / Charm, the character has joined; a Charm worn by someone else moves.
 */
export function equip(
  party: DeepReadonly<Pick<GameState['party'], 'joined' | 'equipment' | 'relic'>>,
  owned: readonly ItemId[],
  characterId: CharacterId,
  slot: EquipSlot,
  itemId: ItemId | null,
): EquipResult {
  if (slot !== 'relic' && !party.joined.includes(characterId)) return { ok: false, reason: 'notJoined' };
  const before = equippedItem(party, characterId, slot);
  if (itemId !== null) {
    const def = ITEM_BY_ID.get(itemId);
    const itemSlot = def === undefined ? null : slotOf(def);
    if (def === undefined || itemSlot === null) return { ok: false, reason: 'unknownItem' };
    if (itemSlot !== slot) return { ok: false, reason: 'wrongSlot' };
    if (slot === 'weapon' && def.character !== characterId) return { ok: false, reason: 'wrongCharacter' };
    if (!owned.includes(itemId)) return { ok: false, reason: 'notOwned' };
  }
  if (before === itemId) return { ok: false, reason: 'unchanged' };
  const loadout = copyLoadout(party);
  let movedFrom: CharacterId | null = null;
  if (slot === 'relic') loadout.relic = itemId;
  else {
    if (slot === 'charm' && itemId !== null) {
      for (const [id, e] of Object.entries(loadout.equipment) as [CharacterId, Loadout['equipment'][CharacterId]][]) {
        if (id !== characterId && e.charm === itemId) {
          e.charm = null;
          movedFrom = id;
        }
      }
    }
    loadout.equipment[characterId][slot] = itemId;
  }
  return { ok: true, loadout, before, after: itemId, movedFrom };
}

/** Effect of one item (none for empty slots, default weapons and non-equipment). */
export function effectOf(itemId: ItemId | null): EquipEffect | null {
  return itemId === null ? null : (ITEM_BY_ID.get(itemId)?.effect ?? null);
}

/** The effects working for `characterId`: its Weapon and Charm, and the party Relic. */
export function effectsOf(loadout: LoadoutView, characterId: CharacterId): EquipEffect[] {
  const own = loadout.equipment[characterId];
  return [own.weapon, own.charm, loadout.relic].map(effectOf).filter((e): e is EquipEffect => e !== null);
}

/** Every equipment effect as numbers the systems read; the neutral values mean "none". */
export interface EquipModifiers {
  /** Added to the base crit chance (critChance). */
  critChanceAdd: number;
  /** computeDamage reactionDamagePct (reactionDamage). */
  reactionDamagePct: number;
  /** Dodge Stamina cost × this (dodgeStaminaMul). */
  dodgeStaminaMul: number;
  /** Damage taken × this while a shield holds (shieldDamageTaken). */
  shieldDamageTakenMul: number;
  /** Extra damage of the marks this character applies, by Element (markDotBonus). */
  markDotPct: Partial<Record<ElementId, number>>;
  /** Heal on a Perfect_Dodge, fraction of max HP (perfectDodgeHeal). */
  perfectDodgeHealPct: number;
  /** Energy to each standby member per Reaction this character causes (reactionEnergyToParty). */
  reactionEnergyToParty: number;
  /** Party heal out of combat, fraction of max HP per second (outOfCombatRegen). */
  outOfCombatRegenPctPerSec: number;
  /** Unopened Chests within this radius show on the Compass; 0 = off (chestCompass). */
  chestCompassRadius: number;
  /** Normal hit 4 wave (normalFinisherWave). */
  normalFinisherWave: { mul: number; radius: number } | null;
  /** Charged arrow puddle length, s; 0 = off (chargedPuddle). */
  chargedPuddleSeconds: number;
  /** Charged launch pulls enemies within this radius; 0 = off (launchPull). */
  launchPullRadius: number;
  /** Stone pillar bonus (pillarBonus). */
  pillarBonus: { seconds: number; knockback: number } | null;
}

export const NO_MODIFIERS: Readonly<EquipModifiers> = Object.freeze({
  critChanceAdd: 0,
  reactionDamagePct: 0,
  dodgeStaminaMul: 1,
  shieldDamageTakenMul: 1,
  markDotPct: Object.freeze({}),
  perfectDodgeHealPct: 0,
  reactionEnergyToParty: 0,
  outOfCombatRegenPctPerSec: 0,
  chestCompassRadius: 0,
  normalFinisherWave: null,
  chargedPuddleSeconds: 0,
  launchPullRadius: 0,
  pillarBonus: null,
});

/** Folds `effects` into modifiers (exhaustive over EquipEffect kinds: a new kind without a case does not compile). */
export function modifiersOf(effects: readonly EquipEffect[]): EquipModifiers {
  const m: EquipModifiers = { ...NO_MODIFIERS, markDotPct: {} };
  for (const e of effects) {
    switch (e.kind) {
      case 'critChance':
        m.critChanceAdd += e.add;
        break;
      case 'reactionDamage':
        m.reactionDamagePct += e.pct;
        break;
      case 'dodgeStaminaMul':
        m.dodgeStaminaMul *= e.mul;
        break;
      case 'shieldDamageTaken':
        m.shieldDamageTakenMul *= e.mul;
        break;
      case 'markDotBonus':
        m.markDotPct[e.element] = (m.markDotPct[e.element] ?? 0) + e.pct;
        break;
      case 'perfectDodgeHeal':
        m.perfectDodgeHealPct += e.pct;
        break;
      case 'reactionEnergyToParty':
        m.reactionEnergyToParty += e.amount;
        break;
      case 'outOfCombatRegen':
        m.outOfCombatRegenPctPerSec += e.pctPerSec;
        break;
      case 'chestCompass':
        m.chestCompassRadius = Math.max(m.chestCompassRadius, e.radius);
        break;
      case 'normalFinisherWave':
        m.normalFinisherWave = { mul: e.mul, radius: e.radius };
        break;
      case 'chargedPuddle':
        m.chargedPuddleSeconds = Math.max(m.chargedPuddleSeconds, e.seconds);
        break;
      case 'launchPull':
        m.launchPullRadius = Math.max(m.launchPullRadius, e.radius);
        break;
      case 'pillarBonus':
        m.pillarBonus = { seconds: e.seconds, knockback: e.knockback };
        break;
      default: {
        const unhandled: never = e;
        throw new Error(`unhandled equip effect ${JSON.stringify(unhandled)}`);
      }
    }
  }
  return m;
}

/** The modifiers working for `characterId` now (its Weapon and Charm, the party Relic). */
export function equipModifiers(loadout: LoadoutView, characterId: CharacterId): EquipModifiers {
  return modifiersOf(effectsOf(loadout, characterId));
}

/** Display name of what a slot holds: the item's name, the kit's default weapon, or "비어 있음". */
export function slotItemName(characterId: CharacterId, slot: EquipSlot, itemId: ItemId | null): string {
  if (itemId !== null) return ITEM_BY_ID.get(itemId)?.name ?? itemId;
  return slot === 'weapon' ? `기본 무기 (${CHARACTERS[characterId].weaponName})` : '비어 있음';
}

/** Effect text of what a slot holds: the item's description, or "효과 없음" for an empty slot / default weapon. */
export function slotEffectText(itemId: ItemId | null): string {
  if (itemId === null) return NO_EFFECT_TEXT;
  const def = ITEM_BY_ID.get(itemId);
  return def?.effect === undefined ? NO_EFFECT_TEXT : def.description;
}
