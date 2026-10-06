// World bounds for recovery (design "Safe_Position과 복구"; Req 20.5, 20.7, 2.5). A body whose feet are
// BELOW_TERRAIN_LIMIT or more under the terrain surface, or farther than OUT_OF_BOUNDS_RADIUS from the
// origin horizontally, has left the world. The ring between PLAY_RADIUS (470 m) and OUT_OF_BOUNDS_RADIUS
// is a buffer: the terrain there is not walkable, so no Safe_Position is recorded in it, but nothing is
// sent back until the body passes 490 m. The player's RecoverySystem, enemies (task 7.5) and the
// RestorableObject registry share this rule. Pure TypeScript: no three.js / DOM.
//
// There is no exception zone for "below the terrain": the heightfield has no overhangs and every playable
// space (the Hollowroot sinkhole included) lies above it (design "지형 생성").

import { copyV3, isFiniteV3 } from '../core/math';
import type { Vec3 } from '../core/types';
import type { Heightfield } from '../physics/types';

/** Feet this far or farther under the terrain surface are below the world (m, Req 20.5). */
export const BELOW_TERRAIN_LIMIT = 2;

/** Past this horizontal distance from the origin a body is outside the world (m, Req 20.5). */
export const OUT_OF_BOUNDS_RADIUS = 490;

export type OutOfWorldReason = 'belowTerrain' | 'outOfBounds';

/**
 * Why `pos` (feet or base) is out of the world, or null when it is inside: 'outOfBounds' past
 * OUT_OF_BOUNDS_RADIUS horizontally at any height (checked first), 'belowTerrain' at or under
 * heightAt(x, z) − BELOW_TERRAIN_LIMIT. A non-finite position is nowhere in the world and counts as
 * 'outOfBounds'; a non-finite terrain height says nothing about the body and is ignored.
 */
export function outOfWorldReason(terrain: Pick<Heightfield, 'heightAt'>, pos: Readonly<Vec3>): OutOfWorldReason | null {
  if (!isFiniteV3(pos)) return 'outOfBounds';
  if (pos.x * pos.x + pos.z * pos.z > OUT_OF_BOUNDS_RADIUS * OUT_OF_BOUNDS_RADIUS) return 'outOfBounds';
  const ground = terrain.heightAt(pos.x, pos.z);
  if (Number.isFinite(ground) && pos.y <= ground - BELOW_TERRAIN_LIMIT) return 'belowTerrain';
  return null;
}

/**
 * Enemy reset rule (Req 20.7): an enemy out of the world goes back to its spawn position. Returns a copy
 * of `spawn` when `pos` is out of the world (outOfWorldReason), else null. The enemy system (task 7.5)
 * calls this for awake enemies after CollisionResolve and also returns the reset enemy's AI to idle.
 */
export function enemyRecoveryPosition(
  terrain: Pick<Heightfield, 'heightAt'>,
  pos: Readonly<Vec3>,
  spawn: Readonly<Vec3>,
): Vec3 | null {
  return outOfWorldReason(terrain, pos) === null ? null : copyV3(spawn);
}
