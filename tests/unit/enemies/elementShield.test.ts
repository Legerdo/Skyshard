import { describe, expect, it } from 'vitest';
import type { ResolvedHit } from '../../../src/combat/attackRuntime';
import { createPlayerReceiver } from '../../../src/combat/playerReceiver';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import { AETHER_SENTINEL, ELITE_DEFS, getEnemyDef } from '../../../src/data/enemies';
import type { ElementId } from '../../../src/data/ids';
import { SHIELD_BREAK_STAGGER } from '../../../src/element/elementRuntime';
import { DRONE_ORBIT_RATE, EnemySystem } from '../../../src/enemies/enemySystem';
import { SHIELD_REACTION_MUL } from '../../../src/logic/damage';
import { freshShield, shieldElementAt } from '../../../src/logic/element';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { createControllerState } from '../../../src/player/core/types';
import type { EnemyRuntime } from '../../../src/save/runtimeState';

// Element_Shield and drones in the EnemySystem (task 9.8; design "Element·Reactions", "적 정의 표", Elite 표; Req 25.10,
// 25.11, 28.5, 12.3): an Aether Sentinel's rotating shield takes the hits and Reactions ×3 before its HP, breaks into a
// 3 s Stagger and comes back only with a reset; Sentinel Prime's two drones orbit it, fire, and fall with it.

const DT = 1 / 60;
const FLAT = { heightAt: () => 0 };

/** Kairen standing at the origin, an EnemySystem on flat ground, and every event in order. */
function setup() {
  const bus = createGameEventBus();
  const enemyMap = new Map<string, EnemyRuntime>();
  const enemies = new EnemySystem({ enemies: enemyMap, terrain: FLAT, bus });
  const gameState = createNewGameState(1);
  gameState.party.level = 6;
  const state = createControllerState({ x: 0, y: 0, z: 0 }, 0);
  const player = createPlayerReceiver({ gameState, bus, body: () => state });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const tick = (seconds = DT): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      enemies.tick({ dt: DT, player });
      bus.dispatch();
    }
  };
  /** A hit of `amount` (already computeDamage'd) carrying `element`, through the enemy's receiver. */
  const hit = (id: string, amount: number, element: ElementId | null = null): void => {
    for (const r of enemies.receivers()) {
      if (r.id !== id) continue;
      const h: ResolvedHit = {
        attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount, crit: false, element,
        elementSource: element === null ? null : 'kairen', stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
      };
      r.receive(h);
    }
  };
  return { bus, enemies, enemyMap, gameState, player, events, tick, hit };
}

describe('Element_Shield rules', () => {
  it('rotates ember → tide → gale → terra every `every` s from its start, back to the start after the last', () => {
    const rotation = AETHER_SENTINEL.shield?.rotation;
    expect(rotation).toEqual({ every: 10, order: ['ember', 'tide', 'gale', 'terra'] });
    const at = (t: number) => shieldElementAt('ember', rotation, t);
    expect([0, 9.99, 10, 19.99, 20, 30, 40, 55].map(at)).toEqual(['ember', 'ember', 'tide', 'tide', 'gale', 'terra', 'ember', 'tide']);
    expect(shieldElementAt('gale', undefined, 100)).toBe('gale');
    expect(freshShield(AETHER_SENTINEL.shield)).toEqual({ element: 'ember', durability: 400, max: 400 });
    expect(freshShield(undefined)).toBeNull();
    expect(getEnemyDef('sentinelPrime').shield?.rotation?.every).toBe(8);
  });
});

describe('an Aether Sentinel’s Element_Shield in the EnemySystem', () => {
  it('spawns at full durability; hits wear it before any HP; a Reaction on it counts ×3; its Element keeps switching every 10 s', () => {
    const { enemies, events, tick, hit } = setup();
    const id = enemies.spawn({ kind: 'aetherSentinel', pos: { x: 0, y: 0, z: 10 }, yaw: Math.PI, level: 7 });
    const e = () => enemies.get(id);
    expect(e()?.element.shield).toEqual({ element: 'ember', durability: 400, max: 400 });
    // An ordinary hit: into the shield, the HP untouched.
    hit(id, 40);
    expect([e()?.element.shield?.durability, e()?.hp]).toEqual([360, e()?.maxHp]);
    // Tide on the Ember shield: the hit's 40, then the steam burst's 150% (60) ×3 into the shield; the shield stays.
    hit(id, 40, 'tide');
    tick();
    expect(events.filter((x) => x.type === 'reaction').map((x) => (x.payload as { reaction: string }).reaction)).toEqual(['steamBurst']);
    expect(e()?.element.shield?.durability).toBe(360 - 40 - 60 * SHIELD_REACTION_MUL);
    expect(e()?.hp).toBe(e()?.maxHp);
    expect(e()?.element.shield?.element).toBe('ember');
    // The shield switches its Element every 10 s from the spawn and keeps its durability; it keeps seeing the target
    // 10 m away, so it never turns to return (which would raise a fresh shield).
    tick(10 - 2 * DT);
    expect(e()?.element.shield?.element).toBe('ember');
    tick(2 * DT);
    expect(e()?.element.shield).toEqual({ element: 'tide', durability: 360 - 40 - 60 * SHIELD_REACTION_MUL, max: 400 });
    expect(e()?.state).not.toBe('return');
  });

  it('breaks at 0 into a 3 s Stagger, the rest of the hit on the HP; broken it stays broken, a reset raises it again', () => {
    const { enemies, tick, hit } = setup();
    const id = enemies.spawn({ kind: 'aetherSentinel', pos: { x: 0, y: 0, z: 10 }, yaw: Math.PI, level: 7 });
    const e = () => enemies.get(id);
    tick(0.6); // alert → chase
    expect(['chase', 'attack']).toContain(e()?.state);
    const maxHp = e()?.maxHp ?? 0;
    hit(id, 450);
    expect(e()?.element.shield).toBeNull();
    expect(e()?.hp).toBe(maxHp - 50);
    tick();
    expect(e()?.state).toBe('stagger');
    expect(e()?.staggerSeconds).toBeGreaterThanOrEqual(SHIELD_BREAK_STAGGER - 2 * DT);
    tick(SHIELD_BREAK_STAGGER - 0.1);
    expect(e()?.state).toBe('stagger');
    tick(0.2);
    expect(e()?.state).not.toBe('stagger');
    hit(id, 30);
    expect(e()?.hp).toBe(maxHp - 80); // no shield any more: the hit is all HP
    tick(12);
    expect(e()?.element.shield).toBeNull(); // no rotation brings it back
    enemies.reset(id);
    expect(e()?.element.shield).toEqual({ element: 'ember', durability: 400, max: 400 });
    expect(e()?.hp).toBe(maxHp);
  });
});

describe('Sentinel Prime’s drones', () => {
  it('two drones orbit it 3 m out and 3.5 m up, fire their glowing bolt once it chases, fall on their own or with it, and a reset restores them', () => {
    const { enemies, events, tick, hit } = setup();
    const id = enemies.spawn({ kind: 'sentinelPrime', pos: { x: 0, y: 0, z: 9 }, yaw: Math.PI, level: ELITE_DEFS.sentinelPrime.level });
    const spec = ELITE_DEFS.sentinelPrime.drones;
    if (spec === undefined) throw new Error('no drones');
    const drones = () => enemies.drones();
    expect(drones().map((d) => [d.owner, d.hp, d.radius])).toEqual([[id, spec.hp, spec.radius], [id, spec.hp, spec.radius]]);
    const prime = () => enemies.get(id);
    const onOrbit = (): void => {
      for (const d of drones()) {
        const p = prime()?.pos ?? { x: 0, y: 0, z: 0 };
        expect(Math.hypot(d.pos.x - p.x, d.pos.z - p.z)).toBeCloseTo(spec.orbitRadius, 6);
        expect(d.pos.y - p.y).toBeCloseTo(spec.altitude, 6);
      }
    };
    onOrbit();
    const before = drones()[0]?.pos;
    tick(0.5);
    onOrbit();
    const after = drones()[0]?.pos;
    const angle = (q: { x: number; z: number } | undefined) => Math.atan2((q?.z ?? 0) - (prime()?.pos.z ?? 0), (q?.x ?? 0) - (prime()?.pos.x ?? 0));
    expect(Math.abs(angle(after) - angle(before))).toBeGreaterThan(0.25 * DRONE_ORBIT_RATE);
    // Once it chases, the drones' bolts start with their 0.6 s glow.
    tick(3);
    const bolts = events.filter((x) => x.type === 'enemy:telegraph' && (x.payload as { entityId: string }).entityId.includes('_drone_'));
    expect(bolts.length).toBeGreaterThan(0);
    expect(bolts[0]?.payload).toMatchObject({ kind: 'sentinelPrime', attackId: 'atk_sentinelPrime_droneBolt', telegraph: 'glow', seconds: 0.6 });
    // Hit targets of their own: one falls, the other goes with the Prime.
    const [d1, d2] = drones();
    if (d1 === undefined || d2 === undefined) throw new Error('drones');
    hit(d1.id, spec.hp - 1);
    expect(drones()).toHaveLength(2);
    hit(d1.id, 1);
    expect(drones().map((d) => d.id)).toEqual([d2.id]);
    expect([...enemies.receivers()].some((r) => r.id === d1.id)).toBe(false);
    enemies.reset(id);
    expect(drones().map((d) => [d.id, d.hp])).toEqual([[d1.id, spec.hp], [d2.id, spec.hp]]);
    hit(id, 1e6);
    tick();
    expect(prime()?.state).toBe('dead');
    expect(drones()).toEqual([]);
  });
});
