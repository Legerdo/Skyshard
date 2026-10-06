// Enemy terrain probes (design "지형 탐지와 이동"; Req 28.8): samples one probe point 1.5 m ahead of an enemy's feet
// against the terrain, the ground an enemy would stand on there and the collision world, and applies the blocking
// rules of logic/aiSteering (ground more than 2.5 m below the feet, a slope over 50°, water deeper than 1 m, outside
// the play boundary, or a solid hit by a waist-height ray within the probe distance).

import { DEG2RAD } from '../core/math';
import type { Vec3 } from '../core/types';
import { PLAY_RADIUS } from '../data/worldLayout';
import { PROBE_DISTANCE, WAIST_HEIGHT_FRACTION, probeBlocked, type Planar } from '../logic/aiSteering';
import { MAX_WALKABLE_SLOPE_DEG, type CollisionQueries } from '../physics/types';

/**
 * Terrain queries the enemies use; a TerrainField satisfies it. Only `heightAt` is required: without `slopeDeg` or
 * `waterDepthAt` those rules never block, and without `insideBoundary` the boundary is the PLAY_RADIUS disc.
 */
export interface EnemyTerrain {
  heightAt(x: number, z: number): number;
  slopeDeg?(x: number, z: number): number;
  waterDepthAt?(x: number, z: number): number;
  insideBoundary?(x: number, z: number): boolean;
}

/** What a probe reads. */
export interface ProbeEnv {
  readonly terrain: EnemyTerrain;
  /** Height of the ground an enemy at `p` would stand on (terrain or a walkable collider top). */
  ground(p: Readonly<Vec3>): number;
  /** Solid obstacles for the waist ray; null: none are checked. */
  readonly world: Pick<CollisionQueries, 'raycast'> | null;
}

/** Ground within this of the terrain height is the terrain itself (m); higher ground is a collider top. */
const ON_TERRAIN_EPS = 0.05;
/** A ray hit on terrain this steep or steeper (normal.y below) is an obstacle; gentler terrain is the slope rule's. */
const COS_MAX_WALKABLE = Math.cos(MAX_WALKABLE_SLOPE_DEG * DEG2RAD);

/**
 * Whether the probe point PROBE_DISTANCE along `dir` (need not be unit) from `feet` is blocked for a body `height`
 * tall. Slope and water are read only where the ground there is the terrain (a bridge or platform top over deep
 * water is walkable); the waist ray is cast last, only when nothing else blocks.
 */
export function probeBlockedAt(env: ProbeEnv, feet: Readonly<Vec3>, height: number, dir: Planar): boolean {
  const len = Math.hypot(dir.x, dir.z);
  if (!(len > 0)) return false;
  const ux = dir.x / len;
  const uz = dir.z / len;
  const x = feet.x + ux * PROBE_DISTANCE;
  const z = feet.z + uz * PROBE_DISTANCE;
  const { terrain } = env;
  const ground = env.ground({ x, y: feet.y, z });
  const onTerrain = !(ground > terrain.heightAt(x, z) + ON_TERRAIN_EPS);
  const sample = {
    drop: feet.y - ground,
    slopeDeg: onTerrain ? terrain.slopeDeg?.(x, z) ?? 0 : 0,
    waterDepth: onTerrain ? terrain.waterDepthAt?.(x, z) ?? 0 : 0,
    inside: terrain.insideBoundary?.(x, z) ?? x * x + z * z <= PLAY_RADIUS * PLAY_RADIUS,
    obstacle: false,
  };
  if (probeBlocked(sample)) return true;
  return waistObstacle(env.world, feet, height, ux, uz);
}

/** A solid collider, or terrain steeper than walkable, hit by the waist ray within PROBE_DISTANCE. */
function waistObstacle(
  world: Pick<CollisionQueries, 'raycast'> | null,
  feet: Readonly<Vec3>,
  height: number,
  ux: number,
  uz: number,
): boolean {
  if (world === null) return false;
  const origin = { x: feet.x, y: feet.y + height * WAIST_HEIGHT_FRACTION, z: feet.z };
  const hit = world.raycast(origin, { x: ux, y: 0, z: uz }, PROBE_DISTANCE, { mask: 'solid' });
  return hit !== null && (hit.colliderId !== null || hit.normal.y < COS_MAX_WALKABLE);
}
