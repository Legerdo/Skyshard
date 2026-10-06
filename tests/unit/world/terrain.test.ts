import { beforeAll, describe, expect, it } from 'vitest';
import { RAD2DEG } from '../../../src/core/math';
import { createRng } from '../../../src/core/rng';
import { LOCATIONS, PLAY_RADIUS, type LocationId } from '../../../src/data/worldLayout';
import type { Heightfield, TerrainMaterial } from '../../../src/physics/types';
import {
  BREEZEWATCH_TERRACES,
  CINDERSPIRE_CRYSTAL_ZONE,
  CRATER_BOWL,
  ELDERBOUGH_SINKHOLE,
  LOCATION_TERRAIN_ROLES,
  PATH_HALF_WIDTH,
  PATH_POLYLINES,
  TERRAIN_PADS,
  WATER_BODIES,
  buildTerrain,
  distanceToPath,
  distanceToRiver,
  dominantRegionAt,
  regionWeightsAt,
  terrainFieldFromHeights,
  waterLevelAt,
  type TerrainField,
  type TerrainRegion,
} from '../../../src/world/terrain';
import {
  FORBIDDEN_PACKAGES,
  collectSourceFiles,
  findForbiddenGlobals,
  findImports,
  findMathRandom,
  lexSource,
  projectRoot,
  readSourceFile,
  resolveImport,
} from '../helpers/importScan';

const N = 561;
const SEED = 20240601;
let field: TerrainField;

beforeAll(() => {
  field = buildTerrain(SEED);
});

// Compile-time contract: a TerrainField is a physics Heightfield and reports physics materials.
const asHeightfield = (f: TerrainField): Heightfield => f;
const asMaterial = (f: TerrainField): TerrainMaterial => f.materialAt(0, 0);

const index = (x: number, z: number): number => ((z + 560) / 2) * N + (x + 560) / 2;

function farFromWater(x: number, z: number): boolean {
  return WATER_BODIES.every((b) =>
    b.kind === 'circle' ? Math.hypot(x - b.x, z - b.z) > b.r + 10 : distanceToRiver(x, z, b).dist > b.halfWidth + 10,
  );
}

/** First point of a 7 m scan over the play area satisfying `pred` (deterministic for one seed). */
function scan(pred: (x: number, z: number) => boolean): { x: number; z: number } {
  for (let z = -462; z <= 462; z += 7) {
    for (let x = -462; x <= 462; x += 7) if (field.insideBoundary(x, z) && pred(x, z)) return { x, z };
  }
  throw new Error('scan: no matching point');
}

const flatAwayFromPaths = (region: TerrainRegion) => (x: number, z: number) =>
  dominantRegionAt(x, z) === region &&
  field.slopeDeg(x, z) <= 30 &&
  distanceToPath(x, z) > PATH_HALF_WIDTH + 2 &&
  farFromWater(x, z);

describe('buildTerrain', () => {
  it('replays identical heights for the same seed and different ones for another seed', () => {
    const again = buildTerrain(SEED);
    const other = buildTerrain(SEED + 1);
    expect(field.heights).toBeInstanceOf(Float32Array);
    expect(field.heights.length).toBe(N * N);
    expect(field.seed).toBe(SEED);
    let same = 0;
    let differ = 0;
    for (let i = 0; i < field.heights.length; i++) {
      if (field.heights[i] === again.heights[i]) same++;
      if (field.heights[i] !== other.heights[i]) differ++;
    }
    expect(same).toBe(N * N);
    expect(differ).toBeGreaterThan(N * N * 0.5);
    expect(field.heights.every(Number.isFinite)).toBe(true);
  });

  it('builds 561 × 561 samples in under 300 ms (Req 1.10)', () => {
    const times = [1, 2, 3].map((i) => {
      const t0 = performance.now();
      buildTerrain(SEED + 10 * i);
      return performance.now() - t0;
    });
    expect(Math.min(...times)).toBeLessThan(300);
  });

  it('blends Region masks over 40 m and normalises them to sum 1', () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i++) {
      const w = regionWeightsAt(rng.range(-560, 560), rng.range(-560, 560));
      const values = Object.values(w);
      expect(values.every((v) => v >= 0 && v <= 1)).toBe(true);
      expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    }
    expect(regionWeightsAt(0, 0).crater).toBe(1);
    expect(regionWeightsAt(-250, 300).verdant).toBe(1);
    expect(regionWeightsAt(300, 200).ember).toBe(1);
    expect(regionWeightsAt(0, -300).azure).toBe(1);
    // Ashgate Pass lies midway between the verdant (x ≤ 40) and ember (x ≥ 80) rectangles.
    const pass = regionWeightsAt(60, 300);
    expect(pass.verdant).toBeCloseTo(0.5, 9);
    expect(pass.ember).toBeCloseTo(0.5, 9);
    expect(regionWeightsAt(20, 300).ember).toBe(0);
  });
});

describe('pads and carved features', () => {
  const NON_TERRAIN: readonly LocationId[] = [
    'vista_verdant',
    'cinderspire_summit',
    'lake_azure',
    'lm_floating_isles',
    'sanctum_gate',
    'sanctum_hall',
    'ws_sanctum',
    'sanctum_arena',
  ];

  it('flattens every ground location to exactly its contract groundY', () => {
    const padIds = TERRAIN_PADS.map((p) => p.id);
    expect(padIds).toEqual(Object.keys(LOCATIONS).filter((id) => !NON_TERRAIN.includes(id as LocationId)));
    for (const pad of TERRAIN_PADS) {
      expect(pad.y).toBe(LOCATIONS[pad.id].groundY);
      expect({ id: pad.id, y: field.heightAt(pad.x, pad.z) }).toEqual({ id: pad.id, y: pad.y });
      // Every grid sample inside the flat radius holds the contract height (no detail noise).
      for (let gz = Math.ceil((pad.z - pad.radius) / 2) * 2; gz <= pad.z + pad.radius; gz += 2) {
        for (let gx = Math.ceil((pad.x - pad.radius) / 2) * 2; gx <= pad.x + pad.radius; gx += 2) {
          if (Math.hypot(gx - pad.x, gz - pad.z) <= pad.radius) expect(field.heights[index(gx, gz)]).toBe(pad.y);
        }
      }
    }
    expect(NON_TERRAIN.map((id) => LOCATION_TERRAIN_ROLES[id].kind)).toEqual([
      'structure',
      'structure',
      'water',
      'floating',
      'floating',
      'floating',
      'floating',
      'floating',
    ]);
  });

  it('keeps pads of different heights out of each other’s flat radius', () => {
    for (const a of TERRAIN_PADS) {
      for (const b of TERRAIN_PADS) {
        if (a === b || a.y === b.y) continue;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(a.radius + b.radius + b.blend);
      }
    }
  });

  it('carves the crater bowl, the Elderbough sinkhole and the water basins', () => {
    expect(Math.abs(field.heightAt(-30, -20) - CRATER_BOWL.floorY)).toBeLessThanOrEqual(0.5);
    const { center, floorY, floorRadius } = ELDERBOUGH_SINKHOLE;
    expect(field.heightAt(center.x, center.z)).toBe(floorY);
    expect(field.heightAt(center.x + floorRadius - 2, center.z)).toBe(floorY);
    // The entrance pad beside the sinkhole keeps its contract y 14.
    expect(field.heightAt(LOCATIONS.hollowroot_entrance.x, LOCATIONS.hollowroot_entrance.z)).toBe(14);
    expect(field.heightAt(-200, -300)).toBeCloseTo(62, 4); // lake_azure: surface 70, 8 m deep
    expect(field.waterDepthAt(-380, 230)).toBeCloseTo(3, 4); // pond_verdant: 3 m deep
    // river_verdant: ≈ 2 m deep on its centreline, dry 10 m off it, also where it crosses the ring.
    const river = WATER_BODIES.find((b) => b.kind === 'river');
    if (river?.kind !== 'river') throw new Error('river missing');
    const [a, b, c] = river.points;
    for (const [p, q] of [
      [a, b],
      [b, c],
    ] as const) {
      const x = p.x + (q.x - p.x) * 0.75;
      const z = p.z + (q.z - p.z) * 0.75;
      // Bilinear reads mix in grid samples up to 1.4 m off the centreline, a little shallower.
      expect(field.waterDepthAt(x, z)).toBeGreaterThan(1.6);
      expect(field.waterDepthAt(x, z)).toBeLessThanOrEqual(2.001);
      expect(field.waterDepthAt(x + 10, z)).toBe(0);
    }
  });

  it('raises ring mountains beyond the play radius', () => {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const at = (r: number): number => field.heightAt(Math.sin(a) * r, Math.cos(a) * r);
      expect(at(540) - at(460)).toBeGreaterThan(100);
    }
  });
});

describe('height queries', () => {
  it('heightAt returns grid samples at grid points and interpolates bilinearly between them', () => {
    const rng = createRng(11);
    for (let i = 0; i < 300; i++) {
      const ix = rng.int(0, N - 2);
      const iz = rng.int(0, N - 2);
      const x = -560 + ix * 2;
      const z = -560 + iz * 2;
      const h = field.heights;
      const [h00, h10, h01, h11] = [h[iz * N + ix], h[iz * N + ix + 1], h[(iz + 1) * N + ix], h[(iz + 1) * N + ix + 1]];
      expect(field.heightAt(x, z)).toBe(h00);
      expect(field.heightAt(x + 1, z)).toBeCloseTo((h00 + h10) / 2, 4);
      expect(field.heightAt(x + 1, z + 1)).toBeCloseTo((h00 + h10 + h01 + h11) / 4, 4);
      const tx = rng.next();
      const tz = rng.next();
      const expected = (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
      expect(field.heightAt(x + 2 * tx, z + 2 * tz)).toBeCloseTo(expected, 3);
    }
  });

  it('heightAt clamps positions outside the grid onto its edge', () => {
    expect(field.heightAt(-1000, 0)).toBe(field.heightAt(-560, 0));
    expect(field.heightAt(10, 900)).toBe(field.heightAt(10, 560));
    expect(field.heightAt(600, 700)).toBe(field.heights[N * N - 1]);
    expect(field.heightAt(-600, -700)).toBe(field.heights[0]);
  });

  it('normalAt and slopeDeg follow the ±2 m central difference', () => {
    const rng = createRng(12);
    for (let i = 0; i < 300; i++) {
      const x = rng.range(-500, 500);
      const z = rng.range(-500, 500);
      const n = field.normalAt(x, z);
      const gx = (field.heightAt(x + 2, z) - field.heightAt(x - 2, z)) / 4;
      const gz = (field.heightAt(x, z + 2) - field.heightAt(x, z - 2)) / 4;
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12);
      expect(n.y).toBeGreaterThan(0);
      expect(-n.x / n.y).toBeCloseTo(gx, 9);
      expect(-n.z / n.y).toBeCloseTo(gz, 9);
      expect(field.slopeDeg(x, z)).toBeCloseTo(Math.acos(n.y) * RAD2DEG, 9);
      expect(field.slopeDeg(x, z)).toBeCloseTo(Math.atan(Math.hypot(gx, gz)) * RAD2DEG, 6);
    }
  });

  it('reports the exact normal and slope of a synthetic plane', () => {
    const heights = new Float32Array(N * N);
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) heights[iz * N + ix] = 0.5 * (ix * 2 - 560);
    const plane = terrainFieldFromHeights(1, heights);
    expect(plane.heightAt(3, -7)).toBeCloseTo(1.5, 5);
    const n = plane.normalAt(3, -7);
    const len = Math.hypot(0.5, 1);
    expect(n.x).toBeCloseTo(-0.5 / len, 9);
    expect(n.y).toBeCloseTo(1 / len, 9);
    expect(n.z).toBeCloseTo(0, 9);
    expect(plane.slopeDeg(3, -7)).toBeCloseTo(Math.atan(0.5) * RAD2DEG, 6);
    expect(() => terrainFieldFromHeights(1, new Float32Array(10))).toThrow(RangeError);
  });
});

describe('materialAt priority', () => {
  it('sand within ±0.6 m of a water surface', () => {
    const lake = WATER_BODIES.find((b) => b.id === 'lake_azure');
    if (lake?.kind !== 'circle') throw new Error('lake missing');
    let found = 0;
    for (let a = 0; a < 16; a++) {
      for (let d = lake.r - 12; d <= lake.r + 6; d += 0.25) {
        const x = lake.x + Math.cos((a / 16) * Math.PI * 2) * d;
        const z = lake.z + Math.sin((a / 16) * Math.PI * 2) * d;
        if (Math.abs(field.heightAt(x, z) - lake.level) > 0.6) continue;
        expect(field.materialAt(x, z)).toBe('sand');
        found++;
        break;
      }
    }
    expect(found).toBeGreaterThan(8);
  });

  it('rock on slopes over 38° (ashRock in Ember), even on a path', () => {
    const t = BREEZEWATCH_TERRACES;
    let cliff: { x: number; z: number } | null = null;
    for (let s = 10; s <= 16 && cliff === null; s += 0.25) {
      const x = t.origin.x + t.dir.x * s;
      const z = t.origin.z + t.dir.z * s;
      if (field.slopeDeg(x, z) > 38) cliff = { x, z };
    }
    if (cliff === null) throw new Error('no terrace cliff found');
    expect(distanceToPath(cliff.x, cliff.z)).toBeLessThanOrEqual(PATH_HALF_WIDTH); // path up the terraces
    expect(dominantRegionAt(cliff.x, cliff.z)).toBe('verdant');
    expect(field.materialAt(cliff.x, cliff.z)).toBe('rock');

    const ember = scan((x, z) => dominantRegionAt(x, z) === 'ember' && field.slopeDeg(x, z) > 38 && farFromWater(x, z));
    expect(field.materialAt(ember.x, ember.z)).toBe('ashRock');
  });

  it('snow in Azure above y 150 on slopes up to 38°', () => {
    const p = scan(
      (x, z) =>
        dominantRegionAt(x, z) === 'azure' && field.heightAt(x, z) > 150 && field.slopeDeg(x, z) <= 38 && farFromWater(x, z),
    );
    expect(field.materialAt(p.x, p.z)).toBe('snow');
  });

  it('dirt near path polylines, over the region default', () => {
    let checked = 0;
    for (const [a, b] of PATH_POLYLINES) {
      for (let t = 0.3; t <= 0.7; t += 0.1) {
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        if (field.slopeDeg(x, z) > 38 || !farFromWater(x, z) || field.heightAt(x, z) > 150) continue;
        expect(field.materialAt(x, z)).toBe('dirt');
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('falls back to the region default: grass, ashRock, crystal, stone', () => {
    const verdant = scan(flatAwayFromPaths('verdant'));
    expect(field.materialAt(verdant.x, verdant.z)).toBe('grass');
    const azure = scan((x, z) => flatAwayFromPaths('azure')(x, z) && field.heightAt(x, z) < 150);
    expect(field.materialAt(azure.x, azure.z)).toBe('grass');
    const crater = scan(flatAwayFromPaths('crater'));
    expect(field.materialAt(crater.x, crater.z)).toBe('stone');
    const c = CINDERSPIRE_CRYSTAL_ZONE;
    const inZone = (x: number, z: number): boolean => Math.hypot(x - c.x, z - c.z) <= c.r;
    const ash = scan((x, z) => flatAwayFromPaths('ember')(x, z) && !inZone(x, z));
    expect(field.materialAt(ash.x, ash.z)).toBe('ashRock');
    const crystal = scan((x, z) => flatAwayFromPaths('ember')(x, z) && inZone(x, z));
    expect(field.materialAt(crystal.x, crystal.z)).toBe('crystal');
    expect(asMaterial(field)).toBe(field.materialAt(0, 0));
  });
});

describe('water, boundary and walkability', () => {
  it('waterDepthAt is the surface level minus the ground, and 0 outside water', () => {
    const rng = createRng(13);
    let wet = 0;
    for (let i = 0; i < 2000; i++) {
      const x = rng.range(-470, 470);
      const z = rng.range(-470, 470);
      const level = waterLevelAt(x, z);
      const depth = field.waterDepthAt(x, z);
      if (level === null) expect(depth).toBe(0);
      else {
        expect(depth).toBeCloseTo(Math.max(0, level - field.heightAt(x, z)), 9);
        wet++;
      }
    }
    expect(wet).toBeGreaterThan(0);
    expect(field.waterDepthAt(0, 0)).toBe(0);
    expect(field.waterDepthAt(-200, -300)).toBeCloseTo(8, 4);
  });

  it('insideBoundary holds up to 470 m from the origin', () => {
    expect(PLAY_RADIUS).toBe(470);
    expect([field.insideBoundary(470, 0), field.insideBoundary(0, -470), field.insideBoundary(332.3, 332.3)]).toEqual([
      true,
      true,
      true,
    ]);
    expect([field.insideBoundary(470.01, 0), field.insideBoundary(-333, -333), field.insideBoundary(0, 600)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('walkable = slope ≤ 50° ∧ water depth < 1.2 m ∧ inside the boundary', () => {
    const rng = createRng(14);
    for (let i = 0; i < 1000; i++) {
      const x = rng.range(-520, 520);
      const z = rng.range(-520, 520);
      const expected = field.slopeDeg(x, z) <= 50 && field.waterDepthAt(x, z) < 1.2 && field.insideBoundary(x, z);
      expect(field.walkable(x, z)).toBe(expected);
    }
    expect(field.walkable(LOCATIONS.thistlewick.x, LOCATIONS.thistlewick.z)).toBe(true);
    expect(field.walkable(-200, -300)).toBe(false); // 8 m deep lake
    const { center, floorRadius } = ELDERBOUGH_SINKHOLE;
    expect(field.slopeDeg(center.x - floorRadius - 3, center.z)).toBeGreaterThan(50);
    expect(field.walkable(center.x - floorRadius - 3, center.z)).toBe(false); // sinkhole wall
    expect(field.walkable(0, 500)).toBe(false); // beyond the boundary
    const hf = asHeightfield(field);
    expect(hf.walkable(0, 0)).toBe(true);
    expect(hf.heightAt(0, 0)).toBe(4);
  });
});

describe('purity', () => {
  it('src/world/terrain imports no three.js, DOM or Math.random, and only pure modules', () => {
    const root = projectRoot();
    const files = collectSourceFiles(root, ['src/world/terrain']);
    expect(files.length).toBeGreaterThanOrEqual(4);
    const allowed = ['src/core/rng', 'src/core/math', 'src/core/types', 'src/data/', 'src/physics/types', 'src/world/terrain/'];
    const problems: string[] = [];
    for (const file of files) {
      const lexed = lexSource(readSourceFile(root, file));
      for (const { specifier } of findImports(lexed)) {
        if (FORBIDDEN_PACKAGES.some((re) => re.test(specifier))) problems.push(`${file}: imports ${specifier}`);
        const target = resolveImport(file, specifier);
        if (target === null) continue;
        const key = target.replace(/\.ts$/, '');
        if (!allowed.some((a) => (a.endsWith('/') ? key.startsWith(a) : key === a))) problems.push(`${file}: imports ${key}`);
      }
      for (const { name } of findForbiddenGlobals(lexed)) problems.push(`${file}: references ${name}`);
      if (findMathRandom(lexed).length > 0) problems.push(`${file}: uses Math.random`);
    }
    expect(problems).toEqual([]);
  });
});
