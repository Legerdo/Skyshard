// Thistlewick in the World (design.md "Thistlewick", task 13.2; Req 14.1, 14.8, 14.10, 5.1): the solid bodies of the
// village buildings (src/data/village.ts VILLAGE_BUILDINGS), the Hearth as an interaction target, and the village's
// progress look (recomputed from GameState on every read, so a load looks like the session that saved it).
// - Colliders: the houses and Elder Maren's house (oriented boxes that block the camera), Pip's counter and Old Bram's
//   altar (low boxes), the well rim (a cylinder) and the watchtower's four posts and platform. They stand off the
//   route's walking lines (the village entrance → plaza → watchtower → east field legs) and outside the plaza's
//   Sanctum sight axis (tests/unit/world/village.test.ts checks both).
// - Hearth (Req 14.10): 'interact' on it restores every Player_Character to full HP and clears Downed (the
//   Party_System's restoreAll), then `rested` tells the HUD.
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import {
  HEARTH_HEIGHT, HEARTH_POS, HEARTH_RADIUS, HEARTH_TARGET_ID, VILLAGE_BUILDINGS, VILLAGE_GROUND_Y, WATCHTOWER_POST_RADIUS,
  type VillageBuildingDef,
} from '../data/village';
import { villageLook, type VillageLook } from '../logic/village';
import type { GameState } from '../logic/save/gameState';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld } from '../physics/types';
import type { InteractTarget } from '../player/interaction';

/** Bodies reach this far below the lowest ground under their footprint (m), so slopes leave no gap. */
const SINK = 0.3;
/** Watchtower platform: its underside height and thickness (m); the roof sits on the posts above it. */
const PLATFORM_Y = 8.6;
const PLATFORM_THICKNESS = 0.3;

/** A building with its resolved base: the lowest terrain height under its footprint. */
export interface PlacedBuilding {
  readonly def: VillageBuildingDef;
  readonly baseY: number;
}

export interface VillageSystemOptions {
  bus: GameEventBus;
  /** Read: Skyshards, the completion record and the world flags (the village look). */
  state: GameState;
  world: Pick<CollisionWorld, 'addStatic'>;
  ids: ColliderIdSource;
  heightAt: (x: number, z: number) => number;
  /** Every Player_Character to full HP, Downed cleared (PartySystem.restoreAll). */
  restoreParty: () => void;
  /** The Hearth healed the party (HUD line). */
  rested?: () => void;
}

/** The footprint corners and centre of `def` in world (x, z). */
export function buildingFootprint(def: VillageBuildingDef): { x: number; z: number }[] {
  const c = Math.cos(def.yaw);
  const s = Math.sin(def.yaw);
  const out = [{ x: def.center.x, z: def.center.z }];
  for (const [ax, az] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const vx = ax * def.half.x;
    const vz = az * def.half.z;
    out.push({ x: def.center.x + vx * c + vz * s, z: def.center.z - vx * s + vz * c });
  }
  return out;
}

/** The colliders of one building standing on `baseY` (ids from `nextId`). */
export function buildingColliders(def: VillageBuildingDef, baseY: number, nextId: () => number): Collider[] {
  const bottom = baseY - SINK;
  switch (def.kind) {
    case 'well':
      return [{
        kind: 'cylinder', id: nextId(), base: { x: def.center.x, y: bottom, z: def.center.z }, radius: def.half.x, height: def.height + SINK,
        flags: { climbable: false, walkableTop: true, blocksCamera: false, material: 'stone' },
      }];
    case 'watchtower': {
      const posts: Collider[] = buildingFootprint(def).slice(1).map((p) => ({
        kind: 'cylinder', id: nextId(), base: { x: p.x, y: bottom, z: p.z }, radius: WATCHTOWER_POST_RADIUS, height: def.height + SINK,
        flags: { climbable: true, walkableTop: false, blocksCamera: false, material: 'wood' },
      }));
      const platform: Collider = {
        kind: 'obb', id: nextId(), center: { x: def.center.x, y: baseY + PLATFORM_Y + PLATFORM_THICKNESS / 2, z: def.center.z },
        half: { x: def.half.x, y: PLATFORM_THICKNESS / 2, z: def.half.z }, yaw: def.yaw,
        flags: { climbable: false, walkableTop: true, blocksCamera: false, material: 'wood' },
      };
      return [...posts, platform];
    }
    default: {
      const big = def.kind === 'marenHouse' || def.kind === 'house';
      const h = def.height + SINK;
      return [{
        kind: 'obb', id: nextId(), center: { x: def.center.x, y: bottom + h / 2, z: def.center.z },
        half: { x: def.half.x, y: h / 2, z: def.half.z }, yaw: def.yaw,
        flags: {
          climbable: big, walkableTop: true, blocksCamera: big, material: def.kind === 'echoAltar' || def.kind === 'step' ? 'stone' : 'wood',
        },
      }];
    }
  }
}

export class VillageSystem {
  readonly buildings: readonly PlacedBuilding[];
  private readonly o: VillageSystemOptions;
  private readonly unsubscribe: () => void;

  constructor(options: VillageSystemOptions) {
    this.o = options;
    this.buildings = VILLAGE_BUILDINGS.map((def) => {
      const ys = buildingFootprint(def).map((p) => options.heightAt(p.x, p.z)).filter(Number.isFinite);
      return { def, baseY: ys.length > 0 ? Math.min(...ys) : VILLAGE_GROUND_Y };
    });
    for (const b of this.buildings) {
      for (const c of buildingColliders(b.def, b.baseY, () => options.ids.next())) options.world.addStatic(c);
    }
    this.unsubscribe = options.bus.on('interact', ({ targetKind, targetId }) => {
      if (targetKind === 'hearth' && targetId === HEARTH_TARGET_ID) this.rest();
    });
  }

  /** The village's look now (Req 14.8): cumulative Skyshard stages, the ending, the Side_Quest world changes. */
  look(): VillageLook {
    return villageLook(this.o.state);
  }

  /** The Hearth in the plaza (Req 14.10). */
  interactTargets(): InteractTarget[] {
    const pos: Vec3 = { x: HEARTH_POS.x, y: this.o.heightAt(HEARTH_POS.x, HEARTH_POS.z), z: HEARTH_POS.z };
    return [{
      kind: 'hearth', id: HEARTH_TARGET_ID, name: 'Hearth', a: pos, b: pos, radius: HEARTH_RADIUS, height: HEARTH_HEIGHT,
      detail: () => '쉬어 가기 · 파티 HP 회복', available: () => true,
    }];
  }

  dispose(): void {
    this.unsubscribe();
  }

  private rest(): void {
    this.o.restoreParty();
    this.o.rested?.();
  }
}
