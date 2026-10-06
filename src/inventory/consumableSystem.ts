// Consumable use (design "소비 아이템과 상점", Party_System "heal"; Req 27.5, 27.6):
// - Herb dumpling (`con_herbDumpling`, `heal` input Z or the Inventory screen's `useItem`): the Inventory_System takes
//   one and the Party_System heals the Active_Character by 35 % of max HP (clamped); for 3 s after a use the next one
//   is refused. Refused without using one (and without starting the wait) while none is held, the Active_Character
//   is Downed or at full HP, the party is wiped, or input is held.
// - Ember Feather (`con_emberFeather`, the `useItem` UiCommand with a `target`): only on a Downed joined character,
//   who stands up at 30 % of max HP; only then is one used.
// The item numbers (pct, cooldown) come from the ItemDef `use` data. The clock is this system's sim time.
// Pure TypeScript: no three.js / DOM.

import type { CharacterId, ItemId } from '../data/ids';
import { ITEM_BY_ID, type ConsumableUse } from '../data/items';
import type { GameState } from '../logic/save/gameState';
import type { InventorySystem } from './inventorySystem';
import type { PartySystem } from '../party/partySystem';

export const HERB_DUMPLING: ItemId = 'con_herbDumpling';
export const EMBER_FEATHER: ItemId = 'con_emberFeather';

/** Why a consumable use was refused. */
export type UseRefusal = 'none' | 'cooldown' | 'full' | 'blocked' | 'notDowned' | 'noTarget' | 'notUsable';

export type UseResult = { ok: true; itemId: ItemId; target: CharacterId; hp: number } | { ok: false; reason: UseRefusal };

export interface ConsumableSystemOptions {
  /** Reads the party (Active_Character, HP, Downed). */
  state: Pick<GameState, 'party'>;
  inventory: Pick<InventorySystem, 'consume' | 'count'>;
  party: Pick<PartySystem, 'heal' | 'revive' | 'maxHp' | 'inputBlocked' | 'wipeActive'>;
}

const TIME_EPS = 1e-6;

function useOf(itemId: ItemId): ConsumableUse | null {
  return ITEM_BY_ID.get(itemId)?.use ?? null;
}

export class ConsumableSystem {
  private readonly o: ConsumableSystemOptions;
  private time = 0;
  /** Sim time before which the herb dumpling is refused. */
  private healReadyAt = 0;

  constructor(options: ConsumableSystemOptions) {
    this.o = options;
  }

  /** Seconds left of the herb dumpling's reuse wait; 0 when ready (HUD). */
  get healCooldown(): number {
    return Math.max(0, this.healReadyAt - this.time);
  }

  /**
   * One tick (after the Party_System): the clock, then the `heal` press of this tick (false while input is held).
   * Returns the use's result when the key was pressed, else null.
   */
  tick(dt: number, healPressed: boolean): UseResult | null {
    if (Number.isFinite(dt) && dt > 0) this.time += dt;
    return healPressed ? this.useHeal() : null;
  }

  /** Herb dumpling on the Active_Character (Z). */
  useHeal(itemId: ItemId = HERB_DUMPLING): UseResult {
    const use = useOf(itemId);
    if (use?.kind !== 'heal') return { ok: false, reason: 'notUsable' };
    const { party } = this.o;
    const active = this.o.state.party.active;
    if (party.inputBlocked || party.wipeActive) return { ok: false, reason: 'blocked' };
    if (this.o.inventory.count(itemId) < 1) return { ok: false, reason: 'none' };
    if (this.time < this.healReadyAt - TIME_EPS) return { ok: false, reason: 'cooldown' };
    const { hp } = this.o.state.party;
    if (hp[active] >= party.maxHp(active)) return { ok: false, reason: 'full' };
    const added = party.heal(active, use.pct);
    if (added <= 0) return { ok: false, reason: 'blocked' };
    this.o.inventory.consume(itemId);
    this.healReadyAt = this.time + use.cooldown;
    return { ok: true, itemId, target: active, hp: hp[active] };
  }

  /**
   * The Inventory screen's `useItem` UiCommand: a heal item heals the Active_Character (as Z), a revive item needs a
   * Downed `target`. Anything else is refused.
   */
  useItem(itemId: ItemId, target?: CharacterId): UseResult {
    const use = useOf(itemId);
    if (use === null) return { ok: false, reason: 'notUsable' };
    if (use.kind === 'heal') return this.useHeal(itemId);
    if (target === undefined) return { ok: false, reason: 'noTarget' };
    if (this.o.inventory.count(itemId) < 1) return { ok: false, reason: 'none' };
    if (this.o.party.wipeActive) return { ok: false, reason: 'blocked' };
    if (!this.o.state.party.downed.includes(target)) return { ok: false, reason: 'notDowned' };
    if (!this.o.party.revive(target, use.pct)) return { ok: false, reason: 'notDowned' };
    this.o.inventory.consume(itemId);
    return { ok: true, itemId, target, hp: this.o.state.party.hp[target] };
  }
}
