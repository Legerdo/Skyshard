import { beforeAll, describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../src/core/gameEvents';
import { UiCommandQueue } from '../../src/core/uiCommands';
import {
  createHarness, deepFreeze, HARNESS_EVENT_CAPACITY, HARNESS_GLOBAL, HarnessEventLog, installHarness, type SkyshardHarness,
} from '../../src/harness/harness';
import { buildSnapshot, RecoveryCounter, type HarnessSources } from '../../src/harness/snapshot';
import { InputState } from '../../src/input/inputState';
import { createNewGameState } from '../../src/logic/save/gameState';
import { PlaySim } from '../../src/playSim';
import { buildTerrain, type TerrainField } from '../../src/world/terrain';

// Test_Harness (task 22.2; design "Test_Harness"; Req 42.2): read-only object, frozen snapshots, the event ring.

const DT = 1 / 60;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(20240601);
});

function session() {
  const gameState = createNewGameState(20240601);
  const input = new InputState();
  const sim = new PlaySim({ gameState, terrain, input, commands: new UiCommandQueue(), sinks: { partyWipe: () => {}, ending: () => {} } });
  const log = new HarnessEventLog();
  let simTime = 0;
  log.attach(sim.bus, () => simTime);
  const sources: HarnessSources = {
    sim: () => sim,
    screens: () => ['title', 'gameplay'],
    inputContext: () => input.context,
    pauseMode: () => 'none',
    pointerLocked: () => false,
    clock: () => ({ tick: Math.round(simTime / DT), simTime, playTimeSec: simTime }),
    camera: () => ({ pos: { x: sim.player.state.pos.x, y: sim.player.state.pos.y + 4, z: sim.player.state.pos.z - 5 }, dir: { x: 0, y: -0.6, z: 0.8 } }),
    render: () => ({ fps: 60, drawCalls: 120, triangles: 45000 }),
    audio: () => ({ context: 'running', unlocked: true, musicBusGain: 0.8, sfxBusGain: 1 }),
    log,
    recoveries: new RecoveryCounter(),
  };
  const harness = createHarness(() => buildSnapshot(sources), log);
  const step = (): void => {
    input.beginTick([], DT);
    sim.tick(DT, 0);
    simTime += DT;
  };
  return { gameState, sim, log, sources, harness, step };
}

/** Every object reachable from `value` is frozen, and every own property is a non-writable data property. */
function assertDeepFrozen(value: unknown, path = 'root'): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value), path).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    expect(d !== undefined && 'value' in d && d.writable === false && d.get === undefined && d.set === undefined, `${path}.${String(key)}`).toBe(true);
    assertDeepFrozen(d?.value, `${path}.${String(key)}`);
  }
}

describe('Test_Harness object', () => {
  it('is a prototype-less frozen object with version and exactly two functions, snapshot and events', () => {
    const { harness } = session();
    expect(Object.getPrototypeOf(harness)).toBeNull();
    assertDeepFrozen(harness);
    const keys = Reflect.ownKeys(harness);
    expect([...keys].sort()).toEqual(['events', 'snapshot', 'version']);
    const functions = keys.filter((k) => typeof (harness as unknown as Record<PropertyKey, unknown>)[k] === 'function');
    expect([...functions].sort()).toEqual(['events', 'snapshot']);
    expect(harness.version).toBe(1);
    // ES modules run in strict mode: writes to frozen data throw.
    expect(() => {
      (harness as unknown as Record<string, unknown>).snapshot = () => null;
    }).toThrow(TypeError);
    expect(() => {
      (harness as unknown as Record<string, unknown>).extra = 1;
    }).toThrow(TypeError);
  });

  it('installs as a non-writable, non-configurable global once', () => {
    const { harness } = session();
    const target: Record<string, unknown> = {};
    installHarness(target, harness);
    const other = createHarness(() => { throw new Error('unused'); }, new HarnessEventLog()) as SkyshardHarness;
    installHarness(target, other);
    expect(target[HARNESS_GLOBAL]).toBe(harness);
    const d = Object.getOwnPropertyDescriptor(target, HARNESS_GLOBAL);
    expect([d?.writable, d?.configurable]).toEqual([false, false]);
    expect(() => {
      target[HARNESS_GLOBAL] = null;
    }).toThrow(TypeError);
  });
});

describe('snapshot()', () => {
  it('returns a recursively frozen copy of the last tick: writes throw and the next snapshot is unchanged', () => {
    const { harness, step, gameState } = session();
    for (let i = 0; i < 5; i++) step();
    const snap = harness.snapshot();
    assertDeepFrozen(snap);
    expect(() => {
      (snap.player.pos as { x: number }).x = 9999;
    }).toThrow(TypeError);
    expect(() => {
      (snap as unknown as { glim: number }).glim = 1e9;
    }).toThrow(TypeError);
    expect(() => {
      (snap.party as unknown as unknown[]).push(1);
    }).toThrow(TypeError);
    const again = harness.snapshot();
    expect(again).toEqual(snap);
    expect(again).not.toBe(snap);
    expect(gameState.inventory.glim).toBe(snap.glim);
  });

  it('carries the fields a bot needs, including audio bus gains, and debugUsed stays untouched', () => {
    const { harness, step, gameState, sources, sim } = session();
    step();
    const snap = harness.snapshot();
    expect(snap).toMatchObject({
      version: 1, screen: 'gameplay', screens: ['title', 'gameplay'], inputContext: 'gameplay', pauseMode: 'none',
      debugUsed: false, skyshards: 0, activeCharacter: 'kairen', level: 1, inCombat: false, cinematic: null, boss: null,
      fps: 60, drawCalls: 120, triangles: 45000,
    });
    expect(snap.party.map((p) => [p.id, p.joined])).toEqual([['kairen', true], ['isla', false], ['wren', false], ['talus', false]]);
    expect(snap.player.pos).toEqual(sim.player.state.pos);
    expect(snap.player.stamina).toBeGreaterThan(0);
    expect(snap.camera?.distance ?? 0).toBeGreaterThan(0);
    expect(snap.audio).toMatchObject({ musicBusGain: 0.8, sfxBusGain: 1 });
    expect(gameState.debugUsed).toBe(false);
    const silent = buildSnapshot({ ...sources, audio: () => null });
    expect(silent.audio).toBeNull();
  });

  it('shows the playing cinematic and the enemies within 60 m, nearest first', () => {
    const { harness, step, sim } = session();
    sim.cinematics.play('cin_skyshard_1');
    step();
    expect(harness.snapshot().cinematic).toMatchObject({ id: 'cin_skyshard_1', skippable: true, skipAvailable: false });
    const enemies = harness.snapshot().enemies;
    const d = enemies.map((e) => e.distance);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(d.every((x) => x <= 60)).toBe(true);
  });
});

describe('events(sinceSeq)', () => {
  it('logs Reactions, Phase changes, cinematics, Objectives, Skyshards, screens and wipes as frozen entries', () => {
    const bus = createGameEventBus();
    const log = new HarnessEventLog();
    let t = 0;
    log.attach(bus, () => t);
    bus.emit('reaction', { reaction: 'steamBurst', targetId: 'e1', position: { x: 1, y: 2, z: 3 }, chainDepth: 0 });
    bus.emit('boss:phaseChanged', { bossId: 'caelith', from: 1, to: 2 });
    bus.emit('cinematic:started', { cinematicId: 'cin_boss_phase2', skippableAfter: Infinity });
    bus.emit('quest:objectiveCompleted', { questId: 'main', stageId: 'ms1', objectiveId: 'ms1_maren' });
    bus.emit('skyshard:acquired', { index: 1, regionId: 'verdant' });
    bus.emit('party:wipe', { bossPhase: null });
    bus.emit('levelUp', { level: 2 }); // not logged
    t = 12.5;
    bus.dispatch();
    log.record('screen', t, { screen: 'defeat', open: true });
    const all = log.since(0);
    expect(all.map((e) => e.kind)).toEqual(['reaction', 'phase', 'cinematic', 'objective', 'skyshard', 'wipe', 'screen']);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(all[0]).toMatchObject({ t: 12.5, data: { reaction: 'steamBurst', chainDepth: 0 } });
    expect(all[2]?.data).toEqual({ event: 'started', cinematicId: 'cin_boss_phase2', skippableAfter: null });
    assertDeepFrozen(all);
    expect(log.since(5).map((e) => e.kind)).toEqual(['wipe', 'screen']);
    expect(log.since(7)).toEqual([]);
    expect(log.recentReactions()).toEqual([{ reaction: 'steamBurst', t: 12.5, chainDepth: 0 }]);
  });

  it('keeps the last 512 entries in its ring and the last 32 Reactions', () => {
    const log = new HarnessEventLog();
    for (let i = 0; i < 600; i++) log.record('reaction', i, { reaction: 'lavaRift', chainDepth: i % 3 });
    const all = log.since(0);
    expect(all).toHaveLength(HARNESS_EVENT_CAPACITY);
    expect(all[0]?.seq).toBe(600 - HARNESS_EVENT_CAPACITY + 1);
    expect(all.at(-1)?.seq).toBe(600);
    expect(log.since(590)).toHaveLength(10);
    expect(log.recentReactions()).toHaveLength(32);
    expect(Object.isFrozen(log.since(0))).toBe(true);
  });

  it('never exposes the recorded payload object (a later change to it is not seen)', () => {
    const log = new HarnessEventLog();
    const payload = { screen: 'map', open: true };
    log.record('screen', 0, payload);
    payload.open = false;
    expect(log.since(0)[0]?.data).toEqual({ screen: 'map', open: true });
    expect(deepFreeze({ a: { b: [1] } })).toSatisfy((o: { a: { b: number[] } }) => Object.isFrozen(o.a.b));
  });
});
