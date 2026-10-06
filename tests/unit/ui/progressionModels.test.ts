import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../../../src/data/characters';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { altarRows, missingText } from '../../../src/ui/models/altarModel';
import {
  consumableRows, equipmentCandidates, equipmentComparison, equipmentSlots,
} from '../../../src/ui/models/inventoryModel';
import { shopRows } from '../../../src/ui/models/shopModel';

function state(): GameState {
  const gs = createNewGameState(11);
  gs.party.joined = [...PARTY_SLOTS];
  return gs;
}

describe('shopRows (Req 14.12)', () => {
  it('lists the stock with prices and enables what purchase would accept', () => {
    const gs = state();
    gs.inventory.glim = 500;
    const rows = shopRows(gs);
    expect(rows.map((r) => [r.itemId, r.priceText, r.enabled])).toEqual([
      ['con_herbDumpling', '40 Glim', true],
      ['con_emberFeather', '120 Glim', true],
      ['chm_ember_ribbon', '300 Glim', true],
      ['chm_feather_bell', '300 Glim', true],
    ]);
    expect(rows[0]).toMatchObject({ name: '허브 경단', held: 3, heldText: '보유 3/10', status: '', command: { kind: 'purchase', itemId: 'con_herbDumpling' } });
  });

  it('disables refused items with "보유 중" / "보유 한도" and the missing Glim', () => {
    const gs = state();
    gs.inventory.glim = 30;
    gs.inventory.items.con_herbDumpling = 10;
    gs.inventory.ownedEquipment = ['chm_ember_ribbon'];
    const [herb, feather, ribbon, bell] = shopRows(gs);
    expect(herb).toMatchObject({ enabled: false, reason: 'cap', missingGlim: 10, notes: ['보유 한도', 'Glim 10 부족'], command: null });
    expect(feather).toMatchObject({ enabled: false, reason: 'glim', missingGlim: 90, status: 'Glim 90 부족' });
    expect(ribbon).toMatchObject({ enabled: false, reason: 'owned', heldText: '보유 중', status: '보유 중 · Glim 270 부족' });
    expect(bell).toMatchObject({ enabled: false, reason: 'glim', missingGlim: 270 });
    gs.inventory.glim = 5000;
    expect(shopRows(gs).map((r) => r.status)).toEqual(['보유 한도', '', '보유 중', '']);
  });
});

describe('altarRows (Req 29.5, 29.6)', () => {
  it('shows current and next tier, cost and the missing amounts', () => {
    const gs = state();
    gs.inventory.items.mat_starmote = 4;
    gs.inventory.glim = 100;
    gs.party.upgrades.kairen.skill = 1;
    const [skill, burst] = altarRows(gs, 'kairen');
    expect(skill).toMatchObject({
      kind: 'Skill', name: '화염 돌진', tier: 1, tierText: '1/3단계', current: '피해 +15%', next: '피해 +15%, 돌진 8 m',
      costText: 'Starmote 6 · Glim 250', enabled: false, missingText: 'Starmote 2 · Glim 150 부족', buttonText: '강화', command: null,
    });
    expect(burst).toMatchObject({
      kind: 'Burst', name: '태양 낙하', tier: 0, current: '강화 전', next: '피해 +15%', enabled: true, missingText: '',
      command: { kind: 'upgradeAbility', characterId: 'kairen', ability: 'burst' },
    });
  });

  it('shows "최대" at tier 3 with nothing missing', () => {
    const gs = state();
    gs.party.upgrades.talus.burst = 3;
    const burst = altarRows(gs, 'talus')[1];
    expect(burst).toMatchObject({
      tier: 3, next: '최대', buttonText: '최대', maxed: true, enabled: false, cost: null, costText: '',
      missingStarmote: 0, missingGlim: 0, missingText: '',
    });
    expect(burst?.current).toBe(CHARACTERS.talus.burst.upgrades.map((t) => t.label).join(' · '));
  });

  it('formats only the short amounts', () => {
    expect(missingText({ missingStarmote: 0, missingGlim: 150 })).toBe('Glim 150 부족');
    expect(missingText({ missingStarmote: 2, missingGlim: 0 })).toBe('Starmote 2 부족');
    expect(missingText({ missingStarmote: 0, missingGlim: 0 })).toBe('');
  });
});

describe('equipment view models (Req 30.3)', () => {
  it('lists the slots with "효과 없음" for the default weapon and empty slots', () => {
    const gs = state();
    gs.party.relic = 'rlc_ember_core';
    gs.inventory.ownedEquipment = ['rlc_ember_core'];
    expect(equipmentSlots(gs, 'isla').map((s) => [s.label, s.name, s.effect])).toEqual([
      ['무기', `기본 무기 (${CHARACTERS.isla.weaponName})`, '효과 없음'],
      ['부적', '비어 있음', '효과 없음'],
      ['유물', '잉걸 핵', 'Reaction 피해 +20%'],
    ]);
  });

  it('compares before and after, including moving a Charm and unequipping', () => {
    const gs = state();
    gs.inventory.ownedEquipment = ['chm_starlit_eye', 'chm_dewdrop'];
    gs.party.equipment.wren.charm = 'chm_starlit_eye';
    const cmp = equipmentComparison(gs, 'kairen', 'charm', 'chm_starlit_eye');
    expect(cmp).toMatchObject({
      label: '부적', allowed: true, movedFrom: 'wren', movedText: 'Wren에게서 옮겨 옵니다',
      before: { name: '비어 있음', effect: '효과 없음' }, after: { name: '별빛 눈', effect: '치명타 확률 +10%' },
      command: { kind: 'equip', characterId: 'kairen', slot: 'charm', itemId: 'chm_starlit_eye' },
    });
    const off = equipmentComparison(gs, 'wren', 'charm', null);
    expect(off).toMatchObject({ allowed: true, before: { effect: '치명타 확률 +10%' }, after: { effect: '효과 없음' } });
    expect(equipmentComparison(gs, 'kairen', 'charm', 'chm_stone_heart')).toMatchObject({ allowed: false, reasonText: '보유하지 않은 장비', command: null });
  });

  it('offers owned fitting candidates and unequipping', () => {
    const gs = state();
    gs.inventory.ownedEquipment = ['wpn_kairen_emberfang', 'wpn_isla_tidecaller', 'chm_dewdrop'];
    gs.party.equipment.isla.charm = 'chm_dewdrop';
    expect(equipmentCandidates(gs, 'kairen', 'weapon').map((c) => [c.itemId, c.allowed])).toEqual([
      ['wpn_kairen_emberfang', true], [null, false],
    ]);
    expect(equipmentCandidates(gs, 'kairen', 'charm').map((c) => [c.itemId, c.wornBy])).toEqual([['chm_dewdrop', 'isla'], [null, null]]);
  });
});

describe('consumableRows (Req 27.5, 27.6)', () => {
  it('shows counts, the herb dumpling state and the Downed Feather targets', () => {
    const gs = state();
    const [herb, feather] = consumableRows(gs);
    expect(herb).toMatchObject({ itemId: 'con_herbDumpling', countText: '3/10', usable: false, reasonText: 'HP가 가득 참' });
    expect(feather).toMatchObject({ itemId: 'con_emberFeather', usable: false, reasonText: '보유하지 않음', targets: [] });
    gs.party.hp.kairen = 10;
    gs.party.hp.wren = 0;
    gs.party.downed = ['wren'];
    gs.inventory.items.con_emberFeather = 1;
    const rows = consumableRows(gs, 2.2);
    expect(rows[0]).toMatchObject({ usable: false, reasonText: '3초 후 사용 가능' });
    expect(consumableRows(gs)[0]).toMatchObject({ usable: true, command: { kind: 'useItem', itemId: 'con_herbDumpling' } });
    expect(rows[1]).toMatchObject({
      usable: true, targets: [{ characterId: 'wren', name: 'Wren', command: { kind: 'useItem', itemId: 'con_emberFeather', target: 'wren' } }],
    });
  });
});
