/*
 * Challenge_Area layouts (design "Challenge Areas·Puzzles", "체크포인트와 실패 처리"; Req 12.1–12.4, 12.6–12.9).
 * Hollowroot Shrine (task 9.6), Cinderspire (task 9.7) and Starfall Observatory (task 9.8), the latter two described at
 * their sections below.
 *
 * Hollowroot Shrine, the underground root sanctuary beside the Elderbough. Everything is laid out in the shrine
 * frame: the origin is the centre of the spiral well, `p` metres along SHRINE_AXIS (north-north-east, away from the
 * root arch) and `q` along SHRINE_SIDE (east-south-east); shrinePoint() turns (p, q) into world (x, z).
 * - R0 root arch (hollowroot_entrance, y 14): the Talus meeting, then the spiral root ramp: 270° around the well,
 *   level for its first 30°, down to the landing at y −10. The well's floor (y −14) is the fall judgement: a
 *   `hazard` fall into it fades back to the latest checkpoint until Skyshard 1 is taken.
 * - R1 bramble gate `pz_hollowroot_1` (Ember) across the landing corridor; cp_hollowroot_1 right behind it.
 * - R2 wind wheel `pz_hollowroot_2` (Gale): once it spins, the root lift rises to the upper corridor (y −2) and stays
 *   an ordinary lift both ways. A non-climbable root wall closes the 8 m step up to the canopy, so only the lift goes up.
 * - R3 upper corridor `pz_hollowroot_3` (weight): the root door 12 m past the pressure plate is open only while the
 *   plate is held (Talus's stone pillar); the bent passage behind it is blocked by a crackedBoulder (Terra or a
 *   Charged_Attack), whose break solves the puzzle and fixes the door open. The passage then descends to R4.
 * - R4 locked combat room: entering locks both doors until `hollowroot_room` (bramblekin ×4, thornspitter ×2) falls;
 *   cp_hollowroot_2 lights in the corridor beyond once it is cleared.
 * - R5 Rootbound Warden arena (fight radius 14 m on a 17 m carved floor), the deepest room; the Warden's glowing back
 *   root is its weak spot. Its defeat opens R6.
 * - R6 Skyshard room: after Skyshard 1 the fall judgement is off and the root lift becomes the exit to the
 *   Elderbough foot beside ws_elderbough (Req 12.9).
 * The terrain carves the floors from `carve` (src/world/terrain), and a root canopy of roof slabs closes every room
 * and corridor past the well above its ceiling, so the shrine is entered only down the spiral. Walls, roofs, doors
 * and lifts are temporary prefab shapes (the art tasks replace the look, not the shapes). The area's music id and
 * its green-fog / glowing-root lighting are declared here for the Audio_System (task 16.2) and the render.
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import { yawFromDir } from '../core/math';
import type { Vec3 } from '../core/types';
import type { ChallengeAreaId, EliteId, ElementId, MusicId, RegionId } from './ids';
import { LOCATIONS, type XZ } from './worldLayout';

// ── Types ───────────────────────────────────────────────────────────────────

/** A standing spot: feet point and facing (rad, core/math yaw). */
export interface AreaSpot {
  readonly pos: Vec3;
  readonly yaw: number;
}

/**
 * Terrain carving (applied after the location pads, as min(): the ground only ever goes down).
 * - basin: flat floor `floorY` within `radius` of `center`, walls rising `wallSlope` m per m beyond it.
 * - trench: a floor 2 × `halfWidth` wide along the polyline (height interpolated along each segment), walls rising
 *   `wallSlope` m per m beyond it; the ends are rounded.
 */
export type CarvePiece =
  | { readonly kind: 'basin'; readonly center: XZ; readonly floorY: number; readonly radius: number; readonly wallSlope: number }
  | { readonly kind: 'trench'; readonly points: readonly Vec3[]; readonly halfWidth: number; readonly wallSlope: number };

/** A solid prefab shape: a box turned `yaw` about +Y (local +Z along dirFromYaw(yaw)) or an upright cylinder. */
export type AreaShape =
  | { readonly kind: 'obb'; readonly center: Vec3; readonly half: Vec3; readonly yaw: number }
  | { readonly kind: 'cylinder'; readonly base: Vec3; readonly radius: number; readonly height: number };

/**
 * How a piece or door is drawn. Hollowroot: root walls, canopy slabs, bramble, root doors and gates, rubble.
 * Cinderspire: charcoal spire rock and orange crystal (climbable), the hot crystal block around the Heat_Crystal
 * wall (not climbable), the ramp's crystal steps, the summit floor, the Skyshard cage, vent ledges and exit stairs.
 * Starfall Observatory: white stone walls, floors and steps, the low parapets, the dome drum, the oculus, the
 * telescope, the starlight barriers of the ring corridor, the Skyshard's star cage and the balcony gate.
 */
export type AreaLook =
  | 'rootWall' | 'canopy' | 'bramble' | 'rootDoor' | 'rubble' | 'rootGate'
  | 'spireRock' | 'spireCrystal' | 'hotCrystal' | 'crystalStep' | 'summitFloor' | 'crystalCage' | 'ventLedge' | 'exitStair'
  | 'obsStone' | 'obsFloor' | 'obsStep' | 'obsParapet' | 'obsDrum' | 'obsOculus' | 'telescope' | 'starBarrier' | 'starCage'
  | 'balconyGate';

/** Static solid: a root wall or canopy slab (Hollowroot, none climbable), a spire, ledge or step (Cinderspire). */
export interface AreaPieceDef {
  readonly id: string;
  readonly shape: AreaShape;
  readonly look: AreaLook;
  /** Roof slabs, ledges and steps are standable on top; walls are not. */
  readonly walkableTop: boolean;
  /** Part of the 'climb' query (spire rock and crystal faces); absent: not climbable. */
  readonly climbable?: boolean;
}

/** When a door stands open. */
export type DoorOpenCondition =
  /** The puzzle is solved. */
  | { readonly kind: 'puzzleSolved'; readonly puzzleId: string }
  /** A puzzle `opens` target is open now (a weight puzzle's plates held, or solved). */
  | { readonly kind: 'puzzleOpen'; readonly target: string }
  /** The combat room is not locked (its fight is not running). */
  | { readonly kind: 'roomUnlocked'; readonly groupId: string }
  /** The combat room's group has been cleared. */
  | { readonly kind: 'roomCleared'; readonly groupId: string }
  /** The Elite is defeated (GameState.world.elites). */
  | { readonly kind: 'eliteDefeated'; readonly elite: EliteId };

/** When a riser stands: a door condition, Skyshard `index` held, or a puzzle part broken open (burnt, broken, exploded). */
export type AreaCondition =
  | DoorOpenCondition
  | { readonly kind: 'skyshard'; readonly index: 1 | 2 | 3 }
  | { readonly kind: 'partGone'; readonly part: string };

/** A door: a solid box while closed, gone while open (a barrier, a cage, a gate). */
export interface AreaDoorDef {
  readonly id: string;
  /** Korean name. */
  readonly name: string;
  readonly shape: Extract<AreaShape, { kind: 'obb' }>;
  readonly look: AreaLook;
  /** Usually a DoorOpenCondition; the Observatory's balcony gate opens with Skyshard 3. */
  readonly openWhen: AreaCondition;
}

/**
 * When a lift runs: a puzzle solved (Hollowroot's root lift, the Observatory's ring lift), Skyshard `index` held (the
 * exit after the Challenge_Area's Skyshard), or a combat room not locked (the Observatory's way down from the ring).
 */
export type AreaLiftCondition = AreaCondition;

/** A lift: an interaction pad that fades the character to `to` (the lift ride). */
export interface AreaLiftDef {
  readonly id: string;
  /** Prompt name (Korean). */
  readonly name: string;
  readonly pad: Vec3;
  readonly to: AreaSpot;
  readonly when: AreaLiftCondition;
  /** Prompt status line (Korean); default '뿌리 승강기 타기'. */
  readonly prompt?: string;
}

/** A checkpoint rune on the floor: stepping inside `radius` registers it (Req 12.7). */
export interface CheckpointDef {
  readonly id: `cp_${ChallengeAreaId}_${number}`;
  /** Where the character stands after a return (the rune's centre) and faces. */
  readonly spot: AreaSpot;
  readonly radius: number;
  /** The rune only lights (and registers) once this holds; always when absent. */
  readonly litWhen?: DoorOpenCondition;
}

/** A combat room that locks its doors while its encounter group fights (Req 12.1). */
export interface CombatRoomDef {
  /** Encounter group (src/data/spawns.ts) and quest `defeat` id; for a wave room the last wave's group. */
  readonly groupId: string;
  readonly center: Vec3;
  /** Floor radius: the player inside this locks the room. */
  readonly radius: number;
  /**
   * A wave room (Observatory ring corridor, Req 12.3): these encounter groups fight one after another. Locking the room
   * places the first wave not cleared yet (`spawnGroup`); each wave's 'camp:cleared' places the next one `waveDelay` s
   * later. The last entry is `groupId`, so its clear is the room's (and the quest `defeat`'s).
   */
  readonly waves?: readonly string[];
  /** Seconds between a wave's 'camp:cleared' and the next wave (design: 2 s). */
  readonly waveDelay?: number;
}

/** The guardian Elite's arena. */
export interface ArenaDef {
  readonly elite: EliteId;
  readonly center: Vec3;
  /** Fight radius (the floor is a little wider). */
  readonly radius: number;
  /** The Elite's spawn. */
  readonly guardian: AreaSpot;
}

/** Fall judgement volume (design `hazard`): feet inside fade back to the latest checkpoint. */
export interface AreaHazardDef {
  readonly id: string;
  readonly center: XZ;
  /** Disc radius (with `box`: the radius of the drawn floor only). */
  readonly radius: number;
  /** An axis-aligned box of these half extents around `center` instead of the disc (the Observatory's courtyard). */
  readonly box?: { readonly halfX: number; readonly halfZ: number };
  readonly minY: number;
  readonly maxY: number;
  /**
   * How the render marks it: a dark pit (default), a floor of glowing embers (Cinderspire) or a pool of fallen
   * starlight (the Observatory's courtyard below the dome stairs).
   */
  readonly look?: 'pit' | 'embers' | 'starfall';
}

/**
 * A ceiling constellation (Starfall Observatory): it glows in the colour of step `step` of its sequence puzzle's order
 * in turn with the others, repeating, so the ceiling shows the order the pedestals take (design `pz_observatory_1`).
 */
export interface ConstellationDef {
  readonly id: string;
  /** The sequence puzzle whose order it shows. */
  readonly puzzle: string;
  /** 0-based step of that order. */
  readonly step: number;
  /** Centre on the ceiling (y just under it). */
  readonly center: Vec3;
  /** Star offsets from the centre in the ceiling plane (m). */
  readonly stars: readonly XZ[];
}

/** The exit glide once the area's Skyshard is held (Req 12.9; the Observatory's dome balcony). */
export interface ExitGlideDef {
  /** The door that opens with the Skyshard onto the glide start. */
  readonly door: string;
  /** The glide start (the balcony's tip, feet on it) facing along the glide heading. */
  readonly start: AreaSpot;
  /** Where the glide heads (the crater's Resonance_Altar). */
  readonly toward: XZ;
}

export type ShrineRoomId = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

export interface AreaRoomDef {
  /** Room id within its area (Hollowroot: ShrineRoomId). */
  readonly id: string;
  /** Korean name. */
  readonly name: string;
  /** Floor centre. */
  readonly center: Vec3;
  /** Flat floor radius (a corridor room: its half width). */
  readonly radius: number;
}

/** One waypoint of the walking route through the area; `lift` legs ride the named lift instead of walking. */
export interface RoutePoint {
  readonly pos: Vec3;
  /** The room (Hollowroot) or route leg (Cinderspire) it belongs to. */
  readonly room: string;
  /** Set on the first point after a lift ride. */
  readonly lift?: string;
}

export type RestLedgeId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

/**
 * A rest ledge (Req 12.6): a standable top at least 3 m across where the Stamina drain stops and regenerates, between
 * the mandatory climbs and flights.
 */
export interface RestLedgeDef {
  readonly id: RestLedgeId;
  /** Korean name. */
  readonly name: string;
  /** Standing point on the top (feet). */
  readonly center: Vec3;
  /** Narrowest horizontal extent of the standable top (m). */
  readonly width: number;
}

/**
 * One section of a vertical route (Cinderspire, design table "구간"):
 * - walk: waypoints (feet) from `fromY` to `toY`.
 * - climb: from the wall foot on the lower ledge up `height` m to the upper ledge; `face` is the yaw looking into the
 *   wall, `heatWall` names the Heat_Crystal wall it climbs (H1).
 * - updraft: the column ridden from the take-off ledge (`fromY`) to its top (`toY`); `jump` is a take-off spot with
 *   its heading.
 * - glide: from the Updraft axis at its top to the near edge of the landing surface (`landing`, its top `toY`),
 *   `horizontal` metres apart.
 */
export type AreaLegDef =
  | { readonly kind: 'walk'; readonly id: string; readonly name: string; readonly fromY: number; readonly toY: number;
    readonly to: RestLedgeId; readonly points: readonly Vec3[] }
  | { readonly kind: 'climb'; readonly id: string; readonly name: string; readonly fromY: number; readonly toY: number;
    readonly from: RestLedgeId; readonly to: RestLedgeId; readonly foot: Vec3; readonly top: Vec3; readonly face: number;
    readonly mandatory: true; readonly heatWall?: string }
  | { readonly kind: 'updraft'; readonly id: string; readonly name: string; readonly fromY: number; readonly toY: number;
    readonly from: RestLedgeId; readonly updraft: string; readonly jump: AreaSpot }
  | { readonly kind: 'glide'; readonly id: string; readonly name: string; readonly fromY: number; readonly toY: number;
    readonly updraft: string; readonly start: Vec3; readonly landing: Vec3; readonly horizontal: number;
    /** The rest ledge landed on; absent for the summit arena. */
    readonly to?: RestLedgeId };

/** An Updraft column (design `updraft` volume, Req 19.6): feet inside while gliding rise at 8 m/s up to `maxY`. */
export interface AreaUpdraftDef {
  readonly id: string;
  readonly center: XZ;
  readonly radius: number;
  /** Bottom of the column: below it a glider is not lifted (m). */
  readonly minY: number;
  /** Where the rise stops (the glider hovers at it). */
  readonly maxY: number;
}

/**
 * A Heat_Crystal wall (Req 13.8): a box whose collider is climbable only while its `part` (a heatCrystal puzzle part,
 * src/data/puzzles.ts) is cooled; hot, it only blocks. Its top is standable.
 */
export interface HeatWallDef {
  readonly id: string;
  readonly part: string;
  readonly shape: Extract<AreaShape, { kind: 'obb' }>;
}

/** A piece that rises into place (a dynamic collider) while `when` holds: the exit stairs, the vent ledges. */
export interface RiserDef {
  readonly id: string;
  readonly shape: Extract<AreaShape, { kind: 'obb' }>;
  readonly look: AreaLook;
  readonly when: AreaCondition;
  /** Rise animation delay after the condition starts holding (s, presentation only). */
  readonly delay: number;
}

/** Interior look (Req 12.4): the render fades the fog to these values inside, and the glowing roots use `glow`. */
export interface AreaLighting {
  /** 0xRRGGBB fog and background colour inside. */
  readonly fogColor: number;
  readonly fogNear: number;
  readonly fogFar: number;
  /** Glowing-root emissive and point-light colour. */
  readonly glow: number;
  /** Point lights (glowing root clusters). */
  readonly lights: readonly Vec3[];
}

/** Horizontal box (centre, half extents along / across its yaw) with a feet height band: the area bounds. */
export interface AreaBounds {
  readonly center: XZ;
  /** Half extent along dirFromYaw(yaw) and across it. */
  readonly halfAlong: number;
  readonly halfAcross: number;
  readonly yaw: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface ChallengeAreaDef {
  readonly id: ChallengeAreaId;
  readonly region: RegionId;
  /** Area music (`mus_area_<id>`, Req 12.4), played by the Audio_System while inside. */
  readonly music: MusicId;
  readonly lighting: AreaLighting;
  readonly bounds: AreaBounds;
  /** Return point before the first checkpoint is stepped on (design: the area entrance). */
  readonly entrance: AreaSpot;
  readonly rooms: readonly AreaRoomDef[];
  readonly route: readonly RoutePoint[];
  readonly carve: readonly CarvePiece[];
  readonly pieces: readonly AreaPieceDef[];
  readonly doors: readonly AreaDoorDef[];
  readonly lifts: readonly AreaLiftDef[];
  readonly checkpoints: readonly CheckpointDef[];
  readonly combatRooms: readonly CombatRoomDef[];
  readonly arena: ArenaDef;
  readonly hazards: readonly AreaHazardDef[];
  /** The Skyshard this area holds and its pedestal (RouteStubs places the pedestal). */
  readonly skyshard: { readonly index: 1 | 2 | 3; readonly pos: Vec3 };
  /** Rest ledges between the climbs and flights (Cinderspire; empty elsewhere). */
  readonly ledges: readonly RestLedgeDef[];
  /** The vertical route in order (Cinderspire; empty elsewhere). */
  readonly legs: readonly AreaLegDef[];
  readonly updrafts: readonly AreaUpdraftDef[];
  readonly heatWalls: readonly HeatWallDef[];
  readonly risers: readonly RiserDef[];
  /** Lift that leads out once the Skyshard is taken (Req 12.9; Hollowroot). */
  readonly exitLift?: string;
  /** Risers that rise as the way out once the Skyshard is taken (Req 12.9; Cinderspire's exit stairs). */
  readonly exitRisers?: readonly string[];
  /** The glide start that opens as the way out once the Skyshard is taken (Req 12.9; the Observatory's balcony). */
  readonly exitGlide?: ExitGlideDef;
  /** Ceiling constellations showing a sequence puzzle's order (the Observatory's great hall). */
  readonly constellations?: readonly ConstellationDef[];
}

/** Radius of every checkpoint rune (design "체크포인트와 실패 처리"). */
export const CHECKPOINT_RADIUS = 2;
/** A checkpoint rune counts feet from this far below to this far above its centre (m). */
export const CHECKPOINT_HEIGHT_BAND = 1.5;

// ── Hollowroot frame ────────────────────────────────────────────────────────

const ENTRANCE = LOCATIONS.hollowroot_entrance; // (−228, 128), y 14
const AXIS_LEN = Math.hypot(28, -52);
/** Shrine axis: north-north-east from the root arch, toward the old sinkhole bowl. */
export const SHRINE_AXIS: XZ = { x: 28 / AXIS_LEN, z: -52 / AXIS_LEN };
/** Across the axis (east-south-east). */
export const SHRINE_SIDE: XZ = { x: -SHRINE_AXIS.z, z: SHRINE_AXIS.x };
/** Yaw facing along the axis; OBBs with it have half.z along the axis and half.x across it. */
export const SHRINE_YAW = yawFromDir(SHRINE_AXIS.x, SHRINE_AXIS.z);
/** Distance from the arch to the spiral well's centre (m). */
const WELL_FROM_ENTRANCE = 22;
/** Centre of the spiral well: the frame origin. */
export const SHRINE_ORIGIN: XZ = {
  x: ENTRANCE.x + WELL_FROM_ENTRANCE * SHRINE_AXIS.x,
  z: ENTRANCE.z + WELL_FROM_ENTRANCE * SHRINE_AXIS.z,
};

/** World (x, z) of shrine-frame (p, q). */
export function shrinePoint(p: number, q: number): XZ {
  return {
    x: SHRINE_ORIGIN.x + p * SHRINE_AXIS.x + q * SHRINE_SIDE.x,
    z: SHRINE_ORIGIN.z + p * SHRINE_AXIS.z + q * SHRINE_SIDE.z,
  };
}

/** Shrine-frame (p, q) of world (x, z). */
export function shrineFrame(x: number, z: number): { p: number; q: number } {
  const dx = x - SHRINE_ORIGIN.x;
  const dz = z - SHRINE_ORIGIN.z;
  return { p: dx * SHRINE_AXIS.x + dz * SHRINE_AXIS.z, q: dx * SHRINE_SIDE.x + dz * SHRINE_SIDE.z };
}

const at = (p: number, q: number, y: number): Vec3 => ({ ...shrinePoint(p, q), y });
/** Yaw facing along shrine-frame direction (dp, dq). */
const facing = (dp: number, dq: number): number =>
  yawFromDir(dp * SHRINE_AXIS.x + dq * SHRINE_SIDE.x, dp * SHRINE_AXIS.z + dq * SHRINE_SIDE.z);
const spot = (p: number, q: number, y: number, dp: number, dq: number): AreaSpot => ({ pos: at(p, q, y), yaw: facing(dp, dq) });

// ── Hollowroot numbers ──────────────────────────────────────────────────────

/** Floor of the shrine rooms (design: the sinkhole floor y −10). */
export const SHRINE_FLOOR_Y = -10;
/** Upper corridor (R3) floor, 8 m above the rooms: where the root lift goes. */
export const SHRINE_UPPER_Y = -2;
/** Spiral well: floor radius and height (the fall pit, below the landing). */
const WELL_RADIUS = 6;
const WELL_FLOOR_Y = -14;
/** Terrain wall steepness of every carved piece (m per m, ≈ 76°: not walkable, climbable like any cliff). */
const WALL_SLOPE = 4;
/** Half width of corridors and of the spiral ramp. */
const CORRIDOR_HALF = 3;
/** Ramp: level for its first `SPIRAL_LEVEL_DEG`, then down to the landing; sampled every SPIRAL_STEP_DEG. */
const SPIRAL_FROM_DEG = 180;
const SPIRAL_TO_DEG = 450;
const SPIRAL_LEVEL_DEG = 30;
const SPIRAL_STEP_DEG = 15;
/** Ceilings: the underside of the roof slabs over the −10 rooms, the upper corridor and the arena. */
const CEILING_Y = 3;
const UPPER_CEILING_Y = 4;
const ARENA_CEILING_Y = 6;
/** Top of the canopy slabs, about the surrounding ground (y 15–21). */
const CANOPY_TOP_Y = 19.5;

/** Ramp height at angle φ (deg): the arch's y 14, level for 30°, then down to the landing. */
function spiralHeight(deg: number): number {
  const top = ENTRANCE.groundY;
  const t = Math.min(1, Math.max(0, (deg - SPIRAL_FROM_DEG - SPIRAL_LEVEL_DEG) / (SPIRAL_TO_DEG - SPIRAL_FROM_DEG - SPIRAL_LEVEL_DEG)));
  return top + (SHRINE_FLOOR_Y - top) * t;
}

/**
 * Ramp centreline radius at height `s`: its inner edge stays 0.6 m outside where the well's wall reaches the ramp
 * height, so the well never cuts under the ramp (16.6 m at the top, 10.6 m at the landing).
 */
function spiralRadius(s: number): number {
  return WELL_RADIUS + (s - WELL_FLOOR_Y) / WALL_SLOPE + 0.6 + CORRIDOR_HALF;
}

/** The ramp centreline from the arch to the landing, every 15°. */
const SPIRAL: readonly Vec3[] = (() => {
  const out: Vec3[] = [at(-WELL_FROM_ENTRANCE, 0, ENTRANCE.groundY)];
  for (let deg = SPIRAL_FROM_DEG; deg <= SPIRAL_TO_DEG; deg += SPIRAL_STEP_DEG) {
    const s = spiralHeight(deg);
    const r = spiralRadius(s);
    const a = (deg * Math.PI) / 180;
    out.push(at(r * Math.cos(a), r * Math.sin(a), s));
  }
  return out;
})();
const LANDING_Q = spiralRadius(SHRINE_FLOOR_Y); // 10.6

// Rooms (shrine frame).
const R2 = { p: 0, q: 25, r: 6 };
const R4 = { p: 27, q: 60, r: 8 };
/** The arena: a 17 m carve keeps every 2 m grid sample around the 14 m fight radius on the flat floor. */
const R5 = { p: 62, q: 60, r: 17 };
const R6 = { p: 90, q: 60, r: 5 };
/** Upper corridor line (q) and its turn (p) into the bent passage. */
const R3_Q = R2.q;
const R3_TURN_P = 27;
const PLATE = { p: 12.5, q: R3_Q };
/** The root door stands 12 m past the plate (design R3). */
const ROOT_DOOR_P = PLATE.p + 12;
const BOULDER = { p: R3_TURN_P, q: 31 };

/**
 * The arena floor radius the terrain reports (ELDERBOUGH_SINKHOLE): 1 m inside the 17 m carve, so a bilinear height
 * read on a grid line that far out still mixes floor samples only. The fight radius is 14 m (Req 12.1).
 */
export const HOLLOWROOT_ARENA_FLOOR_RADIUS = R5.r - 1;

const basin = (p: number, q: number, radius: number, floorY = SHRINE_FLOOR_Y): CarvePiece => ({
  kind: 'basin', center: shrinePoint(p, q), floorY, radius, wallSlope: WALL_SLOPE,
});
const trench = (points: readonly Vec3[], halfWidth = CORRIDOR_HALF): CarvePiece => ({
  kind: 'trench', points, halfWidth, wallSlope: WALL_SLOPE,
});

const HOLLOWROOT_CARVE: readonly CarvePiece[] = [
  basin(0, 0, WELL_RADIUS, WELL_FLOOR_Y), // the spiral well's pit
  trench(SPIRAL), // R0 spiral root ramp
  trench([at(0, LANDING_Q, SHRINE_FLOOR_Y), at(0, R2.q - R2.r, SHRINE_FLOOR_Y)]), // R1 landing corridor
  basin(R2.p, R2.q, R2.r), // R2
  // R3: upper corridor, the bent passage and the descent to R4.
  trench([
    at(8, R3_Q, SHRINE_UPPER_Y), at(R3_TURN_P, R3_Q, SHRINE_UPPER_Y), at(R3_TURN_P, 35, SHRINE_UPPER_Y),
    at(R3_TURN_P, R4.q - R4.r, SHRINE_FLOOR_Y),
  ]),
  basin(R4.p, R4.q, R4.r), // R4
  trench([at(R4.p + R4.r, R4.q, SHRINE_FLOOR_Y), at(R5.p - R5.r, R5.q, SHRINE_FLOOR_Y)]), // R4 → R5
  basin(R5.p, R5.q, R5.r), // R5
  trench([at(R5.p + R5.r, R5.q, SHRINE_FLOOR_Y), at(R6.p - R6.r, R6.q, SHRINE_FLOOR_Y)]), // R5 → R6
  basin(R6.p, R6.q, R6.r), // R6
];

/** OBB aligned with the shrine frame: centre (p, q), from y `y0` to `y1`, half extents along / across the axis. */
function frameBox(p: number, q: number, halfAlong: number, halfAcross: number, y0: number, y1: number): Extract<AreaShape, { kind: 'obb' }> {
  return { kind: 'obb', center: at(p, q, (y0 + y1) / 2), half: { x: halfAcross, y: (y1 - y0) / 2, z: halfAlong }, yaw: SHRINE_YAW };
}
const canopySlab = (id: string, p: number, q: number, halfAlong: number, halfAcross: number, ceiling: number): AreaPieceDef => ({
  id, look: 'canopy', walkableTop: true, shape: frameBox(p, q, halfAlong, halfAcross, ceiling, CANOPY_TOP_Y),
});
const canopyDisc = (id: string, p: number, q: number, radius: number, ceiling: number): AreaPieceDef => ({
  id, look: 'canopy', walkableTop: true, shape: { kind: 'cylinder', base: at(p, q, ceiling), radius, height: CANOPY_TOP_Y - ceiling },
});
/** Canopy margin beyond a floor: the walls reach the ceiling (13 m up) 3.25 m out; the slab covers 1.5 m more. */
const SLAB_MARGIN = (CEILING_Y - SHRINE_FLOOR_Y) / WALL_SLOPE + 1.5;
const SLAB_HALF = CORRIDOR_HALF + SLAB_MARGIN;

const HOLLOWROOT_PIECES: readonly AreaPieceDef[] = [
  // The root canopy over everything past the well (the ramp and the pit stay open to the sky).
  canopySlab('hr_canopy_r1', 0, (12 + R2.q) / 2, SLAB_HALF, (R2.q - 12) / 2, CEILING_Y),
  canopyDisc('hr_canopy_r2', R2.p, R2.q, R2.r + SLAB_MARGIN, CEILING_Y),
  canopySlab('hr_canopy_r3', (8 + R3_TURN_P + SLAB_HALF) / 2, R3_Q, (R3_TURN_P + SLAB_HALF - 8) / 2, SLAB_HALF, UPPER_CEILING_Y),
  canopySlab('hr_canopy_r3_descent', R3_TURN_P, (R3_Q + R4.q - R4.r) / 2, SLAB_HALF + 1, (R4.q - R4.r - R3_Q) / 2, UPPER_CEILING_Y),
  canopyDisc('hr_canopy_r4', R4.p, R4.q, R4.r + SLAB_MARGIN, CEILING_Y),
  canopySlab('hr_canopy_r4_r5', (R4.p + R5.p) / 2, R4.q, (R5.p - R4.p) / 2 - 6, SLAB_HALF, CEILING_Y),
  canopyDisc('hr_canopy_r5', R5.p, R5.q, R5.r + (ARENA_CEILING_Y - SHRINE_FLOOR_Y) / WALL_SLOPE + 1.5, ARENA_CEILING_Y),
  canopySlab('hr_canopy_r5_r6', (R5.p + R5.r + R6.p - R6.r) / 2, R5.q, (R6.p - R6.r - R5.p - R5.r) / 2 + 2, SLAB_HALF, CEILING_Y),
  canopyDisc('hr_canopy_r6', R6.p, R6.q, R6.r + SLAB_MARGIN, CEILING_Y),
  // The 8 m step from R2 up to the upper corridor, faced with roots nobody can climb, up to the canopy.
  { id: 'hr_lift_wall', look: 'rootWall', walkableTop: false, shape: frameBox(7, R3_Q, 0.4, SLAB_HALF, SHRINE_FLOOR_Y, CEILING_Y + 0.2) },
];

/**
 * A door from `floor` to just above `ceiling`, reaching into the walls on both sides: thin along the axis for a
 * corridor running along it (`alongAxis`), else thin across it.
 */
const door = (id: string, name: string, look: AreaLook, p: number, q: number, alongAxis: boolean, floor: number, ceiling: number,
  openWhen: DoorOpenCondition): AreaDoorDef => ({
  id, name, look, openWhen,
  shape: alongAxis ? frameBox(p, q, 0.45, SLAB_HALF, floor, ceiling + 0.2) : frameBox(p, q, SLAB_HALF, 0.45, floor, ceiling + 0.2),
});

export const HOLLOWROOT_ROOM_GROUP = 'hollowroot_room';

const HOLLOWROOT_DOORS: readonly AreaDoorDef[] = [
  // R1: the thicket behind the bramble device burns away with it.
  door('hr_door_bramble', '가시 덤불', 'bramble', 0, 15, false, SHRINE_FLOOR_Y, CEILING_Y, { kind: 'puzzleSolved', puzzleId: 'pz_hollowroot_1' }),
  // R3: the root door, open while the plate is held; fixed open once the boulder behind it breaks.
  door('hr_door_root', '뿌리 문', 'rootDoor', ROOT_DOOR_P, R3_Q, true, SHRINE_UPPER_Y, UPPER_CEILING_Y,
    { kind: 'puzzleOpen', target: 'hollowroot_root_door' }),
  // R3: rubble around the cracked boulder, cleared when it breaks.
  door('hr_door_boulder', '금 간 바위', 'rubble', BOULDER.p, BOULDER.q + 0.9, false, SHRINE_UPPER_Y, UPPER_CEILING_Y,
    { kind: 'puzzleSolved', puzzleId: 'pz_hollowroot_3' }),
  // R4: the entrance locks behind the party while the fight runs; the far door opens once it is won.
  door('hr_door_room_in', '뿌리 전투 방 입구', 'rootGate', R4.p, R4.q - R4.r - 0.5, false, SHRINE_FLOOR_Y, CEILING_Y,
    { kind: 'roomUnlocked', groupId: HOLLOWROOT_ROOM_GROUP }),
  door('hr_door_room_out', '뿌리 전투 방 출구', 'rootGate', R4.p + R4.r + 0.5, R4.q, true, SHRINE_FLOOR_Y, CEILING_Y,
    { kind: 'roomCleared', groupId: HOLLOWROOT_ROOM_GROUP }),
  // R5 → R6: opens with the Rootbound Warden's defeat.
  door('hr_door_skyshard', 'Skyshard 방 뿌리 문', 'rootGate', R6.p - R6.r - 2.5, R6.q, true, SHRINE_FLOOR_Y, CEILING_Y,
    { kind: 'eliteDefeated', elite: 'rootboundWarden' }),
];

/** Elderbough foot beside ws_elderbough (well inside its flat pad, y 14): where the exit lift comes up. */
const ELDERBOUGH_FOOT: AreaSpot = {
  pos: { x: LOCATIONS.ws_elderbough.x + 1, y: LOCATIONS.ws_elderbough.groundY, z: LOCATIONS.ws_elderbough.z },
  yaw: yawFromDir(1, 0.3),
};

const HOLLOWROOT_LIFTS: readonly AreaLiftDef[] = [
  { id: 'lift_hollowroot_up', name: '뿌리 승강기 (윗 회랑)', pad: at(3.6, R2.q + 0.5, SHRINE_FLOOR_Y),
    to: spot(10, R3_Q, SHRINE_UPPER_Y, 1, 0), when: { kind: 'puzzleSolved', puzzleId: 'pz_hollowroot_2' } },
  { id: 'lift_hollowroot_down', name: '뿌리 승강기 (아래층)', pad: at(9.6, R3_Q + 2.2, SHRINE_UPPER_Y),
    to: spot(3, R2.q, SHRINE_FLOOR_Y, -1, 0), when: { kind: 'puzzleSolved', puzzleId: 'pz_hollowroot_2' } },
  // R6: once Skyshard 1 is held the room's root lift carries the party up to the Elderbough foot (Req 12.9).
  { id: 'lift_hollowroot_exit', name: 'Elderbough 기슭으로 오르는 뿌리 승강기', pad: at(R6.p - 1, R6.q + 3, SHRINE_FLOOR_Y),
    to: ELDERBOUGH_FOOT, when: { kind: 'skyshard', index: 1 } },
];

const HOLLOWROOT_CHECKPOINTS: readonly CheckpointDef[] = [
  { id: 'cp_hollowroot_1', spot: spot(0, 17.5, SHRINE_FLOOR_Y, 0, 1), radius: CHECKPOINT_RADIUS },
  { id: 'cp_hollowroot_2', spot: spot((R4.p + R4.r + R5.p - R5.r) / 2, R4.q, SHRINE_FLOOR_Y, 1, 0), radius: CHECKPOINT_RADIUS,
    litWhen: { kind: 'roomCleared', groupId: HOLLOWROOT_ROOM_GROUP } },
];

/** Where the puzzle parts stand (src/data/puzzles.ts HOLLOWROOT_PUZZLES). */
export const HOLLOWROOT_DEVICES = {
  bramble: at(0, 14, SHRINE_FLOOR_Y),
  windWheel: at(-3.8, R2.q + 2.5, SHRINE_FLOOR_Y),
  plate: at(PLATE.p, PLATE.q, SHRINE_UPPER_Y),
  boulder: at(BOULDER.p, BOULDER.q, SHRINE_UPPER_Y),
  /** What each puzzle opens (its `opens` target point). */
  bramblePath: at(0, 15, SHRINE_FLOOR_Y),
  rootLift: at(3.6, R2.q + 0.5, SHRINE_FLOOR_Y),
  rootDoor: at(ROOT_DOOR_P, R3_Q, SHRINE_UPPER_Y),
} as const;

/** Spawn points of the shrine's encounter groups (src/data/spawns.ts). */
export const HOLLOWROOT_SPAWNS = {
  /** R4: bramblekin ×4 around the middle, thornspitter ×2 behind them toward the far wall; all face the entrance. */
  room: {
    bramblekin: [at(R4.p - 3, R4.q - 2, SHRINE_FLOOR_Y), at(R4.p + 3, R4.q - 2, SHRINE_FLOOR_Y), at(R4.p - 2, R4.q + 2, SHRINE_FLOOR_Y),
      at(R4.p + 2, R4.q + 2, SHRINE_FLOOR_Y)],
    thornspitter: [at(R4.p - 3.5, R4.q + 4.5, SHRINE_FLOOR_Y), at(R4.p + 3.5, R4.q + 4.5, SHRINE_FLOOR_Y)],
    yaw: facing(0, -1),
  },
} as const;

const R5_CENTER = at(R5.p, R5.q, SHRINE_FLOOR_Y);

/** Hollowroot Shrine (design "Hollowroot Shrine (전투와 기본 퍼즐)"). */
export const HOLLOWROOT: ChallengeAreaDef & { readonly exitLift: string } = {
  id: 'hollowroot',
  region: 'verdant',
  music: 'mus_area_hollowroot',
  lighting: {
    fogColor: 0x1f3a2a,
    fogNear: 6,
    fogFar: 70,
    glow: 0x9dff8a,
    lights: [at(0, 0, -6), at(0, 16, -6), at(R2.p, R2.q, -5), at(18, R3_Q, 1), at(R4.p, R4.q, -4), at(R5.p, R5.q, 0), at(R6.p, R6.q, -4)],
  },
  bounds: {
    center: shrinePoint(36, 27),
    halfAlong: 61,
    halfAcross: 52,
    yaw: SHRINE_YAW,
    minY: -16,
    // Below the arch (y 14): the area is entered from inside the sinkhole, not from the ground above.
    maxY: 12,
  },
  entrance: { pos: at(-WELL_FROM_ENTRANCE + 1, 0, ENTRANCE.groundY), yaw: facing(1, 0) },
  rooms: [
    { id: 'R0', name: '뿌리 아치 입구와 나선 뿌리 경사로', center: { x: ENTRANCE.x, y: ENTRANCE.groundY, z: ENTRANCE.z }, radius: CORRIDOR_HALF },
    { id: 'R1', name: '가시 덤불 관문', center: at(0, 14, SHRINE_FLOOR_Y), radius: CORRIDOR_HALF },
    { id: 'R2', name: '바람개비 승강기', center: at(R2.p, R2.q, SHRINE_FLOOR_Y), radius: R2.r },
    { id: 'R3', name: '압력판과 금 간 바위 회랑', center: at((8 + R3_TURN_P) / 2, R3_Q, SHRINE_UPPER_Y), radius: CORRIDOR_HALF },
    { id: 'R4', name: '뿌리 전투 방', center: at(R4.p, R4.q, SHRINE_FLOOR_Y), radius: R4.r },
    { id: 'R5', name: 'Rootbound Warden 투기장', center: R5_CENTER, radius: R5.r },
    { id: 'R6', name: 'Skyshard 방', center: at(R6.p, R6.q, SHRINE_FLOOR_Y), radius: R6.r },
  ],
  route: [
    ...SPIRAL.map((pos): RoutePoint => ({ pos, room: 'R0' })),
    { pos: at(0, 11.8, SHRINE_FLOOR_Y), room: 'R1' }, // in front of the bramble
    { pos: at(0, 17.5, SHRINE_FLOOR_Y), room: 'R1' }, // cp_hollowroot_1
    { pos: at(0, R2.q, SHRINE_FLOOR_Y), room: 'R2' },
    { pos: at(3.6, R2.q + 0.5, SHRINE_FLOOR_Y), room: 'R2' }, // lift pad
    { pos: at(10, R3_Q, SHRINE_UPPER_Y), room: 'R3', lift: 'lift_hollowroot_up' },
    { pos: at(10.5, R3_Q - 1.5, SHRINE_UPPER_Y), room: 'R3' }, // beside the plate (a pillar may stand on it)
    { pos: at(14.5, R3_Q - 1.5, SHRINE_UPPER_Y), room: 'R3' }, // past the plate
    { pos: at(ROOT_DOOR_P + 2, R3_Q, SHRINE_UPPER_Y), room: 'R3' },
    { pos: at(R3_TURN_P, R3_Q + 1, SHRINE_UPPER_Y), room: 'R3' },
    { pos: at(R3_TURN_P, BOULDER.q - 2.2, SHRINE_UPPER_Y), room: 'R3' }, // in front of the boulder
    { pos: at(R3_TURN_P, 35, SHRINE_UPPER_Y), room: 'R3' },
    { pos: at(R4.p, R4.q - R4.r, SHRINE_FLOOR_Y), room: 'R4' },
    { pos: at(R4.p, R4.q, SHRINE_FLOOR_Y), room: 'R4' },
    { pos: at(R4.p + R4.r + 3, R4.q, SHRINE_FLOOR_Y), room: 'R4' },
    { pos: at((R4.p + R4.r + R5.p - R5.r) / 2, R4.q, SHRINE_FLOOR_Y), room: 'R5' }, // cp_hollowroot_2
    { pos: at(R5.p - 6, R5.q, SHRINE_FLOOR_Y), room: 'R5' },
    { pos: at(R5.p + R5.r + 1, R5.q, SHRINE_FLOOR_Y), room: 'R6' },
    { pos: at(R6.p, R6.q, SHRINE_FLOOR_Y), room: 'R6' },
  ],
  carve: HOLLOWROOT_CARVE,
  pieces: HOLLOWROOT_PIECES,
  doors: HOLLOWROOT_DOORS,
  lifts: HOLLOWROOT_LIFTS,
  checkpoints: HOLLOWROOT_CHECKPOINTS,
  combatRooms: [{ groupId: HOLLOWROOT_ROOM_GROUP, center: at(R4.p, R4.q, SHRINE_FLOOR_Y), radius: R4.r - 1.5 }],
  arena: { elite: 'rootboundWarden', center: R5_CENTER, radius: 14, guardian: spot(R5.p + 4, R5.q, SHRINE_FLOOR_Y, -1, 0) },
  hazards: [{ id: 'hazard_hollowroot_well', center: SHRINE_ORIGIN, radius: WELL_RADIUS + 2, minY: WELL_FLOOR_Y - 2, maxY: SHRINE_FLOOR_Y - 1 }],
  skyshard: { index: 1, pos: at(R6.p + 2, R6.q, SHRINE_FLOOR_Y) },
  ledges: [],
  legs: [],
  updrafts: [],
  heatWalls: [],
  risers: [],
  exitLift: 'lift_hollowroot_exit',
};

// ── Cinderspire ─────────────────────────────────────────────────────────────
/*
 * Cinderspire (design "Cinderspire (수직 이동과 활강)", task 9.7; Req 12.2, 12.6, 13.8, 13.9, 2.3): an outdoor cluster of
 * charcoal-rock and orange-crystal spires standing on the canyon floor (y ≈ 6) east of cinderspire_base, climbed and
 * glided from spire A over spire B to the summit arena (cinderspire_summit, y 95). The layout is built backwards from
 * the summit: U2 stands 16 + 27 m south of it, spire B 8 m south-west of U2, U1 28.5 m back along the G1 heading and
 * spire A 11 m north of U1, beside the base pad.
 * - Foot ramp (walk, y 6 → 20): 35 crystal steps of 0.4 m (walkable up, below the 0.45 m step-up) wind 250° around
 *   spire A's lower tier from the base pad to the tier's top ring, rest ledge L1. The arc left open faces the canyon,
 *   so the path in from ws_ember never meets a step.
 * - C1 (climb 12 m, 20 → 32): spire A's upper crystal tier; its top is rest ledge L2 with cp_cinderspire_1.
 * - U1 (Updraft 32 → 58): the heat vent 11 m south of spire A, a 4 m column from y 28 (so nothing below L2 rides it).
 * - G1 (glide 58 → 52): 18 m from the U1 axis to the near edge of rest ledge L3 on spire B, arriving 1 m above it.
 * - H1 (climb 12 m on the Heat_Crystal wall, 52 → 64): pz_cinderspire_1 (allOf: the wall + the L4 arrival). The block
 *   behind the wall is hot crystal nobody can climb, so H1 is the only way up; the wall is climbable for 10 s after
 *   Isla's Tide, warns for its last 2 s, and a reheated wall drops the climber back onto L3 below.
 * - L4 (the hot block's top, y 64) holds cp_cinderspire_2; C3 (climb 12 m, 64 → 76) climbs spire B's crystal top
 *   tier to rest ledge L5.
 * - U2 (Updraft 76 → 104): the vent beside L5, from y 72; G2 (glide 104 → 95) crosses 27 m north to the summit
 *   platform's edge, arriving 1.5 m above it, where Cinder Alpha guards the 14 m arena.
 * - Unstable_Crystal clusters (pz_cinderspire_2 / _3) stand on the L2 and L5 rims toward the vents. Ember primes one:
 *   after its 1 s Telegraph a 4 m blast hurts the party too, and the vent ledge it was holding back slides out, a
 *   walk-off straight into the column (the way without it is a jump from another side and a turn into the column).
 * - After Skyshard 2 (in the crystal cage on the summit, open once Cinder Alpha falls) 35 crystal stairs rise from the
 *   platform's west edge down toward ws_ember: 2.5 m drops every 3 m to the canyon floor, the exit (Req 12.9).
 * The floor around spire B, under G2 and under the summit is the fall judgement (glowing embers) until Skyshard 2;
 * the base pad, the ramp and the canyon path in stay outside it.
 */

const CS_SUMMIT = LOCATIONS.cinderspire_summit; // (340, 100), y 95
const CS_BASE = LOCATIONS.cinderspire_base; // (330, 120), y 6

/** Heights of the route (design table): base, rest ledges, Updraft tops, summit. */
export const CINDERSPIRE_Y = {
  base: CS_BASE.groundY,
  L1: 20,
  L2: 32,
  U1: 58,
  L3: 52,
  L4: 64,
  L5: 76,
  U2: 104,
  summit: CS_SUMMIT.groundY,
} as const;

/** Summit platform radius; the Cinder Alpha arena inside it is 14 m (Req 12.2). */
export const CINDERSPIRE_SUMMIT_RADIUS = 16;
export const CINDERSPIRE_ARENA_RADIUS = 14;
/** Every Cinderspire Updraft column's radius (wider than the 2.6 m glide turning radius). */
export const CINDERSPIRE_UPDRAFT_RADIUS = 4;
/** Horizontal glide distances (design G1 / G2): Updraft axis → near edge of the landing surface (m). */
const G1_RUN = 18;
const G2_RUN = 27;
/** Updraft columns start this far below their take-off ledge. */
const VENT_BELOW_LEDGE = 4;

const unitXZ = (x: number, z: number): XZ => {
  const l = Math.hypot(x, z);
  return { x: x / l, z: z / l };
};
const alongXZ = (p: XZ, d: XZ, s: number): XZ => ({ x: p.x + d.x * s, z: p.z + d.z * s });
const onXZ = (p: XZ, y: number): Vec3 => ({ x: p.x, y, z: p.z });

/** G2 heading: from U2 north to the summit. */
const G2_DIR: XZ = { x: 0, z: -1 };
/** U2's axis, 16 + 27 m south of the summit centre. */
const CS_U2: XZ = alongXZ(CS_SUMMIT, G2_DIR, -(CINDERSPIRE_SUMMIT_RADIUS + G2_RUN));
/** Spire B's axis, 8 m south-west of U2. */
const CS_B: XZ = alongXZ(CS_U2, unitXZ(-0.6, 0.8), 8);
/** G1 heading (south-south-east): U1 → L3, and spire B's frame axis (`along`). */
const G1_DIR: XZ = unitXZ(1, Math.sqrt(3));
const B_YAW = yawFromDir(G1_DIR.x, G1_DIR.z);
/** Spire B's `across` axis (an OBB's local +X at B_YAW). */
const B_ACROSS: XZ = { x: G1_DIR.z, z: -G1_DIR.x };

// Spire B, in its frame (`along` G1_DIR, `across` B_ACROSS, metres from its axis).
/** Tier 2 (the hot crystal block, 52 → 64) half size; L4 is its top. */
const B_BLOCK_HALF = 5;
/** Heat_Crystal wall on the block's face toward U1: its thickness. */
const HEAT_WALL_THICK = 0.5;
/** L3 depth in front of the wall (tier 1's top strip). */
const L3_DEPTH = 5;
/** Tier 3 (crystal, 64 → 76) half size; L5 is its top. */
const B_TOP_HALF = 1.75;
/** `along` of the wall's outer face and of L3's near edge. */
const WALL_FACE = -(B_BLOCK_HALF + HEAT_WALL_THICK);
const L3_EDGE = WALL_FACE - L3_DEPTH;
/** L4's rune and arrival trigger: the middle of the block's top between the wall and tier 3. */
const L4_SPOT = (WALL_FACE + -B_TOP_HALF) / 2;

/** World (x, z) of spire B frame (along, across). */
function bPoint(along: number, across: number): XZ {
  return { x: CS_B.x + along * G1_DIR.x + across * B_ACROSS.x, z: CS_B.z + along * G1_DIR.z + across * B_ACROSS.z };
}
const bAt = (along: number, across: number, y: number): Vec3 => onXZ(bPoint(along, across), y);
/** A box of spire B's frame: `along` from a0 to a1, `across` ±half, from y0 to y1. */
function bBox(a0: number, a1: number, half: number, y0: number, y1: number): Extract<AreaShape, { kind: 'obb' }> {
  return { kind: 'obb', center: bAt((a0 + a1) / 2, 0, (y0 + y1) / 2), half: { x: half, y: (y1 - y0) / 2, z: (a1 - a0) / 2 }, yaw: B_YAW };
}

/** U1's axis: G1's horizontal plus L3's near edge back from spire B along G1. */
const CS_U1: XZ = bPoint(L3_EDGE - G1_RUN, 0);
/** Spire A's axis, 11 m north of U1. */
const CS_A: XZ = alongXZ(CS_U1, { x: 0, z: -1 }, 11);
/** Spire A: lower tier (floor → L1 ring) and upper tier (C1, top L2). */
const A_LOWER_R = 7;
const A_UPPER_R = 3.5;

// Foot ramp around spire A's lower tier.
const RAMP_STEPS = 35;
const RAMP_RISE = (CINDERSPIRE_Y.L1 - CINDERSPIRE_Y.base) / RAMP_STEPS; // 0.4 m
const RAMP_RADIUS = A_LOWER_R + 0.3 + 1.5; // centreline: 0.3 m off the tier, 3 m wide
const RAMP_HALF_WIDTH = 1.5;
const RAMP_STEP_RUN = 1.1; // centreline arc per step
const RAMP_START_DEG = 25; // on the base pad's side; the ramp winds toward decreasing angles
const RAMP_STEP_RAD = RAMP_STEP_RUN / RAMP_RADIUS;
/** Angle (rad, x = cos, z = sin about spire A) of step k's centre (k = 1…35). */
const rampAngle = (k: number): number => (RAMP_START_DEG * Math.PI) / 180 - (k - 0.5) * RAMP_STEP_RAD;
const aPoint = (angle: number, r: number): XZ => ({ x: CS_A.x + r * Math.cos(angle), z: CS_A.z + r * Math.sin(angle) });
/** Walking direction of the ramp at `angle` (toward decreasing angles). */
const rampHeading = (angle: number): number => yawFromDir(Math.sin(angle), -Math.cos(angle));

const RAMP_PIECES: readonly AreaPieceDef[] = Array.from({ length: RAMP_STEPS }, (_, i) => {
  const k = i + 1;
  const a = rampAngle(k);
  const top = CINDERSPIRE_Y.base + RAMP_RISE * k;
  return {
    id: `cs_ramp_${k}`,
    look: 'crystalStep',
    walkableTop: true,
    // Each step is a crystal column down to the floor, a little longer than its arc so neighbours overlap.
    shape: { kind: 'obb', center: onXZ(aPoint(a, RAMP_RADIUS), top / 2), half: { x: RAMP_HALF_WIDTH, y: top / 2, z: RAMP_STEP_RUN / 2 + 0.08 }, yaw: rampHeading(a) },
  };
});
/** Where the ramp's top step meets the L1 ring, and the C1 wall foot beside the upper tier there. */
const RAMP_END_ANGLE = rampAngle(RAMP_STEPS);
const L1_POINT = aPoint(RAMP_END_ANGLE, (A_LOWER_R + A_UPPER_R) / 2);
const C1_FOOT = aPoint(RAMP_END_ANGLE, A_UPPER_R + 0.8);

/** Unit direction from spire A to U1 and from spire B to U2. */
const A_TO_U1 = unitXZ(CS_U1.x - CS_A.x, CS_U1.z - CS_A.z);
const B_TO_U2 = unitXZ(CS_U2.x - CS_B.x, CS_U2.z - CS_B.z);
const U1_FROM_A = Math.hypot(CS_U1.x - CS_A.x, CS_U1.z - CS_A.z); // 11
const U2_FROM_B = Math.hypot(CS_U2.x - CS_B.x, CS_U2.z - CS_B.z); // 8
/** A vent ledge ends this far from its column's axis: the column radius and the capsule's (a glider never clips it). */
const LEDGE_END_FROM_AXIS = CINDERSPIRE_UPDRAFT_RADIUS + 0.4;

/** A box from `from` toward `dir`, s ∈ [s0, s1], ±half wide, from y0 to y1. */
function rayBox(from: XZ, dir: XZ, s0: number, s1: number, half: number, y0: number, y1: number): Extract<AreaShape, { kind: 'obb' }> {
  return {
    kind: 'obb', center: onXZ(alongXZ(from, dir, (s0 + s1) / 2), (y0 + y1) / 2), half: { x: half, y: (y1 - y0) / 2, z: (s1 - s0) / 2 },
    yaw: yawFromDir(dir.x, dir.z),
  };
}

// Exit stairs (Req 12.9): from the platform's west edge toward ws_ember.
const EXIT_STEPS = 35;
const EXIT_DROP = 2.5;
const EXIT_RUN = 3;
const EXIT_START: XZ = { x: CS_SUMMIT.x - CINDERSPIRE_SUMMIT_RADIUS, z: CS_SUMMIT.z };
const EXIT_DIR = unitXZ(LOCATIONS.ws_ember.x - EXIT_START.x, LOCATIONS.ws_ember.z - EXIT_START.z);
const EXIT_RISERS: readonly RiserDef[] = Array.from({ length: EXIT_STEPS }, (_, i) => {
  const top = CINDERSPIRE_Y.summit - EXIT_DROP * (i + 1);
  return {
    id: `cs_exit_stair_${i + 1}`,
    look: 'exitStair',
    shape: rayBox(EXIT_START, EXIT_DIR, EXIT_RUN * i - 0.05, EXIT_RUN * (i + 1) + 0.05, 1.6, top - 1.5, top),
    when: { kind: 'skyshard', index: 2 },
    delay: 0.08 * i,
  };
});
/** The bottom of the exit stairs (feet on the canyon floor past the last step), for the route. */
export const CINDERSPIRE_EXIT_END: XZ = alongXZ(EXIT_START, EXIT_DIR, EXIT_RUN * EXIT_STEPS + 3);

/** Where the puzzle parts stand (src/data/puzzles.ts CINDERSPIRE_PUZZLES) and what they open. */
export const CINDERSPIRE_DEVICES = {
  /** H1: the Heat_Crystal wall's outer face at L3's floor (its hurt capsule reaches out over L3). */
  heatWall: bAt(WALL_FACE, 0, CINDERSPIRE_Y.L3),
  /** H1: the L4 arrival trigger (on the rune of cp_cinderspire_2). */
  heatWallTop: bAt(L4_SPOT, 0, CINDERSPIRE_Y.L4),
  /** Unstable_Crystal clusters on the L2 and L5 rims toward U1 / U2. */
  clusterU1: onXZ(alongXZ(CS_A, A_TO_U1, 2.6), CINDERSPIRE_Y.L2),
  clusterU2: onXZ(alongXZ(CS_B, B_TO_U2, 1.6), CINDERSPIRE_Y.L5),
  /** The vent ledges the clusters hold back (their riser centres at the ledge tops). */
  ventLedgeU1: onXZ(alongXZ(CS_A, A_TO_U1, (3 + U1_FROM_A - LEDGE_END_FROM_AXIS) / 2), CINDERSPIRE_Y.L2),
  ventLedgeU2: onXZ(alongXZ(CS_B, B_TO_U2, (1.5 + U2_FROM_B - LEDGE_END_FROM_AXIS) / 2), CINDERSPIRE_Y.L5),
} as const;

/** Unstable_Crystal puzzle parts whose blast opens a vent ledge (src/data/puzzles.ts). */
export const CINDERSPIRE_CLUSTER_PARTS = { u1: 'pz_cinderspire_2_cluster', u2: 'pz_cinderspire_3_cluster' } as const;

const CS_UPDRAFTS: readonly AreaUpdraftDef[] = [
  { id: 'updraft_cinderspire_1', center: CS_U1, radius: CINDERSPIRE_UPDRAFT_RADIUS, minY: CINDERSPIRE_Y.L2 - VENT_BELOW_LEDGE, maxY: CINDERSPIRE_Y.U1 },
  { id: 'updraft_cinderspire_2', center: CS_U2, radius: CINDERSPIRE_UPDRAFT_RADIUS, minY: CINDERSPIRE_Y.L5 - VENT_BELOW_LEDGE, maxY: CINDERSPIRE_Y.U2 },
];

const CS_PIECES: readonly AreaPieceDef[] = [
  ...RAMP_PIECES,
  // Spire A: the lower tier's top is the L1 ring, the upper crystal tier (C1) carries L2.
  { id: 'cs_spire_a_lower', look: 'spireRock', walkableTop: true, climbable: true,
    shape: { kind: 'cylinder', base: onXZ(CS_A, 0), radius: A_LOWER_R, height: CINDERSPIRE_Y.L1 } },
  { id: 'cs_spire_a_upper', look: 'spireCrystal', walkableTop: true, climbable: true,
    shape: { kind: 'cylinder', base: onXZ(CS_A, CINDERSPIRE_Y.L1), radius: A_UPPER_R, height: CINDERSPIRE_Y.L2 - CINDERSPIRE_Y.L1 } },
  // Spire B: rock up to L3 (its top strip in front of the wall), the hot block (L4 on top), the crystal top tier (C3, L5).
  { id: 'cs_spire_b_lower', look: 'spireRock', walkableTop: true, climbable: true,
    shape: bBox(L3_EDGE, B_BLOCK_HALF, B_BLOCK_HALF, 0, CINDERSPIRE_Y.L3) },
  { id: 'cs_spire_b_block', look: 'hotCrystal', walkableTop: true,
    shape: bBox(-B_BLOCK_HALF, B_BLOCK_HALF, B_BLOCK_HALF, CINDERSPIRE_Y.L3, CINDERSPIRE_Y.L4) },
  { id: 'cs_spire_b_top', look: 'spireCrystal', walkableTop: true, climbable: true,
    shape: bBox(-B_TOP_HALF, B_TOP_HALF, B_TOP_HALF, CINDERSPIRE_Y.L4, CINDERSPIRE_Y.L5) },
  // The summit: a rock column under the 16 m platform (its rim can be grabbed by a glider arriving low).
  { id: 'cs_summit_column', look: 'spireRock', walkableTop: false, climbable: true,
    shape: { kind: 'cylinder', base: onXZ(CS_SUMMIT, 0), radius: 5, height: CINDERSPIRE_Y.summit - 2 } },
  { id: 'cs_summit_floor', look: 'summitFloor', walkableTop: true, climbable: true,
    shape: { kind: 'cylinder', base: onXZ(CS_SUMMIT, CINDERSPIRE_Y.summit - 2), radius: CINDERSPIRE_SUMMIT_RADIUS, height: 2 } },
];

/** Skyshard 2 on the summit's north side, in a crystal cage that opens with Cinder Alpha's defeat. */
const CS_SKYSHARD: Vec3 = { x: CS_SUMMIT.x, y: CINDERSPIRE_Y.summit, z: CS_SUMMIT.z - 11 };

const CS_DOORS: readonly AreaDoorDef[] = [
  { id: 'cs_door_skyshard', name: 'Skyshard 수정 우리', look: 'crystalCage', openWhen: { kind: 'eliteDefeated', elite: 'cinderAlpha' },
    shape: { kind: 'obb', center: { x: CS_SKYSHARD.x, y: CS_SKYSHARD.y + 1.6, z: CS_SKYSHARD.z }, half: { x: 1.5, y: 1.6, z: 1.5 }, yaw: 0 } },
];

const CS_HEAT_WALLS: readonly HeatWallDef[] = [
  { id: 'cs_heat_wall', part: 'pz_cinderspire_1_wall', shape: bBox(WALL_FACE, -B_BLOCK_HALF, B_BLOCK_HALF, CINDERSPIRE_Y.L3, CINDERSPIRE_Y.L4) },
];

const CS_RISERS: readonly RiserDef[] = [
  { id: 'cs_vent_ledge_1', look: 'ventLedge', when: { kind: 'partGone', part: CINDERSPIRE_CLUSTER_PARTS.u1 }, delay: 0,
    shape: rayBox(CS_A, A_TO_U1, 3, U1_FROM_A - LEDGE_END_FROM_AXIS, 1, CINDERSPIRE_Y.L2 - 1, CINDERSPIRE_Y.L2) },
  { id: 'cs_vent_ledge_2', look: 'ventLedge', when: { kind: 'partGone', part: CINDERSPIRE_CLUSTER_PARTS.u2 }, delay: 0,
    shape: rayBox(CS_B, B_TO_U2, 1.5, U2_FROM_B - LEDGE_END_FROM_AXIS, 1, CINDERSPIRE_Y.L5 - 1, CINDERSPIRE_Y.L5) },
  ...EXIT_RISERS,
];

const L1: RestLedgeDef = { id: 'L1', name: '첨탑 A 아래층 고리', center: onXZ(L1_POINT, CINDERSPIRE_Y.L1), width: A_LOWER_R - A_UPPER_R };
const L2: RestLedgeDef = { id: 'L2', name: '첨탑 A 꼭대기', center: onXZ(CS_A, CINDERSPIRE_Y.L2), width: 2 * A_UPPER_R };
const L3: RestLedgeDef = { id: 'L3', name: '과열 수정 벽 앞 착지 발판', center: bAt((L3_EDGE + WALL_FACE) / 2, 0, CINDERSPIRE_Y.L3), width: L3_DEPTH };
const L4: RestLedgeDef = { id: 'L4', name: '과열 수정 블록 위', center: bAt(L4_SPOT, 0, CINDERSPIRE_Y.L4), width: B_BLOCK_HALF - B_TOP_HALF };
const L5: RestLedgeDef = { id: 'L5', name: '첨탑 B 꼭대기', center: bAt(0, 0, CINDERSPIRE_Y.L5), width: 2 * B_TOP_HALF };

/**
 * Take-off spots for the Updrafts without a vent ledge, on a rim clear of the cluster: from L2 straight for U1's column,
 * from L5 off its side (spire B's `across`), turning into U2's column once the glider is open.
 */
const U1_JUMP_FROM = aPoint(Math.PI / 4, A_UPPER_R - 0.3);
const U2_JUMP_FROM = bPoint(B_TOP_HALF - 0.55, B_TOP_HALF - 0.3);
const headingTo = (from: XZ, to: XZ): number => yawFromDir(to.x - from.x, to.z - from.z);

/** The ramp walk: from the pad before step 1 over every third step centre and the top step onto the L1 ring. */
const RAMP_POINTS: readonly Vec3[] = [
  onXZ(aPoint(rampAngle(0), RAMP_RADIUS), CINDERSPIRE_Y.base),
  ...Array.from({ length: RAMP_STEPS }, (_, i) => i + 1)
    .filter((k) => k % 3 === 0 || k === RAMP_STEPS)
    .map((k) => onXZ(aPoint(rampAngle(k), RAMP_RADIUS), CINDERSPIRE_Y.base + RAMP_RISE * k)),
  L1.center,
];

const CS_LEGS: readonly AreaLegDef[] = [
  { kind: 'walk', id: 'ramp', name: '기슭 경사로', fromY: CINDERSPIRE_Y.base, toY: CINDERSPIRE_Y.L1, to: 'L1', points: RAMP_POINTS },
  {
    kind: 'climb', id: 'C1', name: '첨탑 A 수정 벽', fromY: CINDERSPIRE_Y.L1, toY: CINDERSPIRE_Y.L2, from: 'L1', to: 'L2', mandatory: true,
    foot: onXZ(C1_FOOT, CINDERSPIRE_Y.L1), top: L2.center, face: headingTo(C1_FOOT, CS_A),
  },
  {
    kind: 'updraft', id: 'U1', name: '첫 번째 열기 분출구', fromY: CINDERSPIRE_Y.L2, toY: CINDERSPIRE_Y.U1, from: 'L2', updraft: 'updraft_cinderspire_1',
    jump: { pos: onXZ(U1_JUMP_FROM, CINDERSPIRE_Y.L2), yaw: headingTo(U1_JUMP_FROM, CS_U1) },
  },
  {
    kind: 'glide', id: 'G1', name: '첨탑 B로 활강', fromY: CINDERSPIRE_Y.U1, toY: CINDERSPIRE_Y.L3, updraft: 'updraft_cinderspire_1', to: 'L3',
    start: onXZ(CS_U1, CINDERSPIRE_Y.U1), landing: bAt(L3_EDGE, 0, CINDERSPIRE_Y.L3), horizontal: G1_RUN,
  },
  {
    kind: 'climb', id: 'H1', name: '과열 수정 벽', fromY: CINDERSPIRE_Y.L3, toY: CINDERSPIRE_Y.L4, from: 'L3', to: 'L4', mandatory: true,
    foot: bAt(WALL_FACE - 0.8, 0, CINDERSPIRE_Y.L3), top: L4.center, face: B_YAW, heatWall: 'cs_heat_wall',
  },
  {
    kind: 'climb', id: 'C3', name: '첨탑 B 꼭대기 수정 벽', fromY: CINDERSPIRE_Y.L4, toY: CINDERSPIRE_Y.L5, from: 'L4', to: 'L5', mandatory: true,
    foot: bAt(-B_TOP_HALF - 0.8, 0, CINDERSPIRE_Y.L4), top: L5.center, face: B_YAW,
  },
  {
    kind: 'updraft', id: 'U2', name: '두 번째 열기 분출구', fromY: CINDERSPIRE_Y.L5, toY: CINDERSPIRE_Y.U2, from: 'L5', updraft: 'updraft_cinderspire_2',
    jump: { pos: onXZ(U2_JUMP_FROM, CINDERSPIRE_Y.L5), yaw: yawFromDir(B_ACROSS.x, B_ACROSS.z) },
  },
  {
    kind: 'glide', id: 'G2', name: '정상으로 활강', fromY: CINDERSPIRE_Y.U2, toY: CINDERSPIRE_Y.summit, updraft: 'updraft_cinderspire_2',
    start: onXZ(CS_U2, CINDERSPIRE_Y.U2), landing: onXZ(alongXZ(CS_SUMMIT, G2_DIR, -CINDERSPIRE_SUMMIT_RADIUS), CINDERSPIRE_Y.summit),
    horizontal: G2_RUN,
  },
];

const CS_ARENA_CENTER = onXZ(CS_SUMMIT, CINDERSPIRE_Y.summit);

/** Cinderspire (design "Cinderspire (수직 이동과 활강)"). */
export const CINDERSPIRE: ChallengeAreaDef & { readonly exitRisers: readonly string[] } = {
  id: 'cinderspire',
  region: 'ember',
  music: 'mus_area_cinderspire',
  // Charcoal rock, orange glowing crystal and embers (Req 12.4): a warm dusk haze outside, orange vent lights.
  lighting: {
    fogColor: 0xd99a6a,
    fogNear: 110,
    fogFar: 820,
    glow: 0xff8a3d,
    lights: [
      onXZ(CS_U1, CINDERSPIRE_Y.L2 - 2), onXZ(CS_U2, CINDERSPIRE_Y.L5 - 2), bAt(WALL_FACE - 1, 0, CINDERSPIRE_Y.L3 + 5),
      onXZ(CS_A, CINDERSPIRE_Y.L2 + 1.5), onXZ(CS_A, CINDERSPIRE_Y.L1 + 1.5), bAt(0, 0, CINDERSPIRE_Y.L5 + 1.5),
      { x: CS_SUMMIT.x, y: CINDERSPIRE_Y.summit + 3, z: CS_SUMMIT.z },
    ],
  },
  // The spire cluster from the base pad and spire A to spire B, and the summit, floor to above U2's top.
  bounds: { center: { x: 333, z: 122.5 }, halfAlong: 42, halfAcross: 26, yaw: 0, minY: 0, maxY: 130 },
  entrance: { pos: onXZ(aPoint((30 * Math.PI) / 180, RAMP_RADIUS), CINDERSPIRE_Y.base), yaw: rampHeading((30 * Math.PI) / 180) },
  rooms: [],
  // The walking part; the climbs and flights are `legs`.
  route: RAMP_POINTS.map((pos): RoutePoint => ({ pos, room: 'ramp' })),
  carve: [],
  pieces: CS_PIECES,
  doors: CS_DOORS,
  lifts: [],
  checkpoints: [
    { id: 'cp_cinderspire_1', spot: { pos: L2.center, yaw: yawFromDir(A_TO_U1.x, A_TO_U1.z) }, radius: CHECKPOINT_RADIUS },
    { id: 'cp_cinderspire_2', spot: { pos: L4.center, yaw: B_YAW }, radius: CHECKPOINT_RADIUS },
  ],
  combatRooms: [],
  arena: {
    elite: 'cinderAlpha',
    center: CS_ARENA_CENTER,
    radius: CINDERSPIRE_ARENA_RADIUS,
    guardian: { pos: { x: CS_SUMMIT.x, y: CINDERSPIRE_Y.summit, z: CS_SUMMIT.z - 3 }, yaw: yawFromDir(0, 1) },
  },
  hazards: [
    { id: 'hazard_cinderspire_spire_b', center: CS_B, radius: 20, minY: -5, maxY: 10, look: 'embers' },
    { id: 'hazard_cinderspire_g2', center: { x: CS_SUMMIT.x + 2, z: CS_SUMMIT.z + 21 }, radius: 9, minY: -5, maxY: 10, look: 'embers' },
    { id: 'hazard_cinderspire_summit', center: CS_SUMMIT, radius: 11, minY: -5, maxY: 9, look: 'embers' },
  ],
  skyshard: { index: 2, pos: CS_SKYSHARD },
  ledges: [L1, L2, L3, L4, L5],
  legs: CS_LEGS,
  updrafts: CS_UPDRAFTS,
  heatWalls: CS_HEAT_WALLS,
  risers: CS_RISERS,
  exitRisers: EXIT_RISERS.map((r) => r.id),
};

// ── Starfall Observatory ────────────────────────────────────────────────────
/*
 * Starfall Observatory (design "Starfall Observatory (속성 조합과 강화 전투)", task 9.8; Req 12.3, 12.7–12.9, 13.5, 13.6):
 * a mountaintop observatory of white stone on the flat y 130 plateau behind observatory_entrance, climbed floor by floor.
 * Angles below run from +x (east) toward +z (south).
 * - Entrance stair (observatory_entrance, y 130): five 0.4 m steps north through the great hall's south doorway.
 * - Great hall (floor y 132, 12 m inside its wall): four star pedestals 6 m from its centre at the compass points
 *   (N Gale, E Ember, S Tide, W Terra) and three constellations on its ceiling that glow one after another, over and over,
 *   in the colours of pz_observatory_1's order: three of the four Elements drawn from the save seed
 *   (src/data/puzzles.ts observatoryPuzzle). Applying them to their pedestals in that order within 15 s of the first
 *   right one solves it, which runs the ring lift.
 * - Ring lift: from the hall's west side up to a walled landing at y 140 with cp_observatory_1, beside the ring corridor.
 * - Ring corridor (y 140): the hall's roof, a ring inside its parapet around the low glass oculus over the hall's
 *   ceiling (a step up, so the fights run across it). Stepping in closes both of its ends (a starlight barrier in the
 *   landing's gap, one at the foot of the dome stairs) and calls wave 1
 *   (windcutter ×2, aetherSentinel ×1); 2 s after its 'camp:cleared' wave 2 (aetherSentinel ×2) comes, and the clear of
 *   that last wave (`observatory_waves`) opens both barriers and lights cp_observatory_2 in front of the dome stairs.
 * - Dome stairs: 25 steps of 0.4 m east over the walled courtyard between the hall and the dome, to the dome (y 150).
 *   The courtyard below them is the fall judgement (a pool of fallen starlight) until Skyshard 3.
 * - Dome (y 150, a 10 m drum with a parapet): Sentinel Prime guards it (arena 9 m); its defeat opens the star cage
 *   beside the telescope that holds Skyshard 3, and Skyshard 3 opens the balcony gate on the south side: the balcony's
 *   tip is the glide start down toward the crater (Req 12.9).
 * Everything stands on the plateau's flat top (terrain y 130), so nothing is carved; the pieces are temporary prefab
 * shapes (the art tasks replace the look, not the shapes). Its music is mus_area_observatory; its lighting a cold
 * blue-violet haze with starlight glows (white stone, cold blue light, violet starlight, Req 12.4).
 */

const OBS = LOCATIONS.observatory_entrance; // (140, −360), y 130

/** Heights: the entrance terrace, the great hall floor, the ring corridor and the dome (design: y 130 → y 150). */
export const OBSERVATORY_Y = { entrance: OBS.groundY, hall: 132, ring: 140, dome: 150 } as const;

/** Great hall centre, 18 m north of the entrance. */
export const OBSERVATORY_HALL_CENTER: XZ = { x: OBS.x, z: OBS.z - 18 };
/** Hall floor radius inside its wall. */
export const OBSERVATORY_HALL_RADIUS = 12;
/** The star pedestals stand this far from the hall centre (design: 6 m). */
export const OBSERVATORY_PEDESTAL_DISTANCE = 6;
/** Dome drum radius, and the Sentinel Prime arena inside its parapet. */
export const OBSERVATORY_DOME_RADIUS = 10;
export const OBSERVATORY_ARENA_RADIUS = 9;
/** The ring corridor's waves: wave 1, then the last wave, whose clear is the quest's `defeat observatory_waves`. */
export const OBSERVATORY_WAVE_GROUPS = ['observatory_wave_1', 'observatory_waves'] as const;
export const OBSERVATORY_WAVES_GROUP = 'observatory_waves';
/** Seconds between wave 1's 'camp:cleared' and wave 2 (design). */
export const OBSERVATORY_WAVE_DELAY = 2;
/** The sequence puzzle of the great hall (its seeded definition is src/data/puzzles.ts observatoryPuzzle). */
export const OBSERVATORY_PUZZLE_ID = 'pz_observatory_1';

const HALL = OBSERVATORY_HALL_CENTER;
const HALL_WALL = 0.6;
/** Podium (hall floor) radius: the wall's outer face. */
const HALL_OUTER = OBSERVATORY_HALL_RADIUS + HALL_WALL;
const HALL_CEILING_Y = 139.4;
/** The roof slab over the wall tops: the ring corridor floor (top y 140). */
const ROOF_R = 12.9;
const PARAPET_R = 12.6;
const PARAPET_T = 0.5;
/** Parapets stand 2 m: above the 1.4 m jump apex. */
const PARAPET_H = 2;
/** The skylight over the hall in the middle of the ring: a low glass disc the fights run across (a step up). */
const OCULUS_R = 3.5;
const OCULUS_H = 0.2;
/** Wall and parapet rings are made of this many straight segments (segment k centred at angle k · 22.5°). */
const RING_SEGMENTS = 16;
/** Segment indices by direction. */
const EAST = 0;
const SOUTH = 4;
const WEST = 8;
const ENTRY_STEPS = 5;
const ENTRY_STEP_RUN = 0.8;
const ENTRY_HALF = 2;
/** Dome stairs: 25 × 0.4 m, 0.9 m deep each, from the roof's east edge to the dome drum. */
const DOME_STEPS = 25;
const DOME_STEP_RUN = 0.9;
const DOME_STAIR_HALF = 1.4;
const DOME_STAIR_X0 = HALL.x + ROOF_R;
/** Dome centre: east of the hall, past the stairs. */
export const OBSERVATORY_DOME_CENTER: XZ = { x: DOME_STAIR_X0 + DOME_STEPS * DOME_STEP_RUN + OBSERVATORY_DOME_RADIUS, z: HALL.z };
const DOME = OBSERVATORY_DOME_CENTER;
const DOME_PARAPET_R = 9.75;
/** The courtyard walls stand this far either side of the dome stairs' axis. */
const COURT_HALF = 6.25;
/** Bottom of the columns and blocks standing on the plateau (below its y 130 top). */
const OBS_BASE_Y = 126;

/** World (x, z) at angle `theta` (rad, from +x toward +z) and radius `r` around `c`. */
const polar = (c: XZ, theta: number, r: number): XZ => ({ x: c.x + r * Math.cos(theta), z: c.z + r * Math.sin(theta) });
const obsAt = (p: XZ, y: number): Vec3 => ({ x: p.x, y, z: p.z });
/** An upright box centred on (cx, cz) from y0 to y1, `hx` × `hz` half extents, turned `yaw`. */
function obsBox(cx: number, cz: number, y0: number, y1: number, hx: number, hz: number, yaw = 0): Extract<AreaShape, { kind: 'obb' }> {
  return { kind: 'obb', center: { x: cx, y: (y0 + y1) / 2, z: cz }, half: { x: hx, y: (y1 - y0) / 2, z: hz }, yaw };
}

/** A ring of straight wall segments around `c` at radius `r` (their centre line), leaving out the `gaps`. */
function ringWall(prefix: string, c: XZ, r: number, thickness: number, y0: number, y1: number, look: AreaLook, gaps: readonly number[]): AreaPieceDef[] {
  const halfLength = (Math.PI * r) / RING_SEGMENTS + 0.06; // a little longer than the arc, so neighbours overlap
  const out: AreaPieceDef[] = [];
  for (let k = 0; k < RING_SEGMENTS; k++) {
    if (gaps.includes(k)) continue;
    const theta = (2 * Math.PI * k) / RING_SEGMENTS;
    const p = polar(c, theta, r);
    // Local +Z along the tangent, local X across the wall.
    out.push({ id: `${prefix}_${k}`, look, walkableTop: false, shape: obsBox(p.x, p.z, y0, y1, thickness / 2, halfLength, yawFromDir(-Math.sin(theta), Math.cos(theta))) });
  }
  return out;
}

/** The pedestals of pz_observatory_1 by compass point: the Element each is marked with (Req 13.2) and where it stands. */
export type ObservatoryPedestalId = 'north' | 'east' | 'south' | 'west';
export interface ObservatoryPedestalDef {
  readonly id: ObservatoryPedestalId;
  readonly element: ElementId;
  readonly pos: Vec3;
}
const D6 = OBSERVATORY_PEDESTAL_DISTANCE;
export const OBSERVATORY_PEDESTALS: readonly ObservatoryPedestalDef[] = [
  { id: 'north', element: 'gale', pos: { x: HALL.x, y: OBSERVATORY_Y.hall, z: HALL.z - D6 } },
  { id: 'east', element: 'ember', pos: { x: HALL.x + D6, y: OBSERVATORY_Y.hall, z: HALL.z } },
  { id: 'south', element: 'tide', pos: { x: HALL.x, y: OBSERVATORY_Y.hall, z: HALL.z + D6 } },
  { id: 'west', element: 'terra', pos: { x: HALL.x - D6, y: OBSERVATORY_Y.hall, z: HALL.z } },
];

/** Ring lift pads and arrivals: up from the hall's west side, down from the landing (its rune is cp_observatory_1). */
const LIFT_UP_PAD: Vec3 = { x: HALL.x - 9.5, y: OBSERVATORY_Y.hall, z: HALL.z };
const LANDING: XZ = { x: HALL.x - 14.85, z: HALL.z };
const LANDING_HALF = { x: 2.75, z: 2.6 };
const LANDING_ARRIVAL: Vec3 = { x: LANDING.x + 0.25, y: OBSERVATORY_Y.ring, z: HALL.z };
const LIFT_DOWN_PAD: Vec3 = { x: LANDING.x - 1.75, y: OBSERVATORY_Y.ring, z: HALL.z };
const HALL_ARRIVAL: Vec3 = { x: HALL.x - 8.5, y: OBSERVATORY_Y.hall, z: HALL.z + 3 };
const FACE_EAST = yawFromDir(1, 0);
const FACE_WEST = yawFromDir(-1, 0);
const FACE_NORTH = yawFromDir(0, -1);
const FACE_SOUTH = yawFromDir(0, 1);

/** Skyshard 3 in its star cage beside the telescope on the dome's east side. */
const OBS_SKYSHARD: Vec3 = { x: DOME.x + 4.5, y: OBSERVATORY_Y.dome, z: DOME.z };
/** The balcony: from under the dome's south parapet out to 15 m from its centre; its tip is the glide start. */
const BALCONY_FROM = 9.3;
const BALCONY_TO = 15;
const BALCONY_HALF = 2;
const GLIDE_START: Vec3 = { x: DOME.x, y: OBSERVATORY_Y.dome, z: DOME.z + BALCONY_TO - 0.6 };

const ENTRY_STEP_PIECES: readonly AreaPieceDef[] = Array.from({ length: ENTRY_STEPS }, (_, i) => {
  const k = i + 1; // step 5 meets the hall floor
  const top = OBSERVATORY_Y.entrance + ((OBSERVATORY_Y.hall - OBSERVATORY_Y.entrance) * k) / ENTRY_STEPS;
  const edge = HALL.z + HALL_OUTER; // the podium's south edge on the axis
  const north = edge + ENTRY_STEP_RUN * (ENTRY_STEPS - k) - (k === ENTRY_STEPS ? 0.6 : 0.05);
  const south = edge + ENTRY_STEP_RUN * (ENTRY_STEPS - k + 1);
  return { id: `obs_entry_step_${k}`, look: 'obsStep', walkableTop: true, shape: obsBox(HALL.x, (north + south) / 2, OBS_BASE_Y, top, ENTRY_HALF, (south - north) / 2) };
});

const DOME_STEP_PIECES: readonly AreaPieceDef[] = Array.from({ length: DOME_STEPS }, (_, i) => {
  const k = i + 1;
  const top = OBSERVATORY_Y.ring + ((OBSERVATORY_Y.dome - OBSERVATORY_Y.ring) * k) / DOME_STEPS;
  const west = DOME_STAIR_X0 + DOME_STEP_RUN * (k - 1) - 0.05;
  const east = DOME_STAIR_X0 + DOME_STEP_RUN * k + (k === DOME_STEPS ? 0.6 : 0.05); // the last one reaches into the drum
  return { id: `obs_dome_step_${k}`, look: 'obsStep', walkableTop: true, shape: obsBox((west + east) / 2, HALL.z, OBS_BASE_Y, top, (east - west) / 2, DOME_STAIR_HALF) };
});

/** The courtyard below the dome stairs: from the hall's podium to the drum, between its two walls. */
const COURT_WEST = HALL.x + Math.sqrt(HALL_OUTER ** 2 - COURT_HALF ** 2) - 0.35;
const COURT_EAST = DOME.x - Math.sqrt(OBSERVATORY_DOME_RADIUS ** 2 - COURT_HALF ** 2) + 0.4;
const COURT_CENTER_X = (COURT_WEST + COURT_EAST) / 2;
const COURT_HALF_X = (COURT_EAST - COURT_WEST) / 2;

const OBS_PIECES: readonly AreaPieceDef[] = [
  ...ENTRY_STEP_PIECES,
  // Great hall: the podium floor, its wall (doorway to the south) and the roof, the ring corridor's floor.
  { id: 'obs_hall_floor', look: 'obsFloor', walkableTop: true,
    shape: { kind: 'cylinder', base: obsAt(HALL, OBS_BASE_Y), radius: HALL_OUTER, height: OBSERVATORY_Y.hall - OBS_BASE_Y } },
  ...ringWall('obs_hall_wall', HALL, OBSERVATORY_HALL_RADIUS + HALL_WALL / 2, HALL_WALL, OBSERVATORY_Y.hall, HALL_CEILING_Y, 'obsStone', [SOUTH]),
  { id: 'obs_roof', look: 'obsFloor', walkableTop: true,
    shape: { kind: 'cylinder', base: obsAt(HALL, HALL_CEILING_Y), radius: ROOF_R, height: OBSERVATORY_Y.ring - HALL_CEILING_Y } },
  // Ring corridor: the parapet (gaps at the landing and the dome stairs) around the oculus.
  ...ringWall('obs_parapet', HALL, PARAPET_R, PARAPET_T, OBSERVATORY_Y.ring, OBSERVATORY_Y.ring + PARAPET_H, 'obsParapet', [EAST, WEST]),
  { id: 'obs_oculus', look: 'obsOculus', walkableTop: true,
    shape: { kind: 'cylinder', base: obsAt(HALL, OBSERVATORY_Y.ring), radius: OCULUS_R, height: OCULUS_H } },
  // The lift landing west of the ring, walled on its three open sides.
  { id: 'obs_landing', look: 'obsFloor', walkableTop: true,
    shape: obsBox(LANDING.x, LANDING.z, OBS_BASE_Y, OBSERVATORY_Y.ring, LANDING_HALF.x, LANDING_HALF.z) },
  { id: 'obs_landing_wall_w', look: 'obsParapet', walkableTop: false,
    shape: obsBox(LANDING.x - LANDING_HALF.x - 0.25, LANDING.z, OBSERVATORY_Y.ring, OBSERVATORY_Y.ring + PARAPET_H, 0.25, LANDING_HALF.z + 0.25) },
  { id: 'obs_landing_wall_n', look: 'obsParapet', walkableTop: false,
    shape: obsBox(LANDING.x + 0.25, LANDING.z - LANDING_HALF.z - 0.25, OBSERVATORY_Y.ring, OBSERVATORY_Y.ring + PARAPET_H, LANDING_HALF.x + 0.25, 0.25) },
  { id: 'obs_landing_wall_s', look: 'obsParapet', walkableTop: false,
    shape: obsBox(LANDING.x + 0.25, LANDING.z + LANDING_HALF.z + 0.25, OBSERVATORY_Y.ring, OBSERVATORY_Y.ring + PARAPET_H, LANDING_HALF.x + 0.25, 0.25) },
  // Dome stairs over the courtyard, whose two walls close it between the hall and the drum.
  ...DOME_STEP_PIECES,
  { id: 'obs_court_wall_n', look: 'obsStone', walkableTop: false,
    shape: obsBox(COURT_CENTER_X, HALL.z - COURT_HALF, OBS_BASE_Y, OBSERVATORY_Y.entrance + 4, COURT_HALF_X, 0.25) },
  { id: 'obs_court_wall_s', look: 'obsStone', walkableTop: false,
    shape: obsBox(COURT_CENTER_X, HALL.z + COURT_HALF, OBS_BASE_Y, OBSERVATORY_Y.entrance + 4, COURT_HALF_X, 0.25) },
  // Dome: the drum (its top is the dome floor, not climbable), its parapet (gaps at the stairs and the balcony), the
  // balcony and the telescope.
  { id: 'obs_dome_drum', look: 'obsDrum', walkableTop: true,
    shape: { kind: 'cylinder', base: obsAt(DOME, OBS_BASE_Y - 2), radius: OBSERVATORY_DOME_RADIUS, height: OBSERVATORY_Y.dome - OBS_BASE_Y + 2 } },
  ...ringWall('obs_dome_parapet', DOME, DOME_PARAPET_R, PARAPET_T, OBSERVATORY_Y.dome, OBSERVATORY_Y.dome + PARAPET_H, 'obsParapet', [SOUTH, WEST]),
  { id: 'obs_balcony', look: 'obsFloor', walkableTop: true,
    shape: obsBox(DOME.x, DOME.z + (BALCONY_FROM + BALCONY_TO) / 2, OBSERVATORY_Y.dome - 0.6, OBSERVATORY_Y.dome, BALCONY_HALF, (BALCONY_TO - BALCONY_FROM) / 2) },
  { id: 'obs_telescope', look: 'telescope', walkableTop: false,
    shape: { kind: 'cylinder', base: { x: DOME.x + 7.4, y: OBSERVATORY_Y.dome, z: DOME.z }, radius: 1.1, height: 2.4 } },
];

const OBS_DOORS: readonly AreaDoorDef[] = [
  // The ring corridor's two ends: the landing's gap closes behind the party while the waves fight; the dome stairs stay
  // closed until the last wave is cleared.
  { id: 'obs_barrier_lift', name: '링 회랑 별빛 장벽 (승강기 쪽)', look: 'starBarrier', openWhen: { kind: 'roomUnlocked', groupId: OBSERVATORY_WAVES_GROUP },
    shape: obsBox(HALL.x - PARAPET_R, HALL.z, OBSERVATORY_Y.ring, OBSERVATORY_Y.ring + 3, 0.3, 2.55) },
  { id: 'obs_barrier_stair', name: '링 회랑 별빛 장벽 (돔 계단 쪽)', look: 'starBarrier', openWhen: { kind: 'roomCleared', groupId: OBSERVATORY_WAVES_GROUP },
    shape: obsBox(HALL.x + PARAPET_R, HALL.z, OBSERVATORY_Y.ring, OBSERVATORY_Y.ring + 3, 0.3, 2.55) },
  // Skyshard 3's star cage opens with Sentinel Prime's defeat; the balcony gate with Skyshard 3 (Req 12.9).
  { id: 'obs_cage_skyshard', name: 'Skyshard 별빛 우리', look: 'starCage', openWhen: { kind: 'eliteDefeated', elite: 'sentinelPrime' },
    shape: obsBox(OBS_SKYSHARD.x, OBS_SKYSHARD.z, OBSERVATORY_Y.dome, OBSERVATORY_Y.dome + 3.2, 1.4, 1.4) },
  { id: 'obs_gate_balcony', name: '돔 발코니 문', look: 'balconyGate', openWhen: { kind: 'skyshard', index: 3 },
    shape: obsBox(DOME.x, DOME.z + DOME_PARAPET_R, OBSERVATORY_Y.dome, OBSERVATORY_Y.dome + PARAPET_H + 0.4, BALCONY_HALF, 0.3) },
];

const OBS_CHECKPOINTS: readonly CheckpointDef[] = [
  // On the ring lift's landing, where the lift puts the party.
  { id: 'cp_observatory_1', spot: { pos: LANDING_ARRIVAL, yaw: FACE_EAST }, radius: CHECKPOINT_RADIUS,
    litWhen: { kind: 'puzzleSolved', puzzleId: OBSERVATORY_PUZZLE_ID } },
  // In front of the dome stairs, lit once the waves are cleared.
  { id: 'cp_observatory_2', spot: { pos: { x: HALL.x + 9.4, y: OBSERVATORY_Y.ring, z: HALL.z }, yaw: FACE_EAST }, radius: CHECKPOINT_RADIUS,
    litWhen: { kind: 'roomCleared', groupId: OBSERVATORY_WAVES_GROUP } },
];

/** Constellation star patterns on the hall ceiling (offsets in m). */
const CONSTELLATION_STARS: readonly (readonly XZ[])[] = [
  [{ x: -1.2, z: 0.4 }, { x: -0.4, z: -0.6 }, { x: 0.5, z: -0.2 }, { x: 1.3, z: 0.5 }, { x: 0.2, z: 0.9 }],
  [{ x: -1, z: -1 }, { x: -0.2, z: -0.3 }, { x: 0.6, z: 0.2 }, { x: 1.2, z: 1.1 }, { x: -0.6, z: 0.8 }, { x: 0.9, z: -0.9 }],
  [{ x: 0, z: -1.2 }, { x: 0.8, z: -0.2 }, { x: 0.2, z: 0.7 }, { x: -0.9, z: 0.3 }, { x: -1.1, z: -0.8 }],
];
/** Where the three constellations sit on the ceiling: 5 m from the hall centre, north first, then clockwise from above. */
const CONSTELLATION_ANGLES = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6];

/**
 * A ceiling constellation glows `stepSeconds` in its turn; after the last one the ceiling rests `pauseSeconds` before the
 * order starts over (src/logic/puzzle.ts constellationStepAt).
 */
export const CONSTELLATION_TIMING = { stepSeconds: 1.2, pauseSeconds: 1.6 } as const;

/** Where the puzzle's opening, the fights and the Skyshard are (src/data/puzzles.ts, spawns.ts, quests.ts). */
export const OBSERVATORY_DEVICES = {
  /** The ring lift's pad in the hall: what pz_observatory_1 opens. */
  liftPad: LIFT_UP_PAD,
} as const;

/** Spawn points of the ring corridor's waves (on its floor, y 140), all facing the lift landing to the west. */
export const OBSERVATORY_SPAWNS = {
  wave1: {
    windcutter: [obsAt(polar(HALL, Math.PI / 2, 8.5), OBSERVATORY_Y.ring), obsAt(polar(HALL, -Math.PI / 2, 8.5), OBSERVATORY_Y.ring)],
    aetherSentinel: [obsAt(polar(HALL, 0, 8.5), OBSERVATORY_Y.ring)],
  },
  wave2: {
    aetherSentinel: [obsAt(polar(HALL, Math.PI / 3, 8.5), OBSERVATORY_Y.ring), obsAt(polar(HALL, -Math.PI / 3, 8.5), OBSERVATORY_Y.ring)],
  },
  yaw: FACE_WEST,
} as const;

/** Main_Quest marker spots (src/data/quests.ts): the hall floor, the ring corridor by the landing, the dome. */
export const OBSERVATORY_SPOTS = {
  hall: obsAt(HALL, OBSERVATORY_Y.hall),
  ring: obsAt(polar(HALL, Math.PI, 9), OBSERVATORY_Y.ring),
  dome: obsAt(DOME, OBSERVATORY_Y.dome),
} as const;

const HALL_FLOOR = obsAt(HALL, OBSERVATORY_Y.hall);
const RING_FLOOR = obsAt(HALL, OBSERVATORY_Y.ring);
const DOME_FLOOR = obsAt(DOME, OBSERVATORY_Y.dome);
const ringAt = (theta: number, r: number): Vec3 => obsAt(polar(HALL, theta, r), OBSERVATORY_Y.ring);

/** Starfall Observatory (design "Starfall Observatory (속성 조합과 강화 전투)"). */
export const OBSERVATORY: ChallengeAreaDef & { readonly exitGlide: ExitGlideDef; readonly constellations: readonly ConstellationDef[] } = {
  id: 'observatory',
  region: 'azure',
  music: 'mus_area_observatory',
  // White stone, cold blue light and violet starlight (Req 12.4): a pale blue-violet haze, violet star glows.
  lighting: {
    fogColor: 0x9aa6d8,
    fogNear: 50,
    fogFar: 520,
    glow: 0xc3b4ff,
    lights: [
      obsAt(HALL, HALL_CEILING_Y - 2),
      ...OBSERVATORY_PEDESTALS.map((p) => ({ ...p.pos, y: p.pos.y + 1.5 })),
      obsAt(polar(HALL, Math.PI / 2, 8), OBSERVATORY_Y.ring + 2.5),
      obsAt(polar(HALL, -Math.PI / 2, 8), OBSERVATORY_Y.ring + 2.5),
      obsAt(DOME, OBSERVATORY_Y.dome + 3),
    ],
  },
  // From the entrance terrace and the lift landing to the dome and its balcony, the plateau's top to above the dome.
  bounds: {
    center: { x: (LANDING.x - LANDING_HALF.x - 1 + DOME.x + OBSERVATORY_DOME_RADIUS + 1) / 2, z: HALL.z + 1 },
    halfAlong: (DOME.x + OBSERVATORY_DOME_RADIUS + 1 - (LANDING.x - LANDING_HALF.x - 1)) / 2,
    halfAcross: 20,
    yaw: FACE_EAST,
    minY: 125,
    maxY: 165,
  },
  entrance: { pos: { x: OBS.x, y: OBS.groundY, z: OBS.z - 0.5 }, yaw: FACE_NORTH },
  rooms: [
    { id: 'entrance', name: '입구 계단', center: { x: OBS.x, y: OBS.groundY, z: OBS.z - 0.5 }, radius: ENTRY_HALF },
    { id: 'hall', name: '대전당', center: HALL_FLOOR, radius: OBSERVATORY_HALL_RADIUS },
    { id: 'ring', name: '링 회랑', center: RING_FLOOR, radius: PARAPET_R - PARAPET_T / 2 },
    { id: 'dome', name: '돔', center: DOME_FLOOR, radius: DOME_PARAPET_R - PARAPET_T / 2 },
  ],
  route: [
    { pos: { x: OBS.x, y: OBS.groundY, z: OBS.z - 0.5 }, room: 'entrance' },
    { pos: { x: HALL.x, y: OBSERVATORY_Y.hall, z: HALL.z + 11 }, room: 'hall' }, // through the doorway
    { pos: { x: HALL.x - 3, y: OBSERVATORY_Y.hall, z: HALL.z + 7.5 }, room: 'hall' }, // west of the south pedestal
    { pos: HALL_FLOOR, room: 'hall' }, // the hall centre (reach observatory_hall)
    { pos: { x: HALL.x - 3.5, y: OBSERVATORY_Y.hall, z: HALL.z + 3 }, room: 'hall' },
    { pos: LIFT_UP_PAD, room: 'hall' }, // the ring lift
    { pos: LANDING_ARRIVAL, room: 'ring', lift: 'lift_observatory_up' }, // cp_observatory_1
    { pos: ringAt(Math.PI, 10.5), room: 'ring' }, // into the corridor: the barriers close, wave 1 comes
    { pos: ringAt((3 * Math.PI) / 4, 9), room: 'ring' },
    { pos: ringAt(Math.PI / 2, 9), room: 'ring' },
    { pos: ringAt(Math.PI / 4, 9), room: 'ring' },
    { pos: ringAt(0, 9.4), room: 'ring' }, // cp_observatory_2 in front of the dome stairs
    { pos: { x: DOME_STAIR_X0 + 0.6, y: OBSERVATORY_Y.ring + 0.4, z: HALL.z }, room: 'stair' },
    { pos: { x: DOME.x - OBSERVATORY_DOME_RADIUS - 0.6, y: OBSERVATORY_Y.dome, z: HALL.z }, room: 'stair' },
    { pos: { x: DOME.x - 6, y: OBSERVATORY_Y.dome, z: DOME.z }, room: 'dome' },
    { pos: { x: OBS_SKYSHARD.x - 2.3, y: OBSERVATORY_Y.dome, z: DOME.z }, room: 'dome' }, // at the star cage
    { pos: { x: DOME.x, y: OBSERVATORY_Y.dome, z: DOME.z + 6 }, room: 'dome' },
    { pos: GLIDE_START, room: 'balcony' }, // the glide start once Skyshard 3 is held
  ],
  carve: [],
  pieces: OBS_PIECES,
  doors: OBS_DOORS,
  lifts: [
    { id: 'lift_observatory_up', name: '링 회랑 승강기', pad: LIFT_UP_PAD, to: { pos: LANDING_ARRIVAL, yaw: FACE_EAST },
      when: { kind: 'puzzleSolved', puzzleId: OBSERVATORY_PUZZLE_ID }, prompt: '승강기 타기' },
    // The way back down is shut while the waves fight (the landing's barrier holds the party in).
    { id: 'lift_observatory_down', name: '대전당으로 내려가는 승강기', pad: LIFT_DOWN_PAD, to: { pos: HALL_ARRIVAL, yaw: FACE_EAST },
      when: { kind: 'roomUnlocked', groupId: OBSERVATORY_WAVES_GROUP }, prompt: '승강기 타기' },
  ],
  checkpoints: OBS_CHECKPOINTS,
  combatRooms: [{
    groupId: OBSERVATORY_WAVES_GROUP, center: RING_FLOOR, radius: 11, waves: OBSERVATORY_WAVE_GROUPS, waveDelay: OBSERVATORY_WAVE_DELAY,
  }],
  arena: {
    elite: 'sentinelPrime',
    center: DOME_FLOOR,
    radius: OBSERVATORY_ARENA_RADIUS,
    guardian: { pos: { x: DOME.x - 2, y: OBSERVATORY_Y.dome, z: DOME.z }, yaw: FACE_WEST },
  },
  hazards: [
    { id: 'hazard_observatory_court', center: { x: COURT_CENTER_X, z: HALL.z }, radius: COURT_HALF - 0.25,
      box: { halfX: COURT_HALF_X, halfZ: COURT_HALF - 0.25 }, minY: OBSERVATORY_Y.entrance - 3, maxY: OBSERVATORY_Y.entrance + 1.4, look: 'starfall' },
  ],
  skyshard: { index: 3, pos: OBS_SKYSHARD },
  ledges: [],
  legs: [],
  updrafts: [],
  heatWalls: [],
  risers: [],
  exitGlide: { door: 'obs_gate_balcony', start: { pos: GLIDE_START, yaw: FACE_SOUTH }, toward: { x: LOCATIONS.resonance_altar.x, z: LOCATIONS.resonance_altar.z } },
  constellations: CONSTELLATION_STARS.map((stars, step): ConstellationDef => ({
    id: `obs_constellation_${step + 1}`,
    puzzle: OBSERVATORY_PUZZLE_ID,
    step,
    center: obsAt(polar(HALL, CONSTELLATION_ANGLES[step] ?? 0, 5), HALL_CEILING_Y - 0.15),
    stars,
  })),
};

/** Every Challenge_Area with its finished layout. */
export const CHALLENGE_AREA_DEFS: readonly ChallengeAreaDef[] = [HOLLOWROOT, CINDERSPIRE, OBSERVATORY];

/** A checkpoint by id, with its area. */
export function checkpointById(id: string): { area: ChallengeAreaDef; checkpoint: CheckpointDef } | null {
  for (const area of CHALLENGE_AREA_DEFS) {
    const checkpoint = area.checkpoints.find((c) => c.id === id);
    if (checkpoint !== undefined) return { area, checkpoint };
  }
  return null;
}
