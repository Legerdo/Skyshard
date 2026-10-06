// Test helper: walkable ground paths over the terrain heightfield (grid A*), for the scripted route bot.
// Nodes are the 2 m heightfield samples; a node is open when its slope is at most `maxSlopeDeg`, it is
// not in wading-deep water and lies inside the play boundary, and an edge is open when the rise between
// its ends stays under the same slope. Colliders (barriers, temporary route pieces) are not considered.

import { TERRAIN_GRID } from '../../../src/data/worldLayout';
import type { TerrainField } from '../../../src/world/terrain';

export interface XZ {
  x: number;
  z: number;
}

export interface GroundPathOptions {
  /** Steepest slope a node or an edge may have (degrees). Default 38. */
  maxSlopeDeg?: number;
  /** Search box margin around the two ends (m). Default 140. */
  margin?: number;
  /** Deepest water a node may have (m). Default 0.8. */
  maxWater?: number;
}

const N = TERRAIN_GRID.samplesPerSide;
const HALF = TERRAIN_GRID.halfExtent;
const STEP = TERRAIN_GRID.step;

const toIndex = (v: number): number => Math.max(0, Math.min(N - 1, Math.round((v + HALF) / STEP)));
const toWorld = (i: number): number => i * STEP - HALF;

/** Binary min-heap of node ids keyed by `f`. */
class Heap {
  private readonly ids: number[] = [];
  constructor(private readonly f: Float64Array) {}
  get size(): number {
    return this.ids.length;
  }
  push(id: number): void {
    const a = this.ids;
    a.push(id);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[a[p]] <= this.f[a[i]]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.ids;
    const top = a[0];
    const last = a.pop() as number;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.f[a[l]] < this.f[a[m]]) m = l;
        if (r < a.length && this.f[a[r]] < this.f[a[m]]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Walkable path from `from` to `to` as waypoints (the end points included), shortened by line of sight;
 * null when the grid has no open path inside the search box.
 */
export function findGroundPath(terrain: TerrainField, from: XZ, to: XZ, options: GroundPathOptions = {}): XZ[] | null {
  const maxSlope = options.maxSlopeDeg ?? 38;
  const margin = options.margin ?? 140;
  const maxWater = options.maxWater ?? 0.8;
  const tanMax = Math.tan((maxSlope * Math.PI) / 180);
  const x0 = toIndex(Math.min(from.x, to.x) - margin);
  const x1 = toIndex(Math.max(from.x, to.x) + margin);
  const z0 = toIndex(Math.min(from.z, to.z) - margin);
  const z1 = toIndex(Math.max(from.z, to.z) + margin);
  const w = x1 - x0 + 1;
  const h = z1 - z0 + 1;
  const count = w * h;
  const open = new Uint8Array(count);
  const height = new Float64Array(count);
  for (let iz = 0; iz < h; iz++) {
    for (let ix = 0; ix < w; ix++) {
      const x = toWorld(ix + x0);
      const z = toWorld(iz + z0);
      const id = iz * w + ix;
      height[id] = terrain.heightAt(x, z);
      open[id] = terrain.slopeDeg(x, z) <= maxSlope && terrain.waterDepthAt(x, z) <= maxWater && terrain.insideBoundary(x, z) ? 1 : 0;
    }
  }
  const node = (p: XZ): number => (toIndex(p.z) - z0) * w + (toIndex(p.x) - x0);
  const start = node(from);
  const goal = node(to);
  open[start] = 1;
  open[goal] = 1;
  const g = new Float64Array(count).fill(Infinity);
  const f = new Float64Array(count).fill(Infinity);
  const parent = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const gx = goal % w;
  const gz = Math.floor(goal / w);
  const heur = (id: number): number => Math.hypot((id % w) - gx, Math.floor(id / w) - gz) * STEP;
  const heap = new Heap(f);
  g[start] = 0;
  f[start] = heur(start);
  heap.push(start);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur] === 1) continue;
    closed[cur] = 1;
    if (cur === goal) break;
    const cx = cur % w;
    const cz = Math.floor(cur / w);
    for (const [dx, dz] of dirs) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const nid = nz * w + nx;
      if (open[nid] === 0 || closed[nid] === 1) continue;
      const run = Math.hypot(dx, dz) * STEP;
      const rise = Math.abs(height[nid] - height[cur]);
      if (rise > run * tanMax) continue;
      const cost = g[cur] + run * (1 + (2 * rise) / run);
      if (cost < g[nid]) {
        g[nid] = cost;
        f[nid] = cost + heur(nid);
        parent[nid] = cur;
        heap.push(nid);
      }
    }
  }
  if (parent[goal] === -1 && goal !== start) return null;
  const cells: XZ[] = [];
  for (let id = goal; id !== -1; id = parent[id]) cells.push({ x: toWorld((id % w) + x0), z: toWorld(Math.floor(id / w) + z0) });
  cells.reverse();
  cells[0] = { ...from };
  cells[cells.length - 1] = { ...to };
  return shorten(terrain, cells, maxSlope, maxWater);
}

/** Whether the straight segment a → b stays on open ground (sampled every metre). */
function clear(terrain: TerrainField, a: XZ, b: XZ, maxSlope: number, maxWater: number): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len));
  const tanMax = Math.tan((maxSlope * Math.PI) / 180);
  let prev = terrain.heightAt(a.x, a.z);
  for (let k = 1; k <= n; k++) {
    const x = a.x + ((b.x - a.x) * k) / n;
    const z = a.z + ((b.z - a.z) * k) / n;
    const y = terrain.heightAt(x, z);
    if (terrain.slopeDeg(x, z) > maxSlope || terrain.waterDepthAt(x, z) > maxWater) return false;
    if (Math.abs(y - prev) > (len / n) * tanMax) return false;
    prev = y;
  }
  return true;
}

/** Drops waypoints that the previous kept one can see past (at most 24 m per leg). */
function shorten(terrain: TerrainField, cells: readonly XZ[], maxSlope: number, maxWater: number): XZ[] {
  const out: XZ[] = [cells[0]];
  let i = 0;
  while (i < cells.length - 1) {
    let j = i + 1;
    while (
      j + 1 < cells.length &&
      Math.hypot(cells[j + 1].x - cells[i].x, cells[j + 1].z - cells[i].z) <= 24 &&
      clear(terrain, cells[i], cells[j + 1], maxSlope, maxWater)
    ) {
      j++;
    }
    out.push(cells[j]);
    i = j;
  }
  return out;
}
