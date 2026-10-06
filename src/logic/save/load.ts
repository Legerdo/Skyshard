/*
 * Load pipeline (design "불러오기 파이프라인", Req 36.10–36.12): main save → backup → quarantine. Every step of reading
 * one stored document (JSON.parse → envelope and format → checksum → version / migration → sanitizeGameState →
 * validateGameState) is guarded, so `loadSave` never throws and always returns one of the three LoadResults.
 * - No main key: `none` (Continue disabled).
 * - Main readable: `ok` from `main` (with the repairs sanitize made).
 * - Main unreadable, backup readable: `ok` from `backup` (the HUD says "백업에서 복구했습니다").
 * - Both unreadable: the main document is copied to `skyshard.save.corrupt.<epochMs>` (at most 3 kept, oldest removed
 *   first), the main key is cleared (the copy keeps the data, so the next New Game needs no overwrite prompt), and
 *   `unrecoverable` is returned.
 * Pure: the store and the clock are injected.
 */
import { stateChecksum, SAVE_FORMAT } from './envelope';
import { SAVE_VERSION, type GameState } from './gameState';
import { storeKeys, type KeyValueStore } from './keyValueStore';
import { migrate, MIGRATIONS, type Migration } from './migrate';
import { isPlainObject, sanitizeGameState } from './sanitize';
import { SAVE_KEYS } from './saveKeys';
import { validateGameState } from './validate';

export type LoadResult =
  | { kind: 'ok'; state: GameState; source: 'main' | 'backup'; repairs: string[] }
  | { kind: 'none' }
  | { kind: 'unrecoverable'; quarantinedKey: string };

export type ReadResult = { ok: true; state: GameState; repairs: string[] } | { ok: false; error: string };

/** Quarantine copies kept (Req 36.10). */
export const MAX_QUARANTINE = 3;

export interface ReadOptions {
  /** Migration table / target (tests); default the real ones. */
  migrations?: Readonly<Record<number, Migration>>;
  version?: number;
}

/** Reads one stored document through every check; never throws. */
export function readSaveDocument(raw: string, options: ReadOptions = {}): ReadResult {
  const fail = (error: string): ReadResult => ({ ok: false, error });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('not JSON');
  }
  try {
    if (!isPlainObject(parsed)) return fail('not an envelope');
    if (parsed.format !== SAVE_FORMAT) return fail('unknown format');
    if (typeof parsed.checksum !== 'string') return fail('no checksum');
    if (!isPlainObject(parsed.state)) return fail('no state');
    if (stateChecksum(parsed.state) !== parsed.checksum) return fail('checksum mismatch');
    const target = options.version ?? SAVE_VERSION;
    const version = parsed.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > target) return fail(`unsupported version ${String(version)}`);
    const current = version < target ? migrate(parsed.state, version, options.migrations ?? MIGRATIONS, target) : parsed.state;
    const { state, repairs } = sanitizeGameState(current);
    const problems = validateGameState(state);
    if (problems.length > 0) return fail(`invalid after repair: ${problems[0]}`);
    return { ok: true, state, repairs };
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'read failed');
  }
}

/** Whether a stored document passes the load checks (the SaveScheduler backs up only such a main save, Req 36.7). */
export function passesLoadChecks(raw: string | null): boolean {
  return raw !== null && raw !== '' && readSaveDocument(raw).ok;
}

const safeGet = (store: KeyValueStore, key: string): string | null => {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
};

export interface LoadOptions extends ReadOptions {
  /** Epoch ms for the quarantine key; default Date.now. */
  now?: () => number;
  /** Receives the repairs of a successful load as one message (the design's single console.warn). */
  warn?: (message: string) => void;
}

export function loadSave(store: KeyValueStore, options: LoadOptions = {}): LoadResult {
  try {
    const main = safeGet(store, SAVE_KEYS.main);
    if (main === null || main === '') return { kind: 'none' };
    const report = (state: GameState, repairs: string[], source: 'main' | 'backup'): LoadResult => {
      if (repairs.length > 0) options.warn?.(`save repaired (${source}): ${repairs.join('; ')}`);
      return { kind: 'ok', state, source, repairs };
    };
    const first = readSaveDocument(main, options);
    if (first.ok) return report(first.state, first.repairs, 'main');
    const backup = safeGet(store, SAVE_KEYS.backup);
    if (backup !== null && backup !== '') {
      const second = readSaveDocument(backup, options);
      if (second.ok) return report(second.state, second.repairs, 'backup');
    }
    return { kind: 'unrecoverable', quarantinedKey: quarantine(store, main, options.now ?? Date.now) };
  } catch {
    return { kind: 'unrecoverable', quarantinedKey: '' };
  }
}

/** Copies `raw` to a new quarantine key, prunes to MAX_QUARANTINE and clears the main key; returns the new key. */
function quarantine(store: KeyValueStore, raw: string, now: () => number): string {
  let stamp = Math.floor(now());
  const existing = new Set(storeKeys(store));
  while (existing.has(`${SAVE_KEYS.corruptPrefix}${stamp}`)) stamp++;
  const key = `${SAVE_KEYS.corruptPrefix}${stamp}`;
  try {
    store.setItem(key, raw);
  } catch {
    return '';
  }
  const copies = storeKeys(store)
    .filter((k) => k.startsWith(SAVE_KEYS.corruptPrefix))
    .map((k) => ({ k, t: Number(k.slice(SAVE_KEYS.corruptPrefix.length)) }))
    .sort((a, b) => (Number.isFinite(a.t) ? a.t : -Infinity) - (Number.isFinite(b.t) ? b.t : -Infinity));
  while (copies.length > MAX_QUARANTINE) {
    const oldest = copies.shift();
    try {
      if (oldest !== undefined) store.removeItem(oldest.k);
    } catch {
      break;
    }
  }
  try {
    store.removeItem(SAVE_KEYS.main);
  } catch {
    // the copy exists; a failing remove only means the next Continue quarantines again
  }
  return key;
}
