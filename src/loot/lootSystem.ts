// Loot_System, enemy side (design "적 드롭", Req 28.13). On each 'enemy:defeated' (EventDispatch) it grants the
// kind's XP through the Progression_System and its Glim through the Inventory_System at once, then rolls the kind's
// drop table on the loot drop stream (logic/loot rollEnemyDrop) and lays each drop on the ground where the body
// fell. Every tick a drop within 3 m of the Active_Character's feet is pulled toward their chest and, on arrival,
// granted by the Inventory_System ('item:granted', source 'enemy'); drops farther away stay where they are.
// Enemy_Camp Chests (design "Chest 보상", Req 10.7): each camp's locked Chest stays locked until its 'camp:cleared',
// which makes it openable and raises the "캠프 소탕" notice (the HUD's 2 s banner). A camp cleared before a load is in
// GameState.world.camps, so its Chest is openable again after the load. Opening Chests, their rewards and Elite
// reward Chests are task 12.7. Pure TypeScript: no three.js / DOM, no Math.random.

import { copyV3, distance } from '../core/math';
import type { GameEventBus, GameEvents } from '../core/gameEvents';
import type { Rng } from '../core/rng';
import type { Vec3 } from '../core/types';
import { getEnemyDef } from '../data/enemies';
import type { EntityId, RegionId } from '../data/ids';
import { CAMPS, type CampDef } from '../data/spawns';
import { rollEnemyDrop } from '../logic/loot';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import type { InventorySystem } from '../inventory/inventorySystem';
import type { ProgressionSystem } from '../progression/progressionSystem';
import type { PickupRuntime } from '../save/runtimeState';

/** A drop starts flying to the Active_Character once their feet are this close (m, Req 28.13). */
export const PICKUP_ATTRACT_RADIUS = 3;
/** Flight speed of a pulled drop (m/s): from 3 m it arrives in about a quarter second. */
export const PICKUP_PULL_SPEED = 12;
/** A pulled drop is collected within this distance (m) of its target point. */
export const PICKUP_COLLECT_RADIUS = 0.5;
/** Pulled drops fly to this height above the feet (chest). */
export const PICKUP_TARGET_HEIGHT = 1;
/** Several drops of one body are spread on a ring of this radius (m) around it, a golden angle apart. */
export const PICKUP_SCATTER_RADIUS = 0.6;
/** 'item:granted' source of enemy drops. */
export const ENEMY_DROP_SOURCE = 'enemy';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** "캠프 소탕" (Req 10.7): an Enemy_Camp was cleared and its locked Chest, if it has one, can now be opened. */
export interface CampClearedNotice {
  readonly campId: string;
  readonly regionId: RegionId;
  readonly chestId: string | null;
}

export interface LootSystemOptions {
  bus: GameEventBus;
  /** The loot drop stream (createRngStreams(seed).loot); only drop rolls draw from it. */
  rng: Rng;
  progression: Pick<ProgressionSystem, 'grantXp'>;
  inventory: Pick<InventorySystem, 'grant' | 'addGlim'>;
  /** RuntimeState.pickups: the drops lying in the world. */
  pickups: PickupRuntime[];
  /**
   * Feet of the defeated enemy's body (it stays listed for 1.5 s, so it is there while its 'enemy:defeated' is
   * delivered), or null when unknown: such drops are granted at once.
   */
  bodyAt(entityId: EntityId): Readonly<Vec3> | null;
  /** Ground height under a scattered drop; default the body's feet height. */
  ground?(p: Readonly<Vec3>): number;
  /** Enemy_Camps and their locked Chests; default CAMPS (src/data/spawns.ts). */
  camps?: readonly CampDef[];
  /** GameState.world: `camps` lists the camps cleared so far (the World records them), read for the Chest locks. */
  world?: DeepReadonly<Pick<GameState['world'], 'camps'>>;
  /** "캠프 소탕" notice for the HUD (a 2 s banner), sent while 'camp:cleared' is delivered. */
  campCleared?(notice: CampClearedNotice): void;
}

export class LootSystem {
  private readonly options: LootSystemOptions;
  private readonly unsubscribe: (() => void)[];
  private readonly camps: ReadonlyMap<string, CampDef>;
  /** Locked Chest id → its camp. */
  private readonly chestCamps: ReadonlyMap<string, string>;
  /** Camps cleared this session (their Chests are openable). */
  private readonly unlocked = new Set<string>();
  private serial = 0;

  constructor(options: LootSystemOptions) {
    this.options = options;
    const camps = options.camps ?? CAMPS;
    this.camps = new Map(camps.map((c) => [c.id, c]));
    this.chestCamps = new Map(camps.flatMap((c): [string, string][] => (c.chestId === null ? [] : [[c.chestId, c.id]])));
    this.unsubscribe = [
      options.bus.on('enemy:defeated', (p) => this.onDefeated(p)),
      options.bus.on('camp:cleared', (p) => this.onCampCleared(p)),
    ];
  }

  /**
   * Whether `chestId` is an Enemy_Camp's locked Chest whose camp is not cleared yet (neither this session nor in
   * GameState.world.camps). Other Chests are never camp-locked.
   */
  chestLocked(chestId: string): boolean {
    const campId = this.chestCamps.get(chestId);
    if (campId === undefined) return false;
    return !this.unlocked.has(campId) && !(this.options.world?.camps.includes(campId) ?? false);
  }

  /** Drops lying in the world or flying to the character. */
  get pickups(): readonly Readonly<PickupRuntime>[] {
    return this.options.pickups;
  }

  /**
   * One tick: `player` is the Active_Character's feet, or null while nothing may be picked up (a fade or a
   * cinematic holds the game). Drops within 3 m start their pull; pulled drops fly and are granted on arrival.
   */
  tick(dt: number, player: Readonly<Vec3> | null): void {
    const list = this.options.pickups;
    for (const p of list) p.prevPos = copyV3(p.pos);
    if (player === null || !(Number.isFinite(dt) && dt > 0)) return;
    const target = { x: player.x, y: player.y + PICKUP_TARGET_HEIGHT, z: player.z };
    const collected: PickupRuntime[] = [];
    for (const p of list) {
      if (!p.pulled && distance(p.pos, player) <= PICKUP_ATTRACT_RADIUS) p.pulled = true;
      if (!p.pulled) continue;
      const d = distance(p.pos, target);
      const step = Math.min(d, PICKUP_PULL_SPEED * dt);
      if (d > 1e-9) {
        const k = step / d;
        p.pos = { x: p.pos.x + (target.x - p.pos.x) * k, y: p.pos.y + (target.y - p.pos.y) * k, z: p.pos.z + (target.z - p.pos.z) * k };
      }
      if (d - step <= PICKUP_COLLECT_RADIUS) collected.push(p);
    }
    for (const p of collected) {
      list.splice(list.indexOf(p), 1);
      this.options.inventory.grant(p.itemId, p.count, p.source);
    }
  }

  /** Removes every drop (fast travel, loads and a Party_Wipe restart rebuild the world). */
  clear(): void {
    this.options.pickups.length = 0;
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** An Enemy_Camp's clear opens its locked Chest and raises "캠프 소탕"; encounter groups are not camps. */
  private onCampCleared({ campId, regionId }: GameEvents['camp:cleared']): void {
    const camp = this.camps.get(campId);
    if (camp === undefined) return;
    this.unlocked.add(campId);
    this.options.campCleared?.({ campId, regionId, chestId: camp.chestId });
  }

  /** XP and Glim at once, then the rolled drops on the ground around the body (Req 28.13). */
  private onDefeated({ entityId, kind }: GameEvents['enemy:defeated']): void {
    const { progression, inventory, rng } = this.options;
    const def = getEnemyDef(kind);
    progression.grantXp(def.xp);
    inventory.addGlim(def.glim);
    const drops = rollEnemyDrop(kind, rng);
    const body = this.options.bodyAt(entityId);
    drops.forEach((drop, i) => {
      if (drop.kind !== 'item') return;
      if (body === null) {
        inventory.grant(drop.id, drop.count, ENEMY_DROP_SOURCE);
        return;
      }
      this.lay(drop.id, drop.count, body, i, drops.length);
    });
  }

  private lay(itemId: PickupRuntime['itemId'], count: number, body: Readonly<Vec3>, index: number, total: number): void {
    const r = total > 1 ? PICKUP_SCATTER_RADIUS : 0;
    const a = index * GOLDEN_ANGLE;
    const at = { x: body.x + Math.sin(a) * r, y: body.y, z: body.z + Math.cos(a) * r };
    const y = this.options.ground?.(at);
    if (y !== undefined && Number.isFinite(y)) at.y = y;
    this.serial += 1;
    this.options.pickups.push({
      id: `drop_${this.serial}`, itemId, count, pos: at, prevPos: copyV3(at), pulled: false, source: ENEMY_DROP_SOURCE,
    });
  }
}
