// Debug_Tools gating and the per-tab use flag (design "Debug_Tools" 활성 조건·사용 기록; Req 41.1–41.3).
// - debugEnabled: only `?debug=1` mounts the panel and its shortcuts.
// - The session flag: the first operation leaves `skyshard.debugUsed` in sessionStorage, so a GameState built or
//   loaded later in the same tab (a reload before the next save included) is marked `debugUsed` again.
// Storage access never throws (blocked storage just loses the flag).

export const DEBUG_SESSION_KEY = 'skyshard.debugUsed';

/** Whether the page's query string turns Debug_Tools on (`debug=1` exactly). */
export function debugEnabled(search: string): boolean {
  try {
    return new URLSearchParams(search).get('debug') === '1';
  } catch {
    return false;
  }
}

/** The tab's session flag is set. */
export function debugSessionFlag(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(DEBUG_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

/** The page's sessionStorage, or null where it cannot be used. */
export function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function setDebugSessionFlag(storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(DEBUG_SESSION_KEY, '1');
  } catch {
    // Blocked storage: GameState.debugUsed (saved) still records the use.
  }
}
