import { describe, expect, it } from 'vitest';
import type { ItemId } from '../../../src/data/ids';
import { CONSUMABLE_CAP, ITEMS, ITEM_BY_ID, SHOP_STOCK, STARTING_ITEMS } from '../../../src/data/items';
import { addGlim, addItem, purchase, useItem, type Inventory } from '../../../src/logic/inventory';
import { rollChest, type Reward } from '../../../src/logic/loot';

/** Frozen inventory: any mutation by the code under test throws. */
function inv(glim: number, items: Inventory['items'] = {}, ownedEquipment: ItemId[] = []): Inventory {
  return Object.freeze({ glim, items: Object.freeze({ ...items }), ownedEquipment: Object.freeze([...ownedEquipment]) });
}

const PREFIX = { weapon: 'wpn_', charm: 'chm_', relic: 'rlc_', consumable: 'con_', material: 'mat_' } as const;

describe('item data', () => {
  it('has 13 equipment pieces (4 weapons, 6 charms, 3 relics) with distinct effects, 2 consumables and Starmote', () => {
    const ids = (kind: string): ItemId[] => ITEMS.filter((item) => item.kind === kind).map((item) => item.id);
    expect(ids('weapon')).toEqual(['wpn_kairen_emberfang', 'wpn_isla_tidecaller', 'wpn_wren_skyreaver', 'wpn_talus_bulwark']);
    expect([ids('charm').length, ids('relic').length]).toEqual([6, 3]);
    expect([...ids('consumable'), ...ids('material')]).toEqual(['con_herbDumpling', 'con_emberFeather', 'mat_starmote']);
    const equipment = ITEMS.filter((item) => item.effect !== undefined);
    expect(new Set(equipment.map((item) => item.effect?.kind)).size).toBe(13);
    expect(ITEMS.filter((item) => !item.id.startsWith(PREFIX[item.kind])).map((item) => item.id)).toEqual([]);
    expect(ITEMS.filter((item) => item.kind === 'weapon').map((item) => item.character)).toEqual(['kairen', 'isla', 'wren', 'talus']);
    expect(ITEM_BY_ID.size).toBe(ITEMS.length);
  });

  it('defines consumables, the shop and the New Game stock', () => {
    expect(ITEM_BY_ID.get('con_herbDumpling')).toMatchObject({ name: '허브 경단', cap: 10, price: 40, use: { pct: 0.35 } });
    expect(ITEM_BY_ID.get('con_emberFeather')).toMatchObject({ name: '불씨 깃털', cap: 10, price: 120, use: { pct: 0.3 } });
    expect(SHOP_STOCK.map((entry) => [entry.id, entry.price])).toEqual([
      ['con_herbDumpling', 40],
      ['con_emberFeather', 120],
      ['chm_ember_ribbon', 300],
      ['chm_feather_bell', 300],
    ]);
    for (const entry of SHOP_STOCK) expect(ITEM_BY_ID.get(entry.id)?.price, entry.id).toBe(entry.price);
    expect([CONSUMABLE_CAP, STARTING_ITEMS]).toEqual([10, { con_herbDumpling: 3 }]);
  });
});

describe('addItem / useItem / addGlim', () => {
  it('clamps consumables to 0..10, keeps materials ≥ 0 and records equipment once', () => {
    const start = inv(0, STARTING_ITEMS);
    expect(addItem(start, 'con_herbDumpling', 20).items.con_herbDumpling).toBe(10);
    expect(addItem(start, 'con_herbDumpling', -5).items.con_herbDumpling).toBe(0);
    expect(addItem(start, 'mat_starmote', 250).items.mat_starmote).toBe(250);
    expect(addItem(inv(0, { mat_starmote: 4 }), 'mat_starmote', -10).items.mat_starmote).toBe(0);
    const twice = addItem(addItem(start, 'chm_dewdrop', 1), 'chm_dewdrop', 3);
    expect(twice).toEqual({ glim: 0, items: { con_herbDumpling: 3 }, ownedEquipment: ['chm_dewdrop'] });
    expect(start).toEqual({ glim: 0, items: { con_herbDumpling: 3 }, ownedEquipment: [] });
  });

  it('uses one held consumable and refuses anything else', () => {
    const start = inv(0, { con_herbDumpling: 1, mat_starmote: 3 }, ['chm_dewdrop']);
    const used = useItem(start, 'con_herbDumpling');
    expect(used).toEqual({ ok: true, inv: { ...start, items: { con_herbDumpling: 0, mat_starmote: 3 } } });
    expect(useItem(used.inv, 'con_herbDumpling')).toEqual({ ok: false, inv: used.inv });
    expect([useItem(start, 'mat_starmote').ok, useItem(start, 'chm_dewdrop').ok]).toEqual([false, false]);
    expect([addGlim(inv(50), -80).glim, addGlim(inv(50), 25).glim]).toEqual([0, 75]);
  });
});

describe('purchase', () => {
  it('refuses owned → cap → glim with the missing Glim, without touching the inventory', () => {
    const start = inv(30, { con_herbDumpling: 10 }, ['chm_ember_ribbon']);
    expect(purchase(start, 'chm_ember_ribbon', 300)).toEqual({ ok: false, reason: 'owned', missing: 270 });
    expect(purchase(start, 'con_herbDumpling', 40)).toEqual({ ok: false, reason: 'cap', missing: 10 });
    expect(purchase(start, 'con_emberFeather', 120)).toEqual({ ok: false, reason: 'glim', missing: 90 });
    expect(purchase(inv(500, { con_herbDumpling: 10 }), 'con_herbDumpling', 40)).toEqual({ ok: false, reason: 'cap' });
    expect(start).toEqual({ glim: 30, items: { con_herbDumpling: 10 }, ownedEquipment: ['chm_ember_ribbon'] });
    expect(() => purchase(start, 'con_herbDumpling', -1)).toThrow(RangeError);
  });

  it('spends exactly the price and sells each charm once', () => {
    const bell = purchase(inv(300), 'chm_feather_bell', 300);
    expect(bell).toEqual({ ok: true, inv: { glim: 0, items: {}, ownedEquipment: ['chm_feather_bell'] } });
    if (bell.ok) expect(purchase(bell.inv, 'chm_feather_bell', 0)).toEqual({ ok: false, reason: 'owned' });
    expect(purchase(inv(100, { con_herbDumpling: 9 }), 'con_herbDumpling', 40)).toEqual({
      ok: true,
      inv: { glim: 60, items: { con_herbDumpling: 10 }, ownedEquipment: [] },
    });
  });
});

describe('rollChest', () => {
  const none = new Set<ItemId>();
  const glimOf = (rewards: Reward[]): number => rewards.reduce((sum, r) => sum + (r.kind === 'glim' ? r.amount : 0), 0);

  it('is deterministic per chest id and draws each tier from its range', () => {
    for (const tier of ['common', 'fine', 'glowing'] as const) {
      expect(rollChest(tier, 'chest_ember_3', none)).toEqual(rollChest(tier, 'chest_ember_3', new Set<ItemId>()));
    }
    const common = Array.from({ length: 400 }, (_, i) => rollChest('common', `chest_verdant_${i}`, none));
    const glim = common.map(glimOf);
    expect([Math.min(...glim), Math.max(...glim)]).toEqual([30, 60]);
    const herbRate = common.filter((r) => r.some((x) => x.kind === 'item' && x.id === 'con_herbDumpling')).length / 400;
    expect(herbRate).toBeGreaterThan(0.4);
    expect(herbRate).toBeLessThan(0.6);
    const fine = rollChest('fine', 'chest_azure_7', none);
    expect(fine).toHaveLength(2);
    expect(glimOf(fine)).toBeGreaterThanOrEqual(60);
    expect(glimOf(fine)).toBeLessThanOrEqual(120);
  });

  it('gives a glowing chest its designated equipment while unowned, else Starmote 5 + Glim 200', () => {
    const item: ItemId = 'wpn_kairen_emberfang';
    expect(rollChest('glowing', 'chest_verdant_9', none, item)).toEqual([{ kind: 'item', id: item, count: 1 }]);
    const fallback = [
      { kind: 'item', id: 'mat_starmote', count: 5 },
      { kind: 'glim', amount: 200 },
    ];
    expect(rollChest('glowing', 'chest_verdant_9', new Set([item]), item)).toEqual(fallback);
    expect(rollChest('glowing', 'chest_verdant_9', none)).toEqual(fallback);
  });
});
