// Pure per-shape collision kernels: validation, world bounds, exact closest features against
// a point or a vertical segment, and raycasts. No three.js / DOM / Math.random.
// Conventions (Y-up, yaw, outward normals) are documented in ./types.ts.
//
// Kernels assume isValidShape(shape) and finite query numbers; anything else may yield NaN,
// which the collision world's NaN guard drops. raycastShape additionally returns null for
// non-finite input.

import { clamp, clamp01, isFiniteV3 } from '../core/math';
import type { Vec3 } from '../core/types';
import type { ColliderShape } from './types';

/** Largest |value| isValidShape accepts for a coordinate, extent or radius (m). */
export const MAX_SHAPE_COORD = 1e6;

/** A ray starting deeper than this inside a solid hits at t = 0; also the ray-entry tolerance. */
const SURFACE_EPS = 1e-9;
/** Below this length an offset or radial vector has no usable direction. */
const TINY = 1e-12;
/** Direction components below this are treated as parallel to a slab or axis. */
const PARALLEL_EPS = 1e-12;
/** Squared length below which a segment counts as a point. */
const SEG_EPS2 = 1e-18;
/** Two segments count as parallel when sin²(angle) is below this. */
const PARALLEL_REL = 1e-12;

/** World-space axis-aligned box. */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/**
 * Closest features of a solid shape and a query (a point or a vertical segment).
 * Invariant: point = queryPoint − normal · distance.
 */
export interface ShapeProximity {
  /** Point on the shape's surface. For a penetration, where queryPoint lands after the push-out. */
  point: Vec3;
  /** Query point: the point itself, or the segment point nearest the shape (deepest when penetrating). */
  queryPoint: Vec3;
  /** Outward unit normal: moving the query along it increases the separation. */
  normal: Vec3;
  /**
   * Signed separation (m): > 0 apart, 0 touching, < 0 penetrating. When penetrating, moving the
   * query by normal · −distance is a minimum translation that leaves it touching.
   */
  distance: number;
}

export interface ShapeRayHit {
  /** Distance along the unit ray direction, in [0, maxDist]. */
  t: number;
  point: Vec3;
  /** Outward unit normal at the hit (the push-out normal when the ray starts inside). */
  normal: Vec3;
}

// ---------------------------------------------------------------------------
// Validation and bounds
// ---------------------------------------------------------------------------

function okNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_SHAPE_COORD;
}

function okV3(a: Vec3 | null | undefined): a is Vec3 {
  return a !== null && typeof a === 'object' && okNum(a.x) && okNum(a.y) && okNum(a.z);
}

/**
 * True when every number is finite with |value| ≤ MAX_SHAPE_COORD, radii are > 0, extents
 * (obb half sizes, cylinder height) are ≥ 0, aabb min ≤ max per axis and the kind is known.
 */
export function isValidShape(shape: ColliderShape): boolean {
  if (shape === null || typeof shape !== 'object') return false;
  switch (shape.kind) {
    case 'aabb': {
      const { min, max } = shape;
      return okV3(min) && okV3(max) && min.x <= max.x && min.y <= max.y && min.z <= max.z;
    }
    case 'obb': {
      const { center, half, yaw } = shape;
      return okV3(center) && okV3(half) && half.x >= 0 && half.y >= 0 && half.z >= 0 && typeof yaw === 'number' && Number.isFinite(yaw);
    }
    case 'cylinder':
      return okV3(shape.base) && okNum(shape.radius) && shape.radius > 0 && okNum(shape.height) && shape.height >= 0;
    case 'sphere':
      return okV3(shape.center) && okNum(shape.radius) && shape.radius > 0;
    case 'capsule':
      return okV3(shape.a) && okV3(shape.b) && okNum(shape.radius) && shape.radius > 0;
    default:
      return false;
  }
}

/** World-space axis-aligned bounds enclosing the shape (new objects). */
export function shapeBounds(shape: ColliderShape): Aabb {
  switch (shape.kind) {
    case 'aabb':
      return { min: { ...shape.min }, max: { ...shape.max } };
    case 'obb': {
      const { center: o, half: h } = shape;
      const c = Math.abs(Math.cos(shape.yaw));
      const s = Math.abs(Math.sin(shape.yaw));
      const ex = c * h.x + s * h.z;
      const ez = s * h.x + c * h.z;
      return { min: { x: o.x - ex, y: o.y - h.y, z: o.z - ez }, max: { x: o.x + ex, y: o.y + h.y, z: o.z + ez } };
    }
    case 'cylinder': {
      const { base: b, radius: r } = shape;
      return { min: { x: b.x - r, y: b.y, z: b.z - r }, max: { x: b.x + r, y: b.y + shape.height, z: b.z + r } };
    }
    case 'sphere': {
      const { center: o, radius: r } = shape;
      return { min: { x: o.x - r, y: o.y - r, z: o.z - r }, max: { x: o.x + r, y: o.y + r, z: o.z + r } };
    }
    case 'capsule': {
      const { a, b, radius: r } = shape;
      return {
        min: { x: Math.min(a.x, b.x) - r, y: Math.min(a.y, b.y) - r, z: Math.min(a.z, b.z) - r },
        max: { x: Math.max(a.x, b.x) + r, y: Math.max(a.y, b.y) + r, z: Math.max(a.z, b.z) + r },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Closest features
// ---------------------------------------------------------------------------

/** Closest features of the shape and point p (a zero-length vertical segment). */
export function closestPointOnShape(shape: ColliderShape, p: Readonly<Vec3>): ShapeProximity {
  return closestToVerticalSegment(shape, p.x, p.z, p.y, p.y);
}

/**
 * Closest features of the shape and the vertical segment from (x, y0, z) to (x, y1, z)
 * (endpoints in either order). Penetrations report a minimum-translation push-out.
 * Degenerate directions fall back to +Y when that is a minimum translation, else +X;
 * for a capsule whose axis crosses the segment, the horizontal perpendicular of the axis.
 */
export function closestToVerticalSegment(shape: ColliderShape, x: number, z: number, y0: number, y1: number): ShapeProximity {
  const lo = y0 <= y1 ? y0 : y1;
  const hi = y0 <= y1 ? y1 : y0;
  switch (shape.kind) {
    case 'aabb': {
      const { min, max } = shape;
      return boxVsSegment(x, z, lo, hi, min.x, min.y, min.z, max.x, max.y, max.z);
    }
    case 'obb':
      return obbVsSegment(shape.center, shape.half, shape.yaw, x, z, lo, hi);
    case 'cylinder':
      return cylinderVsSegment(shape.base, shape.radius, shape.height, x, z, lo, hi);
    case 'sphere':
      return sphereVsSegment(shape.center, shape.radius, x, z, lo, hi);
    case 'capsule':
      return capsuleVsSegment(shape.a, shape.b, shape.radius, x, z, lo, hi);
  }
}

function prox(
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number,
  nx: number, ny: number, nz: number,
  distance: number,
): ShapeProximity {
  return { point: { x: px, y: py, z: pz }, queryPoint: { x: qx, y: qy, z: qz }, normal: { x: nx, y: ny, z: nz }, distance };
}

/** Separated (or touching) result with offset (dx, dy, dz) = queryPoint − point. */
function apart(
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number,
  dx: number, dy: number, dz: number,
): ShapeProximity {
  // Callers guarantee a non-zero offset. Scaling by the largest component first keeps the
  // direction exact for offsets too small to square (e.g. a point a few ulps off a face).
  const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const sx = dx / m;
  const sy = dy / m;
  const sz = dz / m;
  const l = Math.sqrt(sx * sx + sy * sy + sz * sz);
  return prox(px, py, pz, qx, qy, qz, sx / l, sy / l, sz / l, m * l);
}

/** −depth for a penetration, +0 for touching (never −0). */
function penetration(depth: number): number {
  return depth > 0 ? -depth : 0;
}

/** Scratch for boxVsSegment's six face depths (+Y, −Y, +X, −X, +Z, −Z); kernels are not re-entrant. */
const BOX_DEPTHS = new Float64Array(6);

/** Vertical segment [y0, y1] at (x, z) against the box [min, max], all in the box's frame. */
function boxVsSegment(
  x: number, z: number, y0: number, y1: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): ShapeProximity {
  const cx = clamp(x, minX, maxX);
  const cz = clamp(z, minZ, maxZ);
  // Vertically: the gap between [y0, y1] and [minY, maxY], or the middle of their overlap.
  let gy = 0;
  let qy: number;
  let py: number;
  if (y0 > maxY) {
    gy = y0 - maxY;
    qy = y0;
    py = maxY;
  } else if (y1 < minY) {
    gy = y1 - minY;
    qy = y1;
    py = minY;
  } else {
    qy = py = (Math.max(y0, minY) + Math.min(y1, maxY)) / 2;
  }
  if (x !== cx || z !== cz || gy !== 0) return apart(cx, py, cz, x, qy, z, x - cx, gy, z - cz);

  // Penetrating. Seen from the segment's bottom end the obstacle is the Minkowski box
  // [minX, maxX] × [minY − (y1 − y0), maxY] × [minZ, maxZ]; the minimum translation leaves through
  // its nearest face. Ties prefer +Y, −Y, +X, −X, +Z, −Z.
  const depths = BOX_DEPTHS;
  depths[0] = maxY - y0;
  depths[1] = y1 - minY;
  depths[2] = maxX - x;
  depths[3] = x - minX;
  depths[4] = maxZ - z;
  depths[5] = z - minZ;
  let face = 0;
  for (let i = 1; i < 6; i++) if (depths[i] < depths[face]) face = i;
  const dist = penetration(depths[face]);
  switch (face) {
    case 0:
      return prox(x, maxY, z, x, y0, z, 0, 1, 0, dist);
    case 1:
      return prox(x, minY, z, x, y1, z, 0, -1, 0, dist);
    case 2:
      return prox(maxX, qy, z, x, qy, z, 1, 0, 0, dist);
    case 3:
      return prox(minX, qy, z, x, qy, z, -1, 0, 0, dist);
    case 4:
      return prox(x, qy, maxZ, x, qy, z, 0, 0, 1, dist);
    default:
      return prox(x, qy, minZ, x, qy, z, 0, 0, -1, dist);
  }
}

/** Solves in the box frame (world → local is the inverse yaw rotation), then rotates back. */
function obbVsSegment(o: Vec3, h: Vec3, yaw: number, x: number, z: number, y0: number, y1: number): ShapeProximity {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const wx = x - o.x;
  const wz = z - o.z;
  const r = boxVsSegment(wx * c - wz * s, wx * s + wz * c, y0 - o.y, y1 - o.y, -h.x, -h.y, -h.z, h.x, h.y, h.z);
  const { point: p, normal: n, queryPoint: q } = r;
  // local → world: wx = vx·cos + vz·sin, wz = −vx·sin + vz·cos.
  const px = p.x * c + p.z * s;
  const pz = -p.x * s + p.z * c;
  const nx = n.x * c + n.z * s;
  const nz = -n.x * s + n.z * c;
  p.x = o.x + px;
  p.y += o.y;
  p.z = o.z + pz;
  n.x = nx;
  n.z = nz;
  q.x = x;
  q.y += o.y;
  q.z = z;
  return r;
}

/** Vertical cylinder (base = bottom centre) against a vertical segment: a radial + interval problem. */
function cylinderVsSegment(b: Vec3, r: number, h: number, x: number, z: number, y0: number, y1: number): ShapeProximity {
  const ox = x - b.x;
  const oz = z - b.z;
  const d = Math.sqrt(ox * ox + oz * oz);
  const ux = d > TINY ? ox / d : 1; // radial unit, +X on the axis
  const uz = d > TINY ? oz / d : 0;
  const bottom = b.y;
  const top = b.y + h;
  let gy = 0;
  let qy: number;
  let py: number;
  if (y0 > top) {
    gy = y0 - top;
    qy = y0;
    py = top;
  } else if (y1 < bottom) {
    gy = y1 - bottom;
    qy = y1;
    py = bottom;
  } else {
    qy = py = (Math.max(y0, bottom) + Math.min(y1, top)) / 2;
  }
  const over = d - r;
  if (over > 0) return apart(b.x + ux * r, py, b.z + uz * r, x, qy, z, ux * over, gy, uz * over);
  if (gy !== 0) return apart(x, py, z, x, qy, z, 0, gy, 0);

  // Penetrating: leave through the top, the bottom or the side. Ties prefer +Y, −Y, side.
  const up = top - y0;
  const down = y1 - bottom;
  const side = r - d;
  const face = up <= down && up <= side ? 0 : down <= side ? 1 : 2;
  const dist = penetration(face === 0 ? up : face === 1 ? down : side);
  if (face === 0) return prox(x, top, z, x, y0, z, 0, 1, 0, dist);
  if (face === 1) return prox(x, bottom, z, x, y1, z, 0, -1, 0, dist);
  return prox(b.x + ux * r, qy, b.z + uz * r, x, qy, z, ux, 0, uz, dist);
}

/**
 * Rounded shapes: core point k (on the sphere centre / capsule axis), query point q, radius r.
 * (fx, fy, fz) is the normal to use when q lies on the core.
 */
function rounded(
  kx: number, ky: number, kz: number,
  qx: number, qy: number, qz: number,
  r: number, fx: number, fy: number, fz: number,
): ShapeProximity {
  const dx = qx - kx;
  const dy = qy - ky;
  const dz = qz - kz;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let nx = fx;
  let ny = fy;
  let nz = fz;
  if (len > TINY) {
    nx = dx / len;
    ny = dy / len;
    nz = dz / len;
  }
  return prox(kx + nx * r, ky + ny * r, kz + nz * r, qx, qy, qz, nx, ny, nz, len - r);
}

function sphereVsSegment(c: Vec3, r: number, x: number, z: number, y0: number, y1: number): ShapeProximity {
  const qy = clamp(c.y, y0, y1);
  // Centre on the segment: +Y is a minimum translation only when the centre is at its bottom end.
  const up = c.y - y0 <= TINY;
  return rounded(c.x, c.y, c.z, x, qy, z, r, up ? 0 : 1, up ? 1 : 0, 0);
}

/** Capsule axis a→b against the vertical segment, via Ericson's segment–segment closest points. */
function capsuleVsSegment(a: Vec3, b: Vec3, r: number, x: number, z: number, y0: number, y1: number): ShapeProximity {
  const L = y1 - y0; // query direction d1 = (0, L, 0)
  const ex = b.x - a.x; // axis direction d2
  const ey = b.y - a.y;
  const ez = b.z - a.z;
  const ry = y0 - a.y; // r = p1 − p2
  const A = L * L;
  const E = ex * ex + ey * ey + ez * ez;
  const F = ex * (x - a.x) + ey * ry + ez * (z - a.z);
  let s = 0; // on the query segment
  let t = 0; // on the axis
  if (A <= SEG_EPS2) {
    if (E > SEG_EPS2) t = clamp01(F / E);
  } else {
    const C = L * ry;
    if (E <= SEG_EPS2) {
      s = clamp01(-C / A);
    } else {
      const B = L * ey;
      const denom = A * E - B * B;
      s = denom > PARALLEL_REL * A * E ? clamp01((B * F - C * E) / denom) : 0;
      t = (B * s + F) / E;
      if (t < 0) {
        t = 0;
        s = clamp01(-C / A);
      } else if (t > 1) {
        t = 1;
        s = clamp01((B - C) / A);
      }
    }
  }
  const kx = a.x + ex * t;
  const ky = a.y + ey * t;
  const kz = a.z + ez * t;
  // Axis crossing the segment: separate along the horizontal perpendicular of the axis,
  // +X for a vertical axis, and the sphere rule for a point axis.
  let fx = 1;
  let fy = 0;
  let fz = 0;
  const hl = Math.sqrt(ex * ex + ez * ez);
  if (hl > TINY) {
    fx = ez / hl;
    fz = -ex / hl;
  } else if (E <= SEG_EPS2 && ky - y0 <= TINY) {
    fx = 0;
    fy = 1;
  }
  return rounded(kx, ky, kz, x, y0 + L * s, z, r, fx, fy, fz);
}

// ---------------------------------------------------------------------------
// Raycasts
// ---------------------------------------------------------------------------

interface RayEntry {
  t: number;
  normal: Vec3;
}

type Axis = 'x' | 'y' | 'z';
/** Y first so an exact edge hit reports the top or bottom face. */
const SLAB_AXES: readonly Axis[] = ['y', 'x', 'z'];

/**
 * First hit of origin + t·dir with the solid shape, 0 ≤ t ≤ maxDist; `dir` must be unit length.
 * An origin more than SURFACE_EPS inside hits at t = 0 with the push-out normal. Starting on the
 * surface hits at t = 0 only when entering; moving away or along the surface misses.
 * Non-finite input or maxDist < 0 → null.
 */
export function raycastShape(shape: ColliderShape, origin: Readonly<Vec3>, dir: Readonly<Vec3>, maxDist: number): ShapeRayHit | null {
  if (!isFiniteV3(origin) || !isFiniteV3(dir) || !Number.isFinite(maxDist) || maxDist < 0) return null;
  const start = closestPointOnShape(shape, origin);
  if (!Number.isFinite(start.distance)) return null;
  if (start.distance < -SURFACE_EPS) {
    return isFiniteV3(start.normal) ? { t: 0, point: { x: origin.x, y: origin.y, z: origin.z }, normal: start.normal } : null;
  }
  const hit = rayEntry(shape, origin, dir);
  // An entry behind the origin means the shape is behind the ray or being left.
  if (hit === null || !(hit.t >= -SURFACE_EPS) || hit.t > maxDist || !isFiniteV3(hit.normal)) return null;
  const t = hit.t > 0 ? hit.t : 0;
  return { t, point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t }, normal: hit.normal };
}

/** Where the ray's line enters the solid (t < 0 when behind the origin). */
function rayEntry(shape: ColliderShape, o: Readonly<Vec3>, d: Readonly<Vec3>): RayEntry | null {
  switch (shape.kind) {
    case 'aabb':
      return raySlab(o, d, shape.min, shape.max);
    case 'obb': {
      const { center: m, half: h } = shape;
      const c = Math.cos(shape.yaw);
      const s = Math.sin(shape.yaw);
      const wx = o.x - m.x;
      const wz = o.z - m.z;
      const lo = { x: wx * c - wz * s, y: o.y - m.y, z: wx * s + wz * c };
      const ld = { x: d.x * c - d.z * s, y: d.y, z: d.x * s + d.z * c };
      const hit = raySlab(lo, ld, { x: -h.x, y: -h.y, z: -h.z }, h);
      if (hit === null) return null;
      const n = hit.normal;
      hit.normal = { x: n.x * c + n.z * s, y: n.y, z: -n.x * s + n.z * c };
      return hit;
    }
    case 'sphere':
      return raySphere(o, d, shape.center, shape.radius);
    case 'cylinder':
      return rayCylinder(o, d, shape.base, shape.radius, shape.height);
    case 'capsule': {
      const { a, b, radius: r } = shape;
      return nearer(nearer(raySphere(o, d, a, r), raySphere(o, d, b, r)), rayTube(o, d, a, b, r));
    }
  }
}

function unitOr(x: number, y: number, z: number, fx: number, fy: number, fz: number): Vec3 {
  const len = Math.sqrt(x * x + y * y + z * z);
  return len > TINY ? { x: x / len, y: y / len, z: z / len } : { x: fx, y: fy, z: fz };
}

/** Slab test; the normal is the entry face's. */
function raySlab(o: Readonly<Vec3>, d: Readonly<Vec3>, min: Readonly<Vec3>, max: Readonly<Vec3>): RayEntry | null {
  let tEnter = -Infinity;
  let tExit = Infinity;
  let axis: Axis | null = null;
  for (const k of SLAB_AXES) {
    const dk = d[k];
    if (Math.abs(dk) < PARALLEL_EPS) {
      if (o[k] < min[k] || o[k] > max[k]) return null; // parallel and outside the slab
      continue;
    }
    const tA = (min[k] - o[k]) / dk;
    const tB = (max[k] - o[k]) / dk;
    const tNear = tA < tB ? tA : tB;
    const tFar = tA < tB ? tB : tA;
    if (tNear > tEnter) {
      tEnter = tNear;
      axis = k;
    }
    if (tFar < tExit) tExit = tFar;
    if (tEnter > tExit) return null;
  }
  if (axis === null) return null; // zero direction
  const normal = { x: 0, y: 0, z: 0 };
  normal[axis] = d[axis] > 0 ? -1 : 1;
  return { t: tEnter, normal };
}

function raySphere(o: Readonly<Vec3>, d: Readonly<Vec3>, c: Readonly<Vec3>, r: number): RayEntry | null {
  const mx = o.x - c.x;
  const my = o.y - c.y;
  const mz = o.z - c.z;
  const a = d.x * d.x + d.y * d.y + d.z * d.z;
  if (a < PARALLEL_EPS * PARALLEL_EPS) return null;
  const b = mx * d.x + my * d.y + mz * d.z;
  const disc = b * b - a * (mx * mx + my * my + mz * mz - r * r);
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  return { t, normal: unitOr(mx + d.x * t, my + d.y * t, mz + d.z * t, -d.x, -d.y, -d.z) };
}

/** Vertical cylinder: intersect the t-ranges inside the side and between the caps. */
function rayCylinder(o: Readonly<Vec3>, d: Readonly<Vec3>, base: Readonly<Vec3>, r: number, h: number): RayEntry | null {
  const mx = o.x - base.x;
  const mz = o.z - base.z;
  const a = d.x * d.x + d.z * d.z;
  const c = mx * mx + mz * mz - r * r;
  let tEnter = -Infinity;
  let tExit = Infinity;
  if (a < PARALLEL_EPS * PARALLEL_EPS) {
    if (c > 0) return null; // vertical ray outside the disc
  } else {
    const b = mx * d.x + mz * d.z;
    const disc = b * b - a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    tEnter = (-b - sq) / a;
    tExit = (-b + sq) / a;
  }
  let cap = false;
  if (Math.abs(d.y) < PARALLEL_EPS) {
    if (o.y < base.y || o.y > base.y + h) return null;
  } else {
    const t0 = (base.y - o.y) / d.y;
    const t1 = (base.y + h - o.y) / d.y;
    const near = t0 < t1 ? t0 : t1;
    const far = t0 < t1 ? t1 : t0;
    if (near >= tEnter) {
      tEnter = near; // ties (the rim) report the cap
      cap = true;
    }
    if (far < tExit) tExit = far;
  }
  if (tEnter > tExit || tEnter === -Infinity) return null;
  const normal = cap
    ? { x: 0, y: d.y > 0 ? -1 : 1, z: 0 }
    : unitOr(mx + d.x * tEnter, 0, mz + d.z * tEnter, -d.x, 0, -d.z);
  return { t: tEnter, normal };
}

/** Capsule side: the cylinder of radius r around segment ab, without caps. */
function rayTube(o: Readonly<Vec3>, d: Readonly<Vec3>, a: Readonly<Vec3>, b: Readonly<Vec3>, r: number): RayEntry | null {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  if (len2 < SEG_EPS2) return null;
  const mx = o.x - a.x;
  const my = o.y - a.y;
  const mz = o.z - a.z;
  const ms = (mx * abx + my * aby + mz * abz) / len2;
  const ds = (d.x * abx + d.y * aby + d.z * abz) / len2;
  // Components perpendicular to the axis.
  const mpx = mx - abx * ms;
  const mpy = my - aby * ms;
  const mpz = mz - abz * ms;
  const dpx = d.x - abx * ds;
  const dpy = d.y - aby * ds;
  const dpz = d.z - abz * ds;
  const qa = dpx * dpx + dpy * dpy + dpz * dpz;
  if (qa < PARALLEL_EPS * PARALLEL_EPS) return null; // parallel to the axis: only the caps can be hit
  const qb = mpx * dpx + mpy * dpy + mpz * dpz;
  const disc = qb * qb - qa * (mpx * mpx + mpy * mpy + mpz * mpz - r * r);
  if (disc < 0) return null;
  const t = (-qb - Math.sqrt(disc)) / qa;
  const s = ms + ds * t;
  if (s < 0 || s > 1) return null;
  return { t, normal: unitOr(mpx + dpx * t, mpy + dpy * t, mpz + dpz * t, -d.x, -d.y, -d.z) };
}

function ahead(h: RayEntry | null): h is RayEntry {
  return h !== null && h.t >= -SURFACE_EPS;
}

/** The nearer of two candidate entries, ignoring those behind the origin. */
function nearer(a: RayEntry | null, b: RayEntry | null): RayEntry | null {
  if (!ahead(a)) return ahead(b) ? b : null;
  return ahead(b) && b.t < a.t ? b : a;
}
