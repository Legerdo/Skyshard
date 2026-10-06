import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RENDER_QUALITY_PRESETS, renderQualityFor } from '../../../src/data/renderQuality';
import { ChunkedTerrain } from '../../../src/render/terrain/chunkedTerrain';
import { slopeRockOf, terrainColorAt, type TerrainColorSurface } from '../../../src/render/terrain/terrainColors';
import {
  buildLodChunk, LOD_DISTANCES, LOD_GRID_STEP, LOD_HYSTERESIS, selectLod, SKIRT_MARGIN, type LodChunkData,
} from '../../../src/render/terrain/terrainLod';
import { patchStrataFragment, patchStrataVertex, TERRAIN_PROGRAM_KEY, terrainMaterial } from '../../../src/render/terrain/terrainMaterial';
import { gridCoord, terrainChunkSpecs, type TerrainChunkSpec } from '../../../src/render/terrainMesh';

// Task 18.4: terrain chunk LODs (2 / 4 / 8 m at 160 / 400 m × the preset scale), skirts, vertex colours and strata.

/** A bumpy analytic surface (no flat stretches, so coarse edges really cut the fine ones). */
function bumpy(amp = 6): TerrainColorSurface {
  const h = (x: number, z: number): number => amp * Math.sin(x * 0.37) * Math.cos(z * 0.29) + 0.02 * x;
  return {
    heightAt: h,
    normalAt: (x, z) => {
      const gx = (h(x + 2, z) - h(x - 2, z)) / 4;
      const gz = (h(x, z + 2) - h(x, z - 2)) / 4;
      return new THREE.Vector3(-gx, 1, -gz).normalize();
    },
    materialAt: (x) => (x < 0 ? 'grass' : 'rock'),
  };
}

const specs = terrainChunkSpecs();
const specAt = (cx: number, cz: number): TerrainChunkSpec => {
  const s = specs.find((c) => c.cx === cx && c.cz === cz);
  if (s === undefined) throw new Error(`no chunk ${cx},${cz}`);
  return s;
};

describe('LOD selection', () => {
  it('uses the 2 / 4 / 8 m grids at 160 / 400 m times each quality preset scale', () => {
    expect(LOD_GRID_STEP).toEqual({ 0: 2, 1: 4, 2: 8 });
    expect(LOD_DISTANCES).toEqual([160, 400]);
    const scales = RENDER_QUALITY_PRESETS.map((p) => renderQualityFor(p).terrainLodScale);
    expect(scales).toEqual([0.7, 1, 1.3]);
    for (const s of scales) {
      expect([selectLod(160 * s - 0.5, s), selectLod(160 * s + 0.5, s), selectLod(400 * s - 0.5, s), selectLod(400 * s + 0.5, s)]).toEqual([0, 1, 1, 2]);
      expect(selectLod(0, s)).toBe(0);
    }
    // Low 112 / 280 m, high 208 / 520 m.
    expect([selectLod(120, 0.7), selectLod(300, 0.7), selectLod(200, 1.3), selectLod(500, 1.3)]).toEqual([1, 2, 0, 1]);
  });

  it('keeps a finer LOD within the hysteresis band and falls back to medium on bad input', () => {
    const edge = 160 * (1 + LOD_HYSTERESIS * 0.5);
    expect([selectLod(edge, 1, 0), selectLod(edge, 1)]).toEqual([0, 1]);
    expect([selectLod(400 * 1.02, 1, 1), selectLod(400 * 1.02, 1)]).toEqual([1, 2]);
    expect(selectLod(150, 1, 1)).toBe(0);
    expect([selectLod(Number.NaN), selectLod(100, Number.NaN), selectLod(100, -2)]).toEqual([2, 0, 0]);
  });
});

describe('chunk meshes', () => {
  const field = bumpy();
  const spec = specAt(8, 8);

  it('samples the heightfield grid every 2 / 4 / 8 m with every vertex on the surface', () => {
    for (const lod of [0, 1, 2] as const) {
      const d = buildLodChunk(field, spec, lod);
      expect([d.cols, d.rows]).toEqual([32 / (LOD_GRID_STEP[lod] / 2) + 1, 32 / (LOD_GRID_STEP[lod] / 2) + 1]);
      expect(d.gridTriangles).toBe((d.cols - 1) * (d.rows - 1) * 2);
      expect(d.positions[3] - d.positions[0]).toBeCloseTo(LOD_GRID_STEP[lod], 9);
      for (let v = 0; v < d.gridVertexCount; v++) {
        const x = d.positions[v * 3];
        const z = d.positions[v * 3 + 2];
        expect(d.positions[v * 3 + 1]).toBeCloseTo(field.heightAt(x, z), 4);
      }
    }
    // The world's last (half-width) column and row still divide by the coarsest step.
    const last = specAt(17, 17);
    expect([last.quadsX, last.quadsZ]).toEqual([16, 16]);
    expect(buildLodChunk(field, last, 2).cols).toBe(5);
  });

  it('hangs skirts below the lowest fine sample of each edge segment and faces them outward', () => {
    for (const lod of [0, 1, 2] as const) {
      const d = buildLodChunk(field, spec, lod);
      const skirts = d.positions.length / 3 - d.gridVertexCount;
      expect(skirts).toBe(2 * (d.cols - 1) + 2 * (d.rows - 1));
      expect(d.skirtTriangles).toBe(skirts * 2);
      const cx = (gridCoord(spec.ix0) + gridCoord(spec.ix0 + spec.quadsX)) / 2;
      const cz = (gridCoord(spec.iz0) + gridCoord(spec.iz0 + spec.quadsZ)) / 2;
      const p = (i: number): THREE.Vector3 => new THREE.Vector3(d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2]);
      for (let t = d.gridTriangles; t < d.gridTriangles + d.skirtTriangles; t++) {
        const [a, b, c] = [p(d.indices[t * 3]), p(d.indices[t * 3 + 1]), p(d.indices[t * 3 + 2])];
        const n = b.clone().sub(a).cross(c.clone().sub(a));
        const mid = a.clone().add(b).add(c).divideScalar(3);
        expect(n.x * (mid.x - cx) + n.z * (mid.z - cz)).toBeGreaterThan(0);
      }
      const step = LOD_GRID_STEP[lod];
      for (let s = d.gridVertexCount; s < d.positions.length / 3; s++) {
        const bottom = p(s);
        // The matching top vertex is straight above it.
        let top: THREE.Vector3 | null = null;
        for (let v = 0; v < d.gridVertexCount && top === null; v++) {
          const q = p(v);
          if (Math.abs(q.x - bottom.x) < 1e-6 && Math.abs(q.z - bottom.z) < 1e-6) top = q;
        }
        expect(top).not.toBeNull();
        expect((top as THREE.Vector3).y - bottom.y).toBeGreaterThanOrEqual(SKIRT_MARGIN - 1e-6);
        const alongX = Math.abs(bottom.z - gridCoord(spec.iz0)) < 1e-6 || Math.abs(bottom.z - gridCoord(spec.iz0 + spec.quadsZ)) < 1e-6;
        for (let f = -step; f <= step; f += 2) {
          const h = alongX ? field.heightAt(bottom.x + f, bottom.z) : field.heightAt(bottom.x, bottom.z + f);
          expect(bottom.y).toBeLessThanOrEqual(h - SKIRT_MARGIN + 1e-4);
        }
      }
    }
  });

  it('closes the crack between LOD 0 and LOD 2 neighbours: the higher edge always has skirt down to the lower one', () => {
    const a = buildLodChunk(field, specAt(8, 8), 0);
    const b = buildLodChunk(field, specAt(9, 8), 2);
    const edgeX = gridCoord(specAt(9, 8).ix0);
    /** Surface and skirt-bottom heights of `d` along its x = edgeX border at z (linear between its edge vertices). */
    const along = (d: LodChunkData, z: number): { top: number; bottom: number } => {
      const tops: { z: number; y: number; i: number }[] = [];
      for (let v = 0; v < d.gridVertexCount; v++) if (Math.abs(d.positions[v * 3] - edgeX) < 1e-6) tops.push({ z: d.positions[v * 3 + 2], y: d.positions[v * 3 + 1], i: v });
      const bottoms: { z: number; y: number }[] = [];
      for (let v = d.gridVertexCount; v < d.positions.length / 3; v++) if (Math.abs(d.positions[v * 3] - edgeX) < 1e-6) bottoms.push({ z: d.positions[v * 3 + 2], y: d.positions[v * 3 + 1] });
      const lerp = (list: { z: number; y: number }[]): number => {
        list.sort((p, q) => p.z - q.z);
        for (let k = 0; k + 1 < list.length; k++) {
          const p = list[k];
          const q = list[k + 1];
          if (z >= p.z - 1e-9 && z <= q.z + 1e-9) return p.y + ((q.y - p.y) * (z - p.z)) / (q.z - p.z);
        }
        throw new Error(`z ${z} off the edge`);
      };
      return { top: lerp(tops), bottom: lerp(bottoms) };
    };
    for (let z = gridCoord(specAt(9, 8).iz0) + 0.5; z < gridCoord(specAt(9, 8).iz0 + 32); z += 1) {
      const fa = along(a, z);
      const fb = along(b, z);
      const higher = fa.top >= fb.top ? fa : fb;
      const lower = fa.top >= fb.top ? fb : fa;
      expect(higher.bottom).toBeLessThanOrEqual(lower.top + 1e-4);
    }
  });

  it('blends slopes toward the Region rock colour and weights the strata by steepness', () => {
    const out = { r: 0, g: 0, b: 0, strata: 0 };
    const flat = { ...terrainColorAt(field, 1, -300, 300, 5, out) };
    const steep = { ...terrainColorAt(field, 1, -300, 300, 60, out) };
    expect([flat.strata, steep.strata]).toEqual([0, 1]);
    expect(flat.g / flat.r).toBeGreaterThan(steep.g / steep.r); // green grass fades to grey-brown rock
    expect([slopeRockOf('ember'), slopeRockOf('verdant'), slopeRockOf('azure')]).toEqual(['ashRock', 'rock', 'rock']);
    // Deterministic noise tint: same seed, same colour.
    expect(terrainColorAt(field, 7, 10, 20, 12, { r: 0, g: 0, b: 0, strata: 0 })).toEqual(terrainColorAt(field, 7, 10, 20, 12, { r: 0, g: 0, b: 0, strata: 0 }));
  });
});

describe('ChunkedTerrain', () => {
  const field = bumpy(3);

  it('draws near chunks at LOD 0, far ones at LOD 2 and merges coarse 2 × 2 blocks / 4 × 4 superblocks into one mesh', () => {
    const t = new ChunkedTerrain(field, { buildBudget: Number.POSITIVE_INFINITY });
    const stats = t.update({ x: 0, y: 10, z: 0 });
    for (const c of t.chunks) {
      const d = Math.hypot(Math.max(c.bounds.minX, Math.min(0, c.bounds.maxX)), Math.max(c.bounds.minZ, Math.min(0, c.bounds.maxZ)));
      if (d < 100) expect(c.shown).toBe(0);
      if (d > 450) expect(c.shown).toBe(2);
    }
    expect(stats.lods[0] + stats.lods[1] + stats.lods[2]).toBe(324);
    // The corner superblock is all far: one LOD 2 mesh, its blocks and chunks hidden.
    const corner = t.superblocks[0];
    expect([corner.mesh.visible, corner.drawn, corner.chunks.length]).toEqual([true, 2, 16]);
    expect(corner.chunks.every((c) => !c.mesh.visible)).toBe(true);
    expect(t.blocks.filter((b) => corner.chunks.includes(b.chunks[0])).every((b) => !b.mesh.visible)).toBe(true);
    // Every chunk is drawn exactly once: by itself, its block or its superblock.
    for (const c of t.chunks) {
      const block = t.blocks.find((b) => b.chunks.includes(c));
      const sb = t.superblocks.find((s) => s.chunks.includes(c));
      expect([c.mesh.visible, block?.mesh.visible, sb?.mesh.visible].filter(Boolean)).toHaveLength(1);
      // A merged mesh never draws coarser than its chunk asked for.
      const drawn = c.mesh.visible ? c.shown : block?.mesh.visible === true ? block.drawn : sb?.drawn;
      expect(drawn).not.toBeNull();
      expect(drawn as number).toBeLessThanOrEqual(c.wanted);
      if (!c.mesh.visible) expect(c.wanted).toBeGreaterThanOrEqual(1);
    }
    expect(stats.levels[0] + stats.levels[1] + stats.levels[2]).toBe(stats.meshes);
    expect(stats.meshes).toBeLessThan(80);
    expect(stats.triangles).toBeLessThan(300_000);
    // The low preset's scale pulls the LOD 0 ring in.
    t.setLodScale(0.7);
    const low = t.update({ x: 0, y: 10, z: 0 });
    expect(low.lods[0]).toBeLessThan(stats.lods[0]);
    t.dispose();
  });

  it('builds within the vertex budget, showing the best built coarser level meanwhile, and releases far LOD 0', () => {
    const t = new ChunkedTerrain(field, { buildBudget: 1500 });
    const first = t.update({ x: 0, y: 10, z: 0 });
    expect(first.lods[0]).toBeLessThanOrEqual(2);
    for (let i = 0; i < 60; i++) t.update({ x: 0, y: 10, z: 0 });
    const settled = t.stats;
    expect(settled.lods[0]).toBeGreaterThan(first.lods[0]);
    const center = t.chunks.find((c) => c.bounds.minX <= 0 && c.bounds.maxX >= 0 && c.bounds.minZ <= 0 && c.bounds.maxZ >= 0);
    expect(center?.geometries[0]).not.toBeNull();
    // The LOD 1 ring's merged groups were built lazily too, and draw at LOD 1.
    const lod1Groups = [...t.blocks, ...t.superblocks].filter((g) => g.geometries[1] !== null);
    expect(lod1Groups.length).toBeGreaterThan(0);
    expect([...t.blocks, ...t.superblocks].some((g) => g.drawn === 1 && g.mesh.visible)).toBe(true);
    for (let i = 0; i < 5; i++) t.update({ x: 540, y: 10, z: 540 });
    expect(center?.geometries[0]).toBeNull();
    expect(center?.shown).toBe(2);
    // Far from the camera the LOD 1 merges are released again.
    const near = lod1Groups.filter((g) => g.bounds.maxX < 0 && g.bounds.maxZ < 0);
    expect(near.length).toBeGreaterThan(0);
    for (const g of near) expect(g.geometries[1]).toBeNull();
    t.dispose();
  });

  it('uses the shared terrain material with the strata patch and its own program key', () => {
    const m = terrainMaterial();
    expect(terrainMaterial()).toBe(m);
    expect(m.customProgramCacheKey()).toBe(TERRAIN_PROGRAM_KEY);
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.toon.vertexShader, fragmentShader: THREE.ShaderLib.toon.fragmentShader };
    m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute float aStrata');
    expect(shader.fragmentShader).toContain('uStrataPeriod');
    expect(shader.fragmentShader).toContain('fogCap'); // the toon patch still runs first
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['uStrataPeriod', 'uRimColor', 'fogCap']));
    expect(() => patchStrataVertex('void main() {}')).toThrow();
    expect(() => patchStrataFragment('void main() {}')).toThrow();
  });
});
