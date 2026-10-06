import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  estimateFrameCost, FRAME_BUDGET, postConfigFor, postPassCount, QUALITY_RESOURCES, qualityResourceDiff, withinFrameBudget,
  type QualityResource, type QualityState,
} from '../../../src/render/qualityApplier';
import { RenderPipeline } from '../../../src/render/pipeline';
import { bloomSizeFor } from '../../../src/render/post';
import { CHARACTER_SHADOW } from '../../../src/render/shadows';
import { createWorldScene } from '../../../src/render/worldScene';
import { QUALITY_PRESETS, SettingsStore, defaultSettings, type QualityPreset, type Settings } from '../../../src/settings/settings';

// Tasks 18.5 / 18.6: which resources a graphics change rebuilds, the post-processing config per preset, the frame
// budget estimate, and the render pipeline applying settings live (a stub renderer: WebGL cannot run in Vitest).

const preset = (p: QualityPreset): QualityState => ({ qualityPreset: p, ...QUALITY_PRESETS[p] });
const sorted = (s: ReadonlySet<QualityResource>): QualityResource[] => [...s].sort();

describe('qualityResourceDiff', () => {
  it('rebuilds everything on the first application', () => {
    expect(sorted(qualityResourceDiff(null, preset('medium')))).toEqual([...QUALITY_RESOURCES].sort());
  });

  it('touches nothing when nothing changed', () => {
    expect(qualityResourceDiff(preset('medium'), preset('medium')).size).toBe(0);
  });

  it('medium → high: DPR cap, shadow map size, full-res bloom, particles, vegetation, LOD; no composer or shadow toggle', () => {
    expect(sorted(qualityResourceDiff(preset('medium'), preset('high')))).toEqual(
      ['bloomSize', 'particleCapacity', 'pixelRatio', 'shadowMap', 'terrainLod', 'vegetation'],
    );
  });

  it('medium → low: render scale, shadows off (pass + material recompile), composer freed, particles, vegetation, LOD', () => {
    expect(sorted(qualityResourceDiff(preset('medium'), preset('low')))).toEqual(
      ['composer', 'particleCapacity', 'pixelRatio', 'shadowToggle', 'sharedMaterials', 'terrainLod', 'vegetation'],
    );
  });

  it('low → medium switches shadows on with a map allocation', () => {
    const diff = qualityResourceDiff(preset('low'), preset('medium'));
    expect(diff.has('shadowToggle') && diff.has('shadowMap') && diff.has('sharedMaterials') && diff.has('composer')).toBe(true);
  });

  it('single overrides rebuild only their own resource', () => {
    const base = preset('medium');
    expect(sorted(qualityResourceDiff(base, { ...base, renderScale: 0.6 }))).toEqual(['pixelRatio']);
    expect(sorted(qualityResourceDiff(base, { ...base, shadows: 'high' }))).toEqual(['shadowMap']);
    expect(sorted(qualityResourceDiff(base, { ...base, postProcessing: false }))).toEqual(['composer']);
    expect(sorted(qualityResourceDiff(base, { ...base, vegetation: 'high' }))).toEqual(['vegetation']);
    expect(sorted(qualityResourceDiff({ ...base, shadows: 'high' }, { ...base, shadows: 'off' }))).toEqual(['shadowToggle', 'sharedMaterials']);
  });

  it('post-processing config: bloom half res (full at high), FXAA only at medium / high', () => {
    expect(postConfigFor(preset('low'))).toEqual({ enabled: false, bloomScale: 0.5, fxaa: false });
    expect(postConfigFor(preset('medium'))).toEqual({ enabled: true, bloomScale: 0.5, fxaa: true });
    expect(postConfigFor(preset('high'))).toEqual({ enabled: true, bloomScale: 1, fxaa: true });
    expect(postConfigFor({ qualityPreset: 'low', postProcessing: true })).toEqual({ enabled: true, bloomScale: 0.5, fxaa: false });
    expect(bloomSizeFor(1920, 1080, 0.5)).toEqual({ width: 960, height: 540 });
    expect(bloomSizeFor(1920, 1080, 1)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('frame budget estimate (design "성능 예산")', () => {
  it('Default_Quality stays within 500 draw calls and 1.5 M triangles, post passes included', () => {
    const cost = estimateFrameCost(preset('medium'));
    expect(postPassCount(postConfigFor(preset('medium')))).toBe(16);
    expect(cost.drawCalls).toBe(449 + 16);
    expect(cost.drawCalls).toBeLessThanOrEqual(FRAME_BUDGET.drawCalls);
    expect(cost.triangles).toBeLessThanOrEqual(FRAME_BUDGET.triangles);
    expect(withinFrameBudget(cost)).toBe(true);
  });

  it('low costs less than medium (no shadow pass, no composer, sparser vegetation)', () => {
    const low = estimateFrameCost(preset('low'));
    const medium = estimateFrameCost(preset('medium'));
    expect(low.drawCalls).toBeLessThan(medium.drawCalls);
    expect(low.triangles).toBeLessThan(medium.triangles);
    expect(low.items.find((i) => i.id === 'shadowPass')?.drawCalls).toBe(0);
    expect(low.items.find((i) => i.id === 'postPasses')?.drawCalls).toBe(0);
  });

  it('withinFrameBudget rejects either limit', () => {
    expect(withinFrameBudget({ drawCalls: 501, triangles: 10 })).toBe(false);
    expect(withinFrameBudget({ drawCalls: 10, triangles: 1_500_001 })).toBe(false);
    expect(withinFrameBudget({ drawCalls: 500, triangles: 1_500_000 })).toBe(true);
  });
});

/** A WebGLRenderer stand-in with the parts the pipeline, the shadow and the composer touch. */
function stubRenderer(): { renderer: THREE.WebGLRenderer; renders: number; resets: number } {
  const out = { renders: 0, resets: 0, renderer: null as unknown as THREE.WebGLRenderer };
  const stub = {
    info: { autoReset: true, reset: () => { out.resets++; }, render: { calls: 0, triangles: 0 } },
    shadowMap: { enabled: true, type: THREE.PCFShadowMap },
    toneMappingExposure: 1,
    getPixelRatio: () => 1,
    getSize: (v: THREE.Vector2) => v.set(1920, 1080),
    render: () => { out.renders++; },
  };
  out.renderer = stub as unknown as THREE.WebGLRenderer;
  return out;
}

function makePipeline(initial: Partial<Settings> = {}) {
  const stub = stubRenderer();
  const settings = new SettingsStore({ ...defaultSettings(), ...initial });
  const world = createWorldScene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2200);
  const handle = { renderer: stub.renderer, onResize: () => () => undefined, onContextRestored: () => () => undefined };
  const pipeline = new RenderPipeline({ handle, scene: world.scene, camera, world, settings });
  return { stub, settings, world, pipeline };
}

describe('RenderPipeline live settings', () => {
  it('sums every pass into renderer.info (autoReset off, reset each frame) and applies the default preset', () => {
    const { stub, world, pipeline } = makePipeline();
    expect(stub.renderer.info.autoReset).toBe(false);
    expect(world.sun.shadow.mapSize.x).toBe(1024);
    expect(stub.renderer.shadowMap.enabled).toBe(true);
    expect(world.sun.shadow.camera.right - world.sun.shadow.camera.left).toBe(80);
    expect(pipeline.postProcessing).toBe(true);
    expect(world.grading.gradingPassActive).toBe(true);
    pipeline.dispose();
  });

  it('draws with renderer.render when post-processing is off and blends nothing outdoors', () => {
    const { stub, pipeline, settings } = makePipeline();
    settings.set({ postProcessing: false });
    expect(pipeline.postProcessing).toBe(false);
    pipeline.render(0.016, { focus: { x: 10, y: 5, z: -3 }, interior: null });
    expect(stub.resets).toBe(1);
    expect(stub.renders).toBe(1);
    expect(stub.renderer.toneMappingExposure).toBe(1);
    pipeline.dispose();
  });

  it('rebuilds only the changed resources, at once, on each Settings change', () => {
    const { stub, world, pipeline, settings } = makePipeline();
    const composerBefore = (pipeline as unknown as { post: unknown }).post;
    settings.set({ shadows: 'high' });
    expect([...pipeline.lastApplied]).toEqual(['shadowMap']);
    expect(world.sun.shadow.mapSize.x).toBe(2048);
    expect(world.sun.shadow.map).toBeNull(); // freed: three.js allocates the new size on the next frame
    expect((pipeline as unknown as { post: unknown }).post).toBe(composerBefore);

    settings.set({ qualityPreset: 'low' });
    expect(stub.renderer.shadowMap.enabled).toBe(false);
    expect(world.sun.castShadow).toBe(false);
    expect(CHARACTER_SHADOW.enabled).toBe(false);
    expect(pipeline.postProcessing).toBe(false);
    expect(world.grading.gradingPassActive).toBe(false);

    settings.set({ qualityPreset: 'high' });
    expect(stub.renderer.shadowMap.enabled).toBe(true);
    expect(world.sun.shadow.mapSize.x).toBe(2048);
    type Post = { bloom: { resolution: THREE.Vector2; renderTargetBright: THREE.WebGLRenderTarget }; fxaa: { enabled: boolean; material: THREE.ShaderMaterial } };
    const post = (pipeline as unknown as { post: Post }).post;
    expect(post.fxaa.enabled).toBe(true);
    // The bloom's first (bright) target is half its size: full-resolution bloom at high → 960 on a 1920 buffer.
    expect(post.bloom.resolution.x).toBe(1920);
    expect(post.bloom.renderTargetBright.width).toBe(960);
    expect((post.fxaa.material.uniforms.resolution.value as THREE.Vector2).x).toBeCloseTo(1 / 1920);

    settings.set({ qualityPreset: 'medium' });
    expect([...pipeline.lastApplied].sort()).toEqual(['bloomSize', 'particleCapacity', 'pixelRatio', 'shadowMap', 'terrainLod', 'vegetation']);
    expect(post.bloom.resolution.x).toBe(960); // half resolution
    expect(post.bloom.renderTargetBright.width).toBe(480);
    pipeline.dispose();
  });
});
