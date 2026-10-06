// Inventory / Equipment screen view models (design "장비", "소비 아이템과 상점", 화면 목록 Inventory/Equipment;
// Req 30.2, 30.3, 27.5, 27.6). Pure, no DOM:
// - equipmentSlots: a character's Weapon and Charm and the party Relic with their names and effect texts.
// - equipmentCandidates: owned items that fit a slot (plus unequipping), each judged by logic/equipment `equip`.
// - equipmentComparison: the slot's effect before and after a candidate side by side ("효과 없음" for an empty slot
//   or the default weapon), shown while choosing and after the change.
// - consumableRows: the herb dumpling and the Ember Feather with counts, whether they can be used now, and the
//   Downed characters the Feather can target.
import type { UiCommand } from '../../core/uiCommands';
import { CHARACTERS } from '../../data/characters';
import { CHARACTER_IDS, type CharacterId, type ItemId } from '../../data/ids';
import { CONSUMABLE_CAP, ITEMS, ITEM_BY_ID } from '../../data/items';
import {
  equip, equippedItem, slotEffectText, slotItemName, slotOf, type EquipRefusal, type EquipSlot,
} from '../../logic/equipment';
import { statsAt } from '../../logic/progression';
import type { DeepReadonly, GameState } from '../../logic/save/gameState';

type PartyView = DeepReadonly<Pick<GameState, 'party' | 'inventory'>>;

export const SLOT_LABELS: Readonly<Record<EquipSlot, string>> = { weapon: '무기', charm: '부적', relic: '유물' };

const REFUSAL_TEXT: Readonly<Record<EquipRefusal, string>> = {
  unknownItem: '장비할 수 없는 아이템',
  notOwned: '보유하지 않은 장비',
  wrongSlot: '이 칸에 맞지 않는 장비',
  wrongCharacter: '다른 캐릭터의 무기',
  notJoined: '아직 합류하지 않은 캐릭터',
  unchanged: '이미 장착 중',
};

export interface SlotView {
  slot: EquipSlot;
  /** "무기" / "부적" / "유물". */
  label: string;
  itemId: ItemId | null;
  /** Item name, "기본 무기 (한손 곡검)" or "비어 있음". */
  name: string;
  /** Effect text or "효과 없음". */
  effect: string;
}

export interface EquipmentComparison {
  slot: EquipSlot;
  label: string;
  before: SlotView;
  after: SlotView;
  /** The change can be applied (the `equip` UiCommand would succeed). */
  allowed: boolean;
  reason: EquipRefusal | null;
  /** Korean refusal text, "" when allowed. */
  reasonText: string;
  /** A Charm worn by another character moves from them. */
  movedFrom: CharacterId | null;
  /** "Isla에게서 옮겨 옵니다", "" otherwise. */
  movedText: string;
  command: UiCommand | null;
}

export interface CandidateView extends EquipmentComparison {
  /** The candidate (null: unequip). */
  itemId: ItemId | null;
  /** Another character currently wearing this Charm, else null. */
  wornBy: CharacterId | null;
}

function slotView(characterId: CharacterId, slot: EquipSlot, itemId: ItemId | null): SlotView {
  return { slot, label: SLOT_LABELS[slot], itemId, name: slotItemName(characterId, slot, itemId), effect: slotEffectText(itemId) };
}

/** `characterId`'s Weapon and Charm slots and the party Relic slot, in that order. */
export function equipmentSlots(gs: PartyView, characterId: CharacterId): SlotView[] {
  return (['weapon', 'charm', 'relic'] as const).map((slot) => slotView(characterId, slot, equippedItem(gs.party, characterId, slot)));
}

/** Before / after of putting `candidate` (null: unequip) into `characterId`'s `slot`. */
export function equipmentComparison(
  gs: PartyView, characterId: CharacterId, slot: EquipSlot, candidate: ItemId | null,
): EquipmentComparison {
  const current = equippedItem(gs.party, characterId, slot);
  const result = equip(gs.party, gs.inventory.ownedEquipment, characterId, slot, candidate);
  const movedFrom = result.ok ? result.movedFrom : null;
  return {
    slot,
    label: SLOT_LABELS[slot],
    before: slotView(characterId, slot, current),
    after: slotView(characterId, slot, candidate),
    allowed: result.ok,
    reason: result.ok ? null : result.reason,
    reasonText: result.ok ? '' : REFUSAL_TEXT[result.reason],
    movedFrom,
    movedText: movedFrom === null ? '' : `${CHARACTERS[movedFrom].name}에게서 옮겨 옵니다`,
    command: result.ok ? { kind: 'equip', characterId, slot, itemId: candidate } : null,
  };
}

/** Owned items fitting `characterId`'s `slot` (Weapons of that character only), then unequipping (null). */
export function equipmentCandidates(gs: PartyView, characterId: CharacterId, slot: EquipSlot): CandidateView[] {
  const owned = gs.inventory.ownedEquipment;
  const fitting = ITEMS.filter(
    (item) => slotOf(item) === slot && owned.includes(item.id) && (slot !== 'weapon' || item.character === characterId),
  ).map((item) => item.id);
  const wornBy = (itemId: ItemId | null): CharacterId | null =>
    slot !== 'charm' || itemId === null
      ? null
      : (CHARACTER_IDS.find((id) => id !== characterId && gs.party.equipment[id].charm === itemId) ?? null);
  return [...fitting, null].map((itemId) => ({
    ...equipmentComparison(gs, characterId, slot, itemId),
    itemId,
    wornBy: wornBy(itemId),
  }));
}

export interface ConsumableRow {
  itemId: ItemId;
  name: string;
  description: string;
  count: number;
  /** "3/10". */
  countText: string;
  /** Usable now from the Inventory screen. */
  usable: boolean;
  /** Why not, "" when usable. */
  reasonText: string;
  /** Ember Feather: the Downed joined characters it can revive (empty for the herb dumpling). */
  targets: { characterId: CharacterId; name: string; command: UiCommand }[];
  /** The herb dumpling's `useItem` command; null for the Feather (pick a target) or while unusable. */
  command: UiCommand | null;
}

/**
 * The two consumables. `healCooldown` is the herb dumpling's remaining reuse wait (ConsumableSystem.healCooldown,
 * runtime only); default 0.
 */
export function consumableRows(gs: PartyView, healCooldown = 0): ConsumableRow[] {
  const { party, inventory } = gs;
  const rows: ConsumableRow[] = [];
  for (const def of ITEMS) {
    if (def.kind !== 'consumable' || def.use === undefined) continue;
    const count = inventory.items[def.id] ?? 0;
    const base = {
      itemId: def.id, name: def.name, description: def.description, count, countText: `${count}/${def.cap ?? CONSUMABLE_CAP}`,
    };
    if (def.use.kind === 'heal') {
      const active = party.active;
      const max = statsAt(CHARACTERS[active].baseStats, party.level).hp;
      const reasonText = count < 1 ? '보유하지 않음'
        : party.downed.includes(active) || party.hp[active] <= 0 ? '쓰러진 상태'
          : party.hp[active] >= max ? 'HP가 가득 참'
            : healCooldown > 0 ? `${Math.ceil(healCooldown)}초 후 사용 가능` : '';
      const usable = reasonText === '';
      rows.push({ ...base, usable, reasonText, targets: [], command: usable ? { kind: 'useItem', itemId: def.id } : null });
      continue;
    }
    const targets = count < 1 ? [] : CHARACTER_IDS.filter((id) => party.joined.includes(id) && party.downed.includes(id)).map((id) => ({
      characterId: id, name: CHARACTERS[id].name, command: { kind: 'useItem', itemId: def.id, target: id } as UiCommand,
    }));
    const reasonText = count < 1 ? '보유하지 않음' : targets.length === 0 ? '쓰러진 동료 없음' : '';
    rows.push({ ...base, usable: reasonText === '', reasonText, targets, command: null });
  }
  return rows;
}

/** Name of an item for lists ("" for unknown ids). */
export function itemName(itemId: ItemId): string {
  return ITEM_BY_ID.get(itemId)?.name ?? '';
}
