// XP budget read back from the content data (design "메인 진행만의 레벨 검증", Req 29.3), shared by the XP data test and
// Property 24. Everything that exists as data is counted from the data modules:
// - enemies: every placed spawner (src/data/spawns SPAWNERS) at its kind's XP (Elites at XP_SOURCES.elite);
// - quests: the XP of every `grant` effect of the Main_Quest stages and Side_Quests (src/data/quests QUESTS);
// - first discoveries: every Landmark and Waystone id, and the POIs of src/data/pois.ts once it exists (vista, hidden,
//   tablet, lore), loaded optionally so this file works before the POI content lands;
// - Chests: Enemy_Camp Chests (fine) and the Chest POIs, at the tier their data gives (common when none is given);
// - puzzles: their RewardRef XP.
// Main path before ms9: the encounter groups the Main_Quest stages ms1–ms8 name (their `defeat` triggers and
// `spawnGroup` effects) plus the Challenge_Area waves, and the stage XP; the route discoveries and route Chests, which
// have no per-route data, come from the design's estimate lines (MAIN_PATH_XP_ESTIMATE).
import type { ChestTier } from '../../../src/core/gameEvents';
import { getEnemyDef } from '../../../src/data/enemies';
import { LANDMARK_IDS, WAYSTONE_IDS } from '../../../src/data/ids';
import { AVOIDABLE_MAIN_PATH_GROUPS, MAIN_PATH_XP_ESTIMATE, XP_SOURCES, type XpBudgetItem } from '../../../src/data/progression';
import { puzzleDefsFor } from '../../../src/data/puzzles';
import { QUESTS } from '../../../src/data/quests';
import { CAMPS, ENCOUNTER_GROUPS, SPAWNERS } from '../../../src/data/spawns';
import type { QuestEffect, StageDef } from '../../../src/logic/quest/types';

export type XpLine = XpBudgetItem;

const sum = (lines: readonly { xp: number }[]): number => lines.reduce((total, l) => total + l.xp, 0);
export { sum as xpSum };

/** XP of the `grant` effects among `effects`. */
function grantXp(effects: readonly QuestEffect[]): number {
  return effects.reduce((total, e) => total + (e.kind === 'grant' ? (e.reward.xp ?? 0) : 0), 0);
}

/** XP of the placed members of camp / encounter group `groupId`. */
export function groupXp(groupId: string): number {
  return SPAWNERS.filter((s) => s.campId === groupId).reduce((total, s) => total + getEnemyDef(s.kind).xp, 0);
}

function mainStagesBeforeMs9(): readonly StageDef[] {
  const main = QUESTS.find((q) => q.kind === 'main');
  if (main === undefined) throw new Error('no Main_Quest');
  const end = main.stages.findIndex((s) => s.id === 'ms9');
  return main.stages.slice(0, end < 0 ? main.stages.length : end);
}

/** Encounter groups on the main path before ms9: named by stages ms1–ms8, plus the Challenge_Area waves. */
export function mainPathGroups(): string[] {
  const named = new Set<string>();
  for (const stage of mainStagesBeforeMs9()) {
    for (const o of stage.objectives) if (o.trigger.kind === 'defeat') named.add(o.trigger.groupId);
    for (const e of [...stage.onStart, ...stage.onComplete]) if (e.kind === 'spawnGroup') named.add(e.groupId);
  }
  for (const g of ENCOUNTER_GROUPS) if (g.byArea === true) named.add(g.id);
  return [...named].filter((id) => ENCOUNTER_GROUPS.some((g) => g.id === id));
}

/**
 * The main-path XP lines before ms9: each encounter group from the data (avoidable ones marked), each stage's grant
 * XP from the quest data, and the design's route discovery / Chest estimate (avoidable).
 */
export function mainPathXpLines(): XpLine[] {
  const combat = mainPathGroups().map((id) => ({ label: `전투: ${id}`, xp: groupXp(id), avoidable: AVOIDABLE_MAIN_PATH_GROUPS.includes(id) }));
  const stages = mainStagesBeforeMs9().map((s) => ({ label: `단계 완료: ${s.id}`, xp: grantXp(s.onComplete), avoidable: false }));
  const route = MAIN_PATH_XP_ESTIMATE.filter((l) => l.label.startsWith('첫 발견') || l.label.startsWith('Chest'));
  return [...combat, ...stages, ...route];
}

// ── Whole-content total ─────────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isRecord = (v: unknown): v is Loose => typeof v === 'object' && v !== null;
const TIERS: readonly ChestTier[] = ['common', 'fine', 'glowing'];

/** Every exported array element of the optional POI module (and a Chest table beside it) that has an `id`. */
function optionalDataRecords(): Loose[] {
  const modules = import.meta.glob(['../../../src/data/pois.ts', '../../../src/data/chests.ts', '../../../src/data/loot.ts'], { eager: true });
  const out: Loose[] = [];
  for (const mod of Object.values(modules)) {
    if (!isRecord(mod)) continue;
    for (const value of Object.values(mod)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) if (isRecord(item) && typeof item.id === 'string') out.push(item);
    }
  }
  return out;
}

export interface ContentXp {
  lines: XpLine[];
  total: number;
  /** POI data (src/data/pois.ts) was found and counted. */
  poisLoaded: boolean;
}

/** XP of all content that exists as data, by source. */
export function contentXp(seed = 1): ContentXp {
  const records = optionalDataRecords();
  const poisLoaded = records.some((r) => typeof r.kind === 'string');
  const lines: XpLine[] = [];
  const add = (label: string, xp: number): void => {
    lines.push({ label, xp, avoidable: false });
  };
  add('적·Elite 처치 (배치된 전부)', SPAWNERS.reduce((t, s) => t + getEnemyDef(s.kind).xp, 0));
  const main = QUESTS.filter((q) => q.kind === 'main').flatMap((q) => q.stages);
  add('Main_Quest 단계', main.reduce((t, s) => t + grantXp(s.onComplete) + grantXp(s.onStart), 0));
  const side = QUESTS.filter((q) => q.kind === 'side').flatMap((q) => q.stages);
  add('Side_Quest', side.reduce((t, s) => t + grantXp(s.onComplete) + grantXp(s.onStart), 0));
  add('첫 발견: Landmark', LANDMARK_IDS.length * XP_SOURCES.discovery.landmark);
  add('첫 발견: Waystone', WAYSTONE_IDS.length * XP_SOURCES.discovery.waystone);
  add('퍼즐 보상', puzzleDefsFor(seed).reduce((t, p) => t + (isRecord(p.reward) && typeof p.reward.xp === 'number' ? p.reward.xp : 0), 0));
  // Chests: camp Chests are fine; POI / Chest tables give their tier (common when unknown). One entry per id.
  const chests = new Map<string, ChestTier>();
  for (const c of CAMPS) if (c.chestId !== null) chests.set(c.chestId, 'fine');
  for (const r of records) {
    const id = r.id as string;
    if (!(id.startsWith('chest_') || r.kind === 'chest')) continue;
    const tier = TIERS.find((t) => t === r.tier) ?? chests.get(id) ?? 'common';
    chests.set(id, tier);
  }
  add('Chest 개봉', [...chests.values()].reduce((t, tier) => t + XP_SOURCES.chest[tier], 0));
  const kinds = { vista: 'vista', hidden: 'hidden', tablet: 'tablet', lore: 'lore' } as const;
  for (const [kind, source] of Object.entries(kinds) as [keyof typeof kinds, keyof typeof XP_SOURCES.discovery][]) {
    const ids = new Set(records.filter((r) => r.kind === kind).map((r) => r.id as string));
    add(`첫 발견: ${kind}`, ids.size * XP_SOURCES.discovery[source]);
  }
  return { lines, total: sum(lines), poisLoaded };
}
