// Loot_System, Chest side (design "Chest와 보상표", task 12.7; Req 10.5–10.7, 10.10, 30.5, 30.6, 36.3). The Chests of
// src/data/pois.ts in the world: a small solid box each (walkable top) and an interaction target ('chest').
// - Presence: placed and camp Chests stand from the start; a puzzle Chest appears once its puzzle reward is open
//   (PuzzleSystem.isOpen), a hidden Elite's once that Elite is defeated (GameState.world.elites; at the body's feet when
//   it fell near its lair this session, else at the lair) and the Sky Ring Trial's once the trial is completed. An
//   opened Chest (GameState.world.chests) stays, open and empty, and is offered no more.
// - An Enemy_Camp's Chest is locked until its camp is cleared (LootSystem.chestLocked): offered with "잠김" and not
//   opened.
// - Opening ('interact' on it): recorded in GameState (`world.chests`, `stats.chestsOpened`), 'chest:opened'
//   (`chestId`, `tier`: the Progression_System's Chest XP by tier; Render / Audio / UI play the tier's opening VFX and
//   sound), then the rewards of logic/loot rollChest (the Chest's own mulberry32(hash(id)) stream, the glowing tier's
//   designated item while unowned): items through the Inventory_System ('item:granted', source 'chest'), Glim added,
//   and the 'chest' Milestone 'save:request'. The HUD gets the reward list through `opened`.
// Pure TypeScript: no three.js / DOM.

import { copyV3 } from '../core/math';
import type { GameEventBus, GameEvents } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import type { EntityId, RegionId } from '../data/ids';
import { CHEST_PRESENTATION, CHESTS, type ChestDef } from '../data/pois';
import type { InventorySystem } from '../inventory/inventorySystem';
import { rollChest, type ChestTier, type Reward } from '../logic/loot';
import type { GameState } from '../logic/save/gameState';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld } from '../physics/types';
import type { InteractTarget } from '../player/interaction';

/** 'item:granted' source of Chest rewards. */
export const CHEST_SOURCE = 'chest';
/** The Chest's box (m): width across the lid, depth, height. */
export const CHEST_SIZE = { width: 0.9, depth: 0.6, height: 0.7 } as const;
/** A hidden Elite's Chest goes to its body's feet when the body fell within this of the lair (m). */
export const ELITE_CHEST_REACH = 25;
/** Interaction reach around the box: half its width plus a hand (m). */
const TARGET_RADIUS = CHEST_SIZE.width / 2 + 0.25;
/** Prompt detail of a camp Chest before the clear (Req 10.7). */
export const CHEST_LOCKED_TEXT = '잠김 · 캠프를 소탕하면 열립니다';

/** What the HUD shows when a Chest opens (the reward list, Req 10.5) and where its VFX plays. */
export interface ChestOpenedNotice {
  readonly chestId: string;
  readonly tier: ChestTier;
  readonly region: RegionId;
  readonly rewards: readonly Reward[];
  readonly pos: Vec3;
}

/** One Chest for the view. */
export interface ChestView {
  readonly def: ChestDef;
  readonly pos: Readonly<Vec3>;
  /** In the world now (appeared, or always there). */
  readonly present: boolean;
  readonly opened: boolean;
  /** A camp Chest whose camp is not cleared. */
  readonly locked: boolean;
  /** Sim seconds since it opened in this session (the opening effect), else null. */
  readonly openedAgo: number | null;
  /** Sim seconds since it appeared in this session (the appearing effect), else null. */
  readonly appearedAgo: number | null;
}

export interface ChestSystemOptions {
  bus: GameEventBus;
  /** Written: `world.chests`, `stats.chestsOpened`. Read: `world.elites`, `inventory.ownedEquipment`. */
  state: GameState;
  world: Pick<CollisionWorld, 'addStatic' | 'upsertDynamic'>;
  ids: ColliderIdSource;
  heightAt: (x: number, z: number) => number;
  inventory: Pick<InventorySystem, 'grant' | 'addGlim'>;
  /** Whether a camp Chest is still locked (LootSystem.chestLocked). */
  locked: (chestId: string) => boolean;
  /** Whether a puzzle reward target is open (PuzzleSystem.isOpen). */
  puzzleOpen: (target: string) => boolean;
  /** Whether the trial is completed (PoiSystem.trialDone). */
  trialDone: (trialId: string) => boolean;
  /** Feet of a defeated enemy's body while it is listed (the Elite Chest's spot); default unknown. */
  bodyAt?: (entityId: EntityId) => Readonly<Vec3> | null;
  /** Default CHESTS (src/data/pois.ts). */
  chests?: readonly ChestDef[];
  /** A Chest opened: its reward list for the HUD and its tier's VFX. */
  opened?: (notice: ChestOpenedNotice) => void;
}

interface Entry {
  readonly def: ChestDef;
  pos: Vec3;
  present: boolean;
  colliderId: number | null;
  openedAt: number | null;
  appearedAt: number | null;
}

export class ChestSystem {
  private readonly o: ChestSystemOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly unsubscribe: (() => void)[];
  private time = 0;

  constructor(options: ChestSystemOptions) {
    this.o = options;
    for (const def of options.chests ?? CHESTS) {
      const y = def.raised === true ? def.pos.y : options.heightAt(def.pos.x, def.pos.z);
      const entry: Entry = {
        def, pos: { x: def.pos.x, y: Number.isFinite(y) ? y : def.pos.y, z: def.pos.z }, present: false, colliderId: null,
        openedAt: null, appearedAt: null,
      };
      this.entries.set(def.id, entry);
      if (this.wantsPresent(entry)) this.appear(entry, false);
    }
    this.unsubscribe = [
      options.bus.on('interact', ({ targetKind, targetId }) => {
        if (targetKind === 'chest') this.open(targetId);
      }),
      options.bus.on('enemy:defeated', (p) => this.onDefeated(p)),
    ];
  }

  /** Every Chest's state for the view. */
  views(): ChestView[] {
    const opened = new Set(this.o.state.world.chests);
    return [...this.entries.values()].map((e) => ({
      def: e.def, pos: e.pos, present: e.present, opened: opened.has(e.def.id), locked: this.o.locked(e.def.id),
      openedAgo: e.openedAt === null ? null : this.time - e.openedAt,
      appearedAgo: e.appearedAt === null ? null : this.time - e.appearedAt,
    }));
  }

  /** Whether the Chest is in the world now. */
  isPresent(chestId: string): boolean {
    return this.entries.get(chestId)?.present ?? false;
  }

  /** Unopened present Chests within `radius` m (horizontal) of `p` (방랑자의 나침반, Req 30.1). */
  unopenedNear(p: Readonly<Vec3>, radius: number): ChestDef[] {
    const opened = new Set(this.o.state.world.chests);
    const out: ChestDef[] = [];
    for (const e of this.entries.values()) {
      if (!e.present || opened.has(e.def.id)) continue;
      if (Math.hypot(e.pos.x - p.x, e.pos.z - p.z) <= radius) out.push(e.def);
    }
    return out;
  }

  interactTargets(): InteractTarget[] {
    const opened = (id: string): boolean => this.o.state.world.chests.includes(id);
    return [...this.entries.values()].map((e): InteractTarget => ({
      kind: 'chest',
      id: e.def.id,
      name: CHEST_PRESENTATION[e.def.tier].name,
      get a(): Vec3 {
        return e.pos;
      },
      get b(): Vec3 {
        return e.pos;
      },
      radius: TARGET_RADIUS,
      height: CHEST_SIZE.height,
      detail: () => (this.o.locked(e.def.id) ? CHEST_LOCKED_TEXT : '열기'),
      available: () => e.present && !opened(e.def.id),
    }));
  }

  /** One sim tick: Chests whose condition came true appear (their box and target). */
  tick(dt: number): void {
    if (Number.isFinite(dt) && dt > 0) this.time += dt;
    for (const e of this.entries.values()) if (!e.present && this.wantsPresent(e)) this.appear(e, true);
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private wantsPresent(e: Entry): boolean {
    const { state } = this.o;
    if (state.world.chests.includes(e.def.id)) return true;
    const src = e.def.source;
    switch (src.kind) {
      case 'placed':
      case 'camp':
        return true;
      case 'puzzle':
        return this.o.puzzleOpen(src.opens);
      case 'elite':
        return state.world.elites.includes(src.eliteId);
      case 'trial':
        return this.o.trialDone(src.trialId);
    }
  }

  private appear(e: Entry, dynamic: boolean): void {
    e.present = true;
    if (dynamic) e.appearedAt = this.time;
    const { width, depth, height } = CHEST_SIZE;
    const collider: Collider = {
      kind: 'obb', id: this.o.ids.next(), center: { x: e.pos.x, y: e.pos.y + height / 2, z: e.pos.z },
      half: { x: width / 2, y: height / 2, z: depth / 2 }, yaw: e.def.yaw,
      flags: { climbable: false, walkableTop: true, blocksCamera: false, material: 'wood' },
    };
    e.colliderId = collider.id;
    if (dynamic) this.o.world.upsertDynamic(collider);
    else this.o.world.addStatic(collider);
  }

  /** A hidden Elite fell: its Chest will stand at the body's feet when that is near its lair. */
  private onDefeated({ entityId, kind }: GameEvents['enemy:defeated']): void {
    for (const e of this.entries.values()) {
      const src = e.def.source;
      if (src.kind !== 'elite' || src.eliteId !== kind || e.present) continue;
      const body = this.o.bodyAt?.(entityId) ?? null;
      if (body === null || !Number.isFinite(body.x + body.y + body.z)) continue;
      if (Math.hypot(body.x - e.def.pos.x, body.z - e.def.pos.z) > ELITE_CHEST_REACH) continue;
      e.pos = copyV3(body);
    }
  }

  /** 'interact' on a Chest: opened once when present, unopened and not camp-locked. */
  private open(chestId: string): void {
    const e = this.entries.get(chestId);
    const { state, bus, inventory } = this.o;
    if (e === undefined || !e.present || state.world.chests.includes(chestId) || this.o.locked(chestId)) return;
    const { def } = e;
    state.world.chests.push(chestId);
    state.stats.chestsOpened += 1;
    e.openedAt = this.time;
    const rewards = rollChest(def.tier, chestId, new Set(state.inventory.ownedEquipment), def.item);
    bus.emit('chest:opened', { chestId, tier: def.tier });
    for (const r of rewards) {
      if (r.kind === 'glim') inventory.addGlim(r.amount);
      else inventory.grant(r.id, r.count, CHEST_SOURCE);
    }
    bus.emit('save:request', { reason: 'chest' });
    this.o.opened?.({ chestId, tier: def.tier, region: def.region, rewards, pos: { ...e.pos } });
  }
}
