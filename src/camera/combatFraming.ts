// Combat framing (design "전투 프레이밍"; Req 21.5). Pure:
// - Distance: while In_Combat, with `spread` the farthest horizontal distance of an engaged enemy within
//   COMBAT_FRAME_RADIUS of the character, the camera distance is max(userDistance, min(7, 5.5 + 0.2·spread)),
//   eased in with a 0.6 s smoothing and back to userDistance over about 1 s after the fight.
// - Off-screen Telegraphs: an active Telegraph's world point is projected with the view-projection matrix; when it
//   is off screen (or behind the camera, where clip w < 0 and the direction flips back) the HUD gets the point where
//   the line from the screen centre toward it meets the rectangle EDGE_INSET_PX inside the screen edges (at
//   1920×1080), and the direction angle.

import type { Vec3 } from '../core/types';

/** Engaged enemies farther than this from the character do not widen the view (m). */
export const COMBAT_FRAME_RADIUS = 15;
export const COMBAT_BASE_DISTANCE = 5.5;
export const COMBAT_SPREAD_GAIN = 0.2;
export const COMBAT_MAX_DISTANCE = 7;
/** Smooth time of the combat distance (s). */
export const COMBAT_DISTANCE_SMOOTH_TIME = 0.6;
/** After the fight the distance returns to userDistance over COMBAT_RETURN_SECONDS with this smooth time. */
export const COMBAT_RETURN_SECONDS = 1;
export const COMBAT_RETURN_SMOOTH_TIME = 0.5;
/** Off-screen arrows sit this far inside the screen edges (px at the reference height). */
export const EDGE_INSET_PX = 48;
export const EDGE_REFERENCE_HEIGHT = 1080;

/** Farthest horizontal distance of `enemies` within COMBAT_FRAME_RADIUS of `character`; 0 when none. */
export function combatSpread(character: Readonly<Vec3>, enemies: Iterable<Readonly<Vec3>>): number {
  let spread = 0;
  for (const e of enemies) {
    const d = Math.hypot(e.x - character.x, e.z - character.z);
    if (d <= COMBAT_FRAME_RADIUS && d > spread) spread = d;
  }
  return spread;
}

/** Camera distance goal during combat (Req 21.5). */
export function combatDistance(userDistance: number, spread: number): number {
  const s = Number.isFinite(spread) && spread > 0 ? spread : 0;
  return Math.max(userDistance, Math.min(COMBAT_MAX_DISTANCE, COMBAT_BASE_DISTANCE + COMBAT_SPREAD_GAIN * s));
}

/** Where an off-screen marker goes: screen fractions (0..1, y down) and the direction angle (rad, atan2(dy, dx)). */
export interface EdgeIndicator {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/**
 * Edge marker for world point `p` under the column-major 4×4 view-projection matrix `m` (three.js
 * Matrix4.elements) on a `width` × `height` screen; null when `p` is on screen.
 */
export function edgeIndicator(m: ArrayLike<number>, p: Readonly<Vec3>, width: number, height: number): EdgeIndicator | null {
  const cx = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
  const cy = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
  const cw = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
  if (![cx, cy, cw, width, height].every(Number.isFinite) || !(width > 0 && height > 0)) return null;
  if (cw > 1e-9 && Math.abs(cx / cw) <= 1 && Math.abs(cy / cw) <= 1) return null;
  // Direction in pixels (y down). Dividing by a negative w would mirror a point behind the camera, so the sign of w
  // is dropped: (cx, cy) keeps the side the point is really on.
  let dx = (cx * width) / 2;
  let dy = (-cy * height) / 2;
  if (Math.hypot(dx, dy) < 1e-9) {
    dx = 0;
    dy = 1; // straight behind: point down
  }
  const inset = (EDGE_INSET_PX * height) / EDGE_REFERENCE_HEIGHT;
  const hx = Math.max(0, width / 2 - inset);
  const hy = Math.max(0, height / 2 - inset);
  const t = Math.min(dx === 0 ? Infinity : hx / Math.abs(dx), dy === 0 ? Infinity : hy / Math.abs(dy));
  return { x: (width / 2 + dx * t) / width, y: (height / 2 + dy * t) / height, angle: Math.atan2(dy, dx) };
}
