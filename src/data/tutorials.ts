/*
 * Tutorial_Hints (design "Tutorial_System", "첫 10분 온보딩 흐름"; Req 34.1–34.6): the 20 hints in display priority
 * order. When several triggered hints wait at once, the earliest in this list shows first, one at a time.
 *
 * - `trigger`: `start` (seconds after play starts), `near` (the Active_Character within `radius` m of a
 *   `TUTORIAL_ANCHORS` point or an NPC), `event` (a bus event whose `test` holds), `signal` (the system that judged
 *   the situation publishes 'tutorial:trigger' with the hint id).
 * - `text`: at most 40 characters so it fits the 2-line card; no key names (keys follow the bindings), the card draws
 *   the `actions` as key icons from the CURRENT bindings (Req 34.3).
 * - `doneWhen`: an action press / hold, or a bus event name or ControllerEvent type ('climbStarted', 'glideStarted').
 *   Camera actions also complete on mouse look. A shown hint also closes after 8 s (Req 34.4).
 *
 * First 10 minutes (Normal_Play estimate, design timeline): 0:00 move / camera at the village entrance, 0:20 the
 * plaza step (jump), 0:40 Elder Maren (interact), 1:30 the `village_raid` fight (attack, first Telegraph → Dodge),
 * 1:50 Kairen's Skill leaves an Ember mark, then switch key 2 brings Isla in for the steam burst (`tut_reaction`,
 * Req 34.6), 2:40 the open field toward Breezewatch (sprint), 3:20 the Breezewatch cliff foot (climb), 4:20 the
 * windmill-top Vista_Point (map), 5:00 Wren's join on the windmill top (glide).
 *
 * The payload / action / event vocabularies below are local subsets (the pure layer may not import core/gameEvents
 * or src/input); src/tutorial/tutorialSystem.ts checks at compile time that they match GameEvents, InputAction and
 * ControllerEventType.
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import type { DeepReadonly, GameState } from '../logic/save/gameState';
import type { CharacterId, ItemId, TutorialHintId } from './ids';
import { LOCATIONS, NEW_GAME_START } from './worldLayout';

// ── Vocabularies ────────────────────────────────────────────────────────────

/** The input actions hints show as keys or wait for (a subset of src/input/actions' InputAction). */
export type TutorialAction =
  | 'moveForward' | 'moveBack' | 'moveLeft' | 'moveRight'
  | 'camLeft' | 'camRight' | 'camUp' | 'camDown'
  | 'jump' | 'sprint' | 'attack' | 'dodge' | 'skill' | 'burst'
  | 'switch1' | 'switch2' | 'switch3' | 'switch4'
  | 'interact' | 'heal' | 'lockOn' | 'release' | 'map' | 'inventory';

/** Camera actions: their hints also complete on mouse (or stick) look. */
export const CAMERA_ACTIONS: readonly TutorialAction[] = ['camLeft', 'camRight', 'camUp', 'camDown'];

/** Events `event` triggers listen to, with the payload fields their tests read (subset of GameEvents). */
export interface TutorialTriggerEvents {
  'enemy:alerted': { readonly campId: string | null };
  'party:joined': { readonly characterId: CharacterId };
  'area:entered': { readonly areaId: string; readonly first: boolean };
  'item:granted': { readonly itemId: ItemId; readonly count: number };
}

/** `doneWhen` events: bus event names and the controller's event types. */
export type TutorialDoneEvent =
  | 'party:switched' | 'skill:cast' | 'reaction' | 'burst:cast' | 'waystone:activated' | 'element:applied'
  | 'climbStarted' | 'glideStarted';

/** Where the ControllerEvent types come from: the Active_Character's movement mode (src/tutorial maps them). */
export const CONTROLLER_DONE_EVENTS = ['climbStarted', 'glideStarted'] as const satisfies readonly TutorialDoneEvent[];

// ── Hint definition ─────────────────────────────────────────────────────────

export type TutorialEventTrigger = {
  [K in keyof TutorialTriggerEvents]: {
    readonly kind: 'event';
    readonly event: K;
    readonly test?: (payload: TutorialTriggerEvents[K], gs: DeepReadonly<GameState>) => boolean;
  };
}[keyof TutorialTriggerEvents];

export type TutorialTrigger =
  /** Seconds of play after the session starts. */
  | { readonly kind: 'start'; readonly delay: number }
  /** The Active_Character within `radius` m (horizontal) of the target: a TUTORIAL_ANCHORS id or an NPC id. */
  | { readonly kind: 'near'; readonly targetId: string; readonly radius: number }
  | TutorialEventTrigger
  /** Met when 'tutorial:trigger' carries this hint's id. */
  | { readonly kind: 'signal' };

export type TutorialDone =
  | { readonly kind: 'action'; readonly actions: readonly TutorialAction[] }
  | { readonly kind: 'event'; readonly event: TutorialDoneEvent };

export interface TutorialHintDef {
  readonly id: TutorialHintId;
  readonly trigger: TutorialTrigger;
  /** Korean, ≤ 40 characters (2 lines), proper nouns in English. */
  readonly text: string;
  /** Shown as key icons from the current bindings. */
  readonly actions: readonly TutorialAction[];
  readonly doneWhen: TutorialDone;
}

// ── Anchors for `near` triggers ─────────────────────────────────────────────

export interface TutorialAnchor {
  readonly x: number;
  readonly z: number;
  /** Walkable height when known: the check then also needs the feet within 4 m of it. */
  readonly y?: number;
}

const VILLAGE = LOCATIONS.thistlewick;
const BREEZEWATCH = LOCATIONS.breezewatch;
/** Unit (x, z) direction from the village centre along the Breezewatch road. */
const ROAD = (() => {
  const dx = BREEZEWATCH.x - VILLAGE.x;
  const dz = BREEZEWATCH.z - VILLAGE.z;
  const length = Math.hypot(dx, dz);
  return { x: dx / length, z: dz / length };
})();

/**
 * Trigger points on the first-10-minute path. The onboarding placement (task 21.4) puts the plaza step ledge and
 * the open field's terrain at these points.
 */
export const TUTORIAL_ANCHORS = {
  /** The plaza step ledge halfway between the village entrance (New Game start) and the plaza centre. */
  plaza_step: { x: (NEW_GAME_START.x + VILLAGE.x) / 2, z: (NEW_GAME_START.z + VILLAGE.z) / 2, y: VILLAGE.groundY },
  /** The open field on the Breezewatch road, 60 m out of the village centre (ms2 ①). */
  breezewatch_field: { x: VILLAGE.x + ROAD.x * 60, z: VILLAGE.z + ROAD.z * 60 },
} as const satisfies Readonly<Record<string, TutorialAnchor>>;

export type TutorialAnchorId = keyof typeof TUTORIAL_ANCHORS;

/** Equipment items (Weapon / Charm / Relic, by the id prefix rule of src/data/ids.ts). */
const isEquipment = (id: ItemId): boolean => id.startsWith('wpn_') || id.startsWith('chm_') || id.startsWith('rlc_');

// ── The 20 hints, in display priority order ─────────────────────────────────

const MOVE: readonly TutorialAction[] = ['moveForward', 'moveLeft', 'moveBack', 'moveRight'];

export const TUTORIAL_HINTS: readonly TutorialHintDef[] = [
  {
    id: 'tut_move',
    trigger: { kind: 'start', delay: 0 },
    text: '이동 키로 걸어서 광장까지 가 보세요',
    actions: MOVE,
    doneWhen: { kind: 'action', actions: MOVE },
  },
  {
    id: 'tut_camera',
    trigger: { kind: 'start', delay: 3 },
    text: '마우스를 움직이거나 카메라 키로 시점을 돌려 보세요',
    actions: CAMERA_ACTIONS,
    doneWhen: { kind: 'action', actions: CAMERA_ACTIONS },
  },
  {
    id: 'tut_jump',
    trigger: { kind: 'near', targetId: 'plaza_step', radius: 3 },
    text: '턱이 길을 막으면 점프해서 넘어가세요',
    actions: ['jump'],
    doneWhen: { kind: 'action', actions: ['jump'] },
  },
  {
    id: 'tut_interact',
    trigger: { kind: 'near', targetId: 'maren', radius: 2.5 },
    text: 'Elder Maren에게 다가가 말을 걸어 보세요',
    actions: ['interact'],
    doneWhen: { kind: 'action', actions: ['interact'] },
  },
  {
    // The village_raid fight is the first alert on the main path (ms1 ③).
    id: 'tut_attack',
    trigger: { kind: 'event', event: 'enemy:alerted' },
    text: '공격 키로 공격합니다. 길게 누르면 강공격입니다',
    actions: ['attack'],
    doneWhen: { kind: 'action', actions: ['attack'] },
  },
  {
    // Signal: the first enemy Telegraph (the Bramblekin's 0.4 s body glow).
    id: 'tut_dodge',
    trigger: { kind: 'signal' },
    text: '적의 몸이 빛나면 공격이 옵니다. Dodge로 피하세요',
    actions: ['dodge'],
    doneWhen: { kind: 'action', actions: ['dodge'] },
  },
  {
    // Isla's join (ms1 ②); a join cinematic hides it until the cinematic ends.
    id: 'tut_switch',
    trigger: { kind: 'event', event: 'party:joined', test: (_p, gs) => gs.party.joined.length >= 2 },
    text: '교체 키로 합류한 동료와 바꿔 보세요',
    actions: ['switch1', 'switch2', 'switch3', 'switch4'],
    doneWhen: { kind: 'event', event: 'party:switched' },
  },
  {
    // The first fight with a companion in the party (village_raid, after Isla's join).
    id: 'tut_skill',
    trigger: { kind: 'event', event: 'enemy:alerted', test: (_p, gs) => gs.party.joined.length >= 2 },
    text: 'Skill은 적에게 Element 표식을 남깁니다',
    actions: ['skill'],
    doneWhen: { kind: 'event', event: 'skill:cast' },
  },
  {
    // Signal: an enemy holds an Ember mark while Isla stands by to switch in (Req 34.6).
    id: 'tut_reaction',
    trigger: { kind: 'signal' },
    text: 'Ember 표식이 있는 적에게 Isla로 교체해 증기 폭발을 일으키세요',
    actions: ['switch2', 'attack'],
    doneWhen: { kind: 'event', event: 'reaction' },
  },
  {
    // Signal: the Active_Character's Energy is full for the first time.
    id: 'tut_burst',
    trigger: { kind: 'signal' },
    text: 'Energy가 가득 찼습니다. Burst를 써 보세요',
    actions: ['burst'],
    doneWhen: { kind: 'event', event: 'burst:cast' },
  },
  {
    id: 'tut_sprint',
    trigger: { kind: 'near', targetId: 'breezewatch_field', radius: 16 },
    text: '트인 들판에서는 질주 키로 빠르게 달리세요',
    actions: ['sprint'],
    doneWhen: { kind: 'action', actions: ['sprint'] },
  },
  {
    id: 'tut_climb',
    trigger: { kind: 'event', event: 'area:entered', test: (p) => p.areaId === 'breezewatch_base' },
    text: '벽을 향해 이동하면 오르고, 이탈 키로 뛰어내립니다',
    actions: ['moveForward', 'release'],
    doneWhen: { kind: 'event', event: 'climbStarted' },
  },
  {
    // Wren's join on the windmill top (ms2 ③), right before the glide to the Elderbough.
    id: 'tut_glide',
    trigger: { kind: 'event', event: 'party:joined', test: (p) => p.characterId === 'wren' },
    text: '공중에서 점프 키를 누르면 활강합니다',
    actions: ['jump'],
    doneWhen: { kind: 'event', event: 'glideStarted' },
  },
  {
    // Signal: the first Vista_Point reached (the windmill top, vista_verdant).
    id: 'tut_map',
    trigger: { kind: 'signal' },
    text: '주변이 지도에 드러났습니다. 지도를 열어 보세요',
    actions: ['map'],
    doneWhen: { kind: 'action', actions: ['map'] },
  },
  {
    // Signal: the first inactive Waystone in interaction reach (ws_elderbough at the glide's end).
    id: 'tut_waystone',
    trigger: { kind: 'signal' },
    text: 'Waystone을 활성화하면 지도에서 빠른 이동을 할 수 있습니다',
    actions: ['interact', 'map'],
    doneWhen: { kind: 'event', event: 'waystone:activated' },
  },
  {
    // Signal: the first fight with an Elite or three enemies engaged.
    id: 'tut_lockon',
    trigger: { kind: 'signal' },
    text: '적이 많을 때는 Lock-on으로 한 적을 겨냥하세요',
    actions: ['lockOn'],
    doneWhen: { kind: 'action', actions: ['lockOn'] },
  },
  {
    // Signal: the Active_Character's HP under 50 % for the first time.
    id: 'tut_heal',
    trigger: { kind: 'signal' },
    text: 'HP가 낮습니다. 회복 아이템을 사용하세요',
    actions: ['heal'],
    doneWhen: { kind: 'action', actions: ['heal'] },
  },
  {
    id: 'tut_equipment',
    trigger: { kind: 'event', event: 'item:granted', test: (p) => isEquipment(p.itemId) },
    text: '새 장비를 얻었습니다. 가방에서 장비를 교체하세요',
    actions: ['inventory'],
    doneWhen: { kind: 'action', actions: ['inventory'] },
  },
  {
    // Signal: Starmote held and an Echo Altar in interaction reach.
    id: 'tut_upgrade',
    trigger: { kind: 'signal' },
    text: 'Echo Altar에서 Starmote로 능력을 강화할 수 있습니다',
    actions: ['interact'],
    doneWhen: { kind: 'action', actions: ['interact'] },
  },
  {
    // Signal: the first unsolved Puzzle_Mechanism part close by (Hollowroot R1 on the main path).
    id: 'tut_puzzle',
    trigger: { kind: 'signal' },
    text: '장치 아이콘과 같은 색의 Element로 공격하세요',
    actions: ['attack', 'skill'],
    doneWhen: { kind: 'event', event: 'element:applied' },
  },
];

/** Hint ids in display priority order. */
export const TUTORIAL_HINT_IDS: readonly TutorialHintId[] = TUTORIAL_HINTS.map((h) => h.id);

const BY_ID: ReadonlyMap<string, TutorialHintDef> = new Map(TUTORIAL_HINTS.map((h) => [h.id, h]));

/** The hint with `id`, or null. */
export function tutorialHint(id: string): TutorialHintDef | null {
  return BY_ID.get(id) ?? null;
}

/** Longest `text` (characters): two lines of the hint card (Req 34.3). */
export const HINT_TEXT_MAX = 40;

/** Req 34.1's guidance items and the hint that teaches each (the 17 required; lock-on, heal and puzzle are extra). */
export const REQUIRED_GUIDANCE: Readonly<Record<string, TutorialHintId>> = {
  이동: 'tut_move',
  카메라: 'tut_camera',
  점프: 'tut_jump',
  질주: 'tut_sprint',
  상호작용: 'tut_interact',
  공격: 'tut_attack',
  Dodge: 'tut_dodge',
  '캐릭터 교체': 'tut_switch',
  Skill: 'tut_skill',
  Burst: 'tut_burst',
  Reaction: 'tut_reaction',
  등반: 'tut_climb',
  활강: 'tut_glide',
  지도: 'tut_map',
  Waystone: 'tut_waystone',
  장비: 'tut_equipment',
  '능력 강화': 'tut_upgrade',
};

/**
 * Req 34.2's controls, each needed within the first 10 minutes, in first-need order (all before or at the 5:00
 * glide). The onboarding test (task 21.4) checks their trigger points on the main path.
 */
export const FIRST_TEN_MINUTE_HINTS: readonly TutorialHintId[] = [
  'tut_move', 'tut_camera', 'tut_jump', 'tut_attack', 'tut_dodge', 'tut_switch', 'tut_skill', 'tut_reaction', 'tut_climb',
  'tut_glide',
];
