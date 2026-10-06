/*
 * Shape builders of the rig kit (design.md "Rig kit"): lathe torsos / coats / skirts, tapered-capsule limbs, mitten
 * hands, round-toed boots, the shaped head with its face plane 2 mm in front, and spline-swept hair clumps. Every
 * builder returns an indexed BufferGeometry in rig space (metres, feet at the origin, +Z forward) with position,
 * normal and uv; the kit adds the skinning, colour and aFx attributes when it merges the parts.
 */
import * as THREE from 'three';
import type { V3 } from './rigTypes';

const UP = new THREE.Vector3(0, 1, 0);

/** Radius-height profile point of a lathe: [radius, y]. */
export type ProfilePoint = readonly [number, number];

export interface LatheOptions {
  readonly segments?: number;
  /** Cross-section scale (flattened torsos: x wider than z). */
  readonly scaleX?: number;
  readonly scaleZ?: number;
  /** Start angle (0 = +Z, the front) and sweep; less than 2π leaves an opening (coat front). */
  readonly phiStart?: number;
  readonly phiLength?: number;
  /** Axis position [x, z]. */
  readonly center?: readonly [number, number];
}

/** LatheGeometry of a bottom-to-top [radius, y] profile around the vertical axis, faces outward. */
export function lathe(profile: readonly ProfilePoint[], opts: LatheOptions = {}): THREE.BufferGeometry {
  const points = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
  const g = new THREE.LatheGeometry(points, opts.segments ?? 14, opts.phiStart ?? 0, opts.phiLength ?? Math.PI * 2);
  g.scale(opts.scaleX ?? 1, 1, opts.scaleZ ?? 1);
  if (opts.center !== undefined) g.translate(opts.center[0], 0, opts.center[1]);
  return g;
}

/** Reverses winding and normals (the inner lining of an open coat or cape). */
export function flipped(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.clone();
  const index = g.getIndex();
  if (index !== null) {
    const a = index.array;
    for (let i = 0; i + 2 < a.length; i += 3) {
      const t = a[i + 1]!;
      a[i + 1] = a[i + 2]!;
      a[i + 2] = t;
    }
    index.needsUpdate = true;
  }
  const normal = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (normal !== undefined) {
    for (let i = 0; i < normal.array.length; i++) (normal.array as Float32Array)[i] = -normal.array[i]!;
  }
  return g;
}

/** Orients a +Y-axis geometry (origin at its base) from `a` toward `b`. */
export function alongSegment(geometry: THREE.BufferGeometry, a: V3, b: V3): THREE.BufferGeometry {
  const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = dir.length();
  if (len > 1e-9) {
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.divideScalar(len));
    geometry.applyQuaternion(q);
  }
  geometry.translate(a[0], a[1], a[2]);
  return geometry;
}

/**
 * Tapered capsule from `a` (radius r0) to `b` (radius r1): two hemispheres joined by a frustum, one lathe profile.
 * `radial` segments around, `caps` rings per hemisphere.
 */
export function taperedCapsule(a: V3, b: V3, r0: number, r1: number, radial = 8, caps = 3): THREE.BufferGeometry {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const profile: ProfilePoint[] = [];
  for (let i = 0; i <= caps; i++) {
    const t = (-Math.PI / 2) + (i / caps) * (Math.PI / 2);
    profile.push([Math.cos(t) * r0, Math.sin(t) * r0]);
  }
  for (let i = 0; i <= caps; i++) {
    const t = (i / caps) * (Math.PI / 2);
    profile.push([Math.cos(t) * r1, len + Math.sin(t) * r1]);
  }
  profile[0] = [0, -r0];
  profile[profile.length - 1] = [0, len + r1];
  return alongSegment(lathe(profile, { segments: radial }), a, b);
}

/** Ellipsoid (a squashed sphere) centred at `c` with radii `r`. */
export function ellipsoid(c: V3, r: V3, widthSegments = 10, heightSegments = 7): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, widthSegments, heightSegments);
  g.scale(r[0], r[1], r[2]);
  g.translate(c[0], c[1], c[2]);
  return g;
}

/** Axis-aligned box centred at `c` (size `s`), for trims, belts and glow cracks. */
export function box(c: V3, s: V3): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(s[0], s[1], s[2]);
  g.translate(c[0], c[1], c[2]);
  return g;
}

/** Mitten hand at the wrist `w` pointing along `side` (±1 on X): palm block plus a thumb toward +Z. */
export function mitten(w: V3, side: 1 | -1, size: number): THREE.BufferGeometry[] {
  const palm = ellipsoid([w[0] + side * size * 0.95, w[1] - size * 0.1, w[2]], [size * 1.0, size * 0.48, size * 0.62], 8, 6);
  const thumb = taperedCapsule(
    [w[0] + side * size * 0.45, w[1] - size * 0.05, w[2] + size * 0.4],
    [w[0] + side * size * 1.05, w[1] - size * 0.1, w[2] + size * 0.75],
    size * 0.26, size * 0.2, 6, 2,
  );
  return [palm, thumb];
}

/** Boot with a rounded toe: ankle cuff at `ankle`, sole on the ground, toe toward +Z. */
export function boot(ankle: V3, size: number): THREE.BufferGeometry[] {
  const y = Math.max(size * 0.45, ankle[1] * 0.55);
  const foot = taperedCapsule([ankle[0], y, ankle[2] - size * 0.35], [ankle[0], y * 0.9, ankle[2] + size * 1.25], size * 0.52, size * 0.46, 8, 3);
  const cuff = lathe(
    [[size * 0.6, y], [size * 0.64, ankle[1] + size * 0.4], [size * 0.58, ankle[1] + size * 1.3]],
    { segments: 10, center: [ankle[0], ankle[2]] },
  );
  return [foot, cuff];
}

/**
 * The shaped head: a sphere narrowed toward the jaw, swollen at the back of the skull. `shape(p)` maps a unit-sphere
 * direction to the head surface, so the face plane (./faceGeometry) follows the same curvature.
 */
export interface HeadShape {
  readonly center: V3;
  readonly radius: number;
  /** Surface point of a unit direction, pushed out by `lift` m. */
  point(dir: THREE.Vector3, lift?: number, out?: THREE.Vector3): THREE.Vector3;
}

export function headShape(center: V3, radius: number, jaw = 0.28, back = 0.12): HeadShape {
  return {
    center,
    radius,
    point(dir, lift = 0, out = new THREE.Vector3()) {
      const r = radius + lift;
      const down = Math.max(0, -dir.y);
      const narrow = 1 - jaw * down * down;
      const z = dir.z < 0 ? dir.z * (1 + back) : dir.z * 1.02;
      return out.set(center[0] + dir.x * r * narrow * 0.94, center[1] + dir.y * r * 1.06, center[2] + z * r * narrow);
    },
  };
}

/** Sphere mesh deformed by a head shape. */
export function headGeometry(shape: HeadShape, widthSegments = 16, heightSegments = 12): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, widthSegments, heightSegments);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    shape.point(d, 0, p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Face plane: a grid over the front of the head (azimuth ±`halfWidth` rad, elevation `bottom`…`top` rad) lifted 2 mm
 * off the shaped surface; uv (0,0) is the chin-left corner, (1,1) the brow-right one (the atlas cell maps onto it).
 */
export function facePlane(shape: HeadShape, halfWidth = 0.95, bottom = -0.62, top = 0.42, segments = 8): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const d = new THREE.Vector3();
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Vector3(...shape.center);
  for (let iy = 0; iy <= segments; iy++) {
    const v = iy / segments;
    const el = bottom + (top - bottom) * v;
    for (let ix = 0; ix <= segments; ix++) {
      const u = ix / segments;
      // u = 0 is the model's right side (−X) as seen from the front, so the atlas is not mirrored.
      const az = (u - 0.5) * 2 * halfWidth;
      d.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
      shape.point(d, 0.002, p);
      positions.push(p.x, p.y, p.z);
      n.copy(p).sub(c).normalize();
      normals.push(n.x, n.y, n.z);
      uvs.push(u, v);
    }
  }
  const row = segments + 1;
  for (let iy = 0; iy < segments; iy++) {
    for (let ix = 0; ix < segments; ix++) {
      const a = iy * row + ix;
      const b = a + 1;
      const cc = a + row;
      const dd = cc + 1;
      indices.push(a, b, dd, a, dd, cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}

export interface SweepOptions {
  /** Radius at the root and at the tip. */
  readonly r0: number;
  readonly r1: number;
  readonly radial?: number;
  readonly samples?: number;
  /** Cross-section squash along the binormal (1 round, < 1 a flat ribbon). */
  readonly flatten?: number;
}

/**
 * Curved cone swept along a CatmullRomCurve3 through `points`, its cross-section shrinking from r0 to r1: one hair
 * clump (round) or ribbon (flattened). Open at both ends: the root sits inside the scalp, the tip is a point.
 */
export function sweep(points: readonly V3[], opts: SweepOptions): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'centripetal');
  const samples = opts.samples ?? 6;
  const radial = opts.radial ?? 5;
  const flatten = opts.flatten ?? 1;
  const frames = curve.computeFrenetFrames(samples, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const c = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    curve.getPointAt(t, c);
    const r = opts.r0 + (opts.r1 - opts.r0) * Math.pow(t, 0.8);
    const N = frames.normals[i]!;
    const B = frames.binormals[i]!;
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      nrm.set(0, 0, 0).addScaledVector(N, cs).addScaledVector(B, sn * flatten);
      positions.push(c.x + nrm.x * r, c.y + nrm.y * r, c.z + nrm.z * r);
      nrm.set(0, 0, 0).addScaledVector(N, cs * flatten).addScaledVector(B, sn).normalize();
      normals.push(nrm.x, nrm.y, nrm.z);
      uvs.push(k / radial, t);
    }
  }
  const row = radial + 1;
  for (let i = 0; i < samples; i++) {
    for (let k = 0; k < radial; k++) {
      const a = i * row + k;
      const b = a + row;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  // Frenet normals can face either way round the curve: make sure faces wind outward.
  return windOutward(g, curve);
}

/** Flips the winding of a swept tube when its first face points toward the curve (normals kept outward). */
function windOutward(g: THREE.BufferGeometry, curve: THREE.CatmullRomCurve3): THREE.BufferGeometry {
  const index = g.getIndex();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  if (index === null || index.count < 3) return g;
  const a = new THREE.Vector3().fromBufferAttribute(pos, index.getX(0));
  const b = new THREE.Vector3().fromBufferAttribute(pos, index.getX(1));
  const c = new THREE.Vector3().fromBufferAttribute(pos, index.getX(2));
  const faceNormal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
  const centre = curve.getPointAt(0);
  const outward = new THREE.Vector3().addVectors(a, b).add(c).divideScalar(3).sub(centre);
  if (faceNormal.dot(outward) >= 0) return g;
  const arr = index.array;
  for (let i = 0; i + 2 < arr.length; i += 3) {
    const t = arr[i + 1]!;
    arr[i + 1] = arr[i + 2]!;
    arr[i + 2] = t;
  }
  return g;
}

/** Flat strip along a polyline (scarf tails, cape panels): `width` across `side`, `thickness` m thick box section. */
export function ribbon(points: readonly V3[], side: V3, width: number, taper = 1, thickness = 0.012): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const s = new THREE.Vector3(...side).normalize();
  const t = new THREE.Vector3();
  const n = new THREE.Vector3();
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const p = points[i]!;
    const q = points[Math.min(count - 1, i + 1)]!;
    const o = points[Math.max(0, i - 1)]!;
    t.set(q[0] - o[0], q[1] - o[1], q[2] - o[2]).normalize();
    n.crossVectors(s, t).normalize();
    const f = i / Math.max(1, count - 1);
    const w = (width / 2) * (1 - (1 - taper) * f);
    for (const [sx, face] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) {
      const h = (thickness / 2) * face;
      positions.push(p[0] + s.x * w * sx + n.x * h, p[1] + s.y * w * sx + n.y * h, p[2] + s.z * w * sx + n.z * h);
      normals.push(n.x * face, n.y * face, n.z * face);
      uvs.push(sx < 0 ? 0 : 1, f);
    }
  }
  for (let i = 0; i < count - 1; i++) {
    const a = i * 4;
    const b = a + 4;
    // front (+n)
    indices.push(a, a + 1, b + 1, a, b + 1, b);
    // back (−n)
    indices.push(a + 2, b + 3, a + 3, a + 2, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}

/** Torus ring around the vertical axis at `c` (collars, belts, goggle frames when rotated). */
export function ring(c: V3, radius: number, tube: number, radial = 6, tubular = 14, rx = 0, sx = 1, sz = 1): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(radius, tube, radial, tubular);
  g.rotateX(Math.PI / 2 + rx);
  g.scale(sx, 1, sz);
  g.translate(c[0], c[1], c[2]);
  return g;
}
