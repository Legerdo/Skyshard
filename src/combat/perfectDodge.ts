// Perfect_Dodge (design "Energy·Cooldown·Dodge"; Req 24.8, 24.9). A Dodge gives the Active_Character 0.25 s of
// i-frames (the controller's DODGE_IFRAMES; the player receiver is immune while they run). When an enemy hit volume
// overlaps the character during them, the first such overlap of that Dodge is a Perfect_Dodge: 'perfectDodge'
// (characterId, attackerId) and a 0.5 s real-time slow motion at 30% game speed through
// setTimeScale('perfectDodge', 0.3, 0.5). The afterimage VFX and the sound listen to the event; its Energy (+10)
// is granted by the Energy rules (task 6.5). A new Dodge is seen as the i-frame timer rising between two ticks.

import type { TimeScaleSource } from '../core/loop';
import type { GameEventBus } from '../core/gameEvents';
import type { CharacterId, EntityId } from '../data/ids';

/** Game speed and real-time length of the Perfect_Dodge slow motion (Req 24.9). */
export const PERFECT_DODGE_TIME_SCALE = 0.3;
export const PERFECT_DODGE_SECONDS = 0.5;

/** GameLoop.setTimeScale. */
export type SetTimeScale = (source: TimeScaleSource, scale: number, realSeconds: number) => void;

export interface PerfectDodgeOptions {
  bus: GameEventBus;
  /** The Active_Character. */
  character: () => CharacterId;
  /** The loop's time-scale request; omitted (headless) only the event is emitted. */
  setTimeScale?: SetTimeScale;
}

export class PerfectDodge {
  private readonly bus: GameEventBus;
  private readonly character: () => CharacterId;
  private readonly setTimeScale: SetTimeScale | null;
  private lastIFrames = 0;
  private used = false;
  private count = 0;

  constructor(options: PerfectDodgeOptions) {
    this.bus = options.bus;
    this.character = options.character;
    this.setTimeScale = options.setTimeScale ?? null;
  }

  /** Perfect_Dodges so far. */
  get total(): number {
    return this.count;
  }

  /** Once per tick after the controller: the i-frame timer rising means a new Dodge began. */
  observe(iFrames: number): void {
    if (iFrames > this.lastIFrames) this.used = false;
    this.lastIFrames = Number.isFinite(iFrames) ? iFrames : 0;
  }

  /**
   * An enemy hit volume overlapped the character while it was immune. Counts only during i-frames (`iFrames` > 0)
   * and only once per Dodge; returns whether this was the Perfect_Dodge.
   */
  evaded(attackerId: EntityId, iFrames: number): boolean {
    if (!(iFrames > 0) || this.used) return false;
    this.used = true;
    this.count += 1;
    this.bus.emit('perfectDodge', { characterId: this.character(), attackerId });
    this.setTimeScale?.('perfectDodge', PERFECT_DODGE_TIME_SCALE, PERFECT_DODGE_SECONDS);
    return true;
  }
}
