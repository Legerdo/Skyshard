import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import { CHARACTERS } from '../../../src/data/characters';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { statsAt } from '../../../src/logic/progression';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { InventorySystem } from '../../../src/inventory/inventorySystem';
import { PartySystem } from '../../../src/party/partySystem';
import { ProgressionSystem } from '../../../src/progression/progressionSystem';
import { createRuntimeState } from '../../../src/save/runtimeState';

function setup() {
  const gs = createNewGameState(7);
  gs.party.joined = [...PARTY_SLOTS];
  const bus = createGameEventBus();
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const runtime = createRuntimeState(gs);
  const party = new PartySystem({ bus, state: gs, runtime, bossPhase: () => null });
  const progression = new ProgressionSystem({ state: gs, bus });
  const inventory = new InventorySystem({ state: gs, bus });
  const of = (type: GameEventName): unknown[] => events.filter((e) => e.type === type).map((e) => e.payload);
  return { gs, bus, events, of, party, progression, inventory };
}

describe('ProgressionSystem XP and level-up (Req 29.1, 29.2)', () => {
  it('emits one levelUp with the final level for a multi-level gain and caps XP at 3,000', () => {
    const { gs, bus, of, progression } = setup();
    expect(progression.grantXp(1600)).toBe(1600);
    bus.dispatch();
    expect(gs.party).toMatchObject({ xp: 1600, level: 7 });
    expect(of('levelUp')).toEqual([{ level: 7 }]);
    expect(of('save:request')).toEqual([{ reason: 'levelUp' }]);
    expect(progression.grantXp(5000)).toBe(1400);
    expect(progression.grantXp(10)).toBe(0);
    bus.dispatch();
    expect(gs.party).toMatchObject({ xp: 3000, level: 10 });
    expect(of('levelUp')).toEqual([{ level: 7 }, { level: 10 }]);
  });

  it('heals the whole party to the new max HP and clears Downed on levelUp', () => {
    const { gs, bus, progression } = setup();
    gs.party.hp.kairen = 10;
    gs.party.hp.isla = 0;
    gs.party.downed = ['isla'];
    progression.grantXp(300); // level 3
    bus.dispatch();
    for (const id of PARTY_SLOTS) expect(gs.party.hp[id], id).toBe(statsAt(CHARACTERS[id].baseStats, 3).hp);
    expect(gs.party.hp.talus).toBe(Math.round(CHARACTERS.talus.baseStats.hp * 1.08 ** 2));
    expect(gs.party.downed).toEqual([]);
  });

  it('pays Chest and first-discovery XP from the events, once per id', () => {
    const { gs, bus, progression } = setup();
    bus.emit('chest:opened', { chestId: 'chest_verdant_1', tier: 'glowing' });
    bus.emit('chest:opened', { chestId: 'chest_verdant_1', tier: 'glowing' });
    bus.emit('chest:opened', { chestId: 'chest_verdant_2', tier: 'common' });
    bus.emit('landmark:discovered', { landmarkId: 'lm_elderbough', regionId: 'verdant' });
    bus.emit('waystone:activated', { waystoneId: 'ws_elderbough', regionId: 'verdant' });
    bus.dispatch();
    expect(gs.party.xp).toBe(50 + 10 + 20 + 15);
    expect(progression.grantDiscovery('vista', 'vista_verdant_1')).toBe(30);
    expect(progression.grantDiscovery('vista', 'vista_verdant_1')).toBe(0);
    expect(progression.grantDiscovery('hidden', 'poi_verdant_4')).toBe(40);
    expect(progression.grantDiscovery('tablet', 'tab_verdant_1')).toBe(10);
    expect(progression.grantChest('chest_ember_1', 'fine')).toBe(25);
  });

  it('stops listening after dispose', () => {
    const { gs, bus, progression } = setup();
    progression.dispose();
    bus.emit('landmark:discovered', { landmarkId: 'lm_elderbough', regionId: 'verdant' });
    bus.dispatch();
    expect(gs.party.xp).toBe(0);
  });
});

describe('Echo Altar upgradeAbility (Req 29.4–29.6)', () => {
  it('takes Starmote and Glim and raises the tier up to 3, refusing short or maxed requests unchanged', () => {
    const { gs, progression, inventory } = setup();
    gs.inventory.items.mat_starmote = 19;
    gs.inventory.glim = 850;
    expect(progression.upgradeAbility('kairen', 'skill', inventory)).toEqual({ ok: true, tier: 1 });
    expect([gs.inventory.items.mat_starmote, gs.inventory.glim]).toEqual([16, 750]);
    expect(progression.upgradeAbility('kairen', 'skill', inventory)).toEqual({ ok: true, tier: 2 });
    expect(progression.upgradeAbility('kairen', 'skill', inventory)).toEqual({ ok: true, tier: 3 });
    expect([gs.inventory.items.mat_starmote, gs.inventory.glim, gs.party.upgrades.kairen.skill]).toEqual([0, 0, 3]);
    expect(progression.upgradeAbility('kairen', 'skill', inventory)).toMatchObject({ ok: false, check: { nextTier: null } });
    expect(progression.upgradeAbility('kairen', 'burst', inventory)).toEqual({
      ok: false, check: { ok: false, missingStarmote: 3, missingGlim: 100, nextTier: 1 },
    });
    expect(gs.party.upgrades.kairen.burst).toBe(0);
  });

  it('changes nothing when the payer refuses', () => {
    const { gs, progression } = setup();
    gs.inventory.items.mat_starmote = 3;
    gs.inventory.glim = 100;
    expect(progression.upgradeAbility('isla', 'burst', { spend: () => false })).toMatchObject({ ok: false });
    expect(gs.party.upgrades.isla.burst).toBe(0);
  });
});
