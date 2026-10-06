import { beforeAll, describe, expect, it } from 'vitest';
import type { GameEventName } from '../../../src/core/gameEvents';
import { UiCommandQueue, type DebugAction } from '../../../src/core/uiCommands';
import { mountDebugPanel } from '../../../src/debug/debugPanel';
import { DEBUG_LOCATIONS } from '../../../src/debug/debugLocations';
import { DEBUG_SESSION_KEY, debugEnabled, debugSessionFlag, setDebugSessionFlag } from '../../../src/debug/debugSession';
import { DEBUG_GLIM_GRANT, DebugTools, type DebugHost } from '../../../src/debug/debugTools';
import { InputState } from '../../../src/input/inputState';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { PlaySim } from '../../../src/playSim';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Debug_Tools (task 22.1; design "Debug_Tools"; Req 41.1–41.4).

const DT = 1 / 60;

describe('Debug_Tools gating', () => {
  it('turns on only for ?debug=1', () => {
    expect(debugEnabled('?debug=1')).toBe(true);
    expect(debugEnabled('?x=2&debug=1')).toBe(true);
    for (const search of ['', '?debug=0', '?debug=true', '?debug', '?debug=1x', '?DEBUG=1']) expect(debugEnabled(search), search).toBe(false);
  });

  it('creates no DOM and registers no shortcut without the parameter', () => {
    const touched: string[] = [];
    const trap = <T extends object>(name: string): T =>
      new Proxy({} as T, {
        get: (_t, key) => {
          touched.push(`${name}.${String(key)}`);
          throw new Error(`touched ${name}.${String(key)}`);
        },
      });
    const panel = mountDebugPanel({
      search: '', root: trap('root'), keyTarget: trap('keyTarget'), commands: trap('commands'),
      releasePointerLock: () => touched.push('releasePointerLock'),
      toggles: () => {
        touched.push('toggles');
        return null;
      },
      snapshot: () => {
        throw new Error('snapshot');
      },
      project: () => null,
    });
    expect(panel).toBeNull();
    expect(touched).toEqual([]);
  });

  it('keeps the tab flag in sessionStorage without ever throwing', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(debugSessionFlag(storage)).toBe(false);
    setDebugSessionFlag(storage);
    expect(store.get(DEBUG_SESSION_KEY)).toBe('1');
    expect(debugSessionFlag(storage)).toBe(true);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(debugSessionFlag(broken)).toBe(false);
    expect(() => setDebugSessionFlag(broken)).not.toThrow();
    expect(debugSessionFlag(null)).toBe(false);
  });

  it('lists Thistlewick, every Waystone and Landmark and the three Challenge_Area entrances as destinations', () => {
    const ids = DEBUG_LOCATIONS.map((l) => l.id);
    expect(ids[0]).toBe('thistlewick');
    expect(ids.filter((id) => id.startsWith('ws_'))).toHaveLength(6);
    expect(ids.filter((id) => id.startsWith('lm_'))).toHaveLength(8);
    expect(ids.filter((id) => id.startsWith('area_'))).toEqual(['area_hollowroot', 'area_cinderspire', 'area_observatory']);
    for (const l of DEBUG_LOCATIONS) expect(Math.hypot(l.x, l.z), l.id).toBeLessThan(470);
  });
});

describe('DebugTools', () => {
  const host = () => {
    const calls: string[] = [];
    const h: DebugHost = {
      state: { debugUsed: false },
      joinAll: () => calls.push('joinAll'),
      addGlim: (n) => calls.push(`glim ${n}`),
      grantSkyshard: () => (calls.push('skyshard'), true),
      travelTo: (x, z) => (calls.push(`travel ${x},${z}`), true),
      bossDirect: () => (calls.push('boss'), true),
    };
    return { h, calls };
  };

  it('marks debugUsed on the first operation only, and routes every operation to its public path', () => {
    const { h, calls } = host();
    let first = 0;
    const tools = new DebugTools(h, () => first++);
    expect(h.state.debugUsed).toBe(false);
    const actions: DebugAction[] = [
      { op: 'grantGlim', amount: DEBUG_GLIM_GRANT }, { op: 'joinAll' }, { op: 'grantSkyshard' }, { op: 'teleport', x: 10, z: -20 },
      { op: 'bossDirect' }, { op: 'invincible', on: true }, { op: 'showAi', on: true },
    ];
    const moved = actions.map((a) => tools.apply(a));
    expect(moved).toEqual([false, false, false, true, true, false, false]);
    expect(calls).toEqual(['glim 1000', 'joinAll', 'skyshard', 'travel 10,-20', 'boss']);
    expect([tools.invincible, tools.showAi, h.state.debugUsed, first]).toEqual([true, true, true, 1]);
  });

  it('refuses malformed operations without recording a use', () => {
    const { h, calls } = host();
    const tools = new DebugTools(h);
    for (const a of [
      { op: 'grantGlim', amount: Number.NaN }, { op: 'grantGlim', amount: -5 }, { op: 'teleport', x: 9999, z: 0 },
      { op: 'teleport', x: Number.POSITIVE_INFINITY, z: 0 }, { op: 'invincible', on: 'yes' }, { op: 'nope' },
    ] as unknown as DebugAction[]) {
      expect(tools.apply(a)).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(h.state.debugUsed).toBe(false);
  });
});

describe('Debug_Tools in the play session', () => {
  let terrain: TerrainField;
  beforeAll(() => {
    terrain = buildTerrain(20240601);
  });

  function setup() {
    const gameState = createNewGameState(20240601);
    const input = new InputState();
    const commands = new UiCommandQueue();
    const sim = new PlaySim({ gameState, terrain, input, commands, sinks: { partyWipe: () => {}, ending: () => {} } });
    const events: { type: GameEventName; payload: unknown }[] = [];
    sim.bus.onAny((type, payload) => events.push({ type, payload }));
    const step = (): void => {
      input.beginTick([], DT);
      sim.tick(DT, 0);
    };
    const debug = (action: DebugAction): void => commands.push({ kind: 'debug', action });
    return { gameState, sim, commands, events, step, debug };
  }

  it('applies queued operations on the next tick through the normal systems, and records the use', () => {
    const s = setup();
    s.step();
    expect(s.gameState.debugUsed).toBe(false);
    const glim = s.gameState.inventory.glim;
    s.debug({ op: 'grantGlim', amount: DEBUG_GLIM_GRANT });
    s.debug({ op: 'joinAll' });
    s.debug({ op: 'grantSkyshard' });
    expect(s.gameState.inventory.glim).toBe(glim); // queued, not applied yet
    expect(s.gameState.debugUsed).toBe(false);
    s.step();
    expect(s.gameState.inventory.glim).toBe(glim + DEBUG_GLIM_GRANT);
    expect(s.gameState.party.joined).toEqual(['kairen', 'isla', 'wren', 'talus']);
    expect(s.gameState.skyshards).toBe(1);
    expect(s.gameState.debugUsed).toBe(true);
    const names = s.events.map((e) => e.type);
    expect(names.filter((n) => n === 'party:joined')).toHaveLength(3);
    expect(names).toContain('skyshard:acquired');
    expect(names).toContain('save:request');
  });

  it('makes the Active_Character immune while 무적 is on, like the Burst cut-in', () => {
    const s = setup();
    s.step();
    expect(s.sim.playerReceiver.immune()).toBe(false);
    s.debug({ op: 'invincible', on: true });
    s.step();
    expect(s.sim.playerReceiver.immune()).toBe(true);
    s.debug({ op: 'invincible', on: false });
    s.step();
    expect(s.sim.playerReceiver.immune()).toBe(false);
  });

  it('teleports with the fast-travel move and starts Caelith from Phase 1 on 보스 직행', () => {
    const s = setup();
    s.step();
    const at = DEBUG_LOCATIONS.find((l) => l.id === 'ws_crater');
    if (at === undefined) throw new Error('no ws_crater');
    s.debug({ op: 'teleport', x: at.x, z: at.z });
    s.step();
    expect(Math.hypot(s.sim.player.state.pos.x - at.x, s.sim.player.state.pos.z - at.z)).toBeLessThan(0.5);
    s.debug({ op: 'bossDirect' });
    s.step();
    expect(s.sim.boss.active).toBe(true);
    expect(s.sim.boss.phase).toBe(1);
    expect(s.sim.sanctum.inFightZone(s.sim.player.state.pos)).toBe(true);
  });
});
