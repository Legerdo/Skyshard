// Inventory_System (design "Progression·Inventory·Loot", "장비", "소비 아이템과 상점"; Req 30.2–30.6, 14.11, 14.12):
// owns GameState.inventory and the equipment loadout (party.equipment / party.relic) and applies the pure rules of
// logic/inventory and logic/equipment to them.
// - Every item grant is announced as 'item:granted' (`itemId`, `count`, `source`) for the HUD pickup feed and the
//   Quest_System's collect Objectives; Glim changes are silent. Shop purchases are grants with source 'shop'.
// - purchase() (the `purchase` UiCommand, next tick): Pip's price from SHOP_STOCK, then logic/inventory purchase;
//   only `ok: true` changes the inventory and Glim (refusals owned → cap → glim, Req 14.12).
// - equip() (the `equip` UiCommand, next tick): logic/equipment equip; an applied change is in GameState at once, so
//   every EquipEffect reader sees it in the same tick, and it is a Milestone: 'save:request' 'equipment' (Req 36.3).
// - spend() pays the Echo Altar; consume() takes one consumable for the Consumable system.
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import type { CharacterId, ItemId } from '../data/ids';
import { SHOP_STOCK } from '../data/items';
import { equip, type EquipResult, type EquipSlot } from '../logic/equipment';
import { addGlim, addItem, purchase, useItem, type PurchaseResult } from '../logic/inventory';
import type { GameState } from '../logic/save/gameState';
import { STARMOTE_ID } from '../logic/upgrades';

/** 'item:granted' source of shop purchases. */
export const SHOP_SOURCE = 'shop';

export interface InventorySystemOptions {
  /** Owns `inventory`, `party.equipment` and `party.relic`. */
  state: GameState;
  bus: GameEventBus;
}

/** A purchase result, or 'notSold' for an item Pip does not sell. */
export type ShopPurchaseResult = PurchaseResult | { ok: false; reason: 'notSold' };

export class InventorySystem {
  private readonly state: GameState;
  private readonly bus: GameEventBus;

  constructor(options: InventorySystemOptions) {
    this.state = options.state;
    this.bus = options.bus;
  }

  /**
   * Grants `count` of `itemId` from `source` (addItem: consumables stay within their cap, equipment is owned once)
   * and emits 'item:granted'. A count below 1 (after truncation) or non-finite grants nothing.
   */
  grant(itemId: ItemId, count: number, source: string): void {
    const n = Number.isFinite(count) ? Math.trunc(count) : 0;
    if (n < 1) return;
    const inv = this.state.inventory;
    const next = addItem(inv, itemId, n);
    inv.items = { ...next.items };
    inv.ownedEquipment = [...next.ownedEquipment];
    this.bus.emit('item:granted', { itemId, count: n, source });
  }

  /** Adds Glim (never below 0; non-finite changes nothing). */
  addGlim(amount: number): void {
    const inv = this.state.inventory;
    inv.glim = addGlim(inv, amount).glim;
  }

  /** How many of `itemId` are held (equipment: 1 when owned). */
  count(itemId: ItemId): number {
    const inv = this.state.inventory;
    if (inv.ownedEquipment.includes(itemId)) return 1;
    return inv.items[itemId] ?? 0;
  }

  /**
   * Takes `starmote` Starmote and `glim` Glim together (the Echo Altar); refused, taking nothing, when either is
   * short or an amount is negative / non-finite.
   */
  spend(starmote: number, glim: number): boolean {
    if (!(Number.isFinite(starmote) && Number.isFinite(glim) && starmote >= 0 && glim >= 0)) return false;
    const inv = this.state.inventory;
    if ((inv.items[STARMOTE_ID] ?? 0) < starmote || inv.glim < glim) return false;
    inv.items = { ...addItem(inv, STARMOTE_ID, -starmote).items };
    inv.glim -= glim;
    return true;
  }

  /** Uses one held consumable; false (nothing changes) when none is held or `itemId` is no consumable. */
  consume(itemId: ItemId): boolean {
    const inv = this.state.inventory;
    const used = useItem(inv, itemId);
    if (!used.ok) return false;
    inv.items = { ...used.inv.items };
    return true;
  }

  /** Buys one `itemId` from Pip at its SHOP_STOCK price (Req 14.11, 14.12); only `ok: true` changes anything. */
  purchase(itemId: ItemId): ShopPurchaseResult {
    const entry = SHOP_STOCK.find((e) => e.id === itemId);
    if (entry === undefined) return { ok: false, reason: 'notSold' };
    const inv = this.state.inventory;
    const result = purchase(inv, itemId, entry.price);
    if (!result.ok) return result;
    inv.glim = result.inv.glim;
    inv.items = { ...result.inv.items };
    inv.ownedEquipment = [...result.inv.ownedEquipment];
    this.bus.emit('item:granted', { itemId, count: 1, source: SHOP_SOURCE });
    return result;
  }

  /**
   * Equips `itemId` in `characterId`'s `slot` (the party Relic for 'relic'), or unequips it with null (Req 30.2,
   * 30.3). An applied change is written at once and requests the 'equipment' Milestone save.
   */
  equip(characterId: CharacterId, slot: EquipSlot, itemId: ItemId | null): EquipResult {
    const { party, inventory } = this.state;
    const result = equip(party, inventory.ownedEquipment, characterId, slot, itemId);
    if (!result.ok) return result;
    party.equipment = result.loadout.equipment;
    party.relic = result.loadout.relic;
    this.bus.emit('save:request', { reason: 'equipment' });
    return result;
  }
}
