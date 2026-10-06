import { describe, expect, it } from 'vitest';
import type { ResolvedHit } from '../../../src/combat/attackRuntime';
import { createPlayerReceiver } from '../../../src/combat/playerReceiver';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { CHARACTERS } from '../../../src/data/characters';
import { ASH_WISP, MOSSBACK_BRUTE, THORNSPITTER } from '../../../src/data/enemies';
import { ENEMY_DESPAWN_SECONDS, ENEMY_FLINCH_SECONDS, EnemySystem } from '../../../src/enemies/enemySystem';
import { InputState } from '../../../src/input/inputState';
import { computeDamage } from '../../../src/logic/damage';
import { statsAt } from '../../../src/logic/progression';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import { createControllerState, type ControllerState } from '../../../src/player/core/types';
import { PLAYER_KNOCKBACK_SECONDS, PlayerController } from '../../../src/player/playerController';
import type { EnemyRuntime } from '../../../src/save/runtimeState';

// Enemy attack execution, hit reactions and death (task 7.7; design "공격·피격·Stagger"; Req 28.10, 26.1, 26.6).
const DT = 1 / 60;
const FLAT = { heightAt: () => 0 };
const KAIREN_DEF = statsAt(CHARACTERS.kairen.baseStats, 1).def;

/** Kairen standing at the origin, an EnemySystem on flat ground, every event in order, evasions and pushes. */
function setup() {
  const bus = createGameEventBus();
  const enemyMap = new Map<string, EnemyRuntime>();
  const enemies = new EnemySystem({ enemies: enemyMap, terrain: FLAT, bus });
  const gameState = createNewGameState(1);
  const body = { state: createControllerState({ x: 0, y: 0, z: 0 }, 0) as ControllerState };
  const evaded: string[] = [];
  const pushes: { direction: Vec3; distance: number }[] = [];
  const player = createPlayerReceiver({
    gameState, bus, body: () => body.state,
    onEvade: (attackerId) => evaded.push(attackerId),
    onKnockback: (direction, distance) => pushes.push({ direction: { ...direction }, distance }),
  });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const of = <K extends GameEventName>(type: K): GameEvents[K][] =>
    events.filter((e) => e.type === type).map((e) => e.payload as GameEvents[K]);
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) enemies.tick({ dt: DT, player });
    bus.dispatch();
  };
  return { bus, enemyMap, enemies, gameState, body, player, evaded, pushes, of, tick };
}

/** Enemy damage computeDamage gives for `atk` × `dmgMul` against Kairen at level 1 (kind 'enemy', no crit). */
const enemyDamage = (atk: number, dmgMul: number): number =>
  computeDamage({
    baseAtk: atk, level: 1, equipAtkPct: 0, dmgMul, abilityUpgradePct: 0, equipDmgPct: 0, def: KAIREN_DEF,
    critChance: 0, rng01: 0, kind: 'enemy', frontGuard: false, shield: null, vulnerable: false,
  }).amount;

const partyHit = (over: Partial<ResolvedHit> = {}): ResolvedHit => ({
  attackerId: 'player', attackId: 'atk_kairen_n1', hitIndex: 0, kind: 'normal', amount: 1, crit: false,
  element: null, stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 }, ...over,
});

/** Ticks until `pred` holds (at most `max` ticks); fails the test otherwise. */
function tickUntil(tick: () => void, pred: () => boolean, max = 600): void {
  for (let i = 0; i < max && !pred(); i++) tick();
  expect(pred()).toBe(true);
}

describe('enemy attack execution', () => {
  it('announces the Telegraph with enemy:telegraph and judges nothing before it ends', () => {
    const { enemies, gameState, of, tick } = setup();
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 1.9 }, yaw: Math.PI });
    const samples: { t: number; hp: number }[] = [];
    for (let i = 0; i < 120; i++) {
      tick();
      const e = enemies.get(id);
      if (e?.attack != null) samples.push({ t: e.attack.t, hp: gameState.party.hp.kairen });
    }
    const beforeEnd = samples.filter((s) => s.t < 0.4 - 1e-9);
    expect(beforeEnd.length).toBeGreaterThan(20); // the 0.4 s body glow was sampled
    expect(beforeEnd.every((s) => s.hp === 1000)).toBe(true);
    const firstHit = samples.find((s) => s.hp < 1000);
    expect(firstHit?.t).toBeGreaterThanOrEqual(0.4 - 1e-9);
    const [telegraph] = of('enemy:telegraph');
    expect(telegraph).toMatchObject({
      entityId: id, kind: 'bramblekin', attackId: 'atk_bramblekin_claw', telegraph: 'glow', strong: false, seconds: 0.4,
      position: { x: 0, y: 0, z: 1.9 },
    });
  });

  it('ignores a hit overlapping the Dodge i-frames and reports the evasion (Perfect_Dodge check)', () => {
    const { enemies, gameState, body, evaded, pushes, tick } = setup();
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 1.9 }, yaw: Math.PI });
    body.state = { ...body.state, iFrames: 10 };
    tick(120);
    expect(gameState.party.hp.kairen).toBe(1000);
    expect(pushes).toEqual([]);
    expect(evaded.length).toBeGreaterThan(0);
    expect(new Set(evaded)).toEqual(new Set([id]));
  });

  it('deals computeDamage (enemy ATK vs the character DEF) and hands the HitEvent knockback to the controller', () => {
    const { enemies, gameState, pushes, of, tick } = setup();
    enemies.spawn({ kind: 'mossbackBrute', pos: { x: 0, y: 0, z: 2.5 }, yaw: Math.PI });
    tickUntil(() => tick(), () => gameState.party.hp.kairen < 1000);
    const sweep = MOSSBACK_BRUTE.attacks[0];
    const expected = enemyDamage(MOSSBACK_BRUTE.atk, sweep?.hits[0]?.dmgMul ?? 0);
    expect(expected).toBeGreaterThan(1);
    expect(1000 - gameState.party.hp.kairen).toBe(expected);
    expect(of('player:damaged')[0]?.amount).toBe(expected);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.distance).toBe(sweep?.hits[0]?.knockback);
    expect(pushes[0]?.direction.x).toBeCloseTo(0, 9);
    expect(pushes[0]?.direction.z).toBeCloseTo(-1, 9); // away from the attacker at +Z
  });

  it('centres a target-aimed ground circle on the target feet locked at the Telegraph start', () => {
    // The Thornspitter's spike circle (r 1.5 m) lands where Kairen stood when it began, 10 m from the shooter.
    const stay = setup();
    const a = stay.enemies.spawn({ kind: 'thornspitter', pos: { x: 0, y: 0, z: 10 }, yaw: Math.PI });
    tickUntil(() => stay.tick(), () => stay.enemies.get(a)?.state === 'attack');
    expect(stay.enemies.get(a)?.aim).toEqual({ x: 0, y: 0, z: 0 });
    expect(stay.of('enemy:telegraph')[0]).toMatchObject({ telegraph: 'circle', position: { x: 0, y: 0, z: 0 } });
    stay.tick(60);
    const spike = THORNSPITTER.attacks[0]?.hits[0];
    expect(1000 - stay.gameState.party.hp.kairen).toBe(enemyDamage(THORNSPITTER.atk, spike?.dmgMul ?? 0));

    // Stepping 3 m aside during the Telegraph leaves the locked circle behind.
    const step = setup();
    const b = step.enemies.spawn({ kind: 'thornspitter', pos: { x: 0, y: 0, z: 10 }, yaw: Math.PI });
    tickUntil(() => step.tick(), () => step.enemies.get(b)?.state === 'attack');
    step.body.state = { ...step.body.state, pos: { x: 3, y: 0, z: 0 } };
    step.tick(60);
    expect(step.gameState.party.hp.kairen).toBe(1000);
  });

  it('launches projectile HitEvents that fly to the character and land through the same damage', () => {
    const { enemies, gameState, tick } = setup();
    const id = enemies.spawn({ kind: 'ashWisp', pos: { x: 0, y: 0, z: 10 }, yaw: Math.PI });
    tickUntil(() => tick(), () => enemies.projectiles.active.length > 0);
    expect(enemies.get(id)?.attack?.t).toBeGreaterThanOrEqual(0.6 - 1e-9); // launched after its 0.6 s glow
    expect(gameState.party.hp.kairen).toBe(1000);
    tickUntil(() => tick(), () => gameState.party.hp.kairen < 1000, 120);
    const fireball = ASH_WISP.attacks[0]?.hits[0];
    expect(1000 - gameState.party.hp.kairen).toBe(enemyDamage(ASH_WISP.atk, fireball?.dmgMul ?? 0));
    expect(enemies.projectiles.active).toHaveLength(0);
  });
});

describe('player knockback', () => {
  it('slides the character the full distance over 0.15 s, and a wall stops it', () => {
    const input = new InputState();
    const run = (world: ReturnType<typeof createCollisionWorld>): number => {
      const pc = new PlayerController({ world, pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
      pc.knockback({ x: 0, y: 0, z: -1 }, 2.5);
      for (let i = 0; i < Math.ceil(PLAYER_KNOCKBACK_SECONDS / DT) + 5; i++) {
        input.beginTick([], DT);
        pc.tick(input, 0, DT);
      }
      expect(pc.knockbackRemaining).toBe(0);
      return pc.state.pos.z;
    };
    expect(run(createCollisionWorld(flatHeightfield(0)))).toBeCloseTo(-2.5, 3);
    const walled = createCollisionWorld(flatHeightfield(0));
    walled.addStatic({
      kind: 'aabb', min: { x: -5, y: 0, z: -2 }, max: { x: 5, y: 3, z: -1 }, id: 1,
      flags: { climbable: false, walkableTop: true, blocksCamera: true, material: 'stone' },
    });
    const z = run(walled);
    expect(z).toBeGreaterThan(-1 + 0.4 - 0.05); // capsule radius 0.4 kept off the wall face at z = −1
    expect(z).toBeLessThan(-0.4);
  });
});

describe('enemy hit reactions', () => {
  it('flinches 0.2 s on every hit without changing the AI state, and never cuts a Telegraph', () => {
    const { enemies, gameState, tick } = setup();
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 1.9 }, yaw: Math.PI });
    tickUntil(() => tick(), () => enemies.get(id)?.state === 'attack');
    const e = enemies.get(id) as EnemyRuntime;
    const attack = e.attack;
    expect(attack?.t).toBeLessThan(0.4);
    const [receiver] = [...enemies.receivers()];
    receiver?.receive(partyHit({ stagger: 60 })); // above its poise 15, but mid-attack: additive only
    expect([e.state, e.attack, e.flinch, e.flinchHold]).toEqual(['attack', attack, ENEMY_FLINCH_SECONDS, 0]);
    tickUntil(() => tick(), () => gameState.party.hp.kairen < 1000, 30); // the claw still lands on time
    expect(e.attack).toBe(attack);
    expect(e.flinch).toBe(0);
  });

  it('a single hit at or above the poise holds its walking for the flinch outside attack; a smaller one does not', () => {
    const { enemies, tick } = setup();
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 5 }, yaw: Math.PI });
    tickUntil(() => tick(), () => enemies.get(id)?.state === 'chase');
    tick(3); // a decision has picked the approach
    const e = enemies.get(id) as EnemyRuntime;
    const [receiver] = [...enemies.receivers()];

    const z0 = e.pos.z;
    receiver?.receive(partyHit({ stagger: 14 })); // below the poise 15: additive flinch, it keeps walking
    tick();
    expect([e.state, e.flinchHold]).toEqual(['chase', 0]);
    expect(e.pos.z).toBeLessThan(z0);

    receiver?.receive(partyHit({ stagger: 15 })); // at the poise: the body is held for the 0.2 s flinch
    expect(e.flinchHold).toBe(ENEMY_FLINCH_SECONDS);
    const held = e.pos.z;
    const holdTicks = Math.round(ENEMY_FLINCH_SECONDS / DT);
    for (let i = 0; i < holdTicks - 1; i++) {
      tick();
      expect([e.state, e.pos.z]).toEqual(['chase', held]);
    }
    tick(3);
    expect(e.flinchHold).toBe(0);
    expect(e.pos.z).toBeLessThan(held); // walking again
  });
});

describe('enemy death', () => {
  it('HP 0 → dead: the token goes back, one enemy:defeated, and the body is removed 1.5 s later', () => {
    const { enemies, enemyMap, of, tick } = setup();
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 1.9 }, yaw: Math.PI });
    tickUntil(() => tick(), () => enemies.get(id)?.state === 'attack');
    expect(enemies.tokens.holders.has(id)).toBe(true);
    const [receiver] = [...enemies.receivers()];
    receiver?.receive(partyHit({ amount: 999 }));
    receiver?.receive(partyHit({ amount: 999 })); // a dead body takes nothing more
    expect(enemies.get(id)).toMatchObject({ state: 'dead', hp: 0, attack: null });
    expect(enemies.tokens.holders.size).toBe(0);
    expect(receiver?.immune()).toBe(true);
    const removeTicks = Math.round(ENEMY_DESPAWN_SECONDS / DT);
    tick(removeTicks - 1);
    expect(enemyMap.has(id)).toBe(true);
    tick();
    expect(enemyMap.has(id)).toBe(false);
    expect(of('enemy:defeated')).toEqual([{ entityId: id, kind: 'bramblekin', campId: null }]);
  });
});
