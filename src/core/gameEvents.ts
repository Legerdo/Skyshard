/**
 * Game event catalog (design.md "이벤트 버스"): the payload type of every event on the shared EventBus.
 * Pure TypeScript, no three.js or DOM. Payloads are plain JSON-serializable data with readonly fields;
 * delivery rules (tick queue, FIFO order, handler isolation) live in ./eventBus.
 */

import type {
  AttackId,
  BarrierId,
  BossId,
  ChallengeAreaId,
  CharacterId,
  EliteId,
  ElementId,
  EnemyId,
  EntityId,
  ItemId,
  LandmarkId,
  MainStageId,
  NpcId,
  ReactionId,
  RegionId,
  SideQuestId,
  WaystoneId,
} from '../data/ids';
import { EventBus, type EventBusOptions } from './eventBus';
import type { Vec3 } from './types';

// ── Payload vocabularies ────────────────────────────────────────────────────

/** Milestone kinds (Req 36.3, 5.5, 7.6) plus the 90 s timer, new game and manual saves. */
export type SaveReason =
  | 'objective'
  | 'stage'
  | 'skyshard'
  | 'waystone'
  | 'chest'
  | 'puzzle'
  | 'levelUp'
  | 'equipment'
  | 'sideQuest'
  | 'altar'
  | 'gameComplete'
  | 'periodic'
  | 'newGame'
  | 'manual';

/** 일반 / 정교한 / 빛나는 Chest (Req 10.6). */
export type ChestTier = 'common' | 'fine' | 'glowing';

export type InteractTargetKind =
  | 'npc'
  | 'chest'
  | 'waystone'
  | 'hearth'
  | 'altar'
  | 'skyshard'
  | 'puzzle'
  | 'barrier'
  | 'tablet'
  | 'pickup'
  | 'shop'
  | 'echoAltar'
  | 'mural'
  | 'questItem'
  /**
   * Lift pads: the TEMPORARY route lifts (src/data/tempRoute.ts) standing in for climbs and glides, and the
   * Challenge_Area root lifts (src/data/challengeAreas.ts).
   */
  | 'lift'
  /** Task 20.1: lore stones, herb bushes and the Sky Ring Trial's start stone (src/world/poiSystem.ts). */
  | 'lore'
  | 'herb'
  | 'trial';

/** Who applied an Element_Mark. */
export type ElementSource = CharacterId | 'reaction' | 'environment' | 'enemy';

export type UiScreenId =
  | 'loading'
  | 'title'
  | 'newGameConfirm'
  | 'gameplay'
  | 'pause'
  | 'settings'
  | 'map'
  | 'inventory'
  | 'quest'
  | 'codex'
  | 'shop'
  | 'echoAltar'
  | 'dialogue'
  | 'defeat'
  | 'victory'
  | 'credits'
  | 'error';

/** Main_Quest stages use MainStageId; Side_Quest stage ids have no registry. */
type QuestStageRef =
  | { readonly questId: 'main'; readonly stageId: MainStageId }
  | { readonly questId: SideQuestId; readonly stageId: string };

// ── Event map ───────────────────────────────────────────────────────────────

/** Event name → payload, in design catalog order. */
export type GameEvents = {
  'area:entered': { readonly regionId: RegionId; readonly areaId: string; readonly first: boolean };
  'landmark:discovered': { readonly landmarkId: LandmarkId; readonly regionId: RegionId };
  /** `targetId` is the target's content or placement id (NpcId, WaystoneId, chest id, ...). */
  'interact': { readonly targetKind: InteractTargetKind; readonly targetId: string };
  /** `npcId` may be a companion talked to before joining (Main_Quest `talk isla` / `wren` / `talus`). */
  'dialogue:ended': { readonly npcId: NpcId | CharacterId; readonly dialogueId: string };
  'enemy:alerted': {
    readonly entityId: EntityId;
    readonly kind: EnemyId | EliteId;
    readonly campId: string | null;
  };
  'enemy:defeated': {
    readonly entityId: EntityId;
    readonly kind: EnemyId | EliteId;
    readonly campId: string | null;
  };
  /** Also emitted for encounter groups created by `spawnGroup`. */
  'camp:cleared': { readonly campId: string; readonly regionId: RegionId };
  'element:applied': {
    readonly targetId: EntityId;
    readonly element: ElementId;
    readonly source: ElementSource;
  };
  'reaction': {
    readonly reaction: ReactionId;
    readonly targetId: EntityId;
    readonly position: Readonly<Vec3>;
    readonly chainDepth: number;
  };
  'party:switched': { readonly from: CharacterId; readonly to: CharacterId };
  'party:joined': { readonly characterId: CharacterId };
  'party:downed': { readonly characterId: CharacterId };
  /** `bossPhase` is `null` outside the boss fight. */
  'party:wipe': { readonly bossPhase: 1 | 2 | 3 | null };
  'skill:cast': { readonly characterId: CharacterId; readonly hitEnemy: boolean };
  'burst:cast': { readonly characterId: CharacterId };
  'perfectDodge': { readonly characterId: CharacterId; readonly attackerId: EntityId };
  'puzzle:progress': { readonly puzzleId: string; readonly step: number; readonly total: number };
  'puzzle:solved': { readonly puzzleId: string; readonly regionId: RegionId };
  'chest:opened': { readonly chestId: string; readonly tier: ChestTier };
  /** `source` names what granted the items (e.g. 'chest', 'enemy', 'quest', 'shop'). */
  'item:granted': { readonly itemId: ItemId; readonly count: number; readonly source: string };
  'skyshard:acquired': { readonly index: 1 | 2 | 3; readonly regionId: RegionId };
  'barrier:opened': { readonly barrierId: BarrierId; readonly regionId: RegionId };
  /** No payload: there is only one Resonance_Altar. */
  'altar:activated': Record<string, never>;
  'boss:phaseChanged': { readonly bossId: BossId; readonly from: 1 | 2; readonly to: 2 | 3 };
  'boss:defeated': { readonly bossId: BossId };
  /** `skippableAfter` is in seconds. */
  'cinematic:started': { readonly cinematicId: string; readonly skippableAfter: number };
  'cinematic:ended': { readonly cinematicId: string; readonly skipped: boolean };
  /**
   * Task 21.1: a cinematic's `worldChange` (e.g. 'gate_ember', 'starlit_stair') or `timeOfDay` (a TimeOfDayId, 4 s
   * blend) timeline event. A skip sends every remaining one at once, in time order, before its 'cinematic:ended'
   * (`skipped: true`), so a listener that applies them ends in the same World state as a full viewing.
   */
  'cinematic:event': { readonly cinematicId: string; readonly kind: 'worldChange' | 'timeOfDay'; readonly key: string };
  'quest:objectiveCompleted': QuestStageRef & { readonly objectiveId: string };
  'quest:stageCompleted': QuestStageRef & { readonly questDone: boolean };
  /** Shared party level, 1–10. */
  'levelUp': { readonly level: number };
  'waystone:activated': { readonly waystoneId: WaystoneId; readonly regionId: RegionId };
  'save:request': { readonly reason: SaveReason };
  'save:done': { readonly reason: SaveReason; readonly bytes: number };
  /** `error` is a message so the payload stays JSON-serializable. */
  'save:failed': { readonly reason: SaveReason; readonly error: string };
  'tutorial:trigger': { readonly hintId: string };
  'ui:screen': { readonly screen: UiScreenId; readonly open: boolean };

  // Additions beyond the design catalog, needed by later systems.
  'player:landed': { readonly fallHeight: number };
  'player:jumped': Record<string, never>;
  'damage:dealt': {
    readonly targetId: EntityId;
    readonly amount: number;
    readonly crit: boolean;
    readonly element: ElementId | null;
    readonly position: Readonly<Vec3>;
  };
  /**
   * An enemy attack's Telegraph starts (design "공격·피격·Stagger", Req 26.5): the Audio_System plays the ready
   * sound and the Render_System may start its decal / glow. `telegraph` is the TelegraphDef kind, `seconds` its
   * length (clip start → first hit), `position` where it shows (the target's feet for target-aimed attacks, else
   * the attacker's feet) and `yaw` the attacker's facing then.
   */
  'enemy:telegraph': {
    readonly entityId: EntityId;
    readonly kind: EnemyId | EliteId;
    readonly attackId: AttackId;
    readonly telegraph: 'glow' | 'circle' | 'sector' | 'line' | 'ring';
    readonly strong: boolean;
    readonly seconds: number;
    readonly position: Readonly<Vec3>;
    readonly yaw: number;
  };
  /** `fromDirection` points from the character toward the attacker (hit-direction arc), or is `null`. */
  'player:damaged': {
    readonly characterId: CharacterId;
    readonly amount: number;
    readonly fromDirection: Readonly<Vec3> | null;
  };
  'hint:shown': { readonly hintId: string };
  /**
   * A `skill` press during the cooldown or a `burst` press without full Energy (Req 24.5): nothing is cast; the
   * HUD highlights the icon and the Audio_System plays the refusal sound.
   */
  'ability:refused': { readonly characterId: CharacterId; readonly ability: 'skill' | 'burst' };
  /**
   * One Element application chained `count` ≥ 2 reactions (the direct one included): the HUD shows
   * "연쇄 x{count}" for 1.5 s (Req 25.7). Sent after that application's 'reaction' events.
   */
  'reaction:chain': { readonly count: number; readonly targetId: EntityId; readonly position: Readonly<Vec3> };
  /**
   * A Puzzle_Mechanism failure (design "Puzzle_Mechanism 규칙", Req 13.5, 13.7): the Audio_System plays the failure
   * sound. `cause` 'order' / 'timeout' reset a sequence to its start; 'rejected' is an Element a part does not
   * take. `failures` counts this puzzle's failures so far (the hint shows from the 3rd).
   */
  'puzzle:failed': { readonly puzzleId: string; readonly failures: number; readonly cause: 'order' | 'timeout' | 'rejected' };
  /**
   * A hit found an enemy's weak spot (Rootbound Warden's glowing back root, Ember from behind): its `seconds` Stagger
   * starts. The VFX / Audio_System mark the hit; tests read it.
   */
  'enemy:weakSpot': { readonly entityId: EntityId; readonly kind: EnemyId | EliteId; readonly seconds: number };
  /**
   * A Challenge_Area checkpoint rune was stepped on (design "체크포인트와 실패 처리", Req 12.7): it is now the area's
   * latest checkpoint (GameState.checkpoint). `first` on its first activation in this save.
   */
  'checkpoint:reached': { readonly areaId: ChallengeAreaId; readonly checkpointId: string; readonly first: boolean };
  /**
   * Task 13.1: a dialogue window (line `line`, 0-based, of `dialogueId`) was shown. The Audio_System plays the
   * speaker's voice blip at its own pitch (Req 37.7).
   */
  'dialogue:line': { readonly speaker: NpcId | CharacterId; readonly dialogueId: string; readonly line: number };
};

// ── Event names ─────────────────────────────────────────────────────────────

export type GameEventName = keyof GameEvents;

const GAME_EVENT_NAME_LIST = [
  'area:entered',
  'landmark:discovered',
  'interact',
  'dialogue:ended',
  'enemy:alerted',
  'enemy:defeated',
  'camp:cleared',
  'element:applied',
  'reaction',
  'party:switched',
  'party:joined',
  'party:downed',
  'party:wipe',
  'skill:cast',
  'burst:cast',
  'perfectDodge',
  'puzzle:progress',
  'puzzle:solved',
  'chest:opened',
  'item:granted',
  'skyshard:acquired',
  'barrier:opened',
  'altar:activated',
  'boss:phaseChanged',
  'boss:defeated',
  'cinematic:started',
  'cinematic:ended',
  'cinematic:event', // task 21.1
  'quest:objectiveCompleted',
  'quest:stageCompleted',
  'levelUp',
  'waystone:activated',
  'save:request',
  'save:done',
  'save:failed',
  'tutorial:trigger',
  'ui:screen',
  'player:landed',
  'player:jumped',
  'damage:dealt',
  'enemy:telegraph',
  'player:damaged',
  'hint:shown',
  'ability:refused',
  'reaction:chain',
  'puzzle:failed',
  'enemy:weakSpot',
  'checkpoint:reached',
  'dialogue:line', // task 13.1
] as const satisfies readonly GameEventName[];

/** Every GameEvents key, in declaration order. */
export const GAME_EVENT_NAMES: readonly GameEventName[] = GAME_EVENT_NAME_LIST;

/** Compiles only when `T` is `never`. */
type ExpectNever<T extends never> = T;
// Sync check: a GameEvents key missing from GAME_EVENT_NAME_LIST is a type error here that names the key.
type MissingGameEventNames = ExpectNever<Exclude<GameEventName, (typeof GAME_EVENT_NAME_LIST)[number]>>;

// ── Bus ─────────────────────────────────────────────────────────────────────

export type GameEventBus = EventBus<GameEvents>;

/** Creates the game's event bus; `options` go to the EventBus constructor. */
export function createGameEventBus(options?: EventBusOptions): GameEventBus {
  return new EventBus<GameEvents>(options);
}
