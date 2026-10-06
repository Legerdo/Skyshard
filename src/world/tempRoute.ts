// TEMPORARY route pieces and lift pads (src/data/tempRoute.ts; task 4.9 M2 minimal route). The pieces become
// static colliders of the session's CollisionWorld (towers and rims are walls, platforms and floors have walkable
// tops); each lift pad becomes an interaction target (kind 'lift'). Using a pad ('interact' kind 'lift') asks for
// the fade move to its destination through the injected `move` (RecoverySystem.restorePlayer('lift', spot)).
// Heights given as 'ground' are read from the terrain once, here. Removed with tasks 9.1 / 9.3 / 9.6–9.8.
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import {
  TEMP_LIFT_PAD_RADIUS, TEMP_LIFTS, TEMP_PIECES, type PointRef, type SpotRef, type TempLiftDef, type TempPieceDef,
} from '../data/tempRoute';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld, SurfaceMaterial } from '../physics/types';
import type { InteractTarget } from '../player/interaction';
import type { SafePosition } from '../player/recovery';

/** Height of a lift pad's interaction target (m). */
const PAD_HEIGHT = 2;

/** Prompt status line: which movement the pad stands in for. */
const LIFT_DETAIL: Readonly<Record<TempLiftDef['stands'], string>> = {
  // Task 24.5 review: the prompt names the route, not that it is a stand-in.
  climb: '바위 발판을 타고 오른다',
  glide: '바람을 타고 활강한다',
  updraft: '별빛 기류를 타고 오른다',
};

/** Resolves a data point: 'ground' is the terrain height at (x, z). */
export function resolvePoint(p: PointRef, heightAt: (x: number, z: number) => number): Vec3 {
  return { x: p.x, y: p.y === 'ground' ? heightAt(p.x, p.z) : p.y, z: p.z };
}

export function resolveSpot(s: SpotRef, heightAt: (x: number, z: number) => number): SafePosition {
  return { pos: resolvePoint(s, heightAt), yaw: s.yaw };
}

const MATERIAL: Readonly<Record<TempPieceDef['look'], SurfaceMaterial>> = { wood: 'wood', stone: 'stone', crystal: 'crystal', starlight: 'crystal' };

/** A piece as a static collider (never climbable; towers, spires and rims block the camera). */
export function tempPieceCollider(piece: TempPieceDef, id: number): Collider {
  const flags = { climbable: false, walkableTop: piece.walkableTop, blocksCamera: !piece.walkableTop, material: MATERIAL[piece.look] };
  const s = piece.shape;
  switch (s.kind) {
    case 'box':
      return { kind: 'aabb', id, min: { ...s.min }, max: { ...s.max }, flags };
    case 'obb':
      return { kind: 'obb', id, center: { ...s.center }, half: { ...s.half }, yaw: s.yaw, flags };
    case 'cylinder':
      return { kind: 'cylinder', id, base: { ...s.base }, radius: s.radius, height: s.height, flags };
  }
}

/** Conditions a lift can wait for. */
export interface TempRouteProgress {
  stairActive(): boolean;
  puzzleSolved(puzzleId: string): boolean;
}

export interface TempRouteOptions {
  world: Pick<CollisionWorld, 'addStatic'>;
  ids: ColliderIdSource;
  bus: GameEventBus;
  heightAt: (x: number, z: number) => number;
  progress: TempRouteProgress;
  /** Starts the fade move onto a lift's destination; false when another move is running. */
  move(spot: SafePosition): boolean;
  pieces?: readonly TempPieceDef[];
  lifts?: readonly TempLiftDef[];
}

/** A built lift: its data, the resolved pad centre and destination. */
export interface TempLift {
  readonly def: TempLiftDef;
  readonly pad: Vec3;
  readonly to: SafePosition;
}

export class TempRoute {
  readonly lifts: readonly TempLift[];
  private readonly progress: TempRouteProgress;
  private readonly byId: ReadonlyMap<string, TempLift>;
  private readonly unsubscribe: () => void;

  constructor(options: TempRouteOptions) {
    this.progress = options.progress;
    for (const piece of options.pieces ?? TEMP_PIECES) options.world.addStatic(tempPieceCollider(piece, options.ids.next()));
    this.lifts = (options.lifts ?? TEMP_LIFTS).map((def) => ({
      def,
      pad: resolvePoint(def.pad, options.heightAt),
      to: resolveSpot(def.to, options.heightAt),
    }));
    this.byId = new Map(this.lifts.map((l) => [l.def.id, l]));
    this.unsubscribe = options.bus.on('interact', (p) => {
      if (p.targetKind !== 'lift') return;
      const lift = this.byId.get(p.targetId);
      if (lift !== undefined && this.offered(lift.def)) options.move(lift.to);
    });
  }

  /** Whether a lift is offered now. */
  offered(def: TempLiftDef): boolean {
    switch (def.when.kind) {
      case 'always':
        return true;
      case 'stairActive':
        return this.progress.stairActive();
      case 'puzzleSolved':
        return this.progress.puzzleSolved(def.when.puzzleId);
    }
  }

  /** The lift pads as interaction targets (kind 'lift'). */
  interactTargets(): InteractTarget[] {
    return this.lifts.map((lift) => ({
      kind: 'lift',
      id: lift.def.id,
      name: lift.def.name,
      a: lift.pad,
      b: lift.pad,
      radius: TEMP_LIFT_PAD_RADIUS,
      height: PAD_HEIGHT,
      detail: () => LIFT_DETAIL[lift.def.stands],
      available: () => this.offered(lift.def),
    }));
  }

  dispose(): void {
    this.unsubscribe();
  }
}
