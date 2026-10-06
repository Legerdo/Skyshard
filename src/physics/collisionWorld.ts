// Collision world: heightfield terrain + primitive colliders behind one query API
// (design "World·Terrain·Collision"; Req 20.1, 20.3, 18.9, 16.7). Pure TypeScript: imports only
// src/core and src/physics (no three.js / DOM / Math.random). Conventions are in ./types.ts.
//
// Terrain contact uses the dilated height M(cx, cz) = max over the disk ρ ≤ r of h(p) + √(r² − ρ²):
// a sphere of radius r centred at c is clear of the ground iff c.y ≥ M. A heightfield has no
// overhangs, so the capsule's bottom sphere decides for the whole capsule. M is estimated from
// real disk samples (centre, a ring at 0.7 r, fixed-point refinements), so it never
// overestimates: a sphere that is actually clear is never reported blocked.
//
// NaN policy (design: "NaN·Infinity 결과는 버리고 직전 값을 쓴다"): each query method keeps its own
// last valid result (null included). Invalid input (non-finite numbers, negative radius, zero
// ray direction, negative maxDist / maxDrop), a non-finite terrain height or collider kernel
// value, or a result holding any non-finite number returns that method's last valid result
// (null, or [] for overlapCapsule, before the first valid call). The fallback is kept per method
// and per world, not per caller: callers sharing a world share it.

import { isFiniteV3 } from '../core/math';
import type { Vec3 } from '../core/types';
import { heightGradient, isWalkableSlope, normalFromGradient, slopeDegFromNormal } from './heightfield';
import { closestPointOnShape, closestToVerticalSegment, isValidShape, raycastShape, shapeBounds, type ShapeProximity } from './primitives';
import { SpatialHash, type XZBounds } from './spatialHash';
import {
  DEFAULT_GROUND_PROBE_RADIUS,
  type Collider,
  type CollisionWorld,
  type Contact,
  type GroundHit,
  type Heightfield,
  type QueryFilter,
  type RayHit,
  type SurfaceHit,
  type SweepHit,
} from './types';

/** A gap (m) at or below this counts as touching in collider sweeps and ground probes. */
export const CONTACT_TOLERANCE = 1e-4;
/** A move approaches a surface only when dot(normal, move) < −APPROACH_REL · |move|. */
const APPROACH_REL = 1e-6;
/** Newton conservative-advancement iterations per collider sweep. */
const MAX_ADVANCE_ITERS = 32;
/** Terrain sweep march step: max(r, this) metres of travel. */
const TERRAIN_SWEEP_MIN_STEP = 0.05;
const TERRAIN_SWEEP_BISECTIONS = 12;
/** Terrain sweeps block once φ = centre.y − M drops below −TERRAIN_BLOCK_EPS (or φ0 − it when starting overlapped). */
const TERRAIN_BLOCK_EPS = 1e-4;
/** Terrain raycast march step (m) and bisections. */
const RAY_TERRAIN_STEP = 1;
const RAY_TERRAIN_BISECTIONS = 24;
/** Safety cap on terrain march steps (very long sweeps / rays take proportionally longer steps). */
const MAX_MARCH_STEPS = 16384;
/** Dilated-height sampling: 8 ring points at 0.7 r, 2 fixed-point refinements, 1e-4 m ties. */
const DILATE_RING_FRACTION = 0.7;
const DILATE_REFINE_ITERS = 2;
const DILATE_TIE_EPS = 1e-4;
/** A ground probe's start contact counts as ground only when its normal has at least this y. */
const GROUND_MIN_NORMAL_Y = 0.1;
/** oneWay colliders block only through contacts whose normal has at least this y (their top). */
const ONE_WAY_MIN_NORMAL_Y = 0.5;
/** closestSurface terrain search: Gauss-Newton iterations and step halvings. */
const SURFACE_GN_ITERS = 12;
const SURFACE_GN_HALVINGS = 6;

const RING_COS: readonly number[] = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2];
const RING_SIN: readonly number[] = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2];

/** Thrown internally when a terrain height or kernel value is non-finite; caught by guard(). */
class NonFiniteSignal {}
const NON_FINITE = new NonFiniteSignal();

interface Entry {
  readonly c: Collider;
  readonly dynamic: boolean;
  readonly minY: number;
  readonly maxY: number;
}

/** Maximiser of the dilated height: M and the disk point (x, z) that attains it. */
interface Dilated {
  m: number;
  x: number;
  z: number;
}

interface Advance {
  t: number;
  prox: ShapeProximity;
}

interface Slot<R> {
  last: R;
}

const fin = Number.isFinite;

function finV3(a: Readonly<Vec3> | null | undefined): a is Vec3 {
  return a !== null && typeof a === 'object' && isFiniteV3(a);
}

function dotV(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

const cp = (a: Readonly<Vec3>): Vec3 => ({ x: a.x, y: a.y, z: a.z });

/** True when every number reachable in the value is finite. */
function allFinite(v: unknown): boolean {
  if (typeof v === 'number') return fin(v);
  if (v === null || typeof v !== 'object') return true;
  for (const k in v) if (!allFinite((v as Record<string, unknown>)[k])) return false;
  return true;
}

/** Deep copy of a plain result value (objects, arrays, primitives). */
function cloneResult<R>(v: R): R {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneResult) as R;
  const out: Record<string, unknown> = {};
  for (const k in v) out[k] = cloneResult((v as Record<string, unknown>)[k]);
  return out as R;
}

/** Runs a query under the NaN policy (see file header). */
function guard<R>(slot: Slot<R>, ok: boolean, compute: () => R): R {
  if (!ok) return cloneResult(slot.last);
  let result: R;
  try {
    result = compute();
  } catch (err) {
    if (err === NON_FINITE) return cloneResult(slot.last);
    throw err;
  }
  if (!allFinite(result)) return cloneResult(slot.last);
  slot.last = cloneResult(result);
  return result;
}

function isValidCollider(c: Collider): boolean {
  return (
    c !== null &&
    typeof c === 'object' &&
    typeof c.id === 'number' &&
    fin(c.id) &&
    c.flags !== null &&
    typeof c.flags === 'object' &&
    isValidShape(c)
  );
}

/** Deep copy so later edits to the caller's object cannot desync the hash. */
function cloneCollider(c: Collider): Collider {
  const meta = { id: c.id, flags: { ...c.flags } };
  switch (c.kind) {
    case 'aabb':
      return { kind: 'aabb', min: cp(c.min), max: cp(c.max), ...meta };
    case 'obb':
      return { kind: 'obb', center: cp(c.center), half: cp(c.half), yaw: c.yaw, ...meta };
    case 'cylinder':
      return { kind: 'cylinder', base: cp(c.base), radius: c.radius, height: c.height, ...meta };
    case 'sphere':
      return { kind: 'sphere', center: cp(c.center), radius: c.radius, ...meta };
    case 'capsule':
      return { kind: 'capsule', a: cp(c.a), b: cp(c.b), radius: c.radius, ...meta };
  }
}

function makeEntry(c: Collider, dynamic: boolean): { entry: Entry; xz: XZBounds } {
  const copy = cloneCollider(c);
  const b = shapeBounds(copy);
  return {
    entry: { c: copy, dynamic, minY: b.min.y, maxY: b.max.y },
    xz: { minX: b.min.x, minZ: b.min.z, maxX: b.max.x, maxZ: b.max.z },
  };
}

/** Mask + exclude test (the terrain always participates and is not filtered here). */
function passes(c: Collider, f: QueryFilter | undefined): boolean {
  if (f === undefined || f === null) return true;
  if (f.mask === 'camera' && !c.flags.blocksCamera) return false;
  if (f.mask === 'climb' && !c.flags.climbable) return false;
  const ex = f.exclude;
  return !(Array.isArray(ex) && ex.includes(c.id));
}

/** Tie-break rank: the terrain (null) first, then ascending collider id. */
const rank = (id: number | null): number => (id === null ? -Infinity : id);

function byDepth(a: Contact, b: Contact): number {
  if (a.depth !== b.depth) return b.depth - a.depth;
  const ra = rank(a.colliderId);
  const rb = rank(b.colliderId);
  return ra < rb ? -1 : ra > rb ? 1 : 0;
}

/** Closest features with a finiteness check (kernels may overflow on extreme input). */
function segProx(c: Collider, x: number, z: number, y0: number, y1: number): ShapeProximity {
  const p = closestToVerticalSegment(c, x, z, y0, y1);
  if (!fin(p.distance) || !isFiniteV3(p.normal) || !isFiniteV3(p.point)) throw NON_FINITE;
  return p;
}

/**
 * Newton conservative advancement of the vertical segment (x, yLo..yHi, z) moving by D·t toward a
 * convex shape: t += gap / −dot(n, D). The start must be more than CONTACT_TOLERANCE + r apart
 * (prox0). Null when the segment never comes within r for t ≤ tMax. Distance to a convex shape
 * is convex along a straight move, so every step stays at or before the first contact.
 */
function advance(
  c: Collider,
  x: number,
  z: number,
  yLo: number,
  yHi: number,
  r: number,
  D: Readonly<Vec3>,
  lenD: number,
  prox0: ShapeProximity,
  tMax: number,
): Advance | null {
  const eps = APPROACH_REL * lenD;
  let t = 0;
  let prox = prox0;
  let gap = prox.distance - r;
  for (let i = 0; i < MAX_ADVANCE_ITERS; i++) {
    const dn = dotV(prox.normal, D);
    if (dn >= -eps) return null;
    t += gap / -dn;
    if (!(t <= tMax)) return null;
    prox = segProx(c, x + D.x * t, z + D.z * t, yLo + D.y * t, yHi + D.y * t);
    gap = prox.distance - r;
    if (gap <= CONTACT_TOLERANCE) return { t, prox };
  }
  // Still converging (a near-tangent approach): report the conservative contact reached so far.
  return { t, prox };
}

/**
 * First contact of a capsule core segment (feet `from`, radius r, core length coreLen) moving by D
 * with one collider. Start contact: a hit at t = 0 only when moving into the shape, else skipped.
 * oneWay: only when the core segment starts outside and the contact normal has y ≥ 0.5.
 */
function sweepCollider(e: Entry, from: Readonly<Vec3>, D: Readonly<Vec3>, lenD: number, r: number, coreLen: number, tMax: number): Advance | null {
  const c = e.c;
  const yLo = from.y + r;
  const yHi = yLo + coreLen;
  const prox0 = segProx(c, from.x, from.z, yLo, yHi);
  const oneWay = c.flags.oneWay === true;
  if (oneWay && prox0.distance < 0) return null;
  let hit: Advance | null;
  if (prox0.distance - r <= CONTACT_TOLERANCE) {
    hit = dotV(prox0.normal, D) < -APPROACH_REL * lenD ? { t: 0, prox: prox0 } : null;
  } else {
    hit = advance(c, from.x, from.z, yLo, yHi, r, D, lenD, prox0, tMax);
  }
  if (hit !== null && oneWay && hit.prox.normal.y < ONE_WAY_MIN_NORMAL_Y) return null;
  return hit;
}

/**
 * Creates a collision world over `terrain`. Static colliders are hashed once; dynamic colliders
 * live in their own map + hash and are re-hashed only by upsertDynamic / removeDynamic. Collider
 * ids are unique across both sets. Every query tests the terrain and the colliders and returns the
 * nearest result (ties: terrain first, then the lowest collider id).
 */
export function createCollisionWorld<T extends Heightfield>(terrain: T): CollisionWorld<T> {
  const statics = new SpatialHash<Entry>();
  const dynamicHash = new SpatialHash<Entry>();
  const dynamics = new Map<number, Entry>();

  const hAt = (x: number, z: number): number => {
    const y = terrain.heightAt(x, z);
    if (!fin(y)) throw NON_FINITE;
    return y;
  };
  /** Terrain view whose heightAt signals non-finite heights. */
  const checked: Heightfield = {
    heightAt: hAt,
    materialAt: (x, z) => terrain.materialAt(x, z),
    walkable: (x, z) => terrain.walkable(x, z),
  };
  /** Terrain normal from ±0.05 m central differences. */
  const terrainNormal = (x: number, z: number): Vec3 => normalFromGradient(heightGradient(checked, x, z));

  /** Dilated height M at (cx, cz) for radius r, with its maximiser (see file header). */
  function dilate(cx: number, cz: number, r: number): Dilated {
    let bx = cx;
    let bz = cz;
    let bv = hAt(cx, cz) + r;
    let bny = NaN; // normal y of the chosen maximiser, computed lazily on ties
    let max = bv;
    const consider = (x: number, z: number, v: number): void => {
      if (v > max) max = v;
      if (x === bx && z === bz) return;
      if (v > bv + DILATE_TIE_EPS) {
        bx = x;
        bz = z;
        bv = v;
        bny = NaN;
        return;
      }
      if (v < bv - DILATE_TIE_EPS) return;
      if (Number.isNaN(bny)) bny = terrainNormal(bx, bz).y;
      const ny = terrainNormal(x, z).y;
      if (ny > bny) {
        bx = x;
        bz = z;
        bv = v;
        bny = ny;
      }
    };
    if (r > 0) {
      const rr = DILATE_RING_FRACTION * r;
      const lift = r * Math.sqrt(1 - DILATE_RING_FRACTION * DILATE_RING_FRACTION);
      let ringX = cx;
      let ringZ = cz;
      let ringV = -Infinity;
      for (let k = 0; k < RING_COS.length; k++) {
        const x = cx + rr * RING_COS[k];
        const z = cz + rr * RING_SIN[k];
        const v = hAt(x, z) + lift;
        if (v > ringV) {
          ringV = v;
          ringX = x;
          ringZ = z;
        }
        consider(x, z, v);
      }
      // Fixed point of "the sphere touches where the surface normal points at the centre":
      // p = c + r·G / √(1 + |G|²), G = ∇h(p).
      const refine = (sx: number, sz: number): void => {
        let px = sx;
        let pz = sz;
        for (let i = 0; i < DILATE_REFINE_ITERS; i++) {
          const g = heightGradient(checked, px, pz);
          const k = r / Math.sqrt(1 + g.dx * g.dx + g.dz * g.dz);
          px = cx + g.dx * k;
          pz = cz + g.dz * k;
          const ox = px - cx;
          const oz = pz - cz;
          consider(px, pz, hAt(px, pz) + Math.sqrt(Math.max(0, r * r - ox * ox - oz * oz)));
        }
      };
      refine(cx, cz);
      refine(ringX, ringZ);
    }
    if (!fin(max)) throw NON_FINITE;
    return { m: max, x: bx, z: bz };
  }

  /** Surface point at a dilated-height maximiser. */
  const terrainPoint = (d: Dilated): Vec3 => ({ x: d.x, y: hAt(d.x, d.z), z: d.z });

  /** Colliders whose bounds overlap the box and pass the filter, statics then dynamics (each in id order). */
  function candidates(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, f: QueryFilter | undefined): Entry[] {
    const b: XZBounds = { minX, minZ, maxX, maxZ };
    const out: Entry[] = [];
    statics.queryAabb(b, out);
    dynamicHash.queryAabb(b, out);
    let w = 0;
    for (const e of out) if (e.maxY >= minY && e.minY <= maxY && passes(e.c, f)) out[w++] = e;
    out.length = w;
    return out;
  }

  /**
   * Terrain sweep of a sphere of radius r whose bottom moves from `from` by D·t:
   * φ(t) = from.y + r + D.y·t − M(path(t)), marched in max(r, 0.05) m steps then bisected.
   * Returns lo, the last t with φ at or above the blocking threshold (the reported contact), and
   * hi, the first blocked t, whose maximiser supplies the contact point and normal: at lo a flat
   * floor can tie with the blocking surface and win the normal-y tie-break. Null when unblocked.
   */
  function terrainSweep(from: Readonly<Vec3>, D: Readonly<Vec3>, lenD: number, r: number): { lo: number; hi: number } | null {
    if (lenD === 0) return null;
    const phi = (t: number): number => from.y + r + D.y * t - dilate(from.x + D.x * t, from.z + D.z * t, r).m;
    const steps = Math.min(MAX_MARCH_STEPS, Math.max(1, Math.ceil(lenD / Math.max(r, TERRAIN_SWEEP_MIN_STEP))));
    const phi0 = phi(0);
    // Starting overlapped: only moving deeper blocks; the threshold relaxes once clear.
    let thr = phi0 < 0 ? phi0 - TERRAIN_BLOCK_EPS : -TERRAIN_BLOCK_EPS;
    let prevT = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const p = phi(t);
      if (p < thr) {
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < TERRAIN_SWEEP_BISECTIONS; k++) {
          const mid = 0.5 * (lo + hi);
          if (phi(mid) < thr) hi = mid;
          else lo = mid;
        }
        return { lo, hi };
      }
      if (p >= 0) thr = -TERRAIN_BLOCK_EPS;
      prevT = t;
    }
    return null;
  }

  /** Terrain raycast along a unit direction: 1 m march, 24 bisections; an origin below the surface hits at 0. */
  function terrainRay(o: Readonly<Vec3>, d: Readonly<Vec3>, maxDist: number): RayHit | null {
    const f = (s: number): number => o.y + d.y * s - hAt(o.x + d.x * s, o.z + d.z * s);
    if (f(0) < 0) return { distance: 0, point: cp(o), normal: terrainNormal(o.x, o.z), colliderId: null, dynamic: false };
    if (maxDist === 0) return null;
    const steps = Math.min(MAX_MARCH_STEPS, Math.max(1, Math.ceil(maxDist / RAY_TERRAIN_STEP)));
    let prev = 0;
    for (let i = 1; i <= steps; i++) {
      const s = i === steps ? maxDist : (i * maxDist) / steps;
      if (f(s) <= 0) {
        let lo = prev;
        let hi = s;
        for (let k = 0; k < RAY_TERRAIN_BISECTIONS; k++) {
          const mid = 0.5 * (lo + hi);
          if (f(mid) <= 0) hi = mid;
          else lo = mid;
        }
        const point = { x: o.x + d.x * hi, y: o.y + d.y * hi, z: o.z + d.z * hi };
        return { distance: hi, point, normal: terrainNormal(point.x, point.z), colliderId: null, dynamic: false };
      }
      prev = s;
    }
    return null;
  }

  /** Gauss-Newton on |p − (x, h(x, z), z)|² from (x, z), with step halving. */
  function surfaceNewton(p: Readonly<Vec3>, x: number, z: number): { x: number; y: number; z: number; d2: number } {
    let y = hAt(x, z);
    let d2 = (x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2;
    for (let it = 0; it < SURFACE_GN_ITERS; it++) {
      const g = heightGradient(checked, x, z);
      const ry = y - p.y;
      const bx = x - p.x + g.dx * ry;
      const bz = z - p.z + g.dz * ry;
      const det = 1 + g.dx * g.dx + g.dz * g.dz;
      let sx = -((1 + g.dz * g.dz) * bx - g.dx * g.dz * bz) / det;
      let sz = -((1 + g.dx * g.dx) * bz - g.dx * g.dz * bx) / det;
      let moved = false;
      for (let h = 0; h < SURFACE_GN_HALVINGS && !moved; h++) {
        const nx = x + sx;
        const nz = z + sz;
        const ny = hAt(nx, nz);
        const nd2 = (nx - p.x) ** 2 + (ny - p.y) ** 2 + (nz - p.z) ** 2;
        if (nd2 < d2) {
          x = nx;
          z = nz;
          y = ny;
          d2 = nd2;
          moved = true;
        } else {
          sx *= 0.5;
          sz *= 0.5;
        }
      }
      if (!moved || sx * sx + sz * sz < 1e-14) break;
    }
    return { x, y, z, d2 };
  }

  /** Nearest terrain point to p: best 2 of 17 samples (centre, rings at 0.5 and 1.0 radius) refined by Gauss-Newton. */
  function terrainClosest(p: Readonly<Vec3>, radius: number): SurfaceHit {
    const xs: number[] = [p.x];
    const zs: number[] = [p.z];
    for (const f of [0.5, 1]) {
      for (let k = 0; k < RING_COS.length; k++) {
        xs.push(p.x + f * radius * RING_COS[k]);
        zs.push(p.z + f * radius * RING_SIN[k]);
      }
    }
    const d2s = xs.map((x, i) => (x - p.x) ** 2 + (hAt(x, zs[i]) - p.y) ** 2 + (zs[i] - p.z) ** 2);
    const order = d2s.map((_, i) => i).sort((a, b) => d2s[a] - d2s[b] || a - b);
    let best = surfaceNewton(p, xs[order[0]], zs[order[0]]);
    const second = surfaceNewton(p, xs[order[1]], zs[order[1]]);
    if (second.d2 < best.d2) best = second;
    const sign = p.y < hAt(p.x, p.z) ? -1 : 1;
    return {
      distance: sign * Math.sqrt(best.d2),
      point: { x: best.x, y: best.y, z: best.z },
      normal: terrainNormal(best.x, best.z),
      material: terrain.materialAt(best.x, best.z),
      colliderId: null,
      dynamic: false,
    };
  }

  // Per-method last valid results (NaN policy).
  const sweepSlot: Slot<SweepHit | null> = { last: null };
  const overlapSlot: Slot<Contact[]> = { last: [] };
  const raySlot: Slot<RayHit | null> = { last: null };
  const groundSlot: Slot<GroundHit | null> = { last: null };
  const surfaceSlot: Slot<SurfaceHit | null> = { last: null };

  return {
    terrain,

    addStatic(c: Collider): void {
      if (!isValidCollider(c)) throw new TypeError(`addStatic: invalid collider (id ${String(c?.id)})`);
      if (statics.has(c.id) || dynamics.has(c.id)) throw new Error(`addStatic: duplicate collider id ${c.id}`);
      const { entry, xz } = makeEntry(c, false);
      statics.insert(c.id, entry, xz);
    },

    upsertDynamic(c: Collider): boolean {
      if (!isValidCollider(c) || statics.has(c.id)) return false;
      const { entry, xz } = makeEntry(c, true);
      const ok = dynamics.has(c.id) ? dynamicHash.update(c.id, xz, entry) : dynamicHash.insert(c.id, entry, xz);
      if (ok) dynamics.set(c.id, entry);
      return ok;
    },

    removeDynamic(id: number): boolean {
      if (!dynamics.delete(id)) return false;
      dynamicHash.remove(id);
      return true;
    },

    sweepCapsule(from: Vec3, to: Vec3, r: number, h: number, f?: QueryFilter): SweepHit | null {
      return guard(sweepSlot, finV3(from) && finV3(to) && fin(r) && r >= 0 && fin(h), () => {
        const hEff = Math.max(h, 2 * r);
        const D = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
        const lenD = Math.sqrt(D.x * D.x + D.y * D.y + D.z * D.z);
        if (!fin(lenD)) throw NON_FINITE;
        const makeHit = (t: number, point: Vec3, normal: Vec3, colliderId: number | null, dynamic: boolean): SweepHit => ({
          t,
          distance: t * lenD,
          position: { x: from.x + D.x * t, y: from.y + D.y * t, z: from.z + D.z * t },
          point,
          normal,
          colliderId,
          dynamic,
        });
        let best: SweepHit | null = null;
        const tt = terrainSweep(from, D, lenD, r);
        if (tt !== null) {
          const d = dilate(from.x + D.x * tt.hi, from.z + D.z * tt.hi, r);
          best = makeHit(tt.lo, terrainPoint(d), terrainNormal(d.x, d.z), null, false);
        }
        const cands = candidates(
          Math.min(from.x, to.x) - r,
          Math.min(from.y, to.y),
          Math.min(from.z, to.z) - r,
          Math.max(from.x, to.x) + r,
          Math.max(from.y, to.y) + hEff,
          Math.max(from.z, to.z) + r,
          f,
        );
        for (const e of cands) {
          const hit = sweepCollider(e, from, D, lenD, r, hEff - 2 * r, best === null ? 1 : best.t);
          if (hit === null) continue;
          if (best !== null && !(hit.t < best.t || (hit.t === best.t && e.c.id < rank(best.colliderId)))) continue;
          best = makeHit(hit.t, cp(hit.prox.point), cp(hit.prox.normal), e.c.id, e.dynamic);
        }
        return best;
      });
    },

    overlapCapsule(pos: Vec3, r: number, h: number, f?: QueryFilter): Contact[] {
      return guard(overlapSlot, finV3(pos) && fin(r) && r >= 0 && fin(h), () => {
        const hEff = Math.max(h, 2 * r);
        const out: Contact[] = [];
        const d = dilate(pos.x, pos.z, r);
        const depth = d.m - (pos.y + r);
        if (depth > 0) out.push({ depth, point: terrainPoint(d), normal: terrainNormal(d.x, d.z), colliderId: null, dynamic: false });
        const yLo = pos.y + r;
        const yHi = pos.y + hEff - r;
        for (const e of candidates(pos.x - r, pos.y, pos.z - r, pos.x + r, pos.y + hEff, pos.z + r, f)) {
          if (e.c.flags.oneWay === true) continue;
          const p = segProx(e.c, pos.x, pos.z, yLo, yHi);
          const pen = r - p.distance;
          if (pen > 0) out.push({ depth: pen, point: cp(p.point), normal: cp(p.normal), colliderId: e.c.id, dynamic: e.dynamic });
        }
        return out.sort(byDepth);
      });
    },

    raycast(origin: Vec3, dir: Vec3, maxDist: number, f?: QueryFilter): RayHit | null {
      const len = finV3(dir) ? Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) : NaN;
      return guard(raySlot, finV3(origin) && fin(len) && len > 0 && fin(maxDist) && maxDist >= 0, () => {
        const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
        let best = terrainRay(origin, d, maxDist);
        let bestDist = best === null ? Infinity : best.distance;
        let bestRank = best === null ? Infinity : -Infinity;
        // oneWay colliders block a ray only from outside, through their top (normal y ≥ 0.5).
        const visit = (e: Entry): number => {
          const c = e.c;
          if (!passes(c, f)) return bestDist;
          const oneWay = c.flags.oneWay === true;
          if (oneWay && closestPointOnShape(c, origin).distance < 0) return bestDist;
          const hit = raycastShape(c, origin, d, Math.min(bestDist, maxDist));
          if (hit === null || (oneWay && hit.normal.y < ONE_WAY_MIN_NORMAL_Y)) return bestDist;
          if (hit.t < bestDist || (hit.t === bestDist && c.id < bestRank)) {
            bestDist = hit.t;
            bestRank = c.id;
            best = { distance: hit.t, point: cp(hit.point), normal: cp(hit.normal), colliderId: c.id, dynamic: e.dynamic };
          }
          return bestDist;
        };
        statics.queryRay(origin.x, origin.z, d.x, d.z, maxDist, visit);
        dynamicHash.queryRay(origin.x, origin.z, d.x, d.z, maxDist, visit);
        return best;
      });
    },

    /**
     * Drops a sphere of `radius` whose bottom is at `pos`. distance is the drop until it touches
     * (negative when embedded) and point = (pos.x, pos.y − distance, pos.z), where the feet rest;
     * on flat ground that is the surface point below. normal, material and hazard come from the
     * touched surface. The terrain reports no hazard (Heightfield has none).
     */
    groundProbe(pos: Vec3, maxDrop: number, radius: number = DEFAULT_GROUND_PROBE_RADIUS): GroundHit | null {
      return guard(groundSlot, finV3(pos) && fin(maxDrop) && maxDrop >= 0 && fin(radius) && radius >= 0, () => {
        const cy = pos.y + radius;
        let best: GroundHit | null = null;
        const d = dilate(pos.x, pos.z, radius);
        const gap = cy - d.m;
        if (gap <= maxDrop) {
          const normal = terrainNormal(d.x, d.z);
          const slopeDeg = slopeDegFromNormal(normal);
          best = {
            distance: gap,
            point: { x: pos.x, y: pos.y - gap, z: pos.z },
            normal,
            slopeDeg,
            material: terrain.materialAt(d.x, d.z),
            walkable: terrain.walkable(d.x, d.z) && isWalkableSlope(slopeDeg),
            hazard: null,
            colliderId: null,
            dynamic: false,
          };
        }
        const D = { x: 0, y: -maxDrop, z: 0 };
        for (const e of candidates(pos.x - radius, pos.y - maxDrop, pos.z - radius, pos.x + radius, pos.y + 2 * radius, pos.z + radius, undefined)) {
          const c = e.c;
          const oneWay = c.flags.oneWay === true;
          const prox0 = segProx(c, pos.x, pos.z, cy, cy);
          if (oneWay && prox0.distance < 0) continue;
          const gap0 = prox0.distance - radius;
          let dist: number;
          let prox: ShapeProximity;
          if (gap0 <= CONTACT_TOLERANCE) {
            if (prox0.normal.y < GROUND_MIN_NORMAL_Y) continue;
            dist = gap0 / prox0.normal.y;
            prox = prox0;
          } else {
            const hit = advance(c, pos.x, pos.z, cy, cy, radius, D, maxDrop, prox0, 1);
            if (hit === null) continue;
            dist = hit.t * maxDrop;
            prox = hit.prox;
          }
          if ((oneWay && prox.normal.y < ONE_WAY_MIN_NORMAL_Y) || dist > maxDrop) continue;
          if (best !== null && !(dist < best.distance || (dist === best.distance && c.id < rank(best.colliderId)))) continue;
          const normal = cp(prox.normal);
          const slopeDeg = slopeDegFromNormal(normal);
          best = {
            distance: dist,
            point: { x: pos.x, y: pos.y - dist, z: pos.z },
            normal,
            slopeDeg,
            material: c.flags.material,
            walkable: c.flags.walkableTop && isWalkableSlope(slopeDeg),
            hazard: c.flags.hazard ?? null,
            colliderId: c.id,
            dynamic: e.dynamic,
          };
        }
        return best;
      });
    },

    /** Nearest surface (smallest |distance| ≤ radius) to p; distance is negative inside a collider or below the terrain. */
    closestSurface(p: Vec3, radius: number, f: QueryFilter): SurfaceHit | null {
      return guard(surfaceSlot, finV3(p) && fin(radius) && radius >= 0, () => {
        const t = terrainClosest(p, radius);
        let best: SurfaceHit | null = Math.abs(t.distance) <= radius ? t : null;
        for (const e of candidates(p.x - radius, p.y - radius, p.z - radius, p.x + radius, p.y + radius, p.z + radius, f)) {
          const q = segProx(e.c, p.x, p.z, p.y, p.y);
          const ad = Math.abs(q.distance);
          if (ad > radius) continue;
          if (best !== null) {
            const bd = Math.abs(best.distance);
            if (!(ad < bd || (ad === bd && e.c.id < rank(best.colliderId)))) continue;
          }
          best = { distance: q.distance, point: cp(q.point), normal: cp(q.normal), material: e.c.flags.material, colliderId: e.c.id, dynamic: e.dynamic };
        }
        return best;
      });
    },
  };
}
