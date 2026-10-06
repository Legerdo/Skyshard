// Uniform XZ spatial hash for collider broad-phase. Pure TypeScript (no three.js / DOM).
//
// Cells are SPATIAL_CELL_SIZE (16 m) squares indexed by floor(v / cellSize). Bounds are
// inclusive, so an item whose maxX is exactly 16 also occupies cell 1, and a point on a cell
// boundary belongs to the upper cell. Cell (ix, iz) is stored under the packed key
// (ix + 32768) · 65536 + (iz + 32768); items spanning more than MAX_ITEM_CELLS cells, or
// reaching outside the key range, live in a separate oversize list that every query scans.
// Every result is ordered by id, independent of insertion order. Queries are not re-entrant
// (they share a visit stamp), so a ray visitor must not query the same hash.

import { SPATIAL_CELL_SIZE } from './types';

/** Inclusive XZ bounds. */
export interface XZBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Inclusive cell index range. */
export interface CellRange {
  ix0: number;
  iz0: number;
  ix1: number;
  iz1: number;
}

/** Items covering more cells than this go to the oversize list. */
export const MAX_ITEM_CELLS = 256;
/** Cell indices representable in a packed key. */
export const MIN_CELL_INDEX = -32768;
export const MAX_CELL_INDEX = 32767;

const KEY_OFFSET = 32768;
const KEY_STRIDE = 65536;

/** Cell index of coordinate v: floor(v / cellSize). */
export function cellIndex(v: number, cellSize: number = SPATIAL_CELL_SIZE): number {
  return Math.floor(v / cellSize);
}

/** Packed key of cell (ix, iz); only meaningful for indices in [MIN_CELL_INDEX, MAX_CELL_INDEX]. */
export function cellKey(ix: number, iz: number): number {
  return (ix + KEY_OFFSET) * KEY_STRIDE + (iz + KEY_OFFSET);
}

function inKeyRange(i: number): boolean {
  return i >= MIN_CELL_INDEX && i <= MAX_CELL_INDEX;
}

function validBounds(b: Readonly<XZBounds>): boolean {
  return (
    b !== null &&
    typeof b === 'object' &&
    Number.isFinite(b.minX) &&
    Number.isFinite(b.minZ) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.maxZ) &&
    b.minX <= b.maxX &&
    b.minZ <= b.maxZ
  );
}

interface Entry<T> {
  readonly id: number;
  item: T;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  ix0: number;
  iz0: number;
  ix1: number;
  iz1: number;
  oversize: boolean;
  /** Last query stamp that visited this entry (dedupe across cells). */
  stamp: number;
}

const byId = <T>(a: Entry<T>, b: Entry<T>): number => a.id - b.id;

/** Index of the first entry in the id-sorted list whose id is ≥ id. */
function lowerBound<T>(list: readonly Entry<T>[], id: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].id < id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted<T>(list: Entry<T>[], e: Entry<T>): void {
  list.splice(lowerBound(list, e.id), 0, e);
}

function removeSorted<T>(list: Entry<T>[], e: Entry<T>): void {
  const i = lowerBound(list, e.id);
  if (list[i] === e) list.splice(i, 1);
}

function overlaps<T>(e: Entry<T>, b: Readonly<XZBounds>): boolean {
  return e.minX <= b.maxX && e.maxX >= b.minX && e.minZ <= b.maxZ && e.maxZ >= b.minZ;
}

export class SpatialHash<T> {
  readonly cellSize: number;
  private readonly entries = new Map<number, Entry<T>>();
  /** Per-cell entry lists, each sorted by id. */
  private readonly cells = new Map<number, Entry<T>[]>();
  /** Oversize entries, sorted by id. */
  private readonly oversize: Entry<T>[] = [];
  private readonly scratch: Entry<T>[] = [];
  private stamp = 0;
  // Cell index range that has ever held an entry (grow-only); bounds ray walks.
  private occIx0 = Infinity;
  private occIx1 = -Infinity;
  private occIz0 = Infinity;
  private occIz1 = -Infinity;

  constructor(cellSize: number = SPATIAL_CELL_SIZE) {
    if (!(Number.isFinite(cellSize) && cellSize > 0)) throw new RangeError(`cellSize must be a positive finite number, got ${cellSize}`);
    this.cellSize = cellSize;
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: number): boolean {
    return this.entries.has(id);
  }

  get(id: number): T | undefined {
    return this.entries.get(id)?.item;
  }

  /** True when the entry lives in the oversize list. */
  isOversize(id: number): boolean {
    return this.entries.get(id)?.oversize ?? false;
  }

  /** Cells the entry occupies; null when missing or oversize. */
  cellRangeOf(id: number): CellRange | null {
    const e = this.entries.get(id);
    return e && !e.oversize ? { ix0: e.ix0, iz0: e.iz0, ix1: e.ix1, iz1: e.iz1 } : null;
  }

  /** Adds an entry. False (nothing changes) for a used or non-finite id, or invalid bounds. */
  insert(id: number, item: T, bounds: Readonly<XZBounds>): boolean {
    if (!Number.isFinite(id) || this.entries.has(id) || !validBounds(bounds)) return false;
    const e: Entry<T> = { id, item, minX: 0, minZ: 0, maxX: 0, maxZ: 0, ix0: 0, iz0: 0, ix1: 0, iz1: 0, oversize: false, stamp: 0 };
    this.entries.set(id, e);
    this.place(e, bounds);
    return true;
  }

  /**
   * Moves an entry to new bounds, re-hashing only when its cell range changes; `item`, when
   * given, replaces the stored item. False (nothing changes) for a missing id or invalid bounds.
   */
  update(id: number, bounds: Readonly<XZBounds>, item?: T): boolean {
    const e = this.entries.get(id);
    if (e === undefined || !validBounds(bounds)) return false;
    if (item !== undefined) e.item = item;
    const S = this.cellSize;
    const ix0 = cellIndex(bounds.minX, S);
    const iz0 = cellIndex(bounds.minZ, S);
    const ix1 = cellIndex(bounds.maxX, S);
    const iz1 = cellIndex(bounds.maxZ, S);
    if (ix0 === e.ix0 && iz0 === e.iz0 && ix1 === e.ix1 && iz1 === e.iz1) {
      e.minX = bounds.minX;
      e.minZ = bounds.minZ;
      e.maxX = bounds.maxX;
      e.maxZ = bounds.maxZ;
      return true;
    }
    this.unplace(e);
    this.place(e, bounds);
    return true;
  }

  /** False when no entry has this id. */
  remove(id: number): boolean {
    const e = this.entries.get(id);
    if (e === undefined) return false;
    this.unplace(e);
    this.entries.delete(id);
    return true;
  }

  /**
   * Appends to `out`, in id order, every item whose bounds overlap `bounds` (inclusive).
   * Walks the covered cells, or scans all entries when that is fewer than the cells.
   */
  queryAabb(bounds: Readonly<XZBounds>, out: T[] = []): T[] {
    if (!validBounds(bounds)) return out;
    const found = this.scratch;
    found.length = 0;
    const S = this.cellSize;
    const ix0 = cellIndex(bounds.minX, S);
    const iz0 = cellIndex(bounds.minZ, S);
    const ix1 = cellIndex(bounds.maxX, S);
    const iz1 = cellIndex(bounds.maxZ, S);
    if ((ix1 - ix0 + 1) * (iz1 - iz0 + 1) > this.entries.size) {
      for (const e of this.entries.values()) if (overlaps(e, bounds)) found.push(e);
    } else {
      const stamp = ++this.stamp;
      for (const e of this.oversize) if (overlaps(e, bounds)) found.push(e);
      const cx1 = Math.min(ix1, MAX_CELL_INDEX);
      const cz0 = Math.max(iz0, MIN_CELL_INDEX);
      const cz1 = Math.min(iz1, MAX_CELL_INDEX);
      for (let ix = Math.max(ix0, MIN_CELL_INDEX); ix <= cx1; ix++) {
        for (let iz = cz0; iz <= cz1; iz++) {
          const list = this.cells.get(cellKey(ix, iz));
          if (list === undefined) continue;
          for (const e of list) {
            if (e.stamp === stamp) continue;
            e.stamp = stamp;
            if (overlaps(e, bounds)) found.push(e);
          }
        }
      }
    }
    found.sort(byId);
    for (const e of found) out.push(e.item);
    found.length = 0;
    return out;
  }

  /**
   * Visits entries in the cells crossed by the XZ projection of the ray (ox, oz) + t·(dx, dz),
   * t ∈ [0, maxDist], nearest cell first (2D DDA). Pass the x/z components of the 3D ray
   * direction unchanged so t, and every cell exit, is measured like the 3D ray distance.
   *
   * visit(item, id) returns the nearest hit distance found so far (Infinity when none). After
   * each cell the walk stops once that distance is ≤ the cell's exit t: later cells cannot hold
   * a nearer hit. Oversize entries are visited first; within a cell entries go in id order;
   * each entry is visited at most once. Non-finite input or maxDist < 0 visits nothing.
   */
  queryRay(ox: number, oz: number, dx: number, dz: number, maxDist: number, visit: (item: T, id: number) => number): void {
    if (!Number.isFinite(ox) || !Number.isFinite(oz) || !Number.isFinite(dx) || !Number.isFinite(dz) || !(maxDist >= 0)) return;
    const stamp = ++this.stamp;
    let best = Infinity;
    for (const e of this.oversize) best = Math.min(best, visit(e.item, e.id));
    if (best <= 0 || this.cells.size === 0) return;

    const S = this.cellSize;
    let ix = cellIndex(ox, S);
    let iz = cellIndex(oz, S);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    // t at which the ray leaves the current cell's column / row.
    const exitX = (): number => (stepX > 0 ? ((ix + 1) * S - ox) / dx : stepX < 0 ? (ix * S - ox) / dx : Infinity);
    const exitZ = (): number => (stepZ > 0 ? ((iz + 1) * S - oz) / dz : stepZ < 0 ? (iz * S - oz) / dz : Infinity);
    let tMaxX = exitX();
    let tMaxZ = exitZ();
    for (;;) {
      // Stop once the walk can no longer reach an occupied cell.
      if (stepX >= 0 ? ix > this.occIx1 : ix < this.occIx0) return;
      if (stepZ >= 0 ? iz > this.occIz1 : iz < this.occIz0) return;
      if ((stepX === 0 && ix < this.occIx0) || (stepZ === 0 && iz < this.occIz0)) return;
      if (inKeyRange(ix) && inKeyRange(iz)) {
        const list = this.cells.get(cellKey(ix, iz));
        if (list !== undefined) {
          for (const e of list) {
            if (e.stamp === stamp) continue;
            e.stamp = stamp;
            best = Math.min(best, visit(e.item, e.id));
          }
        }
      }
      const tExit = Math.min(tMaxX, tMaxZ);
      if (best <= tExit || tExit >= maxDist) return;
      // Through an exact corner, step first toward the cell that owns the corner point
      // (boundaries belong to the upper cell), so no touched cell is skipped.
      if (tMaxX < tMaxZ || (tMaxX === tMaxZ && !(stepX < 0 && stepZ > 0))) {
        ix += stepX;
        tMaxX = exitX();
      } else {
        iz += stepZ;
        tMaxZ = exitZ();
      }
    }
  }

  private place(e: Entry<T>, b: Readonly<XZBounds>): void {
    const S = this.cellSize;
    e.minX = b.minX;
    e.minZ = b.minZ;
    e.maxX = b.maxX;
    e.maxZ = b.maxZ;
    e.ix0 = cellIndex(b.minX, S);
    e.iz0 = cellIndex(b.minZ, S);
    e.ix1 = cellIndex(b.maxX, S);
    e.iz1 = cellIndex(b.maxZ, S);
    e.oversize =
      (e.ix1 - e.ix0 + 1) * (e.iz1 - e.iz0 + 1) > MAX_ITEM_CELLS ||
      !inKeyRange(e.ix0) || !inKeyRange(e.ix1) || !inKeyRange(e.iz0) || !inKeyRange(e.iz1);
    if (e.oversize) {
      insertSorted(this.oversize, e);
      return;
    }
    for (let ix = e.ix0; ix <= e.ix1; ix++) {
      for (let iz = e.iz0; iz <= e.iz1; iz++) {
        const key = cellKey(ix, iz);
        let list = this.cells.get(key);
        if (list === undefined) this.cells.set(key, (list = []));
        insertSorted(list, e);
      }
    }
    this.occIx0 = Math.min(this.occIx0, e.ix0);
    this.occIx1 = Math.max(this.occIx1, e.ix1);
    this.occIz0 = Math.min(this.occIz0, e.iz0);
    this.occIz1 = Math.max(this.occIz1, e.iz1);
  }

  private unplace(e: Entry<T>): void {
    if (e.oversize) {
      removeSorted(this.oversize, e);
      return;
    }
    for (let ix = e.ix0; ix <= e.ix1; ix++) {
      for (let iz = e.iz0; iz <= e.iz1; iz++) {
        const key = cellKey(ix, iz);
        const list = this.cells.get(key);
        if (list === undefined) continue;
        removeSorted(list, e);
        if (list.length === 0) this.cells.delete(key);
      }
    }
  }
}
