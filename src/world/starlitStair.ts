// Starlit_Stair (design "진행 게이트": seal_sanctum; Req 5.5, 5.6). When seal_sanctum is lifted the stair's
// floating platforms become dynamic colliders and its two starlit Updrafts join the volume index; before that
// neither exists. While active, `track` remembers the last platform the character stood on and reports the
// spot to return to once it falls STAIR_FALL_DISTANCE below that platform (logic/stairFall); the composition
// root passes it to RecoverySystem.restorePlayer('stairFall', spot). Pure TypeScript: no three.js / DOM.

import { yawFromDir } from '../core/math';
import type { Vec3 } from '../core/types';
import { STARLIT_STAIR, type StairPlatformDef, type StarlitStairDef } from '../data/starlitStair';
import { INITIAL_STAIR_FALL_STATE, stepStairFall, type StairFallState } from '../logic/stairFall';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld } from '../physics/types';
import { CAPSULE_RADIUS, GROUND_SNAP_DISTANCE } from '../player/core/constants';
import type { SafePosition } from '../player/recovery';
import type { VolumeIndex } from './volumeIndex';

export interface StarlitStairOptions {
  world: Pick<CollisionWorld, 'upsertDynamic' | 'removeDynamic' | 'groundProbe'>;
  volumes: VolumeIndex;
  ids: ColliderIdSource;
  def?: StarlitStairDef;
}

/** The body fields the fall check reads. */
export interface StairBody {
  readonly pos: Readonly<Vec3>;
  readonly grounded: boolean;
}

/** Platform slab as an axis-aligned box collider: walkable top, not climbable, no camera blocking. */
export function platformCollider(p: StairPlatformDef, thickness: number, id: number): Collider {
  return {
    kind: 'aabb',
    id,
    min: { x: p.x - p.halfX, y: p.topY - thickness, z: p.z - p.halfZ },
    max: { x: p.x + p.halfX, y: p.topY, z: p.z + p.halfZ },
    flags: { climbable: false, walkableTop: true, blocksCamera: false, material: 'crystal' },
  };
}

export class StarlitStair {
  readonly def: StarlitStairDef;
  private readonly world: StarlitStairOptions['world'];
  private readonly volumes: VolumeIndex;
  /** Collider id of each platform, in platform order. */
  private readonly colliderIds: readonly number[];
  private readonly platformByCollider: ReadonlyMap<number, number>;
  private isActive = false;
  private fall: StairFallState = INITIAL_STAIR_FALL_STATE;

  constructor(options: StarlitStairOptions) {
    this.def = options.def ?? STARLIT_STAIR;
    this.world = options.world;
    this.volumes = options.volumes;
    this.colliderIds = this.def.platforms.map(() => options.ids.next());
    this.platformByCollider = new Map(this.colliderIds.map((id, i) => [id, i]));
  }

  get active(): boolean {
    return this.isActive;
  }

  /** Index of the platform last stood on while on the stair; null when off it. */
  get lastPlatform(): number | null {
    return this.fall.last;
  }

  /** Builds (true) or removes (false) the platforms and starlit Updrafts. Setting the current state does nothing. */
  setActive(active: boolean): void {
    if (active === this.isActive) return;
    this.isActive = active;
    this.fall = INITIAL_STAIR_FALL_STATE;
    const { platforms, updrafts, thickness } = this.def;
    if (active) {
      platforms.forEach((p, i) => this.world.upsertDynamic(platformCollider(p, thickness, this.colliderIds[i])));
      this.volumes.addAll(updrafts);
    } else {
      for (const id of this.colliderIds) this.world.removeDynamic(id);
      for (const u of updrafts) this.volumes.remove('updraft', u.id);
    }
  }

  /** Platform index of a collider, or null when it is not one of the stair's platforms. */
  platformOf(colliderId: number | null): number | null {
    return colliderId === null ? null : (this.platformByCollider.get(colliderId) ?? null);
  }

  /** Standing spot on a platform: the centre of its top, facing the next platform (the last faces on along the climb). */
  spotOn(index: number): SafePosition {
    const { platforms } = this.def;
    const p = platforms[index];
    const next = platforms[index + 1];
    const prev = platforms[index - 1];
    const dir = next !== undefined ? { x: next.x - p.x, z: next.z - p.z } : prev !== undefined ? { x: p.x - prev.x, z: p.z - prev.z } : { x: 0, z: -1 };
    return { pos: { x: p.x, y: p.topY, z: p.z }, yaw: yawFromDir(dir.x, dir.z) };
  }

  /**
   * One sim tick on the player's final state (CollisionResolve): the spot to return to when the character
   * fell STAIR_FALL_DISTANCE or more below the last platform this tick, else null. Inactive: always null.
   */
  track(body: StairBody): SafePosition | null {
    if (!this.isActive) return null;
    let platform: number | null = null;
    if (body.grounded) {
      const ground = this.world.groundProbe(body.pos, GROUND_SNAP_DISTANCE, CAPSULE_RADIUS);
      platform = this.platformOf(ground?.colliderId ?? null);
    }
    const step = stepStairFall(this.fall, { grounded: body.grounded, platform }, body.pos.y, (i) => this.def.platforms[i].topY);
    this.fall = step.state;
    return step.fell === null ? null : this.spotOn(step.fell);
  }
}
