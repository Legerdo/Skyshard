/*
 * Terrain chunk LODs (design.md "지형 렌더링"; Req 38.5, 39.3). The 2 m heightfield is cut into 64 m chunks
 * (terrainMesh.ts `terrainChunkSpecs`), and each chunk is meshed at three grid spacings:
 *
 * | LOD | grid | camera distance (× the preset's terrain LOD scale 0.7 / 1 / 1.3) |
 * | 0   | 2 m  | < 160 m     |
 * | 1   | 4 m  | 160–400 m   |
 * | 2   | 8 m  | > 400 m     |
 *
 * Every vertex sits on a heightfield sample, so neighbouring chunks of the same LOD share their edge vertices. Where
 * two LODs meet, the coarse edge cuts corners of the fine one; a skirt hangs from every chunk edge down to below the
 * lowest fine sample of its edge segment (minus 1.5 m), so the crack shows the skirt instead of the sky. Skirt quads
 * face outward: whichever side the camera is on, the neighbour's skirt covers the gap.
 *
 * Vertex attributes: world-space position, normal (TerrainField.normalAt), linear colour (terrainColors.ts) and the
 * strata weight. Pure (no three.js / DOM), so it runs in Node tests; chunkedTerrain.ts wraps it in BufferGeometry.
 */
import { TERRAIN_GRID } from '../../data/worldLayout';
import { gridCoord, type TerrainChunkSpec } from '../terrainMesh';
import { terrainColorAt, type TerrainColorSurface, type TerrainVertexColor } from './terrainColors';

export type TerrainLod = 0 | 1 | 2;
export const TERRAIN_LODS: readonly TerrainLod[] = [0, 1, 2];
/** Grid spacing (m) per LOD. */
export const LOD_GRID_STEP: Readonly<Record<TerrainLod, number>> = { 0: 2, 1: 4, 2: 8 };
/** Switch distances (m) at the 'medium' preset: LOD 0 → 1 at 160 m, 1 → 2 at 400 m. */
export const LOD_DISTANCES = [160, 400] as const;
/** A chunk keeps its finer LOD until the distance passes the threshold by this fraction (no flicker at the edge). */
export const LOD_HYSTERESIS = 0.05;
/** Skirts hang this far below the lowest fine sample along their edge segment (m). */
export const SKIRT_MARGIN = 1.5;

/** Horizontal / vertical extent of a chunk used for the LOD distance and culling. */
export interface ChunkBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Distance (m) from (x, y, z) to the nearest point of the box; 0 inside. */
export function distanceToBounds(b: ChunkBounds, x: number, y: number, z: number): number {
  const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
  const dy = y < b.minY ? b.minY - y : y > b.maxY ? y - b.maxY : 0;
  const dz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * The LOD for a chunk `distance` m from the camera at LOD distance scale `scale`. With `current` given, a finer
 * current LOD is kept until the distance exceeds its threshold by LOD_HYSTERESIS.
 */
export function selectLod(distance: number, scale = 1, current?: TerrainLod): TerrainLod {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const d = Number.isFinite(distance) ? Math.max(0, distance) : Number.POSITIVE_INFINITY;
  const near = LOD_DISTANCES[0] * s;
  const far = LOD_DISTANCES[1] * s;
  const keep = 1 + LOD_HYSTERESIS;
  if (current === 0 && d < near * keep) return 0;
  if (current === 1 && d >= near && d < far * keep) return 1;
  if (current === 1 && d < near) return 0;
  if (d < near) return 0;
  if (d < far) return 1;
  return 2;
}

/** Bounds of a chunk from its heightfield samples (all 2 m samples, so every LOD fits inside). */
export function chunkBounds(heights: Float32Array, spec: TerrainChunkSpec): ChunkBounds {
  const n = TERRAIN_GRID.samplesPerSide;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let j = 0; j <= spec.quadsZ; j++) {
    const row = (spec.iz0 + j) * n + spec.ix0;
    for (let i = 0; i <= spec.quadsX; i++) {
      const h = heights[row + i];
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }
  return {
    minX: gridCoord(spec.ix0),
    maxX: gridCoord(spec.ix0 + spec.quadsX),
    minZ: gridCoord(spec.iz0),
    maxZ: gridCoord(spec.iz0 + spec.quadsZ),
    minY,
    maxY,
  };
}

/** Bounds from `heightAt` samples on the 2 m grid (for surfaces without a heights array). */
export function chunkBoundsFromSurface(field: Pick<TerrainColorSurface, 'heightAt'>, spec: TerrainChunkSpec): ChunkBounds {
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let j = 0; j <= spec.quadsZ; j++) {
    for (let i = 0; i <= spec.quadsX; i++) {
      const h = field.heightAt(gridCoord(spec.ix0 + i), gridCoord(spec.iz0 + j));
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }
  return {
    minX: gridCoord(spec.ix0), maxX: gridCoord(spec.ix0 + spec.quadsX), minZ: gridCoord(spec.iz0), maxZ: gridCoord(spec.iz0 + spec.quadsZ), minY, maxY,
  };
}

export interface LodChunkData {
  readonly spec: TerrainChunkSpec;
  readonly lod: TerrainLod;
  /** Grid vertices per side along x / z (quads / factor + 1). */
  readonly cols: number;
  readonly rows: number;
  /** Vertices of the grid proper; skirt vertices follow them. */
  readonly gridVertexCount: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  /** Steep-slope weight per vertex (the strata shader). */
  readonly strata: Float32Array;
  readonly indices: Uint16Array;
  /** Triangles of the grid proper and of the skirts. */
  readonly gridTriangles: number;
  readonly skirtTriangles: number;
}

/**
 * The chunk's grid walked along its border: x / z vertex indices (i, j). North edge (j = 0, the chunk's −z side)
 * west → east, east edge north → south, south edge east → west, west edge south → north: +x, +z, −x, −z, which is
 * clockwise seen from above (the right-hand normal of the loop points down).
 */
function borderLoop(cols: number, rows: number): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < cols - 1; i++) loop.push([i, 0]);
  for (let j = 0; j < rows - 1; j++) loop.push([cols - 1, j]);
  for (let i = cols - 1; i > 0; i--) loop.push([i, rows - 1]);
  for (let j = rows - 1; j > 0; j--) loop.push([0, j]);
  return loop;
}

const colorSlot: TerrainVertexColor = { r: 0, g: 0, b: 0, strata: 0 };

/**
 * Mesh arrays of `spec` at `lod`: the grid (two triangles per quad, counter-clockwise from above) and the skirt
 * around it. `seed` selects the colour noise.
 */
export function buildLodChunk(field: TerrainColorSurface, spec: TerrainChunkSpec, lod: TerrainLod, seed = 0): LodChunkData {
  const factor = LOD_GRID_STEP[lod] / TERRAIN_GRID.step;
  if (spec.quadsX % factor !== 0 || spec.quadsZ % factor !== 0) throw new RangeError(`terrainLod: chunk ${spec.cx},${spec.cz} does not divide by ${factor}`);
  const cols = spec.quadsX / factor + 1;
  const rows = spec.quadsZ / factor + 1;
  const gridCount = cols * rows;
  const loop = borderLoop(cols, rows);
  const count = gridCount + loop.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const strata = new Float32Array(count);

  for (let j = 0; j < rows; j++) {
    const z = gridCoord(spec.iz0 + j * factor);
    for (let i = 0; i < cols; i++) {
      const x = gridCoord(spec.ix0 + i * factor);
      const v = j * cols + i;
      const k = v * 3;
      const n = field.normalAt(x, z);
      positions[k] = x;
      positions[k + 1] = field.heightAt(x, z);
      positions[k + 2] = z;
      normals[k] = n.x;
      normals[k + 1] = n.y;
      normals[k + 2] = n.z;
      const slope = (Math.acos(Math.min(1, Math.max(-1, n.y))) * 180) / Math.PI;
      terrainColorAt(field, seed, x, z, slope, colorSlot);
      colors[k] = colorSlot.r;
      colors[k + 1] = colorSlot.g;
      colors[k + 2] = colorSlot.b;
      strata[v] = colorSlot.strata;
    }
  }

  // Skirt vertices: below each border vertex, deeper than every fine sample within one coarse step along the edge.
  loop.forEach(([i, j], s) => {
    const src = j * cols + i;
    const dst = gridCount + s;
    const x0 = gridCoord(spec.ix0 + i * factor);
    const z0 = gridCoord(spec.iz0 + j * factor);
    // Edges along x (north / south rows) look along x, edges along z along z; corners belong to both.
    const alongX = j === 0 || j === rows - 1;
    const alongZ = i === 0 || i === cols - 1;
    let low = positions[src * 3 + 1];
    for (let f = -factor; f <= factor; f++) {
      if (alongX) low = Math.min(low, field.heightAt(x0 + f * TERRAIN_GRID.step, z0));
      if (alongZ) low = Math.min(low, field.heightAt(x0, z0 + f * TERRAIN_GRID.step));
    }
    positions[dst * 3] = positions[src * 3];
    positions[dst * 3 + 1] = low - SKIRT_MARGIN;
    positions[dst * 3 + 2] = positions[src * 3 + 2];
    for (let c = 0; c < 3; c++) {
      normals[dst * 3 + c] = normals[src * 3 + c];
      colors[dst * 3 + c] = colors[src * 3 + c];
    }
    strata[dst] = 1; // skirts read as rock face if ever seen
  });

  const gridTriangles = (cols - 1) * (rows - 1) * 2;
  const skirtTriangles = loop.length * 2;
  const indices = new Uint16Array((gridTriangles + skirtTriangles) * 3);
  let t = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }
  // The border loop runs clockwise seen from above, so (top_s, top_s+1, bottom_s) and (top_s+1, bottom_s+1, bottom_s)
  // face outward: (edge direction) × (down) points away from the chunk.
  for (let s = 0; s < loop.length; s++) {
    const s1 = (s + 1) % loop.length;
    const [i0, j0] = loop[s] as [number, number];
    const [i1, j1] = loop[s1] as [number, number];
    const top0 = j0 * cols + i0;
    const top1 = j1 * cols + i1;
    const bottom0 = gridCount + s;
    const bottom1 = gridCount + s1;
    indices[t++] = top0;
    indices[t++] = top1;
    indices[t++] = bottom0;
    indices[t++] = top1;
    indices[t++] = bottom1;
    indices[t++] = bottom0;
  }
  return { spec, lod, cols, rows, gridVertexCount: gridCount, positions, normals, colors, strata, indices, gridTriangles, skirtTriangles };
}

/** Mesh arrays of several chunks in one buffer set (the far 2 × 2 blocks: one draw call instead of four). */
export interface MergedLodData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly strata: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly triangles: number;
}

/** Concatenates chunk arrays, offsetting the indices (Uint16 while the vertex count allows). */
export function mergeLodChunks(parts: readonly LodChunkData[]): MergedLodData {
  let vertices = 0;
  let indexCount = 0;
  for (const p of parts) {
    vertices += p.positions.length / 3;
    indexCount += p.indices.length;
  }
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const strata = new Float32Array(vertices);
  const indices = vertices <= 0xffff ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
  let v = 0;
  let k = 0;
  for (const p of parts) {
    positions.set(p.positions, v * 3);
    normals.set(p.normals, v * 3);
    colors.set(p.colors, v * 3);
    strata.set(p.strata, v);
    for (let i = 0; i < p.indices.length; i++) indices[k++] = (p.indices[i] as number) + v;
    v += p.positions.length / 3;
  }
  return { positions, normals, colors, strata, indices, triangles: indexCount / 3 };
}
