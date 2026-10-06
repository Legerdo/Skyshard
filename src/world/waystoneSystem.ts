// Waystones in the World (design "지도 (Map_System)" 빠른 이동; Req 11.1–11.5): the six stones of src/data/waystones.ts
// as interaction targets, what their 'interact' does, and fast travel.
// - Stones: the five ground stones are static colliders placed here; ws_sanctum's stone is a Sanctum piece
//   (src/world/sanctum.ts), so only its interaction target comes from here.
// - Interact, inactive: the activation (Req 11.1): registered in GameState `world.waystones`, 'waystone:activated'
//   (`waystoneId`, `regionId`; the Audio_System's activation sound and the view's light column follow it) and
//   'save:request' ('waystone'). Every interaction, the activation included, restores every Player_Character to full
//   HP and clears Downed (the Party_System's restoreAll) and makes the Waystone the respawn point (Req 11.3).
// - Fast travel (Req 11.4, 11.5): the map queues `fastTravel`; on the next tick requestTravel checks the Waystone is
//   active and that the party is not In_Combat. In_Combat refuses it with "전투 중에는 이동할 수 없습니다". Otherwise the
//   screen fades out for 0.5 s, the tick at the end of the fade-out moves the Active_Character to the spot 2 m in front
//   of the stone on the ground (the adapter teleports it and refreshes the world: respawnWorld, the triggers), and
//   the screen fades back in for 0.5 s: 1 s in all, inside the 3 s allowed. Input stays locked while it runs.
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import { isWaystoneId, type WaystoneId } from '../data/ids';
import { WAYSTONE_LIST, WAYSTONE_STONE, WAYSTONES, type WaystoneDef } from '../data/waystones';
import type { GameState } from '../logic/save/gameState';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { CollisionWorld } from '../physics/types';
import type { InteractTarget } from '../player/interaction';
import type { SafePosition } from '../player/recovery';

/** Fade to black before the move and back in after it (s, Req 11.4). */
export const FAST_TRAVEL_FADE_OUT = 0.5;
export const FAST_TRAVEL_FADE_IN = 0.5;
/** Longest fast travel allowed (s, Req 11.4). */
export const FAST_TRAVEL_MAX_SECONDS = 3;
/** Shown when fast travel is refused In_Combat (Req 11.5). */
export const FAST_TRAVEL_REFUSED_TEXT = '전투 중에는 이동할 수 없습니다';
/** Interaction reach around the stone: its radius plus a hand (m). */
const TARGET_RADIUS = WAYSTONE_STONE.radius + 0.2;
/** Timers within this of their limit have reached it (float slack for summed ticks). */
const TIME_EPS = 1e-6;

/** What the HUD tells the player about a Waystone. */
export type WaystoneNotice =
  | { readonly kind: 'activated'; readonly waystoneId: WaystoneId }
  | { readonly kind: 'rested'; readonly waystoneId: WaystoneId }
  | { readonly kind: 'travelRefused'; readonly waystoneId: WaystoneId; readonly text: string }
  | { readonly kind: 'arrived'; readonly waystoneId: WaystoneId };

export interface WaystoneSystemOptions {
  bus: GameEventBus;
  /** Written: `world.waystones`, `respawn`. */
  state: GameState;
  /** Every Player_Character to full HP, Downed cleared (PartySystem.restoreAll). */
  restoreParty: () => void;
  world: Pick<CollisionWorld, 'addStatic'>;
  ids: ColliderIdSource;
  /** Ground height, for the arrival spot in front of a ground stone. */
  heightAt: (x: number, z: number) => number;
  /** HUD feedback (activation card, rest, refusal message, arrival). */
  notice?: (notice: WaystoneNotice) => void;
}

interface TravelRun {
  readonly waystoneId: WaystoneId;
  readonly spot: SafePosition;
  elapsed: number;
  moved: boolean;
}

export class WaystoneSystem {
  private readonly o: WaystoneSystemOptions;
  private readonly unsubscribe: () => void;
  private run: TravelRun | null = null;
  /** Sim seconds since each Waystone's last activation (the view's light column); absent: never this session. */
  private readonly activatedAt = new Map<WaystoneId, number>();
  private time = 0;

  constructor(options: WaystoneSystemOptions) {
    this.o = options;
    for (const w of WAYSTONE_LIST) {
      if (w.sanctumPiece) continue;
      options.world.addStatic({
        kind: 'cylinder', id: options.ids.next(), base: { x: w.x, y: w.groundY - 0.3, z: w.z },
        radius: WAYSTONE_STONE.radius, height: WAYSTONE_STONE.height + 0.3,
        flags: { climbable: false, walkableTop: false, blocksCamera: false, material: 'stone' },
      });
    }
    this.unsubscribe = options.bus.on('interact', ({ targetKind, targetId }) => {
      if (targetKind === 'waystone' && isWaystoneId(targetId)) this.use(targetId);
    });
  }

  /** Whether the Waystone is activated (registered in GameState). */
  isActive(id: WaystoneId): boolean {
    return this.o.state.world.waystones.includes(id);
  }

  /** Seconds since `id` was activated in this session, or null (the view's activation effect). */
  sinceActivation(id: WaystoneId): number | null {
    const at = this.activatedAt.get(id);
    return at === undefined ? null : this.time - at;
  }

  interactTargets(): InteractTarget[] {
    return WAYSTONE_LIST.map((w): InteractTarget => {
      const pos = { x: w.x, y: w.groundY, z: w.z };
      return {
        kind: 'waystone', id: w.id, name: `${w.name} Waystone`, a: pos, b: pos, radius: TARGET_RADIUS, height: WAYSTONE_STONE.height,
        detail: () => (this.isActive(w.id) ? '휴식하기' : '활성화하기'),
        available: () => this.run === null,
      };
    });
  }

  // ── Fast travel ───────────────────────────────────────────────────────────

  /** A fast travel is running: input stays locked. */
  get travelling(): boolean {
    return this.run !== null;
  }

  /** Screen fade for the overlay: 0 clear … 1 black. */
  get fadeAlpha(): number {
    const run = this.run;
    if (run === null) return 0;
    if (!run.moved) return Math.min(1, Math.max(0, run.elapsed / FAST_TRAVEL_FADE_OUT));
    return Math.min(1, Math.max(0, 1 - (run.elapsed - FAST_TRAVEL_FADE_OUT) / FAST_TRAVEL_FADE_IN));
  }

  /** The spot fast travel and a respawn put the Active_Character at: 2 m in front of the stone, on the ground. */
  arrivalSpot(id: WaystoneId): SafePosition {
    const w: WaystoneDef = WAYSTONES[id];
    const { x, z, groundY, yaw } = w.spot;
    // Ground stones stand on flat pads (the terrain there is the pad height); the Sanctum hall floor is a collider.
    const y = w.sanctumPiece ? groundY : this.o.heightAt(x, z);
    return { pos: { x, y: Number.isFinite(y) ? y : groundY, z }, yaw };
  }

  /**
   * The `fastTravel` UiCommand, on the tick after it was queued: refused In_Combat (the message, Req 11.5), ignored
   * for an inactive Waystone or while a travel runs; otherwise the fade-out begins. Returns whether it began.
   */
  requestTravel(id: WaystoneId, inCombat: boolean): boolean {
    if (this.run !== null || !this.isActive(id)) return false;
    if (inCombat) {
      this.o.notice?.({ kind: 'travelRefused', waystoneId: id, text: FAST_TRAVEL_REFUSED_TEXT });
      return false;
    }
    this.run = { waystoneId: id, spot: this.arrivalSpot(id), elapsed: 0, moved: false };
    return true;
  }

  /**
   * One sim tick of a running travel. Returns the spot on the one tick the Active_Character must be moved (the end
   * of the fade-out); the adapter teleports it there and refreshes the world. null on every other tick.
   */
  tickTravel(dt: number): SafePosition | null {
    this.time += Number.isFinite(dt) && dt > 0 ? dt : 0;
    const run = this.run;
    if (run === null || !(dt > 0) || !Number.isFinite(dt)) return null;
    run.elapsed += dt;
    let move: SafePosition | null = null;
    if (!run.moved && run.elapsed >= FAST_TRAVEL_FADE_OUT - TIME_EPS) {
      run.moved = true;
      move = { pos: { ...run.spot.pos }, yaw: run.spot.yaw };
    }
    if (run.moved && run.elapsed >= FAST_TRAVEL_FADE_OUT + FAST_TRAVEL_FADE_IN - TIME_EPS) {
      this.run = null;
      this.o.notice?.({ kind: 'arrived', waystoneId: run.waystoneId });
    }
    return move;
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** 'interact' on a Waystone: activation the first time, then healing and the respawn point every time. */
  private use(id: WaystoneId): void {
    const { state, bus } = this.o;
    const first = !this.isActive(id);
    if (first) {
      state.world.waystones.push(id);
      this.activatedAt.set(id, this.time);
      bus.emit('waystone:activated', { waystoneId: id, regionId: WAYSTONES[id].region });
    }
    this.o.restoreParty();
    state.respawn = { kind: 'waystone', id };
    if (first) bus.emit('save:request', { reason: 'waystone' });
    this.o.notice?.({ kind: first ? 'activated' : 'rested', waystoneId: id });
  }
}
