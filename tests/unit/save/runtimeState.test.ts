import { describe, expect, it } from 'vitest';
import { LOCATIONS, NEW_GAME_START, THISTLEWICK_HEARTH } from '../../../src/data/worldLayout';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { createStaminaState } from '../../../src/logic/stamina';
import { createControllerState } from '../../../src/player/core/types';
import { createRuntimeState } from '../../../src/save/runtimeState';

/** Recursively frozen copy target: any write createRuntimeState made would throw in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const tablets = (region: string): string[] => [1, 2, 3].map((n) => `tab_${region}_${n}`);

describe('createRuntimeState', () => {
  it('rebuilds a fresh New Game runtime: player at the start, full Stamina, no Energy, cooldowns or combat', () => {
    const gs = createNewGameState(42);
    const rt = createRuntimeState(gs);
    expect(rt).toStrictEqual({
      player: createControllerState({ x: NEW_GAME_START.x, y: 18, z: NEW_GAME_START.z }, NEW_GAME_START.yaw),
      stamina: createStaminaState(100),
      energy: { kairen: 0, isla: 0, wren: 0, talus: 0 },
      cooldowns: { kairen: 0, isla: 0, wren: 0, talus: 0 },
      switchLockUntil: 0,
      shield: null,
      inCombat: false,
      lockTarget: null,
      enemies: new Map(),
      projectiles: { active: [] },
      enemyProjectiles: { active: [] },
      pickups: [],
      zones: [],
      boss: null,
      cinematic: null,
    });
    expect([rt.player.mode, rt.player.grounded, rt.player.vel]).toEqual(['grounded', true, { x: 0, y: 0, z: 0 }]);
  });

  it('only reads the GameState and returns independent objects on every call', () => {
    const gs = deepFreeze(createNewGameState(7));
    const [a, b] = [createRuntimeState(gs), createRuntimeState(gs)];
    expect(a).toStrictEqual(b);
    a.player.pos.x += 5;
    a.energy.kairen = 60;
    a.zones.push({ id: 'z', source: 'lavaRift', owner: 'kairen', pos: { x: 0, y: 0, z: 0 }, radius: 3, until: 4 });
    expect(b).toStrictEqual(createRuntimeState(gs));
    expect(gs).toStrictEqual(createNewGameState(7));
  });

  it('places the player on the saved Safe_Position, or on the respawn point when there is none', () => {
    const base = createNewGameState(1);
    const at = (state: GameState): [number, number, number, number] => {
      const { pos, yaw } = createRuntimeState(state).player;
      return [pos.x, pos.y, pos.z, yaw];
    };
    expect(at({ ...base, lastSafe: { pos: [10, 4.5, -20], yaw: 1.25 } })).toEqual([10, 4.5, -20, 1.25]);
    const hearth = THISTLEWICK_HEARTH;
    expect(at({ ...base, lastSafe: null })).toEqual([hearth.x, hearth.groundY, hearth.z, hearth.yaw]);
    // Task 13.7: a Waystone respawn stands on its spot 2 m in front of the stone (src/data/waystones.ts).
    const ws = LOCATIONS.ws_ember;
    const [x, y, z, yaw] = at({ ...base, lastSafe: null, respawn: { kind: 'waystone', id: 'ws_ember' } });
    expect(Math.hypot(x - ws.x, z - ws.z)).toBeCloseTo(2, 9);
    expect(y).toBe(ws.groundY);
    expect(yaw).toBeCloseTo(Math.atan2(x - ws.x, z - ws.z), 9);
  });

  it('sizes Stamina from the completed regional Echo_Tablet sets (Req 10.9)', () => {
    const base = createNewGameState(1);
    const withTablets = (echoTablets: string[]): GameState => ({ ...base, world: { ...base.world, echoTablets } });
    expect(createRuntimeState(withTablets(['tab_verdant_1', 'tab_verdant_2'])).stamina).toEqual(createStaminaState(100));
    expect(createRuntimeState(withTablets(tablets('verdant'))).stamina).toEqual(createStaminaState(115));
    expect(createRuntimeState(withTablets([...tablets('verdant'), ...tablets('ember'), ...tablets('azure')])).stamina)
      .toEqual(createStaminaState(145));
  });
});
