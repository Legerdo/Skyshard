/*
 * Live quality application (design.md "품질 프리셋", "성능 예산"; Req 38.1–38.3). Pure rules, no three.js:
 * - `qualityResourceDiff(prev, next)`: which render resources a settings change touches, so only those are rebuilt
 *   (render scale / DPR cap → pixel ratio and the composer, bloom and FXAA sizes; shadows on / off → the shadow pass
 *   and the shared materials' recompile, low ↔ high → the shadow map; post-processing on / off → the composer, the
 *   preset's bloom scale / FXAA → those passes; particle scale → the particle capacities; vegetation / terrain LOD →
 *   the terrain task's instanced buffers and LOD thresholds).
 * - `postConfigFor(settings)`: bloom resolution and FXAA of the composer.
 * - `estimateFrameCost(settings)`: the design's per-frame budget table for a settings combination, checked against
 *   FRAME_BUDGET (Default_Quality: ≤ 500 draw calls, ≤ 1.5 M triangles).
 * Settings are persisted by the Settings_System on every change (SettingsStore `persist`, task 14.4); the render
 * pipeline (src/render/pipeline.ts) applies the diff in the same frame, well inside the 1 s budget.
 */
import { renderQualityFor } from '../data/renderQuality';

export type ShadowSetting = 'off' | 'low' | 'high';
export type VegetationSetting = 'low' | 'medium' | 'high';

/** The Settings fields the Render_System follows (SettingsStore values satisfy it). */
export interface QualityState {
  readonly qualityPreset: string;
  readonly renderScale: number;
  readonly shadows: ShadowSetting;
  readonly vegetation: VegetationSetting;
  readonly postProcessing: boolean;
}

export const QUALITY_RESOURCES = [
  'pixelRatio', 'shadowToggle', 'shadowMap', 'sharedMaterials', 'composer', 'bloomSize', 'fxaa', 'particleCapacity',
  'vegetation', 'terrainLod',
] as const;
export type QualityResource = (typeof QUALITY_RESOURCES)[number];

export interface PostConfig {
  readonly enabled: boolean;
  /** Bloom resolution relative to the drawing buffer (medium 0.5, high 1). */
  readonly bloomScale: number;
  /** FXAA only at medium / high (design "후처리"). */
  readonly fxaa: boolean;
}

export function postConfigFor(s: Pick<QualityState, 'qualityPreset' | 'postProcessing'>): PostConfig {
  const q = renderQualityFor(s.qualityPreset);
  return { enabled: s.postProcessing, bloomScale: q.bloomScale, fxaa: s.postProcessing && s.qualityPreset !== 'low' };
}

const SHADOW_SIZE: Readonly<Record<ShadowSetting, number>> = { off: 0, low: 1024, high: 2048 };

/** The resources to rebuild for `prev` → `next` (`prev` null: first application, everything). */
export function qualityResourceDiff(prev: Readonly<QualityState> | null, next: Readonly<QualityState>): Set<QualityResource> {
  if (prev === null) return new Set(QUALITY_RESOURCES);
  const out = new Set<QualityResource>();
  const a = renderQualityFor(prev.qualityPreset);
  const b = renderQualityFor(next.qualityPreset);
  if (prev.renderScale !== next.renderScale || a.dprCap !== b.dprCap) out.add('pixelRatio');
  const sa = SHADOW_SIZE[prev.shadows] ?? 0;
  const sb = SHADOW_SIZE[next.shadows] ?? 0;
  if ((sa > 0) !== (sb > 0)) {
    out.add('shadowToggle');
    out.add('sharedMaterials');
  }
  if (sb > 0 && sa !== sb) out.add('shadowMap');
  const pa = postConfigFor(prev);
  const pb = postConfigFor(next);
  if (pa.enabled !== pb.enabled) out.add('composer');
  else if (pb.enabled) {
    if (pa.bloomScale !== pb.bloomScale) out.add('bloomSize');
    if (pa.fxaa !== pb.fxaa) out.add('fxaa');
  }
  if (a.particleScale !== b.particleScale) out.add('particleCapacity');
  if (prev.vegetation !== next.vegetation) out.add('vegetation');
  if (a.terrainLodScale !== b.terrainLodScale) out.add('terrainLod');
  return out;
}

// ── Frame budget (design "성능 예산 (Default_Quality)") ─────────────────────────────────────────────────────────────

export const FRAME_BUDGET = { drawCalls: 500, triangles: 1_500_000 } as const;

export interface FrameCostItem {
  readonly id: string;
  readonly drawCalls: number;
  readonly triangles: number;
}

/** The design's Default_Quality estimate per item (medium preset, shadows low, post-processing on). */
export const DEFAULT_FRAME_COST: readonly FrameCostItem[] = [
  { id: 'terrain', drawCalls: 60, triangles: 350_000 },
  { id: 'vegetation', drawCalls: 140, triangles: 450_000 },
  { id: 'structures', drawCalls: 70, triangles: 250_000 },
  { id: 'actors', drawCalls: 40, triangles: 120_000 },
  { id: 'landmarks', drawCalls: 12, triangles: 60_000 },
  { id: 'waterSkyBlight', drawCalls: 12, triangles: 30_000 },
  { id: 'vfx', drawCalls: 25, triangles: 40_000 },
  { id: 'shadowPass', drawCalls: 90, triangles: 150_000 },
];

/**
 * Full-screen passes of the composer: bloom (bright pass, 5 mips × 2 blur passes, composite, blend onto the frame),
 * GradingPass, OutputPass and FXAA. Each draws one triangle.
 */
export function postPassCount(config: PostConfig): number {
  if (!config.enabled) return 0;
  const bloom = 1 + 5 * 2 + 1 + 1;
  return bloom + 1 + 1 + (config.fxaa ? 1 : 0);
}

/** Section 18.4's vegetation density multipliers (drawn triangles follow the instance count). */
const VEGETATION_DENSITY: Readonly<Record<VegetationSetting, number>> = { low: 0.4, medium: 1, high: 1.6 };

/**
 * The estimated frame cost of `s` from the design table: vegetation triangles × density, terrain triangles × the
 * preset's LOD distance scale, the shadow pass only with shadows on (the 80 m box holds the same casters at either
 * size), VFX triangles × particle scale, plus the composer's full-screen passes.
 */
export function estimateFrameCost(s: Readonly<QualityState>): { drawCalls: number; triangles: number; items: FrameCostItem[] } {
  const q = renderQualityFor(s.qualityPreset);
  const items = DEFAULT_FRAME_COST.map((item): FrameCostItem => {
    switch (item.id) {
      case 'terrain':
        return { ...item, triangles: Math.round(item.triangles * q.terrainLodScale) };
      case 'vegetation':
        return { ...item, triangles: Math.round(item.triangles * (VEGETATION_DENSITY[s.vegetation] ?? 1)) };
      case 'vfx':
        return { ...item, triangles: Math.round(item.triangles * q.particleScale) };
      case 'shadowPass':
        return s.shadows === 'off' ? { ...item, drawCalls: 0, triangles: 0 } : item;
      default:
        return item;
    }
  });
  const passes = postPassCount(postConfigFor(s));
  items.push({ id: 'postPasses', drawCalls: passes, triangles: passes });
  let drawCalls = 0;
  let triangles = 0;
  for (const item of items) {
    drawCalls += item.drawCalls;
    triangles += item.triangles;
  }
  return { drawCalls, triangles, items };
}

/** Whether a measured frame (F3 / harness figures) is inside the budget. */
export function withinFrameBudget(frame: { readonly drawCalls: number; readonly triangles: number }): boolean {
  return frame.drawCalls <= FRAME_BUDGET.drawCalls && frame.triangles <= FRAME_BUDGET.triangles;
}
