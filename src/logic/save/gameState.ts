/*
 * Save schema v1 (design.md "GameState (저장 스키마 v1)", Req 36.1, 36.2, 36.9): the persistent
 * progress stored as `SaveEnvelope.state`, the New Game factory and the canonical form written to
 * disk. Runtime-only values (Energy, cooldowns, Stamina, enemies) belong to RuntimeState instead
 * (src/save/runtimeState.ts), which is rebuilt from this state.
 *
 * Req 36.2 → fields: Main/Side_Quest progress `quests`; Skyshards `skyshards`; party joins
 * `party.joined`; level and XP `party.level` / `party.xp`; ability upgrades `party.upgrades`;
 * equipment `party.equipment` / `party.relic` / `inventory.ownedEquipment`; items and Glim
 * `inventory.items` / `inventory.glim`; discovered places `discovery.regions` / `landmarks` / `pois` /
 * `hiddenPlaces`; map reveal `discovery.fog`; `world.waystones` / `chests` / `puzzles` / `camps` /
 * `elites` / `echoTablets`; Tutorial_Hints `tutorials`; statistics `stats` / `victory`; respawn
 * `respawn` / `checkpoint` / `lastSafe`; Debug_Tools use `debugUsed`.
 *
 * Ownership: only the simulation systems write their own fields inside the fixed tick; UI, HUD,
 * Audio and Render get `DeepReadonly<GameState>`, so writes from there do not compile.
 */
import { CHARACTERS } from '../../data/characters';
import {
  CHARACTER_IDS, type ChallengeAreaId, type CharacterId, type EliteId, type ItemId, type LandmarkId, type ReactionId, type RegionId,
  type WaystoneId,
} from '../../data/ids';
import { STARTING_ITEMS } from '../../data/items';
import { QUESTS } from '../../data/quests';
import { NEW_GAME_START, THISTLEWICK_HEARTH } from '../../data/worldLayout';
import { FogOfWar } from '../fogOfWar';
import { statsAt } from '../progression';
import { initialQuestState } from '../quest/questReducer';
import type { QuestDef, QuestState } from '../quest/types';

/** Schema version carried by `SaveEnvelope.version`. */
export const SAVE_VERSION = 1;

export interface GameState {
  seed: number; createdAt: string;
  quests: QuestState;
  skyshards: 0 | 1 | 2 | 3; altarActivated: boolean; bossDefeated: boolean; gameCompleted: boolean;
  party: {
    joined: CharacterId[]; active: CharacterId; level: number; xp: number;
    hp: Record<CharacterId, number>; downed: CharacterId[];
    upgrades: Record<CharacterId, { skill: 0 | 1 | 2 | 3; burst: 0 | 1 | 2 | 3 }>;
    equipment: Record<CharacterId, { weapon: ItemId | null; charm: ItemId | null }>; relic: ItemId | null;
  };
  inventory: { glim: number; items: Partial<Record<ItemId, number>>; ownedEquipment: ItemId[] };
  /** `fog` is the base64 of `FogOfWar.encode()`. */
  discovery: { regions: RegionId[]; landmarks: LandmarkId[]; pois: string[]; hiddenPlaces: string[]; fog: string };
  world: {
    waystones: WaystoneId[]; chests: string[]; puzzles: string[]; camps: string[]; elites: EliteId[]; echoTablets: string[];
    flags: Record<string, boolean>;
  };
  codex: ReactionId[]; tutorials: string[]; cinematicsSeen: string[];
  respawn: { kind: 'waystone' | 'hearth' | 'checkpoint'; id: string };
  lastSafe: { pos: [number, number, number]; yaw: number } | null;
  checkpoint: { area: ChallengeAreaId; id: string } | null;
  boss: { reachedPhase: 1 | 2 | 3 } | null;
  stats: {
    playTimeSec: number; enemiesDefeated: number; reactions: number; chestsOpened: number;
    placesDiscovered: number; questsCompleted: number; partyWipes: number;
  };
  /** Victory Screen record; `places` / `chests` are [found, total] tuples. */
  victory: {
    playTimeSec: number; enemiesDefeated: number; places: [number, number]; quests: number;
    chests: [number, number]; level: number; upgrades: Record<CharacterId, number>;
  } | null;
  debugUsed: boolean;
}

/** Read-only view of plain data (UI and Render only ever get `DeepReadonly<GameState>`). */
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

type Upgrade = GameState['party']['upgrades'][CharacterId];
type Equipment = GameState['party']['equipment'][CharacterId];

/** One value per character, in registry order. */
function byCharacter<V>(make: (id: CharacterId) => V): Record<CharacterId, V> {
  return Object.fromEntries(CHARACTER_IDS.map((id): [CharacterId, V] => [id, make(id)])) as Record<CharacterId, V>;
}

/** `createdAt` of a New Game made without a clock reading, so the factory stays deterministic. */
export const UNDATED_CREATED_AT = '1970-01-01T00:00:00.000Z';

export interface NewGameOptions {
  /** ISO 8601 UTC creation time; the composition root passes the clock. Default {@link UNDATED_CREATED_AT}. */
  createdAt?: string;
  /**
   * Quest content: Side_Quests defined here start 'available', the rest 'locked'. Default
   * {@link QUESTS} (src/data/quests.ts). The main quest starts at ms1's first objective either way
   * (stage and objective are indices).
   */
  quests?: readonly QuestDef[];
}

/**
 * New Game (Req 2.1): ms1's first objective, no Skyshard, Kairen alone at level 1 standing at
 * Thistlewick's village entrance ({@link NEW_GAME_START}, recorded as the last Safe_Position), the
 * Hearth as respawn point, herb dumplings ×3 and nothing else earned. `hp` holds all four characters
 * at their level-1 max HP. The seed is stored as the uint32 the RNG streams use (`seed >>> 0`), and
 * the same arguments always give deep-equal, independent states.
 */
export function createNewGameState(seed: number, options: NewGameOptions = {}): GameState {
  const start = NEW_GAME_START;
  return {
    seed: seed >>> 0,
    createdAt: options.createdAt ?? UNDATED_CREATED_AT,
    quests: initialQuestState(options.quests ?? QUESTS),
    skyshards: 0, altarActivated: false, bossDefeated: false, gameCompleted: false,
    party: {
      joined: ['kairen'], active: 'kairen', level: 1, xp: 0,
      hp: byCharacter((id) => statsAt(CHARACTERS[id].baseStats, 1).hp),
      downed: [],
      upgrades: byCharacter((): Upgrade => ({ skill: 0, burst: 0 })),
      equipment: byCharacter((): Equipment => ({ weapon: null, charm: null })),
      relic: null,
    },
    inventory: { glim: 0, items: { ...STARTING_ITEMS }, ownedEquipment: [] },
    discovery: { regions: [], landmarks: [], pois: [], hiddenPlaces: [], fog: new FogOfWar().encode() },
    world: { waystones: [], chests: [], puzzles: [], camps: [], elites: [], echoTablets: [], flags: {} },
    codex: [], tutorials: [], cinematicsSeen: [],
    respawn: { kind: 'hearth', id: THISTLEWICK_HEARTH.id },
    lastSafe: { pos: [start.x, start.groundY, start.z], yaw: start.yaw },
    checkpoint: null,
    boss: null,
    stats: { playTimeSec: 0, enemiesDefeated: 0, reactions: 0, chestsOpened: 0, placesDiscovered: 0, questsCompleted: 0, partyWipes: 0 },
    victory: null,
    debugUsed: false,
  };
}

/** Set-like array in UTF-16 code-unit order without duplicates. */
const toSet = <T extends string>(xs: readonly T[]): T[] => [...new Set(xs)].sort();

/**
 * Deep copy of JSON-like data. `canonical` inserts object keys in code-unit order and drops
 * `undefined` members (as JSON does); arrays always keep their order.
 */
function copyTree(value: unknown, canonical: boolean): unknown {
  if (Array.isArray(value)) return value.map((v: unknown) => copyTree(v, canonical));
  if (value === null || typeof value !== 'object') return value;
  let entries = Object.entries(value);
  if (canonical) entries = entries.filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
  // fromEntries defines own properties, so a '__proto__' key stays plain data.
  return Object.fromEntries(entries.map(([k, v]) => [k, copyTree(v, canonical)]));
}

/**
 * Canonical form (design "정규형", Req 36.9): a deep copy with every set-like array sorted and
 * de-duplicated and object keys in sorted order, so equal states give identical `JSON.stringify`
 * output. Tuples (`lastSafe.pos`, `victory.places`, `victory.chests`) keep their order.
 */
export function canonicalizeGameState(gs: DeepReadonly<GameState>): GameState {
  const { party, inventory, discovery: d, world: w } = gs;
  const withSets = {
    ...gs,
    party: { ...party, joined: toSet(party.joined), downed: toSet(party.downed) },
    inventory: { ...inventory, ownedEquipment: toSet(inventory.ownedEquipment) },
    discovery: { ...d, regions: toSet(d.regions), landmarks: toSet(d.landmarks), pois: toSet(d.pois), hiddenPlaces: toSet(d.hiddenPlaces) },
    world: {
      ...w, waystones: toSet(w.waystones), chests: toSet(w.chests), puzzles: toSet(w.puzzles),
      camps: toSet(w.camps), elites: toSet(w.elites), echoTablets: toSet(w.echoTablets),
    },
    codex: toSet(gs.codex),
    tutorials: toSet(gs.tutorials),
    cinematicsSeen: toSet(gs.cinematicsSeen),
  };
  return copyTree(withSets, true) as GameState;
}

/** Independent deep copy that keeps array and key order. */
export function cloneGameState(gs: DeepReadonly<GameState>): GameState {
  return copyTree(gs, false) as GameState;
}
