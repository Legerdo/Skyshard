// Placed environment devices (design "환경 수신자", "Puzzle_Mechanism 규칙"; Req 13.1, 13.8, 13.9). Each DeviceReceiver
// gets a hurt volume and joins the party's hit judgement as a HitReceiver marked `device` (no Energy, no damage
// number, no aim assist): a hit carrying an Element calls onElement, a Charged_Attack hit calls onCharged, and the
// result goes to `onSignal` in the PuzzleSignal shape (element null = Charged_Attack break). Each tick the field
// advances its clock, sets the pressure plates from the weights standing on them and detonates primed
// Unstable_Crystals: a 4 m sphere judged with computeDamage kind 'hazard' against the victims (enemies and the
// Active_Character). The puzzle tasks place devices and turn the signals into puzzle progress.

import type { Vec3 } from '../core/types';
import type { ElementId, EntityId } from '../data/ids';
import type { ReceiverKind } from '../data/receivers';
import { UNSTABLE_CRYSTAL } from '../data/receivers';
import type { HitEvent } from '../data/combatTypes';
import { judgeShape, type Attacker, type HitReceiver, type HitResult, type ResolvedHit } from '../combat/attackRuntime';
import type { DeviceReceiver, ReceiverResult } from './receivers';

/** Attack id of the Unstable_Crystal blast. */
export const UNSTABLE_CRYSTAL_ATTACK_ID = 'atk_env_unstable_crystal';
/** A weight counts on a plate from this far below to this far above its top (m). */
const PLATE_BELOW = 0.2;
const PLATE_ABOVE = 0.6;

/** Where a device stands: base centre and hurt capsule. */
export interface DevicePlacement {
  pos: Readonly<Vec3>;
  radius: number;
  height: number;
}

/** A device's answer to one hit (design PuzzleSignal kind 'element'). */
export interface DeviceSignal {
  part: string;
  kind: ReceiverKind;
  /** The hit's Element; null for a Charged_Attack break. */
  element: ElementId | null;
  accepted: boolean;
  state: string;
  changed: boolean;
}

/** Something that presses plates: the Active_Character, a Talus pillar. */
export interface Weight {
  id: string;
  /** Feet / base position. */
  pos: Readonly<Vec3>;
}

export interface ReceiverFieldOptions {
  /** A hit reached a device. */
  onSignal?(signal: DeviceSignal): void;
  /** A pressure plate went down or came up. */
  onPlate?(part: string, change: 'pressed' | 'released'): void;
  /** An Unstable_Crystal exploded at `pos`, landing `hits`. */
  onBlast?(part: string, pos: Readonly<Vec3>, hits: readonly HitResult[]): void;
}

interface Placed {
  device: DeviceReceiver;
  placement: DevicePlacement;
  target: HitReceiver;
}

const BLAST_HIT: HitEvent = {
  t: 0,
  shape: { kind: 'sphere', radius: UNSTABLE_CRYSTAL.radius, offset: { x: 0, y: 0, z: 0 } },
  dmgMul: UNSTABLE_CRYSTAL.dmgMul,
  appliesElement: false,
  poise: UNSTABLE_CRYSTAL.poise,
  knockback: UNSTABLE_CRYSTAL.knockback,
  energy: null,
};

/** A broken-open device no longer takes hits. */
function gone(device: DeviceReceiver, now: number): boolean {
  const s = device.stateAt(now);
  return (device.kind === 'brambleGate' && s === 'burnt') || (device.kind === 'crackedBoulder' && s === 'broken')
    || (device.kind === 'unstableCrystal' && s === 'exploded');
}

export class ReceiverField {
  private readonly o: ReceiverFieldOptions;
  private readonly placed = new Map<string, Placed>();
  private readonly view: Iterable<HitReceiver> = {
    [Symbol.iterator]: () => [...this.placed.values()].map((p) => p.target)[Symbol.iterator](),
  };
  private clock = 0;

  constructor(options: ReceiverFieldOptions = {}) {
    this.o = options;
  }

  /** Sim seconds ticked so far. */
  get time(): number {
    return this.clock;
  }

  /** @throws Error for a duplicate device id. */
  add(device: DeviceReceiver, placement: DevicePlacement): void {
    if (this.placed.has(device.id)) throw new Error(`ReceiverField: duplicate device ${device.id}`);
    const at: DevicePlacement = { pos: { ...placement.pos }, radius: placement.radius, height: placement.height };
    this.placed.set(device.id, { device, placement: at, target: this.targetFor(device, at) });
  }

  remove(id: string): void {
    this.placed.delete(id);
  }

  get(id: string): DeviceReceiver | undefined {
    return this.placed.get(id)?.device;
  }

  /** The devices as hit targets (a live view, iterable any number of times). */
  hitTargets(): Iterable<HitReceiver> {
    return this.view;
  }

  /**
   * Advances the clock by `dt`, sets every pressure plate from `weights` and detonates the Unstable_Crystals whose
   * Telegraph has run against `victims`.
   */
  tick(dt: number, victims: Iterable<HitReceiver>, weights: readonly Weight[] = []): void {
    if (Number.isFinite(dt) && dt > 0) this.clock += dt;
    const now = this.clock;
    const hitList = [...victims];
    for (const { device, placement } of this.placed.values()) {
      if (device.kind === 'pressurePlate') {
        const on = weights.filter((w) => this.onPlate(placement, w.pos)).map((w) => w.id);
        const change = device.setWeights(on);
        if (change !== null) this.o.onPlate?.(device.id, change);
        continue;
      }
      const blast = device.tick(now);
      if (blast === null) continue;
      const center = { x: placement.pos.x, y: placement.pos.y + placement.height / 2, z: placement.pos.z };
      const hits = judgeShape(UNSTABLE_CRYSTAL_ATTACK_ID, 0, BLAST_HIT, this.blastAttacker(device.id, center), hitList, new Set());
      this.o.onBlast?.(device.id, center, hits);
    }
  }

  private onPlate(placement: DevicePlacement, pos: Readonly<Vec3>): boolean {
    const top = placement.pos.y;
    return Math.hypot(pos.x - placement.pos.x, pos.z - placement.pos.z) <= placement.radius
      && pos.y >= top - PLATE_BELOW && pos.y <= top + PLATE_ABOVE;
  }

  private blastAttacker(id: EntityId, center: Vec3): Attacker {
    return {
      id,
      origin: { pos: center, yaw: 0 },
      stats: { baseAtk: UNSTABLE_CRYSTAL.atk, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
      kind: 'hazard',
      element: null,
      elementSource: 'environment',
      roll: () => 0,
    };
  }

  private targetFor(device: DeviceReceiver, placement: DevicePlacement): HitReceiver {
    return {
      id: device.id,
      device: true,
      hurtVolume: () => placement,
      immune: () => gone(device, this.clock),
      sample: () => ({ def: 0, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
      receive: (hit) => this.receive(device, hit),
    };
  }

  /** The hit's Element first; a Charged_Attack breaks a crackedBoulder when its Element did not. */
  private receive(device: DeviceReceiver, hit: ResolvedHit): void {
    const now = this.clock;
    let result: ReceiverResult | null = null;
    let element: ElementId | null = null;
    if (hit.element !== null) {
      result = device.onElement(hit.element, now);
      element = hit.element;
    }
    if (hit.kind === 'charged' && device.def.chargedBreaks && result?.accepted !== true) {
      result = device.onCharged(now);
      element = null;
    }
    if (result === null) return;
    this.o.onSignal?.({ part: device.id, kind: device.kind, element, ...result });
  }
}
