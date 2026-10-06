import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { CHESTS, CHEST_BY_ID, type ChestDef } from '../../../src/data/pois';
import { InventorySystem } from '../../../src/inventory/inventorySystem';
import { rollChest } from '../../../src/logic/loot';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { CHEST_LOCKED_TEXT, CHEST_SOURCE, ChestSystem, type ChestOpenedNotice } from '../../../src/loot/chestSystem';
import { ColliderIdSource } from '../../../src/physics/colliderIds';
import type { Collider } from '../../../src/physics/types';
import { ProgressionSystem } from '../../../src/progression/progressionSystem';

// Loot_System, Chest side (task 12.7; design "Chest와 보상표"; Req 10.5–10.7, 10.10, 30.6, 36.3).

const SEED = 20240601;
const chest = (id: string): ChestDef => {
  const c = CHEST_BY_ID.get(id);
  if (c === undefined) throw new Error(`no chest ${id}`);
  return c;
};

interface Options {
  state?: GameState;
  locked?: Set<string>;
  puzzles?: Set<string>;
  trials?: Set<string>;
  bodies?: Record<string, Vec3>;
}

function setup(o: Options = {}) {
  const bus = createGameEventBus();
  const state = o.state ?? createNewGameState(SEED);
  const statics: Collider[] = [];
  const dynamics: Collider[] = [];
  const inventory = new InventorySystem({ state, bus });
  const progression = new ProgressionSystem({ state, bus });
  const notices: ChestOpenedNotice[] = [];
  const locked = o.locked ?? new Set<string>();
  const puzzles = o.puzzles ?? new Set<string>();
  const trials = o.trials ?? new Set<string>();
  const chests = new ChestSystem({
    bus, state, world: {
      addStatic: (c) => void statics.push(c),
      upsertDynamic: (c) => {
        dynamics.push(c);
        return true;
      },
    }, ids: new ColliderIdSource(),
    heightAt: () => 5, inventory, locked: (id) => locked.has(id), puzzleOpen: (t) => puzzles.has(t), trialDone: (t) => trials.has(t),
    bodyAt: (id) => o.bodies?.[id] ?? null, opened: (n) => notices.push(n),
  });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const of = <K extends GameEventName>(type: K): GameEvents[K][] =>
    events.filter((e) => e.type === type).map((e) => e.payload as GameEvents[K]);
  const open = (id: string): void => {
    bus.emit('interact', { targetKind: 'chest', targetId: id });
    bus.dispatch();
  };
  return { bus, state, statics, dynamics, chests, progression, notices, locked, puzzles, trials, of, open };
}

describe('ChestSystem (Req 10.5–10.7)', () => {
  it('places every always-present Chest with a solid box; reward Chests wait for their condition', () => {
    const h = setup();
    const present = new Set(h.chests.views().filter((v) => v.present).map((v) => v.def.id));
    for (const c of CHESTS) {
      const always = c.source.kind === 'placed' || c.source.kind === 'camp';
      expect(present.has(c.id), c.id).toBe(always);
    }
    expect(h.statics).toHaveLength(present.size);
    // A raised Chest keeps its own surface height; others stand on the ground.
    const shelf = h.chests.views().find((v) => v.def.id === 'chest_verdant_4');
    expect(shelf?.pos.y).toBe(56);
    expect(h.chests.views().find((v) => v.def.id === 'chest_verdant_7')?.pos.y).toBe(5);
  });

  it('opens once: records it, emits chest:opened, grants the rolled rewards (item:granted), saves and notifies the HUD', () => {
    const h = setup();
    const id = 'chest_verdant_7'; // common, placed
    const glim0 = h.state.inventory.glim;
    const expected = rollChest('common', id, new Set());
    h.open(id);
    h.bus.dispatch();
    expect(h.state.world.chests).toEqual([id]);
    expect(h.state.stats.chestsOpened).toBe(1);
    expect(h.of('chest:opened')).toEqual([{ chestId: id, tier: 'common' }]);
    expect(h.of('save:request')).toContainEqual({ reason: 'chest' });
    const glim = expected.reduce((a, r) => a + (r.kind === 'glim' ? r.amount : 0), 0);
    expect(h.state.inventory.glim).toBe(glim0 + glim);
    const items = expected.filter((r) => r.kind === 'item');
    expect(h.of('item:granted')).toEqual(items.map((r) => ({ itemId: r.kind === 'item' ? r.id : '', count: r.kind === 'item' ? r.count : 0, source: CHEST_SOURCE })));
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ chestId: id, tier: 'common', region: 'verdant', rewards: expected });
    // XP by tier (common 10) through the Progression_System.
    expect(h.state.party.xp).toBe(10);

    h.open(id);
    expect(h.state.world.chests).toEqual([id]);
    expect(h.notices).toHaveLength(1);
    expect(h.chests.interactTargets().find((t) => t.id === id)?.available()).toBe(false);
  });

  it('a camp Chest stays shut while its camp is not cleared ("잠김"), then opens as a fine Chest', () => {
    const h = setup({ locked: new Set(['chest_ember_1']) });
    const target = h.chests.interactTargets().find((t) => t.id === 'chest_ember_1');
    expect(target?.detail?.()).toBe(CHEST_LOCKED_TEXT);
    h.open('chest_ember_1');
    expect(h.state.world.chests).toEqual([]);
    h.locked.clear();
    expect(target?.detail?.()).toBe('열기');
    h.open('chest_ember_1');
    expect(h.of('chest:opened')).toEqual([{ chestId: 'chest_ember_1', tier: 'fine' }]);
    const star = h.of('item:granted').find((g) => g.itemId === 'mat_starmote');
    expect(star?.count).toBeGreaterThanOrEqual(2);
    expect(star?.count).toBeLessThanOrEqual(3);
  });

  it('a glowing Chest gives its designated equipment while unowned, else Starmote 5 + Glim 200', () => {
    const def = chest('chest_ember_4');
    expect(def.item).toBe('wpn_isla_tidecaller');
    const h = setup();
    h.open(def.id);
    h.bus.dispatch();
    expect(h.state.inventory.ownedEquipment).toContain('wpn_isla_tidecaller');
    expect(h.of('item:granted')).toEqual([{ itemId: 'wpn_isla_tidecaller', count: 1, source: CHEST_SOURCE }]);

    const owned = createNewGameState(SEED);
    owned.inventory.ownedEquipment.push('wpn_isla_tidecaller');
    const again = setup({ state: owned });
    const glim0 = owned.inventory.glim;
    again.open(def.id);
    again.bus.dispatch();
    expect(again.of('item:granted')).toEqual([{ itemId: 'mat_starmote', count: 5, source: CHEST_SOURCE }]);
    expect(owned.inventory.glim).toBe(glim0 + 200);
  });

  it('the same Chest rolls the same rewards after a reload (its own mulberry32(hash(id)) stream)', () => {
    const a = setup();
    const b = setup();
    a.open('chest_crater_2');
    b.open('chest_crater_2');
    expect(a.notices[0]?.rewards).toEqual(b.notices[0]?.rewards);
  });
});

describe('Reward Chests (Req 10.10)', () => {
  it("a hidden Elite's glowing Chest appears once it is defeated, at the body's feet near its lair", () => {
    const def = chest('chest_verdant_5');
    expect(def.source).toEqual({ kind: 'elite', eliteId: 'oldMossback' });
    const body = { x: def.pos.x + 3, y: 61, z: def.pos.z - 2 };
    const h = setup({ bodies: { e1: body } });
    expect(h.chests.isPresent(def.id)).toBe(false);
    h.open(def.id);
    expect(h.state.world.chests).toEqual([]);
    h.bus.emit('enemy:defeated', { entityId: 'e1', kind: 'oldMossback', campId: null });
    h.bus.dispatch();
    h.state.world.elites.push('oldMossback'); // the Enemy system records the defeat
    h.chests.tick(1 / 60);
    const view = h.chests.views().find((v) => v.def.id === def.id);
    expect(view).toMatchObject({ present: true, pos: body, appearedAgo: 0 });
    expect(h.dynamics).toHaveLength(1);
    h.open(def.id);
    expect(h.of('chest:opened')).toEqual([{ chestId: def.id, tier: 'glowing' }]);
  });

  it('puzzle and Sky Ring Trial Chests appear when their reward opens', () => {
    const pz = chest('chest_pz_verdant_1');
    const trial = chest('chest_azure_6');
    const h = setup();
    expect(h.chests.isPresent(pz.id)).toBe(false);
    expect(h.chests.isPresent(trial.id)).toBe(false);
    h.puzzles.add(pz.source.kind === 'puzzle' ? pz.source.opens : '');
    h.trials.add(trial.source.kind === 'trial' ? trial.source.trialId : '');
    h.chests.tick(1 / 60);
    expect(h.chests.isPresent(pz.id)).toBe(true);
    expect(h.chests.isPresent(trial.id)).toBe(true);
    h.open(trial.id);
    h.bus.dispatch();
    expect(h.of('item:granted')).toEqual([{ itemId: 'chm_starlit_eye', count: 1, source: CHEST_SOURCE }]);
  });

  it('an opened reward Chest is back (open) after a load, and 방랑자의 나침반 lists only unopened present Chests', () => {
    const state = createNewGameState(SEED);
    state.world.chests.push('chest_verdant_5');
    const h = setup({ state });
    expect(h.chests.isPresent('chest_verdant_5')).toBe(true);
    const near = h.chests.unopenedNear({ x: -426, y: 60, z: 124 }, 80).map((c) => c.id);
    expect(near).not.toContain('chest_verdant_5');
    expect(near).toContain('chest_verdant_3');
  });
});
