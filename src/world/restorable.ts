// RestorableObject registry (design "Safe_Position과 복구"; Req 2.5). Objects the main path needs
// (Puzzle_Mechanism parts, movable crystals, moving platforms, quest items, quest NPC anchors) register
// their home transform and a restore callback. An object that is out of the world (worldBounds: below the
// terrain or past 490 m) or that its owner reports invalid for RESTORE_AFTER_INVALID seconds in a row is
// put back at home in its initial state on that tick, well inside the RESTORE_DEADLINE the requirement
// allows. Ticked once per sim tick after CollisionResolve. Pure TypeScript: no three.js / DOM.
//
// The design sketches this as RecoverySystem.registerRestorable(id, home, isValid). It lives in src/world
// so puzzle and quest owners do not depend on the player module; restoring the object's own state stays
// with its owner (the restore callback), since only the owner knows what "initial state" means for it.

import { copyV3, isFiniteNum } from '../core/math';
import type { Vec3 } from '../core/types';
import type { Heightfield } from '../physics/types';
import { outOfWorldReason } from './worldBounds';

/** An invalid state lasting this long triggers the restore (s). */
export const RESTORE_AFTER_INVALID = 1;

/** Req 2.5: an object that left the world or broke is back home within this long (s). */
export const RESTORE_DEADLINE = 5;

/** Timers within this of their limit have reached it (float slack for summed ticks). */
const TIME_EPS = 1e-9;

/** Placement of an object: feet or base position and facing (rad, core/math yaw). */
export interface Transform {
  pos: Vec3;
  yaw: number;
}

export interface RestorableObject {
  /** Placement id; registering the same id again replaces the entry. */
  readonly id: string;
  /** Where the object belongs; copied at registration. */
  readonly home: Readonly<Transform>;
  /** Current feet or base position, read every tick for the out-of-world test. */
  position(): Readonly<Vec3>;
  /** Abnormal states only the owner can see (stuck in a wall, lost its carrier, ...). Omitted: always valid. */
  isValid?(): boolean;
  /** Puts the object back at `home` in its initial state. */
  restore(home: Readonly<Transform>): void;
}

interface Entry {
  readonly object: RestorableObject;
  readonly home: Transform;
  /** Seconds the object has been invalid without a break. */
  invalidTime: number;
}

export class RestorableRegistry {
  private readonly terrain: Pick<Heightfield, 'heightAt'>;
  private readonly entries = new Map<string, Entry>();

  constructor(terrain: Pick<Heightfield, 'heightAt'>) {
    this.terrain = terrain;
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Starts watching `object` (replacing an entry with the same id, whose invalid timer is dropped). */
  register(object: RestorableObject): void {
    const home: Transform = { pos: copyV3(object.home.pos), yaw: object.home.yaw };
    this.entries.set(object.id, { object, home, invalidTime: 0 });
  }

  /** Returns false when no object has this id. */
  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * One sim tick of `dt` seconds: every object invalid this tick (out of the world, or isValid() false)
   * adds `dt` to its invalid time, every valid one resets it. Objects that reach RESTORE_AFTER_INVALID are
   * restored to their home transform now; returns their ids in registration order. A non-positive or
   * non-finite `dt` does nothing.
   */
  tick(dt: number): string[] {
    const restored: string[] = [];
    if (!(isFiniteNum(dt) && dt > 0)) return restored;
    for (const entry of this.entries.values()) {
      if (this.isValidNow(entry.object)) {
        entry.invalidTime = 0;
        continue;
      }
      entry.invalidTime += dt;
      if (entry.invalidTime < RESTORE_AFTER_INVALID - TIME_EPS) continue;
      entry.invalidTime = 0;
      entry.object.restore({ pos: copyV3(entry.home.pos), yaw: entry.home.yaw });
      restored.push(entry.object.id);
    }
    return restored;
  }

  private isValidNow(object: RestorableObject): boolean {
    if (outOfWorldReason(this.terrain, object.position()) !== null) return false;
    return object.isValid === undefined || object.isValid();
  }
}
