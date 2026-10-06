// Spawners, Enemy_Camps and encounter groups (design "스폰·캠프·재배치"; Req 10.7, 11.6, 27.4): the World's placement
// of the src/data/spawns.ts enemies through the EnemySystem.
// - rebuild(): the world as GameState says, after a load (the session is built from it), fast travel and a
//   Party_Wipe restart. Engaged enemies are first reset (EnemySystem.resetEngaged), then every spawner that belongs
//   in the world stands at its spawn, idle at full HP: a living enemy is put back, a defeated one is placed again
//   (its body removed). That is every `'roaming'` spawner, every `'never'` one not yet defeated, every member of an
//   Enemy_Camp not cleared and of an encounter group activated and not cleared, so a partly beaten camp comes back
//   whole. Cleared camps and defeated `'never'` spawners stay empty.
// - activate(groupId): the quest `spawnGroup` sink and a current `defeat` Objective (objectiveChanged) place an
//   encounter group unless some member is alive, so a group beaten before its Objective became current comes back
//   for it (Req 2.6). A Challenge_Area's waves (`byArea`, the Observatory ring corridor) are placed by their area.
// - The CampTracker counts each placed camp's and group's living members; the last one's 'enemy:defeated' emits
//   'camp:cleared' { campId, regionId }. An Enemy_Camp's clear is recorded in GameState.world.camps (its locked Chest
//   is the Loot_System's); an encounter group's only ends its activation (the quest state records that progress).
// - An Elite's defeat is recorded in GameState.world.elites, a lone `'never'` spawner's or a guardian Elite's in an
//   encounter group (the Rootbound Warden); a defeated Elite is never placed again.
// rebuild() and activate() run outside EventDispatch or from its handlers, never with an 'enemy:defeated' of this
// tick still undelivered (the session calls rebuild from UiCommands at the start of a tick or between ticks).
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus, GameEvents } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import { isEliteId, type EliteId, type EntityId, type RegionId } from '../data/ids';
import {
  CAMPS, ENCOUNTER_GROUPS, SPAWNERS, type CampDef, type EncounterGroupDef, type SpawnPoint, type SpawnerDef,
} from '../data/spawns';
import type { EnemySystem } from '../enemies/enemySystem';
import type { GameState } from '../logic/save/gameState';
import type { ObjectiveView } from '../quest/questSystem';
import { CampTracker } from './campTracker';

export interface SpawnerSystemOptions {
  bus: GameEventBus;
  enemies: Pick<EnemySystem, 'spawn' | 'get' | 'reset' | 'remove' | 'resetEngaged'>;
  /** GameState.world: cleared Enemy_Camps (`camps`) and defeated lone Elites (`elites`) are recorded and read here. */
  world: Pick<GameState['world'], 'camps' | 'elites'>;
  /** Terrain height for spawn points at `'ground'`. */
  heightAt: (x: number, z: number) => number;
  /** Default SPAWNERS, CAMPS and ENCOUNTER_GROUPS (src/data/spawns.ts). */
  spawners?: readonly SpawnerDef[];
  camps?: readonly CampDef[];
  groups?: readonly EncounterGroupDef[];
  log?: (message: string) => void;
}

export class SpawnerSystem {
  private readonly o: SpawnerSystemOptions;
  private readonly spawners: readonly SpawnerDef[];
  private readonly campDefs: ReadonlyMap<string, CampDef>;
  private readonly groupDefs: ReadonlyMap<string, EncounterGroupDef>;
  /** Spawners by camp or group id, in data order. */
  private readonly members = new Map<string, SpawnerDef[]>();
  private readonly tally: CampTracker;
  /** Spawner id → the entity it placed last (living, or a defeated one not yet replaced). */
  private readonly placed = new Map<string, EntityId>();
  private readonly spawnerOf = new Map<EntityId, SpawnerDef>();
  /** Encounter groups activated and not cleared since. */
  private readonly active = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(options: SpawnerSystemOptions) {
    this.o = options;
    this.spawners = options.spawners ?? SPAWNERS;
    this.campDefs = new Map((options.camps ?? CAMPS).map((c) => [c.id, c]));
    this.groupDefs = new Map((options.groups ?? ENCOUNTER_GROUPS).map((g) => [g.id, g]));
    for (const def of this.spawners) {
      if (def.campId === null) continue;
      const list = this.members.get(def.campId) ?? [];
      list.push(def);
      this.members.set(def.campId, list);
    }
    this.tally = new CampTracker(options.bus, { onCleared: (campId) => this.cleared(campId) });
    this.unsubscribe = options.bus.on('enemy:defeated', (p) => this.onDefeated(p));
  }

  /** Whether `groupId` is an encounter group this system places. */
  has(groupId: string): boolean {
    return this.groupDefs.has(groupId);
  }

  /** Living members of a placed camp or encounter group; 0 when not placed or cleared. */
  aliveCount(campId: string): number {
    return this.tally.aliveCount(campId);
  }

  /** The living enemy spawner `spawnerId` placed, or null. */
  entityOf(spawnerId: string): EntityId | null {
    const id = this.placed.get(spawnerId);
    return id !== undefined && this.living(id) ? id : null;
  }

  /**
   * Places encounter group `groupId` at full HP unless some member is alive, and starts its tally; returns the
   * placed member ids (none for an unknown group, logged, or one still in play). Defeated members' bodies play out.
   */
  activate(groupId: string): EntityId[] {
    const group = this.groupDefs.get(groupId);
    if (group === undefined) {
      this.o.log?.(`SpawnerSystem: no encounter group '${groupId}'`);
      return [];
    }
    if (this.tally.aliveCount(groupId) > 0) return [];
    const ids: EntityId[] = [];
    for (const def of this.members.get(groupId) ?? []) {
      if (this.eliteDefeated(def)) continue;
      const old = this.placed.get(def.id);
      if (old !== undefined && this.living(old)) {
        ids.push(old);
        continue;
      }
      if (old !== undefined) this.forget(def.id, old, false);
      ids.push(this.place(def));
    }
    this.tally.reset(groupId);
    this.tally.track(groupId, group.region, ids);
    if (ids.length > 0) this.active.add(groupId);
    return ids;
  }

  /**
   * `hud:objective`: a current `defeat` Objective of an encounter group makes sure the group is in the world. A wave its
   * Challenge_Area calls (`byArea`, the Observatory's) waits for its turn instead.
   */
  objectiveChanged(view: ObjectiveView | null): void {
    const trigger = view?.objective.trigger;
    if (trigger?.kind !== 'defeat') return;
    const group = this.groupDefs.get(trigger.groupId);
    if (group !== undefined && group.byArea !== true) this.activate(trigger.groupId);
  }

  /**
   * The world as GameState says (Req 11.6, 27.4): engaged enemies reset, then every spawner that belongs in the world
   * idle at its spawn with full HP (placed again when defeated) and the others empty; camp tallies start over.
   */
  rebuild(): void {
    const { enemies } = this.o;
    enemies.resetEngaged();
    const inPlay = new Map<string, EntityId[]>();
    for (const def of this.spawners) {
      const old = this.placed.get(def.id);
      const alive = old !== undefined && this.living(old);
      if (old !== undefined && !alive) {
        this.defeated(def); // recorded even if its 'enemy:defeated' has not been delivered
        this.forget(def.id, old, true);
      }
      if (!this.belongs(def)) {
        if (old !== undefined && alive) this.forget(def.id, old, true);
        continue;
      }
      let id: EntityId;
      if (old !== undefined && alive) {
        enemies.reset(old);
        id = old;
      } else id = this.place(def);
      if (def.campId !== null) inPlay.set(def.campId, [...(inPlay.get(def.campId) ?? []), id]);
    }
    for (const campId of this.members.keys()) this.tally.reset(campId);
    for (const [campId, ids] of inPlay) this.tally.track(campId, this.regionOf(campId), ids);
  }

  dispose(): void {
    this.unsubscribe();
    this.tally.dispose();
  }

  /**
   * Whether `def` is in the world now: a camp member while its Enemy_Camp is not cleared, a group member while its
   * group is active, a lone `'roaming'` spawner always and a `'never'` one until defeated.
   */
  private belongs(def: SpawnerDef): boolean {
    if (def.campId !== null) {
      if (this.eliteDefeated(def)) return false;
      return this.groupDefs.has(def.campId) ? this.active.has(def.campId) : !this.o.world.camps.includes(def.campId);
    }
    return def.respawn === 'roaming' || !this.o.world.elites.includes(def.kind);
  }

  private onDefeated({ entityId }: GameEvents['enemy:defeated']): void {
    const def = this.spawnerOf.get(entityId);
    if (def !== undefined) this.defeated(def);
  }

  /**
   * An Elite stays defeated (GameState.world.elites): a lone `'never'` spawner, or an Elite member of an encounter
   * group (a Challenge_Area guardian such as the Rootbound Warden, whose group is its quest `defeat` id).
   */
  private defeated(def: SpawnerDef): void {
    const lone = def.campId === null && def.respawn === 'never';
    const guardian = def.campId !== null && this.groupDefs.has(def.campId) && isEliteId(def.kind);
    if (!lone && !guardian) return;
    const elite = def.kind as EliteId;
    if (!this.o.world.elites.includes(elite)) this.o.world.elites.push(elite);
  }

  /** A defeated Elite never comes back, whichever camp or group it belongs to. */
  private eliteDefeated(def: SpawnerDef): boolean {
    return isEliteId(def.kind) && this.o.world.elites.includes(def.kind);
  }

  /** CampTracker: an Enemy_Camp's clear is recorded; an encounter group is no longer active. */
  private cleared(campId: string): void {
    if (this.groupDefs.has(campId)) {
      this.active.delete(campId);
      return;
    }
    if (!this.o.world.camps.includes(campId)) this.o.world.camps.push(campId);
  }

  private place(def: SpawnerDef): EntityId {
    const id = this.o.enemies.spawn({
      kind: def.kind, pos: this.resolve(def.pos), yaw: def.yaw, level: def.level, campId: def.campId, spawner: def.id,
    });
    this.placed.set(def.id, id);
    this.spawnerOf.set(id, def);
    return id;
  }

  /** Unlinks spawner `spawnerId` from entity `id`, removing the entity when `removeBody`. */
  private forget(spawnerId: string, id: EntityId, removeBody: boolean): void {
    this.placed.delete(spawnerId);
    this.spawnerOf.delete(id);
    if (removeBody) this.o.enemies.remove(id);
  }

  private living(id: EntityId): boolean {
    const e = this.o.enemies.get(id);
    return e !== undefined && e.state !== 'dead';
  }

  private regionOf(campId: string): RegionId {
    return this.campDefs.get(campId)?.region ?? this.groupDefs.get(campId)?.region ?? this.members.get(campId)?.[0]?.region ?? 'verdant';
  }

  private resolve(p: SpawnPoint): Vec3 {
    return { x: p.x, y: p.y === 'ground' ? this.o.heightAt(p.x, p.z) : p.y, z: p.z };
  }
}
