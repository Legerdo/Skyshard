/*
 * World state changes (design "세계 상태 변화", task 21.3; Req 4.4, 4.7, 7.5, 7.6, 8.10, 14.8). Pure rules derived from
 * GameState, so a loaded save shows the same world at once:
 * - Blight: each Region's corruption strength (1 = full, 0 = purified). A Skyshard purifies its Region (1 → Verdant
 *   Reach, 2 → Ember Ravine, 3 → Azure Highlands); the crater and the Sanctum stay corrupted until the ending, after
 *   which every trace is gone. The render purifies over 3 s when the count rises in play and instantly on load.
 * - Completion: when cin_ending ends the game is complete; the Victory statistics are recorded once in
 *   GameState.victory (played time, enemies, places and Chests found / total, quests, level, ability tiers).
 * The seal ring segments (= Skyshards), the time of day (src/data/timeOfDay.ts), the village stage (src/logic/village.ts)
 * and the NPC dialogue bucket (src/logic/dialogue.ts) derive from the same fields.
 */
import { CHARACTER_IDS, type CharacterId, type RegionId } from '../data/ids';
import type { QuestState } from './quest/types';
import type { DeepReadonly, GameState } from './save/gameState';

/** The Region each Skyshard index purifies. */
export const SKYSHARD_REGION: Readonly<Record<1 | 2 | 3, RegionId>> = { 1: 'verdant', 2: 'ember', 3: 'azure' };

/** Seconds a Region's Blight takes to fade when its Skyshard is taken in play (instant on load). */
export const BLIGHT_PURIFY_SECONDS = 3;

/** Blight strength of `region` (0 purified … 1 full). */
export function blightStrength(region: RegionId, gs: DeepReadonly<Pick<GameState, 'skyshards' | 'gameCompleted'>>): 0 | 1 {
  if (gs.gameCompleted) return 0;
  for (const index of [1, 2, 3] as const) {
    if (SKYSHARD_REGION[index] === region) return gs.skyshards >= index ? 0 : 1;
  }
  return 1; // crater and sanctum: until the ending
}

/** Main_Quest (when done) plus every finished Side_Quest. */
export function completedQuestCount(quests: DeepReadonly<QuestState>): number {
  const side = Object.values(quests.side).filter((q) => q.status === 'done').length;
  return (quests.main.done ? 1 : 0) + side;
}

export interface CompletionTotals {
  readonly playTimeSec: number;
  readonly placesTotal: number;
  readonly chestsTotal: number;
}

const whole = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** The Victory record (GameState.victory) of `gs` now. */
export function victoryRecord(gs: DeepReadonly<GameState>, totals: CompletionTotals): NonNullable<GameState['victory']> {
  const d = gs.discovery;
  const placesTotal = whole(totals.placesTotal);
  const chestsTotal = whole(totals.chestsTotal);
  const places = Math.min(placesTotal, d.landmarks.length + d.pois.length + d.hiddenPlaces.length);
  const chests = Math.min(chestsTotal, gs.world.chests.length);
  const upgrades = Object.fromEntries(
    CHARACTER_IDS.map((id): [CharacterId, number] => [id, gs.party.upgrades[id].skill + gs.party.upgrades[id].burst]),
  ) as Record<CharacterId, number>;
  const playTime = Number.isFinite(totals.playTimeSec) && totals.playTimeSec > 0 ? totals.playTimeSec : 0;
  return {
    playTimeSec: playTime,
    enemiesDefeated: whole(gs.stats.enemiesDefeated),
    places: [places, placesTotal],
    quests: completedQuestCount(gs.quests),
    chests: [chests, chestsTotal],
    level: gs.party.level,
    upgrades,
  };
}

/**
 * Marks the game complete and records the Victory statistics (once: a second call keeps the first record). Returns
 * whether this call completed it (the caller then requests the 'gameComplete' save).
 */
export function completeGame(gs: GameState, totals: CompletionTotals): boolean {
  if (gs.gameCompleted) return false;
  gs.gameCompleted = true;
  gs.victory = victoryRecord(gs, totals);
  return true;
}
