// Static terrain features the height synthesis (buildTerrain.ts) is shaped around: how each key
// location meets the ground (pads), the Ember canyons and the Broken Bridge chasm, the Elderbough
// sinkhole, the Breezewatch terraces, the waterfall shelf, the Azure landforms and the path
// polylines materialAt paints as dirt. Pure data and geometry: no three.js, DOM or randomness.

import {
  CHALLENGE_AREA_DEFS, HOLLOWROOT, HOLLOWROOT_ARENA_FLOOR_RADIUS, SHRINE_FLOOR_Y, type CarvePiece,
} from '../../data/challengeAreas';
import { CHALLENGE_ROUTES, LOCATIONS, MAIN_PATH, type LocationId, type XZ } from '../../data/worldLayout';

// ── Polylines ───────────────────────────────────────────────────────────────

/** Polyline vertex; `y` is a height carried along the line (canyon floor, path none). */
export interface PolylinePoint {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
}

/**
 * Polyline compiled for nearest-point queries in the per-sample loop: 7 numbers per segment
 * (ax, az, ay, dx, dz, dy, 1/len²) plus a bounding box for cheap early outs.
 */
export interface CompiledPolyline {
  readonly seg: Float64Array;
  readonly count: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export function compilePolyline(points: readonly PolylinePoint[]): CompiledPolyline {
  if (points.length === 0) throw new RangeError('compilePolyline: no points');
  const pts = points.length === 1 ? [points[0], points[0]] : points;
  const count = pts.length - 1;
  const seg = new Float64Array(count * 7);
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    seg.set([a.x, a.z, a.y ?? 0, dx, dz, (b.y ?? 0) - (a.y ?? 0), len2 > 0 ? 1 / len2 : 0], i * 7);
  }
  return {
    seg,
    count,
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minZ: Math.min(...pts.map((p) => p.z)),
    maxZ: Math.max(...pts.map((p) => p.z)),
  };
}

/** Result slot for {@link nearestOnPolyline}: distance to the line and `y` at the nearest point. */
export interface NearestHit {
  dist: number;
  y: number;
}

/**
 * Horizontal distance from (x, z) to `line` and the vertex `y` interpolated at the nearest point,
 * written into `out` (no allocation). Returns `out.dist`.
 */
export function nearestOnPolyline(line: CompiledPolyline, x: number, z: number, out: NearestHit): number {
  const s = line.seg;
  let best = Infinity;
  let y = 0;
  for (let i = 0, o = 0; i < line.count; i++, o += 7) {
    const rx = x - s[o];
    const rz = z - s[o + 1];
    let t = (rx * s[o + 3] + rz * s[o + 4]) * s[o + 6];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = rx - t * s[o + 3];
    const ez = rz - t * s[o + 4];
    const d2 = ex * ex + ez * ez;
    if (d2 < best) {
      best = d2;
      y = s[o + 2] + t * s[o + 5];
    }
  }
  out.dist = Math.sqrt(best);
  out.y = y;
  return out.dist;
}

/** Whether (x, z) lies within `margin` of the polyline's bounding box. */
export function nearBounds(line: CompiledPolyline, x: number, z: number, margin: number): boolean {
  return x >= line.minX - margin && x <= line.maxX + margin && z >= line.minZ - margin && z <= line.maxZ + margin;
}

// ── Key locations on the terrain ────────────────────────────────────────────

/**
 * How a key location meets the terrain.
 * - pad: its `groundY` is the ground. The heightfield is flattened to exactly `groundY` within
 *   `radius` and blended back into the surroundings over the next `blend` metres (detail noise off).
 * - structure: `groundY` is the top of a built structure standing on the terrain.
 * - floating: `groundY` is a floating isle above the terrain.
 * - water: `groundY` is a water surface level (see waterBodies.ts).
 */
export type LocationTerrainRole =
  | { readonly kind: 'pad'; readonly radius: number; readonly blend: number }
  | { readonly kind: 'structure' | 'floating' | 'water' };

const pad = (radius: number, blend: number): LocationTerrainRole => ({ kind: 'pad', radius, blend });
const STRUCTURE: LocationTerrainRole = { kind: 'structure' };
const FLOATING: LocationTerrainRole = { kind: 'floating' };
const WATER: LocationTerrainRole = { kind: 'water' };

/**
 * Terrain role of every key location (a Record, so a new location must be classified here).
 * Pads with different heights are spaced so that no pad's blend reaches another pad's flat
 * radius (unit-tested), which keeps every pad exactly at its contract height.
 */
export const LOCATION_TERRAIN_ROLES: Readonly<Record<LocationId, LocationTerrainRole>> = {
  thistlewick: pad(22, 18), // village ground
  ws_thistlewick: pad(4, 8),
  breezewatch: pad(5, 6), // foot of the terraces, see BREEZEWATCH_TERRACES
  vista_verdant: STRUCTURE, // windmill top (y 64)
  lm_elderbough: pad(10, 28), // wide blend: the tree, entrance and waystone share y 14
  hollowroot_entrance: pad(5, 8), // the shrine's spiral ramp starts level beside it, see CHALLENGE_AREA_CARVE
  ws_elderbough: pad(4, 8),
  lm_waterfall: pad(2, 2), // on the shelf's cliff edge above pond_verdant
  gate_ember: pad(8, 12),
  broken_bridge: pad(5, 4), // western bridge approach; the chasm starts 9 m further east
  camp_durga: pad(12, 12),
  ws_ember: pad(4, 10),
  vista_ember: pad(6, 10), // mesa top
  cinderspire_base: pad(8, 10),
  cinderspire_summit: STRUCTURE, // summit arena on top of the crystal spire (y 95)
  gate_azure: pad(6, 10),
  ws_azure: pad(4, 8),
  camp_oriel: pad(8, 8),
  lm_arch_azure: pad(8, 12), // ground under the natural arch
  lake_azure: WATER, // water surface y 70
  sky_ring_start: pad(5, 8), // cliff top
  lm_floating_isles: FLOATING, // ruin isles y 120–190
  vista_azure: pad(4, 8), // shoulder of AZURE_VISTA_PEAK
  observatory_entrance: pad(6, 6), // edge of OBSERVATORY_PLATEAU
  resonance_altar: pad(6, 6), // crater floor
  ws_crater: pad(4, 10),
  starlit_stair_start: pad(3, 10), // low rise on the crater floor
  sanctum_gate: FLOATING,
  sanctum_hall: FLOATING,
  ws_sanctum: FLOATING,
  sanctum_arena: FLOATING,
};

export interface TerrainPad {
  readonly id: LocationId;
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly radius: number;
  readonly blend: number;
}

/** Every ground pad with its contract height (`LOCATIONS[id].groundY`). */
export const TERRAIN_PADS: readonly TerrainPad[] = (Object.keys(LOCATION_TERRAIN_ROLES) as LocationId[]).flatMap(
  (id) => {
    const role = LOCATION_TERRAIN_ROLES[id];
    if (role.kind !== 'pad') return [];
    const loc = LOCATIONS[id];
    return [{ id, x: loc.x, z: loc.z, y: loc.groundY, radius: role.radius, blend: role.blend }];
  },
);

const at = (id: LocationId, y?: number): PolylinePoint => ({ x: LOCATIONS[id].x, z: LOCATIONS[id].z, y });

/** Unit vector from `a` towards `b`. */
function dirTo(a: XZ, b: XZ): XZ {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
}

// ── Verdant ─────────────────────────────────────────────────────────────────

/**
 * Stepped cliffs at Breezewatch (y 22 → 34 → 46, 12 m climbs). They rise from the breezewatch pad
 * towards the Elderbough, so the top terrace sits on the glide line to lm_elderbough. `along` is the
 * distance from the pad along `dir`; the band is `halfWidth` wide on each side, fading over `edge`.
 */
export const BREEZEWATCH_TERRACES = {
  origin: { x: LOCATIONS.breezewatch.x, z: LOCATIONS.breezewatch.z },
  dir: dirTo(LOCATIONS.breezewatch, LOCATIONS.lm_elderbough),
  footY: 22,
  /** [along start, along end, height reached] of each cliff. */
  steps: [
    [12, 14, 34],
    [30, 32, 46],
  ],
  /** The top terrace ends here and falls back to the hills by `fadeEnd`, short of the Elderbough. */
  topEnd: 60,
  fadeEnd: 95,
  halfWidth: 36,
  edge: 16,
} as const;

/** Pond fed by the waterfall (design: lm_waterfall row). Matches pond_verdant in waterBodies.ts. */
export const POND_VERDANT = { x: -380, z: 230, r: 30, level: 30, depth: 3 } as const;

/**
 * Shelf at y 60 behind the waterfall cliff north-west of pond_verdant: the cliff runs across the
 * pond→lm_waterfall axis between `cliffStart` and `cliffEnd` metres from the pond centre.
 */
export const WATERFALL_SHELF = {
  pond: { x: POND_VERDANT.x, z: POND_VERDANT.z },
  dir: dirTo(POND_VERDANT, LOCATIONS.lm_waterfall),
  cliffStart: 33,
  cliffEnd: 35,
  topY: LOCATIONS.lm_waterfall.groundY,
  halfWidth: 60,
  edge: 25,
} as const;

/**
 * Terrain cuts of the Challenge_Areas (src/data/challengeAreas.ts `carve`): the Hollowroot Shrine's spiral well and
 * ramp, corridors and rooms beside the Elderbough. buildTerrain applies them after the location pads, as min(), so
 * they only ever lower the ground; hollowroot_entrance keeps its contract y 14 because the ramp starts level there.
 */
export const CHALLENGE_AREA_CARVE: readonly CarvePiece[] = CHALLENGE_AREA_DEFS.flatMap((area) => area.carve);

/**
 * Elderbough sinkhole (Hollowroot Shrine, floor y −10): the shrine's main bowl, the Rootbound Warden arena R5 at its
 * deepest point, flat out to `floorRadius` with steep walls beyond its 17 m carve (one of the CHALLENGE_AREA_CARVE basins).
 */
export const ELDERBOUGH_SINKHOLE = {
  center: { x: HOLLOWROOT.arena.center.x, z: HOLLOWROOT.arena.center.z },
  floorY: SHRINE_FLOOR_Y,
  floorRadius: HOLLOWROOT_ARENA_FLOOR_RADIUS,
} as const;

// ── Ember ───────────────────────────────────────────────────────────────────

export interface CanyonDef {
  readonly id: string;
  /** Centreline; `y` is the canyon floor height at each vertex. */
  readonly points: readonly PolylinePoint[];
  /** Flat floor half-width (m). */
  readonly floorHalfWidth: number;
  /** Distance where the walls reach the mesa top (m). */
  readonly halfWidth: number;
}

/**
 * Canyons cut into the Ember mesa base. The main canyon follows gate_ember → broken_bridge →
 * cinderspire_base (design) through camp_durga and ws_ember so both sit on its floor; the crater
 * pass is added so the ground leg cinderspire_base → resonance_altar runs on a canyon floor around
 * the vista_ember mesa. Floor heights at the locations are their contract heights.
 */
export const EMBER_CANYONS: readonly CanyonDef[] = [
  {
    id: 'ember_canyon',
    points: [
      at('gate_ember', 20),
      at('broken_bridge', 12),
      at('camp_durga', 10),
      at('ws_ember', 8),
      at('cinderspire_base', 6),
    ],
    floorHalfWidth: 30,
    halfWidth: 60,
  },
  {
    id: 'ember_crater_pass',
    points: [
      at('cinderspire_base', 6),
      { x: 240, z: 150, y: 7 },
      { x: 150, z: 130, y: 9 },
      { x: 95, z: 72, y: 11 },
      { x: 60, z: 40, y: 10 },
    ],
    floorHalfWidth: 14,
    halfWidth: 38,
  },
];

/**
 * Mesa top heights: two flat levels with cliffs between them (mesas up to y 75). The mesa under
 * vista_ember is levelled to its y 70 within `radius`, fading over `edge`.
 */
export const EMBER_MESA = {
  lowY: 64,
  highY: 74,
  vista: { x: LOCATIONS.vista_ember.x, z: LOCATIONS.vista_ember.z, y: LOCATIONS.vista_ember.groundY, radius: 25, edge: 30 },
} as const;

const BRIDGE_TO_CAMP = dirTo(LOCATIONS.broken_bridge, LOCATIONS.camp_durga);
const CHASM_CENTER: XZ = {
  x: LOCATIONS.broken_bridge.x + 24 * BRIDGE_TO_CAMP.x,
  z: LOCATIONS.broken_bridge.z + 24 * BRIDGE_TO_CAMP.z,
};

/**
 * 30 m wide chasm at the Broken Bridge, across the canyon between broken_bridge and camp_durga
 * (its near edge is 9 m east of the bridge pad). Floor y −20 with an Updraft (design), walls ≈ 83°.
 */
export const BROKEN_BRIDGE_CHASM = {
  center: CHASM_CENTER,
  points: [
    { x: CHASM_CENTER.x + 60 * BRIDGE_TO_CAMP.z, z: CHASM_CENTER.z - 60 * BRIDGE_TO_CAMP.x },
    { x: CHASM_CENTER.x - 60 * BRIDGE_TO_CAMP.z, z: CHASM_CENTER.z + 60 * BRIDGE_TO_CAMP.x },
  ] as readonly PolylinePoint[],
  floorY: -20,
  floorHalfWidth: 11,
  /** Half the chasm width at the canyon floor. */
  halfWidth: 15,
} as const;

/** Red crystal field around the Cinderspire cluster (material 'crystal'). */
export const CINDERSPIRE_CRYSTAL_ZONE = { x: 335, z: 110, r: 45 } as const;

// ── Azure ───────────────────────────────────────────────────────────────────

/** Peak whose shoulder carries vista_azure (y 150); snow above y 150. */
export const AZURE_VISTA_PEAK = { x: -275, z: -400, topY: 168, slope: 0.7 } as const;

/**
 * Azure plateau ramp (heights by distance north of the origin, n = −z): y 26 at gate_azure up to
 * y 80 at ws_azure, linear between the two pads' flat radii, then rising 0.3 m per metre.
 */
export const AZURE_RAMP = { startN: 131, startY: 26, endN: 196, endY: 80, riseFromN: 204, rise: 0.3 } as const;

/**
 * Flat cliff-top blocks: the y 130 plateau whose southern edge carries observatory_entrance, and
 * the Sky Ring Trial start cliff (y 120).
 */
export const AZURE_PLATEAUS: readonly { x: number; z: number; y: number; radius: number; edge: number }[] = [
  { x: 150, z: -390, y: LOCATIONS.observatory_entrance.groundY, radius: 34, edge: 6 },
  { x: -20, z: -342, y: LOCATIONS.sky_ring_start.groundY, radius: 20, edge: 6 },
];

// ── Paths ───────────────────────────────────────────────────────────────────

/** Half-width of the dirt paths along the ground routes (m). */
export const PATH_HALF_WIDTH = 2.5;

const isPad = (id: LocationId): boolean => LOCATION_TERRAIN_ROLES[id].kind === 'pad';

/**
 * Dirt path segments: consecutive stops of the Challenge_Area ground routes and the ground legs of
 * the main path, between two ground pads, skipping pairs the main path travels by climb or glide
 * (e.g. camp_oriel → observatory_entrance). Each entry is a two-point polyline; duplicates dropped.
 */
export const PATH_POLYLINES: readonly (readonly PolylinePoint[])[] = (() => {
  const key = (a: LocationId, b: LocationId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const airborne = new Set(MAIN_PATH.filter((leg) => leg.mode !== 'ground').map((leg) => key(leg.from, leg.to)));
  const pairs: [LocationId, LocationId][] = [
    ...Object.values(CHALLENGE_ROUTES).flatMap((route) =>
      route.slice(1).map((to, i): [LocationId, LocationId] => [route[i], to]),
    ),
    ...MAIN_PATH.filter((leg) => leg.mode === 'ground').map((leg): [LocationId, LocationId] => [leg.from, leg.to]),
  ];
  const seen = new Set<string>();
  const out: PolylinePoint[][] = [];
  for (const [a, b] of pairs) {
    const k = key(a, b);
    if (a === b || seen.has(k) || airborne.has(k) || !isPad(a) || !isPad(b)) continue;
    seen.add(k);
    out.push([at(a), at(b)]);
  }
  return out;
})();
