import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { analyticHeightfield, flatHeightfield } from '../../../src/physics/heightfield';
import type { Collider, ColliderFlags, ColliderShape, Heightfield } from '../../../src/physics/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function flags(o: Partial<ColliderFlags> = {}): ColliderFlags {
  return { climbable: false, walkableTop: true, blocksCamera: true, material: 'stone', ...o };
}

function col(id: number, shape: ColliderShape, f: Partial<ColliderFlags> = {}): Collider {
  return { ...shape, id, flags: flags(f) } as Collider;
}

function box(id: number, min: Vec3, max: Vec3, f: Partial<ColliderFlags> = {}): Collider {
  return col(id, { kind: 'aabb', min, max }, f);
}

function expectV(a: Vec3, b: Vec3, tol = 1e-3): void {
  expect(Math.abs(a.x - b.x)).toBeLessThan(tol);
  expect(Math.abs(a.y - b.y)).toBeLessThan(tol);
  expect(Math.abs(a.z - b.z)).toBeLessThan(tol);
}

/** World whose ground is far below, so only colliders matter. */
const colliderWorld = () => createCollisionWorld(flatHeightfield(-100));

describe('sweepCapsule vs primitives', () => {
  // Capsule r = 0.5, h = 2, feet at y = 0.5 moving +X by 5 m: core segment y ∈ [1, 2].
  const from = v(0, 0.5, 0);
  const to = v(5, 0.5, 0);
  const cases: { name: string; shape: ColliderShape; t: number; normal: Vec3 }[] = [
    { name: 'aabb', shape: { kind: 'aabb', min: v(2, 0, -1), max: v(3, 2, 1) }, t: 1.5 / 5, normal: v(-1, 0, 0) },
    // Yaw 45°: the vertical edge at local (−0.5, −0.5) points at −X, x = 3 − √0.5.
    { name: 'rotated obb', shape: { kind: 'obb', center: v(3, 1, 0), half: v(0.5, 1, 0.5), yaw: Math.PI / 4 }, t: (2.5 - Math.SQRT1_2) / 5, normal: v(-1, 0, 0) },
    { name: 'cylinder', shape: { kind: 'cylinder', base: v(3, 0, 0), radius: 0.5, height: 2 }, t: 2 / 5, normal: v(-1, 0, 0) },
    // Offset sphere: contact when √((3 − x)² + 0.6²) = 1 → x = 2.2.
    { name: 'sphere', shape: { kind: 'sphere', center: v(3, 1.5, 0.6), radius: 0.5 }, t: 2.2 / 5, normal: v(-0.8, 0, -0.6) },
    { name: 'tilted capsule', shape: { kind: 'capsule', a: v(3, 0, -1), b: v(3, 3, 1), radius: 0.5 }, t: 2 / 5, normal: v(-1, 0, 0) },
  ];
  for (const c of cases) {
    it(`stops at first contact with a ${c.name}`, () => {
      const w = colliderWorld();
      w.addStatic(col(7, c.shape));
      const hit = w.sweepCapsule(from, to, 0.5, 2);
      expect(hit).not.toBeNull();
      expect(Math.abs(hit!.t - c.t)).toBeLessThan(1e-4);
      expect(hit!.distance).toBeCloseTo(hit!.t * 5, 9);
      expectV(hit!.position, v(5 * hit!.t, 0.5, 0), 1e-9);
      expectV(hit!.normal, c.normal);
      expect(hit!.colliderId).toBe(7);
      expect(hit!.dynamic).toBe(false);
    });
  }
});

describe('sweepCapsule vs terrain', () => {
  it('lands on flat ground', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    const hit = w.sweepCapsule(v(0, 2, 0), v(0, -1, 0), 0.5, 2);
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.t - 2 / 3)).toBeLessThan(1e-3);
    expect(Math.abs(hit!.position.y)).toBeLessThan(1e-3);
    expect(hit!.position.y).toBeGreaterThanOrEqual(-1e-4);
    expectV(hit!.normal, v(0, 1, 0), 1e-9);
    expectV(hit!.point, v(0, 0, 0), 1e-9);
    expect(hit!.colliderId).toBeNull();
    expect(hit!.dynamic).toBe(false);
  });

  it('lands on a slope where the sphere touches uphill of the feet', () => {
    // h = 0.5x: the sphere centre rests at M = r·√(1 + 0.25) above h(c).
    const w = createCollisionWorld(analyticHeightfield((x) => 0.5 * x));
    const hit = w.sweepCapsule(v(0, 3, 0), v(0, -3, 0), 0.5, 2);
    expect(hit).not.toBeNull();
    const feetY = 0.5 * Math.sqrt(1.25) - 0.5;
    expect(Math.abs(hit!.position.y - feetY)).toBeLessThan(1e-3);
    expectV(hit!.normal, v(-0.5 / Math.sqrt(1.25), 1 / Math.sqrt(1.25), 0));
    expectV(hit!.point, v(0.25 / Math.sqrt(1.25), 0.125 / Math.sqrt(1.25), 0));
  });

  it('is blocked by a 0.45 m step (step-up belongs to the controller)', () => {
    const w = createCollisionWorld(analyticHeightfield((x) => 0.45 * Math.min(1, Math.max(0, (x - 0.95) / 0.1))));
    const hit = w.sweepCapsule(v(0, 0, 0), v(3, 0, 0), 0.4, 1.8);
    expect(hit).not.toBeNull();
    expect(hit!.position.x).toBeGreaterThan(0.5);
    expect(hit!.position.x).toBeLessThan(0.75);
    expect(hit!.normal.x).toBeLessThan(-0.5);
    expect(hit!.colliderId).toBeNull();
  });

  it('walks freely along flat ground at exact contact', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    expect(w.sweepCapsule(v(0, 0, 0), v(4, 0, 3), 0.4, 1.8)).toBeNull();
  });
});

describe('sweepCapsule start overlap', () => {
  it('terrain: moving deeper hits at ~0, moving out or sideways does not', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    const down = w.sweepCapsule(v(0, -0.1, 0), v(0, -1, 0), 0.5, 2);
    expect(down).not.toBeNull();
    expect(down!.t).toBeLessThan(1e-3);
    expect(w.sweepCapsule(v(0, -0.1, 0), v(0, 1, 0), 0.5, 2)).toBeNull();
    expect(w.sweepCapsule(v(0, -0.1, 0), v(1, -0.1, 0), 0.5, 2)).toBeNull();
  });

  it('collider: moving in hits at t = 0, moving away is skipped', () => {
    const w = colliderWorld();
    w.addStatic(box(3, v(1, 0, -1), v(2, 2, 1)));
    const into = w.sweepCapsule(v(0.7, 0, 0), v(1.7, 0, 0), 0.5, 2);
    expect(into).not.toBeNull();
    expect(into!.t).toBe(0);
    expect(into!.colliderId).toBe(3);
    expectV(into!.normal, v(-1, 0, 0), 1e-9);
    expect(w.sweepCapsule(v(0.7, 0, 0), v(-0.3, 0, 0), 0.5, 2)).toBeNull();
  });
});

describe('dilated height', () => {
  // Plateau at 5 for x ≤ 0 falling smoothly to 0 by x = 0.2.
  const cliff = (x: number): number => {
    const s = Math.min(1, Math.max(0, x / 0.2));
    return 5 * (1 - s * s * (3 - 2 * s));
  };

  it('does not block a capsule walking off a cliff edge', () => {
    const w = createCollisionWorld(analyticHeightfield(cliff));
    expect(w.sweepCapsule(v(-1, 5, 0), v(2, 5, 0), 0.4, 1.8)).toBeNull();
    expect(w.overlapCapsule(v(0.1, 5, 0), 0.4, 1.8)).toEqual([]);
    expect(w.overlapCapsule(v(0, 5.001, 0), 0.4, 1.8)).toEqual([]);
  });

  it('clears a convex ridge by 1 cm and is blocked 1 cm lower', () => {
    const w = createCollisionWorld(analyticHeightfield((x) => 2 - 4 * x * x));
    expect(w.sweepCapsule(v(-1, 2.01, 0), v(1, 2.01, 0), 0.5, 2)).toBeNull();
    const hit = w.sweepCapsule(v(-1, 1.99, 0), v(1, 1.99, 0), 0.5, 2);
    expect(hit).not.toBeNull();
    expect(hit!.position.x).toBeLessThan(0);
    expect(hit!.normal.x).toBeLessThan(0);
  });
});

describe('overlapCapsule', () => {
  it('reports every penetration, deepest first, with push-out normals', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    w.addStatic(box(4, v(1, 0, -1), v(2, 2, 1)));
    w.addStatic(col(2, { kind: 'sphere', center: v(-3, 1, 0), radius: 0.5 }));
    const contacts = w.overlapCapsule(v(0.8, -0.1, 0), 0.5, 2);
    expect(contacts.length).toBe(2);
    expect(contacts[0].colliderId).toBe(4);
    expect(contacts[0].depth).toBeCloseTo(0.3, 9);
    expectV(contacts[0].normal, v(-1, 0, 0), 1e-9);
    expect(contacts[0].point.x).toBeCloseTo(1, 9);
    expect(contacts[1].colliderId).toBeNull();
    expect(contacts[1].depth).toBeCloseTo(0.1, 9);
    expectV(contacts[1].normal, v(0, 1, 0), 1e-9);
    expectV(contacts[1].point, v(0.8, 0, 0), 1e-9);
    // Pushing out along normal · depth leaves the capsule touching, not penetrating.
    const moved = v(0.8 - contacts[0].depth, -0.1 + contacts[1].depth, 0);
    expect(w.overlapCapsule(moved, 0.5, 2)).toEqual([]);
  });

  it('returns [] when nothing penetrates', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    w.addStatic(box(4, v(1, 0, -1), v(2, 2, 1)));
    expect(w.overlapCapsule(v(0, 0, 0), 0.5, 2)).toEqual([]);
  });
});

describe('raycast', () => {
  const hFn = (x: number, z: number): number => 2 * Math.sin(0.3 * x) + 1.5 * Math.cos(0.2 * z);

  it('matches the analytic terrain to < 1e-3 m and finds the first crossing', () => {
    const w = createCollisionWorld(analyticHeightfield(hFn));
    const o = v(-10, 20, -5);
    const len = Math.hypot(1, -0.8, 0.3);
    const d = v(1 / len, -0.8 / len, 0.3 / len);
    const hit = w.raycast(o, v(1, -0.8, 0.3), 100);
    expect(hit).not.toBeNull();
    // Reference: fine march (1 cm) + bisection on the analytic function.
    const f = (s: number): number => o.y + d.y * s - hFn(o.x + d.x * s, o.z + d.z * s);
    let s0 = 0;
    while (f(s0 + 0.01) > 0) s0 += 0.01;
    let lo = s0;
    let hi = s0 + 0.01;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    expect(Math.abs(hit!.distance - lo)).toBeLessThan(1e-3);
    expectV(hit!.point, v(o.x + d.x * hit!.distance, o.y + d.y * hit!.distance, o.z + d.z * hit!.distance), 1e-9);
    expect(Math.abs(hit!.point.y - hFn(hit!.point.x, hit!.point.z))).toBeLessThan(1e-3);
    const gx = 0.6 * Math.cos(0.3 * hit!.point.x);
    const gz = -0.3 * Math.sin(0.2 * hit!.point.z);
    const n = Math.hypot(gx, 1, gz);
    expectV(hit!.normal, v(-gx / n, 1 / n, -gz / n), 1e-2);
    expect(hit!.colliderId).toBeNull();
  });

  it('handles flat ground, origins below the surface and short rays', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    const down = w.raycast(v(0, 10, 0), v(0, -2, 0), 50);
    expect(Math.abs(down!.distance - 10)).toBeLessThan(1e-6);
    expectV(down!.normal, v(0, 1, 0), 1e-9);
    expect(w.raycast(v(0, -1, 0), v(1, 0, 0), 10)!.distance).toBe(0);
    expect(w.raycast(v(0, 10, 0), v(0, -1, 0), 5)).toBeNull();
    expect(w.raycast(v(0, 1, 0), v(0, 1, 0), 50)).toBeNull();
  });

  it('hits colliders and returns the nearest hit (ties: lowest id)', () => {
    const w = colliderWorld();
    w.addStatic(box(2, v(8, -1, -1), v(9, 1, 1)));
    w.addStatic(box(5, v(5, -1, -1), v(6, 1, 1)));
    const hit = w.raycast(v(0, 0, 0), v(1, 0, 0), 100);
    expect(hit!.colliderId).toBe(5);
    expect(hit!.distance).toBeCloseTo(5, 9);
    expectV(hit!.normal, v(-1, 0, 0), 1e-9);
    expectV(hit!.point, v(5, 0, 0), 1e-9);
    expect(hit!.dynamic).toBe(false);
    w.addStatic(box(3, v(5, -1, -0.5), v(5.5, 1, 0.5)));
    expect(w.raycast(v(0, 0, 0), v(1, 0, 0), 100)!.colliderId).toBe(3);
    // A collider two 16 m cells away.
    const far = colliderWorld();
    far.addStatic(box(9, v(40, -1, -1), v(41, 1, 1)));
    expect(far.raycast(v(0, 0, 0), v(1, 0, 0), 100)!.distance).toBeCloseTo(40, 9);
  });

  it('orders terrain and collider hits by distance', () => {
    const d = v(1, -0.5, 0);
    const w = createCollisionWorld(flatHeightfield(0));
    w.addStatic(box(1, v(10, -1, -1), v(11, 5, 1)));
    const ground = w.raycast(v(0, 2, 0), d, 100);
    expect(ground!.colliderId).toBeNull();
    expect(ground!.point.x).toBeCloseTo(4, 5);
    w.addStatic(box(2, v(2, -1, -1), v(3, 5, 1)));
    const wall = w.raycast(v(0, 2, 0), d, 100);
    expect(wall!.colliderId).toBe(2);
    expect(wall!.distance).toBeCloseTo(Math.hypot(2, 1), 9);
  });
});

describe('groundProbe', () => {
  it('finds flat terrain below the feet', () => {
    const w = createCollisionWorld(flatHeightfield(0, 'dirt'));
    const g = w.groundProbe(v(0, 0.3, 0), 1);
    expect(g).not.toBeNull();
    expect(g!.distance).toBeCloseTo(0.3, 9);
    expectV(g!.point, v(0, 0, 0), 1e-9);
    expectV(g!.normal, v(0, 1, 0), 1e-9);
    expect(g!.slopeDeg).toBeCloseTo(0, 9);
    expect(g!.material).toBe('dirt');
    expect(g!.walkable).toBe(true);
    expect(g!.hazard).toBeNull();
    expect(g!.colliderId).toBeNull();
    expect(w.groundProbe(v(0, 1.5, 0), 1)).toBeNull();
  });

  it('lands on a collider top, including when embedded', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    w.addStatic(box(6, v(-1, 0, -1), v(1, 1, 1), { material: 'wood' }));
    const g = w.groundProbe(v(0, 1.2, 0), 1);
    expect(g!.colliderId).toBe(6);
    expect(Math.abs(g!.distance - 0.2)).toBeLessThan(2e-4);
    expect(g!.material).toBe('wood');
    expect(g!.walkable).toBe(true);
    expect(g!.point.y).toBeCloseTo(1.2 - g!.distance, 9);
    const embedded = w.groundProbe(v(0, 0.9, 0), 1);
    expect(embedded!.colliderId).toBe(6);
    expect(embedded!.distance).toBeCloseTo(-0.1, 9);
  });

  it('reports steep slopes as not walkable and collider hazards', () => {
    const steep = createCollisionWorld(analyticHeightfield((x) => 1.5 * x));
    const g = steep.groundProbe(v(0, 1, 0), 3);
    expect(Math.abs(g!.distance - (1.4 - 0.4 * Math.sqrt(3.25)))).toBeLessThan(1e-3);
    expect(Math.abs(g!.slopeDeg - (Math.atan(1.5) * 180) / Math.PI)).toBeLessThan(0.1);
    expect(g!.walkable).toBe(false);
    const w = colliderWorld();
    w.addStatic(box(8, v(-1, -1, -1), v(1, 0, 1), { hazard: 'lava', walkableTop: false }));
    const lava = w.groundProbe(v(0, 0.5, 0), 1);
    expect(lava!.hazard).toBe('lava');
    expect(lava!.walkable).toBe(false);
    expect(lava!.colliderId).toBe(8);
  });
});

describe('closestSurface', () => {
  it('finds a box wall and a cylinder, signed inside', () => {
    const w = colliderWorld();
    w.addStatic(box(11, v(1, 0, -5), v(2, 5, 5)));
    w.addStatic(col(12, { kind: 'cylinder', base: v(0, 0, 10), radius: 1, height: 4 }, { material: 'wood' }));
    const out = w.closestSurface(v(0.6, 2, 0), 1, {});
    expect(out!.colliderId).toBe(11);
    expect(out!.distance).toBeCloseTo(0.4, 9);
    expectV(out!.normal, v(-1, 0, 0), 1e-9);
    expectV(out!.point, v(1, 2, 0), 1e-9);
    expect(out!.material).toBe('stone');
    const inside = w.closestSurface(v(1.1, 2, 0), 1, {});
    expect(inside!.distance).toBeCloseTo(-0.1, 9);
    expectV(inside!.normal, v(-1, 0, 0), 1e-9);
    expectV(inside!.point, v(1, 2, 0), 1e-9);
    const cyl = w.closestSurface(v(0, 2, 11.5), 1, {});
    expect(cyl!.colliderId).toBe(12);
    expect(cyl!.distance).toBeCloseTo(0.5, 9);
    expectV(cyl!.normal, v(0, 0, 1), 1e-9);
    expect(cyl!.material).toBe('wood');
    expect(w.closestSurface(v(-10, 2, 0), 1, {})).toBeNull();
    expect(w.closestSurface(v(0.6, 2, 0), 1, { mask: 'climb' })).toBeNull();
  });

  it('finds a steep terrain wall, signed below the surface', () => {
    // h = clamp(10x, 0, 10): a 84° face between x = 0 and x = 1.
    const w = createCollisionWorld(analyticHeightfield((x) => Math.min(10, Math.max(0, 10 * x)), 'rock'));
    const s = Math.sqrt(101);
    const out = w.closestSurface(v(-0.5, 5, 0), 2, {});
    expect(out!.colliderId).toBeNull();
    expect(Math.abs(out!.distance - 10 / s)).toBeLessThan(1e-3);
    expectV(out!.normal, v(-10 / s, 1 / s, 0), 1e-2);
    expect(out!.material).toBe('rock');
    const inside = w.closestSurface(v(0.8, 5, 0), 2, {});
    expect(Math.abs(inside!.distance + 3 / s)).toBeLessThan(1e-3);
    expect(Math.abs(inside!.point.y - 10 * inside!.point.x)).toBeLessThan(1e-3);
  });
});

describe('filters', () => {
  it('applies masks and exclude to colliders; the terrain is always tested', () => {
    const w = colliderWorld();
    w.addStatic(box(1, v(5, -1, -1), v(6, 1, 1), { blocksCamera: false }));
    w.addStatic(box(2, v(8, -1, -1), v(9, 1, 1), { climbable: true }));
    const ray = (f?: object) => w.raycast(v(0, 0, 0), v(1, 0, 0), 100, f)?.colliderId ?? null;
    expect(ray()).toBe(1);
    expect(ray({ mask: 'solid' })).toBe(1);
    expect(ray({ mask: 'camera' })).toBe(2);
    expect(ray({ mask: 'climb' })).toBe(2);
    expect(ray({ exclude: [1] })).toBe(2);
    expect(ray({ exclude: [1, 2] })).toBeNull();
    expect(w.sweepCapsule(v(0, -0.5, 0), v(10, -0.5, 0), 0.5, 1, { exclude: [1] })!.colliderId).toBe(2);
    expect(w.overlapCapsule(v(5.5, -0.5, 0), 0.5, 1, { mask: 'camera' })).toEqual([]);
    const ground = createCollisionWorld(flatHeightfield(0));
    expect(ground.raycast(v(0, 5, 0), v(0, -1, 0), 10, { mask: 'camera' })!.colliderId).toBeNull();
    expect(ground.raycast(v(0, 5, 0), v(0, -1, 0), 10, { mask: 'climb' })!.colliderId).toBeNull();
  });
});

describe('oneWay colliders', () => {
  const platform = () => {
    const w = colliderWorld();
    w.addStatic(box(20, v(-2, 1, -2), v(2, 1.2, 2), { oneWay: true }));
    return w;
  };

  it('pass from below, land from above, and are ignored by overlap', () => {
    const w = platform();
    expect(w.sweepCapsule(v(0, -1, 0), v(0, 2, 0), 0.4, 1.8)).toBeNull();
    const land = w.sweepCapsule(v(0, 2, 0), v(0, 0, 0), 0.4, 1.8);
    expect(land!.colliderId).toBe(20);
    expect(Math.abs(land!.position.y - 1.2)).toBeLessThan(1e-3);
    expectV(land!.normal, v(0, 1, 0), 1e-9);
    // Core segment inside the platform (mid-jump through it): not blocked.
    expect(w.sweepCapsule(v(0, 0.7, 0), v(0, 0, 0), 0.4, 1.8)).toBeNull();
    expect(w.overlapCapsule(v(0, 1, 0), 0.4, 1.8)).toEqual([]);
    expect(Math.abs(w.groundProbe(v(0, 1.5, 0), 1)!.distance - 0.3)).toBeLessThan(2e-4);
    expect(w.raycast(v(0, 5, 0), v(0, -1, 0), 10)!.distance).toBeCloseTo(3.8, 9);
    expect(w.raycast(v(0, -5, 0), v(0, 1, 0), 10)).toBeNull();
  });
});

describe('collider management', () => {
  it('upserts, moves across 16 m cells and removes dynamic colliders', () => {
    const w = colliderWorld();
    expect(w.upsertDynamic(box(30, v(2, -1, -1), v(3, 1, 1)))).toBe(true);
    const near = w.raycast(v(0, 0, 0), v(1, 0, 0), 100);
    expect(near!.colliderId).toBe(30);
    expect(near!.dynamic).toBe(true);
    expect(near!.distance).toBeCloseTo(2, 9);
    expect(w.sweepCapsule(v(0, -0.5, 0), v(5, -0.5, 0), 0.5, 1)!.dynamic).toBe(true);
    // Move two cells over (cell 0 → cell 2): the old spot is empty, the new one is found.
    expect(w.upsertDynamic(box(30, v(40, -1, -1), v(41, 1, 1)))).toBe(true);
    expect(w.overlapCapsule(v(2.5, -1, 0), 0.5, 2)).toEqual([]);
    const moved = w.overlapCapsule(v(40.5, -1, 0), 0.5, 2);
    expect(moved.map((c) => [c.colliderId, c.dynamic])).toEqual([[30, true]]);
    expect(w.raycast(v(0, 0, 0), v(1, 0, 0), 100)!.distance).toBeCloseTo(40, 9);
    // Back across the negative boundary.
    expect(w.upsertDynamic(box(30, v(-17, -1, -1), v(-16.5, 1, 1)))).toBe(true);
    expect(w.raycast(v(0, 0, 0), v(-1, 0, 0), 100)!.distance).toBeCloseTo(16.5, 9);
    expect(w.raycast(v(0, 0, 0), v(1, 0, 0), 100)).toBeNull();
    // An invalid shape is rejected and the previous collider stays.
    expect(w.upsertDynamic(col(30, { kind: 'sphere', center: v(0, 0, 0), radius: -1 }))).toBe(false);
    expect(w.raycast(v(0, 0, 0), v(-1, 0, 0), 100)!.colliderId).toBe(30);
    expect(w.removeDynamic(30)).toBe(true);
    expect(w.removeDynamic(30)).toBe(false);
    expect(w.raycast(v(0, 0, 0), v(-1, 0, 0), 100)).toBeNull();
  });

  it('keeps ids unique across static and dynamic colliders', () => {
    const w = colliderWorld();
    w.addStatic(box(31, v(2, -1, -1), v(3, 1, 1)));
    expect(w.upsertDynamic(box(31, v(5, -1, -1), v(6, 1, 1)))).toBe(false);
    expect(w.removeDynamic(31)).toBe(false);
    expect(w.upsertDynamic(box(32, v(5, -1, -1), v(6, 1, 1)))).toBe(true);
    expect(() => w.addStatic(box(32, v(8, -1, -1), v(9, 1, 1)))).toThrow();
    expect(() => w.addStatic(box(31, v(8, -1, -1), v(9, 1, 1)))).toThrow();
  });

  it('addStatic throws on invalid geometry and changes nothing', () => {
    const w = colliderWorld();
    expect(() => w.addStatic(box(1, v(2, 0, 0), v(1, 1, 1)))).toThrow(TypeError);
    expect(() => w.addStatic(box(2, v(NaN, 0, 0), v(1, 1, 1)))).toThrow(TypeError);
    expect(() => w.addStatic(col(3, { kind: 'sphere', center: v(5, 0, 0), radius: 0 }))).toThrow(TypeError);
    expect(() => w.addStatic({ ...box(4, v(5, -1, -1), v(6, 1, 1)), id: Infinity })).toThrow(TypeError);
    expect(w.raycast(v(0, 0, 0), v(1, 0, 0), 100)).toBeNull();
  });

  it('copies colliders so later edits by the caller have no effect', () => {
    const w = colliderWorld();
    const c = box(5, v(5, -1, -1), v(6, 1, 1));
    w.addStatic(c);
    if (c.kind === 'aabb') c.min.x = 50;
    expect(w.raycast(v(0, 0, 0), v(1, 0, 0), 100)!.distance).toBeCloseTo(5, 9);
  });
});

describe('NaN defense', () => {
  it('returns null / [] for bad input before any valid result', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    expect(w.sweepCapsule(v(NaN, 0, 0), v(1, 0, 0), 0.5, 2)).toBeNull();
    expect(w.overlapCapsule(v(0, Infinity, 0), 0.5, 2)).toEqual([]);
    expect(w.raycast(v(0, 1, 0), v(0, 0, 0), 10)).toBeNull();
    expect(w.groundProbe(v(0, NaN, 0), 1)).toBeNull();
    expect(w.closestSurface(v(-Infinity, 0, 0), 1, {})).toBeNull();
  });

  it('returns each method’s previous valid result for NaN / Infinity input', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    w.addStatic(box(1, v(1, 0, -1), v(2, 2, 1)));
    const sweep = w.sweepCapsule(v(0, 2, 0), v(0, -1, 0), 0.5, 2);
    const overlap = w.overlapCapsule(v(0.8, -0.1, 0), 0.5, 2);
    const ray = w.raycast(v(0, 10, 0), v(0, -1, 0), 50);
    const ground = w.groundProbe(v(0, 0.3, 0), 1);
    const surface = w.closestSurface(v(0.6, 1, 0), 1, {});
    expect([sweep, ray, ground, surface].every((r) => r !== null)).toBe(true);
    expect(overlap.length).toBe(2);
    expect(w.sweepCapsule(v(0, 2, 0), v(Infinity, 0, 0), 0.5, 2)).toEqual(sweep);
    expect(w.sweepCapsule(v(0, 2, 0), v(0, -1, 0), NaN, 2)).toEqual(sweep);
    expect(w.overlapCapsule(v(0, 0, 0), 0.5, NaN)).toEqual(overlap);
    expect(w.raycast(v(0, 10, 0), v(0, 0, 0), 50)).toEqual(ray);
    expect(w.raycast(v(0, 10, 0), v(0, -1, 0), Infinity)).toEqual(ray);
    expect(w.groundProbe(v(0, 0.3, 0), NaN)).toEqual(ground);
    expect(w.closestSurface(v(0.6, 1, 0), NaN, {})).toEqual(surface);
    // A valid "nothing found" is also remembered.
    expect(w.raycast(v(0, 1, 0), v(0, 1, 0), 10)).toBeNull();
    expect(w.raycast(v(NaN, 1, 0), v(0, 1, 0), 10)).toBeNull();
    // Fallbacks are copies: editing one does not change the next.
    const copy = w.groundProbe(v(NaN, 0, 0), 1)!;
    copy.point.y = 99;
    expect(w.groundProbe(v(NaN, 0, 0), 1)).toEqual(ground);
  });

  it('drops results computed from a terrain that returns NaN', () => {
    let poison = false;
    const hf: Heightfield = {
      heightAt: (x) => (poison && x > 50 ? NaN : 0),
      materialAt: () => 'grass',
      walkable: () => true,
    };
    const w = createCollisionWorld(hf);
    const ground = w.groundProbe(v(0, 0.5, 0), 1);
    const sweep = w.sweepCapsule(v(0, 2, 0), v(0, -1, 0), 0.5, 2);
    const ray = w.raycast(v(0, 10, 0), v(0, -1, 0), 50);
    const overlap = w.overlapCapsule(v(0, -0.2, 0), 0.5, 2);
    const surface = w.closestSurface(v(0, 0.5, 0), 1, {});
    poison = true;
    expect(w.groundProbe(v(60, 0.5, 0), 1)).toEqual(ground);
    expect(w.sweepCapsule(v(0, 0.5, 0), v(100, 0.5, 0), 0.5, 2)).toEqual(sweep);
    expect(w.raycast(v(60, 10, 0), v(0, -1, 0), 50)).toEqual(ray);
    expect(w.overlapCapsule(v(60, 0, 0), 0.5, 2)).toEqual(overlap);
    expect(w.closestSurface(v(60, 0.5, 0), 1, {})).toEqual(surface);
    // Queries that never touch the poisoned region still work.
    expect(w.groundProbe(v(0, 0.25, 0), 1)!.distance).toBeCloseTo(0.25, 9);
  });
});
