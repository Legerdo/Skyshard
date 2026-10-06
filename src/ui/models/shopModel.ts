// Pip's shop screen rows (design "소비 아이템과 상점", Req 14.11, 14.12). Pure view model, no DOM: each row is
// judged with the same logic/inventory `purchase` the Inventory_System applies on the next tick, so a refused item's
// button is disabled with "보유 중" / "보유 한도" and the missing Glim ("Glim 90 부족") before the player presses it.
import type { UiCommand } from '../../core/uiCommands';
import type { ItemId } from '../../data/ids';
import { CONSUMABLE_CAP, ITEM_BY_ID, SHOP_STOCK, type ShopEntry } from '../../data/items';
import { purchase } from '../../logic/inventory';
import type { DeepReadonly, GameState } from '../../logic/save/gameState';

export type ShopRefusal = 'owned' | 'cap' | 'glim';

export interface ShopRow {
  itemId: ItemId;
  name: string;
  description: string;
  price: number;
  /** "40 Glim". */
  priceText: string;
  /** Held count (1 for owned equipment). */
  held: number;
  /** "보유 3/10" for consumables, "보유 중" for owned equipment, else "". */
  heldText: string;
  /** The buy button is enabled: `purchase` would succeed. */
  enabled: boolean;
  /** The refusal reason (owned → cap → glim), or null. */
  reason: ShopRefusal | null;
  /** Glim short of the price, 0 when enough. */
  missingGlim: number;
  /** "보유 중" / "보유 한도" and "Glim N 부족", in that order. */
  notes: string[];
  /** `notes` joined with " · " ("" when enabled). */
  status: string;
  /** The UiCommand the button queues; null while disabled. */
  command: UiCommand | null;
}

const REASON_TEXT: Readonly<Record<'owned' | 'cap', string>> = { owned: '보유 중', cap: '보유 한도' };

/** Missing Glim text: "Glim 90 부족". */
export function missingGlimText(missing: number): string {
  return `Glim ${missing} 부족`;
}

/** One shop row for `entry` against the party's inventory and Glim. */
export function shopRow(gs: DeepReadonly<Pick<GameState, 'inventory'>>, entry: ShopEntry): ShopRow {
  const inv = gs.inventory;
  const def = ITEM_BY_ID.get(entry.id);
  const consumable = entry.id.startsWith('con_');
  const owned = inv.ownedEquipment.includes(entry.id);
  const held = consumable ? (inv.items[entry.id] ?? 0) : owned ? 1 : 0;
  const cap = def?.cap ?? CONSUMABLE_CAP;
  const result = purchase(
    { glim: inv.glim, items: { ...inv.items }, ownedEquipment: [...inv.ownedEquipment] }, entry.id, entry.price,
  );
  const reason = result.ok ? null : result.reason;
  const missingGlim = result.ok ? 0 : (result.missing ?? 0);
  const notes: string[] = [];
  if (reason === 'owned' || reason === 'cap') notes.push(REASON_TEXT[reason]);
  if (missingGlim > 0) notes.push(missingGlimText(missingGlim));
  return {
    itemId: entry.id,
    name: def?.name ?? entry.id,
    description: def?.description ?? '',
    price: entry.price,
    priceText: `${entry.price} Glim`,
    held,
    heldText: consumable ? `보유 ${held}/${cap}` : owned ? '보유 중' : '',
    enabled: result.ok,
    reason,
    missingGlim,
    notes,
    status: notes.join(' · '),
    command: result.ok ? { kind: 'purchase', itemId: entry.id } : null,
  };
}

/** Every row of Pip's shop, in SHOP_STOCK order. */
export function shopRows(gs: DeepReadonly<Pick<GameState, 'inventory'>>, stock: readonly ShopEntry[] = SHOP_STOCK): ShopRow[] {
  return stock.map((entry) => shopRow(gs, entry));
}
