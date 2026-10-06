// Shared collision types for src/physics (design "World·Terrain·Collision").
// Pure TypeScript: imports only src/core, no three.js / DOM / Math.random.
//
// Conventions
// - World is Y-up, metres. Yaw follows core/math: yaw 0 faces +Z, positive yaw turns toward +X,
//   so an OBB's local axes map to world as wx = vx·cos(yaw) + vz·sin(yaw), wz = −vx·sin(yaw) + vz·cos(yaw).
// - Every normal is an outward unit vector pointing from the surface toward the query.
// - Capsule queries (sweepCapsule, overlapCapsule) use a VERTICAL capsule of radius r and total
//   height h whose `pos` is the feet (lowest point). Its core segment runs
//   y ∈ [pos.y + r, pos.y + h − r] at (pos.x, pos.z); the capsule is every point within r of it.
//   h < 2r is treated as h = 2r (a sphere centred at pos.y + r).

import type { Vec3 } from '../core/types';

/** Terrain surface kinds. Single source of truth: src/world/terrain imports it from here. */
export type TerrainMaterial = 'grass' | 'dirt' | 'rock' | 'sand' | 'ashRock' | 'crystal' | 'snow' | 'stone';

/** Materials a query can report: terrain kinds plus collider-only surfaces. */
export type SurfaceMaterial = TerrainMaterial | 'wood' | 'water';

export type HazardKind = 'lava' | 'heat' | 'fall' | 'unstableCrystal' | 'shardCrystal';

export type ColliderShape =
  | { kind: 'aabb'; min: Vec3; max: Vec3 }
  | { kind: 'obb'; center: Vec3; half: Vec3; yaw: number } // rotation about +Y only
  | { kind: 'cylinder'; base: Vec3; radius: number; height: number } // vertical axis, base = bottom centre
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'capsule'; a: Vec3; b: Vec3; radius: number };

export type ColliderKind = ColliderShape['kind'];

export interface ColliderFlags {
  climbable: boolean;
  walkableTop: boolean;
  blocksCamera: boolean;
  material: SurfaceMaterial;
  hazard?: HazardKind;
  /** Passable from below; landable from above only. */
  oneWay?: boolean;
}

export type Collider = ColliderShape & { id: number; flags: ColliderFlags };

/**
 * Which colliders a query considers. The terrain always participates.
 * - 'solid' (default): every collider.
 * - 'camera': colliders with flags.blocksCamera.
 * - 'climb': colliders with flags.climbable.
 * `exclude` lists collider ids to skip (e.g. the object being carried).
 */
export type QueryMask = 'solid' | 'camera' | 'climb';

export interface QueryFilter {
  mask?: QueryMask;
  exclude?: readonly number[];
}

// ---------------------------------------------------------------------------
// Query results. All numbers are finite (NaN / Infinity results are dropped),
// every normal is unit length, and colliderId is null when the terrain was hit.
// ---------------------------------------------------------------------------

/** First contact of a capsule swept from `from` to `to`. */
export interface SweepHit {
  /** Fraction of the move completed at contact, in [0, 1]. */
  t: number;
  /** Distance moved before contact (m): t · |to − from|. */
  distance: number;
  /** Feet position at contact: from + (to − from) · t. */
  position: Vec3;
  /** Contact point on the surface that was hit. */
  point: Vec3;
  normal: Vec3;
  colliderId: number | null;
  dynamic: boolean;
}

/** One penetration found by overlapCapsule. */
export interface Contact {
  /** Penetration depth (m, ≥ 0): moving the capsule by normal · depth separates it. */
  depth: number;
  /** Deepest contact point on the surface. */
  point: Vec3;
  normal: Vec3;
  colliderId: number | null;
  dynamic: boolean;
}

export interface RayHit {
  /** Distance from the origin along the normalised direction, in [0, maxDist]. */
  distance: number;
  point: Vec3;
  normal: Vec3;
  colliderId: number | null;
  dynamic: boolean;
}

export interface GroundHit {
  /** pos.y − point.y: how far the feet are above the ground (negative when embedded), ≤ maxDrop. */
  distance: number;
  point: Vec3;
  normal: Vec3;
  /** Angle between the normal and +Y, degrees. */
  slopeDeg: number;
  material: SurfaceMaterial;
  /** Standable: slopeDeg ≤ MAX_WALKABLE_SLOPE_DEG and the surface allows it (terrain walkable / walkableTop). */
  walkable: boolean;
  hazard: HazardKind | null;
  colliderId: number | null;
  dynamic: boolean;
}

/** Nearest surface to a point (climbing surface search). */
export interface SurfaceHit {
  /** Signed distance from the query point to the surface: negative when the point is inside. */
  distance: number;
  point: Vec3;
  normal: Vec3;
  material: SurfaceMaterial;
  colliderId: number | null;
  dynamic: boolean;
}

/**
 * Minimal terrain view the collision queries need. A subset of src/world/terrain's
 * TerrainField, so a TerrainField satisfies it structurally. Normals and slopes are
 * derived from heightAt (see heightfield.ts).
 */
export interface Heightfield {
  heightAt(x: number, z: number): number;
  materialAt(x: number, z: number): TerrainMaterial;
  walkable(x: number, z: number): boolean;
}

/** Read-only query view of a CollisionWorld (the query methods only). */
export interface CollisionQueries {
  sweepCapsule(from: Vec3, to: Vec3, r: number, h: number, f?: QueryFilter): SweepHit | null;
  overlapCapsule(pos: Vec3, r: number, h: number, f?: QueryFilter): Contact[];
  raycast(origin: Vec3, dir: Vec3, maxDist: number, f?: QueryFilter): RayHit | null;
  /** Ground under `pos` within maxDrop, probed with a disc/sphere of `radius` (default DEFAULT_GROUND_PROBE_RADIUS). */
  groundProbe(pos: Vec3, maxDrop: number, radius?: number): GroundHit | null;
  /** Nearest surface within `radius` of `p`. */
  closestSurface(p: Vec3, radius: number, f: QueryFilter): SurfaceHit | null;
}

/** Heightfield + primitive colliders; every query tests both and returns the nearest result. */
export interface CollisionWorld<T extends Heightfield = Heightfield> extends CollisionQueries {
  readonly terrain: T;
  addStatic(c: Collider): void;
  /** Adds or moves a dynamic collider. Returns false (and changes nothing) when the collider is rejected. */
  upsertDynamic(c: Collider): boolean;
  /** Returns false when no dynamic collider has this id. */
  removeDynamic(id: number): boolean;
}

/** Steepest slope (degrees) a character can stand on; matches TerrainField.walkable. */
export const MAX_WALKABLE_SLOPE_DEG = 50;

/** Edge length (m) of a spatial-hash cell in XZ. */
export const SPATIAL_CELL_SIZE = 16;

/** groundProbe radius when none is given (player capsule radius, m). */
export const DEFAULT_GROUND_PROBE_RADIUS = 0.4;
