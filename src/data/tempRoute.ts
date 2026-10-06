/*
 * TEMPORARY movement aids of the minimal full route (task 4.9, design "구현 마일스톤" M2). The current
 * Player_Controller only walks, runs, sprints, jumps and dodges; climbing (task 9.1), gliding, Updrafts and
 * Wind_Zones (task 9.3), the Challenge_Area structures (tasks 9.6–9.8) and the windmill art do not exist yet.
 * Every main-path leg that needs one of them gets a stand-in here, so the route can be played on foot without
 * changing any quest data:
 * - `TEMP_PIECES`: simple solid pieces where the design has a structure: the Breezewatch windmill tower and
 *   its top (vista_verdant, y 64) and a plank over the Broken Bridge chasm. (Hollowroot, Cinderspire and the
 *   Starfall Observatory are real Challenge_Areas since tasks 9.6–9.8, src/data/challengeAreas.ts; the Astral
 *   Sanctum's gate, connecting hall and Caelith arena are src/data/sanctum.ts since task 10.2.)
 * - `TEMP_LIFTS`: interaction pads that fade the character to another spot, standing in for a climb, a glide
 *   or an Updraft ride of the design's main path (MAIN_PATH `climb` / `glide` / `starlitStair` legs).
 * Heights given as 'ground' are read from the terrain when the pieces are built. Every id here is
 * referenced only by src/world/tempRoute.ts and its view; tasks 9.x delete this file with them.
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import { yawFromDir } from '../core/math';
import type { Vec3 } from '../core/types';
import { LOCATIONS } from './worldLayout';

/** A point whose height is either given or the terrain height at (x, z). */
export interface PointRef {
  readonly x: number;
  readonly z: number;
  readonly y: number | 'ground';
}

/** A standing spot: feet point and facing (rad, core/math yaw). */
export interface SpotRef extends PointRef {
  readonly yaw: number;
}

export type TempShape =
  | { readonly kind: 'box'; readonly min: Vec3; readonly max: Vec3 }
  | { readonly kind: 'obb'; readonly center: Vec3; readonly half: Vec3; readonly yaw: number }
  | { readonly kind: 'cylinder'; readonly base: Vec3; readonly radius: number; readonly height: number };

/** How a piece is drawn (and its surface material). */
export type TempLook = 'wood' | 'stone' | 'crystal' | 'starlight';

export interface TempPieceDef {
  readonly id: string;
  readonly shape: TempShape;
  /** Standable top (platforms, steps, floors); false for towers, spires and rims. */
  readonly walkableTop: boolean;
  readonly look: TempLook;
}

/** When a lift pad is offered. */
export type TempLiftCondition =
  | { readonly kind: 'always' }
  /** While the Starlit_Stair exists (after the altar activation). */
  | { readonly kind: 'stairActive' }
  /** Once the puzzle is recorded as solved in GameState (world.puzzles). */
  | { readonly kind: 'puzzleSolved'; readonly puzzleId: string };

export interface TempLiftDef {
  readonly id: string;
  /** Prompt name (Korean; proper nouns stay English). */
  readonly name: string;
  /** What the lift stands in for; the view colours the pad by it. */
  readonly stands: 'climb' | 'glide' | 'updraft';
  /** Centre of the pad on the floor. */
  readonly pad: PointRef;
  /** Where the character is put after the fade. */
  readonly to: SpotRef;
  readonly when: TempLiftCondition;
}

/** Radius of a lift pad (interaction target surface and drawn disc, m). */
export const TEMP_LIFT_PAD_RADIUS = 0.9;

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const box = (id: string, look: TempLook, min: Vec3, max: Vec3, walkableTop = true): TempPieceDef => ({
  id, look, walkableTop, shape: { kind: 'box', min, max },
});
const cylinder = (id: string, look: TempLook, base: Vec3, radius: number, height: number, walkableTop: boolean): TempPieceDef => ({
  id, look, walkableTop, shape: { kind: 'cylinder', base, radius, height },
});
const ALWAYS: TempLiftCondition = { kind: 'always' };
const facing = (dx: number, dz: number): number => yawFromDir(dx, dz);

/** Slab thickness of the platforms and floors (m). */
const SLAB = 0.6;

// ── Breezewatch windmill (climb, then the glide to the Elderbough) ───────────

const BREEZEWATCH_TOP_Y = LOCATIONS.vista_verdant.groundY; // 64
const BW = { x: LOCATIONS.breezewatch.x, z: LOCATIONS.breezewatch.z }; // (−130, 250), foot y 22

// ── Broken Bridge plank over the chasm (the Updraft crossing) ────────────────

const BRIDGE = LOCATIONS.broken_bridge;
const CAMP = LOCATIONS.camp_durga;
const BRIDGE_LEN = Math.hypot(CAMP.x - BRIDGE.x, CAMP.z - BRIDGE.z);
const BRIDGE_DIR = { x: (CAMP.x - BRIDGE.x) / BRIDGE_LEN, z: (CAMP.z - BRIDGE.z) / BRIDGE_LEN };
/** From 4 m past the bridge pad centre to 46 m: over the 30 m chasm (9–39 m) with footing at both ends. */
const PLANK_FROM = 4;
const PLANK_TO = 46;
const PLANK_MID = (PLANK_FROM + PLANK_TO) / 2;

/** Top of the Sanctum gate slab (src/data/sanctum.ts), where the second starlit Updraft's lift arrives. */
const GATE_Y = LOCATIONS.sanctum_gate.groundY; // 175

export const TEMP_PIECES: readonly TempPieceDef[] = [
  // Breezewatch windmill: tower from the cliff foot and the top platform (vista_verdant area r 5).
  cylinder('bw_tower', 'stone', v(BW.x, 18, BW.z), 1.6, BREEZEWATCH_TOP_Y - SLAB - 18, false),
  box('bw_top', 'wood', v(BW.x - 3, BREEZEWATCH_TOP_Y - SLAB, BW.z - 3), v(BW.x + 3, BREEZEWATCH_TOP_Y, BW.z + 3)),

  // Broken Bridge: a plank at the bridge pad height (y 12) across the chasm toward camp_durga.
  {
    id: 'bridge_plank',
    look: 'wood',
    walkableTop: true,
    shape: {
      kind: 'obb',
      center: v(BRIDGE.x + BRIDGE_DIR.x * PLANK_MID, BRIDGE.groundY - SLAB / 2, BRIDGE.z + BRIDGE_DIR.z * PLANK_MID),
      half: v(1.6, SLAB / 2, (PLANK_TO - PLANK_FROM) / 2),
      yaw: facing(BRIDGE_DIR.x, BRIDGE_DIR.z),
    },
  },
];

export const TEMP_LIFTS: readonly TempLiftDef[] = [
  // ms2: Breezewatch cliffs and spiral stair (climb), then the glide from the windmill top to the Elderbough.
  { id: 'lift_breezewatch', name: 'Breezewatch 풍차 오르기', stands: 'climb', pad: { x: BW.x + 3.8, z: BW.z, y: 'ground' },
    to: { x: BW.x - 2, z: BW.z, y: BREEZEWATCH_TOP_Y, yaw: facing(1, 0) }, when: ALWAYS },
  { id: 'glide_breezewatch', name: 'Elderbough로 활강', stands: 'glide', pad: { x: BW.x - 1.8, z: BW.z + 2.2, y: BREEZEWATCH_TOP_Y },
    to: { x: -228, z: 160, y: 'ground', yaw: facing(0, -1) }, when: ALWAYS },

  // ms6–ms7: the Wind_Zone glide from camp_oriel to the ridge and the climbs up to the Observatory's plateau (its
  // cliff Updraft arrives with the Azure content). The Observatory itself and its exit glide from the dome balcony are
  // the real Challenge_Area since task 9.8 (src/data/challengeAreas.ts).
  { id: 'glide_oriel', name: '강풍을 타고 능선으로 활강', stands: 'glide', pad: { x: 47, z: -225, y: 'ground' },
    to: { x: 110, z: -318, y: 'ground', yaw: facing(0.3, -1) }, when: ALWAYS },
  // The rock band between the glide landing (y ≈ 115) and the ridge shelf (y ≈ 120) is too steep to walk.
  { id: 'lift_azure_ridge', name: '능선 오르기', stands: 'climb', pad: { x: 112.5, z: -321.5, y: 'ground' },
    to: { x: 117, z: -337, y: 'ground', yaw: facing(0.5, -1) }, when: ALWAYS },
  { id: 'lift_observatory_cliff', name: '관측소 절벽 오르기', stands: 'climb', pad: { x: 121, z: -357, y: 'ground' },
    to: { x: 137, z: -360, y: 'ground', yaw: facing(0, -1) }, when: ALWAYS },

  // ms8: the two starlit Updrafts of the Starlit_Stair (L1 → L2, L3 → L4), offered while the stair exists.
  { id: 'lift_stair_1', name: '별빛 상승 기류', stands: 'updraft', pad: { x: 20, z: -36, y: 13 },
    to: { x: 21, z: -57, y: 90, yaw: facing(-1, 0) }, when: { kind: 'stairActive' } },
  { id: 'lift_stair_2', name: '별빛 상승 기류', stands: 'updraft', pad: { x: 3.5, z: -59.2, y: 93 },
    to: { x: 2, z: -56.5, y: GATE_Y, yaw: facing(0, 1) }, when: { kind: 'stairActive' } },
];
