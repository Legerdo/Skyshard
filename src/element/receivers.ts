// Environment Element receivers (design "환경 수신자", Req 13.1, 13.8, 13.9). A device takes the party's hits through
// the same judgement as enemies (ReceiverField.hitTargets) but, instead of holding a mark, changes its own state:
// - brambleGate (Ember → burnt, the way opens) · brazier (Ember → lit) · fireObstacle (Tide → extinguished, passable)
// - windWheel (Gale → spinning, drives what it is linked to) · crackedBoulder (Terra or a Charged_Attack → broken)
// - heatCrystal (Tide → cooled for 10 s: no contact damage and a climbable surface; Tide again restarts the 10 s)
// - pressurePlate (no Element: down while a weight — the character or Talus's pillar — stands on it)
// - unstableCrystal (Ember → primed: a 1 s Telegraph, then a 4 m blast hitting enemies and the Player_Character)
// - elementPedestal (any Element → lit: the Starfall Observatory's star pedestals; their sequence puzzle judges which)
// An Element outside `accepts` is ignored with accepted false (the puzzle counts it as a failure, Req 13.7).
// Positions and hit volumes live in the ReceiverField; placement in the world is done by the puzzle tasks.

import type { ElementId } from '../data/ids';
import {
  HEAT_CRYSTAL_COOL_SECONDS, RECEIVER_DEFS, UNSTABLE_CRYSTAL, type ReceiverDef, type ReceiverKind,
} from '../data/receivers';

export interface ReceiverResult {
  /** The Element is one the device takes (in `accepts`); false inputs change nothing. */
  accepted: boolean;
  /** State after the input. */
  state: string;
  /** The input changed the state (the device plays its glow / spin / opening and sound, Req 13.3). */
  changed: boolean;
}

/** design `ElementReceiver`. */
export interface ElementReceiver {
  readonly id: string;
  readonly accepts: readonly ElementId[];
  onElement(el: ElementId, now: number): ReceiverResult;
}

/** An Unstable_Crystal detonation. */
export interface DeviceBlast {
  readonly deviceId: string;
  readonly radius: number;
}

/** One environment device of any ReceiverKind. */
export class DeviceReceiver implements ElementReceiver {
  readonly id: string;
  readonly kind: ReceiverKind;
  readonly def: ReceiverDef;
  private current: string;
  /** heatCrystal: cooled while now < until · unstableCrystal: detonates at until. */
  private until = Number.NEGATIVE_INFINITY;
  private readonly weights = new Set<string>();

  constructor(id: string, kind: ReceiverKind) {
    this.id = id;
    this.kind = kind;
    this.def = RECEIVER_DEFS[kind];
    this.current = this.def.initial;
  }

  get accepts(): readonly ElementId[] {
    return this.def.accepts;
  }

  /** The Element icon on its surface (Req 13.2); null for a pressure plate. */
  get icon(): ElementId | null {
    return this.def.accepts[0] ?? null;
  }

  /** State at `now` (the Heat_Crystal warms up again 10 s after its last Tide). */
  stateAt(now: number): string {
    if (this.kind === 'heatCrystal') return now < this.until ? 'cooled' : 'hot';
    return this.current;
  }

  onElement(el: ElementId, now: number): ReceiverResult {
    const before = this.stateAt(now);
    if (!this.def.accepts.includes(el)) return { accepted: false, state: before, changed: false };
    switch (this.kind) {
      case 'heatCrystal':
        // Restarts the 10 s; a settled crystal stays cooled.
        this.until = Math.max(this.until, now + HEAT_CRYSTAL_COOL_SECONDS);
        break;
      case 'unstableCrystal':
        if (this.current === 'stable') {
          this.current = 'primed';
          this.until = now + UNSTABLE_CRYSTAL.telegraph;
        }
        break;
      default:
        this.current = this.def.done;
    }
    const state = this.stateAt(now);
    return { accepted: true, state, changed: state !== before };
  }

  /** A Charged_Attack hit: breaks a crackedBoulder the same way Terra does; every other device ignores it. */
  onCharged(now: number): ReceiverResult {
    const before = this.stateAt(now);
    if (!this.def.chargedBreaks) return { accepted: false, state: before, changed: false };
    this.current = this.def.done;
    return { accepted: true, state: this.current, changed: this.current !== before };
  }

  /**
   * pressurePlate: the weights (ids of the character and Talus pillars) standing on it now. Returns 'pressed' when
   * it goes down, 'released' when the last weight leaves, else null. Other devices: always null.
   */
  setWeights(ids: Iterable<string>): 'pressed' | 'released' | null {
    if (this.kind !== 'pressurePlate') return null;
    this.weights.clear();
    for (const id of ids) this.weights.add(id);
    const next = this.weights.size > 0 ? 'down' : 'up';
    if (next === this.current) return null;
    this.current = next;
    return next === 'down' ? 'pressed' : 'released';
  }

  /** Back to the state before any input: a failed sequence puzzle puts its parts back (Req 13.5). */
  reset(): void {
    this.current = this.def.initial;
    this.until = Number.NEGATIVE_INFINITY;
  }

  /**
   * Fixes the device in its done state for a solved puzzle (and every part of one solved in a loaded save): a
   * Heat_Crystal stays cooled, a stable Unstable_Crystal is gone without a blast while a primed one still explodes
   * when its Telegraph runs out, a pressure plate keeps following its weights, the rest take their done state.
   */
  settle(): void {
    switch (this.kind) {
      case 'heatCrystal':
        this.until = Number.POSITIVE_INFINITY;
        break;
      case 'unstableCrystal':
        if (this.current === 'stable') this.current = 'exploded';
        break;
      case 'pressurePlate':
        break;
      default:
        this.current = this.def.done;
    }
  }

  /** Seconds a Heat_Crystal stays cooled from `now` (Infinity once settled by a solved puzzle), else 0. */
  cooledLeft(now: number): number {
    return this.kind === 'heatCrystal' && now < this.until ? this.until - now : 0;
  }

  /** Seconds left of an Unstable_Crystal's 1 s Telegraph, else 0. */
  telegraphLeft(now: number): number {
    return this.kind === 'unstableCrystal' && this.current === 'primed' ? Math.max(0, this.until - now) : 0;
  }

  /** unstableCrystal: the blast once its Telegraph has run (then 'exploded'); otherwise null. */
  tick(now: number): DeviceBlast | null {
    if (this.kind !== 'unstableCrystal' || this.current !== 'primed' || now < this.until - 1e-9) return null;
    this.current = 'exploded';
    return { deviceId: this.id, radius: UNSTABLE_CRYSTAL.radius };
  }

  /** It blocks the way: an intact brambleGate or crackedBoulder, a burning fireObstacle, a stable crystal wall. */
  blocking(now: number): boolean {
    const s = this.stateAt(now);
    switch (this.kind) {
      case 'brambleGate':
      case 'crackedBoulder':
        return s === 'intact';
      case 'fireObstacle':
        return s === 'burning';
      case 'unstableCrystal':
        return s !== 'exploded';
      default:
        return false;
    }
  }

  /** It hurts on contact: a hot Heat_Crystal or a burning obstacle (Req 13.8). */
  contactDamage(now: number): boolean {
    const s = this.stateAt(now);
    return (this.kind === 'heatCrystal' && s === 'hot') || (this.kind === 'fireObstacle' && s === 'burning');
  }

  /** Its surface can be climbed: a cooled Heat_Crystal only (Req 13.8). */
  climbable(now: number): boolean {
    return this.kind === 'heatCrystal' && this.stateAt(now) === 'cooled';
  }
}
