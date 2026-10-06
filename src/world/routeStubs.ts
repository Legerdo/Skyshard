// TEMPORARY route stand-ins (src/data/routeStubs.ts; task 4.9 M2 minimal route): the three Skyshard pedestals as
// interaction targets, and what their 'interact' does:
// - skyshard: offered once Skyshard index − 1 is held and its `skyshard` Objective is current (the guardian is
//   down). Taking it raises GameState.skyshards to the index and publishes 'skyshard:acquired' (HUD n/3, the
//   acquisition cinematic, Quest) and 'save:request' ('skyshard'); GateSystem.tick re-derives the barriers from
//   the new count and opens gate_ember / gate_azure with their veils (Req 4.3, 4.5, 4.6).
// The NPC talk stubs are gone: the NPCs (src/world/npcSystem.ts) and the Dialogue_System (src/dialogue) took them over
// in tasks 13.1–13.2. The Sanctum mural is part of the connecting hall (src/world/sanctum.ts); the Challenge_Area
// puzzles are real Puzzle_Mechanisms (tasks 9.6–9.8). Pedestals are small static colliders. Pure TypeScript: no
// three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import { SKYSHARD_PEDESTALS, skyshardTargetId, type SkyshardPedestalDef } from '../data/routeStubs';
import type { ObjectiveTrigger } from '../logic/quest/types';
import type { GameState } from '../logic/save/gameState';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { CollisionWorld } from '../physics/types';
import type { InteractTarget } from '../player/interaction';
import type { ObjectiveView } from '../quest/questSystem';
import { resolvePoint } from './tempRoute';

/** Interaction size of a pedestal (m). */
export const STUB_DEVICE_RADIUS = 0.5;
export const STUB_DEVICE_HEIGHT = 1.1;

export interface RouteStubsOptions {
  bus: GameEventBus;
  /** Written: skyshards. */
  state: GameState;
  /** The Quest_System: the current Main_Quest Objective. */
  quests: { objectiveView(): ObjectiveView | null };
  world: Pick<CollisionWorld, 'addStatic'>;
  ids: ColliderIdSource;
  heightAt: (x: number, z: number) => number;
}

/** A built stub: its data and resolved position. */
export interface PlacedStub<D> {
  readonly def: D;
  readonly pos: Vec3;
}

export class RouteStubs {
  readonly pedestals: readonly PlacedStub<SkyshardPedestalDef>[];
  private readonly o: RouteStubsOptions;
  private readonly unsubscribe: () => void;

  constructor(options: RouteStubsOptions) {
    this.o = options;
    this.pedestals = SKYSHARD_PEDESTALS.map((def) => ({ def, pos: resolvePoint(def.pos, options.heightAt) }));
    for (const { pos } of this.pedestals) {
      options.world.addStatic({
        kind: 'cylinder', id: options.ids.next(), base: { x: pos.x, y: pos.y - 0.2, z: pos.z }, radius: STUB_DEVICE_RADIUS * 0.8,
        height: STUB_DEVICE_HEIGHT + 0.2, flags: { climbable: false, walkableTop: false, blocksCamera: false, material: 'stone' },
      });
    }
    this.unsubscribe = options.bus.on('interact', ({ targetKind, targetId }) => {
      if (targetKind === 'skyshard') this.takeSkyshard(targetId);
    });
  }

  /** Whether the Skyshard still rests on its pedestal. */
  pedestalFull(def: SkyshardPedestalDef): boolean {
    return this.o.state.skyshards < def.index;
  }

  interactTargets(): InteractTarget[] {
    return this.pedestals.map(({ def, pos }): InteractTarget => ({
      kind: 'skyshard', id: skyshardTargetId(def.index), name: 'Skyshard', a: pos, b: pos, radius: STUB_DEVICE_RADIUS,
      height: STUB_DEVICE_HEIGHT + 0.8, detail: () => '손을 뻗어 얻기', available: () => this.canTake(def),
    }));
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Whether the tracked Main_Quest Objective has this trigger. */
  private current(match: (t: ObjectiveTrigger) => boolean): boolean {
    const view = this.o.quests.objectiveView();
    return view !== null && view.questId === 'main' && match(view.objective.trigger);
  }

  private canTake(def: SkyshardPedestalDef): boolean {
    return this.o.state.skyshards === def.index - 1 && this.current((t) => t.kind === 'skyshard' && t.index === def.index);
  }

  private takeSkyshard(targetId: string): void {
    const pedestal = this.pedestals.find((p) => skyshardTargetId(p.def.index) === targetId);
    if (pedestal === undefined || !this.canTake(pedestal.def)) return;
    this.acquire(pedestal.def);
  }

  /**
   * Task 22.1 (Debug_Tools "Skyshard 지급"): the next Skyshard through the same acquisition as its pedestal, without
   * waiting for its Objective. False when all three are held.
   */
  acquireNext(): boolean {
    const next = this.pedestals.find((p) => p.def.index === this.o.state.skyshards + 1);
    if (next === undefined) return false;
    this.acquire(next.def);
    return true;
  }

  private acquire(def: SkyshardPedestalDef): void {
    const { index, region } = def;
    this.o.state.skyshards = index;
    this.o.bus.emit('skyshard:acquired', { index, regionId: region });
    this.o.bus.emit('save:request', { reason: 'skyshard' });
  }
}
