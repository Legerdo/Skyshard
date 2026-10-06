// Pure Vec3 / scalar / angle helpers for the fixed-step simulation.
// No three.js, DOM or Math.random: src/logic and src/data may import this module.
//
// Allocation: every function below returns a NEW object and never mutates its inputs,
// except the `*Into` / `setV3` variants at the end of the file, which write into `out`
// and return it (safe when `out` aliases an input) for per-tick hot paths.
//
// Yaw convention (world is Y-up, metres):
//   yaw 0 faces +Z, and positive yaw turns toward +X (a turn about +Y, seen from above).
//   yawFromDir(x, z) = atan2(x, z);  dirFromYaw(yaw) = { x: sin(yaw), y: 0, z: cos(yaw) }.
//   This matches three.js `Object3D.rotation.y` for models whose front faces +Z.

import type { Vec3 } from './types';

export type { Vec3, Vec2 } from './types';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

const TAU = Math.PI * 2;
/** Below this length a vector has no usable direction; normalize() returns zero. */
const NORMALIZE_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function copyV3(a: Readonly<Vec3>): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

// ---------------------------------------------------------------------------
// Vector arithmetic (new objects)
// ---------------------------------------------------------------------------

export function add(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Readonly<Vec3>, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/** a + b * s */
export function addScaled(a: Readonly<Vec3>, b: Readonly<Vec3>, s: number): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

export function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Right-handed cross product: cross(+X, +Y) = +Z. */
export function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(a: Readonly<Vec3>): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Readonly<Vec3>): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/** Horizontal length, ignoring Y. */
export function lengthXZ(a: Readonly<Vec3>): number {
  return Math.sqrt(a.x * a.x + a.z * a.z);
}

/** Unit vector in the direction of `a`; {0,0,0} when |a| < 1e-9 (NaN input stays NaN). */
export function normalize(a: Readonly<Vec3>): Vec3 {
  const len = length(a);
  if (len < NORMALIZE_EPSILON) return { x: 0, y: 0, z: 0 };
  const inv = 1 / len;
  return { x: a.x * inv, y: a.y * inv, z: a.z * inv };
}

export function distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Horizontal distance, ignoring Y. */
export function distanceXZ(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.sqrt(distanceSqXZ(a, b));
}

/** Squared horizontal distance, ignoring Y (cheap range checks). */
export function distanceSqXZ(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function lerpV3(a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Unclamped linear interpolation: a at t = 0, b at t = 1. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Hermite ease between edges: 0 at x <= e0, 1 at x >= e1, 3t² − 2t³ in between.
 * Reversed edges (e0 > e1) give the mirrored ramp; equal edges act as a step at e0.
 */
export function smoothstep(e0: number, e1: number, x: number): number {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Moves `current` toward `target` by at most `maxDelta` (<= 0 means no movement), never overshooting. */
export function approach(current: number, target: number, maxDelta: number): number {
  const step = maxDelta > 0 ? maxDelta : 0;
  const diff = target - current;
  if (diff > step) return current + step;
  if (diff < -step) return current - step;
  return target;
}

/**
 * Frame-rate independent exponential smoothing: target + (current − target) · e^(−lambda·dt).
 * Two steps of dt/2 equal one step of dt; dt = 0 returns `current`; large lambda·dt → target.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

// ---------------------------------------------------------------------------
// Angles (radians)
// ---------------------------------------------------------------------------

/** Wraps an angle into (−π, π]. −π maps to +π. NaN / ±Infinity yield NaN. */
export function wrapAngle(a: number): number {
  if (a > -Math.PI && a <= Math.PI) return a;
  // `%` is exact and keeps the dividend's sign, so r ∈ (−2π, 2π); one correction suffices.
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

/** Shortest signed rotation from `from` to `to`, in (−π, π] (exactly opposite → +π). */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Interpolates along the shortest arc from a to b; the result is wrapped to (−π, π]. */
export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + angleDelta(a, b) * t);
}

/**
 * Yaw of the horizontal direction (x, z): 0 for +Z, +π/2 for +X, π for −Z, −π/2 for −X.
 * Result is in (−π, π]; the zero vector yields 0.
 */
export function yawFromDir(x: number, z: number): number {
  // atan2 returns −π for (−0, negative z); wrapAngle canonicalises that to +π.
  return wrapAngle(Math.atan2(x, z));
}

/** Horizontal unit direction for a yaw (inverse of yawFromDir): { sin(yaw), 0, cos(yaw) }. */
export function dirFromYaw(yaw: number): Vec3 {
  return { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True for a finite number (not NaN / ±Infinity, not a non-number). */
export function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** True when all three components are finite. */
export function isFiniteV3(a: Readonly<Vec3>): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}

// ---------------------------------------------------------------------------
// Allocation-free variants: write into `out` and return it. `out` may alias an input.
// Generic so a structurally compatible target (e.g. a three.js Vector3 in an adapter)
// keeps its own type.
// ---------------------------------------------------------------------------

export function setV3<T extends Vec3>(out: T, x: number, y: number, z: number): T {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function addInto<T extends Vec3>(out: T, a: Readonly<Vec3>, b: Readonly<Vec3>): T {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function subInto<T extends Vec3>(out: T, a: Readonly<Vec3>, b: Readonly<Vec3>): T {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function scaleInto<T extends Vec3>(out: T, a: Readonly<Vec3>, s: number): T {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** Same rule as normalize(): writes {0,0,0} when |a| < 1e-9. */
export function normalizeInto<T extends Vec3>(out: T, a: Readonly<Vec3>): T {
  const len = length(a);
  if (len < NORMALIZE_EPSILON) return setV3(out, 0, 0, 0);
  const inv = 1 / len;
  out.x = a.x * inv;
  out.y = a.y * inv;
  out.z = a.z * inv;
  return out;
}

export function lerpV3Into<T extends Vec3>(out: T, a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): T {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}
