import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { terrainMaterial } from '../../../src/render/terrain/terrainMaterial';
import type { TerrainSurface } from '../../../src/render/terrainMesh';
import { createTerrainView } from '../../../src/render/terrainView';

// three.js objects of the world view (tasks 2.8, 18.4), built in Node without a WebGL context.

/** Cheap analytic stand-in for a TerrainField: a gentle slope toward +x. */
const SLOPE: TerrainSurface = {
  heightAt: (x) => 0.1 * x,
  normalAt: () => new Vector3(-0.1, 1, 0).normalize(),
  materialAt: (x) => (x < 0 ? 'grass' : 'rock'),
};

describe('createTerrainView', () => {
  it('builds one culled chunk mesh per 64 m chunk (plus the 2 × 2 blocks and 4 × 4 superblocks), all sharing the terrain material', () => {
    const view = createTerrainView(SLOPE, { vegetation: false });
    expect(view.chunks).toHaveLength(324);
    expect(view.terrain.object.children).toHaveLength(324 + 81 + 25);
    for (const g of [...view.terrain.blocks, ...view.terrain.superblocks]) expect(g.mesh.material).toBe(view.material);
    expect(view.material).toBe(terrainMaterial());
    expect(view.material.vertexColors).toBe(true);
    for (const mesh of view.chunks) {
      const geometry = mesh.geometry;
      const count = geometry.getAttribute('position').count;
      expect(mesh.material).toBe(view.material);
      expect([geometry.getAttribute('normal').count, geometry.getAttribute('color').count, geometry.getAttribute('aStrata').count]).toEqual([count, count, count]);
      expect(geometry.index?.count).toBeGreaterThan(0);
      expect(geometry.boundingSphere?.radius).toBeGreaterThan(0);
      expect(mesh.receiveShadow && mesh.frustumCulled).toBe(true);
    }
    view.dispose();
    expect(view.object.children).toHaveLength(0);
  });
});

// The temporary capsule (TempCharacterView) was replaced by the hero rigs in task 19.2; its facing, fade and hurt
// checks live in tests/unit/visual/visualProvider.test.ts (HeroViews).
