/*
 * Prefab kit (design.md "식생·바위·소품", "구조물과 실내 공간"; Req 39.3): the construction rules every procedural
 * structure and prop follows, and the builder they share.
 *
 * Rules: a basic shape never shows raw. Boxes are chamfered (`box`: every edge cut by `bevel`, 44 triangles),
 * cylinders and cones get a bevelled rim or noise displacement (`cylinder`), spheres are displaced icospheres
 * (`blob`), and a structure is a combination of such parts. Parts are painted per face from a Region palette swatch
 * (sRGB hex → linear vertex colour) with a small deterministic brightness jitter, and merged into one non-indexed
 * geometry (position, flat normal, colour) drawn with one shared toon material (vertex colours as albedo), so a
 * prefab is one draw call (plus one for any glowing trim).
 *
 * Deterministic: hash noise only (no Math.random), so every session builds the same shapes.
 */
import * as THREE from 'three';
import { sharedMaterial } from '../toonMaterial';

export type ColorSpec = number | ((centroid: THREE.Vector3, normal: THREE.Vector3) => number);

export function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth value noise in [0, 1]. */
export function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number): number => hash3(ix + dx, iy + dy, iz + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), ux), l(c(0, 1, 0), c(1, 1, 0), ux), uy),
    l(l(c(0, 0, 1), c(1, 0, 1), ux), l(c(0, 1, 1), c(1, 1, 1), ux), uy),
    uz,
  );
}

/** Translation · rotation (Euler XYZ, rad) · scale. */
export function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

const scratch = new THREE.Color();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const vc = new THREE.Vector3();
const vn = new THREE.Vector3();
const vcen = new THREE.Vector3();

export interface PartOptions {
  /** Per-face brightness jitter ± this (default 0.05). */
  jitter?: number;
}

/** Accumulates painted, transformed parts into one merged geometry. */
export class PartBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];

  get triangles(): number {
    return this.pos.length / 9;
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  /** One triangle (world or prefab space), flat normal, painted by `color`. */
  triangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: ColorSpec, jitter = 0.05): void {
    va.subVectors(b, a);
    vb.subVectors(c, a);
    vn.crossVectors(va, vb);
    const len = vn.length();
    if (!(len > 1e-10)) return; // degenerate
    vn.multiplyScalar(1 / len);
    vcen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const hex = typeof color === 'number' ? color : color(vcen, vn);
    scratch.setHex(hex).multiplyScalar(1 + (hash3(vcen.x, vcen.y, vcen.z) - 0.5) * 2 * jitter);
    for (const v of [a, b, c]) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(vn.x, vn.y, vn.z);
      this.col.push(scratch.r, scratch.g, scratch.b);
    }
  }

  /**
   * Triangles of a convex solid given as local points, oriented outward from `center` automatically, then moved by
   * `matrix`.
   */
  convex(tris: readonly (readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3])[], center: THREE.Vector3, matrix: THREE.Matrix4, color: ColorSpec, jitter?: number): void {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (const [p, q, r] of tris) {
      va.subVectors(q, p);
      vb.subVectors(r, p);
      vn.crossVectors(va, vb);
      vc.copy(p).add(q).add(r).multiplyScalar(1 / 3).sub(center);
      const flip = vn.dot(vc) < 0;
      a.copy(p).applyMatrix4(matrix);
      b.copy(flip ? r : q).applyMatrix4(matrix);
      c.copy(flip ? q : r).applyMatrix4(matrix);
      this.triangle(a, b, c, color, jitter);
    }
  }

  /** Chamfered box w × h × d centred on the local origin, every edge cut by `bevel` (44 triangles). */
  box(w: number, h: number, d: number, matrix: THREE.Matrix4, color: ColorSpec, bevel = 0.04, jitter?: number): void {
    const hx = w / 2;
    const hy = h / 2;
    const hz = d / 2;
    const b = Math.max(0.001, Math.min(bevel, hx * 0.45, hy * 0.45, hz * 0.45));
    const P = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
    // Corner (sx, sy, sz): its vertex on the x face, the y face and the z face.
    const vx = (sx: number, sy: number, sz: number): THREE.Vector3 => P(sx * hx, sy * (hy - b), sz * (hz - b));
    const vy = (sx: number, sy: number, sz: number): THREE.Vector3 => P(sx * (hx - b), sy * hy, sz * (hz - b));
    const vz = (sx: number, sy: number, sz: number): THREE.Vector3 => P(sx * (hx - b), sy * (hy - b), sz * hz);
    const tris: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [];
    const quad = (a: THREE.Vector3, bb: THREE.Vector3, c: THREE.Vector3, d2: THREE.Vector3): void => {
      tris.push([a, bb, c], [a, c, d2]);
    };
    for (const s of [-1, 1]) {
      quad(vx(s, -1, -1), vx(s, 1, -1), vx(s, 1, 1), vx(s, -1, 1));
      quad(vy(-1, s, -1), vy(1, s, -1), vy(1, s, 1), vy(-1, s, 1));
      quad(vz(-1, -1, s), vz(1, -1, s), vz(1, 1, s), vz(-1, 1, s));
    }
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        // Edges along z (between the x and y faces), along x (y and z faces), along y (x and z faces).
        quad(vx(s1, s2, -1), vx(s1, s2, 1), vy(s1, s2, 1), vy(s1, s2, -1));
        quad(vy(-1, s1, s2), vy(1, s1, s2), vz(1, s1, s2), vz(-1, s1, s2));
        quad(vx(s1, -1, s2), vx(s1, 1, s2), vz(s1, 1, s2), vz(s1, -1, s2));
      }
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) tris.push([vx(sx, sy, sz), vy(sx, sy, sz), vz(sx, sy, sz)]);
    this.convex(tris, new THREE.Vector3(), matrix, color, jitter);
  }

  /** Box standing on its base centre (x, y, z) turned by `yaw`: the common placement of props. */
  boxAt(x: number, y: number, z: number, w: number, h: number, d: number, color: ColorSpec, yaw = 0, bevel = 0.04, parent?: THREE.Matrix4): void {
    const m = trs(x, y + h / 2, z, 0, yaw, 0);
    this.box(w, h, d, parent !== undefined ? parent.clone().multiply(m) : m, color, bevel);
  }

  /**
   * Frustum from radius `r0` (bottom) to `r1` (top), `h` tall, base at the local origin. `bevel` cuts both rims;
   * `noise` (m) displaces the side rings radially (rock, bark). Caps are closed unless `open`.
   */
  cylinder(r0: number, r1: number, h: number, sides: number, matrix: THREE.Matrix4, color: ColorSpec, opts: { bevel?: number; noise?: number; rings?: number; open?: boolean; seed?: number; jitter?: number } = {}): void {
    const bevel = Math.max(0, Math.min(opts.bevel ?? 0, h * 0.3, Math.min(r0, r1) * 0.4));
    const rings = Math.max(1, opts.rings ?? 1);
    const noise = opts.noise ?? 0;
    const seed = opts.seed ?? 0;
    // Profile (radius, y) from the bottom rim to the top rim.
    const profile: [number, number][] = [];
    if (bevel > 0) profile.push([r0 - bevel, 0]);
    for (let k = 0; k <= rings; k++) {
      const t = k / rings;
      const y = bevel + (h - 2 * bevel) * t;
      profile.push([r0 + (r1 - r0) * (y / h), y]);
    }
    if (bevel > 0) profile.push([r1 - bevel, h]);
    const ring = (k: number, s: number): THREE.Vector3 => {
      const [r, y] = profile[k] as [number, number];
      const a = (s / sides) * Math.PI * 2;
      const n = noise > 0 && k > 0 && k < profile.length - 1 ? (noise3(Math.cos(a) * 2 + seed, y * 0.8, Math.sin(a) * 2 - seed) - 0.5) * 2 * noise : 0;
      return new THREE.Vector3(Math.cos(a) * (r + n), y, Math.sin(a) * (r + n));
    };
    const tris: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [];
    for (let k = 0; k + 1 < profile.length; k++) {
      for (let s = 0; s < sides; s++) {
        const a = ring(k, s);
        const b = ring(k, s + 1);
        const c = ring(k + 1, s + 1);
        const d = ring(k + 1, s);
        tris.push([a, b, c], [a, c, d]);
      }
    }
    if (opts.open !== true) {
      const bottom = new THREE.Vector3(0, 0, 0);
      const top = new THREE.Vector3(0, h, 0);
      const last = profile.length - 1;
      for (let s = 0; s < sides; s++) {
        tris.push([bottom, ring(0, s + 1), ring(0, s)]);
        tris.push([top, ring(last, s), ring(last, s + 1)]);
      }
    }
    // Orient each face away from the axis at its height (every part here is convex per ring band).
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const out = new THREE.Vector3();
    for (const [p, q, r] of tris) {
      va.subVectors(q, p);
      vb.subVectors(r, p);
      n.crossVectors(va, vb);
      vc.copy(p).add(q).add(r).multiplyScalar(1 / 3);
      // Caps (a vertex on the axis) face down / up; side and rim faces face away from the axis.
      const onAxis = (v: THREE.Vector3): boolean => v.x === 0 && v.z === 0;
      const cap = (onAxis(p) || onAxis(q) || onAxis(r)) && Math.abs(p.y - q.y) < 1e-9 && Math.abs(q.y - r.y) < 1e-9;
      out.set(vc.x, 0, vc.z);
      if (cap || out.lengthSq() < 1e-12) out.set(0, vc.y < h / 2 ? -1 : 1, 0);
      const flip = n.dot(out) < 0;
      a.copy(p).applyMatrix4(matrix);
      b.copy(flip ? r : q).applyMatrix4(matrix);
      c.copy(flip ? q : r).applyMatrix4(matrix);
      this.triangle(a, b, c, color, opts.jitter);
    }
  }

  /** A displaced icosphere (detail 1: 80 triangles) of radius `r` at the local origin. */
  blob(r: number, matrix: THREE.Matrix4, color: ColorSpec, noise = 0.15, seed = 0, detail = 1): void {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let f = 0; f + 2 < p.count; f += 3) {
      for (let k = 0; k < 3; k++) {
        const w = (v[k] as THREE.Vector3).fromBufferAttribute(p, f + k);
        const len = w.length();
        const n = (noise3(w.x * 1.7 / r + seed, w.y * 1.7 / r, w.z * 1.7 / r - seed) - 0.5) * 2 * noise * r;
        w.multiplyScalar((len + n) / len).applyMatrix4(matrix);
      }
      // Icosahedron faces wind outward already.
      this.triangle(v[0] as THREE.Vector3, v[1] as THREE.Vector3, v[2] as THREE.Vector3, color);
    }
    g.dispose();
  }

  /**
   * A triangular prism (gable end, wedge): the triangle (−w/2, 0), (w/2, 0), (0, h) in the x–y plane, `d` deep along z,
   * centred on z = 0.
   */
  prism(w: number, h: number, d: number, matrix: THREE.Matrix4, color: ColorSpec): void {
    const hz = d / 2;
    const p = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
    const f = [p(-w / 2, 0, hz), p(w / 2, 0, hz), p(0, h, hz)];
    const k = [p(-w / 2, 0, -hz), p(w / 2, 0, -hz), p(0, h, -hz)];
    const [f0, f1, f2] = f as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    const [k0, k1, k2] = k as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    this.convex([[f0, f1, f2], [k0, k2, k1], [f0, k0, k1], [f0, k1, f1], [f1, k1, k2], [f1, k2, f2], [f2, k2, k0], [f2, k0, f0]], p(0, h / 3, 0), matrix, color);
  }

  /** The merged geometry (non-indexed: position, normal, color). */
  build(name = 'prefab'): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  /** Appends another builder's triangles. */
  append(other: PartBuilder): void {
    for (let i = 0; i < other.pos.length; i++) {
      this.pos.push(other.pos[i] as number);
      this.nor.push(other.nor[i] as number);
      this.col.push(other.col[i] as number);
    }
  }

  /** Appends a non-indexed geometry with position / normal / color, moved by `matrix`. */
  appendGeometry(g: THREE.BufferGeometry, matrix: THREE.Matrix4 = new THREE.Matrix4()): void {
    const src = g.index !== null ? g.toNonIndexed() : g;
    const p = src.getAttribute('position') as THREE.BufferAttribute;
    const n = src.getAttribute('normal') as THREE.BufferAttribute;
    const c = src.getAttribute('color') as THREE.BufferAttribute;
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      this.pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      this.nor.push(v.x, v.y, v.z);
      this.col.push(c.getX(i), c.getY(i), c.getZ(i));
    }
    if (src !== g) src.dispose();
  }
}

/** The shared toon material every prefab and merged prop batch draws with (vertex colours as albedo). */
export function prefabMaterial(): THREE.MeshToonMaterial {
  return sharedMaterial('stone');
}

/** A prefab mesh: one draw call, receives shadows; large structures cast them (design "그림자"). */
export function prefabMesh(geometry: THREE.BufferGeometry, name: string, castShadow = true, material: THREE.Material = prefabMaterial()): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

/** Triangles of a geometry. */
export function trianglesOf(g: THREE.BufferGeometry): number {
  return (g.index?.count ?? g.getAttribute('position').count) / 3;
}
