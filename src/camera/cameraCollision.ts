// Collision view of the camera (design "카메라 충돌과 근접 페이드"): sphere casts and overlap tests
// against the terrain and colliders flagged blocksCamera (grass, leaves and small props have no such
// flag and never block the camera), plus terrain heights for the ground clearance. The camera core
// only sees this interface; createCameraCollision adapts a CollisionWorld.

import type { Vec3 } from '../core/types';
import { overlapSphere, sweepSphere } from '../physics/sphereQueries';
import type { CollisionQueries, Heightfield, QueryFilter } from '../physics/types';

export interface CameraCollision {
  /**
   * Distance the centre of a sphere of `radius` travels from `from` toward `to` before it touches
   * camera-blocking geometry; null when the whole path is clear.
   */
  sweep(from: Readonly<Vec3>, to: Readonly<Vec3>, radius: number): number | null;
  /** True when a sphere of `radius` centred at `center` overlaps camera-blocking geometry. */
  overlaps(center: Readonly<Vec3>, radius: number): boolean;
  /** Terrain height at (x, z). */
  groundHeight(x: number, z: number): number;
}

/** What the adapter needs from the world; a CollisionWorld satisfies it structurally. */
export type CameraCollisionWorld = Pick<CollisionQueries, 'sweepCapsule' | 'overlapCapsule'> & {
  readonly terrain: Pick<Heightfield, 'heightAt'>;
};

const CAMERA_MASK: QueryFilter = { mask: 'camera' };

/** Camera collision over `world`: the terrain plus colliders with flags.blocksCamera. */
export function createCameraCollision(world: CameraCollisionWorld): CameraCollision {
  return {
    sweep: (from, to, radius) => sweepSphere(world, from, to, radius, CAMERA_MASK)?.distance ?? null,
    overlaps: (center, radius) => overlapSphere(world, center, radius, CAMERA_MASK).length > 0,
    groundHeight: (x, z) => world.terrain.heightAt(x, z),
  };
}
