// World triggers: Region, area and Landmark entry (design "물·기류·트리거 볼륨", "청크와 활성화", event
// `area:entered` / `landmark:discovered`; Req 8.7, 9.4). Runs in the WorldTriggers step of each sim tick on the
// Active_Character's feet and, in this order:
//   1. Region: `regionAt` (with height, for the floating Sanctum) gives the Region underfoot; a locked Region
//      (its barriers still closed) or a border strip keeps the current one (logic/worldEntry). Entering a
//      Region publishes 'area:entered' with the RegionId as `areaId`; the first entry registers it in
//      GameState `discovery.regions` (the map) and shows the 3 s title card (Req 8.7).
//   2. Areas: `area` volumes in the feet's hash cell and its neighbours; each newly entered one publishes
//      'area:entered' (`first` on the first entry in this save, recorded as a `world.flags` entry).
//   3. Landmarks: a `discovery` volume whose Landmark is not in `discovery.landmarks` yet registers it and
//      publishes 'landmark:discovered' once.
// The World owns `discovery.regions`, `discovery.landmarks` and the `entered_<area>` flags. Pure TypeScript:
// no three.js / DOM; the title card is a sink.

import { isFiniteV3 } from '../core/math';
import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import type { RegionId } from '../data/ids';
import { regionAt } from '../data/worldLayout';
import type { GameState } from '../logic/save/gameState';
import { areaVisitedFlag, newAreaEntries, stepRegion } from '../logic/worldEntry';
import type { VolumeIndex } from './volumeIndex';

export interface WorldTriggerSinks {
  /** First entry into a Region: the HUD title card (Region name and subtitle, 3 s). */
  regionTitle?(region: RegionId): void;
}

export interface WorldTriggersOptions {
  bus: GameEventBus;
  state: GameState;
  volumes: VolumeIndex;
  /** Whether a Region may be entered now (logic/gates `regionUnlocked` on the current GameState). */
  unlocked: (region: RegionId) => boolean;
  sinks?: WorldTriggerSinks;
}

export class WorldTriggers {
  private readonly bus: GameEventBus;
  private readonly state: GameState;
  private readonly volumes: VolumeIndex;
  private readonly unlocked: (region: RegionId) => boolean;
  private readonly sinks: WorldTriggerSinks;
  private currentRegion: RegionId | null = null;
  private insideAreas = new Set<string>();

  constructor(options: WorldTriggersOptions) {
    this.bus = options.bus;
    this.state = options.state;
    this.volumes = options.volumes;
    this.unlocked = options.unlocked;
    this.sinks = options.sinks ?? {};
  }

  /** Region the character is in (the last unlocked Region entered); null before the first tick. */
  get region(): RegionId | null {
    return this.currentRegion;
  }

  /** Area ids the feet were inside on the last tick. */
  get areas(): ReadonlySet<string> {
    return this.insideAreas;
  }

  /**
   * Forgets where the character was (after a load or a teleport by fast travel), so the next tick enters
   * the Region and areas it stands in again (as returns, when visited before).
   */
  reset(): void {
    this.currentRegion = null;
    this.insideAreas = new Set();
  }

  /** One sim tick on the character's feet. A non-finite position changes nothing. */
  tick(feet: Readonly<Vec3>): void {
    if (!isFiniteV3(feet)) return;
    this.trackRegion(feet);
    this.trackAreas(feet);
    this.trackLandmarks(feet);
  }

  private trackRegion(feet: Readonly<Vec3>): void {
    const { discovery } = this.state;
    const step = stepRegion(this.currentRegion, regionAt(feet), this.unlocked, discovery.regions);
    this.currentRegion = step.region;
    const entered = step.entered;
    if (entered === null) return;
    if (entered.first) discovery.regions.push(entered.regionId);
    this.bus.emit('area:entered', { regionId: entered.regionId, areaId: entered.regionId, first: entered.first });
    if (entered.first) this.sinks.regionTitle?.(entered.regionId);
  }

  private trackAreas(feet: Readonly<Vec3>): void {
    const inside = this.volumes.at(feet, 'area');
    const flags = this.state.world.flags;
    const entries = newAreaEntries(this.insideAreas, inside.map((v) => v.id), (id) => flags[areaVisitedFlag(id)] === true);
    this.insideAreas = new Set(inside.map((v) => v.id));
    for (const { id, first } of entries) {
      const def = inside.find((v) => v.id === id);
      if (def === undefined) continue;
      flags[areaVisitedFlag(id)] = true;
      this.bus.emit('area:entered', { regionId: def.region, areaId: id, first });
    }
  }

  private trackLandmarks(feet: Readonly<Vec3>): void {
    const { landmarks } = this.state.discovery;
    for (const v of this.volumes.at(feet, 'discovery')) {
      if (landmarks.includes(v.id)) continue;
      landmarks.push(v.id);
      this.bus.emit('landmark:discovered', { landmarkId: v.id, regionId: v.region });
    }
  }
}
