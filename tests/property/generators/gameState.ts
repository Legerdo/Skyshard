/*
 * Shared save generators for Properties 1–4 (design "속성 기반 테스트"): valid canonical GameStates built only from
 * content-defined ids (arbGameState), arbitrary JSON-ish documents (arbJsonish) and damaged variants of a valid state.
 */
import fc from 'fast-check';
import { CHALLENGE_AREA_DEFS } from '../../../src/data/challengeAreas';
import { CHARACTERS } from '../../../src/data/characters';
import {
  CHARACTER_IDS, ELITE_IDS, LANDMARK_IDS, REACTION_IDS, REGION_IDS, SIDE_QUEST_IDS, WAYSTONE_IDS, type CharacterId, type ItemId,
} from '../../../src/data/ids';
import { ITEMS } from '../../../src/data/items';
import { MAIN_QUEST, QUESTS } from '../../../src/data/quests';
import { CAMPS, ENCOUNTER_GROUPS } from '../../../src/data/spawns';
import { TUTORIAL_HINT_IDS } from '../../../src/data/tutorials';
import { THISTLEWICK_HEARTH } from '../../../src/data/worldLayout';
import { FogOfWar } from '../../../src/logic/fogOfWar';
import { statsAt } from '../../../src/logic/progression';
import type { QuestState, SideQuestStatus } from '../../../src/logic/quest/types';
import { puzzleIds } from '../../../src/logic/save/contentIds';
import { canonicalizeGameState, createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { skyshardsForQuest, xpBand } from '../../../src/logic/save/sanitize';

/** A subset of `items` (fast-check picks each at most once). */
const subset = <T>(items: readonly T[]): fc.Arbitrary<T[]> => fc.subarray([...items]);
/** Non-negative double without -0. */
const nonNeg = (max: number): fc.Arbitrary<number> => fc.double({ min: 0, max, noNaN: true }).map((v) => v + 0);
const flagKey = fc.stringMatching(/^[a-z][a-z0-9_]{0,11}$/);
const flags = fc.dictionary(flagKey, fc.boolean(), { maxKeys: 5 });

const WEAPONS = ITEMS.filter((i) => i.kind === 'weapon');
const CHARMS = ITEMS.filter((i) => i.kind === 'charm').map((i) => i.id);
const RELICS = ITEMS.filter((i) => i.kind === 'relic').map((i) => i.id);
const EQUIPMENT = ITEMS.filter((i) => i.kind === 'weapon' || i.kind === 'charm' || i.kind === 'relic').map((i) => i.id);
const CHECKPOINTS = CHALLENGE_AREA_DEFS.flatMap((a) => a.checkpoints.map((c) => ({ area: a.id, id: c.id })));
const CAMP_IDS = [...new Set([...CAMPS.map((c) => c.id), ...ENCOUNTER_GROUPS.map((g) => g.id), 'camp_verdant_1', 'camp_ember_2'])];
const CHEST_IDS = ['chest_verdant_1', 'chest_ember_3', 'chest_azure_2', 'chest_pz_verdant_1', 'chest_pz_azure_1'];
const TABLET_IDS = ['tab_verdant_1', 'tab_verdant_2', 'tab_ember_1', 'tab_azure_3'];
const POI_IDS = ['poi_verdant_1', 'poi_ember_4', 'lm_elderbough', 'vista_verdant', 'ws_ember', 'pz_verdant_1', 'maren'];
const HIDDEN_IDS = ['hidden_verdant_grotto', 'hidden_ember_vent', 'poi_azure_7'];
const CINEMATIC_IDS = ['cin_boss_intro', 'cin_skyshard_1', 'cin_join_isla', 'cin_landmark_lm_elderbough'];

const arbMainPosition: fc.Arbitrary<QuestState['main']> = fc
  .tuple(fc.nat({ max: MAIN_QUEST.stages.length - 1 }), fc.nat({ max: 20 }), fc.boolean())
  .map(([stage, o, done]) => {
    if (done) {
      const last = MAIN_QUEST.stages.length - 1;
      return { stage: last, objective: MAIN_QUEST.stages[last].objectives.length - 1, done: true };
    }
    return { stage, objective: o % MAIN_QUEST.stages[stage].objectives.length, done: false };
  });

const arbSide = fc.tuple(
  ...SIDE_QUEST_IDS.map((id) => {
    const def = QUESTS.find((q) => q.id === id);
    const stages = def?.stages.length ?? 1;
    return fc
      .tuple(fc.constantFrom<SideQuestStatus>('locked', 'available', 'active', 'done'), fc.nat({ max: stages - 1 }), fc.nat({ max: 20 }))
      .map(([status, stage, o]) => ({ status, stage, objective: o % Math.max(1, def?.stages[stage]?.objectives.length ?? 1) }));
  }),
);

const arbFog: fc.Arbitrary<string> = fc
  .array(fc.tuple(fc.integer({ min: -560, max: 560 }), fc.integer({ min: -560, max: 560 }), fc.integer({ min: 0, max: 200 })), { maxLength: 4 })
  .map((ops) => {
    const fog = new FogOfWar();
    for (const [x, z, r] of ops) fog.reveal(x, z, r);
    return fog.encode();
  });

const arbPose = fc.record({
  pos: fc.tuple(fc.integer({ min: -560, max: 560 }), nonNeg(200), fc.double({ min: -560, max: 560, noNaN: true }).map((v) => v + 0)),
  yaw: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }).map((v) => v + 0),
});

const arbRespawn: fc.Arbitrary<GameState['respawn']> = fc.oneof(
  fc.constant({ kind: 'hearth' as const, id: THISTLEWICK_HEARTH.id }),
  fc.constantFrom(...WAYSTONE_IDS).map((id) => ({ kind: 'waystone' as const, id })),
  fc.constantFrom(...CHECKPOINTS).map((c) => ({ kind: 'checkpoint' as const, id: c.id })),
);

const arbVictory: fc.Arbitrary<GameState['victory']> = fc.option(
  fc.record({
    playTimeSec: nonNeg(20000),
    enemiesDefeated: fc.nat({ max: 999 }),
    places: fc.tuple(fc.nat({ max: 40 }), fc.nat({ max: 40 })).map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]),
    quests: fc.nat({ max: 20 }),
    chests: fc.tuple(fc.nat({ max: 30 }), fc.nat({ max: 30 })).map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as [number, number]),
    level: fc.integer({ min: 1, max: 10 }),
    upgrades: fc.tuple(...CHARACTER_IDS.map(() => fc.nat({ max: 6 }))).map((u) => Object.fromEntries(CHARACTER_IDS.map((id, i) => [id, u[i]])) as Record<CharacterId, number>),
  }),
  { nil: null },
);

/** A valid, canonical GameState using only content-defined ids (sanitize leaves it unchanged, no repairs). */
export const arbGameState: fc.Arbitrary<GameState> = fc
  .record({
    seed: fc.nat({ max: 0xffffffff }),
    createdAt: fc.integer({ min: 0, max: 4_000_000_000_000 }).map((ms) => new Date(ms).toISOString()),
    main: arbMainPosition,
    side: arbSide,
    trackSide: fc.nat({ max: SIDE_QUEST_IDS.length }),
    questFlags: flags,
    joined: subset(CHARACTER_IDS).map((j) => (j.length === 0 ? (['kairen'] as CharacterId[]) : j)),
    activeIndex: fc.nat({ max: 3 }),
    level: fc.integer({ min: 1, max: 10 }),
    xpFrac: fc.double({ min: 0, max: 1, noNaN: true }),
    hpFrac: fc.tuple(...CHARACTER_IDS.map(() => fc.double({ min: 0, max: 1, noNaN: true }))),
    downedMask: fc.tuple(...CHARACTER_IDS.map(() => fc.boolean())),
    upgrades: fc.tuple(...CHARACTER_IDS.map(() => fc.tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 })))),
    owned: subset(EQUIPMENT),
    weaponMask: fc.tuple(...CHARACTER_IDS.map(() => fc.boolean())),
    charmPick: fc.tuple(...CHARACTER_IDS.map(() => fc.nat({ max: CHARMS.length }))),
    relicPick: fc.nat({ max: RELICS.length }),
    glim: fc.nat({ max: 99_999 }),
    herb: fc.nat({ max: 10 }),
    feather: fc.option(fc.nat({ max: 10 }), { nil: undefined }),
    starmote: fc.option(fc.nat({ max: 500 }), { nil: undefined }),
    regions: subset(REGION_IDS),
    landmarks: subset(LANDMARK_IDS),
    pois: subset(POI_IDS),
    hidden: subset(HIDDEN_IDS),
    fog: arbFog,
    waystones: subset(WAYSTONE_IDS),
    chests: subset(CHEST_IDS),
    puzzleMask: fc.array(fc.boolean(), { minLength: 32, maxLength: 32 }),
    camps: subset(CAMP_IDS),
    elites: subset(ELITE_IDS),
    tablets: subset(TABLET_IDS),
    worldFlags: flags,
    codex: subset(REACTION_IDS),
    tutorials: subset(TUTORIAL_HINT_IDS),
    cinematics: subset(CINEMATIC_IDS),
    respawn: arbRespawn,
    lastSafe: fc.option(arbPose, { nil: null }),
    checkpoint: fc.option(fc.constantFrom(...CHECKPOINTS), { nil: null }),
    boss: fc.option(fc.constantFrom(1, 2, 3).map((p) => ({ reachedPhase: p as 1 | 2 | 3 })), { nil: null }),
    stats: fc.tuple(nonNeg(50_000), fc.nat({ max: 999 }), fc.nat({ max: 999 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }), fc.nat({ max: 20 }), fc.nat({ max: 50 })),
    victory: arbVictory,
    bools: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
  })
  .map((g): GameState => {
    const gs = createNewGameState(g.seed);
    gs.createdAt = g.createdAt;
    const side = Object.fromEntries(SIDE_QUEST_IDS.map((id, i) => [id, g.side[i]])) as QuestState['side'];
    const active = SIDE_QUEST_IDS.filter((id) => side[id].status === 'active');
    const tracked = g.trackSide < active.length ? active[g.trackSide] : 'main';
    gs.quests = { main: g.main, side, tracked, flags: g.questFlags };
    gs.skyshards = skyshardsForQuest(g.main);
    const joined = [...g.joined].sort();
    gs.party.joined = joined;
    gs.party.active = joined[g.activeIndex % joined.length];
    gs.party.level = g.level;
    const [lo, hi] = xpBand(g.level);
    gs.party.xp = Math.round(lo + (hi - lo) * g.xpFrac);
    CHARACTER_IDS.forEach((id, i) => {
      gs.party.hp[id] = Math.round(statsAt(CHARACTERS[id].baseStats, g.level).hp * g.hpFrac[i]);
      gs.party.upgrades[id] = { skill: g.upgrades[i][0] as 0 | 1 | 2 | 3, burst: g.upgrades[i][1] as 0 | 1 | 2 | 3 };
    });
    gs.party.downed = joined.filter((id) => g.downedMask[CHARACTER_IDS.indexOf(id)]);
    const owned = new Set<ItemId>(g.owned);
    const worn = new Set<ItemId>();
    CHARACTER_IDS.forEach((id, i) => {
      const weapon = WEAPONS.find((w) => w.character === id)?.id ?? null;
      const charm = g.charmPick[i] < CHARMS.length ? CHARMS[g.charmPick[i]] : null;
      const wearCharm = charm !== null && owned.has(charm) && !worn.has(charm);
      if (wearCharm) worn.add(charm);
      gs.party.equipment[id] = {
        weapon: weapon !== null && owned.has(weapon) && g.weaponMask[i] ? weapon : null,
        charm: wearCharm ? charm : null,
      };
    });
    const relic = g.relicPick < RELICS.length ? RELICS[g.relicPick] : null;
    gs.party.relic = relic !== null && owned.has(relic) ? relic : null;
    gs.inventory = {
      glim: g.glim,
      items: {
        con_herbDumpling: g.herb,
        ...(g.feather === undefined ? {} : { con_emberFeather: g.feather }),
        ...(g.starmote === undefined ? {} : { mat_starmote: g.starmote }),
      },
      ownedEquipment: [...owned],
    };
    gs.discovery = { regions: g.regions, landmarks: g.landmarks, pois: g.pois, hiddenPlaces: g.hidden, fog: g.fog };
    const puzzles = [...puzzleIds(g.seed)].filter((_, i) => g.puzzleMask[i % g.puzzleMask.length]);
    gs.world = {
      waystones: g.waystones, chests: g.chests, puzzles, camps: g.camps, elites: g.elites, echoTablets: g.tablets, flags: g.worldFlags,
    };
    gs.codex = g.codex;
    gs.tutorials = g.tutorials;
    gs.cinematicsSeen = g.cinematics;
    gs.respawn = g.respawn;
    gs.lastSafe = g.lastSafe;
    gs.checkpoint = g.checkpoint;
    gs.boss = g.boss;
    const [playTimeSec, enemiesDefeated, reactions, chestsOpened, placesDiscovered, questsCompleted, partyWipes] = g.stats;
    gs.stats = { playTimeSec, enemiesDefeated, reactions, chestsOpened, placesDiscovered, questsCompleted, partyWipes };
    gs.victory = g.victory;
    [gs.altarActivated, gs.bossDefeated, gs.gameCompleted, gs.debugUsed] = g.bools;
    return canonicalizeGameState(gs);
  });

/** Any JSON value (objects, arrays, strings, numbers, booleans, null). */
export const arbJsonValue: fc.Arbitrary<unknown> = fc.jsonValue({ maxDepth: 4 });

/** Paths into a GameState worth damaging. */
const DAMAGE_PATHS: readonly (readonly string[])[] = [
  ['seed'], ['skyshards'], ['quests', 'main', 'stage'], ['quests', 'tracked'], ['party', 'level'], ['party', 'xp'], ['party', 'joined'],
  ['party', 'active'], ['party', 'hp', 'kairen'], ['party', 'equipment', 'isla', 'charm'], ['party', 'relic'], ['inventory', 'glim'],
  ['inventory', 'items', 'con_herbDumpling'], ['inventory', 'items', 'wpn_kairen_emberfang'], ['inventory', 'items', 'con_unknown'],
  ['discovery', 'fog'], ['discovery', 'regions'], ['world', 'puzzles'], ['world', 'chests'], ['world', 'flags'], ['codex'],
  ['respawn'], ['respawn', 'id'], ['lastSafe'], ['lastSafe', 'pos'], ['checkpoint'], ['boss'], ['stats', 'enemiesDefeated'],
  ['victory'], ['debugUsed'], ['createdAt'], ['party'], ['world'],
];

const arbDamageValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined), fc.constant(null), fc.integer({ min: -1000, max: 100000 }), fc.double(), fc.string({ maxLength: 12 }),
  fc.boolean(), fc.array(fc.oneof(fc.string({ maxLength: 8 }), fc.integer()), { maxLength: 4 }), fc.constant({}),
  fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY),
);

/** Writes `value` at `path` into a deep copy of `obj` (undefined deletes the field). */
export function withDamage(obj: unknown, path: readonly string[], value: unknown): unknown {
  const copy = structuredClone(obj) as Record<string, unknown>;
  let at: Record<string, unknown> = copy;
  for (let i = 0; i < path.length - 1; i++) {
    const next = at[path[i]];
    if (typeof next !== 'object' || next === null) return copy;
    at = next as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (value === undefined) delete at[last];
  else at[last] = value;
  return copy;
}

/** A valid state with 1–4 fields replaced by wrong types, out-of-range values, unknown ids or removed. */
export const arbDamagedState: fc.Arbitrary<unknown> = fc
  .tuple(arbGameState, fc.array(fc.tuple(fc.constantFrom(...DAMAGE_PATHS), arbDamageValue), { minLength: 1, maxLength: 4 }))
  .map(([gs, damage]) => damage.reduce<unknown>((acc, [path, value]) => withDamage(acc, path, value), gs));
