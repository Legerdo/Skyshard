import { describe, expect, it } from 'vitest';
import { angleDelta, DEG2RAD, dirFromYaw } from '../../../src/core/math';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import type { HitReceiver } from '../../../src/combat/attackRuntime';
import { getEnemyDef } from '../../../src/data/enemies';
import type { ElementId } from '../../../src/data/ids';
import { EnemySystem } from '../../../src/enemies/enemySystem';
import { hitsFromBehind } from '../../../src/logic/frontGuard';
import type { EnemyRuntime } from '../../../src/save/runtimeState';

// Rootbound Warden in the R5 arena (task 9.6; design "Elite" table: 등 뒤 발광 뿌리 약점, Ember 적중 시 2 s Stagger;
// anchored, turning at 60°/s).
const DT = 1 / 60;

function setup() {
  const bus = createGameEventBus();
  const map = new Map<string, EnemyRuntime>();
  const enemies = new EnemySystem({ enemies: map, terrain: { heightAt: () => 0 }, bus });
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const id = enemies.spawn({ kind: 'rootboundWarden', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
  const warden = (): EnemyRuntime => {
    const e = map.get(id);
    if (e === undefined) throw new Error('no Warden');
    return e;
  };
  const receiver = (): HitReceiver => {
    for (const r of enemies.receivers()) if (r.id === id) return r;
    throw new Error('no receiver');
  };
  /** A small hit travelling along `direction` (attacker → Warden) carrying `element`, with a knockback. */
  const hit = (direction: Vec3, element: ElementId | null): void => {
    receiver().receive({
      attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount: 10, crit: false,
      element, stagger: 0, knockback: 1.5, direction,
    });
  };
  /** A target far enough away to be out of reach, standing still. */
  const target = (pos: Vec3): HitReceiver => ({
    id: 'player',
    hurtVolume: () => ({ pos, radius: 0.4, height: 1.75 }),
    immune: () => false,
    sample: () => ({ def: 50, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
    receive: () => {},
  });
  const tick = (player: HitReceiver, seconds = DT): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) enemies.tick({ dt: DT, player });
    bus.dispatch();
  };
  return { enemies, warden, hit, tick, target, events };
}

describe('Rootbound Warden', () => {
  /** Engaged with a target 10 m in front (it faces +Z): past its 0.5 s alert, fighting. */
  const engaged = () => {
    const s = setup();
    const player = s.target({ x: 0, y: 0, z: 10 });
    s.tick(player, 0.7);
    expect(['chase', 'attack', 'recovery']).toContain(s.warden().state);
    // A hit from its back travels along its facing; one from the front against it.
    const behind = dirFromYaw(s.warden().yaw);
    return { ...s, player, behind, front: { x: -behind.x, y: 0, z: -behind.z } };
  };

  it('staggers for 2 s when Ember hits the glowing root on its back', () => {
    const s = engaged();
    s.hit(s.behind, 'ember');
    expect(s.warden().state).toBe('stagger');
    s.tick(s.player);
    expect(s.events.filter((e) => e.type === 'enemy:weakSpot').map((e) => e.payload)).toEqual([
      { entityId: s.warden().id, kind: 'rootboundWarden', seconds: 2 },
    ]);
    s.tick(s.player, 1.9);
    expect(s.warden().state).toBe('stagger');
    s.tick(s.player, 0.2);
    expect(s.warden().state).not.toBe('stagger');
  });

  it('shrugs off Ember from the front and other Elements from behind', () => {
    for (const [side, element] of [['front', 'ember'], ['behind', 'tide'], ['behind', null]] as const) {
      const s = engaged();
      s.hit(side === 'front' ? s.front : s.behind, element);
      s.tick(s.player);
      expect(s.warden().state, `${element ?? 'none'} ${side}`).not.toBe('stagger');
      expect(s.events.some((e) => e.type === 'enemy:weakSpot')).toBe(false);
    }
    // The rear sector is 120° wide: 50° off the back still counts, 70° off does not.
    const off = (deg: number): Vec3 => dirFromYaw(deg * DEG2RAD);
    expect(hitsFromBehind(0, off(50), 120)).toBe(true);
    expect(hitsFromBehind(0, off(70), 120)).toBe(false);
  });

  it('stays rooted under knockback and turns toward its target at no more than 60°/s', () => {
    const s = setup();
    const start = { ...s.warden().pos };
    s.hit({ x: 0, y: 0, z: -1 }, null); // from the front, 1.5 m of knockback; the hit alerts it
    const side = s.target({ x: 10, y: 0, z: 0 }); // 90° to its side, where it has to turn to
    s.tick(side, 0.5);
    expect(s.warden().pos).toEqual(start);
    const turned: number[] = [];
    let yaw = s.warden().yaw;
    for (let i = 0; i < 30; i++) {
      s.tick(side);
      turned.push(Math.abs(angleDelta(yaw, s.warden().yaw)));
      yaw = s.warden().yaw;
    }
    const rate = getEnemyDef('rootboundWarden').movement;
    expect(rate).toEqual({ kind: 'anchored', turnRateDeg: 60 });
    expect(Math.max(...turned)).toBeLessThanOrEqual(60 * DEG2RAD * DT + 1e-9);
    expect(Math.max(...turned)).toBeGreaterThan(0);
  });
});
