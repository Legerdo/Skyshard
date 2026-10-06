import { describe, expect, it } from 'vitest';
import {
  AI_STATES, AI_TRANSITIONS, CHEST_HEIGHT_FRACTION, EYE_HEIGHT_FRACTION, LEASH_RANGE, LOST_TARGET_SECONDS, MeleeTokenPool,
  SLEEP_RANGE, aiTransition, alertsOn, detectsTarget, isDecisionTick, keepRangeMove, pickAttack, shouldReturn, sightClear,
  sightLine, sleepsAt,
} from '../../../src/logic/ai';

/** Edges of the design's state diagram, plus "Alive --> dead" for every living state. */
const DIAGRAM_EDGES = [
  'idle>patrol', 'patrol>idle', 'idle>alert', 'patrol>alert', 'return>alert', 'alert>chase',
  'chase>attack', 'attack>recovery', 'recovery>chase', 'chase>stagger', 'attack>stagger',
  'recovery>stagger', 'stagger>chase', 'chase>return', 'recovery>return', 'return>idle',
];

describe('AI transition table', () => {
  it('has the nine states and exactly the design table', () => {
    expect(AI_STATES).toEqual(['idle', 'patrol', 'alert', 'chase', 'attack', 'recovery', 'stagger', 'return', 'dead']);
    expect(AI_TRANSITIONS).toEqual({
      idle: ['patrol', 'alert', 'dead'],
      patrol: ['idle', 'alert', 'dead'],
      alert: ['chase', 'dead'],
      chase: ['attack', 'return', 'stagger', 'dead'],
      attack: ['recovery', 'stagger', 'dead'],
      recovery: ['chase', 'return', 'stagger', 'dead'],
      stagger: ['chase', 'dead'],
      return: ['idle', 'alert', 'dead'],
      dead: [],
    });
  });

  it('allows exactly the diagram edges: 24 of the 81 pairs', () => {
    const allowed = AI_STATES.flatMap((from) => AI_STATES.filter((to) => aiTransition(from, to)).map((to) => `${from}>${to}`));
    const expected = [...DIAGRAM_EDGES, ...AI_STATES.filter((s) => s !== 'dead').map((s) => `${s}>dead`)];
    expect(allowed).toHaveLength(24);
    expect(new Set(allowed)).toEqual(new Set(expected));
  });

  it.each([
    ['idle', 'chase'], ['patrol', 'chase'], ['alert', 'attack'], ['alert', 'idle'], ['alert', 'stagger'],
    ['chase', 'recovery'], ['attack', 'chase'], ['attack', 'return'], ['recovery', 'attack'],
    ['stagger', 'attack'], ['stagger', 'return'], ['return', 'chase'], ['return', 'stagger'],
  ] as const)('refuses %s → %s', (from, to) => {
    expect(aiTransition(from, to)).toBe(false);
  });

  it('refuses self-transitions', () => {
    expect(AI_STATES.filter((s) => aiTransition(s, s))).toEqual([]);
  });

  it('every living state can die, and dead is terminal', () => {
    for (const s of AI_STATES) {
      expect(aiTransition(s, 'dead'), s).toBe(s !== 'dead');
      expect(aiTransition('dead', s), s).toBe(false);
    }
  });
});

describe('AI rules', () => {
  it('sight alerts only idle / patrol; a hit also alerts during return (Req 28.3)', () => {
    expect(AI_STATES.filter((s) => alertsOn(s, 'sight'))).toEqual(['idle', 'patrol']);
    expect(AI_STATES.filter((s) => alertsOn(s, 'hit'))).toEqual(['idle', 'patrol', 'return']);
    // Every state an alert can start from has the edge to alert.
    for (const s of AI_STATES) if (alertsOn(s, 'hit')) expect(aiTransition(s, 'alert'), s).toBe(true);
  });

  it('a chase gives up at 30 m from the spawn or after 8 s unseen (Req 28.5)', () => {
    expect([LEASH_RANGE, LOST_TARGET_SECONDS]).toEqual([30, 8]);
    expect([shouldReturn(29.99, 0), shouldReturn(30, 0), shouldReturn(45, 0)]).toEqual([false, true, true]);
    expect([shouldReturn(0, 7.99), shouldReturn(0, 8), shouldReturn(12, 9)]).toEqual([false, true, true]);
  });

  it('sleeps strictly beyond 80 m (Req 28.12)', () => {
    expect(SLEEP_RANGE).toBe(80);
    expect([sleepsAt(0), sleepsAt(80), sleepsAt(80.001), sleepsAt(500)]).toEqual([false, false, true, true]);
  });

  it('decides on ticks with (tick + n) % 3 === 0: every third tick, the ordinals spread over three phases', () => {
    for (let n = 0; n < 6; n++) {
      const ticks = Array.from({ length: 12 }, (_, t) => t).filter((t) => isDecisionTick(t, n));
      const first = (3 - (n % 3)) % 3;
      expect(ticks, `n = ${n}`).toEqual([first, first + 3, first + 6, first + 9]);
    }
    // On each tick exactly one of three consecutive ordinals decides.
    for (let t = 0; t < 9; t++) expect([0, 1, 2].filter((n) => isDecisionTick(t, n)), `tick ${t}`).toHaveLength(1);
  });

  it('a ranged enemy approaches beyond its band, backs off inside it and strafes within it (Req 28.4)', () => {
    const band = [8, 14] as const;
    expect([20, 14.01, 14, 11, 8, 7.99, 2].map((d) => keepRangeMove(d, band))).toEqual([
      'approach', 'approach', 'strafe', 'strafe', 'strafe', 'retreat', 'retreat',
    ]);
  });

  it('picks the first attack in priority order whose use range holds the gap and whose cooldown has run out', () => {
    const slam = { id: 'atk_x_slam', useRange: [0, 4] as const };
    const beam = { id: 'atk_x_beam', useRange: [6, 16] as const };
    const both = { id: 'atk_x_both', useRange: [0, 16] as const };
    const attacks = [slam, beam, both];
    expect([2, 4, 5, 6, 16, 16.5].map((gap) => pickAttack(attacks, gap, {}, 0)?.id ?? null)).toEqual([
      'atk_x_slam', 'atk_x_slam', 'atk_x_both', 'atk_x_beam', 'atk_x_beam', null,
    ]);
    const cooling = { atk_x_beam: 10 };
    expect([pickAttack(attacks, 8, cooling, 9.5)?.id, pickAttack(attacks, 8, cooling, 10)?.id]).toEqual(['atk_x_both', 'atk_x_beam']);
  });

  it('sight line: eye height to chest height, clear unless a solid is hit before the chest', () => {
    const line = sightLine({ x: 0, y: 0, z: 0 }, 3, { x: 0, y: 0, z: 10 }, 2);
    expect(line).not.toBeNull();
    if (line === null) return;
    expect(line.origin).toEqual({ x: 0, y: 3 * EYE_HEIGHT_FRACTION, z: 0 });
    expect(line.distance).toBeCloseTo(Math.hypot(10, 2 * CHEST_HEIGHT_FRACTION - 3 * EYE_HEIGHT_FRACTION), 9);
    expect(Math.hypot(line.dir.x, line.dir.y, line.dir.z)).toBeCloseTo(1, 9);
    expect([sightClear(line, null), sightClear(line, line.distance), sightClear(line, 5)]).toEqual([true, true, false]);
    expect(sightLine({ x: 0, y: 0, z: 0 }, 1, { x: 0, y: 0.9 - 0.7, z: 0 }, 1)).toBeNull();
  });

  it('detection takes a custom perception shape', () => {
    const narrow = { coneDeg: 60, coneRange: 10, nearRange: 3 };
    const at = { x: 0, y: 0, z: 0 };
    const polar = (deg: number, d: number) => ({ x: Math.sin((deg * Math.PI) / 180) * d, y: 0, z: Math.cos((deg * Math.PI) / 180) * d });
    expect([polar(25, 9), polar(35, 9), polar(0, 11), polar(180, 2.9), polar(180, 3.5)].map((p) => detectsTarget(at, 0, p, narrow)))
      .toEqual([true, false, false, true, false]);
    // The default is the 120° / 14 m / 6 m shape.
    expect([polar(55, 13), polar(65, 13), polar(180, 5.9)].map((p) => detectsTarget(at, 0, p))).toEqual([true, false, true]);
  });
});

describe('MeleeTokenPool', () => {
  it('holds at most two tokens by default; a holder re-acquiring succeeds without taking a slot', () => {
    const pool = new MeleeTokenPool();
    expect(pool.capacity).toBe(2);
    expect(['a', 'b', 'c'].map((id) => pool.acquire(id))).toEqual([true, true, false]);
    expect(pool.acquire('a')).toBe(true);
    expect([...pool.holders]).toEqual(['a', 'b']);
  });

  it('frees a slot only when a holder releases; releasing a non-holder is ignored', () => {
    const pool = new MeleeTokenPool();
    pool.acquire('a');
    pool.acquire('b');
    pool.release('c');
    expect(pool.acquire('c')).toBe(false);
    pool.release('a');
    expect(pool.holders.has('a')).toBe(false);
    expect(pool.acquire('c')).toBe(true);
    pool.release('a');
    expect([...pool.holders]).toEqual(['b', 'c']);
    expect(pool.acquire('d')).toBe(false);
  });

  it('honours a custom capacity and rejects invalid ones', () => {
    const three = new MeleeTokenPool(3);
    expect(['a', 'b', 'c', 'd'].map((id) => three.acquire(id))).toEqual([true, true, true, false]);
    expect(new MeleeTokenPool(0).acquire('a')).toBe(false);
    for (const bad of [-1, 1.5, NaN, Infinity]) expect(() => new MeleeTokenPool(bad), String(bad)).toThrow(RangeError);
  });
});
