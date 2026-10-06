import { describe, expect, it } from 'vitest';
import {
  AIM_TURN_SECONDS, meleeAssistTarget, rangedAim, RANGED_AIM_RANGE,
} from '../../src/combat/aim';
import {
  judgeHitEvent, startAttack, type Attacker, type HitReceiver, type ResolvedHit,
} from '../../src/combat/attackRuntime';
import { PERFECT_DODGE_SECONDS, PERFECT_DODGE_TIME_SCALE, PerfectDodge } from '../../src/combat/perfectDodge';
import { PlayerCombat, SHOT_HEIGHT, type CombatBody } from '../../src/combat/playerCombat';
import { createPlayerReceiver } from '../../src/combat/playerReceiver';
import { ProjectileSystem, sweptSphereContact } from '../../src/combat/projectiles';
import { createGameEventBus, type GameEvents } from '../../src/core/gameEvents';
import { DEG2RAD } from '../../src/core/math';
import { createRng } from '../../src/core/rng';
import type { Vec3 } from '../../src/core/types';
import { CHARACTERS } from '../../src/data/characters';
import type { AttackDef, HitEvent } from '../../src/data/combatTypes';
import type { CharacterId } from '../../src/data/ids';
import { EnemySystem } from '../../src/enemies/enemySystem';
import { InputState, type RawInput } from '../../src/input/inputState';
import { activeMark } from '../../src/logic/element';
import { createNewGameState } from '../../src/logic/save/gameState';
import { createCollisionWorld } from '../../src/physics/collisionWorld';
import { flatHeightfield } from '../../src/physics/heightfield';
import type { Collider } from '../../src/physics/types';
import { createControllerState, type ControllerState } from '../../src/player/core/types';

// Combat action runtime (design "전투 액션 모델", "Energy·Cooldown·Dodge"; Req 24.1–24.3, 24.8, 24.9, 24.11–24.13,
// 20.3, 38.6).
const DT = 1 / 60;
const TAP: RawInput[] = [
  { kind: 'down', code: 'Mouse0', time: 0 },
  { kind: 'up', code: 'Mouse0', time: 0 },
];
const DOWN: RawInput[] = [{ kind: 'down', code: 'Mouse0', time: 0 }];
const UP: RawInput[] = [{ kind: 'up', code: 'Mouse0', time: 0 }];

/** A target standing at `pos` (feet) that records the hits it takes. */
function dummy(id: string, pos: Vec3, radius = 0.5, height = 1.6) {
  const hits: ResolvedHit[] = [];
  const receiver: HitReceiver = {
    id,
    hurtVolume: () => ({ pos, radius, height }),
    immune: () => false,
    sample: () => ({ def: 0, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
    receive: (hit) => hits.push(hit),
  };
  return { receiver, hits };
}

function attackerAt(pos: Vec3, yaw = 0): Attacker {
  return {
    id: 'player',
    origin: { pos, yaw },
    stats: { baseAtk: 100, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
    kind: 'normal',
    element: null,
    roll: () => 0.99,
  };
}

class Body implements CombatBody {
  state: ControllerState = createControllerState({ x: 0, y: 0, z: 0 }, 0);
  face(yaw: number): void {
    this.state = { ...this.state, yaw };
  }
}

function combatFor(character: CharacterId, targets: () => Iterable<HitReceiver>, world: ConstructorParameters<typeof PlayerCombat>[0]['world'] = null) {
  const bus = createGameEventBus();
  const input = new InputState();
  const body = new Body();
  const combat = new PlayerCombat({ bus, rng: createRng(3), level: () => 1, character: () => character, world });
  const tick = (events: RawInput[] = [], cameraYaw = 0) => {
    input.beginTick(events, DT);
    return combat.tick({ input, body, cameraYaw, targets: targets(), dt: DT });
  };
  return { bus, input, body, combat, tick };
}

describe('hit judgement: each target at most once per HitEvent', () => {
  it('an arc HitEvent listing the same target twice, and judged again, hits it once', () => {
    const a = dummy('a', { x: 0, y: 0, z: 1.5 });
    const b = dummy('b', { x: 0.8, y: 0, z: 1.2 });
    const def = CHARACTERS.kairen.normal[0] as AttackDef;
    const p = startAttack(def);
    const attacker = attackerAt({ x: 0, y: 0, z: 0 });
    const first = judgeHitEvent(p, 0, attacker, [a.receiver, b.receiver, a.receiver]);
    expect(first.map((r) => r.receiver.id)).toEqual(['a', 'b']);
    expect(judgeHitEvent(p, 0, attacker, [a.receiver, b.receiver])).toEqual([]);
    expect([a.hits.length, b.hits.length]).toEqual([1, 1]);
  });

  it("Bramblekin's two HitEvents each hit the dodging player once at most, and only its first i-frame overlap is a Perfect_Dodge", () => {
    const bus = createGameEventBus();
    const gameState = createNewGameState(1);
    let state: ControllerState = { ...createControllerState({ x: 0, y: 0, z: 1.2 }, 0), iFrames: 0.25 };
    const requests: [string, number, number][] = [];
    const dodge = new PerfectDodge({ bus, character: () => 'kairen', setTimeScale: (s, k, t) => requests.push([s, k, t]) });
    const player = createPlayerReceiver({ gameState, bus, body: () => state, onEvade: (id, i) => dodge.evaded(id, i) });
    const perfect: GameEvents['perfectDodge'][] = [];
    bus.on('perfectDodge', (e) => perfect.push(e));
    const claw = { ...(CHARACTERS.kairen.normal[0] as AttackDef), hits: [
      { t: 0, shape: { kind: 'arc', radius: 1.8, angleDeg: 100, height: 1.6 }, dmgMul: 1, appliesElement: false, poise: 0, knockback: 0, energy: null },
      { t: 0.1, shape: { kind: 'arc', radius: 1.8, angleDeg: 100, height: 1.6 }, dmgMul: 1, appliesElement: false, poise: 0, knockback: 0, energy: null },
    ] satisfies HitEvent[] };
    const p = startAttack(claw);
    const enemy = { ...attackerAt({ x: 0, y: 0, z: 0 }), id: 'bramblekin_1', kind: 'enemy' as const };
    dodge.observe(state.iFrames);
    const hp = gameState.party.hp.kairen;
    expect(judgeHitEvent(p, 0, enemy, [player, player])).toEqual([]); // i-frames: no damage
    expect(judgeHitEvent(p, 1, enemy, [player])).toEqual([]);
    bus.dispatch();
    expect(perfect).toEqual([{ characterId: 'kairen', attackerId: 'bramblekin_1' }]);
    expect(requests).toEqual([['perfectDodge', PERFECT_DODGE_TIME_SCALE, PERFECT_DODGE_SECONDS]]);
    expect(gameState.party.hp.kairen).toBe(hp);

    // The i-frames run out: the next HitEvent lands; a new Dodge re-arms the Perfect_Dodge.
    state = { ...state, iFrames: 0 };
    dodge.observe(0);
    const again = startAttack(claw);
    expect(judgeHitEvent(again, 0, enemy, [player])).toHaveLength(1);
    state = { ...state, iFrames: 0.25 };
    dodge.observe(0.25);
    judgeHitEvent(again, 1, enemy, [player]);
    expect(dodge.total).toBe(2);
  });
});

describe('aim target selection', () => {
  it('melee aim assist: the nearest living target within 5 m and 60° of the camera forward', () => {
    const at = { x: 0, y: 0, z: 0 };
    const ahead = dummy('ahead', { x: 0, y: 0, z: 4 });
    const nearSide = dummy('side', { x: 2 * Math.sin(70 * DEG2RAD), y: 0, z: 2 * Math.cos(70 * DEG2RAD) }); // 70°: outside
    const far = dummy('far', { x: 0, y: 0, z: 5.6 }); // 5.1 m to its surface
    const inside = dummy('inside', { x: 3 * Math.sin(50 * DEG2RAD), y: 0, z: 3 * Math.cos(50 * DEG2RAD) });
    expect(meleeAssistTarget(at, 0, [ahead.receiver, nearSide.receiver, far.receiver])?.id).toBe('ahead');
    expect(meleeAssistTarget(at, 0, [ahead.receiver, inside.receiver])?.id).toBe('inside');
    expect(meleeAssistTarget(at, 0, [nearSide.receiver, far.receiver])).toBeNull();
    expect(meleeAssistTarget(at, Math.PI, [ahead.receiver])).toBeNull(); // camera looking the other way
  });

  it("Isla: Lock-on target first, else the nearest in the 30° / 25 m cone, else the camera ray's point", () => {
    const at = { x: 0, y: 0, z: 0 };
    const locked = dummy('locked', { x: 10, y: 0, z: -3 });
    const cone = dummy('cone', { x: 3, y: 0, z: 12 }); // ≈ 14°
    const wide = dummy('wide', { x: 6, y: 0, z: 6 }); // 45°
    const beyond = dummy('beyond', { x: 0, y: 0, z: 26 });
    const all = [locked.receiver, cone.receiver, wide.receiver, beyond.receiver];
    const lockView = { lockTarget: 'locked', ray: null };
    expect(rangedAim(at, 0, lockView, all, null, SHOT_HEIGHT)).toMatchObject({ kind: 'lockOn', target: { id: 'locked' } });
    expect(rangedAim(at, 0, { lockTarget: null, ray: null }, all, null, SHOT_HEIGHT)).toMatchObject({ kind: 'cone', target: { id: 'cone' } });

    const world = createCollisionWorld(flatHeightfield(0));
    const ray = { origin: { x: 0, y: 3, z: -5 }, dir: { x: 0, y: -0.2, z: 1 } };
    const onGround = rangedAim(at, 0, { lockTarget: null, ray }, [wide.receiver, beyond.receiver], world, SHOT_HEIGHT);
    expect(onGround.kind).toBe('ray');
    if (onGround.kind === 'ray') expect(onGround.point).toEqual({ x: 0, y: expect.closeTo(0, 6), z: expect.closeTo(10, 6) });
    const sky = rangedAim(at, 0, { lockTarget: null, ray: { origin: ray.origin, dir: { x: 0, y: 0, z: 1 } } }, [], world, SHOT_HEIGHT);
    expect(sky).toEqual({ kind: 'ray', point: { x: 0, y: 3, z: -5 + RANGED_AIM_RANGE } });
  });

  it('a melee attack turns toward the assist target within 0.1 s, before its first hit', () => {
    const side = dummy('side', { x: 2, y: 0, z: 2 }); // 45° to the left of +Z (toward +X)
    const { body, tick } = combatFor('kairen', () => [side.receiver]);
    tick(TAP);
    const ticks = Math.round(AIM_TURN_SECONDS / DT);
    for (let i = 1; i < ticks; i++) tick();
    expect(body.state.yaw).toBeCloseTo(45 * DEG2RAD, 6);
    for (let i = 0; i < 60 && side.hits.length === 0; i++) tick();
    expect(side.hits).toHaveLength(1);
  });
});

describe('projectiles', () => {
  const wall: Collider = {
    kind: 'aabb', id: 1, min: { x: -3, y: -1, z: 9.9 }, max: { x: 3, y: 6, z: 10.1 },
    flags: { climbable: false, walkableTop: false, blocksCamera: true, material: 'stone' },
  };
  const fast: HitEvent = {
    t: 0, shape: { kind: 'projectile', speed: 240, radius: 0.1, maxRange: 25, gravity: 0, pierce: 0 },
    dmgMul: 1, appliesElement: false, poise: 0, knockback: 0, energy: 'normalHit',
  };

  it('a 240 m/s arrow (4 m per tick) stops on a 0.2 m wall and never reaches the target behind it', () => {
    const world = createCollisionWorld(flatHeightfield(-50));
    world.addStatic(wall);
    const target = dummy('behind', { x: 0, y: 0, z: 12 });
    const system = new ProjectileSystem({ pool: { active: [] }, world });
    const arrow = system.spawn({ attacker: attackerAt({ x: 0, y: 0, z: 0 }), attackId: 'atk_isla_n1', hitIndex: 0, hit: fast, from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: 1 } });
    for (let i = 0; i < 20; i++) system.tick(DT, [target.receiver]);
    expect(target.hits).toEqual([]);
    expect(system.active).toEqual([]);
    expect(arrow.pos.z).toBeLessThan(9.9);
    expect(arrow.pos.z).toBeGreaterThan(9.5);

    // Control: without the wall the same shot hits the target once, then the record goes back to the pool.
    const open = new ProjectileSystem({ pool: { active: [] }, world: createCollisionWorld(flatHeightfield(-50)) });
    const shot = open.spawn({ attacker: attackerAt({ x: 0, y: 0, z: 0 }), attackId: 'atk_isla_n1', hitIndex: 0, hit: fast, from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: 1 } });
    for (let i = 0; i < 20; i++) open.tick(DT, [target.receiver]);
    expect(target.hits).toHaveLength(1);
    expect(open.pooled).toBe(1);
    const reused = open.spawn({ attacker: attackerAt({ x: 0, y: 0, z: 0 }), attackId: 'atk_isla_n1', hitIndex: 0, hit: fast, from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: 1 } });
    expect(reused).toBe(shot); // the same record, relaunched under a new id
    expect([reused.id, reused.travelled, open.pooled]).toEqual(['proj_2', 0, 0]);
  });

  it('a piercing arrow hits targets in path order up to pierce + 1, each once; the swept contact is exact', () => {
    const line = [4, 8, 12, 16].map((z) => dummy(`t${z}`, { x: 0, y: 0, z }));
    const charged = CHARACTERS.isla.charged.hits[0] as HitEvent; // pierce 2
    const system = new ProjectileSystem({ pool: { active: [] }, world: null });
    system.spawn({ attacker: attackerAt({ x: 0, y: 0, z: 0 }), attackId: 'atk_isla_charged', hitIndex: 0, hit: charged, from: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: 1 } });
    const order: string[] = [];
    for (let i = 0; i < 40; i++) for (const r of system.tick(DT, [...line].reverse().map((t) => t.receiver))) order.push(r.receiver.id);
    expect(order).toEqual(['t4', 't8', 't12']);
    expect(line.map((t) => t.hits.length)).toEqual([1, 1, 1, 0]);

    const s = sweptSphereContact({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 10 }, 0.1, { pos: { x: 0, y: 0, z: 5 }, radius: 0.4, height: 1.6 });
    expect(s).toBeCloseTo(0.45, 6); // touches at z = 5 − 0.5
    expect(sweptSphereContact({ x: 0, y: 5, z: 0 }, { x: 0, y: 5, z: 10 }, 0.1, { pos: { x: 0, y: 0, z: 5 }, radius: 0.4, height: 1.6 })).toBeNull();
  });

  it("Isla's Normal_Attack shoots toward the Lock-on target and hits it (swept against the terrain)", () => {
    const target = dummy('mark', { x: -6, y: 0, z: 14 });
    const world = createCollisionWorld(flatHeightfield(0));
    const bus = createGameEventBus();
    const input = new InputState();
    const body = new Body();
    const combat = new PlayerCombat({ bus, rng: createRng(3), level: () => 1, character: () => 'isla', world });
    const aim = { lockTarget: 'mark', ray: null };
    for (let i = 0; i < 60 && target.hits.length === 0; i++) {
      input.beginTick(i === 0 ? TAP : [], DT);
      combat.tick({ input, body, cameraYaw: Math.PI / 2, aim, targets: [target.receiver], dt: DT });
    }
    expect(target.hits).toHaveLength(1);
    expect(combat.projectiles.active).toEqual([]);
  });
});

describe('Charged_Attack, Element and Dodge cancel', () => {
  it('releasing attack after ≥ 0.4 s starts the Charged_Attack; a shorter hold does not', () => {
    const { combat, tick } = combatFor('kairen', () => []);
    tick(DOWN);
    for (let t = DT; t < 0.3 - 1e-9; t += DT) tick();
    tick(UP);
    expect(combat.attackKind).not.toBe('charged');
    while (combat.attack !== null) tick();

    tick(DOWN);
    for (let t = DT; t < 0.4 - 1e-9; t += DT) tick();
    tick(UP);
    const playing = (): string | null => combat.attack?.def.id ?? null; // re-read past the loop's narrowing
    expect([combat.attackKind, playing()]).toEqual(['charged', 'atk_kairen_charged']);
  });

  it("only the appliesElement HitEvent (Kairen's 4th hit) marks the enemy with Ember and reports 'element:applied'", () => {
    const bus = createGameEventBus();
    const enemies = new EnemySystem({ enemies: new Map(), terrain: { heightAt: () => 0 }, bus });
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 1.8 }, yaw: Math.PI, level: 20 });
    const input = new InputState();
    const body = new Body();
    const combat = new PlayerCombat({ bus, rng: createRng(3), level: () => 1, character: () => 'kairen' });
    const applied: GameEvents['element:applied'][] = [];
    bus.on('element:applied', (e) => applied.push(e));
    const tick = (events: RawInput[] = []) => {
      input.beginTick(events, DT);
      combat.tick({ input, body, cameraYaw: 0, targets: enemies.receivers(), dt: DT });
      bus.dispatch();
    };
    const chain = CHARACTERS.kairen.normal;
    tick(TAP);
    for (let step = 1; step < chain.length; step++) {
      const [open] = (chain[step - 1] as AttackDef).comboWindow ?? [0];
      while ((combat.attack?.t ?? Infinity) < open - 1e-9) tick();
      expect(applied).toEqual([]);
      tick(TAP);
    }
    while (combat.attack !== null) tick();
    expect(applied).toEqual([{ targetId: id, element: 'ember', source: 'kairen' }]);
    expect(activeMark(enemies.get(id)!.element, enemies.simTime)?.element).toBe('ember');
  });

  it('a Dodge pressed during the attack is held back until dodgeCancelFrom, then let through to cancel it', () => {
    const { combat, input, body, tick } = combatFor('kairen', () => []);
    const gate = combat.gateInput(input);
    const n1 = CHARACTERS.kairen.normal[0] as AttackDef;
    tick(TAP);
    while ((combat.attack?.t ?? Infinity) < 0.1) tick();
    tick([{ kind: 'down', code: 'Mouse2', time: 0 }, { kind: 'up', code: 'Mouse2', time: 0 }]); // buffered 0.15 s
    while ((combat.attack?.t ?? Infinity) < n1.dodgeCancelFrom - 1e-9) {
      expect(gate.isBuffered('dodge')).toBe(false);
      tick();
    }
    expect(gate.isBuffered('dodge')).toBe(true); // the controller now starts the Dodge
    body.state = { ...body.state, mode: 'dodge' };
    tick();
    expect(combat.attack).toBeNull(); // leaving the standing mode cancels the attack
  });
});
