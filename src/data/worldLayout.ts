/*
 * World layout (design.md, "World Layout Master Table"): the coordinate convention, Region bounds,
 * the key location table (with the Waystones and Blight_Barrier gates), the main path, and the
 * ground routes and glide the layout is checked against (Req 8.1, 8.8, 5.1, 2.3).
 *
 * Coordinates: metres; y is up, +x is east and −z is north (so +z is south); the origin is the
 * centre of Shardfall Crater. Horizontal data is (x, z); heights are y.
 *
 * Other placement data (waystones, barriers, volumes, POIs, spawns, quests, cinematic anchors)
 * refers to places by the `LocationId` keys declared here.
 *
 * Pure data and queries: no three.js, DOM or Math.random (src/data layering rule).
 */

import { yawFromDir } from '../core/math';
import { makeGuard, type ChallengeAreaId, type IdGuard, type RegionId } from './ids';

// ── Coordinate convention ───────────────────────────────────────────────────

/** Horizontal position or direction: x towards the east, z towards the south. */
export interface XZ {
  readonly x: number;
  readonly z: number;
}

/** Unit compass directions under the convention: +x is east, −z is north. */
export const COMPASS = {
  north: { x: 0, z: -1 },
  east: { x: 1, z: 0 },
  south: { x: 0, z: 1 },
  west: { x: -1, z: 0 },
} as const satisfies Readonly<Record<'north' | 'east' | 'south' | 'west', XZ>>;

/** Heightfield grid: x, z ∈ [−560, 560] sampled every 2 m, 561 × 561 samples. */
export const TERRAIN_GRID = { halfExtent: 560, step: 2, samplesPerSide: 561 } as const;

/**
 * Radius of the playable area around the origin (m). Ring mountains, cliffs and a cloud sea lie
 * beyond it, behind an invisible boundary wall (Req 8.6).
 */
export const PLAY_RADIUS = 470;

// ── Regions ─────────────────────────────────────────────────────────────────

/** Horizontal extent of a Region: a polygon of (x, z) vertices, or a circle. */
export type RegionBounds =
  | { readonly kind: 'polygon'; readonly points: readonly XZ[] }
  | { readonly kind: 'circle'; readonly center: XZ; readonly radius: number };

export interface RegionDef {
  readonly bounds: RegionBounds;
  /** Height band of a floating Region; a ground Region spans every height. */
  readonly altitude?: { readonly minY: number; readonly maxY: number };
}

/** Polygon for the design's "x minX..maxX, z minZ..maxZ" ranges; vertices NW → NE → SE → SW. */
function rect(minX: number, maxX: number, minZ: number, maxZ: number): RegionBounds {
  return {
    kind: 'polygon',
    points: [
      { x: minX, z: minZ },
      { x: maxX, z: minZ },
      { x: maxX, z: maxZ },
      { x: minX, z: maxZ },
    ],
  };
}

/**
 * Region extents from the design table. The three rectangles do not overlap and leave border
 * strips between them (Ashgate Pass lies in x 40..80); the crater circle overlaps verdant's
 * north-east corner and ember's west edge, and the Sanctum floats above the crater. In play,
 * everything is further limited by {@link PLAY_RADIUS}.
 */
export const REGIONS: Readonly<Record<RegionId, RegionDef>> = {
  // South-west: gentle hills, ground y 8–40.
  verdant: { bounds: rect(-460, 40, 60, 460) },
  // East to south-east: canyon floor y 0–15, mesas up to y 75.
  ember: { bounds: rect(80, 460, -80, 420) },
  // North: plateau y 60–110, peaks up to y 180.
  azure: { bounds: rect(-420, 360, -460, -110) },
  // Centre: bowl floor y 4, rim y 22.
  crater: { bounds: { kind: 'circle', center: { x: 0, z: 0 }, radius: 110 } },
  // Floating island above the crater, y 170–215.
  sanctum: {
    bounds: { kind: 'circle', center: { x: 0, z: 0 }, radius: 55 },
    altitude: { minY: 170, maxY: 215 },
  },
};

/** One-line Korean subtitle under the Region name on the first-entry title card (Req 8.7). */
export const REGION_SUBTITLES: Readonly<Record<RegionId, string>> = {
  verdant: '바람이 머무는 초록 언덕',
  ember: '붉은 수정이 타오르는 협곡',
  azure: '별에 가장 가까운 고원',
  crater: '별이 떨어진 자리',
  sanctum: '하늘에 떠 있는 별의 성소',
};

/** Whether (x, z) lies inside `bounds`. Points exactly on an edge may fall on either side. */
export function boundsContain(bounds: RegionBounds, x: number, z: number): boolean {
  switch (bounds.kind) {
    case 'circle': {
      const dx = x - bounds.center.x;
      const dz = z - bounds.center.z;
      return dx * dx + dz * dz <= bounds.radius * bounds.radius;
    }
    case 'polygon': {
      // Even-odd rule: count the edges crossed by a ray from (x, z) towards +x.
      const pts = bounds.points;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i];
        const b = pts[j];
        if ((a.z > z) !== (b.z > z) && x < a.x + ((z - a.z) * (b.x - a.x)) / (b.z - a.z)) inside = !inside;
      }
      return inside;
    }
  }
}

/** Lookup priority: the floating Sanctum, then the crater (it overlaps verdant and ember), then the rest. */
const REGION_PRIORITY: readonly RegionId[] = ['sanctum', 'crater', 'verdant', 'ember', 'azure'];

/**
 * Region containing a point, or null in the border strips between Regions. Without `y` (a map or
 * ground query) altitude-limited Regions (the Sanctum) are skipped; a NaN `y` matches none of them.
 * The result is not clipped by {@link PLAY_RADIUS}.
 */
export function regionAt(point: { readonly x: number; readonly z: number; readonly y?: number }): RegionId | null {
  const { y } = point;
  for (const id of REGION_PRIORITY) {
    const { bounds, altitude } = REGIONS[id];
    if (altitude !== undefined && !(y !== undefined && y >= altitude.minY && y <= altitude.maxY)) continue;
    if (boundsContain(bounds, point.x, point.z)) return id;
  }
  return null;
}

// ── Key locations ───────────────────────────────────────────────────────────

export interface LocationDef {
  /** Region of the location; for a boundary location, the first Region the design lists. */
  readonly region: RegionId;
  /** Boundary locations (the Blight_Barrier gates): the Region on the other side. */
  readonly border?: RegionId;
  readonly x: number;
  readonly z: number;
  /**
   * Height of the walkable surface at (x, z) ("지면 y"): the ground, or for vista_verdant the
   * windmill top, for sanctum_* the floating island and for lake_azure the water surface.
   */
  readonly groundY: number;
  /** Top of the range when the design gives one (lm_floating_isles: y 120–190). */
  readonly groundYMax?: number;
}

/*
 * The design's key location table in its order, plus three places it gives inside other rows or
 * sections: ws_thistlewick (thistlewick row, on the village ground y 18), vista_verdant (breezewatch
 * row and the map section) and ws_sanctum (inside sanctum_hall).
 */
const LOCATION_TABLE = {
  thistlewick: { region: 'verdant', x: -250, z: 300, groundY: 18 }, // village centre; Hearth (−246, 296)
  ws_thistlewick: { region: 'verdant', x: -232, z: 318, groundY: 18 },
  breezewatch: { region: 'verdant', x: -130, z: 250, groundY: 22 }, // foot of the cliffs 22 → 34 → 46 (≤ 12 m climbs)
  vista_verdant: { region: 'verdant', x: -130, z: 250, groundY: 64 }, // windmill top via its outer spiral stair, Vista_Point
  lm_elderbough: { region: 'verdant', x: -240, z: 150, groundY: 14 }, // giant old tree, ≈ 70 m tall
  hollowroot_entrance: { region: 'verdant', x: -228, z: 128, groundY: 14 }, // root arch → sinkhole shrine, floor y −10
  ws_elderbough: { region: 'verdant', x: -214, z: 170, groundY: 14 }, // south-east of the tree
  lm_waterfall: { region: 'verdant', x: -400, z: 200, groundY: 60 }, // plateau falls → pond_verdant (−380, 230), r 30, 3 m deep
  gate_ember: { region: 'verdant', border: 'ember', x: 60, z: 300, groundY: 20 }, // Ashgate Pass, Blight_Barrier 1
  broken_bridge: { region: 'ember', x: 170, z: 260, groundY: 12 }, // 30 m wide chasm, Updraft at the bottom
  camp_durga: { region: 'ember', x: 235, z: 235, groundY: 10 }, // miners' camp
  ws_ember: { region: 'ember', x: 250, z: 200, groundY: 8 }, // north of camp_durga
  vista_ember: { region: 'ember', x: 200, z: 60, groundY: 70 }, // mesa-top Vista_Point
  cinderspire_base: { region: 'ember', x: 330, z: 120, groundY: 6 }, // entrance of the crystal spire cluster
  cinderspire_summit: { region: 'ember', x: 340, z: 100, groundY: 95 }, // summit arena, r 14
  gate_azure: { region: 'crater', border: 'azure', x: 40, z: -125, groundY: 26 }, // past the crater's north rim, Blight_Barrier 2
  ws_azure: { region: 'azure', x: 30, z: -200, groundY: 80 }, // between gate_azure and camp_oriel
  camp_oriel: { region: 'azure', x: 40, z: -220, groundY: 82 }, // astronomer's camp
  lm_arch_azure: { region: 'azure', x: -60, z: -260, groundY: 95 }, // giant natural arch
  lake_azure: { region: 'azure', x: -200, z: -300, groundY: 70 }, // lake, water surface y 70, r 60
  sky_ring_start: { region: 'azure', x: -20, z: -330, groundY: 120 }, // Sky Ring Trial start cliff
  lm_floating_isles: { region: 'azure', x: -120, z: -400, groundY: 120, groundYMax: 190 }, // floating ruin isles
  vista_azure: { region: 'azure', x: -260, z: -380, groundY: 150 }, // peak Vista_Point
  observatory_entrance: { region: 'azure', x: 140, z: -360, groundY: 130 }, // Starfall Observatory, dome top y 150
  resonance_altar: { region: 'crater', x: 0, z: 0, groundY: 4 }, // central altar
  ws_crater: { region: 'crater', x: -40, z: 60, groundY: 8 }, // south-west part of the crater
  starlit_stair_start: { region: 'crater', x: 20, z: -10, groundY: 8 }, // appears once the altar is activated
  sanctum_gate: { region: 'sanctum', x: 0, z: -40, groundY: 175 }, // Sanctum entrance gate
  sanctum_hall: { region: 'sanctum', x: 0, z: -10, groundY: 180 }, // ws_sanctum and the mural, no combat
  ws_sanctum: { region: 'sanctum', x: 0, z: -10, groundY: 180 }, // in sanctum_hall
  sanctum_arena: { region: 'sanctum', x: 0, z: 30, groundY: 182 }, // Caelith arena, r 32
} as const satisfies Readonly<Record<string, LocationDef>>;

/** Id of a key location; other placement data refers to places by these. */
export type LocationId = keyof typeof LOCATION_TABLE;

export const LOCATIONS: Readonly<Record<LocationId, LocationDef>> = LOCATION_TABLE;

export const LOCATION_IDS = Object.keys(LOCATION_TABLE) as readonly LocationId[];

export const isLocationId: IdGuard<LocationId> = makeGuard(LOCATION_IDS);

/** Entrance of each Challenge_Area. */
export const CHALLENGE_ENTRANCES: Readonly<Record<ChallengeAreaId, LocationId>> = {
  hollowroot: 'hollowroot_entrance',
  cinderspire: 'cinderspire_base',
  observatory: 'observatory_entrance',
};

// ── Thistlewick spots ───────────────────────────────────────────────────────

/** A standing spot: where the feet go and which way the character faces (rad, core/math yaw). */
export interface SpotDef {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly yaw: number;
}

/** Id of Thistlewick's Hearth as a respawn point (`GameState.respawn` of kind 'hearth'). */
export type HearthId = 'hearth_thistlewick';

/**
 * Thistlewick's Hearth in the plaza, (+4, −4) from the village centre (design "Thistlewick"): the
 * healing bonfire and the New Game respawn point. Standing there faces north.
 */
export const THISTLEWICK_HEARTH: SpotDef & { readonly id: HearthId } = {
  id: 'hearth_thistlewick',
  x: -246,
  z: 296,
  groundY: LOCATIONS.thistlewick.groundY,
  yaw: yawFromDir(COMPASS.north.x, COMPASS.north.z),
};

/**
 * Distance of the village entrance from the centre (m), on the road toward Breezewatch (the first
 * main-path leg). It stays inside the flat 22 m village pad, so the ground there is y 18.
 */
export const VILLAGE_ENTRANCE_DISTANCE = 18;

/** Thistlewick's village entrance on the Breezewatch road, facing the village centre. */
function villageEntrance(): SpotDef {
  const village = LOCATIONS.thistlewick;
  const road = LOCATIONS.breezewatch;
  const length = Math.hypot(road.x - village.x, road.z - village.z);
  const x = village.x + ((road.x - village.x) / length) * VILLAGE_ENTRANCE_DISTANCE;
  const z = village.z + ((road.z - village.z) / length) * VILLAGE_ENTRANCE_DISTANCE;
  return { x, z, groundY: village.groundY, yaw: yawFromDir(village.x - x, village.z - z) };
}

/** Where a New Game starts (Req 2.1): Thistlewick's village entrance, looking into the village. */
export const NEW_GAME_START: SpotDef = villageEntrance();

// ── Travel budget ───────────────────────────────────────────────────────────

/**
 * Movement figures the layout is checked against (design "메인 경로와 거리 검증"). They restate
 * Player_Controller and Stamina values so layout data can be verified without the simulation.
 */
export const LAYOUT_TRAVEL = {
  /** Running speed, m/s (Req 16.1). */
  runSpeed: 6,
  /** Longest allowed run from Thistlewick to a Challenge_Area entrance, s (Req 8.8). */
  maxRunSeconds: 180,
  /** Horizontal glide speed, m/s (Req 19.2). */
  glideSpeed: 9,
  /** Maximum sink rate while gliding, m/s (Req 19.2). */
  glideSinkSpeed: 2.5,
  /** Stamina spent per second of gliding (Req 19.2). */
  glideStaminaPerSecond: 6,
  /** Base maximum Stamina, before Echo_Tablet bonuses (Req 2.3, 10.9). */
  baseStamina: 100,
} as const;

/** Horizontal metres gained per metre of drop while gliding: 9 ÷ 2.5 = 3.6. */
export const GLIDE_RATIO = LAYOUT_TRAVEL.glideSpeed / LAYOUT_TRAVEL.glideSinkSpeed;

/** Longest allowed ground route from Thistlewick to a Challenge_Area entrance: 6 m/s × 180 s = 1,080 m. */
export const MAX_ROUTE_LENGTH = LAYOUT_TRAVEL.runSpeed * LAYOUT_TRAVEL.maxRunSeconds;

/** Horizontal length of the polyline through `points` (m); 0 for fewer than two points. */
export function polylineLength(points: readonly XZ[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

// ── Main path, ground routes, glide ─────────────────────────────────────────

/**
 * How a main-path leg is travelled: on foot, climbing (the Breezewatch cliffs and windmill stair),
 * gliding (the design's "활강" legs, which may end on foot; only {@link BREEZEWATCH_GLIDE} is
 * budgeted as one continuous glide), or up the Starlit_Stair (floating steps and starlit Updrafts).
 */
export type TravelMode = 'ground' | 'climb' | 'glide' | 'starlitStair';

export interface MainPathLeg {
  readonly from: LocationId;
  readonly to: LocationId;
  readonly mode: TravelMode;
}

/**
 * The main path in story order as a chain of legs (design "메인 경로"). Each Challenge_Area is run
 * from its entrance, and its Skyshard is held before the next leg: gate_ember opens at Skyshard 1,
 * gate_azure at Skyshard 2, and the Starlit_Stair appears once the altar takes all three.
 */
export const MAIN_PATH: readonly MainPathLeg[] = [
  { from: 'thistlewick', to: 'breezewatch', mode: 'ground' },
  { from: 'breezewatch', to: 'vista_verdant', mode: 'climb' },
  { from: 'vista_verdant', to: 'lm_elderbough', mode: 'glide' }, // BREEZEWATCH_GLIDE
  { from: 'lm_elderbough', to: 'hollowroot_entrance', mode: 'ground' }, // Hollowroot Shrine → Skyshard 1
  { from: 'hollowroot_entrance', to: 'gate_ember', mode: 'ground' },
  { from: 'gate_ember', to: 'broken_bridge', mode: 'ground' },
  { from: 'broken_bridge', to: 'camp_durga', mode: 'ground' }, // crosses the chasm on its Updraft
  { from: 'camp_durga', to: 'ws_ember', mode: 'ground' },
  { from: 'ws_ember', to: 'cinderspire_base', mode: 'ground' }, // Cinderspire → Skyshard 2
  { from: 'cinderspire_base', to: 'resonance_altar', mode: 'ground' }, // west over the crater floor
  { from: 'resonance_altar', to: 'gate_azure', mode: 'ground' },
  { from: 'gate_azure', to: 'camp_oriel', mode: 'ground' },
  { from: 'camp_oriel', to: 'observatory_entrance', mode: 'glide' }, // Wind_Zone glide; Starfall Observatory → Skyshard 3
  { from: 'observatory_entrance', to: 'resonance_altar', mode: 'glide' }, // glide down towards the crater (386 m)
  { from: 'resonance_altar', to: 'starlit_stair_start', mode: 'ground' },
  { from: 'starlit_stair_start', to: 'sanctum_gate', mode: 'starlitStair' },
  { from: 'sanctum_gate', to: 'sanctum_hall', mode: 'ground' },
  { from: 'sanctum_hall', to: 'sanctum_arena', mode: 'ground' },
];

/**
 * Ground routes from Thistlewick to each Challenge_Area entrance over the paths open when the
 * player first heads there (Challenge_Areas are cleared in `CHALLENGE_AREA_IDS` order, so with 0, 1
 * and 2 Skyshards). A route is the polyline through its waypoints' (x, z); the design table puts
 * them at ≈ 305, 640 and 800 m against the 1,080 m limit (Req 8.8).
 */
export const CHALLENGE_ROUTES: Readonly<Record<ChallengeAreaId, readonly LocationId[]>> = {
  hollowroot: ['thistlewick', 'breezewatch', 'lm_elderbough', 'hollowroot_entrance'],
  cinderspire: ['thistlewick', 'gate_ember', 'broken_bridge', 'camp_durga', 'ws_ember', 'cinderspire_base'],
  observatory: ['thistlewick', 'ws_crater', 'resonance_altar', 'gate_azure', 'camp_oriel', 'observatory_entrance'],
};

/** A glide from a launch point to a landing target; the heights are the locations' `groundY`. */
export interface GlideSegmentDef {
  readonly from: LocationId;
  readonly to: LocationId;
}

/**
 * ms2's glide from the Breezewatch windmill top (y 64) to the Elderbough (y 14): ≈ 148.7 m
 * horizontally, so at glide ratio 3.6 it needs ≈ 41.3 m of the 50 m drop and ≈ 16.5 s of the
 * 16.7 s that base Stamina lasts at 6/s (Req 2.3, 19.2).
 */
export const BREEZEWATCH_GLIDE: GlideSegmentDef = { from: 'vista_verdant', to: 'lm_elderbough' };
