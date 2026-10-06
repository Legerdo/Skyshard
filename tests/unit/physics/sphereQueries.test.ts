import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import { overlapSphere, sweepSphere } from '../../../src/physics/sphereQueries';
import type { Collider, ColliderFlags } from '../../../src/physics/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
/** Components rounded to 6 decimals (also turns −0 into 0). */
const r6 = (a: Vec3): number[] => [a.x, a.y, a.z].map((c) => +c.toFixed(6));

function box(id: number, min: Vec3, max: Vec3, f: Partial<ColliderFlags> = {}): Collider {
  return { kind: 'aabb', min, max, id, flags: { climbable: false, walkableTop: true, blocksCamera: true, material: 'stone', ...f } };
}

describe('sweepSphere', () => {
  it('stops where the sphere surface first touches a collider and reports the centre there', () => {
    const w = createCollisionWorld(flatHeightfield(-100));
    w.addStatic(box(1, v(-2, 0, -4), v(2, 3, -3)));
    const hit = sweepSphere(w, v(0, 1.5, 0), v(0, 1.5, -5), 0.25);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(2.75, 6); // face at z = −3, radius 0.25
    expect(hit!.t).toBeCloseTo(0.55, 6);
    expect(r6(hit!.center)).toEqual([0, 1.5, -2.75]);
    expect(r6(hit!.normal)).toEqual([0, 0, 1]);
    expect(hit!.colliderId).toBe(1);
  });

  it('meets the terrain with the sphere bottom and passes 5 cm above it', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    const hit = sweepSphere(w, v(3, 2, 1), v(3, -1, 1), 0.25);
    expect(hit).not.toBeNull();
    expect(hit!.center.y).toBeCloseTo(0.25, 3);
    expect(hit!.distance).toBeCloseTo(1.75, 3);
    expect(hit!.colliderId).toBeNull();
    expect(sweepSphere(w, v(0, 0.3, 0), v(5, 0.3, 0), 0.25)).toBeNull();
  });

  it('applies the query mask to colliders', () => {
    const w = createCollisionWorld(flatHeightfield(-100));
    w.addStatic(box(1, v(-2, 0, -4), v(2, 3, -3), { blocksCamera: false }));
    expect(sweepSphere(w, v(0, 1.5, 0), v(0, 1.5, -5), 0.25, { mask: 'camera' })).toBeNull();
    expect(sweepSphere(w, v(0, 1.5, 0), v(0, 1.5, -5), 0.25)?.colliderId).toBe(1);
  });
});

describe('overlapSphere', () => {
  it('reports terrain and collider penetrations of the sphere, filtered by the mask', () => {
    const w = createCollisionWorld(flatHeightfield(0));
    w.addStatic(box(2, v(1, 0, -1), v(2, 2, 1)));
    expect(overlapSphere(w, v(0, 0.3, 0), 0.25)).toEqual([]);
    const ground = overlapSphere(w, v(0, 0.2, 0), 0.25);
    expect(ground).toHaveLength(1);
    expect(ground[0].depth).toBeCloseTo(0.05, 6);
    expect(ground[0].colliderId).toBeNull();
    const wall = overlapSphere(w, v(0.9, 1, 0), 0.25);
    expect(wall).toHaveLength(1);
    expect(wall[0].depth).toBeCloseTo(0.15, 9);
    expect(wall[0].colliderId).toBe(2);
    expect(overlapSphere(w, v(0.9, 1, 0), 0.25, { mask: 'climb' })).toEqual([]);
  });
});
