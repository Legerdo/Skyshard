/*
 * Resonance_Altar and Starlit_Stair (design.md "진행 게이트", World Layout "메인 경로"; Req 5.2–5.6).
 *
 * The altar stands at the crater centre (0, 4, 0): a low round dais the character can step onto
 * (0.4 m < the 0.45 m step-up) around a central plinth the Skyshards are offered to. From Skyshard 3
 * a light pillar rises from it, visible across the world (Req 5.3).
 *
 * Once the altar is activated and seal_sanctum is lifted, the Starlit_Stair appears (Req 5.5): three
 * tiers of floating platforms joined by two starlit Updrafts, from starlit_stair_start (20, −10) on the
 * crater floor to the Sanctum gate (0, −40, y 175):
 *   tier 1  steps rising 1 m at a time (jumps of ≤ 1.3 m gaps) to landing L1 (y 13),
 *   Updraft U1  beside L1, rising to y 96; glide a few metres to landing L2 (y 90),
 *   tier 2  steps west to landing L3 (y 93),
 *   Updraft U2  beside L3, rising to y 179; glide onto landing L4 (y 175),
 *   tier 3  level walkway south to the Sanctum gate.
 * Each Updraft ride plus its glide stays within the base Stamina (Req 2.3), and the landings between
 * them let Stamina refill. Tests check the gaps, rises and glide reach against the movement numbers.
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import type { Vec3 } from '../core/types';
import type { UpdraftVolumeDef } from './volumes';
import { LOCATIONS } from './worldLayout';

/** Interaction target id of the altar (also the quest `interact` target, src/quest/questSystem.ts). */
export const RESONANCE_ALTAR_ID = 'resonance_altar';

export const RESONANCE_ALTAR = {
  id: RESONANCE_ALTAR_ID,
  name: 'Resonance Altar',
  /** Centre of the dais on the crater floor pad. */
  pos: { x: LOCATIONS.resonance_altar.x, y: LOCATIONS.resonance_altar.groundY, z: LOCATIONS.resonance_altar.z },
  daisRadius: 3.2,
  daisHeight: 0.4,
  plinthRadius: 0.8,
  plinthHeight: 1.4,
  /** Light pillar from Skyshard 3 (Req 5.3). */
  pillarRadius: 1.6,
  pillarHeight: 420,
} as const satisfies {
  id: string;
  name: string;
  pos: Vec3;
  daisRadius: number;
  daisHeight: number;
  plinthRadius: number;
  plinthHeight: number;
  pillarRadius: number;
  pillarHeight: number;
};

/** A floating platform: a slab `thickness` deep whose walkable top is at `topY`. */
export interface StairPlatformDef {
  readonly x: number;
  readonly z: number;
  readonly topY: number;
  /** Half extents in x and z. */
  readonly halfX: number;
  readonly halfZ: number;
  /** 1–3. */
  readonly tier: 1 | 2 | 3;
}

export interface StarlitStairDef {
  /** In climbing order. */
  readonly platforms: readonly StairPlatformDef[];
  readonly updrafts: readonly UpdraftVolumeDef[];
  /** Slab thickness of every platform (m). */
  readonly thickness: number;
}

const STEP = 1.6;
const LANDING = 3;

const step = (tier: 1 | 2 | 3, x: number, z: number, topY: number, halfX = STEP, halfZ = STEP): StairPlatformDef => ({ x, z, topY, halfX, halfZ, tier });

/** Crater floor under the Updrafts (their base), about y 4. */
const CRATER_FLOOR_Y = 4;

export const STARLIT_STAIR: StarlitStairDef = {
  platforms: [
    // Tier 1: north from the stair start (20, −10, y 8).
    step(1, 20, -15, 9),
    step(1, 20, -19.5, 10),
    step(1, 20, -24, 11),
    step(1, 20, -28.5, 12),
    step(1, 20, -34, 13, LANDING, LANDING), // L1, U1 to its north
    // Tier 2: after U1, west along z −57.
    step(2, 20, -57, 90, LANDING, LANDING), // L2
    step(2, 14.2, -57, 91),
    step(2, 9.7, -57, 92),
    step(2, 4.2, -57, 93, LANDING, LANDING), // L3, U2 to its north
    // Tier 3: after U2, a level walkway south to the Sanctum gate (0, −40, y 175).
    step(3, 2, -57.5, 175, LANDING, 2.5), // L4
    step(3, 1, -52, 175, 2.5, 2.5),
    step(3, 0, -46.5, 175, 2.5, 2.5),
  ],
  updrafts: [
    { kind: 'updraft', id: 'updraft_starlit_1', shape: { kind: 'cylinder', x: 20, z: -42, radius: 4, minY: CRATER_FLOOR_Y, maxY: 96 } },
    { kind: 'updraft', id: 'updraft_starlit_2', shape: { kind: 'cylinder', x: 4.2, z: -65, radius: 4, minY: 88, maxY: 179 } },
  ],
  thickness: 0.6,
};
