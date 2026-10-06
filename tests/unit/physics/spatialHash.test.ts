import { describe, expect, it } from 'vitest';
import {
  MAX_CELL_INDEX,
  MAX_ITEM_CELLS,
  MIN_CELL_INDEX,
  SpatialHash,
  cellIndex,
  cellKey,
  type XZBounds,
} from '../../../src/physics/spatialHash';
import { SPATIAL_CELL_SIZE } from '../../../src/physics/types';

const bx = (minX: number, minZ: number, maxX: number, maxZ: number): XZBounds => ({ minX, minZ, maxX, maxZ });
/** Square of half-size h around (x, z). */
const around = (x: number, z: number, h = 1): XZBounds => bx(x - h, z - h, x + h, z + h);
const overlaps = (a: XZBounds, b: XZBounds): boolean => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;

/** Hash whose items are their own ids. */
function hashOf(items: readonly [number, XZBounds][]): SpatialHash<number> {
  const h = new SpatialHash<number>();
  for (const [id, b] of items) expect(h.insert(id, id, b), `insert ${id}`).toBe(true);
  return h;
}

/** Ids visited by a ray whose visitor reports `bestOf(id)` as the running best distance. */
function rayVisits(h: SpatialHash<number>, ox: number, oz: number, dx: number, dz: number, maxDist: number, bestOf: (id: number) => number = () => Infinity): number[] {
  const seen: number[] = [];
  let best = Infinity;
  h.queryRay(ox, oz, dx, dz, maxDist, (item, id) => {
    expect(item).toBe(id);
    seen.push(id);
    best = Math.min(best, bestOf(id));
    return best;
  });
  return seen;
}

describe('cells and keys', () => {
  it('uses floor(v / 16) with boundaries in the upper cell, including negatives', () => {
    expect(SPATIAL_CELL_SIZE).toBe(16);
    const cases: [number, number][] = [[0, 0], [15.999, 0], [16, 1], [31.999, 1], [32, 2], [-0.001, -1], [-16, -1], [-16.001, -2], [-32, -2]];
    for (const [value, index] of cases) expect(cellIndex(value), String(value)).toBe(index);
  });

  it('packs (ix + 32768) · 65536 + (iz + 32768) without collisions in range', () => {
    expect(cellKey(0, 0)).toBe(32768 * 65536 + 32768);
    expect(cellKey(MIN_CELL_INDEX, MIN_CELL_INDEX)).toBe(0);
    expect(cellKey(MAX_CELL_INDEX, MAX_CELL_INDEX)).toBe(65536 * 65536 - 1);
    const keys = new Set<number>();
    for (const ix of [MIN_CELL_INDEX, -1, 0, 1, MAX_CELL_INDEX]) for (const iz of [MIN_CELL_INDEX, -1, 0, 1, MAX_CELL_INDEX]) keys.add(cellKey(ix, iz));
    expect(keys.size).toBe(25);
  });

  it('registers inclusive bounds: touching a multiple of 16 reaches the next cell', () => {
    const h = hashOf([
      [1, bx(0, 0, 16, 0)],
      [2, bx(-16, -16, -0.5, -0.5)],
      [3, bx(-16.5, 3, 15.9, 3)],
      [4, bx(16, 16, 16, 16)],
    ]);
    expect(h.cellRangeOf(1)).toEqual({ ix0: 0, iz0: 0, ix1: 1, iz1: 0 });
    expect(h.cellRangeOf(2)).toEqual({ ix0: -1, iz0: -1, ix1: -1, iz1: -1 });
    expect(h.cellRangeOf(3)).toEqual({ ix0: -2, iz0: 0, ix1: 0, iz1: 0 });
    expect(h.cellRangeOf(4)).toEqual({ ix0: 1, iz0: 1, ix1: 1, iz1: 1 });
    expect(h.cellRangeOf(99)).toBeNull();
  });
});

describe('queryAabb', () => {
  it('uses inclusive overlap at cell boundaries and negative coordinates', () => {
    const h = hashOf([
      [1, bx(0, 0, 16, 16)],
      [2, bx(-20, -20, -16, -16)],
    ]);
    expect(h.queryAabb(bx(16, 16, 20, 20))).toEqual([1]);
    expect(h.queryAabb(bx(16.01, 16, 20, 20))).toEqual([]);
    expect(h.queryAabb(bx(-16, -16, -15, -15))).toEqual([2]);
    expect(h.queryAabb(bx(-15.99, -16, -15, -15))).toEqual([]);
    expect(h.queryAabb(bx(-18, -18, -17, -17))).toEqual([2]);
  });

  it('returns an item spanning many cells once, and orders results by id', () => {
    const h = hashOf([
      [5, bx(0, 0, 100, 100)],
      [1, around(8, 8)],
      [3, around(9, 9)],
    ]);
    expect(h.cellRangeOf(5)).toEqual({ ix0: 0, iz0: 0, ix1: 6, iz1: 6 });
    expect(h.queryAabb(bx(-10, -10, 110, 110))).toEqual([1, 3, 5]);
    expect(h.queryAabb(bx(50, 50, 60, 60))).toEqual([5]);
    const out = [42];
    expect(h.queryAabb(around(8, 8, 0.5), out)).toBe(out);
    expect(out).toEqual([42, 1, 3, 5]);
  });

  it('matches a brute-force filter on both the cell walk and the linear-scan path', () => {
    let seed = 12345;
    const rand = (lo: number, hi: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return lo + ((hi - lo) * seed) / 4294967296;
    };
    const items: [number, XZBounds][] = [];
    for (let id = 0; id < 150; id++) {
      const [x, z] = [rand(-200, 200), rand(-200, 200)];
      items.push([(id * 37) % 150, bx(x, z, x + rand(0, 40), z + rand(0, 40))]);
    }
    const h = hashOf(items);
    const queries = [bx(-10, -10, 10, 10), bx(-30, 5, 2, 40), bx(-200, -200, 200, 200), bx(-500, -500, 500, 500), bx(33, -64, 48, -48)];
    for (const q of queries) {
      const expected = items.filter(([, b]) => overlaps(b, q)).map(([id]) => id).sort((a, b) => a - b);
      expect(h.queryAabb(q), JSON.stringify(q)).toEqual(expected);
    }
  });

  it('ignores invalid query bounds', () => {
    const h = hashOf([[1, around(0, 0)]]);
    expect(h.queryAabb(bx(Number.NaN, 0, 1, 1))).toEqual([]);
    expect(h.queryAabb(bx(2, 0, 1, 1))).toEqual([]);
  });
});

describe('oversize entries', () => {
  it(`keeps items covering more than ${MAX_ITEM_CELLS} cells or leaving the key range in the oversize list`, () => {
    const h = hashOf([
      [1, bx(0, 0, 255.9, 255.9)], // 16 × 16 = 256 cells: still hashed
      [2, bx(0, 0, 256, 255.9)], // 17 × 16 cells
      [3, around(1e6, 0)], // cell 62500 > MAX_CELL_INDEX
      [4, around(-600000, 5)],
    ]);
    expect([1, 2, 3, 4].map((id) => h.isOversize(id))).toEqual([false, true, true, true]);
    expect(h.cellRangeOf(2)).toBeNull();
    expect(h.queryAabb(around(250, 100, 0.5))).toEqual([1, 2]);
    expect(h.queryAabb(around(256, 200, 0.05))).toEqual([2]);
    expect(h.queryAabb(around(1e6, 0.5, 0.1))).toEqual([3]);
    expect(h.queryAabb(around(-600000, 5, 0.1))).toEqual([4]);
    expect(h.queryAabb(around(500, 500, 0.1))).toEqual([]);
  });
});

describe('insert / update / remove', () => {
  it('rejects duplicate or non-finite ids and invalid bounds', () => {
    const h = hashOf([[1, around(0, 0)]]);
    expect(h.insert(1, 1, around(50, 50))).toBe(false);
    expect(h.insert(Number.NaN, 2, around(0, 0))).toBe(false);
    expect(h.insert(2, 2, bx(0, 0, Number.POSITIVE_INFINITY, 1))).toBe(false);
    expect(h.insert(2, 2, bx(3, 0, 1, 1))).toBe(false);
    expect([h.size, h.has(1), h.has(2), h.get(1)]).toEqual([1, true, false, 1]);
    expect(h.queryAabb(around(50, 50))).toEqual([]);
  });

  it('moves entries between cells, into and out of the oversize list, and removes them', () => {
    const h = new SpatialHash<string>();
    expect(h.insert(7, 'crate', around(8, 8))).toBe(true);
    expect(h.update(7, around(-40, 70))).toBe(true);
    expect(h.queryAabb(around(8, 8))).toEqual([]);
    expect(h.queryAabb(around(-40, 70))).toEqual(['crate']);
    expect(h.cellRangeOf(7)).toEqual({ ix0: -3, iz0: 4, ix1: -3, iz1: 4 });
    // Same cells: bounds change without re-hashing; the item can be replaced.
    expect(h.update(7, around(-41, 70), 'barrel')).toBe(true);
    expect(h.queryAabb(bx(-42, 69, -42, 69))).toEqual(['barrel']);
    expect(h.queryAabb(bx(-39.5, 69, -39.5, 69))).toEqual([]);
    expect(h.update(7, bx(0, 0, 400, 400))).toBe(true);
    expect([h.isOversize(7), ...h.queryAabb(around(300, 300))]).toEqual([true, 'barrel']);
    expect(h.update(7, around(8, 8))).toBe(true);
    expect([h.isOversize(7), ...h.queryAabb(around(8, 8))]).toEqual([false, 'barrel']);
    expect(h.queryAabb(around(300, 300))).toEqual([]);
    expect([h.update(8, around(0, 0)), h.update(7, bx(Number.NaN, 0, 0, 0))]).toEqual([false, false]);
    expect(h.queryAabb(around(8, 8))).toEqual(['barrel']);
    expect([h.remove(7), h.remove(7), h.size]).toEqual([true, false, 0]);
    expect(h.queryAabb(around(8, 8))).toEqual([]);
  });
});

describe('queryRay', () => {
  // Along z = 8: id 3 in cell 0, id 2 in cell 1, id 1 in cell 2, id 4 spans cells 0–2.
  const row = (): SpatialHash<number> =>
    hashOf([
      [3, around(8, 8)],
      [2, around(24, 8)],
      [1, around(40, 8)],
      [4, bx(2, 12, 45, 14)],
    ]);

  it('visits cells in DDA order, each entry once, in id order within a cell', () => {
    expect(rayVisits(row(), 1, 8, 1, 0, 100)).toEqual([3, 4, 2, 1]);
    expect(rayVisits(row(), 47, 8, -1, 0, 100)).toEqual([1, 4, 2, 3]);
  });

  it('stops once the best hit is no farther than the current cell exit, or at maxDist', () => {
    // Ray from x = 1: cell 0 exits at t = 15, cell 1 at t = 31.
    expect(rayVisits(row(), 1, 8, 1, 0, 100, (id) => (id === 3 ? 5 : Infinity))).toEqual([3, 4]);
    expect(rayVisits(row(), 1, 8, 1, 0, 100, (id) => (id === 3 ? 20 : Infinity))).toEqual([3, 4, 2]);
    expect(rayVisits(row(), 1, 8, 1, 0, 100, (id) => (id === 3 ? 15 : Infinity))).toEqual([3, 4]);
    expect(rayVisits(row(), 1, 8, 1, 0, 20)).toEqual([3, 4, 2]);
    expect(rayVisits(row(), 1, 8, 1, 0, 0)).toEqual([3, 4]);
  });

  it('measures t in units of the given direction', () => {
    // Direction (0.5, 0): cell 0 exits at t = 30, so a hit at 20 stops after cell 0.
    expect(rayVisits(row(), 1, 8, 0.5, 0, 100, (id) => (id === 3 ? 20 : Infinity))).toEqual([3, 4]);
  });

  it('handles vertical rays, negative coordinates and diagonal corners', () => {
    const h = hashOf([
      [1, around(-8, -8)],
      [2, around(-24, -8)],
      [3, around(8, 8)],
      [4, bx(16, 16, 20, 16)], // zero-thickness strip at z = 16: only cell (1, 1)
      [5, around(24, 8)], // cell (1, 0)
    ]);
    expect(rayVisits(h, -8, -8, 0, 0, 50)).toEqual([1]);
    expect(rayVisits(h, -1, -8, -1, 0, 100)).toEqual([1, 2]);
    // (+,−) through the corner (16, 16): the corner belongs to cell (1, 1), entered before (1, 0).
    expect(rayVisits(h, 8, 24, 1, -1, 12)).toEqual([4, 5]);
    // (−,+) through the corner (16, 16): enters (1, 1) first, then (0, 1).
    expect(rayVisits(h, 24, 8, -1, 1, 12)).toEqual([5, 4]);
  });

  it('visits oversize entries first and ignores invalid rays', () => {
    const h = hashOf([
      [2, around(8, 8)],
      [9, bx(-1000, -1000, 1000, 1000)],
    ]);
    expect(h.isOversize(9)).toBe(true);
    expect(rayVisits(h, 1, 8, 1, 0, 100)).toEqual([9, 2]);
    expect(rayVisits(h, 1, 8, 1, 0, 100, (id) => (id === 9 ? 0 : Infinity))).toEqual([9]);
    expect(rayVisits(h, Number.NaN, 8, 1, 0, 100)).toEqual([]);
    expect(rayVisits(h, 1, 8, 1, 0, -1)).toEqual([]);
  });

  it('stops walking once it leaves the occupied cells', () => {
    const h = hashOf([[1, around(8, 8)]]);
    let calls = 0;
    h.queryRay(40, 8, 1, 0, 1e9, () => {
      calls++;
      return Infinity;
    });
    expect(calls).toBe(0);
    expect(rayVisits(h, -1e5, 8, 1, 0, 2e5)).toEqual([1]);
  });
});
