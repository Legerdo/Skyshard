import { beforeAll, describe, expect, it } from 'vitest';
import {
  CHUNKS_PER_SIDE,
  CHUNK_QUADS,
  TERRAIN_LINEAR_COLORS,
  buildTerrainChunk,
  gridCoord,
  terrainChunkSpecs,
  type TerrainChunkData,
} from '../../../src/render/terrainMesh';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Terrain chunk meshes, LOD 0 (design "지형 렌더링"): 64 m chunks over the 2 m heightfield, built in Node.
const SEED = 20240601;
const GRID_QUADS = 560;
let field: TerrainField;

beforeAll(() => {
  field = buildTerrain(SEED);
});

function chunk(cx: number, cz: number): TerrainChunkData {
  const spec = terrainChunkSpecs().find((s) => s.cx === cx && s.cz === cz);
  if (spec === undefined) throw new Error(`no chunk ${cx},${cz}`);
  return buildTerrainChunk(field, spec);
}

/** Position, normal and colour of vertex (i, j) as one flat list. */
function vertex(data: TerrainChunkData, i: number, j: number): number[] {
  const k = (j * (data.spec.quadsX + 1) + i) * 3;
  return [data.positions, data.normals, data.colors].flatMap((a) => [a[k], a[k + 1], a[k + 2]]);
}

describe('terrainChunkSpecs', () => {
  it('tiles the 560 × 560 quad grid exactly once with 18 × 18 chunks, the last column and row 16 quads wide', () => {
    const specs = terrainChunkSpecs();
    expect([CHUNKS_PER_SIDE, CHUNK_QUADS, specs.length]).toEqual([18, 32, 324]);
    const covered = new Uint8Array(GRID_QUADS * GRID_QUADS);
    for (const s of specs) {
      expect([s.ix0, s.iz0]).toEqual([s.cx * CHUNK_QUADS, s.cz * CHUNK_QUADS]);
      expect([s.quadsX, s.quadsZ]).toEqual([s.cx === 17 ? 16 : 32, s.cz === 17 ? 16 : 32]);
      for (let j = 0; j < s.quadsZ; j++) {
        for (let i = 0; i < s.quadsX; i++) covered[(s.iz0 + j) * GRID_QUADS + s.ix0 + i]++;
      }
    }
    expect(covered.every((n) => n === 1)).toBe(true);
  });
});

describe('buildTerrainChunk', () => {
  it('puts each vertex on a heightfield sample with its height, normal and material colour', () => {
    const data = chunk(4, 13); // Thistlewick (−250, 300) and the hills around it
    expect(data.positions).toHaveLength(33 * 33 * 3);
    expect(data.indices).toHaveLength(32 * 32 * 6);
    let checked = 0;
    for (let j = 0; j <= 32; j++) {
      for (let i = 0; i <= 32; i++) {
        const x = gridCoord(data.spec.ix0 + i);
        const z = gridCoord(data.spec.iz0 + j);
        const n = field.normalAt(x, z);
        const expected = [x, field.heightAt(x, z), z, n.x, n.y, n.z, ...TERRAIN_LINEAR_COLORS[field.materialAt(x, z)]];
        const actual = vertex(data, i, j);
        expect(actual.every((v, k) => v === Math.fround(expected[k]))).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(33 * 33);
    expect(chunk(17, 17).positions).toHaveLength(17 * 17 * 3); // corner chunk: 16 × 16 quads
  });

  it('shares identical edge vertices with the neighbouring chunks, so there are no cracks or seams', () => {
    const a = chunk(4, 13);
    const east = chunk(5, 13);
    const south = chunk(4, 14);
    for (let k = 0; k <= 32; k++) {
      expect(vertex(east, 0, k)).toEqual(vertex(a, 32, k));
      expect(vertex(south, k, 0)).toEqual(vertex(a, k, 32));
    }
  });

  it('winds every triangle counter-clockwise seen from above (front faces up) with in-range indices', () => {
    const { positions: p, indices } = chunk(4, 13);
    const vertexCount = p.length / 3;
    let upward = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
      // y of (b − a) × (c − a)
      const ny = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
      if (ny > 0) upward++;
    }
    expect(upward).toBe(indices.length / 3);
    expect(Math.max(...indices)).toBe(vertexCount - 1);
  });
});
