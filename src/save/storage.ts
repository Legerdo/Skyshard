/*
 * The save store at boot (design "저장소 없음"): localStorage when it can be read and written, otherwise an in-memory
 * store for this page (progress is then not kept; the page warns once).
 */
import { MemoryStore, type KeyValueStore } from '../logic/save/keyValueStore';

const PROBE_KEY = 'skyshard.probe';

export interface OpenedStore {
  store: KeyValueStore;
  /** False: the in-memory fallback. */
  persistent: boolean;
}

export function openSaveStore(get: () => Storage | null | undefined = () => globalThis.localStorage): OpenedStore {
  try {
    const ls = get();
    if (ls === null || ls === undefined) throw new Error('no localStorage');
    ls.setItem(PROBE_KEY, '1');
    ls.removeItem(PROBE_KEY);
    return { store: ls, persistent: true };
  } catch {
    return { store: new MemoryStore(), persistent: false };
  }
}
