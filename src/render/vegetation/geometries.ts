/*
 * Vegetation geometry (design.md "식생·바위·소품"; Req 39.3, 39.4): one shared BufferGeometry per kind / variant,
 * instanced per chunk by vegetationSystem.ts.
 * - grass: a clump of three crossed leaf cards (three blades each, both faces modelled so a front-face material draws
 *   them from any side), normals up so a clump lights like the ground it stands on;
 * - flower: two crossed stem cards and a five-petal head (petals white: the instance colour paints them);
 * - bush: three noise-displaced icospheres;
 * - rock: six noise-displaced icosahedron variants (the flat-shaded `rock` material facets them);
 * - trees: three procedural archetypes per Region (TREE_ARCHETYPES), a tapered, bent trunk under a canopy of merged
 *   noise-displaced spheres, stacked cones, crystal shards or bare branches, and a far LOD that keeps only one
 *   canopy mass (Req 38.5).
 * Vertex colours are the albedo (the tree archetypes are painted from the Region palette; grass, flowers, bushes and
 * rocks carry a brightness gradient that the per-instance colour tints). `aSway` holds the wind (x) and bend (y)
 * weights of windMaterial.ts: 0 at the base, growing with height. Every geometry is non-indexed and deterministic
 * (hash noise, no Math.random).
 */
import * as THREE from 'three';
import { REGION_PALETTES } from '../../data/palettes';
import { ROCK_VARIANTS, TREE_ARCHETYPES, type VegetationRegion } from '../../data/vegetation';

// ── Deterministic noise ─────────────────────────────────────────────────────────────────────────────────────────────
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth value noise in [0, 1]. */
function noise3(x: number, y: number, z: number): number {
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

// ── Builder ─────────────────────────────────────────────────────────────────────────────────────────────────────────
type Rgb = readonly [number, number, number];
const WHITE: Rgb = [1, 1, 1];
const scratch = new THREE.Color();

/** sRGB hex → linear rgb × `k`. */
function lin(hex: number, k = 1): Rgb {
  scratch.setHex(hex);
  return [scratch.r * k, scratch.g * k, scratch.b * k];
}

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scl = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

/** Non-indexed triangle soup with position, normal, colour and sway. */
export class GeoBuilder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly sway: number[] = [];

  vertex(p: THREE.Vector3, n: THREE.Vector3, c: Rgb, sx: number, sy: number): void {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.col.push(c[0], c[1], c[2]);
    this.sway.push(sx, sy);
  }

  get triangles(): number {
    return this.pos.length / 9;
  }

  /**
   * Appends `source` (disposed) transformed by `matrix`. `displace(p, n)` may move each local vertex before the
   * transform; normals: 'smooth' keeps the geometry's (re-derived from `center` when displaced), 'flat' uses faces.
   */
  add(source: THREE.BufferGeometry, matrix: THREE.Matrix4, opts: {
    color: (p: THREE.Vector3, face: number) => Rgb;
    sway: (p: THREE.Vector3) => readonly [number, number];
    displace?: (p: THREE.Vector3) => void;
    normals?: 'smooth' | 'flat' | 'up';
    /** Smooth normals of displaced blobs point away from this local point. */
    center?: THREE.Vector3;
  }): void {
    const g = source.index !== null ? source.toNonIndexed() : source;
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const na = new THREE.Vector3();
    const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const nrm = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let f = 0; f + 2 < p.count; f += 3) {
      for (let k = 0; k < 3; k++) {
        const v = tri[k] as THREE.Vector3;
        const vn = nrm[k] as THREE.Vector3;
        v.fromBufferAttribute(p, f + k);
        if (n !== undefined) vn.fromBufferAttribute(n, f + k);
        else vn.set(0, 1, 0);
        if (opts.displace !== undefined) {
          opts.displace(v);
          if (opts.center !== undefined) vn.copy(v).sub(opts.center).normalize();
        }
        v.applyMatrix4(matrix);
        vn.applyMatrix3(normalMatrix).normalize();
      }
      const mode = opts.normals ?? 'smooth';
      if (mode === 'flat') {
        a.copy(tri[1] as THREE.Vector3).sub(tri[0] as THREE.Vector3);
        b.copy(tri[2] as THREE.Vector3).sub(tri[0] as THREE.Vector3);
        na.crossVectors(a, b).normalize();
        for (const vn of nrm) vn.copy(na);
      } else if (mode === 'up') {
        for (const vn of nrm) vn.set(0, 1, 0);
      }
      c.copy(tri[0] as THREE.Vector3).add(tri[1] as THREE.Vector3).add(tri[2] as THREE.Vector3).multiplyScalar(1 / 3);
      const faceColor = opts.color(c, f / 3);
      for (let k = 0; k < 3; k++) {
        const v = tri[k] as THREE.Vector3;
        const [sx, sy] = opts.sway(v);
        this.vertex(v, nrm[k] as THREE.Vector3, faceColor, sx, sy);
      }
    }
    if (g !== source) g.dispose();
    source.dispose();
  }

  /** A triangle with per-vertex colours; `both` adds the back face with the same normals. */
  triangle(v: readonly THREE.Vector3[], n: THREE.Vector3, colors: readonly Rgb[], sways: readonly (readonly [number, number])[], both = false): void {
    for (let k = 0; k < 3; k++) {
      const s = sways[k] as readonly [number, number];
      this.vertex(v[k] as THREE.Vector3, n, colors[k] as Rgb, s[0], s[1]);
    }
    if (both) {
      for (const k of [0, 2, 1]) {
        const s = sways[k] as readonly [number, number];
        this.vertex(v[k] as THREE.Vector3, n, colors[k] as Rgb, s[0], s[1]);
      }
    }
  }

  build(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 2));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const trs = (x: number, y: number, z: number, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0): THREE.Matrix4 =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );

/** Radial noise displacement of a sphere-like part around its local origin. */
const radialNoise = (amp: number, freq: number, seed: number) => (p: THREE.Vector3): void => {
  const len = p.length();
  if (len < 1e-6) return;
  const n = (noise3(p.x * freq + seed, p.y * freq + seed * 1.7, p.z * freq - seed) - 0.5) * 2 * amp;
  p.multiplyScalar((len + n) / len);
};

// ── Grass, flowers, bushes, rocks ───────────────────────────────────────────────────────────────────────────────────
/** Grass clump: 0.55 m tall, 3 cards × 3 blades, both faces (18 triangles). */
export const GRASS_HEIGHT = 0.55;

export function buildGrassGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const h = GRASS_HEIGHT;
  const w = 0.5;
  const up = new THREE.Vector3(0, 1, 0);
  const base: Rgb = [0.55, 0.55, 0.55];
  const tipC: Rgb = [1.05, 1.05, 1.0];
  const sw = (y: number): readonly [number, number] => [Math.pow(y / h, 1.5), y / h];
  for (let card = 0; card < 3; card++) {
    const a = (card * Math.PI) / 3 + 0.2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const at = (u: number, y: number): THREE.Vector3 => new THREE.Vector3(u * ca, y, u * sa);
    // Three blades side by side along the card, tips leaning outward.
    const blades: [number, number, number, number][] = [[-w / 2, -w / 6, -w * 0.55, 0.8], [-w / 6, w / 6, w * 0.04, 1], [w / 6, w / 2, w * 0.5, 0.72]];
    blades.forEach(([u0, u1, tip, th], i) => {
      const tipY = h * th * (0.92 + 0.08 * hash3(card, i, 1));
      b.triangle([at(u0, 0), at(u1, 0), at(tip, tipY)], up, [base, base, tipC], [sw(0), sw(0), sw(tipY)], true);
    });
  }
  return b.build('veg:grass');
}

export const FLOWER_HEIGHT = 0.42;

export function buildFlowerGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const h = FLOWER_HEIGHT;
  const up = new THREE.Vector3(0, 1, 0);
  const stem: Rgb = [0.28, 0.5, 0.2];
  const petal: Rgb = WHITE;
  const heart: Rgb = [1.0, 0.82, 0.3];
  const sw = (y: number): readonly [number, number] => [Math.pow(y / h, 1.5) * 1.2, (y / h) * 0.9];
  for (let card = 0; card < 2; card++) {
    const a = (card * Math.PI) / 2;
    const d = new THREE.Vector3(Math.cos(a) * 0.035, 0, Math.sin(a) * 0.035);
    b.triangle([d.clone().negate(), d.clone(), new THREE.Vector3(0, h, 0)], up, [stem, stem, stem], [sw(0), sw(0), sw(h)], true);
  }
  // Head: five petals round a small heart, facing up and a little outward.
  const center = new THREE.Vector3(0, h, 0);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const a0 = a - 0.42;
    const a1 = a + 0.42;
    const r = 0.11;
    const tip = new THREE.Vector3(Math.cos(a) * r, h + 0.02, Math.sin(a) * r);
    const l = new THREE.Vector3(Math.cos(a0) * r * 0.55, h + 0.01, Math.sin(a0) * r * 0.55);
    const rr = new THREE.Vector3(Math.cos(a1) * r * 0.55, h + 0.01, Math.sin(a1) * r * 0.55);
    b.triangle([center, rr, tip], up, [petal, petal, petal], [sw(h), sw(h), sw(h)], true);
    b.triangle([center, tip, l], up, [petal, petal, petal], [sw(h), sw(h), sw(h)], true);
  }
  const hh = new THREE.Vector3(0, h + 0.035, 0);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const a1 = ((k + 1) / 4) * Math.PI * 2;
    b.triangle(
      [new THREE.Vector3(Math.cos(a) * 0.03, h + 0.015, Math.sin(a) * 0.03), new THREE.Vector3(Math.cos(a1) * 0.03, h + 0.015, Math.sin(a1) * 0.03), hh],
      up, [heart, heart, heart], [sw(h), sw(h), sw(h)], true,
    );
  }
  return b.build('veg:flower');
}

export const BUSH_HEIGHT = 1.3;

export function buildBushGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const blobs: [number, number, number, number][] = [[0, 0.55, 0, 0.75], [0.55, 0.42, 0.25, 0.55], [-0.45, 0.45, -0.3, 0.58]];
  blobs.forEach(([x, y, z, r], i) => {
    const center = new THREE.Vector3(0, 0, 0);
    b.add(new THREE.IcosahedronGeometry(r, 1), trs(x, y, z, i * 1.3, 1, 0.85, 1), {
      displace: radialNoise(r * 0.18, 2.2 / r, i * 3.1),
      center,
      color: (p, f) => {
        const t = Math.min(1, Math.max(0, p.y / BUSH_HEIGHT));
        const k = 0.62 + 0.45 * t + (hash3(f, i, 2) - 0.5) * 0.08;
        return [k, k, k];
      },
      sway: (p) => [0.3 * Math.max(0, p.y / BUSH_HEIGHT), 0.25 * Math.max(0, p.y / BUSH_HEIGHT)],
    });
  });
  return b.build('veg:bush');
}

/** Rock variant `v` (0–5): about 1 m across at scale 1, base at y 0 (the placer sinks it a little). */
export function buildRockGeometry(v: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const shapes: [number, number, number, number][] = [
    [1.0, 0.62, 0.85, 0.22], [0.8, 0.9, 0.75, 0.18], [1.2, 0.45, 0.9, 0.2], [0.7, 0.7, 1.1, 0.26], [0.95, 0.55, 0.6, 0.3], [1.05, 0.8, 1.0, 0.15],
  ];
  const [sx, sy, sz, amp] = shapes[((v % ROCK_VARIANTS) + ROCK_VARIANTS) % ROCK_VARIANTS] as [number, number, number, number];
  b.add(new THREE.IcosahedronGeometry(0.6, 1), trs(0, 0.6 * sy * 0.8, 0, v * 0.7, sx, sy, sz), {
    displace: (p) => {
      radialNoise(amp * 0.6, 3.1, v * 5.3 + 1)(p);
      if (p.y < -0.3) p.y = -0.3 + (p.y + 0.3) * 0.3; // a flatter base
    },
    normals: 'flat',
    color: (p, f) => {
      const top = Math.min(1, Math.max(0, p.y / (1.1 * sy)));
      const k = 0.78 + 0.3 * top + (hash3(f, v, 9) - 0.5) * 0.16;
      return [k, k, k];
    },
    sway: () => [0, 0],
  });
  return b.build(`veg:rock_${v}`);
}

/** The far rock (all variants beyond VEGETATION_DISTANCES.rockNear): one displaced low-poly icosahedron, 20 triangles. */
export function buildFarRockGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.add(new THREE.IcosahedronGeometry(0.6, 0), trs(0, 0.6 * 0.66 * 0.8, 0, 0.4, 0.95, 0.66, 0.85), {
    displace: (p) => {
      radialNoise(0.12, 3.1, 7.7)(p);
      if (p.y < -0.3) p.y = -0.3 + (p.y + 0.3) * 0.3;
    },
    normals: 'flat',
    color: (p, f) => {
      const k = 0.8 + 0.28 * Math.min(1, Math.max(0, p.y / 0.75)) + (hash3(f, 3, 9) - 0.5) * 0.12;
      return [k, k, k];
    },
    sway: () => [0, 0],
  });
  return b.build('veg:rock_far');
}

// ── Trees ───────────────────────────────────────────────────────────────────────────────────────────────────────────
type Canopy =
  | { readonly kind: 'blobs'; readonly blobs: readonly (readonly [number, number, number, number])[]; readonly color: number; readonly light: number; readonly squash: number }
  | { readonly kind: 'tiers'; readonly base: number; readonly top: number; readonly r0: number; readonly r1: number; readonly tiers: number; readonly color: number; readonly light: number; readonly lean: number }
  | { readonly kind: 'crystals'; readonly shards: readonly (readonly [number, number, number, number, number, number])[]; readonly color: number; readonly light: number }
  | { readonly kind: 'bare'; readonly branches: readonly (readonly [number, number, number, number, number])[] };

export interface TreeArchetypeDef {
  readonly id: string;
  readonly trunk: { readonly h: number; readonly r0: number; readonly r1: number; readonly bend: number; readonly color: number; readonly dark: number };
  readonly canopy: Canopy;
}

const PV = REGION_PALETTES.verdant.swatches;
const PE = REGION_PALETTES.ember.swatches;
const PA = REGION_PALETTES.azure.swatches;
const PC = REGION_PALETTES.crater.swatches;

/** The three archetypes of each Region, in TREE_ARCHETYPES order. */
export const TREE_DEFS: Readonly<Record<VegetationRegion, readonly TreeArchetypeDef[]>> = {
  verdant: [
    { id: 'broadleaf', trunk: { h: 4.2, r0: 0.32, r1: 0.2, bend: 0.35, color: PV.bark, dark: 0x5a3c26 },
      canopy: { kind: 'blobs', blobs: [[0, 5.6, 0, 2.4], [1.3, 5.0, 0.6, 1.7], [-1.2, 5.2, -0.5, 1.8], [0.2, 6.9, -0.3, 1.7]], color: PV.foliage, light: PV.foliageLight, squash: 0.85 } },
    { id: 'birch', trunk: { h: 6.5, r0: 0.2, r1: 0.12, bend: 0.5, color: 0xe8e2d4, dark: 0x8a8478 },
      canopy: { kind: 'blobs', blobs: [[0.3, 5.3, 0.2, 1.25], [-0.4, 6.2, -0.2, 1.1], [0.1, 7.1, 0.1, 0.95]], color: 0x86c04c, light: 0xb8e070, squash: 0.95 } },
    { id: 'giant', trunk: { h: 6, r0: 0.75, r1: 0.45, bend: 0.3, color: PV.bark, dark: 0x4f3522 },
      canopy: { kind: 'blobs', blobs: [[0, 8, 0, 3.6], [2.8, 7.2, 1, 2.8], [-2.6, 7.4, -1, 2.9], [1, 7, -2.7, 2.6], [-0.8, 7.1, 2.6, 2.6], [0.3, 10, 0.2, 2.6]], color: 0x4f8a34, light: PV.foliage, squash: 0.8 } },
  ],
  ember: [
    { id: 'charredPine', trunk: { h: 7.5, r0: 0.28, r1: 0.1, bend: 0.2, color: 0x3a2e28, dark: 0x201a18 },
      canopy: { kind: 'tiers', base: 2.8, top: 8.6, r0: 2.0, r1: 0.5, tiers: 4, color: 0x4a4a2c, light: PE.foliage, lean: 0 } },
    { id: 'crystalShrub', trunk: { h: 0.8, r0: 0.45, r1: 0.3, bend: 0, color: PE.rockDark, dark: 0x241e1c },
      canopy: { kind: 'crystals', shards: [[0, 0, 2.4, 0.32, 0, 0], [0.45, 0.2, 1.7, 0.24, 0.35, 0.2], [-0.4, 0.3, 1.5, 0.22, -0.3, 0.3], [0.1, -0.45, 1.8, 0.25, 0.1, -0.35], [-0.3, -0.25, 1.2, 0.18, -0.3, -0.25]], color: PE.crystal, light: PE.glow } },
    { id: 'ashSnag', trunk: { h: 5.5, r0: 0.3, r1: 0.1, bend: 0.6, color: 0x3a2f2a, dark: 0x221c1a },
      canopy: { kind: 'bare', branches: [[2.8, 0, 0.9, 1.8, 0.09], [3.6, 2.1, 0.7, 1.5, 0.08], [4.3, 4.2, 0.8, 1.3, 0.07], [2.2, 3.3, 1.0, 1.2, 0.08]] } },
  ],
  azure: [
    { id: 'windPine', trunk: { h: 8, r0: 0.26, r1: 0.1, bend: 1.2, color: PA.bark, dark: 0x3a3440 },
      canopy: { kind: 'tiers', base: 3.2, top: 9, r0: 2.2, r1: 0.6, tiers: 4, color: PA.foliage, light: PA.foliageLight, lean: 0.8 } },
    { id: 'blueSpruce', trunk: { h: 9.5, r0: 0.3, r1: 0.08, bend: 0.1, color: 0x4a3e44, dark: 0x2e2830 },
      canopy: { kind: 'tiers', base: 1.6, top: 10.5, r0: 2.4, r1: 0.5, tiers: 5, color: 0x2f5a6e, light: 0x5f8ca0, lean: 0 } },
    { id: 'frostBirch', trunk: { h: 6, r0: 0.19, r1: 0.11, bend: 0.4, color: 0xf0eef4, dark: 0x9a98a6 },
      canopy: { kind: 'blobs', blobs: [[0.2, 5.0, 0.1, 1.2], [-0.35, 5.9, -0.2, 1.05], [0.1, 6.7, 0.15, 0.9]], color: 0x9cc4c8, light: 0xd0e8f0, squash: 0.95 } },
  ],
  crater: [
    { id: 'gnarledSnag', trunk: { h: 4.5, r0: 0.35, r1: 0.12, bend: 0.9, color: 0x5a4632, dark: 0x3a2c20 },
      canopy: { kind: 'bare', branches: [[2.6, 0.5, 0.8, 1.6, 0.1], [3.4, 2.8, 0.6, 1.4, 0.09], [3.9, 4.6, 0.9, 1.1, 0.07]] } },
    { id: 'dustAcacia', trunk: { h: 3.8, r0: 0.22, r1: 0.14, bend: 0.4, color: PC.bark, dark: 0x4a3826 },
      canopy: { kind: 'blobs', blobs: [[0, 4.4, 0, 2.6], [1.6, 4.2, 0.8, 1.9], [-1.5, 4.3, -0.7, 2.0]], color: PC.foliage, light: PC.foliageLight, squash: 0.38 } },
    { id: 'shardShrub', trunk: { h: 0.6, r0: 0.4, r1: 0.28, bend: 0, color: PC.rockDark, dark: 0x4a3e30 },
      canopy: { kind: 'crystals', shards: [[0, 0, 2.0, 0.28, 0, 0], [0.4, 0.15, 1.4, 0.2, 0.3, 0.2], [-0.35, 0.25, 1.3, 0.2, -0.3, 0.3], [0.05, -0.4, 1.5, 0.22, 0.1, -0.3]], color: PC.crystal, light: 0xe0c0ff } },
  ],
};

// The archetype tables must line up with the data (ids in the same order).
for (const region of Object.keys(TREE_ARCHETYPES) as VegetationRegion[]) {
  const ids = TREE_ARCHETYPES[region].map((a) => a.id).join(',');
  if (TREE_DEFS[region].map((d) => d.id).join(',') !== ids) throw new Error(`vegetation: tree archetypes of ${region} do not match the data`);
}

/** Tapered trunk bending toward +x: `rings` rings of `sides` vertices. */
function addTrunk(b: GeoBuilder, t: TreeArchetypeDef['trunk'], sides: number, rings: number, totalH: number): void {
  const bark = lin(t.color);
  const dark = lin(t.dark);
  const at = (k: number, s: number): THREE.Vector3 => {
    const v = k / rings;
    const r = t.r0 + (t.r1 - t.r0) * v;
    const a = (s / sides) * Math.PI * 2;
    return new THREE.Vector3(t.bend * v * v + Math.cos(a) * r, v * t.h, Math.sin(a) * r);
  };
  const sw = (y: number): readonly [number, number] => [1.5 * (y / totalH) ** 2, 0];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let k = 0; k < rings; k++) {
    for (let s = 0; s < sides; s++) {
      const p00 = at(k, s);
      const p01 = at(k, s + 1);
      const p10 = at(k + 1, s);
      const p11 = at(k + 1, s + 1);
      const shade = 0.9 + 0.2 * hash3(k, s, t.h);
      const c0 = scl(mixRgb(dark, bark, Math.min(1, k / rings + 0.35)), shade);
      const c1 = scl(mixRgb(dark, bark, Math.min(1, (k + 1) / rings + 0.35)), shade);
      for (const [a, bb, c, ca, cb, cc] of [[p00, p10, p01, c0, c1, c0], [p01, p10, p11, c0, c1, c1]] as const) {
        e1.subVectors(bb, a);
        e2.subVectors(c, a);
        n.crossVectors(e1, e2).normalize();
        b.triangle([a, bb, c], n, [ca, cb, cc], [sw(a.y), sw(bb.y), sw(c.y)]);
      }
    }
  }
}

function canopyTop(def: TreeArchetypeDef): number {
  const c = def.canopy;
  switch (c.kind) {
    case 'blobs':
      return Math.max(...c.blobs.map(([, y, , r]) => y + r * c.squash));
    case 'tiers':
      return c.top;
    case 'crystals':
      return def.trunk.h + Math.max(...c.shards.map(([, , h]) => h));
    case 'bare':
      return def.trunk.h + 0.5;
  }
}

/** Near (full canopy) or far (one canopy mass) geometry of an archetype. */
export function buildTreeGeometry(region: VegetationRegion, archetype: number, lod: 'near' | 'far'): THREE.BufferGeometry {
  const def = TREE_DEFS[region][archetype] ?? TREE_DEFS[region][0];
  if (def === undefined) throw new Error(`vegetation: no tree ${region}/${archetype}`);
  const b = new GeoBuilder();
  const H = canopyTop(def);
  const sw = (p: THREE.Vector3): readonly [number, number] => [1.5 * Math.max(0, p.y / H) ** 2, 0];
  const near = lod === 'near';
  addTrunk(b, def.trunk, near ? 6 : 5, near ? 4 : 1, H);
  const c = def.canopy;
  const bendTop = def.trunk.bend;
  switch (c.kind) {
    case 'blobs': {
      const base = lin(c.color);
      const light = lin(c.light);
      const color = (p: THREE.Vector3, f: number): Rgb => {
        const t = Math.min(1, Math.max(0, (p.y - (H - 4)) / 4));
        const k = 0.92 + (hash3(f, p.y, 3) - 0.5) * 0.12;
        return scl(mixRgb(base, light, t * 0.85), k);
      };
      const blobs = near ? c.blobs : [meanBlob(c.blobs)];
      blobs.forEach(([x, y, z, r], i) => {
        b.add(new THREE.IcosahedronGeometry(r, 1), trs(x + bendTop, y, z, i * 0.9, 1, c.squash, 1), {
          displace: radialNoise(r * 0.16, 1.6 / r, i * 2.3 + def.trunk.h), center: new THREE.Vector3(), color, sway: sw,
        });
      });
      break;
    }
    case 'tiers': {
      const base = lin(c.color);
      const light = lin(c.light);
      const tiers = near ? c.tiers : 1;
      for (let k = 0; k < tiers; k++) {
        const t0 = near ? k / c.tiers : 0;
        const t1 = near ? (k + 1.35) / c.tiers : 1;
        const y0 = c.base + (c.top - c.base) * t0;
        const y1 = Math.min(c.top, c.base + (c.top - c.base) * t1);
        const r = c.r0 + (c.r1 - c.r0) * t0;
        const lean = c.lean * t0;
        const cone = new THREE.ConeGeometry(r, y1 - y0, 7, 1);
        b.add(cone, trs(bendTop * (y0 / def.trunk.h) + lean, (y0 + y1) / 2, 0, k * 0.5), {
          normals: 'flat',
          color: (p, f) => {
            const top = Math.min(1, Math.max(0, (p.y - y0) / (y1 - y0)));
            const shade = 0.9 + (hash3(f, k, 5) - 0.5) * 0.1;
            return scl(mixRgb(base, light, top * 0.7 + (k / Math.max(1, tiers)) * 0.2), shade);
          },
          sway: sw,
        });
      }
      break;
    }
    case 'crystals': {
      const base = lin(c.color);
      const light = lin(c.light);
      const shards = near ? c.shards : c.shards.slice(0, 2);
      shards.forEach(([x, z, h, r, tx, tz], i) => {
        const shard = new THREE.CylinderGeometry(r * 0.2, r, h, 5, 1);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(x, def.trunk.h * 0.6, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(tx, i * 1.1, tz)),
          new THREE.Vector3(1, 1, 1),
        ).multiply(trs(0, h / 2, 0));
        b.add(shard, m, {
          normals: 'flat',
          color: (p, f) => mixRgb(base, light, Math.min(1, Math.max(0, p.y / (def.trunk.h + h))) * 0.8 + (hash3(f, i, 7) - 0.5) * 0.1),
          sway: () => [0, 0],
        });
      });
      break;
    }
    case 'bare': {
      const branches = near ? c.branches : c.branches.slice(0, 2);
      for (const [y, a, pitch, len, r] of branches) {
        const dir = new THREE.Vector3(Math.cos(a) * Math.sin(pitch), Math.cos(pitch), Math.sin(a) * Math.sin(pitch)).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        const base = new THREE.Vector3(bendTop * (y / def.trunk.h) ** 2, y, 0);
        const m = new THREE.Matrix4().compose(base, q, new THREE.Vector3(1, 1, 1)).multiply(trs(0, len / 2, 0));
        b.add(new THREE.CylinderGeometry(r * 0.4, r, len, near ? 5 : 4, 1, true), m, {
          normals: 'flat',
          color: (_p, f) => lin(def.trunk.color, 0.9 + 0.2 * hash3(f, y, 11)),
          sway: sw,
        });
      }
      break;
    }
  }
  return b.build(`veg:tree_${region}_${def.id}_${lod}`);
}

/** One blob covering a canopy (the far LOD). */
function meanBlob(blobs: readonly (readonly [number, number, number, number])[]): readonly [number, number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [bx, by, bz] of blobs) {
    x += bx;
    y += by;
    z += bz;
  }
  x /= blobs.length;
  y /= blobs.length;
  z /= blobs.length;
  let r = 0;
  for (const [bx, by, bz, br] of blobs) r = Math.max(r, Math.hypot(bx - x, (by - y) * 0.8, bz - z) + br * 0.85);
  return [x, y, z, r];
}

// ── Shared cache ────────────────────────────────────────────────────────────────────────────────────────────────────
const cache = new Map<string, THREE.BufferGeometry>();

/** The shared geometry for a key: 'grass', 'flower', 'bush', 'rock:<v>', 'tree:<region>:<archetype>:<near|far>'. */
export function vegetationGeometry(key: string): THREE.BufferGeometry {
  let g = cache.get(key);
  if (g !== undefined) return g;
  const [kind, a, b, c] = key.split(':');
  switch (kind) {
    case 'grass':
      g = buildGrassGeometry();
      break;
    case 'flower':
      g = buildFlowerGeometry();
      break;
    case 'bush':
      g = buildBushGeometry();
      break;
    case 'rock':
      g = a === 'far' ? buildFarRockGeometry() : buildRockGeometry(Number(a));
      break;
    case 'tree':
      g = buildTreeGeometry(a as VegetationRegion, Number(b), c === 'far' ? 'far' : 'near');
      break;
    default:
      throw new Error(`vegetation: unknown geometry ${key}`);
  }
  cache.set(key, g);
  return g;
}

/** Triangles of a shared geometry. */
export function geometryTriangles(g: THREE.BufferGeometry): number {
  return (g.index?.count ?? g.getAttribute('position').count) / 3;
}
