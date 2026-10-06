import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../../src/core/gameEvents';
import { createRng, createRngStreams } from '../../../src/core/rng';
import type { Vec3 } from '../../../src/core/types';
import { BRAMBLEKIN, getEnemyDef } from '../../../src/data/enemies';
import type { EliteId, EnemyId } from '../../../src/data/ids';
import { InventorySystem } from '../../../src/inventory/inventorySystem';
import { rollEnemyDrop } from '../../../src/logic/loot';
import { addXp, MAX_XP } from '../../../src/logic/progression';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { LootSystem, PICKUP_ATTRACT_RADIUS } from '../../../src/loot/lootSystem';
import { ProgressionSystem } from '../../../src/progression/progressionSystem';
import type { PickupRuntime } from '../../../src/save/runtimeState';

// Loot_System on 'enemy:defeated' (task 7.7; design "적 드롭"; Req 28.13): XP, Glim, seeded chance drops and the
// 3 m pull-in auto pickup.
const DT = 1 / 60;
const SEED = 20240601;

function setup(bodies: Record<string, Vec3> = {}) {
  const bus = createGameEventBus();
  const gameState = createNewGameState(SEED);
  const pickups: PickupRuntime[] = [];
  const progression = new ProgressionSystem({ state: gameState, bus });
  const inventory = new InventorySystem({ state: gameState, bus });
  const loot = new LootSystem({
    bus, rng: createRngStreams(SEED).loot, progression, inventory, pickups, bodyAt: (id) => bodies[id] ?? null,
  });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const of = <K extends GameEventName>(type: K): GameEvents[K][] =>
    events.filter((e) => e.type === type).map((e) => e.payload as GameEvents[K]);
  const defeat = (entityId: string, kind: EnemyId | EliteId) => {
    bus.emit('enemy:defeated', { entityId, kind, campId: null });
    bus.dispatch();
  };
  return { bus, gameState, pickups, loot, of, defeat };
}

describe('rollEnemyDrop', () => {
  it('rolls each drop-table line with one loot-stream draw: regular enemies ~10% Starmote ×1, Elites Starmote ×3 for sure', () => {
    const rng = createRng(7);
    let hits = 0;
    for (let i = 0; i < 2000; i++) {
      const before = createRng(rng.state());
      const drops = rollEnemyDrop('bramblekin', rng);
      before.next();
      expect(rng.state()).toBe(before.state()); // exactly one draw per line
      if (drops.length > 0) {
        expect(drops).toEqual([{ kind: 'item', id: 'mat_starmote', count: 1 }]);
        hits += 1;
      }
    }
    expect(hits).toBeGreaterThan(140);
    expect(hits).toBeLessThan(260);
    expect(rollEnemyDrop('oldMossback', createRng(1))).toEqual([{ kind: 'item', id: 'mat_starmote', count: 3 }]);
  });

  it('is deterministic for the same seed', () => {
    const roll = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 50 }, () => rollEnemyDrop('thornspitter', rng).length);
    };
    expect(roll(99)).toEqual(roll(99));
  });
});

describe('ProgressionSystem', () => {
  it('adds XP up to 3,000, raises the level from the total and emits levelUp once with the final level', () => {
    expect([addXp(2990, 50), addXp(100, -5), addXp(100, Number.NaN), MAX_XP]).toEqual([3000, 100, 100, 3000]);
    const bus = createGameEventBus();
    const gameState = createNewGameState(1);
    const levels: number[] = [];
    bus.on('levelUp', (p) => levels.push(p.level));
    const progression = new ProgressionSystem({ state: gameState, bus });
    progression.grantXp(100);
    progression.grantXp(450); // 550: past levels 2, 3 and 4 at once
    bus.dispatch();
    expect([gameState.party.xp, gameState.party.level, levels]).toEqual([550, 4, [4]]);
  });
});

describe('LootSystem', () => {
  it('grants the kind’s XP and Glim at once and lays the seeded drops where the body fell', () => {
    const bodies: Record<string, Vec3> = {};
    const kills = Array.from({ length: 30 }, (_, i) => `bramblekin_${i + 1}`);
    kills.forEach((id, i) => (bodies[id] = { x: i * 10, y: 2, z: 0 }));
    const { gameState, pickups, of, defeat } = setup(bodies);
    for (const id of kills) defeat(id, 'bramblekin');

    expect(gameState.party.xp).toBe(BRAMBLEKIN.xp * kills.length);
    expect(gameState.inventory.glim).toBe(BRAMBLEKIN.glim * kills.length);
    expect(of('levelUp').map((p) => p.level)).toEqual([2, 3]); // 120 and 300 crossed on separate kills
    // The same loot stream seed rolls the same drops, one per 'enemy:defeated' in order.
    const replay = createRngStreams(SEED).loot;
    const expected = kills.filter(() => rollEnemyDrop('bramblekin', replay).length > 0);
    expect(expected.length).toBeGreaterThan(0);
    expect(pickups.map((p) => p.pos)).toEqual(expected.map((id) => bodies[id]));
    expect(pickups.every((p) => p.itemId === 'mat_starmote' && p.count === 1 && !p.pulled)).toBe(true);
    expect(gameState.inventory.items.mat_starmote ?? 0).toBe(0); // not picked up yet
  });

  it('pulls a drop in once the character is within 3 m and grants it; farther drops stay put', () => {
    const { gameState, pickups, loot, of, defeat } = setup({ elite: { x: 0, y: 0, z: 0 } });
    defeat('elite', 'oldMossback'); // Elites always drop Starmote ×3
    expect(gameState.party.xp).toBe(getEnemyDef('oldMossback').xp);
    expect(pickups).toHaveLength(1);

    const far = { x: PICKUP_ATTRACT_RADIUS + 0.2, y: 0, z: 0 };
    for (let i = 0; i < 120; i++) loot.tick(DT, far);
    expect(pickups).toHaveLength(1);
    expect(pickups[0]).toMatchObject({ pulled: false, pos: { x: 0, y: 0, z: 0 } });
    loot.tick(DT, null); // held (fade / cinematic): nothing moves
    expect(pickups[0]?.pulled).toBe(false);

    const near = { x: PICKUP_ATTRACT_RADIUS - 0.1, y: 0, z: 0 };
    loot.tick(DT, near);
    expect(pickups[0]?.pulled).toBe(true);
    for (let i = 0; i < 30 && pickups.length > 0; i++) loot.tick(DT, near);
    expect(pickups).toHaveLength(0);
    expect(gameState.inventory.items.mat_starmote).toBe(3);
    expect(of('item:granted')).toEqual([]); // emitted during the tick: delivered by the next EventDispatch
  });

  it('unlocks an Enemy_Camp’s Chest on its camp:cleared with a "캠프 소탕" notice, and from GameState after a load (Req 10.7)', () => {
    const camps = [
      { id: 'camp_verdant_1', region: 'verdant', chestId: 'chest_verdant_1' },
      { id: 'camp_verdant_2', region: 'verdant', chestId: 'chest_verdant_2' },
    ] as const;
    const bus = createGameEventBus();
    const gameState = createNewGameState(SEED);
    gameState.world.camps.push('camp_verdant_2'); // cleared before the save
    const notices: unknown[] = [];
    const loot = new LootSystem({
      bus, rng: createRngStreams(SEED).loot, progression: new ProgressionSystem({ state: gameState, bus }),
      inventory: new InventorySystem({ state: gameState, bus }), pickups: [], bodyAt: () => null,
      camps, world: gameState.world, campCleared: (n) => notices.push(n),
    });
    expect(['chest_verdant_1', 'chest_verdant_2', 'chest_ember_1'].map((c) => loot.chestLocked(c))).toEqual([true, false, false]);
    bus.emit('camp:cleared', { campId: 'village_raid', regionId: 'verdant' }); // an encounter group, not a camp
    bus.dispatch();
    expect([loot.chestLocked('chest_verdant_1'), notices]).toEqual([true, []]);
    bus.emit('camp:cleared', { campId: 'camp_verdant_1', regionId: 'verdant' });
    bus.dispatch();
    expect(loot.chestLocked('chest_verdant_1')).toBe(false);
    expect(notices).toEqual([{ campId: 'camp_verdant_1', regionId: 'verdant', chestId: 'chest_verdant_1' }]);
  });

  it('announces a collected drop with item:granted (source enemy) at the next dispatch', () => {
    const { bus, pickups, loot, of, defeat } = setup({ e: { x: 0, y: 0, z: 0 } });
    defeat('e', 'galeclaw');
    for (let i = 0; i < 30 && pickups.length > 0; i++) loot.tick(DT, { x: 1, y: 0, z: 0 });
    bus.dispatch();
    expect(of('item:granted')).toEqual([{ itemId: 'mat_starmote', count: 3, source: 'enemy' }]);
  });
});
