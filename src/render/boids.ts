/*
 * Boids-lite bird flocks (design.md "대기 효과·환경 생물"; Req 39.4). Pure and deterministic (no three.js, no
 * Math.random): a flock of 8–12 birds per Region is seeded once, and `stepFlock` moves it with the classic three rules
 * over the few neighbours in range (cohesion, alignment, separation) plus a pull toward its home point, an altitude
 * band above the ground and a minimum / maximum speed. When the Active_Character sprints within SCATTER_RADIUS of a
 * bird, the flock scatters for SCATTER_SECONDS: every bird flees away from and above the runner, cohesion off.
 * The same seed, inputs and dt sequence always give the same flight.
 */
import { createRng } from '../core/rng';
import type { Vec3 } from '../core/types';

export interface Bird {
  pos: Vec3;
  vel: Vec3;
}

export interface Flock {
  readonly birds: Bird[];
  /** Point the flock circles. */
  home: Vec3;
  /** Seconds of scatter left. */
  scatter: number;
}

export interface FlockParams {
  /** Birds farther than this from home turn back (m). */
  readonly homeRadius: number;
  /** Flight band above the ground (m). */
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly minSpeed: number;
  readonly maxSpeed: number;
  /** Neighbour radius for cohesion / alignment (m). */
  readonly neighbourRadius: number;
  /** Separation starts inside this distance (m). */
  readonly separation: number;
}

export const DEFAULT_FLOCK_PARAMS: FlockParams = {
  homeRadius: 45, minHeight: 14, maxHeight: 34, minSpeed: 6, maxSpeed: 12, neighbourRadius: 14, separation: 2.6,
};

/** A runner at least this fast (m/s, sprint 9) within SCATTER_RADIUS scatters the flock. */
export const SCATTER_SPEED = 7.5;
export const SCATTER_RADIUS = 25;
export const SCATTER_SECONDS = 4;
export const FLOCK_MIN = 8;
export const FLOCK_MAX = 12;

/** The Active_Character as the flock sees it. */
export interface FlockThreat {
  readonly pos: Readonly<Vec3>;
  /** Horizontal speed (m/s). */
  readonly speed: number;
}

/** A seeded flock of 8–12 birds spread around `home` at `groundY + 20` m, circling. */
export function createFlock(seed: number, home: Readonly<Vec3>, groundY = home.y): Flock {
  const rng = createRng(seed);
  const count = rng.int(FLOCK_MIN, FLOCK_MAX);
  const birds: Bird[] = [];
  const heading = rng.range(0, Math.PI * 2);
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(2, 9);
    const speed = rng.range(7, 9);
    const h = heading + rng.range(-0.3, 0.3);
    birds.push({
      pos: { x: home.x + Math.cos(a) * r, y: groundY + 20 + rng.range(-3, 3), z: home.z + Math.sin(a) * r },
      vel: { x: Math.cos(h) * speed, y: 0, z: Math.sin(h) * speed },
    });
  }
  return { birds, home: { x: home.x, y: home.y, z: home.z }, scatter: 0 };
}

const clampLen = (v: Vec3, min: number, max: number): void => {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-9) {
    v.x = min;
    return;
  }
  const k = len > max ? max / len : len < min ? min / len : 1;
  v.x *= k;
  v.y *= k;
  v.z *= k;
};

/** Scratch steering vectors, one per bird (reused between calls). */
const steerScratch: Vec3[] = [];

/**
 * Advances the flock by `dt` s. `groundAt(x, z)` is the terrain height; `threat` the Active_Character (null: none).
 * All birds read the positions of the previous step (steering first, then integration), so the order of the birds
 * does not change the result.
 */
export function stepFlock(
  flock: Flock,
  dt: number,
  groundAt: (x: number, z: number) => number,
  threat: FlockThreat | null,
  params: FlockParams = DEFAULT_FLOCK_PARAMS,
): void {
  if (!(Number.isFinite(dt) && dt > 0)) return;
  const h = Math.min(dt, 0.1);
  const { birds } = flock;
  if (threat !== null && threat.speed >= SCATTER_SPEED) {
    for (const b of birds) {
      const dx = b.pos.x - threat.pos.x;
      const dz = b.pos.z - threat.pos.z;
      const dy = b.pos.y - threat.pos.y;
      if (dx * dx + dy * dy + dz * dz <= SCATTER_RADIUS * SCATTER_RADIUS) {
        flock.scatter = SCATTER_SECONDS;
        break;
      }
    }
  }
  const scattering = flock.scatter > 0;
  const nr2 = params.neighbourRadius * params.neighbourRadius;
  while (steerScratch.length < birds.length) steerScratch.push({ x: 0, y: 0, z: 0 });
  for (let i = 0; i < birds.length; i++) {
    const b = birds[i];
    const s = steerScratch[i];
    s.x = 0;
    s.y = 0;
    s.z = 0;
    let n = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (let j = 0; j < birds.length; j++) {
      if (j === i) continue;
      const o = birds[j];
      const dx = o.pos.x - b.pos.x;
      const dy = o.pos.y - b.pos.y;
      const dz = o.pos.z - b.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > nr2) continue;
      n++;
      cx += o.pos.x;
      cy += o.pos.y;
      cz += o.pos.z;
      ax += o.vel.x;
      ay += o.vel.y;
      az += o.vel.z;
      const d = Math.sqrt(d2);
      if (d < params.separation) {
        // Separation grows as the gap closes.
        const k = (params.separation - d) / Math.max(d, 0.05) * 6;
        s.x -= dx * k;
        s.y -= dy * k;
        s.z -= dz * k;
      }
    }
    if (n > 0) {
      const cohesion = scattering ? 0 : 0.8;
      s.x += (cx / n - b.pos.x) * cohesion;
      s.y += (cy / n - b.pos.y) * cohesion;
      s.z += (cz / n - b.pos.z) * cohesion;
      s.x += (ax / n - b.vel.x) * 1.2;
      s.y += (ay / n - b.vel.y) * 1.2;
      s.z += (az / n - b.vel.z) * 1.2;
    }
    // Home: beyond the radius turn back, inside it drift around it (tangent), so the flock circles.
    const hx = flock.home.x - b.pos.x;
    const hz = flock.home.z - b.pos.z;
    const hd = Math.hypot(hx, hz);
    if (hd > params.homeRadius) {
      const k = (hd - params.homeRadius) / hd * 1.5;
      s.x += hx * k;
      s.z += hz * k;
    } else if (hd > 1e-6) {
      s.x += (-hz / hd) * 1.2 + (hx / hd) * 0.4;
      s.z += (hx / hd) * 1.2 + (hz / hd) * 0.4;
    }
    // Altitude band above the terrain.
    const ground = groundAt(b.pos.x, b.pos.z);
    const lo = ground + params.minHeight;
    const hi = ground + params.maxHeight;
    if (b.pos.y < lo) s.y += (lo - b.pos.y) * 2.5;
    else if (b.pos.y > hi) s.y -= (b.pos.y - hi) * 1.5;
    s.y -= b.vel.y * 0.6; // level flight
    if (scattering && threat !== null) {
      const dx = b.pos.x - threat.pos.x;
      const dz = b.pos.z - threat.pos.z;
      const d = Math.max(1, Math.hypot(dx, dz));
      s.x += (dx / d) * 14;
      s.z += (dz / d) * 14;
      s.y += 6;
    }
  }
  const maxSpeed = scattering ? params.maxSpeed * 1.5 : params.maxSpeed;
  for (let i = 0; i < birds.length; i++) {
    const b = birds[i];
    const s = steerScratch[i];
    b.vel.x += s.x * h;
    b.vel.y += s.y * h;
    b.vel.z += s.z * h;
    clampLen(b.vel, params.minSpeed, maxSpeed);
    b.pos.x += b.vel.x * h;
    b.pos.y += b.vel.y * h;
    b.pos.z += b.vel.z * h;
    const floor = groundAt(b.pos.x, b.pos.z) + 2;
    if (b.pos.y < floor) b.pos.y = floor;
  }
  flock.scatter = Math.max(0, flock.scatter - h);
}
