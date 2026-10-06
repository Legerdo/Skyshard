import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_AREA_IDS,
  WAYSTONE_IDS,
  isBarrierId,
  isLandmarkId,
  isWaystoneId,
  type RegionId,
} from '../../src/data/ids';
import {
  BREEZEWATCH_GLIDE,
  CHALLENGE_ENTRANCES,
  CHALLENGE_ROUTES,
  COMPASS,
  GLIDE_RATIO,
  LAYOUT_TRAVEL,
  LOCATIONS,
  LOCATION_IDS,
  MAIN_PATH,
  MAX_ROUTE_LENGTH,
  PLAY_RADIUS,
  REGIONS,
  isLocationId,
  polylineLength,
  regionAt,
  type LocationId,
  type RegionBounds,
  type XZ,
} from '../../src/data/worldLayout';

/**
 * Skyshards held before a Region may be entered: the crater is open from the start (A8), ember and
 * azure open with gate_ember / veil_ember (≥ 1) and gate_azure / veil_azure (≥ 2), the Sanctum last.
 */
const REGION_OPENS_AT: Readonly<Record<RegionId, number>> = {
  verdant: 0,
  crater: 0,
  ember: 1,
  azure: 2,
  sanctum: 3,
};

const pointsOf = (ids: readonly LocationId[]): XZ[] => ids.map((id) => LOCATIONS[id]);

/** Points at most `step` metres apart along the polyline, both ends included. */
function samplePolyline(points: readonly XZ[], step = 2): XZ[] {
  const samples = points.slice(0, 1);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 1; k <= n; k++) {
      samples.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
  }
  return samples;
}

/** Regions met along the polyline (ground query) that are still closed while holding `skyshards`. */
function closedRegionsAlong(points: readonly XZ[], skyshards: number): RegionId[] {
  const closed = new Set<RegionId>();
  for (const p of samplePolyline(points)) {
    const region = regionAt(p);
    if (region !== null && REGION_OPENS_AT[region] > skyshards) closed.add(region);
  }
  return [...closed];
}

/** Compass bearing of a point seen from the origin, in degrees clockwise from north. */
function bearingDeg(p: XZ): number {
  const east = p.x * COMPASS.east.x + p.z * COMPASS.east.z;
  const north = p.x * COMPASS.north.x + p.z * COMPASS.north.z;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

function centerOf(bounds: RegionBounds): XZ {
  if (bounds.kind === 'circle') return bounds.center;
  const sum = bounds.points.reduce((acc, p) => ({ x: acc.x + p.x, z: acc.z + p.z }), { x: 0, z: 0 });
  return { x: sum.x / bounds.points.length, z: sum.z / bounds.points.length };
}

describe('coordinate convention and Region bounds', () => {
  it('puts the Regions where the design table does, with +x east and −z north', () => {
    const bearing = (id: RegionId): number => bearingDeg(centerOf(REGIONS[id].bounds));
    // verdant: south-west
    expect(bearing('verdant')).toBeGreaterThan(180);
    expect(bearing('verdant')).toBeLessThan(270);
    // ember: east to south-east
    expect(bearing('ember')).toBeGreaterThanOrEqual(90);
    expect(bearing('ember')).toBeLessThanOrEqual(135);
    // azure: north
    const azure = bearing('azure');
    expect(Math.min(azure, 360 - azure)).toBeLessThan(45);
    // The origin is the crater centre, and the Sanctum floats above it.
    expect(centerOf(REGIONS.crater.bounds)).toEqual({ x: 0, z: 0 });
    expect(centerOf(REGIONS.sanctum.bounds)).toEqual({ x: 0, z: 0 });
  });
});

describe('key location table', () => {
  it('places every Waystone and both Blight_Barrier gates, and registry-prefixed ids are registry ids', () => {
    expect(WAYSTONE_IDS.filter((id) => !isLocationId(id))).toEqual([]);
    expect(['gate_ember', 'gate_azure'].filter((id) => !isLocationId(id))).toEqual([]);
    const unresolved = LOCATION_IDS.filter(
      (id) =>
        (id.startsWith('ws_') && !isWaystoneId(id)) ||
        (id.startsWith('lm_') && !isLandmarkId(id)) ||
        (/^(?:gate|veil|seal)_/.test(id) && !isBarrierId(id)),
    );
    expect(unresolved).toEqual([]);
  });

  it('puts every location in its Region (gates on the boundary) and inside the playable radius', () => {
    const misplaced = LOCATION_IDS.filter((id) => {
      const loc = LOCATIONS[id];
      const found = regionAt({ x: loc.x, z: loc.z, y: loc.groundY });
      return loc.border === undefined ? found !== loc.region : ![null, loc.region, loc.border].includes(found);
    });
    expect(misplaced).toEqual([]);
    expect(LOCATION_IDS.filter((id) => Math.hypot(LOCATIONS[id].x, LOCATIONS[id].z) > PLAY_RADIUS)).toEqual([]);
  });
});

describe('ground routes from Thistlewick to the Challenge_Area entrances (Req 8.8)', () => {
  it('measures polylines horizontally', () => {
    expect(
      polylineLength([
        { x: 0, z: 0 },
        { x: 3, z: 4 },
        { x: 3, z: -2 },
      ]),
    ).toBe(11);
    expect(polylineLength([{ x: 5, z: 5 }])).toBe(0);
    expect(polylineLength([LOCATIONS.breezewatch, LOCATIONS.vista_verdant])).toBe(0);
  });

  it.each(CHALLENGE_AREA_IDS)('%s: only open Regions, recomputed length ≤ 1,080 m (3 min at 6 m/s)', (area) => {
    const route = CHALLENGE_ROUTES[area];
    expect(route[0]).toBe('thistlewick');
    expect(route.at(-1)).toBe(CHALLENGE_ENTRANCES[area]);
    // Challenge_Areas are cleared in registry order, so the i-th is first reached holding i Skyshards.
    expect(closedRegionsAlong(pointsOf(route), CHALLENGE_AREA_IDS.indexOf(area))).toEqual([]);

    const length = polylineLength(pointsOf(route));
    expect(MAX_ROUTE_LENGTH).toBe(1080);
    expect(length).toBeLessThanOrEqual(MAX_ROUTE_LENGTH);
    expect(length / LAYOUT_TRAVEL.runSpeed).toBeLessThanOrEqual(LAYOUT_TRAVEL.maxRunSeconds);
  });
});

describe('Breezewatch glide: windmill top (y 64) → Elderbough (y 14) (Req 2.3, 19.2)', () => {
  const from = LOCATIONS[BREEZEWATCH_GLIDE.from];
  const to = LOCATIONS[BREEZEWATCH_GLIDE.to];
  const horizontal = polylineLength([from, to]);

  it('needs no more drop than is available at glide ratio 3.6', () => {
    expect([from.groundY, to.groundY]).toEqual([64, 14]);
    expect(GLIDE_RATIO).toBeCloseTo(3.6, 12);
    expect(horizontal / GLIDE_RATIO).toBeLessThanOrEqual(from.groundY - to.groundY);
  });

  it('lasts no longer than base Stamina allows (100 ÷ 6/s)', () => {
    const staminaSeconds = LAYOUT_TRAVEL.baseStamina / LAYOUT_TRAVEL.glideStaminaPerSecond;
    expect(horizontal / LAYOUT_TRAVEL.glideSpeed).toBeLessThanOrEqual(staminaSeconds);
  });
});

describe('main path', () => {
  const waypoints = [MAIN_PATH[0].from, ...MAIN_PATH.map((leg) => leg.to)];
  const entrances: readonly LocationId[] = Object.values(CHALLENGE_ENTRANCES);

  it('chains Thistlewick to the Caelith arena, reaching the Challenge_Areas in story order', () => {
    expect(MAIN_PATH.slice(1).filter((leg, i) => leg.from !== MAIN_PATH[i].to)).toEqual([]);
    expect(waypoints[0]).toBe('thistlewick');
    expect(waypoints.at(-1)).toBe('sanctum_arena');
    const steps = CHALLENGE_AREA_IDS.map((area) => waypoints.indexOf(CHALLENGE_ENTRANCES[area]));
    expect(steps.every((step, i) => step > (i === 0 ? 0 : steps[i - 1]))).toBe(true);
    expect(MAIN_PATH).toContainEqual({ ...BREEZEWATCH_GLIDE, mode: 'glide' });
  });

  it('enters a Region only once the Skyshards held open it', () => {
    let skyshards = 0;
    const early: string[] = [];
    for (const leg of MAIN_PATH) {
      for (const region of closedRegionsAlong(pointsOf([leg.from, leg.to]), skyshards)) {
        early.push(`${leg.from} → ${leg.to}: ${region} with ${skyshards} Skyshards`);
      }
      if (entrances.includes(leg.to)) skyshards++;
    }
    expect(early).toEqual([]);
    expect(skyshards).toBe(3);
  });
});
