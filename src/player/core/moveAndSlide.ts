// Collide-and-slide helpers for the pure player controller (design "Player Controller" →
// "충돌 이동 (collide-and-slide)" steps 2–5 and 7; Req 16.6, 16.7, 20.1). stepController builds
// its tick on these. Pure TypeScript: imports only src/core and src/physics (no three.js / DOM /
// Math.random), and nothing here mutates its arguments.
//
// Positions are capsule FEET (lowest point), matching src/physics capsule queries.

import { addScaled, copyV3, cross, dot, isFiniteV3, length, lengthSq, normalize, scale } from '../../core/math';
import type { Vec3 } from '../../core/types';
import { slopeDegFromNormal } from '../../physics/heightfield';
import type { CollisionQueries, GroundHit, QueryFilter, SweepHit } from '../../physics/types';
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  CLIMB_SLOPE_DEG,
  GROUND_SNAP_DISTANCE,
  MAX_SLIDE_ITERATIONS,
  SKIN_WIDTH,
  STEP_UP_HEIGHT,
  WALKABLE_SLOPE_DEG,
} from './constants';
import type { ControllerWorld } from './types';

/** Moves shorter than this (m) count as finished. */
const MIN_MOVE = 1e-6;
/** A vector moves into a plane when dot(v, n) < −CLIP_EPS. */
const CLIP_EPS = 1e-9;
/** Slope tolerance (degrees) so normals built from exactly 50° / 65° land on the inclusive side. */
const SLOPE_EPS_DEG = 1e-6;
/**
 * Step-up tuning (implementation choices, not in the design table):
 * - STEP_MIN_FORWARD: the step's forward sweep reaches at least this far into the ledge, so the
 *   capsule's round bottom rests on the ledge edge at a walkable angle (≈ 39° on a vertical face)
 *   even when the tick's move is short; later ticks slide it over the edge onto the top.
 * - STEP_PROBE_INSET / STEP_PROBE_CLEARANCE: the ray that finds the ledge's top face starts this far
 *   past the contact (horizontally into the obstacle) and this far above the step limit.
 * - STEP_TOP_TOLERANCE: slack on the step limit when comparing the top face height.
 */
const STEP_MIN_FORWARD = 0.15;
const STEP_PROBE_INSET = 0.05;
const STEP_PROBE_CLEARANCE = 0.02;
const STEP_TOP_TOLERANCE = 1e-3;

const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const slopeDeg = (n: Readonly<Vec3>): number => slopeDegFromNormal(n);
const isWalkableNormal = (n: Readonly<Vec3>): boolean => slopeDeg(n) <= WALKABLE_SLOPE_DEG + SLOPE_EPS_DEG;

// ---------------------------------------------------------------------------
// Velocity clipping
// ---------------------------------------------------------------------------

/** Removes the component of v that points into the plane with normal n (dot(v, n) < 0). */
function removeInto(v: Readonly<Vec3>, n: Readonly<Vec3>): Vec3 {
  const d = dot(v, n);
  return d < 0 ? addScaled(v, n, -d) : copyV3(v);
}

function satisfiesAll(v: Readonly<Vec3>, normals: readonly Readonly<Vec3>[]): boolean {
  for (const n of normals) if (dot(v, n) < -CLIP_EPS) return false;
  return true;
}

/**
 * Removes from `v` every component that pushes into one of the planes (unit `normals`, pointing
 * away from the surfaces). Planes are clipped in order; when that re-enters an earlier plane the
 * result slides along the best crease (intersection line) of two planes that satisfies all of them,
 * and when none does, or the result would turn against `v`, it is zero. Use it for the remaining
 * move and for the velocity after moveAndSlide (step 2 "남은 이동량과 속도").
 */
export function clipVelocity(v: Readonly<Vec3>, normals: readonly Readonly<Vec3>[]): Vec3 {
  let out = copyV3(v);
  for (const n of normals) out = removeInto(out, n);
  if (!satisfiesAll(out, normals)) {
    out = zero();
    let best = 0;
    for (let i = 0; i < normals.length; i++) {
      for (let j = i + 1; j < normals.length; j++) {
        const c = cross(normals[i], normals[j]);
        if (lengthSq(c) < 1e-12) continue;
        const dir = normalize(c);
        const along = dot(v, dir);
        const cand = scale(dir, along);
        if (Math.abs(along) > best && satisfiesAll(cand, normals)) {
          best = Math.abs(along);
          out = cand;
        }
      }
    }
  }
  return dot(out, v) > 0 ? out : zero();
}

// ---------------------------------------------------------------------------
// moveAndSlide
// ---------------------------------------------------------------------------

export interface SlideOptions {
  /**
   * Ground movement (e.g. grounded / slide / dodge on the ground): blocking ledges up to
   * `stepHeight` are stepped onto (step 3), and non-walkable up-facing contacts clip as vertical
   * walls, so pushing into a steep slope does not creep up it. Default false (airborne): no step-up,
   * true normals.
   */
  grounded?: boolean;
  /** Capsule radius, height, skin gap and iteration cap; defaults are the constants.ts values. */
  radius?: number;
  height?: number;
  skin?: number;
  maxIterations?: number;
  /** Step-up limit above the feet (m). Default STEP_UP_HEIGHT. */
  stepHeight?: number;
  filter?: QueryFilter;
}

export interface SlideResult {
  /** Final feet position; a copy of the input when !valid. */
  pos: Vec3;
  /**
   * Planes that deflected the move, in contact order: the hit normals, except that in grounded mode
   * a non-walkable up-facing normal is flattened to horizontal. Pass them to clipVelocity to drop
   * the velocity that pushes into those surfaces. A ledge that was stepped onto is not included.
   */
  normals: Vec3[];
  /** Raw sweep hits behind `normals` (true surface normal, contact point, collider id). */
  hits: SweepHit[];
  /** A non-walkable contact (slope > WALKABLE_SLOPE_DEG: wall, too-high ledge, steep slope) cut the move. */
  blocked: boolean;
  /** A step-up was applied this call; stepHeight is how much it raised the feet (m, else 0). */
  steppedUp: boolean;
  stepHeight: number;
  /** False when pos, delta or the result was non-finite; pos is then the input unchanged. */
  valid: boolean;
}

interface SlideConfig {
  r: number;
  h: number;
  skin: number;
  stepHeight: number;
  filter: QueryFilter | undefined;
}

function invalidSlide(pos: Readonly<Vec3>): SlideResult {
  return { pos: copyV3(pos), normals: [], hits: [], blocked: false, steppedUp: false, stepHeight: 0, valid: false };
}

/** In grounded mode, a steep up-facing contact clips like a vertical wall (no sliding up it). */
function groundClipNormal(n: Readonly<Vec3>): Vec3 {
  if (n.y > 0 && !isWalkableNormal(n)) {
    const h = Math.hypot(n.x, n.z);
    if (h > 1e-9) return { x: n.x / h, y: 0, z: n.z / h };
  }
  return copyV3(n);
}

/** A non-walkable, not ceiling-like contact no higher than the step limit above the feet. */
function isStepCandidate(hit: SweepHit, stepHeight: number): boolean {
  const n = hit.normal;
  if (isWalkableNormal(n)) return false; // walkable contacts are simply slid up
  if (n.x * n.x + n.z * n.z < 1e-6) return false;
  return hit.point.y - hit.position.y <= stepHeight;
}

/**
 * Step 3: from `p` (just short of the blocking contact) sweep up by the step limit, forward by the
 * blocked horizontal move, then down. Accepted only when the ledge's top face (found by a downward
 * ray just past the contact) is walkable and no higher than the step limit, and the capsule lands
 * on a walkable contact above where it started. Null when rejected.
 */
function tryStepUp(
  world: CollisionQueries,
  p: Readonly<Vec3>,
  remaining: Readonly<Vec3>,
  hit: SweepHit,
  cfg: SlideConfig,
): { pos: Vec3; rise: number } | null {
  const nh = Math.hypot(hit.normal.x, hit.normal.z);
  const nx = hit.normal.x / nh;
  const nz = hit.normal.z / nh;
  let fx = remaining.x;
  let fz = remaining.z;
  const into = -(fx * nx + fz * nz);
  if (!(into > MIN_MOVE)) return null; // not pushing into the ledge horizontally
  if (into < STEP_MIN_FORWARD) {
    fx -= nx * (STEP_MIN_FORWARD - into);
    fz -= nz * (STEP_MIN_FORWARD - into);
  }

  // Landing surface ("착지 지점 법선"): the ledge's top face just past the contact.
  const probeY = p.y + cfg.stepHeight + STEP_PROBE_CLEARANCE;
  const top = world.raycast(
    { x: hit.point.x - nx * STEP_PROBE_INSET, y: probeY, z: hit.point.z - nz * STEP_PROBE_INSET },
    { x: 0, y: -1, z: 0 },
    cfg.stepHeight + STEP_PROBE_CLEARANCE,
    cfg.filter,
  );
  // A ray that starts inside the obstacle hits at distance 0, i.e. above the limit.
  if (top === null || top.point.y - p.y > cfg.stepHeight + STEP_TOP_TOLERANCE || !isWalkableNormal(top.normal)) return null;

  // Up.
  const upHit = world.sweepCapsule(p, { x: p.x, y: p.y + cfg.stepHeight, z: p.z }, cfg.r, cfg.h, cfg.filter);
  const rise = upHit === null ? cfg.stepHeight : Math.max(0, upHit.distance - cfg.skin);
  if (!(rise > MIN_MOVE)) return null;
  const up: Vec3 = { x: p.x, y: p.y + rise, z: p.z };

  // Forward.
  const fLen = Math.hypot(fx, fz);
  let fwd: Vec3 = { x: up.x + fx, y: up.y, z: up.z + fz };
  const fwdHit = world.sweepCapsule(up, fwd, cfg.r, cfg.h, cfg.filter);
  if (fwdHit !== null) {
    const adv = Math.max(0, fwdHit.distance - cfg.skin);
    if (!(adv > MIN_MOVE)) return null;
    fwd = { x: up.x + (fx * adv) / fLen, y: up.y, z: up.z + (fz * adv) / fLen };
  }

  // Down, at most back to the starting height.
  const downHit = world.sweepCapsule(fwd, { x: fwd.x, y: fwd.y - rise, z: fwd.z }, cfg.r, cfg.h, cfg.filter);
  if (downHit === null || !isWalkableNormal(downHit.normal)) return null;
  const landing: Vec3 = { x: fwd.x, y: fwd.y - Math.max(0, downHit.distance - cfg.skin), z: fwd.z };
  const gained = landing.y - p.y;
  if (!(gained > MIN_MOVE) || !isFiniteV3(landing)) return null;
  return { pos: landing, rise: gained };
}

/**
 * Steps 2–3: moves the capsule (feet at `pos`) by `delta` with up to maxIterations sweeps. Each hit
 * stops `skin` short of the contact along the move, records the plane and clips the rest of the move
 * with clipVelocity; a move that would turn back against `delta` ends. In grounded mode the first
 * blocking ledge ≤ stepHeight is stepped onto when tryStepUp accepts it (that ends the move).
 * Non-finite `pos` or `delta` returns the input position with valid = false.
 */
export function moveAndSlide(
  world: CollisionQueries,
  pos: Readonly<Vec3>,
  delta: Readonly<Vec3>,
  opts: SlideOptions = {},
): SlideResult {
  if (!isFiniteV3(pos) || !isFiniteV3(delta)) return invalidSlide(pos);
  const cfg: SlideConfig = {
    r: opts.radius ?? CAPSULE_RADIUS,
    h: opts.height ?? CAPSULE_HEIGHT,
    skin: opts.skin ?? SKIN_WIDTH,
    stepHeight: opts.stepHeight ?? STEP_UP_HEIGHT,
    filter: opts.filter,
  };
  const grounded = opts.grounded === true;
  const maxIterations = opts.maxIterations ?? MAX_SLIDE_ITERATIONS;

  let p = copyV3(pos);
  let remaining = copyV3(delta);
  const normals: Vec3[] = [];
  const hits: SweepHit[] = [];
  let steppedUp = false;
  let stepHeight = 0;

  for (let i = 0; i < maxIterations; i++) {
    const len = length(remaining);
    if (!(len > MIN_MOVE)) break;
    const to = addScaled(p, remaining, 1);
    const hit = world.sweepCapsule(p, to, cfg.r, cfg.h, cfg.filter);
    if (hit === null) {
      p = to;
      break;
    }
    // Stop `skin` short of the contact along the move (never behind the start).
    const frac = Math.min(1, Math.max(0, hit.distance - cfg.skin) / len);
    p = addScaled(p, remaining, frac);
    remaining = scale(remaining, 1 - frac);

    if (grounded && !steppedUp && isStepCandidate(hit, cfg.stepHeight)) {
      const step = tryStepUp(world, p, remaining, hit, cfg);
      if (step !== null) {
        p = step.pos;
        stepHeight = step.rise;
        steppedUp = true;
        break;
      }
    }

    hits.push(hit);
    normals.push(grounded ? groundClipNormal(hit.normal) : copyV3(hit.normal));
    remaining = clipVelocity(remaining, normals);
    // Never turn back against the requested move (avoids jitter in sloped or acute corners).
    if (dot(remaining, delta) <= 0) break;
  }

  if (!isFiniteV3(p)) return invalidSlide(pos);
  const blocked = hits.some((h) => !isWalkableNormal(h.normal));
  return { pos: p, normals, hits, blocked, steppedUp, stepHeight, valid: true };
}

// ---------------------------------------------------------------------------
// Ground snap, slope classes, terrain clamp
// ---------------------------------------------------------------------------

export interface SnapResult {
  /** Feet after the snap; a copy of the input when nothing was found. */
  pos: Vec3;
  /** Ground within maxSnap below the feet (distance < 0 when embedded: the snap lifts the feet). */
  hit: GroundHit | null;
  snapped: boolean;
}

/**
 * Step 4: places the feet on the ground found by groundProbe within `maxSnap` below them (a sphere of
 * `radius` dropped from the feet), so walking downhill keeps contact instead of hopping. Any ground
 * counts; the caller decides from hit.walkable / hit.slopeDeg whether to use it (call it only while
 * grounded and not jumping). Non-finite input, or no ground in range, leaves pos unchanged.
 */
export function snapToGround(
  world: CollisionQueries,
  pos: Readonly<Vec3>,
  maxSnap: number = GROUND_SNAP_DISTANCE,
  radius: number = CAPSULE_RADIUS,
): SnapResult {
  const none = (): SnapResult => ({ pos: copyV3(pos), hit: null, snapped: false });
  if (!isFiniteV3(pos) || !Number.isFinite(maxSnap) || maxSnap < 0) return none();
  const hit = world.groundProbe(pos, maxSnap, radius);
  // groundProbe reports point = (pos.x, pos.y − distance, pos.z); anything else is a stale fallback.
  if (hit === null || !(hit.distance <= maxSnap) || hit.point.x !== pos.x || hit.point.z !== pos.z) return none();
  return { pos: { x: pos.x, y: pos.y - hit.distance, z: pos.z }, hit, snapped: true };
}

export type SlopeClass = 'walk' | 'slide' | 'climbCandidate' | 'wall';

/**
 * Step 5 (Req 16.6): ≤ 50° walks, 50–65° slides, ≥ 65° is a climb candidate on a climbable surface
 * and a wall otherwise (overhangs included). A zero or non-finite normal is a wall.
 */
export function classifySlope(normal: Readonly<Vec3>, climbable: boolean): SlopeClass {
  if (!isFiniteV3(normal) || lengthSq(normal) < 1e-18) return 'wall';
  const deg = slopeDeg(normalize(normal));
  if (deg <= WALKABLE_SLOPE_DEG + SLOPE_EPS_DEG) return 'walk';
  if (deg < CLIMB_SLOPE_DEG - SLOPE_EPS_DEG) return 'slide';
  return climbable ? 'climbCandidate' : 'wall';
}

export interface ClampResult {
  pos: Vec3;
  /** The feet were below the terrain and were raised onto it. */
  clamped: boolean;
}

/**
 * Step 7 (Req 20.1): enforces feet y ≥ terrain.heightAt(x, z). Non-finite input or terrain height
 * leaves pos unchanged.
 */
export function clampAboveTerrain(world: Pick<ControllerWorld, 'terrain'>, pos: Readonly<Vec3>): ClampResult {
  if (!isFiniteV3(pos)) return { pos: copyV3(pos), clamped: false };
  const ground = world.terrain.heightAt(pos.x, pos.z);
  if (!Number.isFinite(ground) || pos.y >= ground) return { pos: copyV3(pos), clamped: false };
  return { pos: { x: pos.x, y: ground, z: pos.z }, clamped: true };
}
