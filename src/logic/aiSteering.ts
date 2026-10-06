/*
 * Enemy movement rules (design "공격 토큰과 분리", "지형 탐지와 이동"; Req 28.6–28.8, 20.2): the 4–6 m waiting ring of
 * melee enemies without an attack token, separation steering and the CollisionResolve spacing pass (1.2 m, or the
 * radius sum when larger), the terrain probe decision (0° and ±40°, 1.5 m ahead) and the 2 s progress window.
 * Pure planar maths: the EnemySystem samples the terrain and the collision world and feeds the results in.
 * Directions follow core/math: yaw 0 faces +Z and a positive yaw turns toward +X (counter-clockwise seen from above).
 */
import { DEG2RAD } from '../core/math';

/** A vector on the ground plane. */
export interface Planar {
  readonly x: number;
  readonly z: number;
}

const EPS = 1e-9;
/** Below this centre distance (m) two bodies count as coincident. */
const COINCIDENT = 1e-6;

/** `v` scaled down to at most `max` long. */
export function capLength(v: Planar, max: number): Planar {
  const len = Math.hypot(v.x, v.z);
  return len > max ? { x: (v.x / len) * max, z: (v.z / len) * max } : { x: v.x, z: v.z };
}

/** `v` turned by `angle` rad in the yaw sense (+Z toward +X). */
export function rotateYaw(v: Planar, angle: number): Planar {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c + v.z * s, z: v.z * c - v.x * s };
}

// ── Waiting ring (Req 28.6) ─────────────────────────────────────────────────

/** A melee enemy without a token circles the target between these distances (m). */
export const WAIT_RING: readonly [number, number] = [4, 6];
/** Circling runs at this fraction of the move speed (implementation choice). */
export const CIRCLE_SPEED_FRACTION = 0.5;

/** Circling side by spawn ordinal parity: even +1 (counter-clockwise seen from above), odd −1. */
export function circleSide(seq: number): 1 | -1 {
  return (seq & 1) === 0 ? 1 : -1;
}

/**
 * Steer (fraction of the move speed, at most 1 long) for circling `centre` on `ring` at `self`: a tangent of
 * CIRCLE_SPEED_FRACTION in the `side` direction plus a radial pull toward the ring's middle that is full speed
 * (outward or inward) at and beyond the ring's edges. A body on the centre heads out along +Z.
 */
export function ringSteer(self: Planar, centre: Planar, side: 1 | -1, ring: readonly [number, number] = WAIT_RING): Planar {
  const dx = self.x - centre.x;
  const dz = self.z - centre.z;
  const d = Math.hypot(dx, dz);
  const rx = d > COINCIDENT ? dx / d : 0;
  const rz = d > COINCIDENT ? dz / d : 1;
  const mid = (ring[0] + ring[1]) / 2;
  const half = Math.max((ring[1] - ring[0]) / 2, EPS);
  const radial = Math.max(-1, Math.min(1, (mid - d) / half));
  return capLength({
    x: side * rz * CIRCLE_SPEED_FRACTION + rx * radial,
    z: -side * rx * CIRCLE_SPEED_FRACTION + rz * radial,
  }, 1);
}

// ── Separation (Req 28.7) ───────────────────────────────────────────────────

/** Least horizontal centre distance (m) between two enemies… */
export const ENEMY_SPACING = 1.2;
/** …and how far beyond it (m) separation steering starts pushing them apart (implementation choice). */
export const SEPARATION_STEER_RANGE = 1;
/**
 * Most passes of the CollisionResolve spacing pass; it stops early once no pair is closer than its spacing by more
 * than SPACING_TOLERANCE. A packed chain converges by half its shortfall per pass, so 32 passes leave nothing visible.
 */
export const SPACING_ITERATIONS = 32;
/** A pair this little (m) under its spacing counts as spaced. */
export const SPACING_TOLERANCE = 1e-9;

/** A vertical body: feet `y`, total `height`. */
export interface SpacingBody {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
}

/** The spacing two enemies of radii `a` and `b` keep: 1.2 m, or the radius sum when larger. */
export function spacingFor(a: number, b: number): number {
  return Math.max(ENEMY_SPACING, a + b);
}

/** Whether the vertical spans of two bodies overlap (one on a ledge above the other does not crowd it). */
function sharesHeight(a: SpacingBody, b: SpacingBody): boolean {
  return a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Separation steering: the sum, over the other bodies within their spacing + SEPARATION_STEER_RANGE, of the unit
 * vector away from each weighted by (range − d) / range, capped at 1. `self` itself and coincident bodies (the
 * spacing pass splits those) are skipped.
 */
export function separationSteer(self: SpacingBody, others: Iterable<SpacingBody>): Planar {
  let x = 0;
  let z = 0;
  for (const o of others) {
    if (o === self || !sharesHeight(self, o)) continue;
    const dx = self.x - o.x;
    const dz = self.z - o.z;
    const d = Math.hypot(dx, dz);
    const range = spacingFor(self.radius, o.radius) + SEPARATION_STEER_RANGE;
    if (!(d < range) || !(d > COINCIDENT)) continue;
    const w = (range - d) / range;
    x += (dx / d) * w;
    z += (dz / d) * w;
  }
  return capLength({ x, z }, 1);
}

/**
 * The CollisionResolve spacing pass: every pair whose vertical spans overlap and whose horizontal centre distance
 * is below `spacingFor(ra, rb)` is pushed apart half each along the line between them (coincident pairs along ±X),
 * repeated until no pair is too close or SPACING_ITERATIONS passes ran. Returns the new x / z, index-aligned.
 */
export function separateBodies(bodies: readonly SpacingBody[], iterations = SPACING_ITERATIONS): Planar[] {
  const pos = bodies.map((b) => ({ x: b.x, z: b.z }));
  for (let pass = 0; pass < iterations; pass++) {
    let pushed = false;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i] as SpacingBody;
      const pa = pos[i] as { x: number; z: number };
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j] as SpacingBody;
        const pb = pos[j] as { x: number; z: number };
        const need = spacingFor(a.radius, b.radius);
        const dx = pb.x - pa.x;
        const dz = pb.z - pa.z;
        if (Math.abs(dx) >= need || Math.abs(dz) >= need || !sharesHeight(a, b)) continue;
        const d = Math.hypot(dx, dz);
        if (d >= need - SPACING_TOLERANCE) continue;
        const ux = d > COINCIDENT ? dx / d : 1;
        const uz = d > COINCIDENT ? dz / d : 0;
        const half = (need - d) / 2;
        pa.x -= ux * half;
        pa.z -= uz * half;
        pb.x += ux * half;
        pb.z += uz * half;
        pushed = true;
      }
    }
    if (!pushed) break;
  }
  return pos;
}

// ── Terrain probes (Req 28.8) ───────────────────────────────────────────────

/** Probe points lie this far (m) ahead of the feet… */
export const PROBE_DISTANCE = 1.5;
/** …straight toward the goal and this many degrees to either side. */
export const PROBE_SIDE_DEG = 40;
export const PROBE_SIDE_RAD = PROBE_SIDE_DEG * DEG2RAD;
/** A probe point is blocked by ground more than this far (m) below the feet… */
export const PROBE_MAX_DROP = 2.5;
/** …a terrain slope steeper than this (degrees)… */
export const PROBE_MAX_SLOPE_DEG = 50;
/** …water deeper than this (m)… */
export const PROBE_MAX_WATER = 1;
/** …lying outside the play boundary, or a solid hit within PROBE_DISTANCE by a ray at this fraction of the height. */
export const WAIST_HEIGHT_FRACTION = 0.5;

/** What the EnemySystem measured at one probe point. */
export interface ProbeSample {
  /** Feet height minus the ground height at the point (m; positive when the ground there is lower). */
  readonly drop: number;
  readonly slopeDeg: number;
  readonly waterDepth: number;
  /** The point lies inside the play boundary. */
  readonly inside: boolean;
  /** The waist-height ray hit a solid obstacle within PROBE_DISTANCE. */
  readonly obstacle: boolean;
}

/** Whether a probe point is blocked (Req 28.8). Non-finite measurements do not block. */
export function probeBlocked(s: ProbeSample): boolean {
  return s.drop > PROBE_MAX_DROP || s.slopeDeg > PROBE_MAX_SLOPE_DEG || s.waterDepth > PROBE_MAX_WATER || !s.inside
    || s.obstacle;
}

/** A probe direction: 0 straight toward the goal, ±1 the ±PROBE_SIDE_DEG side (yaw sense). */
export type ProbeChoice = -1 | 0 | 1;

/**
 * The open probe direction closest to the goal (Req 28.8): straight on when open, else a side; when both sides
 * are open the `previous` side wins (a straight previous choice defers to `fallback`). Null when all three are
 * blocked: the enemy only turns toward the goal. `blocked` is asked lazily, straight first, at most once each.
 */
export function chooseProbe(
  blocked: (choice: ProbeChoice) => boolean,
  previous: ProbeChoice,
  fallback: 1 | -1,
): ProbeChoice | null {
  if (!blocked(0)) return 0;
  const first: 1 | -1 = previous === 0 ? fallback : previous;
  if (!blocked(first)) return first;
  const second: 1 | -1 = first === 1 ? -1 : 1;
  return blocked(second) ? null : second;
}

// ── Progress (Req 28.8, 20.7) ───────────────────────────────────────────────

/** An approach that closes less than STUCK_MIN_PROGRESS (m) on its goal in STUCK_SECONDS (s) is stuck. */
export const STUCK_SECONDS = 2;
export const STUCK_MIN_PROGRESS = 0.5;

/** Seconds and metres closed on the goal since the window last started. */
export interface ProgressWindow {
  readonly t: number;
  readonly closed: number;
}

export const FRESH_PROGRESS: ProgressWindow = { t: 0, closed: 0 };

/** One tick of an approach that closed `closed` m on its goal in `dt` s; the window restarts once it has 0.5 m. */
export function advanceProgress(w: ProgressWindow, closed: number, dt: number): ProgressWindow {
  const sum = w.closed + (Number.isFinite(closed) ? closed : 0);
  return sum >= STUCK_MIN_PROGRESS - EPS ? FRESH_PROGRESS : { t: w.t + dt, closed: sum };
}

/** Whether the window ran STUCK_SECONDS without STUCK_MIN_PROGRESS. */
export function progressStalled(w: ProgressWindow): boolean {
  return w.t >= STUCK_SECONDS - EPS;
}
