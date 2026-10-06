import { describe, expect, it } from 'vitest';
import { addScaled, clamp, cross, normalize, sub, type Vec3 } from '../../../src/core/math';
import { createRng, type Rng } from '../../../src/core/rng';
import {
  MAX_VISUAL_INSET,
  MIN_BLOCKING_PROP_HEIGHT,
  insetVisualPoint,
  maxInset,
  propCollider,
} from '../../../src/physics/decor';
import { closestPointOnShape, isValidShape } from '../../../src/physics/primitives';
import type { ColliderKind, ColliderShape } from '../../../src/physics/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const AXES = ['x', 'y', 'z'] as const;
const expectV3 = (a: Vec3, e: Vec3, msg = ''): void =>
  AXES.forEach((k) => expect(a[k], `${msg} .${k}`).toBeCloseTo(e[k], 9));

describe('propCollider', () => {
  const rock: ColliderShape = { kind: 'sphere', center: v(0, 0.5, 0), radius: 0.6 };
  const DEFAULT_FLAGS = { climbable: false, walkableTop: true, blocksCamera: true, material: 'stone' };

  it('gives decorations under 1 m no collider', () => {
    expect(MIN_BLOCKING_PROP_HEIGHT).toBe(1);
    const small = [['grass', 0.3], ['smallStone', 0.45], ['mushroom', 0.15], ['bush', 0.999], ['decal', 0]] as const;
    for (const [kind, height] of small) expect(propCollider({ kind, height, shape: rock }, 1), kind).toBeNull();
  });

  it('gives props of 1 m and taller a valid collider with the default flags', () => {
    for (const height of [1, 1.0001, 3.5, 12]) {
      const c = propCollider({ kind: 'boulder', height, shape: rock }, 7);
      expect(c, `${height} m`).toEqual({ ...rock, id: 7, flags: DEFAULT_FLAGS });
      expect(c !== null && isValidShape(c)).toBe(true);
    }
  });

  it('applies flag overrides and copies the shape', () => {
    const base = v(4, 0, 4);
    const shape: ColliderShape = { kind: 'cylinder', base, radius: 0.35, height: 6 };
    const c = propCollider({ kind: 'tree', height: 6, shape, flags: { climbable: true, material: 'wood', hazard: 'heat' } }, 3);
    expect(c?.flags).toEqual({ climbable: true, walkableTop: true, blocksCamera: true, material: 'wood', hazard: 'heat' });
    base.x = 99;
    expect(c).toMatchObject({ kind: 'cylinder', base: { x: 4, y: 0, z: 4 }, radius: 0.35, height: 6 });
  });

  it('rejects invalid geometry and non-finite heights', () => {
    const bad = [
      { kind: 'sphere', center: v(0, 0, 0), radius: 0 },
      { kind: 'aabb', min: v(1, 0, 0), max: v(0, 2, 1) },
      { kind: 'capsule', a: v(Number.NaN, 0, 0), b: v(0, 2, 0), radius: 0.5 },
      { kind: 'cone', center: v(0, 0, 0), radius: 1 },
    ] as unknown as ColliderShape[];
    for (const shape of bad) expect(propCollider({ kind: 'boulder', height: 2, shape }, 1), JSON.stringify(shape)).toBeNull();
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY]) expect(propCollider({ kind: 'boulder', height, shape: rock }, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Visual inset
// ---------------------------------------------------------------------------

/** Rotates a local OBB vector to world (types.ts yaw convention). */
const yawToWorld = (l: Vec3, yaw: number): Vec3 => {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return v(l.x * c + l.z * s, l.y, -l.x * s + l.z * c);
};

const randomUnit = (rng: Rng): Vec3 => {
  const y = rng.range(-1, 1);
  const phi = rng.range(0, 2 * Math.PI);
  const s = Math.sqrt(1 - y * y);
  return v(s * Math.cos(phi), y, s * Math.sin(phi));
};

/** Uniformly placed point on a face / side / cap of the shape, with its analytic outward normal. */
function sampleSurface(shape: ColliderShape, rng: Rng): { point: Vec3; normal: Vec3 } {
  switch (shape.kind) {
    case 'aabb':
    case 'obb': {
      const h = shape.kind === 'aabb' ? { x: (shape.max.x - shape.min.x) / 2, y: (shape.max.y - shape.min.y) / 2, z: (shape.max.z - shape.min.z) / 2 } : shape.half;
      const k = rng.pick(AXES);
      const side = rng.chance(0.5) ? 1 : -1;
      const local = v(rng.range(-h.x, h.x), rng.range(-h.y, h.y), rng.range(-h.z, h.z));
      const n = v(0, 0, 0);
      n[k] = side;
      if (shape.kind === 'aabb') {
        const point = v(shape.min.x + h.x + local.x, shape.min.y + h.y + local.y, shape.min.z + h.z + local.z);
        point[k] = side > 0 ? shape.max[k] : shape.min[k];
        return { point, normal: n };
      }
      local[k] = side * h[k];
      const w = yawToWorld(local, shape.yaw);
      return { point: v(shape.center.x + w.x, shape.center.y + w.y, shape.center.z + w.z), normal: yawToWorld(n, shape.yaw) };
    }
    case 'cylinder': {
      const { base: b, radius: r, height: h } = shape;
      const th = rng.range(0, 2 * Math.PI);
      const [ux, uz] = [Math.cos(th), Math.sin(th)];
      const part = rng.int(0, 2);
      if (part === 0) return { point: v(b.x + r * ux, b.y + h * rng.next(), b.z + r * uz), normal: v(ux, 0, uz) };
      const rho = r * Math.sqrt(rng.next());
      return { point: v(b.x + rho * ux, part === 1 ? b.y + h : b.y, b.z + rho * uz), normal: v(0, part === 1 ? 1 : -1, 0) };
    }
    case 'sphere': {
      const u = randomUnit(rng);
      return { point: addScaled(shape.center, u, shape.radius), normal: u };
    }
    case 'capsule': {
      const { a, b, radius: r } = shape;
      const ab = sub(b, a);
      const e = normalize(ab);
      if (rng.chance(0.5)) {
        const p1 = normalize(cross(e, Math.abs(e.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0)));
        const p2 = cross(e, p1);
        const phi = rng.range(0, 2 * Math.PI);
        const n = addScaled(addScaled(v(0, 0, 0), p1, Math.cos(phi)), p2, Math.sin(phi));
        return { point: addScaled(addScaled(a, ab, rng.next()), n, r), normal: n };
      }
      const u = randomUnit(rng);
      const end = u.x * e.x + u.y * e.y + u.z * e.z >= 0 ? b : a; // hemisphere caps
      return { point: addScaled(end, u, r), normal: u };
    }
  }
}

describe('insetVisualPoint', () => {
  const KINDS: readonly ColliderKind[] = ['aabb', 'obb', 'cylinder', 'sphere', 'capsule'];
  // Each kind has a thick shape and one thinner than 2 × MAX_VISUAL_INSET somewhere.
  const SHAPES: readonly ColliderShape[] = [
    { kind: 'aabb', min: v(-1, 0, -2), max: v(1.5, 2, 0.5) },
    { kind: 'aabb', min: v(3, 0, 3), max: v(5, 0.2, 4) },
    { kind: 'obb', center: v(2, 1, -3), half: v(1, 0.8, 0.4), yaw: 0.7 },
    { kind: 'obb', center: v(0, 0.5, 0), half: v(0.6, 0.5, 0.08), yaw: -2.1 },
    { kind: 'cylinder', base: v(0, 0, 0), radius: 0.4, height: 3 },
    { kind: 'cylinder', base: v(-2, 1, 4), radius: 1.5, height: 0.2 },
    { kind: 'sphere', center: v(1, 2, 3), radius: 1.2 },
    { kind: 'sphere', center: v(0, 0.1, 0), radius: 0.1 },
    { kind: 'capsule', a: v(0, 0.5, 0), b: v(0, 2.5, 0), radius: 0.5 },
    { kind: 'capsule', a: v(-1, 0.3, 1), b: v(2, 1.3, -1), radius: 0.12 },
  ];

  it('moves surface points of every primitive inward by clamp(amount, 0, maxInset), staying inside and within 0.15 m', () => {
    const rng = createRng(0x5eed);
    for (const kind of KINDS) {
      const shapes = SHAPES.filter((s) => s.kind === kind);
      expect(shapes.length, kind).toBeGreaterThan(0);
      for (const shape of shapes) {
        const cap = maxInset(shape);
        for (let i = 0; i < 200; i++) {
          const { point, normal } = sampleSurface(shape, rng);
          const amount = rng.range(-1, 1);
          const label = `${kind} #${i} at ${JSON.stringify(point)} amount ${amount}`;
          const q = insetVisualPoint(shape, point, amount);
          expectV3(q, addScaled(point, normal, -clamp(amount, 0, cap)), label);
          const signed = closestPointOnShape(shape, q).distance;
          expect(signed, label).toBeLessThanOrEqual(1e-9);
          expect(signed, label).toBeGreaterThanOrEqual(-MAX_VISUAL_INSET - 1e-9);
        }
      }
    }
  });

  it('caps the inset at the thinnest half-extent', () => {
    expect(MAX_VISUAL_INSET).toBe(0.15);
    const plank: ColliderShape = { kind: 'aabb', min: v(0, 0, 0), max: v(2, 0.1, 1) };
    expect(maxInset(plank)).toBeCloseTo(0.05, 12);
    const q = insetVisualPoint(plank, v(1, 0.1, 0.5), 1);
    expectV3(q, v(1, 0.05, 0.5));
    expect(closestPointOnShape(plank, q).distance).toBeCloseTo(-0.05, 12);

    expect(maxInset({ kind: 'obb', center: v(0, 0, 0), half: v(2, 1, 0.05), yaw: 0.3 })).toBe(0.05);
    expect(maxInset({ kind: 'cylinder', base: v(0, 0, 0), radius: 0.08, height: 2 })).toBe(0.08);
    expect(maxInset({ kind: 'cylinder', base: v(0, 0, 0), radius: 1, height: 0.1 })).toBe(0.05);
    expect(maxInset({ kind: 'sphere', center: v(0, 0, 0), radius: 0.12 })).toBe(0.12);
    expect(maxInset({ kind: 'capsule', a: v(0, 0, 0), b: v(0, 1, 0), radius: 0.04 })).toBe(0.04);
    expect(maxInset({ kind: 'sphere', center: v(0, 0, 0), radius: 3 })).toBe(MAX_VISUAL_INSET);
    expect(maxInset({ kind: 'sphere', center: v(0, 0, 0), radius: -1 })).toBe(0);
  });

  it('snaps a point outside the collider onto its surface before insetting', () => {
    const box: ColliderShape = { kind: 'aabb', min: v(0, 0, 0), max: v(2, 2, 1) };
    expectV3(insetVisualPoint(box, v(1, 2.5, 0.5), 0.1), v(1, 1.9, 0.5));
    expectV3(insetVisualPoint(box, v(1, 2.5, 0.5), -1), v(1, 2, 0.5));
  });

  it('returns non-finite input unchanged', () => {
    const box: ColliderShape = { kind: 'aabb', min: v(0, 0, 0), max: v(2, 2, 1) };
    for (const p of [v(Number.NaN, 2, 0.5), v(1, Number.POSITIVE_INFINITY, 0.5), v(1, 2, Number.NEGATIVE_INFINITY)]) {
      expect(insetVisualPoint(box, p, 0.1)).toEqual(p);
    }
    const top = v(1, 2, 0.5);
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(insetVisualPoint(box, top, amount), String(amount)).toEqual(top);
    }
    expect(insetVisualPoint({ kind: 'sphere', center: v(0, 0, 0), radius: Number.NaN }, top, 0.1)).toEqual(top);
  });
});
