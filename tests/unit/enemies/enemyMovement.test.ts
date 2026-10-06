import { describe, expect, it } from 'vitest';
import type { HitReceiver, ResolvedHit } from '../../../src/combat/attackRuntime';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { angleDelta, distanceXZ } from '../../../src/core/math';
import type { Vec3 } from '../../../src/core/types';
import { getEnemyDef } from '../../../src/data/enemies';
import { ELITE_IDS, ENEMY_IDS, type EliteId, type EnemyId, type EntityId } from '../../../src/data/ids';
import { APPROACH_MARGIN, EnemySystem } from '../../../src/enemies/enemySystem';
import { probeBlockedAt, type EnemyTerrain, type ProbeEnv } from '../../../src/enemies/terrainProbe';
import { MeleeTokenPool } from '../../../src/logic/ai';
import type { Planar } from '../../../src/logic/aiSteering';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { analyticHeightfield, flatHeightfield } from '../../../src/physics/heightfield';
import { MAX_SEPARATION_AGENT_RADIUS } from '../../../src/physics/separation';
import type { Collider, CollisionWorld } from '../../../src/physics/types';
import type { EnemyRuntime } from '../../../src/save/runtimeState';

// Enemy movement (design "공격 토큰과 분리", "지형 탐지와 이동"; Req 28.6–28.8, 20.2, 20.7): melee tokens and the
// waiting ring, separation steering and CollisionResolve spacing / push-out, terrain probes, the 2 s progress rule
// and the out-of-world reset, in the EnemySystem against a movable stand-in for the Active_Character.
const DT = 1 / 60;
const FLAT: EnemyTerrain = { heightAt: () => 0 };
const TARGET_RADIUS = 0.4;
const TARGET_HEIGHT = 1.75;
const BRAMBLEKIN_REACH = getEnemyDef('bramblekin').attackRange + TARGET_RADIUS - APPROACH_MARGIN;

interface Options {
  tokens?: MeleeTokenPool;
  world?: CollisionWorld;
  terrain?: EnemyTerrain;
  /** Run CollisionResolve after every tick, as the PlaySim does (default true). */
  resolve?: boolean;
}

function setup(options: Options = {}) {
  const bus = createGameEventBus();
  const map = new Map<EntityId, EnemyRuntime>();
  const world = options.world ?? createCollisionWorld(flatHeightfield(0));
  const enemies = new EnemySystem({
    enemies: map, terrain: options.terrain ?? FLAT, bus, tokens: options.tokens, world: options.world,
  });
  const pos: Vec3 = { x: 0, y: 0, z: 0 };
  const taken: ResolvedHit[] = [];
  const player: HitReceiver = {
    id: 'player',
    hurtVolume: () => ({ pos, radius: TARGET_RADIUS, height: TARGET_HEIGHT }),
    immune: () => false,
    sample: () => ({ def: 50, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
    receive: (hit) => {
      taken.push(hit);
    },
  };
  const get = (id: EntityId): EnemyRuntime => {
    const e = map.get(id);
    if (e === undefined) throw new Error(`${id} gone`);
    return e;
  };
  const resolve = (): void => enemies.resolveCollisions(world, player.hurtVolume(), DT);
  const tick = (n = 1, before?: () => void): void => {
    for (let i = 0; i < n; i++) {
      before?.();
      enemies.tick({ dt: DT, player });
      if (options.resolve !== false) resolve();
      bus.dispatch();
    }
  };
  const tickUntil = (done: () => boolean, max: number, before?: () => void): number => {
    let n = 0;
    while (!done()) {
      if (n >= max) throw new Error(`not done after ${max} ticks`);
      tick(1, before);
      n += 1;
    }
    return n;
  };
  const hit = (id: EntityId, stagger = 0, amount = 1): void => {
    const r = [...enemies.receivers()].find((x) => x.id === id);
    if (r === undefined) throw new Error(`no receiver ${id}`);
    r.receive({
      attackerId: 'player', attackId: 'atk_kairen_n1', hitIndex: 0, kind: 'normal', amount, crit: false,
      element: null, stagger, knockback: 0, direction: { x: 0, y: 0, z: 1 },
    });
  };
  const place = (p: Partial<Vec3>): void => {
    Object.assign(pos, p);
  };
  const spawn = (kind: EnemyId | EliteId, at: Partial<Vec3>, yaw = 0): EntityId =>
    enemies.spawn({ kind, pos: { x: 0, y: 0, z: 0, ...at }, yaw });
  return { enemies, map, world, pos, taken, get, resolve, tick, tickUntil, hit, place, spawn };
}

type Harness = ReturnType<typeof setup>;

/** A Bramblekin 5 m from the target (at the origin) facing it, ticked until its first attack starts. */
function attackingBramblekin(h: Harness): EntityId {
  const id = h.spawn('bramblekin', { z: 5 }, Math.PI);
  h.tickUntil(() => h.get(id).state === 'attack', 120);
  return id;
}

/** A solid box. */
const box = (id: number, min: Vec3, max: Vec3): Collider => ({
  kind: 'aabb', id, min, max, flags: { climbable: false, walkableTop: false, blocksCamera: true, material: 'stone' },
});

describe('melee tokens (Req 28.6)', () => {
  it('a holder keeps its token through the attack and its recovery and gives it back when the recovery ends', () => {
    const h = setup();
    const id = attackingBramblekin(h);
    expect([...h.enemies.tokens.holders]).toEqual([id]);
    h.tickUntil(() => h.get(id).state === 'recovery', 120);
    expect(h.enemies.tokens.holders.has(id)).toBe(true);
    h.place({ z: -3 }); // out of reach, so the chase that follows closes in instead of attacking again
    h.tickUntil(() => h.get(id).state === 'chase', 60);
    expect(h.enemies.tokens.holders.size).toBe(0);
  });

  it('entering stagger gives the token back', () => {
    const h = setup();
    const id = attackingBramblekin(h);
    h.hit(id, 100);
    h.tick();
    expect(h.get(id).state).toBe('stagger');
    expect(h.enemies.tokens.holders.size).toBe(0);
  });

  it('death gives the token back', () => {
    const h = setup();
    const id = attackingBramblekin(h);
    h.hit(id, 0, 10_000);
    expect(h.get(id).state).toBe('dead');
    expect(h.enemies.tokens.holders.size).toBe(0);
  });

  it('entering return gives the token back', () => {
    const h = setup();
    const id = h.spawn('bramblekin', {}, 0);
    h.place({ z: 10 });
    h.tickUntil(() => h.get(id).state === 'chase', 60);
    expect(h.enemies.tokens.acquire(id)).toBe(true); // holding one while it chases a target it never reaches
    h.tickUntil(() => h.get(id).state === 'return', 60 * 15, () => {
      if (h.get(id).state === 'chase') h.place({ z: h.get(id).pos.z + 10 });
    });
    expect(h.enemies.tokens.holders.size).toBe(0);
  });

  it('ranged enemies attack without tokens', () => {
    const h = setup({ tokens: new MeleeTokenPool(0), world: createCollisionWorld(flatHeightfield(0)) });
    const id = h.spawn('aetherSentinel', {}, 0);
    h.place({ z: 11 });
    h.tickUntil(() => h.get(id).state === 'attack', 60);
    expect(h.enemies.tokens.holders.size).toBe(0);
  });
});

describe('waiting ring (Req 28.6)', () => {
  /** Bearing change (rad, positive: counter-clockwise from above) and the distance range over `ticks` ticks. */
  function circle(h: Harness, id: EntityId, ticks: number) {
    let turned = 0;
    let min = Infinity;
    let max = -Infinity;
    let bearing = Math.atan2(h.get(id).pos.x, h.get(id).pos.z);
    h.tick(ticks, () => {
      const p = h.get(id).pos;
      const next = Math.atan2(p.x - h.pos.x, p.z - h.pos.z);
      turned += angleDelta(bearing, next);
      bearing = next;
      const d = distanceXZ(p, h.pos);
      min = Math.min(min, d);
      max = Math.max(max, d);
    });
    return { turned, min, max };
  }

  it.each([
    ['even', 0, 1],
    ['odd', 1, -1],
  ] as const)('refused a token, a melee enemy with an %s ordinal circles 4–6 m around the target (side %i)', (_l, seq, side) => {
    const h = setup({ tokens: new MeleeTokenPool(0) });
    if (seq === 1) h.spawn('bramblekin', { z: 300 }); // ordinal 0, asleep far away
    const id = h.spawn('bramblekin', { z: 5 }, Math.PI);
    expect(h.get(id).seq).toBe(seq);
    h.tick(300);
    expect([h.get(id).state, h.get(id).circling]).toEqual(['chase', true]);
    const { turned, min, max } = circle(h, id, 60);
    expect(Math.sign(turned)).toBe(side);
    expect(Math.abs(turned)).toBeGreaterThan(0.3); // ≈ 2.1 m/s on a 5 m ring
    expect(min).toBeGreaterThanOrEqual(4);
    expect(max).toBeLessThanOrEqual(6);
    expect(h.taken).toEqual([]);
  });

  it('it asks again every decision: a freed token is taken within one decision, then it closes in and attacks', () => {
    const tokens = new MeleeTokenPool(1);
    tokens.acquire('someone_else');
    const h = setup({ tokens });
    const id = h.spawn('bramblekin', { z: 5 }, Math.PI);
    h.tick(240);
    expect(h.get(id).circling).toBe(true);
    expect(distanceXZ(h.get(id).pos, h.pos)).toBeGreaterThan(4);
    tokens.release('someone_else');
    expect(h.tickUntil(() => tokens.holders.has(id), 3)).toBeLessThanOrEqual(3);
    expect(h.get(id).circling).toBe(false);
    h.tickUntil(() => h.get(id).state === 'attack', 120);
    expect(distanceXZ(h.get(id).pos, h.pos)).toBeCloseTo(BRAMBLEKIN_REACH, 6);
  });
});

describe('separation (Req 28.7, 20.2)', () => {
  it('separation steering spreads enemies that approach side by side, before any CollisionResolve', () => {
    const h = setup({ resolve: false });
    const a = h.spawn('bramblekin', { x: -0.3, z: 10 }, Math.PI);
    const b = h.spawn('bramblekin', { x: 0.3, z: 10 }, Math.PI);
    h.tickUntil(() => h.get(a).state === 'chase' && h.get(b).state === 'chase', 60);
    h.tick(30);
    expect(distanceXZ(h.get(a).pos, h.get(b).pos)).toBeGreaterThanOrEqual(1.2);
    for (const id of [a, b]) expect(distanceXZ(h.get(id).pos, h.pos)).toBeLessThan(9);
  });

  it('CollisionResolve keeps enemies 1.2 m apart, or their radius sum when larger', () => {
    const h = setup();
    h.place({ z: -20 }); // within 80 m, overlapping nobody
    const pairs: [EntityId, EntityId, number][] = [
      [h.spawn('bramblekin', { z: 10 }), h.spawn('bramblekin', { x: 0.5, z: 10 }), 1.2],
      [h.spawn('mossbackBrute', { x: 20, z: 10 }), h.spawn('mossbackBrute', { x: 21.5, z: 10 }), 2],
      [h.spawn('bramblekin', { x: -20, z: 10 }), h.spawn('mossbackBrute', { x: -19, z: 10 }), 1.5],
    ];
    const trio = [
      h.spawn('bramblekin', { z: 30 }), h.spawn('bramblekin', { x: 0.3, z: 30 }), h.spawn('bramblekin', { x: 0.6, z: 30.2 }),
    ];
    h.resolve();
    for (const [a, b, spacing] of pairs) expect(distanceXZ(h.get(a).pos, h.get(b).pos)).toBeCloseTo(spacing, 9);
    for (let i = 0; i < trio.length; i++) {
      for (let j = i + 1; j < trio.length; j++) {
        expect(distanceXZ(h.get(trio[i]!).pos, h.get(trio[j]!).pos)).toBeGreaterThanOrEqual(1.2 - 1e-9);
      }
    }
    for (const e of h.map.values()) expect(e.pos.y).toBe(0);
  });

  it.each(['bramblekin', 'rootboundWarden'] as const)(
    'a %s sharing the player’s centre is pushed out of its capsule within 0.2 s (12 ticks)',
    (kind) => {
      const radius = getEnemyDef(kind).radius;
      expect(radius).toBeLessThanOrEqual(MAX_SEPARATION_AGENT_RADIUS);
      const h = setup();
      const id = h.spawn(kind, {});
      const ticks = h.tickUntil(() => distanceXZ(h.get(id).pos, h.pos) >= TARGET_RADIUS + radius, 12);
      expect(ticks).toBeLessThanOrEqual(12);
    },
  );

  it('every enemy and Elite body is inside the push-out guarantee', () => {
    for (const kind of [...ENEMY_IDS, ...ELITE_IDS]) {
      expect(getEnemyDef(kind).radius, kind).toBeLessThanOrEqual(MAX_SEPARATION_AGENT_RADIUS);
    }
  });
});

describe('terrain probes (Req 28.8)', () => {
  const FEET: Vec3 = { x: 0, y: 0, z: 0 };
  const AHEAD: Planar = { x: 0, z: 1 };
  const HEIGHT = 1.3; // waist at 0.65 m
  const env = (terrain: EnemyTerrain, world: CollisionWorld | null = null, ground?: ProbeEnv['ground']): ProbeEnv => ({
    terrain,
    ground: ground ?? ((p) => terrain.heightAt(p.x, p.z)),
    world,
  });
  const beyond = (value: number, near = 0) => (_x: number, z: number) => (z > 1 ? value : near);

  it('flat open ground is open', () => {
    expect(probeBlockedAt(env(FLAT, createCollisionWorld(flatHeightfield(0))), FEET, HEIGHT, AHEAD)).toBe(false);
  });

  it('ground more than 2.5 m below the feet blocks', () => {
    expect(probeBlockedAt(env({ heightAt: beyond(-2.6) }), FEET, HEIGHT, AHEAD)).toBe(true);
    expect(probeBlockedAt(env({ heightAt: beyond(-2.4) }), FEET, HEIGHT, AHEAD)).toBe(false);
    // Off a platform top 3 m up: the ground ahead is the terrain far below.
    expect(probeBlockedAt(env(FLAT, null, (p) => (p.z < 1 ? 3 : 0)), { x: 0, y: 3, z: 0 }, HEIGHT, AHEAD)).toBe(true);
  });

  it('a terrain slope over 50° blocks', () => {
    expect(probeBlockedAt(env({ heightAt: () => 0, slopeDeg: beyond(51) }), FEET, HEIGHT, AHEAD)).toBe(true);
    expect(probeBlockedAt(env({ heightAt: () => 0, slopeDeg: beyond(49) }), FEET, HEIGHT, AHEAD)).toBe(false);
  });

  it('water deeper than 1 m blocks, except under a walkable collider top (a bridge)', () => {
    expect(probeBlockedAt(env({ heightAt: () => 0, waterDepthAt: beyond(1.1) }), FEET, HEIGHT, AHEAD)).toBe(true);
    expect(probeBlockedAt(env({ heightAt: () => 0, waterDepthAt: beyond(0.9) }), FEET, HEIGHT, AHEAD)).toBe(false);
    const river: EnemyTerrain = { heightAt: () => -3, waterDepthAt: () => 2.5, slopeDeg: () => 60 };
    expect(probeBlockedAt(env(river, null, () => 0), FEET, HEIGHT, AHEAD)).toBe(false);
  });

  it('a point outside the play boundary blocks (insideBoundary, else the 470 m disc)', () => {
    expect(probeBlockedAt(env({ heightAt: () => 0, insideBoundary: (_x, z) => z < 1 }), FEET, HEIGHT, AHEAD)).toBe(true);
    const east: Planar = { x: 1, z: 0 };
    expect(probeBlockedAt(env(FLAT), { x: 469, y: 0, z: 0 }, HEIGHT, east)).toBe(true); // 470.5 m
    expect(probeBlockedAt(env(FLAT), { x: 468, y: 0, z: 0 }, HEIGHT, east)).toBe(false); // 469.5 m
  });

  it('a solid within 1.5 m at waist height blocks; one farther away or below the waist does not', () => {
    const at = (min: Vec3, max: Vec3): boolean => {
      const world = createCollisionWorld(flatHeightfield(0));
      world.addStatic(box(1, min, max));
      return probeBlockedAt(env(FLAT, world), FEET, HEIGHT, AHEAD);
    };
    expect(at({ x: -1, y: -1, z: 1 }, { x: 1, y: 5, z: 1.2 })).toBe(true);
    expect(at({ x: -1, y: -1, z: 1.6 }, { x: 1, y: 5, z: 1.8 })).toBe(false);
    expect(at({ x: -1, y: 0, z: 1 }, { x: 1, y: 0.3, z: 1.2 })).toBe(false); // a kerb it steps onto
  });

  it('the waist ray treats a terrain face steeper than walkable as an obstacle, a walkable rise as open', () => {
    const steep = analyticHeightfield((_x, z) => (z > 0.8 ? (z - 0.8) * 3 : 0)); // ≈ 72°
    const ramp = analyticHeightfield((_x, z) => (z > 0.5 ? (z - 0.5) * Math.tan((40 * Math.PI) / 180) : 0));
    expect(probeBlockedAt(env(steep, createCollisionWorld(steep)), FEET, HEIGHT, AHEAD)).toBe(true);
    expect(probeBlockedAt(env(ramp, createCollisionWorld(ramp)), FEET, HEIGHT, AHEAD)).toBe(false);
  });

  it.each([
    ['even', 0, 1],
    ['odd', 1, -1],
  ] as const)('a chasing enemy (%s ordinal) takes the open 40° side around a post straight ahead and still reaches the target', (_l, seq, side) => {
    const world = createCollisionWorld(flatHeightfield(0));
    world.addStatic(box(1, { x: -0.3, y: -1, z: 2.5 }, { x: 0.3, y: 5, z: 3 }));
    const h = setup({ world });
    if (seq === 1) h.spawn('bramblekin', { z: 300 });
    const id = h.spawn('bramblekin', {}, 0);
    h.place({ z: 8 });
    let widest = 0;
    let wrongSide = 0;
    h.tickUntil(() => h.get(id).state === 'attack', 600, () => {
      const p = h.get(id).pos;
      if (p.z > 2 && p.z < 3.5) widest = Math.max(widest, p.x * side);
      wrongSide = Math.max(wrongSide, -p.x * side);
    });
    expect(widest).toBeGreaterThan(0.3); // it went round the post on its side…
    expect(wrongSide).toBeLessThan(1e-6); // …never the other way
    expect(distanceXZ(h.get(id).pos, h.pos)).toBeCloseTo(BRAMBLEKIN_REACH, 6);
  });
});

describe('progress (Req 28.8, 20.7)', () => {
  /** A Bramblekin at the origin chasing a target 10 m ahead behind a wall across its whole way. */
  function walledChase() {
    const world = createCollisionWorld(flatHeightfield(0));
    world.addStatic(box(1, { x: -50, y: -1, z: 3 }, { x: 50, y: 10, z: 3.5 }));
    const h = setup({ world });
    const id = h.spawn('bramblekin', {}, 0);
    h.place({ z: 10 });
    let stoppedAt = 0;
    let furthest = 0;
    let last = { ...h.get(id).pos };
    const ticks = h.tickUntil(() => h.get(id).state === 'return', 60 * 10, () => {
      const p = h.get(id).pos;
      if (distanceXZ(p, last) > 0) stoppedAt = h.enemies.simTime;
      furthest = Math.max(furthest, p.z);
      last = { ...p };
    });
    return { h, world, id, stoppedAt, furthest, returnedAt: ticks * DT };
  }

  it('a chase that cannot close 0.5 m in 2 s (every probe blocked) turns to return', () => {
    const { h, id, stoppedAt, furthest, returnedAt } = walledChase();
    expect(furthest).toBeLessThan(2.5); // stopped by the probes, clear of the wall
    expect(returnedAt - stoppedAt).toBeGreaterThan(1.8);
    expect(returnedAt - stoppedAt).toBeLessThanOrEqual(2 + 1e-9);
    const e = h.get(id);
    expect([e.state, e.hp, h.enemies.tokens.holders.size]).toEqual(['return', e.maxHp, 0]);
  });

  it('a return that makes no progress for 2 s is reset to its spawn, idle', () => {
    const { h, world, id } = walledChase();
    world.addStatic(box(2, { x: -50, y: -1, z: 1 }, { x: 50, y: 10, z: 1.3 })); // now the way home is shut too
    const ticks = h.tickUntil(() => h.get(id).state !== 'return', 200);
    expect(ticks).toBe(120); // it walked home for at most one decision before its probes saw the new wall
    const e = h.get(id);
    expect(e).toMatchObject({ state: 'idle', hp: e.maxHp });
    expect(e.pos).toEqual(e.spawnPos);
  });

  it('a chase closing in on a target walking away at its own pace is not stuck', () => {
    const h = setup();
    const id = h.spawn('bramblekin', {}, 0);
    h.place({ z: 10 });
    h.tickUntil(() => h.get(id).state === 'chase', 60);
    h.tick(60 * 4, () => h.place({ z: h.get(id).pos.z + 10 })); // the gap never shrinks
    expect(h.get(id).state).toBe('chase');
  });
});

describe('out of the world (Req 20.7)', () => {
  /** A chasing Bramblekin spawned at `at`, the target 3 m beside it. */
  function chaser(at: Partial<Vec3>) {
    const h = setup();
    const id = h.spawn('bramblekin', at);
    h.place({ x: (at.x ?? 0) - 3, z: at.z ?? 0 });
    h.hit(id, 0, 50);
    h.tickUntil(() => h.get(id).state === 'chase', 31);
    return { h, id };
  }

  it('an enemy 2 m or more under the terrain is reset to its spawn, idle at full HP', () => {
    const { h, id } = chaser({ z: 5 });
    h.get(id).pos.y = -1.9;
    h.resolve();
    expect(h.get(id).state).toBe('chase');
    h.get(id).pos.y = -2;
    h.resolve();
    expect(h.get(id)).toMatchObject({ state: 'idle', hp: 180, pos: { x: 0, y: 0, z: 5 } });
    expect(h.enemies.tokens.holders.size).toBe(0);
  });

  it('an enemy past 490 m from the centre is reset to its spawn', () => {
    const { h, id } = chaser({ x: 486 });
    h.get(id).pos.x = 489.5;
    h.resolve();
    expect(h.get(id).state).toBe('chase');
    h.get(id).pos.x = 490.5;
    h.resolve();
    expect(h.get(id)).toMatchObject({ state: 'idle', hp: 180, pos: { x: 486, y: 0, z: 0 } });
  });
});
