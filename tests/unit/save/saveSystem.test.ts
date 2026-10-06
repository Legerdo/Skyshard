import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import { serializeSave } from '../../../src/logic/save/envelope';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { MemoryStore } from '../../../src/logic/save/keyValueStore';
import { loadSave } from '../../../src/logic/save/load';
import { SAVE_KEYS } from '../../../src/logic/save/saveKeys';
import { SaveSystem, type SaveTarget } from '../../../src/save/saveSystem';
import { openSaveStore } from '../../../src/save/storage';

// Save_System writes, backups and failures (task 15.6, Req 36.6, 36.7, 36.13).

function setup(store = new MemoryStore()) {
  const bus = createGameEventBus();
  const gameState = createNewGameState(20240601);
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  let recorded = 0;
  const target: SaveTarget = {
    bus, gameState, playTimeSec: () => 123.5,
    recordPosition: () => {
      recorded++;
      gameState.lastSafe = { pos: [1, 2, 3], yaw: 0.5 };
    },
  };
  const system = new SaveSystem(store);
  system.attach(target);
  return { bus, gameState, events, system, store, recorded: () => recorded };
}

describe('SaveSystem', () => {
  it("a 'save:request' is written after the merge window with the position and play time, then 'save:done'", () => {
    const { bus, system, store, events, recorded } = setup();
    bus.emit('save:request', { reason: 'chest' });
    bus.dispatch();
    for (let i = 0; i < 40; i++) system.update(1 / 60, { inCombat: false, cinematic: false });
    bus.dispatch();
    expect(recorded()).toBe(1);
    const loaded = loadSave(store);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.state.lastSafe).toEqual({ pos: [1, 2, 3], yaw: 0.5 });
      expect(loaded.state.stats.playTimeSec).toBe(123.5);
    }
    const done = events.find((e) => e.type === 'save:done');
    expect(done?.payload).toMatchObject({ reason: 'chest' });
  });

  it('the main save is copied to the backup before a write only when it passes the load checks', () => {
    const { system, store } = setup();
    store.setItem(SAVE_KEYS.main, 'corrupt');
    store.setItem(SAVE_KEYS.backup, 'old backup');
    system.saveNow('manual');
    expect(store.getItem(SAVE_KEYS.backup)).toBe('old backup');
    const first = store.getItem(SAVE_KEYS.main);
    system.saveNow('manual');
    expect(store.getItem(SAVE_KEYS.backup)).toBe(first);
  });

  it("a failing store sends 'save:failed', drops the waiting requests and keeps going", () => {
    const store = new MemoryStore();
    const { bus, system, events } = setup(store);
    const quota = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    store.setItem = () => {
      throw quota;
    };
    bus.emit('save:request', { reason: 'levelUp' });
    bus.dispatch();
    expect(() => {
      for (let i = 0; i < 40; i++) system.update(1 / 60, { inCombat: false, cinematic: false });
    }).not.toThrow();
    bus.dispatch();
    expect(events.find((e) => e.type === 'save:failed')?.payload).toMatchObject({ reason: 'levelUp', error: expect.stringContaining('QuotaExceededError') });
    expect(system.scheduler.pendingCount).toBe(0);
  });

  it('New Game moves the main save to the backup and leaves the settings alone', () => {
    const store = new MemoryStore();
    const main = serializeSave(createNewGameState(1), 1);
    store.setItem(SAVE_KEYS.main, main);
    store.setItem(SAVE_KEYS.settings, '{"musicOn":false}');
    new SaveSystem(store).archiveForNewGame();
    expect(store.getItem(SAVE_KEYS.main)).toBeNull();
    expect(store.getItem(SAVE_KEYS.backup)).toBe(main);
    expect(store.getItem(SAVE_KEYS.settings)).toBe('{"musicOn":false}');
  });

  it('boot store: localStorage when writable, else an in-memory store', () => {
    expect(openSaveStore(() => { throw new Error('SecurityError'); }).persistent).toBe(false);
    expect(openSaveStore(() => null).persistent).toBe(false);
    const ok = openSaveStore(() => new MemoryStore() as unknown as Storage);
    expect(ok.persistent).toBe(true);
  });
});
