import { describe, expect, it } from 'vitest';
import { distanceXZ, type Vec3 } from '../../../src/core/math';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import {
  MAX_SEPARATION_AGENT_RADIUS,
  SEPARATION_SPEED,
  SEPARATION_TIME,
  resolvePlayerOverlaps,
  type SeparationBody,
} from '../../../src/physics/separation';
import type { Collider, CollisionWorld } from '../../../src/physics/types';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const DT = 1 / 60;
/** Ticks in SEPARATION_TIME at 60 Hz (12). */
const MAX_TICKS = Math.round(SEPARATION_TIME / DT);
const PLAYER_RADIUS = 0.4;
const PLAYER_HEIGHT = 1.75;
const AGENT_HEIGHT = 1.8;
const RADII = [0.3, 0.5, 0.75, 1, 1.25, 1.5];

const player = (pos: Vec3 = v(0, 0, 0)): SeparationBody => ({ id: 0, pos, radius: PLAYER_RADIUS, height: PLAYER_HEIGHT });
const agent = (id: number, pos: Vec3, radius: number, height = AGENT_HEIGHT): SeparationBody => ({ id, pos, radius, height });
const openWorld = (): CollisionWorld => createCollisionWorld(flatHeightfield(0));
const wall = (id: number, min: Vec3, max: Vec3): Collider => ({
  kind: 'aabb',
  min,
  max,
  id,
  flags: { climbable: false, walkableTop: false, blocksCamera: true, material: 'stone' },
});

interface Run {
  /** Tick on which the agent cleared the player, Infinity when it never did. */
  ticks: number;
  /** Agent position after every tick. */
  path: Vec3[];
  /** Every `blocked` id reported along the way. */
  blocked: number[];
}

/** Steps one agent against a fixed player until it clears the player's capsule or maxTicks pass. */
function runUntilSeparated(world: CollisionWorld, p: SeparationBody, a: SeparationBody, maxTicks = 60): Run {
  const path: Vec3[] = [];
  const blocked: number[] = [];
  let body = a;
  for (let tick = 1; tick <= maxTicks; tick++) {
    const res = resolvePlayerOverlaps(world, p, [body], DT);
    body = { ...body, pos: res.positions[0] };
    path.push(body.pos);
    blocked.push(...res.blocked);
    if (distanceXZ(body.pos, p.pos) >= p.radius + a.radius) return { ticks: tick, path, blocked };
  }
  return { ticks: Infinity, path, blocked };
}

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object') {
    for (const value of Object.values(o)) deepFreeze(value);
    Object.freeze(o);
  }
  return o;
}

describe('resolvePlayerOverlaps: separation time (Req 20.2)', () => {
  it('SEPARATION_SPEED clears the deepest supported overlap within SEPARATION_TIME', () => {
    expect(MAX_TICKS).toBe(12);
    expect((PLAYER_RADIUS + MAX_SEPARATION_AGENT_RADIUS) / SEPARATION_SPEED).toBeLessThanOrEqual(SEPARATION_TIME);
  });

  it.each(RADII)('separates an agent sharing the player centre (r = %s) within 12 ticks', (r) => {
    const world = openWorld();
    for (const id of [1, 2, 3, 7, 42]) {
      const run = runUntilSeparated(world, player(), agent(id, v(0, 0, 0), r));
      expect(run.ticks).toBeLessThanOrEqual(MAX_TICKS);
      expect(run.blocked).toEqual([]);
      for (const pos of run.path) expect(pos.y).toBe(0); // horizontal push only
    }
  });

  it.each(RADII)('separates an agent at 50% overlap (r = %s) within 12 ticks, straight away from the player', (r) => {
    const world = openWorld();
    const half = (PLAYER_RADIUS + r) / 2;
    for (const yaw of [0, 1, 2.5, -2]) {
      const start = v(Math.sin(yaw) * half, 0, Math.cos(yaw) * half);
      const run = runUntilSeparated(world, player(), agent(1, start, r));
      expect(run.ticks).toBeLessThanOrEqual(MAX_TICKS);
      let prev = start;
      for (const pos of run.path) {
        expect(distanceXZ(pos, prev)).toBeLessThanOrEqual(SEPARATION_SPEED * DT + 1e-12); // rate-limited
        expect(Math.atan2(pos.x, pos.z)).toBeCloseTo(yaw, 9); // along the centre line
        prev = pos;
      }
    }
  });
});

describe('resolvePlayerOverlaps: untouched agents', () => {
  it('leaves agents that do not overlap horizontally unchanged', () => {
    const world = openWorld();
    const agents = [
      agent(1, v(PLAYER_RADIUS + 0.5, 0, 0), 0.5), // exactly touching
      agent(2, v(0, 0, -(PLAYER_RADIUS + 0.5 + 0.01)), 0.5),
      agent(3, v(5, 0, 5), 1.5),
    ];
    const res = resolvePlayerOverlaps(world, player(), agents, DT);
    expect(res.positions).toEqual(agents.map((a) => a.pos));
    expect(res.blocked).toEqual([]);
  });

  it('leaves agents at a different height (no vertical overlap) unchanged', () => {
    const world = openWorld();
    const agents = [
      agent(1, v(0.1, PLAYER_HEIGHT + 0.01, 0), 0.5), // on a ledge above the player's head
      agent(2, v(0, -AGENT_HEIGHT - 0.01, 0.2), 0.5), // entirely below the player's feet
    ];
    const res = resolvePlayerOverlaps(world, player(), agents, DT);
    expect(res.positions).toEqual(agents.map((a) => a.pos));
    expect(res.blocked).toEqual([]);

    // Control: the same horizontal overlap with overlapping heights is pushed.
    const control = resolvePlayerOverlaps(world, player(), [agent(3, v(0.1, 1, 0), 0.5)], DT);
    expect(control.positions[0].x).toBeGreaterThan(0.1);
  });
});

describe('resolvePlayerOverlaps: walls', () => {
  const WALL_ID = 10;
  const insideWall = (world: CollisionWorld, pos: Vec3, r: number) =>
    world.overlapCapsule(pos, r, AGENT_HEIGHT).filter((c) => c.colliderId === WALL_ID && c.depth > 1e-6);

  it('slides an agent pushed into a wall along it and never ends inside the wall', () => {
    const world = openWorld();
    const face = 1.85;
    world.addStatic(wall(WALL_ID, v(face, 0, -10), v(face + 1, 3, 10)));
    const r = 0.5;
    const p = player(v(1, 0, 0));
    const start = v(1.3, 0, 0.4); // d = 0.5 < 0.9; the push points 37° off the wall normal
    expect(insideWall(world, start, r)).toEqual([]);

    const run = runUntilSeparated(world, p, agent(1, start, r));
    expect(run.ticks).toBeLessThanOrEqual(MAX_TICKS);
    expect(run.blocked).toEqual([]);
    for (const pos of run.path) {
      expect(pos.x).toBeLessThanOrEqual(face - r + 1e-9);
      expect(insideWall(world, pos, r)).toEqual([]);
    }
    const end = run.path[run.path.length - 1];
    expect(end.x).toBeGreaterThan(face - r - 0.01); // still against the wall
    expect(end.z).toBeGreaterThan(start.z + 0.3); // slid along it
  });

  it('reports an agent pinned head-on between the player and a wall as blocked and leaves it in place', () => {
    const world = openWorld();
    world.addStatic(wall(WALL_ID, v(1, 0, -10), v(2, 3, 10)));
    const r = 0.5;
    const start = v(1 - r, 0, 0); // touching the wall face at x = 1
    const run = runUntilSeparated(world, player(v(0.2, 0, 0)), agent(7, start, r), 3);
    expect(run.ticks).toBe(Infinity);
    expect(run.blocked).toEqual([7, 7, 7]);
    for (const pos of run.path) {
      expect(pos).toEqual(start);
      expect(insideWall(world, pos, r)).toEqual([]);
    }
  });
});

describe('resolvePlayerOverlaps: purity', () => {
  it('does not mutate its inputs and returns fresh position objects', () => {
    const world = openWorld();
    const p = deepFreeze(player());
    const agents = deepFreeze([agent(1, v(0.1, 0, 0.2), 0.6), agent(2, v(3, 0, 3), 0.5), agent(3, v(0, 0, 0), 1)]);
    const before = structuredClone({ p, agents });
    const res = resolvePlayerOverlaps(world, p, agents, DT);
    expect({ p, agents }).toEqual(before);
    expect(res.positions).toHaveLength(agents.length);
    res.positions.forEach((pos, i) => expect(pos).not.toBe(agents[i].pos));
  });

  it('is deterministic, including the push direction for coincident centres', () => {
    const agents = [agent(5, v(0, 0, 0), 0.8), agent(6, v(0, 0, 0), 0.8), agent(8, v(0.2, 0, -0.1), 1.2)];
    const a = resolvePlayerOverlaps(openWorld(), player(), agents, DT);
    const b = resolvePlayerOverlaps(openWorld(), player(), agents, DT);
    expect(a).toEqual(b);
    expect(a.positions[0]).not.toEqual(a.positions[1]); // different ids scatter differently
  });

  it('leaves NaN positions unchanged, and everything when the player or dt is invalid', () => {
    const world = openWorld();
    const nanAgent = agent(1, v(Number.NaN, 0, 0), 0.5);
    const ok = agent(2, v(0.1, 0, 0), 0.5);
    const res = resolvePlayerOverlaps(world, player(), [nanAgent, ok], DT);
    expect(res.positions[0]).toEqual(nanAgent.pos);
    expect(res.positions[1]).not.toEqual(ok.pos); // the valid agent is still pushed
    expect(res.blocked).toEqual([]);

    expect(resolvePlayerOverlaps(world, player(v(0, Number.NaN, 0)), [ok], DT).positions).toEqual([ok.pos]);
    for (const dt of [Number.NaN, 0, -DT, Number.POSITIVE_INFINITY]) {
      expect(resolvePlayerOverlaps(world, player(), [ok], dt).positions).toEqual([ok.pos]);
    }
  });
});
