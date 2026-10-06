import { describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { CHARACTERS } from '../../../src/data/characters';
import { ConsumableSystem } from '../../../src/inventory/consumableSystem';
import { EquipmentEffects } from '../../../src/inventory/equipmentEffects';
import { InventorySystem } from '../../../src/inventory/inventorySystem';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { DODGE_STAMINA_COST } from '../../../src/logic/stamina';
import { PartySystem } from '../../../src/party/partySystem';
import { createRuntimeState } from '../../../src/save/runtimeState';

function setup() {
  const gs = createNewGameState(5);
  gs.party.joined = [...PARTY_SLOTS];
  const bus = createGameEventBus();
  const runtime = createRuntimeState(gs);
  const party = new PartySystem({ bus, state: gs, runtime, bossPhase: () => null });
  const inventory = new InventorySystem({ state: gs, bus });
  const consumables = new ConsumableSystem({ state: gs, inventory, party });
  const effects = new EquipmentEffects({ bus, state: gs, runtime, party });
  const max = (id: keyof typeof CHARACTERS): number => party.maxHp(id);
  return { gs, bus, runtime, party, inventory, consumables, effects, max };
}

describe('herb dumpling (Z, Req 27.5)', () => {
  it('heals the Active_Character 35 % of max HP, clamped, then refuses for 3 s', () => {
    const { gs, consumables, max } = setup();
    gs.party.hp.kairen = 100;
    expect(consumables.tick(1 / 60, true)).toMatchObject({ ok: true, target: 'kairen', hp: 100 + Math.round(max('kairen') * 0.35) });
    expect(gs.inventory.items.con_herbDumpling).toBe(2);
    expect(consumables.healCooldown).toBeCloseTo(3, 9);
    gs.party.hp.kairen = 100;
    expect(consumables.tick(1, true)).toEqual({ ok: false, reason: 'cooldown' });
    expect(consumables.tick(1.5, false)).toBeNull();
    expect(consumables.tick(0.4, true)).toEqual({ ok: false, reason: 'cooldown' });
    gs.party.hp.kairen = max('kairen') - 10;
    expect(consumables.tick(0.1, true)).toMatchObject({ ok: true, hp: max('kairen') });
    expect(gs.inventory.items.con_herbDumpling).toBe(1);
  });

  it('uses none at full HP, when none is held or while the Active_Character is Downed', () => {
    const { gs, consumables, party } = setup();
    expect(consumables.useHeal()).toEqual({ ok: false, reason: 'full' });
    gs.party.hp.kairen = 50;
    gs.inventory.items.con_herbDumpling = 0;
    expect(consumables.useHeal()).toEqual({ ok: false, reason: 'none' });
    gs.inventory.items.con_herbDumpling = 3;
    gs.party.hp.kairen = 0;
    party.afterHits(); // Downed
    expect(consumables.useHeal()).toEqual({ ok: false, reason: 'blocked' });
    expect(gs.inventory.items.con_herbDumpling).toBe(3);
    expect(consumables.healCooldown).toBe(0);
  });
});

describe('Ember Feather (Req 27.6)', () => {
  it('revives only a Downed character at 30 % of max HP and is used only then', () => {
    const { gs, consumables, max } = setup();
    gs.inventory.items.con_emberFeather = 2;
    expect(consumables.useItem('con_emberFeather', 'isla')).toEqual({ ok: false, reason: 'notDowned' });
    expect(consumables.useItem('con_emberFeather')).toEqual({ ok: false, reason: 'noTarget' });
    gs.party.hp.isla = 0;
    gs.party.downed = ['isla'];
    expect(consumables.useItem('con_emberFeather', 'isla')).toEqual({ ok: true, itemId: 'con_emberFeather', target: 'isla', hp: Math.round(max('isla') * 0.3) });
    expect(gs.party.downed).toEqual([]);
    expect(gs.inventory.items.con_emberFeather).toBe(1);
    gs.inventory.items.con_emberFeather = 0;
    gs.party.downed = ['wren'];
    expect(consumables.useItem('con_emberFeather', 'wren')).toEqual({ ok: false, reason: 'none' });
    expect(consumables.useItem('mat_starmote', 'wren')).toEqual({ ok: false, reason: 'notUsable' });
  });

  it('cancels the Active_Character’s pending automatic switch when revived during its fall', () => {
    const { gs, consumables, party } = setup();
    gs.inventory.items.con_emberFeather = 1;
    gs.party.hp.kairen = 0;
    party.afterHits();
    expect(party.inputBlocked).toBe(true);
    expect(consumables.useItem('con_emberFeather', 'kairen')).toMatchObject({ ok: true });
    expect(party.inputBlocked).toBe(false);
    party.tick({ dt: 1, input: null, context: 'free' });
    expect(gs.party.active).toBe('kairen');
  });
});

describe('EquipmentEffects at run time (Req 30.3)', () => {
  it('regenerates the party 1 %/s out of combat with 새싹 씨앗 and stops the tick it is unequipped', () => {
    const { gs, runtime, effects, max } = setup();
    gs.party.relic = 'rlc_verdant_seed';
    gs.party.hp.kairen = 100;
    gs.party.hp.isla = 0;
    gs.party.downed = ['isla'];
    for (let i = 0; i < 60; i++) effects.tick(1 / 60);
    expect(gs.party.hp.kairen).toBe(100 + Math.floor(max('kairen') * 0.01 + 1e-9));
    expect(gs.party.hp.isla).toBe(0); // Downed members do not regenerate
    runtime.inCombat = true;
    const inCombat = gs.party.hp.kairen;
    for (let i = 0; i < 60; i++) effects.tick(1 / 60);
    expect(gs.party.hp.kairen).toBe(inCombat);
    runtime.inCombat = false;
    gs.party.relic = null;
    for (let i = 0; i < 60; i++) effects.tick(1 / 60);
    expect(gs.party.hp.kairen).toBe(inCombat);
  });

  it('heals on a Perfect_Dodge with 이슬방울 부적 and shares Reaction Energy with 메아리 소라', () => {
    const { gs, bus, runtime, effects, max } = setup();
    gs.party.equipment.kairen.charm = 'chm_dewdrop';
    gs.party.hp.kairen = 100;
    bus.emit('perfectDodge', { characterId: 'kairen', attackerId: 'e1' });
    bus.dispatch();
    expect(gs.party.hp.kairen).toBe(100 + Math.round(max('kairen') * 0.05));
    bus.emit('reaction', { reaction: 'steamBurst', targetId: 'e1', position: { x: 0, y: 0, z: 0 }, chainDepth: 0 });
    bus.dispatch();
    expect(runtime.energy).toEqual({ kairen: 0, isla: 0, wren: 0, talus: 0 });
    gs.party.equipment.kairen.charm = 'chm_echo_shell';
    gs.party.downed = ['talus'];
    bus.emit('reaction', { reaction: 'steamBurst', targetId: 'e1', position: { x: 0, y: 0, z: 0 }, chainDepth: 0 });
    bus.dispatch();
    expect(runtime.energy).toEqual({ kairen: 0, isla: 3, wren: 3, talus: 0 });
    effects.dispose();
  });

  it('gives back a quarter of the Dodge cost with 깃털 방울 and reads the compass radius', () => {
    const { gs, effects } = setup();
    expect([effects.dodgeRefund(), effects.chestCompassRadius]).toEqual([0, 0]);
    gs.party.equipment.kairen.charm = 'chm_feather_bell';
    gs.party.relic = 'rlc_wanderers_compass';
    expect(effects.dodgeRefund()).toBeCloseTo(DODGE_STAMINA_COST * 0.25, 9);
    expect(effects.chestCompassRadius).toBe(40);
    expect(effects.modifiers('kairen').dodgeStaminaMul).toBe(0.75);
    expect(effects.modifiers('isla').dodgeStaminaMul).toBe(1);
  });
});
