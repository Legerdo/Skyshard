// Climbing geometry for the pure player controller (design "Player Controller" → "등반"; Req 18.2, 18.5,
// 18.9, 18.10). stepController runs the climb modes on these queries: the wall is followed with one
// closestSurface query per tick (the chest point is re-seated CLIMB_SURFACE_OFFSET out along the nearest
// point's normal, so curved surfaces and convex corners need no special path), a short tangent sweep of a
// chest sphere turns onto the adjacent face of a concave corner, and the mantle looks for a walkable top
// past the wall. Pure TypeScript: imports only src/core, src/physics and this folder (no three.js / DOM /
// Math.random), and nothing here mutates its arguments.
//
// Climbable surfaces are those the 'climb' query mask keeps: colliders flagged climbable and the terrain.
// Non-climbable colliders (Blight crystal walls and veils, the Sanctum seal, a hot Heat_Crystal) block like
// any solid but are never attached to or followed.

import { addScaled, clamp, copyV3, cross, dirFromYaw, dot, isFiniteV3, length, lengthSq, normalize, scale } from '../../core/math';
import type { Vec3 } from '../../core/types';
import type { CollisionQueries, QueryFilter, RayHit, SurfaceHit, SweepHit } from '../../physics/types';
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  CLIMB_CHEST_HEIGHT,
  CLIMB_HEAD_HEIGHT,
  CLIMB_MIN_OBJECT_HEIGHT,
  CLIMB_SURFACE_OFFSET,
  CLIMB_SURFACE_RADIUS,
  MANTLE_REACH,
  SKIN_WIDTH,
} from './constants';
import { classifySlope } from './moveAndSlide';

/** Query filter of every climbable-surface query. */
export const CLIMB_FILTER: Readonly<QueryFilter> = Object.freeze({ mask: 'climb' });

/** Two queries report the same contact when their distances differ by at most this (m). */
const SAME_HIT_EPS = 1e-6;
/** Horizontal normal parts shorter than this give no wall direction. */
const HORIZONTAL_EPS = 1e-3;
/** Tangent moves shorter than this (m) are no move. */
const MIN_MOVE = 1e-9;
/** Sweep-and-slide passes of the chest sphere per tick. */
const SWEEP_PASSES = 2;
/**
 * Mantle tuning (implementation choices): the top is probed at these distances past the wall contact
 * (the first where the capsule fits wins, all within MANTLE_REACH), from this far above the head height,
 * and the capsule is tested for fit this far above the found top.
 */
const MANTLE_INSETS: readonly number[] = [CAPSULE_RADIUS + 0.1, 0.85, MANTLE_REACH];
const MANTLE_PROBE_CLEARANCE = 0.15;
const MANTLE_FIT_LIFT = 0.02;
const MANTLE_FIT_TOLERANCE = 5e-3;
/** Push-out passes and the shallowest penetration they still fix (m). */
const DEPENETRATE_PASSES = 4;
const DEPENETRATE_MIN_DEPTH = 1e-4;

const WORLD_UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });

/** Chest point of a capsule whose feet are at `feet`. */
export function chestPoint(feet: Readonly<Vec3>): Vec3 {
  return { x: feet.x, y: feet.y + CLIMB_CHEST_HEIGHT, z: feet.z };
}

/** Feet of a capsule whose chest point is at `chest`. */
export function feetFromChest(chest: Readonly<Vec3>): Vec3 {
  return { x: chest.x, y: chest.y - CLIMB_CHEST_HEIGHT, z: chest.z };
}

/** Horizontal unit direction into the surface with outward normal `n`; null for a (nearly) horizontal surface. */
export function intoWall(n: Readonly<Vec3>): Vec3 | null {
  const h = Math.hypot(n.x, n.z);
  return h > HORIZONTAL_EPS ? { x: -n.x / h, y: 0, z: -n.z / h } : null;
}

/** A surface a climb may attach to: 65° or steeper, overhangs included (Req 16.6, 18.2). */
export function isWallNormal(n: Readonly<Vec3>): boolean {
  return classifySlope(n, true) === 'climbCandidate';
}

/** Nearest climbable surface within CLIMB_SURFACE_RADIUS of the chest point (design: closestSurface(chestPoint, 0.9, climbable)). */
export function nearestClimbSurface(world: CollisionQueries, chest: Readonly<Vec3>): SurfaceHit | null {
  return world.closestSurface(copyV3(chest), CLIMB_SURFACE_RADIUS, CLIMB_FILTER);
}

/**
 * First solid surface along the ray when it is climbable (the same contact under the 'climb' mask),
 * else null: a non-climbable collider in front hides a climbable one behind it.
 */
export function climbableRay(world: CollisionQueries, origin: Readonly<Vec3>, dir: Readonly<Vec3>, maxDist: number): RayHit | null {
  const solid = world.raycast(copyV3(origin), copyV3(dir), maxDist);
  if (solid === null) return null;
  const climb = world.raycast(copyV3(origin), copyV3(dir), maxDist, CLIMB_FILTER);
  return climb !== null && climb.colliderId === solid.colliderId && Math.abs(climb.distance - solid.distance) <= SAME_HIT_EPS ? solid : null;
}

/**
 * Attach check (Req 18.2, 18.9): the climbable wall a character at `feet` touches along `contactNormal`
 * (a steep contact of its last move). A ray toward the wall from CLIMB_MIN_OBJECT_HEIGHT above the feet
 * must reach a climbable ≥ 65° surface first, so objects lower than 1 m and non-climbable walls in front
 * are never climbed; returns the nearest climbable surface of the chest point to attach to, or null.
 */
export function wallToAttach(world: CollisionQueries, feet: Readonly<Vec3>, contactNormal: Readonly<Vec3>): SurfaceHit | null {
  if (!isWallNormal(contactNormal)) return null;
  const into = intoWall(contactNormal);
  if (into === null) return null;
  const grip: Vec3 = { x: feet.x, y: feet.y + CLIMB_MIN_OBJECT_HEIGHT, z: feet.z };
  const ray = climbableRay(world, grip, into, CLIMB_SURFACE_RADIUS);
  if (ray === null || !isWallNormal(ray.normal)) return null;
  const surface = nearestClimbSurface(world, chestPoint(feet));
  return surface !== null && isWallNormal(surface.normal) ? surface : null;
}

/** Up and right tangents of the surface with outward normal `n` (design: up = world up on the plane, right = up × n). */
export interface ClimbBasis {
  up: Vec3;
  right: Vec3;
  /** Horizontal unit direction toward the wall (the facing), the input reference for "up". */
  forward: Vec3;
}

/**
 * Tangent basis of the climbed surface. `up` is world up projected onto the plane; on a (nearly) horizontal
 * surface, where that vanishes, the facing `yaw` projected onto the plane is used instead.
 */
export function climbBasis(n: Readonly<Vec3>, yaw: number): ClimbBasis {
  const forward = intoWall(n) ?? dirFromYaw(yaw);
  let up = normalize(addScaled(WORLD_UP, n, -n.y));
  if (lengthSq(up) < 0.5) up = normalize(addScaled(forward, n, -dot(forward, n)));
  return { up, right: cross(up, n), forward };
}

/**
 * World-space climb direction (unit) for the camera-relative world move `dir` (Req 18.3): its part toward
 * the wall climbs up, away from it down, and its sideways part moves right or left. Null without input.
 */
export function climbMoveDir(dir: { x: number; z: number } | null, basis: Readonly<ClimbBasis>): Vec3 | null {
  if (dir === null) return null;
  const f = basis.forward;
  const upAmount = dir.x * f.x + dir.z * f.z;
  const rightAmount = dir.x * -f.z + dir.z * f.x; // the facing's right (facing +Z → −X)
  const m = normalize(addScaled(scale(basis.up, upAmount), basis.right, rightAmount));
  return lengthSq(m) > 0.5 ? m : null;
}

/** `v` without its component along the unit `axis` when that component is positive. */
export function withoutPositive(v: Readonly<Vec3>, axis: Readonly<Vec3>): Vec3 {
  const d = dot(v, axis);
  return d > 0 ? addScaled(v, axis, -d) : copyV3(v);
}

/** Rotates the unit vector `from` toward the unit vector `to` by at most `maxAngle` rad (great-circle). */
export function turnNormal(from: Readonly<Vec3>, to: Readonly<Vec3>, maxAngle: number): Vec3 {
  const angle = Math.acos(clamp(dot(from, to), -1, 1));
  if (!(angle > maxAngle)) return copyV3(to);
  const s = Math.sin(angle);
  if (s < 1e-6) {
    // Opposite normals: turn about any axis perpendicular to `from`.
    let axis = cross(from, WORLD_UP);
    if (lengthSq(axis) < 1e-6) axis = cross(from, { x: 1, y: 0, z: 0 });
    axis = normalize(axis);
    return normalize(addScaled(scale(from, Math.cos(maxAngle)), cross(axis, from), Math.sin(maxAngle)));
  }
  const k = maxAngle / angle;
  return normalize(addScaled(scale(from, Math.sin((1 - k) * angle) / s), to, Math.sin(k * angle) / s));
}

export interface WallSweep {
  /** Chest point after the move. */
  chest: Vec3;
  /** Normal of a climbable face the move ran into (a concave corner's adjacent face), else null. */
  adopted: Vec3 | null;
}

/**
 * Moves the chest point by `delta` along the wall (design "오목 모서리"): a sphere of the capsule radius is
 * swept from the chest with CLIMB_SURFACE_OFFSET − radius of look-ahead, so it stops CLIMB_SURFACE_OFFSET
 * short of what it runs into and slides along it. A climbable ≥ 65° face hit this way is reported as
 * `adopted`, so the climb turns onto it; anything else only blocks.
 */
export function sweepAlongWall(world: CollisionQueries, chest: Readonly<Vec3>, delta: Readonly<Vec3>): WallSweep {
  const r = CAPSULE_RADIUS;
  const look = CLIMB_SURFACE_OFFSET - r;
  let p = copyV3(chest);
  let rest = copyV3(delta);
  let adopted: Vec3 | null = null;
  for (let pass = 0; pass < SWEEP_PASSES; pass++) {
    const len = length(rest);
    if (!(len > MIN_MOVE)) break;
    const dir = scale(rest, 1 / len);
    const from: Vec3 = { x: p.x, y: p.y - r, z: p.z }; // a capsule of height 2r is a sphere centred at from.y + r
    const to = addScaled(from, dir, len + look);
    const hit = world.sweepCapsule(from, to, r, 2 * r);
    if (hit === null) {
      p = addScaled(p, rest, 1);
      break;
    }
    const advance = clamp(hit.distance - look, 0, len);
    p = addScaled(p, dir, advance);
    if (adopted === null && isWallNormal(hit.normal) && isClimbableSweep(world, from, to, hit)) adopted = copyV3(hit.normal);
    const left = scale(dir, len - advance);
    const into = dot(left, hit.normal);
    rest = into < 0 ? addScaled(left, hit.normal, -into) : left;
    if (dot(rest, delta) <= 0) break;
  }
  return { chest: p, adopted };
}

/** The sweep's first contact is climbable: the same contact under the 'climb' mask. */
function isClimbableSweep(world: CollisionQueries, from: Readonly<Vec3>, to: Readonly<Vec3>, hit: Readonly<SweepHit>): boolean {
  const r = CAPSULE_RADIUS;
  const climb = world.sweepCapsule(copyV3(from), copyV3(to), r, 2 * r, CLIMB_FILTER);
  return climb !== null && climb.colliderId === hit.colliderId && Math.abs(climb.distance - hit.distance) <= SAME_HIT_EPS;
}

/** The head ray toward the wall along −n reaches nothing: the wall's top is below the head (Req 18.5). */
export function headClear(world: CollisionQueries, feet: Readonly<Vec3>, n: Readonly<Vec3>): boolean {
  const into = intoWall(n);
  if (into === null) return false;
  return world.raycast({ x: feet.x, y: feet.y + CLIMB_HEAD_HEIGHT, z: feet.z }, into, CLIMB_SURFACE_RADIUS) === null;
}

/**
 * Mantle target (Req 18.5, design "등정"): the head ray toward the wall (along −n) misses, the chest ray hits
 * it, and within MANTLE_REACH past the chest contact there is walkable ground higher than the chest (the
 * grip) and no higher than the head ray where the capsule fits. Returns the feet position on that ground,
 * else null.
 */
export function findMantleTarget(world: CollisionQueries, feet: Readonly<Vec3>, n: Readonly<Vec3>): Vec3 | null {
  const into = intoWall(n);
  if (into === null) return null;
  const chest = chestPoint(feet);
  const headY = feet.y + CLIMB_HEAD_HEIGHT;
  if (world.raycast({ x: feet.x, y: headY, z: feet.z }, into, CLIMB_SURFACE_RADIUS) !== null) return null;
  const wall = world.raycast(chest, into, CLIMB_SURFACE_RADIUS);
  if (wall === null) return null;
  const startY = headY + MANTLE_PROBE_CLEARANCE;
  for (const inset of MANTLE_INSETS) {
    const x = wall.point.x + into.x * inset;
    const z = wall.point.z + into.z * inset;
    const g = world.groundProbe({ x, y: startY, z }, startY - chest.y, CAPSULE_RADIUS);
    if (g === null || !g.walkable) continue;
    const y = startY - g.distance;
    if (!(y > chest.y && y <= headY)) continue;
    const fits = world.overlapCapsule({ x, y: y + MANTLE_FIT_LIFT, z }, CAPSULE_RADIUS, CAPSULE_HEIGHT).every((c) => c.depth <= MANTLE_FIT_TOLERANCE);
    if (fits) return { x, y, z };
  }
  return null;
}

/**
 * Pushes the capsule (feet `pos`) out of what it overlaps, deepest contact first, for a few passes: the
 * climb keeps the chest 0.45 m off the surface, so the lower capsule can sink into a slanted wall and has
 * to be freed before a fall sweeps it. Non-finite results return `pos` unchanged.
 */
export function depenetrate(world: CollisionQueries, pos: Readonly<Vec3>): Vec3 {
  let p = copyV3(pos);
  for (let pass = 0; pass < DEPENETRATE_PASSES; pass++) {
    const deepest = world.overlapCapsule(p, CAPSULE_RADIUS, CAPSULE_HEIGHT)[0];
    if (deepest === undefined || deepest.depth <= DEPENETRATE_MIN_DEPTH) break;
    p = addScaled(p, deepest.normal, deepest.depth + SKIN_WIDTH);
  }
  return isFiniteV3(p) ? p : copyV3(pos);
}
