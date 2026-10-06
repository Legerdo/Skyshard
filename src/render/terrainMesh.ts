// Terrain chunk mesh data, LOD 0 only (design "지형 렌더링", "청크와 활성화"; Req 8.1). The 2 m heightfield
// is cut into 64 m chunks of 32 × 32 quads (18 × 18 chunks; the last column and row are 32 m wide).
// Every vertex sits on a heightfield sample and takes its height, normal and colour from the TerrainField
// at that sample, so neighbouring chunks share identical edge vertices: no cracks and no lighting seams,
// and the rendered surface meets the collision surface at every sample.
//
// The chunk grid (specs, sample coordinates, sRGB → linear) is shared by the task 18.4 renderer: the three LODs
// with skirts, the Region / slope / noise vertex colours and the strata shader live in src/render/terrain/, the
// page's terrain in terrainView.ts. The flat-colour LOD 0 arrays below are the original single-level mesh data.
// Pure: no three.js / DOM, so it runs in Node tests.

import { TERRAIN_GRID } from '../data/worldLayout';
import type { TerrainField, TerrainMaterial } from '../world/terrain';

/** Chunk edge length (m). */
export const TERRAIN_CHUNK_SIZE = 64;
/** Quads per chunk side at LOD 0 (2 m grid). */
export const CHUNK_QUADS = TERRAIN_CHUNK_SIZE / TERRAIN_GRID.step;
/** Quads per heightfield side (560). */
const GRID_QUADS = TERRAIN_GRID.samplesPerSide - 1;
/** Chunks per side (18). */
export const CHUNKS_PER_SIDE = Math.ceil(GRID_QUADS / CHUNK_QUADS);

/** The TerrainField queries a chunk mesh reads. */
export type TerrainSurface = Pick<TerrainField, 'heightAt' | 'normalAt' | 'materialAt'>;

export interface TerrainChunkSpec {
  /** Chunk column (along x) and row (along z); chunk (0, 0) starts at x = z = −560. */
  readonly cx: number;
  readonly cz: number;
  /** Heightfield index of the chunk's first sample column / row (sample i sits at −560 + 2i m). */
  readonly ix0: number;
  readonly iz0: number;
  /** Quads along x / z: CHUNK_QUADS, fewer in the last column / row. */
  readonly quadsX: number;
  readonly quadsZ: number;
}

export interface TerrainChunkData {
  readonly spec: TerrainChunkSpec;
  /** World-space xyz per vertex; vertex (i, j) of the chunk (i along x, j along z) is index j·(quadsX + 1) + i. */
  readonly positions: Float32Array;
  /** Unit normals (TerrainField.normalAt). */
  readonly normals: Float32Array;
  /** Linear-sRGB rgb per vertex (three.js vertex colours are linear). */
  readonly colors: Float32Array;
  /** Two triangles per quad, counter-clockwise seen from above, so front faces point up. */
  readonly indices: Uint16Array;
}

/** Temporary per-material base colours (sRGB 0xRRGGBB). */
export const TERRAIN_COLORS: Readonly<Record<TerrainMaterial, number>> = {
  grass: 0x6f9f4a,
  dirt: 0x9a7a52,
  rock: 0x8b8680,
  sand: 0xd8c796,
  ashRock: 0x6f5b54,
  crystal: 0xc24a5e,
  snow: 0xeef2f6,
  stone: 0xa39c90,
};

export type LinearRgb = readonly [number, number, number];

/** sRGB transfer function inverse for one channel in [0, 1]. */
function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** 0xRRGGBB (sRGB) → linear-sRGB rgb in [0, 1]. */
export function srgbHexToLinear(hex: number): LinearRgb {
  return [
    srgbChannelToLinear(((hex >> 16) & 0xff) / 255),
    srgbChannelToLinear(((hex >> 8) & 0xff) / 255),
    srgbChannelToLinear((hex & 0xff) / 255),
  ];
}

/** TERRAIN_COLORS in linear space, the values written to the colour attribute. */
export const TERRAIN_LINEAR_COLORS: Readonly<Record<TerrainMaterial, LinearRgb>> = Object.fromEntries(
  Object.entries(TERRAIN_COLORS).map(([material, hex]) => [material, srgbHexToLinear(hex)]),
) as Record<TerrainMaterial, LinearRgb>;

/** World x (or z) of heightfield sample index `i`. */
export function gridCoord(i: number): number {
  return -TERRAIN_GRID.halfExtent + i * TERRAIN_GRID.step;
}

/** Every chunk of the heightfield, row by row (cz, then cx). */
export function terrainChunkSpecs(): TerrainChunkSpec[] {
  const specs: TerrainChunkSpec[] = [];
  for (let cz = 0; cz < CHUNKS_PER_SIDE; cz++) {
    for (let cx = 0; cx < CHUNKS_PER_SIDE; cx++) {
      const ix0 = cx * CHUNK_QUADS;
      const iz0 = cz * CHUNK_QUADS;
      specs.push({
        cx,
        cz,
        ix0,
        iz0,
        quadsX: Math.min(CHUNK_QUADS, GRID_QUADS - ix0),
        quadsZ: Math.min(CHUNK_QUADS, GRID_QUADS - iz0),
      });
    }
  }
  return specs;
}

/** Index buffers depend only on the chunk's quad counts, so chunks of one size share one array. */
const indexCache = new Map<string, Uint16Array>();

/**
 * Triangles of a quadsX × quadsZ quad grid. Quad corners a (i, j), b (i + 1, j), c (i, j + 1), d (i + 1, j + 1)
 * give (a, c, b) and (b, c, d): counter-clockwise seen from above (+X to the right, +Z down the screen).
 */
function gridIndices(quadsX: number, quadsZ: number): Uint16Array {
  const key = `${quadsX}x${quadsZ}`;
  const cached = indexCache.get(key);
  if (cached !== undefined) return cached;
  const row = quadsX + 1;
  const indices = new Uint16Array(quadsX * quadsZ * 6);
  let k = 0;
  for (let j = 0; j < quadsZ; j++) {
    for (let i = 0; i < quadsX; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  indexCache.set(key, indices);
  return indices;
}

/** Mesh arrays of one chunk; `colors` maps each TerrainMaterial to a linear rgb. */
export function buildTerrainChunk(
  field: TerrainSurface,
  spec: TerrainChunkSpec,
  colors: Readonly<Record<TerrainMaterial, LinearRgb>> = TERRAIN_LINEAR_COLORS,
): TerrainChunkData {
  const row = spec.quadsX + 1;
  const count = row * (spec.quadsZ + 1);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const rgb = new Float32Array(count * 3);
  for (let j = 0; j <= spec.quadsZ; j++) {
    const z = gridCoord(spec.iz0 + j);
    for (let i = 0; i < row; i++) {
      const x = gridCoord(spec.ix0 + i);
      const k = (j * row + i) * 3;
      positions[k] = x;
      positions[k + 1] = field.heightAt(x, z);
      positions[k + 2] = z;
      const n = field.normalAt(x, z);
      normals[k] = n.x;
      normals[k + 1] = n.y;
      normals[k + 2] = n.z;
      const c = colors[field.materialAt(x, z)];
      rgb[k] = c[0];
      rgb[k + 1] = c[1];
      rgb[k + 2] = c[2];
    }
  }
  return { spec, positions, normals, colors: rgb, indices: gridIndices(spec.quadsX, spec.quadsZ) };
}
