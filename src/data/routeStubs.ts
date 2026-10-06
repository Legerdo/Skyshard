/*
 * TEMPORARY stand-ins for the systems the minimal full route (task 4.9, M2) reaches before they exist. Each
 * publishes the same trigger id as the Main_Quest data (src/data/quests.ts), so the later systems replace
 * these entries without any quest data change:
 * - The NPC talk stubs were replaced by the NPC placement (src/data/village.ts NPC_PLACEMENTS) and the
 *   Dialogue_System (tasks 13.1, 13.2).
 * - The Challenge_Area puzzles are all real Puzzle_Mechanisms (src/data/puzzles.ts, tasks 9.6–9.8); the puzzle stubs
 *   are gone.
 * - `SKYSHARD_PEDESTALS`: the Skyshard in each Challenge_Area's final room (Req 4.1), offered once the room's
 *   guardian is down (its `skyshard` Objective is current). Hollowroot's stands in its R6 Skyshard room, Cinderspire's
 *   in the crystal cage on the summit, the Observatory's in the star cage on the dome.
 * - The Bramblekin groups for every `defeat` group id are encounter groups in src/data/spawns.ts (task 7.8).
 * - The Sanctum mural (`interact sanctum_mural`, Req 5.7) is part of the connecting hall, src/data/sanctum.ts.
 * Heights stand on the Challenge_Areas' floors.
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import { CINDERSPIRE, HOLLOWROOT, OBSERVATORY } from './challengeAreas';
import type { PointRef } from './tempRoute';
import type { ChallengeAreaId, RegionId } from './ids';

export interface SkyshardPedestalDef {
  readonly index: 1 | 2 | 3;
  readonly area: ChallengeAreaId;
  readonly region: RegionId;
  readonly pos: PointRef;
}

/** The Challenge_Areas' pedestals (src/data/challengeAreas.ts): Hollowroot R6, the Cinderspire summit, the dome. */
const pedestalAt = (p: { readonly x: number; readonly y: number; readonly z: number }): PointRef => ({ x: p.x, z: p.z, y: p.y });

export const SKYSHARD_PEDESTALS: readonly SkyshardPedestalDef[] = [
  // Hollowroot R6, behind the Rootbound Warden's door.
  { index: 1, area: 'hollowroot', region: 'verdant', pos: pedestalAt(HOLLOWROOT.skyshard.pos) },
  // Cinderspire summit, in the crystal cage that opens with Cinder Alpha's defeat.
  { index: 2, area: 'cinderspire', region: 'ember', pos: pedestalAt(CINDERSPIRE.skyshard.pos) },
  // Observatory dome, in the star cage beside the telescope that opens with Sentinel Prime's defeat.
  { index: 3, area: 'observatory', region: 'azure', pos: pedestalAt(OBSERVATORY.skyshard.pos) },
];

/** Interaction target id of Skyshard `index`'s pedestal. */
export const skyshardTargetId = (index: 1 | 2 | 3): string => `skyshard_${index}`;
