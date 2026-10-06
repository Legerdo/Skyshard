// Real-time smoothing helpers for the camera: a critically damped spring (smoothDamp) and easing
// curves. Pure: no three.js / DOM.

import { clamp01 } from '../core/math';

/** Value and velocity of a critically damped spring. */
export interface Spring {
  value: number;
  velocity: number;
}

/** Smallest smooth time used, so smoothTime → 0 cannot divide by zero. */
const MIN_SMOOTH_TIME = 1e-4;

/**
 * Moves `s` toward `target` like a critically damped spring that closes most of the gap in about
 * `smoothTime` seconds (Game Programming Gems 4 §1.10, the approximation behind Unity's SmoothDamp).
 * It never overshoots: a step that would pass the target stops on it with zero velocity. dt ≤ 0 (or
 * NaN) leaves `s` unchanged. Mutates `s` and returns the new value.
 */
export function smoothDamp(s: Spring, target: number, smoothTime: number, dt: number): number {
  if (!(dt > 0)) return s.value;
  const omega = 2 / Math.max(MIN_SMOOTH_TIME, smoothTime);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s.value - target;
  const temp = (s.velocity + omega * change) * dt;
  let velocity = (s.velocity - omega * temp) * decay;
  let value = target + (change + temp) * decay;
  if (target - s.value > 0 === value > target) {
    value = target;
    velocity = 0;
  }
  s.value = value;
  s.velocity = velocity;
  return value;
}

/** Puts the spring at rest on `value`. */
export function resetSpring(s: Spring, value: number): void {
  s.value = value;
  s.velocity = 0;
}

/** Decelerating ease: 0 at k ≤ 0, 1 at k ≥ 1, 1 − (1 − k)² in between. */
export function easeOutQuad(k: number): number {
  const u = 1 - clamp01(k);
  return 1 - u * u;
}

/** Decelerating ease: 0 at k ≤ 0, 1 at k ≥ 1, 1 − (1 − k)³ in between. */
export function easeOutCubic(k: number): number {
  const u = 1 - clamp01(k);
  return 1 - u * u * u;
}
