// Party level / XP numbers and Echo Altar costs (design "Progression·Inventory·Loot", Req 29).
// Pure data. Normal-enemy XP (12–50) lives in the enemy table.
import { ELITE_NAMES, MAIN_STAGE_IDS, MAIN_STAGE_NAMES, type EliteId, type MainStageId } from './ids';

/** Cumulative XP at which levels 1–10 start (index = level − 1); XP beyond 3,000 is discarded. */
export const XP_TABLE: readonly number[] = [0, 120, 300, 520, 800, 1130, 1500, 1950, 2450, 3000];
export const MAX_LEVEL = 10;
/** Per-level growth, compounded from the base: max HP × 1.08^(L−1), ATK × 1.06^(L−1). */
export const LEVEL_HP_GROWTH = 1.08;
export const LEVEL_ATK_GROWTH = 1.06;

/** First-discovery XP kinds, once per id (POI kind names); `lore` is the first read of a lore stone. */
export type DiscoveryKind = 'landmark' | 'vista' | 'hidden' | 'waystone' | 'tablet' | 'lore';

export interface XpSources {
  readonly elite: Readonly<Record<EliteId, number>>;
  /** Main_Quest stage completion; ms9 / ms10 grant none. */
  readonly stage: Readonly<Partial<Record<MainStageId, number>>>;
  /** Each Side_Quest completion. */
  readonly sideQuest: number;
  /** Chest opening by tier (logic/loot `ChestTier`). */
  readonly chest: Readonly<Record<'common' | 'fine' | 'glowing', number>>;
  readonly discovery: Readonly<Record<DiscoveryKind, number>>;
}

export const XP_SOURCES: XpSources = {
  elite: { oldMossback: 120, emberjaw: 120, galeclaw: 120, rootboundWarden: 150, cinderAlpha: 180, sentinelPrime: 220 },
  stage: { ms1: 40, ms2: 60, ms3: 100, ms4: 60, ms5: 120, ms6: 80, ms7: 140, ms8: 60 },
  sideQuest: 80,
  chest: { common: 10, fine: 25, glowing: 50 },
  discovery: { landmark: 20, vista: 30, hidden: 40, waystone: 15, tablet: 10, lore: 5 },
};

/** Echo Altar cost of reaching each tier; every ability goes up to tier 3 (Req 29.4). */
export const UPGRADE_COSTS: Readonly<Record<1 | 2 | 3, Readonly<{ starmote: number; glim: number }>>> = {
  1: { starmote: 3, glim: 100 },
  2: { starmote: 6, glim: 250 },
  3: { starmote: 10, glim: 500 },
};

/**
 * Main-path encounter groups a player can walk past (design "피할 수 있는 Ember·Azure 무리 전투"): the ms4 canyon pack
 * and the ms6 ridge pack. The XP data test leaves them out and still needs level 7 before ms9 (Req 29.3).
 */
export const AVOIDABLE_MAIN_PATH_GROUPS: readonly string[] = ['ember_pass_pack', 'azure_ridge_pack'];

/** One line of the main-path XP budget. */
export interface XpBudgetItem {
  readonly label: string;
  readonly xp: number;
  /** Skippable on the main path: the Ember / Azure packs, route discoveries and route chests. */
  readonly avoidable: boolean;
}

const { elite, stage, chest, discovery } = XP_SOURCES;
const GUARDIAN_ELITES: readonly EliteId[] = ['rootboundWarden', 'cinderAlpha', 'sentinelPrime'];
const STAGES_BEFORE_MS9 = MAIN_STAGE_IDS.slice(0, MAIN_STAGE_IDS.indexOf('ms9'));

/**
 * Main-path-only XP earned before ms9 starts (design "메인 진행만의 레벨 검증"): 2,211 in total
 * (level 8) and 1,542 without the avoidable lines (level 7); Req 29.3 needs level ≥ 7.
 */
export const MAIN_PATH_XP_ESTIMATE: readonly XpBudgetItem[] = [
  // Combat by encounter group (≈ 656).
  { label: '전투: 마을 습격', xp: 48, avoidable: false },
  { label: '전투: Hollowroot 방', xp: 78, avoidable: false },
  { label: '전투: Ember 무리', xp: 180, avoidable: true },
  { label: '전투: Azure 무리', xp: 144, avoidable: true },
  { label: '전투: Observatory 웨이브', xp: 206, avoidable: false },
  // Guardian Elites (550) and stage completions ms1–ms8 (660).
  ...GUARDIAN_ELITES.map((id) => ({ label: `수호 Elite: ${ELITE_NAMES[id]}`, xp: elite[id], avoidable: false })),
  ...STAGES_BEFORE_MS9.map((id) => ({
    label: `단계 완료: ${id} ${MAIN_STAGE_NAMES[id]}`,
    xp: stage[id] ?? 0,
    avoidable: false,
  })),
  // First discoveries on the route (≈ 255) and route chests (≈ 90).
  { label: '첫 발견: Landmark 6곳', xp: 6 * discovery.landmark, avoidable: true },
  { label: '첫 발견: Vista_Point 2곳', xp: 2 * discovery.vista, avoidable: true },
  { label: '첫 발견: Waystone 5곳', xp: 5 * discovery.waystone, avoidable: true },
  { label: 'Chest: 일반 4개', xp: 4 * chest.common, avoidable: true },
  { label: 'Chest: 정교한 2개', xp: 2 * chest.fine, avoidable: true },
];
