import { describe, expect, it } from 'vitest';
import { judgeHitEvent, startAttack, type Attacker, type HitReceiver, type ResolvedHit } from '../../../src/combat/attackRuntime';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { distanceXZ, yawFromDir } from '../../../src/core/math';
import type { Vec3 } from '../../../src/core/types';
import type { AttackDef } from '../../../src/data/combatTypes';
import { getEnemyDef, STAGGER_THRESHOLD } from '../../../src/data/enemies';
import type { EliteId, EnemyId, EntityId } from '../../../src/data/ids';
import {
  APPROACH_MARGIN, ENEMY_STAGGER_SECONDS, EnemySystem, RETURN_ARRIVE_DISTANCE, type EnemySystemOptions,
} from '../../../src/enemies/enemySystem';
import { isDecisionTick, LEASH_RANGE, MeleeTokenPool, sightClear, sightLine } from '../../../src/logic/ai';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import type { Collider, CollisionWorld } from '../../../src/physics/types';
import type { EnemyRuntime } from '../../../src/save/runtimeState';

// Enemy_AI FSM behaviour in the EnemySystem (design "AI 상태 머신", "감지·추적·거리 유지", "공격·피격·Stagger",
// "갱신 비용"; Req 28.2–28.5, 28.12, 26.9) against a movable stand-in for the Active_Character.
const DT = 1 / 60;
const FLAT = { heightAt: () => 0 };
const TARGET_RADIUS = 0.4;
const TARGET_HEIGHT = 1.75;

type Options = Pick<EnemySystemOptions, 'tokens' | 'world'>;

/** An EnemySystem on flat ground, the target it senses and attacks, and helpers to drive both. */
function setup(options: Options = {}) {
  const bus = createGameEventBus();
  const alerted: unknown[] = [];
  bus.on('enemy:alerted', (p) => alerted.push(p));
  const enemies = new EnemySystem({ enemies: new Map(), terrain: FLAT, bus, ...options });
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
  /** Fixed ticks run so far; the next tick has this index. */
  let ticks = 0;
  const get = (id: EntityId): Readonly<EnemyRuntime> => {
    const e = enemies.get(id);
    if (e === undefined) throw new Error(`${id} gone`);
    return e;
  };
  const receiver = (id: EntityId): HitReceiver => {
    const r = [...enemies.receivers()].find((x) => x.id === id);
    if (r === undefined) throw new Error(`no receiver ${id}`);
    return r;
  };
  /** Ticks `n` times; `before` runs ahead of each tick (moving the target). */
  const tick = (n = 1, before?: () => void): void => {
    for (let i = 0; i < n; i++) {
      before?.();
      enemies.tick({ dt: DT, player });
      bus.dispatch();
      ticks += 1;
    }
  };
  /** Ticks until `done` (at most `max` ticks); returns how many ran. */
  const tickUntil = (done: () => boolean, max: number, before?: () => void): number => {
    let n = 0;
    while (!done()) {
      if (n >= max) throw new Error(`not done after ${max} ticks`);
      tick(1, before);
      n += 1;
    }
    return n;
  };
  /** A party hit landing on `id` without an Element. */
  const hit = (id: EntityId, stagger = 0, amount = 1): void =>
    receiver(id).receive({
      attackerId: 'player', attackId: 'atk_kairen_n1', hitIndex: 0, kind: 'normal', amount, crit: false,
      element: null, stagger, knockback: 0, direction: { x: 0, y: 0, z: 1 },
    });
  const place = (p: Partial<Vec3>): void => {
    Object.assign(pos, p);
  };
  return { enemies, pos, taken, alerted, get, receiver, tick, tickUntil, hit, place, ticks: () => ticks };
}

type Harness = ReturnType<typeof setup>;

/** Wakes `id` with a hit and ticks through the 0.5 s alert into chase. */
function wake(h: Harness, id: EntityId): void {
  h.hit(id);
  h.tickUntil(() => h.get(id).state === 'chase', 31);
}

/** A Bramblekin chasing a target kept 10 m ahead of it along +Z until the 30 m leash sends it back. */
function leashedBramblekin(h: Harness): EntityId {
  const id = h.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
  h.place({ z: 10 });
  h.tickUntil(() => h.get(id).state === 'return', 60 * 15, () => {
    if (h.get(id).state === 'chase') h.place({ z: h.get(id).pos.z + 10 });
  });
  return id;
}

/** A wall box (solid, blocks the camera). */
const wall = (id: number, min: Vec3, max: Vec3): Collider => ({
  kind: 'aabb', id, min, max, flags: { climbable: false, walkableTop: false, blocksCamera: true, material: 'stone' },
});

/** Whether the eye → chest ray of `e` reaches the target in `world`. */
function lineOpen(world: CollisionWorld, e: Readonly<EnemyRuntime>, target: Readonly<Vec3>): boolean {
  const line = sightLine(e.pos, getEnemyDef(e.def).height, target, TARGET_HEIGHT);
  if (line === null) return true;
  return sightClear(line, world.raycast({ ...line.origin }, { ...line.dir }, line.distance)?.distance ?? null);
}

describe('detection and alert (Req 28.3)', () => {
  const polar = (deg: number, d: number): Vec3 => ({
    x: Math.sin((deg * Math.PI) / 180) * d, y: 0, z: Math.cos((deg * Math.PI) / 180) * d,
  });

  it.each([
    ['13.5 m straight ahead', polar(0, 13.5), true],
    ['13 m, 55° off the facing', polar(55, 13), true],
    ['13 m, 65° off the facing', polar(65, 13), false],
    ['14.5 m straight ahead', polar(0, 14.5), false],
    ['5.9 m behind', polar(180, 5.9), true],
    ['6.5 m behind', polar(180, 6.5), false],
  ] as const)('a target %s is detected: %s', (_label, at, seen) => {
    const h = setup();
    const id = h.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    h.place(at);
    h.tick(3); // one decision tick at least
    expect(h.get(id).state).toBe(seen ? 'alert' : 'idle');
    expect(h.alerted).toHaveLength(seen ? 1 : 0);
  });

  it('a hit alerts at once, even from outside the detection shape; 0.5 s (30 ticks) later it chases', () => {
    const h = setup();
    const id = h.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    h.place({ z: -20 }); // behind, far outside the cone
    h.tick(3);
    expect(h.get(id).state).toBe('idle');
    h.hit(id);
    expect(h.get(id).state).toBe('alert');
    expect(h.tickUntil(() => h.get(id).state !== 'alert', 60)).toBe(30);
    expect(h.get(id).state).toBe('chase');
    expect(Math.abs(h.get(id).yaw)).toBeCloseTo(Math.PI, 6); // it turned to face the target during the alert
    expect(h.alerted).toEqual([{ entityId: id, kind: 'bramblekin', campId: null }]);
  });

  it('during return sight does not alert, only a hit does', () => {
    const h = setup();
    const id = leashedBramblekin(h);
    const e = h.get(id);
    h.place({ x: e.pos.x, z: e.pos.z - 2 }); // 2 m ahead on its way home
    h.tick(30);
    expect(h.get(id).state).toBe('return');
    h.hit(id);
    expect(h.get(id).state).toBe('alert');
    h.tick(); // EventDispatch
    expect(h.alerted).toHaveLength(2);
  });
});

describe('chase (Req 28.4)', () => {
  it('a melee enemy stops at its reach and starts an attack only once it holds a melee token', () => {
    // Refused a token it never attacks; it waits circling on the ring instead (Req 28.6, enemyMovement.test.ts).
    const noToken = setup({ tokens: new MeleeTokenPool(0) });
    const id = noToken.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 5 }, yaw: Math.PI });
    noToken.tick(180);
    expect([noToken.get(id).state, noToken.get(id).circling]).toEqual(['chase', true]);
    expect(noToken.taken).toEqual([]);

    const h = setup();
    const other = h.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 5 }, yaw: Math.PI });
    h.tickUntil(() => h.get(other).state === 'attack', 120);
    const reach = getEnemyDef('bramblekin').attackRange + TARGET_RADIUS - APPROACH_MARGIN;
    expect(h.get(other).pos.z).toBeCloseTo(reach, 6);
    expect(h.enemies.tokens.holders.has(other)).toBe(true);
  });

  describe('a ranged enemy (Aether Sentinel, 2 m/s) keeps the target 8–14 m away', () => {
    /** Sentinel at the origin facing +Z, target `d` m ahead behind a wall that keeps the sight line shut. */
    const band = (d: number) => {
      const world = createCollisionWorld(flatHeightfield(0));
      world.addStatic(wall(1, { x: -200, y: -1, z: Math.min(d / 2, 3) - 0.3 }, { x: 200, y: 20, z: Math.min(d / 2, 3) + 0.3 }));
      const h = setup({ world });
      const id = h.enemies.spawn({ kind: 'aetherSentinel', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
      h.place({ z: d });
      wake(h, id);
      return { h, id };
    };
    const range = (h: Harness, id: EntityId): number => distanceXZ(h.get(id).pos, h.pos);

    it('approaches from beyond 14 m', () => {
      const { h, id } = band(20);
      h.tick(30);
      expect(range(h, id)).toBeCloseTo(20 - 2 * 0.5, 1);
      expect(h.get(id).state).toBe('chase');
    });

    it('backs off from inside 8 m', () => {
      const { h, id } = band(5);
      h.tick(30);
      expect(range(h, id)).toBeCloseTo(5 + 2 * 0.5, 1);
      expect(h.get(id).state).toBe('chase');
    });

    it('strafes sideways at half speed inside the band while the sight line is blocked, never attacking', () => {
      const { h, id } = band(11);
      h.tick(60);
      expect(range(h, id)).toBeCloseTo(11, 1);
      expect(Math.abs(h.get(id).pos.x)).toBeCloseTo(1, 1);
      h.tick(120);
      expect(h.get(id).state).toBe('chase');
      expect(h.taken).toEqual([]);
    });
  });

  it('a ranged enemy attacks only while its eye → chest line is open, strafing out of a wall’s shadow until it is', () => {
    const world = createCollisionWorld(flatHeightfield(0));
    world.addStatic(wall(1, { x: -1, y: -1, z: 5 }, { x: 1, y: 10, z: 6 }));
    const h = setup({ world });
    const id = h.enemies.spawn({ kind: 'aetherSentinel', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    h.place({ z: 11 });
    const chaseTicks = h.tickUntil(() => h.get(id).state === 'chase', 60);
    expect(lineOpen(world, h.get(id), h.pos)).toBe(false);
    const blocked = h.tickUntil(() => h.get(id).state === 'attack', 60 * 5);
    // It kept strafing (about 1 m/s) until the ray cleared the 2 m wide wall halfway to the target.
    expect(blocked).toBeGreaterThan(60);
    expect(lineOpen(world, h.get(id), h.pos)).toBe(true);
    expect(Math.abs(h.get(id).pos.x)).toBeGreaterThan(1.8);
    expect(h.get(id).attack?.def.id).toBe('atk_aetherSentinel_beam');

    // Control: with nothing in the way it attacks on its first decision after the alert.
    const open = setup({ world: createCollisionWorld(flatHeightfield(0)) });
    const other = open.enemies.spawn({ kind: 'aetherSentinel', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    open.place({ z: 11 });
    expect(open.tickUntil(() => open.get(other).state === 'attack', 60)).toBe(chaseTicks);
  });
});

describe('leash and return (Req 28.5)', () => {
  it('30 m from the spawn a chase turns to return with full HP and an empty stagger meter, walks home and idles there', () => {
    const h = setup();
    const id = h.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    h.hit(id, 50, 40);
    expect([h.get(id).hp, h.get(id).stagger]).toEqual([140, 50]);
    h.place({ z: 10 });
    h.tickUntil(() => h.get(id).state === 'return', 60 * 15, () => {
      if (h.get(id).state === 'chase') h.place({ z: h.get(id).pos.z + 10 });
    });
    const e = h.get(id);
    // Judged on the tick's starting position (prevPos): at most three ticks of running past 30 m; the walk home
    // starts on the same tick.
    const judgedAt = distanceXZ(e.prevPos, e.spawnPos);
    expect(judgedAt).toBeGreaterThanOrEqual(LEASH_RANGE);
    expect(judgedAt).toBeLessThan(LEASH_RANGE + 3 * 4.2 * DT + 1e-9);
    expect([e.hp, e.stagger, e.attack]).toEqual([180, 0, null]);
    const fromSpawn = distanceXZ(e.pos, e.spawnPos);
    expect(fromSpawn).toBeCloseTo(judgedAt - 4.2 * DT, 9);

    h.place({ x: 0, z: -40 }); // out of sight from its spawn
    const walked = h.tickUntil(() => h.get(id).state !== 'return', 60 * 15);
    expect(walked * DT).toBeCloseTo(fromSpawn / 4.2, 1);
    expect(h.get(id).state).toBe('idle');
    expect(distanceXZ(h.get(id).pos, h.get(id).spawnPos)).toBeLessThanOrEqual(RETURN_ARRIVE_DISTANCE);
    h.tick(60);
    expect(h.get(id).state).toBe('idle');
  });

  it('8 s without detecting the target turns a chase to return; a hit restarts that clock', () => {
    const h = setup();
    // 2 m/s: it covers well under 30 m in the 11 s this takes, so only the lost-target clock can send it back.
    const id = h.enemies.spawn({ kind: 'aetherSentinel', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    const ahead = (): void => h.place({ z: h.get(id).pos.z + 20 }); // beyond the 14 m cone, never seen
    ahead();
    h.hit(id, 0, 100);
    h.tick(180, ahead);
    expect(h.get(id).state).toBe('chase');
    h.hit(id, 0, 100); // 3 s in: counts as detection
    const after = h.tickUntil(() => h.get(id).state === 'return', 60 * 10, ahead);
    expect(after).toBeGreaterThanOrEqual(480);
    expect(after).toBeLessThanOrEqual(483); // the next 20 Hz decision
    const e = h.get(id);
    expect(distanceXZ(e.pos, e.spawnPos)).toBeLessThan(LEASH_RANGE);
    expect(e.hp).toBe(e.maxHp);
  });
});

describe('stagger (Req 26.9)', () => {
  /** A light party hit (poise 20) from 1.5 m in front of an enemy at the origin facing +Z. */
  const JAB: AttackDef = {
    id: 'atk_kairen_testJab', owner: 'kairen', clip: 'test', duration: 0.5, recoveryFrom: 0.5, dodgeCancelFrom: 0.5,
    hits: [{
      t: 0.1, shape: { kind: 'arc', radius: 3, angleDeg: 90, height: 2 }, dmgMul: 0.01, appliesElement: false, poise: 20,
      knockback: 0, energy: null,
    }],
  };
  const jabber: Attacker = {
    id: 'player',
    origin: { pos: { x: 0, y: 0, z: 1.5 }, yaw: yawFromDir(0, -1) },
    stats: { baseAtk: 120, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
    kind: 'normal',
    element: null,
    roll: () => 0.5,
  };

  it('each hit adds its stagger (×1.5 on a Terra mark); 100 in alert staggers 2 s on the tick the chase begins', () => {
    const h = setup();
    const id = h.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    h.place({ z: -30 });
    const jab = (): void => {
      expect(judgeHitEvent(startAttack(JAB), 0, jabber, [h.receiver(id)])).toHaveLength(1);
    };
    jab();
    expect([h.get(id).state, h.get(id).stagger]).toEqual(['alert', 20]);
    h.enemies.applyElement(id, 'terra', 'talus');
    jab();
    expect(h.get(id).stagger).toBe(50);
    jab();
    jab();
    expect(h.get(id).stagger).toBe(110);
    // Full in alert (no edge to stagger): the stagger starts on the tick the chase would begin.
    const states: string[] = [];
    h.tickUntil(() => h.get(id).state !== 'alert', 60, () => states.push(h.get(id).state));
    expect(states).toHaveLength(30);
    expect([h.get(id).state, h.get(id).staggerSeconds]).toEqual(['stagger', ENEMY_STAGGER_SECONDS]);
    h.tick(119);
    expect(h.get(id).state).toBe('stagger');
    h.tick();
    expect([h.get(id).state, h.get(id).stagger]).toEqual(['chase', 0]);
  });

  it.each([
    ['bramblekin', STAGGER_THRESHOLD.small, 100],
    ['thornspitter', STAGGER_THRESHOLD.small, 100],
    ['mossbackBrute', STAGGER_THRESHOLD.large, 250],
    ['aetherSentinel', STAGGER_THRESHOLD.large, 250],
    ['oldMossback', STAGGER_THRESHOLD.elite, 400],
    ['rootboundWarden', STAGGER_THRESHOLD.elite, 400],
  ] as const)('%s staggers for 2 s at a meter of %i', (kind: EnemyId | EliteId, threshold, value) => {
    expect([getEnemyDef(kind).staggerThreshold, threshold]).toEqual([value, value]);
    const h = setup();
    const id = h.enemies.spawn({ kind, pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    h.place({ z: 40 });
    wake(h, id);
    h.hit(id, value - 1);
    h.tick();
    expect(h.get(id).state).toBe('chase');
    h.hit(id, 1);
    h.tick();
    expect([h.get(id).state, h.get(id).staggerSeconds]).toEqual(['stagger', 2]);
  });
});

describe('80 m sleep (Req 28.12)', () => {
  it('an engaged enemy beyond 80 m is put back at its spawn, idle at full HP, then nothing runs until the player is back', () => {
    const h = setup();
    const id = h.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    h.place({ z: 12 });
    h.hit(id, 30, 50);
    h.tick(60);
    expect(h.get(id).state).toBe('chase');
    expect(h.get(id).pos.z).toBeGreaterThan(1);

    h.place({ z: -85 }); // > 80 m away
    h.tick();
    const e = h.get(id);
    expect([e.state, e.hp, e.stagger, e.asleep, e.stateTime]).toEqual(['idle', 180, 0, true, 0]);
    expect(e.pos).toEqual(e.spawnPos);
    h.tick(120);
    expect([h.get(id).state, h.get(id).stateTime, h.get(id).asleep]).toEqual(['idle', 0, true]);

    h.place({ z: 30 });
    h.tick(3);
    expect(h.get(id).asleep).toBe(false);
    expect(h.get(id).stateTime).toBeCloseTo(3 * DT, 9);
  });

  it('a returning enemy beyond 80 m just freezes where it is and walks on once the player is within 80 m again', () => {
    const h = setup();
    const id = leashedBramblekin(h);
    h.place({ z: -40 });
    h.tick(30);
    const frozenAt = { ...h.get(id).pos };
    const clock = h.get(id).stateTime;
    h.place({ z: frozenAt.z + 81 });
    h.tick(120);
    expect([h.get(id).state, h.get(id).stateTime, h.get(id).asleep]).toEqual(['return', clock, true]);
    expect(h.get(id).pos).toEqual(frozenAt);
    h.place({ z: frozenAt.z + 60 });
    h.tick(30);
    expect(h.get(id).state).toBe('return');
    expect(h.get(id).pos.z).toBeCloseTo(frozenAt.z - 30 * 4.2 * DT, 6);
  });
});

describe('20 Hz decisions (design "갱신 비용")', () => {
  it('enemy n decides only on ticks with (tick + n) % 3 === 0', () => {
    const h = setup();
    const ids = [
      h.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 5 } }),
      h.enemies.spawn({ kind: 'bramblekin', pos: { x: 5, y: 0, z: 0 } }),
      h.enemies.spawn({ kind: 'bramblekin', pos: { x: -5, y: 0, z: 0 } }),
    ];
    const alertTick = new Map<EntityId, number>();
    h.tick(6, () => {
      for (const id of ids) if (h.get(id).state === 'alert' && !alertTick.has(id)) alertTick.set(id, h.ticks() - 1);
    });
    // All three are within 6 m from the first tick; each notices on its own phase: ticks 0, 2 and 1.
    expect(ids.map((id) => alertTick.get(id))).toEqual([0, 2, 1]);
    ids.forEach((id, n) => expect(isDecisionTick(alertTick.get(id) ?? -1, n)).toBe(true));

    // A target stepping into range on tick 10 is noticed on tick 12, the next decision of ordinal 0.
    const late = setup();
    const e = late.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    late.place({ z: 20 });
    late.tick(10);
    late.place({ z: 5 });
    late.tick(2);
    expect(late.get(e).state).toBe('idle');
    late.tick();
    expect(late.get(e).state).toBe('alert');
  });

  it('timers run every tick: a hit between decisions alerts at once and the chase begins exactly 0.5 s later', () => {
    const h = setup();
    const id = h.enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    h.place({ z: -20 });
    h.tick(2);
    h.hit(id);
    expect(h.get(id).state).toBe('alert');
    expect(h.tickUntil(() => h.get(id).state === 'chase', 60)).toBe(30);
    const chaseTick = h.ticks() - 1;
    expect(chaseTick).toBe(31);
    expect(isDecisionTick(chaseTick, 0)).toBe(false);
  });
});
