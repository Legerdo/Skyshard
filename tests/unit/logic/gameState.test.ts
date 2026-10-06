import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { CHARACTERS } from '../../../src/data/characters';
import { MAIN_STAGE_IDS, type CharacterId, type NpcId } from '../../../src/data/ids';
import { STARTING_ITEMS } from '../../../src/data/items';
import { QUESTS } from '../../../src/data/quests';
import { LOCATIONS, NEW_GAME_START, THISTLEWICK_HEARTH } from '../../../src/data/worldLayout';
import { FogOfWar } from '../../../src/logic/fogOfWar';
import { currentObjective, initialQuestState } from '../../../src/logic/quest/questReducer';
import type { ObjectiveDef, QuestDef } from '../../../src/logic/quest/types';
import {
  SAVE_VERSION, UNDATED_CREATED_AT, canonicalizeGameState, cloneGameState, createNewGameState, type DeepReadonly, type GameState,
} from '../../../src/logic/save/gameState';
import { LOCATION_TERRAIN_ROLES } from '../../../src/world/terrain/features';

const talk = (id: string, npc: NpcId): ObjectiveDef => ({ id, text: id, trigger: { kind: 'talk', npc }, category: 'interact', marker: { kind: 'none' } });
const objectives = [talk('ms1_0', 'maren'), talk('ms1_1', 'pip')];
const DEFS: QuestDef[] = [
  { id: 'main', kind: 'main', stages: [{ id: 'ms1', name: 'Arrival', objectives, onStart: [], onComplete: [] }] },
  { id: 'sq_hobb', kind: 'side', stages: [{ id: 'hobb_1', name: 'Thorns', objectives: [talk('hobb_0', 'hobb')], onStart: [], onComplete: [] }] },
];
const CREATED = '2025-01-01T00:00:00.000Z';
const newGame = (): GameState => createNewGameState(42, { createdAt: CREATED, quests: DEFS });
const each = <V>(v: V): Record<CharacterId, V> => ({ kairen: v, isla: v, wren: v, talus: v });

/** A played state with unsorted sets and keys; `reverse` builds every set, record and the top level in the opposite order. */
function played(reverse: boolean): GameState {
  const o = <T extends string>(xs: T[]): T[] => (reverse ? [...xs].reverse() : xs);
  const gs = newGame();
  const out: GameState = {
    ...gs,
    party: { ...gs.party, joined: o(['wren', 'kairen', 'isla', 'wren']), downed: o(['talus', 'isla', 'isla']) },
    inventory: { glim: 5, items: reverse ? { con_a: 1, con_b: 2 } : { con_b: 2, con_a: 1 }, ownedEquipment: o(['wpn_b', 'wpn_b', 'chm_a']) },
    discovery: { ...gs.discovery, regions: o(['verdant', 'verdant', 'ember']), landmarks: o(['lm_waterfall', 'lm_elderbough']),
      pois: o(['p2', 'p1']), hiddenPlaces: o(['h2', 'h2', 'h1']) },
    world: { waystones: o(['ws_thistlewick', 'ws_ember']), chests: o(['c2', 'c1']), puzzles: o(['z2', 'z1']), camps: o(['k2', 'k1']),
      elites: o(['oldMossback', 'emberjaw']), echoTablets: o(['t2', 't1']), flags: reverse ? { a: false, b: true } : { b: true, a: false } },
    codex: o(['steamBurst', 'steamBurst', 'lavaRift']), tutorials: o(['tut_move', 'tut_glide']), cinematicsSeen: o(['cin_b', 'cin_a']),
    lastSafe: { pos: [12, -4, 7], yaw: 1.5 },
  };
  return reverse ? (Object.fromEntries(Object.entries(out).reverse()) as GameState) : out;
}

/** Every set-like array (fog and flags are not arrays and drop out). */
const setsOf = (g: GameState): string[][] => [g.party.joined, g.party.downed, g.inventory.ownedEquipment, g.codex, g.tutorials,
  g.cinematicsSeen, ...Object.values(g.discovery), ...Object.values(g.world)].filter((v): v is string[] => Array.isArray(v));

describe('createNewGameState', () => {
  it('gives deep-equal, independent states for the same seed', () => {
    for (const seed of [0, 1, 42, 20240601, 0xffffffff]) {
      const [a, b] = [createNewGameState(seed), createNewGameState(seed)];
      expect([a, JSON.stringify(a)]).toStrictEqual([b, JSON.stringify(b)]);
      expect(a).not.toBe(b);
    }
    const [a, b] = [newGame(), newGame()];
    expect([a, JSON.stringify(a)]).toStrictEqual([b, JSON.stringify(b)]);
    a.party.joined.push('isla');
    a.inventory.items.con_herbDumpling = 0;
    a.lastSafe?.pos.fill(0);
    a.quests.main.objective = 1;
    expect(b).toStrictEqual(newGame());
    expect([STARTING_ITEMS.con_herbDumpling, NEW_GAME_START.groundY, SAVE_VERSION]).toEqual([3, 18, 1]);
  });

  it('differs between seeds only in the seed, stored as the uint32 the RNG uses', () => {
    const { seed: _a, ...restA } = createNewGameState(7);
    const { seed: _b, ...restB } = createNewGameState(8);
    expect(restA).toStrictEqual(restB);
    for (const seed of [-1, 2 ** 32 + 5, 3.9, Number.NaN]) expect(createNewGameState(seed).seed).toBe(createRng(seed).seed);
  });

  it('starts at the first ms1 objective with Kairen alone at level 1, Skyshard 0 and herb dumplings ×3', () => {
    const gs = newGame();
    const level1Hp = { kairen: 0, isla: 0, wren: 0, talus: 0 };
    for (const id of Object.keys(level1Hp) as CharacterId[]) level1Hp[id] = CHARACTERS[id].baseStats.hp;
    expect(gs).toStrictEqual({
      seed: 42, createdAt: CREATED, quests: initialQuestState(DEFS),
      skyshards: 0, altarActivated: false, bossDefeated: false, gameCompleted: false,
      party: { joined: ['kairen'], active: 'kairen', level: 1, xp: 0, hp: level1Hp, downed: [], relic: null,
        upgrades: each({ skill: 0, burst: 0 }), equipment: each({ weapon: null, charm: null }) },
      inventory: { glim: 0, items: { con_herbDumpling: 3 }, ownedEquipment: [] },
      discovery: { regions: [], landmarks: [], pois: [], hiddenPlaces: [], fog: new FogOfWar().encode() },
      world: { waystones: [], chests: [], puzzles: [], camps: [], elites: [], echoTablets: [], flags: {} },
      codex: [], tutorials: [], cinematicsSeen: [], respawn: { kind: 'hearth', id: 'hearth_thistlewick' },
      lastSafe: { pos: [NEW_GAME_START.x, 18, NEW_GAME_START.z], yaw: NEW_GAME_START.yaw },
      checkpoint: null, boss: null, victory: null, debugUsed: false,
      stats: { playTimeSec: 0, enemiesDefeated: 0, reactions: 0, chestsOpened: 0, placesDiscovered: 0, questsCompleted: 0, partyWipes: 0 },
    });
    expect(MAIN_STAGE_IDS[gs.quests.main.stage]).toBe('ms1');
    expect([gs.quests.main, gs.quests.tracked]).toEqual([{ stage: 0, objective: 0, done: false }, 'main']);
    expect([currentObjective(gs.quests, DEFS, 'main')?.id, FogOfWar.decode(gs.discovery.fog).revealedCount()]).toEqual(['ms1_0', 0]);
    // Defined side quests are open, the rest locked. The default content (QUESTS) defines all three (task 13.3).
    expect([gs.quests.side.sq_hobb.status, gs.quests.side.sq_tamsin.status]).toEqual(['available', 'locked']);
    const standard = createNewGameState(42);
    expect(Object.values(standard.quests.side).map((s) => s.status)).toEqual(['available', 'available', 'available']);
    expect([standard.quests, currentObjective(standard.quests, QUESTS, 'main')?.id]).toEqual([initialQuestState(QUESTS), 'ms1_maren']);
    expect([createNewGameState(42).createdAt, UNDATED_CREATED_AT]).toEqual(['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z']);
  });

  it('stands at the Thistlewick village entrance facing the centre, with the Hearth as respawn point', () => {
    const village = LOCATIONS.thistlewick;
    const road = LOCATIONS.breezewatch;
    const { lastSafe, respawn } = createNewGameState(1);
    expect(lastSafe).not.toBeNull();
    const { pos: [x, y, z], yaw } = lastSafe!;
    const dist = Math.hypot(x - village.x, z - village.z);
    const pad = LOCATION_TERRAIN_ROLES.thistlewick;
    // Outside the 12 m plaza, on the flat village pad (so the ground is exactly y 18), toward Breezewatch.
    expect([village.x, village.z, village.groundY, y]).toEqual([-250, 300, 18, 18]);
    expect(dist).toBeCloseTo(18, 9);
    expect(pad.kind === 'pad' && dist > 12 && dist < pad.radius).toBe(true);
    const toRoad = Math.atan2(road.x - village.x, road.z - village.z);
    expect(Math.atan2(x - village.x, z - village.z)).toBeCloseTo(toRoad, 9);
    // yaw 0 faces +z, positive turns toward +x: facing the village centre from the entrance.
    expect(Math.sin(yaw)).toBeCloseTo((village.x - x) / dist, 9);
    expect(Math.cos(yaw)).toBeCloseTo((village.z - z) / dist, 9);
    expect(respawn).toEqual({ kind: 'hearth', id: THISTLEWICK_HEARTH.id });
    expect([THISTLEWICK_HEARTH.x, THISTLEWICK_HEARTH.z, THISTLEWICK_HEARTH.groundY]).toEqual([-246, 296, 18]);
  });

  it('only hands out read-only views through DeepReadonly', () => {
    const view: DeepReadonly<GameState> = newGame();
    const write = (): void => {
      // @ts-expect-error DeepReadonly forbids writes to nested fields
      view.party.level = 2;
      // @ts-expect-error DeepReadonly makes arrays readonly
      view.party.joined.push('isla');
      // @ts-expect-error DeepReadonly makes tuples readonly
      if (view.lastSafe) view.lastSafe.pos[0] = 0;
    };
    expect(typeof write).toBe('function');
    expect(canonicalizeGameState(view)).toStrictEqual(newGame());
  });
});

describe('canonicalizeGameState', () => {
  it('sorts and de-duplicates every set, keeps tuples, sorts keys and leaves the input alone', () => {
    const a = played(false);
    const c = canonicalizeGameState(a);
    expect(setsOf(c)).toHaveLength(16);
    for (const s of setsOf(c)) expect(s).toEqual([...new Set(s)].sort());
    expect([c.party.joined, c.party.downed, c.inventory.ownedEquipment, c.world.chests, c.lastSafe?.pos]).toEqual([
      ['isla', 'kairen', 'wren'], ['isla', 'talus'], ['chm_a', 'wpn_b'], ['c1', 'c2'], [12, -4, 7]]);
    expect([Object.keys(c), Object.keys(c.world.flags), Object.keys(c.inventory.items)]).toEqual([
      Object.keys(c).sort(), ['a', 'b'], ['con_a', 'con_b']]);
    expect(a.party.joined).toEqual(['wren', 'kairen', 'isla', 'wren']);
  });

  it('is idempotent and gives identical JSON for states built in different orders', () => {
    const [a, b] = [played(false), played(true)];
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    const c = canonicalizeGameState(a);
    expect(JSON.stringify(canonicalizeGameState(b))).toBe(JSON.stringify(c));
    expect([canonicalizeGameState(c), JSON.stringify(canonicalizeGameState(c))]).toStrictEqual([c, JSON.stringify(c)]);
    expect(canonicalizeGameState(newGame())).toStrictEqual(newGame());
  });
});

describe('cloneGameState', () => {
  it('returns an independent deep copy in the same order', () => {
    const a = played(false);
    const c = cloneGameState(a);
    expect([c, JSON.stringify(c)]).toStrictEqual([a, JSON.stringify(a)]);
    c.party.joined.push('talus');
    c.world.flags.extra = true;
    c.quests.main.stage = 3;
    c.lastSafe?.pos.fill(0);
    expect(a).toStrictEqual(played(false));
  });
});
