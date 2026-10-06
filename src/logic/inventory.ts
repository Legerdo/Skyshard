// Inventory, Glim and shop purchase rules (design "소비 아이템과 상점", Req 30.4, 14.11, 14.12).
// Pure: inputs are never mutated; a call that changes nothing may return its input as is.
import { clamp } from '../core/math';
import type { ConsumableId, ItemId, MaterialId } from '../data/ids';
import { CONSUMABLE_CAP, ITEM_BY_ID } from '../data/items';

export interface Inventory {
  glim: number;
  items: Partial<Record<ItemId, number>>;
  ownedEquipment: readonly ItemId[];
}

export type PurchaseResult =
  | { ok: true; inv: Inventory }
  | { ok: false; reason: 'glim' | 'cap' | 'owned'; missing?: number };

const isConsumable = (id: ItemId): id is ConsumableId => id.startsWith('con_');
const isMaterial = (id: ItemId): id is MaterialId => id.startsWith('mat_');
/** wpn_ / chm_ / rlc_: ownership only, never a count. */
const isEquipment = (id: ItemId): boolean => !isConsumable(id) && !isMaterial(id);
const capOf = (id: ItemId): number => ITEM_BY_ID.get(id)?.cap ?? CONSUMABLE_CAP;
const countOf = (inv: Inventory, id: ItemId): number => inv.items[id] ?? 0;

/**
 * Adds `n` of `id`; negative `n` consumes. Consumables clamp to 0..cap (overflow is discarded),
 * materials stay ≥ 0, equipment is recorded once when `n > 0`. `n` is truncated; non-finite is 0.
 */
export function addItem(inv: Inventory, id: ItemId, n: number): Inventory {
  const delta = Number.isFinite(n) ? Math.trunc(n) : 0;
  if (isEquipment(id)) {
    if (delta <= 0 || inv.ownedEquipment.includes(id)) return inv;
    return { ...inv, ownedEquipment: [...inv.ownedEquipment, id] };
  }
  const current = countOf(inv, id);
  const next = isConsumable(id) ? clamp(current + delta, 0, capOf(id)) : Math.max(0, current + delta);
  return next === current ? inv : { ...inv, items: { ...inv.items, [id]: next } };
}

/** Uses one consumable; refused (inventory unchanged) when `id` is not a held consumable. */
export function useItem(inv: Inventory, id: ItemId): { ok: boolean; inv: Inventory } {
  if (!isConsumable(id) || countOf(inv, id) < 1) return { ok: false, inv };
  return { ok: true, inv: addItem(inv, id, -1) };
}

/**
 * Buys one `itemId` for `price` Glim. Refusal reason, in priority order: 'owned' (equipment already
 * held) → 'cap' (consumable at its limit) → 'glim'; `missing = price − glim` whenever Glim is short,
 * whatever the reason. Succeeds only when glim ≥ price, so Glim never goes negative.
 * Throws RangeError for a negative or non-finite price.
 */
export function purchase(inv: Inventory, itemId: ItemId, price: number): PurchaseResult {
  if (!(Number.isFinite(price) && price >= 0)) throw new RangeError(`purchase: invalid price ${price}`);
  const missing = inv.glim < price ? price - inv.glim : undefined;
  const reason =
    isEquipment(itemId) && inv.ownedEquipment.includes(itemId)
      ? 'owned'
      : isConsumable(itemId) && countOf(inv, itemId) >= capOf(itemId)
        ? 'cap'
        : missing !== undefined
          ? 'glim'
          : null;
  if (reason !== null) return missing === undefined ? { ok: false, reason } : { ok: false, reason, missing };
  return { ok: true, inv: addItem({ ...inv, glim: inv.glim - price }, itemId, 1) };
}

/** Adds Glim (negative spends), never below 0; a non-finite amount changes nothing. */
export function addGlim(inv: Inventory, amount: number): Inventory {
  return Number.isFinite(amount) ? { ...inv, glim: Math.max(0, inv.glim + amount) } : inv;
}
