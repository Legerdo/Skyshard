/*
 * SaveScheduler (design "저장 스케줄러", Req 36.3–36.5, 4.8, 5.5, 7.6): decides WHEN to write.
 * - Merge: Milestone requests ('save:request') are written once the last one has been quiet for 0.5 s or 1.5 s after
 *   the first, so a burst is saved within 2 s. Timed in real seconds (menus stop game time, not saving).
 * - Hold: requests arriving In_Combat or during a cinematic wait; when both end they count as arriving then, and the
 *   same rule writes them within 2 s (a new fight in between holds them again).
 * - Periodic: 90 s of gameplay (not In_Combat, cinematic or menu) request 'periodic'; every write restarts the count.
 * `update` runs every render frame after the fixed ticks with the frame's real dt; `write` does the actual write.
 */
import type { SaveReason } from '../core/gameEvents';

export const SAVE_QUIET_SEC = 0.5;
export const SAVE_MAX_WAIT_SEC = 1.5;
export const PERIODIC_SAVE_SEC = 90;

export interface SaveContext {
  inCombat: boolean;
  cinematic: boolean;
  /** A menu / map screen is up (game time stopped): no periodic count. */
  menu?: boolean;
}

export class SaveScheduler {
  private readonly write: (reason: SaveReason) => void;
  private pending: SaveReason[] = [];
  private sinceFirst = 0;
  private sinceLast = 0;
  private periodic = 0;
  private held = false;

  constructor(write: (reason: SaveReason) => void) {
    this.write = write;
  }

  /** Requests waiting to be written. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Seconds of gameplay counted toward the next periodic save. */
  get periodicElapsed(): number {
    return this.periodic;
  }

  request(reason: SaveReason): void {
    if (this.pending.length === 0) this.sinceFirst = 0;
    this.sinceLast = 0;
    this.pending.push(reason);
  }

  /** Drops every waiting request (a failed write: the next Milestone tries again, Req 36.13). */
  clear(): void {
    this.pending = [];
  }

  update(dt: number, ctx: SaveContext): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const hold = ctx.inCombat || ctx.cinematic;
    if (hold) {
      this.held = true;
      return;
    }
    if (this.held) {
      // The fight / cinematic ended: waiting requests count as arriving now.
      this.held = false;
      this.sinceFirst = 0;
      this.sinceLast = 0;
      return;
    }
    if (ctx.menu !== true) {
      this.periodic += step;
      if (this.periodic >= PERIODIC_SAVE_SEC) {
        this.periodic = 0;
        this.request('periodic');
      }
    }
    if (this.pending.length === 0) return;
    this.sinceFirst += step;
    this.sinceLast += step;
    if (this.sinceLast >= SAVE_QUIET_SEC - 1e-9 || this.sinceFirst >= SAVE_MAX_WAIT_SEC - 1e-9) this.flush();
  }

  /** Writes now whatever is waiting (and any `reason`), ignoring the timers. */
  flush(reason?: SaveReason): void {
    if (reason !== undefined) this.pending.push(reason);
    if (this.pending.length === 0) return;
    const chosen = this.pending.find((r) => r !== 'periodic') ?? this.pending[0];
    this.pending = [];
    this.sinceFirst = 0;
    this.sinceLast = 0;
    this.periodic = 0;
    this.write(chosen);
  }
}
