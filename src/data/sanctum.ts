/*
 * Astral Sanctum layout (design "Boss Caelith" Arena, World Layout Master Table, 진행 게이트; Req 5.7, 6.11): the
 * floating Sanctum from the Starlit_Stair's arrival to Caelith's arena. Coordinates follow src/data/worldLayout
 * (m, y up, +x east, −z north):
 * - Gate slab (sanctum_gate, y 175): tier 3 of the Starlit_Stair (its last platform at z −46.5) arrives on it.
 * - Steps up to the connecting hall `sanctum_hall` (y 180), a combat-free room walled east and west (Req 5.7): the
 *   `ws_sanctum` Waystone stands in its middle (0, −10) and the mural covers the west wall.
 * - The entrance bridge: steps from the hall up to the arena's entrance gap (y 182).
 * - The arena `sanctum_arena` (ARENA of src/data/boss): a 32 m disc centred on (0, 30) at y 182, divided into 8
 *   floor sectors of 45° for sectorBlast (sector 0 centred on the entrance, north; numbered clockwise), the four
 *   Shard_Crystal pedestals 18 m out (SHARD_CRYSTAL_SOCKETS: north, east, south, west) and the 1.2 m rim wall, neither
 *   climbable nor standable. A jump peaks 1.4 m above the feet (player constants), higher than the rim, so a starlight
 *   ward stands on the rim up to `wardTop` m above the floor: nobody jumps, glides or climbs out, and Caelith stays
 *   inside too. The rim and ward leave one 15° gap toward the hall: the entrance, sealed by a starlight barrier
 *   (a dynamic collider) while the fight runs and opened on a Party_Wipe or the victory.
 * - Spots: in front of the Waystone ("Waystone으로 돌아가기", 2 m toward the arena) and just inside the entrance
 *   ("현재 Phase부터 재도전"); the fight starts once the Active_Character is `fightRadius` m or less from the centre.
 * Shapes are temporary prefab geometry (the art tasks replace the look, not the shapes).
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import { yawFromDir } from '../core/math';
import type { Vec3 } from '../core/types';
import { ARENA, SHARD_CRYSTAL_SOCKETS } from './boss';
import type { AreaShape, AreaSpot } from './challengeAreas';
import type { ElementId } from './ids';
import { LOCATIONS } from './worldLayout';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * How a Sanctum piece is drawn: floors and steps of pale star-stone, the hall walls, the rim wall, the faint starlight
 * ward above it, the Shard_Crystal pedestals and the Waystone.
 */
export type SanctumLook = 'floor' | 'step' | 'hallWall' | 'rim' | 'ward' | 'pedestal' | 'waystone';

/** A static solid of the Sanctum. None is climbable (the rim and walls are the design's non-climbable walls). */
export interface SanctumPieceDef {
  readonly id: string;
  readonly shape: AreaShape;
  readonly look: SanctumLook;
  /** Floors, steps and pedestals are standable on top; walls, rim, ward and the Waystone are not. */
  readonly walkableTop: boolean;
  /** Seen through by the camera (the ward is only a shimmer). Default false: it blocks the camera. */
  readonly cameraPasses?: boolean;
}

/** One of the 8 floor sectors: compass bearings from the arena centre (0° north, clockwise), [from, to). */
export interface ArenaSectorDef {
  readonly index: number;
  readonly centerDeg: number;
  readonly fromDeg: number;
  readonly toDeg: number;
}

/** A Shard_Crystal pedestal (socket) on the arena floor. */
export interface ArenaPedestalDef {
  readonly id: string;
  readonly element: ElementId;
  /** Base centre on the floor. */
  readonly pos: Vec3;
  readonly radius: number;
  readonly height: number;
  /** The floor sector it stands in. */
  readonly sector: number;
}

export interface SanctumArenaDef {
  /** Floor centre (top surface). */
  readonly center: Vec3;
  readonly radius: number;
  readonly sectors: readonly ArenaSectorDef[];
  readonly pedestals: readonly ArenaPedestalDef[];
  readonly rim: {
    /** Height above the floor (ARENA.rimHeight). */
    readonly height: number;
    readonly thickness: number;
    /** Wall segments around the full circle; `gapSegment` is left out as the entrance. */
    readonly segments: number;
    readonly gapSegment: number;
    /** Top of the starlight ward standing on the rim, above the floor (m). */
    readonly wardTop: number;
  };
  /** The starlight barrier across the entrance gap, solid while the fight runs. */
  readonly seal: { readonly id: string; readonly shape: Extract<AreaShape, { kind: 'obb' }> };
  /** The fight starts with the Active_Character's feet this close to the centre (m) and above `minY`. */
  readonly fightRadius: number;
  readonly minY: number;
}

export interface SanctumMuralDef {
  readonly id: 'sanctum_mural';
  /** Prompt name (Korean). */
  readonly name: string;
  /** Interaction point (floor level, in front of the panel). */
  readonly pos: Vec3;
  /** The painted panel on the west wall (drawn only). */
  readonly panel: Extract<AreaShape, { kind: 'obb' }>;
}

export interface SanctumDef {
  readonly pieces: readonly SanctumPieceDef[];
  readonly arena: SanctumArenaDef;
  /** ws_sanctum in the hall: its stone (a piece) and the spot 2 m in front of it. */
  readonly waystone: { readonly id: 'ws_sanctum'; readonly pos: Vec3; readonly radius: number; readonly height: number; readonly spot: AreaSpot };
  readonly mural: SanctumMuralDef;
  /** Just inside the entrance, facing the arena centre (the Phase retry). */
  readonly arenaEntry: AreaSpot;
  /** The connecting hall's floor box (feet inside: in the hall). */
  readonly hall: { readonly min: Vec3; readonly max: Vec3 };
}

// ── Layout ──────────────────────────────────────────────────────────────────

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
/** Axis-aligned box piece (an obb with yaw 0) from its min / max corners. */
const box = (id: string, look: SanctumLook, min: Vec3, max: Vec3, walkableTop: boolean): SanctumPieceDef => ({
  id, look, walkableTop,
  shape: { kind: 'obb', center: v((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2), half: v((max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2), yaw: 0 },
});

/** Slab thickness of floors and steps (m). */
const SLAB = 0.6;
const GATE_Y = LOCATIONS.sanctum_gate.groundY; // 175
const HALL_Y = LOCATIONS.sanctum_hall.groundY; // 180
const ARENA_LOC = LOCATIONS.sanctum_arena; // (0, 30), y 182
const ARENA_Y = ARENA_LOC.groundY;
const CENTER = v(ARENA_LOC.x, ARENA_Y, ARENA_LOC.z);

/** Hall floor: 16 m wide, from the top of the gate steps to the entrance bridge. */
const HALL_MIN = v(-8, HALL_Y - SLAB, -24.4);
const HALL_MAX = v(8, HALL_Y, -6);
const HALL_WALL = { thickness: 0.6, height: 4 };

/** Rim wall and starlight ward. */
const RIM_THICKNESS = 0.5;
const RIM_SEGMENTS = 24;
/** Segment 0 is centred on bearing 0° (north, toward the hall): the entrance. */
const GAP_SEGMENT = 0;
/** Ward top above the floor: over a jump (1.4 m) from a Talus pillar (2.4 m) plus the 1.75 m capsule. */
const WARD_TOP = 8;

/** Compass bearing (deg, 0 north, clockwise) → world direction (x east, z south). */
const bearingDir = (deg: number): { x: number; z: number } => {
  const r = (deg * Math.PI) / 180;
  return { x: Math.sin(r), z: -Math.cos(r) };
};

/**
 * Compass bearing of (x, z) seen from the arena centre, in [0, 360): 0 north (−z), 90 east (+x). The centre itself
 * reads 0.
 */
export function arenaBearing(x: number, z: number): number {
  const dx = x - CENTER.x;
  const dz = z - CENTER.z;
  if (dx === 0 && dz === 0) return 0;
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** Sector k is centred on bearing k × 45°: 0 north (the entrance), 2 east, 4 south, 6 west. */
const SECTOR_DEG = 360 / ARENA.sectors;
const SECTORS: readonly ArenaSectorDef[] = Array.from({ length: ARENA.sectors }, (_, index) => ({
  index,
  centerDeg: index * SECTOR_DEG,
  fromDeg: index * SECTOR_DEG - SECTOR_DEG / 2,
  toDeg: index * SECTOR_DEG + SECTOR_DEG / 2,
}));

/** Floor sector containing (x, z), or null off the arena disc (NaN is off it). */
export function arenaSectorAt(x: number, z: number): number | null {
  const d = Math.hypot(x - CENTER.x, z - CENTER.z);
  if (!(d <= ARENA.radius)) return null;
  return Math.floor(((arenaBearing(x, z) + SECTOR_DEG / 2) % 360) / SECTOR_DEG);
}

const PEDESTAL = { radius: 1.2, height: 0.3 };
const PEDESTALS: readonly ArenaPedestalDef[] = SHARD_CRYSTAL_SOCKETS.map((socket) => {
  const pos = v(CENTER.x + socket.dx, ARENA_Y, CENTER.z + socket.dz);
  return { id: `sanctum_socket_${socket.element}`, element: socket.element, pos, ...PEDESTAL, sector: arenaSectorAt(pos.x, pos.z) ?? -1 };
});

/**
 * Rim segment `k` (centred on bearing k × 15°) as an obb standing from `fromY` to `toY`: tangent to the circle
 * through the wall's middle, long enough to overlap its neighbours.
 */
function rimSegment(id: string, look: SanctumLook, k: number, fromY: number, toY: number, cameraPasses: boolean): SanctumPieceDef {
  const r = ARENA.radius - RIM_THICKNESS / 2;
  const bearing = (360 / RIM_SEGMENTS) * k;
  const dir = bearingDir(bearing);
  // The tangent (clockwise) is (cos b, sin b); an obb's local +Z points along dirFromYaw(yaw) = (sin yaw, cos yaw).
  const yaw = Math.PI / 2 - (bearing * Math.PI) / 180;
  return {
    id, look, walkableTop: false, ...(cameraPasses ? { cameraPasses } : {}),
    shape: {
      kind: 'obb',
      center: v(CENTER.x + dir.x * r, (fromY + toY) / 2, CENTER.z + dir.z * r),
      half: v(RIM_THICKNESS / 2, (toY - fromY) / 2, (Math.PI * r) / RIM_SEGMENTS + 0.05),
      yaw,
    },
  };
}

function rimAndWard(): SanctumPieceDef[] {
  const out: SanctumPieceDef[] = [];
  for (let k = 0; k < RIM_SEGMENTS; k++) {
    if (k === GAP_SEGMENT) continue;
    out.push(rimSegment(`sanctum_rim_${k}`, 'rim', k, ARENA_Y - SLAB, ARENA_Y + ARENA.rimHeight, false));
    out.push(rimSegment(`sanctum_ward_${k}`, 'ward', k, ARENA_Y + ARENA.rimHeight, ARENA_Y + WARD_TOP, true));
  }
  return out;
}

/** The entrance seal: across the gap segment from the floor slab to the ward top, overlapping the rim ends. */
const SEAL_SHAPE: Extract<AreaShape, { kind: 'obb' }> = (() => {
  const s = rimSegment('sanctum_seal', 'ward', GAP_SEGMENT, ARENA_Y - SLAB, ARENA_Y + WARD_TOP, false).shape as Extract<AreaShape, { kind: 'obb' }>;
  return { ...s, half: v(s.half.x + 0.05, s.half.y, s.half.z + 0.2) };
})();

/** Steps from `fromY` to `toY` along +z from `z0`, `depth` m each, `halfWidth` wide around x = 0. */
function steps(prefix: string, fromY: number, toY: number, z0: number, count: number, depth: number, halfWidth: number): SanctumPieceDef[] {
  const rise = (toY - fromY) / count;
  return Array.from({ length: count }, (_, k) =>
    box(`${prefix}_${k + 1}`, 'step', v(-halfWidth, fromY - SLAB, z0 + depth * k), v(halfWidth, fromY + rise * (k + 1), z0 + depth * (k + 1)), true),
  );
}

const WS = LOCATIONS.ws_sanctum; // (0, −10), y 180
const WAYSTONE = { radius: 0.55, height: 2.6 };
/** The arena lies south (+z) of the hall: spots face it. */
const TOWARD_ARENA = yawFromDir(0, 1);

const MURAL_Z = -15;

export const SANCTUM: SanctumDef = {
  pieces: [
    // Gate slab: tier 3 of the Starlit_Stair (z −49..−44) arrives on its north end.
    box('sanctum_gate_floor', 'floor', v(-6, GATE_Y - SLAB, -49), v(6, GATE_Y, -34), true),
    // 12 steps of 0.42 m (under the 0.45 m step-up) up to the hall.
    ...steps('sanctum_steps_hall', GATE_Y, HALL_Y, -34, 12, 0.8, 3),
    // The connecting hall: floor and the east / west walls (the mural is painted on the west one).
    box('sanctum_hall_floor', 'floor', HALL_MIN, HALL_MAX, true),
    box('sanctum_hall_wall_w', 'hallWall', v(HALL_MIN.x - HALL_WALL.thickness, HALL_MIN.y, HALL_MIN.z), v(HALL_MIN.x, HALL_Y + HALL_WALL.height, HALL_MAX.z), false),
    box('sanctum_hall_wall_e', 'hallWall', v(HALL_MAX.x, HALL_MIN.y, HALL_MIN.z), v(HALL_MAX.x + HALL_WALL.thickness, HALL_Y + HALL_WALL.height, HALL_MAX.z), false),
    { id: 'sanctum_waystone', look: 'waystone', walkableTop: false,
      shape: { kind: 'cylinder', base: v(WS.x, HALL_Y, WS.z), radius: WAYSTONE.radius, height: WAYSTONE.height } },
    // The entrance bridge: 5 steps of 0.4 m from the hall to the arena's entrance gap, as wide as the gap.
    ...steps('sanctum_bridge', HALL_Y, ARENA_Y, HALL_MAX.z, 5, 0.8, 4.2),
    // The arena disc, the Shard_Crystal pedestals, the rim wall and the ward above it.
    { id: 'sanctum_arena_floor', look: 'floor', walkableTop: true,
      shape: { kind: 'cylinder', base: v(CENTER.x, ARENA_Y - SLAB, CENTER.z), radius: ARENA.radius, height: SLAB } },
    ...PEDESTALS.map((p): SanctumPieceDef => ({
      id: p.id, look: 'pedestal', walkableTop: true, shape: { kind: 'cylinder', base: { ...p.pos }, radius: p.radius, height: p.height },
    })),
    ...rimAndWard(),
  ],
  arena: {
    center: CENTER,
    radius: ARENA.radius,
    sectors: SECTORS,
    pedestals: PEDESTALS,
    rim: { height: ARENA.rimHeight, thickness: RIM_THICKNESS, segments: RIM_SEGMENTS, gapSegment: GAP_SEGMENT, wardTop: WARD_TOP },
    seal: { id: 'sanctum_seal', shape: SEAL_SHAPE },
    fightRadius: ARENA.radius - 4,
    minY: HALL_Y - 2,
  },
  waystone: {
    id: 'ws_sanctum',
    pos: v(WS.x, HALL_Y, WS.z),
    ...WAYSTONE,
    spot: { pos: v(WS.x, HALL_Y, WS.z + 2), yaw: TOWARD_ARENA },
  },
  mural: {
    id: 'sanctum_mural',
    name: '성소 벽화',
    pos: v(-6.5, HALL_Y, MURAL_Z),
    panel: { kind: 'obb', center: v(HALL_MIN.x + 0.08, HALL_Y + 1.6, MURAL_Z), half: v(0.08, 1.3, 3.2), yaw: 0 },
  },
  arenaEntry: { pos: v(CENTER.x, ARENA_Y, CENTER.z - ARENA.radius + 5), yaw: TOWARD_ARENA },
  hall: { min: v(HALL_MIN.x, HALL_Y, HALL_MIN.z), max: v(HALL_MAX.x, HALL_Y + HALL_WALL.height, HALL_MAX.z) },
};
