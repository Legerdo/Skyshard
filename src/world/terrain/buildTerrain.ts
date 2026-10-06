// Terrain heightfield (design "지형 생성 (src/world/terrain, 순수)", Req 8.1–8.6, 1.10).
//
// buildTerrain(seed) synthesises one height per 2 m grid sample (561 × 561 over x, z ∈ [−560, 560])
// and every later query and chunk mesh reads only that array. A sample's height is, in order:
//   1. a region-mask weighted sum of the Verdant, Ember, Azure and crater shape functions
//      (masks blend over 40 m and sum to 1),
//   2. ±0.5 m of seeded detail noise,
//   3. local carving: the lake, pond and river basins (the crater bowl and the Broken Bridge chasm are
//      part of the crater and Ember shapes),
//   4. ring mountains rising beyond the play radius (470 → 540 m, ≈ +180 m),
//   5. key location pads flattened to their contract heights (detail noise off),
//   6. the Challenge_Area cuts (the Hollowroot Shrine's well, spiral ramp and rooms), as min() after the pads so
//      their floors keep their exact heights; they never go below a pad inside its flat radius.
// Pure and deterministic: no three.js, DOM or Math.random; noise comes from seeded permutations.

import { RAD2DEG, clamp, lerp, smoothstep, type Vec3 } from '../../core/math';
import { deriveSeed } from '../../core/rng';
import { PLAY_RADIUS, REGIONS, TERRAIN_GRID, type RegionBounds } from '../../data/worldLayout';
import { MAX_WALKABLE_SLOPE_DEG, type TerrainMaterial } from '../../physics/types';
import {
  AZURE_PLATEAUS,
  AZURE_RAMP,
  AZURE_VISTA_PEAK,
  BREEZEWATCH_TERRACES,
  BROKEN_BRIDGE_CHASM,
  CHALLENGE_AREA_CARVE,
  CINDERSPIRE_CRYSTAL_ZONE,
  EMBER_CANYONS,
  EMBER_MESA,
  PATH_HALF_WIDTH,
  PATH_POLYLINES,
  TERRAIN_PADS,
  WATERFALL_SHELF,
  compilePolyline,
  nearBounds,
  nearestOnPolyline,
  type NearestHit,
} from './features';
import { createNoise2D, fbm, ridged, type Noise2D } from './noise';
import { WATER_BODIES, waterLevelAt, type WaterBody } from './waterBodies';

export type { TerrainMaterial } from '../../physics/types';

/** Terrain-shaping regions (the floating Sanctum has no ground). */
export type TerrainRegion = 'verdant' | 'ember' | 'azure' | 'crater';

export interface TerrainField {
  /** Seed the field was built from, coerced to uint32. */
  readonly seed: number;
  /** 561 × 561 heights on a 2 m grid over x, z ∈ [−560, 560]; index `iz * 561 + ix`, `ix = (x + 560) / 2`. */
  readonly heights: Float32Array;
  /** Bilinear height; positions outside the grid are clamped onto it. */
  heightAt(x: number, z: number): number;
  /** Unit normal from central differences of heightAt at ±2 m. */
  normalAt(x: number, z: number): Vec3;
  /** acos(normalAt(x, z).y) in degrees. */
  slopeDeg(x: number, z: number): number;
  materialAt(x: number, z: number): TerrainMaterial;
  /** Water surface level − heightAt where there is water, else 0 (never negative). */
  waterDepthAt(x: number, z: number): number;
  /** Horizontal distance from the origin ≤ PLAY_RADIUS (470 m). */
  insideBoundary(x: number, z: number): boolean;
  /** slopeDeg ≤ 50 ∧ waterDepthAt < 1.2 ∧ insideBoundary. */
  walkable(x: number, z: number): boolean;
}

// ── Contract values ─────────────────────────────────────────────────────────

const N = TERRAIN_GRID.samplesPerSide;
const HALF = TERRAIN_GRID.halfExtent;
const STEP = TERRAIN_GRID.step;

/** Width of the smoothstep band between Region masks (m). */
export const REGION_BLEND_WIDTH = 40;

export const CRATER_BOWL = { floorY: 4, rimY: 22, floorRadius: 55, rimRadius: 110 } as const;

/** Ring mountains: +height·smoothstep(start, full, r) with ±20 m of ridged noise. */
export const RING_MOUNTAINS = { start: PLAY_RADIUS, full: 540, height: 180 } as const;

/** materialAt thresholds (design priority rule). */
export const MATERIAL_RULES = {
  /** |height − water level| within this → sand. */
  sandBand: 0.6,
  /** Horizontal reach of a shore beyond a water body's edge (m). */
  shoreReach: 6,
  /** Steeper than this → rock (ashRock in Ember). */
  rockSlopeDeg: 38,
  /** Azure above this height → snow. */
  snowLineY: 150,
} as const;

/** Water this deep or deeper is swimming depth, not walkable (Req 16.10). */
export const SWIM_DEPTH = 1.2;

/** Depth below the surface at the centre of each water body (m); the river is ≈ 2 m deep. */
const WATER_DEPTH: Readonly<Record<string, number>> = { lake_azure: 8, pond_verdant: 3 };
const RIVER_DEPTH = 2;
/** River gorge walls: rise per metre beyond the banks, and how far out they are cut (m). */
const RIVER_GORGE_SLOPE = 3;
const RIVER_GORGE_REACH = 64;

// ── Region masks ────────────────────────────────────────────────────────────

interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function rectOf(bounds: RegionBounds): Rect {
  if (bounds.kind !== 'polygon') throw new Error('terrain: expected a rectangular Region');
  const xs = bounds.points.map((p) => p.x);
  const zs = bounds.points.map((p) => p.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

const RECT_VERDANT = rectOf(REGIONS.verdant.bounds);
const RECT_EMBER = rectOf(REGIONS.ember.bounds);
const RECT_AZURE = rectOf(REGIONS.azure.bounds);
const CRATER_RADIUS = REGIONS.crater.bounds.kind === 'circle' ? REGIONS.crater.bounds.radius : CRATER_BOWL.rimRadius;

/** Signed distance to a rectangle: negative inside (distance to the nearest edge), positive outside. */
function sdRect(r: Rect, x: number, z: number): number {
  const dx = Math.max(r.minX - x, x - r.maxX);
  const dz = Math.max(r.minZ - z, z - r.maxZ);
  if (dx <= 0 && dz <= 0) return Math.max(dx, dz);
  const ox = dx > 0 ? dx : 0;
  const oz = dz > 0 ? dz : 0;
  return Math.sqrt(ox * ox + oz * oz);
}

/**
 * Region weights at (x, z) written into `out` as [verdant, ember, azure, crater], summing to 1.
 * The crater takes 1 − smoothstep(r 90, 130); the rest is shared by the three outer Regions,
 * each weighted 1 − smoothstep(0, 40, its distance − the nearest one's), so the border strips
 * between the Region rectangles blend their neighbours instead of having no Region.
 */
function regionWeightsInto(x: number, z: number, out: Float64Array): void {
  const half = REGION_BLEND_WIDTH / 2;
  const r = Math.sqrt(x * x + z * z);
  const wc = 1 - smoothstep(CRATER_RADIUS - half, CRATER_RADIUS + half, r);
  const sv = sdRect(RECT_VERDANT, x, z);
  const se = sdRect(RECT_EMBER, x, z);
  const sa = sdRect(RECT_AZURE, x, z);
  const m = Math.min(sv, se, sa);
  const wv = 1 - smoothstep(0, REGION_BLEND_WIDTH, sv - m);
  const we = 1 - smoothstep(0, REGION_BLEND_WIDTH, se - m);
  const wa = 1 - smoothstep(0, REGION_BLEND_WIDTH, sa - m);
  const k = (1 - wc) / (wv + we + wa);
  out[0] = wv * k;
  out[1] = we * k;
  out[2] = wa * k;
  out[3] = wc;
}

const REGION_ORDER: readonly TerrainRegion[] = ['verdant', 'ember', 'azure', 'crater'];

/** Region weights at (x, z); they sum to 1. */
export function regionWeightsAt(x: number, z: number): Record<TerrainRegion, number> {
  const w = new Float64Array(4);
  regionWeightsInto(x, z, w);
  return { verdant: w[0], ember: w[1], azure: w[2], crater: w[3] };
}

function dominantOf(w: Float64Array): TerrainRegion {
  let best = 0;
  for (let i = 1; i < 4; i++) if (w[i] > w[best]) best = i;
  return REGION_ORDER[best];
}

/** Region with the largest mask weight at (x, z) (materials and region defaults). */
export function dominantRegionAt(x: number, z: number): TerrainRegion {
  const w = new Float64Array(4);
  regionWeightsInto(x, z, w);
  return dominantOf(w);
}

// ── Shape functions ─────────────────────────────────────────────────────────

interface TerrainNoises {
  readonly verdant: Noise2D;
  readonly ember: Noise2D;
  readonly emberFloor: Noise2D;
  readonly azure: Noise2D;
  readonly azureMask: Noise2D;
  readonly azurePeaks: Noise2D;
  readonly ring: Noise2D;
  readonly detail: Noise2D;
}

function createTerrainNoises(seed: number): TerrainNoises {
  const n = (name: string): Noise2D => createNoise2D(deriveSeed(seed, `terrain:${name}`));
  return {
    verdant: n('verdant'),
    ember: n('ember'),
    emberFloor: n('emberFloor'),
    azure: n('azure'),
    azureMask: n('azureMask'),
    azurePeaks: n('azurePeaks'),
    ring: n('ring'),
    detail: n('detail'),
  };
}

/** Scratch slot for polyline queries (buildTerrain is synchronous, so one slot suffices). */
const HIT: NearestHit = { dist: 0, y: 0 };

const TERRACES = BREEZEWATCH_TERRACES;
const SHELF = WATERFALL_SHELF;

/** Verdant: fBm hills (4 octaves, ≈ 10 m, ≈ 140 m wavelength), a raised west, terraces, waterfall shelf. */
function verdantHeight(x: number, z: number, ns: TerrainNoises): number {
  let h = 18 + 10 * fbm(ns.verdant, x / 140, z / 140, 4);
  h += 14 * smoothstep(-300, -420, x);

  // Breezewatch terraces: foot y 22, cliffs to 34 and 46 along TERRACES.dir.
  const tx = x - TERRACES.origin.x;
  const tz = z - TERRACES.origin.z;
  const along = tx * TERRACES.dir.x + tz * TERRACES.dir.z;
  if (along > -30 && along < TERRACES.fadeEnd) {
    const lat = Math.abs(tx * TERRACES.dir.z - tz * TERRACES.dir.x);
    if (lat < TERRACES.halfWidth + TERRACES.edge) {
      const [s1, s2] = TERRACES.steps;
      let y = lerp(TERRACES.footY, s1[2], smoothstep(s1[0], s1[1], along));
      y = lerp(y, s2[2], smoothstep(s2[0], s2[1], along));
      const m =
        (1 - smoothstep(TERRACES.halfWidth, TERRACES.halfWidth + TERRACES.edge, lat)) *
        smoothstep(-30, -5, along) *
        (1 - smoothstep(TERRACES.topEnd, TERRACES.fadeEnd, along));
      h = lerp(h, y, m);
    }
  }

  // Waterfall shelf at y 60 behind the cliff above pond_verdant (raises only).
  const px = x - SHELF.pond.x;
  const pz = z - SHELF.pond.z;
  const up = px * SHELF.dir.x + pz * SHELF.dir.z;
  if (up > SHELF.cliffStart && h < SHELF.topY) {
    const lat = Math.abs(px * SHELF.dir.z - pz * SHELF.dir.x);
    if (lat < SHELF.halfWidth + SHELF.edge) {
      const m =
        smoothstep(SHELF.cliffStart, SHELF.cliffEnd, up) *
        (1 - smoothstep(SHELF.halfWidth, SHELF.halfWidth + SHELF.edge, lat));
      h = lerp(h, SHELF.topY, m);
    }
  }
  return h;
}

const CANYONS = EMBER_CANYONS.map((c) => ({ ...c, line: compilePolyline(c.points) }));
const CHASM_LINE = compilePolyline(BROKEN_BRIDGE_CHASM.points);
/** Chasm wall rise per metre: from the floor at floorHalfWidth to y 12 at halfWidth. */
const CHASM_WALL_SLOPE =
  (12 - BROKEN_BRIDGE_CHASM.floorY) / (BROKEN_BRIDGE_CHASM.halfWidth - BROKEN_BRIDGE_CHASM.floorHalfWidth);

/**
 * Ember: a flat-topped mesa base (two levels) cut by the canyons. At distance d from a canyon
 * centreline the height is mesa − depth·(1 − smoothstep(floorHalfWidth, halfWidth, d)), the
 * design's formula with a flat floor band; the Broken Bridge chasm is cut deeper still.
 */
function emberHeight(x: number, z: number, ns: TerrainNoises): number {
  let mesa = lerp(EMBER_MESA.lowY, EMBER_MESA.highY, smoothstep(-0.25, 0.25, ns.ember(x / 170, z / 170)));
  const v = EMBER_MESA.vista;
  const dVista = Math.hypot(x - v.x, z - v.z);
  if (dVista < v.radius + v.edge) mesa = lerp(mesa, v.y, 1 - smoothstep(v.radius, v.radius + v.edge, dVista));
  let h = mesa;
  for (const c of CANYONS) {
    if (!nearBounds(c.line, x, z, c.halfWidth)) continue;
    const d = nearestOnPolyline(c.line, x, z, HIT);
    if (d >= c.halfWidth) continue;
    const floor = HIT.y + 1.5 * ns.emberFloor(x / 40, z / 40);
    const surface = lerp(floor, mesa, smoothstep(c.floorHalfWidth, c.halfWidth, d));
    if (surface < h) h = surface;
  }
  if (nearBounds(CHASM_LINE, x, z, BROKEN_BRIDGE_CHASM.halfWidth + 12)) {
    const d = nearestOnPolyline(CHASM_LINE, x, z, HIT);
    const surface = BROKEN_BRIDGE_CHASM.floorY + Math.max(0, d - BROKEN_BRIDGE_CHASM.floorHalfWidth) * CHASM_WALL_SLOPE;
    if (surface < h) h = surface;
  }
  return h;
}

const LAKE = WATER_BODIES.find((b) => b.id === 'lake_azure' && b.kind === 'circle') as Extract<
  WaterBody,
  { kind: 'circle' }
>;
const PEAK = AZURE_VISTA_PEAK;
const RAMP = AZURE_RAMP;
const RAMP_SLOPE = (RAMP.endY - RAMP.startY) / (RAMP.endN - RAMP.startN);

/** Azure base height by distance north of the origin (n = −z), see AZURE_RAMP. */
function azureRampHeight(n: number): number {
  if (n < RAMP.startN) return Math.max(14, RAMP.startY + (n - RAMP.startN) * 0.2);
  if (n < RAMP.endN) return RAMP.startY + (n - RAMP.startN) * RAMP_SLOPE;
  return RAMP.endY + Math.max(0, n - RAMP.riseFromN) * RAMP.rise;
}

/**
 * Azure: a plateau rising north from gate_azure (y 26) past ws_azure (y 80), quantised into 12 m
 * steps north of camp_oriel, a valley around lake_azure, ridged-noise peaks, the vista_azure peak
 * and the flat cliff-top blocks (observatory y 130, Sky Ring start y 120).
 */
function azureHeight(x: number, z: number, ns: TerrainNoises): number {
  const n = -z; // distance north of the origin
  let h = azureRampHeight(n);
  const high = smoothstep(200, 260, n);
  if (high > 0) h += 6 * high * fbm(ns.azure, x / 200, z / 200, 2);
  const qw = smoothstep(215, 250, n);
  if (qw > 0) {
    const u = h / 12;
    const k = Math.floor(u);
    h = lerp(h, 12 * (k + smoothstep(0.7, 1, u - k)), qw);
  }

  const lx = x - LAKE.x;
  const lz = z - LAKE.z;
  const dLake = Math.sqrt(lx * lx + lz * lz);
  const valley = LAKE.level + 0.9 + Math.max(0, dLake - LAKE.r - 3) * 0.32;
  if (valley < h) h = valley;

  const pw = smoothstep(250, 320, n) * smoothstep(70, 120, dLake);
  if (pw > 0) {
    const mask = smoothstep(0.05, 0.4, ns.azureMask(x / 350, z / 350));
    if (mask > 0) h += 55 * pw * mask * ridged(ns.azurePeaks, x / 130, z / 130, 3);
  }

  const cx = x - PEAK.x;
  const cz = z - PEAK.z;
  const dPeak = Math.sqrt(cx * cx + cz * cz);
  if (dPeak < 75) {
    const cone = PEAK.topY - PEAK.slope * dPeak;
    if (cone > h) h += (cone - h) * (1 - smoothstep(45, 75, dPeak));
  }

  for (const p of AZURE_PLATEAUS) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d < p.radius + p.edge) h = lerp(h, p.y, 1 - smoothstep(p.radius, p.radius + p.edge, d));
  }
  return h;
}

/** Crater bowl: floor y 4 out to r 55, rising to the rim y 22 at r 110. */
function craterHeight(r: number): number {
  return CRATER_BOWL.floorY + (CRATER_BOWL.rimY - CRATER_BOWL.floorY) * smoothstep(CRATER_BOWL.floorRadius, CRATER_BOWL.rimRadius, r);
}

// ── Local carving ───────────────────────────────────────────────────────────

/** Carve walls are only evaluated up to this height: no ground near a Challenge_Area rises above it. */
const CARVE_TOP_Y = 60;

/** A Challenge_Area cut compiled for the per-sample loop, with the box beyond which its walls clear CARVE_TOP_Y. */
interface CompiledCarve {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Carved surface height at (x, z) (the ground is min(ground, surface)). */
  surface(x: number, z: number): number;
}

const carveHit: NearestHit = { dist: 0, y: 0 };

function compileCarve(piece: (typeof CHALLENGE_AREA_CARVE)[number]): CompiledCarve {
  if (piece.kind === 'basin') {
    const { center, floorY, radius, wallSlope } = piece;
    const reach = radius + (CARVE_TOP_Y - floorY) / wallSlope;
    return {
      minX: center.x - reach, maxX: center.x + reach, minZ: center.z - reach, maxZ: center.z + reach,
      surface: (x, z) => floorY + Math.max(0, Math.hypot(x - center.x, z - center.z) - radius) * wallSlope,
    };
  }
  const { points, halfWidth, wallSlope } = piece;
  // One compiled line per segment, so a point near two segments (a corner, a joint) takes the lower cut.
  const segments = points.slice(1).map((b, i) => compilePolyline([points[i], b]));
  const lowest = Math.min(...points.map((p) => p.y));
  const reach = halfWidth + (CARVE_TOP_Y - lowest) / wallSlope;
  return {
    minX: Math.min(...points.map((p) => p.x)) - reach,
    maxX: Math.max(...points.map((p) => p.x)) + reach,
    minZ: Math.min(...points.map((p) => p.z)) - reach,
    maxZ: Math.max(...points.map((p) => p.z)) + reach,
    surface: (x, z) => {
      let best = Infinity;
      for (const line of segments) {
        if (!nearBounds(line, x, z, reach)) continue;
        const d = nearestOnPolyline(line, x, z, carveHit);
        const s = carveHit.y + Math.max(0, d - halfWidth) * wallSlope;
        if (s < best) best = s;
      }
      return best;
    },
  };
}

const CARVES: readonly CompiledCarve[] = CHALLENGE_AREA_CARVE.map(compileCarve);
const CARVE_BOX = {
  minX: Math.min(...CARVES.map((c) => c.minX)),
  maxX: Math.max(...CARVES.map((c) => c.maxX)),
  minZ: Math.min(...CARVES.map((c) => c.minZ)),
  maxZ: Math.max(...CARVES.map((c) => c.maxZ)),
};

/** The Challenge_Area cuts: the lowest carved surface at (x, z) when it is below `h`. */
function carveChallengeAreas(x: number, z: number, h: number): number {
  if (x < CARVE_BOX.minX || x > CARVE_BOX.maxX || z < CARVE_BOX.minZ || z > CARVE_BOX.maxZ) return h;
  for (const c of CARVES) {
    if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
    const s = c.surface(x, z);
    if (s < h) h = s;
  }
  return h;
}

/** Banks are raised to level + 0.9 near the water, fading out over this many metres. */
const BANK_FADE = 21;
const BANK_RISE = 0.9;

/** Banks within 3 m of a body's edge are raised to its level + 0.9, fading out over 21 m more. */
function raiseBank(h: number, d: number, edge: number, level: number): number {
  const bank = level + BANK_RISE;
  return h < bank ? lerp(bank, h, smoothstep(edge + 3, edge + 3 + BANK_FADE, d)) : h;
}

/**
 * Bed at distance d from a body's centre (circle) or centreline (river): level − depth at the
 * centre, the level at the edge and level + 0.9 3 m outside it; unchanged further out.
 */
function cutBed(h: number, d: number, edge: number, level: number, depth: number): number {
  if (d > edge + 3) return h;
  const f = d / edge;
  const bed = d <= edge ? level - depth * (1 - f * f) : level + (d - edge) * (BANK_RISE / 3);
  return bed < h ? bed : h;
}

const CIRCLE_WATERS = WATER_BODIES.filter((b): b is Extract<WaterBody, { kind: 'circle' }> => b.kind === 'circle');
const RIVERS = WATER_BODIES.filter((b): b is Extract<WaterBody, { kind: 'river' }> => b.kind === 'river').map((b) => ({
  halfWidth: b.halfWidth,
  line: compilePolyline(b.points.map((p) => ({ x: p.x, z: p.z, y: p.level }))),
}));
const WATER_COUNT = CIRCLE_WATERS.length + RIVERS.length;
/** Per-sample scratch: distance to and level of each water body (NaN when out of reach). */
const WATER_D = new Float64Array(WATER_COUNT);
const WATER_L = new Float64Array(WATER_COUNT);

/**
 * Lake, pond and river basins. Every bank is raised before any bed is cut, so where bodies meet
 * (the river starts inside pond_verdant) one body's bank never refills another's bed.
 */
function carveWater(x: number, z: number, h: number): number {
  let any = false;
  for (let i = 0; i < CIRCLE_WATERS.length; i++) {
    const b = CIRCLE_WATERS[i];
    const d = Math.hypot(x - b.x, z - b.z);
    const inReach = d < b.r + 3 + BANK_FADE;
    WATER_D[i] = inReach ? d : NaN;
    WATER_L[i] = b.level;
    if (inReach) {
      any = true;
      h = raiseBank(h, d, b.r, b.level);
    }
  }
  for (let j = 0; j < RIVERS.length; j++) {
    const river = RIVERS[j];
    const i = CIRCLE_WATERS.length + j;
    const reach = river.halfWidth + 3 + RIVER_GORGE_REACH;
    const d = nearBounds(river.line, x, z, reach) ? nearestOnPolyline(river.line, x, z, HIT) : Infinity;
    WATER_D[i] = d < reach ? d : NaN;
    WATER_L[i] = HIT.y;
    if (d < reach) {
      any = true;
      h = raiseBank(h, d, river.halfWidth, HIT.y);
    }
  }
  if (!any) return h;
  for (let i = 0; i < CIRCLE_WATERS.length; i++) {
    const b = CIRCLE_WATERS[i];
    if (!Number.isNaN(WATER_D[i])) h = cutBed(h, WATER_D[i], b.r, b.level, WATER_DEPTH[b.id] ?? RIVER_DEPTH);
  }
  for (let j = 0; j < RIVERS.length; j++) {
    const i = CIRCLE_WATERS.length + j;
    const d = WATER_D[i];
    if (Number.isNaN(d)) continue;
    const edge = RIVERS[j].halfWidth;
    h = cutBed(h, d, edge, WATER_L[i], RIVER_DEPTH);
    // Gorge walls (≈ 72°) wherever the channel runs through high ground.
    const wall = WATER_L[i] + BANK_RISE + Math.max(0, d - edge - 3) * RIVER_GORGE_SLOPE;
    if (wall < h) h = wall;
  }
  return h;
}

// ── Pads ────────────────────────────────────────────────────────────────────

const PAD_COUNT = TERRAIN_PADS.length;
const PAD_X = Float64Array.from(TERRAIN_PADS, (p) => p.x);
const PAD_Z = Float64Array.from(TERRAIN_PADS, (p) => p.z);
const PAD_Y = Float64Array.from(TERRAIN_PADS, (p) => p.y);
const PAD_R = Float64Array.from(TERRAIN_PADS, (p) => p.radius);
const PAD_REACH = Float64Array.from(TERRAIN_PADS, (p) => p.radius + p.blend);

/**
 * Pads: exactly the contract height within a pad's radius, blended back over its `blend` band.
 * Overlapping bands mix their targets by weight (pads with different heights never reach each
 * other's flat radius, see features.ts).
 */
function applyPads(x: number, z: number, h: number): number {
  let wSum = 0;
  let whSum = 0;
  let wMax = 0;
  for (let i = 0; i < PAD_COUNT; i++) {
    const reach = PAD_REACH[i];
    const dx = x - PAD_X[i];
    if (dx > reach || dx < -reach) continue;
    const dz = z - PAD_Z[i];
    if (dz > reach || dz < -reach) continue;
    const d2 = dx * dx + dz * dz;
    if (d2 >= reach * reach) continue;
    const d = Math.sqrt(d2);
    const w = d <= PAD_R[i] ? 1 : 1 - smoothstep(PAD_R[i], reach, d);
    wSum += w;
    whSum += w * PAD_Y[i];
    if (w > wMax) wMax = w;
  }
  if (wMax <= 0) return h;
  const target = whSum / wSum;
  return wMax >= 1 ? target : h + (target - h) * wMax;
}

// ── Synthesis ───────────────────────────────────────────────────────────────

const MIN_WEIGHT = 1e-6;

function synthesizeHeight(x: number, z: number, ns: TerrainNoises, w: Float64Array): number {
  regionWeightsInto(x, z, w);
  const r = Math.sqrt(x * x + z * z);
  let h = 0;
  let used = 0;
  if (w[0] > MIN_WEIGHT) {
    h += w[0] * verdantHeight(x, z, ns);
    used += w[0];
  }
  if (w[1] > MIN_WEIGHT) {
    h += w[1] * emberHeight(x, z, ns);
    used += w[1];
  }
  if (w[2] > MIN_WEIGHT) {
    h += w[2] * azureHeight(x, z, ns);
    used += w[2];
  }
  if (w[3] > MIN_WEIGHT) {
    h += w[3] * craterHeight(r);
    used += w[3];
  }
  h /= used;
  h += 0.5 * ns.detail(x / 7.3, z / 7.3);
  if (r > RING_MOUNTAINS.start) {
    const t = smoothstep(RING_MOUNTAINS.start, RING_MOUNTAINS.full, r);
    h += t * (RING_MOUNTAINS.height + 40 * (ridged(ns.ring, x / 110, z / 110, 3) - 0.5));
  }
  // After the ring: river_verdant leaves the pond through the ring mountains in a gorge.
  h = carveWater(x, z, h);
  return carveChallengeAreas(x, z, applyPads(x, z, h));
}

/**
 * Builds the terrain for `seed` (coerced to uint32): the same seed always yields the same heights.
 * Samples the synthesis once per grid point (≈ 315k samples; budget < 300 ms, Req 1.10).
 */
export function buildTerrain(seed: number): TerrainField {
  const ns = createTerrainNoises(seed >>> 0);
  const heights = new Float32Array(N * N);
  const w = new Float64Array(4);
  for (let iz = 0; iz < N; iz++) {
    const z = -HALF + iz * STEP;
    const row = iz * N;
    for (let ix = 0; ix < N; ix++) heights[row + ix] = synthesizeHeight(-HALF + ix * STEP, z, ns, w);
  }
  return terrainFieldFromHeights(seed, heights);
}

// ── Queries ─────────────────────────────────────────────────────────────────

const PATHS = PATH_POLYLINES.map((points) => compilePolyline(points));

/** Horizontal distance from (x, z) to the nearest dirt path polyline (m). */
export function distanceToPath(x: number, z: number): number {
  const hit: NearestHit = { dist: 0, y: 0 };
  let best = Infinity;
  for (const line of PATHS) {
    if (!nearBounds(line, x, z, Math.min(best, 50))) continue;
    const d = nearestOnPolyline(line, x, z, hit);
    if (d < best) best = d;
  }
  return best;
}

/** Whether a height `h` at (x, z) lies within ±0.6 m of a nearby water surface (shoreline sand). */
function onShore(x: number, z: number, h: number): boolean {
  const band = MATERIAL_RULES.sandBand;
  const reach = MATERIAL_RULES.shoreReach;
  for (const b of CIRCLE_WATERS) {
    if (Math.hypot(x - b.x, z - b.z) <= b.r + reach && Math.abs(h - b.level) <= band) return true;
  }
  const hit: NearestHit = { dist: 0, y: 0 };
  for (const river of RIVERS) {
    if (!nearBounds(river.line, x, z, river.halfWidth + reach)) continue;
    if (nearestOnPolyline(river.line, x, z, hit) <= river.halfWidth + reach && Math.abs(h - hit.y) <= band) return true;
  }
  return false;
}

function inCrystalZone(x: number, z: number): boolean {
  const c = CINDERSPIRE_CRYSTAL_ZONE;
  return Math.hypot(x - c.x, z - c.z) <= c.r;
}

/**
 * TerrainField over an existing 561 × 561 height array (buildTerrain's output, or a cached copy).
 * Materials and water still come from the static layout.
 */
export function terrainFieldFromHeights(seed: number, heights: Float32Array): TerrainField {
  if (heights.length !== N * N) throw new RangeError(`terrain: expected ${N * N} heights, got ${heights.length}`);
  const last = N - 2;

  const heightAt = (x: number, z: number): number => {
    const gx = (clamp(x, -HALF, HALF) + HALF) / STEP;
    const gz = (clamp(z, -HALF, HALF) + HALF) / STEP;
    const ix = Math.min(Math.floor(gx), last);
    const iz = Math.min(Math.floor(gz), last);
    const tx = gx - ix;
    const tz = gz - iz;
    const i = iz * N + ix;
    const h00 = heights[i];
    const h10 = heights[i + 1];
    const h01 = heights[i + N];
    const h11 = heights[i + N + 1];
    const near = h00 + (h10 - h00) * tx;
    const far = h01 + (h11 - h01) * tx;
    return near + (far - near) * tz;
  };

  /** Unit normal's y component and horizontal parts from ±2 m central differences. */
  const normalAt = (x: number, z: number): Vec3 => {
    const gx = (heightAt(x + STEP, z) - heightAt(x - STEP, z)) / (2 * STEP);
    const gz = (heightAt(x, z + STEP) - heightAt(x, z - STEP)) / (2 * STEP);
    const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    return { x: -gx * inv, y: inv, z: -gz * inv };
  };

  const slopeDeg = (x: number, z: number): number => Math.acos(clamp(normalAt(x, z).y, -1, 1)) * RAD2DEG;

  const waterDepthAt = (x: number, z: number): number => {
    const level = waterLevelAt(x, z);
    return level === null ? 0 : Math.max(0, level - heightAt(x, z));
  };

  const insideBoundary = (x: number, z: number): boolean => x * x + z * z <= PLAY_RADIUS * PLAY_RADIUS;

  const materialAt = (x: number, z: number): TerrainMaterial => {
    const h = heightAt(x, z);
    if (onShore(x, z, h)) return 'sand';
    const region = dominantRegionAt(x, z);
    if (slopeDeg(x, z) > MATERIAL_RULES.rockSlopeDeg) return region === 'ember' ? 'ashRock' : 'rock';
    if (region === 'azure' && h > MATERIAL_RULES.snowLineY) return 'snow';
    if (distanceToPath(x, z) <= PATH_HALF_WIDTH) return 'dirt';
    switch (region) {
      case 'verdant':
      case 'azure':
        return 'grass';
      case 'ember':
        return inCrystalZone(x, z) ? 'crystal' : 'ashRock';
      case 'crater':
        return 'stone';
    }
  };

  return {
    seed: seed >>> 0,
    heights,
    heightAt,
    normalAt,
    slopeDeg,
    materialAt,
    waterDepthAt,
    insideBoundary,
    walkable: (x, z) =>
      slopeDeg(x, z) <= MAX_WALKABLE_SLOPE_DEG && waterDepthAt(x, z) < SWIM_DEPTH && insideBoundary(x, z),
  };
}
