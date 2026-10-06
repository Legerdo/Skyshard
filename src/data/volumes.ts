/*
 * Trigger and air volumes (design.md "물·기류·트리거 볼륨", "콘텐츠 정의 타입" volumes.ts).
 *
 * - `area`: Region part, POI or Challenge_Area trigger. Entering it publishes `'area:entered'` with the
 *   volume id as `areaId` (the Main_Quest `reach` targets and the Challenge_Area ids), telling a first
 *   entry from a return (`first`). Regions themselves are tracked from `regionAt`, not from volumes.
 * - `discovery`: Landmark discovery radius. The first entry publishes `'landmark:discovered'` (Req 9.4).
 * - `updraft`: vertical column that lifts a glider at 8 m/s up to `shape.maxY` (Req 19.6). Declared so far: the
 *   Broken Bridge chasm column and the Challenge_Areas' vents (Cinderspire U1 / U2) in AIR_VOLUMES, and the two
 *   starlit Updrafts of the Starlit_Stair (src/data/starlitStair.ts, only while the stair is active); the Observatory
 *   cliff and floating isles columns arrive with their areas.
 * - `windZone`: box (OBB) of strong wind that pushes a glider 4 m/s along `direction` (Req 19.7). Declared so far:
 *   the Azure ridge wind from camp_oriel toward wind_ridge_end (ms6).
 * - `hazard`: a Challenge_Area's fall judgement (HAZARD_VOLUMES; the Hollowroot well, the Cinderspire floor between the
 *   spires, the Observatory courtyard below its dome stairs). Water volumes join this union with their system (the
 *   water surfaces are terrain data so far).
 *
 * Shapes are vertical cylinders (centre (x, z), radius) or boxes turned about +Y (centre, half extents, yaw), each
 * with a height band [minY, maxY] (feet). Pure data and queries: no three.js, DOM or Math.random (src/data layering
 * rule).
 */

import { yawFromDir } from '../core/math';
import {
  CHALLENGE_AREA_DEFS, CINDERSPIRE, HOLLOWROOT, OBSERVATORY, OBSERVATORY_HALL_CENTER, OBSERVATORY_HALL_RADIUS, OBSERVATORY_Y, checkpointById,
  type AreaHazardDef, type ChallengeAreaDef,
} from './challengeAreas';
import type { ChallengeAreaId, LandmarkId, RegionId, SfxId } from './ids';
import { LOCATIONS, type LocationId } from './worldLayout';

/** Vertical cylinder around (x, z) covering feet heights minY..maxY. */
export interface CylinderShape {
  readonly kind: 'cylinder';
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * Box turned `yaw` about +Y (core/math convention: its local +Z faces dirFromYaw(yaw)), centred on (x, z), with
 * half extents halfX / halfZ along its local axes, covering feet heights minY..maxY.
 */
export interface BoxShape {
  readonly kind: 'box';
  readonly x: number;
  readonly z: number;
  readonly halfX: number;
  readonly halfZ: number;
  readonly yaw: number;
  readonly minY: number;
  readonly maxY: number;
}

export type VolumeShape = CylinderShape | BoxShape;

export interface AreaVolumeDef {
  readonly kind: 'area';
  /** `'area:entered'` areaId: a Main_Quest `reach` target or a ChallengeAreaId. */
  readonly id: string;
  readonly region: RegionId;
  readonly shape: VolumeShape;
}

export interface DiscoveryVolumeDef {
  readonly kind: 'discovery';
  readonly id: LandmarkId;
  readonly region: RegionId;
  readonly shape: VolumeShape;
}

export interface UpdraftVolumeDef {
  readonly kind: 'updraft';
  readonly id: string;
  /** The vertical column (design: cylinder with radius, base and top height); `maxY` is where the rise stops (Req 19.6). */
  readonly shape: CylinderShape;
}

export interface WindZoneVolumeDef {
  readonly kind: 'windZone';
  readonly id: string;
  readonly shape: VolumeShape;
  /** Horizontal unit direction the wind pushes a glider (Req 19.7). */
  readonly direction: { readonly x: number; readonly z: number };
}

/**
 * `hazard` (design "물·기류·트리거 볼륨"): a Challenge_Area's fall judgement. Feet inside fade the character back to
 * the area's latest checkpoint while the area's Skyshard is not taken (Req 12.8, 12.9); the ground inside never
 * becomes a Safe_Position. Lava and hot-crystal hazards join this kind with their systems.
 */
export interface HazardVolumeDef {
  readonly kind: 'hazard';
  readonly id: string;
  /** The Challenge_Area it belongs to. */
  readonly area: ChallengeAreaId;
  readonly effect: 'fall';
  readonly shape: VolumeShape;
}

export type VolumeDef = AreaVolumeDef | DiscoveryVolumeDef | UpdraftVolumeDef | WindZoneVolumeDef | HazardVolumeDef;
export type VolumeKind = VolumeDef['kind'];
/** The volumes that act on a glider. */
export type AirVolumeDef = UpdraftVolumeDef | WindZoneVolumeDef;

/** Whether the point (feet) lies inside `shape`, boundary included. */
export function volumeContains(shape: VolumeShape, p: { readonly x: number; readonly y: number; readonly z: number }): boolean {
  if (!(p.y >= shape.minY && p.y <= shape.maxY)) return false;
  const dx = p.x - shape.x;
  const dz = p.z - shape.z;
  if (shape.kind === 'cylinder') return dx * dx + dz * dz <= shape.radius * shape.radius;
  // World → box-local: the inverse of the yaw rotation (wx = vx·cos + vz·sin, wz = −vx·sin + vz·cos).
  const c = Math.cos(shape.yaw);
  const s = Math.sin(shape.yaw);
  return Math.abs(dx * c - dz * s) <= shape.halfX && Math.abs(dx * s + dz * c) <= shape.halfZ;
}

/** Horizontal extent of a shape, for the spatial hash. */
export function volumeBounds(shape: VolumeShape): { minX: number; minZ: number; maxX: number; maxZ: number } {
  if (shape.kind === 'cylinder') {
    return { minX: shape.x - shape.radius, minZ: shape.z - shape.radius, maxX: shape.x + shape.radius, maxZ: shape.z + shape.radius };
  }
  const c = Math.abs(Math.cos(shape.yaw));
  const s = Math.abs(Math.sin(shape.yaw));
  const ex = c * shape.halfX + s * shape.halfZ;
  const ez = s * shape.halfX + c * shape.halfZ;
  return { minX: shape.x - ex, minZ: shape.z - ez, maxX: shape.x + ex, maxZ: shape.z + ez };
}

const cylinder = (x: number, z: number, radius: number, minY: number, maxY: number): CylinderShape => ({
  kind: 'cylinder', x, z, radius, minY, maxY,
});

/** Cylinder on a key location: `below` / `above` metres around its walkable height. */
const around = (id: LocationId, radius: number, below: number, above: number): CylinderShape => {
  const loc = LOCATIONS[id];
  return cylinder(loc.x, loc.z, radius, loc.groundY - below, loc.groundY + above);
};

const area = (id: string, region: RegionId, shape: CylinderShape): AreaVolumeDef => ({ kind: 'area', id, region, shape });

/** End of the Azure wind ridge (the ms6 `reach wind_ridge_end` target), where the ridge wind blows toward. */
const WIND_RIDGE_END = { x: 110, z: -318 } as const;

/** A Challenge_Area's bounds (src/data/challengeAreas.ts) as its area box. */
const areaBox = (area: ChallengeAreaDef): BoxShape => {
  const b = area.bounds;
  return { kind: 'box', x: b.center.x, z: b.center.z, halfX: b.halfAcross, halfZ: b.halfAlong, yaw: b.yaw, minY: b.minY, maxY: b.maxY };
};

/**
 * A Main_Quest `reach` target on a Challenge_Area checkpoint (Cinderspire ms5 ①–②): 4 m around its rune, from 1 m
 * below its ledge to 3 m above (the feet on the ledge, not on the wall climbed to it).
 */
function checkpointArea(id: string): CylinderShape {
  const found = checkpointById(id);
  if (found === null) throw new Error(`volumes: no checkpoint ${id}`);
  const { pos } = found.checkpoint.spot;
  return cylinder(pos.x, pos.z, 4, pos.y - 1, pos.y + 3);
}

/** Challenge_Area triggers; the first entry plays the area's entry cinematic (Req 12.5). */
const CHALLENGE_AREAS: readonly (AreaVolumeDef & { readonly id: ChallengeAreaId })[] = [
  // The Hollowroot Shrine below the root arch: the spiral well and every room (floor y −10, arch ground y 14 above it).
  { kind: 'area', id: 'hollowroot', region: HOLLOWROOT.region, shape: areaBox(HOLLOWROOT) },
  // The Cinderspire spire cluster from its base pad (330, 120) and spire A to spire B, up to above the summit (y 95).
  { kind: 'area', id: 'cinderspire', region: CINDERSPIRE.region, shape: areaBox(CINDERSPIRE) },
  // Starfall Observatory from its entrance terrace (y 130) and the ring lift's landing to the dome (y 150) and its balcony.
  { kind: 'area', id: 'observatory', region: OBSERVATORY.region, shape: areaBox(OBSERVATORY) },
];

/** The great hall's floor (y 132) inside its wall, up to below its ceiling: the ms7 `reach observatory_hall` target. */
const OBSERVATORY_HALL_AREA = cylinder(
  OBSERVATORY_HALL_CENTER.x, OBSERVATORY_HALL_CENTER.z, OBSERVATORY_HALL_RADIUS - 0.5, OBSERVATORY_Y.hall - 1, OBSERVATORY_Y.hall + 6,
);

/**
 * Main_Quest `reach` targets (src/data/quests.ts), in story order. Each band starts a little below the
 * walkable height, so a character standing, landing or gliding low over the spot is inside.
 */
const QUEST_AREAS: readonly AreaVolumeDef[] = [
  area('thistlewick', 'verdant', around('thistlewick', 40, 10, 40)),
  area('breezewatch_base', 'verdant', around('breezewatch', 14, 8, 10)), // cliff foot, below the 34 m tier
  area('vista_verdant', 'verdant', around('vista_verdant', 5, 2, 8)), // windmill top
  area('lm_elderbough', 'verdant', around('lm_elderbough', 24, 10, 40)), // glide landing by the old tree
  // East of the Ashgate wall (x 60), inside the pass: only reachable once gate_ember is open.
  area('gate_ember', 'ember', cylinder(72, 296, 8, 10, 40)),
  area('bridge_far_side', 'ember', cylinder(190, 253, 8, 4, 30)),
  area('cinderspire_base', 'ember', around('cinderspire_base', 10, 6, 14)),
  area('cp_cinderspire_1', 'ember', checkpointArea('cp_cinderspire_1')), // rest ledge L2 on spire A (y 32)
  area('cp_cinderspire_2', 'ember', checkpointArea('cp_cinderspire_2')), // L4 on spire B, above the Heat_Crystal wall (y 64)
  // North of the gate_azure wall (z −125), on the plateau ramp: only reachable once gate_azure is open.
  area('gate_azure', 'azure', cylinder(40, -134, 8, 20, 50)),
  area('wind_ridge_end', 'azure', cylinder(WIND_RIDGE_END.x, WIND_RIDGE_END.z, 8, 114, 135)),
  area('observatory_hall', 'azure', OBSERVATORY_HALL_AREA), // inside the great hall, below the ring corridor (y 140)
  area('resonance_altar', 'crater', around('resonance_altar', 12, 6, 26)),
  area('sanctum_gate', 'sanctum', around('sanctum_gate', 8, 5, 10)),
  area('sanctum_arena', 'sanctum', around('sanctum_arena', 28, 6, 18)),
];

/** Every `area` volume: Challenge_Areas, then the quest targets. */
export const AREA_VOLUMES: readonly AreaVolumeDef[] = [...CHALLENGE_AREAS, ...QUEST_AREAS];

/** A hazard's shape: its disc, or its axis-aligned box. */
const hazardShape = (h: AreaHazardDef): VolumeShape =>
  h.box === undefined
    ? cylinder(h.center.x, h.center.z, h.radius, h.minY, h.maxY)
    : { kind: 'box', x: h.center.x, z: h.center.z, halfX: h.box.halfX, halfZ: h.box.halfZ, yaw: 0, minY: h.minY, maxY: h.maxY };

/**
 * Challenge_Area fall judgement volumes (the Hollowroot well's floor, the Cinderspire floor between the spires, the
 * Observatory's courtyard below the dome stairs).
 */
export const HAZARD_VOLUMES: readonly HazardVolumeDef[] = CHALLENGE_AREA_DEFS.flatMap((area) =>
  area.hazards.map((h): HazardVolumeDef => ({ kind: 'hazard', id: h.id, area: area.id, effect: 'fall', shape: hazardShape(h) })),
);

/** Heights a ground Landmark's discovery radius covers: from below the lowest terrain to above any glide. */
const DISCOVERY_MIN_Y = -40;
const DISCOVERY_MAX_Y = 400;

const discovery = (id: LandmarkId, region: RegionId, x: number, z: number, radius: number, minY = DISCOVERY_MIN_Y): DiscoveryVolumeDef => ({
  kind: 'discovery', id, region, shape: cylinder(x, z, radius, minY, DISCOVERY_MAX_Y),
});

/** One discovery radius per Landmark (Req 9.1, 9.4). */
export const DISCOVERY_VOLUMES: readonly DiscoveryVolumeDef[] = [
  discovery('lm_breezewatch', 'verdant', LOCATIONS.breezewatch.x, LOCATIONS.breezewatch.z, 45),
  discovery('lm_elderbough', 'verdant', LOCATIONS.lm_elderbough.x, LOCATIONS.lm_elderbough.z, 50),
  discovery('lm_waterfall', 'verdant', LOCATIONS.lm_waterfall.x, LOCATIONS.lm_waterfall.z, 40),
  discovery('lm_cinderspire', 'ember', 336, 106, 60),
  discovery('lm_observatory', 'azure', 145, -378, 50),
  discovery('lm_arch_azure', 'azure', LOCATIONS.lm_arch_azure.x, LOCATIONS.lm_arch_azure.z, 40),
  discovery('lm_floating_isles', 'azure', LOCATIONS.lm_floating_isles.x, LOCATIONS.lm_floating_isles.z, 60),
  // The floating Sanctum is discovered on the way up the Starlit_Stair, not from the crater floor.
  discovery('lm_astral_sanctum', 'sanctum', 0, 0, 70, 120),
];

// ── Air volumes (Req 19.6–19.8) ──────────────────────────────────────────────

/** Unit direction and distance from one location to another (horizontal). */
function between(from: LocationId, to: LocationId): { x: number; z: number; length: number } {
  const a = LOCATIONS[from];
  const b = LOCATIONS[to];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  return { x: dx / length, z: dz / length, length };
}

/**
 * Centre of the Broken Bridge chasm: 24 m from the bridge pad toward camp_durga, the same point the terrain's
 * BROKEN_BRIDGE_CHASM is cut around (src/world/terrain/features.ts; a test keeps them together).
 */
const BRIDGE_TO_CAMP = between('broken_bridge', 'camp_durga');
export const BROKEN_BRIDGE_CHASM_CENTER = {
  x: LOCATIONS.broken_bridge.x + 24 * BRIDGE_TO_CAMP.x,
  z: LOCATIONS.broken_bridge.z + 24 * BRIDGE_TO_CAMP.z,
} as const;
/** Chasm floor height (terrain BROKEN_BRIDGE_CHASM.floorY). */
const CHASM_FLOOR_Y = -20;

/**
 * Azure ridge wind (ms6): from camp_oriel toward the Observatory, over the wind_ridge_end area, which lies on the
 * same line; the box runs from just short of camp_oriel to just past the ridge end.
 */
const ORIEL_TO_RIDGE = between('camp_oriel', 'observatory_entrance');
const RIDGE_WIND_CENTER = {
  x: (LOCATIONS.camp_oriel.x + WIND_RIDGE_END.x) / 2,
  z: (LOCATIONS.camp_oriel.z + WIND_RIDGE_END.z) / 2,
};

/**
 * Air volumes of the world, registered in the VolumeIndex with the others: the open-world ones and the Challenge_Area
 * vents (Cinderspire U1 / U2). The starlit Updrafts are not listed: the Starlit_Stair adds and removes them with its
 * platforms.
 */
export const AIR_VOLUMES: readonly AirVolumeDef[] = [
  // Chasm floor (y −20) to 12 m above its rims (y 12): ride up out of the chasm and glide on to the far side.
  { kind: 'updraft', id: 'updraft_broken_bridge', shape: cylinder(BROKEN_BRIDGE_CHASM_CENTER.x, BROKEN_BRIDGE_CHASM_CENTER.z, 6, CHASM_FLOOR_Y, 24) },
  ...CHALLENGE_AREA_DEFS.flatMap((area) =>
    area.updrafts.map((u): AirVolumeDef => ({ kind: 'updraft', id: u.id, shape: cylinder(u.center.x, u.center.z, u.radius, u.minY, u.maxY) })),
  ),
  {
    kind: 'windZone',
    id: 'wind_azure_ridge',
    shape: {
      kind: 'box', x: RIDGE_WIND_CENTER.x, z: RIDGE_WIND_CENTER.z, halfX: 14, halfZ: 64,
      yaw: yawFromDir(ORIEL_TO_RIDGE.x, ORIEL_TO_RIDGE.z), minY: 80, maxY: 170,
    },
    direction: { x: ORIEL_TO_RIDGE.x, z: ORIEL_TO_RIDGE.z },
  },
];

/** How each air volume kind is shown and heard (Req 19.8): the render's particle look and the Audio_System's loop. */
export interface AirVolumePresentation {
  /** Particle effect: rising motes in the column, or wind streaks flowing along the direction. */
  readonly vfx: `vfx_${string}`;
  /** Looped wind sound played at the volume while the listener is near (the Audio_System maps it, task 16). */
  readonly sfx: SfxId;
  /** 0xRRGGBB of the particles. */
  readonly color: number;
}

export const AIR_VOLUME_PRESENTATION: Readonly<Record<AirVolumeDef['kind'], AirVolumePresentation>> = {
  updraft: { vfx: 'vfx_updraft_column', sfx: 'sfx_updraft_loop', color: 0xfff1c9 },
  windZone: { vfx: 'vfx_wind_streaks', sfx: 'sfx_wind_zone_loop', color: 0xe4f6ff },
};

/** Whether a volume acts on a glider. */
export function isAirVolume(def: VolumeDef): def is AirVolumeDef {
  return def.kind === 'updraft' || def.kind === 'windZone';
}
