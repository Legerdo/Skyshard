// Glide helpers of the pure player controller (design "Player Controller" → "활강"; Req 19.1, 19.9, 19.10): the
// ground clearance the deploy checks, Wren's gliding Skill lift and the glide wind loudness the controller adapter
// hands to the Audio_System. The glide tick itself lives in stepController. Pure TypeScript: imports only src/core,
// src/physics (types) and this directory (no three.js / DOM / Math.random); nothing here mutates its arguments.

import { clamp01, copyV3, isFiniteNum, isFiniteV3 } from '../../core/math';
import type { Vec3 } from '../../core/types';
import { CAPSULE_HEIGHT, CAPSULE_RADIUS, GLIDE_WIND_FULL_HEIGHT, GLIDE_WIND_FULL_SPEED, SKIN_WIDTH } from './constants';
import { isGlideMode, type ControllerState, type ControllerWorld } from './types';

const DOWN: Vec3 = { x: 0, y: -1, z: 0 };
const UP: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * How far below the feet the first surface (terrain or collider) is, straight down, within `maxDist`; null when
 * nothing is hit. The ray starts at the capsule's lower sphere centre, so feet resting on a surface measure 0.
 */
export function groundClearance(world: Pick<ControllerWorld, 'raycast'>, feet: Readonly<Vec3>, maxDist: number): number | null {
  if (!isFiniteV3(feet) || !(maxDist >= 0)) return null;
  const origin = { x: feet.x, y: feet.y + CAPSULE_RADIUS, z: feet.z };
  const hit = world.raycast(origin, DOWN, maxDist + CAPSULE_RADIUS);
  if (hit === null || !isFiniteNum(hit.distance)) return null;
  return Math.max(0, hit.distance - CAPSULE_RADIUS);
}

/**
 * Wren's Skill cast while gliding (Req 19.9): the character rises `rise` m at once, or less when an upward ray from
 * the capsule centre meets a ceiling: the head then stops SKIN_WIDTH below it. The descent stops (vy ≥ 0) and the
 * fall start follows the new height. Returns the lifted state, or null outside glideDeploy / glide or for a
 * non-positive or non-finite `rise` (nothing changes).
 */
export function glideLift(s: Readonly<ControllerState>, world: Pick<ControllerWorld, 'raycast'>, rise: number): ControllerState | null {
  if (!isGlideMode(s.mode) || !(isFiniteNum(rise) && rise > 0) || !isFiniteV3(s.pos)) return null;
  const half = CAPSULE_HEIGHT / 2;
  const centre = { x: s.pos.x, y: s.pos.y + half, z: s.pos.z };
  const hit = world.raycast(centre, UP, half + rise);
  const room = hit === null || !isFiniteNum(hit.distance) ? rise : Math.max(0, hit.distance - half - SKIN_WIDTH);
  const lift = Math.min(rise, room);
  const pos = { x: s.pos.x, y: s.pos.y + lift, z: s.pos.z };
  return {
    ...s,
    pos,
    vel: { x: s.vel.x, y: Math.max(0, s.vel.y), z: s.vel.z },
    groundNormal: copyV3(s.groundNormal),
    climbNormal: s.climbNormal === null ? null : copyV3(s.climbNormal),
    mantleTarget: s.mantleTarget === null ? null : copyV3(s.mantleTarget),
    fallStartY: pos.y,
  };
}

/**
 * Glide wind loudness in [0, 1] (Req 19.10): clamp01(0.5·h / 40 m + 0.5·v / 13 m/s) for the height above the ground
 * `height` and the speed `speed`, both rising with the value. Non-finite or negative inputs count as 0.
 */
export function glideWindIntensity(height: number, speed: number): number {
  const h = isFiniteNum(height) && height > 0 ? height : 0;
  const v = isFiniteNum(speed) && speed > 0 ? speed : 0;
  return clamp01((0.5 * h) / GLIDE_WIND_FULL_HEIGHT + (0.5 * v) / GLIDE_WIND_FULL_SPEED);
}
