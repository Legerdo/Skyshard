// GateSystem: Blight_Barrier gates, Blight veils and the Sanctum seal (design "진행 게이트"; Req 4.5, 4.6, 4.9,
// 5.2, 5.5, 2.7). Whether each barrier is open is derived from GameState every time (logic/gates); `refresh`
// applies the result:
// - closed → open, animated (a Skyshard or the altar just changed it): 'barrier:opened' is published at once,
//   the shatter VFX plays for the kind's BARRIER_SHATTER_SECONDS, and only then are the colliders removed.
//   Lifting seal_sanctum raises the Starlit_Stair at that point.
// - closed → open on load (`animate: false`): the colliders are removed at once, without event or VFX.
// - open → closed (loading an earlier save in the same session): the colliders come back at once.
// `tick` runs the shatter timers and calls `refresh` whenever the Skyshard count or the altar flag changed,
// so the barriers follow GameState whoever changed it. Walls and the seal are dynamic colliders (design
// "충돌 primitive와 질의"): not climbable, and only the gate walls block the camera. Pure TypeScript: no DOM.

import { yawFromDir } from '../core/math';
import type { GameEventBus } from '../core/gameEvents';
import { BARRIERS, wallPieces, type BarrierDef, type BarrierKind, type GateDef, type WallPiece } from '../data/barriers';
import { BARRIER_IDS, type BarrierId } from '../data/ids';
import { barrierPromptText, isBarrierOpen, type WorldProgress } from '../logic/gates';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld } from '../physics/types';
import type { InteractTarget } from '../player/interaction';

/** Length of the shatter / dissolve VFX before the colliders go (s). */
export const BARRIER_SHATTER_SECONDS: Readonly<Record<BarrierKind, number>> = { gate: 1.6, veil: 2.4, seal: 3 };

export type BarrierPhase = 'closed' | 'shattering' | 'open';

/** What the render and map read: the phase and, while shattering, how far the VFX got (0..1). */
export interface BarrierView {
  readonly id: BarrierId;
  readonly kind: BarrierKind;
  readonly phase: BarrierPhase;
  readonly progress: number;
}

/** Hook raised when seal_sanctum's colliders go (true) or come back (false): the Starlit_Stair. */
export interface SealListener {
  setActive(active: boolean): void;
}

export interface GateSystemOptions {
  world: Pick<CollisionWorld, 'upsertDynamic' | 'removeDynamic'>;
  bus: GameEventBus;
  ids: ColliderIdSource;
  /** GameState at construction (New Game or load): barriers already open are removed without effects. */
  progress: WorldProgress;
  stair?: SealListener;
  defs?: Readonly<Record<BarrierId, BarrierDef>>;
}

interface BarrierState {
  readonly def: BarrierDef;
  readonly colliders: readonly Collider[];
  phase: BarrierPhase;
  /** Seconds into the shatter. */
  elapsed: number;
  /** Colliders are in the world. */
  solid: boolean;
}

/** A wall piece as a yaw-rotated box: local +Z along a → b, x across the thickness. */
function wallCollider(piece: WallPiece, id: number, blocksCamera: boolean): Collider {
  const dx = piece.b.x - piece.a.x;
  const dz = piece.b.z - piece.a.z;
  return {
    kind: 'obb',
    id,
    center: { x: (piece.a.x + piece.b.x) / 2, y: (piece.bottomY + piece.topY) / 2, z: (piece.a.z + piece.b.z) / 2 },
    half: { x: piece.thickness / 2, y: (piece.topY - piece.bottomY) / 2, z: Math.hypot(dx, dz) / 2 },
    yaw: yawFromDir(dx, dz),
    flags: { climbable: false, walkableTop: false, blocksCamera, material: 'crystal' },
  };
}

/** The colliders a barrier is made of, with ids drawn from `ids`. */
export function barrierColliders(def: BarrierDef, ids: ColliderIdSource): Collider[] {
  if (def.kind === 'seal') {
    return [{
      kind: 'sphere', id: ids.next(), center: { ...def.center }, radius: def.radius,
      flags: { climbable: false, walkableTop: false, blocksCamera: false, material: 'crystal' },
    }];
  }
  return wallPieces(def).map((piece) => wallCollider(piece, ids.next(), def.kind === 'gate'));
}

export class GateSystem {
  private readonly world: GateSystemOptions['world'];
  private readonly bus: GameEventBus;
  private readonly stair: SealListener | undefined;
  private readonly defs: Readonly<Record<BarrierId, BarrierDef>>;
  private readonly states: ReadonlyMap<BarrierId, BarrierState>;
  private last: WorldProgress;

  constructor(options: GateSystemOptions) {
    this.world = options.world;
    this.bus = options.bus;
    this.stair = options.stair;
    const defs = options.defs ?? BARRIERS;
    this.defs = defs;
    this.states = new Map(
      BARRIER_IDS.map((id): [BarrierId, BarrierState] => {
        const def = defs[id];
        return [id, { def, colliders: barrierColliders(def, options.ids), phase: 'closed', elapsed: 0, solid: false }];
      }),
    );
    for (const s of this.states.values()) this.setSolid(s, true);
    this.last = { skyshards: options.progress.skyshards, altarActivated: options.progress.altarActivated };
    this.refresh(options.progress, { animate: false });
  }

  /**
   * Re-derives every barrier from `p` (Req 2.7). Newly opened barriers shatter (`animate`, default) or
   * vanish at once (a load); barriers that should be closed are restored at once.
   */
  refresh(p: WorldProgress, options: { animate?: boolean } = {}): void {
    const animate = options.animate ?? true;
    this.last = { skyshards: p.skyshards, altarActivated: p.altarActivated };
    for (const [id, s] of this.states) {
      const open = isBarrierOpen(id, p, this.defs);
      if (open && s.phase === 'closed') {
        if (animate) {
          s.phase = 'shattering';
          s.elapsed = 0;
          this.bus.emit('barrier:opened', { barrierId: id, regionId: s.def.region });
        } else {
          this.finishOpening(s);
        }
      } else if (!open && s.phase !== 'closed') {
        s.phase = 'closed';
        s.elapsed = 0;
        this.setSolid(s, true);
        if (s.def.kind === 'seal') this.stair?.setActive(false);
      }
    }
  }

  /** One sim tick: re-derives the barriers when `p` changed since the last refresh, then runs the shatter timers. */
  tick(dt: number, p?: WorldProgress): void {
    if (p !== undefined && (p.skyshards !== this.last.skyshards || p.altarActivated !== this.last.altarActivated)) this.refresh(p);
    if (!(Number.isFinite(dt) && dt > 0)) return;
    for (const s of this.states.values()) {
      if (s.phase !== 'shattering') continue;
      s.elapsed += dt;
      if (s.elapsed >= BARRIER_SHATTER_SECONDS[s.def.kind] - 1e-9) this.finishOpening(s);
    }
  }

  phase(id: BarrierId): BarrierPhase {
    return this.states.get(id)?.phase ?? 'open';
  }

  /** Whether the barrier's colliders are in the world (closed or still shattering). */
  isSolid(id: BarrierId): boolean {
    return this.states.get(id)?.solid ?? false;
  }

  /** Collider ids of a barrier (render tests, debug). */
  colliderIds(id: BarrierId): number[] {
    return this.states.get(id)?.colliders.map((c) => c.id) ?? [];
  }

  /** Every barrier's phase and shatter progress, in registry order. */
  views(): BarrierView[] {
    return [...this.states.values()].map((s) => ({
      id: s.def.id,
      kind: s.def.kind,
      phase: s.phase,
      progress: s.phase === 'shattering' ? Math.min(1, s.elapsed / BARRIER_SHATTER_SECONDS[s.def.kind]) : s.phase === 'open' ? 1 : 0,
    }));
  }

  /**
   * Prompt targets for the gate walls (Req 4.9): offered while the gate is closed, along the wall's length,
   * with "Skyshard n/필요 수" from `progress` as the status line.
   */
  gateTargets(progress: () => WorldProgress): InteractTarget[] {
    const out: InteractTarget[] = [];
    for (const s of this.states.values()) {
      if (s.def.kind !== 'gate') continue;
      const def: GateDef = s.def;
      out.push({
        kind: 'barrier',
        id: def.id,
        name: def.name,
        a: { x: def.span.a.x, y: def.groundY, z: def.span.a.z },
        b: { x: def.span.b.x, y: def.groundY, z: def.span.b.z },
        radius: def.thickness / 2,
        height: def.topY - def.groundY,
        detail: () => barrierPromptText(def, progress()),
        available: () => s.phase === 'closed',
      });
    }
    return out;
  }

  private finishOpening(s: BarrierState): void {
    s.phase = 'open';
    s.elapsed = 0;
    this.setSolid(s, false);
    if (s.def.kind === 'seal') this.stair?.setActive(true);
  }

  private setSolid(s: BarrierState, solid: boolean): void {
    if (s.solid === solid) return;
    s.solid = solid;
    for (const c of s.colliders) {
      if (solid) this.world.upsertDynamic(c);
      else this.world.removeDynamic(c.id);
    }
  }
}
