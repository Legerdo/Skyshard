// HitShape overlap tests (design "전투 액션 모델"): does a HitEvent's volume, placed in the attacker's frame
// at judgement time, touch a target's hurt capsule? Pure geometry: no three.js / DOM.
//
// Frames: the attacker's feet and yaw (core/math: yaw 0 faces +Z, positive turns toward +X). A local offset
// (x, y, z) maps to world as x·cos(yaw) + z·sin(yaw), y, −x·sin(yaw) + z·cos(yaw), the same rotation as
// physics OBBs. Targets are vertical capsules with feet at `pos` (height below 2·radius counts as 2·radius).

import { DEG2RAD, dirFromYaw } from '../core/math';
import type { Vec3 } from '../core/types';
import type { HitShape } from '../data/combatTypes';

/** A target's hurt capsule. */
export interface HurtVolume {
  readonly pos: Readonly<Vec3>;
  readonly radius: number;
  readonly height: number;
}

/** Attacker feet and facing when the HitEvent is judged. */
export interface HitOrigin {
  readonly pos: Readonly<Vec3>;
  readonly yaw: number;
}

/** Height above the attacker's feet of the capsule and line axes (chest height). */
export const STRIKE_HEIGHT = 1;
/** Vertical reach of a ground circle: from 0.5 m below to 1.5 m above the attacker's feet. */
export const GROUND_CIRCLE_BELOW = 0.5;
export const GROUND_CIRCLE_ABOVE = 1.5;

const spansOverlap = (a0: number, a1: number, b0: number, b1: number): boolean => a0 <= b1 && b0 <= a1;

const topOf = (t: HurtVolume): number => t.pos.y + Math.max(t.height, 2 * t.radius);

/** Vertical core segment [y0, y1] of the target capsule. */
function coreSpan(t: HurtVolume): [number, number] {
  const y0 = t.pos.y + t.radius;
  return [y0, Math.max(y0, topOf(t) - t.radius)];
}

/** Distance from `y` to the span [y0, y1] (0 inside). */
const outside = (y: number, y0: number, y1: number): number => Math.max(0, y0 - y, y - y1);

/** Forward sector of `radius` and `angleDeg`, from the feet up to `height`. */
function arcOverlaps(radius: number, angleDeg: number, height: number, o: HitOrigin, t: HurtVolume): boolean {
  if (!spansOverlap(o.pos.y, o.pos.y + height, t.pos.y, topOf(t))) return false;
  const dx = t.pos.x - o.pos.x;
  const dz = t.pos.z - o.pos.z;
  const d = Math.hypot(dx, dz);
  if (d - t.radius > radius) return false;
  if (d <= t.radius) return true; // the attacker stands inside the target's footprint
  const f = dirFromYaw(o.yaw);
  const angle = Math.acos(Math.max(-1, Math.min(1, (dx * f.x + dz * f.z) / d)));
  // The capsule's own width widens the accepted angle by asin(r / d).
  return angle <= (angleDeg / 2) * DEG2RAD + Math.asin(Math.min(1, t.radius / d));
}

/** Sphere of `radius` around the attacker-local `offset`. */
function sphereOverlaps(radius: number, offset: Readonly<Vec3>, o: HitOrigin, t: HurtVolume): boolean {
  const sin = Math.sin(o.yaw);
  const cos = Math.cos(o.yaw);
  const cx = o.pos.x + offset.x * cos + offset.z * sin;
  const cy = o.pos.y + offset.y;
  const cz = o.pos.z - offset.x * sin + offset.z * cos;
  const [y0, y1] = coreSpan(t);
  const dist = Math.hypot(t.pos.x - cx, t.pos.z - cz, outside(cy, y0, y1));
  return dist <= radius + t.radius;
}

/**
 * Horizontal capsule from chest height reaching `length` forward. Its axis is horizontal and the target's is
 * vertical, so the axis distance splits into the 2D point–segment distance and the height gap.
 */
function forwardCapsuleOverlaps(length: number, radius: number, o: HitOrigin, t: HurtVolume): boolean {
  const f = dirFromYaw(o.yaw);
  const px = t.pos.x - o.pos.x;
  const pz = t.pos.z - o.pos.z;
  const along = Math.max(0, Math.min(length, px * f.x + pz * f.z));
  const [y0, y1] = coreSpan(t);
  const dist = Math.hypot(px - f.x * along, pz - f.z * along, outside(o.pos.y + STRIKE_HEIGHT, y0, y1));
  return dist <= radius + t.radius;
}

/** Disc of `radius` around the attacker's feet. */
function groundCircleOverlaps(radius: number, o: HitOrigin, t: HurtVolume): boolean {
  if (!spansOverlap(o.pos.y - GROUND_CIRCLE_BELOW, o.pos.y + GROUND_CIRCLE_ABOVE, t.pos.y, topOf(t))) return false;
  return Math.hypot(t.pos.x - o.pos.x, t.pos.z - o.pos.z) - t.radius <= radius;
}

/**
 * Whether `shape` placed at `origin` touches `target`. Projectiles are never judged here: the HitEvent spawns
 * a projectile that the projectile system sweeps each tick (task 6.4), so they return false.
 */
export function hitShapeOverlaps(shape: HitShape, origin: HitOrigin, target: HurtVolume): boolean {
  switch (shape.kind) {
    case 'arc':
      return arcOverlaps(shape.radius, shape.angleDeg, shape.height, origin, target);
    case 'sphere':
      return sphereOverlaps(shape.radius, shape.offset, origin, target);
    case 'capsule':
      return forwardCapsuleOverlaps(shape.length, shape.radius, origin, target);
    case 'line':
      return forwardCapsuleOverlaps(shape.length, shape.width / 2, origin, target);
    case 'groundCircle':
      return groundCircleOverlaps(shape.radius, origin, target);
    case 'projectile':
      return false;
  }
}
