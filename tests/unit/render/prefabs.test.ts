import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CHALLENGE_AREA_DEFS } from '../../../src/data/challengeAreas';
import { SANCTUM } from '../../../src/data/sanctum';
import { TEMP_PIECES } from '../../../src/data/tempRoute';
import { NPC_PLACEMENTS, VILLAGE_BUILDINGS } from '../../../src/data/village';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { villageLook } from '../../../src/logic/village';
import { PartBuilder, prefabMaterial, trianglesOf, trs } from '../../../src/render/prefabs/kit';
import {
  brokenBridge, elderboughBase, observatory, sanctum, shrine, spire, thistlewickHouse, windmillStand,
} from '../../../src/render/prefabs/keyLocations';
import { ChunkBatcher, chunkOf } from '../../../src/render/props/propBatcher';
import { villagePropSpots } from '../../../src/render/props/villagePropLayout';
import { sharedMaterial } from '../../../src/render/toonMaterial';
import { TempVillageView } from '../../../src/render/tempVillageView';
import { createTerrainView } from '../../../src/render/terrainView';
import type { TerrainSurface } from '../../../src/render/terrainMesh';

// Task 18.4: the eight key-location prefabs (Req 39.3, 8.3–8.5) and the per-chunk prop merge (Req 38.5), built in Node.

const FLAT: TerrainSurface = { heightAt: () => 18, normalAt: () => new THREE.Vector3(0, 1, 0), materialAt: () => 'grass' };

const piece = (id: string) => {
  const p = TEMP_PIECES.find((q) => q.id === id);
  if (p === undefined) throw new Error(`no piece ${id}`);
  return p;
};

/** Every prefab: name, its geometries (body first; glows / trims after) and the triangle budget of all of them. */
function prefabs(): { name: string; parts: THREE.BufferGeometry[]; budget: number }[] {
  const tower = piece('bw_tower');
  const top = piece('bw_top');
  const bridge = piece('bridge_plank');
  if (tower.shape.kind !== 'cylinder' || top.shape.kind !== 'box' || bridge.shape.kind !== 'obb') throw new Error('piece shapes changed');
  const area = (id: string) => {
    const def = CHALLENGE_AREA_DEFS.find((d) => d.id === id);
    if (def === undefined) throw new Error(`no area ${id}`);
    return def;
  };
  const areaParts = (p: { body: THREE.BufferGeometry; glows: readonly { geometry: THREE.BufferGeometry }[] }): THREE.BufferGeometry[] => [p.body, ...p.glows.map((g) => g.geometry)];
  const houses = VILLAGE_BUILDINGS.filter((b) => b.kind === 'house' || b.kind === 'marenHouse');
  const sanc = sanctum(SANCTUM);
  return [
    ...houses.map((b) => ({ name: `house ${b.id}`, parts: [thistlewickHouse(b)], budget: 3_500 })),
    { name: 'windmill', parts: [windmillStand({ tower: tower.shape, top: top.shape })], budget: 2_500 },
    { name: 'elderbough', parts: [elderboughBase({ x: LOCATIONS.lm_elderbough.x - 8, z: LOCATIONS.lm_elderbough.z - 8 }, () => 14)], budget: 4_000 },
    { name: 'shrine', parts: areaParts(shrine(area('hollowroot'))), budget: 12_000 },
    { name: 'spire', parts: areaParts(spire(area('cinderspire'))), budget: 20_000 },
    { name: 'observatory', parts: areaParts(observatory(area('observatory'))), budget: 30_000 },
    { name: 'bridge', parts: [brokenBridge(bridge.shape)], budget: 6_000 },
    { name: 'sanctum', parts: [sanc.body, sanc.trim], budget: 20_000 },
  ];
}

describe('key-location prefabs', () => {
  it('builds all eight kinds deterministically as vertex-coloured, non-indexed geometry within their triangle budgets', () => {
    const a = prefabs();
    const b = prefabs();
    const kinds = new Set(a.map((p) => p.name.split(' ')[0]));
    expect(kinds).toEqual(new Set(['house', 'windmill', 'elderbough', 'shrine', 'spire', 'observatory', 'bridge', 'sanctum']));
    for (const [i, p] of a.entries()) {
      let tris = 0;
      for (const [j, g] of p.parts.entries()) {
        expect(g.index, p.name).toBeNull();
        const count = g.getAttribute('position').count;
        expect([g.getAttribute('normal').count, g.getAttribute('color').count], p.name).toEqual([count, count]);
        tris += trianglesOf(g);
        // Painted: finite and not a single flat colour.
        const colors = g.getAttribute('color').array as Float32Array;
        const distinct = new Set<string>();
        let finite = true;
        for (let k = 0; k < colors.length; k += 3) {
          finite &&= Number.isFinite(colors[k]) && (colors[k] as number) >= 0;
          if (distinct.size < 8) distinct.add(`${(colors[k] as number).toFixed(3)},${(colors[k + 1] as number).toFixed(3)},${(colors[k + 2] as number).toFixed(3)}`);
        }
        expect(finite, p.name).toBe(true);
        if (j === 0) expect(distinct.size, p.name).toBeGreaterThan(1);
        const again = (b[i] as { parts: THREE.BufferGeometry[] }).parts[j] as THREE.BufferGeometry;
        expect(Array.from(g.getAttribute('position').array), p.name).toEqual(Array.from(again.getAttribute('position').array));
      }
      expect(tris, p.name).toBeGreaterThan(300);
      expect(tris, p.name).toBeLessThanOrEqual(p.budget);
    }
  });

  it('never draws a raw primitive: boxes are chamfered, cylinders bevelled', () => {
    const box = new PartBuilder();
    box.box(1, 1, 1, trs(0, 0, 0), 0x808080);
    expect(box.triangles).toBe(44); // a raw box has 12
    const cyl = new PartBuilder();
    cyl.cylinder(0.5, 0.5, 1, 8, trs(0, 0, 0), 0x808080, { bevel: 0.05 });
    expect(cyl.triangles).toBeGreaterThan(8 * 4); // a raw 8-sided cylinder has 32
  });

  it('draws with the shared toon material in the views that place them', () => {
    const material = prefabMaterial();
    expect(material).toBe(sharedMaterial('stone'));
    expect(material.vertexColors).toBe(true);
    // The Elderbough base in the terrain view's props, merged per chunk.
    const view = createTerrainView(FLAT, { vegetation: false });
    const props = view.props.children as THREE.Mesh[];
    expect(props.length).toBeGreaterThan(0);
    for (const m of props) expect(m.material).toBe(material);
    view.dispose();
  });
});

function village(): TempVillageView {
  const gs = createNewGameState(1);
  return new TempVillageView({
    village: { buildings: VILLAGE_BUILDINGS.map((def) => ({ def, baseY: 18 })), look: () => villageLook(gs) },
    npcs: { views: () => NPC_PLACEMENTS.map((p) => ({ id: p.id, pos: { x: p.home.x, y: 18, z: p.home.z }, yaw: p.yaw, anim: p.idle[0] ?? 'idle', present: true, talking: false })) },
    sideQuests: { kiteState: () => 'hanging' },
    heightAt: () => 18,
  });
}

describe('prop merge per chunk', () => {
  it('ChunkBatcher builds one mesh per non-empty 64 m chunk with the shared material', () => {
    const batcher = new ChunkBatcher();
    for (let i = 0; i < 40; i++) batcher.at(-250 + (i % 5), 300 + i * 0.2).boxAt(-250 + (i % 5), 18, 300 + i * 0.2, 0.5, 0.5, 0.5, 0x9c7b4f);
    batcher.at(100, 100).boxAt(100, 0, 100, 1, 1, 1, 0x808080);
    const meshes = batcher.build('test', undefined, false);
    expect(meshes).toHaveLength(2);
    expect(batcher.chunkCount).toBe(2);
    for (const m of meshes) {
      expect(m.material).toBe(prefabMaterial());
      expect(m.castShadow).toBe(false);
    }
  });

  it('merges Thistlewick\'s static parts and small props into about one draw call per chunk', () => {
    const view = village();
    const statics = view.object.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name.startsWith('village:static:'));
    const chunks = new Set<string>();
    for (const s of villagePropSpots()) {
      const c = chunkOf(s.x, s.z);
      chunks.add(`${c.cx}_${c.cz}`);
    }
    for (const b of VILLAGE_BUILDINGS) {
      const c = chunkOf(b.center.x, b.center.z);
      chunks.add(`${c.cx}_${c.cz}`);
    }
    // One static mesh per chunk (none twice), covering every chunk with props or buildings.
    expect(new Set(statics.map((m) => m.name)).size).toBe(statics.length);
    for (const key of chunks) expect(statics.some((m) => m.name === `village:static:${key}`), key).toBe(true);
    // (camp_oriel's stand-ins add their own chunk)
    expect(statics.length).toBeLessThanOrEqual(chunks.size + 1);
    for (const m of statics) expect(m.material).toBe(prefabMaterial());
    // No prop keeps its own mesh: the village draws a handful of meshes besides the NPC rigs and toggled groups.
    let meshes = 0;
    view.object.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes++;
    });
    const npcMeshes = [...NPC_PLACEMENTS].reduce((n, p) => {
      let k = 0;
      view.npcObject(p.id)?.traverse((o) => {
        if (o instanceof THREE.Mesh) k++;
      });
      return n + k;
    }, 0);
    expect(villagePropSpots().length).toBeGreaterThan(20);
    expect(meshes - npcMeshes).toBeLessThanOrEqual(40);
    view.dispose();
  });
});
