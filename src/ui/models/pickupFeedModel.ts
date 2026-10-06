/*
 * The HUD pickup feed's queue (design "적 드롭" 마지막 항목, task 12.7; Req 30.6): every grant ('item:granted', and the
 * Glim of Chest rewards and caches) becomes one line with its name, icon kind and count. A line shows for 3 s, at most
 * 5 lines at once; further lines wait in arrival order until a line frees. Pure: no DOM, real seconds from the caller.
 */

/** A line shows this long (s, fades included). */
export const PICKUP_LINE_SECONDS = 3;
/** Lines visible at once. */
export const PICKUP_MAX_LINES = 5;

export type PickupIconKind = 'glim' | 'weapon' | 'charm' | 'relic' | 'consumable' | 'material';

export interface PickupLineInput {
  readonly name: string;
  readonly icon: PickupIconKind;
  readonly count: number;
}

export interface PickupLine extends PickupLineInput {
  /** Stable key for the view. */
  readonly key: number;
  /** Seconds shown so far. */
  readonly age: number;
}

export class PickupFeedModel {
  private readonly shown: { key: number; input: PickupLineInput; age: number }[] = [];
  private readonly waiting: PickupLineInput[] = [];
  private serial = 0;

  /** Queues a line; a count below 1 or a blank name adds nothing. */
  push(line: PickupLineInput): void {
    if (!(line.count >= 1) || line.name === '') return;
    this.waiting.push(line);
    this.fill();
  }

  /** Advances the shown lines by `dt` real seconds; expired ones leave and waiting ones take their place. */
  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const l of this.shown) l.age += step;
    for (let i = this.shown.length - 1; i >= 0; i--) if ((this.shown[i]?.age ?? 0) >= PICKUP_LINE_SECONDS) this.shown.splice(i, 1);
    this.fill();
  }

  /** The visible lines, oldest first. */
  lines(): PickupLine[] {
    return this.shown.map((l) => ({ ...l.input, key: l.key, age: l.age }));
  }

  /** Lines waiting for a free row. */
  get pending(): number {
    return this.waiting.length;
  }

  private fill(): void {
    while (this.shown.length < PICKUP_MAX_LINES) {
      const next = this.waiting.shift();
      if (next === undefined) return;
      this.serial += 1;
      this.shown.push({ key: this.serial, input: next, age: 0 });
    }
  }
}
