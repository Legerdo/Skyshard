/*
 * Side_Quest world objects and figures (design.md "Side_Quest", task 13.3; Req 15.1–15.5). The three Side_Quests use
 * existing places, an Enemy_Camp and ElementReceivers only:
 * - sq_tamsin 잃어버린 풍경: the kite caught on a blade tip of the Breezewatch windmill, on its top (vista_verdant,
 *   y 64), reached by the two cliff climbs and the spiral stair; then the glide back to the village (130 m) and Tamsin.
 * - sq_hobb 들판 가시 소탕: clearing the thorn nest Enemy_Camp `camp_verdant_1` (−170, 360) beyond Hobb's field.
 * - sq_durga 식어버린 용광로: lighting the three braziers round camp_durga with Ember, a Puzzle_Mechanism of kind
 *   `allOf` (any order, no time limit; `pz_ember_3`).
 * Quest-only objects exist only while their QuestDef does (`sideQuestPuzzles`, the kite in src/world/sideQuests.ts), so
 * dropping a Side_Quest (Req 15.5) leaves nothing of it in the world.
 *
 * Pure data and queries: no three.js, DOM or Math.random (src/data layering rule).
 */
import type { Vec3 } from '../core/types';
import type { QuestDef } from '../logic/quest/types';
import type { PuzzleId, SideQuestId } from './ids';
import { PART_SIZE, type PuzzleDef, type PuzzlePartDef } from './puzzles';
import { GLIDE_RATIO, LAYOUT_TRAVEL, LOCATIONS } from './worldLayout';

/** sq_tamsin's kite: its interact target id (kind 'questItem') and where it hangs on the windmill top. */
export const KITE_TARGET_ID = 'sq_tamsin_kite';
export const KITE_POS: Vec3 = {
  x: LOCATIONS.vista_verdant.x + 2.4, y: LOCATIONS.vista_verdant.groundY, z: LOCATIONS.vista_verdant.z - 2.4,
};
/** Interaction size of the kite (m). */
export const KITE_RADIUS = 0.5;
export const KITE_HEIGHT = 1.4;

/** sq_hobb's thorn nest (design POI table): the Enemy_Camp to clear. */
export const HOBB_NEST_CAMP = 'camp_verdant_1';
export const HOBB_NEST_POS = { x: -170, z: 360 } as const;

/** sq_durga's brazier puzzle: three braziers round camp_durga, lit with Ember in any order. */
export const DURGA_BRAZIERS_PUZZLE: PuzzleId = 'pz_ember_3';

const camp = { x: LOCATIONS.camp_durga.x, z: LOCATIONS.camp_durga.z };
const brazier = (name: string, dx: number, dz: number): PuzzlePartDef => ({
  id: `${DURGA_BRAZIERS_PUZZLE}_${name}`, device: 'brazier', name: '야영지 화로', pos: { x: camp.x + dx, z: camp.z + dz }, ...PART_SIZE.brazier,
});

export const DURGA_BRAZIERS: PuzzleDef = {
  id: DURGA_BRAZIERS_PUZZLE,
  name: '광부 야영지의 화로',
  region: 'ember',
  kind: 'allOf',
  // North-west, north-east and south of the camp, off the paths into and out of it.
  parts: [brazier('brazier_nw', -8, -7), brazier('brazier_ne', 8, -9), brazier('brazier_s', -3, 11)],
  hint: '야영지 둘레 화로 세 개에 모두 Ember 불꽃을 붙여 보자.',
  reward: {}, // the quest's hand-in rewards the player (sq_durga onComplete)
};

/** The Puzzle_Mechanisms that belong to Side_Quests, by quest. */
export const SIDE_QUEST_PUZZLES: Readonly<Partial<Record<SideQuestId, readonly PuzzleDef[]>>> = {
  sq_durga: [DURGA_BRAZIERS],
};

/** The Side_Quest puzzles of the quests defined in `quests` (none of a dropped Side_Quest). */
export function sideQuestPuzzles(quests: readonly QuestDef[]): PuzzleDef[] {
  return quests.flatMap((q) => (q.id === 'main' ? [] : (SIDE_QUEST_PUZZLES[q.id] ?? [])));
}

/**
 * sq_tamsin's glide home from the windmill top (y 64) to the plaza (y 18), design "sq_tamsin 귀환 활강": 130 m
 * horizontally at glide ratio 3.6 needs ≈ 36 m of the 46 m drop and ≈ 14.4 s of the 16.7 s base Stamina lasts.
 */
export function tamsinReturnGlide(): { horizontal: number; dropNeeded: number; dropAvailable: number; seconds: number; staminaSeconds: number } {
  const from = LOCATIONS.vista_verdant;
  const to = LOCATIONS.thistlewick;
  const horizontal = Math.hypot(to.x - from.x, to.z - from.z);
  return {
    horizontal,
    dropNeeded: horizontal / GLIDE_RATIO,
    dropAvailable: from.groundY - to.groundY,
    seconds: horizontal / LAYOUT_TRAVEL.glideSpeed,
    staminaSeconds: LAYOUT_TRAVEL.baseStamina / LAYOUT_TRAVEL.glideStaminaPerSecond,
  };
}
