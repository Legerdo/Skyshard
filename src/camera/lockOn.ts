// Lock-on target rules (design "Lock-on"; Req 21.6–21.8). Pure: the Camera_System passes the view, the
// candidates and a line-of-sight test.
// - Pick: among living enemies whose body centre is within LOCK_RANGE of the Active_Character and visible from the
//   camera (terrain and camera-blocking colliders do not cut the line), the one at the smallest angle from the
//   camera's forward; none → the camera re-centres behind the character instead (Req 21.7).
// - Keep: the target stays locked while it is alive and within LOCK_BREAK_RANGE; otherwise the lock ends (Req 21.8).

import { DEG2RAD, distance } from '../core/math';
import type { Vec3 } from '../core/types';

/** Candidates must be this close to the Active_Character (m, Req 21.6). */
export const LOCK_RANGE = 20;
/** A locked target farther than this is released (m, Req 21.8). */
export const LOCK_BREAK_RANGE = 25;
/** Look input moves the locked view at most this far from the framing goal (rad). */
export const LOCK_LOOK_LIMIT = 20 * DEG2RAD;
/** Smooth time of the pull toward the framing goal and of the look offset returning to it (s). */
export const LOCK_SMOOTH_TIME = 0.25;
/** Without a candidate the camera turns behind the character over this time (s, Req 21.7). */
export const RECENTER_SECONDS = 0.3;
/** When the character and the target spread wider than this share of the horizontal FOV, the camera pulls back. */
export const LOCK_WIDE_FOV_SHARE = 0.8;
/** Distance the camera pulls back to for a wide lock (m). */
export const LOCK_WIDE_DISTANCE = 7;
/** Radius of the line-of-sight cast from the camera to a candidate (m). */
export const LOCK_SIGHT_RADIUS = 0.05;

export interface LockTargetCandidate {
  readonly id: string;
  /** Body centre. */
  readonly center: Readonly<Vec3>;
}

/** Camera eye and unit forward direction. */
export interface LockView {
  readonly eye: Readonly<Vec3>;
  readonly forward: Readonly<Vec3>;
}

/** Angle (rad) between the view's forward and the direction from the eye to `p`. */
export function viewAngle(view: LockView, p: Readonly<Vec3>): number {
  const dx = p.x - view.eye.x;
  const dy = p.y - view.eye.y;
  const dz = p.z - view.eye.z;
  const d = Math.hypot(dx, dy, dz);
  const f = view.forward;
  const fl = Math.hypot(f.x, f.y, f.z);
  if (!(d > 1e-9) || !(fl > 1e-9)) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (dx * f.x + dy * f.y + dz * f.z) / (d * fl))));
}

/**
 * The Lock-on target: the visible candidate within LOCK_RANGE of `character` at the smallest view angle (ties by
 * id), or null.
 */
export function pickLockTarget(
  view: LockView,
  character: Readonly<Vec3>,
  candidates: Iterable<LockTargetCandidate>,
  visible: (from: Readonly<Vec3>, to: Readonly<Vec3>) => boolean,
): string | null {
  let best: { id: string; angle: number } | null = null;
  for (const c of candidates) {
    if (!(distance(character, c.center) <= LOCK_RANGE)) continue;
    const angle = viewAngle(view, c.center);
    if (best !== null && (angle > best.angle || (angle === best.angle && c.id > best.id))) continue;
    if (!visible(view.eye, c.center)) continue;
    best = { id: c.id, angle };
  }
  return best?.id ?? null;
}

/** The locked target to keep: its candidate when still listed (alive) and within LOCK_BREAK_RANGE, else null. */
export function keepLockTarget(
  id: string,
  character: Readonly<Vec3>,
  candidates: Iterable<LockTargetCandidate>,
): LockTargetCandidate | null {
  for (const c of candidates) {
    if (c.id !== id) continue;
    return distance(character, c.center) <= LOCK_BREAK_RANGE ? c : null;
  }
  return null;
}
