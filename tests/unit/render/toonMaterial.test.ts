import * as THREE from 'three';
import { WebGLPrograms } from 'three/src/renderers/webgl/WebGLPrograms.js';
import type { WebGLBindingStates } from 'three/src/renderers/webgl/WebGLBindingStates.js';
import type { WebGLCapabilities } from 'three/src/renderers/webgl/WebGLCapabilities.js';
import type { WebGLClipping } from 'three/src/renderers/webgl/WebGLClipping.js';
import type { WebGLEnvironments } from 'three/src/renderers/webgl/WebGLEnvironments.js';
import type { WebGLExtensions } from 'three/src/renderers/webgl/WebGLExtensions.js';
import type { WebGLLightsState } from 'three/src/renderers/webgl/WebGLLights.js';
import { describe, expect, it } from 'vitest';
import { attachOutline, detachOutline, OUTLINE_TARGETS, outlineOf, sharedOutlineMaterial } from '../../../src/render/outline';
import { bindRenderSettings, pixelRatioFor } from '../../../src/render/renderer';
import {
  createOutlineMaterial, createToonMaterial, isToonMaterial, OUTLINE_PROGRAM_KEY, outlineColorFor, outlineWidthAt,
  patchOutlineVertex, patchToonFragment, setToonFogCap, SHARED_MATERIAL_KINDS, sharedMaterial, sharedMaterialVariant,
  TOON_PROGRAM_KEY, TOON_UNIFORMS, toonFogCap, toonGradient,
} from '../../../src/render/toonMaterial';
import { renderQualityFor } from '../../../src/data/renderQuality';
import { SettingsStore } from '../../../src/settings/settings';

// Task 18.1: the shared toon materials, the inverted-hull outline and the renderer settings, in Node (no WebGL).

/** The shader object three.js hands to onBeforeCompile for a material (uniforms cloned from its ShaderLib entry). */
function compile(material: THREE.Material, lib: 'toon' | 'basic'): THREE.WebGLProgramParametersWithUniforms {
  const source = THREE.ShaderLib[lib];
  const shader = {
    uniforms: THREE.UniformsUtils.clone(source.uniforms),
    vertexShader: source.vertexShader,
    fragmentShader: source.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

/**
 * three.js's own program keying (WebGLPrograms.getParameters → getProgramCacheKey) with a stub renderer: the renderer
 * acquires one program per distinct key, so the number of keys over a scene is its `renderer.info.programs` count.
 */
function programCounter(scene: THREE.Scene) {
  const renderer = {
    getRenderTarget: () => null,
    state: { buffers: { depth: { getReversed: () => false } } },
    toneMapping: THREE.NeutralToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: true, type: THREE.PCFShadowMap },
  } as unknown as THREE.WebGLRenderer;
  const programs = new WebGLPrograms(
    renderer,
    { get: () => null } as unknown as WebGLEnvironments,
    { has: () => false } as unknown as WebGLExtensions,
    { logarithmicDepthBuffer: false, precision: 'highp', getMaxPrecision: () => 'highp' } as unknown as WebGLCapabilities,
    {} as WebGLBindingStates,
    { numPlanes: 0, numIntersection: 0 } as unknown as WebGLClipping,
  );
  const lights = {
    sun: [], directional: [{}], point: [], spot: [], spotLightMap: [], rectArea: [], hemi: [{}], sunShadowMap: [],
    directionalShadowMap: [{}], pointShadowMap: [], spotShadowMap: [], numSpotLightShadowsWithMaps: 0, numLightProbes: 0,
  } as unknown as WebGLLightsState;
  const shadows = [new THREE.DirectionalLight()];
  return (): number => {
    const keys = new Set<string>();
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list as THREE.Material[]) keys.add(programs.getProgramCacheKey(programs.getParameters(m, lights, shadows, scene, o, [])));
    });
    return keys.size;
  };
}

function coloured(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = geometry.getAttribute('position').count;
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.8), 3));
  return geometry;
}

/** A two-bone rigid-skinned box (the shape task 19.1's rigs have). */
function skinnedBox(): THREE.SkinnedMesh {
  const geometry = coloured(new THREE.BoxGeometry(0.5, 1.6, 0.4, 1, 4, 1));
  const pos = geometry.getAttribute('position');
  const index = new Uint16Array(pos.count * 4);
  const weight = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    index[i * 4] = pos.getY(i) > 0 ? 1 : 0;
    weight[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
  const hips = new THREE.Bone();
  const chest = new THREE.Bone();
  chest.position.y = 0.8;
  hips.add(chest);
  const mesh = new THREE.SkinnedMesh(geometry, sharedMaterial('character'));
  mesh.name = 'hero';
  mesh.add(hips);
  mesh.bind(new THREE.Skeleton([hips, chest]));
  return mesh;
}

describe('createToonMaterial', () => {
  it('is a MeshToonMaterial with the 3-step NearestFilter gradient, white colour and vertex-colour albedo', () => {
    const m = createToonMaterial();
    expect(m).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(m.gradientMap).toBe(toonGradient());
    const g = toonGradient();
    expect([g.image.width, g.image.height, g.minFilter, g.magFilter, g.generateMipmaps]).toEqual([3, 1, THREE.NearestFilter, THREE.NearestFilter, false]);
    const data = g.image.data as Uint8Array;
    expect([data[0], data[4], data[8]]).toEqual([90, 170, 255]); // shadow < mid < light
    expect([m.vertexColors, m.color.getHex()]).toEqual([true, 0xffffff]);
    expect(isToonMaterial(m)).toBe(true);
    expect(isToonMaterial(new THREE.MeshToonMaterial())).toBe(false);
  });

  it('injects the fresnel rim, the grading fallback and the capped fog into the toon shader', () => {
    const fragment = patchToonFragment(THREE.ShaderLib.toon.fragmentShader);
    for (const s of ['uniform vec3 uRimColor', 'uniform float uRimPower', 'uniform float uRimStrength', 'uniform float fogCap',
      'fogFactor = min( fogFactor, fogCap )', 'uGradeSaturation', '#include <opaque_fragment>']) expect(fragment).toContain(s);
    expect(fragment).not.toContain('#include <fog_fragment>');
    const m = createToonMaterial({ fogCap: 0.55, rimScale: 2 });
    const shader = compile(m, 'toon');
    expect(shader.fragmentShader).toBe(fragment);
    // The rim / grading uniforms are the one shared set; fogCap and rimScale are this material's.
    expect(shader.uniforms.uRimColor).toBe(TOON_UNIFORMS.uRimColor);
    expect(shader.uniforms.uRimStrength).toBe(TOON_UNIFORMS.uRimStrength);
    expect(shader.uniforms.uGradeTint).toBe(TOON_UNIFORMS.uGradeTint);
    expect([shader.uniforms.fogCap?.value, shader.uniforms.uRimScale?.value]).toEqual([0.55, 2]);
    setToonFogCap(m, 0.3);
    expect([shader.uniforms.fogCap?.value, toonFogCap(m)]).toEqual([0.3, 0.3]); // a uniform: no recompile
  });

  it('defaults the fog cap to 1.0 and clamps it to 0–1', () => {
    expect(toonFogCap(createToonMaterial())).toBe(1);
    expect(toonFogCap(createToonMaterial({ fogCap: 4 }))).toBe(1);
    expect(toonFogCap(createToonMaterial({ fogCap: -1 }))).toBe(0);
    expect(toonFogCap(createToonMaterial({ fogCap: Number.NaN }))).toBe(1);
    expect(toonFogCap(new THREE.MeshBasicMaterial())).toBe(1);
  });

  it('keeps the fixed set of 11 shared instances, one per kind, all toon materials with fog cap 1', () => {
    expect(SHARED_MATERIAL_KINDS).toEqual(['terrain', 'foliage', 'bark', 'rock', 'wood', 'stone', 'crystal', 'blight', 'water', 'character', 'enemy']);
    const all = SHARED_MATERIAL_KINDS.map((k) => sharedMaterial(k));
    expect(new Set(all).size).toBe(11);
    for (const [i, k] of SHARED_MATERIAL_KINDS.entries()) {
      expect(sharedMaterial(k)).toBe(all[i]);
      expect(isToonMaterial(all[i] as THREE.Material)).toBe(true);
      expect(toonFogCap(all[i] as THREE.Material)).toBe(1);
    }
  });

  it('gives every toon material and variant the same program cache key', () => {
    const keys = new Set([
      ...SHARED_MATERIAL_KINDS.map((k) => sharedMaterial(k).customProgramCacheKey()),
      sharedMaterialVariant('character', { emissive: 0xff0000 }).customProgramCacheKey(),
      createToonMaterial({ fogCap: 0.55, rimScale: 0.2 }).customProgramCacheKey(),
    ]);
    expect([...keys]).toEqual([TOON_PROGRAM_KEY]);
    expect(createOutlineMaterial().customProgramCacheKey()).toBe(OUTLINE_PROGRAM_KEY);
  });

  it('adds no shader program as meshes, variants and outlines multiply (renderer.info.programs)', () => {
    const build = (n: number): number => {
      const scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0xffffff, 100, 1000);
      const box = coloured(new THREE.BoxGeometry());
      for (let i = 0; i < n; i++) {
        for (const kind of ['terrain', 'wood', 'stone', 'character', 'enemy'] as const) scene.add(new THREE.Mesh(box, sharedMaterial(kind)));
        // A rig / species variant (own emissive, own fog cap) and an outlined enemy.
        scene.add(new THREE.Mesh(box, sharedMaterialVariant('enemy', { emissive: i * 1000, fogCap: 0.2 + 0.01 * i })));
        const enemy = new THREE.Mesh(box, sharedMaterial('enemy'));
        attachOutline(enemy, 'enemy');
        scene.add(enemy);
        const hero = skinnedBox();
        attachOutline(hero, 'character');
        scene.add(hero);
      }
      return programCounter(scene)();
    };
    const few = build(2);
    expect(build(40)).toBe(few);
    expect(few).toBeLessThanOrEqual(4); // toon, toon skinned, outline, outline skinned
  });
});

describe('inverted-hull outline', () => {
  it('pushes the (skinned) normal 0.02–0.05 m in proportion to the camera distance, on back faces only', () => {
    const vertex = patchOutlineVertex(THREE.ShaderLib.basic.vertexShader);
    expect(vertex.indexOf('outlineWidth')).toBeGreaterThan(vertex.indexOf('#include <skinning_vertex>'));
    expect(vertex).toContain('objectNormal'); // the skinned normal under USE_SKINNING
    const m = createOutlineMaterial();
    expect(m.side).toBe(THREE.BackSide);
    expect(compile(m, 'basic').vertexShader).toBe(vertex);
    expect(outlineWidthAt(0)).toBeCloseTo(0.02, 9);
    expect(outlineWidthAt(8)).toBeCloseTo(0.032, 9);
    expect(outlineWidthAt(500)).toBeCloseTo(0.05, 9);
    let last = 0;
    for (let d = 0; d <= 40; d += 0.5) {
      const w = outlineWidthAt(d);
      expect(w).toBeGreaterThanOrEqual(Math.max(0.02, last));
      expect(w).toBeLessThanOrEqual(0.05);
      last = w;
    }
  });

  it('draws at about 35 % of the base colour', () => {
    const dark = outlineColorFor(0xc05030).getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    expect(dark.r).toBeCloseTo((0xc0 / 255) * 0.35, 4);
    expect(dark.g).toBeCloseTo((0x50 / 255) * 0.35, 4);
    expect(dark.b).toBeCloseTo((0x30 / 255) * 0.35, 4);
    const vc = sharedOutlineMaterial('npc');
    expect(vc.vertexColors).toBe(true);
    expect(vc.color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace).r).toBeCloseTo(0.35, 4);
  });

  it('builds a SkinnedMesh outline sharing the body geometry, Skeleton and bind matrix', () => {
    const body = skinnedBox();
    const outline = attachOutline(body, 'character');
    expect(outline).toBeInstanceOf(THREE.SkinnedMesh);
    const skinned = outline as THREE.SkinnedMesh;
    expect(skinned.geometry).toBe(body.geometry);
    expect(skinned.skeleton).toBe(body.skeleton);
    expect(skinned.bindMatrix.equals(body.bindMatrix)).toBe(true);
    expect(skinned.parent).toBe(body);
    expect([skinned.castShadow, skinned.receiveShadow]).toEqual([false, false]);
    expect((skinned.material as THREE.Material).side).toBe(THREE.BackSide);
    expect(attachOutline(body, 'character')).toBe(outline); // idempotent
    // A held weapon (rigid) gets a plain Mesh outline on the same geometry.
    const blade = new THREE.Mesh(coloured(new THREE.BoxGeometry(0.05, 1, 0.1)), sharedMaterial('character'));
    const bladeOutline = attachOutline(blade, 'weapon', { baseColor: 0x9aa0b0 });
    expect(bladeOutline).not.toBeInstanceOf(THREE.SkinnedMesh);
    expect(bladeOutline.geometry).toBe(blade.geometry);
    detachOutline(blade);
    expect(outlineOf(blade)).toBeNull();
    expect(OUTLINE_TARGETS).toEqual(['character', 'npc', 'enemy', 'caelith', 'weapon']);
  });
});

describe('renderer settings', () => {
  it('uses min(devicePixelRatio, DPR cap) × render scale', () => {
    expect(pixelRatioFor(2, 1, 1)).toBe(1);
    expect(pixelRatioFor(2, 1.5, 1)).toBe(1.5);
    expect(pixelRatioFor(1.25, 1.5, 0.8)).toBeCloseTo(1, 9);
    expect(pixelRatioFor(1, 1, 0.75)).toBe(0.75);
    expect(pixelRatioFor(3, 1.5, 0.2)).toBe(0.75); // render scale floor 50 %
    expect(pixelRatioFor(Number.NaN, 1, 1)).toBe(1);
  });

  it('applies the preset DPR cap and the render scale at once on every Settings change', () => {
    const settings = new SettingsStore();
    const calls: [string, number][] = [];
    const handle = {
      setPixelRatioCap: (cap: number) => calls.push(['cap', cap]),
      setRenderScale: (scale: number) => calls.push(['scale', scale]),
    };
    const off = bindRenderSettings(handle, settings);
    expect(calls).toEqual([['cap', renderQualityFor('medium').dprCap], ['scale', 1]]);
    calls.length = 0;
    settings.set({ qualityPreset: 'high' });
    expect(calls).toEqual([['cap', 1.5], ['scale', 1]]); // synchronous: well inside the 1 s budget
    calls.length = 0;
    settings.set({ renderScale: 0.6 });
    expect(calls).toEqual([['cap', 1.5], ['scale', 0.6]]);
    calls.length = 0;
    settings.set({ qualityPreset: 'low' });
    expect(calls).toEqual([['cap', 1], ['scale', 0.75]]);
    off();
    calls.length = 0;
    settings.set({ renderScale: 0.9 });
    expect(calls).toEqual([]);
  });
});
