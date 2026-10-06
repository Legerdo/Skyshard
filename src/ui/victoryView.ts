/*
 * VictoryView (design "화면 목록" Victory, Req 7.3, 7.7): the numbers the Victory Screen shows, built once when
 * it opens. When the game-completion record `GameState.victory` exists (saved when Caelith falls, Req 7.6) its
 * figures are used; until the Save_System writes it, they come from the live state and the caller's totals.
 * Ability ranks and the Debug_Tools flag always come from the state. Pure: no DOM.
 */
import { CHARACTER_IDS, type CharacterId } from '../data/ids';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import { completedQuestCount } from '../logic/worldChange';

export interface VictoryView {
  playTimeSec: number;
  enemiesDefeated: number;
  questsCompleted: number;
  partyLevel: number;
  /** Discovered places / all places. */
  places: { found: number; total: number };
  /** Chests found (opened) / all Chests. */
  chests: { found: number; total: number };
  /** Skill and Burst upgrade rank per character, 0–3. */
  abilityRanks: Record<CharacterId, { skill: number; burst: number }>;
  /** Shows "디버그 사용됨". */
  debugUsed: boolean;
}

/** Values the state does not hold: the loop's play time and the content totals from src/data. */
export interface VictoryLive {
  playTimeSec: number;
  placesTotal: number;
  chestsTotal: number;
}

/** Whole, non-negative count; anything else reads as 0. */
function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Main_Quest (when done) plus every finished Side_Quest (the rule lives in src/logic/worldChange.ts). */
export { completedQuestCount };

export function buildVictoryView(gs: DeepReadonly<GameState>, live: VictoryLive): VictoryView {
  const abilityRanks = Object.fromEntries(
    CHARACTER_IDS.map((id) => [id, { skill: gs.party.upgrades[id].skill, burst: gs.party.upgrades[id].burst }]),
  ) as Record<CharacterId, { skill: number; burst: number }>;
  const record = gs.victory;
  if (record !== null) {
    return {
      playTimeSec: count(record.playTimeSec),
      enemiesDefeated: count(record.enemiesDefeated),
      questsCompleted: count(record.quests),
      partyLevel: count(record.level),
      places: { found: count(record.places[0]), total: count(record.places[1]) },
      chests: { found: count(record.chests[0]), total: count(record.chests[1]) },
      abilityRanks,
      debugUsed: gs.debugUsed,
    };
  }
  const { discovery } = gs;
  return {
    playTimeSec: count(live.playTimeSec),
    enemiesDefeated: count(gs.stats.enemiesDefeated),
    questsCompleted: completedQuestCount(gs.quests),
    partyLevel: count(gs.party.level),
    places: {
      found: discovery.landmarks.length + discovery.pois.length + discovery.hiddenPlaces.length,
      total: count(live.placesTotal),
    },
    chests: { found: gs.world.chests.length, total: count(live.chestsTotal) },
    abilityRanks,
    debugUsed: gs.debugUsed,
  };
}
