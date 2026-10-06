import { describe, expect, it } from 'vitest';
import type { ItemId } from '../../../src/data/ids';
import { ITEMS, type EquipEffect } from '../../../src/data/items';
import {
  NO_EFFECT_TEXT, NO_MODIFIERS, effectsOf, equip, equipModifiers, modifiersOf, slotEffectText, slotItemName,
} from '../../../src/logic/equipment';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';

function party(owned: ItemId[] = []): { party: GameState['party']; owned: ItemId[] } {
  const gs = createNewGameState(1);
  gs.party.joined = ['kairen', 'isla', 'wren', 'talus'];
  return { party: gs.party, owned };
}

describe('equip (Req 30.2)', () => {
  it('puts a Weapon only in its own character slot and returns to the default weapon on unequip', () => {
    const { party: p, owned } = party(['wpn_kairen_emberfang']);
    expect(equip(p, owned, 'isla', 'weapon', 'wpn_kairen_emberfang')).toEqual({ ok: false, reason: 'wrongCharacter' });
    const on = equip(p, owned, 'kairen', 'weapon', 'wpn_kairen_emberfang');
    expect(on).toMatchObject({ ok: true, before: null, after: 'wpn_kairen_emberfang', movedFrom: null });
    if (!on.ok) return;
    expect(on.loadout.equipment.kairen.weapon).toBe('wpn_kairen_emberfang');
    expect(p.equipment.kairen.weapon).toBeNull(); // input untouched
    const off = equip({ ...p, ...on.loadout }, owned, 'kairen', 'weapon', null);
    expect(off).toMatchObject({ ok: true, before: 'wpn_kairen_emberfang', after: null });
    if (off.ok) expect(off.loadout.equipment.kairen.weapon).toBeNull();
  });

  it('moves a Charm worn by another character', () => {
    const { party: p, owned } = party(['chm_dewdrop']);
    const first = equip(p, owned, 'kairen', 'charm', 'chm_dewdrop');
    if (!first.ok) throw new Error('refused');
    const moved = equip({ ...p, ...first.loadout }, owned, 'isla', 'charm', 'chm_dewdrop');
    expect(moved).toMatchObject({ ok: true, movedFrom: 'kairen', before: null, after: 'chm_dewdrop' });
    if (!moved.ok) return;
    expect([moved.loadout.equipment.kairen.charm, moved.loadout.equipment.isla.charm]).toEqual([null, 'chm_dewdrop']);
  });

  it('keeps one party Relic whatever character asks', () => {
    const { party: p, owned } = party(['rlc_ember_core', 'rlc_verdant_seed']);
    p.joined = ['kairen'];
    const r = equip(p, owned, 'talus', 'relic', 'rlc_ember_core'); // an unjoined character may still set the party Relic
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.loadout.relic).toBe('rlc_ember_core');
    const swap = equip({ ...p, ...r.loadout }, owned, 'kairen', 'relic', 'rlc_verdant_seed');
    expect(swap).toMatchObject({ ok: true, before: 'rlc_ember_core', after: 'rlc_verdant_seed' });
  });

  it('refuses unowned, unknown, wrong-slot, unjoined and unchanged requests', () => {
    const { party: p, owned } = party(['chm_starlit_eye']);
    expect(equip(p, owned, 'kairen', 'charm', 'chm_dewdrop')).toEqual({ ok: false, reason: 'notOwned' });
    expect(equip(p, owned, 'kairen', 'charm', 'con_herbDumpling')).toEqual({ ok: false, reason: 'unknownItem' });
    expect(equip(p, owned, 'kairen', 'relic', 'chm_starlit_eye')).toEqual({ ok: false, reason: 'wrongSlot' });
    expect(equip(p, owned, 'kairen', 'charm', null)).toEqual({ ok: false, reason: 'unchanged' });
    p.joined = ['kairen'];
    expect(equip(p, owned, 'wren', 'charm', 'chm_starlit_eye')).toEqual({ ok: false, reason: 'notJoined' });
  });
});

describe('EquipEffect modifiers (Req 30.1, 30.3)', () => {
  it('folds every effect kind and starts from neutral values', () => {
    expect(modifiersOf([])).toEqual(NO_MODIFIERS);
    const effects = ITEMS.flatMap((i) => (i.effect === undefined ? [] : [i.effect]));
    const m = modifiersOf(effects);
    expect(m).toEqual({
      critChanceAdd: 0.1,
      reactionDamagePct: 0.2,
      dodgeStaminaMul: 0.75,
      shieldDamageTakenMul: 0.85,
      markDotPct: { ember: 0.5 },
      perfectDodgeHealPct: 0.05,
      reactionEnergyToParty: 3,
      outOfCombatRegenPctPerSec: 0.01,
      chestCompassRadius: 40,
      normalFinisherWave: { mul: 0.6, radius: 3 },
      chargedPuddleSeconds: 3,
      launchPullRadius: 3,
      pillarBonus: { seconds: 3, knockback: 3 },
    });
    expect(() => modifiersOf([{ kind: 'nope' } as unknown as EquipEffect])).toThrow();
  });

  it('reads a character’s Weapon and Charm and the party Relic only', () => {
    const { party: p } = party();
    p.equipment.kairen = { weapon: 'wpn_kairen_emberfang', charm: 'chm_starlit_eye' };
    p.equipment.isla.charm = 'chm_dewdrop';
    p.relic = 'rlc_ember_core';
    expect(effectsOf(p, 'kairen').map((e) => e.kind)).toEqual(['normalFinisherWave', 'critChance', 'reactionDamage']);
    expect(effectsOf(p, 'wren').map((e) => e.kind)).toEqual(['reactionDamage']);
    expect(equipModifiers(p, 'isla')).toMatchObject({ perfectDodgeHealPct: 0.05, critChanceAdd: 0, reactionDamagePct: 0.2 });
  });

  it('names slots and writes "효과 없음" for empty slots and default weapons', () => {
    expect(slotEffectText(null)).toBe(NO_EFFECT_TEXT);
    expect(slotEffectText('chm_feather_bell')).toBe('Dodge Stamina 소모 −25%');
    expect(slotItemName('kairen', 'weapon', null)).toBe('기본 무기 (한손 곡검)');
    expect(slotItemName('kairen', 'charm', null)).toBe('비어 있음');
    expect(slotItemName('isla', 'weapon', 'wpn_isla_tidecaller')).toBe('조수부름 활');
  });
});
