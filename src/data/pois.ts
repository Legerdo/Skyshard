/*
 * World density and POIs (design "World Density·POI", "Chest와 보상표", tasks 12.7 and 20.1–20.3; Req 9.3–9.8,
 * 10.1–10.10): every discoverable thing of the open world in one `PoiDef` list, so the data tests can count them per
 * Region and kind, check every Chest's `context` and prove the 60 m coverage (Property 29).
 *
 * - Chests (`CHESTS`, `chest_<region>_<n>` and the puzzle Chests `chest_pz_<region>_<n>`): tier, context and where they
 *   come from: placed in the world, an Enemy_Camp's locked Chest (src/data/spawns.ts `CampDef.chestId`), a puzzle's
 *   reward (`PuzzleSystem.isOpen(opens)`), a hidden Elite's reward (at its lair once defeated) or the Sky Ring Trial's
 *   reward. A glowing Chest may name its designated equipment (`item`, design "장비" 획득 column).
 * - Echo_Tablets (`ECHO_TABLETS`, `tab_<region>_1..3`): the 1–2 sentence record shown on collection (Req 10.8).
 * - Hidden places (`HIDDEN_PLACES`, `poi_<region>_1`): the "숨겨진 장소 발견" notice, own sound and map entry (Req 9.6).
 * - Lore stones, caches and herb bushes (`DENSITY_POIS`): the design's coverage fill. `FILL_SITES` are the centres of
 *   the clusters the Property 29 scan found uncovered (walkable ground of the world seed 20240601 more than 54 m from
 *   every other POI), each given a kind in a fixed rotation per Region.
 * - The Azure Sky Ring Trial (`SKY_RING_TRIAL`): 8 rings on the glide line from `sky_ring_start` down to the lake's
 *   east shore, 60 s, a glowing Chest at the end (Req 10.10).
 * - POI structures (`POI_STRUCTURES`) and air (`POI_AIR_VOLUMES`): the Breezewatch blade shelf, the floating isles'
 *   lower deck (Galeclaw's lair, reached on its Updraft only) and the lake islet with its stepping stones.
 * - Sightlines (`SIGHTLINES`, Req 9.8) and the Landmarks' silhouette bounds (`LANDMARK_SILHOUETTES`, Req 9.3).
 *
 * Positions are metres in the world layout's frame (src/data/worldLayout.ts); `pos.y` is the terrain height of the
 * world seed there, or the surface the POI stands on when `raised`. Pure data: no three.js, DOM or Math.random.
 */
import type { Vec3 } from '../core/types';
import {
  ELITE_NAMES, LANDMARK_NAMES, NPC_NAMES, REGION_NAMES, type EliteId, type ItemId, type LandmarkId, type NpcId, type RegionId,
  type SfxId,
} from './ids';
import { OPEN_WORLD_PUZZLES } from './puzzles';
import { CAMPS } from './spawns';
import type { UpdraftVolumeDef } from './volumes';
import { VISTA_LIST } from './vistas';
import { WAYSTONE_LIST } from './waystones';

// ── Types (design "src/data/pois.ts") ──────────────────────────────────────

export type PoiKind = 'chest' | 'camp' | 'puzzle' | 'tablet' | 'vista' | 'waystone' | 'hidden' | 'elite'
  | 'npc' | 'landmark' | 'trial' | 'lore' | 'cache' | 'herb' | 'updraftRoute';
export type ChestContext = 'hidden' | 'camp' | 'high' | 'puzzle' | 'sidepath' | 'cave';
/** 일반 / 정교한 / 빛나는 (the same strings as logic/loot `ChestTier`). */
export type PoiChestTier = 'common' | 'fine' | 'glowing';

/**
 * id: the target's id (chest_·camp_·pz_·tab_·vista_·ws_·lm_·NpcId·EliteId) or poi_<region>_<n>; radius: the discovery /
 * interaction radius (m). A chest always has its `context`.
 */
export interface PoiDef {
  readonly id: string;
  readonly kind: PoiKind;
  readonly region: RegionId;
  readonly pos: Vec3;
  readonly radius: number;
  readonly context?: ChestContext;
  /** Korean display name (map, notices). */
  readonly name: string;
  /** Stands on a structure (a collider or the Sanctum), not on the terrain: `pos.y` is that surface. */
  readonly raised?: true;
}

/** A main-path look-out: from `pos` (feet) facing `pathDir`, the next Landmark shows within 15° of straight ahead. */
export interface SightlineDef {
  readonly id: string;
  readonly region: RegionId;
  readonly pos: Vec3;
  readonly pathDir: Vec3;
  readonly target: LandmarkId;
}

/** Where a Chest comes from (what makes it present in the world). */
export type ChestSource =
  | { readonly kind: 'placed' }
  /** An Enemy_Camp's locked Chest: openable once the camp is cleared (Req 10.7). */
  | { readonly kind: 'camp'; readonly campId: string }
  /** Appears once the puzzle reward `opens` is open (PuzzleSystem.isOpen). */
  | { readonly kind: 'puzzle'; readonly opens: string }
  /** Left at the hidden Elite's lair once it is defeated (GameState.world.elites, Req 10.10). */
  | { readonly kind: 'elite'; readonly eliteId: EliteId }
  /** The Sky Ring Trial's reward: appears at its end once it is completed (Req 10.10). */
  | { readonly kind: 'trial'; readonly trialId: string };

export interface ChestDef {
  readonly id: string;
  readonly region: RegionId;
  readonly pos: Vec3;
  /** Facing of the lid's front (core/math yaw). */
  readonly yaw: number;
  readonly tier: PoiChestTier;
  readonly context: ChestContext;
  /** Glowing Chests: the designated equipment, given while not owned (else Starmote 5 + Glim 200). */
  readonly item?: ItemId;
  readonly source: ChestSource;
  readonly raised?: true;
}

export interface EchoTabletDef {
  readonly id: string;
  readonly region: RegionId;
  readonly pos: Vec3;
  readonly yaw: number;
  /** Where it stands (map / prompt). */
  readonly name: string;
  /** The 1–2 sentence record shown on collection (Req 10.8). */
  readonly text: string;
}

export interface HiddenPlaceDef {
  readonly id: string;
  readonly region: RegionId;
  readonly pos: Vec3;
  /** Horizontal trigger radius (m); the feet must also be within HIDDEN_PLACE_BAND of `pos.y`. */
  readonly radius: number;
  readonly name: string;
}

export interface LoreDef {
  readonly id: string;
  readonly region: RegionId;
  readonly pos: Vec3;
  readonly name: string;
  readonly text: string;
}

export interface SkyRingTrialDef {
  readonly id: string;
  readonly region: RegionId;
  readonly name: string;
  /** Start stone on the cliff (feet). */
  readonly start: Vec3;
  /** Ring centres, in order. */
  readonly rings: readonly Vec3[];
  /** A ring is passed when the body centre comes within this of its centre (m). */
  readonly ringRadius: number;
  readonly timeLimitSec: number;
  /** The glowing reward Chest at the end. */
  readonly chestId: string;
}

/** A solid POI structure: its footprint and top; the World fills it down into the terrain. */
export type PoiStructureShape =
  | { readonly kind: 'box'; readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number; readonly topY: number; readonly thickness: number }
  | { readonly kind: 'disc'; readonly x: number; readonly z: number; readonly radius: number; readonly topY: number; readonly thickness: number }
  /** A column from under the terrain (or lake bed) up to `topY`. */
  | { readonly kind: 'pillar'; readonly x: number; readonly z: number; readonly radius: number; readonly topY: number };

export interface PoiStructureDef {
  readonly id: string;
  readonly region: RegionId;
  readonly look: 'wood' | 'ruin' | 'rock';
  readonly shape: PoiStructureShape;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

/** Coverage rule (Req 10.1): walkable ground has a POI within this 3D distance (m). */
export const POI_COVERAGE_RADIUS = 60;
/** Hidden places: feet within this height band of the place (m). */
export const HIDDEN_PLACE_BAND = 12;
/** Cache Glim, drawn from the cache's own stream (inclusive). */
export const CACHE_GLIM: readonly [number, number] = [5, 15];
/** Herb bushes give one herb dumpling. */
export const HERB_ITEM: ItemId = 'con_herbDumpling';
/** The hidden place's own discovery sound (the Audio_System maps it). */
export const HIDDEN_PLACE_SFX: SfxId = 'sfx_hidden_place';
/** Chest opening presentation per tier (Req 10.5, 10.6): the glowing tier's larger pillar and own sound. */
export const CHEST_PRESENTATION: Readonly<Record<PoiChestTier, { readonly vfx: `vfx_${string}`; readonly sfx: SfxId; readonly name: string }>> = {
  common: { vfx: 'vfx_chest_open', sfx: 'sfx_chest_open', name: '상자' },
  fine: { vfx: 'vfx_chest_open', sfx: 'sfx_chest_open', name: '정교한 상자' },
  glowing: { vfx: 'vfx_chest_pillar', sfx: 'sfx_chest_glowing', name: '빛나는 상자' },
};

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

// ── Chests (design "Chest 맥락 규칙") ──────────────────────────────────────

const placed = { kind: 'placed' } as const;
const camp = (campId: string): ChestSource => ({ kind: 'camp', campId });
const puzzle = (opens: string): ChestSource => ({ kind: 'puzzle', opens });
const elite = (eliteId: EliteId): ChestSource => ({ kind: 'elite', eliteId });

/** The Sky Ring Trial's id (a `trial` POI) and its reward Chest. */
export const SKY_RING_TRIAL_ID = 'poi_azure_2';
const TRIAL_CHEST_ID = 'chest_azure_6';

export const CHESTS: readonly ChestDef[] = [
  // ── Verdant Reach ──
  { id: 'chest_verdant_1', region: 'verdant', pos: v(-165, 19.0, 364), yaw: 3.6, tier: 'fine', context: 'camp', source: camp('camp_verdant_1') },
  { id: 'chest_verdant_2', region: 'verdant', pos: v(-326, 15.4, 64.5), yaw: 0.8, tier: 'fine', context: 'camp', source: camp('camp_verdant_2') },
  // The cave behind the falls (poi_verdant_1).
  { id: 'chest_verdant_3', region: 'verdant', pos: v(-412, 60.0, 192), yaw: 0.8, tier: 'glowing', context: 'hidden', item: 'chm_echo_shell', source: placed },
  // The shelf on the Breezewatch windmill below its top: dropped onto from the top (y 64) or climbed to.
  { id: 'chest_verdant_4', region: 'verdant', pos: v(-130, 56, 245.4), yaw: Math.PI, tier: 'glowing', context: 'high', item: 'wpn_kairen_emberfang', source: placed, raised: true },
  // Old Mossback's reward in the hidden forest.
  { id: 'chest_verdant_5', region: 'verdant', pos: v(-426, 59.8, 124), yaw: 1.2, tier: 'glowing', context: 'hidden', item: 'rlc_verdant_seed', source: elite('oldMossback') },
  { id: 'chest_pz_verdant_1', region: 'verdant', pos: v(-300, 16.5, 102), yaw: 0, tier: 'fine', context: 'puzzle', source: puzzle('chest_pz_verdant_1') },
  // The sunken Chest the pond sluice (pz_verdant_2) uncovers on the east bank.
  { id: 'chest_verdant_6', region: 'verdant', pos: v(-354, 29.7, 241), yaw: -1.4, tier: 'common', context: 'puzzle', source: puzzle('sluice_pond_verdant') },
  // Side paths along the route: the old Ashgate road and the Elderbough's roots.
  { id: 'chest_verdant_7', region: 'verdant', pos: v(-36, 16.4, 336), yaw: -1.2, tier: 'common', context: 'sidepath', source: placed },
  { id: 'chest_verdant_8', region: 'verdant', pos: v(-262, 17.0, 172), yaw: 2.4, tier: 'common', context: 'sidepath', source: placed },
  // ── Ember Ravine ──
  { id: 'chest_ember_1', region: 'ember', pos: v(146, 64.5, 333.5), yaw: 2.8, tier: 'fine', context: 'camp', source: camp('camp_ember_1') },
  { id: 'chest_ember_2', region: 'ember', pos: v(304, 73.8, 253), yaw: -2, tier: 'fine', context: 'camp', source: camp('camp_ember_2') },
  // Emberjaw's den at the end of the canyon cave (behind pz_ember_2's wall).
  { id: 'chest_ember_3', region: 'ember', pos: v(303, 64.1, 327), yaw: -2.2, tier: 'glowing', context: 'cave', item: 'wpn_talus_bulwark', source: elite('emberjaw') },
  // The mesa top by vista_ember: its walls are climbed.
  { id: 'chest_ember_4', region: 'ember', pos: v(206, 70.0, 64), yaw: -0.8, tier: 'glowing', context: 'high', item: 'wpn_isla_tidecaller', source: placed },
  // Below the broken bridge on the chasm floor (its Updraft carries the character out again).
  { id: 'chest_ember_5', region: 'ember', pos: v(190, -20.2, 253), yaw: 0.5, tier: 'common', context: 'sidepath', source: placed },
  { id: 'chest_ember_6', region: 'ember', pos: v(260, 68.4, -26), yaw: 2.6, tier: 'common', context: 'cave', source: placed },
  // Behind the overheated crystal door (pz_ember_1) at the cave mouth.
  { id: 'chest_ember_7', region: 'ember', pos: v(278, 64.4, 349), yaw: -2.4, tier: 'fine', context: 'hidden', source: puzzle('cave_ember_1') },
  { id: 'chest_ember_8', region: 'ember', pos: v(322, 6.7, 146), yaw: 2.2, tier: 'common', context: 'sidepath', source: placed },
  // ── Azure Highlands ──
  { id: 'chest_azure_1', region: 'azure', pos: v(-120, 85.5, -226.5), yaw: 0, tier: 'fine', context: 'camp', source: camp('camp_azure_1') },
  { id: 'chest_azure_2', region: 'azure', pos: v(60, 122.2, -295.5), yaw: 0, tier: 'fine', context: 'camp', source: camp('camp_azure_2') },
  // The floating isles' lower deck (y 118), reached on its Updraft only.
  { id: 'chest_azure_3', region: 'azure', pos: v(-102, 118, -384), yaw: 2.3, tier: 'glowing', context: 'high', item: 'wpn_wren_skyreaver', source: placed, raised: true },
  { id: 'chest_azure_4', region: 'azure', pos: v(-114, 118, -394), yaw: 0.6, tier: 'glowing', context: 'high', item: 'rlc_ember_core', source: elite('galeclaw'), raised: true },
  // The lake islet over the stepping stones.
  { id: 'chest_azure_5', region: 'azure', pos: v(-165, 70.6, -300), yaw: 1.57, tier: 'common', context: 'sidepath', source: placed, raised: true },
  // The Sky Ring Trial's end on the lake's east shore (a challenge reward, counted as `puzzle`).
  { id: TRIAL_CHEST_ID, region: 'azure', pos: v(-140, 70.0, -300), yaw: 1.57, tier: 'glowing', context: 'puzzle', item: 'chm_starlit_eye', source: { kind: 'trial', trialId: SKY_RING_TRIAL_ID } },
  { id: 'chest_pz_azure_1', region: 'azure', pos: v(-28, 86.0, -238), yaw: 0, tier: 'glowing', context: 'puzzle', source: puzzle('chest_pz_azure_1') },
  // The meteor basin beyond the Observatory ridge (poi_azure_1).
  { id: 'chest_azure_7', region: 'azure', pos: v(259, 85.1, -241), yaw: -2.4, tier: 'fine', context: 'hidden', source: placed },
  { id: 'chest_azure_8', region: 'azure', pos: v(20, 81.2, -208), yaw: 1, tier: 'common', context: 'sidepath', source: placed },
  // ── Shardfall Crater ──
  { id: 'chest_crater_1', region: 'crater', pos: v(-60, 6.1, -30), yaw: 1, tier: 'common', context: 'sidepath', source: placed },
  { id: 'chest_crater_2', region: 'crater', pos: v(70, 12.0, 40), yaw: -2, tier: 'fine', context: 'cave', source: placed },
];

export const CHEST_BY_ID: ReadonlyMap<string, ChestDef> = new Map(CHESTS.map((c) => [c.id, c]));

// ── Echo_Tablets (design core POI table) ───────────────────────────────────

export const ECHO_TABLETS: readonly EchoTabletDef[] = [
  { id: 'tab_verdant_1', region: 'verdant', pos: v(-256, 15.5, 164), yaw: 2.2, name: 'Elderbough 뿌리 둔덕의 석판',
    text: '고목은 추락의 밤을 기억한다. 뿌리 아래 성소에 첫 번째 별의 조각이 잠들었다.' },
  { id: 'tab_verdant_2', region: 'verdant', pos: v(-142, 34.0, 236), yaw: 0.9, name: 'Breezewatch 테라스의 옛 초석',
    text: '풍차를 세운 이들은 바람을 길들이지 않았다. 바람과 함께 나는 법을 배웠을 뿐이다.' },
  { id: 'tab_verdant_3', region: 'verdant', pos: v(-30, 16.0, 330), yaw: -1.6, name: 'Ashgate 옛길의 무너진 이정표',
    text: '이 길의 끝, 붉은 협곡 너머에서 두 번째 메아리가 울린다.' },
  { id: 'tab_ember_1', region: 'ember', pos: v(316, 6.7, 138), yaw: -2.4, name: 'Cinderspire 기슭의 석판',
    text: 'Cinderspire의 심장은 별의 불꽃으로 뛴다. 그 불을 지키는 짐승은 잠들지 않는다.' },
  { id: 'tab_ember_2', region: 'ember', pos: v(405, 67.0, 175), yaw: -1.2, name: '옛 제련소 폐허의 석판',
    text: '용광로지기들은 별의 금속으로 하늘에 닿는 계단을 만들려 했다. 그 꿈은 재가 되었다.' },
  { id: 'tab_ember_3', region: 'ember', pos: v(255, 67.0, -30), yaw: 3, name: '옛 광산 갱도 입구의 석판',
    text: '광부들이 깊이 팔수록 대지는 더 크게 울었다. 그 울음은 크레이터를 향하고 있었다.' },
  { id: 'tab_azure_1', region: 'azure', pos: v(-46, 96.8, -274), yaw: 0.4, name: '거대 아치 기둥의 별자리 부조',
    text: '별자리는 세 파편이 가야 할 길을 그린다. 마지막 별은 가장 높은 곳에 있다.' },
  { id: 'tab_azure_2', region: 'azure', pos: v(118, 120.6, -342), yaw: -0.4, name: '관측소 앞 옛 천문 석주',
    text: 'Caelith는 한때 하늘의 수호자였다. 떨어진 별의 슬픔이 그 빛을 어둡게 물들였다.' },
  { id: 'tab_azure_3', region: 'azure', pos: v(-320, 79.0, -195), yaw: 1.2, name: '서쪽 절벽 끝 봉화대 폐허',
    text: '봉화 셋이 오르면 성소가 깨어난다. 메아리를 모은 자여, 크레이터로 가라.' },
];

export const ECHO_TABLET_BY_ID: ReadonlyMap<string, EchoTabletDef> = new Map(ECHO_TABLETS.map((t) => [t.id, t]));

// ── Hidden places (Req 9.6) ─────────────────────────────────────────────────

export const HIDDEN_PLACES: readonly HiddenPlaceDef[] = [
  // Behind lm_waterfall: the cave whose inner passage leads to the hidden forest (Old Mossback).
  { id: 'poi_verdant_1', region: 'verdant', pos: v(-408, 59.9, 196), radius: 10, name: '폭포 뒤 동굴' },
  // The Ember cave mouth at the end of the canyon (pz_ember_1's crystal door), 446 m from the centre.
  { id: 'poi_ember_1', region: 'ember', pos: v(270, 65.1, 355), radius: 10, name: '협곡 끝 동굴' },
  // The meteor basin beyond the ridge south-east of the Observatory.
  { id: 'poi_azure_1', region: 'azure', pos: v(255, 84.3, -245), radius: 14, name: '운석 분지' },
];

// ── Sky Ring Trial (Req 10.10) ─────────────────────────────────────────────

const TRIAL_START = v(-20, 120, -330);
const TRIAL_END = { x: -140, z: -300 };
const TRIAL_LEN = Math.hypot(TRIAL_END.x - TRIAL_START.x, TRIAL_END.z - TRIAL_START.z);
const TRIAL_DIR = { x: (TRIAL_END.x - TRIAL_START.x) / TRIAL_LEN, z: (TRIAL_END.z - TRIAL_START.z) / TRIAL_LEN };
/** Ring i (0-based) 15·(i + 1) m along the course, its centre y from 116 down to 87 (the glide line, ratio 3.6). */
const TRIAL_RINGS: readonly Vec3[] = Array.from({ length: 8 }, (_, i) =>
  v(TRIAL_START.x + TRIAL_DIR.x * 15 * (i + 1), 116 - (29 * i) / 7, TRIAL_START.z + TRIAL_DIR.z * 15 * (i + 1)));

export const SKY_RING_TRIAL: SkyRingTrialDef = {
  id: SKY_RING_TRIAL_ID, region: 'azure', name: 'Sky Ring Trial', start: TRIAL_START, rings: TRIAL_RINGS, ringRadius: 5,
  timeLimitSec: 60, chestId: TRIAL_CHEST_ID,
};

/** Horizontal course direction (start → end), for the rings' facing. */
export const SKY_RING_DIRECTION: { readonly x: number; readonly z: number } = TRIAL_DIR;

// ── POI structures and air ─────────────────────────────────────────────────

/** The floating isles' lower deck: Galeclaw's lair (src/data/spawns.ts, y 118) and two glowing Chests. */
export const ISLE_LOWER_DECK = { x: -110, z: -390, radius: 13, topY: 118 } as const;

export const POI_STRUCTURES: readonly PoiStructureDef[] = [
  // Breezewatch: a plank shelf on the windmill's north side, 8 m under its top platform (the tower is r 1.6 at (−130, 250)).
  { id: 'bw_blade_shelf', region: 'verdant', look: 'wood',
    shape: { kind: 'box', minX: -131.6, maxX: -128.4, minZ: 244, maxZ: 248.6, topY: 56, thickness: 0.5 } },
  { id: 'isle_lower_deck', region: 'azure', look: 'ruin',
    shape: { kind: 'disc', x: ISLE_LOWER_DECK.x, z: ISLE_LOWER_DECK.z, radius: ISLE_LOWER_DECK.radius, topY: ISLE_LOWER_DECK.topY, thickness: 3 } },
  // lake_azure: the islet 25 m off the east shore and its stepping stones (1.7 m gaps).
  { id: 'lake_islet', region: 'azure', look: 'rock', shape: { kind: 'pillar', x: -165, z: -300, radius: 3.2, topY: 70.6 } },
  ...[-145.5, -149, -152.5, -156, -159.5].map((x, i): PoiStructureDef => ({
    id: `lake_stone_${i + 1}`, region: 'azure', look: 'rock', shape: { kind: 'pillar', x, z: -300, radius: 0.9, topY: 70.4 },
  })),
];

/** The floating isles' Updraft: from the ground north-east of the deck to above it (Req 19.6). */
export const ISLE_UPDRAFT_ID = 'updraft_floating_isles';
export const POI_AIR_VOLUMES: readonly UpdraftVolumeDef[] = [
  { kind: 'updraft', id: ISLE_UPDRAFT_ID, shape: { kind: 'cylinder', x: -94, z: -368, radius: 5, minY: 85, maxY: 132 } },
];

// ── Lore, caches and herbs (coverage fill) ─────────────────────────────────

const LORE_TEXTS: Readonly<Record<RegionId, readonly string[]>> = {
  verdant: [
    '바람이 처음 이 언덕을 지나던 날, 사람들은 풍차를 세워 그 노래를 붙잡았다.',
    '고목의 뿌리는 별빛을 마시고 자란다고 옛 정원사들은 믿었다.',
    '하늘에서 떨어진 파편이 밤마다 속삭였다. 들판의 아이들은 그 소리를 메아리라 불렀다.',
    '가시덤불이 번지기 전, 이 길은 순례자들이 크레이터로 향하던 길이었다.',
    '폭포 뒤에는 숲이 하나 더 있다. 길을 잃은 자만 그 입구를 찾는다.',
    'Thistlewick의 첫 화로는 추락한 별의 조각으로 불을 붙였다고 전해진다.',
    '바람을 읽는 자는 언덕 끝에서 날개를 편다. 두려움은 땅에 두고 가라.',
    '비석의 이름은 지워졌지만, 그 아래 묻힌 씨앗은 아직 싹을 틔운다.',
  ],
  ember: [
    '협곡의 불꽃은 꺼지지 않는다. 광부들은 그 열로 별의 금속을 녹였다.',
    '붉은 수정은 노래하듯 갈라진다. 그 소리가 들리면 네 걸음 물러서라.',
    'Cinderspire는 떨어진 별이 대지를 찌른 자리에서 자라났다.',
    '잿불 속에서도 꽃은 핀다. 용광로지기들은 그것을 재의 약속이라 불렀다.',
    '다리가 무너진 밤, 협곡 아래에서 뜨거운 바람이 솟아 사람들을 건너게 했다.',
    '여기 잠든 대장장이는 불꽃에게 이름을 지어 주었다. 불꽃은 그 이름으로만 대답했다.',
    '옛 제련소의 굴뚝은 별을 향해 연기를 올렸다. 하늘이 답하기를 기다리며.',
    '메사 위에서 보면 협곡은 대지에 새겨진 불의 문자처럼 보인다.',
  ],
  azure: [
    '고원의 별지기들은 밤마다 하늘의 균열을 세었다. 그 수가 늘던 해, 별이 떨어졌다.',
    '부유 섬은 한때 땅이었다. 별의 힘이 그것들을 하늘로 들어 올렸다.',
    '바람의 고리를 지나는 자는 하늘의 축복을 받는다고 전해진다.',
    '관측소의 돔은 별빛을 모으는 그릇이었다. 그릇이 넘치던 날을 기억하는 이는 없다.',
    '호수는 밤하늘을 비춘다. 두 하늘 사이에서 길을 잃지 마라.',
    '거대한 아치는 하늘로 향하는 문이었다고 한다. 문을 여는 열쇠는 바람이었다.',
    '봉화대의 불은 성소가 떠오른 밤에 마지막으로 타올랐다.',
    '눈 덮인 봉우리에 서면 크레이터 위에 떠 있는 성소가 보인다.',
  ],
  crater: [
    '별이 떨어진 자리에는 아무것도 자라지 않았다. 공명의 제단이 세워지기 전까지는.',
    '세 파편이 모이면 하늘의 길이 열린다. 제단의 문양은 그렇게 말한다.',
    '크레이터의 돌은 아직 따뜻하다. 별의 심장이 멈추지 않았기 때문이다.',
  ],
  sanctum: ['성소는 하늘과 대지 사이에서 별의 노래를 지킨다.'],
};

type FillKind = 'lore' | 'cache' | 'herb';
/** Kind rotation per Region: 2 caches, 2 lore stones and a herb bush in every five sites. */
const FILL_ROTATION: readonly FillKind[] = ['cache', 'lore', 'herb', 'cache', 'lore'];
const FILL_NAMES: Readonly<Record<FillKind, string>> = { lore: '옛 기록 비석', cache: '낡은 항아리', herb: '허브 덤불' };
const FILL_RADIUS: Readonly<Record<FillKind, number>> = { lore: 6, cache: 2, herb: 2 };

/**
 * Coverage fill sites [x, y, z, region] (Property 29 scan of the world seed, 5 m grid, 54 m target): walkable ground
 * farther than 54 m from every other POI, greedily covered cluster by cluster. Border-strip sites take the nearest
 * Region.
 */
const FILL_SITES: readonly (readonly [number, number, number, RegionId])[] = [
  // Azure Highlands and the western lowland south of it.
  [10, 135.8, -465, 'azure'], [65, 150.6, -465, 'azure'], [-135, 103.2, -450, 'azure'], [-45, 115.5, -430, 'azure'],
  [110, 144.1, -425, 'azure'], [35, 134.5, -415, 'azure'], [195, 141.5, -415, 'azure'], [-185, 81.5, -395, 'azure'],
  [80, 132.0, -380, 'azure'], [25, 120.2, -360, 'azure'], [-230, 69.6, -350, 'azure'], [240, 120.2, -345, 'azure'],
  [295, 119.3, -345, 'azure'], [-285, 82.0, -330, 'azure'], [-90, 86.5, -315, 'azure'], [170, 107.4, -295, 'azure'],
  [225, 105.0, -295, 'azure'], [325, 99.0, -290, 'azure'], [10, 103.2, -280, 'azure'], [-270, 74.3, -275, 'azure'],
  [-225, 71.7, -240, 'azure'], [95, 85.4, -240, 'azure'], [150, 85.8, -235, 'azure'], [405, 86.5, -230, 'azure'],
  [-415, 84.8, -220, 'azure'], [300, 80.2, -205, 'azure'], [355, 79.1, -195, 'azure'], [180, 75.0, -190, 'azure'],
  [-215, 70.7, -185, 'azure'], [-45, 62.6, -175, 'azure'], [-390, 58.2, -170, 'azure'], [-290, 50.3, -160, 'azure'],
  [-170, 50.2, -160, 'azure'], [280, 50.1, -160, 'azure'], [50, 45.9, -155, 'azure'], [335, 45.9, -155, 'azure'],
  [115, 42.2, -150, 'azure'], [225, 42.1, -150, 'azure'], [-85, 37.5, -145, 'azure'], [-450, 29.1, -135, 'azure'],
  [-360, 23.6, -120, 'azure'], [-215, 23.6, -120, 'azure'], [-305, 21.9, -110, 'azure'], [10, 22.1, -110, 'azure'],
  [185, 39.8, -100, 'azure'], [325, 40.1, -100, 'azure'], [-405, 17.0, -85, 'azure'], [-160, 15.9, -80, 'azure'],
  [-460, 14.8, -75, 'azure'], [-200, 14.7, -40, 'azure'], [-430, 22.4, -30, 'azure'], [-255, 17.2, -30, 'azure'],
  // Shardfall Crater.
  [-85, 17.5, -80, 'crater'], [-30, 12.3, -75, 'crater'], [40, 4.3, -20, 'crater'], [-120, 19.2, 15, 'crater'],
  [5, 4.0, 30, 'crater'], [65, 38.0, 95, 'crater'],
  // Ember Ravine.
  [415, 49.0, -135, 'ember'], [85, 46.0, -95, 'ember'], [240, 41.4, -95, 'ember'], [445, 74.0, -95, 'ember'],
  [130, 72.4, -75, 'ember'], [415, 73.3, -50, 'ember'], [350, 70.9, -45, 'ember'], [160, 70.4, -30, 'ember'],
  [205, 64.0, 0, 'ember'], [450, 71.4, 5, 'ember'], [330, 69.0, 10, 'ember'], [120, 69.6, 25, 'ember'],
  [410, 63.9, 45, 'ember'], [345, 62.3, 65, 'ember'], [265, 65.8, 70, 'ember'], [430, 64.2, 100, 'ember'],
  [150, 9.4, 110, 'ember'], [210, 7.7, 130, 'ember'], [100, 63.7, 180, 'ember'], [165, -20.2, 190, 'ember'],
  [345, 71.3, 190, 'ember'], [150, 63.7, 205, 'ember'], [360, 74.2, 245, 'ember'], [145, 12.6, 250, 'ember'],
  [100, 16.9, 285, 'ember'], [240, 66.2, 295, 'ember'], [350, 72.7, 300, 'ember'], [205, -20.1, 305, 'ember'],
  [80, 73.0, 380, 'ember'], [195, 74.0, 380, 'ember'], [130, 73.8, 405, 'ember'], [175, 73.9, 435, 'ember'],
  // Verdant Reach and the lowland north of it.
  [-325, 15.2, -20, 'verdant'], [-380, 27.0, -5, 'verdant'], [-445, 57.0, 15, 'verdant'], [-285, 18.7, 20, 'verdant'],
  [-175, 15.5, 25, 'verdant'], [-420, 59.9, 65, 'verdant'], [-230, 18.3, 65, 'verdant'], [-125, -10.0, 65, 'verdant'],
  [-375, 30.4, 90, 'verdant'], [-180, -2.0, 100, 'verdant'], [-75, 16.6, 105, 'verdant'], [-130, 19.2, 115, 'verdant'],
  [25, 20.0, 130, 'verdant'], [-340, 22.8, 140, 'verdant'], [-60, 15.1, 165, 'verdant'], [-5, 18.4, 175, 'verdant'],
  [-125, 16.4, 180, 'verdant'], [55, 40.9, 200, 'verdant'], [-295, 18.1, 215, 'verdant'], [-40, 16.8, 220, 'verdant'],
  [-240, 17.6, 235, 'verdant'], [15, 21.1, 235, 'verdant'], [-190, 18.7, 265, 'verdant'], [-80, 15.8, 270, 'verdant'],
  [10, 18.3, 290, 'verdant'], [-365, 27.7, 295, 'verdant'], [-130, 15.3, 320, 'verdant'], [-320, 21.7, 330, 'verdant'],
  [55, 34.3, 350, 'verdant'], [-280, 18.1, 370, 'verdant'], [-235, 20.9, 400, 'verdant'], [-105, 17.4, 410, 'verdant'],
  [-185, 20.7, 425, 'verdant'], [-10, 17.4, 425, 'verdant'], [55, 43.2, 425, 'verdant'], [-80, 17.8, 460, 'verdant'],
];

/** First free `poi_<region>_<n>` serial: the hidden places, the trial and the Updraft route take the low ones. */
const FIRST_FILL_SERIAL: Readonly<Record<RegionId, number>> = { verdant: 2, ember: 2, azure: 4, crater: 1, sanctum: 1 };

export interface DensityPoiDef {
  readonly id: string;
  readonly kind: FillKind;
  readonly region: RegionId;
  readonly pos: Vec3;
  readonly name: string;
}

function buildDensity(): { pois: DensityPoiDef[]; lore: LoreDef[] } {
  const serial: Record<string, number> = { ...FIRST_FILL_SERIAL };
  const perRegion: Record<string, number> = {};
  const lorePerRegion: Record<string, number> = {};
  const pois: DensityPoiDef[] = [];
  const lore: LoreDef[] = [];
  for (const [x, y, z, region] of FILL_SITES) {
    const index = perRegion[region] ?? 0;
    perRegion[region] = index + 1;
    const kind = FILL_ROTATION[index % FILL_ROTATION.length] ?? 'cache';
    const n = serial[region] ?? 1;
    serial[region] = n + 1;
    const id = `poi_${region}_${n}`;
    const pos = v(x, y, z);
    pois.push({ id, kind, region, pos, name: FILL_NAMES[kind] });
    if (kind === 'lore') {
      const texts = LORE_TEXTS[region];
      const i = lorePerRegion[region] ?? 0;
      lorePerRegion[region] = i + 1;
      lore.push({ id, region, pos, name: FILL_NAMES.lore, text: texts[i % texts.length] ?? '' });
    }
  }
  return { pois, lore };
}

const DENSITY = buildDensity();
/** Lore stones, caches and herb bushes. */
export const DENSITY_POIS: readonly DensityPoiDef[] = DENSITY.pois;
export const LORE_STONES: readonly LoreDef[] = DENSITY.lore;
export const LORE_BY_ID: ReadonlyMap<string, LoreDef> = new Map(LORE_STONES.map((l) => [l.id, l]));

// ── Sightlines and Landmark silhouettes (Req 9.3, 9.8) ────────────────────

/** A Landmark's silhouette: the vertical span (y) of its bounding box above (x, z). */
export interface LandmarkSilhouette {
  readonly x: number;
  readonly z: number;
  readonly minY: number;
  readonly maxY: number;
}

export const LANDMARK_SILHOUETTES: Readonly<Record<LandmarkId, LandmarkSilhouette>> = {
  lm_elderbough: { x: -240, z: 150, minY: 14, maxY: 84 }, // the ≈ 70 m old tree
  lm_breezewatch: { x: -130, z: 250, minY: 22, maxY: 70 }, // cliffs, tower and blades
  lm_waterfall: { x: -400, z: 200, minY: 28, maxY: 62 },
  lm_cinderspire: { x: 340, z: 100, minY: 6, maxY: 100 }, // the spire cluster up to the summit arena
  lm_observatory: { x: 145, z: -378, minY: 130, maxY: 150 }, // dome top y 150
  lm_floating_isles: { x: -120, z: -400, minY: 120, maxY: 190 },
  lm_arch_azure: { x: -60, z: -260, minY: 95, maxY: 135 },
  lm_astral_sanctum: { x: 0, z: 0, minY: 170, maxY: 215 },
};

/** Point `fraction` (0 = bottom, 1 = top) up a Landmark's silhouette. */
export function silhouettePoint(id: LandmarkId, fraction: number): Vec3 {
  const s = LANDMARK_SILHOUETTES[id];
  return v(s.x, s.minY + (s.maxY - s.minY) * fraction, s.z);
}

/** Eye height above the feet for sightline checks (m). */
export const SIGHTLINE_EYE_HEIGHT = 1.55;
/** The target must be within this of straight ahead (degrees, Req 9.8). */
export const SIGHTLINE_MAX_ANGLE_DEG = 15;

export const SIGHTLINES: readonly SightlineDef[] = [
  // East end of the Thistlewick plaza, on the road toward Breezewatch.
  { id: 'sl_verdant', region: 'verdant', pos: v(-236, 18, 300), pathDir: v(0.9, 0, -0.43), target: 'lm_breezewatch' },
  // The canyon road in front of ws_ember, toward the Cinderspire base.
  { id: 'sl_ember', region: 'ember', pos: v(256, 7.4, 194), pathDir: v(0.71, 0, -0.71), target: 'lm_cinderspire' },
  // The end of the climb from the camp_oriel ridge, on the Observatory road by camp_azure_2: below this ledge the
  // plateau's rim hides the dome, from here its centre shows straight ahead.
  { id: 'sl_azure', region: 'azure', pos: v(53, 126.3, -313), pathDir: v(0.88, 0, -0.47), target: 'lm_observatory' },
];

// ── The POI list ────────────────────────────────────────────────────────────

const LANDMARK_POIS: readonly PoiDef[] = [
  { id: 'lm_elderbough', kind: 'landmark', region: 'verdant', pos: v(-240, 14, 150), radius: 50, name: LANDMARK_NAMES.lm_elderbough },
  { id: 'lm_breezewatch', kind: 'landmark', region: 'verdant', pos: v(-130, 22, 250), radius: 45, name: LANDMARK_NAMES.lm_breezewatch },
  { id: 'lm_waterfall', kind: 'landmark', region: 'verdant', pos: v(-400, 60, 200), radius: 40, name: LANDMARK_NAMES.lm_waterfall },
  { id: 'lm_cinderspire', kind: 'landmark', region: 'ember', pos: v(336, 5.8, 106), radius: 60, name: LANDMARK_NAMES.lm_cinderspire },
  { id: 'lm_observatory', kind: 'landmark', region: 'azure', pos: v(145, 130.1, -378), radius: 50, name: LANDMARK_NAMES.lm_observatory },
  { id: 'lm_floating_isles', kind: 'landmark', region: 'azure', pos: v(-120, 120, -400), radius: 60, name: LANDMARK_NAMES.lm_floating_isles, raised: true },
  { id: 'lm_arch_azure', kind: 'landmark', region: 'azure', pos: v(-60, 95, -260), radius: 40, name: LANDMARK_NAMES.lm_arch_azure },
  { id: 'lm_astral_sanctum', kind: 'landmark', region: 'sanctum', pos: v(0, 180, 0), radius: 70, name: LANDMARK_NAMES.lm_astral_sanctum, raised: true },
];

/** Camp centres' ground heights (world seed). */
const CAMP_Y: Readonly<Record<string, number>> = {
  camp_verdant_1: 19.3, camp_verdant_2: 15.8, camp_ember_1: 64.7, camp_ember_2: 74.2, camp_azure_1: 84.5, camp_azure_2: 123.3,
};

/** The named NPCs (not the companions) at home, with the ground there. */
const NPC_POIS: readonly (readonly [NpcId, RegionId, number, number, number])[] = [
  ['maren', 'verdant', -251, 18, 301.5], ['pip', 'verdant', -234.4, 18, 300], ['bram', 'verdant', -266, 18, 301.5],
  ['tamsin', 'verdant', -256.2, 18, 311], ['hobb', 'verdant', -208, 19.2, 318], ['durga', 'ember', 235, 10, 235],
  ['oriel', 'azure', 37, 82, -217],
];

/** Puzzle centres' ground heights (world seed), at their first part. */
const PUZZLE_Y: Readonly<Record<string, number>> = {
  pz_verdant_1: 16.5, pz_verdant_2: 30.8, pz_ember_1: 65.1, pz_ember_2: 63.9, pz_azure_1: 86.8, pz_azure_2: 95.7,
};

/** Hidden Elites' lairs: Old Mossback's forest, Emberjaw's den, Galeclaw's deck. */
const ELITE_POIS: readonly (readonly [EliteId, RegionId, Vec3, true?])[] = [
  ['oldMossback', 'verdant', v(-430, 60, 120)],
  ['emberjaw', 'ember', v(300, 63.9, 330)],
  ['galeclaw', 'azure', v(-110, 118, -390), true],
];

function buildPois(): PoiDef[] {
  const out: PoiDef[] = [];
  const add = (p: PoiDef): void => {
    out.push(p);
  };
  for (const c of CAMPS) {
    const center = c.center ?? { x: 0, z: 0 };
    add({ id: c.id, kind: 'camp', region: c.region, pos: v(center.x, CAMP_Y[c.id] ?? 0, center.z), radius: 30, name: c.name ?? 'Enemy_Camp' });
  }
  for (const c of CHESTS) {
    add({
      id: c.id, kind: 'chest', region: c.region, pos: c.pos, radius: 2, context: c.context, name: CHEST_PRESENTATION[c.tier].name,
      ...(c.raised === true ? { raised: true as const } : {}),
    });
  }
  for (const p of OPEN_WORLD_PUZZLES) {
    const first = p.parts[0];
    if (first === undefined) continue;
    add({ id: p.id, kind: 'puzzle', region: p.region, pos: v(first.pos.x, PUZZLE_Y[p.id] ?? 0, first.pos.z), radius: 15, name: p.name });
  }
  for (const t of ECHO_TABLETS) add({ id: t.id, kind: 'tablet', region: t.region, pos: t.pos, radius: 6, name: 'Echo_Tablet' });
  for (const vista of VISTA_LIST) {
    add({ id: vista.id, kind: 'vista', region: vista.region, pos: v(vista.x, vista.groundY, vista.z), radius: vista.arrival.radius, name: vista.name,
      ...(vista.id === 'vista_verdant' ? { raised: true as const } : {}) });
  }
  for (const w of WAYSTONE_LIST) {
    add({ id: w.id, kind: 'waystone', region: w.region, pos: v(w.x, w.groundY, w.z), radius: 3, name: `${w.name} Waystone`,
      ...(w.sanctumPiece ? { raised: true as const } : {}) });
  }
  for (const h of HIDDEN_PLACES) add({ id: h.id, kind: 'hidden', region: h.region, pos: h.pos, radius: h.radius, name: h.name });
  for (const [id, region, pos, raised] of ELITE_POIS) {
    add({ id, kind: 'elite', region, pos, radius: 25, name: ELITE_NAMES[id], ...(raised === true ? { raised } : {}) });
  }
  for (const [id, region, x, y, z] of NPC_POIS) add({ id, kind: 'npc', region, pos: v(x, y, z), radius: 3, name: NPC_NAMES[id] });
  for (const l of LANDMARK_POIS) add(l);
  add({ id: SKY_RING_TRIAL_ID, kind: 'trial', region: 'azure', pos: TRIAL_START, radius: 12, name: SKY_RING_TRIAL.name });
  // The floating isles' Updraft route: its column's foot, the deck's Chests at its end.
  add({ id: 'poi_azure_3', kind: 'updraftRoute', region: 'azure', pos: v(-94, 91.1, -368), radius: 6, name: '부유 섬 상승 기류' });
  for (const d of DENSITY_POIS) add({ id: d.id, kind: d.kind, region: d.region, pos: d.pos, radius: FILL_RADIUS[d.kind], name: d.name });
  return out;
}

/** Every POI of the world. */
export const POIS: readonly PoiDef[] = buildPois();

/** Kinds recorded in `GameState.discovery.pois` on the first approach and shown on the map from then on. */
export const MAP_POI_KINDS: ReadonlySet<PoiKind> = new Set<PoiKind>(['camp', 'puzzle', 'tablet', 'vista', 'lore', 'trial', 'elite']);

/** POIs the World registers on first approach (discovery.pois); hidden places are recorded as such. */
export const DISCOVERABLE_POIS: readonly PoiDef[] = POIS.filter((p) => MAP_POI_KINDS.has(p.kind));

/** Victory Screen totals: Landmarks + map POIs + hidden places; every Chest. */
export const PLACE_TOTAL = LANDMARK_POIS.length + DISCOVERABLE_POIS.length + HIDDEN_PLACES.length;
export const CHEST_TOTAL = CHESTS.length;

/** Minimum POI counts per Region and kind (design "Region별 최소 수량"). */
export const POI_MINIMUMS: Readonly<Partial<Record<RegionId, Readonly<Partial<Record<PoiKind, number>>>>>> = {
  verdant: { camp: 2, chest: 6, puzzle: 2, tablet: 3, vista: 1, waystone: 1, hidden: 1, elite: 1, lore: 3, cache: 4, herb: 2 },
  ember: { camp: 2, chest: 6, puzzle: 2, tablet: 3, vista: 1, waystone: 1, hidden: 1, elite: 1, lore: 3, cache: 4, herb: 2 },
  azure: { camp: 2, chest: 6, puzzle: 2, tablet: 3, vista: 1, waystone: 1, hidden: 1, elite: 1, lore: 3, cache: 4, herb: 2 },
  crater: { chest: 2, waystone: 1, lore: 2, cache: 2 },
};

/** The main Regions (each needs a `high` glowing Chest, Req 10.4). */
export const MAIN_POI_REGIONS: readonly RegionId[] = ['verdant', 'ember', 'azure'];

/**
 * Data rules as messages (empty when valid, Req 10.2–10.4, 10.10): per-Region minimum counts, every Chest with a
 * context, a `high` glowing Chest in every main Region, unique ids, the trial's 8 rings / 60 s / glowing Chest, and
 * every POI inside the play area.
 */
export function poiDataErrors(pois: readonly PoiDef[] = POIS, chests: readonly ChestDef[] = CHESTS): string[] {
  const errors: string[] = [];
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  for (const p of pois) {
    counts.set(`${p.region}:${p.kind}`, (counts.get(`${p.region}:${p.kind}`) ?? 0) + 1);
    const key = `${p.kind}:${p.id}`;
    if (ids.has(key)) errors.push(`duplicate POI ${p.id}`);
    ids.add(key);
    if (p.kind === 'chest' && p.context === undefined) errors.push(`chest ${p.id} has no context`);
    if (p.region !== 'sanctum' && Math.hypot(p.pos.x, p.pos.z) > 470) errors.push(`POI ${p.id} is outside the play area`);
  }
  for (const [region, mins] of Object.entries(POI_MINIMUMS)) {
    for (const [kind, min] of Object.entries(mins ?? {})) {
      const n = counts.get(`${region}:${kind}`) ?? 0;
      if (n < (min ?? 0)) errors.push(`${REGION_NAMES[region as RegionId]} has ${n} ${kind}, needs ${min}`);
    }
  }
  const byId = new Map(chests.map((c) => [c.id, c]));
  for (const region of MAIN_POI_REGIONS) {
    const high = pois.some((p) => p.kind === 'chest' && p.region === region && p.context === 'high' && byId.get(p.id)?.tier === 'glowing');
    if (!high) errors.push(`${REGION_NAMES[region]} has no high glowing Chest`);
  }
  const trial = SKY_RING_TRIAL;
  if (trial.rings.length !== 8) errors.push(`the Sky Ring Trial has ${trial.rings.length} rings, needs 8`);
  if (trial.timeLimitSec !== 60) errors.push('the Sky Ring Trial limit is not 60 s');
  if (byId.get(trial.chestId)?.tier !== 'glowing') errors.push('the Sky Ring Trial does not end at a glowing Chest');
  return errors;
}
