// Attack aiming (design "전투 액션 모델"; Req 24.12, 24.13). Pure geometry over the targets' hurt capsules:
// - Melee aim assist: at the start of a melee attack, the nearest living target within MELEE_ASSIST_RANGE whose
//   direction lies within MELEE_ASSIST_ANGLE of the camera's forward; the character turns toward it within
//   AIM_TURN_SECONDS (playerCombat).
// - Isla's shots: the Lock-on target, else the nearest living target within RANGED_AIM_RANGE inside the
//   RANGED_AIM_ANGLE cone around the camera's forward, else the first point the camera's centre ray hits within
//   RANGED_AIM_RANGE (25 m ahead of the camera when it hits nothing).
// Angles are measured horizontally (about the camera yaw) and distances from the character's feet to the target's
// surface (centre distance minus the hurt radius). No three.js / DOM.

import { addScaled, DEG2RAD, dirFromYaw, normalize } from '../core/math';
import type { Vec3 } from '../core/types';
import type { EntityId } from '../data/ids';
import type { RayHit, QueryFilter } from '../physics/types';
import type { HitReceiver } from './attackRuntime';
import type { HurtVolume } from './hitShapes';

/** Melee aim assist reach (m) and the largest angle from the camera's forward (Req 24.12). */
export const MELEE_ASSIST_RANGE = 5;
export const MELEE_ASSIST_ANGLE = 60 * DEG2RAD;
/** Isla's aim cone half-angle from the camera's forward and its reach (Req 24.13). */
export const RANGED_AIM_ANGLE = 30 * DEG2RAD;
export const RANGED_AIM_RANGE = 25;
/** An attack's facing correction completes within this time (Req 24.12). */
export const AIM_TURN_SECONDS = 0.1;
/** Aim point height on a target: this fraction of its hurt height (body centre). */
export const AIM_HEIGHT_FRACTION = 0.5;

/** Camera centre ray for the tick: origin at the camera, unit direction. */
export interface AimRay {
  readonly origin: Readonly<Vec3>;
  readonly dir: Readonly<Vec3>;
}

/** What the combat tick knows about the view (from the Camera_System). */
export interface AimView {
  /** Camera Lock-on target, or null. */
  readonly lockTarget: EntityId | null;
  /** Camera centre ray, or null (headless): Isla then shoots along the camera yaw at body height. */
  readonly ray: AimRay | null;
}

/** Ray queries against the terrain and colliders (a CollisionWorld satisfies it). */
export interface AimRaycaster {
  raycast(origin: Vec3, dir: Vec3, maxDist: number, f?: QueryFilter): RayHit | null;
}

/** Body centre of a hurt capsule: where aimed shots go. */
export function aimPoint(v: HurtVolume): Vec3 {
  return { x: v.pos.x, y: v.pos.y + Math.max(v.height, 2 * v.radius) * AIM_HEIGHT_FRACTION, z: v.pos.z };
}

interface Candidate {
  receiver: HitReceiver;
  /** Distance from the character's feet to the target's surface, horizontal (m). */
  reach: number;
}

/**
 * Living targets within `range` (surface distance) whose horizontal direction from `from` is within `maxAngle`
 * of the camera yaw, nearest first (ties by id).
 */
function inCone(
  from: Readonly<Vec3>,
  cameraYaw: number,
  targets: Iterable<HitReceiver>,
  range: number,
  maxAngle: number,
): Candidate[] {
  const f = dirFromYaw(cameraYaw);
  const found: Candidate[] = [];
  for (const receiver of targets) {
    if (receiver.immune()) continue;
    const v = receiver.hurtVolume();
    const dx = v.pos.x - from.x;
    const dz = v.pos.z - from.z;
    const d = Math.hypot(dx, dz);
    const reach = Math.max(0, d - v.radius);
    if (!(reach <= range)) continue;
    if (d > 1e-6) {
      const angle = Math.acos(Math.max(-1, Math.min(1, (dx * f.x + dz * f.z) / d)));
      if (!(angle <= maxAngle)) continue;
    }
    found.push({ receiver, reach });
  }
  found.sort((a, b) => a.reach - b.reach || (a.receiver.id < b.receiver.id ? -1 : a.receiver.id > b.receiver.id ? 1 : 0));
  return found;
}

/** The melee aim-assist target: nearest living target within 5 m and 60° of the camera's forward, or null. */
export function meleeAssistTarget(
  from: Readonly<Vec3>,
  cameraYaw: number,
  targets: Iterable<HitReceiver>,
): HitReceiver | null {
  return inCone(from, cameraYaw, targets, MELEE_ASSIST_RANGE, MELEE_ASSIST_ANGLE)[0]?.receiver ?? null;
}

/** Where a ranged shot goes: a target (followed until the shot leaves) or a fixed point. */
export type RangedAim =
  | { kind: 'lockOn' | 'cone'; target: HitReceiver }
  | { kind: 'ray'; point: Vec3 };

/**
 * Isla's aim (Req 24.13): the living Lock-on target, else the nearest living target within 25 m in the 30° cone
 * around the camera yaw, else the camera ray's first hit within 25 m (25 m along the ray when it hits nothing).
 * Without a ray the fallback point is 25 m ahead along the camera yaw at the shot height `from.y + shotHeight`.
 */
export function rangedAim(
  from: Readonly<Vec3>,
  cameraYaw: number,
  view: AimView,
  targets: Iterable<HitReceiver>,
  world: AimRaycaster | null,
  shotHeight: number,
): RangedAim {
  const list = [...targets];
  if (view.lockTarget !== null) {
    const locked = list.find((r) => r.id === view.lockTarget && !r.immune());
    if (locked !== undefined) return { kind: 'lockOn', target: locked };
  }
  const cone = inCone(from, cameraYaw, list, RANGED_AIM_RANGE, RANGED_AIM_ANGLE)[0];
  if (cone !== undefined) return { kind: 'cone', target: cone.receiver };
  const ray = view.ray;
  if (ray === null) {
    const start = { x: from.x, y: from.y + shotHeight, z: from.z };
    return { kind: 'ray', point: addScaled(start, dirFromYaw(cameraYaw), RANGED_AIM_RANGE) };
  }
  const dir = normalize(ray.dir);
  const hit = world?.raycast({ ...ray.origin }, dir, RANGED_AIM_RANGE) ?? null;
  return { kind: 'ray', point: hit !== null ? { ...hit.point } : addScaled(ray.origin, dir, RANGED_AIM_RANGE) };
}

/** The point a RangedAim resolves to now (a target's current body centre). */
export function rangedAimPoint(aim: RangedAim): Vec3 {
  return aim.kind === 'ray' ? { ...aim.point } : aimPoint(aim.target.hurtVolume());
}
