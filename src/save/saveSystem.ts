/*
 * Save_System (design "저장 스케줄러", "Continue와 New Game", Req 36.3–36.8, 36.13): one per page, attached to the
 * running session. It hears 'save:request', lets the SaveScheduler pick the moment, and writes:
 *   1. the session records its Safe_Position (Challenge_Area: the latest checkpoint) and play time into GameState;
 *   2. the current main save is copied to the backup key only if it passes the load checks (Req 36.7);
 *   3. serializeSave(GameState) goes to the main key; 'save:done' (bytes) follows on the bus, or 'save:failed' when
 *      the store throws (QuotaExceededError, SecurityError): the waiting requests are dropped and play goes on.
 * The result events are emitted after the fixed ticks, so they reach the HUD in the next tick's EventDispatch.
 * New Game moves an existing main save to the backup key (the settings key is never touched).
 */
import type { GameEventBus, SaveReason } from '../core/gameEvents';
import { serializeSave } from '../logic/save/envelope';
import type { GameState } from '../logic/save/gameState';
import type { KeyValueStore } from '../logic/save/keyValueStore';
import { passesLoadChecks } from '../logic/save/load';
import { SAVE_KEYS } from '../logic/save/saveKeys';
import { SaveScheduler, type SaveContext } from './saveScheduler';

/** What a session gives the Save_System. */
export interface SaveTarget {
  readonly bus: GameEventBus;
  readonly gameState: GameState;
  /** Writes the Safe_Position the next Continue starts from into GameState.lastSafe. */
  recordPosition(): void;
  /** Play time (s) so far. */
  playTimeSec(): number;
}

export class SaveSystem {
  readonly scheduler: SaveScheduler;
  private readonly store: KeyValueStore;
  private target: SaveTarget | null = null;
  private off: (() => void) | null = null;

  constructor(store: KeyValueStore) {
    this.store = store;
    this.scheduler = new SaveScheduler((reason) => this.write(reason));
  }

  /** Starts saving `target` (a begun or continued session); a previous target is detached. */
  attach(target: SaveTarget): void {
    this.detach();
    this.target = target;
    this.off = target.bus.on('save:request', (p) => this.scheduler.request(p.reason));
  }

  detach(): void {
    this.off?.();
    this.off = null;
    this.target = null;
    this.scheduler.clear();
  }

  /** Every render frame after the ticks, with real seconds. */
  update(realDt: number, ctx: SaveContext): void {
    if (this.target !== null) this.scheduler.update(realDt, ctx);
  }

  /** New Game: the existing main save becomes the backup, the main key is cleared (Req 31.4). */
  archiveForNewGame(): void {
    try {
      const main = this.store.getItem(SAVE_KEYS.main);
      if (main !== null && main !== '') {
        this.store.setItem(SAVE_KEYS.backup, main);
        this.store.removeItem(SAVE_KEYS.main);
      }
    } catch {
      // storage refused: the new game overwrites the main key at its first save
    }
  }

  /** Writes at once (the New Game start, manual saves); returns whether it succeeded. */
  saveNow(reason: SaveReason): boolean {
    if (this.target === null) return false;
    return this.write(reason);
  }

  private write(reason: SaveReason): boolean {
    const target = this.target;
    if (target === null) return false;
    try {
      target.recordPosition();
      const playTime = target.playTimeSec();
      target.gameState.stats.playTimeSec = Number.isFinite(playTime) && playTime > 0 ? playTime : 0;
      const current = this.store.getItem(SAVE_KEYS.main);
      if (current !== null && passesLoadChecks(current)) this.store.setItem(SAVE_KEYS.backup, current);
      const text = serializeSave(target.gameState, target.gameState.stats.playTimeSec);
      this.store.setItem(SAVE_KEYS.main, text);
      target.bus.emit('save:done', { reason, bytes: text.length });
      return true;
    } catch (err) {
      this.scheduler.clear();
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      target.bus.emit('save:failed', { reason, error });
      return false;
    }
  }
}
