/*
 * Quest model (design.md "Quest 모델"). `QuestDef[]` is read-only content; only `QuestState` is
 * persisted. `stage` / `objective` are indices into `stages` / `objectives`.
 */
import type { Vec3 } from '../../core/types';
import type { CharacterId, ItemId, MainStageId, NpcId, SideQuestId } from '../../data/ids';

/** Reward bundle shared by quest effects ('grant', 'hud:stageComplete') and puzzles. */
export type RewardRef = { glim?: number; xp?: number; items?: readonly { id: ItemId; count: number }[] };

/** `talk` also targets companions spoken to before they join (table D: `talk isla`). */
export type ObjectiveTrigger =
  | { kind: 'talk'; npc: NpcId | CharacterId }
  | { kind: 'reach'; areaId: string }
  | { kind: 'defeat'; groupId: string }
  | { kind: 'interact'; targetId: string }
  | { kind: 'solve'; puzzleId: string }
  | { kind: 'skyshard'; index: 1 | 2 | 3 }
  | { kind: 'cinematic'; cinematicId: string }
  | { kind: 'collect'; itemId: string; count: number }
  | { kind: 'flag'; flag: string };

export type ObjectiveCategory = 'explore' | 'combat' | 'interact';

export type ObjectiveMarker =
  | { kind: 'exact'; pos: Vec3 }
  | { kind: 'zone'; center: Vec3; radius: number }
  | { kind: 'none' };

export interface ObjectiveDef {
  id: string;
  text: string;
  trigger: ObjectiveTrigger;
  category: ObjectiveCategory;
  marker: ObjectiveMarker;
}

export interface StageDef {
  /** MainStageId for Main_Quest stages; free-form for Side_Quest stages. */
  id: MainStageId | string;
  name: string;
  objectives: readonly ObjectiveDef[];
  onStart: readonly QuestEffect[];
  onComplete: readonly QuestEffect[];
}

export type QuestId = 'main' | SideQuestId;

export interface QuestDef {
  id: QuestId;
  kind: 'main' | 'side';
  stages: readonly StageDef[];
}

export type SideQuestStatus = 'locked' | 'available' | 'active' | 'done';

export interface MainQuestProgress {
  stage: number;
  objective: number;
  done: boolean;
}

export interface SideQuestProgress {
  status: SideQuestStatus;
  stage: number;
  objective: number;
}

export interface QuestState {
  main: MainQuestProgress;
  side: Record<SideQuestId, SideQuestProgress>;
  tracked: QuestId;
  flags: Record<string, boolean>;
}

/** `id` is the trigger target; `count` (collect only) is the amount held after the grant. */
export type QuestEvent = { kind: ObjectiveTrigger['kind']; id: string; count?: number };

export type QuestEffect =
  | { kind: 'hud:objective' }
  /** 3 s banner: `stage` is the stage name, `rewards` the stage's `grant` rewards. */
  | { kind: 'hud:stageComplete'; stage: string; rewards: readonly RewardRef[] }
  | { kind: 'grant'; reward: RewardRef }
  | { kind: 'setFlag'; flag: string }
  | { kind: 'spawnGroup'; groupId: string }
  | { kind: 'startCinematic'; id: string }
  | { kind: 'joinParty'; character: CharacterId }
  | { kind: 'save'; reason: 'objective' | 'stage' | 'sideQuest' }
  | { kind: 'log'; message: string }
  /**
   * Task 13.3: a quest giver's dialogue `onEnd` accepts a Side_Quest ('available' → 'active'). The reducer never emits
   * it; the Quest_System applies it and re-sends progress already made in the world (a cleared camp, a solved puzzle).
   */
  | { kind: 'acceptQuest'; quest: SideQuestId };

export interface QuestResult {
  state: QuestState;
  effects: QuestEffect[];
}
