/*
 * Playthrough bot, observation side (task 24.4; design "입력 전용 완주 봇" harness.ts, Req 42.2, 42.3): reads the
 * read-only Test_Harness (window.__SKYSHARD_HARNESS__) and nothing else. Every poll is one page.evaluate that returns
 * snapshot() and events(sinceSeq) together, at least POLL_MS apart (≤ 20 Hz); the events since the last seq are
 * accumulated here (the page keeps only a 512-entry ring). Nothing on the page is written or called besides those two
 * readers.
 */
import type { Page } from '@playwright/test';
import type { HarnessEvent } from '../../../src/harness/harness';
import type { HarnessSnapshot } from '../../../src/harness/snapshot';

export type Snap = HarnessSnapshot;
export type BotEvent = HarnessEvent;
export type SnapEnemy = Snap['enemies'][number];
export type SnapBoss = NonNullable<Snap['boss']>;

/** Minimum spacing of two harness reads (ms): 20 Hz at most (design harness.ts). */
export const POLL_MS = 50;

type Observer = (s: Snap, fresh: readonly BotEvent[]) => void;

interface HarnessWindow {
  __SKYSHARD_HARNESS__?: { readonly version: number; snapshot(): unknown; events(sinceSeq: number): readonly unknown[] };
}

export class Harness {
  /** Every event read so far, oldest first. */
  readonly events: BotEvent[] = [];
  /** The latest snapshot (null before the first poll). */
  last: Snap | null = null;
  /** Polls made. */
  polls = 0;
  /** Time between the last two reads and the last read's duration (ms), for traces. */
  gapMs = 0;
  readMs = 0;
  private seq = 0;
  private lastAt = -Infinity;
  private prevAt = 0;
  private readonly observers: Observer[] = [];

  constructor(private readonly page: Page) {}

  /** Calls `fn` after every poll with the snapshot and the events new since the previous poll. */
  onPoll(fn: Observer): void {
    this.observers.push(fn);
  }

  /** Waits until the harness is installed and checks its schema version (design: `version === 1`). */
  async ready(timeoutMs = 60_000): Promise<void> {
    await this.page.waitForFunction(() => (window as unknown as HarnessWindow).__SKYSHARD_HARNESS__ !== undefined, undefined, { timeout: timeoutMs });
    const version = await this.page.evaluate(() => (window as unknown as HarnessWindow).__SKYSHARD_HARNESS__?.version ?? null);
    if (version !== 1) throw new Error(`Test_Harness version ${String(version)} (expected 1)`);
  }

  /** One read: waits out the POLL_MS spacing, then snapshot() and events(seq) in a single evaluate. */
  async poll(): Promise<Snap> {
    const wait = this.lastAt + POLL_MS - Date.now();
    if (wait > 0) await this.page.waitForTimeout(wait);
    this.lastAt = Date.now();
    this.gapMs = this.lastAt - this.prevAt;
    this.prevAt = this.lastAt;
    const { snap, fresh } = await this.page.evaluate((since) => {
      const h = (window as unknown as HarnessWindow).__SKYSHARD_HARNESS__;
      if (h === undefined) throw new Error('Test_Harness not installed');
      return { snap: h.snapshot(), fresh: h.events(since) };
    }, this.seq) as { snap: Snap; fresh: BotEvent[] };
    this.polls++;
    this.readMs = Date.now() - this.lastAt;
    for (const e of fresh) {
      if (e.seq > this.seq) this.seq = e.seq;
      this.events.push(e);
    }
    this.last = snap;
    for (const fn of this.observers) fn(snap, fresh);
    return snap;
  }
}

// ── Snapshot helpers ────────────────────────────────────────────────────────

export interface XZ {
  readonly x: number;
  readonly z: number;
}

export const flat = (a: XZ, b: XZ): number => Math.hypot(b.x - a.x, b.z - a.z);

/** Play is on screen and takes input: the gameplay screen on top, no dialogue, cinematic or recovery fade. */
export function free(s: Snap): boolean {
  return s.screen === 'gameplay' && s.inputContext === 'gameplay' && s.dialogue === null && s.cinematic === null && !s.recovery.active;
}

/** Enemy states that mean it is fighting the party (tests/unit/helpers/routeBot.ts ENGAGED). */
export const ENGAGED_STATES: ReadonlySet<string> = new Set(['alert', 'chase', 'attack', 'recovery', 'stagger']);

/** The nearest enemy engaging the party within `range` m (and 6 m of height), else null. */
export function engagedNear(s: Snap, range: number): SnapEnemy | null {
  let best: SnapEnemy | null = null;
  for (const e of s.enemies) {
    if (!ENGAGED_STATES.has(e.state) || Math.abs(e.pos.y - s.player.pos.y) > 6) continue;
    const d = flat(s.player.pos, e.pos);
    if (d <= range && (best === null || d < flat(s.player.pos, best.pos))) best = e;
  }
  return best;
}

export const isClimbMode = (mode: string): boolean => mode.startsWith('climb') || mode === 'mantle';
export const isGlideMode = (mode: string): boolean => mode === 'glide' || mode === 'glideDeploy';

/** The Active_Character's party entry. */
export function activeMember(s: Snap): Snap['party'][number] | undefined {
  return s.party.find((p) => p.active);
}
