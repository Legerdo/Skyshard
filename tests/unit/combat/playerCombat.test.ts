import { describe, expect, it } from 'vitest';
import type { HitReceiver } from '../../../src/combat/attackRuntime';
import { PlayerCombat, type CombatBody } from '../../../src/combat/playerCombat';
import { createGameEventBus, type GameEvents } from '../../../src/core/gameEvents';
import { createRng } from '../../../src/core/rng';
import { CHARACTERS } from '../../../src/data/characters';
import type { AttackDef } from '../../../src/data/combatTypes';
import { EnemySystem } from '../../../src/enemies/enemySystem';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createControllerState, type ControllerState } from '../../../src/player/core/types';

// Kairen's Normal_Attack combo through the InputBuffer (design "전투 액션 모델"; Req 24.1, 24.10, 24.11).
const DT = 1 / 60;
const CHAIN = CHARACTERS.kairen.normal;
/** Left click pressed and released within one tick. */
const TAP: RawInput[] = [
  { kind: 'down', code: 'Mouse0', time: 0 },
  { kind: 'up', code: 'Mouse0', time: 0 },
];

/** The Active_Character standing at the origin facing +Z. */
class Body implements CombatBody {
  state: ControllerState = createControllerState({ x: 0, y: 0, z: 0 }, 0);
  face(yaw: number): void {
    this.state = { ...this.state, yaw };
  }
}

function setup(targets: Iterable<HitReceiver> = []) {
  const bus = createGameEventBus();
  const input = new InputState();
  const body = new Body();
  const combat = new PlayerCombat({ bus, rng: createRng(7), level: () => 1, character: () => 'kairen' });
  const tick = (events: RawInput[] = []) => {
    input.beginTick(events, DT);
    return combat.tick({ input, body, cameraYaw: 0, targets, dt: DT });
  };
  const idOf = () => combat.attack?.def.id ?? null;
  return { bus, input, body, combat, tick, idOf };
}

describe('PlayerCombat Normal_Attack combo', () => {
  it('a press starts hit 1, and a press inside each comboWindow chains hits 2, 3 and 4', () => {
    const { combat, tick, idOf } = setup();
    tick(TAP);
    expect([idOf(), combat.comboStep]).toEqual(['atk_kairen_n1', 0]);
    for (let step = 1; step < CHAIN.length; step++) {
      const [open] = (CHAIN[step - 1] as AttackDef).comboWindow ?? [Number.NaN];
      while ((combat.attack?.t ?? Infinity) < open - 1e-9) tick();
      tick(TAP);
      expect([idOf(), combat.comboStep]).toEqual([CHAIN[step]?.id, step]);
    }
    let ticks = 0;
    while (combat.attack !== null && ticks < 600) {
      tick();
      ticks++;
    }
    expect(ticks * DT).toBeCloseTo((CHAIN[3] as AttackDef).duration, 1); // hit 4 has no comboWindow
    tick(TAP);
    expect(idOf()).toBe('atk_kairen_n1');
  });

  it('a press that expires before the window opens does not chain; the next press after the clip is hit 1 again', () => {
    const { combat, tick, idOf } = setup();
    tick(TAP);
    tick();
    tick(TAP); // t ≈ 0.03 s: buffered 0.15 s, gone before the window opens at 0.22 s
    const seen = new Set<string | null>();
    while (combat.attack !== null) {
      tick();
      seen.add(idOf());
    }
    expect([...seen]).toEqual(['atk_kairen_n1', null]);
    tick(TAP);
    expect([idOf(), combat.comboStep]).toEqual(['atk_kairen_n1', 0]);
  });

  it('a press buffered just before the window chains as soon as the window opens (consume in the window)', () => {
    const { combat, tick, idOf } = setup();
    tick(TAP);
    while ((combat.attack?.t ?? Infinity) < 0.12) tick();
    tick(TAP);
    expect(idOf()).toBe('atk_kairen_n1');
    let chainedAfter = Number.NaN;
    while (idOf() === 'atk_kairen_n1') {
      chainedAfter = combat.attack?.t ?? Number.NaN;
      tick();
    }
    expect(idOf()).toBe('atk_kairen_n2');
    expect(chainedAfter).toBeGreaterThanOrEqual(0.22 - 1e-9);
    expect(chainedAfter).toBeLessThan(0.22 + DT);
  });

  it('holds movement and Dodge back until recoveryFrom / dodgeCancelFrom; moving after recoveryFrom ends the attack', () => {
    const { combat, input, tick } = setup();
    const gate = combat.gateInput(input);
    tick(TAP);
    tick([{ kind: 'down', code: 'KeyW', time: 0 }, { kind: 'down', code: 'Mouse2', time: 0 }]);
    expect(input.moveVector()).toEqual({ x: 0, y: 1 });
    expect([gate.moveVector(), gate.down('sprint'), gate.isBuffered('dodge')]).toEqual([{ x: 0, y: 0 }, false, false]);
    expect(input.isBuffered('dodge')).toBe(true);
    let lastT = 0;
    while (combat.attack !== null) {
      lastT = combat.attack.t;
      tick();
    }
    const n1 = CHAIN[0] as AttackDef;
    expect(lastT).toBeGreaterThanOrEqual(n1.recoveryFrom - DT);
    expect(lastT).toBeLessThan(n1.duration - DT);
    expect(gate.moveVector()).toEqual({ x: 0, y: 1 });
  });

  it('faces the move input when an attack starts, and cancels when the character leaves the ground', () => {
    const { combat, body, tick } = setup();
    tick([{ kind: 'down', code: 'KeyD', time: 0 }, ...TAP]); // camera yaw 0: screen-right is −X
    expect(body.state.yaw).toBeCloseTo(-Math.PI / 2, 6);
    body.state = { ...body.state, mode: 'dodge' };
    tick();
    expect(combat.attack).toBeNull();
  });

  it('hit 1 damages a Bramblekin at its 0.18 s hit time: 120 × 0.9 × 100 / 120 = 90 (135 on a crit)', () => {
    const bus = createGameEventBus();
    const enemies = new EnemySystem({ enemies: new Map(), terrain: { heightAt: () => 0 }, bus });
    const id = enemies.spawn({ kind: 'bramblekin', pos: { x: 0, y: 0, z: 1.8 }, yaw: Math.PI });
    const { combat, tick } = setupWith(bus, enemies.receivers());
    const dealt: GameEvents['damage:dealt'][] = [];
    bus.on('damage:dealt', (p) => dealt.push(p));
    tick(TAP);
    let t = 0;
    while (enemies.get(id)?.hp === 180) {
      t = combat.attack?.t ?? Number.NaN;
      tick();
    }
    expect(t + DT).toBeGreaterThanOrEqual(0.18 - 1e-9);
    expect(t).toBeLessThan(0.18);
    bus.dispatch();
    expect(dealt).toHaveLength(1);
    const [hit] = dealt;
    expect(hit?.amount).toBe(hit?.crit === true ? 135 : 90);
    expect(enemies.get(id)?.hp).toBe(180 - (hit?.amount ?? 0));
    expect(hit).toMatchObject({ targetId: id, element: null });
  });
});

/** setup() on a given bus and target list. */
function setupWith(bus: ReturnType<typeof createGameEventBus>, targets: Iterable<HitReceiver>) {
  const input = new InputState();
  const body = new Body();
  const combat = new PlayerCombat({ bus, rng: createRng(7), level: () => 1, character: () => 'kairen' });
  const tick = (events: RawInput[] = []) => {
    input.beginTick(events, DT);
    return combat.tick({ input, body, cameraYaw: 0, targets, dt: DT });
  };
  return { combat, tick };
}
