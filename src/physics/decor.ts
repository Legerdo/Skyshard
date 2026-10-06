// Decoration props → blocking colliders, and the visual-inset rule that keeps a prop's visual
// mesh inside its collider (design "World·Terrain·Collision"; Req 20.1, 18.9, 16.7):
// - Decorations shorter than MIN_BLOCKING_PROP_HEIGHT (grass, small stones, mushrooms) get no
//   blocking collider, so characters walk through them.
// - A visual mesh never leaves its collider: noise displacement only moves the surface inward,
//   by at most MAX_VISUAL_INSET.
// Pure TypeScript: imports only src/core and src/physics, no three.js / DOM / Math.random.

import { clamp, copyV3, isFiniteNum, isFiniteV3 } from '../core/math';
import type { Vec3 } from '../core/types';
import { closestPointOnShape, isValidShape } from './primitives';
import type { Collider, ColliderFlags, ColliderShape } from './types';

/** Props shorter than this (m) never block. */
export const MIN_BLOCKING_PROP_HEIGHT = 1;

/** Largest inward displacement (m) of a visual surface from its collider surface. */
export const MAX_VISUAL_INSET = 0.15;

/** Flags a blocking prop gets unless its definition overrides them. */
export const DEFAULT_PROP_FLAGS: Readonly<ColliderFlags> = {
  climbable: false,
  walkableTop: true,
  blocksCamera: true,
  material: 'stone',
};

export interface PropDef {
  /** Content label, e.g. 'grass', 'boulder', 'tree'. Not interpreted here. */
  kind: string;
  /** Visual height (m); decides whether the prop blocks. */
  height: number;
  /** Collider geometry, used when the prop blocks. */
  shape: ColliderShape;
  /** Overrides for DEFAULT_PROP_FLAGS. */
  flags?: Partial<ColliderFlags>;
}

/**
 * Blocking collider for a prop, or null when the prop is shorter than MIN_BLOCKING_PROP_HEIGHT,
 * its height is non-finite or its shape fails isValidShape. The collider copies the shape's
 * vectors, so later edits to `def` do not move it. `id` is passed through as given.
 */
export function propCollider(def: Readonly<PropDef>, id: number): Collider | null {
  if (!isFiniteNum(def.height) || def.height < MIN_BLOCKING_PROP_HEIGHT || !isValidShape(def.shape)) return null;
  return { ...copyShape(def.shape), id, flags: propFlags(def.flags) };
}

function propFlags(o: Partial<ColliderFlags> | undefined): ColliderFlags {
  const flags: ColliderFlags = {
    climbable: o?.climbable ?? DEFAULT_PROP_FLAGS.climbable,
    walkableTop: o?.walkableTop ?? DEFAULT_PROP_FLAGS.walkableTop,
    blocksCamera: o?.blocksCamera ?? DEFAULT_PROP_FLAGS.blocksCamera,
    material: o?.material ?? DEFAULT_PROP_FLAGS.material,
  };
  if (o?.hazard !== undefined) flags.hazard = o.hazard;
  if (o?.oneWay !== undefined) flags.oneWay = o.oneWay;
  return flags;
}

function copyShape(s: ColliderShape): ColliderShape {
  switch (s.kind) {
    case 'aabb':
      return { kind: 'aabb', min: copyV3(s.min), max: copyV3(s.max) };
    case 'obb':
      return { kind: 'obb', center: copyV3(s.center), half: copyV3(s.half), yaw: s.yaw };
    case 'cylinder':
      return { kind: 'cylinder', base: copyV3(s.base), radius: s.radius, height: s.height };
    case 'sphere':
      return { kind: 'sphere', center: copyV3(s.center), radius: s.radius };
    case 'capsule':
      return { kind: 'capsule', a: copyV3(s.a), b: copyV3(s.b), radius: s.radius };
  }
}

/**
 * Largest inset insetVisualPoint applies: min(MAX_VISUAL_INSET, thinnest half-extent), so insets
 * from opposite sides never cross. Half-extents: half sizes (aabb, obb), radius and height / 2
 * (cylinder), radius (sphere, capsule). 0 for an invalid shape.
 */
export function maxInset(shape: ColliderShape): number {
  return isValidShape(shape) ? Math.min(MAX_VISUAL_INSET, thinnestHalfExtent(shape)) : 0;
}

function thinnestHalfExtent(s: ColliderShape): number {
  switch (s.kind) {
    case 'aabb':
      return Math.min(s.max.x - s.min.x, s.max.y - s.min.y, s.max.z - s.min.z) / 2;
    case 'obb':
      return Math.min(s.half.x, s.half.y, s.half.z);
    case 'cylinder':
      return Math.min(s.radius, s.height / 2);
    case 'sphere':
    case 'capsule':
      return s.radius;
  }
}

/**
 * Visual-mesh position for a point on the collider surface: moved inward (against the outward
 * normal from closestPointOnShape) by clamp(amount, 0, maxInset(shape)). Outward (negative)
 * amounts clamp to 0 and a point outside the shape is first snapped onto its surface, so the
 * result is always inside or on the collider, within MAX_VISUAL_INSET of the surface for
 * surface points. Non-finite input or an invalid shape returns a copy of the point unchanged.
 */
export function insetVisualPoint(shape: ColliderShape, surfacePoint: Readonly<Vec3>, amount: number): Vec3 {
  const p = surfacePoint;
  if (!isFiniteV3(p) || !Number.isFinite(amount) || !isValidShape(shape)) return copyV3(p);
  const near = closestPointOnShape(shape, p);
  const n = near.normal;
  if (!Number.isFinite(near.distance) || !isFiniteV3(n) || !isFiniteV3(near.point)) return copyV3(p);
  const d = clamp(amount, 0, maxInset(shape));
  const base = near.distance > 0 ? near.point : p;
  return { x: base.x - n.x * d, y: base.y - n.y * d, z: base.z - n.z * d };
}
