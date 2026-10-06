/*
 * Puzzle_Mechanism definitions (design "Puzzle_Mechanism 규칙", "오픈월드 퍼즐 (Region당 2개)"; Req 13.1–13.7, 10.2).
 * A puzzle is made of parts: environment Element receivers (src/data/receivers.ts ReceiverKind), pressure plates
 * and arrival triggers. The judgement is the pure `stepPuzzle` (src/logic/puzzle.ts); the scene adapter
 * (src/world/puzzleSystem.ts) places the parts and turns their answers into PuzzleSignals.
 *
 * - single: its one part takes the right Element (or is pressed / reached).
 * - allOf: every part activated once, in any order; activation stays.
 * - sequence: part i takes order[i], in order, within `timeLimitSec` of the first right input (≥ steps × 5 s,
 *   Req 13.6); `parts` beyond order.length are decoys.
 * - weight: plates are active only while pressed; while all are held the `opens` target is open. Without other
 *   parts that moment solves it; with others, activating all of them does, and the target stays open.
 *
 * Positions are world metres (+x east, −z north); a part without `y` stands on the terrain.
 * `PUZZLES` is the same in every save; the Starfall Observatory's sequence takes its order from the save seed, so the
 * Puzzle system places `puzzleDefsFor(seed)` (observatoryPuzzle, seeded through core/rng).
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import { createRng, deriveSeed } from '../core/rng';
import type { Vec3 } from '../core/types';
import type { RewardRef } from '../logic/quest/types';
import {
  CINDERSPIRE_CLUSTER_PARTS, CINDERSPIRE_DEVICES, HOLLOWROOT_DEVICES, OBSERVATORY_DEVICES, OBSERVATORY_PEDESTALS, OBSERVATORY_PUZZLE_ID,
} from './challengeAreas';
import { ELEMENT_IDS, type ElementId, type PuzzleId, type RegionId } from './ids';
import { RECEIVER_DEFS, type ReceiverKind } from './receivers';

export const PUZZLE_KINDS = ['single', 'allOf', 'sequence', 'weight'] as const;
export type PuzzleKind = (typeof PUZZLE_KINDS)[number];

/** What a part is: an Element receiver or pressure plate (ReceiverField devices), or an arrival trigger. */
export type PuzzlePartDevice = ReceiverKind | 'arrival';

/** A world point; without `y` it stands on the terrain. */
export interface PuzzlePoint {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
}

export interface PuzzlePartDef {
  /** `<puzzleId>_<name>`: the device id in the ReceiverField and the PuzzleSignal `part`. */
  readonly id: string;
  readonly device: PuzzlePartDevice;
  /** Korean device name. */
  readonly name: string;
  readonly pos: PuzzlePoint;
  /** Hurt capsule / plate / trigger radius and height (m). */
  readonly radius: number;
  readonly height: number;
  /** The door this puzzle opens: the part stays solid until the puzzle is solved (breakable devices go when broken). */
  readonly gate?: boolean;
  /**
   * false: the part has no solid body of its own because its Challenge_Area places the collider (the Cinderspire H1
   * Heat_Crystal wall, whose climbable flag follows the device); its hurt capsule still takes the hits.
   */
  readonly solid?: false;
  /**
   * The Element the part is marked with (Req 13.2) when its device takes several: the Observatory's star pedestals.
   * A sequence step still shows its `order` Element (the same one there).
   */
  readonly element?: ElementId;
}

/** What solving opens: a Chest that appears, a door, lift or platform id, and where it is. */
export interface PuzzleOpens {
  readonly opens: string;
  readonly at: PuzzlePoint;
}

/** design `PuzzleDef.reward`: a granted reward or the id of what opens. */
export type PuzzleReward = RewardRef | PuzzleOpens;

/** design `PuzzleDef`. */
export interface PuzzleDef {
  readonly id: PuzzleId;
  /** Korean name. */
  readonly name: string;
  readonly region: RegionId;
  readonly kind: PuzzleKind;
  readonly parts: readonly PuzzlePartDef[];
  /** sequence only: the Element part i takes as step i. */
  readonly order?: readonly ElementId[];
  /** sequence only: ≥ order.length × 5 s (Req 13.6). */
  readonly timeLimitSec?: number;
  /** One line shown after the 3rd failure (Req 13.7). */
  readonly hint: string;
  readonly reward: PuzzleReward;
}

/** Timing and counting rules (Req 13.3, 13.5, 13.6, 13.7). */
export const PUZZLE_RULES = {
  /** A right input shows its glow / spin / opening and sound within this (s). */
  feedbackSec: 0.2,
  /** A failed sequence is back at its initial state within this (s); the rules reset it at once. */
  resetWithinSec: 2,
  /** Minimum sequence time per step (s). */
  secondsPerStep: 5,
  /** The hint shows from this failure on. */
  hintAfterFailures: 3,
  /** How long the parts flash after a failure (s, presentation). */
  failFlashSec: 0.8,
} as const;

/** Default hurt / trigger sizes by device (m). */
export const PART_SIZE: Readonly<Record<PuzzlePartDevice, { radius: number; height: number }>> = {
  brambleGate: { radius: 1.4, height: 2.4 },
  brazier: { radius: 0.6, height: 1.1 },
  heatCrystal: { radius: 1.4, height: 3.2 },
  fireObstacle: { radius: 1, height: 1.5 },
  windWheel: { radius: 0.5, height: 2.6 },
  crackedBoulder: { radius: 1.2, height: 1.8 },
  pressurePlate: { radius: 1, height: 0.1 },
  unstableCrystal: { radius: 1.5, height: 3 },
  arrival: { radius: 1.5, height: 2 },
  // Tall enough that Isla's arrows (1.3 m above her feet on the same floor) hit it.
  elementPedestal: { radius: 0.7, height: 1.6 },
};

/** Whether a reward opens something rather than granting items. */
export function isOpensReward(reward: PuzzleReward): reward is PuzzleOpens {
  return 'opens' in reward;
}

/**
 * The Element whose icon and colour a part shows (Req 13.2): a sequence step's Element, else the first Element the
 * device takes; a pressure plate shows Terra (Talus's stone pillar holds it, Req 13.1); an arrival trigger none.
 */
export function partElement(def: Pick<PuzzleDef, 'parts' | 'order'>, index: number): ElementId | null {
  const part = def.parts[index];
  if (part === undefined) return null;
  const step = def.order?.[index];
  if (step !== undefined) return step;
  if (part.element !== undefined) return part.element;
  if (part.device === 'arrival') return null;
  if (part.device === 'pressurePlate') return 'terra';
  return RECEIVER_DEFS[part.device].accepts[0] ?? null;
}

function part(puzzle: PuzzleId, name: string, device: PuzzlePartDevice, label: string, x: number, z: number, extra: { gate?: boolean } = {}): PuzzlePartDef {
  return { id: `${puzzle}_${name}`, device, name: label, pos: { x, z }, ...PART_SIZE[device], ...extra };
}

const at = (x: number, z: number): PuzzlePoint => ({ x, z });

/*
 * Open-world puzzles, two per main Region (Req 10.2), from the design table. Spots were chosen on walkable
 * terrain of the world seed (verdant ruins north-west of the Elderbough, the pond_verdant east bank, the Ember
 * cave at poi_ember_1 and the Emberjaw den at (300, 330), the Azure plateau west of camp_oriel and the flat
 * shelf west of lake_azure below vista_azure). Sequence chimes stand 20 m apart, so no single hit (Wren's
 * Burst reaches 8.5 m) rings two of them.
 */
export const OPEN_WORLD_PUZZLES: readonly PuzzleDef[] = [
  {
    id: 'pz_verdant_1',
    name: '폐허의 화로',
    region: 'verdant',
    kind: 'allOf',
    parts: [
      part('pz_verdant_1', 'brazier_a', 'brazier', '폐허의 화로', -296, 96),
      part('pz_verdant_1', 'brazier_b', 'brazier', '폐허의 화로', -306, 102),
      part('pz_verdant_1', 'brazier_c', 'brazier', '폐허의 화로', -298, 108),
    ],
    hint: '세 화로 모두에 Ember 불꽃을 붙여 보자.',
    reward: { opens: 'chest_pz_verdant_1', at: at(-300, 102) }, // a fine Chest appears (context `puzzle`)
  },
  {
    id: 'pz_verdant_2',
    name: '연못 수문 바람개비',
    region: 'verdant',
    kind: 'single',
    parts: [part('pz_verdant_2', 'wheel', 'windWheel', '수문 바람개비', -346, 236)],
    hint: '바람개비는 Gale 바람으로 돌릴 수 있다.',
    reward: { opens: 'sluice_pond_verdant', at: at(-365, 232) }, // the pond drops 2 m, the sunken Chest shows
  },
  {
    id: 'pz_ember_1',
    name: '과열 수정 문',
    region: 'ember',
    kind: 'single',
    parts: [part('pz_ember_1', 'door', 'heatCrystal', '과열 수정 문', 270, 355, { gate: true })],
    hint: '달아오른 수정은 Tide 물로 식혀야 갈라진다.',
    reward: { opens: 'cave_ember_1', at: at(274, 352) }, // the Ember cave entrance
  },
  {
    id: 'pz_ember_2',
    name: '불안정 수정 벽',
    region: 'ember',
    kind: 'single',
    parts: [part('pz_ember_2', 'wall', 'unstableCrystal', '불안정 수정 벽', 288, 340)],
    hint: 'Ember로 불안정 수정을 터뜨리고 4 m 밖으로 물러나자.',
    reward: { opens: 'den_emberjaw', at: at(300, 330) }, // the hidden Elite Emberjaw's den
  },
  {
    id: 'pz_azure_1',
    name: '바람 풍경',
    region: 'azure',
    kind: 'sequence',
    // parts[i] is step i: the pole with i + 1 notches.
    parts: [
      part('pz_azure_1', 'chime_1', 'windWheel', '바람 풍경', -48, -230),
      part('pz_azure_1', 'chime_2', 'windWheel', '바람 풍경', -28, -230),
      part('pz_azure_1', 'chime_3', 'windWheel', '바람 풍경', -8, -230),
    ],
    // 20 m between the chimes: ≈ 6.7 s running and two Gale hits, well inside 3 × 5 s.
    order: ['gale', 'gale', 'gale'],
    timeLimitSec: 15,
    hint: '기둥의 홈 수 1·2·3 순서로 15초 안에 Gale을 울리자.',
    reward: { opens: 'chest_pz_azure_1', at: at(-28, -238) }, // a glowing Chest appears
  },
  {
    id: 'pz_azure_2',
    name: '부유 발판 압력판',
    region: 'azure',
    kind: 'weight',
    parts: [
      part('pz_azure_2', 'plate_a', 'pressurePlate', '압력판', -352, -284),
      part('pz_azure_2', 'plate_b', 'pressurePlate', '압력판', -344, -284),
    ],
    hint: '한 판은 Talus의 돌기둥으로 누르고 다른 판에 서 보자.',
    reward: { opens: 'shortcut_vista_azure', at: at(-340, -300) }, // floating platforms toward vista_azure
  },
];

const D = HOLLOWROOT_DEVICES;
const on = (p: Vec3): PuzzlePoint => ({ x: p.x, z: p.z, y: p.y });
function partOn(puzzle: PuzzleId, name: string, device: PuzzlePartDevice, label: string, pos: Vec3): PuzzlePartDef {
  return { id: `${puzzle}_${name}`, device, name: label, pos: on(pos), ...PART_SIZE[device] };
}

/**
 * Hollowroot Shrine (design "Hollowroot Shrine", task 9.6; Req 12.1): one Ember, one Gale and one Terra puzzle, in the
 * order of the shrine's rooms. Their `opens` targets are the doors and the lift of src/data/challengeAreas.ts.
 */
export const HOLLOWROOT_PUZZLES: readonly PuzzleDef[] = [
  {
    id: 'pz_hollowroot_1',
    name: '불꽃 문양 가시 덤불',
    region: 'verdant',
    kind: 'single',
    parts: [partOn('pz_hollowroot_1', 'bramble', 'brambleGate', '가시 덤불 관문', D.bramble)],
    hint: '불꽃 문양 덤불은 Ember 불꽃으로 태울 수 있다.',
    reward: { opens: 'hollowroot_bramble_path', at: on(D.bramblePath) }, // R1 → cp_hollowroot_1 and R2
  },
  {
    id: 'pz_hollowroot_2',
    name: '바람개비 뿌리 승강기',
    region: 'verdant',
    kind: 'single',
    parts: [partOn('pz_hollowroot_2', 'wheel', 'windWheel', '승강기 바람개비', D.windWheel)],
    hint: 'Wren의 Gale 바람으로 바람개비를 돌려 보자.',
    reward: { opens: 'hollowroot_root_lift', at: on(D.rootLift) }, // the root lift up to the R3 corridor
  },
  {
    id: 'pz_hollowroot_3',
    name: '압력판과 금 간 바위',
    region: 'verdant',
    // The root door is open while the plate is held; breaking the boulder behind it solves the puzzle.
    kind: 'weight',
    parts: [
      partOn('pz_hollowroot_3', 'plate', 'pressurePlate', '뿌리 문 압력판', D.plate),
      partOn('pz_hollowroot_3', 'boulder', 'crackedBoulder', '금 간 바위', D.boulder),
    ],
    hint: 'Talus의 돌기둥으로 판을 누르고 바위는 Terra로 부수자.',
    reward: { opens: 'hollowroot_root_door', at: on(D.rootDoor) },
  },
];

const C = CINDERSPIRE_DEVICES;

/**
 * Cinderspire (design "Cinderspire", task 9.7; Req 12.2, 13.8, 13.9): the H1 Heat_Crystal wall (allOf: the wall
 * cooled by Tide + the arrival on L4 above it, so a climber who made it up solves it and the wall stays cooled), and
 * the two optional Unstable_Crystal clusters at the vents, whose blasts free the vent ledges (src/data/challengeAreas.ts
 * risers). Only pz_cinderspire_1 is a Main_Quest `solve` target.
 */
export const CINDERSPIRE_PUZZLES: readonly PuzzleDef[] = [
  {
    id: 'pz_cinderspire_1',
    name: '과열 수정 벽',
    region: 'ember',
    kind: 'allOf',
    parts: [
      // The wall's own collider is the Challenge_Area's HeatCrystalWall; the hurt capsule reaches out over L3.
      { ...partOn('pz_cinderspire_1', 'wall', 'heatCrystal', '과열 수정 벽', C.heatWall), radius: 1.6, height: 4, solid: false },
      { ...partOn('pz_cinderspire_1', 'top', 'arrival', '과열 수정 벽 위 발판', C.heatWallTop), radius: 1.8 },
    ],
    hint: 'Isla의 Tide로 벽을 식히고 10초 안에 끝까지 오르자.',
    reward: { opens: 'cinderspire_heat_wall', at: on(C.heatWallTop) },
  },
  {
    id: 'pz_cinderspire_2',
    name: '첫 번째 분출구의 불안정 수정',
    region: 'ember',
    kind: 'single',
    parts: [{ ...partOn('pz_cinderspire_2', 'cluster', 'unstableCrystal', '불안정 수정 무리', C.clusterU1), id: CINDERSPIRE_CLUSTER_PARTS.u1 }],
    hint: 'Ember로 터뜨리고 4 m 밖으로 물러나면 분출구 발판이 열린다.',
    reward: { opens: 'cinderspire_vent_ledge_1', at: on(C.ventLedgeU1) },
  },
  {
    id: 'pz_cinderspire_3',
    name: '두 번째 분출구의 불안정 수정',
    region: 'ember',
    kind: 'single',
    parts: [{ ...partOn('pz_cinderspire_3', 'cluster', 'unstableCrystal', '불안정 수정 무리', C.clusterU2), id: CINDERSPIRE_CLUSTER_PARTS.u2 }],
    hint: 'Ember로 터뜨리고 4 m 밖으로 물러나면 분출구 발판이 열린다.',
    reward: { opens: 'cinderspire_vent_ledge_2', at: on(C.ventLedgeU2) },
  },
];

/**
 * The Puzzle_Mechanisms whose definition is the same in every save; the Puzzle system places these plus the seeded
 * Observatory puzzle (puzzleDefsFor).
 */
export const PUZZLES: readonly PuzzleDef[] = [...OPEN_WORLD_PUZZLES, ...HOLLOWROOT_PUZZLES, ...CINDERSPIRE_PUZZLES];

/** Minimum time limit of a sequence with `steps` steps (Req 13.6). */
export function minTimeLimit(steps: number): number {
  return steps * PUZZLE_RULES.secondsPerStep;
}

/** Steps of pz_observatory_1: three of the four Elements (design). */
export const OBSERVATORY_STEPS = 3;

/**
 * The Observatory's constellation order for a save seed: three distinct Elements of the four, drawn from the seed's own
 * `pz_observatory_1` stream (core/rng deriveSeed; a seeded Fisher–Yates shuffle), so one save always gets the same order
 * and different saves mostly different ones.
 */
export function observatoryOrder(seed: number): readonly ElementId[] {
  const rng = createRng(deriveSeed(seed, OBSERVATORY_PUZZLE_ID));
  const pool: ElementId[] = [...ELEMENT_IDS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const swap = pool[i] as ElementId;
    pool[i] = pool[j] as ElementId;
    pool[j] = swap;
  }
  return pool.slice(0, OBSERVATORY_STEPS);
}

/**
 * Starfall Observatory's `pz_observatory_1` (design "Starfall Observatory", task 9.8; Req 12.3, 13.5, 13.6) for a save
 * seed: a sequence over the great hall's four star pedestals. `order` is observatoryOrder(seed); `parts` are the
 * pedestals marked with those Elements in that order, then the fourth pedestal as the decoy. A pedestal takes any
 * Element, so a wrong Element or pedestal is a wrong step: the attempt resets (Req 13.5). 15 s from the first right
 * input (3 steps × 5 s, Req 13.6); solving it runs the ring lift.
 */
export function observatoryPuzzle(seed: number): PuzzleDef {
  const order = observatoryOrder(seed);
  const pedestal = (element: ElementId) => {
    const p = OBSERVATORY_PEDESTALS.find((x) => x.element === element);
    if (p === undefined) throw new Error(`observatoryPuzzle: no pedestal for ${element}`);
    return p;
  };
  const inOrder = order.map(pedestal);
  const decoys = OBSERVATORY_PEDESTALS.filter((p) => !order.includes(p.element));
  const id = OBSERVATORY_PUZZLE_ID as PuzzleId;
  return {
    id,
    name: '천장 별자리 받침대',
    region: 'azure',
    kind: 'sequence',
    parts: [...inOrder, ...decoys].map((p) => ({ ...partOn(id, p.id, 'elementPedestal', '별자리 받침대', p.pos), element: p.element })),
    order,
    timeLimitSec: minTimeLimit(OBSERVATORY_STEPS),
    hint: '천장 별자리가 빛나는 순서대로 받침대에 속성을 새기자.',
    reward: { opens: 'observatory_ring_lift', at: on(OBSERVATORY_DEVICES.liftPad) }, // the ring lift up to cp_observatory_1
  };
}

/** Every Puzzle_Mechanism of a save: PUZZLES and the seeded Observatory puzzle (what the Puzzle system places). */
export function puzzleDefsFor(seed: number): readonly PuzzleDef[] {
  return [...PUZZLES, observatoryPuzzle(seed)];
}
