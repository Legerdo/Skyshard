// Items: 13 unique-effect equipment pieces, consumables, Starmote, Pip's shop and the New Game
// inventory (design "장비", "소비 아이템과 상점"; Req 30, 14.11). Pure data: ratios are fractions
// (0.5 = +50%), times seconds, distances metres.
import type { CharacterId, CharmId, ElementId, ItemId, RelicId, WeaponId } from './ids';

export type ItemKind = 'weapon' | 'charm' | 'relic' | 'consumable' | 'material';

/** Unique equipment effect; rule code switches on `kind`, never on the item id (design "효과 표현"). */
export type EquipEffect =
  | { kind: 'normalFinisherWave'; mul: number; radius: number }
  | { kind: 'chargedPuddle'; seconds: number }
  | { kind: 'launchPull'; radius: number }
  | { kind: 'pillarBonus'; seconds: number; knockback: number }
  | { kind: 'markDotBonus'; element: ElementId; pct: number }
  | { kind: 'perfectDodgeHeal'; pct: number }
  | { kind: 'dodgeStaminaMul'; mul: number }
  | { kind: 'shieldDamageTaken'; mul: number }
  | { kind: 'critChance'; add: number }
  | { kind: 'reactionEnergyToParty'; amount: number }
  | { kind: 'chestCompass'; radius: number }
  | { kind: 'outOfCombatRegen'; pctPerSec: number }
  | { kind: 'reactionDamage'; pct: number };

/** Heal the Active_Character (then a `cooldown` s lockout) or revive a Downed one, to `pct` of max HP. */
export type ConsumableUse = { kind: 'heal'; pct: number; cooldown: number } | { kind: 'revive'; pct: number };

export interface ItemDef {
  id: ItemId;
  kind: ItemKind;
  /** Korean display name. */
  name: string;
  /** Korean effect text for the equipment, inventory and shop screens. */
  description: string;
  /** Weapons only: the one character whose slot it fits. */
  character?: CharacterId;
  effect?: EquipEffect;
  use?: ConsumableUse;
  /** Stack limit (consumables). */
  cap?: number;
  /** Shop price in Glim. */
  price?: number;
}

/** Stack limit of each consumable kind (Req 30.4). */
export const CONSUMABLE_CAP = 10;

function weapon(id: WeaponId, character: CharacterId, name: string, description: string, effect: EquipEffect): ItemDef {
  return { id, kind: 'weapon', character, name, description, effect };
}
function charm(id: CharmId, name: string, description: string, effect: EquipEffect, price?: number): ItemDef {
  return { id, kind: 'charm', name, description, effect, ...(price === undefined ? {} : { price }) };
}
function relic(id: RelicId, name: string, description: string, effect: EquipEffect): ItemDef {
  return { id, kind: 'relic', name, description, effect };
}

export const ITEMS: readonly ItemDef[] = [
  // Weapons, one per character; unequipping falls back to the effectless default weapon.
  weapon('wpn_kairen_emberfang', 'kairen', '잿불송곳니', 'Normal 4타가 전방 3 m 화염 파동(0.6×, Ember) 발사',
    { kind: 'normalFinisherWave', mul: 0.6, radius: 3 }),
  weapon('wpn_isla_tidecaller', 'isla', '조수부름 활', 'Charged 화살 착탄 지점에 3 s 물웅덩이(Tide 부여)',
    { kind: 'chargedPuddle', seconds: 3 }),
  weapon('wpn_wren_skyreaver', 'wren', '하늘가르개', 'Charged 띄우기가 반경 3 m 적을 함께 끌어올림',
    { kind: 'launchPull', radius: 3 }),
  // The design gives no knockback distance; 3 m (like the other short knockbacks) is assumed.
  weapon('wpn_talus_bulwark', 'talus', '원시 방벽', '돌기둥 지속 +3 s, 생성 시 주변 적 넉백',
    { kind: 'pillarBonus', seconds: 3, knockback: 3 }),
  // Charms: worn by one character at a time.
  charm('chm_ember_ribbon', '불씨 리본', '이 캐릭터가 건 Ember 표식 지속 피해 +50%',
    { kind: 'markDotBonus', element: 'ember', pct: 0.5 }, 300),
  charm('chm_dewdrop', '이슬방울 부적', 'Perfect_Dodge 시 HP 5% 회복', { kind: 'perfectDodgeHeal', pct: 0.05 }),
  charm('chm_feather_bell', '깃털 방울', 'Dodge Stamina 소모 −25%', { kind: 'dodgeStaminaMul', mul: 0.75 }, 300),
  charm('chm_stone_heart', '돌심장', '보호막이 있는 동안 받는 피해 −15%', { kind: 'shieldDamageTaken', mul: 0.85 }),
  charm('chm_starlit_eye', '별빛 눈', '치명타 확률 +10%', { kind: 'critChance', add: 0.1 }),
  charm('chm_echo_shell', '메아리 소라', '이 캐릭터가 일으킨 Reaction마다 대기 파티원 Energy +3',
    { kind: 'reactionEnergyToParty', amount: 3 }),
  // Relics: one party-wide slot.
  relic('rlc_wanderers_compass', '방랑자의 나침반', '40 m 안 미개봉 Chest를 Compass에 표시',
    { kind: 'chestCompass', radius: 40 }),
  relic('rlc_verdant_seed', '새싹 씨앗', '전투 밖에서 파티 HP 초당 1% 회복', { kind: 'outOfCombatRegen', pctPerSec: 0.01 }),
  relic('rlc_ember_core', '잉걸 핵', 'Reaction 피해 +20%', { kind: 'reactionDamage', pct: 0.2 }),
  // Consumables and materials.
  {
    id: 'con_herbDumpling',
    kind: 'consumable',
    name: '허브 경단',
    description: '현재 캐릭터의 HP를 최대 HP의 35%만큼 회복 (Z, 재사용 대기 3 s)',
    use: { kind: 'heal', pct: 0.35, cooldown: 3 },
    cap: CONSUMABLE_CAP,
    price: 40,
  },
  {
    id: 'con_emberFeather',
    kind: 'consumable',
    name: '불씨 깃털',
    description: '쓰러진 캐릭터를 최대 HP의 30%로 부활',
    use: { kind: 'revive', pct: 0.3 },
    cap: CONSUMABLE_CAP,
    price: 120,
  },
  { id: 'mat_starmote', kind: 'material', name: 'Starmote', description: 'Echo Altar에서 능력을 강화하는 별빛 재료' },
];

export const ITEM_BY_ID: ReadonlyMap<ItemId, ItemDef> = new Map<ItemId, ItemDef>(ITEMS.map((item) => [item.id, item]));

/** Pip's shop (Req 14.11): consumables repeat up to the cap, charms sell once (`purchase` → 'owned'). */
export interface ShopEntry {
  id: ItemId;
  price: number;
}

export const SHOP_STOCK: readonly ShopEntry[] = [
  { id: 'con_herbDumpling', price: 40 },
  { id: 'con_emberFeather', price: 120 },
  { id: 'chm_ember_ribbon', price: 300 },
  { id: 'chm_feather_bell', price: 300 },
];

/** New Game inventory: herb dumpling ×3. */
export const STARTING_ITEMS: Readonly<Partial<Record<ItemId, number>>> = { con_herbDumpling: 3 };
