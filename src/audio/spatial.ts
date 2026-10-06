/*
 * Positional sound rules for the `world` group (design "공간감", Req 19.8): the camera is the listener, gain falls
 * as min(1, 3 m / d), the stereo pan is sin(azimuth in camera space) × 0.8, and nothing plays beyond 60 m.
 * Pure functions: no Web Audio.
 */

import type { Vec3 } from '../core/types';

/** Full loudness within this distance (m); gain = REF / d beyond it. */
export const SPATIAL_REF_DISTANCE = 3;
/** Sounds farther than this (m) are not played. */
export const SPATIAL_MAX_DISTANCE = 60;
/** Pan at 90° to the side. */
export const SPATIAL_PAN_WIDTH = 0.8;

/** Where the listener (the render camera) is and which way it looks (any length; only its horizontal part counts). */
export interface Listener {
  readonly pos: Readonly<Vec3>;
  readonly forward: Readonly<Vec3>;
}

export interface Spatial {
  readonly gain: number;
  readonly pan: number;
  readonly distance: number;
}

/**
 * Gain and pan of a sound at `pos` for `listener`, or null beyond SPATIAL_MAX_DISTANCE (or with a non-finite point).
 * The azimuth is measured in the horizontal plane from the camera's forward toward its right (+pan).
 */
export function spatialize(listener: Listener, pos: Readonly<Vec3>): Spatial | null {
  const dx = pos.x - listener.pos.x;
  const dy = pos.y - listener.pos.y;
  const dz = pos.z - listener.pos.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(distance) || distance > SPATIAL_MAX_DISTANCE) return null;
  const gain = distance <= SPATIAL_REF_DISTANCE ? 1 : SPATIAL_REF_DISTANCE / distance;
  let fx = listener.forward.x;
  let fz = listener.forward.z;
  const fl = Math.hypot(fx, fz);
  if (fl > 1e-9) {
    fx /= fl;
    fz /= fl;
  } else {
    fx = 0;
    fz = -1;
  }
  // Right of a forward (fx, fz) in the Y-up world is (−fz, fx) (three.js: looking down −Z, right is +X).
  const side = dx * -fz + dz * fx;
  const ahead = dx * fx + dz * fz;
  const horizontal = Math.hypot(side, ahead);
  const pan = horizontal > 1e-6 ? (side / horizontal) * SPATIAL_PAN_WIDTH : 0;
  return { gain, pan, distance };
}
