// World POIs besides the Chests (design "World Density·POI", tasks 12.7 and 20.1–20.3; Req 9.4–9.6, 10.8–10.10):
// - Echo_Tablets ('tablet'): a slab with a small collider. Interacting shows its record; the first time it is recorded
//   in GameState `world.echoTablets` (Region n/3), pays the first-discovery XP and, when it completes its Region's three,
//   raises the party's max Stamina by 15 (logic/stamina staminaMax, Req 10.9).
// - Hidden places: the first entry records `discovery.hiddenPlaces` (the map shows it), pays the discovery XP and raises
//   "숨겨진 장소 발견" with its own sound (Req 9.6).
// - Map POIs (camps, puzzles, tablets, Vistas, lore stones, the trial, hidden Elites): the first approach within the
//   POI's radius records it in `discovery.pois`, so the map shows it (Req 33.2).
// - Lore stones ('lore'): 1–2 sentences, the first read pays 5 XP. Caches: breakable by any party hit (device
//   receivers, no Energy or damage numbers), Glim 5–15 from the cache's own stream. Herb bushes ('herb'): one herb
//   dumpling. Both come back with the world refresh after fast travel (regrow()).
// - The Azure Sky Ring Trial ('trial' on its start stone): 8 rings in order within 60 s while gliding; a landing after
//   the first ring or the time running out fails it. Completion is recorded (`world.flags` `trial_<id>`), its glowing
//   Chest appears (the ChestSystem reads trialDone) and a 'puzzle' Milestone save follows (Req 10.10).
// - POI structures (the Breezewatch blade shelf, the isles' lower deck, the lake islet and stones) as static colliders.
// Pure TypeScript: no three.js / DOM.

import { createRng, hashString } from '../core/rng';
import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import type { RegionId, SfxId } from '../data/ids';
import {
  CACHE_GLIM, DENSITY_POIS, DISCOVERABLE_POIS, ECHO_TABLET_BY_ID, ECHO_TABLETS, HERB_ITEM, HIDDEN_PLACE_BAND, HIDDEN_PLACE_SFX,
  HIDDEN_PLACES, LORE_BY_ID, POI_STRUCTURES, SKY_RING_TRIAL, type DensityPoiDef, type PoiStructureDef,
} from '../data/pois';
import type { HitReceiver, ResolvedHit, TargetSample } from '../combat/attackRuntime';
import type { HurtVolume } from '../combat/hitShapes';
import { completedTabletSets, staminaMax, TABLETS_PER_SET } from '../logic/stamina';
import type { GameState } from '../logic/save/gameState';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld } from '../physics/types';
import type { InteractTarget } from '../player/interaction';
import type { ProgressionSystem } from '../progression/progressionSystem';
import type { InventorySystem } from '../inventory/inventorySystem';

/** 'item:granted' source of herb bushes. */
export const HERB_SOURCE = 'herb';
/** Map POIs register when the feet are within this height band of them (m). */
const DISCOVER_BAND = 20;
/** The trial counts the body centre this far above the feet. */
const BODY_CENTRE = 0.9;
/** Tablet slab (m) and interaction reaches. */
export const TABLET_SIZE = { width: 1.1, depth: 0.3, height: 1.5 } as const;
const TABLET_REACH = 0.9;
const LORE_REACH = 0.7;
const HERB_REACH = 0.8;
export const CACHE_SIZE = { radius: 0.45, height: 0.8 } as const;

/** `world.flags` key recording a completed trial. */
export const trialDoneFlag = (id: string): string => `trial_${id}`;

/** What the HUD tells the player about the POIs. */
export type PoiNotice =
  | {
    readonly kind: 'tablet'; readonly id: string; readonly name: string; readonly text: string; readonly region: RegionId;
    readonly found: number; readonly total: number; readonly first: boolean; readonly staminaMax: number | null;
  }
  | { readonly kind: 'lore'; readonly id: string; readonly name: string; readonly text: string; readonly first: boolean }
  | { readonly kind: 'hidden'; readonly id: string; readonly name: string; readonly sfx: SfxId }
  | { readonly kind: 'cache'; readonly id: string; readonly glim: number; readonly pos: Vec3 }
  | { readonly kind: 'herb'; readonly id: string }
  | { readonly kind: 'trialStarted'; readonly rings: number; readonly seconds: number }
  | { readonly kind: 'trialRing'; readonly passed: number; readonly rings: number }
  | { readonly kind: 'trialCompleted'; readonly seconds: number; readonly first: boolean }
  | { readonly kind: 'trialFailed'; readonly reason: 'timeout' | 'landed' };

export interface PoiSystemOptions {
  bus: GameEventBus;
  /**
   * Written: `world.echoTablets`, `discovery.pois`, `discovery.hiddenPlaces`, `stats.placesDiscovered`, the trial's
   * `world.flags` entry.
   */
  state: GameState;
  world: Pick<CollisionWorld, 'addStatic'>;
  ids: ColliderIdSource;
  heightAt: (x: number, z: number) => number;
  progression: Pick<ProgressionSystem, 'grantDiscovery'>;
  inventory: Pick<InventorySystem, 'grant' | 'addGlim'>;
  /** Sets the party's max Stamina (PlayerController.setStaminaMax). */
  setStaminaMax: (max: number) => void;
  notice?: (notice: PoiNotice) => void;
}

/** The trial's run in progress. */
export interface TrialRun {
  readonly next: number;
  readonly elapsed: number;
}

/** A cache or herb for the view. */
export interface DensityView {
  readonly def: DensityPoiDef;
  readonly pos: Readonly<Vec3>;
  /** Broken (cache) or picked (herb) since the last regrow. */
  readonly spent: boolean;
  readonly spentAgo: number | null;
}

export class PoiSystem {
  private readonly o: PoiSystemOptions;
  private readonly unsubscribe: (() => void)[];
  private readonly discovered: Set<string>;
  private readonly hidden: Set<string>;
  private readonly spent = new Map<string, number>();
  private readonly density: { def: DensityPoiDef; pos: Vec3 }[];
  private readonly caches: HitReceiver[] = [];
  private run: { next: number; elapsed: number } | null = null;
  private time = 0;

  constructor(options: PoiSystemOptions) {
    this.o = options;
    const { state, world, ids, heightAt } = options;
    this.discovered = new Set(state.discovery.pois);
    this.hidden = new Set(state.discovery.hiddenPlaces);
    for (const s of POI_STRUCTURES) world.addStatic(structureCollider(s, ids.next(), heightAt));
    for (const t of ECHO_TABLETS) {
      const y = groundY(heightAt, t.pos);
      world.addStatic({
        kind: 'obb', id: ids.next(), center: { x: t.pos.x, y: y + TABLET_SIZE.height / 2 - 0.2, z: t.pos.z },
        half: { x: TABLET_SIZE.width / 2, y: TABLET_SIZE.height / 2 + 0.2, z: TABLET_SIZE.depth / 2 }, yaw: t.yaw,
        flags: { climbable: false, walkableTop: false, blocksCamera: false, material: 'stone' },
      });
    }
    this.density = DENSITY_POIS.map((def) => ({ def, pos: { x: def.pos.x, y: groundY(heightAt, def.pos), z: def.pos.z } }));
    for (const d of this.density) if (d.def.kind === 'cache') this.caches.push(this.cacheReceiver(d.def, d.pos));
    this.unsubscribe = [
      options.bus.on('interact', ({ targetKind, targetId }) => {
        if (targetKind === 'tablet') this.readTablet(targetId);
        else if (targetKind === 'lore') this.readLore(targetId);
        else if (targetKind === 'herb') this.pickHerb(targetId);
        else if (targetKind === 'trial' && targetId === SKY_RING_TRIAL.id) this.startTrial();
      }),
      // A Landmark's first discovery counts as a place (the Victory Screen's statistics).
      options.bus.on('landmark:discovered', () => {
        this.o.state.stats.placesDiscovered += 1;
      }),
    ];
  }

  /** Interaction targets: tablets, lore stones, herb bushes and the trial's start stone. */
  interactTargets(): InteractTarget[] {
    const { state, heightAt } = this.o;
    const out: InteractTarget[] = [];
    for (const t of ECHO_TABLETS) {
      const p = { x: t.pos.x, y: groundY(heightAt, t.pos), z: t.pos.z };
      out.push({
        kind: 'tablet', id: t.id, name: 'Echo_Tablet', a: p, b: p, radius: TABLET_REACH, height: TABLET_SIZE.height,
        detail: () => {
          const found = this.tabletsFound(t.region);
          return state.world.echoTablets.includes(t.id) ? `다시 읽기 · ${found}/${TABLETS_PER_SET}` : `기록 읽기 · ${found}/${TABLETS_PER_SET}`;
        },
        available: () => true,
      });
    }
    for (const d of this.density) {
      if (d.def.kind === 'lore') {
        out.push({
          kind: 'lore', id: d.def.id, name: d.def.name, a: d.pos, b: d.pos, radius: LORE_REACH, height: 1.4,
          detail: () => '읽기', available: () => true,
        });
      } else if (d.def.kind === 'herb') {
        out.push({
          kind: 'herb', id: d.def.id, name: d.def.name, a: d.pos, b: d.pos, radius: HERB_REACH, height: 0.8,
          detail: () => '채집하기', available: () => !this.spent.has(d.def.id),
        });
      }
    }
    const s = SKY_RING_TRIAL.start;
    const start = { x: s.x, y: groundY(heightAt, s), z: s.z };
    out.push({
      kind: 'trial', id: SKY_RING_TRIAL.id, name: SKY_RING_TRIAL.name, a: start, b: start, radius: 0.8, height: 1.6,
      detail: () => (this.trialDone(SKY_RING_TRIAL.id) ? `완료 · 다시 도전 (${SKY_RING_TRIAL.timeLimitSec}초)` : `링 ${SKY_RING_TRIAL.rings.length}개 · 제한 ${SKY_RING_TRIAL.timeLimitSec}초`),
      available: () => this.run === null,
    });
    return out;
  }

  /** The caches as hit targets (every party hit breaks one). */
  hitTargets(): readonly HitReceiver[] {
    return this.caches;
  }

  /** Caches and herbs for the view. */
  densityViews(): DensityView[] {
    return this.density.filter((d) => d.def.kind !== 'lore').map((d) => {
      const at = this.spent.get(d.def.id);
      return { def: d.def, pos: d.pos, spent: at !== undefined, spentAgo: at === undefined ? null : this.time - at };
    });
  }

  /** Lore stones' ground positions for the view. */
  lorePositions(): { id: string; pos: Readonly<Vec3>; read: boolean }[] {
    const read = new Set(this.o.state.discovery.pois);
    return this.density.filter((d) => d.def.kind === 'lore').map((d) => ({ id: d.def.id, pos: d.pos, read: read.has(d.def.id) }));
  }

  /** Whether the trial `id` was completed in this save. */
  trialDone(id: string): boolean {
    return this.o.state.world.flags[trialDoneFlag(id)] === true;
  }

  /** The Sky Ring Trial's run, or null when none is running. */
  get trial(): TrialRun | null {
    return this.run;
  }

  /** Echo_Tablets of `region` found so far. */
  tabletsFound(region: RegionId): number {
    return ECHO_TABLETS.filter((t) => t.region === region && this.o.state.world.echoTablets.includes(t.id)).length;
  }

  /**
   * One sim tick on the Active_Character's feet: map POIs and hidden places entered, the trial's rings and clock.
   * `locked` (a fade, cinematic or dialogue) pauses all of it; `grounded` ends a trial run after its first ring.
   */
  tick(dt: number, feet: Readonly<Vec3>, grounded: boolean, locked: boolean): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.time += step;
    if (locked || !Number.isFinite(feet.x + feet.y + feet.z)) return;
    this.discover(feet);
    this.enterHidden(feet);
    this.stepTrial(step, feet, grounded);
  }

  /** The world refresh after fast travel or a restart: caches and herbs are back, a running trial is dropped. */
  regrow(): void {
    this.spent.clear();
    this.run = null;
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private discover(feet: Readonly<Vec3>): void {
    const { state } = this.o;
    for (const p of DISCOVERABLE_POIS) {
      // A lore stone is on the map once read (its first read also pays its XP).
      if (p.kind === 'lore' || this.discovered.has(p.id)) continue;
      if (Math.abs(feet.y - p.pos.y) > DISCOVER_BAND) continue;
      if (Math.hypot(feet.x - p.pos.x, feet.z - p.pos.z) > p.radius) continue;
      this.discovered.add(p.id);
      if (!state.discovery.pois.includes(p.id)) {
        state.discovery.pois.push(p.id);
        state.stats.placesDiscovered += 1;
      }
    }
  }

  private enterHidden(feet: Readonly<Vec3>): void {
    const { state, progression } = this.o;
    for (const h of HIDDEN_PLACES) {
      if (this.hidden.has(h.id)) continue;
      if (Math.abs(feet.y - h.pos.y) > HIDDEN_PLACE_BAND) continue;
      if (Math.hypot(feet.x - h.pos.x, feet.z - h.pos.z) > h.radius) continue;
      this.hidden.add(h.id);
      if (state.discovery.hiddenPlaces.includes(h.id)) continue;
      state.discovery.hiddenPlaces.push(h.id);
      state.stats.placesDiscovered += 1;
      progression.grantDiscovery('hidden', h.id);
      this.o.notice?.({ kind: 'hidden', id: h.id, name: h.name, sfx: HIDDEN_PLACE_SFX });
    }
  }

  private readTablet(id: string): void {
    const t = ECHO_TABLET_BY_ID.get(id);
    if (t === undefined) return;
    const { state, progression } = this.o;
    const first = !state.world.echoTablets.includes(id);
    let raised: number | null = null;
    if (first) {
      const before = completedTabletSets(state.world.echoTablets);
      state.world.echoTablets.push(id);
      if (!state.discovery.pois.includes(id)) {
        state.discovery.pois.push(id);
        state.stats.placesDiscovered += 1;
      }
      this.discovered.add(id);
      progression.grantDiscovery('tablet', id);
      const after = completedTabletSets(state.world.echoTablets);
      if (after > before) {
        raised = staminaMax(after);
        this.o.setStaminaMax(raised);
      }
    }
    this.o.notice?.({
      kind: 'tablet', id, name: t.name, text: t.text, region: t.region, found: this.tabletsFound(t.region), total: TABLETS_PER_SET,
      first, staminaMax: raised,
    });
  }

  private readLore(id: string): void {
    const l = LORE_BY_ID.get(id);
    if (l === undefined) return;
    const { state, progression } = this.o;
    const first = !state.discovery.pois.includes(id);
    if (first) {
      // Read for the first time in this save: on the map from now on, and its XP (Req 10.1 "작은 스토리 흔적").
      state.discovery.pois.push(id);
      state.stats.placesDiscovered += 1;
      this.discovered.add(id);
      progression.grantDiscovery('lore', id);
    }
    this.o.notice?.({ kind: 'lore', id, name: l.name, text: l.text, first });
  }

  private pickHerb(id: string): void {
    const d = this.density.find((x) => x.def.id === id && x.def.kind === 'herb');
    if (d === undefined || this.spent.has(id)) return;
    this.spent.set(id, this.time);
    this.o.inventory.grant(HERB_ITEM, 1, HERB_SOURCE);
    this.o.notice?.({ kind: 'herb', id });
  }

  private cacheReceiver(def: DensityPoiDef, pos: Vec3): HitReceiver {
    const volume: HurtVolume = { pos, radius: CACHE_SIZE.radius, height: CACHE_SIZE.height };
    const sample: TargetSample = { def: 0, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false };
    return {
      id: def.id,
      device: true,
      hurtVolume: () => volume,
      immune: () => this.spent.has(def.id),
      sample: () => sample,
      receive: (_hit: ResolvedHit) => this.breakCache(def, pos),
    };
  }

  private breakCache(def: DensityPoiDef, pos: Vec3): void {
    if (this.spent.has(def.id)) return;
    this.spent.set(def.id, this.time);
    const glim = createRng(hashString(def.id)).int(CACHE_GLIM[0], CACHE_GLIM[1]);
    this.o.inventory.addGlim(glim);
    this.o.notice?.({ kind: 'cache', id: def.id, glim, pos: { ...pos } });
  }

  private startTrial(): void {
    if (this.run !== null) return;
    this.run = { next: 0, elapsed: 0 };
    this.o.notice?.({ kind: 'trialStarted', rings: SKY_RING_TRIAL.rings.length, seconds: SKY_RING_TRIAL.timeLimitSec });
  }

  private stepTrial(dt: number, feet: Readonly<Vec3>, grounded: boolean): void {
    const run = this.run;
    if (run === null) return;
    const trial = SKY_RING_TRIAL;
    run.elapsed += dt;
    const ring = trial.rings[run.next];
    if (ring !== undefined) {
      const d = Math.hypot(feet.x - ring.x, feet.y + BODY_CENTRE - ring.y, feet.z - ring.z);
      if (d <= trial.ringRadius) {
        run.next += 1;
        this.o.notice?.({ kind: 'trialRing', passed: run.next, rings: trial.rings.length });
      }
    }
    if (run.next >= trial.rings.length) {
      this.run = null;
      const flags = this.o.state.world.flags;
      const first = flags[trialDoneFlag(trial.id)] !== true;
      flags[trialDoneFlag(trial.id)] = true;
      this.o.bus.emit('save:request', { reason: 'puzzle' });
      this.o.notice?.({ kind: 'trialCompleted', seconds: run.elapsed, first });
      return;
    }
    if (run.elapsed >= trial.timeLimitSec) {
      this.run = null;
      this.o.notice?.({ kind: 'trialFailed', reason: 'timeout' });
    } else if (grounded && run.next > 0) {
      this.run = null;
      this.o.notice?.({ kind: 'trialFailed', reason: 'landed' });
    }
  }
}

/** Ground height at a POI (its own y when that is not finite). */
function groundY(heightAt: (x: number, z: number) => number, p: Readonly<Vec3>): number {
  const y = heightAt(p.x, p.z);
  return Number.isFinite(y) ? y : p.y;
}

/** A POI structure's static collider; pillars reach down below the lowest ground around their foot. */
export function structureCollider(s: PoiStructureDef, id: number, heightAt: (x: number, z: number) => number): Collider {
  const flags = { climbable: false, walkableTop: true, blocksCamera: false, material: s.look === 'wood' ? 'wood' : 'stone' } as const;
  const sh = s.shape;
  switch (sh.kind) {
    case 'box':
      return { kind: 'aabb', id, min: { x: sh.minX, y: sh.topY - sh.thickness, z: sh.minZ }, max: { x: sh.maxX, y: sh.topY, z: sh.maxZ }, flags };
    case 'disc':
      return { kind: 'cylinder', id, base: { x: sh.x, y: sh.topY - sh.thickness, z: sh.z }, radius: sh.radius, height: sh.thickness, flags };
    case 'pillar': {
      const r = sh.radius;
      const lowest = Math.min(
        heightAt(sh.x, sh.z), heightAt(sh.x + r, sh.z), heightAt(sh.x - r, sh.z), heightAt(sh.x, sh.z + r), heightAt(sh.x, sh.z - r),
      );
      const base = (Number.isFinite(lowest) ? Math.min(lowest, sh.topY) : sh.topY) - 0.5;
      return { kind: 'cylinder', id, base: { x: sh.x, y: base, z: sh.z }, radius: r, height: sh.topY - base, flags };
    }
  }
}
