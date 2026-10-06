import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { InputState } from '../../../src/input/inputState';
import { PLAY_RADIUS } from '../../../src/data/worldLayout';
import { ColliderIdSource } from '../../../src/physics/colliderIds';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import type { CollisionWorld } from '../../../src/physics/types';
import { CAPSULE_HEIGHT, CAPSULE_RADIUS } from '../../../src/player/core/constants';
import { PlayerController } from '../../../src/player/playerController';
import {
  addBoundaryWall, BOUNDARY_WALL_MAX_Y, BOUNDARY_WALL_MIN_Y, BOUNDARY_WALL_SEGMENTS, boundaryWallColliders,
} from '../../../src/world/worldEdge';
import { buildTerrain, RING_MOUNTAINS, type TerrainField } from '../../../src/world/terrain';

// Task 20.4 (Req 8.6): the play area ends 470 m from the centre. The ring mountains rise beyond it, and the invisible
// boundary wall stops walking, climbing and gliding out at any angle and height.

const SEED = 20240601;

function walledWorld(): CollisionWorld {
  const world = createCollisionWorld(flatHeightfield(0));
  addBoundaryWall(world, new ColliderIdSource());
  return world;
}

let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

describe('World edge (Req 8.6)', () => {
  it('builds a closed ring of tall, unclimbable wall segments that do not block the camera', () => {
    const walls = boundaryWallColliders(new ColliderIdSource());
    expect(walls).toHaveLength(BOUNDARY_WALL_SEGMENTS);
    expect(BOUNDARY_WALL_MIN_Y).toBeLessThan(-20);
    expect(BOUNDARY_WALL_MAX_Y).toBeGreaterThan(400);
    for (const w of walls) expect(w.flags).toMatchObject({ climbable: false, walkableTop: false, blocksCamera: false });
  });

  it('a capsule moving outward is stopped at the 470 m circle, at any angle and height', () => {
    const world = walledWorld();
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
        fc.double({ min: 0.5, max: 380, noNaN: true }),
        (a, y) => {
          const dir = { x: Math.sin(a), z: Math.cos(a) };
          const from = { x: dir.x * (PLAY_RADIUS - 10), y, z: dir.z * (PLAY_RADIUS - 10) };
          const to = { x: dir.x * (PLAY_RADIUS + 30), y, z: dir.z * (PLAY_RADIUS + 30) };
          const hit = world.sweepCapsule(from, to, CAPSULE_RADIUS, CAPSULE_HEIGHT);
          expect(hit).not.toBeNull();
          const r = Math.hypot(hit?.position.x ?? 0, hit?.position.z ?? 0);
          expect(r).toBeLessThanOrEqual(PLAY_RADIUS);
          // Nothing inside the play area is walled off.
          expect(r).toBeGreaterThan(PLAY_RADIUS - CAPSULE_RADIUS - 2.5);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a character running outward stays inside the play area', () => {
    const world = walledWorld();
    const input = new InputState();
    const pc = new PlayerController({ world, pos: { x: 0, y: 0, z: PLAY_RADIUS - 6 }, yaw: 0 });
    const dt = 1 / 60;
    input.beginTick([{ kind: 'down', code: 'KeyW', time: 0 }], dt);
    for (let i = 0; i < 300; i++) {
      pc.tick(input, 0, dt);
      input.beginTick([], dt);
    }
    expect(Math.hypot(pc.state.pos.x, pc.state.pos.z)).toBeLessThanOrEqual(PLAY_RADIUS);
    expect(pc.state.pos.z).toBeGreaterThan(PLAY_RADIUS - 3);
  });

  it('ring mountains rise beyond the boundary all the way round, open only at the river gorge', () => {
    const low: number[] = [];
    for (let deg = 0; deg < 360; deg++) {
      const a = (deg * Math.PI) / 180;
      const at = (r: number): number => terrain.heightAt(Math.sin(a) * r, Math.cos(a) * r);
      if (at(RING_MOUNTAINS.full) - at(PLAY_RADIUS - 10) <= 100) low.push(deg);
      expect(terrain.insideBoundary(Math.sin(a) * (PLAY_RADIUS + 1), Math.cos(a) * (PLAY_RADIUS + 1))).toBe(false);
    }
    // river_verdant leaves through one narrow gorge (the boundary wall closes it, see above).
    expect(low.length).toBeLessThanOrEqual(12);
    if (low.length > 0) expect(Math.max(...low) - Math.min(...low)).toBeLessThanOrEqual(15);
  });
});
