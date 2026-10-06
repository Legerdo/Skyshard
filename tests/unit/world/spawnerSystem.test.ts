import { describe, expect, it } from 'vitest';
import { createPlayerReceiver } from '../../../src/combat/playerReceiver';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../../src/core/gameEvents';
import { createRngStreams } from '../../../src/core/rng';
import { MAIN_QUEST } from '../../../src/data/quests';
import { CAMPS, SPAWNERS as WORLD_SPAWNERS, spawnDataErrors, type CampDef, type EncounterGroupDef, type SpawnerDef, type SpawnPoint } from '../../../src/data/spawns';
import { EnemySystem } from '../../../src/enemies/enemySystem';
import { InventorySystem } from '../../../src/inventory/inventorySystem';
import { canonicalizeGameState, createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { LootSystem, type CampClearedNotice } from '../../../src/loot/lootSystem';
import { createControllerState } from '../../../src/player/core/types';
import { ProgressionSystem } from '../../../src/progression/progressionSystem';
import type { ObjectiveView } from '../../../src/quest/questSystem';
import type { EnemyRuntime } from '../../../src/save/runtimeState';
import { SpawnerSystem } from '../../../src/world/spawnerSystem';

// Spawners, Enemy_Camps and encounter groups (task 7.8; design "스폰·캠프·재배치"; Req 10.7, 11.6, 27.4).
const DT = 1 / 60;
const GROUND_Y = 5;
const at = (x: number, z: number): SpawnPoint => ({ x, z, y: 'ground' });

/** A camp of three with a locked Chest, a lone roaming Bramblekin, a lone Elite and a two-member encounter group. */
const CAMP: CampDef = { id: 'camp_verdant_1', region: 'verdant', chestId: 'chest_verdant_1' };
const GROUP: EncounterGroupDef = { id: 'test_pack', region: 'verdant' };
const campMember = (n: number, x: number): SpawnerDef => ({
  id: `sp_camp_verdant_1_${n}`, region: 'verdant', kind: 'bramblekin', pos: at(x, 0), yaw: 0, level: 2, campId: CAMP.id, respawn: 'roaming',
});
const ROAMING: SpawnerDef = { id: 'sp_verdant_1', region: 'verdant', kind: 'bramblekin', pos: at(-20, 0), yaw: 0, level: 1, campId: null, respawn: 'roaming' };
const ELITE: SpawnerDef = { id: 'sp_oldMossback', region: 'verdant', kind: 'oldMossback', pos: at(0, -30), yaw: 0, level: 3, campId: null, respawn: 'never' };
const packMember = (n: number, x: number): SpawnerDef => ({
  id: `sp_test_pack_${n}`, region: 'verdant', kind: 'bramblekin', pos: at(x, 40), yaw: 0, level: 1, campId: GROUP.id, respawn: 'roaming',
});
const SPAWNERS: SpawnerDef[] = [campMember(1, 10), campMember(2, 12), campMember(3, 14), ROAMING, ELITE, packMember(1, 0), packMember(2, 2)];
const CAMP_IDS = ['sp_camp_verdant_1_1', 'sp_camp_verdant_1_2', 'sp_camp_verdant_1_3'];

/** An EnemySystem on flat ground at y 5, a SpawnerSystem and a LootSystem on one bus, over `gameState`. */
function setup(gameState: GameState = createNewGameState(1), fixture = true) {
  const bus = createGameEventBus();
  const map = new Map<string, EnemyRuntime>();
  const enemies = new EnemySystem({ enemies: map, terrain: { heightAt: () => GROUND_Y }, bus });
  const logs: string[] = [];
  const data = fixture ? { spawners: SPAWNERS, camps: [CAMP], groups: [GROUP] } : {};
  const spawners = new SpawnerSystem({ bus, enemies, world: gameState.world, heightAt: () => GROUND_Y, log: (m) => logs.push(m), ...data });
  const notices: CampClearedNotice[] = [];
  const loot = new LootSystem({
    bus, rng: createRngStreams(1).loot, progression: new ProgressionSystem({ state: gameState, bus }),
    inventory: new InventorySystem({ state: gameState, bus }), pickups: [], bodyAt: () => null,
    camps: fixture ? [CAMP] : [], world: gameState.world, campCleared: (n) => notices.push(n),
  });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const of = <K extends GameEventName>(type: K): GameEvents[K][] =>
    events.filter((e) => e.type === type).map((e) => e.payload as GameEvents[K]);
  const hit = (id: string, amount: number): void => {
    for (const r of enemies.receivers()) {
      if (r.id !== id) continue;
      r.receive({
        attackerId: 'player', attackId: 'atk_kairen_n1', hitIndex: 0, kind: 'normal', amount, crit: false,
        element: null, stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
      });
    }
  };
  /** Defeats the living enemies of `spawnerIds` through lethal hits, then delivers the events. */
  const kill = (...spawnerIds: string[]): void => {
    for (const s of spawnerIds) {
      const id = spawners.entityOf(s);
      if (id === null) throw new Error(`${s} has no living enemy`);
      hit(id, 1e6);
    }
    bus.dispatch();
  };
  const living = (): EnemyRuntime[] => [...map.values()].filter((e) => e.state !== 'dead');
  const view = (objectiveId: string): ObjectiveView => {
    for (const stage of MAIN_QUEST.stages) {
      const objective = stage.objectives.find((o) => o.id === objectiveId);
      if (objective !== undefined) return { questId: 'main', stageId: stage.id, stageName: stage.name, objective };
    }
    throw new Error(objectiveId);
  };
  return { bus, map, enemies, spawners, loot, notices, gameState, logs, of, hit, kill, living, view };
}

/** Whether entity `e` stands idle at spawner `def`'s point with full HP. */
const atSpawn = (e: EnemyRuntime | undefined, def: SpawnerDef): boolean =>
  e !== undefined && e.state === 'idle' && e.hp === e.maxHp && e.pos.x === def.pos.x && e.pos.z === def.pos.z && e.pos.y === GROUND_Y;

describe('SpawnerSystem', () => {
  it('rebuild places lone spawners and uncleared camps idle at their spawn at full HP; encounter groups wait for activation', () => {
    expect(spawnDataErrors(SPAWNERS, [CAMP], [GROUP])).toEqual([]);
    const { spawners, map } = setup();
    spawners.rebuild();
    expect(map.size).toBe(5);
    for (const def of [...SPAWNERS.slice(0, 5)]) {
      const e = map.get(spawners.entityOf(def.id) ?? '');
      expect(atSpawn(e, def), def.id).toBe(true);
      expect([e?.def, e?.level, e?.campId, e?.spawner]).toEqual([def.kind, def.level, def.campId, def.id]);
    }
    expect([spawners.aliveCount(CAMP.id), spawners.entityOf('sp_test_pack_1')]).toEqual([3, null]);
  });

  it('the camp’s last defeat emits one camp:cleared: its clear is recorded, its locked Chest opens and "캠프 소탕" is raised', () => {
    const { spawners, loot, notices, gameState, of, kill, bus } = setup();
    spawners.rebuild();
    expect(loot.chestLocked('chest_verdant_1')).toBe(true);
    const last = spawners.entityOf(CAMP_IDS[2] ?? '');
    kill(CAMP_IDS[0] ?? '');
    kill(CAMP_IDS[1] ?? '');
    expect([of('camp:cleared'), spawners.aliveCount(CAMP.id), gameState.world.camps, notices]).toEqual([[], 1, [], []]);
    expect(loot.chestLocked('chest_verdant_1')).toBe(true);
    kill(CAMP_IDS[2] ?? '');
    bus.emit('enemy:defeated', { entityId: last ?? '', kind: 'bramblekin', campId: CAMP.id }); // a repeat is ignored
    bus.dispatch();
    expect(of('camp:cleared')).toEqual([{ campId: CAMP.id, regionId: 'verdant' }]);
    expect(of('enemy:defeated').filter((p) => p.campId === CAMP.id)).toHaveLength(4);
    expect(gameState.world.camps).toEqual([CAMP.id]);
    expect(loot.chestLocked('chest_verdant_1')).toBe(false);
    expect(loot.chestLocked('chest_verdant_9')).toBe(false); // not a camp Chest
    expect(notices).toEqual([{ campId: CAMP.id, regionId: 'verdant', chestId: 'chest_verdant_1' }]);
  });

  it('keeps cleared camps and a defeated Elite gone after rebuild and after a save round trip and load', () => {
    const first = setup();
    first.spawners.rebuild();
    first.kill(ELITE.id);
    expect(first.gameState.world.elites).toEqual(['oldMossback']);
    first.kill(...CAMP_IDS);
    first.kill(ROAMING.id);
    first.spawners.rebuild(); // fast travel
    expect(first.living().map((e) => e.spawner)).toEqual([ROAMING.id]);
    expect([first.spawners.entityOf(ELITE.id), first.spawners.aliveCount(CAMP.id)]).toEqual([null, 0]);

    // Save and load: the records survive the canonical JSON round trip, and the new session skips them.
    const saved = canonicalizeGameState(first.gameState);
    const loaded = JSON.parse(JSON.stringify(saved)) as GameState;
    expect(loaded).toEqual(saved);
    expect([loaded.world.camps, loaded.world.elites]).toEqual([[CAMP.id], ['oldMossback']]);
    const second = setup(loaded);
    second.spawners.rebuild();
    expect(second.living().map((e) => e.spawner)).toEqual([ROAMING.id]);
    expect(atSpawn(second.living()[0], ROAMING)).toBe(true);
    expect(second.loot.chestLocked('chest_verdant_1')).toBe(false);
    expect(second.of('camp:cleared')).toEqual([]);
  });

  it('after fast travel or a load, a defeated roaming enemy is back at its spawn at full HP and a partly beaten camp comes back whole', () => {
    const { spawners, map, hit, kill, of, living, bus } = setup();
    spawners.rebuild();
    const survivor = spawners.entityOf(CAMP_IDS[2] ?? '') ?? '';
    kill(ROAMING.id, CAMP_IDS[0] ?? '', CAMP_IDS[1] ?? '');
    hit(survivor, 60); // wounded and alerted
    expect(map.get(survivor)).toMatchObject({ state: 'alert', hp: (map.get(survivor)?.maxHp ?? 0) - 60 });
    spawners.rebuild();
    expect(map.size).toBe(5); // the dead bodies went with the rebuild
    for (const def of SPAWNERS.slice(0, 5)) expect(atSpawn(map.get(spawners.entityOf(def.id) ?? ''), def), def.id).toBe(true);
    expect(spawners.entityOf(CAMP_IDS[2] ?? '')).toBe(survivor); // the living one is put back, the others replaced
    expect(spawners.aliveCount(CAMP.id)).toBe(3);
    expect(living()).toHaveLength(5);
    // The tally started over with the new members: the camp clears once all three are down again.
    kill(...CAMP_IDS.slice(0, 2));
    expect(of('camp:cleared')).toEqual([]);
    kill(CAMP_IDS[2] ?? '');
    bus.dispatch();
    expect(of('camp:cleared')).toHaveLength(1);
  });

  it('Party_Wipe restart: engaged enemies back at spawn, idle at full HP, and an active group partly beaten is restored', () => {
    const { spawners, enemies, map, kill, bus, gameState } = setup();
    spawners.rebuild();
    const chaser = spawners.entityOf(ROAMING.id) ?? '';
    const pack = spawners.activate(GROUP.id);
    expect(pack).toHaveLength(2);
    // Kairen stands 5 m in front of the roaming Bramblekin (its facing +Z): it alerts, chases and attacks.
    const body = createControllerState({ x: -20, y: GROUND_Y, z: 5 }, Math.PI);
    const player = createPlayerReceiver({ gameState, bus, body: () => body });
    for (let i = 0; i < 90; i++) enemies.tick({ dt: DT, player });
    bus.dispatch();
    expect(['chase', 'attack', 'recovery']).toContain(map.get(chaser)?.state);
    expect(map.get(chaser)?.pos.z).toBeGreaterThan(1);
    kill('sp_test_pack_1');
    expect(spawners.aliveCount(GROUP.id)).toBe(1);

    spawners.rebuild(); // the Defeat Screen's restart
    expect(atSpawn(map.get(chaser), ROAMING)).toBe(true);
    expect(map.get(chaser)?.attack).toBeNull();
    expect(enemies.tokens.holders.size).toBe(0);
    expect(enemies.engaged).toBe(false);
    expect(spawners.aliveCount(GROUP.id)).toBe(2);
    expect(atSpawn(map.get(spawners.entityOf('sp_test_pack_1') ?? ''), packMember(1, 0))).toBe(true);
  });

  it('a cleared encounter group is not recorded, stays out of rebuilds and comes back only when activated again', () => {
    const { spawners, gameState, kill, of, notices } = setup();
    spawners.activate(GROUP.id);
    kill('sp_test_pack_1', 'sp_test_pack_2');
    expect(of('camp:cleared')).toEqual([{ campId: GROUP.id, regionId: 'verdant' }]);
    expect([gameState.world.camps, notices]).toEqual([[], []]); // not an Enemy_Camp: no record, no banner
    spawners.rebuild();
    expect(spawners.aliveCount(GROUP.id)).toBe(0);
    expect(spawners.activate(GROUP.id)).toHaveLength(2);
    expect(spawners.activate(GROUP.id)).toEqual([]); // members alive: not placed twice
  });
});

// The minimal route's encounter groups (task 4.9), moved from the EncounterDirector to the spawner data.
describe('SpawnerSystem route encounter groups', () => {
  it('activates a group for every Main_Quest defeat trigger except the boss, members under the trigger id', () => {
    const groups = MAIN_QUEST.stages.flatMap((s) => s.objectives).flatMap((o) => (o.trigger.kind === 'defeat' ? [o.trigger.groupId] : []));
    const { spawners, living } = setup(undefined, false);
    for (const g of groups.filter((id) => id !== 'caelith')) expect(spawners.has(g), g).toBe(true);
    expect(spawners.activate('village_raid')).toHaveLength(4);
    expect(living().every((e) => e.campId === 'village_raid' && e.def === 'bramblekin' && e.pos.y === GROUND_Y)).toBe(true);
    expect(spawners.activate('village_raid')).toEqual([]);
  });

  it('brings a group back when its Objective becomes current after an early clear', () => {
    const { spawners, living, view, bus, gameState, hit } = setup(undefined, false);
    spawners.activate('village_raid');
    spawners.objectiveChanged(view('ms1_raid'));
    expect(spawners.aliveCount('village_raid')).toBe(4);
    for (const e of living()) hit(e.id, 1e6);
    bus.dispatch(); // beaten before its Objective: that 'camp:cleared' is ignored by the quest
    expect([spawners.aliveCount('village_raid'), gameState.world.camps]).toEqual([0, []]);
    spawners.objectiveChanged(view('ms1_raid'));
    expect(spawners.aliveCount('village_raid')).toBe(4);
    expect(living()).toHaveLength(4);
  });

  it('activates a Challenge_Area group when its defeat Objective becomes current, at its level', () => {
    const { spawners, map, view } = setup(undefined, false);
    spawners.rebuild(); // the world's Enemy_Camps and lone hidden Elites (task 20.1), never an encounter group
    const world = map.size;
    const campIds = new Set(CAMPS.map((c) => c.id));
    expect(world).toBe(WORLD_SPAWNERS.filter((s) => s.campId === null || campIds.has(s.campId)).length);
    spawners.objectiveChanged(view('ms3_bramble'));
    expect(map.size).toBe(world);
    spawners.objectiveChanged(view('ms3_warden'));
    expect(spawners.aliveCount('rootboundWarden')).toBe(1);
    expect([...map.values()].filter((e) => e.campId === 'rootboundWarden').map((e) => [e.def, e.level])).toEqual([['rootboundWarden', 3]]);
    expect(map.size).toBe(world + 1);
  });

  it('records a guardian Elite of an encounter group as defeated and never places it again', () => {
    const { spawners, map, view, bus, gameState, hit, living } = setup(undefined, false);
    spawners.objectiveChanged(view('ms3_warden'));
    const [warden] = living();
    hit(warden.id, 1e6);
    bus.dispatch();
    expect(gameState.world.elites).toEqual(['rootboundWarden']);
    spawners.rebuild();
    expect(spawners.activate('rootboundWarden')).toEqual([]);
    expect([...map.values()].filter((e) => e.state !== 'dead' && e.def === 'rootboundWarden')).toEqual([]);
  });

  it('logs and ignores unknown groups', () => {
    const { spawners, logs, view } = setup(undefined, false);
    expect(spawners.activate('nobody')).toEqual([]);
    expect(logs).toHaveLength(1);
    spawners.objectiveChanged(view('ms9_caelith')); // the boss is not an encounter group
    expect(logs).toHaveLength(1);
  });
});
