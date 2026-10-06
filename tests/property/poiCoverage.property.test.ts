// Feature: skyshard-echoes-of-the-wild, Property 29: POI 60 m 커버리지
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/types';
import { POI_COVERAGE_RADIUS, POIS, type PoiDef } from '../../src/data/pois';
import { PLAY_RADIUS, regionAt } from '../../src/data/worldLayout';
import { buildTerrain, type TerrainField } from '../../src/world/terrain';

// Property 29 (design "60 m 커버리지 검증"; Req 10.1): from any walkable point of the play area (slope ≤ 50°, water
// shallower than 1.2 m, inside the 470 m boundary), the nearest POI is within 60 m in 3D. Checked on the full 10 m
// grid and on random continuous points of the world seed's terrain. Uncovered samples are reported as clusters
// (grid 4-neighbours) with their centre, sample count and Region, the places the POI data fills with lore / cache /
// herb POIs.

const SEED = 20240601; // main.ts DEV_WORLD_SEED
const R = POI_COVERAGE_RADIUS;
const GRID = 10;
/** Grid samples beyond this also get reported as warnings (a point between samples is ≤ 5√2 m from one). */
const WARN = R - 5 * Math.SQRT2;

/** POIs in a spatial hash of R-sized (x, z) cells: a POI within R lies in the 3 × 3 cells around the point. */
class PoiHash {
  private readonly cells = new Map<string, PoiDef[]>();

  constructor(pois: readonly PoiDef[]) {
    for (const p of pois) {
      const key = this.key(Math.floor(p.pos.x / R), Math.floor(p.pos.z / R));
      const list = this.cells.get(key) ?? [];
      list.push(p);
      this.cells.set(key, list);
    }
  }

  /** Distance to the nearest POI of the 3 × 3 cells (3D; exact whenever it is ≤ R), or Infinity. */
  nearest(p: Readonly<Vec3>): number {
    const cx = Math.floor(p.x / R);
    const cz = Math.floor(p.z / R);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const q of this.cells.get(this.key(cx + dx, cz + dz)) ?? []) {
          best = Math.min(best, Math.hypot(q.pos.x - p.x, q.pos.y - p.y, q.pos.z - p.z));
        }
      }
    }
    return best;
  }

  private key(x: number, z: number): string {
    return `${x},${z}`;
  }
}

interface Sample {
  readonly ix: number;
  readonly iz: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly d: number;
}

/** Grid 4-neighbour clusters of `samples`: centre, count and Region of each, largest first. */
function clusters(samples: readonly Sample[]): string[] {
  const byCell = new Map(samples.map((s) => [`${s.ix},${s.iz}`, s]));
  const seen = new Set<string>();
  const out: { text: string; n: number }[] = [];
  for (const s of samples) {
    const k0 = `${s.ix},${s.iz}`;
    if (seen.has(k0)) continue;
    seen.add(k0);
    const group: Sample[] = [];
    const stack = [s];
    while (stack.length > 0) {
      const c = stack.pop() as Sample;
      group.push(c);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const k = `${c.ix + dx},${c.iz + dz}`;
        const n = byCell.get(k);
        if (n !== undefined && !seen.has(k)) {
          seen.add(k);
          stack.push(n);
        }
      }
    }
    const x = group.reduce((a, g) => a + g.x, 0) / group.length;
    const y = group.reduce((a, g) => a + g.y, 0) / group.length;
    const z = group.reduce((a, g) => a + g.z, 0) / group.length;
    const far = Math.max(...group.map((g) => g.d));
    out.push({
      text: `(${x.toFixed(0)}, ${y.toFixed(1)}, ${z.toFixed(0)}) ${regionAt({ x, z }) ?? 'none'}: ${group.length} samples, farthest ${far.toFixed(1)} m`,
      n: group.length,
    });
  }
  return out.sort((a, b) => b.n - a.n).map((c) => c.text);
}

let terrain: TerrainField;
let hash: PoiHash;
beforeAll(() => {
  terrain = buildTerrain(SEED);
  hash = new PoiHash(POIS);
});

describe('Property 29: POI 60 m coverage', () => {
  it('every walkable point of the 10 m grid has a POI within 60 m (3D)', () => {
    const failed: Sample[] = [];
    const warned: Sample[] = [];
    let walkable = 0;
    const n = Math.floor(PLAY_RADIUS / GRID);
    for (let ix = -n; ix <= n; ix++) {
      for (let iz = -n; iz <= n; iz++) {
        const x = ix * GRID;
        const z = iz * GRID;
        if (!terrain.walkable(x, z)) continue;
        walkable++;
        const y = terrain.heightAt(x, z);
        const d = hash.nearest({ x, y, z });
        if (d > R) failed.push({ ix, iz, x, y, z, d });
        else if (d > WARN) warned.push({ ix, iz, x, y, z, d });
      }
    }
    // The scan covers the play area (most of the ≈ 8,700 grid points inside 470 m are walkable).
    expect(walkable).toBeGreaterThan(5000);
    if (warned.length > 0) console.warn(`POI coverage: ${warned.length} samples beyond ${WARN.toFixed(1)} m\n${clusters(warned).join('\n')}`);
    expect(clusters(failed), 'uncovered clusters (centre, Region)').toEqual([]);
  });

  it('any walkable continuous point has a POI within 60 m (3D)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -PLAY_RADIUS, max: PLAY_RADIUS, noNaN: true }),
        fc.double({ min: -PLAY_RADIUS, max: PLAY_RADIUS, noNaN: true }),
        (x, z) => {
          fc.pre(terrain.walkable(x, z));
          const y = terrain.heightAt(x, z);
          const d = hash.nearest({ x, y, z });
          if (d > R) throw new Error(`(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) ${regionAt({ x, z }) ?? 'none'}: nearest POI ${d.toFixed(1)} m`);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the spatial hash finds the same nearest distance as a full scan (within 60 m)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -470, max: 470 }), fc.integer({ min: -470, max: 470 }), (x, z) => {
        const p = { x, y: terrain.heightAt(x, z), z };
        const full = Math.min(...POIS.map((q) => Math.hypot(q.pos.x - p.x, q.pos.y - p.y, q.pos.z - p.z)));
        const hashed = hash.nearest(p);
        if (full <= R) expect(hashed).toBeCloseTo(full, 9);
        else expect(hashed).toBeGreaterThan(R);
      }),
      { numRuns: 100 },
    );
  });
});
