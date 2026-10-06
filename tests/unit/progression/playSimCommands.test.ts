// Tasks 12.1–12.5 wired into the play session: the UiCommands (upgradeAbility, equip, useItem, purchase) apply on the
// next tick, Z uses a herb dumpling, quest grants pay XP and a level-up heals the party.
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameEventName } from '../../../src/core/gameEvents';
import { UiCommandQueue, type UiCommand } from '../../../src/core/uiCommands';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { PlaySim } from '../../../src/playSim';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

const DT = 1 / 60;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(20240601);
});

function session() {
  const gameState = createNewGameState(20240601);
  gameState.party.joined = [...PARTY_SLOTS];
  const input = new InputState();
  const commands = new UiCommandQueue();
  const sim = new PlaySim({ gameState, terrain, input, commands, sinks: { partyWipe: () => {}, ending: () => {} } });
  const events: { type: GameEventName; payload: unknown }[] = [];
  sim.bus.onAny((type, payload) => events.push({ type, payload }));
  const step = (raw: RawInput[] = []): void => {
    input.beginTick(raw, DT);
    sim.tick(DT, 0);
  };
  const send = (command: UiCommand): void => {
    commands.push(command);
    step();
  };
  const of = (type: GameEventName): unknown[] => events.filter((e) => e.type === type).map((e) => e.payload);
  return { sim, gs: gameState, step, send, of, commands };
}

describe('PlaySim UiCommands (tasks 12.3–12.5)', () => {
  it('upgradeAbility raises the tier and takes the cost on the next tick; the upgraded Skill is what combat casts', () => {
    const { gs, send } = session();
    gs.inventory.items.mat_starmote = 3;
    gs.inventory.glim = 150;
    send({ kind: 'upgradeAbility', characterId: 'kairen', ability: 'skill' });
    expect(gs.party.upgrades.kairen.skill).toBe(1);
    expect([gs.inventory.items.mat_starmote, gs.inventory.glim]).toEqual([0, 50]);
    send({ kind: 'upgradeAbility', characterId: 'kairen', ability: 'skill' }); // short: refused, nothing taken
    expect([gs.party.upgrades.kairen.skill, gs.inventory.glim]).toEqual([1, 50]);
  });

  it('equip applies in the same tick (combat modifiers see it) and requests the equipment save', () => {
    const { sim, gs, send, of } = session();
    gs.inventory.ownedEquipment = ['chm_starlit_eye'];
    send({ kind: 'equip', characterId: 'kairen', slot: 'charm', itemId: 'chm_starlit_eye' });
    expect(gs.party.equipment.kairen.charm).toBe('chm_starlit_eye');
    expect(sim.equipment.modifiers('kairen').critChanceAdd).toBeCloseTo(0.1, 12);
    expect(of('save:request')).toContainEqual({ reason: 'equipment' });
    send({ kind: 'equip', characterId: 'kairen', slot: 'charm', itemId: null });
    expect(sim.equipment.modifiers('kairen').critChanceAdd).toBe(0);
  });

  it('purchase buys from Pip only when purchase allows it', () => {
    const { gs, send, of } = session();
    gs.inventory.glim = 350;
    send({ kind: 'purchase', itemId: 'chm_feather_bell' });
    send({ kind: 'purchase', itemId: 'con_emberFeather' }); // 50 left: refused
    expect(gs.inventory.glim).toBe(50);
    expect(gs.inventory.ownedEquipment).toEqual(['chm_feather_bell']);
    expect(gs.inventory.items.con_emberFeather ?? 0).toBe(0);
    expect(of('item:granted')).toContainEqual({ itemId: 'chm_feather_bell', count: 1, source: 'shop' });
  });

  it('Z uses a herb dumpling on the Active_Character; useItem revives a Downed companion with an Ember Feather', () => {
    const { sim, gs, step, send } = session();
    for (let i = 0; i < 20; i++) step();
    gs.party.hp.kairen = 200;
    step([{ kind: 'down', code: 'KeyZ', time: 0 }, { kind: 'up', code: 'KeyZ', time: 0 }]);
    expect(gs.party.hp.kairen).toBe(200 + Math.round(sim.party.maxHp('kairen') * 0.35));
    expect(gs.inventory.items.con_herbDumpling).toBe(2);
    expect(sim.consumables.healCooldown).toBeGreaterThan(2.9);
    gs.inventory.items.con_emberFeather = 1;
    gs.party.hp.isla = 0;
    gs.party.downed = ['isla'];
    send({ kind: 'useItem', itemId: 'con_emberFeather', target: 'isla' });
    expect(gs.party.downed).toEqual([]);
    expect(gs.party.hp.isla).toBe(Math.round(sim.party.maxHp('isla') * 0.3));
    expect(gs.inventory.items.con_emberFeather).toBe(0);
  });
});

describe('PlaySim menu commands (task 14.2)', () => {
  it('applies the menu screens\' commands at once under a menu and keeps the rest queued in order', () => {
    const { sim, gs, of, commands } = session();
    gs.inventory.glim = 350;
    gs.inventory.ownedEquipment = ['chm_starlit_eye'];
    commands.push({ kind: 'unstuck' });
    commands.push({ kind: 'purchase', itemId: 'chm_feather_bell' });
    commands.push({ kind: 'equip', characterId: 'kairen', slot: 'charm', itemId: 'chm_starlit_eye' });
    commands.push({ kind: 'continueExploring' });
    sim.applyMenuCommands();
    expect(gs.inventory.ownedEquipment).toContain('chm_feather_bell');
    expect(gs.inventory.glim).toBe(50);
    expect(gs.party.equipment.kairen.charm).toBe('chm_starlit_eye');
    expect(of('save:request')).toContainEqual({ reason: 'equipment' }); // the EventDispatch ran
    expect(commands.drain()).toEqual([{ kind: 'unstuck' }, { kind: 'continueExploring' }]);
  });

  it('"끼임 해제" (unstuck) starts the recovery path on the next tick', () => {
    const { sim, send } = session();
    for (let i = 0; i < 5; i++) send({ kind: 'trackQuest', questId: null });
    send({ kind: 'unstuck' });
    expect(sim.recovery.reason).toBe('manual');
  });
});

describe('PlaySim XP (task 12.1)', () => {
  it('quest grant effects pay XP; a level-up heals everyone and emits one levelUp', () => {
    const { sim, gs, step, of } = session();
    gs.party.hp.wren = 5;
    sim.quests.applyEffects([{ kind: 'grant', reward: { xp: 320, glim: 40 } }]);
    step();
    expect(gs.party).toMatchObject({ xp: 320, level: 3 });
    expect(gs.inventory.glim).toBe(40);
    expect(of('levelUp')).toEqual([{ level: 3 }]);
    expect(gs.party.hp.wren).toBe(sim.party.maxHp('wren'));
  });
});
