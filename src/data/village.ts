/*
 * Thistlewick and the named NPCs (design.md "Thistlewick", "NPC 행동", task 13.2; Req 14.1, 14.2, 14.9, 5.1).
 *
 * The village centre is (−250, 300) on ground y 18 (LOCATIONS.thistlewick); the design gives the places as offsets
 * (Δx, Δz) from it, +x east and −z north: the 12 m stone plaza with the Hearth (+4, −4), Elder Maren's two-storey house
 * (0, −24), Pip's stall (+14, 0), Old Bram's Echo Altar (−18, 0), the well (−9, +11), Hobb's field (+50, +20, about
 * 30 × 20 m), the 10 m watchtower (+30, +32) and `ws_thistlewick` (+18, +18) on the way to it (the Waystone itself is
 * src/data/waystones.ts). The sight axis from the plaza toward the Astral Sanctum (bearing 30°–50°) holds no building
 * (Req 5.1); the other houses stand west, south and north-west, off the roads to Breezewatch, the east field and the
 * watchtower.
 *
 * NPCs: every named NPC (and each companion until it joins) has a home spot and facing, an idle and at least one
 * ambient behaviour alternating every 8–15 s (Req 14.9): Maren walks between the plaza and her door, Pip tidies his
 * stall, Bram sweeps the altar, Tamsin runs round the well and points at Breezewatch, Hobb hoes a furrow, Durga
 * hammers at the anvil by the cold forge in camp_durga (235, 235), Oriel looks through the telescope in camp_oriel
 * (40, −220). From Skyshard 3 on (and after the ending) the five villagers gather on the plaza rim facing the Sanctum.
 *
 * Pure data and queries: no three.js, DOM or Math.random (src/data layering rule).
 */
import { yawFromDir } from '../core/math';
import type { CharacterId } from './ids';
import type { Speaker } from './dialogue';
import { TUTORIAL_ANCHORS } from './tutorials';
import { LOCATIONS, NEW_GAME_START, type XZ } from './worldLayout';

// ── Places ──────────────────────────────────────────────────────────────────

/** The village centre (plaza centre) and its ground height. */
export const VILLAGE_CENTER = { x: LOCATIONS.thistlewick.x, z: LOCATIONS.thistlewick.z } as const satisfies XZ;
export const VILLAGE_GROUND_Y = LOCATIONS.thistlewick.groundY;

/** A point `dx` east and `dz` south of the village centre. */
export const villageAt = (dx: number, dz: number): XZ => ({ x: VILLAGE_CENTER.x + dx, z: VILLAGE_CENTER.z + dz });

/** Radius of the stone-paved plaza (m). */
export const PLAZA_RADIUS = 12;

/** Where the Astral Sanctum floats: over the crater centre (the origin, REGIONS.sanctum), bearing ≈ 40° from the plaza. */
export const SANCTUM_SIGHT_TARGET: XZ = { x: 0, z: 0 };

/**
 * The plaza's sight axis toward the Astral Sanctum (design "시야", Req 5.1): compass bearings (deg, north 0°, east 90°)
 * that no building or large tree may block from the plaza.
 */
export const SANCTUM_SIGHT_AXIS = { from: VILLAGE_CENTER, minBearingDeg: 30, maxBearingDeg: 50 } as const;

/** Compass bearing (deg in [0, 360)) from `from` to `to`: north 0°, east 90° (bearing = atan2(dx, −dz)). */
export function bearingDeg(from: XZ, to: XZ): number {
  const deg = (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Whether a round obstacle at `at` with horizontal `radius` would block the plaza's view along the Sanctum sight axis:
 * some bearing of its silhouette lies within 30°–50°. For the vegetation and prop placers too.
 */
export function blocksSanctumSight(at: XZ, radius: number): boolean {
  const { from, minBearingDeg, maxBearingDeg } = SANCTUM_SIGHT_AXIS;
  const d = Math.hypot(at.x - from.x, at.z - from.z);
  if (d <= radius) return true;
  const half = (Math.asin(Math.min(1, radius / d)) * 180) / Math.PI;
  const b = bearingDeg(from, at);
  return b + half >= minBearingDeg && b - half <= maxBearingDeg;
}

export type VillageBuildingKind = 'marenHouse' | 'house' | 'stall' | 'echoAltar' | 'well' | 'watchtower' | 'step';

/**
 * Task 21.4 (onboarding): the plaza step, a 0.7 m stone ledge across the road between the village entrance and the
 * plaza at TUTORIAL_ANCHORS.plaza_step. It is higher than the automatic step-up (0.45 m) and lower than a jump's apex
 * (1.4 m), so the first steps of a New Game meet `tut_jump` where a jump is actually needed; its ends leave room to
 * walk round (6 m wide).
 */
export const PLAZA_STEP = { halfWidth: 3, halfDepth: 0.6, height: 0.7 } as const;

/** A building or fixture: its footprint (centre, half extents along its own axes), height and facing. */
export interface VillageBuildingDef {
  readonly id: string;
  readonly kind: VillageBuildingKind;
  readonly center: XZ;
  /** Half extents along the building's x (width) and z (depth) before `yaw`. */
  readonly half: { readonly x: number; readonly z: number };
  /** Height of the solid body above the ground (m). */
  readonly height: number;
  /** Facing of the front (door, counter) as a core/math yaw. */
  readonly yaw: number;
}

const SOUTH = yawFromDir(0, 1);
const EAST = yawFromDir(1, 0);
const WEST = yawFromDir(-1, 0);
const NORTH = yawFromDir(0, -1);

/** Buildings and fixtures with solid bodies (the field and the Hearth have none). */
export const VILLAGE_BUILDINGS: readonly VillageBuildingDef[] = [
  // North: Elder Maren's two-storey timber house, its door facing the plaza.
  { id: 'house_maren', kind: 'marenHouse', center: villageAt(0, -24), half: { x: 4.5, z: 3.5 }, height: 7.5, yaw: SOUTH },
  // The other houses: north-west, west, south-west and south, off the roads.
  { id: 'house_nw', kind: 'house', center: villageAt(-18, -17), half: { x: 3.5, z: 3 }, height: 4.6, yaw: yawFromDir(1, 1) },
  { id: 'house_w', kind: 'house', center: villageAt(-32, 2), half: { x: 3, z: 3.5 }, height: 4.4, yaw: EAST },
  { id: 'house_sw', kind: 'house', center: villageAt(-20, 22), half: { x: 3.5, z: 3 }, height: 4.6, yaw: yawFromDir(1, -1) },
  { id: 'house_s', kind: 'house', center: villageAt(2, 27), half: { x: 3.5, z: 3 }, height: 4.4, yaw: NORTH },
  // Pip's stall on the plaza's east edge: the counter faces the plaza.
  { id: 'stall_pip', kind: 'stall', center: villageAt(14, 0), half: { x: 0.5, z: 1.6 }, height: 1.0, yaw: WEST },
  // Old Bram's Echo Altar, the stone altar on the west.
  { id: 'altar_bram', kind: 'echoAltar', center: villageAt(-18, 0), half: { x: 0.7, z: 1.0 }, height: 1.0, yaw: EAST },
  // The well south-west of the plaza (a round stone rim).
  { id: 'well', kind: 'well', center: villageAt(-9, 11), half: { x: 1.1, z: 1.1 }, height: 0.9, yaw: 0 },
  // The 10 m timber watchtower south-east: four posts and a platform (Isla stands at its west foot).
  { id: 'watchtower', kind: 'watchtower', center: villageAt(30, 32), half: { x: 1.5, z: 1.5 }, height: 10, yaw: WEST },
  // Task 21.4: the plaza step across the entrance road, facing into the village (its width runs across the road).
  {
    id: 'plaza_step', kind: 'step', center: { x: TUTORIAL_ANCHORS.plaza_step.x, z: TUTORIAL_ANCHORS.plaza_step.z },
    half: { x: PLAZA_STEP.halfWidth, z: PLAZA_STEP.halfDepth }, height: PLAZA_STEP.height, yaw: NEW_GAME_START.yaw,
  },
];

/** Watchtower post radius (m); the posts stand at the footprint's corners. */
export const WATCHTOWER_POST_RADIUS = 0.18;

/** The Hearth in the plaza (+4, −4): heals the party (Req 14.10). It has no solid body (the respawn spot is on it). */
export const HEARTH_POS: XZ = villageAt(4, -4);
export const HEARTH_TARGET_ID = 'hearth_thistlewick';
/** Interaction size of the Hearth (m). */
export const HEARTH_RADIUS = 0.8;
export const HEARTH_HEIGHT = 1.2;

/** Hobb's field east of the village: centre (+50, +20), 30 × 20 m of furrows running east–west. */
export const HOBB_FIELD = { center: villageAt(50, 20), halfX: 15, halfZ: 10, rows: 8 } as const;

/** Street lanterns: along the Breezewatch road, round the plaza rim and toward the watchtower. */
export const STREET_LANTERNS: readonly XZ[] = [
  villageAt(10, -9), villageAt(-10, -9), villageAt(-13, 3), villageAt(-6, 13), villageAt(9, 11), villageAt(13, 3),
  villageAt(24, -13), villageAt(21, 24), villageAt(-2, -19),
];

/** Flower beds by the houses and the plaza (wilted at Skyshard 0). */
export const FLOWER_BEDS: readonly XZ[] = [villageAt(-7, -13), villageAt(7, -14), villageAt(-15, 8), villageAt(3, 15), villageAt(-24, -12)];

/** Star lanterns floating over the plaza (Skyshard 3): ring radius and height above the ground (m). */
export const STAR_LANTERNS = { radius: 7, height: 9, count: 8 } as const;

/** Dawn-festival tents after the ending: west and south of the plaza, clear of the roads. */
export const FESTIVAL_TENTS: readonly XZ[] = [villageAt(-10, -3), villageAt(-4, 9), villageAt(6, 8)];

/** Blight traces round the village (gone after the ending, Req 7.5): dark patches at the field and road edges. */
export const BLIGHT_PATCHES: readonly XZ[] = [villageAt(40, 5), villageAt(62, 34), villageAt(26, -20), villageAt(-30, 30), villageAt(-38, -14)];

/** The kite over the village once sq_tamsin is done: its anchor on the ground and its height (m). */
export const VILLAGE_KITE = { anchor: villageAt(-9, 11), height: 26 } as const;

// ── camp_durga and camp_oriel ───────────────────────────────────────────────

const DURGA_CAMP = { x: LOCATIONS.camp_durga.x, z: LOCATIONS.camp_durga.z } as const satisfies XZ;
const ORIEL_CAMP = { x: LOCATIONS.camp_oriel.x, z: LOCATIONS.camp_oriel.z } as const satisfies XZ;

/** The miners' camp: the cold forge (with its chimney) and the anvil Durga hammers at. */
export const DURGA_CAMP_PROPS = {
  forge: { x: DURGA_CAMP.x + 5, z: DURGA_CAMP.z + 4 },
  anvil: { x: DURGA_CAMP.x + 2.2, z: DURGA_CAMP.z + 1.4 },
} as const satisfies Readonly<Record<string, XZ>>;

/** The astronomer's camp: the telescope Oriel looks through. */
export const ORIEL_CAMP_PROPS = { telescope: { x: ORIEL_CAMP.x - 1.2, z: ORIEL_CAMP.z + 1.4 } } as const satisfies Readonly<Record<string, XZ>>;

// ── NPC behaviour ───────────────────────────────────────────────────────────

/** Named animation states the NPC rigs play (the temporary view tints / sways by them). */
export type NpcAnim =
  | 'idle' | 'walk' | 'run' | 'lookAround' | 'point' | 'leanCounter' | 'arrange' | 'eyesClosed' | 'sweep'
  | 'restOnHoe' | 'hoe' | 'armsCrossed' | 'hammer' | 'notebook' | 'telescope' | 'staff';

/**
 * Ambient behaviour: `walk` moves back and forth between the home spot and `to` (each ambient phase one way, at
 * `speed`), `loop` runs round `points` once and ends at home, `inPlace` plays its animation facing `face`.
 */
export type NpcAmbientDef =
  | { readonly kind: 'walk'; readonly anim: NpcAnim; readonly to: XZ; readonly speed: number }
  | { readonly kind: 'loop'; readonly anim: NpcAnim; readonly points: readonly XZ[]; readonly speed: number }
  | { readonly kind: 'inPlace'; readonly anim: NpcAnim; readonly face?: XZ };

export interface NpcPlacementDef {
  readonly id: Speaker;
  /** Home spot: (x, z) and, for a spot above the terrain (the windmill top), its height. */
  readonly home: XZ & { readonly y?: number };
  /** Facing at home (core/math yaw). */
  readonly yaw: number;
  /** The prompt's role line (Req 14.3). */
  readonly role: string;
  /** Idle animations, cycled one per idle phase; `point` faces `pointAt`. */
  readonly idle: readonly NpcAnim[];
  readonly pointAt?: XZ;
  readonly ambient: NpcAmbientDef;
  /** Phase lengths (s, each within 8–15), cycled: idle, ambient, idle, ... (a walk phase lasts its walk). */
  readonly durations: readonly number[];
  /** Villagers: their spot on the plaza rim from Skyshard 3 on, facing the Sanctum. */
  readonly gather?: XZ;
  /** A companion stands here until it joins. */
  readonly joins?: CharacterId;
  /**
   * After a talk with this NPC, the screen it runs: Pip's shop (Req 14.11), Old Bram's Echo Altar (Req 29.4). The
   * Dialogue_System publishes 'interact' with this targetKind and the NPC id; the screens' owners open them.
   */
  readonly opens?: 'shop' | 'echoAltar';
}

/** Alternation limits (s, Req 14.9). */
export const NPC_PHASE_SECONDS = { min: 8, max: 15 } as const;
/** A walking NPC stops while the player is within this (m, Req 14.3). */
export const NPC_STOP_RADIUS = 2.5;
/** Interaction body of an NPC (m). */
export const NPC_RADIUS = 0.45;
export const NPC_HEIGHT = 1.8;

/** A spot on the plaza rim at compass bearing `deg`, `r` m from the centre. */
function rim(deg: number, r = 9): XZ {
  const a = (deg * Math.PI) / 180;
  return villageAt(r * Math.sin(a), -r * Math.cos(a));
}

const face = (from: XZ, to: XZ): number => yawFromDir(to.x - from.x, to.z - from.z);

const MAREN_HOME = villageAt(-1, 1.5);
const MAREN_DOOR = villageAt(0, -18);
const PIP_HOME = villageAt(15.6, 0);
const BRAM_HOME = villageAt(-16, 1.5);
const WELL = villageAt(-9, 11);
const TAMSIN_HOME = villageAt(-6.2, 11);
const HOBB_HOME = villageAt(42, 18);
const HOBB_ROW_END = villageAt(56, 18);
const DURGA_HOME = { x: DURGA_CAMP.x, z: DURGA_CAMP.z };
const ORIEL_HOME = { x: ORIEL_CAMP.x - 3, z: ORIEL_CAMP.z + 3 };
const BREEZEWATCH = { x: LOCATIONS.breezewatch.x, z: LOCATIONS.breezewatch.z };

/** Tamsin's run round the well: a circle of radius 2.8 m starting and ending at her home spot. */
function wellLoop(): XZ[] {
  const r = Math.hypot(TAMSIN_HOME.x - WELL.x, TAMSIN_HOME.z - WELL.z);
  const start = Math.atan2(TAMSIN_HOME.z - WELL.z, TAMSIN_HOME.x - WELL.x);
  const out: XZ[] = [];
  for (let i = 1; i <= 12; i++) {
    const a = start + (i / 12) * Math.PI * 2;
    out.push({ x: WELL.x + r * Math.cos(a), z: WELL.z + r * Math.sin(a) });
  }
  return out;
}

export const NPC_PLACEMENTS: readonly NpcPlacementDef[] = [
  {
    id: 'maren', home: MAREN_HOME, yaw: face(MAREN_HOME, villageAt(16, -7)), role: '촌장', idle: ['staff', 'idle'],
    ambient: { kind: 'walk', anim: 'walk', to: MAREN_DOOR, speed: 1.6 }, durations: [15, 12, 10, 14], gather: rim(215),
  },
  {
    id: 'pip', home: PIP_HOME, yaw: WEST, role: '상점', idle: ['leanCounter'],
    ambient: { kind: 'inPlace', anim: 'arrange', face: villageAt(15.6, -1.6) }, durations: [9, 11, 13, 10], gather: rim(170), opens: 'shop',
  },
  {
    id: 'bram', home: BRAM_HOME, yaw: face(BRAM_HOME, VILLAGE_CENTER), role: 'Echo Altar 능력 강화', idle: ['eyesClosed'],
    ambient: { kind: 'inPlace', anim: 'sweep', face: villageAt(-18, 0) }, durations: [12, 9, 14, 11], gather: rim(260), opens: 'echoAltar',
  },
  {
    id: 'tamsin', home: TAMSIN_HOME, yaw: EAST, role: '마을 아이', idle: ['lookAround', 'point'], pointAt: BREEZEWATCH,
    ambient: { kind: 'loop', anim: 'run', points: wellLoop(), speed: 2 }, durations: [8, 10, 12, 9], gather: rim(192),
  },
  {
    id: 'hobb', home: HOBB_HOME, yaw: EAST, role: '농부', idle: ['restOnHoe'],
    ambient: { kind: 'walk', anim: 'hoe', to: HOBB_ROW_END, speed: 1.2 }, durations: [10, 13, 9, 12], gather: rim(237),
  },
  {
    id: 'durga', home: DURGA_HOME, yaw: yawFromDir(-1, 0.3), role: '광부', idle: ['armsCrossed'],
    ambient: { kind: 'inPlace', anim: 'hammer', face: DURGA_CAMP_PROPS.anvil }, durations: [11, 9, 13, 10],
  },
  {
    id: 'oriel', home: ORIEL_HOME, yaw: yawFromDir(0, 1), role: '천문학자', idle: ['notebook'],
    ambient: { kind: 'inPlace', anim: 'telescope', face: ORIEL_CAMP_PROPS.telescope }, durations: [12, 10, 14, 9],
  },
  // Companions until they join (Main_Quest talk targets; the old route-stub spots).
  {
    id: 'isla', home: villageAt(26, 31.5), yaw: yawFromDir(-1, -1), role: '궁수', idle: ['idle'],
    ambient: { kind: 'inPlace', anim: 'lookAround', face: villageAt(40, 20) }, durations: [10, 9], joins: 'isla',
  },
  {
    id: 'wren', home: { x: -128.4, z: 250.3, y: LOCATIONS.vista_verdant.groundY }, yaw: WEST, role: '풍차지기', idle: ['idle'],
    ambient: { kind: 'inPlace', anim: 'lookAround', face: { x: LOCATIONS.lm_elderbough.x, z: LOCATIONS.lm_elderbough.z } },
    durations: [11, 9], joins: 'wren',
  },
  {
    id: 'talus', home: { x: LOCATIONS.hollowroot_entrance.x - 3.5, z: LOCATIONS.hollowroot_entrance.z - 1 }, yaw: yawFromDir(1, 1),
    role: '수호자', idle: ['armsCrossed'], ambient: { kind: 'inPlace', anim: 'lookAround' }, durations: [12, 9], joins: 'talus',
  },
];

/** The placement of `id`, or undefined. */
export const npcPlacement = (id: Speaker): NpcPlacementDef | undefined => NPC_PLACEMENTS.find((p) => p.id === id);
