// Heat_Crystal walls as colliders (Req 13.8, 18.1; design "등반" → 등반 불가 재질). The collider's `climbable`
// flag follows the device state, so a hot crystal is left out of every climbing query (the 'climb' mask) and
// only blocks, while a Tide-cooled one is climbable for its 10 s; a hot one also carries the 'heat' hazard.
// The Challenge_Area task places the walls (Cinderspire H1) and calls sync once per tick. Pure TypeScript.

import type { Collider, ColliderFlags, ColliderShape, CollisionWorld } from '../physics/types';

/** The device view a Heat_Crystal wall reads (a heatCrystal DeviceReceiver satisfies it). */
export interface HeatCrystalState {
  climbable(now: number): boolean;
  contactDamage(now: number): boolean;
}

/** Collider flags of a Heat_Crystal wall at `now`: climbable only while cooled, the heat hazard only while hot. */
export function heatCrystalFlags(device: HeatCrystalState, now: number, walkableTop = false): ColliderFlags {
  const flags: ColliderFlags = { climbable: device.climbable(now), walkableTop, blocksCamera: true, material: 'crystal' };
  if (device.contactDamage(now)) flags.hazard = 'heat';
  return flags;
}

/** One Heat_Crystal wall kept in the collision world as a dynamic collider whose flags track its device. */
export class HeatCrystalWall {
  private synced: string | null = null;

  constructor(
    private readonly world: Pick<CollisionWorld, 'upsertDynamic' | 'removeDynamic'>,
    readonly id: number,
    private readonly shape: ColliderShape,
    private readonly device: HeatCrystalState,
    private readonly walkableTop = false,
  ) {}

  /** Writes the collider when its climbable / hazard state changed since the last sync; returns whether it did. */
  sync(now: number): boolean {
    const flags = heatCrystalFlags(this.device, now, this.walkableTop);
    const key = `${flags.climbable}|${flags.hazard ?? ''}`;
    if (key === this.synced) return false;
    const collider = { ...this.shape, id: this.id, flags } as Collider; // the world keeps its own copy
    if (!this.world.upsertDynamic(collider)) return false;
    this.synced = key;
    return true;
  }

  /** Takes the wall out of the world (a later sync puts it back). */
  remove(): void {
    this.world.removeDynamic(this.id);
    this.synced = null;
  }
}
