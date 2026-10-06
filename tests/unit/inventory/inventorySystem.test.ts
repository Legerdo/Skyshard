import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import { InventorySystem } from '../../../src/inventory/inventorySystem';
import { createNewGameState } from '../../../src/logic/save/gameState';

function setup() {
  const gs = createNewGameState(3);
  gs.party.joined = ['kairen', 'isla'];
  const bus = createGameEventBus();
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const inventory = new InventorySystem({ state: gs, bus });
  const of = (type: GameEventName): unknown[] => {
    bus.dispatch();
    return events.filter((e) => e.type === type).map((e) => e.payload);
  };
  return { gs, inventory, of };
}

describe('InventorySystem shop purchases (Req 14.11, 14.12)', () => {
  it('buys at Pip’s price, repeats consumables up to the cap and sells a Charm once', () => {
    const { gs, inventory, of } = setup();
    gs.inventory.glim = 1000;
    expect(inventory.purchase('con_herbDumpling')).toMatchObject({ ok: true });
    expect([gs.inventory.glim, gs.inventory.items.con_herbDumpling]).toEqual([960, 4]);
    for (let i = 0; i < 6; i++) inventory.purchase('con_herbDumpling');
    expect(gs.inventory.items.con_herbDumpling).toBe(10);
    expect(inventory.purchase('con_herbDumpling')).toEqual({ ok: false, reason: 'cap' });
    expect(gs.inventory.glim).toBe(1000 - 7 * 40);
    expect(inventory.purchase('chm_ember_ribbon')).toMatchObject({ ok: true });
    expect(inventory.purchase('chm_ember_ribbon')).toEqual({ ok: false, reason: 'owned' });
    expect(gs.inventory.ownedEquipment).toEqual(['chm_ember_ribbon']);
    expect(of('item:granted')).toHaveLength(8);
    expect(of('item:granted')[0]).toEqual({ itemId: 'con_herbDumpling', count: 1, source: 'shop' });
  });

  it('refuses short Glim with the missing amount and items Pip does not sell, changing nothing', () => {
    const { gs, inventory, of } = setup();
    gs.inventory.glim = 90;
    const before = structuredClone(gs.inventory);
    expect(inventory.purchase('con_emberFeather')).toEqual({ ok: false, reason: 'glim', missing: 30 });
    expect(inventory.purchase('wpn_kairen_emberfang')).toEqual({ ok: false, reason: 'notSold' });
    expect(gs.inventory).toEqual(before);
    expect(of('item:granted')).toEqual([]);
  });
});

describe('InventorySystem spend / consume / equip', () => {
  it('spends Starmote and Glim together or not at all', () => {
    const { gs, inventory } = setup();
    gs.inventory.items.mat_starmote = 5;
    gs.inventory.glim = 120;
    expect(inventory.spend(6, 100)).toBe(false);
    expect(inventory.spend(3, 130)).toBe(false);
    expect(inventory.spend(-1, 0)).toBe(false);
    expect([gs.inventory.items.mat_starmote, gs.inventory.glim]).toEqual([5, 120]);
    expect(inventory.spend(3, 100)).toBe(true);
    expect([gs.inventory.items.mat_starmote, gs.inventory.glim]).toEqual([2, 20]);
  });

  it('consumes held consumables only', () => {
    const { gs, inventory } = setup();
    expect(inventory.consume('con_herbDumpling')).toBe(true);
    expect(gs.inventory.items.con_herbDumpling).toBe(2);
    expect(inventory.consume('con_emberFeather')).toBe(false);
    expect(inventory.consume('mat_starmote')).toBe(false);
    expect([inventory.count('con_herbDumpling'), inventory.count('chm_dewdrop')]).toEqual([2, 0]);
  });

  it('applies an equip at once and requests the equipment Milestone save; refusals change nothing', () => {
    const { gs, inventory, of } = setup();
    gs.inventory.ownedEquipment = ['chm_dewdrop', 'wpn_isla_tidecaller'];
    expect(inventory.equip('isla', 'weapon', 'wpn_isla_tidecaller')).toMatchObject({ ok: true });
    expect(gs.party.equipment.isla.weapon).toBe('wpn_isla_tidecaller');
    expect(inventory.equip('kairen', 'charm', 'chm_dewdrop')).toMatchObject({ ok: true });
    expect(inventory.equip('isla', 'charm', 'chm_dewdrop')).toMatchObject({ ok: true, movedFrom: 'kairen' });
    expect([gs.party.equipment.kairen.charm, gs.party.equipment.isla.charm]).toEqual([null, 'chm_dewdrop']);
    expect(inventory.equip('wren', 'charm', 'chm_dewdrop')).toEqual({ ok: false, reason: 'notJoined' });
    expect(inventory.equip('isla', 'weapon', null)).toMatchObject({ ok: true, after: null });
    expect(gs.party.equipment.isla.weapon).toBeNull();
    expect(of('save:request')).toEqual([{ reason: 'equipment' }, { reason: 'equipment' }, { reason: 'equipment' }, { reason: 'equipment' }]);
  });
});
