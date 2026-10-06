// Title Screen camera (design "화면 목록" Title): looks from behind Thistlewick, over the village roofs, toward
// Astral Sanctum above the crater, swaying slowly around the village in real time. Pure: the render loop copies
// the rig to the three.js camera with applyCameraRig.

import type { Vec3 } from '../core/types';
import { LOCATIONS } from '../data/worldLayout';
import type { CameraRig } from './cameraCore';
import { CAMERA_FOV_DEG } from './constants';

/** Horizontal distance (m) of the camera from the village centre, on the side away from the crater. */
const ORBIT_RADIUS = 70;
/** Camera height above the village ground (m) and the least clearance over the terrain below it. */
const ORBIT_HEIGHT = 30;
const MIN_CLEARANCE = 12;
/** Sway half-angle (rad) and period (s) of the slow orbit. */
const SWAY = 0.2;
const SWAY_PERIOD = 60;
/** Look target: this far (m) from the village toward the crater, at this height. */
const LOOK_AHEAD = 120;
const LOOK_HEIGHT = 40;

/** Terrain height query (TerrainField.heightAt). */
export type GroundHeight = (x: number, z: number) => number;

/** Camera rig for the Title background at real time `t` seconds. */
export function titleCameraRig(t: number, groundAt?: GroundHeight): CameraRig {
  const village = LOCATIONS.thistlewick;
  const sanctum = LOCATIONS.sanctum_arena;
  // Unit direction from the sanctum (above the crater) to the village; the camera sits beyond the village.
  const dx = village.x - sanctum.x;
  const dz = village.z - sanctum.z;
  const len = Math.hypot(dx, dz);
  const base = Math.atan2(dz / len, dx / len);
  const time = Number.isFinite(t) ? t : 0;
  const angle = base + SWAY * Math.sin((2 * Math.PI * time) / SWAY_PERIOD);
  const x = village.x + Math.cos(angle) * ORBIT_RADIUS;
  const z = village.z + Math.sin(angle) * ORBIT_RADIUS;
  let y = village.groundY + ORBIT_HEIGHT;
  const ground = groundAt?.(x, z);
  if (ground !== undefined && Number.isFinite(ground)) y = Math.max(y, ground + MIN_CLEARANCE);
  const position: Vec3 = { x, y, z };
  const lookAt: Vec3 = {
    x: village.x - (dx / len) * LOOK_AHEAD,
    y: LOOK_HEIGHT,
    z: village.z - (dz / len) * LOOK_AHEAD,
  };
  return { position, lookAt, fov: CAMERA_FOV_DEG, roll: 0 };
}
