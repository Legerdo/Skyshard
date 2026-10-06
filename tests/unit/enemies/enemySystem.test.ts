import { describe, expect, it } from 'vitest';
import { PlayerCombat } from '../../../src/combat/playerCombat';
import { createPlayerReceiver } from '../../../src/combat/playerReceiver';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import { createRng } from '../../../src/core/rng';
import type { AttackDef } from '../../../src/data/combatTypes';
import { BRAMBLEKIN } from '../../../src/data/enemies';
import { ENEMY_DESPAWN_SECONDS, EnemySystem } from '../../../src/enemies/enemySystem';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { detectsTarget } from '../../../src/logic/ai';
import { enemyDamageLevel, enemyMaxHp } from '../../../src/logic/enemyScaling';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { createControllerState, type ControllerState } from '../../../src/player/core/types';
import type { EnemyRuntime } from '../../../src/save/runtimeState';
import { CampTracker } from '../../../src/world/campTracker';

// Bramblekin: data, simple chase / attack / hit / death and the camp tally (design "Enemies·AI";
// Req 24.1, 24.10, 28.10).
const DT = 1 / 60;
const FLAT = { heightAt: () => 0 };
const TAP: RawInput[] = [
  { kind: 'down', code: 'Mouse0', time: 0 },
  { kind: 'up', code: 'Mouse0', time: 0 },
];

/** Kairen standing at the origin facing +Z, an EnemySystem on flat ground, and every event in order. */
function setup() {
  const bus = createGameEventBus();
  const camps = new CampTracker(bus);
  const enemyMap = new Map<string, EnemyRuntime>();
  const enemies = new EnemySystem({ enemies: enemyMap, terrain: FLAT, bus });
  const gameState = createNewGameState(1);
  const body: { state: ControllerState; face(yaw: number): void } = {
    state: createControllerState({ x: 0, y: 0, z: 0 }, 0),
    face(yaw) {
      this.state = { ...this.state, yaw };
    },
  };
  const player = createPlayerReceiver({ gameState, bus, body: () => body.state });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  return { bus, camps, enemyMap, enemies, gameState, body, player, events };
}

describe('Bramblekin data', () => {
  it('has HP 180, ATK 40, DEF 20 and a two-claw atk_bramblekin_claw behind a 0.4 s body-glow Telegraph', () => {
    expect([BRAMBLEKIN.hp, BRAMBLEKIN.atk, BRAMBLEKIN.def, BRAMBLEKIN.attackRange]).toEqual([180, 40, 20, 1.8]);
    const claw = BRAMBLEKIN.attacks[0] as AttackDef;
    expect([claw.id, claw.owner, claw.telegraph]).toEqual(['atk_bramblekin_claw', 'bramblekin', { kind: 'glow', duration: 0.4, strong: false }]);
    const times = claw.hits.map((h) => h.t);
    expect(times).toEqual([0.4, 0.8]);
    // Each claw gets at least the 0.4 s of warning an ordinary attack needs (Req 28.9).
    times.forEach((t, i) => expect(t - (i === 0 ? 0 : (times[i - 1] ?? 0))).toBeGreaterThanOrEqual(0.4));
  });

  it('scales HP +10% and ATK ×1.06 per level above L₀ (design: thornspitter at level 4 → HP 293, ATK level 4)', () => {
    expect(enemyMaxHp(220, 1, 4)).toBe(293);
    expect(enemyDamageLevel(1, 4)).toBe(4);
    expect([enemyMaxHp(180, 1, 1), enemyDamageLevel(4, 4), enemyDamageLevel(4, 2)]).toEqual([180, 1, 1]);
  });

  it('detects within the 120° 14 m cone or 6 m all around', () => {
    const at = { x: 0, y: 0, z: 0 };
    expect(detectsTarget(at, 0, { x: 0, y: 0, z: 13.5 })).toBe(true);
    expect(detectsTarget(at, 0, { x: 0, y: 0, z: 14.5 })).toBe(false);
    expect(detectsTarget(at, 0, { x: 10, y: 0, z: 2 })).toBe(false); // 79° off the facing
    expect(detectsTarget(at, 0, { x: 0, y: 0, z: -5.5 })).toBe(true);
    // A character on a platform far above or below is not sensed (the Cinderspire summit over ledge L4).
    expect(detectsTarget(at, 0, { x: 0, y: 4.9, z: 3 })).toBe(true);
    expect(detectsTarget(at, 0, { x: 0, y: -31, z: 3 })).toBe(false);
  });
});

describe('EnemySystem', () => {
  it('alerts, chases into reach, glows for 0.4 s, then claws twice for computeDamage(kind "enemy") = 27 each', () => {
    const { enemies, gameState, player, events, bus } = setup();
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 5.5 }, yaw: Math.PI });
    const log: { time: number; state: string; hp: number }[] = [];
    for (let i = 1; i <= 240; i++) {
      enemies.tick({ dt: DT, player });
      log.push({ time: i * DT, state: enemies.get(id)?.state ?? '', hp: gameState.party.hp.kairen });
    }
    bus.dispatch();
    const firstOf = (pred: (e: (typeof log)[number]) => boolean) => log.find(pred)?.time ?? Number.NaN;
    const alertAt = firstOf((e) => e.state === 'alert');
    const chaseAt = firstOf((e) => e.state === 'chase');
    const attackAt = firstOf((e) => e.state === 'attack');
    expect(alertAt).toBeCloseTo(DT, 9);
    expect(chaseAt - alertAt).toBeCloseTo(0.5, 6);
    expect(attackAt).toBeGreaterThan(chaseAt);
    const hits = log.filter((e, i) => e.hp !== (log[i - 1]?.hp ?? 1000));
    expect(hits.map((e) => e.hp).slice(0, 2)).toEqual([973, 946]);
    expect((hits[0]?.time ?? 0) - attackAt).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect((hits[0]?.time ?? 0) - attackAt).toBeLessThan(0.4 + DT);
    expect((hits[1]?.time ?? 0) - attackAt).toBeCloseTo(0.8, 1);
    // It stopped at its reach: 1.8 m + the player's 0.4 m radius − 0.3 m margin.
    expect(enemies.get(id)?.pos.z).toBeCloseTo(1.9, 6);
    expect(events.filter((e) => e.type === 'enemy:alerted')).toHaveLength(1);
    const damaged = { characterId: 'kairen', amount: 27, fromDirection: { x: 0, y: 0, z: 1 } }; // attacker at +Z
    expect(events.filter((e) => e.type === 'player:damaged').slice(0, 2).map((e) => e.payload)).toEqual([damaged, damaged]);
  });

  it('claws pass through the Dodge i-frames', () => {
    const { enemies, gameState, player, body } = setup();
    enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 2 }, yaw: Math.PI });
    body.state = { ...body.state, iFrames: 10 };
    for (let i = 0; i < 120; i++) enemies.tick({ dt: DT, player });
    expect(gameState.party.hp.kairen).toBe(1000);
  });

  it('Kairen’s combo kills a two-Bramblekin group: each emits enemy:defeated, then camp:cleared once, bodies go after 1.5 s', () => {
    const { bus, camps, enemyMap, enemies, gameState, body, player, events } = setup();
    const ids = [-0.6, 0.6].map((x) =>
      enemies.spawn({ kind: 'bramblekin', pos: { x, y: 0, z: 1.6 }, yaw: Math.PI, campId: 'village_raid' }),
    );
    camps.track('village_raid', 'verdant', ids);
    expect(camps.aliveCount('village_raid')).toBe(2);
    const input = new InputState();
    const combat = new PlayerCombat({ bus, rng: createRng(3), level: () => gameState.party.level, character: () => 'kairen' });
    const tick = (raw: RawInput[] = []) => {
      input.beginTick(raw, DT);
      combat.tick({ input, body, cameraYaw: 0, targets: enemies.receivers(), dt: DT });
      enemies.tick({ dt: DT, player });
      bus.dispatch();
    };
    tick(TAP);
    while ((combat.attack?.t ?? Infinity) < 0.22) tick();
    tick(TAP); // chains hit 2 (90 + 100 ≥ 180, crit or not)
    for (let i = 0; i < 30; i++) tick();
    expect(ids.map((id) => enemies.get(id)?.state)).toEqual(['dead', 'dead']);

    const order = events.map((e) => e.type).filter((t) => t === 'enemy:defeated' || t === 'camp:cleared');
    expect(order).toEqual(['enemy:defeated', 'enemy:defeated', 'camp:cleared']);
    expect(events.filter((e) => e.type === 'enemy:defeated').map((e) => e.payload)).toEqual(
      ids.map((entityId) => ({ entityId, kind: 'bramblekin', campId: 'village_raid' })),
    );
    expect(events.find((e) => e.type === 'camp:cleared')?.payload).toEqual({ campId: 'village_raid', regionId: 'verdant' });
    expect(camps.aliveCount('village_raid')).toBe(0);

    for (let i = 0; i < Math.ceil(ENEMY_DESPAWN_SECONDS / DT) + 1; i++) tick();
    expect(enemyMap.size).toBe(0);
    expect([...enemies.receivers()]).toEqual([]);
  });

  it('a hit wakes an idle enemy outside its detection and staggers it for 2 s once the meter reaches 100', () => {
    const { enemies, player } = setup();
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 30 } });
    const [receiver] = [...enemies.receivers()];
    const hit = {
      attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount: 1, crit: false,
      element: null, stagger: 100, knockback: 0, direction: { x: 0, y: 0, z: 1 },
    } as const;
    receiver?.receive({ ...hit, stagger: 40 });
    expect(enemies.get(id)?.state).toBe('alert');
    for (let i = 0; i < 31; i++) enemies.tick({ dt: DT, player });
    expect(enemies.get(id)?.state).toBe('chase');
    receiver?.receive(hit);
    enemies.tick({ dt: DT, player });
    expect([enemies.get(id)?.state, enemies.get(id)?.hp]).toEqual(['stagger', 178]);
    for (let i = 0; i < 120; i++) enemies.tick({ dt: DT, player });
    expect([enemies.get(id)?.state, enemies.get(id)?.stagger]).toEqual(['chase', 0]);
  });

  it('stands on the height the ground option gives (a platform top) instead of the terrain', () => {
    const bus = createGameEventBus();
    const enemies = new EnemySystem({
      enemies: new Map(), terrain: FLAT, bus, ground: (p) => (Math.abs(p.x) < 5 && p.y > 50 ? 140 : 0),
    });
    const onRing = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 140, z: 0 } });
    const onGround = enemies.spawn({ kind: 'bramblekin', pos: { x: 20, y: 0, z: 0 } });
    expect([enemies.get(onRing)?.pos.y, enemies.get(onGround)?.pos.y]).toEqual([140, 0]);
  });

  it('resetEngaged puts engaging enemies back at their spawn, idle at full HP, and leaves idle ones alone (Party_Wipe restart)', () => {
    const { enemies, player } = setup();
    const chaser = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 5 }, yaw: Math.PI });
    const sleeper = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 40 } });
    const [receiver] = [...enemies.receivers()];
    receiver?.receive({
      attackerId: 'player', attackId: 'atk_kairen_n1', hitIndex: 0, kind: 'normal', amount: 50, crit: false,
      element: null, stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
    });
    for (let i = 0; i < 60; i++) enemies.tick({ dt: DT, player });
    expect(enemies.get(chaser)?.state).not.toBe('idle');
    enemies.resetEngaged();
    expect(enemies.get(chaser)).toMatchObject({ state: 'idle', hp: 180, pos: { x: 0, y: 0, z: 5 }, attack: null });
    expect(enemies.tokens.holders.size).toBe(0);
    expect(enemies.get(sleeper)?.state).toBe('idle');
  });
});

describe('CampTracker', () => {
  it('emits camp:cleared once, when the last tracked member is defeated; others and repeats are ignored', () => {
    const bus = createGameEventBus();
    const camps = new CampTracker(bus);
    const cleared: unknown[] = [];
    bus.on('camp:cleared', (p) => cleared.push(p));
    camps.track('camp_verdant_1', 'verdant', ['a', 'b']);
    bus.emit('enemy:defeated', { entityId: 'a', kind: 'bramblekin', campId: 'camp_verdant_1' });
    bus.emit('enemy:defeated', { entityId: 'a', kind: 'bramblekin', campId: 'camp_verdant_1' });
    bus.emit('enemy:defeated', { entityId: 'x', kind: 'bramblekin', campId: null });
    bus.emit('enemy:defeated', { entityId: 'b', kind: 'bramblekin', campId: 'other_camp' });
    bus.dispatch();
    expect([cleared, camps.aliveCount('camp_verdant_1')]).toEqual([[], 1]);
    bus.emit('enemy:defeated', { entityId: 'b', kind: 'bramblekin', campId: 'camp_verdant_1' });
    bus.emit('enemy:defeated', { entityId: 'b', kind: 'bramblekin', campId: 'camp_verdant_1' });
    bus.dispatch();
    expect(cleared).toEqual([{ campId: 'camp_verdant_1', regionId: 'verdant' }]);
  });
});
