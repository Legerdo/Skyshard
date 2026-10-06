// World edge (design "World Layout Master Table" 경계, task 20.4; Req 8.6): the play area ends at 470 m from the centre.
// Beyond it the terrain rises into the ring mountains (src/world/terrain RING_MOUNTAINS) and the cloud sea covers the
// rest (the render's world edge view); here the invisible boundary wall: a ring of tall, thin boxes whose inner faces
// stand on the 470 m circle, too high to glide over and not climbable, so neither walking, climbing nor gliding leaves
// the play area. They do not block the camera (it may look out over the mountains). Pure TypeScript: no three.js / DOM.

import { PLAY_RADIUS } from '../data/worldLayout';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld } from '../physics/types';

/** Number of wall segments around the circle (each ≈ 31 m long). */
export const BOUNDARY_WALL_SEGMENTS = 96;
/** Half thickness of a segment (m); its inner face touches the PLAY_RADIUS circle at the segment's middle. */
export const BOUNDARY_WALL_HALF_THICKNESS = 1;
/** Vertical span of the wall (m): from below the lowest ground to far above the highest glide start. */
export const BOUNDARY_WALL_MIN_Y = -80;
export const BOUNDARY_WALL_MAX_Y = 700;

/** The boundary wall's colliders, ids from `ids`. */
export function boundaryWallColliders(ids: ColliderIdSource, radius: number = PLAY_RADIUS): Collider[] {
  const out: Collider[] = [];
  const n = BOUNDARY_WALL_SEGMENTS;
  const t = BOUNDARY_WALL_HALF_THICKNESS;
  const centreR = radius + t;
  // Half length reaching the neighbours' ends on the circle of the outer face, so the corners overlap.
  const halfLength = (radius + 2 * t) * Math.tan(Math.PI / n) + 0.5;
  const halfY = (BOUNDARY_WALL_MAX_Y - BOUNDARY_WALL_MIN_Y) / 2;
  const cy = (BOUNDARY_WALL_MAX_Y + BOUNDARY_WALL_MIN_Y) / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    // Local +Z points outward (yaw a faces (sin a, cos a)); the long side runs along local X.
    out.push({
      kind: 'obb', id: ids.next(), center: { x: dx * centreR, y: cy, z: dz * centreR },
      half: { x: halfLength, y: halfY, z: t }, yaw: a,
      flags: { climbable: false, walkableTop: false, blocksCamera: false, material: 'rock' },
    });
  }
  return out;
}

/** Adds the boundary wall to `world` (static colliders). */
export function addBoundaryWall(world: Pick<CollisionWorld, 'addStatic'>, ids: ColliderIdSource): void {
  for (const c of boundaryWallColliders(ids)) world.addStatic(c);
}
