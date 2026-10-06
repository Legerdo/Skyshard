import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAMERA_FOV_DEG } from '../../../src/camera/constants';
import { POIS } from '../../../src/data/pois';
import {
  MAX_VEGETATION_DENSITY, ROCK_VARIANTS, TREE_ARCHETYPES, VEGETATION_DISTANCES, VEGETATION_KINDS, VEGETATION_REGIONS, VEGETATION_RULES,
  VEGETATION_STEPS, VEGETATION_WIND, type VegetationKind,
} from '../../../src/data/vegetation';
import { VILLAGE_BUILDINGS, VILLAGE_CENTER } from '../../../src/data/village';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { chunkOf } from '../../../src/render/props/propBatcher';
import { gridCoord, terrainChunkSpecs, type TerrainChunkSpec } from '../../../src/render/terrainMesh';
import { sharedMaterial } from '../../../src/render/toonMaterial';
import { createTerrainView } from '../../../src/render/terrainView';
import { geometryTriangles, vegetationGeometry } from '../../../src/render/vegetation/geometries';
import { worldKeepOuts } from '../../../src/render/vegetation/keepOuts';
import { createPlacementEnv, decodeVariant, keptCount, placeChunk, REC, RECORD_STRIDE } from '../../../src/render/vegetation/placement';
import { VegetationSystem } from '../../../src/render/vegetation/vegetationSystem';
import {
  patchWindVertex, setVegetationBend, VEGETATION_PROGRAM_KEY, VEGETATION_UNIFORMS, vegetationMaterial,
} from '../../../src/render/vegetation/windMaterial';
import { defaultSettings, SettingsStore } from '../../../src/settings/settings';
import { buildTerrain, distanceToPath, PATH_HALF_WIDTH } from '../../../src/world/terrain';

// Task 18.4: instanced vegetation (Req 39.4, 39.5, 38.1, 38.5): deterministic placement, the density steps, the
// surface rules (water, slope, keep-outs, paths), the draw distances, box culling, far blocks, wind / bend and the live
// vegetation setting that refills only the chunks in view. Sampled chunks of the real seeded terrain.

const SEED = 20240601;
const terrain = buildTerrain(SEED);
const env = createPlacementEnv(SEED);
const specs = terrainChunkSpecs();
const specAt = (x: number, z: number): TerrainChunkSpec => {
  const { cx, cz } = chunkOf(x, z);
  return specs.find((s) => s.cx === cx && s.cz === cz) as TerrainChunkSpec;
};

/** Each record of `records` as an object. */
function each(records: Float32Array): { x: number; y: number; z: number; keep: number; variant: number; scale: number }[] {
  const out = [];
  for (let r = 0; r < records.length; r += RECORD_STRIDE) {
    out.push({
      x: records[r + REC.x] as number, y: records[r + REC.y] as number, z: records[r + REC.z] as number, keep: records[r + REC.keep] as number,
      variant: records[r + REC.variant] as number, scale: records[r + REC.scale] as number,
    });
  }
  return out;
}

const VILLAGE = specAt(VILLAGE_CENTER.x, VILLAGE_CENTER.z);
const SAMPLES: readonly TerrainChunkSpec[] = [
  VILLAGE, specAt(VILLAGE_CENTER.x + 40, VILLAGE_CENTER.z), specAt(LOCATIONS.lm_elderbough.x, LOCATIONS.lm_elderbough.z),
  specAt(LOCATIONS.camp_durga.x, LOCATIONS.camp_durga.z), specAt(LOCATIONS.camp_oriel.x, LOCATIONS.camp_oriel.z),
  specAt(LOCATIONS.ws_crater.x, LOCATIONS.ws_crater.z),
];

describe('placement', () => {
  it('is deterministic: the same seed places the same instances, another seed others', () => {
    for (const spec of SAMPLES.slice(0, 3)) {
      for (const kind of VEGETATION_KINDS) {
        const a = placeChunk(terrain, spec, kind, env);
        const b = placeChunk(terrain, spec, kind, createPlacementEnv(SEED));
        expect(Array.from(b), `${kind} ${spec.cx},${spec.cz}`).toEqual(Array.from(a));
      }
    }
    const grass = placeChunk(terrain, SAMPLES[1] as TerrainChunkSpec, 'grass', env);
    expect(grass.length).toBeGreaterThan(0);
    expect(Array.from(placeChunk(terrain, SAMPLES[1] as TerrainChunkSpec, 'grass', createPlacementEnv(SEED + 1)))).not.toEqual(Array.from(grass));
  });

  it('keeps 0.4 / 1.0 / 1.6 × of the candidates as nested subsets (keep value below density ÷ 1.6)', () => {
    const records = placeChunk(terrain, SAMPLES[1] as TerrainChunkSpec, 'grass', env);
    const total = records.length / RECORD_STRIDE;
    expect(total).toBeGreaterThan(300);
    const [low, medium, high] = (['low', 'medium', 'high'] as const).map((s) => keptCount(records, VEGETATION_STEPS[s].density));
    expect(high).toBe(total);
    expect(low / total).toBeCloseTo(0.4 / MAX_VEGETATION_DENSITY, 1);
    expect(medium / total).toBeCloseTo(1 / MAX_VEGETATION_DENSITY, 1);
    expect(low).toBeLessThan(medium);
    // Lower steps are subsets: every record kept at low is kept at medium.
    for (const r of each(records)) if (r.keep < 0.4 / MAX_VEGETATION_DENSITY) expect(r.keep).toBeLessThan(1 / MAX_VEGETATION_DENSITY);
    expect(VEGETATION_STEPS).toEqual({ low: { density: 0.4, grassDistance: 45 }, medium: { density: 1, grassDistance: 70 }, high: { density: 1.6, grassDistance: 90 } });
  });

  it('never places on water or on ground steeper than the kind allows', () => {
    const wet = [specAt(-380, 230), specAt(-200, -300), specAt(-160, -300)]; // pond_verdant, lake_azure
    let sampledWater = 0;
    for (const spec of wet) {
      for (let x = gridCoord(spec.ix0); x < gridCoord(spec.ix0 + spec.quadsX); x += 4) {
        for (let z = gridCoord(spec.iz0); z < gridCoord(spec.iz0 + spec.quadsZ); z += 4) if (terrain.waterDepthAt(x, z) > 0) sampledWater++;
      }
      for (const kind of VEGETATION_KINDS) {
        for (const r of each(placeChunk(terrain, spec, kind, env))) expect(terrain.waterDepthAt(r.x, r.z), `${kind} in water`).toBe(0);
      }
    }
    expect(sampledWater).toBeGreaterThan(50); // the sample chunks really hold water
    const steep = [specAt(LOCATIONS.cinderspire_base.x, LOCATIONS.cinderspire_base.z), specAt(LOCATIONS.breezewatch.x, LOCATIONS.breezewatch.z), ...SAMPLES];
    for (const spec of steep) {
      for (const kind of VEGETATION_KINDS) {
        const limit = VEGETATION_RULES[kind].maxSlopeDeg;
        for (const r of each(placeChunk(terrain, spec, kind, env))) {
          const slope = (Math.acos(Math.min(1, terrain.normalAt(r.x, r.z).y)) * 180) / Math.PI;
          expect(slope, `${kind} at ${r.x.toFixed(1)},${r.z.toFixed(1)}`).toBeLessThanOrEqual(limit + 1e-6);
          expect(r.y).toBeCloseTo(terrain.heightAt(r.x, r.z), 3);
        }
      }
    }
  });

  it('keeps clear of the village buildings (plaza_step included), the dirt paths and the POIs', () => {
    expect(VILLAGE_BUILDINGS.some((b) => b.id === 'plaza_step')).toBe(true);
    expect(worldKeepOuts().some((k) => k.id === 'plaza_step')).toBe(true);
    const village = [VILLAGE, ...[[-30, 0], [30, 0], [0, -30], [0, 30]].map(([dx, dz]) => specAt(VILLAGE_CENTER.x + (dx as number), VILLAGE_CENTER.z + (dz as number)))];
    const chunks = [...new Set([...village, SAMPLES[2] as TerrainChunkSpec, SAMPLES[3] as TerrainChunkSpec])];
    let placed = 0;
    let stepChecked = false;
    for (const spec of chunks) {
      const x0 = gridCoord(spec.ix0) - 12;
      const x1 = gridCoord(spec.ix0 + spec.quadsX) + 12;
      const z0 = gridCoord(spec.iz0) - 12;
      const z1 = gridCoord(spec.iz0 + spec.quadsZ) + 12;
      const pois = POIS.filter((p) => p.pos.x > x0 && p.pos.x < x1 && p.pos.z > z0 && p.pos.z < z1);
      const buildings = VILLAGE_BUILDINGS.filter((b) => b.center.x > x0 && b.center.x < x1 && b.center.z > z0 && b.center.z < z1);
      if (buildings.some((b) => b.id === 'plaza_step')) stepChecked = true;
      for (const kind of VEGETATION_KINDS) {
        const rule = VEGETATION_RULES[kind];
        // Every tall instance, every third grass / flower one (the dense kinds).
        const stride = kind === 'grass' || kind === 'flower' ? 3 : 1;
        for (const [i, r] of each(placeChunk(terrain, spec, kind, env)).entries()) {
          if (i % stride !== 0) continue;
          placed++;
          for (const b of buildings) {
            // The footprint in its own axes (the world → local inverse of the core/math yaw).
            const dx = r.x - b.center.x;
            const dz = r.z - b.center.z;
            const lx = Math.abs(dx * Math.cos(b.yaw) - dz * Math.sin(b.yaw)) - b.half.x;
            const lz = Math.abs(dx * Math.sin(b.yaw) + dz * Math.cos(b.yaw)) - b.half.z;
            expect(Math.max(lx, lz), `${kind} in ${b.id}`).toBeGreaterThanOrEqual(0);
          }
          expect(distanceToPath(r.x, r.z), `${kind} on a path`).toBeGreaterThanOrEqual(PATH_HALF_WIDTH + rule.pathClearance - 1e-6);
          for (const p of pois) expect(Math.hypot(r.x - p.pos.x, r.z - p.pos.z), `${kind} on ${p.id}`).toBeGreaterThanOrEqual(Math.max(1, p.radius) + 0.5);
        }
      }
    }
    expect(placed).toBeGreaterThan(500);
    expect(stepChecked).toBe(true);
  });

  it('draws six rock variants and three tree archetypes per Region with a lighter far LOD', () => {
    const rocks = Array.from({ length: ROCK_VARIANTS }, (_, v) => vegetationGeometry(`rock:${v}`));
    expect(new Set(rocks.map((g) => Array.from(g.getAttribute('position').array.slice(0, 9)).join())).size).toBe(6);
    expect(geometryTriangles(vegetationGeometry('rock:far'))).toBeLessThan(geometryTriangles(rocks[0] as THREE.BufferGeometry));
    for (const region of VEGETATION_REGIONS) {
      expect(TREE_ARCHETYPES[region]).toHaveLength(3);
      for (let a = 0; a < 3; a++) {
        const near = vegetationGeometry(`tree:${region}:${a}:near`);
        const far = vegetationGeometry(`tree:${region}:${a}:far`);
        expect(geometryTriangles(far), `${region} ${a}`).toBeLessThan(geometryTriangles(near));
      }
    }
    // Crossed-card grass: its sway weights rise from 0 at the base.
    const grass = vegetationGeometry('grass');
    const pos = grass.getAttribute('position');
    const sway = grass.getAttribute('aSway');
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) < 1e-6) expect(sway.getX(i)).toBe(0);
      else expect(sway.getX(i)).toBeGreaterThan(0);
    }
  });
});

describe('wind and bend', () => {
  it('sways by height and lays grass down within 1 m of the character, on the shared foliage material', () => {
    const m = vegetationMaterial();
    expect(vegetationMaterial()).toBe(m);
    expect(m.customProgramCacheKey()).toBe(VEGETATION_PROGRAM_KEY);
    const vertex = patchWindVertex(THREE.ShaderLib.toon.vertexShader);
    expect(vertex).toContain('attribute vec2 aSway');
    expect(vertex).toContain('uWindStrength * aSway.x');
    expect(vertex).toContain('uBendRadius');
    expect(VEGETATION_UNIFORMS.uBendRadius.value).toBe(VEGETATION_WIND.bendRadius);
    expect(VEGETATION_WIND.bendRadius).toBe(1);
    setVegetationBend(12.5, { x: 3, y: 4, z: 5 }, 3, 4);
    expect([VEGETATION_UNIFORMS.uWindTime.value, VEGETATION_UNIFORMS.uBendPos.value.toArray(), VEGETATION_UNIFORMS.uBendDir.value.toArray()])
      .toEqual([12.5, [3, 4, 5], [0.6, 0.8]]);
    setVegetationBend(13, null);
    expect(VEGETATION_UNIFORMS.uBendPos.value.y).toBeLessThan(-1000);
  });
});

/** A gameplay-like camera at the plaza looking along `yaw` (0 = +z). */
function plazaCamera(yaw: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 16 / 9, 0.1, 2200);
  const y = terrain.heightAt(VILLAGE_CENTER.x, VILLAGE_CENTER.z) + 3;
  camera.position.set(VILLAGE_CENTER.x, y, VILLAGE_CENTER.z);
  camera.lookAt(VILLAGE_CENTER.x + Math.sin(yaw) * 10, y - 1, VILLAGE_CENTER.z + Math.cos(yaw) * 10);
  camera.updateMatrixWorld();
  return camera;
}

const nearReach = (kind: VegetationKind, grass: number): number =>
  kind === 'grass' || kind === 'flower' ? grass : kind === 'bush' ? VEGETATION_DISTANCES.bush : kind === 'rock' ? VEGETATION_DISTANCES.rockNear : VEGETATION_DISTANCES.treeNear;

describe('VegetationSystem', () => {
  it('culls by chunk box, shows each kind within its distance and draws far trees and rocks per far block', () => {
    const veg = new VegetationSystem(terrain, { seed: SEED, step: 'medium' });
    const stats = veg.prewarm(plazaCamera(Math.PI / 2));
    expect(stats.drawCalls).toBeGreaterThan(10);
    expect(stats.drawCalls).toBeLessThanOrEqual(140);
    for (const chunk of veg.chunks) {
      for (const [kind, batches] of chunk.batches) {
        for (const b of batches) {
          if (!b.mesh.visible) continue;
          expect(chunk.inFrustum).toBe(true);
          expect(chunk.distance).toBeLessThan(nearReach(kind, 70));
          expect(b.mesh.material).toBe(kind === 'rock' ? sharedMaterial('rock') : vegetationMaterial());
          expect(b.mesh.castShadow).toBe(false);
        }
      }
    }
    // Far blocks: one instanced mesh per far geometry; visible ones hold only chunks in their far ring.
    const far = veg.blocks.flatMap((b) => [...b.far.values()].filter((f) => f.mesh.visible).map((f) => ({ block: b, mesh: f.mesh })));
    expect(far.length).toBeGreaterThan(0);
    for (const { block, mesh } of far) {
      expect(block.inFrustum).toBe(true);
      expect(mesh.name.includes(':far')).toBe(true);
    }
    const kinds = new Set(far.map((f) => f.mesh.name.split(':')[1]));
    expect(kinds).toEqual(new Set(['rock', 'tree']));
    // Behind the camera nothing draws.
    const behind = veg.chunks.filter((c) => !c.inFrustum && c.batches.size > 0);
    expect(behind.length).toBeGreaterThan(0);
    for (const c of behind) for (const batches of c.batches.values()) for (const b of batches) expect(b.mesh.visible).toBe(false);
    veg.dispose();
  });

  it('applies the grass distance of each step (45 / 70 / 90 m) and scales the instance counts', () => {
    const drawn = (step: 'low' | 'medium' | 'high'): { far: number; grass: number } => {
      const veg = new VegetationSystem(terrain, { seed: SEED, step });
      veg.prewarm(plazaCamera(Math.PI / 2));
      let far = 0;
      let grass = 0;
      for (const c of veg.chunks) {
        for (const b of c.batches.get('grass') ?? []) {
          if (!b.mesh.visible) continue;
          far = Math.max(far, c.distance);
          grass += b.mesh.count;
        }
      }
      veg.dispose();
      return { far, grass };
    };
    const low = drawn('low');
    const medium = drawn('medium');
    const high = drawn('high');
    expect(low.far).toBeLessThan(45);
    expect(medium.far).toBeLessThan(70);
    expect(high.far).toBeLessThan(90);
    expect(high.far).toBeGreaterThan(45);
    expect(low.grass).toBeLessThan(medium.grass);
    expect(medium.grass).toBeLessThan(high.grass);
  });

  it('refills only the chunks and far blocks in view on a settings change; the others catch up once in view', () => {
    const veg = new VegetationSystem(terrain, { seed: SEED, step: 'medium' });
    veg.prewarm(plazaCamera(Math.PI / 2));
    const built = veg.chunks.filter((c) => c.batches.size > 0);
    const inView = built.filter((c) => c.inFrustum);
    const outOfView = built.filter((c) => !c.inFrustum);
    expect(inView.length).toBeGreaterThan(0);
    expect(outOfView.length).toBeGreaterThan(0);
    const blockSigs = new Map(veg.blocks.map((b) => [b, b.signature.get('tree')]));
    expect(veg.setStep('low')).toBe(inView.length);
    const counted = (c: (typeof built)[number], kind: VegetationKind, density: number): void => {
      expect(veg.countOf(c, kind), `${kind} ${c.spec.cx},${c.spec.cz}`).toBe(keptCount(veg.recordsOf(c, kind), density));
    };
    for (const c of inView) for (const kind of c.batches.keys()) counted(c, kind, 0.4);
    for (const c of outOfView) for (const kind of c.batches.keys()) counted(c, kind, 1);
    // The far blocks refill on the next update, the ones in view only.
    const next = veg.update(plazaCamera(Math.PI / 2), 0);
    expect(next.refilled).toBeGreaterThan(0);
    for (const b of veg.blocks) {
      const sig = b.signature.get('tree');
      if (sig === undefined || sig === '') continue;
      if (b.inFrustum) expect(sig.startsWith('0.4|')).toBe(true);
      else expect(sig).toBe(blockSigs.get(b));
    }
    // Turning round brings the others into view: they draw the new step at once.
    veg.update(plazaCamera(-Math.PI / 2), 0);
    let caught = 0;
    for (const c of outOfView) {
      if (!c.inFrustum) continue;
      for (const kind of c.batches.keys()) {
        if (c.distance >= nearReach(kind, 45)) continue;
        counted(c, kind, 0.4);
        caught++;
      }
    }
    expect(caught).toBeGreaterThan(0);
    veg.dispose();
  });

  it('follows the Settings vegetation step and the preset terrain LOD scale live through the terrain view', () => {
    const settings = new SettingsStore(defaultSettings());
    const view = createTerrainView(terrain, { settings, props: false });
    expect([view.vegetation?.step, view.terrain.lodScale]).toEqual(['medium', 1]);
    settings.set({ vegetation: 'high' });
    expect(view.vegetation?.step).toBe('high');
    expect(view.vegetation?.settings).toEqual({ density: 1.6, grassDistance: 90 });
    settings.set({ qualityPreset: 'low' });
    expect([view.vegetation?.step, view.terrain.lodScale]).toEqual(['low', 0.7]);
    view.dispose();
  });

  it('decodes the Region of every placed tree into one of its three archetypes', () => {
    for (const spec of SAMPLES) {
      for (const r of each(placeChunk(terrain, spec, 'tree', env))) {
        const v = decodeVariant(r.variant);
        expect(VEGETATION_REGIONS).toContain(v.region);
        expect(v.sub).toBeLessThan(3);
      }
    }
  });
});
