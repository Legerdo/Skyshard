// Challenge_Area runtime (design "Challenge Areas·Puzzles", "체크포인트와 실패 처리"; Req 12.1, 12.2, 12.7–12.9, 13.8):
// the World side of each area in src/data/challengeAreas.ts (Hollowroot Shrine, Cinderspire, Starfall Observatory).
// Built once per session; its tick runs after the puzzles and before CollisionResolve (so a fall starts its fade in the
// same tick):
// - Pieces: static colliders: Hollowroot's root walls and canopy slabs (none climbable), Cinderspire's spires, ramp
//   steps and summit (the spire rock and crystal faces climbable, the hot block around the Heat_Crystal wall not).
// - Heat_Crystal walls (Cinderspire H1): a HeatCrystalWall over the wall's puzzle device, synced every tick on the
//   ReceiverField's clock, so the collider is climbable exactly while the device is cooled (10 s after Tide) and a
//   climber on a wall that heats up again loses it and falls (Req 13.8). Its view carries the last-2 s warning.
// - Doors: solid boxes while closed, removed while open. The condition is read every tick (a solved puzzle, a weight
//   puzzle's plates held, a combat room not locked / cleared, the guardian Elite defeated, the area's Skyshard held).
//   A door never closes on the Active_Character's capsule: it waits until they stepped out of it.
// - Risers: dynamic boxes that stand while their condition holds (Skyshard held, a puzzle part broken open): the
//   Cinderspire exit stairs after Skyshard 2 and the vent ledges freed by the Unstable_Crystal blasts. Like a door, a
//   riser never appears inside the Active_Character's capsule.
// - Lifts: interaction pads (kind 'lift'); using an offered one fades the character onto its destination through
//   RecoverySystem.restorePlayer('lift', spot). Their conditions are the doors' (Hollowroot's exit lift runs once the
//   area's Skyshard is held, Req 12.9; the Observatory's way down is shut while its waves fight).
// - Checkpoint runes (radius 2 m): feet on a lit rune make it the area's latest checkpoint, recorded as
//   GameState.checkpoint { area, id } ('checkpoint:reached'). While the feet are inside the area's bounds the latest
//   checkpoint — the area entrance before the first — is registered with setCheckpointOverride, so falls, the terrain
//   and boundary checks and a stuck body all return there (Req 12.8); leaving the bounds clears it.
// - Fall judgement: feet in one of the area's `hazard` volumes ask for restorePlayer('hazard') while its Skyshard is
//   not held; after that the judgement is off so leaving the area is never punished (design).
// - Combat rooms: the Active_Character inside the floor of a room whose group is alive locks it (its `roomUnlocked`
//   doors close); members that wandered out are put back at their spawn first, so the whole fight is inside. The
//   lock ends with the group's 'camp:cleared' — recorded as the `cleared_<group>` flag, so a cleared room stays open
//   after a restart or a load — or when the character is no longer inside (a recovery moved them).
// - Wave rooms (the Observatory's ring corridor, Req 12.3): stepping inside an uncleared one locks it at once and calls
//   its first wave not cleared yet (`spawnGroup` through `rooms.spawn`); each wave's 'camp:cleared' is recorded as its
//   `cleared_<wave>` flag and calls the next wave `waveDelay` s later (on the devices' clock); the last wave's clear is
//   the room's. A wave already placed is never placed again while its clear is still on its way.
// - Ceiling constellations (the Observatory's hall): each glows in its turn in the colour of its step of the puzzle's
//   order (the save-seeded order the PuzzleSystem holds), repeating; all of them glow once the puzzle is solved.
// - Party_Wipe restart: restartSpot() is the checkpoint to put the party on; restart() drops the running room locks and
//   pending waves (the SpawnerSystem puts the uncleared fight back at full HP). Solved puzzles, cleared rooms and waves
//   and defeated Elites keep their state in GameState.
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import {
  CHALLENGE_AREA_DEFS, CHECKPOINT_HEIGHT_BAND, CONSTELLATION_TIMING, type AreaCondition, type AreaDoorDef, type AreaLiftDef, type AreaLook,
  type AreaShape, type AreaSpot, type ChallengeAreaDef, type CheckpointDef, type CombatRoomDef, type ConstellationDef, type HeatWallDef,
  type RiserDef,
} from '../data/challengeAreas';
import type { ChallengeAreaId, ElementId, EntityId, MusicId } from '../data/ids';
import { HEAT_CRYSTAL_WARNING_SECONDS } from '../data/receivers';
import { TEMP_LIFT_PAD_RADIUS } from '../data/tempRoute';
import { constellationStepAt } from '../logic/puzzle';
import type { GameState } from '../logic/save/gameState';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld, SurfaceMaterial } from '../physics/types';
import { CAPSULE_HEIGHT, CAPSULE_RADIUS } from '../player/core/constants';
import type { InteractTarget } from '../player/interaction';
import type { RecoverySystem, SafePosition } from '../player/recovery';
import { HeatCrystalWall, type HeatCrystalState } from './heatCrystal';
import type { VolumeIndex } from './volumeIndex';

/** GameState `world.flags` key recording that a Challenge_Area combat room's group was cleared. */
export function roomClearedFlag(groupId: string): string {
  return `cleared_${groupId}`;
}

/** GameState `world.flags` key recording that a checkpoint rune was activated once. */
export function checkpointFlag(checkpointId: string): string {
  return `checkpoint_${checkpointId}`;
}

/** A lift pad's interaction target height (m). */
const LIFT_PAD_HEIGHT = 2;
/** A locked room lets the character go only this far past its floor radius before the lock ends (m). */
const ROOM_LOCK_MARGIN = 3;
/** Room members farther than this past the floor radius are put back when the room locks (m). */
const ROOM_MEMBER_MARGIN = 1.5;
/** Feet within this height of a room's floor count as inside it (m). */
const ROOM_HEIGHT_BAND = 3;

/** A living enemy of a combat room's group. */
export interface RoomMember {
  readonly id: EntityId;
  readonly pos: Readonly<Vec3>;
}

export interface ChallengeAreaOptions {
  bus: GameEventBus;
  /** Written: checkpoint, world.flags (cleared rooms, activated runes). Read: skyshards, world.elites. */
  state: GameState;
  world: Pick<CollisionWorld, 'addStatic' | 'upsertDynamic' | 'removeDynamic'>;
  ids: ColliderIdSource;
  /** Holds the areas' bounds (`area` volumes) and fall judgement (`hazard` volumes). */
  volumes: Pick<VolumeIndex, 'at'>;
  recovery: Pick<RecoverySystem, 'setCheckpointOverride' | 'restorePlayer'>;
  /**
   * The PuzzleSystem: solved puzzles and open targets, whether a part still stands, and the Heat_Crystal walls'
   * devices (a heatCrystal DeviceReceiver).
   */
  puzzles: {
    isSolved(id: string): boolean;
    isOpen(target: string): boolean;
    partPresent(partId: string): boolean;
    device(partId: string): HeatWallDevice | null;
    /** A sequence puzzle's order (the Observatory's comes from the save seed), null for an unknown one. */
    sequenceOrder(id: string): readonly ElementId[] | null;
  };
  /** The devices' clock (the ReceiverField): Heat_Crystal cooling and the wave delays run on it. */
  clock: { readonly time: number };
  /**
   * Living members of an encounter group, putting one back at its spawn (EnemySystem.reset), and placing a wave room's
   * next wave (`spawnGroup`, SpawnerSystem.activate).
   */
  rooms: { members(groupId: string): RoomMember[]; resetMember(id: EntityId): void; spawn(groupId: string): void };
  defs?: readonly ChallengeAreaDef[];
}

/** The Active_Character's feet this tick. */
export interface ChallengeAreaBody {
  readonly pos: Readonly<Vec3>;
}

/** A Heat_Crystal wall's device: cooled state and the cooling left (a heatCrystal DeviceReceiver). */
export interface HeatWallDevice extends HeatCrystalState {
  cooledLeft(now: number): number;
}

interface PlacedDoor {
  readonly def: AreaDoorDef;
  readonly body: Collider;
  solid: boolean;
}

interface PlacedHeatWall {
  readonly def: HeatWallDef;
  readonly device: HeatWallDevice;
  readonly wall: HeatCrystalWall;
}

interface PlacedRiser {
  readonly def: RiserDef;
  readonly body: Collider;
  up: boolean;
}

interface AreaState {
  readonly def: ChallengeAreaDef;
  readonly doors: PlacedDoor[];
  readonly heatWalls: PlacedHeatWall[];
  readonly risers: PlacedRiser[];
  latest: CheckpointDef | null;
  readonly locked: Set<string>;
  /** Wave room → devices-clock time from which its next wave may come (after the previous wave's clear). */
  readonly waveAt: Map<string, number>;
  /** Wave room → the wave placed last in this run (not placed again while its 'camp:cleared' is on its way). */
  readonly wavePlaced: Map<string, string>;
}

/** A ceiling constellation as the render draws it. */
export interface ConstellationView {
  readonly def: ConstellationDef;
  /** The Element of its step of the puzzle's order; null when the puzzle has no such step. */
  readonly element: ElementId | null;
  /** Glowing now: its turn in the repeating order, or always once the puzzle is solved. */
  readonly lit: boolean;
  readonly solved: boolean;
}

/** A Heat_Crystal wall as the render draws it. */
export interface HeatWallView {
  readonly def: HeatWallDef;
  /** Cooled: climbable, no heat (Req 13.8). */
  readonly cooled: boolean;
  /** Seconds of cooling left (Infinity once its puzzle is solved), 0 while hot. */
  readonly cooledLeft: number;
  /** The last HEAT_CRYSTAL_WARNING_SECONDS of the cooling: the wall flashes orange. */
  readonly warning: boolean;
}

/** A riser as the render draws it. */
export interface RiserView {
  readonly def: RiserDef;
  /** Standing (its collider is in the world). */
  readonly up: boolean;
}

/** A door as the render draws it. */
export interface AreaDoorView {
  readonly def: AreaDoorDef;
  readonly open: boolean;
}

/** A checkpoint rune as the render draws it. */
export interface CheckpointView {
  readonly def: CheckpointDef;
  readonly area: ChallengeAreaId;
  /** Lit (it can be activated). */
  readonly lit: boolean;
  /** The area's latest checkpoint. */
  readonly latest: boolean;
}

/** A root lift as the render and the route bot see it. */
export interface AreaLift {
  readonly def: AreaLiftDef;
  readonly pad: Vec3;
  readonly to: SafePosition;
}

const copySpot = (s: AreaSpot): SafePosition => ({ pos: { ...s.pos }, yaw: s.yaw });

/** Surface material by look: roots are wood, Cinderspire's rock is ash rock, its crystal crystal. */
const LOOK_MATERIAL: Readonly<Record<AreaLook, SurfaceMaterial>> = {
  rootWall: 'wood', canopy: 'wood', bramble: 'wood', rootDoor: 'wood', rubble: 'stone', rootGate: 'wood',
  spireRock: 'ashRock', spireCrystal: 'crystal', hotCrystal: 'crystal', crystalStep: 'crystal', summitFloor: 'ashRock',
  crystalCage: 'crystal', ventLedge: 'ashRock', exitStair: 'crystal',
  obsStone: 'stone', obsFloor: 'stone', obsStep: 'stone', obsParapet: 'stone', obsDrum: 'stone', obsOculus: 'crystal',
  telescope: 'stone', starBarrier: 'crystal', starCage: 'crystal', balconyGate: 'stone',
};

/**
 * Task 24.6: looks the follow camera passes. The Observatory's 2 m parapets (ring corridor, landing, dome) stand below
 * the camera at its default pitch (≈ 3 m above the floor at 5.5 m), and its starlight barriers and the Skyshard's star
 * cage are light and bars the view reads through; yet the camera's sweep from the shoulder hit them whenever a fight
 * pressed the character against one, pulling the camera to under 1 m from the character (the playthrough measured 8
 * such episodes in the wave and Sentinel Prime fights).
 */
const CAMERA_PASSES: ReadonlySet<AreaLook> = new Set<AreaLook>(['obsParapet', 'starBarrier', 'starCage']);

function shapeCollider(shape: AreaShape, id: number, walkableTop: boolean, look: AreaLook, climbable = false): Collider {
  const flags = { climbable, walkableTop, blocksCamera: !CAMERA_PASSES.has(look), material: LOOK_MATERIAL[look] };
  return shape.kind === 'obb'
    ? { kind: 'obb', id, center: { ...shape.center }, half: { ...shape.half }, yaw: shape.yaw, flags }
    : { kind: 'cylinder', id, base: { ...shape.base }, radius: shape.radius, height: shape.height, flags };
}

/** Whether a standing capsule at `feet` overlaps the box (door-local test with the capsule radius). */
export function capsuleInBox(shape: Extract<AreaShape, { kind: 'obb' }>, feet: Readonly<Vec3>): boolean {
  const dx = feet.x - shape.center.x;
  const dz = feet.z - shape.center.z;
  const c = Math.cos(shape.yaw);
  const s = Math.sin(shape.yaw);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const r = CAPSULE_RADIUS;
  return Math.abs(lx) <= shape.half.x + r && Math.abs(lz) <= shape.half.z + r
    && feet.y + CAPSULE_HEIGHT >= shape.center.y - shape.half.y && feet.y <= shape.center.y + shape.half.y;
}

const flat = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(a.x - b.x, a.z - b.z);

export class ChallengeAreaSystem {
  /** Root lifts of every area. */
  readonly lifts: readonly AreaLift[];
  private readonly o: ChallengeAreaOptions;
  private readonly areas: AreaState[];
  private readonly liftById: ReadonlyMap<string, AreaLift>;
  private readonly unsubscribe: (() => void)[] = [];
  /** The area the feet were inside on the last tick. */
  private here: AreaState | null = null;
  private lastFeet: Vec3 | null = null;

  constructor(options: ChallengeAreaOptions) {
    this.o = options;
    const defs = options.defs ?? CHALLENGE_AREA_DEFS;
    for (const def of defs) {
      for (const piece of def.pieces) {
        options.world.addStatic(shapeCollider(piece.shape, options.ids.next(), piece.walkableTop, piece.look, piece.climbable === true));
      }
    }
    const saved = options.state.checkpoint;
    this.areas = defs.map((def) => ({
      def,
      doors: def.doors.map((d) => ({ def: d, body: shapeCollider(d.shape, options.ids.next(), false, d.look), solid: false })),
      heatWalls: def.heatWalls.map((w) => {
        const device = options.puzzles.device(w.part);
        if (device === null) throw new Error(`ChallengeAreaSystem: heat wall ${w.id} has no device ${w.part}`);
        return { def: w, device, wall: new HeatCrystalWall(options.world, options.ids.next(), { ...w.shape }, device, true) };
      }),
      risers: def.risers.map((r) => ({ def: r, body: shapeCollider(r.shape, options.ids.next(), true, r.look), up: false })),
      // A load inside an area resumes from its latest checkpoint.
      latest: saved !== null && saved.area === def.id ? (def.checkpoints.find((c) => c.id === saved.id) ?? null) : null,
      locked: new Set<string>(),
      waveAt: new Map<string, number>(),
      wavePlaced: new Map<string, string>(),
    }));
    this.lifts = defs.flatMap((def) => def.lifts.map((l): AreaLift => ({ def: l, pad: { ...l.pad }, to: copySpot(l.to) })));
    this.liftById = new Map(this.lifts.map((l) => [l.def.id, l]));
    for (const area of this.areas) this.updateBodies(area, null);
    this.unsubscribe.push(
      options.bus.on('interact', (p) => {
        if (p.targetKind !== 'lift') return;
        const lift = this.liftById.get(p.targetId);
        if (lift !== undefined && this.liftRuns(lift.def)) options.recovery.restorePlayer('lift', lift.to);
      }),
      options.bus.on('camp:cleared', (p) => this.campCleared(p.campId)),
    );
  }

  /** The Challenge_Area the Active_Character is inside, or null. */
  get current(): ChallengeAreaDef | null {
    return this.here?.def ?? null;
  }

  /** Music of the area the character is inside (`mus_area_<id>`, Req 12.4), for the Audio_System. */
  get music(): MusicId | null {
    return this.here?.def.music ?? null;
  }

  /** The latest checkpoint of `area`, or null before the first. */
  latestCheckpoint(area: ChallengeAreaId): CheckpointDef | null {
    return this.areas.find((a) => a.def.id === area)?.latest ?? null;
  }

  /** Whether the area still judges falls (its Skyshard not held yet). */
  fallJudgement(area: ChallengeAreaId): boolean {
    const a = this.areas.find((s) => s.def.id === area);
    return a !== undefined && this.o.state.skyshards < a.def.skyshard.index;
  }

  /** Whether a combat room's fight holds its doors now. */
  roomLocked(groupId: string): boolean {
    return this.areas.some((a) => a.locked.has(groupId));
  }

  roomCleared(groupId: string): void {
    const room = this.roomDef(groupId);
    if (room === null) return;
    this.o.state.world.flags[roomClearedFlag(groupId)] = true;
    for (const a of this.areas) {
      a.locked.delete(groupId);
      a.waveAt.delete(groupId);
      a.wavePlaced.delete(groupId);
    }
  }

  isRoomCleared(groupId: string): boolean {
    return this.o.state.world.flags[roomClearedFlag(groupId)] === true;
  }

  /**
   * The wave of wave room `groupId` in play or next to come: its first wave not cleared yet; null once the room is
   * cleared (or for a room without waves).
   */
  currentWave(groupId: string): string | null {
    const room = this.roomDef(groupId);
    if (room?.waves === undefined) return null;
    return room.waves.find((w) => !this.isRoomCleared(w)) ?? null;
  }

  /** Seconds until wave room `groupId`'s next wave may come (after the previous wave's clear), else null. */
  waveDueIn(groupId: string): number | null {
    for (const a of this.areas) {
      const at = a.waveAt.get(groupId);
      if (at !== undefined) return Math.max(0, at - this.o.clock.time);
    }
    return null;
  }

  /** Whether door `id` stands open now. */
  doorOpen(id: string): boolean {
    for (const a of this.areas) for (const d of a.doors) if (d.def.id === id) return !d.solid;
    return false;
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
      height: LIFT_PAD_HEIGHT,
      detail: () => lift.def.prompt ?? '뿌리 승강기 타기',
      available: () => this.liftRuns(lift.def),
    }));
  }

  /** Whether a lift runs now. */
  liftRuns(def: AreaLiftDef): boolean {
    return this.conditionHolds(def.when);
  }

  /** Whether riser `id` stands now. */
  riserUp(id: string): boolean {
    for (const a of this.areas) for (const r of a.risers) if (r.def.id === id) return r.up;
    return false;
  }

  /** Whether Heat_Crystal wall `id` is climbable now (cooled). */
  heatWallClimbable(id: string): boolean {
    for (const a of this.areas) for (const w of a.heatWalls) if (w.def.id === id) return w.device.climbable(this.o.clock.time);
    return false;
  }

  /**
   * One sim tick on the Active_Character's final feet of the movement step: the area they are in, its checkpoint
   * runes, fall judgement and room locks, the recovery override, then every door.
   */
  tick(body: ChallengeAreaBody | null): void {
    const feet = body?.pos ?? null;
    this.lastFeet = feet === null ? null : { ...feet };
    const inside = feet === null ? null : this.areaAt(feet);
    this.here = inside;
    if (inside !== null && feet !== null) {
      this.stepCheckpoints(inside, feet);
      this.stepHazards(inside, feet);
    }
    for (const area of this.areas) this.stepRooms(area, area === inside ? feet : null);
    const spot = inside === null ? null : this.returnSpot(inside);
    if (inside === null || spot === null) this.o.recovery.setCheckpointOverride(null);
    else this.o.recovery.setCheckpointOverride(inside.def.id, spot.pos, spot.yaw);
    for (const area of this.areas) this.updateBodies(area, this.lastFeet);
  }

  /** Party_Wipe restart point: the latest checkpoint (or entrance) of the area the party fell in, else null. */
  restartSpot(): SafePosition | null {
    return this.here === null ? null : this.returnSpot(this.here);
  }

  /**
   * Party_Wipe restart: running room fights and pending waves are dropped (their groups are placed again at full HP by
   * the spawners; the next lock calls the first wave not cleared yet).
   */
  restart(): void {
    for (const a of this.areas) {
      a.locked.clear();
      a.waveAt.clear();
      a.wavePlaced.clear();
    }
    for (const area of this.areas) this.updateBodies(area, null);
  }

  /** The ceiling constellations of every area, lit in turn in their step's Element (or all once solved). */
  constellationViews(): ConstellationView[] {
    const now = this.o.clock.time;
    return this.areas.flatMap((a) => (a.def.constellations ?? []).map((c): ConstellationView => {
      const order = this.o.puzzles.sequenceOrder(c.puzzle) ?? [];
      const solved = this.o.puzzles.isSolved(c.puzzle);
      const element = order[c.step] ?? null;
      const lit = element !== null && (solved || constellationStepAt(now, order.length, CONSTELLATION_TIMING) === c.step);
      return { def: c, element, lit, solved };
    }));
  }

  doorViews(): AreaDoorView[] {
    return this.areas.flatMap((a) => a.doors.map((d) => ({ def: d.def, open: !d.solid })));
  }

  heatWallViews(): HeatWallView[] {
    const now = this.o.clock.time;
    return this.areas.flatMap((a) => a.heatWalls.map((w): HeatWallView => {
      const left = w.device.cooledLeft(now);
      return { def: w.def, cooled: w.device.climbable(now), cooledLeft: left, warning: left > 0 && left <= HEAT_CRYSTAL_WARNING_SECONDS };
    }));
  }

  riserViews(): RiserView[] {
    return this.areas.flatMap((a) => a.risers.map((r) => ({ def: r.def, up: r.up })));
  }

  checkpointViews(): CheckpointView[] {
    return this.areas.flatMap((a) =>
      a.def.checkpoints.map((c) => ({ def: c, area: a.def.id, lit: this.lit(c), latest: a.latest === c })),
    );
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private areaAt(feet: Readonly<Vec3>): AreaState | null {
    const ids = new Set(this.o.volumes.at(feet, 'area').map((v) => v.id));
    return this.areas.find((a) => ids.has(a.def.id)) ?? null;
  }

  private returnSpot(area: AreaState): SafePosition {
    return copySpot(area.latest?.spot ?? area.def.entrance);
  }

  private lit(c: CheckpointDef): boolean {
    return c.litWhen === undefined || this.conditionHolds(c.litWhen);
  }

  private stepCheckpoints(area: AreaState, feet: Readonly<Vec3>): void {
    for (const c of area.def.checkpoints) {
      if (area.latest === c || !this.lit(c)) continue;
      if (flat(feet, c.spot.pos) > c.radius || Math.abs(feet.y - c.spot.pos.y) > CHECKPOINT_HEIGHT_BAND) continue;
      area.latest = c;
      const flags = this.o.state.world.flags;
      const first = flags[checkpointFlag(c.id)] !== true;
      flags[checkpointFlag(c.id)] = true;
      this.o.state.checkpoint = { area: area.def.id, id: c.id };
      this.o.bus.emit('checkpoint:reached', { areaId: area.def.id, checkpointId: c.id, first });
    }
  }

  private stepHazards(area: AreaState, feet: Readonly<Vec3>): void {
    if (!this.fallJudgement(area.def.id)) return;
    const falling = this.o.volumes.at(feet, 'hazard').some((h) => h.area === area.def.id && h.effect === 'fall');
    if (falling) this.o.recovery.restorePlayer('hazard');
  }

  /**
   * 'camp:cleared': a wave room's wave before the last is recorded and calls the next one `waveDelay` s later; any other
   * group's clear (a room's own group, a wave room's last wave) clears its room.
   */
  private campCleared(campId: string): void {
    for (const a of this.areas) {
      for (const room of a.def.combatRooms) {
        const waves = room.waves;
        if (waves === undefined || campId === room.groupId || !waves.includes(campId)) continue;
        this.o.state.world.flags[roomClearedFlag(campId)] = true;
        a.waveAt.set(room.groupId, this.o.clock.time + (room.waveDelay ?? 0));
        return;
      }
    }
    this.roomCleared(campId);
  }

  /** Locks a room when the character stands inside it with its group alive; ends the lock once they are out. */
  private stepRooms(area: AreaState, feet: Readonly<Vec3> | null): void {
    for (const room of area.def.combatRooms) {
      const locked = area.locked.has(room.groupId);
      if (this.isRoomCleared(room.groupId)) {
        area.locked.delete(room.groupId);
        continue;
      }
      const inRoom = feet !== null && this.insideRoom(room, feet, locked ? ROOM_LOCK_MARGIN : 0);
      if (!inRoom) {
        area.locked.delete(room.groupId);
        continue;
      }
      if (room.waves !== undefined) {
        this.stepWaves(area, room, locked);
        continue;
      }
      if (locked) continue;
      const members = this.o.rooms.members(room.groupId);
      if (members.length === 0) continue;
      for (const m of members) {
        if (flat(m.pos, room.center) > room.radius + ROOM_MEMBER_MARGIN) this.o.rooms.resetMember(m.id);
      }
      area.locked.add(room.groupId);
    }
  }

  /**
   * A wave room with the character inside: locked at once (its current wave's stragglers put back first), and its
   * current wave placed when none of it is alive, it was not placed already in this run and its delay has passed.
   */
  private stepWaves(area: AreaState, room: CombatRoomDef, locked: boolean): void {
    const wave = this.currentWave(room.groupId);
    if (wave === null) return;
    const members = this.o.rooms.members(wave);
    if (!locked) {
      for (const m of members) {
        if (flat(m.pos, room.center) > room.radius + ROOM_MEMBER_MARGIN) this.o.rooms.resetMember(m.id);
      }
      area.locked.add(room.groupId);
    } else {
      // A member knocked off the room's floor (the ring corridor's inner edge into the hall) cannot be reached in the
      // locked room: it is put back at its spawn.
      for (const m of members) if (room.center.y - m.pos.y > ROOM_HEIGHT_BAND) this.o.rooms.resetMember(m.id);
    }
    if (members.length > 0 || area.wavePlaced.get(room.groupId) === wave) return;
    const due = area.waveAt.get(room.groupId);
    if (due !== undefined && this.o.clock.time < due) return;
    area.waveAt.delete(room.groupId);
    area.wavePlaced.set(room.groupId, wave);
    this.o.rooms.spawn(wave);
  }

  private insideRoom(room: CombatRoomDef, feet: Readonly<Vec3>, margin: number): boolean {
    return flat(feet, room.center) <= room.radius + margin && Math.abs(feet.y - room.center.y) <= ROOM_HEIGHT_BAND;
  }

  private roomDef(groupId: string): CombatRoomDef | null {
    for (const a of this.areas) {
      const room = a.def.combatRooms.find((r) => r.groupId === groupId);
      if (room !== undefined) return room;
    }
    return null;
  }

  private conditionHolds(c: AreaCondition | AreaLiftDef['when']): boolean {
    switch (c.kind) {
      case 'puzzleSolved':
        return this.o.puzzles.isSolved(c.puzzleId);
      case 'puzzleOpen':
        return this.o.puzzles.isOpen(c.target);
      case 'roomUnlocked':
        return !this.roomLocked(c.groupId);
      case 'roomCleared':
        return this.isRoomCleared(c.groupId);
      case 'eliteDefeated':
        return this.o.state.world.elites.includes(c.elite);
      case 'skyshard':
        return this.o.state.skyshards >= c.index;
      case 'partGone':
        return !this.o.puzzles.partPresent(c.part);
    }
  }

  /** Doors, risers and Heat_Crystal walls follow their conditions and devices. */
  private updateBodies(area: AreaState, feet: Readonly<Vec3> | null): void {
    this.updateDoors(area, feet);
    this.updateRisers(area, feet);
    const now = this.o.clock.time;
    for (const w of area.heatWalls) w.wall.sync(now);
  }

  /** Doors follow their conditions; one about to close waits while the character's capsule is in it. */
  private updateDoors(area: AreaState, feet: Readonly<Vec3> | null): void {
    for (const door of area.doors) {
      const open = this.conditionHolds(door.def.openWhen);
      const solid = !open && !(feet !== null && !door.solid && capsuleInBox(door.def.shape, feet));
      if (solid === door.solid) continue;
      door.solid = solid;
      if (solid) this.o.world.upsertDynamic(door.body);
      else this.o.world.removeDynamic(door.body.id);
    }
  }

  /** Risers stand while their condition holds; one about to rise waits while the character's capsule is in it. */
  private updateRisers(area: AreaState, feet: Readonly<Vec3> | null): void {
    for (const riser of area.risers) {
      const holds = this.conditionHolds(riser.def.when);
      const up = holds && !(feet !== null && !riser.up && capsuleInBox(riser.def.shape, feet));
      if (up === riser.up) continue;
      riser.up = up;
      if (up) this.o.world.upsertDynamic(riser.body);
      else this.o.world.removeDynamic(riser.body.id);
    }
  }
}
