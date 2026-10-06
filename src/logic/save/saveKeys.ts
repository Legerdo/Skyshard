/*
 * Storage keys (design.md "저장 키와 형식") and the read-only save-presence check the Title Screen uses for
 * Continue (Req 31.3). The store is injected, so this stays free of browser globals. Reading, repairing and
 * writing saves (`loadSave`, `serializeSave`, SaveScheduler) arrive with tasks 15.1 and 15.6; until then this
 * only answers "is there a main save?", which is exactly when `loadSave` would not return `none`.
 */

export const SAVE_KEYS = {
  /** Main save: one `SaveEnvelope` as JSON. */
  main: 'skyshard.save',
  /** The last main save that passed the load checks, copied before each write. */
  backup: 'skyshard.save.bak',
  /** Prefix of the quarantine keys (`skyshard.save.corrupt.<epochMs>`). */
  corruptPrefix: 'skyshard.save.corrupt.',
  /** Settings live apart from progress. */
  settings: 'skyshard.settings',
} as const;

/** The part of the Web Storage API the presence check reads. */
export interface SaveProbe {
  getItem(key: string): string | null;
}

/**
 * True when the main save key holds data. A missing store (localStorage unavailable) or a store that throws
 * counts as no save data, so Continue stays disabled rather than breaking the Title Screen.
 */
export function hasSaveData(store: SaveProbe | null): boolean {
  if (store === null) return false;
  try {
    const raw = store.getItem(SAVE_KEYS.main);
    return raw !== null && raw !== '';
  } catch {
    return false;
  }
}
