import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { REGION_IDS } from '../../../src/data/ids';
import { VILLAGE_CENTER } from '../../../src/data/village';
import { BLIGHT_PURIFY_SECONDS } from '../../../src/logic/worldChange';
import { MIN_BLOCKING_PROP_HEIGHT } from '../../../src/physics/decor';
import {
  addBlightAttributes, BLIGHT_PROGRAM_KEY, BLIGHT_UNIFORMS, BlightView, blightSurfaceMaterial, createBlightVeilMaterial, crystalGeometry,
  patchBlightFragment, patchBlightVertex, vineGeometry,
} from '../../../src/render/blight';
import { BLIGHT_MAX_DECOR_HEIGHT, BLIGHT_MAX_SLOPE_DEG, blightLayout, VINE_MAX_SCALE, type BlightSite } from '../../../src/render/blightLayout';
import { BLIGHT_BARRIER_INDEX, BLIGHT_REGION_INDEX, BlightState } from '../../../src/render/blightState';
import { patchToonFragment, sharedMaterial } from '../../../src/render/toonMaterial';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Task 18.5: Blight strength per Region (instant on load, 3 s purification), where it grows (no climbable Blight
// surface), the one shared Blight material and the veil variant, and the view's purification on the bus events.

const gs = (skyshards: 0 | 1 | 2 | 3, gameCompleted = false) => ({ skyshards, gameCompleted });

describe('BlightState purification timing', () => {
  it('starts from GameState at once: a loaded save shows its purified Regions without a fade', () => {
    const s = new BlightState(gs(2));
    expect(s.strength('verdant')).toBe(0);
    expect(s.strength('ember')).toBe(0);
    expect(s.strength('azure')).toBe(1);
    expect(s.strength('crater')).toBe(1);
    expect(s.strength('sanctum')).toBe(1);
    expect(s.strengths[BLIGHT_BARRIER_INDEX]).toBe(1);
    expect(new BlightState(gs(3, true)).strengths.slice(0, REGION_IDS.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it('fades a newly purified Region to 0 over exactly BLIGHT_PURIFY_SECONDS (3 s), the others untouched', () => {
    expect(BLIGHT_PURIFY_SECONDS).toBe(3);
    const s = new BlightState(gs(0));
    const progress = gs(1);
    const dt = 1 / 60;
    let t = 0;
    let fading = s.update(0, progress);
    expect(s.strength('verdant')).toBe(1);
    while (t < 1.5 - 1e-9) {
      fading = s.update(dt, progress);
      t += dt;
    }
    expect(fading).toEqual(['verdant']);
    expect(s.strength('verdant')).toBeCloseTo(0.5, 6);
    expect(s.strength('ember')).toBe(1);
    while (t < 2.99) {
      s.update(dt, progress);
      t += dt;
    }
    expect(s.strength('verdant')).toBeGreaterThan(0);
    s.update(0.02, progress);
    expect(s.strength('verdant')).toBe(0);
    expect(s.update(dt, progress)).toEqual([]);
  });

  it('jumps up at once for an earlier save, and clears every Region on blight_cleared', () => {
    const s = new BlightState(gs(3));
    s.update(0.016, gs(0));
    expect(s.strength('verdant')).toBe(1);
    s.clearAll();
    s.update(1.5, gs(3));
    expect(s.strength('crater')).toBeCloseTo(0.5, 6);
    expect(s.strength('sanctum')).toBeCloseTo(0.5, 6);
    s.update(1.5, gs(3)); // gameCompleted is not set yet: the clear holds anyway
    expect(s.strengths.slice(0, REGION_IDS.length)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('Blight layout', () => {
  let terrain: TerrainField;
  let sites: BlightSite[];
  beforeAll(() => {
    terrain = buildTerrain(1);
    sites = blightLayout(terrain);
  });

  it('is deterministic in the terrain seed and covers every ground Region', () => {
    const again = blightLayout(terrain);
    expect(again).toEqual(sites);
    for (const region of ['verdant', 'ember', 'azure', 'crater'] as const) {
      expect(sites.filter((s) => s.region === region).length, region).toBeGreaterThanOrEqual(10);
    }
    expect(sites.some((s) => s.region === 'sanctum')).toBe(false);
  });

  it('never makes a climbable Blight surface: every decoration is under the blocking-prop height, patches on gentle ground', () => {
    expect(BLIGHT_MAX_DECOR_HEIGHT).toBeLessThan(MIN_BLOCKING_PROP_HEIGHT);
    const crystal = crystalGeometry();
    crystal.computeBoundingBox();
    const vine = vineGeometry();
    vine.computeBoundingBox();
    expect(crystal.boundingBox?.max.y).toBeCloseTo(1, 6); // instance scale y = the crystal's height
    expect((vine.boundingBox?.max.y ?? Infinity) * VINE_MAX_SCALE).toBeLessThan(MIN_BLOCKING_PROP_HEIGHT);
    for (const s of sites) {
      expect(terrain.slopeDeg(s.x, s.z)).toBeLessThanOrEqual(BLIGHT_MAX_SLOPE_DEG);
      expect(terrain.waterDepthAt(s.x, s.z)).toBe(0);
      for (const c of s.crystals) expect(c.height).toBeLessThanOrEqual(BLIGHT_MAX_DECOR_HEIGHT);
      for (const v of s.vines) expect(v.scale).toBeLessThanOrEqual(VINE_MAX_SCALE);
      expect(Math.hypot(s.x - VILLAGE_CENTER.x, s.z - VILLAGE_CENTER.z)).toBeGreaterThan(60);
    }
  });
});

describe('the one Blight material', () => {
  it('patches the shared blight toon instance once, with its own program key and the shared uniforms', () => {
    const m = blightSurfaceMaterial();
    expect(m).toBe(sharedMaterial('blight'));
    expect(blightSurfaceMaterial()).toBe(m);
    expect(m.customProgramCacheKey()).toBe(BLIGHT_PROGRAM_KEY);
    const veil = createBlightVeilMaterial(0.3);
    expect(veil).not.toBe(m);
    expect(veil.customProgramCacheKey()).toBe(BLIGHT_PROGRAM_KEY);
    expect(veil.transparent && veil.depthWrite === false && veil.side === THREE.DoubleSide).toBe(true);
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.toon.vertexShader,
      fragmentShader: THREE.ShaderLib.toon.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    veil.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.uBlightStrength).toBe(BLIGHT_UNIFORMS.uBlightStrength);
    expect((shader.uniforms.uVeil as THREE.IUniform<number>).value).toBe(1);
    expect(shader.fragmentShader).toContain('discard');
    expect(shader.fragmentShader).toContain('uRimColor'); // the toon patch still ran
  });

  it('applies to the three.js toon shader chunks', () => {
    expect(() => patchBlightVertex(THREE.ShaderLib.toon.vertexShader)).not.toThrow();
    expect(() => patchBlightFragment(patchToonFragment(THREE.ShaderLib.toon.fragmentShader))).not.toThrow();
  });

  it('addBlightAttributes gives every vertex a colour and (mask, slot, seed)', () => {
    const g = addBlightAttributes(new THREE.BoxGeometry(1, 1, 1), 0x8a4dd6, BLIGHT_REGION_INDEX.ember, 0.5, 3);
    const a = g.getAttribute('aBlight');
    expect(a.count).toBe(g.getAttribute('position').count);
    expect([a.getX(0), a.getY(0), a.getZ(0)]).toEqual([0.5, BLIGHT_REGION_INDEX.ember, 3]);
    expect(g.getAttribute('color').count).toBe(a.count);
  });
});

describe('BlightView', () => {
  it('hides purified Regions, fades on skyshard:acquired with sparkles and clears everything on blight_cleared', () => {
    const terrain = buildTerrain(1);
    const bus = createGameEventBus();
    const state = gs(0);
    const bursts: unknown[] = [];
    const view = new BlightView({ terrain, bus, progress: () => state, burst: (spec, at) => bursts.push({ spec, at }) });
    const camera = new THREE.PerspectiveCamera();
    const verdant = view.sites.find((s) => s.region === 'verdant');
    if (verdant === undefined) throw new Error('no verdant site');
    camera.position.set(verdant.x, verdant.y + 2, verdant.z);
    camera.updateMatrixWorld();
    view.update(0.016, camera);
    const strength = (region: keyof typeof BLIGHT_REGION_INDEX): number => BLIGHT_UNIFORMS.uBlightStrength.value[BLIGHT_REGION_INDEX[region]];
    // Three draw calls for every Region: crystals and vines instanced with the Region slot per instance, merged patches.
    expect(view.meshes.map((m) => m.name)).toEqual(['blight:crystals', 'blight:vines', 'blight:patches']);
    const crystals = view.meshes[0] as THREE.InstancedMesh;
    const slots = crystals.geometry.getAttribute('aBlight') as THREE.InstancedBufferAttribute;
    expect(slots.count).toBe(crystals.count);
    expect(new Set(Array.from({ length: slots.count }, (_, i) => slots.getY(i)))).toEqual(
      new Set(['verdant', 'ember', 'azure', 'crater'].map((r) => BLIGHT_REGION_INDEX[r as 'verdant'])),
    );
    expect(view.meshes.every((m) => m.visible)).toBe(true);
    expect(view.instanceCount('verdant')).toBeGreaterThan(0);
    expect(strength('verdant')).toBe(1);

    state.skyshards = 1;
    bus.emit('skyshard:acquired', { index: 1, regionId: 'verdant' });
    bus.dispatch();
    expect(bursts.length).toBeGreaterThan(0);
    for (let i = 0; i < 90; i++) view.update(1 / 60, camera);
    expect(strength('verdant')).toBeCloseTo(0.5, 5);
    for (let i = 0; i < 95; i++) view.update(1 / 60, camera);
    expect(strength('verdant')).toBe(0);
    expect(strength('crater')).toBe(1);
    expect(view.meshes.every((m) => m.visible)).toBe(true);

    bus.emit('cinematic:event', { cinematicId: 'cin_ending', kind: 'worldChange', key: 'blight_cleared' });
    bus.dispatch();
    for (let i = 0; i < 200; i++) view.update(1 / 60, camera);
    expect(REGION_IDS.map((r) => strength(r))).toEqual([0, 0, 0, 0, 0]);
    expect(view.meshes.every((m) => !m.visible)).toBe(true);
    view.dispose();
  });

  it('starts purified Regions at strength 0 on load (no fade, no sparkles)', () => {
    const bursts: unknown[] = [];
    const view = new BlightView({ terrain: buildTerrain(1), bus: createGameEventBus(), progress: () => gs(2), burst: () => bursts.push(1) });
    expect(BLIGHT_UNIFORMS.uBlightStrength.value[BLIGHT_REGION_INDEX.ember]).toBe(0);
    view.update(0.016, new THREE.PerspectiveCamera());
    expect(view.state.strength('verdant')).toBe(0);
    expect(view.state.strength('ember')).toBe(0);
    expect(view.state.strength('azure')).toBe(1);
    expect(bursts).toEqual([]);
    view.dispose();
  });
});
