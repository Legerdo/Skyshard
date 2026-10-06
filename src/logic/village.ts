/*
 * Thistlewick's progress look (design.md "Thistlewick" stage table, task 13.2; Req 14.8, 7.5, 15.3). Pure: the look is
 * computed from GameState every time (Skyshards 0–3, the completion record, the Side_Quest world flags), and each
 * stage keeps the earlier stages' changes, so a freshly loaded save looks exactly like the session that saved it.
 *
 * | stage | change                                                                              |
 * |-------|-------------------------------------------------------------------------------------|
 * | 0     | lanterns out, wilted flower beds, Pip on a makeshift stand                          |
 * | 1     | street lanterns lit, bunting between the roofs                                      |
 * | 2     | the stall reopened (awning, shelves), garlands on the doors, the beds in bloom      |
 * | 3     | star lanterns over the plaza, the five villagers gathered on its rim facing the Sanctum |
 * | post  | the dawn festival (tents, flowers, music), the Blight traces round the village gone  |
 *
 * Pure: imports only src/data and src/logic (layering rule).
 */
import { SIDE_QUEST_FLAGS } from '../data/dialogue';
import type { DeepReadonly, GameState } from './save/gameState';

export type VillageStage = 0 | 1 | 2 | 3 | 'post';

/** What the village stage reads from GameState. */
export type VillageState = DeepReadonly<Pick<GameState, 'skyshards' | 'gameCompleted' | 'world'>>;

/** 'post' once the game is completed (Req 7.6), else the Skyshards held. */
export function villageStage(gs: Pick<VillageState, 'skyshards' | 'gameCompleted'>): VillageStage {
  return gs.gameCompleted ? 'post' : gs.skyshards;
}

/** Stage as a number for "this stage or later" (post = 4). */
export const stageLevel = (stage: VillageStage): number => (stage === 'post' ? 4 : stage);

export interface VillageLook {
  readonly stage: VillageStage;
  readonly streetLanternsLit: boolean;
  readonly bunting: boolean;
  /** 'makeshift' at Skyshard 0–1, 'restored' (awning and shelves) from 2. */
  readonly stall: 'makeshift' | 'restored';
  readonly garlands: boolean;
  readonly flowerBedsBloom: boolean;
  readonly starLanterns: boolean;
  /** The five villagers stand on the plaza rim facing the Sanctum. */
  readonly villagersGathered: boolean;
  readonly festival: boolean;
  readonly blightTraces: boolean;
  /** Side_Quest world changes (Req 15.3). */
  readonly kite: boolean;
  readonly fieldFlowers: boolean;
  readonly forgeLit: boolean;
}

/** The village's look for this GameState (cumulative stages plus the Side_Quest flags). */
export function villageLook(gs: VillageState): VillageLook {
  const stage = villageStage(gs);
  const level = stageLevel(stage);
  const flag = (name: string): boolean => gs.world.flags[name] === true;
  return {
    stage,
    streetLanternsLit: level >= 1,
    bunting: level >= 1,
    stall: level >= 2 ? 'restored' : 'makeshift',
    garlands: level >= 2,
    flowerBedsBloom: level >= 2,
    starLanterns: level >= 3,
    villagersGathered: level >= 3,
    festival: level >= 4,
    blightTraces: level < 4,
    kite: flag(SIDE_QUEST_FLAGS.sq_tamsin),
    fieldFlowers: flag(SIDE_QUEST_FLAGS.sq_hobb),
    forgeLit: flag(SIDE_QUEST_FLAGS.sq_durga),
  };
}
