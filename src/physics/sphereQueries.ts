// Sphere queries built on the capsule queries: a capsule of height ≤ 2r is a sphere centred r above
// its feet (./types.ts), so these helpers only convert between sphere centres and capsule feet.
// Used by the camera's 0.25 m collision cast (design "카메라 충돌과 근접 페이드") and available to
// swept-sphere projectiles. Pure TypeScript: imports only src/core and src/physics.

import type { Vec3 } from '../core/types';
import type { CollisionQueries, Contact, QueryFilter } from './types';

/** First contact of a sphere swept from centre `from` to centre `to`. */
export interface SphereSweepHit {
  /** Fraction of the move completed at contact, in [0, 1]. */
  t: number;
  /** Distance the centre moved before contact (m): t · |to − from|. */
  distance: number;
  /** Sphere centre at contact: from + (to − from) · t. */
  center: Vec3;
  /** Contact point on the surface that was hit. */
  point: Vec3;
  /** Outward unit normal of that surface. */
  normal: Vec3;
  /** null when the terrain was hit. */
  colliderId: number | null;
  dynamic: boolean;
}

const feetOf = (center: Readonly<Vec3>, r: number): Vec3 => ({ x: center.x, y: center.y - r, z: center.z });

/**
 * Sweeps a sphere of `radius` from centre `from` to centre `to` against the terrain and the colliders
 * `f` selects (sweepCapsule with height 0). Start contact follows sweepCapsule: a sphere that starts
 * touching or overlapping is blocked only when it moves deeper. Non-finite input follows the world's
 * NaN policy (its last valid sweep result), so callers should pass finite values.
 */
export function sweepSphere(
  q: Pick<CollisionQueries, 'sweepCapsule'>,
  from: Readonly<Vec3>,
  to: Readonly<Vec3>,
  radius: number,
  f?: QueryFilter,
): SphereSweepHit | null {
  const hit = q.sweepCapsule(feetOf(from, radius), feetOf(to, radius), radius, 0, f);
  if (hit === null) return null;
  const { t, distance, position, point, normal, colliderId, dynamic } = hit;
  return { t, distance, center: { x: position.x, y: position.y + radius, z: position.z }, point, normal, colliderId, dynamic };
}

/**
 * Penetrations of a sphere of `radius` centred at `center` (overlapCapsule with height 0), deepest
 * first. As in overlapCapsule, oneWay colliders never report an overlap.
 */
export function overlapSphere(
  q: Pick<CollisionQueries, 'overlapCapsule'>,
  center: Readonly<Vec3>,
  radius: number,
  f?: QueryFilter,
): Contact[] {
  return q.overlapCapsule(feetOf(center, radius), radius, 0, f);
}
