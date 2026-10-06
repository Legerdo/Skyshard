// Astral Sanctum runtime (design "Boss Caelith" Arena; Req 5.7, 6.11): the World side of src/data/sanctum.ts, built
// once per session.
// - Pieces: static colliders: the gate slab, the steps, the connecting hall's floor and walls, the ws_sanctum stone,
//   the entrance bridge, the arena disc, the four Shard_Crystal pedestals, the 1.2 m rim wall and the starlight ward on
//   it. None is climbable, and only floors, steps and pedestals have standable tops, so nobody climbs, jumps or glides
//   out of the arena. The ward lets the camera through.
// - Entrance seal: a dynamic box across the rim's entrance gap. The session seals it when the fight starts (the intro
//   included) and opens it on a Party_Wipe, the victory or when the party leaves for the Waystone. Like a
//   Challenge_Area door it never closes on the Active_Character's capsule: it waits until they stepped out of it.
// - Mural: an interaction target (kind 'mural', `sanctum_mural`); the quest reads the plain 'interact'.
// - Queries: whether feet stand where the fight starts, the floor sector of a point (sectorBlast), the spots in front
//   of the Waystone and inside the entrance.
// The ws_sanctum stone is only placed here; activation, healing and fast travel come with the Waystone system.
// Pure TypeScript: no three.js / DOM.

import type { Vec3 } from '../core/types';
import { arenaSectorAt, SANCTUM, type SanctumDef, type SanctumPieceDef } from '../data/sanctum';
import type { AreaShape } from '../data/challengeAreas';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld, SurfaceMaterial } from '../physics/types';
import type { InteractTarget } from '../player/interaction';
import type { SafePosition } from '../player/recovery';
import { capsuleInBox } from './challengeArea';

/** Interaction size of the mural (m). */
const MURAL_RADIUS = 0.6;
const MURAL_HEIGHT = 3;

const MATERIAL: Readonly<Record<SanctumPieceDef['look'], SurfaceMaterial>> = {
  floor: 'stone', step: 'stone', hallWall: 'stone', rim: 'stone', ward: 'crystal', pedestal: 'stone', waystone: 'stone',
};

function shapeCollider(shape: AreaShape, id: number, flags: Collider['flags']): Collider {
  return shape.kind === 'obb'
    ? { kind: 'obb', id, center: { ...shape.center }, half: { ...shape.half }, yaw: shape.yaw, flags }
    : { kind: 'cylinder', id, base: { ...shape.base }, radius: shape.radius, height: shape.height, flags };
}

/** A Sanctum piece as a static collider (never climbable). */
export function sanctumPieceCollider(piece: SanctumPieceDef, id: number): Collider {
  return shapeCollider(piece.shape, id, {
    climbable: false, walkableTop: piece.walkableTop, blocksCamera: piece.cameraPasses !== true, material: MATERIAL[piece.look],
  });
}

const copySpot = (s: SanctumDef['arenaEntry']): SafePosition => ({ pos: { ...s.pos }, yaw: s.yaw });

export interface SanctumOptions {
  world: Pick<CollisionWorld, 'addStatic' | 'upsertDynamic' | 'removeDynamic'>;
  ids: ColliderIdSource;
  def?: SanctumDef;
}

export class SanctumSystem {
  readonly def: SanctumDef;
  private readonly world: SanctumOptions['world'];
  private readonly sealBody: Collider;
  /** The session wants the entrance sealed (the fight runs). */
  private wanted = false;
  /** The seal's collider is in the world. */
  private solid = false;

  constructor(options: SanctumOptions) {
    this.def = options.def ?? SANCTUM;
    this.world = options.world;
    for (const piece of this.def.pieces) options.world.addStatic(sanctumPieceCollider(piece, options.ids.next()));
    this.sealBody = shapeCollider(this.def.arena.seal.shape, options.ids.next(), {
      climbable: false, walkableTop: false, blocksCamera: false, material: 'crystal',
    });
  }

  /** Whether the entrance seal stands now. */
  get sealed(): boolean {
    return this.solid;
  }

  /**
   * Seals (the fight starts) or opens (Party_Wipe, victory, leaving) the entrance. Opening is immediate; closing
   * happens now unless the capsule at `feet` stands in the gap, else on the first tick after it left.
   */
  setSealed(sealed: boolean, feet: Readonly<Vec3> | null = null): void {
    this.wanted = sealed;
    this.sync(feet);
  }

  /** Once per tick with the Active_Character's feet: a pending seal closes once the gap is clear. */
  tick(feet: Readonly<Vec3> | null): void {
    this.sync(feet);
  }

  /** Feet on the arena floor within the fight radius: where the Caelith fight starts. */
  inFightZone(feet: Readonly<Vec3>): boolean {
    const a = this.def.arena;
    return feet.y >= a.minY && Math.hypot(feet.x - a.center.x, feet.z - a.center.z) <= a.fightRadius;
  }

  /** Floor sector (0–7, 0 at the entrance, clockwise) under (x, z), or null off the arena disc. */
  sectorAt(x: number, z: number): number | null {
    return arenaSectorAt(x, z);
  }

  /** Where "Waystone으로 돌아가기" puts the party: 2 m in front of ws_sanctum, facing the arena. */
  waystoneSpot(): SafePosition {
    return copySpot(this.def.waystone.spot);
  }

  /** Where "현재 Phase부터 재도전" puts the party: just inside the entrance, facing the centre. */
  arenaEntrySpot(): SafePosition {
    return copySpot(this.def.arenaEntry);
  }

  /** The mural's interaction point. */
  get mural(): Vec3 {
    return { ...this.def.mural.pos };
  }

  interactTargets(): InteractTarget[] {
    const m = this.def.mural;
    const pos = { ...m.pos };
    return [{
      kind: 'mural', id: m.id, name: m.name, a: pos, b: pos, radius: MURAL_RADIUS, height: MURAL_HEIGHT,
      detail: () => '살펴보기', available: () => true,
    }];
  }

  private sync(feet: Readonly<Vec3> | null): void {
    const solid = this.wanted && !(feet !== null && !this.solid && capsuleInBox(this.def.arena.seal.shape, feet));
    if (solid === this.solid) return;
    this.solid = solid;
    if (solid) this.world.upsertDynamic(this.sealBody);
    else this.world.removeDynamic(this.sealBody.id);
  }
}
