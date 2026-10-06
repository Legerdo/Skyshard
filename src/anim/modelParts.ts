/*
 * Small shape helpers shared by the enemy, Elite, NPC and Caelith models (./enemyRigs, ./npcRigs, ./caelithRig): cones
 * between two points, faceted crystals, hexagonal plates, Fibonacci sphere directions and vector arithmetic on V3.
 * Every builder returns rig-space geometry (metres, +Z forward) for a PartDef.
 */
import * as THREE from 'three';
import { alongSegment } from './rigGeometry';
import type { V3 } from './rigTypes';

export const v3add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const v3sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const v3scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const v3lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const v3len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const v3norm = (a: V3): V3 => {
  const l = v3len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Mirror across the body's centre plane (left ↔ right). */
export const mirrorX = (a: V3): V3 => [-a[0], a[1], a[2]];

/** Cone from `base` (radius r) to the point `tip`. */
export function cone(base: V3, tip: V3, r: number, radial = 6): THREE.BufferGeometry {
  const len = Math.max(1e-4, v3len(v3sub(tip, base)));
  const g = new THREE.ConeGeometry(r, len, radial, 1);
  g.translate(0, len / 2, 0);
  return alongSegment(g, base, tip);
}

/** Faceted crystal (a stretched octahedron) centred at `c`, `length` along `dir`, `width` across. */
export function crystal(c: V3, dir: V3, length: number, width: number): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(1, 0);
  g.scale(width / 2, length / 2, width / 2);
  const d = v3norm(dir);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(d[0], d[1], d[2])));
  g.translate(c[0], c[1], c[2]);
  return g;
}

/** Hexagonal plate of circumradius `size` and thickness `depth`, centred at `c`, its face turned toward `normal`. */
export function hexPlate(c: V3, normal: V3, size: number, depth: number, stretch: readonly [number, number] = [1, 1]): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * size * stretch[0];
    const y = Math.sin(a) * size * stretch[1];
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.35, bevelSize: size * 0.08, bevelSegments: 1, curveSegments: 1, steps: 1 });
  g.translate(0, 0, -depth / 2);
  const n = v3norm(normal);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(n[0], n[1], n[2])));
  g.translate(c[0], c[1], c[2]);
  return g;
}

/** `n` unit directions spread evenly over a sphere (Fibonacci lattice), optionally only those with y ≥ `minY`. */
export function fibonacciDirections(n: number, minY = -1): V3[] {
  const out: V3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  let i = 0;
  let k = 0;
  // Oversample when a cap is cut away so the count stays `n`.
  const total = minY <= -1 ? n : Math.ceil(n * 2 / Math.max(0.05, 1 - minY));
  while (out.length < n && k < total * 2) {
    const y = 1 - (2 * (i + 0.5)) / total;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * golden;
    i++;
    k++;
    if (y < minY) continue;
    out.push([Math.cos(phi) * r, y, Math.sin(phi) * r]);
  }
  return out;
}

/** Straight tube (a cylinder) from `a` to `b`: staffs, handles, shafts. */
export function rod(a: V3, b: V3, r: number, radial = 6): THREE.BufferGeometry {
  const len = Math.max(1e-4, v3len(v3sub(b, a)));
  const g = new THREE.CylinderGeometry(r, r, len, radial, 1);
  g.translate(0, len / 2, 0);
  return alongSegment(g, a, b);
}
