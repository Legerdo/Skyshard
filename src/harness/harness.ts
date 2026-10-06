// Test_Harness (design "Test_Harness", Req 42.2): the read-only window E2E bots observe the game through. It is
// installed in every build as `window.__SKYSHARD_HARNESS__` and never changes the game (it is not a Debug_Tool and
// does not touch GameState.debugUsed).
//
// - The harness object has no prototype (Object.create(null)) and exactly three frozen data properties: `version`,
//   `snapshot()` and `events(sinceSeq)`; no setters, no state-changing methods, no internal references.
// - snapshot() reads the state of the last finished tick when called (JS is single-threaded, so a page.evaluate
//   always lands between frames), structuredClones it and freezes the copy recursively: editing it reaches nothing.
// - events(sinceSeq) returns, as a frozen array, the log entries with `seq` > sinceSeq from a 512-entry ring buffer:
//   'reaction', 'phase' (boss:phaseChanged), 'cinematic' (started / ended), 'objective' (objective / stage
//   completed), 'skyshard', 'screen' (a screen opened / closed on the ScreenManager) and 'wipe' (party:wipe).
// Plain TypeScript; the page supplies the snapshot reader (./snapshot) and installs the object (installHarness).

import type { GameEventBus } from '../core/gameEvents';
import type { HarnessSnapshot } from './snapshot';

export const HARNESS_VERSION = 1;
/** Event log capacity (entries). */
export const HARNESS_EVENT_CAPACITY = 512;
/** `recentReactions` keeps this many. */
export const HARNESS_RECENT_REACTIONS = 32;
/** The global the harness is installed as. */
export const HARNESS_GLOBAL = '__SKYSHARD_HARNESS__';

export type HarnessEventKind = 'reaction' | 'phase' | 'cinematic' | 'objective' | 'skyshard' | 'screen' | 'wipe';

export interface HarnessEvent {
  readonly seq: number;
  /** Simulation time (s) of the tick the event happened in. */
  readonly t: number;
  readonly kind: HarnessEventKind;
  /** A copy of the event payload (plus `event`, the bus event name, where one kind covers several). */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RecentReaction {
  readonly reaction: string;
  readonly t: number;
  readonly chainDepth: number;
}

export interface SkyshardHarness {
  readonly version: typeof HARNESS_VERSION;
  snapshot(): HarnessSnapshot;
  events(sinceSeq: number): readonly HarnessEvent[];
}

/** Freezes `value` and everything reachable from it; returns it. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  return value;
}

/** A structuredClone that also works where the global is missing (plain JSON data only). */
function cloneData<T>(value: T): T {
  return typeof structuredClone === 'function' ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T);
}

/** The event ring: `seq` grows by 1 per entry for the page's life; the oldest entries drop past the capacity. */
export class HarnessEventLog {
  private readonly capacity: number;
  private readonly ring: HarnessEvent[] = [];
  private readonly reactions: RecentReaction[] = [];
  private seq = 0;

  constructor(capacity = HARNESS_EVENT_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** `seq` of the newest entry (0 before the first). */
  get lastSeq(): number {
    return this.seq;
  }

  record(kind: HarnessEventKind, t: number, data: Readonly<Record<string, unknown>>): void {
    this.seq += 1;
    const entry: HarnessEvent = deepFreeze({ seq: this.seq, t: Number.isFinite(t) ? t : 0, kind, data: cloneData({ ...data }) });
    this.ring.push(entry);
    if (this.ring.length > this.capacity) this.ring.shift();
    if (kind === 'reaction') {
      this.reactions.push({ reaction: String(data['reaction']), t: entry.t, chainDepth: Number(data['chainDepth'] ?? 0) });
      if (this.reactions.length > HARNESS_RECENT_REACTIONS) this.reactions.shift();
    }
  }

  /** Entries with `seq` > `sinceSeq`, oldest first, as a frozen array. */
  since(sinceSeq: number): readonly HarnessEvent[] {
    const from = Number.isFinite(sinceSeq) ? sinceSeq : 0;
    return Object.freeze(this.ring.filter((e) => e.seq > from));
  }

  /** The last 32 Reactions (copies). */
  recentReactions(): RecentReaction[] {
    return this.reactions.map((r) => ({ ...r }));
  }

  /**
   * Subscribes to a session's bus (the screens are recorded by the page from the ScreenManager, since no tick runs
   * under a menu). `now` is the simulation time. Returns the unsubscribe.
   */
  attach(bus: Pick<GameEventBus, 'on'>, now: () => number): () => void {
    const offs = [
      bus.on('reaction', (p) => this.record('reaction', now(), { reaction: p.reaction, targetId: p.targetId, chainDepth: p.chainDepth, position: { ...p.position } })),
      bus.on('boss:phaseChanged', (p) => this.record('phase', now(), { ...p })),
      bus.on('cinematic:started', (p) => this.record('cinematic', now(), { event: 'started', cinematicId: p.cinematicId, skippableAfter: Number.isFinite(p.skippableAfter) ? p.skippableAfter : null })),
      bus.on('cinematic:ended', (p) => this.record('cinematic', now(), { event: 'ended', ...p })),
      bus.on('quest:objectiveCompleted', (p) => this.record('objective', now(), { event: 'objectiveCompleted', ...p })),
      bus.on('quest:stageCompleted', (p) => this.record('objective', now(), { event: 'stageCompleted', ...p })),
      bus.on('skyshard:acquired', (p) => this.record('skyshard', now(), { ...p })),
      bus.on('party:wipe', (p) => this.record('wipe', now(), { ...p })),
    ];
    return () => {
      for (const off of offs) off();
    };
  }
}

/**
 * The harness object: `read` builds this moment's snapshot data (plain JSON-safe values), `log` answers events().
 */
export function createHarness(read: () => HarnessSnapshot, log: HarnessEventLog): SkyshardHarness {
  const harness = Object.create(null) as Record<string, unknown>;
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(harness, key, { value, writable: false, enumerable: true, configurable: false });
  };
  define('version', HARNESS_VERSION);
  define('snapshot', function snapshot(): HarnessSnapshot {
    return deepFreeze(cloneData(read()));
  });
  define('events', function events(sinceSeq: number): readonly HarnessEvent[] {
    return log.since(sinceSeq);
  });
  return Object.freeze(harness) as unknown as SkyshardHarness;
}

/** Installs `harness` on `target` (the window) as a non-writable, non-configurable property; once per page. */
export function installHarness(target: object, harness: SkyshardHarness): void {
  if (Object.prototype.hasOwnProperty.call(target, HARNESS_GLOBAL)) return;
  Object.defineProperty(target, HARNESS_GLOBAL, { value: harness, writable: false, enumerable: false, configurable: false });
}
