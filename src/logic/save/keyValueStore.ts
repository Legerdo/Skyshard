/*
 * The part of the Web Storage API the save code uses (design "인터페이스"): the browser passes `window.localStorage`,
 * tests and the no-storage fallback pass a MemoryStore. Pure: no browser globals here.
 */

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** In-memory KeyValueStore: insertion-ordered keys, string values, like localStorage without persistence. */
export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  getItem(key: string): string | null {
    return this.data.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.data.delete(String(key));
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  /** Every key, in insertion order (tests). */
  keys(): string[] {
    return [...this.data.keys()];
  }
}

/** Every key of `store` (tolerates stores that throw: those keys are skipped). */
export function storeKeys(store: KeyValueStore): string[] {
  const out: string[] = [];
  let n = 0;
  try {
    n = store.length;
  } catch {
    return out;
  }
  for (let i = 0; i < n; i++) {
    try {
      const k = store.key(i);
      if (k !== null) out.push(k);
    } catch {
      // skip
    }
  }
  return out;
}
