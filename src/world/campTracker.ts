// Enemy_Camp / encounter group tally (design "스폰·캠프·재배치", Req 10.7): the World's count of the living members
// of each tracked camp. While EventDispatch delivers the last member's 'enemy:defeated' it calls `onCleared` (the
// SpawnerSystem records the clear) and emits 'camp:cleared' (so it reaches subscribers in the same dispatch, right
// after that event). The SpawnerSystem (src/world/spawnerSystem) tracks the camps and encounter groups it places.

import type { GameEventBus, GameEvents } from '../core/gameEvents';
import type { EntityId, RegionId } from '../data/ids';

interface CampTally {
  regionId: RegionId;
  alive: Set<EntityId>;
}

export interface CampTrackerOptions {
  /** Called as a camp is cleared, before its 'camp:cleared' is emitted. */
  onCleared?(campId: string, regionId: RegionId): void;
}

export class CampTracker {
  private readonly bus: GameEventBus;
  private readonly options: CampTrackerOptions;
  private readonly camps = new Map<string, CampTally>();
  private readonly unsubscribe: () => void;

  constructor(bus: GameEventBus, options: CampTrackerOptions = {}) {
    this.bus = bus;
    this.options = options;
    this.unsubscribe = bus.on('enemy:defeated', (p) => this.onDefeated(p));
  }

  /** Adds `members` to camp `campId` (a camp tracked again keeps its region and gains the new members). */
  track(campId: string, regionId: RegionId, members: readonly EntityId[]): void {
    const tally = this.camps.get(campId) ?? { regionId, alive: new Set<EntityId>() };
    for (const id of members) tally.alive.add(id);
    if (tally.alive.size > 0) this.camps.set(campId, tally);
  }

  /** Stops tracking `campId` without clearing it (its members are being placed again). */
  reset(campId: string): void {
    this.camps.delete(campId);
  }

  /** Living members of a tracked camp; 0 when it is not tracked (never, or already cleared). */
  aliveCount(campId: string): number {
    return this.camps.get(campId)?.alive.size ?? 0;
  }

  dispose(): void {
    this.unsubscribe();
    this.camps.clear();
  }

  private onDefeated({ entityId, campId }: GameEvents['enemy:defeated']): void {
    if (campId === null) return;
    const tally = this.camps.get(campId);
    if (tally === undefined || !tally.alive.delete(entityId) || tally.alive.size > 0) return;
    this.camps.delete(campId);
    this.options.onCleared?.(campId, tally.regionId);
    this.bus.emit('camp:cleared', { campId, regionId: tally.regionId });
  }
}
